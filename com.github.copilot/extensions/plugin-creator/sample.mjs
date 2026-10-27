// Web管理画面の見本（REQ-027、generated-plugin-structure.md 9章、ユーザーの答え4・7）。
//
// 生成前の確認で受けた作業の定義の案（<作業フォルダ>/.plugin-creator-work/draft/task.json）に、
// 「合否の決め方」のナレッジから合否の基準を差し込み、仮のデータを入れた状態の全体（BLUEPRINT 3.5）を作って、
// ひな形の生成プラグインの画面（ui/static）で見せる。画面のサーバーはクリエイターの画面とは別に、見本のために1つ起動する。
//
// 見本の動き：最初は「開始前の設定」。「開始する」を押すと、仮のデータが入った「実行中」、「止める」を押すと「終わった後」に変わる。
// どれも仮のデータで、実際には何も動かない。

import fs from 'node:fs';

import { checkSchema } from './schema-check.mjs';

/**
 * 作業の定義の案に、合否の基準を差し込む。案は変えず、写しを返す。
 * 基準は番号つき（change.mjs の criteriaRows の結果：{ id, text, knowledge }）で受け、番号を付け直さない（BLUEPRINT 4.4）
 */
export function injectCriteria(draft, criteria) {
  return {
    ...draft,
    criteria: criteria.map((c) => ({ id: c.id, text: c.text, knowledge: c.knowledge })),
  };
}

/**
 * 差し込んだ作業の定義を、ひな形の決まり（task.schema.json）で確かめる。
 * @returns {string[]} 合わない点の文。合えば空
 */
export function checkTaskDefinition(task, schema) {
  return checkSchema(task, schema, 'task.json');
}

/** 作業の定義の案を読む。読めなければ理由つきの Error（message は平易な日本語） */
export function readDraft(file) {
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(error.code === 'ENOENT' ? `画面と合格の条件の設定の案が見つかりません：${file}` : `画面と合格の条件の設定の案を読めません：${file}（${error.message}）`);
  }
  try {
    const value = JSON.parse(source);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON のまとまり（{ }）ではありません');
    return value;
  } catch (error) {
    throw new Error(`画面と合格の条件の設定の案が JSON として読めません：${file}（${error.message}）`);
  }
}

// ---- 仮のデータ ----------------------------------------------------------------------------

/** 表示の種類ごとの、仮の値 */
function sampleValue(def) {
  switch (def.type) {
    case 'kv':
      return { 見出し1: '（見本）仮の値', 見出し2: '（見本）仮の値', 見出し3: '（見本）仮の値' };
    case 'table':
      return {
        columns: ['列1', '列2', '列3'],
        rows: [
          ['（見本）', '（見本）', '（見本）'],
          ['（見本）', '（見本）', '（見本）'],
        ],
      };
    case 'progress':
      return { value: 60, max: 100, label: def.label };
    case 'image':
      return { fileId: 'sample-image', name: '見本の画像.svg' };
    case 'file':
      return { fileId: 'sample-file', name: '見本のファイル.txt' };
    default:
      return `（見本）ここに「${def.label}」の文章が出ます。仮のデータです。`;
  }
}

/** 必須の設定が空のままだと、見本の「開始する」を押せない。仮の初めの値を入れる */
function withSampleDefaults(settings) {
  return settings.map((s) => {
    const empty = s.default === undefined || s.default === '';
    if (!s.required || !empty) return s;
    if (s.type === 'number') return { ...s, default: 1 };
    if (s.type === 'select') return { ...s, default: s.options?.[0] ?? '' };
    if (s.type === 'checkbox') return { ...s, default: false };
    return { ...s, default: s.type === 'path' ? '（見本の場所）' : '（見本）' };
  });
}

const SAMPLE_MODEL = { id: 'sample-model', name: '見本のモデル' };

const NOTICES = [
  { text: 'これは作業の画面の見本です。表示は仮のデータで、実際には何も動きません。「開始する」を押すと実行中の見本、「止める」を押すと終わった後の見本に変わります。' },
];

/**
 * 状態の全体（BLUEPRINT 3.5）を作る。
 * @param {object} options
 * @param {object} options.task 合否の基準を差し込んだ作業の定義
 * @param {'preparing'|'running'|'finished'} options.mode
 * @param {number} options.version
 * @param {number} options.nowMs
 */
export function buildSampleState({ task, mode, version, nowMs }) {
  const settings = withSampleDefaults(task.settings ?? []);
  const maxIterations = task.maxIterationsDefault ?? 3;
  const base = {
    version,
    plugin: { name: 'sample', title: task.name },
    setup: {
      models: [SAMPLE_MODEL],
      defaults: { orchestrator: SAMPLE_MODEL.id, worker: SAMPLE_MODEL.id, verifier: SAMPLE_MODEL.id },
      maxIterationsDefault: maxIterations,
      taskSettings: settings,
      isAuto: false,
    },
    run: null,
    previous: null,
    notices: NOTICES,
    taskDisplays: task.displays ?? [],
  };
  if (mode === 'preparing') return base;

  const running = mode === 'running';
  const criteria = (task.criteria ?? []).map((c) => ({ id: c.id, text: c.text, fromUser: true }));
  const agent = (slot, role, label, status, work, summary) => ({
    slot,
    role,
    label,
    status,
    task: work,
    selectedModel: SAMPLE_MODEL.name,
    actualModel: SAMPLE_MODEL.name,
    lastActiveAt: nowMs,
    replySummary: summary,
  });
  const workers = (task.workers ?? []).map((w, i) =>
    agent(`worker-${i + 1}`, 'worker', w.label, running ? 'running' : 'completed', '（見本）成果物を作る', running ? '' : '（見本）成果物を作りました。'),
  );
  const agents = [
    agent('orchestrator', 'orchestrator', '統括', running ? 'standby' : 'completed', '（見本）計画を立てて、結果をまとめる', running ? '' : '（見本）すべての合格の条件を満たしました。'),
    ...workers,
    agent('verifier', 'verifier', '検証', running ? 'standby' : 'completed', '（見本）成果物を合格の条件で確かめる', running ? '' : '（見本）すべて合格です。'),
  ];
  const displays = {};
  for (const def of task.displays ?? []) displays[def.key] = sampleValue(def);

  base.run = {
    id: 'sample-run',
    status: running ? 'running' : 'finished',
    endReason: running ? null : { kind: 'all_passed', detail: null, unstoppable: false },
    settings: {
      models: { orchestrator: SAMPLE_MODEL.id, worker: SAMPLE_MODEL.id, verifier: SAMPLE_MODEL.id },
      maxIterations,
      task: Object.fromEntries(settings.map((s) => [s.key, s.default ?? ''])),
    },
    isAuto: false,
    phase: running ? 'do' : null,
    iteration: 1,
    maxIterations,
    agents,
    iterations: [
      {
        n: 1,
        criteria,
        plan: '（見本）合格の条件を満たす成果物を作る計画です。',
        verdicts: running ? [] : criteria.map((c) => ({ criterionId: c.id, pass: true, note: '' })),
        agentIds: [],
      },
    ],
    displays,
    summary: running ? '' : '（見本）仮のまとめです。実際には、実行の結果がここに出ます。',
    issues: [],
    canFile: { ok: true },
    unstopped: [],
    waits: [],
  };
  return base;
}

// ---- 見本の画面のサーバー ---------------------------------------------------------------------

const SAMPLE_IMAGE = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" viewBox="0 0 320 120"><rect width="320" height="120" fill="#e8eef5"/><text x="160" y="66" font-size="20" text-anchor="middle" fill="#2b3a4a" font-family="sans-serif">見本の画像（仮）</text></svg>`;
const SAMPLE_FILE = 'これは作業の画面の見本のファイルです。仮のデータです。\n';

/**
 * 見本の画面のサーバーを持つ。
 * @param {object} options
 * @param {() => Promise<{ startServer: Function, HttpError: Function, Reply: Function, templateStaticDir: string }>} options.loadUi ひな形の画面の部品
 * @param {{ now: () => number }} options.clock
 */
export function createSample({ loadUi, clock }) {
  let server = null;
  let task = null;
  let mode = 'preparing';
  let version = 0;
  let starting = null;

  const current = () => buildSampleState({ task, mode, version, nowMs: clock.now() });

  async function start() {
    const ui = await loadUi();
    const { HttpError, Reply } = ui;
    return ui.startServer({
      preferredPort: 0,
      staticDir: ui.templateStaticDir,
      routes: {
        'GET /api/state': () => current(),
        'POST /api/start': () => {
          mode = 'running';
          version += 1;
          return { ok: true };
        },
        'POST /api/stop': () => {
          mode = 'finished';
          version += 1;
          return { ok: true };
        },
        'GET /api/files/:id': ({ params }) => {
          if (params.id === 'sample-image') {
            return new Reply({ headers: { 'Content-Type': 'image/svg+xml', 'Content-Security-Policy': 'sandbox' }, body: SAMPLE_IMAGE });
          }
          if (params.id === 'sample-file') {
            return new Reply({
              headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Content-Disposition': "attachment; filename=\"sample.txt\"; filename*=UTF-8''%E8%A6%8B%E6%9C%AC.txt",
                'Content-Security-Policy': 'sandbox',
              },
              body: SAMPLE_FILE,
            });
          }
          throw new HttpError(404, 'ファイルが見つかりません');
        },
        'GET /api/agents/:id/reply': () => {
          throw new HttpError(404, '返事が見つかりません');
        },
        'POST /api/issues/:id/file': () => {
          throw new HttpError(400, '見本では起票できません');
        },
      },
    });
  }

  return {
    /**
     * 見本を作り直す（生成前の確認のたび）。画面のサーバーは、まだなら起動する。URL は同じまま。
     * @returns {Promise<string>} 見本の画面の URL
     */
    async update(nextTask) {
      task = nextTask;
      mode = 'preparing';
      version += 1;
      if (!server) {
        starting ??= start().then(
          (s) => {
            server = s;
            return s;
          },
          (error) => {
            starting = null;
            throw error;
          },
        );
        await starting;
      }
      return server.url;
    },
    get url() {
      return server?.url ?? null;
    },
    get state() {
      return task ? current() : null;
    },
    async close() {
      const s = server;
      server = null;
      starting = null;
      if (s) await s.close();
    },
  };
}
