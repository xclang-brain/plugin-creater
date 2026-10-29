// 2段目 部品の試験（クリエイターのエクステンション）：ユーザーの言葉の抜き書きの確かめ（quote.mjs）。
// 外側の EVAL の1回目で落ちた2観点への守り：
//   - 項目を未着手から変えるときの抜き書きは、それより前の問答の記録のユーザーの言葉の中にある
//   - 生成前の確認で足したナレッジの抜き書きが、選んだ選択肢の文だけなら、足したことにならない
// 外側の EVAL（改善）の1回目で落ちた観点への守り：直すとき、引き継いだ決まりを「決まった」にする抜き書きは、その番号を示した問いへの答えの中にある
// 直すときは、頼みの文もユーザーの言葉に数える（REQ-056。どの項目で数えるかは record-tools.test.mjs で見る）
// 抜き書きが見つかるかの決め方は、外側の EVAL の採点（tests/dev-eval/runner/outer-grade.mjs）と同じなので、同じ場合分けを両方に通して見張る。
// 設計書：hearing.md 7.2、testing.md 6.5、REQ-015、REQ-020。
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { EXTENSION_DIR, REPO_ROOT } from './helpers.mjs';

const quote = await import(pathToFileURL(path.join(EXTENSION_DIR, 'quote.mjs')).href);
const grade = await import(pathToFileURL(path.join(REPO_ROOT, 'tests', 'dev-eval', 'runner', 'outer-grade.mjs')).href);

const ANSWER_1 = '1. 売上データの sales.csv（日付・担当・金額）をもらいます。2. 売上集計表.xlsx に sales.csv の中身を貼り付けて、万円にして切り捨てます。';
const ANSWER_2 = '思い当たらない（いつもと違うことはなかった）。\n\nただ、先週は田中さんの売上が0円でした。';
const ANSWER_3 = 'User responded: 毎週金曜日の17時までです';

// [名前, 抜き書き, 答えの一覧, 見つかるか]
const CASES = [
  ['そのまま写した', 'sales.csv（日付・担当・金額）をもらいます', [ANSWER_1], true],
  ['間の括弧を省いた（印なし。見つからない）', 'sales.csv をもらいます', [ANSWER_1], false],
  ['答えの全部', ANSWER_3, [ANSWER_3], true],
  ['答えの一部（前置きを除く）', '毎週金曜日の17時まで', [ANSWER_3], true],
  ['空白の違い', '毎週 金曜日の 17時まで', [ANSWER_3], true],
  ['句読点とかぎ括弧の違い', '「毎週金曜日の17時までです。」', [ANSWER_3], true],
  ['全角と半角の違い（NFKC）', '毎週金曜日の１７時までです', [ANSWER_3], true],
  ['括弧の中だけ', 'sales.csv（日付・担当・金額）', [ANSWER_1], true],
  ['「…」で間を省いた（同じ答えの中）', '思い当たらない…ただ、先週は田中さんの売上が0円でした', [ANSWER_2], true],
  ['「...」で間を省いた', '思い当たらない...田中さんの売上が0円', [ANSWER_2], true],
  ['「⋯」で間を省いた', '思い当たらない⋯田中さんの売上', [ANSWER_2], true],
  ['改行をまたいで写した', '思い当たらない（いつもと違うことはなかった）。ただ、先週は田中さんの', [ANSWER_2], true],
  ['括弧を印なしに省いた（EVAL 1回目の誤り）', '思い当たらない。ただ、先週は田中さんの売上が0円でした', [ANSWER_2], false],
  ['手順を「→」でつないだ要約（EVAL 1回目の誤り）', 'sales.csv をもらう→売上集計表.xlsx に貼り付け→万円にして切り捨て', [ANSWER_1], false],
  ['「…」の断片が別々の答えにある', '毎週金曜日…田中さんの売上', [ANSWER_3, ANSWER_2], false],
  ['「…」の断片が同じ答えにある（複数の答えのうちの1つ）', '毎週金曜日…17時まで', [ANSWER_2, ANSWER_3], true],
  ['別の答えの言葉', '田中さん', [ANSWER_3], false],
  ['答えが1件もない', 'なんでも', [], false],
  ['抜き書きが空', '', [ANSWER_3], false],
  ['抜き書きが空白だけ', '   ', [ANSWER_3], false],
  ['抜き書きが「…」だけ', '…', [ANSWER_3], false],
  ['抜き書きが句読点だけ', '、。', [ANSWER_3], false],
  ['抜き書きが undefined', undefined, [ANSWER_3], false],
  ['抜き書きが数', 17, ['17時まで'], true],
  ['大文字と小文字は区別する', 'SALES.CSV', [ANSWER_1], false],
  ['答えより長い', `${ANSWER_3}です。そして、もう少し`, [ANSWER_3], false],
  ['英語の答え', 'I submit it on Fridays', ['User responded: I submit it on Fridays, by 5pm.'], true],
];

describe('抜き書きが見つかるかの決め方（quote.mjs と、外側の EVAL の採点が同じ）', () => {
  test('REQ-015 REQ-020 抜き書きが、ユーザーの答えのどれか1つの中にあるかを、表のとおり見分ける', () => {
    for (const [name, text, answers, expected] of CASES) {
      assert.equal(quote.quoteFound(text, answers), expected, name);
    }
  });

  test('REQ-015 REQ-020 同じ場合分けを、外側の EVAL の採点（outer-grade.mjs の quoteFound・normalizeQuote）にも通して、同じ答えになる（決め方がずれない）', () => {
    for (const [name, text, answers] of CASES) {
      assert.equal(quote.quoteFound(text, answers), grade.quoteFound(text, answers), name);
    }
    for (const text of ['  A　b\tC ', '「あ」、い。うｴ', '１２３abc', undefined, null, 5, '…', '\n']) {
      assert.equal(quote.normalizeQuote(text), grade.normalizeQuote(text), JSON.stringify(text));
    }
  });
});

describe('問答の記録から取り出すもの（quote.mjs）', () => {
  const QA = [
    { type: 'ask_user', question: { message: 'a' }, answer: 'User responded: はい', outcome: 'answered' },
    { type: 'ask_user', question: { message: 'b' }, answer: 'User cancelled the request.', outcome: 'cancelled' },
    { type: 'ask_user', question: { message: 'c' }, answer: 'The user is not available to respond', outcome: 'unavailable' },
    { type: 'user_prompt', text: 'ついでに、祝日は月曜です' },
    { type: 'ask_user', question: { message: 'd' }, answer: '古い形の答え' }, // outcome のない記録は、答えが来たものとして扱う
    { type: 'other', text: 'x' },
    null,
  ];

  test('REQ-015 ユーザーの言葉は、答えが来た ask_user の答えと、打った発言。取り消しと断りは含めない', () => {
    assert.deepEqual(quote.userWords(QA), ['User responded: はい', 'ついでに、祝日は月曜です', '古い形の答え']);
    assert.deepEqual(quote.userWords([]), []);
    assert.deepEqual(quote.userWords(undefined), []);
  });

  test('REQ-056 頼みの文は、既定では数えない（作るとき）。request を true にすると数える（今のプラグインを直すとき）', () => {
    const qa = [{ type: 'request', text: 'デプロイを足したい' }, { type: 'request', text: 5 }, ...QA];
    assert.deepEqual(quote.userWords(qa), ['User responded: はい', 'ついでに、祝日は月曜です', '古い形の答え']);
    assert.deepEqual(quote.userWords(qa, {}), quote.userWords(qa));
    assert.deepEqual(quote.userWords(qa, { request: true }), ['デプロイを足したい', 'User responded: はい', 'ついでに、祝日は月曜です', '古い形の答え'], '文でない頼みの文は数えない');
    assert.deepEqual(quote.userWords([{ type: 'request', text: 'x' }], { request: true }), ['x']);
  });

  test('REQ-020 ask_user の問いの選択肢の文は、choices・options・requestedSchema の enum・oneOf・配列の items から集める。説明をつなげたものも数える', () => {
    assert.deepEqual(quote.choicesOf({ choices: ['はい', { label: 'いいえ', description: '次へ進む' }] }), ['はい', 'いいえ', 'いいえ次へ進む']);
    assert.deepEqual(quote.choicesOf({ options: [{ label: 'A', description: '説明' }] }), ['A', 'A説明']);
    assert.deepEqual(
      quote.choicesOf({ requestedSchema: { type: 'object', properties: { a: { type: 'string', enum: ['x', 'y'] }, b: { oneOf: [{ const: 'v1', title: '表示名1' }] }, c: { type: 'array', items: { enum: ['m', 'n'] } } } } }),
      ['x', 'y', '表示名1', 'v1', 'm', 'n'],
    );
    assert.deepEqual(quote.choicesOf('文字だけの問い'), []);
    assert.deepEqual(quote.choicesOf(null), []);
    assert.deepEqual(quote.choicesOf({ choices: [null, 5, '', '  '] }), []);
  });

  test('REQ-020 抜き書きが、ユーザーが選んだ選択肢の文だけと同じかを見分ける（選ばれていない選択肢や、自分の言葉なら違う）', () => {
    const qa = [
      { type: 'ask_user', question: { message: '足りないことは？', choices: ['違うところはない（この一覧と案で合っている）', '直したい'] }, answer: 'User responded: 違うところはない（この一覧と案で合っている）', outcome: 'answered' },
      { type: 'ask_user', question: { message: '別の問い', choices: ['毎週', '毎月'] }, answer: 'User responded: 毎月', outcome: 'answered' },
    ];
    const only = (text) => quote.isOnlyChosenOption(text, qa);
    assert.equal(only('違うところはない（この一覧と案で合っている）'), true);
    assert.equal(only('「違うところはない（この一覧と案で合っている）」。'), true, 'かぎ括弧と句読点の違いは同じ');
    assert.equal(only('違うところはない。この一覧と案で合っている'), false, '丸括弧は消さない（採点と同じ）');
    assert.equal(only('毎月'), true);
    assert.equal(only('毎週'), false, '選ばれていない選択肢');
    assert.equal(only('直したい'), false, '選ばれていない選択肢');
    assert.equal(only('毎月、月末に出します'), false, '自分の言葉を足している');
    assert.equal(only('違うところはない'), false, '選択肢の一部');
    assert.equal(only(''), false);
    assert.equal(quote.isOnlyChosenOption('毎月', []), false);
    assert.equal(quote.isOnlyChosenOption('毎月', [{ type: 'ask_user', question: { choices: ['毎月'] }, answer: 'User cancelled the request.', outcome: 'cancelled' }]), false, '取り消しは選んだことにならない');
  });

  test('REQ-054 引き継いだ決まりの抜き書きが、その番号を示した問いへの答えの中にあるかを見分ける（番号は前後が英数字でない形。ask_user がなければ通す）', () => {
    const qa = [
      { type: 'ask_user', question: { message: '今のプラグインは、次のことができます。違うところはありますか？' }, answer: 'User responded: 決まりの一覧（K-01〜K-03）で古いものはありません', outcome: 'answered' },
      { type: 'ask_user', question: { message: '今の決まりは次のとおりです。\nK-01 毎週金曜に出す\nK-02 見出しは実績、予定の順\nK-030 ほか' }, answer: 'User responded: ない', outcome: 'answered' },
      { type: 'ask_user', question: { message: 'K-03 は今も同じですか？' }, answer: 'User cancelled the request.', outcome: 'cancelled' },
      { type: 'ask_user', question: { header: '直す決まり', options: [{ label: 'K-04 を直す' }] }, answer: 'User responded: K-04 を直す', outcome: 'answered' },
      { type: 'user_prompt', text: 'K-03 もそのとおりです' },
    ];
    const shown = (text, id) => quote.quoteInAnswerShowing(text, id, qa);
    assert.equal(shown('ない', 'K-01'), true);
    assert.equal(shown('ない', 'K-02'), true);
    assert.equal(shown('ない', 'K-03'), false, 'K-030 は K-03 に当たらない。取り消した問いと打った発言は数えない');
    assert.equal(shown('K-03 もそのとおりです', 'K-03'), false, '打った発言は、番号を示した問いへの答えではない');
    assert.equal(shown('古いものはありません', 'K-01'), false, '番号を示していない問いの答え（答えに番号の範囲があっても）');
    assert.equal(shown('ない', 'K-0'), false, 'K-01 は K-0 に当たらない');
    assert.equal(shown('K-04 を直す', 'K-04'), true, '選択肢の文に番号があってもよい');
    assert.equal(quote.quoteInAnswerShowing('何でも', 'K-01', [{ type: 'user_prompt', text: 'x' }]), true, 'ask_user がなければ確かめない');
    assert.equal(quote.quoteInAnswerShowing('何でも', 'K-01', undefined), true);
  });

  test('REQ-054 番号のすぐ後が英字でも当たらない。答えが来なかった問いのすぐ次に打った発言は、その問いへの答えに数える（間にほかの記録があれば数えない）', () => {
    const list = { message: '今の決まりは次のとおりです。\nK-01 毎週金曜に出す\nK-02 見出しは実績、予定の順' };
    const ask = (question, answer, outcome = 'answered') => ({ type: 'ask_user', question, answer, outcome });
    const shown = (text, id, qa) => quote.quoteInAnswerShowing(text, id, qa);
    assert.equal(shown('ない', 'K-01', [ask({ message: 'K-01a の件' }, 'User responded: ない')]), false, 'K-01a は K-01 に当たらない');
    assert.equal(shown('ない', 'K-01', [ask({ header: 'K-01 の確かめ', message: '今と違いますか？' }, 'User responded: ない')]), true, '見出しの番号も数える');
    // 取り消した・答えられなかった一覧の問いの後に、チャットに打った答え
    for (const [answer, outcome] of [['User cancelled the request.', 'cancelled'], ['The user is not available to respond.', 'unavailable']]) {
      const qa = [ask(list, answer, outcome), { type: 'user_prompt', text: 'K-02 だけ古いです' }];
      assert.equal(shown('K-02 だけ古いです', 'K-01', qa), true, outcome);
    }
    const between = [ask(list, 'User cancelled the request.', 'cancelled'), ask({ message: '別の問い' }, 'User responded: はい'), { type: 'user_prompt', text: 'K-02 だけ古いです' }];
    assert.equal(shown('K-02 だけ古いです', 'K-01', between), false, '間にほかの問いがある');
    const afterAnswered = [ask(list, 'User responded: ない'), { type: 'user_prompt', text: 'K-02 だけ古いです' }];
    assert.equal(shown('K-02 だけ古いです', 'K-01', afterAnswered), false, '答えが来た問いの後の発言は、その問いへの答えではない');
  });
});
