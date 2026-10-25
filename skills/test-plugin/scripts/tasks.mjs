// EVAL の課題（<生成プラグイン>/tests/eval/<課題>/eval.json）の読み込みと、実行ごとの作業フォルダの用意。
// eval.json の形は BLUEPRINT 4.3、基準の check の決まりは grade.mjs の先頭にある。

import fs from 'node:fs';
import path from 'node:path';

import { inputCheckProblems, normalizeRelPath, sha256OfFile, validateTask } from './grade.mjs';

/** 課題の入力（ファイルかフォルダ）を確かめる。シンボリックリンクは認めない（外のファイルを写さないため）。誤りの文の並びを返す */
function inputProblems(taskDir, rel, label) {
  const source = path.join(taskDir, ...normalizeRelPath(rel).split('/'));
  let stat;
  try {
    stat = fs.lstatSync(source);
  } catch {
    return [`${label} の入力「${rel}」が見つからない（${source}）`];
  }
  if (stat.isSymbolicLink()) return [`${label} の入力「${rel}」はシンボリックリンクなので使えない`];
  if (stat.isFile()) return [];
  if (!stat.isDirectory()) return [`${label} の入力「${rel}」はファイルでもフォルダでもない`];
  const problems = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) problems.push(`${label} の入力「${rel}」の中に、シンボリックリンクがある（${path.relative(taskDir, abs)}）`);
      else if (entry.isDirectory()) walk(abs);
    }
  };
  walk(source);
  return problems;
}

/**
 * 課題の入力を作業フォルダに写したときのファイルの一覧（prepareWorkDir が写すのと同じもの）。
 * 入力は課題のフォルダからの相対の場所で、作業フォルダの同じ相対の場所に写る。フォルダの入力は、中のファイルをすべて数える。
 * inputProblems を通った入力にだけ使う（シンボリックリンクはたどらない）。
 * @returns {Array<{ path: string, absPath: string, size: number }>} path は作業フォルダの根からの相対の場所。場所の順
 */
export function listInputFiles(taskDir, inputs = []) {
  const found = new Map();
  const walk = (abs, rel) => {
    let stat;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(abs)) walk(path.join(abs, name), rel ? `${rel}/${name}` : name);
    } else if (stat.isFile()) {
      const key = normalizeRelPath(rel);
      found.set(key, { path: key, absPath: abs, size: stat.size });
    }
  };
  for (const item of inputs) {
    // 写す先と同じく、path.join で「.」や重なった区切りを除いてから、相対の場所にする
    const rel = path.posix.normalize(normalizeRelPath(item)).replace(/\/$/, '').replace(/^\.$/, '');
    walk(path.join(taskDir, ...rel.split('/')), rel);
  }
  return [...found.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * 生成プラグインの課題をすべて読む。
 * @returns {{ tasks: Array<{ id: string, dir: string, json: object }>, problems: string[] }}
 *   課題は、フォルダの名前の順。誤りがあっても、読めた課題は返す。
 */
export function loadTasks(pluginDir) {
  const evalDir = path.join(pluginDir, 'tests', 'eval');
  const tasks = [];
  const problems = [];
  let names = [];
  try {
    names = fs.readdirSync(evalDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    problems.push(`課題のフォルダがない（${evalDir}）`);
    return { tasks, problems };
  }
  const seen = new Map();
  for (const name of names) {
    const dir = path.join(evalDir, name);
    const file = path.join(dir, 'eval.json');
    const label = `tests/eval/${name}/eval.json`;
    let json;
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      problems.push(error.code === 'ENOENT' ? `${label} がない` : `${label} を JSON として読めない（${error.message}）`);
      continue;
    }
    const own = validateTask(json, label);
    if (own.length === 0) {
      for (const rel of json.inputs ?? []) own.push(...inputProblems(dir, rel, label));
      // 入力のままで当てはまってしまう採点や、入力に当てはまらない unchanged は、入力がそろっているときに確かめる
      if (own.length === 0) own.push(...inputCheckProblems(json, listInputFiles(dir, json.inputs ?? []), label));
      if (seen.has(json.id)) own.push(`${label} の id「${json.id}」が、${seen.get(json.id)} と重なっている`);
      else seen.set(json.id, label);
    }
    if (own.length > 0) problems.push(...own);
    else tasks.push({ id: json.id, dir, json });
  }
  if (tasks.length === 0 && problems.length === 0) problems.push('課題が1つもない（tests/eval/<課題>/eval.json がない）');
  return { tasks, problems };
}

/** 基準の数を、採点のしかた別に数える */
export function countCriteria(task) {
  const criteria = task.json?.criteria ?? task.criteria ?? [];
  return {
    total: criteria.length,
    program: criteria.filter((c) => c.grading === 'program').length,
    model: criteria.filter((c) => c.grading === 'model').length,
  };
}

function copyEntry(source, dest, record, rootDest) {
  const stat = fs.lstatSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(source)) copyEntry(path.join(source, entry), path.join(dest, entry), record, rootDest);
  } else if (stat.isFile()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
    record.set(normalizeRelPath(path.relative(rootDest, dest)), sha256OfFile(dest));
  }
}

/**
 * 実行1回のための、まっさらな作業フォルダを作り、課題の入力のファイルだけを写す。
 * @param {{ task: { dir: string, json: object }, dir: string }} args dir は作るフォルダ（まだないか、空であること）
 * @returns {{ workDir: string, inputs: Map<string, string> }} inputs は、写したファイルの { 相対の場所 → sha256 }
 */
export function prepareWorkDir({ task, dir }) {
  fs.mkdirSync(dir, { recursive: true });
  if (fs.readdirSync(dir).length > 0) throw new Error(`作業フォルダが空ではない（${dir}）`);
  const workDir = fs.realpathSync(dir);
  const inputs = new Map();
  for (const rel of task.json.inputs ?? []) {
    const parts = normalizeRelPath(rel).split('/');
    copyEntry(path.join(task.dir, ...parts), path.join(workDir, ...parts), inputs, workDir);
  }
  return { workDir, inputs };
}
