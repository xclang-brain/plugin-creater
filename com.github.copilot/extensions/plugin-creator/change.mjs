// 今のプラグインを直す（改善・設計変更。REQ-052〜061）ときの、直すフォルダの読み取りと、番号・版の決まり。
// 設計図：wip/change-plugin/BLUEPRINT.md 4.1（記録の change）、4.2（決まりの番号）、4.4（合否の基準の番号）、4.5（版の案）、D15・D16・D29。
//
// - Copilot CLI に依らない。直すフォルダのファイルは読むだけで、何も書かない。
// - git は使わない（子プロセスは起票の gh だけ。git の確かめは組み立てのスクリプトの change-check。D7）。
// - 生成プラグインかの見分け方（D29）は、組み立てのスクリプト（change-check・extract）と同じにする：
//   plugin.json の name で、tests/knowledge.json と com.github.copilot/extensions/<name>/task.json の両方があれば生成プラグイン。
//   あるのに読めないときは、理由を示して断る。

import fs from 'node:fs';
import path from 'node:path';

import { Refusal } from './hearing.mjs';
import { KNOWLEDGE_KINDS, MAIN_ITEMS, listNames } from './names.mjs';

/** plugin.json を探す場所。この順に探し、最初に見つかったものを使う（make-plugin の references/start.md と同じ） */
export const MANIFEST_PLACES = Object.freeze(['plugin.json', '.plugin/plugin.json', '.github/plugin/plugin.json', '.claude-plugin/plugin.json']);

/** 確認の版の形（D16） */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

const KNOWLEDGE_ID = /^K-(\d+)$/;
const CRITERION_ID = /^C-(\d+)$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';
const numberOf = (id, pattern) => Number(pattern.exec(String(id))?.[1] ?? NaN);
const pad2 = (n) => String(n).padStart(2, '0');

/** 決まりの番号 K-NN（2桁以上） */
export const knowledgeId = (n) => `K-${pad2(n)}`;

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * 直すフォルダの中の JSON のファイルを読む。ないときは undefined。あるのに読めないときは、理由つきで断る（D29）。
 * @param {string} folder 直すフォルダ（実パス）
 * @param {string} rel フォルダからの場所（POSIX）
 */
function readJson(folder, rel) {
  const file = path.join(folder, ...rel.split('/'));
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Refusal(`直すプラグインの ${rel} を読めません（${error.message}）。ファイルを確かめてから、もう一度頼んでください。`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Refusal(`直すプラグインの ${rel} を、JSON として読めません（${error.message}）。ファイルを直すか、git で前の中身に戻してから、もう一度頼んでください。`);
  }
}

const shapeRefusal = (rel, problem) => new Refusal(`直すプラグインの ${rel} の形が違います：${problem}。ファイルを直すか、git で前の中身に戻してから、もう一度頼んでください。`);

const MAIN_BY_NAME = new Map(MAIN_ITEMS.map((i) => [i.name, i]));
const KIND_KEYS = KNOWLEDGE_KINDS.map((k) => k.key);
const untrimmed = (value) => value !== value.trim();

/**
 * tests/knowledge.json（組み立てのスクリプトが書く形：[{ id, kind, item〔日本語の名前〕, text }]）を確かめて、取り込む行にする。
 * 聞くこと（item）と文（text）は、ファイルの文字のまま持つ（組み立ての change は、元の item・text と記録の itemName・text を、
 * そのまま比べる。BLUEPRINT 4.1・4.2）。記録の文は前後の空白を除いて持つので、前後に空白がある文や、日本語の名前でない聞くことは、
 * 取り込まずに断る（取り込むと、中身を直していないのに、直す段で「同じ番号のまま中身が違う」と断られるため）。
 */
function knowledgeRows(data) {
  const rel = 'tests/knowledge.json';
  if (!Array.isArray(data)) throw shapeRefusal(rel, '決まりの一覧（[ ]）ではありません');
  const seen = new Set();
  return data.map((row, index) => {
    const where = `${index + 1}件目`;
    if (!isObject(row)) throw shapeRefusal(rel, `${where}が { } のまとまりではありません`);
    if (typeof row.id !== 'string' || !KNOWLEDGE_ID.test(row.id)) throw shapeRefusal(rel, `${where}の番号（id）が K-数字 の形ではありません`);
    if (seen.has(row.id)) throw shapeRefusal(rel, `番号 ${row.id} が重なっています`);
    seen.add(row.id);
    // 種類は、ファイルに書く値（criterion・other）を、日本語の名前と並べて示す（ファイルを直すときに要るため）
    if (!KIND_KEYS.includes(row.kind)) throw shapeRefusal(rel, `${row.id} の種類（kind）が、合否の決め方（criterion）かそれ以外（other）のどちらでもありません`);
    const item = typeof row.item === 'string' ? MAIN_BY_NAME.get(row.item.trim()) : undefined;
    if (!item) throw shapeRefusal(rel, `${row.id} の聞くこと（item）が、10の聞くことの名前（${listNames(MAIN_ITEMS)}）のどれでもありません`);
    if (untrimmed(row.item)) throw shapeRefusal(rel, `${row.id} の聞くこと（item）の初めか終わりに、空白か改行があります`);
    if (!nonEmpty(row.text)) throw shapeRefusal(rel, `${row.id} の文（text）が空です`);
    if (untrimmed(row.text)) throw shapeRefusal(rel, `${row.id} の文（text）の初めか終わりに、空白か改行があります`);
    return { id: row.id, kind: row.kind, item: item.key, itemName: row.item, text: row.text };
  });
}

/** tests/knowledge-removed.json（BLUEPRINT 4.3：[{ id, kind, item, text, replacedBy? }]）の番号 */
function removedIds(data) {
  const rel = 'tests/knowledge-removed.json';
  if (!Array.isArray(data)) throw shapeRefusal(rel, '外した決まりの一覧（[ ]）ではありません');
  return data.map((row, index) => {
    if (!isObject(row) || typeof row.id !== 'string' || !KNOWLEDGE_ID.test(row.id)) throw shapeRefusal(rel, `${index + 1}件目の番号（id）が K-数字 の形ではありません`);
    return row.id;
  });
}

/** task.json の criteria から、決まりの番号 → 合否の基準の番号 */
function criteriaIdsOf(rel, data) {
  if (!isObject(data) || !Array.isArray(data.criteria)) throw shapeRefusal(rel, '合格の条件の一覧（criteria）がありません');
  const out = {};
  for (const [index, c] of data.criteria.entries()) {
    if (!isObject(c) || typeof c.id !== 'string' || !CRITERION_ID.test(c.id) || typeof c.knowledge !== 'string' || !KNOWLEDGE_ID.test(c.knowledge)) {
      throw shapeRefusal(rel, `合格の条件（criteria）の ${index + 1}件目の番号（id は C-数字、knowledge は K-数字）の形が違います`);
    }
    if (!Object.hasOwn(out, c.knowledge)) out[c.knowledge] = c.id;
  }
  return out;
}

/** tests/eval/*\/eval.json の頼むときの言葉（prompt）。課題のフォルダの名前の順 */
function evalPromptsOf(folder) {
  const base = path.join(folder, 'tests', 'eval');
  let names;
  try {
    names = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
  const prompts = [];
  for (const name of names) {
    const rel = `tests/eval/${name}/eval.json`;
    const data = readJson(folder, rel);
    if (data === undefined) continue;
    if (!isObject(data) || !nonEmpty(data.prompt)) throw shapeRefusal(rel, '頼むときの言葉（prompt）がありません');
    prompts.push(data.prompt.trim());
  }
  return prompts;
}

/**
 * 直すフォルダを読む（plugin-creator_change。BLUEPRINT 5 C1）。
 * @param {string} folder 直すフォルダの実パス（あるフォルダであることは呼ぶ側が確かめる）
 * @returns {{ manifest: string, name: string, version: string|null, generated: boolean,
 *   knowledge: {id, kind, item, itemName, text}[], removed: string[], maxId: number, criteriaIds: Record<string,string>, evalPrompts: string[] }}
 *   knowledge は取り込む行（生成プラグインのときだけ）。maxId は knowledge.json と knowledge-removed.json の番号の最大（D15）。
 */
export function readPluginForChange(folder) {
  const manifest = MANIFEST_PLACES.find((rel) => isFile(path.join(folder, ...rel.split('/'))));
  if (!manifest) {
    throw new Refusal(`${folder} に plugin.json がありません（探した場所：${MANIFEST_PLACES.join('、')}）。Copilot CLI で読み込めるプラグインのフォルダを示してください。`);
  }
  const data = readJson(folder, manifest);
  if (!isObject(data)) throw shapeRefusal(manifest, '{ } のまとまりではありません');
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!name || /[\\/]/.test(name) || name === '.' || name === '..') throw shapeRefusal(manifest, 'プラグインの名前（name）がないか、フォルダの区切りを含んでいます');
  const version = nonEmpty(data.version) ? data.version.trim() : null;

  const taskRel = `com.github.copilot/extensions/${name}/task.json`;
  const knowledgeData = readJson(folder, 'tests/knowledge.json');
  const taskData = readJson(folder, taskRel);
  // 組み立てのスクリプト（plugin_kind）と同じく、まず全体の形だけを見る（あるのに読めなければ断る）
  if (knowledgeData !== undefined && !Array.isArray(knowledgeData)) throw shapeRefusal('tests/knowledge.json', '決まりの一覧（[ ]）ではありません');
  if (taskData !== undefined && !isObject(taskData)) throw shapeRefusal(taskRel, '{ } のまとまりではありません');
  const generated = knowledgeData !== undefined && taskData !== undefined;

  // 生成プラグインのときだけ、決まりを取り込み、外した決まりの一覧・合格の条件の番号・課題を読む
  const rows = generated ? knowledgeRows(knowledgeData) : [];
  const removedData = generated ? readJson(folder, 'tests/knowledge-removed.json') : undefined;
  const removed = removedData === undefined ? [] : removedIds(removedData);
  // 新しい番号は、これまでに使った番号（knowledge.json と knowledge-removed.json）の最大の次から（D15。外した番号を使い回さない）。
  // 生成プラグインでないときも、knowledge.json があれば、その番号と重ならないようにする
  const ownIds = generated ? rows.map((r) => r.id) : (knowledgeData ?? []).map((r) => (isObject(r) ? r.id : null));
  const maxId = Math.max(0, ...[...ownIds, ...removed].map((id) => numberOf(id, KNOWLEDGE_ID)).filter(Number.isFinite));

  return {
    manifest,
    name,
    version,
    generated,
    knowledge: generated ? rows : [],
    removed,
    maxId,
    criteriaIds: generated ? criteriaIdsOf(taskRel, taskData) : {},
    evalPrompts: generated ? evalPromptsOf(folder) : [],
    taskRel,
  };
}

/**
 * 合否の基準の番号（C 番号。BLUEPRINT 4.4、D14）。
 * rows は確認で示す決まり（番号の小さい順）。合否の決め方の行ごとに、criteriaIds[行の番号] があればその番号、
 * なければ criteriaIds の値の最大の次から順に C-NN。作る流れは criteriaIds が空なので、C-01 から。
 * @returns {{ id: string, text: string, knowledge: string }[]}
 */
export function criteriaRows(rows, criteriaIds = {}) {
  const ids = isObject(criteriaIds) ? criteriaIds : {};
  let next = Math.max(0, ...Object.values(ids).map((id) => numberOf(id, CRITERION_ID)).filter(Number.isFinite));
  return rows
    .filter((k) => k.kind === 'criterion')
    .map((k) => ({ id: Object.hasOwn(ids, k.id) ? ids[k.id] : `C-${pad2((next += 1))}`, text: k.text, knowledge: k.id }));
}

/**
 * 版を数ごとに比べる（D16）。a が大きければ正、同じなら 0、小さければ負。
 * どちらかが「数を . でつないだ形」でなければ null（比べられない。そのときは確認の版の形だけを見る）。
 */
export function compareVersions(a, b) {
  const parse = (v) => (typeof v === 'string' && /^\d+(\.\d+)*$/.test(v.trim()) ? v.trim().split('.').map(Number) : null);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
