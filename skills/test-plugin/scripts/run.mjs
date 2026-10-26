// EVAL の実行（testing.md 10.4、REQ-041）。
// 生成プラグインあり・なしで、課題ごとに回数分、実行のたびにまっさらな作業フォルダで Copilot CLI を動かし、採点する。
// Copilot SDK と画面の操作は引数で受ける（試験では偽物を渡す。本物は eval.mjs が道具のフォルダから読み込む）。
//
// 流れ（実行1回）
//   1. 作業フォルダを作り、課題の入力のファイルだけを写す（OS の一時フォルダの下。生成プラグインのフォルダの外）
//   2. CopilotClient を起動する。ありのときは `--plugin-dir <生成プラグイン>`、どちらも COPILOT_PLUGIN_DIR_ONLY=true
//   3. セッションを作る。ありのときは requestExtensions: true。読み込まれたプラグインとエクステンションを確かめ、記録する
//   4. 課題の頼むときの言葉を送る
//   5. ありのとき：チャットに出た URL を画面で開き、設定を入れて開始し、終わった理由が出たら結果を読む。なしのとき：手番が終わる（session.idle）まで待つ
//      ありで、実行が人の判断待ちになり、メインのエージェントの手番が終わったら、決まった返事をチャットに送る（human-wait.mjs）
//   6. 落ち着くまで待ち（最後の費用のイベントを取りこぼさないため）、セッションとクライアントを閉じる
//   7. ありのとき、この実行でできた生成プラグインの実行の記録だけを消す（plugin-records.mjs。ふだんの作業の記録と同じ場所に入るため。ユーザーの答え27）
//   8. 作業フォルダの成果物を、基準で採点する（生成プラグインの検証エージェントの合否は使わない）
// 試験全体を止める場合：管理設定で人の承認が要る求め、AI クレジットの上限、プラグインやエクステンションが読み込まれない、ブラウザーが起動できない。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clipText, createEventLog, createTracker, waitUntil } from './events.mjs';
import { createExtensionLaunchProvider } from './extension-launch.mjs';
import { gradeRun } from './grade.mjs';
import { createHumanWaitAnswerer } from './human-wait.mjs';
import { createPermissionHandler, createUserInputHandler } from './permissions.mjs';
import { removeEvalRecords, watchPluginRecords } from './plugin-records.mjs';
import { RESULT_FILE, createResultsDir, summarizeRuns, writeJsonAtomic } from './results.mjs';
import { ScreenError } from './screen.mjs';
import { loadTasks, prepareWorkDir } from './tasks.mjs';

export const DEFAULTS = Object.freeze({
  /** 1回の実行の上限（送ってから、画面に終わった理由が出る、または手番が終わるまで） */
  timeoutMs: 30 * 60_000,
  /** ランタイムの起動とセッションの作成の上限 */
  sdkCallMs: 90_000,
  /** エクステンションが動き出すのを待つ上限 */
  setupWaitMs: 60_000,
  /** 終わった後、最後のイベントから何ミリ秒静かなら、落ち着いたとするか */
  settleMs: 3000,
  /** 落ち着くのを待つ上限 */
  idleGraceMs: 120_000,
  /** 画面の状態を見る間隔 */
  screenPollMs: 2000,
  /** 人の判断待ちで、手番の終わりの知らせか session.idle が届かないとき、セッションが何ミリ秒静かなら、決まった返事を送るか */
  humanQuietMs: 60_000,
  /** 閉じるのを待つ上限 */
  closeMs: 15_000,
});

const isoOf = (ms) => new Date(ms).toISOString();
const VARIANT_JA = { with: 'あり', without: 'なし' };

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** 生成プラグインの plugin.json から、名前と版を読む。読めなければ Error（message は平易な日本語） */
export function readPluginInfo(pluginDir) {
  const file = path.join(pluginDir, 'plugin.json');
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(error.code === 'ENOENT' ? `生成プラグインの plugin.json が見つかりません（${file}）` : `plugin.json を読めません（${error.message}）`);
  }
  if (typeof json.name !== 'string' || json.name === '') throw new Error(`plugin.json に name がありません（${file}）`);
  return { name: json.name, version: typeof json.version === 'string' ? json.version : null, path: pluginDir };
}

/** ランタイムに渡す環境。ほかのプラグインを読み込ませず、同梱のランタイムを使う（手元の Copilot CLI に替えない） */
export function runtimeEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') out[key] = value;
  out.COPILOT_PLUGIN_DIR_ONLY = 'true';
  delete out.COPILOT_CLI_PATH;
  return out;
}

const maskUrl = (url) => (url ? url.replace(/(\?k=).*/, '$1***') : null);

/** プラグインが「このプラグイン」か（--plugin-dir で読み込んだものは、名前か、読み込み元の場所で見分ける） */
function isOurPlugin(p, plugin) {
  if (p?.name === plugin.name) return true;
  try {
    return typeof p?.installedFrom === 'string' && fs.realpathSync(p.installedFrom) === fs.realpathSync(plugin.path);
  } catch {
    return false;
  }
}
const isBuiltinPlugin = (p) => typeof p?.source === 'string' && p.source.includes('builtin');
const isOurExtension = (e, plugin) => e?.source === 'plugin' && typeof e.id === 'string' && e.id.startsWith(`plugin:${plugin.name}:`);

async function tryList(call) {
  try {
    return await call();
  } catch {
    return null;
  }
}

/**
 * EVAL を実行する。
 * @param {object} opts
 * @param {string} opts.pluginDir 生成プラグインのフォルダ
 * @param {number} opts.runs 課題ごと、あり・なしそれぞれの回数
 * @param {object} opts.sdk Copilot SDK（CopilotClient、RuntimeConnection）
 * @param {object} opts.screen 画面の操作（prepare、operate、close）
 * @param {Function} [opts.judge] model の基準を判定する関数
 * @param {string} [opts.model] 試験のセッションのモデル（省くと Copilot の既定）
 * @param {object} [opts.versions] 記録に残す版（copilotSdk、playwright など）
 * @param {Array} [opts.tasks] loadTasks の課題（省くと読み込む）
 * @param {string} [opts.resultsDir] 結果を置くフォルダ（省くと tests/results/eval-<日時>）
 * @param {string} [opts.extensionSdkPath] エクステンションの子プロセスが読み込む SDK のフォルダ（index.js と extension.js がある）。
 *   ありの実行で、セッションの extensionSdkPath に渡し、エクステンションの起動のしかた（extensionLaunchProvider）を CopilotClient に渡す。
 *   Copilot SDK でエクステンションを動かすのに要る（本物のランタイムで確かめた）。省くと、どちらも渡さない
 * @param {string} [opts.workRoot] 作業フォルダを作る場所（省くと OS の一時フォルダの下）
 * @param {object} [opts.env] ランタイムに渡す環境
 * @param {(text: string) => void} [opts.log] 進み具合
 * @param {AbortSignal} [opts.signal] 外からの中断の合図
 * @returns {Promise<object>} 結果（result.json と同じ）
 */
export async function runEval(opts) {
  const { pluginDir, runs, sdk, screen, judge } = opts;
  const timing = { ...DEFAULTS, ...(opts.timing ?? {}) };
  const nowMs = opts.nowMs ?? Date.now;
  const log = opts.log ?? (() => {});
  const plugin = readPluginInfo(pluginDir);
  let tasks = opts.tasks;
  if (!tasks) {
    const loaded = loadTasks(pluginDir);
    if (loaded.problems.length > 0) throw new Error(`課題に誤りがあります：\n${loaded.problems.join('\n')}`);
    tasks = loaded.tasks;
  }
  const resultsDir = opts.resultsDir ?? createResultsDir(pluginDir, new Date(nowMs()));
  const workRoot = opts.workRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-creator-eval-'));
  const resultFile = path.join(resultsDir, RESULT_FILE);
  const startedAt = nowMs();

  const controller = new AbortController();
  const state = { stopped: null, runs: [], warnings: [], browser: null };
  const stop = (reason, message, where) => {
    if (state.stopped) return;
    state.stopped = { reason, message, run: where ?? null, at: isoOf(nowMs()) };
    controller.abort();
  };

  const snapshot = (status) => {
    const summary = summarizeRuns(state.runs);
    return {
      kind: 'eval',
      status,
      stopped: state.stopped,
      plugin,
      startedAt: isoOf(startedAt),
      finishedAt: status === 'running' ? null : isoOf(nowMs()),
      options: { runs, model: opts.model ?? null, timeoutMinutes: Math.round(timing.timeoutMs / 6000) / 10, ...(opts.options ?? {}) },
      versions: { ...(opts.versions ?? {}), copilotCli: state.runs.find((r) => r.copilotVersion)?.copilotVersion ?? null, browser: state.browser },
      tasks: tasks.map((t) => ({ id: t.id, criteria: t.json.criteria.map((c) => ({ id: c.id, text: c.text, grading: c.grading })) })),
      runs: state.runs,
      scores: summary.scores,
      credits: summary.credits,
      creditDetail: summary.creditDetail,
      counts: summary.counts,
      warnings: warningsOf(state.runs, summary),
      resultsDir,
      resultFile,
    };
  };
  const save = (status) => {
    const result = snapshot(status);
    writeJsonAtomic(resultFile, result);
    return result;
  };

  save('running');

  // 外からの中断（Ctrl+C など）。動いている実行は閉じて、結果は stopped で書く
  const interrupt = () => stop('interrupted', '試験が中断されました（Ctrl+C などで止められました）。');
  if (opts.signal?.aborted) interrupt();
  else opts.signal?.addEventListener('abort', interrupt, { once: true });

  try {
    const prepared = await screen.prepare();
    state.browser = prepared?.channel ?? null;
  } catch (error) {
    stop('browser_failed', error?.message ?? String(error));
  }

  const ctx = { opts, plugin, timing, nowMs, log, sdk, screen, judge, resultsDir, workRoot, stop, signal: controller.signal, state };
  for (const task of tasks) {
    for (let n = 1; n <= runs; n += 1) {
      for (const variant of ['with', 'without']) {
        const where = `${task.id} ${VARIANT_JA[variant]} ${n}/${runs}`;
        if (state.stopped) {
          state.runs.push(blankRecord(task, variant, n, 'skipped', state.stopped.message, nowMs));
          continue;
        }
        log(`[${where}] 実行します`);
        const record = await runOne(ctx, task, variant, n, where);
        state.runs.push(record);
        log(`[${where}] ${record.status}${record.score === null ? '' : `（${record.passed}/${record.total} 合格）`}${record.error ? `：${record.error}` : ''}`);
        save('running');
      }
    }
  }
  opts.signal?.removeEventListener('abort', interrupt);
  return save(state.stopped ? 'stopped' : 'completed');
}

function blankRecord(task, variant, n, status, error, nowMs) {
  return {
    task: task.id,
    variant,
    n,
    status,
    error: error ?? null,
    startedAt: isoOf(nowMs()),
    finishedAt: isoOf(nowMs()),
    criteria: [],
    passed: 0,
    total: task.json.criteria.length,
    score: null,
    credits: 0,
    creditsStatus: 'complete',
    judgeCredits: 0,
    judgeCreditsStatus: 'complete',
    judgments: 0,
  };
}

/** 結果に添える注意（ユーザーに示す） */
function warningsOf(runs, summary) {
  const out = [];
  const where = (r) => `${r.task} ${VARIANT_JA[r.variant]} ${r.n}`;
  const foreignExt = runs.filter((r) => r.foreignExtensions?.length);
  if (foreignExt.length > 0) {
    const names = [...new Set(foreignExt.flatMap((r) => r.foreignExtensions))];
    out.push(`ほかのエクステンションが混ざった：${names.join('、')}（実行：${foreignExt.map(where).join('、')}）。あり・なしの比べ合いに、そのエクステンションの影響が入っているかもしれません。`);
  }
  const foreignPlugins = runs.filter((r) => r.foreignPlugins?.length);
  if (foreignPlugins.length > 0) {
    const names = [...new Set(foreignPlugins.flatMap((r) => r.foreignPlugins))];
    out.push(`ほかのプラグインが混ざった：${names.join('、')}（実行：${foreignPlugins.map(where).join('、')}）。`);
  }
  const errors = runs.filter((r) => r.status === 'error');
  if (errors.length > 0) out.push(`試験の仕組みの側の失敗で、採点できなかった実行が ${errors.length} 回あります（${errors.map(where).join('、')}）。点数には入っていません。`);
  const incomplete = runs.filter((r) => r.status === 'incomplete');
  if (incomplete.length > 0) out.push(`終わりまで動かなかった実行が ${incomplete.length} 回あります（${incomplete.map(where).join('、')}）。できていた分だけを採点しています。`);
  if (summary.creditDetail.status !== 'complete') out.push('AI クレジットを数えきれなかった呼び出しがあります。使った AI クレジットは、実際より少ないかもしれません。');
  const kept = runs.filter((r) => r.pluginRecords?.unidentified?.length);
  if (kept.length > 0) {
    const count = kept.reduce((total, r) => total + r.pluginRecords.unidentified.length, 0);
    out.push(`試験の間に、生成プラグインの実行の記録が ${count} 件増えましたが、試験の実行のものと確かめられなかったので、消していません（実行：${kept.map(where).join('、')}）。ふだんの作業の記録かもしれません。`);
  }
  const notRemoved = runs.filter((r) => r.pluginRecords?.failed?.length);
  if (notRemoved.length > 0) {
    const places = notRemoved.flatMap((r) => r.pluginRecords.failed.map((f) => path.join(r.pluginRecords.root, f.id)));
    out.push(`試験でできた生成プラグインの実行の記録を、消せませんでした：${places.join('、')}。試験のものなので、手で消してかまいません。`);
  }
  const skippedRecords = runs.find((r) => r.pluginRecords?.skipped);
  if (skippedRecords) out.push(`試験でできた生成プラグインの実行の記録は、消していません（${skippedRecords.pluginRecords.skipped}）。`);
  const humanFailed = runs.filter((r) => r.humanAnswerFailures?.length);
  if (humanFailed.length > 0) out.push(`人の判断待ちに、決まった返事をチャットで送れなかった実行があります（${humanFailed.map(where).join('、')}）。`);
  const rejected = runs.reduce((total, r) => total + (r.permissions?.rejected ?? 0), 0);
  if (rejected > 0) out.push(`作業フォルダの外への書き込みなど、${rejected} 件の許可の求めを拒みました。`);
  return out;
}

// ---- 実行1回 -----------------------------------------------------------------------------------

async function runOne(ctx, task, variant, n, where) {
  const { opts, plugin, timing, nowMs, sdk, screen, judge, resultsDir, workRoot, stop, signal, state } = ctx;
  const runDir = path.join(resultsDir, 'runs', task.id, `${variant}-${n}`);
  const eventsFile = path.join(runDir, 'events.jsonl');
  const rel = (file) => path.relative(resultsDir, file).split(path.sep).join('/');
  const startedMs = nowMs();
  const deadline = startedMs + timing.timeoutMs;
  const remaining = () => Math.max(0, deadline - nowMs());
  const record = blankRecord(task, variant, n, 'error', null, nowMs);
  record.events = rel(eventsFile);

  fs.mkdirSync(runDir, { recursive: true });
  const eventLog = createEventLog(eventsFile, nowMs);
  const userInput = createUserInputHandler();
  let permission = null;
  let workDir = null;
  let inputs = new Map();
  let client = null;
  let session = null;
  let launchProviderOf = null;
  let recordWatch = null;

  const tracker = createTracker({
    log: eventLog,
    now: nowMs,
    onLimit: (event) => {
      // 利用の上限（AI クレジットの予算）は、クレジットを足さずに止める。承認していない費用を使わないため
      stop('credit_limit', 'AI クレジットの上限に達したので、クレジットを足さずに試験を止めました。', where);
      const requestId = event?.data?.requestId;
      if (session && requestId) {
        Promise.resolve()
          .then(() => session.rpc.ui.handlePendingSessionLimitsExhausted({ requestId, response: { action: 'cancel' } }))
          .catch(() => {});
      }
    },
  });

  // 人の判断待ちに、決まった返事をチャットで送る（ありのときだけ。session は後で作る）
  const human =
    variant === 'with'
      ? createHumanWaitAnswerer({
          tracker,
          send: (prompt) => session.send({ prompt }),
          now: nowMs,
          settleMs: timing.settleMs,
          quietMs: timing.humanQuietMs,
          log: (entry) => eventLog.write(entry),
        })
      : null;

  try {
    ({ workDir, inputs } = prepareWorkDir({ task, dir: path.join(workRoot, `${task.id}-${variant}-${n}`) }));
    record.workDir = workDir;
    permission = createPermissionHandler({
      workDir,
      onManaged: ({ summary }) =>
        stop(
          'managed_approval',
          `組織の管理設定で、人の承認が要る確認が出たので、試験を止めました（${summary}）。この確認は、人が答える決まりで、試験の仕組みは自動では許可できません。`,
          where,
        ),
    });

    // ありのとき、起動してよいのは生成プラグインのエクステンションだけ。ユーザーの ~/.copilot/extensions/ などのものは、起動を断って混ぜない
    const hostExtensions = variant === 'with' && opts.extensionSdkPath;
    const launchProvider = hostExtensions ? createExtensionLaunchProvider({ accept: (request) => isOurExtension(request, plugin), env: opts.env ?? process.env }) : null;
    launchProviderOf = launchProvider;
    // 生成プラグインの実行の記録は、ユーザーのふだんの作業の記録と同じ場所に入る。始める前に、今ある記録の番号を控える
    if (variant === 'with') recordWatch = watchPluginRecords({ pluginName: plugin.name, env: opts.env ?? process.env });
    client = new sdk.CopilotClient({
      connection: sdk.RuntimeConnection.forStdio({ args: variant === 'with' ? ['--plugin-dir', plugin.path] : [], env: runtimeEnv(opts.env ?? process.env) }),
      workingDirectory: workDir,
      logLevel: 'error',
      ...(launchProvider ? { extensionLaunchProvider: launchProvider } : {}),
    });
    await withTimeout(client.start(), timing.sdkCallMs, 'Copilot のランタイムを起動できませんでした（時間切れ）');
    session = await withTimeout(
      client.createSession({
        ...(opts.model ? { model: opts.model } : {}),
        workingDirectory: workDir,
        requestExtensions: variant === 'with',
        ...(hostExtensions ? { extensionSdkPath: opts.extensionSdkPath } : {}),
        trustWorkingDirectory: 'session',
        onPermissionRequest: permission,
        onUserInputRequest: userInput,
        onEvent: tracker.onEvent,
      }),
      timing.sdkCallMs,
      'セッションを作れませんでした（時間切れ）',
    );

    await inspectLoaded({ ctx, session, tracker, variant, record, where });
    if (signal.aborted) {
      record.status = 'stopped';
    } else {
      tracker.markSent();
      await session.send({ prompt: task.json.prompt });
      if (variant === 'with') await driveWithPlugin({ ctx, task, tracker, record, runDir, remaining, eventLog, human });
      else await driveWithoutPlugin({ ctx, tracker, record, remaining });
      // 最後の費用のイベントまで取りこぼさないよう、落ち着くまで待つ
      await waitUntil(() => tracker.settled(timing.settleMs), { timeoutMs: Math.min(timing.idleGraceMs, Math.max(remaining(), timing.settleMs * 2)), signal, pollMs: Math.min(25, timing.settleMs) });
      if (record.variant === 'with') await recordExtensions({ session, tracker, record, plugin });
    }
  } catch (error) {
    record.status = 'error';
    record.error = clipText(error?.message ?? String(error), 500);
  } finally {
    await closeAll({ session, client, closeMs: timing.closeMs });
    // ランタイムが止まってから（エクステンションが書き込み終わってから）、この実行でできた記録だけを消す。ふだんの作業の記録と、生成プラグインは消さない
    if (recordWatch) record.pluginRecords = removeEvalRecords(recordWatch, { workDir, sessionId: session?.sessionId });
  }

  // 試験全体が止まったときに動いていた実行は、採点しない
  if (state.stopped && record.status !== 'completed') {
    record.status = 'stopped';
    record.error = state.stopped.message;
  }
  fillFromTracker({ record, tracker, permission, userInput, human });
  if (launchProviderOf) record.extensionLaunch = { launched: launchProviderOf.launched, refused: launchProviderOf.skipped };
  if ((record.status === 'completed' || record.status === 'incomplete') && workDir) {
    try {
      const graded = await gradeRun({ task: task.json, workDir, inputs, judge });
      Object.assign(record, {
        criteria: graded.results.map((r) => ({ id: r.id, text: r.text, grading: r.grading, pass: r.pass, reason: r.reason, ...(r.error ? { error: true } : {}) })),
        passed: graded.passed,
        total: graded.total,
        score: graded.score,
        judgments: graded.judgments,
        judgeCredits: Math.round(graded.judgeCredits * 1e6) / 1e6,
        judgeCreditsStatus: graded.judgeCreditsStatus,
      });
    } catch (error) {
      record.status = 'error';
      record.error = `採点できませんでした（${clipText(error?.message ?? String(error), 300)}）`;
    }
  }
  record.finishedAt = isoOf(nowMs());
  return record;
}

/** 読み込まれたプラグインとエクステンションを確かめ、記録する。ありのとき、読み込まれていなければ試験全体を止める */
async function inspectLoaded({ ctx, session, tracker, variant, record, where }) {
  const { plugin, timing, stop, signal } = ctx;
  const listed = await tryList(() => session.rpc.plugins.list());
  const plugins = Array.isArray(listed?.plugins) ? listed.plugins : null;
  if (plugins) {
    record.plugins = plugins.map((p) => ({ name: p.name, version: p.version ?? null, enabled: p.enabled, source: p.source ?? null }));
    record.foreignPlugins = plugins.filter((p) => !isBuiltinPlugin(p) && !(variant === 'with' && isOurPlugin(p, plugin))).map((p) => p.name);
  }
  if (variant !== 'with') {
    await recordExtensions({ session, tracker, record, plugin });
    return;
  }
  if (plugins && !plugins.some((p) => isOurPlugin(p, plugin))) {
    const names = plugins.map((p) => p.name).join('、') || '（なし）';
    stop('plugin_not_loaded', `生成プラグイン「${plugin.name}」が Copilot CLI に読み込まれませんでした（読み込まれたプラグイン：${names}）。plugin.json と、置き場所を確かめてください。`, where);
    return;
  }
  // エクステンションが動き出すまで待つ（読み込みのときの確認には、onPermissionRequest が答える）
  let last = null;
  const outcome = await waitUntil(
    async () => {
      const result = await tryList(() => session.rpc.extensions.list());
      last = Array.isArray(result?.extensions) ? result.extensions : tracker.state.extensions ?? last;
      const ours = (last ?? []).filter((e) => isOurExtension(e, plugin));
      return ours.some((e) => e.status === 'running') || ours.some((e) => e.status === 'failed' || e.status === 'disabled');
    },
    { timeoutMs: timing.setupWaitMs, signal, pollMs: Math.min(250, timing.setupWaitMs) },
  );
  const ours = (last ?? []).filter((e) => isOurExtension(e, plugin));
  if (outcome === 'aborted') return;
  if (ours.some((e) => e.status === 'running')) return;
  if (ours.length === 0) {
    stop(
      'extension_missing',
      `生成プラグインのエクステンションが読み込まれませんでした（${outcome === 'timeout' ? `${Math.round(timing.setupWaitMs / 1000)}秒待ちました。` : ''}読み込まれたエクステンション：${(last ?? []).map((e) => e.id).join('、') || 'なし'}）。com.github.copilot/extensions/ の置き場所と、Copilot SDK でエクステンションが読み込まれる条件（requestExtensions）を確かめてください。`,
      where,
    );
  } else {
    stop('extension_failed', `生成プラグインのエクステンションが動き出しませんでした（状態：${ours.map((e) => `${e.id} ${e.status}`).join('、')}）。`, where);
  }
}

/** セッションの今のエクステンションを記録し、生成プラグインのもの以外があれば印を付ける */
async function recordExtensions({ session, tracker, record, plugin }) {
  const result = await tryList(() => session.rpc.extensions.list());
  const list = Array.isArray(result?.extensions) ? result.extensions : tracker.state.extensions ?? [];
  record.extensions = list.map((e) => ({ id: e.id, source: e.source, status: e.status }));
  // 混ざったのは、生成プラグイン以外で、動いている（または動き出している）もの。起動を断ったもの（failed など）は混ざっていない
  const mixed = new Set(record.foreignExtensions ?? []);
  const refused = new Set(record.refusedExtensions ?? []);
  for (const e of list) {
    if (record.variant === 'with' && isOurExtension(e, plugin)) continue;
    if (e.status === 'running' || e.status === 'starting') mixed.add(e.id);
    else refused.add(e.id);
  }
  record.foreignExtensions = [...mixed];
  record.refusedExtensions = [...refused];
}

async function driveWithPlugin({ ctx, task, tracker, record, runDir, remaining, eventLog, human }) {
  const { screen, signal, timing } = ctx;
  const done = () => tracker.state.url || tracker.state.errors.length > 0 || (tracker.state.idleCount > 0 && !tracker.state.busy);
  const waited = await waitUntil(done, { timeoutMs: remaining(), signal });
  if (signal.aborted) return;
  if (tracker.state.errors.length > 0) {
    record.status = 'error';
    record.error = `セッションがエラーになりました（${tracker.state.errors[0]}）`;
    return;
  }
  if (!tracker.state.url) {
    record.status = 'incomplete';
    record.error = waited === 'timeout' ? '時間切れ：チャットに画面の URL が示されませんでした' : 'チャットに画面の URL が示されませんでした（URL が出る前に、手番が終わりました）';
    return;
  }
  const screenFile = path.join(runDir, 'screen.json');
  let result;
  // 人の判断待ちを見張る。画面の状態は onSnapshot で受け、メインのエージェントの手番の終わりは、決まった間隔で確かめる
  const humanTimer = setInterval(() => {
    if (!signal.aborted) human.tick().catch(() => {});
  }, Math.min(250, timing.screenPollMs));
  try {
    result = await screen.operate({
      url: tracker.state.url,
      settings: task.json.settings ?? {},
      timeoutMs: remaining(),
      pollMs: timing.screenPollMs,
      screenshotPath: path.join(runDir, 'screen.png'),
      signal,
      onSnapshot: (snap) => {
        eventLog.write({ type: 'screen.snapshot', data: snap });
        human.observe(snap);
      },
    });
  } catch (error) {
    if (!(error instanceof ScreenError)) throw error;
    record.status = 'incomplete';
    record.error = error.message;
    writeScreenRecord(screenFile, { url: tracker.state.url, error: error.message, snapshots: error.snapshots ?? [] });
    record.screen = path.relative(ctx.resultsDir, screenFile).split(path.sep).join('/');
    return;
  } finally {
    clearInterval(humanTimer);
    human.close();
  }
  writeScreenRecord(screenFile, { url: tracker.state.url, ...result });
  record.screen = path.relative(ctx.resultsDir, screenFile).split(path.sep).join('/');
  if (result.timedOut) {
    record.status = 'incomplete';
    record.error = `時間切れ：${Math.round(timing.timeoutMs / 60_000)}分たっても、画面に終わった理由が出ませんでした`;
    return;
  }
  record.endReason = { ...(result.endReason ?? {}), text: String(result.endReasonText ?? '').replace(/^終わった理由：\s*/, '') };
  if (result.endReason?.kind === 'aborted') {
    record.status = 'incomplete';
    record.error = `実行が途中で終わりました（${record.endReason.text}）`;
  } else {
    record.status = 'completed';
  }
}

function writeScreenRecord(file, data) {
  // 画面の URL の合言葉は残さない。結果の表示にある検証エージェントの合否は、記録だけに残し、採点には使わない
  writeJsonAtomic(file, { ...data, url: maskUrl(data.url), note: '検証エージェントの合否は、記録のために残している。採点には使っていない。' });
}

async function driveWithoutPlugin({ ctx, tracker, record, remaining }) {
  const { signal } = ctx;
  const waited = await waitUntil(() => tracker.state.errors.length > 0 || (tracker.state.idleCount > 0 && !tracker.state.busy), { timeoutMs: remaining(), signal });
  if (signal.aborted) return;
  if (tracker.state.errors.length > 0) {
    record.status = 'error';
    record.error = `セッションがエラーになりました（${tracker.state.errors[0]}）`;
  } else if (waited === 'timeout') {
    record.status = 'incomplete';
    record.error = '時間切れ：手番が終わりませんでした';
  } else {
    record.status = 'completed';
  }
}

function fillFromTracker({ record, tracker, permission, userInput, human }) {
  const c = tracker.credits();
  record.credits = c.credits;
  record.creditsStatus = c.status;
  record.creditsByModel = c.byModel;
  record.models = Object.keys(c.byModel);
  record.copilotVersion = tracker.state.copilotVersion;
  record.skills = tracker.state.skills;
  record.subagents = [...tracker.state.subagents.values()];
  record.permissions = permission
    ? { approved: permission.stats.approved, rejected: permission.stats.rejected, rejections: permission.stats.rejections, extensionRequests: permission.stats.extensionRequests }
    : null;
  record.questions = userInput.stats.count;
  record.questionTexts = userInput.stats.questions;
  // 人の判断待ちに送った決まった返事の数と、その質問の文（ありのときだけ起きる）
  record.humanQuestions = human ? human.stats.count : 0;
  record.humanQuestionTexts = human ? human.stats.questions : [];
  if (human?.stats.failures.length) record.humanAnswerFailures = human.stats.failures;
}

/** セッションとクライアントを閉じる。閉じるのに時間がかかるときは、強制的に止める */
async function closeAll({ session, client, closeMs }) {
  if (session) {
    try {
      await withTimeout(Promise.resolve(session.abort?.()).catch(() => {}), closeMs, 'abort の時間切れ');
    } catch {
      // 続けて閉じる
    }
    try {
      await withTimeout(session.disconnect(), closeMs, 'セッションを閉じられませんでした（時間切れ）');
    } catch {
      // 続けて、クライアントを止める
    }
  }
  if (client) {
    try {
      await withTimeout(client.stop(), closeMs, 'クライアントを止められませんでした（時間切れ）');
    } catch {
      try {
        await client.forceStop?.();
      } catch {
        // 止められないものは、そのままにする
      }
    }
  }
}
