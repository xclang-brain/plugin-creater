// 画面の試験で使う偽物の中心の処理（core）。
// 状態の全体（BLUEPRINT 3.5 の形）を試験から決め、画面から呼ばれた操作を記録する。
// 本物の core は使わない（画面とサーバーだけを試験する）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 試験の対象の画面（ui/）の場所。ひな形でも生成プラグインでも、extensions/<名前>/ui/ を探す。 */
export function locateUi() {
  const root = path.resolve(here, '..', '..', '..');
  const extensions = path.join(root, 'com.github.copilot', 'extensions');
  for (const name of fs.readdirSync(extensions)) {
    const ui = path.join(extensions, name, 'ui');
    if (fs.existsSync(path.join(ui, 'app.mjs'))) return { root, extensionDir: path.join(extensions, name), uiDir: ui };
  }
  throw new Error(`画面（${extensions}/<名前>/ui/app.mjs）が見つかりません`);
}

export const MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
];

/** 作業の定義（task.json）の見本。設定の5種類と、表示の6種類を使う。 */
export const SAMPLE_TASK = {
  name: '週報の作成',
  maxIterationsDefault: 3,
  criteria: [
    { id: 'C-01', text: '先週の実績が3行以内にまとまっている', knowledge: 'K-03' },
    { id: 'C-02', text: '来週の予定に担当者が書いてある', knowledge: 'K-04' },
  ],
  workers: [{ agent: 'worker', label: '週報を書く係' }],
  settings: [
    { key: 'week', label: '対象の週', type: 'text', default: '', required: true, help: '例：2026-W42', options: [] },
    { key: 'items', label: '項目の数', type: 'number', default: 5, required: false, help: '週報に書く項目の数です。', options: [] },
    { key: 'tone', label: '文体', type: 'select', default: 'です・ます調', required: false, help: '', options: ['です・ます調', 'だ・である調'] },
    { key: 'attach', label: '前回の週報をつける', type: 'checkbox', default: false, required: false, help: '', options: [] },
    { key: 'folder', label: '保存先のフォルダ', type: 'path', default: '', required: false, help: '空なら作業フォルダに保存します。', options: [] },
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

export function prepState(overrides = {}) {
  return {
    version: 1,
    plugin: { name: 'weekly-report', title: SAMPLE_TASK.name },
    setup: {
      models: MODELS,
      defaults: { orchestrator: 'claude-opus-5-5', worker: 'claude-haiku-5-5', verifier: 'claude-opus-5-5' },
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      effortAgents: [
        { agent: 'orchestrator', label: '統括' },
        { agent: 'worker', label: '作業（週報を書く係）' },
        { agent: 'verifier', label: '検証' },
      ],
      maxIterationsDefault: 3,
      taskSettings: SAMPLE_TASK.settings,
      taskDisplays: SAMPLE_TASK.displays,
      isAuto: false,
      autoNotice: null,
      overrideNotice: '実行が終わると、このチャットでほかのエージェントに設定したモデルと思考の深さの指定も消えます。',
    },
    run: null,
    previous: null,
    notices: [],
    ...overrides,
  };
}

const agent = (slot, role, label, status, extra = {}) => ({
  slot,
  role,
  label,
  status,
  task: null,
  selectedModel: null,
  actualModel: null,
  lastActiveAt: null,
  replySummary: null,
  agentId: null,
  ...extra,
});

/** 実行中の状態の見本。phase：plan、do、study。 */
export function runState(phase = 'do', overrides = {}) {
  const running = (role) => (phase === { orchestrator: 'plan', worker: 'do', verifier: 'study' }[role] ? 'running' : 'standby');
  return prepState({
    run: {
      id: 'run-1',
      status: 'running',
      endReason: null,
      settings: { models: { orchestrator: 'claude-opus-5-5', worker: 'claude-haiku-5-5', verifier: 'claude-opus-5-5' }, maxIterations: 3, task: { week: '2026-W42' } },
      isAuto: false,
      phase,
      iteration: 1,
      maxIterations: 3,
      agents: [
        agent('orchestrator', 'orchestrator', '統括', running('orchestrator'), { task: '計画を立てる', selectedModel: 'claude-opus-5-5', actualModel: 'claude-opus-5-5', lastActiveAt: Date.UTC(2026, 9, 22, 3, 4, 5), agentId: 'ag-orch', replySummary: '計画を記録しました。' }),
        agent('worker', 'worker', '週報を書く係', running('worker'), { task: '週報の下書きを書く', selectedModel: 'claude-haiku-5-5', actualModel: 'claude-haiku-5-5', lastActiveAt: Date.UTC(2026, 9, 22, 3, 4, 9), agentId: 'ag-work' }),
        agent('verifier', 'verifier', '検証', running('verifier'), { selectedModel: 'claude-opus-5-5', agentId: null }),
      ],
      iterations: [
        {
          n: 1,
          criteria: [
            { id: 'C-01', text: SAMPLE_TASK.criteria[0].text, fromUser: true },
            { id: 'C-02', text: SAMPLE_TASK.criteria[1].text, fromUser: true },
            { id: 'C-03', text: '誤字がない', fromUser: false },
          ],
          plan: '先週の記録を読み、3行にまとめる。',
          verdicts: [],
          agentIds: ['ag-work'],
        },
      ],
      displays: {},
      summary: null,
      issues: [],
      canFile: { ok: true, reason: null, steps: [] },
      unstopped: [],
      waits: [],
    },
    ...overrides,
  });
}

/** 終わった状態の見本。 */
export function finishedState(endReason = { kind: 'all_passed', detail: null, unstoppable: false }, overrides = {}) {
  const base = runState('study');
  base.run = {
    ...base.run,
    status: 'finished',
    endReason,
    phase: null,
    agents: base.run.agents.map((a) => ({ ...a, status: 'completed' })),
    summary: '週報を1回で作成しました。',
    ...overrides,
  };
  return base;
}

// ---- 崩れ・色・書き方の試験で使う、長い文字や全部の部品を含む状態 ----

// ---- 試験用の状態 --------------------------------------------------------------------------------

export const LONG = 'あ'.repeat(10) + 'x'.repeat(150); // 途中で切れない長い文字
export const LONG_COMMAND = `curl -s https://example.com/${'path/'.repeat(30)}file.tar.gz -o /tmp/${'a'.repeat(120)} && tar xzf /tmp/${'a'.repeat(120)}`;

/** 作業の定義の表示を、いつでも出るようにしたもの（崩れと色の試験で、全部の部品を同時に出すため） */
export const ALL_DISPLAYS_TASK = { ...SAMPLE_TASK, displays: SAMPLE_TASK.displays.map((d) => ({ ...d, when: 'both' })) };

export function richRunning() {
  const state = runState('do');
  const agent = (slot, role, label, status, extra = {}) => ({ slot, role, label, status, task: '', selectedModel: 'claude-haiku-5-5', actualModel: 'claude-haiku-5-5', lastActiveAt: Date.UTC(2026, 9, 22, 3, 4, 5), replySummary: '', agentId: null, ...extra });
  state.run.agents = [
    agent('orchestrator', 'orchestrator', '統括', 'completed', { task: '計画を立てる', replySummary: LONG, agentId: 'ag-orch' }),
    agent('worker', 'worker', '週報を書く係', 'running', { task: LONG, selectedModel: 'claude-opus-5-5', actualModel: 'gpt-6-luna', agentId: 'ag-work', replySummary: '下書きを書いています。\n'.repeat(5) }),
    agent('worker-b', 'worker', '集計をする係', 'waiting', { task: '集計する', agentId: 'ag-work-b' }),
    agent('verifier', 'verifier', '検証', 'standby', {}),
  ];
  state.run.isAuto = true;
  state.run.waits = [
    { requestId: 'r1', slot: 'worker-b', kind: 'permission', detail: { permissionKind: 'shell', toolKind: 'shell', command: LONG_COMMAND, paths: [`/work/${'dir/'.repeat(30)}file`], urls: [`https://example.com/${'p'.repeat(100)}`], warning: '外のファイルを消すかもしれません。', sandboxBypass: true } },
    { requestId: 'r2', slot: 'worker', kind: 'question', detail: { question: `どちらの形式で保存しますか？ ${LONG}` } },
    { requestId: 'r3', slot: null, kind: 'limit', detail: {} },
  ];
  state.run.iterations = [
    {
      n: 1,
      criteria: [
        { id: 'C-01', text: LONG, fromUser: true },
        { id: 'C-02', text: '来週の予定に担当者が書いてある', fromUser: true },
        { id: 'C-03', text: '誤字がない', fromUser: false },
      ],
      plan: `先週の記録を読み、3行にまとめる。${LONG}`,
      verdicts: [
        { criterionId: 'C-01', pass: true, note: '' },
        { criterionId: 'C-02', pass: false, note: `担当者が書かれていません。${LONG}` },
      ],
      agentIds: ['ag-work', 'ag-work-b'],
    },
    { n: 2, criteria: [{ id: 'C-01', text: '先週の実績が3行以内にまとまっている', fromUser: true }], plan: '直す', verdicts: [], agentIds: [] },
  ];
  state.run.iteration = 2;
  state.run.displays = {
    draft: `下書きの本文です。${'長い文章が続きます。'.repeat(60)}`,
    meta: { [`見出し${LONG}`]: LONG, 週: '2026-W42' },
    stats: { columns: ['項目', '件数', '備考', '担当', '期限', '状態', '詳細'], rows: [['A', 1, LONG, 'x', 'y', 'z', 'w'], ['B', 2, '', '', '', '', '']] },
    progress: { value: 3, max: 8, label: '進み具合' },
    chart: { fileId: 'f1', name: 'chart.png' },
    report: { fileId: 'f2', name: '週報.md' },
  };
  state.run.summary = `まとめの文です。${'まとめが続きます。'.repeat(50)}`;
  state.run.issues = [
    { id: 'i1', title: `課題の題 ${LONG}`, body: '本文\n2行目', source: 'mechanical', filing: { state: 'none', url: null, reason: null } },
    { id: 'i2', title: '振り返りの案', body: '本文', source: 'orchestrator', filing: { state: 'filed', url: 'https://github.com/o/r/issues/1', reason: null } },
  ];
  state.setup.isAuto = true;
  state.notices = ['この実行の記録は、手元のフォルダに書いています。'];
  return state;
}

export function richFinished() {
  const state = richRunning();
  state.run.status = 'finished';
  state.run.phase = null;
  state.run.waits = [];
  state.run.endReason = { kind: 'aborted', detail: 'credit_limit', unstoppable: true };
  state.run.agents = state.run.agents.map((a, i) => ({ ...a, status: ['completed', 'failed', 'stopped', 'unstopped'][i] }));
  state.run.unstopped = [{ agentId: 'ag-work-b', role: 'worker', howTo: 'チャットで Esc を2回押すか、Copilot CLI を終えてください。' }];
  state.run.canFile = { ok: false, reason: 'gh にログインしていません。', steps: ['gh auth login を実行する。', 'プラグインをアンインストールしてから、もう一度インストールする。'] };
  state.run.issues = [
    { id: 'i1', title: '未起票の案', body: '本文', source: 'mechanical', filing: { state: 'none', url: null, reason: null } },
    { id: 'i2', title: '起票済みの案', body: '本文', source: 'orchestrator', filing: { state: 'filed', url: 'https://github.com/o/r/issues/2', reason: null } },
    { id: 'i3', title: '失敗した案', body: '本文', source: 'mechanical', filing: { state: 'failed', url: null, reason: '時間切れです。' } },
    { id: 'i4', title: '分からない案', body: '本文', source: 'mechanical', filing: { state: 'unknown', url: null, reason: '起票できたか分かりません。' } },
    { id: 'i5', title: '起票中の案', body: '本文', source: 'mechanical', filing: { state: 'filing', url: null, reason: null } },
  ];
  return state;
}

export function richPrep() {
  return prepState({
    setup: { ...prepState().setup, isAuto: true, autoNotice: null },
    notices: ['前回の実行は途中で切れました。'],
    previous: {
      endReason: { kind: 'aborted', detail: 'cut_off', unstoppable: false },
      summary: `前回のまとめ ${LONG}`,
      finishedAt: Date.UTC(2026, 9, 21, 12, 0, 0),
      issues: [
        { id: 'p1', title: `前の案 ${LONG}`, body: '本文', source: 'mechanical', filing: { state: 'none', url: null, reason: null } },
        { id: 'p2', title: '起票済みの前の案', body: '本文', source: 'orchestrator', filing: { state: 'filed', url: 'https://github.com/o/r/issues/3', reason: null } },
      ],
    },
  });
}

/**
 * 偽物の core。
 * - set(関数 か 部分): 状態を変えて版の番号を上げる。setSilently は版の番号を上げない。
 * - calls: 呼ばれた操作の記録 [{ name, args }]。
 * - replies / files: getReply / getFile が返すもの。
 * - refusals: { start, stop, fileIssue } に Error を入れると、その操作を断る。
 * - hooks: { start, stop, fileIssue } に関数を入れると、呼ばれたときに状態を変えられる。
 */
export function createFakeCore(initial = prepState()) {
  let state = structuredClone(initial);
  let version = 1;
  const calls = [];
  const core = {
    calls,
    replies: {},
    files: {},
    refusals: {},
    hooks: {},
    callsOf: (name) => calls.filter((call) => call.name === name),
    set(next) {
      state = typeof next === 'function' ? (next(structuredClone(state)) ?? state) : { ...state, ...next };
      version += 1;
    },
    setSilently(next) {
      state = typeof next === 'function' ? (next(structuredClone(state)) ?? state) : { ...state, ...next };
    },
    getState: () => ({ ...structuredClone(state), version }),
    async start(settings) {
      calls.push({ name: 'start', args: [settings] });
      if (core.refusals.start) throw core.refusals.start;
      await core.hooks.start?.(settings, core);
    },
    async stop() {
      calls.push({ name: 'stop', args: [] });
      if (core.refusals.stop) throw core.refusals.stop;
      await core.hooks.stop?.(core);
    },
    async fileIssue(issueId) {
      calls.push({ name: 'fileIssue', args: [issueId] });
      if (core.refusals.fileIssue) throw core.refusals.fileIssue;
      await core.hooks.fileIssue?.(issueId, core);
    },
    async getReply(agentId) {
      calls.push({ name: 'getReply', args: [agentId] });
      return core.replies[agentId] ?? null;
    },
    async getFile(fileId) {
      calls.push({ name: 'getFile', args: [fileId] });
      return core.files[fileId] ?? null;
    },
  };
  return core;
}
