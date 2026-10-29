// 段階、項目、状態、ナレッジの種類・出どころの名前と、内部の記号の表。ここに1か所だけ持つ（BLUEPRINT 4.4）。
// 設計書：docs/design/hearing.md 3.1（段階）、7.2（項目と状態）、7.3（ナレッジの欄）。
//
// - ユーザーとモデルに見える名前（ツールの引数と返り値、画面）は、日本語の名前。
// - 記録（state.json）に書くのは、内部の記号（英語）。state.json を読む組み立てのスクリプトは、この表の記号を使う。
// - 内部の記号を、ツールの引数にも返り値にも出さない。

// 表の1行：[記号, 日本語の名前]
const table = (rows) => Object.freeze(rows.map(([key, name]) => Object.freeze({ key, name })));

// 段階（hearing.md 3.1。BLUEPRINT 7章）。並びがヒアリングの流れの順
export const STAGES = table([
  ['start', '始まり'],
  ['receive', '実物を受け取る'],
  ['read', '読む'],
  ['rebuild_check', 'できていたことの確認'],
  ['last_case', '前回の1回'],
  ['rule_check', '決まりの確かめ'],
  ['item_check', '項目の点検'],
  ['assets', '資産と公開のプラグイン'],
  ['screen', '画面'],
  ['confirm', '生成前の確認'],
  ['generate', '生成'],
]);

// 項目（hearing.md 7.2。BLUEPRINT 7章）
// group：main10＝仕様 REQ-015 の10項目（ナレッジの項目になれる）、その他＝それ以外
export const ITEMS = Object.freeze([
  Object.freeze({ key: 'purpose', name: '作業の目的', group: 'main10' }),
  Object.freeze({ key: 'trigger', name: '頼む場面と言い方', group: 'main10' }),
  Object.freeze({ key: 'input', name: '受け取るもの', group: 'main10' }),
  Object.freeze({ key: 'procedure', name: '進め方', group: 'main10' }),
  Object.freeze({ key: 'output', name: '成果物', group: 'main10' }),
  Object.freeze({ key: 'criteria', name: '合否の決め方', group: 'main10' }),
  Object.freeze({ key: 'rules', name: '決まった書き方やルール', group: 'main10' }),
  Object.freeze({ key: 'must_not_break', name: '守らないと困ること', group: 'main10' }),
  Object.freeze({ key: 'tools', name: '使う道具と環境', group: 'main10' }),
  Object.freeze({ key: 'exceptions', name: 'いつもと違うとき', group: 'main10' }),
  Object.freeze({ key: 'last_case', name: '前回の1回', group: 'other' }),
  // 候補の確かめ：状態はエクステンションが計算する。ツールでは変えられない
  Object.freeze({ key: 'candidate_check', name: '候補の確かめ', group: 'other', computed: true }),
  // draftable：今のプラグインを直すときに、状態「聞かずに案で示す」にできる項目（REQ-056、REQ-057）
  Object.freeze({ key: 'assets', name: '資産', group: 'other', draftable: true }),
  Object.freeze({ key: 'oss', name: '標準機能と公開のプラグイン', group: 'other', draftable: true }),
  Object.freeze({ key: 'settings', name: '開始前に設定したいこと', group: 'other', draftable: true }),
  Object.freeze({ key: 'running_view', name: '実行中に見たいこと', group: 'other', draftable: true }),
  Object.freeze({ key: 'result_view', name: '終わった後に見たい結果と見せ方', group: 'other', draftable: true }),
  // 作り直しのときだけ
  Object.freeze({ key: 'rebuild_check', name: 'できていたことの確認', group: 'other', rebuildOnly: true }),
]);

// 項目の状態（hearing.md 7.2）
// unchanged：今のプラグインを直すときだけ。変えるところに関わらないので聞かない項目（REQ-056。BLUEPRINT 4.1）
// drafted：今のプラグインを直すときだけ。聞かずに、案を作るか調べた結果を、直す前の確認で示す項目（REQ-056、REQ-057）。済んだ項目に数える
export const ITEM_STATUSES = table([
  ['todo', '未着手'],
  ['asked', '聞いた'],
  ['none', '決まりなし'],
  ['pending', '保留'],
  ['unchanged', '変えないので聞かない'],
  ['drafted', '聞かずに案で示す'],
]);

// ナレッジの種類（hearing.md 7.3。記号は tests/knowledge.json の kind と同じ）
export const KNOWLEDGE_KINDS = table([
  ['criterion', '合否の決め方'],
  ['other', 'それ以外'],
]);

// ナレッジの状態（hearing.md 7.3）
export const KNOWLEDGE_STATUSES = table([
  ['candidate', '候補'],
  ['decided', '決まった'],
  ['dropped', '外した'],
]);

// ナレッジの出どころ（hearing.md 7.3）
export const KNOWLEDGE_SOURCES = table([
  ['answer', 'ヒアリングの答え'],
  ['volunteered', 'ユーザーが自分から話した'],
  ['added_at_confirmation', '生成前の確認で足した'],
  ['file', 'ファイルから読んで確かめた'],
  ['existing_plugin', '既存のプラグインから読んで確かめた'],
  ['ai_decision', 'AI の判断（ユーザーが任せた）'],
]);

// 資産の状態、標準機能と公開のプラグインの選んだ結果
export const ASSET_STATUSES = table([
  ['candidate', '候補'],
  ['reuse', '流用する'],
  ['skip', '流用しない'],
]);

export const OSS_KINDS = table([
  ['builtin', '標準機能'],
  ['public_plugin', '公開のプラグイン'],
]);

export const OSS_CHOICES = table([
  ['use', '使う'],
  ['skip', '使わない'],
]);

// ---- 引く関数 -------------------------------------------------------------------------

function indexOf(rows) {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const byName = new Map(rows.map((r) => [r.name, r]));
  return {
    rows,
    names: rows.map((r) => r.name),
    keys: rows.map((r) => r.key),
    byKey,
    byName,
    // 日本語の名前 → 記号。なければ null
    keyOf: (name) => byName.get(name)?.key ?? null,
    // 記号 → 日本語の名前。なければ記号をそのまま返す（画面を壊さないため）
    nameOf: (key) => byKey.get(key)?.name ?? String(key),
  };
}

export const stageIndex = indexOf(STAGES);
export const itemIndex = indexOf(ITEMS);
export const itemStatusIndex = indexOf(ITEM_STATUSES);
export const kindIndex = indexOf(KNOWLEDGE_KINDS);
export const knowledgeStatusIndex = indexOf(KNOWLEDGE_STATUSES);
export const sourceIndex = indexOf(KNOWLEDGE_SOURCES);
export const assetStatusIndex = indexOf(ASSET_STATUSES);
export const ossKindIndex = indexOf(OSS_KINDS);
export const ossChoiceIndex = indexOf(OSS_CHOICES);

// ---- ユーザーに見せるときの言葉 -----------------------------------------------------------------
// 画面とツールの返り値の文は、references/words.md の表の「ユーザーに話す言葉」で書く（ユーザーの答え22）。
// ただし、段階・項目・状態・種類・出どころの名前は、ツールの引数の値なので、そのまま使う（BLUEPRINT 7章）。
// 引数の値のうち、表の左の言葉を含むものだけは、画面と返り値に出すときに、次の言葉にする。

/** ユーザーに見せる確認の呼び名。今のプラグインを直すときは「直す前の確認」、作るときは「作る前の確認」 */
export const confirmWordFor = (isChange) => (isChange ? '直す前の確認' : '作る前の確認');

const SOURCE_DISPLAY = { answer: 'お話を聞いた答え' };

/** ナレッジの出どころを、ユーザーに見せる言葉にする。確認で足したものは、確認の呼び名を、作るときと直すときで変える */
export const sourceDisplay = (key, isChange = false) =>
  key === 'added_at_confirmation' ? `${confirmWordFor(isChange)}で足した` : SOURCE_DISPLAY[key] ?? sourceIndex.nameOf(key);

/** ナレッジの状態を、ユーザーに見せる言葉にする（候補 → 確かめたいこと） */
export const knowledgeStatusDisplay = (key) => (key === 'candidate' ? '確かめたいこと' : knowledgeStatusIndex.nameOf(key));

/** 仕様 REQ-015 の10項目（ナレッジの項目になれるもの） */
export const MAIN_ITEMS = Object.freeze(ITEMS.filter((i) => i.group === 'main10'));

/** 状態「聞かずに案で示す」にできる項目（資産、標準機能と公開のプラグイン、画面の3つ） */
export const DRAFTABLE_ITEMS = Object.freeze(ITEMS.filter((i) => i.draftable));

/** 日本語の名前を、「、」でつないだ文にする（誤りのときに使える値を示すため） */
export const listNames = (rows) => rows.map((r) => r.name).join('、');

/** 段階の並びの番号（前後の比べ合いに使う） */
export const stageOrder = (key) => STAGES.findIndex((s) => s.key === key);
