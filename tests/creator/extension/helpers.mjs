// クリエイターのエクステンションの試験の道具。
// 作業フォルダと COPILOT_HOME は、試験ごとに作る一時フォルダ。終わったら、画面のサーバーを閉じて消す。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createFakeSession } from './fake-session.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** クリエイターのプラグインの根（リポジトリの直下） */
export const REPO_ROOT = path.resolve(here, '..', '..', '..');
export const EXTENSION_DIR = path.join(REPO_ROOT, 'com.github.copilot', 'extensions', 'plugin-creator');
export const TEMPLATE_EXTENSION_DIR = path.join(REPO_ROOT, 'template', 'com.github.copilot', 'extensions', '_plugin_');

export const T = (name) => `plugin-creator_${name}`;

/** 時を進められる時計 */
export function createClock(start = Date.parse('2026-10-22T09:00:00.000Z')) {
  let t = start;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
      return t;
    },
    iso: () => new Date(t).toISOString(),
  };
}

export function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `plugin-creator-test-${prefix}-`));
}

/** フォルダの中のファイルを、相対パスの一覧にする（空のフォルダも含む） */
export function listTree(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      out.push(path.relative(dir, full) + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * クリエイターのエクステンションを、偽物のセッションにつないで始める。
 * @param {object} [options]
 * @param {string} [options.sessionId]
 * @param {string} [options.home] 省くと一時フォルダ
 * @param {string} [options.cwd] 省くと一時フォルダ
 * @param {object} [options.clock]
 * @param {object} [options.extra] startCreator に足す設定（loadUi、runGh、examplesDir など）
 */
export async function startForTest({ sessionId = 'session-test-0001', home, cwd, clock = createClock(), extra = {} } = {}) {
  const { startCreator } = await import(pathToFileURL(path.join(EXTENSION_DIR, 'creator.mjs')).href);
  const ownHome = home === undefined;
  const ownCwd = cwd === undefined;
  home ??= tempDir('home');
  cwd ??= tempDir('cwd');
  const fake = createFakeSession({ sessionId, cwd });
  const warnings = [];
  const creator = await startCreator({
    joinSession: fake.joinSession,
    env: { SESSION_ID: sessionId, COPILOT_HOME: home },
    cwd,
    clock,
    examplesDir: path.join(home, 'no-examples'),
    warn: (text) => warnings.push(text),
    ...extra,
  });
  const run = {
    fake,
    creator,
    home,
    cwd,
    clock,
    warnings,
    sessionId,
    call: (name, args, options) => fake.callTool(T(name), args, options),
    callRaw: (name, args, options) => fake.callToolRaw(T(name), args, options),
    callSafe: (name, args, options) => fake.callToolSafe(T(name), args, options),
    hook: (name, input) => fake.hook(name, input),
    statePath: () => creator.store.statePath,
    qaPath: () => creator.store.qaPath,
    readState: () => JSON.parse(fs.readFileSync(creator.store.statePath, 'utf8')),
    readQa: () =>
      fs.existsSync(creator.store.qaPath)
        ? fs
            .readFileSync(creator.store.qaPath, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [],
    async cleanup() {
      await creator.shutdown();
      if (ownHome) fs.rmSync(home, { recursive: true, force: true });
      if (ownCwd) fs.rmSync(cwd, { recursive: true, force: true });
    },
  };
  return run;
}

// ---- ヒアリングを進める道具 -----------------------------------------------------------------------

/** 状態を変えられる項目（候補の確かめは自動、できていたことの確認は作り直しのときだけ）の名前 */
export const SETTABLE_ITEMS = [
  '作業の目的',
  '頼む場面と言い方',
  '受け取るもの',
  '進め方',
  '成果物',
  '合否の決め方',
  '決まった書き方やルール',
  '守らないと困ること',
  '使う道具と環境',
  'いつもと違うとき',
  '前回の1回',
  '資産',
  '標準機能と公開のプラグイン',
  '開始前に設定したいこと',
  '実行中に見たいこと',
  '終わった後に見たい結果と見せ方',
];

export const MAIN_ITEM_NAMES = SETTABLE_ITEMS.slice(0, 10);

/** 項目の状態を変える（抜き書きは「（項目名）への答え」） */
export function answers(names, status = '聞いた') {
  return { items: names.map((item) => ({ item, status, quote: `${item}への答え` })) };
}

/** 状態を変えられる項目のすべてを「聞いた」にする */
export async function answerEverything(run, { except = [] } = {}) {
  await run.call('progress', answers(SETTABLE_ITEMS.filter((n) => !except.includes(n))));
}

/** 決まったナレッジを1件記録する */
export function knowledge(overrides = {}) {
  return {
    kind: 'それ以外',
    item: '進め方',
    text: '毎週金曜日の17時までに提出する',
    source: 'ヒアリングの答え',
    quote: '金曜の17時までです',
    status: '決まった',
    ...overrides,
  };
}

/** 作業の定義の案（criteria なし）を、作業フォルダの決まった場所に書く */
export function writeDraft(cwd, overrides = {}) {
  const file = path.join(cwd, '.plugin-creator-work', 'draft', 'task.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const draft = {
    name: '週報の作成',
    maxIterationsDefault: 3,
    workers: [{ agent: 'worker', label: '週報を書く係' }],
    settings: [
      { key: 'week', label: '対象の週', type: 'text', default: '', required: true, help: '例：2026-W42' },
      { key: 'style', label: '書き方', type: 'select', default: '簡易', options: ['簡易', '詳細'] },
    ],
    displays: [
      { key: 'draft', label: '下書き', type: 'text', when: 'running' },
      { key: 'table', label: '集計表', type: 'table', when: 'finished' },
      { key: 'rate', label: '進み具合', type: 'progress', when: 'both' },
      { key: 'facts', label: '要点', type: 'kv', when: 'both' },
      { key: 'chart', label: 'グラフ', type: 'image', when: 'finished' },
      { key: 'report', label: '週報のファイル', type: 'file', when: 'finished' },
    ],
    ...overrides,
  };
  fs.writeFileSync(file, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
  return file;
}

/** EVAL の課題の実物の入力のファイルを、作業フォルダの inputs/ に置き、絶対パスを返す（確認のツールは、実物があるファイルの絶対パスだけを受け付ける） */
export function writeRealInput(cwd, name = '実績.xlsx') {
  const file = path.join(cwd, 'inputs', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '実績');
  return file;
}

/** 生成前の確認の引数（決まったナレッジの番号、振る舞いの案、作業の定義の案、EVAL の課題） */
export function confirmArgs(overrides = {}) {
  return {
    knowledgeIds: ['K-01', 'K-02'],
    behavior: '前回の週報を受け取り、今週の予定と実績を整理して、決まった書き方の週報を作る。',
    taskPath: '.plugin-creator-work/draft/task.json',
    evalTasks: [
      {
        prompt: '今週の週報を作ってください。',
        inputs: [{ path: 'inputs/前回の週報.docx', provisional: true }],
        criteria: ['K-02'],
        // 作業の定義の案（writeDraft）の「対象の週」は、必須で初めの値がないので、課題が値を入れる（省くと断られる）
        settings: { task: { week: '2026-W42' } },
      },
    ],
    ...overrides,
  };
}

/**
 * 生成前の確認の手前まで進める：項目をすべて「聞いた」にし、ナレッジ K-01（それ以外）と K-02（合否の決め方）を決める。
 * 作業の定義の案も書く。
 */
export async function readyToConfirm(run) {
  await answerEverything(run);
  await run.call('record', {
    knowledge: [
      knowledge({ item: '進め方', text: '毎週金曜日の17時までに提出する' }),
      knowledge({ kind: '合否の決め方', item: '合否の決め方', text: '見出しが「今週の実績」「来週の予定」の順に並んでいれば合格', quote: '実績が先、予定が後です' }),
    ],
  });
  writeDraft(run.cwd);
}

// ---- 今のプラグインを直す（plugin-creator_change）ための道具 ---------------------------------------------

/** 直すプラグインの決まりの一覧（組み立てのスクリプトが書く tests/knowledge.json の形。item は日本語の名前） */
export const PLUGIN_KNOWLEDGE = Object.freeze([
  { id: 'K-01', kind: 'other', item: '進め方', text: 'ビルドの前にソースのフォルダで git pull する' },
  { id: 'K-02', kind: 'criterion', item: '合否の決め方', text: '機器のログに AVG=25 と出れば合格' },
  { id: 'K-03', kind: 'other', item: '決まった書き方やルール', text: 'ログは logs/device.log に保存する' },
  { id: 'K-04', kind: 'criterion', item: '合否の決め方', text: 'dbg_log.h を変えていなければ合格' },
  { id: 'K-05', kind: 'other', item: 'いつもと違うとき', text: 'デプロイできないときは、機器を1回 reboot してやり直す' },
]);

/** 直すプラグインの作業の定義（合否の基準の番号の対応だけを使う） */
export const PLUGIN_TASK = Object.freeze({
  name: '組み込みのデバッグ',
  maxIterationsDefault: 3,
  criteria: [
    { id: 'C-01', text: '機器のログに AVG=25 と出れば合格', knowledge: 'K-02' },
    { id: 'C-02', text: 'dbg_log.h を変えていなければ合格', knowledge: 'K-04' },
  ],
  workers: [{ agent: 'worker', label: 'デバッグする係' }],
  settings: [],
  displays: [],
});

/** 直すプラグインの EVAL の課題（tests/eval/<番号>/eval.json） */
export const PLUGIN_EVALS = Object.freeze([{ id: 'T-01', prompt: 'inputs/src のプログラムの平均値の誤りを直してください。', criteria: [{ id: 'C-01' }, { id: 'C-02' }], inputs: ['inputs/src/main.c'] }]);

/**
 * 直すプラグインのフォルダを、作業フォルダの下に作り、その絶対パスを返す。
 * knowledge・task を null にすると、そのファイルを置かない（クリエイターが作っていないプラグイン）。
 * @param {string} cwd 作業フォルダ
 * @param {object} [options]
 */
export function writePluginFolder(
  cwd,
  { name = 'edl-sample', dir = name, knowledge = PLUGIN_KNOWLEDGE, removed = null, version = '0.1.0', manifestAt = 'plugin.json', task = PLUGIN_TASK, evals = PLUGIN_EVALS, extraFiles = {} } = {},
) {
  const folder = path.join(cwd, dir);
  const put = (rel, value) => {
    const file = path.join(folder, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  };
  put(manifestAt, { name, ...(version === null ? {} : { version }), description: '直すための見本のプラグイン' });
  if (knowledge !== null) put('tests/knowledge.json', knowledge);
  if (removed !== null) put('tests/knowledge-removed.json', removed);
  if (task !== null) put(`com.github.copilot/extensions/${name}/task.json`, task);
  for (const e of evals ?? []) {
    put(`tests/eval/${e.id}/eval.json`, { prompt: e.prompt, inputs: e.inputs ?? [], criteria: e.criteria ?? [] });
    for (const input of e.inputs ?? []) put(`tests/eval/${e.id}/${input}`, 'int main(void) { return 0; }\n');
  }
  for (const [rel, value] of Object.entries(extraFiles)) put(rel, value);
  return folder;
}

/**
 * plugin-creator_change を呼ぶ（直すプラグインのフォルダがなければ作る）。{ folder, text } を返す。
 * overrides.plugin は writePluginFolder の options、overrides.args は change の引数に足すもの。
 */
export async function startChange(run, { plugin = {}, args = {} } = {}) {
  const folder = writePluginFolder(run.cwd, plugin);
  const text = await run.call('change', { folder: path.relative(run.cwd, folder), wants: ['KX-200 のクロスコンパイルとデプロイの手順を組み込みたい'], ...args });
  return { folder, text };
}

/** 直すときの、変えるところに関わらない聞くこと（「変えないので聞かない」にするもの） */
export const UNCHANGED_ITEMS = ['作業の目的', '頼む場面と言い方', '受け取るもの', '成果物', '守らないと困ること', '開始前に設定したいこと', '実行中に見たいこと', '終わった後に見たい結果と見せ方'];

/**
 * 直す前の確認の手前まで進める：引き継いだ決まりをすべて「決まった」にし、変えるところに関わらない聞くことを「変えないので聞かない」に、
 * ほかを「聞いた」にする。足した決まり（合否の決め方）を1件記録し、作業の定義の案を書く。足した決まりの番号を返す。
 */
export async function readyToConfirmChange(run, { carried = PLUGIN_KNOWLEDGE.map((k) => k.id) } = {}) {
  if (carried.length) await run.call('record', { knowledge: carried.map((id) => ({ id, status: '決まった', quote: '一覧のとおりです' })) });
  await run.call('progress', answers(UNCHANGED_ITEMS, '変えないので聞かない'));
  await run.call('progress', answers(SETTABLE_ITEMS.filter((n) => !UNCHANGED_ITEMS.includes(n))));
  const added = await run.call('record', { knowledge: [knowledge({ kind: '合否の決め方', item: '合否の決め方', text: 'kxtool で 192.168.7.2 に送っていれば合格', quote: '送り先は 192.168.7.2 です' })] });
  writeDraft(run.cwd);
  return /K-\d+/.exec(added)[0];
}

/** 直す前の確認の引数（引き継いだ課題と、変えたところを試す課題、引き継ぐことと変わること、版） */
export function changeConfirmArgs(ids, overrides = {}) {
  return confirmArgs({
    knowledgeIds: ids,
    evalTasks: [
      { prompt: PLUGIN_EVALS[0].prompt, inputs: [{ path: 'tests/eval/T-01/inputs/src/main.c', provisional: true }], criteria: ['K-02', 'K-04'], settings: { task: { week: 'W42' } } },
      { prompt: 'KX-200 にデプロイして、機器のログを保存してください。', criteria: [ids[ids.length - 1]], settings: { task: { week: 'W42' } } },
    ],
    rebuild: { keep: ['ログを入れて原因を探す流れ', '引き継いだ決まり K-01〜K-05'], change: ['クロスコンパイルとデプロイのルールのスキルを足す', '土台を今の版に上げる（上書きされるファイル：tests/run.py）'] },
    version: '0.2.0',
    ...overrides,
  });
}

/** 始めて、fn を動かし、終わったら（失敗しても）片付ける */
export async function withRun(fn, options) {
  const run = await startForTest(options);
  try {
    return await fn(run);
  } finally {
    await run.cleanup();
  }
}

/** 内部の記号（英語）が、ユーザーに見える文に出ていないことを確かめる（hearing.md 7.5） */
export const INTERNAL_SYMBOLS = [
  'must_not_break',
  'candidate_check',
  'rebuild_check',
  'item_check',
  'rule_check',
  'last_case',
  'running_view',
  'result_view',
  'added_at_confirmation',
  'ai_decision',
  'existing_plugin',
  'volunteered',
  'public_plugin',
  'criterion',
  'decided',
  'dropped',
  'todo',
  'generate',
  'pending',
  'asked',
  'unchanged',
  'drafted',
  'carried',
  'replaces',
];

export function internalSymbolsIn(text) {
  return INTERNAL_SYMBOLS.filter((s) => new RegExp(`(^|[^A-Za-z_])${s}([^A-Za-z_]|$)`).test(String(text)));
}
