// 画面の開始前の設定を、ユーザー役が決める流れ（inner-settings.mjs）。偽のユーザー役で確かめる。実際のモデルは使わない。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { choicesOf, decideSettings, describeSetting, normalizeSettingAnswer, notesField, previewInputs } from './inner-settings.mjs';
import { tempDir } from './temp-dirs.mjs';

const WEEK = { key: 'week', label: '対象の週', type: 'text', default: '', required: true, help: '週報を作る週を書きます（例：2026-W42）。' };
const COUNT = { key: 'count', label: '項目の数', type: 'number', default: 5, required: false };
const STYLE = { key: 'style', label: '文体', type: 'select', default: 'です・ます', options: ['です・ます', 'である'], required: false, help: '文末の書き方' };
const FORCE = { key: 'force', label: '前回の週報を引き継ぐ', type: 'checkbox', default: false };
const SOURCE = { key: 'source', label: '売上のファイル', type: 'path', default: '', required: true };

test('REQ-007 REQ-031 ユーザー役に聞く文：欄の見出し・説明・種類・必須か・初めの値・選べるものと、頼んだことと渡したファイルを示す', () => {
  const text = describeSetting(STYLE, { prompt: 'inputs/sales.csv から、今週の週報を作ってください。', inputs: [{ path: 'inputs/sales.csv', preview: '担当,売上\n田中,128000' }] });
  assert.match(text, /設定の欄「文体」に入れる値を決めてください/);
  assert.match(text, /あなたが頼んだこと：inputs\/sales\.csv から、今週の週報を作ってください。/);
  assert.match(text, /- inputs\/sales\.csv\n {4}担当,売上\n {4}田中,128000/);
  assert.match(text, /欄の種類：選択/);
  assert.match(text, /欄の説明：文末の書き方/);
  assert.match(text, /この欄は入れなくてもかまいません。/);
  assert.match(text, /初めに入っている値：です・ます/);
  assert.match(text, /選べるもの：です・ます、である/);
  assert.match(text, /入れる値だけを答えてください/);
  const required = describeSetting(WEEK, { prompt: 'p' });
  assert.match(required, /この欄は必ず入れます。/);
  assert.doesNotMatch(required, /あなたが渡したファイル/);
  assert.doesNotMatch(required, /初めに入っている値/);
  assert.deepEqual(choicesOf(STYLE), ['です・ます', 'である']);
  assert.deepEqual(choicesOf(FORCE), ['はい（チェックを入れる）', 'いいえ（チェックを入れない）']);
  assert.deepEqual(choicesOf(WEEK), []);
});

test('REQ-007 答えを欄の値にする：文字は最初の行から飾りを除き、数は数字を取り出し、選択は選択肢に当て、チェックは はい／いいえ を読む', () => {
  const value = (def, answer) => normalizeSettingAnswer(def, answer);
  assert.deepEqual(value(WEEK, '2026-W42'), { ok: true, value: '2026-W42' });
  assert.deepEqual(value(WEEK, '「2026-W42」'), { ok: true, value: '2026-W42' });
  assert.deepEqual(value(WEEK, '2026-W42。\n理由は…'), { ok: true, value: '2026-W42' });
  assert.deepEqual(value(SOURCE, '"inputs/sales.csv"'), { ok: true, value: 'inputs/sales.csv' });
  assert.deepEqual(value(COUNT, '10件にします'), { ok: true, value: 10 });
  assert.deepEqual(value(COUNT, '１２'), { ok: true, value: 12 });
  assert.deepEqual(value(COUNT, '1,500'), { ok: true, value: 1500 });
  assert.deepEqual(value(COUNT, 'たくさん'), { ok: false, reason: 'not_a_number' });
  assert.deepEqual(value(STYLE, 'である'), { ok: true, value: 'である' });
  assert.deepEqual(value(STYLE, '文体は「である」でお願いします'), { ok: true, value: 'である' });
  assert.deepEqual(value(STYLE, 'です・ます調'), { ok: true, value: 'です・ます' });
  assert.deepEqual(value(STYLE, 'カジュアル'), { ok: false, reason: 'no_such_option' });
  assert.deepEqual(value(FORCE, 'はい'), { ok: true, value: true });
  assert.deepEqual(value(FORCE, 'はい（チェックを入れる）'), { ok: true, value: true });
  assert.deepEqual(value(FORCE, 'いいえ（チェックを入れない）'), { ok: true, value: false });
  assert.deepEqual(value(FORCE, 'チェックは入れない'), { ok: true, value: false });
  assert.deepEqual(value(FORCE, 'いいえ'), { ok: true, value: false });
  assert.deepEqual(value(FORCE, 'オフ'), { ok: true, value: false });
  assert.deepEqual(value(FORCE, 'チェックを入れる'), { ok: true, value: true });
  assert.deepEqual(value(FORCE, 'オンにします'), { ok: true, value: true });
  assert.deepEqual(value(FORCE, 'どちらでも'), { ok: false, reason: 'unclear' });
  // 選択肢の言葉が、ほかの選択肢の言葉の一部のとき、長いほうを選ぶ
  const NESTED = { key: 'tone', type: 'select', options: ['です', 'です・ます'] };
  assert.deepEqual(value(NESTED, 'です'), { ok: true, value: 'です' });
  assert.deepEqual(value(NESTED, 'です・ます調で'), { ok: true, value: 'です・ます' });
  // 選択肢が { value, label } の形でも、見出しか値のどちらで答えても当たる
  const OBJECTS = { key: 'mode', type: 'select', options: [{ value: 'plain', label: 'ふつう' }, { value: 'short', label: '短く' }] };
  assert.deepEqual(value(OBJECTS, '短くしてください'), { ok: true, value: 'short' });
  assert.deepEqual(value(OBJECTS, 'plain'), { ok: true, value: 'plain' });
});

test('REQ-007 決められない答え（決まっていません、そのまま、空）は値にしない。長い答えは、中に似た言葉があっても値として扱う', () => {
  for (const answer of ['特に決まっていません', '特に決まっていません。', '決まっていません', 'そのままで大丈夫です', '', '   ', undefined]) {
    assert.deepEqual(normalizeSettingAnswer(WEEK, answer), { ok: false, reason: 'abstain' }, String(answer));
  }
  const long = 'レポートの対象は、そのまま使える形にした2026年第42週の分です。経理にも渡すので、日付を入れて、必ず期間を書くようにします。';
  assert.equal(normalizeSettingAnswer(WEEK, long).ok, true);
});

test('REQ-007 設定の値を決める順：コマンドラインの補い ＞ 課題の settings.task ＞ ユーザー役。ユーザー役に聞くのは、前の2つにない欄だけ', async () => {
  const asked = [];
  const userRole = async ({ question, choices, via, meta }) => {
    asked.push({ question, choices, via, meta });
    return meta.setting === 'week' ? '2026-W42' : meta.setting === 'count' ? '8件' : meta.setting === 'force' ? 'はい' : 'である';
  };
  const out = await decideSettings({
    definitions: [WEEK, COUNT, STYLE, FORCE], fromEval: { count: 3, style: 'です・ます' }, fromCli: { style: 'である', other: 'x' }, userRole, prompt: '週報を作って',
  });
  // style は補い、count は課題の値。ユーザー役に聞いたのは week と force だけ
  assert.deepEqual(asked.map((a) => a.meta.setting), ['week', 'force']);
  assert.ok(asked.every((a) => a.via === 'setting'));
  assert.deepEqual(asked[1].choices, ['はい（チェックを入れる）', 'いいえ（チェックを入れない）']);
  assert.deepEqual(out.values, { week: '2026-W42', count: 3, style: 'である', force: true, other: 'x' });
  assert.deepEqual(out.decisions.map((d) => [d.key, d.source, d.value]), [['week', 'user-role', '2026-W42'], ['count', 'eval-json', 3], ['style', 'cli', 'である'], ['force', 'user-role', true]]);
  // ユーザー役が決めた欄には、聞いた文と答えが残る。ほかには残らない
  assert.match(out.decisions[0].question, /設定の欄「対象の週」/);
  assert.equal(out.decisions[0].answer, '2026-W42');
  assert.equal(out.decisions[1].question, undefined);
  assert.equal(out.decisions[0].required, true);
});

test('REQ-007 ユーザー役が決められなかった欄は、値を入れずに初めの値のままにし、理由を残す', async () => {
  const history = [];
  const out = await decideSettings({
    definitions: [WEEK, COUNT, STYLE], userRole: async ({ meta }) => (meta.setting === 'week' ? '特に決まっていません' : meta.setting === 'count' ? 'たくさん' : 'カジュアル'), prompt: 'p', history,
  });
  assert.deepEqual(out.values, {});
  assert.deepEqual(out.decisions.map((d) => [d.key, d.source, d.note, d.value]), [['week', 'default', 'abstain', ''], ['count', 'default', 'not_a_number', 5], ['style', 'default', 'no_such_option', 'です・ます']]);
  assert.equal(history.length, 3);
  assert.equal(history[0].via, 'setting');
});

test('REQ-007 ユーザー役が失敗したら、その失敗をそのまま伝える（答えなしで進めない）', async () => {
  await assert.rejects(
    decideSettings({ definitions: [WEEK], userRole: async () => { throw new Error('ユーザー役の呼び出しに失敗しました'); }, prompt: 'p' }),
    /ユーザー役の呼び出しに失敗しました/,
  );
});

test('REQ-007 設定の欄がない（definitions が空）なら、ユーザー役に聞かず、課題と補いの値だけを使う', async () => {
  let called = 0;
  const out = await decideSettings({ definitions: [], fromEval: { a: 1 }, fromCli: { b: 2 }, userRole: async () => { called += 1; return ''; }, prompt: 'p' });
  assert.equal(called, 0);
  assert.deepEqual(out.values, { a: 1, b: 2 });
  assert.deepEqual(out.decisions, []);
});

test('REQ-007 渡したファイルの中身は先頭の数件・数百文字だけ質問に付ける。文字にできないファイルは場所だけ', async () => {
  const dir = tempDir('settings-inputs');
  fs.mkdirSync(path.join(dir, 'inputs'));
  fs.writeFileSync(path.join(dir, 'inputs', 'a.csv'), `担当,売上\n${'田中,100\n'.repeat(500)}`);
  fs.writeFileSync(path.join(dir, 'inputs', 'b.txt'), '短い');
  fs.writeFileSync(path.join(dir, 'inputs', 'c.bin'), Buffer.from([0, 1, 2, 3, 0, 0]));
  fs.writeFileSync(path.join(dir, 'inputs', 'd.txt'), 'four');
  const inputs = new Map(['inputs/d.txt', 'inputs/c.bin', 'inputs/b.txt', 'inputs/a.csv'].map((p) => [p, 'sha']));
  const preview = await previewInputs(inputs, dir);
  assert.deepEqual(preview.map((p) => p.path), ['inputs/a.csv', 'inputs/b.txt', 'inputs/c.bin']);
  assert.ok(preview[0].preview.startsWith('担当,売上\n田中,100'));
  assert.ok(preview[0].preview.endsWith('\n…'));
  assert.ok(preview[0].preview.length < 900);
  assert.equal(preview[1].preview, '短い');
  assert.equal(preview[2].preview, null);
});

test('REQ-007 設定の欄をユーザー役に聞くとき、メインのエージェントがチャットに書いた文（まだ渡していないもの）を、最初に聞く欄にだけ付ける。見せた文は記録に残る', async () => {
  const unread = ['画面を開きました。', 'URL は上のとおりです。'];
  const takeNotes = () => unread.splice(0);
  const asked = [];
  const history = [];
  const userRole = async (request) => {
    asked.push({ key: request.meta.setting, notes: request.notes });
    return request.meta.setting === 'week' ? '2026-W44' : '特に決まっていません';
  };
  const { decisions } = await decideSettings({
    definitions: [WEEK, COUNT, STYLE], fromEval: { style: 'である' }, userRole, prompt: 'p', history, takeNotes,
  });
  // 課題で決まっている欄（style）は聞かないので、前の文は最初に聞いた欄（week）にだけ付く。次の欄（count）には付かない
  assert.deepEqual(asked, [{ key: 'week', notes: ['画面を開きました。', 'URL は上のとおりです。'] }, { key: 'count', notes: [] }]);
  assert.equal(decisions.find((d) => d.key === 'week').notes, '画面を開きました。\n\nURL は上のとおりです。');
  assert.equal(Object.hasOwn(decisions.find((d) => d.key === 'count'), 'notes'), false);
  assert.equal(Object.hasOwn(decisions.find((d) => d.key === 'style'), 'notes'), false);
  // 決められなかった欄の記録にも、見せた文が残る
  const abstained = await decideSettings({ definitions: [WEEK], userRole: async () => '決まっていません', prompt: 'p', takeNotes: () => ['案内です。'] });
  assert.deepEqual(abstained.decisions.map((d) => [d.source, d.notes]), [['default', '案内です。']]);
  assert.deepEqual(history.map((h) => [h.via, h.notes]), [['setting', '画面を開きました。\n\nURL は上のとおりです。'], ['setting', undefined]]);
  // 文を取り出す関数を渡さなければ、今までどおり（notes は空）
  const seen = [];
  await decideSettings({ definitions: [WEEK], userRole: async (request) => { seen.push(request.notes); return '2026-W42'; }, prompt: 'p' });
  assert.deepEqual(seen, [[]]);
});

test('REQ-007 見せた文の記録：空の文は項目にしない。複数あれば空行でつなぐ', () => {
  assert.deepEqual(notesField([]), {});
  assert.deepEqual(notesField(['', '  ']), {});
  assert.deepEqual(notesField(undefined), {});
  assert.deepEqual(notesField(['A', ' B ']), { notes: 'A\n\nB' });
});
