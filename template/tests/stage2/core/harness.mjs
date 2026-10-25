// 中心の処理（core）の試験の道具。偽物の窓口と偽物の時計で core を動かし、イベントと記録のツールの呼び出しを組み立てる。
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFakeClock } from '../fake-clock.mjs';
import { createFakePort } from '../fake-port.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// 試験の対象（extensions/<名前>/core/）の場所。ひな形でも生成プラグインでも探せるようにする。
export function locateCore() {
  const root = resolve(here, '..', '..', '..');
  const extensions = join(root, 'com.github.copilot', 'extensions');
  for (const name of readdirSync(extensions)) {
    const dir = join(extensions, name, 'core');
    try {
      readdirSync(dir);
      if (readdirSync(dir).includes('index.mjs')) return { root, extensionDir: join(extensions, name), coreDir: dir };
    } catch {
      // 次の候補へ
    }
  }
  throw new Error(`中心の処理（${extensions}/<名前>/core/index.mjs）が見つかりません`);
}

const located = locateCore();
const coreUrl = (file) => pathToFileURL(join(located.coreDir, file)).href;
const { createCore } = await import(coreUrl('index.mjs'));
export const { LIMITS } = await import(coreUrl('constants.mjs'));
export const { TOOL_DEFS, buildToolDefinitions } = await import(coreUrl('tools.mjs'));
export const recovery = await import(coreUrl('recovery.mjs'));
export const github = await import(coreUrl('github.mjs'));
export { createCore };

export const PLUGIN = 'weekly-report';

// 作業の定義の見本（BLUEPRINT 4.1）
export const TASK = {
  name: '週報の作成',
  maxIterationsDefault: 3,
  criteria: [
    { id: 'C-01', text: '先週の実績が3行以内にまとまっている', knowledge: 'K-03' },
    { id: 'C-02', text: '来週の予定に担当者が書いてある', knowledge: 'K-04' },
  ],
  workers: [{ agent: 'worker', label: '週報を書く係' }],
  settings: [
    { key: 'week', label: '対象の週', type: 'text', default: '', required: true, help: '例：2026-W42', options: [] },
    { key: 'items', label: '項目の数', type: 'number', default: 5, required: false, help: '', options: [] },
    {
      key: 'tone',
      label: '文体',
      type: 'select',
      default: 'desu',
      required: false,
      help: '',
      options: [
        { value: 'desu', label: 'です・ます調' },
        { value: 'da', label: 'だ・である調' },
      ],
    },
    { key: 'attach', label: '前回の週報をつける', type: 'checkbox', default: false, required: false, help: '', options: [] },
  ],
  displays: [
    { key: 'draft', label: '下書き', type: 'text', when: 'running' },
    { key: 'meta', label: '概要', type: 'kv', when: 'both' },
    { key: 'stats', label: '集計', type: 'table', when: 'finished' },
    { key: 'progress', label: '進み具合', type: 'progress', when: 'running' },
    { key: 'chart', label: 'グラフ', type: 'image', when: 'both' },
    { key: 'report', label: 'できあがった週報', type: 'file', when: 'finished' },
  ],
};

const AGENT_MD = (model) => `---\nname: x\ndescription: x\nmodel:\n${model.map((m) => `  - ${m}`).join('\n')}\n---\n本文\n`;

// 偽物の gh（実行ファイル）。動きは同じフォルダの config.json で決め、呼ばれた内容は calls.jsonl に残す。
const FAKE_GH_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return d; } };
const config = read('config.json', {});
const args = process.argv.slice(2);
let stdin = '';
const finish = () => {
  fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ args, stdin }) + '\\n');
  const key = args[0] === 'issue' ? 'issue ' + args[1] : args.join(' ');
  const b = config[key] ?? config[args[0]] ?? {};
  if (b.hang) return setTimeout(() => {}, 600000);
  if (b.stderr) process.stderr.write(b.stderr);
  if (b.stdout !== undefined) process.stdout.write(typeof b.stdout === 'string' ? b.stdout : JSON.stringify(b.stdout));
  process.exit(b.code ?? 0);
};
if (args[0] === 'issue' && args[1] === 'create') {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { stdin += d; });
  process.stdin.on('end', finish);
} else {
  finish();
}
`;

export function createFakeGh(dir) {
  mkdirSync(dir, { recursive: true });
  const command = join(dir, 'gh');
  writeFileSync(command, FAKE_GH_SOURCE);
  chmodSync(command, 0o755);
  const gh = {
    command,
    // 動きを決める。キーは 'issue create'、'issue list'、'auth status'、'--version'
    configure(config) {
      writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    },
    calls() {
      try {
        return readFileSyncLines(join(dir, 'calls.jsonl'));
      } catch {
        return [];
      }
    },
  };
  gh.configure({
    '--version': { stdout: 'gh version 2.0.0\n' },
    'auth status': { stdout: 'Logged in\n' },
    'issue create': { stdout: 'https://github.com/example/weekly-report/issues/1\n' },
    'issue list': { stdout: '[]' },
  });
  return gh;
}

function readFileSyncLines(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// 試験 1 本分の道具。reuse に前の道具を渡すと、記録の置き場所・作業フォルダ・プラグインの根を引き継ぐ（起動し直し）。
// options.cwd を渡すと、作業フォルダだけを替えられる（ほかの作業フォルダの実行を見る試験）。
export async function makeHarness(t, options = {}) {
  const reuse = options.reuse ?? null;
  const base = reuse ? reuse.base : mkdtempSync(join(tmpdir(), 'a1-core-'));
  const pluginRoot = reuse ? reuse.pluginRoot : join(base, 'plugin');
  const cwd = options.cwd ?? (reuse ? reuse.cwd : join(base, 'work'));
  const dataRoot = reuse ? reuse.dataRoot : join(base, 'data', 'runs');
  mkdirSync(cwd, { recursive: true });
  if (!reuse) {
    mkdirSync(join(pluginRoot, 'com.github.copilot', 'agents'), { recursive: true });
    writeFileSync(
      join(pluginRoot, 'plugin.json'),
      JSON.stringify({ name: PLUGIN, version: '0.1.0', description: '週報', repository: options.repository ?? 'https://github.com/example/weekly-report' }),
    );
    writeFileSync(join(pluginRoot, 'com.github.copilot', 'agents', 'orchestrator.agent.md'), AGENT_MD(['claude-opus-5-5']));
    writeFileSync(join(pluginRoot, 'com.github.copilot', 'agents', 'worker.agent.md'), AGENT_MD(['claude-haiku-5-5', 'gpt-6-luna']));
    writeFileSync(join(pluginRoot, 'com.github.copilot', 'agents', 'verifier.agent.md'), AGENT_MD(['claude-opus-5-5']));
    t.after(() => rmSync(base, { recursive: true, force: true }));
  }
  const clock = options.clock ?? reuse?.clock ?? createFakeClock();
  const port = options.port ?? createFakePort({ clock, idPrefix: options.idPrefix ?? '' });
  const sessionId = options.sessionId ?? reuse?.sessionId ?? 'session-1';
  const uiCalls = [];
  const startUi = options.startUi ?? (async (core) => {
    uiCalls.push(core);
    return { url: 'http://127.0.0.1:9/?k=test', close: async () => {} };
  });
  const gh = options.gh ?? null;
  const core = createCore({
    port,
    pluginRoot,
    pluginName: PLUGIN,
    dataRoot,
    sessionId,
    cwd,
    clock,
    startUi,
    task: options.task ?? TASK,
    ghCommand: gh ? gh.command : 'gh-not-installed-for-test',
  });
  t.after(() => core.shutdown());

  const h = {
    base,
    pluginRoot,
    cwd,
    dataRoot,
    sessionId,
    clock,
    port,
    core,
    gh,
    uiCalls,
    root: null,

    // 待っている Promise を片づける。偽物の時計の待ちは動かさない（列が空になるのは待たない）
    async settle() {
      await clock.flush();
    },
    state: () => core.getState(),
    run: () => core.getState().run,

    settings(extra = {}) {
      return {
        models: { orchestrator: 'claude-opus-5-5', worker: 'gpt-6-luna', verifier: 'claude-opus-5-5', ...(extra.models ?? {}) },
        ...(extra.efforts ? { efforts: extra.efforts } : {}),
        maxIterations: extra.maxIterations ?? 3,
        task: { week: '2026-W42', items: 4, tone: 'desu', attach: true, ...(extra.task ?? {}) },
      };
    },

    // 画面を開いて、開始して、実行中にする。統括の番号を返す
    async begin(extra = {}) {
      await core.open({ requestText: extra.requestText ?? '先週の週報を作ってください' });
      const p = core.start(h.settings(extra));
      await h.settle();
      await p;
      h.root = port.callsOf('startAgent').length > 0 ? port.tasks.find((x) => x.agentType === `${PLUGIN}:orchestrator`)?.agentId : null;
      await h.event({ type: 'agent.started', agentId: h.root, agentType: `${PLUGIN}:orchestrator`, model: 'claude-opus-5-5', executionMode: 'background', description: '統括' });
      return h.root;
    },

    async event(e) {
      core.onEvent({ at: clock.now(), ...e });
      await h.settle();
    },

    // 木の下のエージェントを動かす（一覧に載せて、開始のイベントを流す）
    async spawn(role, { parent = h.root, id, executionMode = 'sync', model = 'gpt-6-luna', description } = {}) {
      const agentId = id ?? `${role}-${port.tasks.length + 1}`;
      port.spawn({ agentId, parentAgentId: parent, agentType: `${PLUGIN}:${role}`, executionMode });
      await h.event({ type: 'agent.started', agentId, parentAgentId: parent, agentType: `${PLUGIN}:${role}`, model, executionMode, description: description ?? `${role} の作業` });
      return agentId;
    },

    async complete(agentId, { cancelled = false, response = '終わりました' } = {}) {
      port.setStatus(agentId, cancelled ? 'cancelled' : 'completed');
      await h.event({ type: 'agent.completed', agentId, cancelled, response });
    },

    tool: (name, args, agentId) => core.handleTool(name, args, { agentId }),

    planArgs(n, { extra = [] } = {}) {
      return { iteration: n, criteria: [...TASK.criteria.map(({ id, text }) => ({ id, text })), ...extra], plan: `試行 ${n} の計画` };
    },

    verdictArgs(n, { pass = true, only } = {}) {
      return {
        iteration: n,
        verdicts: TASK.criteria.map((c, i) => ({ criterionId: c.id, pass: typeof pass === 'function' ? pass(c, i) : pass, note: pass === true ? '' : '直してください' })),
        ...(only ? { verdicts: only } : {}),
      };
    },

    // 1 回の試行（計画 → 作業 → 検証 → 合否の記録）を最後まで動かす
    async iterate(n, { pass = true } = {}) {
      await h.tool('plan', h.planArgs(n), h.root);
      const worker = await h.spawn('worker');
      await h.complete(worker);
      const verifier = await h.spawn('verifier', { model: 'claude-opus-5-5' });
      await h.tool('verdict', h.verdictArgs(n, { pass }), verifier);
      await h.complete(verifier);
      return { worker, verifier };
    },

    // まとめ中にする（1 回で全部合格）
    async toSummarizing() {
      await h.begin();
      return h.iterate(1);
    },

    // 統括が手番を終えて待ちに入った
    async rootIdle() {
      port.setStatus(h.root, 'idle');
      await h.event({ type: 'agent.idle', agentId: h.root });
    },
  };
  return h;
}

// 状態の全体から、エージェントの枠を役割で引く
export const slotOf = (run, slot) => run.agents.find((a) => a.slot === slot);

export async function expectRefusal(promise) {
  try {
    await promise;
  } catch (e) {
    return e.message;
  }
  throw new Error('断られると思ったが、断られなかった');
}
