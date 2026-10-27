// 2段目 部品の試験（クリエイターのエクステンション）：Web管理画面の見本（REQ-027）と、作業の定義の決まりの確かめ。
// 設計書：generated-plugin-structure.md 9章（Web管理画面の見本）、hearing.md 6.3、6.4、RESUME ユーザーの答え4・7。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { EXTENSION_DIR, TEMPLATE_EXTENSION_DIR, confirmArgs, readyToConfirm, withRun, writeDraft } from './helpers.mjs';

const load = (name) => import(pathToFileURL(path.join(EXTENSION_DIR, name)).href);
const { checkSchema } = await load('schema-check.mjs');
const { buildSampleState, injectCriteria } = await load('sample.mjs');

const SCHEMA_FILE = path.join(TEMPLATE_EXTENSION_DIR, 'core', 'task.schema.json');
const schema = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));

const GOOD_TASK = {
  name: '週報の作成',
  maxIterationsDefault: 3,
  criteria: [{ id: 'C-01', text: '見出しが順に並んでいる', knowledge: 'K-02' }],
  workers: [{ agent: 'worker', label: '週報を書く係' }, { agent: 'worker-table', label: '表を作る係' }],
  settings: [
    { key: 'week', label: '対象の週', type: 'text', default: '', required: true, help: '例：2026-W42' },
    { key: 'count', label: '件数', type: 'number', default: 3 },
    { key: 'style', label: '書き方', type: 'select', default: '簡易', options: ['簡易', '詳細'] },
    { key: 'draft', label: '下書きを出す', type: 'checkbox', default: false },
    { key: 'folder', label: '保存先', type: 'path', default: '' },
  ],
  displays: [
    { key: 'a', label: 'A', type: 'text', when: 'running' },
    { key: 'b', label: 'B', type: 'kv', when: 'finished' },
    { key: 'c', label: 'C', type: 'table', when: 'both' },
    { key: 'd', label: 'D', type: 'progress', when: 'both' },
    { key: 'e', label: 'E', type: 'image', when: 'finished' },
    { key: 'f', label: 'F', type: 'file', when: 'finished' },
  ],
};

const clone = (v) => JSON.parse(JSON.stringify(v));

describe('作業の定義の決まりの確かめ（schema-check）', () => {
  test('REQ-027 ひな形の決まり（core/task.schema.json）に合う作業の定義は通り、合わないものは直す点を平易な日本語で返す', () => {
    assert.deepEqual(checkSchema(GOOD_TASK, schema), []);

    const bad = clone(GOOD_TASK);
    bad.name = '';
    bad.maxIterationsDefault = 1.5;
    bad.criteria[0].id = 'X-1';
    bad.workers[0].agent = 'Worker';
    bad.settings[0].type = 'dropdown';
    bad.settings[1].default = '3';
    bad.settings[2].options = [];
    bad.displays[0].when = 'sometimes';
    bad.extra = 1;
    delete bad.settings[3].label;
    const errors = checkSchema(bad, schema);
    const text = errors.join('\n');
    assert.match(text, /task\.json\.name：空にできません/);
    assert.match(text, /task\.json\.maxIterationsDefault：整数で書いてください（今は数）/);
    assert.match(text, /task\.json\.criteria\[0\]\.id：書き方が決まりに合いません/);
    assert.match(text, /task\.json\.workers\[0\]\.agent：書き方が決まりに合いません/);
    assert.match(text, /task\.json\.settings\[0\]\.type：使える値は "text"、"number"、"select"、"checkbox"、"path" です（今は "dropdown"）/);
    assert.match(text, /task\.json\.settings\[1\]\.default：数で書いてください（今は文字）/);
    assert.match(text, /task\.json\.settings\[2\]\.options：1個以上入れてください/);
    assert.match(text, /task\.json\.displays\[0\]\.when：使える値は "running"、"finished"、"both" です/);
    assert.match(text, /task\.json：決まりにない名前「extra」があります/);
    assert.match(text, /task\.json\.settings\[3\]：「label」がありません/);
    assert.ok(errors.every((e) => !/[{}]/.test(e) || /まとまり（\{ \}）/.test(e)), 'JSON の記号だらけの文を返していない');
  });

  test('REQ-027 select の設定は options が要り、default の型は部品の種類で決まる（決まりの if/then を扱う）', () => {
    const task = clone(GOOD_TASK);
    delete task.settings[2].options;
    assert.match(checkSchema(task, schema).join('\n'), /task\.json\.settings\[2\]：「options」がありません/);
    const checkbox = clone(GOOD_TASK);
    checkbox.settings[3].default = 'false';
    assert.match(checkSchema(checkbox, schema).join('\n'), /task\.json\.settings\[3\]\.default：真偽（true か false）で書いてください（今は文字）/);
  });

  test('REQ-027 Python の jsonschema（1段目が使う）と、同じ作業の定義に同じ合否を出す（変えた作業の定義の差の確かめ）', { skip: pythonHasJsonschema() }, () => {
    const docs = mutations();
    assert.ok(docs.length > 60, `変えた形が少ない：${docs.length}`);
    const python = spawnSync(
      'python3',
      [
        '-I',
        '-c',
        'import json, sys, jsonschema\n' +
          'payload = json.load(sys.stdin)\n' +
          'validator = jsonschema.Draft202012Validator(payload["schema"])\n' +
          'print(json.dumps([validator.is_valid(d) for d in payload["docs"]]))\n',
      ],
      { input: JSON.stringify({ schema, docs }), encoding: 'utf8' },
    );
    assert.equal(python.status, 0, python.stderr);
    const expected = JSON.parse(python.stdout);
    const mine = docs.map((d) => checkSchema(d, schema).length === 0);
    const differences = docs.map((d, i) => (mine[i] === expected[i] ? null : { doc: JSON.stringify(d).slice(0, 200), mine: mine[i], python: expected[i] })).filter(Boolean);
    assert.deepEqual(differences, []);
    assert.ok(expected.some(Boolean) && expected.some((v) => !v), '合格と不合格の両方を含めた');
  });

  test('REQ-027 合否の基準は、番号つきで受けた基準（ナレッジの文のまま）を、番号を付け直さずに書き込む（作業の定義の案は変えない）', () => {
    const draft = clone(GOOD_TASK);
    delete draft.criteria;
    const before = clone(draft);
    // 番号は change.mjs の criteriaRows が付ける（直すときは元の番号を引き継ぐので、C-01 から始まらないこともある。BLUEPRINT 4.4）
    const criteria = [
      { id: 'C-02', text: '見出しが「今週の実績」「来週の予定」の順に並んでいれば合格', knowledge: 'K-02', extra: '使わない欄' },
      { id: 'C-04', text: '数値は  半角で  書く', knowledge: 'K-05' },
    ];
    const task = injectCriteria(draft, criteria);
    assert.deepEqual(task.criteria, [
      { id: 'C-02', text: '見出しが「今週の実績」「来週の予定」の順に並んでいれば合格', knowledge: 'K-02' },
      { id: 'C-04', text: '数値は  半角で  書く', knowledge: 'K-05' },
    ]);
    assert.deepEqual(draft, before, '案を書き換えない');
    assert.deepEqual(checkSchema(task, schema), []);
  });
});

/** python3 と jsonschema があれば false、なければ飛ばす理由（node:test の skip に渡す） */
function pythonHasJsonschema() {
  const r = spawnSync('python3', ['-I', '-c', 'import jsonschema'], { encoding: 'utf8' });
  return r.status === 0 ? false : 'python3 と jsonschema がない';
}

/** 作業の定義を少しずつ変えた形（合格と不合格が混ざる） */
function mutations() {
  const docs = [clone(GOOD_TASK)];
  const add = (mutate) => {
    const doc = clone(GOOD_TASK);
    mutate(doc);
    docs.push(doc);
  };
  for (const key of ['name', 'maxIterationsDefault', 'criteria', 'workers', 'settings', 'displays']) add((d) => delete d[key]);
  add((d) => {
    d.extra = true;
  });
  for (const name of ['', '週報', 5, null]) add((d) => (d.name = name));
  for (const n of [0, 1, 3, 1.5, '3', -2]) add((d) => (d.maxIterationsDefault = n));
  add((d) => (d.criteria = []));
  for (const id of ['C-01', 'C-1', 'C1', 'X-01', 'c-01']) add((d) => (d.criteria[0].id = id));
  for (const k of ['K-01', 'K-100', 'K1', 'k-01', '']) add((d) => (d.criteria[0].knowledge = k));
  add((d) => (d.criteria[0].text = ''));
  add((d) => delete d.criteria[0].text);
  add((d) => (d.criteria[0].note = 'x'));
  add((d) => (d.workers = []));
  for (const a of ['worker', 'worker-a1', 'worker-', 'Worker', 'workers', 'worker-A', 'worker-a-b']) add((d) => (d.workers[0].agent = a));
  add((d) => (d.workers[0].label = ''));
  add((d) => delete d.workers[0].label);
  for (const t of ['text', 'number', 'select', 'checkbox', 'path', 'radio', 5]) add((d) => (d.settings[0].type = t));
  for (const key of ['a', '1a', 'a b', 'a_1', 'A1', '']) add((d) => (d.settings[0].key = key));
  for (const def of ['', 'abc', 5, true, null]) add((d) => (d.settings[0].default = def));
  for (const def of [3, '3', 1.5, true]) add((d) => (d.settings[1].default = def));
  for (const def of ['簡易', '詳細', 'その他', 1]) add((d) => (d.settings[2].default = def));
  add((d) => delete d.settings[2].options);
  add((d) => (d.settings[2].options = []));
  add((d) => (d.settings[2].options = ['a', 'a']));
  add((d) => (d.settings[2].options = ['a', '']));
  add((d) => (d.settings[2].options = [1, 2]));
  add((d) => (d.settings[2].options = 'a'));
  for (const def of [true, false, 'true', 0]) add((d) => (d.settings[3].default = def));
  add((d) => (d.settings[0].required = 'yes'));
  add((d) => (d.settings[0].help = 5));
  add((d) => (d.settings[0].extra = 1));
  add((d) => delete d.settings[0].label);
  add((d) => (d.settings = []));
  for (const t of ['kv', 'table', 'progress', 'text', 'image', 'file', 'chart']) add((d) => (d.displays[0].type = t));
  for (const w of ['running', 'finished', 'both', 'always', '']) add((d) => (d.displays[0].when = w));
  add((d) => delete d.displays[0].when);
  add((d) => (d.displays[0].extra = 1));
  add((d) => (d.displays = []));
  return docs;
}

// ---- 見本の画面のサーバー --------------------------------------------------------------------------------

const readyAndConfirm = async (run, args = confirmArgs()) => {
  await readyToConfirm(run);
  const text = await run.call('confirm', args);
  return /見本：(http:\/\/127\.0\.0\.1:\d+\/\?k=\S+)/.exec(text)[1];
};
const sampleApi = (url, pathname, options = {}) => {
  const u = new URL(url);
  return fetch(`${u.origin}${pathname}?k=${u.searchParams.get('k')}`, {
    method: options.method ?? 'GET',
    ...(options.body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) }),
  });
};
const sampleState = async (url) => (await sampleApi(url, '/api/state')).json();

describe('Web管理画面の見本', () => {
  test('REQ-027 生成前の確認で、ひな形の生成プラグインの画面で見せる：画面の部品はひな形のものをそのまま返す', async () => {
    await withRun(async (run) => {
      const url = await readyAndConfirm(run);
      const u = new URL(url);
      const html = await (await sampleApi(url, '/')).text();
      assert.match(html, /<title>作業の画面<\/title>/, 'ひな形の index.html');
      const staticDir = path.join(TEMPLATE_EXTENSION_DIR, 'ui', 'static');
      for (const name of ['app.js', 'render.js', 'style.css']) {
        const served = await (await sampleApi(url, `/${name}`)).text();
        // 合言葉の差し込み口（style.css の中のフォントの URL）だけは、今の合言葉になる
        assert.equal(served, fs.readFileSync(path.join(staticDir, name), 'utf8').replaceAll('%%K%%', u.searchParams.get('k')), `${name} がひな形と違う`);
      }
      assert.match(u.hostname, /^127\.0\.0\.1$/);
    });
  });

  test('REQ-027 最初は「開始前の設定」：作業の定義の設定の部品と、題、注意（見本であること）が入った状態の全体になる', async () => {
    await withRun(async (run) => {
      const url = await readyAndConfirm(run);
      const state = await sampleState(url);
      assert.equal(state.plugin.title, '週報の作成');
      assert.equal(state.run, null, '開始前');
      assert.equal(state.previous, null);
      assert.equal(state.setup.maxIterationsDefault, 3);
      assert.deepEqual(state.setup.models, [{ id: 'sample-model', name: '見本のモデル' }]);
      assert.equal(state.setup.isAuto, false);
      assert.deepEqual(state.setup.taskSettings.map((s) => [s.key, s.type]), [['week', 'text'], ['style', 'select']]);
      // 必須の設定が空のままだと「開始する」を押せないので、仮の初めの値が入る
      assert.equal(state.setup.taskSettings[0].default, '（見本）');
      assert.equal(state.setup.taskSettings[1].default, '簡易');
      assert.deepEqual(state.taskDisplays.map((d) => [d.key, d.type, d.when]), [
        ['draft', 'text', 'running'], ['table', 'table', 'finished'], ['rate', 'progress', 'both'], ['facts', 'kv', 'both'], ['chart', 'image', 'finished'], ['report', 'file', 'finished'],
      ]);
      assert.equal(typeof state.version, 'number');
      assert.match(state.notices[0].text, /これは作業の画面の見本です。表示は仮のデータで、実際には何も動きません。/);
    });
  });

  test('REQ-027 「開始する」で、仮のデータの入った実行中の状態になる。基準はナレッジの文のまま入り、作業ごとの表示（全種類）に仮の値が入る', async () => {
    await withRun(async (run) => {
      const url = await readyAndConfirm(run);
      const before = await sampleState(url);
      assert.equal((await sampleApi(url, '/api/start', { method: 'POST', body: { models: {}, maxIterations: 3, task: { week: 'x' } } })).status, 200);
      const state = await sampleState(url);
      assert.ok(state.version > before.version);
      const r = state.run;
      assert.equal(r.status, 'running');
      assert.equal(r.phase, 'do');
      assert.equal(r.endReason, null);
      assert.deepEqual(r.agents.map((a) => [a.role, a.label, a.status]), [['orchestrator', '統括', 'standby'], ['worker', '週報を書く係', 'running'], ['verifier', '検証', 'standby']]);

      // ユーザーの答え4：合否の基準は、種類「合否の決め方」のナレッジから差し込まれる（文は変えない）
      assert.deepEqual(r.iterations[0].criteria, [{ id: 'C-01', text: '見出しが「今週の実績」「来週の予定」の順に並んでいれば合格', fromUser: true }]);
      assert.deepEqual(r.iterations[0].verdicts, []);

      // 作業ごとの表示：すべての表示が、表示の種類に合う仮の値を持つ（どれを見せるかは、画面が when で決める）。値の形は描画の部品が読める形
      assert.equal(typeof r.displays.draft, 'string');
      assert.match(r.displays.draft, /^（見本）/);
      assert.deepEqual(Object.keys(r.displays).sort(), ['chart', 'draft', 'facts', 'rate', 'report', 'table']);
      assert.deepEqual(Object.keys(r.displays.facts), ['見出し1', '見出し2', '見出し3']);
      assert.deepEqual(r.displays.table.columns, ['列1', '列2', '列3']);
      assert.equal(r.displays.table.rows.length, 2);
      assert.deepEqual(r.displays.rate, { value: 60, max: 100, label: '進み具合' });
      assert.deepEqual(r.displays.chart, { fileId: 'sample-image', name: '見本の画像.svg' });
      assert.deepEqual(r.displays.report, { fileId: 'sample-file', name: '見本のファイル.txt' });
      assert.equal(r.summary, '');
    });
  });

  test('REQ-027 「止める」で、仮のデータの入った終わった後の状態になる：全部の基準が合格、まとめが入る', async () => {
    await withRun(async (run) => {
      const url = await readyAndConfirm(run);
      await sampleApi(url, '/api/start', { method: 'POST', body: {} });
      assert.equal((await sampleApi(url, '/api/stop', { method: 'POST' })).status, 200);
      const r = (await sampleState(url)).run;
      assert.equal(r.status, 'finished');
      assert.deepEqual(r.endReason, { kind: 'all_passed', detail: null, unstoppable: false });
      assert.deepEqual(r.iterations[0].verdicts, [{ criterionId: 'C-01', pass: true, note: '' }]);
      assert.ok(r.agents.every((a) => a.status === 'completed'));
      assert.match(r.summary, /^（見本）/);
      assert.deepEqual(r.issues, []);
    });
  });

  test('REQ-027 仮の画像とファイルは、見本のサーバーが返す（画像は画像として、ファイルはダウンロードの形）。ほかの番号は 404', async () => {
    await withRun(async (run) => {
      const url = await readyAndConfirm(run);
      const image = await sampleApi(url, '/api/files/sample-image');
      assert.equal(image.status, 200);
      assert.equal(image.headers.get('content-type'), 'image/svg+xml');
      assert.match(await image.text(), /<svg /);
      const file = await sampleApi(url, '/api/files/sample-file');
      assert.equal(file.status, 200);
      assert.match(file.headers.get('content-disposition'), /^attachment;/);
      assert.equal((await sampleApi(url, '/api/files/other')).status, 404);
      assert.equal((await sampleApi(url, '/api/agents/x/reply')).status, 404);
      const issue = await sampleApi(url, '/api/issues/x/file', { method: 'POST' });
      assert.equal(issue.status, 400);
      assert.match((await issue.json()).error, /見本では起票できません/);
    });
  });

  test('REQ-027 見本のサーバーも、127.0.0.1 だけで待ち受け、合言葉のない問い合わせを断る', async () => {
    await withRun(async (run) => {
      const url = await readyAndConfirm(run);
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/\?k=[\w-]{20,}$/);
      const u = new URL(url);
      assert.equal((await fetch(`${u.origin}/api/state`)).status, 403);
      assert.equal((await fetch(`${u.origin}/api/state?k=wrong`)).status, 403);
    });
  });

  test('REQ-027 直したら見本を作り直して見せ直す：同じ URL のまま、状態が開始前に戻り、新しい中身になる', async () => {
    await withRun(async (run) => {
      const url = await readyAndConfirm(run);
      await sampleApi(url, '/api/start', { method: 'POST', body: {} });
      const running = await sampleState(url);
      assert.equal(running.run.status, 'running');

      // ユーザーの指摘で、作業の定義の案（画面）を直す。作業エージェントが書き直した、という想定
      writeDraft(run.cwd, { name: '直した週報', settings: [{ key: 'month', label: '対象の月', type: 'text', default: '2026-10', required: true }] });
      await run.call('record', { knowledge: [{ id: 'K-02', text: '見出しが「実績」「予定」の順に並んでいれば合格', quote: '短くしたい' }] });
      const text = await run.call('confirm', confirmArgs({ evalTasks: [{ prompt: '今週の週報を作ってください。', criteria: ['K-02'] }] })); // 案の設定を替えたので、既定の設定の値は渡さない
      assert.ok(text.endsWith(url), '見本の URL は変わらない');

      const state = await sampleState(url);
      assert.ok(state.version > running.version);
      assert.equal(state.run, null, '開始前に戻る');
      assert.equal(state.plugin.title, '直した週報');
      assert.deepEqual(state.setup.taskSettings.map((s) => [s.key, s.default]), [['month', '2026-10']]);
      await sampleApi(url, '/api/start', { method: 'POST', body: {} });
      assert.equal((await sampleState(url)).run.iterations[0].criteria[0].text, '見出しが「実績」「予定」の順に並んでいれば合格', '直したナレッジの文が入る');
    });
  });

  test('REQ-027 作業エージェントが2体以上のときは、体ごとの枠が入る。表示や設定が空でも、見本が作れる', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      writeDraft(run.cwd, { workers: [{ agent: 'worker', label: '書く係' }, { agent: 'worker-table', label: '表の係' }], settings: [], displays: [] });
      const text = await run.call('confirm', confirmArgs({ evalTasks: [{ prompt: '今週の週報を作ってください。', criteria: ['K-02'] }] })); // 案の設定を替えたので、既定の設定の値は渡さない
      const url = /見本：(\S+)/.exec(text)[1];
      await sampleApi(url, '/api/start', { method: 'POST', body: {} });
      const r = (await sampleState(url)).run;
      assert.deepEqual(r.agents.map((a) => [a.slot, a.label]), [['orchestrator', '統括'], ['worker-1', '書く係'], ['worker-2', '表の係'], ['verifier', '検証']]);
      assert.deepEqual(r.displays, {});
    });
  });

  test('REQ-027 見本の状態は、BLUEPRINT 3.5 の状態の全体の形（必要な項目が全部ある）', () => {
    const task = { ...clone(GOOD_TASK), criteria: GOOD_TASK.criteria };
    for (const mode of ['preparing', 'running', 'finished']) {
      const state = buildSampleState({ task, mode, version: 7, nowMs: Date.parse('2026-10-22T09:00:00Z') });
      for (const key of ['version', 'plugin', 'setup', 'run', 'previous', 'notices']) assert.ok(key in state, `${mode}：${key}`);
      for (const key of ['models', 'defaults', 'maxIterationsDefault', 'taskSettings', 'isAuto']) assert.ok(key in state.setup, `${mode}：setup.${key}`);
      if (mode === 'preparing') continue;
      for (const key of ['id', 'status', 'endReason', 'settings', 'isAuto', 'phase', 'iteration', 'maxIterations', 'agents', 'iterations', 'displays', 'summary', 'issues', 'canFile', 'unstopped', 'waits']) {
        assert.ok(key in state.run, `${mode}：run.${key}`);
      }
      for (const agent of state.run.agents) for (const key of ['slot', 'role', 'label', 'status', 'task', 'selectedModel', 'actualModel', 'lastActiveAt', 'replySummary']) assert.ok(key in agent, `${mode}：agent.${key}`);
    }
  });

  test('REQ-027 見本のサーバーは、クリエイターの画面のサーバーとは別に動く（クリエイターの画面の状態に、見本の状態を混ぜない）', async () => {
    await withRun(async (run) => {
      await run.call('open');
      const url = await readyAndConfirm(run);
      const creatorUrl = run.creator.screen.url;
      assert.ok(creatorUrl && creatorUrl !== url);
      assert.notEqual(new URL(creatorUrl).port, new URL(url).port);
      const view = await (await fetch(`${new URL(creatorUrl).origin}/api/state?k=${new URL(creatorUrl).searchParams.get('k')}`)).json();
      assert.ok(!('run' in view) && !('setup' in view));
    });
  });
});
