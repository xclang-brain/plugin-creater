import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTO_NOTICE,
  BUSY_NOTICE,
  CHAT_CONFIRM_NOTICE,
  CLEAR_NOTICE,
  EFFORT_LEVELS,
  LIMITS,
  OVERRIDE_NOTICE,
} from './constants.mjs';
import { realClock } from './clock.mjs';
import { SerialQueue } from './queue.mjs';
import { createStore } from './store.mjs';
import { effortAgents, loadTaskFile, normalizeTask, pickDefaultModel, readAgentModels } from './task-def.mjs';
import { buildToolDefinitions } from './tools.mjs';
import { callWithTimeout, clone } from './util.mjs';
import { viewRun } from './run.mjs';
import { handleEvent } from './events.mjs';
import { applyRecord, checkFileInsideCwd, isRecordTool, RecordRefusal, refuseWithoutQueue } from './records.mjs';
import { startRun, stopRun } from './lifecycle.mjs';
import { fileIssue, startCanFileCheck } from './filing.mjs';
import { logEntry } from './log.mjs';
import { recoverOnStartup, refreshPrevious, viewPrevious } from './recovery.mjs';

// 生成プラグインの中心の処理（BLUEPRINT 3.3）。Copilot CLI に依らない。
// つなぎ口とは、窓口 port（BLUEPRINT 3.2）と中立のイベント（3.1）だけでやり取りする。画面は startUi(core) で起こす。

const MODEL_ROLES = ['orchestrator', 'worker', 'verifier'];

// 選べるモデルの一覧の要素の形は、型で決まっていない（R2）。文字列でも { id, name } でもよいように読む。
function normalizeModels(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const id = typeof item === 'string' ? item : (item?.id ?? item?.modelId ?? item?.model);
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
    seen.add(id);
    const name = typeof item === 'object' ? (item.name ?? item.displayName ?? id) : id;
    out.push({ id, name: String(name) });
  }
  return out;
}

async function refreshSetup(ctx) {
  const { port, clock } = ctx;
  const [listed, current] = await Promise.all([
    callWithTimeout(clock, () => port.listModels(), LIMITS.CALL_TIMEOUT_MS),
    callWithTimeout(clock, () => port.getCurrentModel(), LIMITS.CALL_TIMEOUT_MS),
  ]);
  let models = listed.status === 'ok' ? normalizeModels(listed.value) : [];
  const currentModel = current.status === 'ok' ? (current.value?.model ?? current.value?.modelId ?? '') : '';
  const isAuto = current.status === 'ok' && Boolean(current.value?.isAuto);
  const candidates = {};
  for (const role of MODEL_ROLES) {
    const agent = role === 'worker' ? ctx.task.workers[0].agent : role;
    candidates[role] = readAgentModels(ctx.pluginRoot, agent);
  }
  if (models.length === 0) {
    // 一覧が取れないときは、エージェントの定義の既定と今のモデルだけを選択肢にする（設計書 11章 #10）
    const ids = [...new Set([...MODEL_ROLES.flatMap((r) => candidates[r].slice(0, 1)), currentModel].filter(Boolean))];
    models = ids.map((id) => ({ id, name: id }));
  }
  const ids = models.map((m) => m.id);
  const defaults = {};
  for (const role of MODEL_ROLES) defaults[role] = pickDefaultModel(candidates[role], ids, currentModel);
  ctx.setup = {
    models,
    defaults,
    effortLevels: [...EFFORT_LEVELS],
    effortAgents: effortAgents(ctx.task),
    maxIterationsDefault: ctx.task.maxIterationsDefault,
    taskSettings: clone(ctx.task.settings),
    taskDisplays: clone(ctx.task.displays),
    isAuto,
    autoNotice: isAuto ? AUTO_NOTICE : null,
    overrideNotice: OVERRIDE_NOTICE,
    currentModel,
    requestText: ctx.requestText,
  };
}

async function ensureUi(ctx, api) {
  if (ctx.uiHandle) return ctx.uiHandle.url;
  if (typeof ctx.startUi !== 'function') throw new Error('画面を起こす部品が渡されていないため、画面を開けません。');
  ctx.uiPromise ??= (async () => {
    const handle = await ctx.startUi(api);
    ctx.uiHandle = typeof handle === 'string' ? { url: handle } : handle;
    return ctx.uiHandle.url;
  })().catch((e) => {
    ctx.uiPromise = null;
    throw new Error(`画面を開けませんでした：${e?.message ?? e}`);
  });
  return ctx.uiPromise;
}

function buildState(ctx) {
  refreshPrevious(ctx);
  const run = ctx.run;
  const view = run ? viewRun(ctx, run) : null;
  const previous = run ? null : viewPrevious(ctx, ctx.previous);
  // 起票の状態は印のファイルから読むので、変わったら版の番号を上げる
  const filings = (view ? view.issues : (previous?.issues ?? [])).map((i) => `${i.id}:${i.filing.state}`).join(',');
  if (filings !== ctx.filingSignature) {
    if (ctx.filingSignature !== null) ctx.version += 1;
    ctx.filingSignature = filings;
  }
  const active = run && run.status !== 'finished';
  const setup = ctx.setup ?? {
    models: [],
    defaults: { orchestrator: '', worker: '', verifier: '' },
    effortLevels: [...EFFORT_LEVELS],
    effortAgents: effortAgents(ctx.task),
    maxIterationsDefault: ctx.task.maxIterationsDefault,
    taskSettings: clone(ctx.task.settings),
    taskDisplays: clone(ctx.task.displays),
    isAuto: false,
    autoNotice: null,
    overrideNotice: OVERRIDE_NOTICE,
    currentModel: '',
    requestText: ctx.requestText,
  };
  return {
    version: ctx.version,
    plugin: { name: ctx.pluginName, title: ctx.task.name },
    setup: { ...setup, requestText: ctx.requestText },
    run: view,
    previous,
    startError: ctx.startError ? { ...ctx.startError } : null,
    notices: active ? [CLEAR_NOTICE, CHAT_CONFIRM_NOTICE] : [],
  };
}

async function open(ctx, api, args) {
  const active = ctx.run && ctx.run.status !== 'finished';
  if (!active) {
    // 終わった後に呼ばれたら、新しい実行の準備に戻す（前の結果は previous で開ける）
    ctx.run = null;
    ctx.startError = null;
    ctx.requestText = typeof args?.requestText === 'string' ? args.requestText : '';
    ctx.previousDirty = true;
    await refreshSetup(ctx);
  }
  const url = await ensureUi(ctx, api);
  // 起票できるかは、画面を開いたときに確かめる（待たない）
  startCanFileCheck(ctx);
  const notices = [CLEAR_NOTICE, CHAT_CONFIRM_NOTICE];
  // 実行中に呼ばれたときは、頼みの文を受け付けない。黙って捨てずに、始められないことを知らせる
  if (active) notices.unshift(BUSY_NOTICE);
  if (!active && ctx.endedAtStartup.length > 0) {
    notices.push('前の実行が途中で終わっていました。画面で結果を見られます。');
    ctx.endedAtStartup.length = 0;
  }
  ctx.bump();
  return { url, notices };
}

export function createCore(options = {}) {
  const { port, pluginName, dataRoot } = options;
  if (!port) throw new Error('createCore には port（窓口）が要ります。');
  if (!pluginName) throw new Error('createCore には pluginName が要ります。');
  if (!dataRoot) throw new Error('createCore には dataRoot（記録の置き場所）が要ります。');
  const clock = options.clock ?? realClock;
  const coreDir = dirname(fileURLToPath(import.meta.url));
  const task = options.task
    ? normalizeTask(options.task, pluginName)
    : loadTaskFile(join(coreDir, '..', 'task.json'), pluginName);

  const ctx = {
    port,
    pluginRoot: options.pluginRoot ?? '',
    pluginName,
    dataRoot,
    sessionId: options.sessionId ?? randomBytes(8).toString('hex'),
    cwd: options.cwd ?? process.cwd(),
    clock,
    startUi: options.startUi ?? options.ui ?? null,
    ghCommand: options.ghCommand ?? 'gh',
    task,
    queue: new SerialQueue(),
    store: createStore({ dataRoot, clock }),
    version: 1,
    bump() {
      this.version += 1;
    },
    run: null,
    setup: null,
    previous: null,
    previousDirty: true,
    startError: null,
    requestText: '',
    deny: new Set(), // 拒む一覧（4.4）
    knownRoots: new Set(), // どれかの実行の根になった統括の番号
    strayHandled: new Set(), // 取り消しを頼み済みの番号
    canFile: { ok: false, reason: '起票できるかを確かめています。', code: 'checking', steps: [], repo: null },
    canFileChecked: false,
    canFilePromise: null,
    uiHandle: null,
    uiPromise: null,
    aliveTimer: null,
    recheckTimer: null,
    recoveryPromise: null,
    endedAtStartup: [],
    filingSignature: null,
    recordingError: null,
    closed: false,
  };

  const fail = (e) => {
    ctx.recordingError = e;
  };

  const api = {
    // <名前>_open（記録のツール）
    open: (args) => open(ctx, api, args),

    // つなぎ口 → 中心の処理（BLUEPRINT 3.1）。列に入れて、1 件ずつ処理する
    onEvent(e) {
      ctx.queue
        .enqueue(() => handleEvent(ctx, e))
        .then(() => ctx.bump())
        .catch(fail);
    },

    // 記録のツール（plan・verdict・show・review・issue・finish）。断るときは Error を投げる
    async handleTool(shortName, args, { agentId } = {}) {
      if (!isRecordTool(shortName)) throw new RecordRefusal('知らない記録のツールです。');
      const early = refuseWithoutQueue(ctx);
      if (early) throw new RecordRefusal(early);
      try {
        return await ctx.queue.enqueue(() => applyRecord(ctx, shortName, args, agentId));
      } finally {
        ctx.bump();
      }
    },

    // ツールを使ってよいかの問い合わせ（フック onPreToolUse）。列に入れず、同期ですぐ答える。例外を投げない（4.4）
    preToolUse(input) {
      let agentId;
      try {
        agentId = input.agentId;
        if (agentId === undefined || agentId === null) return { deny: false };
        let denied = ctx.deny.has(agentId);
        if (!denied && input.parentAgentId != null && ctx.deny.has(input.parentAgentId)) {
          ctx.deny.add(agentId); // 拒む一覧のエージェントの子も拒む
          denied = true;
        }
        if (!denied) return { deny: false };
        return { deny: true, reason: `この実行は止められたため、ツール「${String(input.toolName ?? '')}」は使えません。` };
      } catch {
        try {
          return agentId !== undefined && agentId !== null && ctx.deny.has(agentId)
            ? { deny: true, reason: 'この実行は止められたため、ツールは使えません。' }
            : { deny: false };
        } catch {
          return { deny: false };
        }
      }
    },

    // 許可の求めの受け口（4.14）。列に入れるだけで、答えない。例外を投げない
    onPermissionRequest(req) {
      try {
        ctx.queue
          .enqueue(() => {
            const run = ctx.run;
            if (run && run.status !== 'finished') {
              logEntry(ctx, run, { t: 'note', at: ctx.clock.now(), kind: 'permission_request_seen', requestId: req?.requestId ?? null });
            }
          })
          .catch(fail);
      } catch {
        // 見るだけ。失敗しても答えは変わらない
      }
      return { kind: 'no-result' };
    },

    // ---- 画面から呼ばれる ----
    getState: () => buildState(ctx),
    async start(settings) {
      return startRun(ctx, settings);
    },
    async stop() {
      return stopRun(ctx);
    },
    async fileIssue(issueId) {
      return fileIssue(ctx, issueId);
    },
    getReply(agentId) {
      const rec = ctx.run?.tree.get(agentId);
      return rec && rec.reply != null ? rec.reply : null;
    },
    // 記録のツールで知らされた、作業フォルダの中のファイル。それ以外は null
    getFile(fileId) {
      const entry = ctx.run?.files.get(fileId);
      if (!entry) return null;
      const real = checkFileInsideCwd(ctx, entry.path); // 作り直されたシンボリックリンクなどを、出すときにもう一度確かめる
      return real ? { path: real, name: entry.name, image: /\.(png|jpe?g|gif|webp)$/i.test(real) } : null;
    },

    // 記録のツールの定義（名前の頭にプラグインの名前を付けたもの。つなぎ口が登録する）
    get toolDefinitions() {
      return buildToolDefinitions(pluginName);
    },

    // 列が空になるまで待つ（試験と終了処理で使う）
    whenIdle: () => ctx.queue.idle(),

    async shutdown() {
      ctx.closed = true;
      if (ctx.aliveTimer !== null) clock.clearInterval(ctx.aliveTimer);
      if (ctx.recheckTimer) clock.clearTimeout(ctx.recheckTimer);
      ctx.aliveTimer = null;
      ctx.recheckTimer = null;
      try {
        await ctx.uiHandle?.close?.();
      } catch {
        // 終わるときの失敗は無視する
      }
    },
  };

  recoverOnStartup(ctx);
  return api;
}
