// ユーザーに話す言葉の確かめの道具（skills/make-plugin/references/words.md の表。ユーザーの答え22）。
// 表の左の言葉が、ツールの返り値と断る文と画面の文に出ていないことを確かめるときに使う。
//
// ただし、段階・項目・状態・種類・出どころの名前は、ツールの引数の値（BLUEPRINT 7章）なので、そのまま出てよい。
// 引数の値のうち、表の左の言葉を含むもの（段階「生成前の確認」、「項目の点検」、項目「候補の確かめ」、状態「候補」）は、
// 引数の値として出ている場所（「」で括った名前、「使える名前：」の一覧、「段階：」のあと、その名前そのもの）だけ見逃す。
// 「候補」「生成前の確認」などの言葉そのものを、どこでも見逃すことはしない（見逃すと、言い換え忘れに気づけない）。

import {
  ASSET_STATUSES,
  ITEM_STATUSES,
  ITEMS,
  KNOWLEDGE_KINDS,
  KNOWLEDGE_SOURCES,
  KNOWLEDGE_STATUSES,
  OSS_CHOICES,
  OSS_KINDS,
  STAGES,
} from '../../../com.github.copilot/extensions/plugin-creator/names.mjs';

/** 表の左の言葉（ユーザーに話さない言葉） */
export const LEFT_WORDS = Object.freeze([
  'ナレッジ',
  'ヒアリング',
  '生成プラグイン',
  '統括エージェント',
  '作業エージェント',
  '検証エージェント',
  '合否の基準',
  '評価基準',
  '作業の定義',
  'Web管理画面',
  'EVAL',
  '構造の検査',
  '部品の試験',
  '候補',
  '項目',
  '生成前の確認',
  '試行',
  'コンパクション',
  'スキル',
  'フック',
  'MCP',
  'エクステンション',
  '記録のツール',
  'ひな形',
]);

const ALL_NAMES = [STAGES, ITEMS, ITEM_STATUSES, KNOWLEDGE_KINDS, KNOWLEDGE_STATUSES, KNOWLEDGE_SOURCES, ASSET_STATUSES, OSS_KINDS, OSS_CHOICES]
  .flatMap((rows) => rows.map((r) => r.name))
  .sort((a, b) => b.length - a.length);
const STAGE_NAMES = STAGES.map((s) => s.name);

// 表の左の言葉を含むだけで、その言葉そのものではない名前。名前そのものとして出る場所は、どこでも見逃す
const COMPOUND_NAMES = ['項目の点検', '候補の確かめ'];

/** 引数の値として出ている場所を取り除く */
export function withoutArgValues(text) {
  let s = String(text);
  for (const name of ALL_NAMES) s = s.replaceAll(`「${name}」`, '');
  s = s.replace(/使える(?:名前|状態|値)：[^\n]*/g, '');
  s = s.replace(new RegExp(`段階：\\s*(?:${STAGE_NAMES.join('|')})`, 'g'), '');
  for (const name of COMPOUND_NAMES) s = s.replaceAll(name, '');
  return s;
}

/** 文に出ている、表の左の言葉の一覧（なければ空） */
export function leftWordsIn(text) {
  const s = withoutArgValues(text);
  return LEFT_WORDS.filter((w) => s.includes(w));
}

// ソースの注釈（行の注釈と、ブロックの注釈）を取り除く。文字列の中の二重スラッシュ（URL）は残す
export function withoutComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}
