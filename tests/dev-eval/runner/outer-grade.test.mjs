// 外側の EVAL の採点（outer-grade.mjs）の試験。会話の記録は、試験の中で組み立てる。実際のモデルは使わない。
// 動かし方（リポジトリの根で）：node --test "tests/dev-eval/runner/*.test.mjs"

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadPersona } from '../personas/validate.mjs';
import {
  HAIKU_REQUIRED,
  collectGeneratedFiles,
  countRecorded,
  environmentNotGraded,
  exchangesOf,
  gradeAllItemsHeard,
  gradeFirstRun,
  gradeHurryOptions,
  gradeModels,
  gradeNoGenerationBeforeApproval,
  gradeOuter,
  gradeScreenUrlShown,
  isTestCode,
  knowledgeTrace,
  normalizeModelId,
  normalizeQuote,
  quoteFound,
  scopes,
  sha256OfBuffer,
  userRoleFaults,
} from './outer-grade.mjs';
import { tempDir } from './temp-dirs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PERSONAS = path.join(here, '..', 'personas');
const weekly = await loadPersona(path.join(PERSONAS, 'weekly-report'), { allStyles: true });
const training = await loadPersona(path.join(PERSONAS, 'training-survey'));

const ITEM_NAMES = ['作業の目的', '頼む場面と言い方', '受け取るもの', '進め方', '成果物', '合否の決め方', '決まった書き方やルール', '守らないと困ること', '使う道具と環境', 'いつもと違うとき', '前回の1回', '資産', '標準機能と公開のプラグイン', '開始前に設定したいこと', '実行中に見たいこと', '終わった後に見たい結果と見せ方'];
const ITEM_KEYS = ['purpose', 'trigger', 'input', 'procedure', 'output', 'criteria', 'rules', 'must_not_break', 'tools', 'exceptions', 'last_case', 'assets', 'oss', 'settings', 'running_view', 'result_view'];

/** 会話の記録を組み立てる道具 */
function script() {
  let seq = 0;
  let index = 0;
  let callId = 0;
  const items = [];
  const toolEvents = [];
  return {
    items,
    toolEvents,
    question(question, { header = '', options = [] } = {}) {
      items.push({ seq: (seq += 1), kind: 'creator.question', header, question, options, multiSelect: false });
    },
    answer(question, answer, { via = 'AskUserQuestion', signal = false, header = '' } = {}) {
      items.push({ seq: (seq += 1), kind: 'user.answer', index: index++, via, question, header, choices: [], answer, signal });
    },
    use(name, input) {
      items.push({ seq: (seq += 1), kind: 'tool.use', owner: 'main', id: `t${seq}`, name, input });
    },
    progress(args, { isError = false } = {}) {
      callId += 1;
      toolEvents.push({ seq: (seq += 1), type: 'tool.call', callId, tool: 'progress', args });
      toolEvents.push({ seq: (seq += 1), type: 'tool.result', callId, tool: 'progress', isError, result: isError ? '断った' : '記録しました' });
    },
    /** 画面を開くツール（open）の成功した呼び出しと、返り値の URL をチャットに書いた文（REQ-043） */
    open(url = SCREEN_URL) {
      callId += 1;
      toolEvents.push({ seq: (seq += 1), type: 'tool.call', callId, tool: 'open', args: {} });
      toolEvents.push({ seq: (seq += 1), type: 'tool.result', callId, tool: 'open', isError: false, result: `plugin-creator の画面の用意ができました。次の URL をブラウザーで開いてください：${url}` });
      items.push({ seq: (seq += 1), kind: 'creator.text', text: `決まったことは plugin-creator の画面で見られます：${url}` });
    },
  };
}

const SCREEN_URL = 'http://127.0.0.1:41234/?k=abcDEF123_-xyz';

const allItemsState = (overrides = {}) => ({ stage: 'confirm', rebuild: false, items: Object.fromEntries(ITEM_KEYS.map((k) => [k, { status: 'asked' }])), ...overrides });

const file = (rel, text, extra = {}) => ({ rel, size: text?.length ?? 0, sha256: sha256OfBuffer(Buffer.from(text ?? '')), text, ...extra });

test('REQ-015 抜き書きの比べ方：空白と句読点の違いを無視し、「…」で区切った断片はすべて同じ答えの中にあればよい', () => {
  assert.equal(normalizeQuote(' 「見出し は、 2つ」。'), '見出しは2つ');
  assert.ok(quoteFound('見出しは2つだけ', ['はい、見出しは 2つだけ です']));
  assert.ok(quoteFound('見出し…2つだけ', ['見出しは、まあ、2つだけです']));
  assert.ok(!quoteFound('見出し…3つだけ', ['見出しは2つだけです']));
  assert.ok(!quoteFound('', ['何か']));
  assert.ok(!quoteFound('金曜の17時', ['月曜です', '火曜です']));
});

test('REQ-015 全項目をヒアリングしたか：すべての項目に、それより前の答えの中の抜き書きがあれば合格', () => {
  const s = script();
  s.answer('進め方を教えてください。', '毎週月曜に売上データを集計して週報にします', { via: 'text' });
  s.progress({ items: ITEM_NAMES.map((item) => ({ item, status: '聞いた', quote: '毎週月曜に売上データを集計' })) });
  const r = gradeAllItemsHeard({ state: allItemsState(), items: s.items, toolEvents: s.toolEvents });
  assert.equal(r.ok, true, r.detail);
});

test('REQ-015 全項目をヒアリングしたか：答えの中にない抜き書きがあれば不合格（モデルが作った抜き書き）', () => {
  const s = script();
  s.answer('進め方を教えてください。', '毎週月曜に集計します', { via: 'text' });
  s.progress({ items: [{ item: '進め方', status: '聞いた', quote: '毎週月曜に集計' }, { item: '成果物', status: '聞いた', quote: 'ユーザーが言っていない言葉' }] });
  const r = gradeAllItemsHeard({ state: allItemsState(), items: s.items, toolEvents: s.toolEvents });
  assert.equal(r.ok, false);
  assert.match(r.detail, /項目「成果物」の抜き書き/);
});

test('REQ-015 全項目をヒアリングしたか：抜き書きの後に出た答えは、その抜き書きの証拠にならない', () => {
  const s = script();
  s.progress({ items: [{ item: '進め方', status: '聞いた', quote: '毎週月曜に集計' }] });
  s.answer('進め方は？', '毎週月曜に集計します', { via: 'text' });
  const r = gradeAllItemsHeard({ state: allItemsState(), items: s.items, toolEvents: s.toolEvents });
  assert.equal(r.ok, false);
});

test('REQ-015 全項目をヒアリングしたか：未着手の項目が残っていれば不合格。断られた呼び出しは数えない', () => {
  const s = script();
  s.answer('q', '成果物は weekly_report.md です', { via: 'text' });
  s.progress({ items: [{ item: '成果物', status: '聞いた', quote: 'weekly_report.md' }] });
  const state = allItemsState();
  state.items.input = { status: 'todo' };
  const r = gradeAllItemsHeard({ state, items: s.items, toolEvents: s.toolEvents });
  assert.equal(r.ok, false);
  assert.match(r.detail, /未着手の項目が残っている：受け取るもの/);
  // 断られた呼び出しの抜き書きは見ない
  const s2 = script();
  s2.progress({ items: [{ item: '成果物', status: '聞いた', quote: 'でたらめ' }] }, { isError: true });
  assert.equal(gradeAllItemsHeard({ state: allItemsState(), items: s2.items, toolEvents: s2.toolEvents }).ok, true);
  assert.equal(gradeAllItemsHeard({ state: null, items: [], toolEvents: [] }).ok, false);
});

test('REQ-015 作り直しのときだけ、項目「できていたことの確認」も未着手であってはならない', () => {
  const state = allItemsState({ rebuild: true });
  const r = gradeAllItemsHeard({ state, items: [], toolEvents: [] });
  assert.equal(r.ok, false);
  assert.match(r.detail, /できていたことの確認/);
});

test('REQ-020 承認の前に生成しなかったか：承認の抜き書きが直前の答えにあり、それより前の書き込みが作業の定義の案だけなら合格', () => {
  const s = script();
  s.use('Write', { file_path: '/w/.plugin-creator-work/draft/task.json', content: '{}' });
  s.question('この内容で作ってよいですか？', { options: [{ label: '作る' }, { label: '直す' }] });
  s.answer('この内容で作ってよいですか？', '作ってください、お願いします');
  s.progress({ stage: '生成', approvalQuote: '作ってください' });
  s.use('Bash', { command: 'python3 -I skills/make-plugin/scripts/scaffold.py build --hearing s.json --work w --out o' });
  const r = gradeNoGenerationBeforeApproval({ items: s.items, toolEvents: s.toolEvents });
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.approved, true);
});

test('REQ-020 承認の前に生成しなかったか：承認の前に組み立てのスクリプトが動いたら不合格', () => {
  const s = script();
  s.use('Bash', { command: 'python3 -I /x/scaffold.py build --out o' });
  s.answer('作ってよいですか？', '作ってください');
  s.progress({ stage: '生成', approvalQuote: '作ってください' });
  const r = gradeNoGenerationBeforeApproval({ items: s.items, toolEvents: s.toolEvents });
  assert.equal(r.ok, false);
  assert.match(r.detail, /承認の前に組み立てのスクリプトが動いた/);
});

test('REQ-020 承認の前に生成しなかったか：承認の前に、下書きの置き場所のほかにファイルが書かれたら不合格（サブエージェントを含む）', () => {
  const s = script();
  s.use('Write', { file_path: '/w/plugin.json', content: '{}' });
  s.answer('作ってよいですか？', '作ってください');
  s.progress({ stage: '生成', approvalQuote: '作ってください' });
  const r = gradeNoGenerationBeforeApproval({ items: s.items, toolEvents: s.toolEvents });
  assert.equal(r.ok, false);
  assert.match(r.detail, /下書きの置き場所のほかにファイルが書かれた：\/w\/plugin\.json/);
});

test('REQ-020 承認の前に生成しなかったか：下書きの置き場所の見本（画面の図など）は、承認の前に書いてよい。置き場所の外に出る書き込みは不合格', () => {
  const s = script();
  s.use('Write', { file_path: '/w/.plugin-creator-work/draft/task.json', content: '{}' });
  s.use('Write', { file_path: '/w/.plugin-creator-work/draft/mock/gen_mock.py', content: '' });
  s.answer('作ってよいですか？', '作ってください');
  s.progress({ stage: '生成', approvalQuote: '作ってください' });
  assert.equal(gradeNoGenerationBeforeApproval({ items: s.items, toolEvents: s.toolEvents }).ok, true);

  const t = script();
  t.use('Write', { file_path: '/w/.plugin-creator-work/draft/../../plugin/plugin.json', content: '{}' });
  t.answer('作ってよいですか？', '作ってください');
  t.progress({ stage: '生成', approvalQuote: '作ってください' });
  const r = gradeNoGenerationBeforeApproval({ items: t.items, toolEvents: t.toolEvents });
  assert.equal(r.ok, false);
  assert.match(r.detail, /下書きの置き場所のほかにファイルが書かれた/);
});

test('REQ-020 承認の前に生成しなかったか：承認の抜き書きが、直前の質問のツールへの答えの中になければ不合格', () => {
  const s = script();
  s.answer('作ってよいですか？', 'ちょっと待ってください、直したい所があります');
  s.progress({ stage: '生成', approvalQuote: '作ってください' });
  assert.equal(gradeNoGenerationBeforeApproval({ items: s.items, toolEvents: s.toolEvents }).ok, false);
  // 文章の返事は「質問のツールへの答え」ではない
  const t = script();
  t.answer('作ってよいですか？', '作ってください', { via: 'text' });
  t.progress({ stage: '生成', approvalQuote: '作ってください' });
  assert.equal(gradeNoGenerationBeforeApproval({ items: t.items, toolEvents: t.toolEvents }).ok, false);
});

test('REQ-020 承認の記録がなくて、組み立てのスクリプトが動いたら不合格。何も生成していなければ合格', () => {
  const s = script();
  assert.equal(gradeNoGenerationBeforeApproval({ items: s.items, toolEvents: s.toolEvents }).ok, true);
  s.use('Bash', { command: 'python3 scaffold.py build --out o' });
  assert.equal(gradeNoGenerationBeforeApproval({ items: s.items, toolEvents: s.toolEvents }).ok, false);
});

test('REQ-015 急ぐ合図の後に、残りの項目と 3 つの進め方の問いがあるか', () => {
  const three = [{ label: 'このまま続ける' }, { label: '残りを手早く聞く' }, { label: 'ここでやめて後で続ける' }];
  const s = script();
  s.answer('q1', '短い答え。早くしてください', { signal: true });
  s.question('まだ聞いていないことが残り5件あります。どう進めますか？', { options: three });
  assert.equal(gradeHurryOptions({ items: s.items, userSignals: [{ answerIndex: 0 }] }).ok, true);

  // 合図の前の問いは数えない
  const before = script();
  before.question('残りがあります。どう進めますか？', { options: three });
  before.answer('q', '急いでいます', { signal: true });
  assert.equal(gradeHurryOptions({ items: before.items, userSignals: [{ answerIndex: 0 }] }).ok, false);

  // 進め方が欠けている
  const lacking = script();
  lacking.answer('q', '急いでいます', { signal: true });
  lacking.question('残りがあります。続けますか？', { options: [{ label: 'はい' }, { label: 'いいえ' }] });
  assert.equal(gradeHurryOptions({ items: lacking.items, userSignals: [{ answerIndex: 0 }] }).ok, false);

  // 合図を出していなければ、この観点はない
  assert.equal(gradeHurryOptions({ items: s.items, userSignals: [] }), null);
});

test('REQ-016 まだやったことのない作業：「初めてやるとしたら」の問いの後に、前回の 1 回（想定の 1 回）を記録していれば合格', () => {
  const s = script();
  s.answer('この作業を初めてやるとしたら、最初に何をしますか？', 'survey.csv を開いて平均を出します');
  s.progress({ items: [{ item: '前回の1回', status: '聞いた', quote: 'survey.csv を開いて' }] });
  const ok = gradeFirstRun({ persona: training.persona, exchanges: s.items.filter((i) => i.kind === 'user.answer'), toolEvents: s.toolEvents });
  assert.equal(ok.ok, true, ok.detail);

  const none = script();
  none.answer('成果物は？', 'survey_summary.md です');
  assert.equal(gradeFirstRun({ persona: training.persona, exchanges: none.items.filter((i) => i.kind === 'user.answer'), toolEvents: none.toolEvents }).ok, false);

  const noWalk = script();
  noWalk.answer('この作業を初めてやるとしたら、最初に何をしますか？', 'まず CSV を見ます');
  assert.equal(gradeFirstRun({ persona: training.persona, exchanges: noWalk.items.filter((i) => i.kind === 'user.answer'), toolEvents: noWalk.toolEvents }).ok, false);
});

test('REQ-015 ナレッジごとの記録：聞いた・答えた・組み込まれた・聞かれずに話した・漏れた', () => {
  const { persona } = weekly;
  const s = script();
  s.answer('成果物はどんなファイルですか？', '成果物は weekly_report.md です');
  s.answer('テンプレートや見出しの決まりはありますか？', '見出しは「■今週の売上」と「■来週の予定」の2つです');
  // 「以上」は、聞かれずに話した（ユーザー役の誤り）
  s.answer('守らないと困ることはありますか？', '最後の行は必ず「以上」にします');
  const exchanges = s.items.filter((i) => i.kind === 'user.answer');
  const generated = [
    file('skills/w/SKILL.md', '成果物は weekly_report.md。見出しは ■今週の売上 と ■来週の予定。'),
    file('tests/knowledge.json', '["最後の行は「以上」"]'),
    file('docs/x.md', '題名の日付は 10/5〜10/9 の形で書く'),
  ];
  const scope = scopes(generated, []);
  const trace = knowledgeTrace({ persona, exchanges, scope });
  const by = Object.fromEntries(trace.map((t) => [t.id, t]));
  assert.deepEqual([by.output.asked, by.output.answered, by.output.embedded, by.output.verdict], [true, true, true, 'ok']);
  assert.deepEqual([by.headings.asked, by.headings.answered, by.headings.embedded, by.headings.verdict], [true, true, true, 'ok']);
  // 「以上」：聞かれていない質問に話した。一覧にしかないので、組み込みの証拠にならない
  assert.equal(by.ijou.unprompted, true);
  assert.equal(by.ijou.leaked, true);
  assert.equal(by.ijou.embedded, false);
  assert.equal(by.ijou.verdict, 'not-written');
  // たまたまの書き方が決まりとして入った
  assert.equal(by['title-date'].excludedHit, true);
  assert.equal(by['title-date'].verdict, 'wrongly-embedded');
  // 聞かれても答えてもいない
  assert.equal(by['man-yen'].asked, false);
  assert.equal(by['man-yen'].verdict, 'not-asked');
});

// 外側の EVAL（改善）2回目の問いと答え（記録の seq。文は抜き書き）。ナレッジの言葉は、そのときの edl-change の模擬ユーザーのもの
const RUN2_KNOWLEDGE = [
  { id: 'cc-toolchain', volunteer: false, markers: { asked: 'コンパイラ|ツールチェーン|arm-linux|gcc|ビルドのやり方|ビルドの仕方|ビルドの決まり', answered: 'arm-linux-gnueabihf' } },
  { id: 'dp-console', volunteer: false, markers: { asked: 'console|コマンドを打|打ち方|打つ方法|入り方|どうやって入|kxtool', answered: 'console' } },
  { id: 'log-dbg', volunteer: false, markers: { asked: 'DBG_LOG|dbg_log|ログ関数|ログの出し方|ログをどう出|printf|書き足|ログ追加', answered: 'DBG_LOG' } },
];
const RUN2 = {
  194: { header: 'つまずき', question: '初めての人がつまずくところは、AI もつまずきやすいところです。KX-200 でクロスコンパイルしてボードにデプロイし、ログを取るとき、初めての人がやると、どこで間違えそうですか？', choices: [{ label: '書く', description: 'Other 欄に書く' }, { label: '特にない', description: '思い当たるところはない' }], answer: '書く\n\n1. 開発機の gcc でビルドしてしまう。KX-200 は arm-linux-gnueabihf-gcc でビルドしないと動きません。' },
  228: { header: 'DBG_LOG', question: '「KX-200 では、dbg_log.h の DBG_LOG でログを出し、printf を直接使わない」という決まりですか？', choices: [{ label: 'このとおり', description: 'この決まりで合っている' }], answer: 'このとおり\n\nKX-200 のファームウェアでは、ログは dbg_log.h の DBG_LOG で出す決まりで、printf は直接使いません。' },
  397: { header: '進め方', question: '次の順で進めると理解しました。\n1. ソースにログを足す（dbg_log.h の DBG_LOG）\n4. kxtool -d <アドレス> send でボードに送る\n違うところと足りないところを書いてください。', choices: [{ label: 'ない', description: 'このとおり' }, { label: '書く', description: 'Other 欄に書く' }], answer: '書く\n\n2. 手順5で、ボードでコマンドを打つときは `kxtool -d <アドレス> console -c "<コマンド>"` で打ちます。' },
  411: { header: '守ること', question: 'KX-200 で守らないと困ることは、次のとおりと理解しました。\n- arm-linux-gnueabihf-gcc でビルドする\n\nKX-200 で、ほかに守らないと困ることはありますか？', choices: [{ label: 'ない', description: 'このとおり' }, { label: '書く', description: 'Other 欄に書く' }], answer: '書く\n\n2. ボードでコマンドを打つときは、kxtool -d <アドレス> console -c "<コマンド>" で打ちます。\n\nほかに、KX-200 のファームウェアでは、ログは dbg_log.h の DBG_LOG で出し、printf は直接使わない決まりです。' },
};
const run2Exchanges = (seqs) => seqs.map((seq, index) => ({ seq: seq + 1, index, via: 'AskUserQuestion', signal: false, ...RUN2[seq] }));
const leakedOf = (exchanges) => knowledgeTrace({ persona: { knowledge: RUN2_KNOWLEDGE }, exchanges, scope: { embedded: '', excluded: '', task: '' } }).filter((t) => t.leaked);
// answered の言葉（arm-linux-gnueabihf）が asked に当たらないナレッジ。問いに示しただけで聞いてはいない、を作るため（RUN2_KNOWLEDGE の3つは、answered の言葉が asked にも当たる）
const NARROW = { id: 'cc-name', volunteer: false, markers: { asked: 'コンパイラ|ツールチェーン', answered: 'arm-linux-gnueabihf' } };
const traceNarrow = (exchanges) => knowledgeTrace({ persona: { knowledge: [NARROW] }, exchanges, scope: { embedded: '', excluded: '', task: '' } });

test('REQ-015 聞かれずに話した：前に答えた・クリエイターが示したナレッジを、後の答えでくり返しただけなら、漏れにしない（外側の EVAL〔改善〕2回目の [412]）', () => {
  // [412] は、確かめで答えた DBG_LOG（[229]）と、進め方の問いへの答えで足した console（[398]）をくり返した。
  // [195] の arm-linux-gnueabihf は、まだ会話に出ていないナレッジを、つまずきの問い（asked に当たらない）に答えて話した
  const exchanges = run2Exchanges([194, 228, 397, 411]);
  const trace = leakedOf(exchanges);
  assert.deepEqual(trace.map((t) => [t.id, t.leakedAt]), [['cc-toolchain', 0]]);
  assert.deepEqual(userRoleFaults({ exchanges, trace }), [{ kind: 'leaked', knowledge: 'cc-toolchain', answerIndex: 0 }]);
  // 前のやり取りがなければ、[412] の DBG_LOG と console は、守ることの問い（どちらの asked にも当たらない）に答えて話したことになる
  assert.deepEqual(leakedOf(run2Exchanges([411])).map((t) => t.id), ['dp-console', 'log-dbg']);
  // [411] の問いは arm-linux-gnueabihf-gcc を示している（クリエイターが示した）ので、[412] でくり返しても漏れにしない。
  // asked が [411] の問いに当たらないナレッジで見る（cc-toolchain の asked は gcc で [411] に当たり、示した経路を確かめられないため）
  const repeated = run2Exchanges([411]).map((e) => ({ ...e, answer: `${e.answer}\narm-linux-gnueabihf-gcc でビルドします。` }));
  assert.equal(traceNarrow(repeated)[0].leaked, false);
  // 問いが示していなければ、同じ答えは漏れ
  assert.deepEqual(traceNarrow(repeated.map((e) => ({ ...e, question: 'KX-200 で、ほかに守らないと困ることはありますか？' }))).map((t) => [t.leaked, t.leakedAt]), [[true, 0]]);
});

/** 質問のツールの問いと答えの組（exchangesOf の形） */
const ask = (index, header, question, choices, answer, shown = '') => ({ seq: index * 2 + 2, index, via: 'AskUserQuestion', signal: false, header, question, choices, answer, shown });

test('REQ-015 聞かれずに話した：前の答えで話した（聞かれて答えた）ナレッジは、問いに示されていなくても、後でくり返して漏れにしない', () => {
  // 問い0は log-dbg の asked（ログの出し方）に当たり、DBG_LOG（answered）を示していない。答え0で初めて話した
  const exchanges = [
    ask(0, 'ログ', 'ログの出し方に決まりはありますか？', [], 'ログは DBG_LOG で出します。'),
    ask(1, '守ること', 'ほかに守らないと困ることはありますか？', [], 'printf ではなく DBG_LOG を使います。'),
  ];
  assert.deepEqual(leakedOf(exchanges).map((t) => t.id), []);
  // 答え0が、聞かれていない問いへの漏れなら、漏れは答え0の1つだけ（答え1は、出たナレッジのくり返し）
  const leakedTwice = [
    ask(0, '守ること', 'ほかに守らないと困ることはありますか？', [], 'ログは DBG_LOG で出します。'),
    ask(1, 'まとめ', 'ほかにありますか？', [], 'DBG_LOG の決まりだけです。'),
  ];
  assert.deepEqual(leakedOf(leakedTwice).map((t) => [t.id, t.leakedAt]), [['log-dbg', 0]]);
});

test('REQ-015 聞かれずに話した：クリエイターが問い・選択肢・チャットの文・同じ呼び出しのほかの問いに示したナレッジは、出たものとして扱う', () => {
  // この問いの選択肢の説明に DBG_LOG がある（クリエイターが示した）
  const shownInChoice = [ask(0, '守ること', 'ほかに守らないと困ることはありますか？', [{ label: 'ない', description: 'DBG_LOG で出す決まりのほかはない' }], '書く\n\nログは DBG_LOG で出します。')];
  assert.deepEqual(leakedOf(shownInChoice).map((t) => t.id), []);
  // 前の問いが arm-linux-gnueabihf を示した（asked には当たらない）。答え0では話さず、後のほかの話題の答えで話しても漏れにしない
  const shownEarlier = [
    ask(0, '進め方', '次の順で進めると理解しました。1. arm-linux-gnueabihf-gcc でビルドする 2. ボードに送る。よいですか？', [], 'はい'),
    ask(1, '守ること', 'ほかに守らないと困ることはありますか？', [], 'arm-linux-gnueabihf-gcc でビルドしないと動きません。'),
  ];
  assert.deepEqual(traceNarrow(shownEarlier).map((t) => [t.asked, t.leaked]), [[false, false]]);
  // 選択肢に示したときも同じ
  const shownInEarlierChoice = [ask(0, '進め方', 'ビルドはどうしますか？', [{ label: '今のまま', description: 'arm-linux-gnueabihf-gcc でビルドする' }], '今のまま'), shownEarlier[1]];
  assert.deepEqual(traceNarrow(shownInEarlierChoice).map((t) => t.leaked), [false]);
  // 前の問いが示していなければ、答え1は漏れ
  assert.deepEqual(traceNarrow([{ ...shownEarlier[0], question: '次の順で進めると理解しました。よいですか？' }, shownEarlier[1]]).map((t) => [t.leaked, t.leakedAt]), [[true, 1]]);
  // 前の答えの後のチャットの文（shown）に示した
  assert.deepEqual(leakedOf([ask(0, '守ること', 'ほかに守らないと困ることはありますか？', [], 'ログは DBG_LOG で出します。', '読み取った決まり：ログは DBG_LOG で出す。')]).map((t) => t.id), []);
  // 前の問いの選択肢が console の asked（打ち方）に当たった（聞いた）だけでは、出たにしない。後のほかの話題の答えで話したら漏れ
  const choice = [{ label: '打ち方を書く', description: 'Other 欄に書く' }, { label: 'ない', description: 'このとおり' }];
  const askedInChoice = [
    ask(0, '進め方', 'ボードでの手順は、次のとおりでよいですか？', choice, 'ない'),
    ask(1, '守ること', 'ほかに守らないと困ることはありますか？', [], 'ボードでは console -c で打ちます。'),
  ];
  assert.deepEqual(leakedOf(askedInChoice).map((t) => [t.id, t.leakedAt]), [['dp-console', 1]]);
  // 見出しと問いが asked に当たらず、選択肢だけに当たる問いへの答えで話したら、漏れにする（その問いが聞いたかは、見出しと問いで見る）
  const answeredInChoiceQuestion = [ask(0, '進め方', 'ボードでの手順は、次のとおりでよいですか？', choice, 'ボードでは console -c で打ちます。')];
  assert.deepEqual(leakedOf(answeredInChoiceQuestion).map((t) => [t.id, t.leakedAt]), [['dp-console', 0]]);
});

test('REQ-015 会話の記録から：答えの shown は、前の答えの後のチャットの文と、同じ質問のツールの呼び出しのほかの問い', () => {
  const items = [
    { seq: 1, kind: 'user.request', text: '直したい' },
    { seq: 2, kind: 'creator.text', text: '画面：http://127.0.0.1:1/?k=x' },
    { seq: 3, kind: 'creator.question', header: 'ファイル', question: 'どこにありますか？', options: [], group: 1, groupSize: 1 },
    { seq: 4, kind: 'user.answer', index: 0, via: 'AskUserQuestion', header: 'ファイル', question: 'どこにありますか？', choices: [], answer: 'ここです' },
    { seq: 5, kind: 'creator.text', text: '読み取った決まり：ログは DBG_LOG で出す。' },
    { seq: 6, kind: 'tool.use', owner: 'main', id: 't6', name: 'Read', input: {} },
    // 1 回の呼び出しに問いが 2 つ（group 2）。答えは問いごとに記録される
    { seq: 7, kind: 'creator.question', header: '守ること', question: 'ほかに守らないと困ることは？', options: [], group: 2, groupSize: 2 },
    { seq: 8, kind: 'user.answer', index: 1, via: 'AskUserQuestion', header: '守ること', question: 'ほかに守らないと困ることは？', choices: [], answer: 'ボードでは console -c で打ちます。' },
    { seq: 9, kind: 'creator.question', header: '打ち方', question: 'ボードでは kxtool console -c で打ちますか？', options: [{ label: 'はい', description: 'console -c で打つ' }], group: 2, groupSize: 2 },
    { seq: 10, kind: 'user.answer', index: 2, via: 'AskUserQuestion', header: '打ち方', question: 'ボードでは kxtool console -c で打ちますか？', choices: [{ label: 'はい', description: 'console -c で打つ' }], answer: 'はい' },
    // 続きから始めた後の記録で、group の番号が前と同じでも、チャットの文を挟めば別の呼び出し
    { seq: 11, kind: 'creator.text', text: '続けます。' },
    { seq: 12, kind: 'creator.question', header: '次', question: 'ほかには？', options: [], group: 2, groupSize: 1 },
    { seq: 13, kind: 'user.answer', index: 3, via: 'AskUserQuestion', header: '次', question: 'ほかには？', choices: [], answer: 'ない' },
  ];
  const ex = exchangesOf(items);
  assert.deepEqual(ex.map((e) => e.shown), [
    '画面：http://127.0.0.1:1/?k=x',
    '読み取った決まり：ログは DBG_LOG で出す。\n打ち方 ボードでは kxtool console -c で打ちますか？ はい console -c で打つ',
    '守ること ほかに守らないと困ることは？',
    '続けます。',
  ]);
  // 答え1の console は、同じ呼び出しの後の問い（同時に見えている）が示しているので、漏れにしない
  assert.deepEqual(leakedOf(ex).map((t) => t.id), []);
  // 後の問いがなければ、答え1の console は漏れ
  assert.deepEqual(leakedOf(exchangesOf(items.filter((i) => i.seq < 9))).map((t) => [t.id, t.leakedAt]), [['dp-console', 1]]);
});

test('REQ-017 たまたまの書き方が入っていない：入っていなければ ok。入力の写しにある手がかりの文字は、組み込みに数えない', () => {
  const { persona } = weekly;
  const inputCopy = file('tests/eval/T-01/inputs/先週の売上.csv', '10/5〜10/9 の売上', { text: '10/5〜10/9 の売上' });
  const hashed = [{ role: 'input', place: '資料/先週の売上.csv', sha256: inputCopy.sha256 }];
  const scope = scopes([file('skills/w/SKILL.md', '見出しは2つ'), inputCopy], hashed);
  const trace = knowledgeTrace({ persona, exchanges: [], scope });
  assert.equal(trace.find((t) => t.id === 'title-date').excludedHit, false);
  assert.equal(trace.find((t) => t.id === 'title-date').verdict, 'ok');
});

test('REQ-038 見る範囲：課題と基準のファイルは、tests/eval の eval.json と task.json。knowledge.json は組み込みの範囲に入れない', () => {
  const files = [
    file('tests/eval/T-01/eval.json', '{"criteria":[{"text":"■今週の売上"}]}'),
    file('tests/eval/T-01/inputs/a.txt', '■今週の売上'),
    file('com.github.copilot/extensions/w/task.json', '{"criteria":[{"text":"weekly_report.md"}]}'),
    file('tests/knowledge.json', '["万円"]'),
    file('README.md', '説明'),
    { rel: 'x.bin', size: 3, sha256: 'z', text: null },
  ];
  const s = scopes(files, []);
  assert.match(s.task, /■今週の売上/);
  assert.match(s.task, /weekly_report\.md/);
  assert.ok(!s.embedded.includes('万円'));
  assert.ok(s.excluded.includes('万円'));
  assert.ok(!s.embedded.includes('weekly_report.md') || files.some((f) => f.rel === 'com.github.copilot/extensions/w/task.json'), '課題と基準のファイルの文字は、組み込みの範囲にも入る（knowledge.json だけが外れる）');
});

test('REQ-017 入ってはいけない書き方は、生成プラグインの1・2段目の試験のコード（tests/stage1/・tests/stage2/）では見ない。スキル・スクリプト・エージェント・課題と基準・一覧では見る', () => {
  // 外側の EVAL〔改善〕3回目：作業エージェントが書いた否定の試験（古いアドレスには応答しない）が、古いアドレスの文字を持っていた
  const run3 = 'done = self.tool("kxtool", "-d", "192.168.7.20", "send", str(image))\nself.assertIn("no response from 192.168.7.20", done.stderr)';
  const seen = { 'skills/deploy-rules/SKILL.md': 'W-SKILL', 'skills/deploy-rules/scripts/deploy.sh': 'W-SCRIPT', 'com.github.copilot/agents/worker.agent.md': 'W-AGENT', 'tests/eval/T-01/eval.json': 'W-EVAL', 'com.github.copilot/extensions/w/task.json': 'W-TASK', 'tests/knowledge.json': 'W-LIST', 'tests/run.py': 'W-RUN', 'tests/stage3/x.py': 'W-STAGE3', 'skills/x/tests/stage2/y.py': 'W-NESTED' };
  const s = scopes([file('tests/stage2/task/test_req107_t02_fake_kx200.py', run3), file('tests/stage1/check_extra.py', 'T-STAGE1'), ...Object.entries(seen).map(([rel, text]) => file(rel, text))], []);
  assert.doesNotMatch(s.excluded, /192\.168\.7\.20|T-STAGE1/);
  for (const [rel, text] of Object.entries(seen)) assert.ok(s.excluded.includes(text), rel);
  // 組み込まれたかを見る範囲は変えない
  assert.match(s.embedded, /192\.168\.7\.20/);
  assert.equal(isTestCode('tests/stage2/task/test_req107_t02_fake_kx200.py'), true);
  assert.equal(isTestCode('tests/stage1/check_structure.py'), true);
  for (const rel of Object.keys(seen)) assert.equal(isTestCode(rel), false, rel);
});

test('REQ-039 生成プラグインのファイルを読む：.git・tests/results・node_modules は読まない。バイナリは文字なし', () => {
  const dir = tempDir('grade-files');
  const put = (rel, content) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  put('plugin.json', '{"name":"x"}');
  put('skills/x/SKILL.md', '本文');
  put('.git/config', 'git');
  put('tests/results/latest.json', '{}');
  put('tests/node_modules/playwright/index.js', 'x');
  put('docs/a.docx', Buffer.from([0x50, 0x4b, 0x00, 0x01]));
  const files = collectGeneratedFiles(dir);
  const rels = files.map((f) => f.rel).sort();
  assert.deepEqual(rels, ['docs/a.docx', 'plugin.json', 'skills/x/SKILL.md']);
  assert.equal(files.find((f) => f.rel === 'docs/a.docx').text, null);
  assert.equal(files.find((f) => f.rel === 'plugin.json').text, '{"name":"x"}');
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 全部の観点に合格する会話と生成物 */
function passingRun() {
  const s = script();
  s.open();
  s.use('Write', { file_path: '/w/.plugin-creator-work/draft/task.json', content: '{}' });
  s.answer('成果物は？ ファイルの名前を教えてください', '成果物は weekly_report.md です', { via: 'text' });
  s.progress({ items: ITEM_NAMES.map((item) => ({ item, status: '聞いた', quote: 'weekly_report.md' })) });
  s.answer('この内容で作ってよいですか？', '作ってください');
  s.progress({ stage: '生成', approvalQuote: '作ってください' });
  s.use('Bash', { command: 'python3 -I scaffold.py build --out o' });
  return s;
}

const goodFiles = () => [
  file('skills/w/SKILL.md', 'weekly_report.md を作る。■今週の売上 と ■来週の予定。最後の行は 「以上」。万円で書き、切り捨て、1万円未満と書く。'),
  file('tests/eval/T-01/eval.json', 'weekly_report.md ■今週の売上 ■来週の予定 「以上」 万円 1万円未満'),
  file('tests/eval/T-01/inputs/先週の売上.csv', 'date,rep,amount', { text: 'date,rep,amount' }),
];

test('REQ-015 全体の採点：すべての観点に合格する会話と生成物なら、思考力の高いモデルでも Haiku でも合格', () => {
  const s = passingRun();
  const files = goodFiles();
  const personaFiles = weekly.files.map((f) => ({ src: f.src, place: f.place, role: f.role }));
  // 入力のファイルの写しは、元のファイルと同じ中身にする
  const inputSrc = weekly.files.find((f) => f.role === 'input').src;
  files[2] = file('tests/eval/T-01/inputs/先週の売上.csv', fs.readFileSync(inputSrc, 'utf8'));
  // 聞かれずに話すナレッジは、この会話では出ない。ここでは markers を絞った模擬ユーザーで見る
  const persona = JSON.parse(JSON.stringify(weekly.persona));
  persona.knowledge = persona.knowledge.filter((k) => k.id === 'output');
  const r = gradeOuter({ persona, personaFiles, items: s.items, toolEvents: s.toolEvents, state: allItemsState({ stage: 'generate' }), generatedCount: 1, generatedFiles: files, stages: { stage1: { ok: true }, stage2: { ok: true } }, inner: { withScore: 1 }, userSignals: [], model: 'claude-opus-5-5' });
  const failed = r.grades.filter((g) => !g.ok);
  assert.deepEqual(failed.map((g) => g.id), [], JSON.stringify(failed));
  assert.equal(r.verdict.ok, true);
  assert.equal(r.score, 1);
  assert.equal(r.exampleCandidate, true);
  assert.ok(r.grades.some((g) => g.id === 'input-files-in-repo' && g.ok));
  assert.ok(r.grades.some((g) => g.id === 'inner-deliverable' && g.ok));
  const h = gradeOuter({ persona, personaFiles, items: s.items, toolEvents: s.toolEvents, state: allItemsState({ stage: 'generate' }), generatedCount: 1, generatedFiles: files, stages: null, inner: null, userSignals: [], model: 'claude-haiku-5-5' });
  assert.deepEqual(h.verdict.required, HAIKU_REQUIRED);
  assert.equal(h.verdict.ok, true, '1・2段目を動かしていなくても、Haiku は 2 点だけを見る');
  assert.equal(h.exampleCandidate, false, 'Haiku の会話は会話例にしない');
});

test('REQ-039 全体の採点：2段目の不合格がすべてディスクの誤り（diskErrorsOnly）なら、環境で止まったとして stage2 を採点しない（点数と合否に入れず、理由を残す）', () => {
  const s = passingRun();
  const files = goodFiles();
  const personaFiles = weekly.files.map((f) => ({ src: f.src, place: f.place, role: f.role }));
  files[2] = file('tests/eval/T-01/inputs/先週の売上.csv', fs.readFileSync(weekly.files.find((f) => f.role === 'input').src, 'utf8'));
  const persona = JSON.parse(JSON.stringify(weekly.persona));
  persona.knowledge = persona.knowledge.filter((k) => k.id === 'output');
  const grade = (stage2) => gradeOuter({ persona, personaFiles, items: s.items, toolEvents: s.toolEvents, state: allItemsState({ stage: 'generate' }), generatedCount: 1, generatedFiles: files, stages: { stage1: { ok: true }, stage2 }, inner: { withScore: 1 }, userSignals: [], model: 'claude-opus-5-5' });
  const env = grade({ ok: false, status: 'failed', counts: { total: 486, passed: 408, failed: 78 }, diskErrorsOnly: true });
  assert.equal(env.grades.some((g) => g.id === 'stage2'), false);
  assert.equal(env.notGraded.length, 1);
  assert.equal(env.notGraded[0].id, 'stage2');
  assert.equal(env.notGraded[0].environment, true);
  assert.match(env.notGraded[0].reason, /環境で止まった（ディスクがいっぱい）.*78 件.*ENOSPC か EIO/);
  assert.equal(env.verdict.ok, true);
  assert.equal(env.verdict.partial, true);
  assert.deepEqual(env.verdict.notGraded, ['stage2']);
  assert.equal(env.score, 1);
  assert.equal(env.exampleCandidate, false, '採点しなかった観点のある会話は、会話例にしない');
  // ほかの理由の不合格が混ざれば（印がなければ）、これまでどおり落ちる
  const real = grade({ ok: false, status: 'failed', counts: { failed: 79 } });
  assert.equal(real.grades.find((g) => g.id === 'stage2').ok, false);
  assert.equal(real.notGraded, undefined);
  assert.deepEqual(real.verdict.failed, ['stage2']);
});

test('testing.md 6.5 環境で止まった観点：1段目の不合格がすべてディスクの誤り、入口がディスクの誤りで落ちた、内側の EVAL がディスクの空きで始めなかった', () => {
  // 1段目だけ・両方
  assert.deepEqual(Object.keys(environmentNotGraded({ stage1: { ok: false, failures: [{ reason: 'OSError: [Errno 28] No space left on device' }], diskErrorsOnly: true }, stage2: { ok: true } })), ['stage1']);
  assert.match(environmentNotGraded({ stage1: { ok: false, counts: { failed: 2 }, diskErrorsOnly: true } }).stage1, /1段目の不合格 2 件/);
  // 入口（tests/run.py）がディスクの誤りで落ちた（印 diskError）なら 1・2段目の両方。道具が足りないときなど、印がなければ外さない
  const crashed = environmentNotGraded({ skipped: true, reason: 'tests/run.py の結果を読めない（終了コード 1）：OSError: [Errno 28] No space left on device', diskError: true });
  assert.deepEqual(Object.keys(crashed), ['stage1', 'stage2']);
  assert.match(crashed.stage1, /入口がディスクの誤りで落ちた/);
  assert.deepEqual(environmentNotGraded({ skipped: true, reason: '道具が足りなくて止まった：Node.js' }), {});
  assert.deepEqual(environmentNotGraded({ skipped: true, reason: 'x', stage2: { diskErrorsOnly: true } }), {});
  // 内側の EVAL：disk_low のときだけ
  assert.deepEqual(Object.keys(environmentNotGraded(null, { withScore: null, error: '足りない', code: 'disk_low' })), ['inner-deliverable']);
  assert.deepEqual(environmentNotGraded(null, { withScore: null, error: '課題がない', code: 'usage' }), {});
  assert.deepEqual(environmentNotGraded(null, null), {});
});

test('testing.md 6.5 環境の影響を受けた回：クリエイターのツールの結果にディスクの誤りが出たか、環境で止まった観点があれば、environment と partial を付け、会話例にしない', () => {
  const s = passingRun();
  const files = goodFiles();
  const personaFiles = weekly.files.map((f) => ({ src: f.src, place: f.place, role: f.role }));
  files[2] = file('tests/eval/T-01/inputs/先週の売上.csv', fs.readFileSync(weekly.files.find((f) => f.role === 'input').src, 'utf8'));
  const persona = JSON.parse(JSON.stringify(weekly.persona));
  persona.knowledge = persona.knowledge.filter((k) => k.id === 'output');
  const grade = ({ items = s.items, stages = { stage1: { ok: true }, stage2: { ok: true } }, inner = { withScore: 1 } } = {}) =>
    gradeOuter({ persona, personaFiles, items, toolEvents: s.toolEvents, state: allItemsState({ stage: 'generate' }), generatedCount: 1, generatedFiles: files, stages, inner, userSignals: [], model: 'claude-opus-5-5' });
  const base = grade();
  assert.equal(base.environment, undefined);
  assert.equal(base.verdict.partial, undefined);
  assert.equal(base.exampleCandidate, true);
  // クリエイターの Chromium を入れるコマンドの結果に ENOSPC が出た（外側の EVAL〔改善〕3回目の [539]）。観点はすべて採点し、合否も変えない
  const last = s.items.at(-1).seq;
  const items = [...s.items, { seq: last + 1, kind: 'tool.use', owner: 'main', name: 'Bash', input: { command: 'npx playwright install chromium' } }, { seq: last + 2, kind: 'tool.result', owner: 'main', isError: false, text: '[Error: ENOSPC: no space left on device, write]' }];
  const hit = grade({ items });
  assert.deepEqual(hit.environment, { notGraded: [], toolResults: [last + 2] });
  assert.deepEqual(hit.grades.map((g) => g.id), base.grades.map((g) => g.id));
  assert.equal(hit.verdict.ok, true);
  assert.equal(hit.verdict.partial, true);
  assert.equal(hit.verdict.environment, true);
  assert.equal(hit.verdict.notGraded, undefined);
  assert.equal(hit.exampleCandidate, false);
  // 内側の EVAL が disk_low で始めなかった：inner-deliverable を採点せず、環境の観点に残す
  const inner = grade({ inner: { withScore: null, error: 'ディスクの空きが足りないので始めません', code: 'disk_low' } });
  assert.equal(inner.grades.some((g) => g.id === 'inner-deliverable'), false);
  assert.deepEqual(inner.notGraded.map((g) => [g.id, g.environment]), [['inner-deliverable', true]]);
  assert.deepEqual(inner.environment, { notGraded: ['inner-deliverable'], toolResults: [] });
  assert.deepEqual([inner.verdict.partial, inner.verdict.notGraded, inner.verdict.environment], [true, ['inner-deliverable'], true]);
  // 1段目の不合格がすべてディスクの誤り：stage1 を採点しない
  const stage1 = grade({ stages: { stage1: { ok: false, counts: { failed: 1 }, diskErrorsOnly: true }, stage2: { ok: true } } });
  assert.deepEqual(stage1.notGraded.map((g) => g.id), ['stage1']);
  assert.equal(stage1.verdict.ok, true);
});

test('REQ-015 全体の採点：聞かれないと話すナレッジが組み込まれていなければ不合格（クリエイターが聞かなかったとき）', () => {
  const s = passingRun();
  const personaFiles = weekly.files.map((f) => ({ src: f.src, place: f.place, role: f.role }));
  const r = gradeOuter({ persona: weekly.persona, personaFiles, items: s.items, toolEvents: s.toolEvents, state: allItemsState({ stage: 'generate' }), generatedCount: 1, generatedFiles: goodFiles(), stages: { stage1: { ok: true }, stage2: { ok: true } }, inner: null, userSignals: [], model: 'claude-opus-5-5' });
  // ijou・headings は、会話に出ていないが、生成プラグインの本文にはある（偶然）。落ちるのは、入力のファイルがないことと、man-yen の例外など
  const trace = Object.fromEntries(r.trace.map((t) => [t.id, t]));
  assert.equal(trace.headings.asked, false);
  assert.equal(trace.headings.answered, false);
  assert.equal(trace.ijou.asked, false);
  assert.equal(r.grades.find((g) => g.id === 'input-files-in-repo').ok, false);
  assert.equal(r.verdict.ok, false);
  assert.ok(r.verdict.failed.includes('input-files-in-repo'));
});

test('REQ-015 全体の採点：生成プラグインが 2 つ見つかれば不合格。Without の腕は、ヒアリングの観点を採点しない', () => {
  const personaFiles = [];
  const persona = { ...weekly.persona, knowledge: [], files: [] };
  const r = gradeOuter({ persona, personaFiles, items: [], toolEvents: [], state: null, generatedCount: 2, generatedFiles: null, stages: null, inner: null, userSignals: [], model: 'claude-opus-5-5', arm: 'without' });
  assert.equal(r.grades.find((g) => g.id === 'one-plugin-generated').ok, false);
  assert.ok(!r.grades.some((g) => g.id === 'all-items-heard'));
  assert.ok(!r.grades.some((g) => g.id === 'no-generation-before-approval'));
  const control = gradeOuter({ persona, personaFiles, items: [], toolEvents: [], state: null, generatedCount: 1, generatedFiles: [], stages: { skipped: true, reason: 'x' }, inner: null, userSignals: [], model: 'claude-opus-5-5', arm: 'control' });
  assert.equal(control.grades.find((g) => g.id === 'all-items-heard').ok, false, '対照のクリエイターは、全項目を聞かないので、落ちる');
  assert.equal(control.grades.find((g) => g.id === 'stage1').ok, false);
});

test('REQ-015 ユーザー役の誤り：聞かれていないのに隠すべきナレッジを話した・指示の言葉を話した答えを、見つける', () => {
  const s = script();
  s.answer('ほかに伝えたいことはありますか？', '見出しは「■今週の売上」の2つです');
  s.answer('進め方は？', '答える条件に当てはまるので答えます。月曜に集計します');
  const persona = JSON.parse(JSON.stringify(weekly.persona));
  const r = gradeOuter({ persona, personaFiles: [], items: s.items, toolEvents: [], state: null, generatedCount: 0, generatedFiles: null, stages: null, inner: null, userSignals: [], model: 'claude-opus-5-5', arm: 'without' });
  assert.ok(r.faults.some((f) => f.kind === 'instruction-words' && f.answerIndex === 1), JSON.stringify(r.faults));
  assert.equal(r.exampleCandidate, false);
});

test('REQ-015 開発者が答えたとき（testing.md 6.7）：ナレッジの観点はなく、ユーザー役の誤り（指示の言葉）は見ず、会話例の候補にしない。ヒアリングの観点は同じに見る', () => {
  const s = passingRun();
  s.answer('ほかに伝えたいことはありますか？', '模擬ユーザーのつもりで、プロンプトを試しています', { via: 'text' });
  const persona = { id: 'human', title: '開発者が答える', experience: 'done', request: '作って', profile: '', files: [], knowledge: [], styles: { normal: { label: '開発者', instruction: '' } } };
  const args = { persona, personaFiles: [], items: s.items, toolEvents: s.toolEvents, state: allItemsState({ stage: 'generate' }), generatedCount: 1, generatedFiles: goodFiles(), stages: { stage1: { ok: true }, stage2: { ok: true } }, inner: null, userSignals: [], model: 'claude-opus-5-5' };
  const human = gradeOuter({ ...args, answerer: 'human' });
  assert.deepEqual(human.grades.map((g) => g.id), ['one-plugin-generated', 'stage1', 'stage2', 'screen-url-shown', 'all-items-heard', 'no-generation-before-approval']);
  assert.ok(human.grades.every((g) => g.ok), JSON.stringify(human.grades));
  assert.deepEqual(human.trace, []);
  assert.deepEqual(human.faults, []);
  assert.equal(human.verdict.ok, true);
  assert.equal(human.exampleCandidate, false);
  // 同じ会話でも、ユーザー役の AI の答えなら、指示の言葉を誤りとして見つける（既定は user-role）
  const role = gradeOuter(args);
  assert.ok(role.faults.some((f) => f.kind === 'instruction-words'), JSON.stringify(role.faults));
  assert.equal(role.exampleCandidate, false);
  assert.deepEqual(role.grades, human.grades);
});

// ---- 記録する数（testing.md 6.5。X2-08） ----------------------------------------------------------------

/** 記録のツールの呼び出し 1 回（結果つき）。失敗の結果は isError: true */
function toolCalls(list) {
  let seq = 0;
  let callId = 0;
  const events = [];
  for (const [tool, args, isError, result] of list) {
    callId += 1;
    events.push({ seq: (seq += 1), type: 'tool.call', callId, tool, args });
    events.push({ seq: (seq += 1), type: 'tool.result', callId, tool, isError, result: result ?? (isError ? '断りの理由' : '記録しました') });
  }
  return events;
}

test('REQ-015 記録する数：問いの数は、質問のツールの問いと文章の問いの合計。1 回の呼び出しの問いの欄の数の最大と、2 つ以上の欄を置いた回数も数える', () => {
  const q = (group, groupSize, n) => ({ seq: n, kind: 'creator.question', header: '', question: `問い${n}`, options: [], group, groupSize });
  const items = [q(1, 1, 1), q(2, 2, 2), q(2, 2, 3), q(3, 3, 4), q(3, 3, 5), q(3, 3, 6), { seq: 7, kind: 'creator.question-text', text: '文章の問い' }, { seq: 8, kind: 'creator.question-text', text: 'もう 1 つ' }];
  const c = countRecorded({ items, toolEvents: [], state: null });
  assert.deepEqual(c.questions, { total: 8, askTool: 6, text: 2 });
  assert.deepEqual(c.askToolCalls, { calls: 3, maxQuestionsPerCall: 3, callsWithMultiple: 2 });
  // 1 回に 1 つだけなら、2 つ以上の欄を置いた呼び出しは 0 回
  const single = countRecorded({ items: [q(1, 1, 1), q(2, 1, 2)], toolEvents: [], state: null });
  assert.deepEqual(single.askToolCalls, { calls: 2, maxQuestionsPerCall: 1, callsWithMultiple: 0 });
  // group のない古い記録は、問い 1 つごとを 1 回の呼び出しと数える
  const old = countRecorded({ items: [{ seq: 1, kind: 'creator.question', question: 'a' }, { seq: 2, kind: 'creator.question', question: 'b' }], toolEvents: [], state: null });
  assert.deepEqual(old.askToolCalls, { calls: 2, maxQuestionsPerCall: 1, callsWithMultiple: 0 });
  assert.deepEqual(countRecorded({ items: [], toolEvents: [], state: null }).askToolCalls, { calls: 0, maxQuestionsPerCall: 0, callsWithMultiple: 0 });
});

test('REQ-015 記録する数：保留の項目と AI の判断のナレッジの数（外したナレッジは数えない）', () => {
  const state = {
    items: { purpose: { status: 'asked' }, output: { status: 'pending' }, rules: { status: 'pending' }, tools: { status: 'none' } },
    knowledge: [
      { id: 'K-01', source: 'ai_decision', status: 'decided' },
      { id: 'K-02', source: 'ai_decision', status: 'candidate' },
      { id: 'K-03', source: 'ai_decision', status: 'dropped' },
      { id: 'K-04', source: 'answer', status: 'decided' },
    ],
  };
  const c = countRecorded({ items: [], toolEvents: [], state });
  assert.deepEqual(c.pending, { count: 2, items: ['成果物', '決まった書き方やルール'] });
  assert.deepEqual(c.aiDecisions, { count: 2 });
  assert.deepEqual(countRecorded({ items: [], toolEvents: [], state: null }).pending, { count: 0, items: [] });
});

test('REQ-015 記録する数：記録のツールが断った回数（失敗の結果）と、その後に同じツールが成功した（直した）回数', () => {
  const toolEvents = toolCalls([
    ['progress', { stage: '始まり' }, false],
    ['progress', { items: [] }, true, '抜き書き（quote）を添えてください'],
    ['progress', { items: [] }, false],
    ['record', { knowledge: [] }, true, '種類の名前が違います'],
    ['confirm', {}, true, '未着手の項目が残っています'],
    ['confirm', {}, true, 'もう一度断る'],
    ['confirm', {}, false],
    ['state', {}, true, '状態取得ツールの失敗は、記録のツールの断りに数えない'],
  ]);
  const r = countRecorded({ items: [], toolEvents, state: null }).recordRefusals;
  assert.deepEqual(r.byTool.progress, { calls: 3, refused: 1, fixed: 1, unfixed: 0 });
  assert.deepEqual(r.byTool.record, { calls: 1, refused: 1, fixed: 0, unfixed: 1 });
  assert.deepEqual(r.byTool.confirm, { calls: 3, refused: 2, fixed: 2, unfixed: 0 });
  assert.equal(r.total, 4);
  assert.equal(r.fixed, 3);
  assert.equal(r.unfixed, 1);
  assert.equal(r.samples.length, 4);
  assert.deepEqual(r.samples[0], { tool: 'progress', seq: 3, reason: '抜き書き（quote）を添えてください' });
  // 断りの前の成功は、直しに数えない（断りの後に、同じツールが成功したときだけ）
  const before = countRecorded({ items: [], toolEvents: toolCalls([['progress', {}, false], ['progress', {}, true, '断り']]), state: null }).recordRefusals;
  assert.deepEqual(before.byTool.progress, { calls: 2, refused: 1, fixed: 0, unfixed: 1 });
  // 断りの文は、長ければ 160 文字で切る。見本は 5 件まで
  const many = toolCalls(Array.from({ length: 9 }, () => ['progress', {}, true, 'あ'.repeat(300)]));
  const m = countRecorded({ items: [], toolEvents: many, state: null }).recordRefusals;
  assert.equal(m.total, 9);
  assert.equal(m.samples.length, 5);
  assert.equal(m.samples[0].reason.length, 160);
});

test('REQ-015 記録する数は、採点の合否に入らない：数が多くても grades・score・verdict は変わらない', () => {
  const s = passingRun();
  const personaFiles = weekly.files.map((f) => ({ src: f.src, place: f.place, role: f.role }));
  const persona = JSON.parse(JSON.stringify(weekly.persona));
  persona.knowledge = persona.knowledge.filter((k) => k.id === 'output');
  const files = goodFiles();
  files[2] = file('tests/eval/T-01/inputs/先週の売上.csv', fs.readFileSync(weekly.files.find((f) => f.role === 'input').src, 'utf8'));
  const args = { persona, personaFiles, items: s.items, toolEvents: s.toolEvents, state: allItemsState({ stage: 'generate' }), generatedCount: 1, generatedFiles: files, stages: { stage1: { ok: true }, stage2: { ok: true } }, inner: null, userSignals: [], model: 'claude-opus-5-5' };
  const base = gradeOuter(args);
  const extra = toolCalls(Array.from({ length: 5 }, () => ['record', {}, true])).map((e, i) => ({ ...e, seq: 1000 + i, callId: 100 + e.callId }));
  const noisy = gradeOuter({ ...args, toolEvents: [...s.toolEvents, ...extra] });
  assert.equal(noisy.counts.recordRefusals.total, 5);
  assert.deepEqual(noisy.grades, base.grades);
  assert.equal(noisy.score, base.score);
  assert.deepEqual(noisy.verdict, base.verdict);
  assert.ok(base.counts.questions.total >= 0 && base.counts.recordRefusals.total === 0);
});

test('REQ-015 記録する数：英語の覚え書きのようなチャットの文（日本語の字を含まない文、内部の番号だけの文）を数える。合否には入れない', () => {
  const items = [
    { seq: 1, kind: 'creator.text', text: 'Need the carried knowledge list from state.json.' },
    { seq: 2, kind: 'creator.text', text: '画面の URL は http://127.0.0.1:1/?k=x です。' },
    { seq: 3, kind: 'creator.text', text: 'K-25 next.' },
    { seq: 4, kind: 'creator.text', text: '   ' },
    { seq: 5, kind: 'creator.question', question: 'Which file?' },
    { seq: 6, kind: 'creator.text', text: 'カタカナだけ：OK' },
    { seq: 7, kind: 'user.answer', answer: 'OK' },
  ];
  const c = countRecorded({ items, toolEvents: [], state: null }).nonJapaneseTexts;
  assert.equal(c.count, 2, '質問・ユーザーの答え・空の文は数えない');
  assert.deepEqual(c.samples, [{ seq: 1, text: 'Need the carried knowledge list from state.json.' }, { seq: 3, text: 'K-25 next.' }]);
  const many = Array.from({ length: 8 }, (_, i) => ({ seq: i + 1, kind: 'creator.text', text: `Note ${i} ${'x'.repeat(100)}` }));
  const m = countRecorded({ items: many, toolEvents: [], state: null }).nonJapaneseTexts;
  assert.equal(m.count, 8);
  assert.equal(m.samples.length, 5);
  assert.equal(m.samples[0].text.length, 80);
  assert.deepEqual(countRecorded({ items: [], toolEvents: [], state: null }).nonJapaneseTexts, { count: 0, samples: [] });
});

test('REQ-015 記録する数：日本語が混ざった英語の覚え書きも数える。URL だけ・コードだけの文と、日本語の文の中のファイル名の並びは数えない', () => {
  const counted = [
    'Next: いつもと違うとき, including K-25 in different form.', // 英単語が3つ以上続く（外側の EVAL〔改善〕1回目の [345]）
    'Ask "ほかにありますか" first.', // 引用の中の日本語を除くと英語だけ（同じく [427]）
    '直しました。\nNow run tests.', // 日本語の文の後の英語の行
    'Passed. Commit.',
  ];
  const skipped = [
    'http://127.0.0.1:41234/?k=abcDEF123_-xyz',
    '```\nnpm test --prefix tests\n```',
    '`git -C market log --oneline`',
    '直すファイル：main.c, sensor_avg.c, sensor_avg.h, dbg_log.h, Makefile.target を見ます。',
    'Copilot CLI を起動し直してください。戻すときは `git revert HEAD` です。',
    '画面：http://127.0.0.1:1/?k=x を開いてください。',
    '0.2.0',
    // かぎ括弧の中に引いた機器の出力は、英単語の続きに数えない（外側の EVAL〔改善〕2回目の [524]）
    '初めて入れたアプリなら「not installed (pending: reboot to activate)」と出ます。',
    'ボードは "bad magic: not a kximg file" と返します。',
  ];
  const items = [...counted, ...skipped].map((text, n) => ({ seq: n + 1, kind: 'creator.text', text }));
  const c = countRecorded({ items, toolEvents: [], state: null }).nonJapaneseTexts;
  assert.equal(c.count, counted.length, JSON.stringify(c.samples));
  assert.deepEqual(c.samples.map((x) => x.seq), counted.map((_, n) => n + 1));
});

test('REQ-015 記録する数：最初の問いより前のチャットの文に、これからの流れ（矢印2つ以上か、番号付きの行3つ以上）を示したか。合否には入れない', () => {
  const FLOW = 'これから、次の順に進めます。今使っているスキルやファイルを教えてもらう → プラグインを読み、引き継ぐことと変えるところを確かめる → 直す前に、まとめを確かめてもらう。';
  const q = (seq) => ({ seq, kind: 'creator.question', header: 'ファイル', question: 'どこにありますか？', options: [] });
  const t = (seq, text) => ({ seq, kind: 'creator.text', text });
  const flowOf = (items) => countRecorded({ items, toolEvents: [], state: null }).flowShown;
  // URL と同じ文でも、別の文でもよい
  assert.deepEqual(flowOf([t(1, `plugin-creator の画面: http://127.0.0.1:1/?k=x\n\n${FLOW}`), q(2)]), { shown: true, seq: 1 });
  assert.deepEqual(flowOf([t(1, 'plugin-creator の画面: http://127.0.0.1:1/?k=x'), t(2, FLOW), q(3)]), { shown: true, seq: 2 });
  assert.deepEqual(flowOf([t(1, 'これから、次の順にお話を聞きます。\n1. ファイルを教えてもらう\n2. 最近やった1回の流れを聞く\n3. まとめを確かめてもらう'), q(2)]), { shown: true, seq: 1 });
  // 言い方は見ない（例の書き出し「これから」と違う言い方の流れも数える）
  assert.deepEqual(flowOf([t(1, '次の順に進めます。A → B → C'), q(2)]), { shown: true, seq: 1 });
  assert.deepEqual(flowOf([t(1, '流れ：\n1) ファイル\n2) 決まりの確かめ\n3) 直す前の確認'), q(2)]), { shown: true, seq: 1 });
  // URL だけ（外側の EVAL〔改善〕2回目の [11]）、最初の問いの後、問いの中、矢印が1つ、番号付きの行が2つの文は数えない
  assert.deepEqual(flowOf([t(1, 'plugin-creator の画面: http://127.0.0.1:1/?k=x'), q(2), t(3, FLOW)]), { shown: false, seq: null });
  assert.deepEqual(flowOf([{ ...q(1), question: FLOW }]), { shown: false, seq: null });
  assert.deepEqual(flowOf([t(1, 'これから、今のプラグインを読んで → 変えるところだけをお聞きします。'), q(2)]), { shown: false, seq: null });
  assert.deepEqual(flowOf([t(1, 'これから、次の順に進めます。\n1. ファイルを教えてもらう\n2. まとめを確かめてもらう'), q(2)]), { shown: false, seq: null });
  // 文章の問いも、最初の問いに数える
  assert.deepEqual(flowOf([{ seq: 1, kind: 'creator.question-text', text: 'どこにありますか？' }, t(2, FLOW)]), { shown: false, seq: null });
  assert.deepEqual(flowOf([]), { shown: false, seq: null });
});

test('REQ-043 画面の URL：画面を開くツールの返り値の URL が、最初の問いより前のチャットの文にあれば合格', () => {
  const URL = 'http://127.0.0.1:37889/?k=CYfGZLjd7c7BOkfTZOh38tH9n5ZjIdl_';
  const opened = (seq, isError = false, result = `plugin-creator の画面の用意ができました。次の URL をブラウザーで開いてください：${URL}`) => [
    { seq, type: 'tool.call', callId: seq, tool: 'open', args: {} },
    { seq: seq + 0.5, type: 'tool.result', callId: seq, tool: 'open', isError, result },
  ];
  const question = (seq) => ({ seq, kind: 'creator.question', header: 'ファイル', question: 'ファイルはどこにありますか？', options: [] });
  const ok = gradeScreenUrlShown({ items: [{ seq: 1, kind: 'user.request', text: '頼み' }, { seq: 3, kind: 'creator.text', text: `plugin-creator の画面：${URL}。決まったことはここで見られます。` }, question(4)], toolEvents: opened(2) });
  assert.equal(ok.ok, true, ok.detail);
  // 文章の問いが最初の問いでも、その前の文で見る
  assert.equal(gradeScreenUrlShown({ items: [{ seq: 3, kind: 'creator.text', text: `画面：${URL}` }, { seq: 4, kind: 'creator.question-text', text: 'ファイルはどこですか？' }], toolEvents: opened(2) }).ok, true);
  // URL がツールの返り値にしかない（チャットに書いていない）。外側の EVAL（改善）1回目と同じ
  const hidden = gradeScreenUrlShown({ items: [{ seq: 3, kind: 'creator.text', text: 'Need the carried knowledge list.' }, question(4), { seq: 6, kind: 'creator.text', text: `画面：${URL}` }], toolEvents: opened(2) });
  assert.equal(hidden.ok, false);
  assert.match(hidden.detail, /ツールの返り値はユーザーに見えない/);
  // 合言葉を落とした URL は、開けないので数えない
  assert.equal(gradeScreenUrlShown({ items: [{ seq: 3, kind: 'creator.text', text: '画面：http://127.0.0.1:37889/' }, question(4)], toolEvents: opened(2) }).ok, false);
  // 画面を開くツールが、最初の問いより後・失敗だけ・呼んでいない
  assert.match(gradeScreenUrlShown({ items: [question(1), { seq: 4, kind: 'creator.text', text: URL }], toolEvents: opened(2) }).detail, /最初の問いより前に、画面を開くツール/);
  assert.equal(gradeScreenUrlShown({ items: [{ seq: 3, kind: 'creator.text', text: URL }, question(4)], toolEvents: opened(2, true, 'open に失敗しました') }).ok, false);
  assert.equal(gradeScreenUrlShown({ items: [{ seq: 3, kind: 'creator.text', text: URL }, question(4)], toolEvents: [] }).ok, false);
  // 失敗の後に成功した呼び出しの URL で見る。返り値に URL がなければ落ちる
  assert.equal(gradeScreenUrlShown({ items: [{ seq: 5, kind: 'creator.text', text: `画面：${URL}` }, question(6)], toolEvents: [...opened(2, true, 'だめ'), ...opened(3)] }).ok, true);
  assert.match(gradeScreenUrlShown({ items: [question(6)], toolEvents: opened(2, false, '用意ができました') }).detail, /URL がない/);
});

test('REQ-043 作る流れの採点（gradeOuter）も、腕 with では画面の URL を見る。示さないと、思考力の高いモデルの合格と会話例の候補が落ちる。対照とプラグインなしの腕には入れない', () => {
  const personaFiles = weekly.files.map((f) => ({ src: f.src, place: f.place, role: f.role }));
  const persona = JSON.parse(JSON.stringify(weekly.persona));
  persona.knowledge = persona.knowledge.filter((k) => k.id === 'output');
  const files = goodFiles();
  files[2] = file('tests/eval/T-01/inputs/先週の売上.csv', fs.readFileSync(weekly.files.find((f) => f.role === 'input').src, 'utf8'));
  const run = (s, o = {}) => gradeOuter({ persona, personaFiles, items: s.items, toolEvents: s.toolEvents, state: allItemsState({ stage: 'generate' }), generatedCount: 1, generatedFiles: files, stages: { stage1: { ok: true }, stage2: { ok: true } }, inner: null, userSignals: [], model: 'claude-opus-5-5', ...o });
  const ok = run(passingRun());
  assert.deepEqual(ok.grades.filter((g) => g.id === 'screen-url-shown').map((g) => [g.ok, g.req]), [[true, 'REQ-043']]);
  // URL を、画面を開くツールの返り値にしか出していない（チャットに書いていない）
  const hidden = passingRun();
  hidden.items.splice(hidden.items.findIndex((i) => i.kind === 'creator.text'), 1);
  const bad = run(hidden);
  assert.deepEqual(bad.verdict.failed, ['screen-url-shown']);
  assert.equal(bad.exampleCandidate, false);
  // Haiku のクリエイターの合格は、2 点のまま
  assert.equal(run(hidden, { model: 'claude-haiku-5-5' }).verdict.ok, true);
  // 画面を開くツールは腕 with にだけあるので、対照とプラグインなしの腕には入れない
  for (const arm of ['control', 'without']) assert.ok(!run(hidden, { arm }).grades.some((g) => g.id === 'screen-url-shown'), arm);
});

// ---- モデル（REQ-045・REQ-046。X2-09 の(1)） ----------------------------------------------------------------

test('REQ-045 モデルの ID：[1m] のような末尾の印と日付の末尾をそろえて比べる', () => {
  assert.equal(normalizeModelId('claude-opus-5-5[1m]'), 'claude-opus-5-5');
  assert.equal(normalizeModelId('claude-haiku-5-5-20261001'), 'claude-haiku-5-5');
  assert.equal(normalizeModelId('claude-sonnet-5-5'), 'claude-sonnet-5-5');
  assert.equal(normalizeModelId(undefined), '');
});

test('REQ-045 メインのエージェントのメッセージのモデルがすべて指定のモデルなら合格。ほかのモデルが混ざれば不合格', () => {
  const use = (main) => ({ requested: 'claude-opus-5-5', main, subagents: [], lowCost: 'claude-haiku-5-5' });
  const ok = gradeModels({ use: use(['claude-opus-5-5']), generatedCount: 0 });
  assert.deepEqual(ok.map((g) => [g.id, g.ok, g.req]), [['main-model', true, 'REQ-045']]);
  assert.equal(gradeModels({ use: use(['claude-opus-5-5[1m]']), generatedCount: 0 })[0].ok, true);
  const mixed = gradeModels({ use: use(['claude-opus-5-5', 'claude-sonnet-5-5']), generatedCount: 0 })[0];
  assert.equal(mixed.ok, false);
  assert.match(mixed.detail, /claude-sonnet-5-5 でも動いた/);
  const none = gradeModels({ use: use([]), generatedCount: 0 })[0];
  assert.equal(none.ok, false);
  assert.match(none.detail, /モデルの記録がない/);
  // 選ぶモデルを変えて始めると、変えたモデルで対話が行われる
  const haiku = gradeModels({ use: { requested: 'claude-haiku-5-5', main: ['claude-haiku-5-5'], subagents: [], lowCost: null }, generatedCount: 0 })[0];
  assert.equal(haiku.ok, true);
});

test('REQ-046 作業エージェントがすべて費用の低いモデルで動いたら合格。生成プラグインができたのに動かなければ不合格。できていなければ採点しない', () => {
  const base = { requested: 'claude-opus-5-5', main: ['claude-opus-5-5'], lowCost: 'claude-haiku-5-5' };
  const worker = (models, type = 'plugin-creator:worker') => ({ type, models });
  const find = (g, id) => g.find((x) => x.id === id);
  const ok = gradeModels({ use: { ...base, subagents: [worker(['claude-haiku-5-5']), worker(['claude-haiku-5-5']), { type: 'plugin-creator:reader', models: ['claude-opus-5-5'] }] }, generatedCount: 1 });
  assert.equal(find(ok, 'worker-model').ok, true);
  assert.match(find(ok, 'worker-model').detail, /作業エージェント 2 回/);
  assert.equal(find(ok, 'worker-model').req, 'REQ-046');
  // 作業エージェントの 1 つが高いモデルで動いた
  const wrong = gradeModels({ use: { ...base, subagents: [worker(['claude-haiku-5-5']), worker(['claude-opus-5-5'])] }, generatedCount: 1 });
  assert.equal(find(wrong, 'worker-model').ok, false);
  assert.match(find(wrong, 'worker-model').detail, /claude-opus-5-5 でも動いた/);
  // 名前つきの作業エージェント（worker-<名前>）も作業エージェント。読み取り役は数えない
  const named = gradeModels({ use: { ...base, subagents: [worker(['claude-haiku-5-5'], 'plugin-creator:worker-report'), { type: 'plugin-creator:reader', models: ['claude-opus-5-5'] }] }, generatedCount: 1 });
  assert.equal(find(named, 'worker-model').ok, true);
  // 動かなかった（メインのエージェントが書いた見込み）
  const none = gradeModels({ use: { ...base, subagents: [{ type: 'plugin-creator:reader', models: ['claude-opus-5-5'] }] }, generatedCount: 1 });
  assert.equal(find(none, 'worker-model').ok, false);
  assert.match(find(none, 'worker-model').detail, /作業エージェントが動かなかった/);
  // モデルの記録がない
  assert.equal(find(gradeModels({ use: { ...base, subagents: [worker([])] }, generatedCount: 1 }), 'worker-model').ok, false);
  // 変換後の定義に費用の低いモデルの指定がない
  assert.match(find(gradeModels({ use: { ...base, lowCost: null, subagents: [worker(['claude-haiku-5-5'])] }, generatedCount: 1 }), 'worker-model').detail, /指定がない/);
  // 生成プラグインができていなければ、作業エージェントの観点はない
  assert.equal(find(gradeModels({ use: { ...base, subagents: [] }, generatedCount: 0 }), 'worker-model'), undefined);
  // 主のモデルを変えても（Haiku で始めても）、作業エージェントは費用の低いモデル
  const haikuMain = gradeModels({ use: { requested: 'claude-haiku-5-5', main: ['claude-haiku-5-5'], lowCost: 'claude-haiku-5-5', subagents: [worker(['claude-haiku-5-5'])] }, generatedCount: 1 });
  assert.deepEqual(haikuMain.map((g) => g.ok), [true, true]);
});

test('REQ-045 REQ-046 全体の採点：腕 with にだけ、モデルの観点が入る。落ちると、思考力の高いモデルの合格と会話例の候補が落ちる。Haiku の合格は変わらない', () => {
  const s = passingRun();
  const personaFiles = weekly.files.map((f) => ({ src: f.src, place: f.place, role: f.role }));
  const persona = JSON.parse(JSON.stringify(weekly.persona));
  persona.knowledge = persona.knowledge.filter((k) => k.id === 'output');
  const files = goodFiles();
  files[2] = file('tests/eval/T-01/inputs/先週の売上.csv', fs.readFileSync(weekly.files.find((f) => f.role === 'input').src, 'utf8'));
  const run = (modelUse, o = {}) => gradeOuter({ persona, personaFiles, items: s.items, toolEvents: s.toolEvents, state: allItemsState({ stage: 'generate' }), generatedCount: 1, generatedFiles: files, stages: { stage1: { ok: true }, stage2: { ok: true } }, inner: null, userSignals: [], model: 'claude-opus-5-5', modelUse, ...o });
  const good = { requested: 'claude-opus-5-5', main: ['claude-opus-5-5'], lowCost: 'claude-haiku-5-5', subagents: [{ type: 'plugin-creator:worker', models: ['claude-haiku-5-5'] }] };
  const ok = run(good);
  assert.deepEqual(ok.grades.filter((g) => g.req === 'REQ-045' || g.req === 'REQ-046').map((g) => [g.id, g.ok]), [['main-model', true], ['worker-model', true]]);
  assert.equal(ok.verdict.ok, true);
  assert.equal(ok.exampleCandidate, true);
  // 作業エージェントが高いモデルで動いた
  const bad = run({ ...good, subagents: [{ type: 'plugin-creator:worker', models: ['claude-opus-5-5'] }] });
  assert.deepEqual(bad.verdict.failed, ['worker-model']);
  assert.equal(bad.verdict.ok, false);
  assert.equal(bad.exampleCandidate, false);
  // Haiku のクリエイターの合格は、2 点のまま（testing.md 6.5 の表）。モデルの観点が落ちても合否には効かない
  const haiku = run({ ...good, requested: 'claude-haiku-5-5', main: ['claude-haiku-5-5'], subagents: [] }, { model: 'claude-haiku-5-5' });
  assert.deepEqual(haiku.verdict.required, HAIKU_REQUIRED);
  assert.equal(haiku.verdict.ok, true);
  assert.equal(haiku.grades.find((g) => g.id === 'worker-model').ok, false);
  // 対照とプラグインなしの腕、modelUse を渡さないときは、モデルの観点がない
  for (const o of [{ arm: 'control' }, { arm: 'without' }]) assert.ok(!run(good, o).grades.some((g) => g.id === 'main-model' || g.id === 'worker-model'));
  assert.ok(!run(null).grades.some((g) => g.id === 'main-model'));
});
