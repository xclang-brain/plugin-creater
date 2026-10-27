// ユーザー役の部品の試験。実際のモデルは使わない（偽物の Agent SDK）。
// 動かし方（リポジトリの根で）：node --test "tests/dev-eval/runner/*.test.mjs"

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadPersona } from '../personas/validate.mjs';
import { createFakeSdk } from './outer-fake-sdk.mjs';
import {
  HISTORY_LIMITS,
  INSTRUCTION_WORDS,
  CALL_RETRIES,
  LIMIT_PATTERN,
  MARKUP_RETRIES,
  MARKUP_RETRY_NOTE,
  TOOL_CALL_MARKUP,
  USER_ROLE_MODEL,
  USER_RULES,
  askUserRole,
  buildSystemPrompt,
  buildUserPrompt,
  createUserRole,
  joinNotes,
} from './user-role.mjs';
import { tempDir } from './temp-dirs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PERSONAS = path.join(here, '..', 'personas');
const tmp = () => tempDir('user-role-test');

const weekly = (await loadPersona(path.join(PERSONAS, 'weekly-report'), { allStyles: true })).persona;
const training = (await loadPersona(path.join(PERSONAS, 'training-survey'))).persona;

test('REQ-015 ユーザー役のモデルは ID で固定されている（別名ではない）', () => {
  assert.equal(USER_ROLE_MODEL, 'claude-sonnet-5-5');
  assert.match(USER_ROLE_MODEL, /^claude-[a-z]+-\d+-\d+$/);
});

test('REQ-017 ユーザー役に渡すもの：profile・ファイル・ナレッジ・決まりの確かめの答え。渡さないもの：markers・id・ほかの模擬ユーザー', () => {
  const system = buildSystemPrompt(weekly);
  assert.ok(system.includes(weekly.profile));
  for (const f of weekly.files) {
    assert.ok(system.includes(f.place), f.place);
    assert.ok(system.includes(f.describe));
    assert.ok(system.includes(f.reveal));
  }
  for (const k of weekly.knowledge) {
    assert.ok(system.includes(k.fact), k.id);
    assert.ok(system.includes(k.reveal));
  }
  // 決まりの確かめ：答えの選択肢と、足す中身
  const man = weekly.knowledge.find((k) => k.id === 'man-yen');
  assert.ok(system.includes('「そうしないときもある」を選ぶ（名前だけを書く）'));
  assert.ok(!system.includes('そうしないときもある（どんなときか）'), '選択肢の説明まで写させない');
  assert.ok(system.includes(man.file.detail));
  assert.ok(system.includes('「決まりではなく、たまたま」を選ぶ'));
  // 渡さない：言葉の見分け（正規表現の文字）は、指示に入らない
  for (const k of weekly.knowledge) {
    for (const value of Object.values(k.markers).flat()) {
      if (/[|\\]/.test(value)) assert.ok(!system.includes(value), `${k.id} の見分けが指示に入っている：${value}`);
    }
    assert.ok(!system.includes(`id：${k.id}`));
  }
  assert.ok(!system.includes('userRoleTests'));
  assert.ok(!system.includes('weekly-report'));
  assert.ok(!system.includes(training.profile));
});

test('REQ-015 話し方：normal は指示なし。ほかは話し方を優先すると書き、何を話してよいかは答え方の決まりに従うと書く', () => {
  assert.ok(!buildSystemPrompt(weekly, { styleName: 'normal' }).includes('話し方：'));
  const terse = buildSystemPrompt(weekly, { styleName: 'terse' });
  assert.ok(terse.includes(`話し方：${weekly.styles.terse.instruction}`));
  assert.ok(terse.includes('答えの長さと言い方は、答え方の決まりより、この話し方を優先する。何を話してよいかは、答え方の決まりに従う。'));
  // hurry のときだけ、進め方の選び方を足す
  assert.ok(buildSystemPrompt(weekly, { styleName: 'hurry' }).includes('残りを手早く聞く'));
  assert.ok(!terse.includes('残りを手早く聞く」を選ぶ'));
});

test('REQ-016 まだやったことのない作業では、ファイルを示さない（「ありません。まだやったことがないので」）', () => {
  const system = buildSystemPrompt(training);
  assert.ok(system.includes('持っているファイルはありません'));
  assert.ok(system.includes('ありません。まだやったことがないので'));
  assert.ok(!system.includes('あなたが持っているファイル'));
});

test('REQ-015 質問のプロンプトに、それまでのやり取りと選択肢が入り、長い履歴は新しい側が残る', () => {
  const history = Array.from({ length: HISTORY_LIMITS.exchanges + 5 }, (_, i) => ({ question: `質問${i}`, answer: `答え${i}` }));
  const p = buildUserPrompt({ question: '今の質問', choices: [{ label: 'はい', description: '進める' }, 'いいえ'], history });
  assert.ok(p.includes('AI：質問44') && p.includes('あなた：答え44'));
  assert.ok(!p.includes('AI：質問0\n'));
  assert.ok(p.includes('AI からの質問：今の質問'));
  assert.ok(p.includes('- はい（進める）') && p.includes('- いいえ'));
  const none = buildUserPrompt({ question: 'q' });
  assert.ok(!none.includes('これまでのやり取り') && !none.includes('選択肢'));
});

test('REQ-015 askUserRole は Agent SDK を道具なし・1手番・設定なしで呼び、答えを返す', async () => {
  const seen = [];
  const sdk = createFakeSdk({ userRole: (req) => { seen.push(req); return '  weekly_report.md です  '; } });
  const r = await askUserRole(weekly, '成果物は？', [], { query: sdk.query });
  assert.equal(r.text, 'weekly_report.md です');
  assert.equal(seen.length, 1);
  const o = seen[0].options;
  assert.equal(o.model, 'claude-sonnet-5-5');
  assert.equal(o.maxTurns, 1);
  assert.deepEqual(o.tools, []);
  assert.deepEqual(o.settingSources, []);
  assert.equal(typeof o.systemPrompt, 'string');
  // 環境変数は許可リストと一時 HOME だけ
  assert.ok(o.env.HOME && o.env.HOME.includes('user-role-home'));
  assert.equal(o.env.GITHUB_TOKEN, undefined);
});

test('REQ-015 askUserRole は呼び出しが失敗したら、平易な日本語の Error を投げる', async () => {
  const sdk = createFakeSdk({ userRole: () => new Error('limit') });
  await assert.rejects(() => askUserRole(weekly, 'q', [], { query: sdk.query }), /ユーザー役の呼び出しに失敗しました/);
});

test(`REQ-015 呼び出しの失敗（誤りの結果・空の答え・例外）は ${CALL_RETRIES} 回まで呼び直す。利用枠の上限なら呼び直さずに usage_limit で投げる`, async () => {
  // 失敗の後に直れば、その答えを返し、呼び直しの回数を返す（道具の呼び出しの形の呼び直しとは別に数える）
  let n = 0;
  const flaky = createFakeSdk({ userRole: () => { n += 1; return n === 1 ? new Error('API Error: 529 Overloaded') : n === 2 ? '' : '特に決まっていません'; } });
  const ok = await askUserRole(weekly, 'q', [], { query: flaky.query });
  assert.deepEqual([ok.text, ok.callRetries, ok.retries, n], ['特に決まっていません', 2, 0, 3]);
  // query() が例外を投げても、呼び直す
  let m = 0;
  const throwing = (params) => { m += 1; if (m === 1) throw new Error('process exited with code 1'); return flaky.query(params); };
  assert.equal((await askUserRole(weekly, 'q', [], { query: throwing })).text, '特に決まっていません');
  // 続けて失敗すれば call_failed
  let k = 0;
  const failing = createFakeSdk({ userRole: () => { k += 1; return new Error('API Error: 500'); } });
  await assert.rejects(() => askUserRole(weekly, 'q', [], { query: failing.query }), (error) => {
    assert.equal(error.code, 'call_failed');
    assert.match(error.message, /3 回続けて/);
    return true;
  });
  assert.equal(k, CALL_RETRIES + 1);
  // 利用枠の上限は、呼び直さない
  let l = 0;
  const limited = createFakeSdk({ userRole: () => { l += 1; return new Error("You've hit your session limit · resets at 3pm"); } });
  await assert.rejects(() => askUserRole(weekly, 'q', [], { query: limited.query }), (error) => error.code === 'usage_limit');
  assert.equal(l, 1);
  assert.ok(LIMIT_PATTERN.test('Claude AI usage limit reached'));
});

test('REQ-015 createUserRole は答えとやり取りを記録し、次の質問に履歴を渡す', async () => {
  const prompts = [];
  const sdk = createFakeSdk({ userRole: ({ prompt }) => { prompts.push(prompt); return `答え${prompts.length}`; } });
  const home = tmp();
  const role = createUserRole({ persona: weekly, query: sdk.query, home });
  const a1 = await role.answer('1つ目', [], 'text');
  await role.answer('2つ目', [{ label: 'A', description: '' }], 'AskUserQuestion');
  assert.equal(a1.answer, '答え1');
  assert.equal(role.answerCount, 2);
  assert.ok(prompts[1].includes('AI：1つ目') && prompts[1].includes('あなた：答え1'));
  assert.equal(role.answers[1].via, 'AskUserQuestion');
  assert.deepEqual(role.answers[1].choices, [{ label: 'A', description: '' }]);
  assert.ok(role.cost > 0);
  assert.equal(role.signals.length, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('REQ-015 順に答える：同時に聞いても、履歴の並びが崩れない', async () => {
  const sdk = createFakeSdk({ userRole: async ({ prompt }) => { await new Promise((r) => setTimeout(r, prompt.includes('遅い') ? 30 : 1)); return 'ok'; } });
  const home = tmp();
  const role = createUserRole({ persona: weekly, query: sdk.query, home });
  await Promise.all([role.answer('遅い質問'), role.answer('速い質問')]);
  assert.deepEqual(role.history.map((h) => h.question), ['遅い質問', '速い質問']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('REQ-015 話し方 hurry：afterAnswers 回答えた後の次の答えに text を足し、その位置を記録する', async () => {
  const sdk = createFakeSdk({ userRole: () => '短い答え' });
  const home = tmp();
  const role = createUserRole({ persona: weekly, styleName: 'hurry', query: sdk.query, home });
  const n = weekly.styles.hurry.signal.afterAnswers;
  for (let i = 0; i < n + 2; i += 1) await role.answer(`質問${i}`);
  assert.equal(role.signals.length, 1, '合図は 1 回だけ');
  assert.equal(role.signals[0].answerIndex, n);
  assert.equal(role.signals[0].text, weekly.styles.hurry.signal.text);
  assert.ok(role.answers[n].answer.endsWith(weekly.styles.hurry.signal.text));
  assert.equal(role.answers[n].signal, true);
  assert.equal(role.answers[n].rawAnswer, '短い答え');
  assert.ok(!role.answers[n - 1].answer.includes(weekly.styles.hurry.signal.text));
  assert.ok(!role.answers[n + 1].answer.includes(weekly.styles.hurry.signal.text));
  // 履歴には合図つきの答えが入る（次の質問のユーザー役が、急ぐ合図を出したことを覚えている）
  assert.ok(role.history[n].answer.includes(weekly.styles.hurry.signal.text));
  fs.rmSync(home, { recursive: true, force: true });
});

test('REQ-015 話し方 hurry 以外には signal がなく、合図は足されない', async () => {
  const sdk = createFakeSdk({ userRole: () => 'ok' });
  const home = tmp();
  const role = createUserRole({ persona: weekly, styleName: 'terse', query: sdk.query, home });
  for (let i = 0; i < 10; i += 1) await role.answer(`q${i}`);
  assert.equal(role.signals.length, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('REQ-015 知らない話し方は断る', () => {
  assert.throws(() => createUserRole({ persona: weekly, styleName: 'rude', home: tmp() }), /話し方「rude」/);
});

test('REQ-015 指示のことを話さない：見張る言葉は、指示の言葉に当たり、ふつうの答えには当たらない', () => {
  for (const bad of ['答える条件に当てはまるので答えます', '自分から話すかどうかは「いいえ」です', '答え方の決まりでは言えません', '聞かれているので答えます', 'ユーザー役として答えます']) {
    assert.ok(INSTRUCTION_WORDS.test(bad), bad);
  }
  for (const ok of ['weekly_report.md です', '見出しは2つだけです', '特に決まっていません', '金額は万円で書きます', '以上、です。']) {
    assert.ok(!INSTRUCTION_WORDS.test(ok), ok);
  }
});

// ---- 会話例の下読みの直し（E1）：クリエイターがチャットに書いた文、答え方 -----------------------------------------------

test('REQ-015 質問のプロンプトに、クリエイターが質問の前にチャットに書いた文が入る（「上のまとめ」に答えるため。testing.md 6.1）', () => {
  const p = buildUserPrompt({ question: '上のまとめで、違うところはどこですか？', notes: ['確かめた決まりは次のとおりです。\n・金額は万円', '足りなければ教えてください。'] });
  const at = (text) => p.indexOf(text);
  assert.ok(at('AI が質問の前にチャットに書いた文：') >= 0);
  assert.ok(at('・金額は万円') > at('AI が質問の前にチャットに書いた文：'));
  assert.ok(at('AI からの質問：上のまとめで') > at('足りなければ教えてください。'), '前の文は、質問より前');
  // 文がないときは、見出しも出さない
  for (const none of [undefined, '', [], ['', '  ']]) assert.ok(!buildUserPrompt({ question: 'q', notes: none }).includes('チャットに書いた文'));
  assert.equal(joinNotes(['a', ' ', 'b ']), 'a\n\nb');
  // 長いときは後ろ（質問に近い側）を残す
  const long = buildUserPrompt({ question: 'q', notes: `${'あ'.repeat(HISTORY_LIMITS.noteChars)}末尾` });
  assert.ok(long.includes('末尾') && long.includes('…'));
});

test('REQ-015 createUserRole は、前の文を次の質問に付け、履歴にも残す。後の質問は、前の質問と一緒に前の文も読める', async () => {
  const prompts = [];
  const sdk = createFakeSdk({ userRole: ({ prompt }) => { prompts.push(prompt); return '答え'; } });
  const home = tmp();
  const role = createUserRole({ persona: weekly, query: sdk.query, home });
  const first = await role.answer('上のまとめで、違うところは？', [], 'AskUserQuestion', {}, ['まとめ：金額は万円']);
  await role.answer('次の質問', [], 'AskUserQuestion');
  assert.ok(prompts[0].includes('AI が質問の前にチャットに書いた文：\nまとめ：金額は万円'));
  assert.equal(first.notes, 'まとめ：金額は万円', '何を見せたかを、答えの記録に残す');
  // 2 つ目：今回の前の文はないが、履歴には 1 つ目の前の文が入っている
  assert.ok(!prompts[1].includes('AI が質問の前にチャットに書いた文：\n'));
  assert.ok(prompts[1].includes('AI がチャットに書いた文：まとめ：金額は万円\nAI：上のまとめで、違うところは？'));
  assert.equal(role.answers[1].notes, undefined);
  fs.rmSync(home, { recursive: true, force: true });
});

test('REQ-015 答え方の決まり：選択肢は名前だけを書き、「名前（説明）」と写さない。見えないものを指す問いには聞き返し、「見えません」と言わない', () => {
  const rules = USER_ROLE_RULES_TEXT();
  assert.match(rules, /名前（説明）」の形にしない/);
  assert.match(rules, /説明の部分は写さない/);
  assert.match(rules, /「上の〜とは、どれのことですか？」のように聞き返す/);
  assert.match(rules, /「違いはない」「特にない」と答えない/);
  assert.match(rules, /「見えません」「表示されていません」のような、機械の言い方はしない/);
  assert.match(rules, /「（　）」で重ねて書かない/);
  assert.match(rules, /AI が質問の前にチャットに書いた文も、読んだものとして踏まえる/);
  assert.match(rules, /最初に書いてある自分の立場と仕事（誰として、何のために、何をしているか）は、自分のこととして答えてよい/);
  // 選択肢の見出しにも、名前だけを使うと書く（説明は手がかり）
  const p = buildUserPrompt({ question: 'q', choices: [{ label: '違いも不足もない', description: 'このままでよい' }] });
  assert.ok(p.includes('選ぶときは名前だけを使う'));
  assert.ok(p.includes('- 違いも不足もない（このままでよい）'));
  // 指示の言葉の見張り（INSTRUCTION_WORDS）に、足した決まりの文が当たらないように、決まりの文は口に出さない側に書いてある
  assert.ok(USER_RULES.some((r) => r.includes('口に出さない')));
});

test('REQ-017 決まりの確かめ：足す中身（例外・本当のやり方）そのものを確かめられたときは「このとおり」。足す中身のないものには付けない', () => {
  const system = buildSystemPrompt(weekly);
  const rule = weekly.knowledge.find((k) => k.id === 'headings');
  assert.ok(rule && !rule.file.detail);
  const blocks = system.split('\n- ').filter((b) => b.includes('これはファイル「'));
  const withDetail = blocks.filter((b) => b.includes('ただし、相手が確かめてきた文の中に、すでにこの具体的な中身が書いてあるときは'));
  assert.equal(withDetail.length, weekly.knowledge.filter((k) => k.from === 'file' && k.file.detail).length);
  assert.ok(withDetail.every((b) => b.includes('「このとおり」を選ぶ')));
  assert.ok(blocks.length > withDetail.length, '足す中身のない決まり（このとおり・たまたま）には付かない');
});

// ---- 道具の呼び出しの形の答え（外側の EVAL（改善）1回目の診断 1.4、testing.md 6.1） --------------------------------

/** 道具の呼び出しの形の文（試験の文字そのものに書くと紛らわしいので、組み立てる） */
const LT = '<';
const markupAnswer = (prefix = '') => `${LT}${prefix}invoke name="Read">\n${LT}${prefix}parameter name="file_path">kx200-firmware/.github/skills/cross-compile/scripts/kx-build.sh${LT}/${prefix}parameter>\n${LT}/${prefix}invoke>`;

test('REQ-015 ユーザー役への指示に、ファイルを開いて見る道具はないことと、知っていることの範囲で答えることを書く', () => {
  const system = buildSystemPrompt(weekly);
  const rule = 'ファイルを開いて見る道具はない。ファイルの中身は、知っていることの範囲で答える。';
  assert.ok(system.includes(rule));
  assert.equal(INSTRUCTION_WORDS.test(rule), false, 'ユーザー役がこの文を口にしても、指示の言葉の見張りには当たらない（ふつうの言い方）');
});

test('REQ-015 道具の呼び出しの形の見分け：invoke・function_calls・parameter の印と antml: に当たり、ふつうの答えには当たらない', () => {
  for (const text of [markupAnswer(), markupAnswer('antml:'), `${LT}function_calls>`, `${LT}parameter name="x">1`, 'antml:invoke']) {
    assert.ok(TOOL_CALL_MARKUP.test(text), text);
  }
  for (const text of ['このとおり。-O2 でビルドしています。', 'kx-build.sh の --src と --name を渡します', '引数（parameter）は3つです', '<tmp> に送ります']) {
    assert.equal(TOOL_CALL_MARKUP.test(text), false, text);
  }
});

test('REQ-015 答えが道具の呼び出しの形なら、「答えの文だけを書いてください。道具は使えません。」を足して呼び直し、直った答えを使う', async () => {
  const prompts = [];
  const sdk = createFakeSdk({ userRole: ({ prompt }) => { prompts.push(prompt); return prompts.length === 1 ? markupAnswer() : 'このとおり。0 以外はビルドの失敗です。'; } });
  const home = tmp();
  const role = createUserRole({ persona: weekly, query: sdk.query, home });
  const entry = await role.answer('終了コードの決まりですか？', [], 'AskUserQuestion');
  assert.equal(entry.answer, 'このとおり。0 以外はビルドの失敗です。');
  assert.equal(entry.markupRetries, 1);
  assert.equal(prompts.length, 2);
  assert.ok(!prompts[0].includes(MARKUP_RETRY_NOTE));
  assert.ok(prompts[1].endsWith(MARKUP_RETRY_NOTE));
  // 履歴には直った答えだけが残り、呼び直しの費用も数える
  assert.deepEqual(role.history.map((h) => h.answer), ['このとおり。0 以外はビルドの失敗です。']);
  assert.ok(Math.abs(role.cost - 0.002) < 1e-9);
  // 直らなかった問いは、askUserRole（ユーザー役の試験）でも同じに呼び直す
  let n = 0;
  const sdk2 = createFakeSdk({ userRole: () => ((n += 1) <= 2 ? markupAnswer('antml:') : '特に決まっていません') });
  const r = await askUserRole(weekly, 'q', [], { query: sdk2.query });
  assert.equal(r.text, '特に決まっていません');
  assert.equal(n, 3);
  fs.rmSync(home, { recursive: true, force: true });
});

test(`REQ-015 呼び直しても道具の呼び出しの形のままなら（${MARKUP_RETRIES} 回まで）、試験の仕組みの失敗として投げ、答えを履歴に入れない`, async () => {
  let calls = 0;
  const sdk = createFakeSdk({ userRole: () => { calls += 1; return markupAnswer(); } });
  const home = tmp();
  const role = createUserRole({ persona: weekly, query: sdk.query, home });
  await assert.rejects(() => role.answer('q', [], 'AskUserQuestion'), (error) => {
    assert.equal(error.code, 'tool_markup');
    assert.match(error.message, /3 回続けて道具の呼び出しの形でした（試験の仕組みの失敗。クリエイターには渡していません）/);
    return true;
  });
  assert.equal(calls, MARKUP_RETRIES + 1);
  assert.equal(role.answerCount, 0);
  assert.equal(role.history.length, 0);
  assert.ok(Math.abs(role.cost - 0.003) < 1e-9, '失敗した呼び出しの費用も数える');
  await assert.rejects(() => askUserRole(weekly, 'q', [], { query: sdk.query }), /道具の呼び出しの形でした/);
  fs.rmSync(home, { recursive: true, force: true });
});

function USER_ROLE_RULES_TEXT() {
  return USER_RULES.join('\n');
}
