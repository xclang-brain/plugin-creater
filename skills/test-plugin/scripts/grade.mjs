// 採点（testing.md 10.4、REQ-041）。
// 採点は生成プラグインの外で行う。生成プラグインの検証エージェントが出した合否は使わない。
// Copilot SDK にも Agent SDK にも依らない。モデルで判定する部分は、判定の関数を引数で受ける（testing.md 10.5）。
//   ユーザーの試験：Copilot SDK のセッションで判定する関数（run.mjs の createCopilotJudge）
//   開発の試験    ：Agent SDK で判定する関数（tests/dev-eval）
//
// 基準（eval.json の criteria の1件）
//   { id, text, grading: "program", check: {...} }   プログラムで採点する
//   { id, text, grading: "model", check?: { files?: [グロブ] } }   モデルが判定する
//
// program の check.type（5種類。file は作業フォルダの根からの相対のグロブ）
//   file_exists   { type, file }                 file に当てはまる、空でないファイルがある
//   contains      { type, file, text }           当てはまるファイルのどれかに、text という文字がある
//   not_contains  { type, file, text }           当てはまるファイルが1つ以上あり、どれにも text がない
//   regex         { type, file, pattern, flags? } 当てはまるファイルのどれかに、正規表現が合う（flags は i・m・s・u）
//   unchanged     { type, file }                 file に当てはまる課題の入力のファイルが、すべてもとのまま残っている
// 課題の入力として写したファイルのうち、中身が変わっていないものは「当てはまるファイル」に数えない（入力だけで合格しないため）。
// そのため、unchanged のほかの4種類で、課題の入力のままで当てはまってしまうものは、課題の誤りにする（inputCheckProblems）。
// 入力を変えていないことは unchanged で確かめる。unchanged の file は、課題の入力のファイルのどれかに当てはまらなければならない。
// docx・xlsx・pptx は、中の文字を取り出して調べる（クリエイターの文書をテキストにする部品を使う）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ---- 決まった値 --------------------------------------------------------------------------------

export const GRADINGS = ['program', 'model'];
export const CHECK_TYPES = {
  file_exists: { required: ['file'], optional: [] },
  contains: { required: ['file', 'text'], optional: [] },
  not_contains: { required: ['file', 'text'], optional: [] },
  regex: { required: ['file', 'pattern'], optional: ['flags'] },
  unchanged: { required: ['file'], optional: [] },
};
const REGEX_FLAGS = new Set(['i', 'm', 's', 'u']);
const SKIP_DIRS = new Set(['node_modules', '.git']);
export const MAX_LISTED_FILES = 5000;
/** program の採点で読む1ファイルの文字数の上限 */
const CHECK_MAX_CHARS = 2_000_000;
const CHECK_MAX_BYTES = 20 * 1024 * 1024;
/** モデルに渡す成果物の上限 */
export const JUDGE_LIMITS = { perFileChars: 20_000, totalChars: 80_000, files: 30 };
const REASON_MAX_CHARS = 400;

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.html', '.htm', '.xml', '.yaml', '.yml', '.log', '.ini', '.toml',
  '.py', '.js', '.mjs', '.cjs', '.ts', '.sh', '.rst', '.tex', '.svg', '.css',
]);
const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx']);

// ---- 小さな道具 ---------------------------------------------------------------------------------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';

/** 作業フォルダの根からの相対の場所を、区切りが / で、Unicode の正規化形式が NFC の文字にそろえる */
export function normalizeRelPath(p) {
  return String(p).replace(/\\/g, '/').normalize('NFC');
}

export function clip(text, max) {
  const s = String(text ?? '');
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, max).join('')}…`;
}

export function sha256OfFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const escapeRegExp = (c) => c.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');

// ---- グロブ -------------------------------------------------------------------------------------

/**
 * 作業フォルダの根からの相対のグロブを、正規表現にする。
 * 使える書き方：
 *   アスタリスク1つ  / 以外の0文字以上
 *   アスタリスク2つ  / も含む0文字以上（アスタリスク2つと / が続くときは、0個以上のフォルダ）
 *   ?  / 以外の1文字
 *   [abc] [a-z] [!abc]  文字の集まり
 *   {md,txt}  どれか（入れ子は不可）
 * 大文字小文字は区別する。
 */
export function globToRegExp(pattern) {
  const p = normalizeRelPath(pattern);
  let re = '';
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        i += 1;
        if (p[i + 1] === '/') {
          i += 1;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      const end = p.indexOf(']', i + 2);
      if (end === -1) {
        re += '\\[';
      } else {
        let body = p.slice(i + 1, end);
        if (body[0] === '!') body = `^${body.slice(1)}`;
        re += `[${body.replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else if (c === '{') {
      const end = p.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
      } else {
        re += `(?:${p.slice(i + 1, end).split(',').map(escapeRegExp).join('|')})`;
        i = end;
      }
    } else {
      re += escapeRegExp(c);
    }
  }
  return new RegExp(`^${re}$`, 'u');
}

// ---- 課題と基準の確かめ ----------------------------------------------------------------------------

function checkGlob(value, label, problems) {
  if (!isText(value)) {
    problems.push(`${label} は、作業フォルダの根からの場所（グロブ）を文字で書く`);
    return;
  }
  if (value.includes('\\')) problems.push(`${label} は、場所の区切りを / で書く（\\ は使えない）`);
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) problems.push(`${label} は、作業フォルダの根からの相対の場所で書く（絶対の場所は使えない）`);
  if (value.split('/').includes('..')) problems.push(`${label} に .. は使えない`);
  try {
    globToRegExp(value);
  } catch (error) {
    problems.push(`${label} がグロブとして読めない（${error.message}）`);
  }
}

/** program の check を確かめる。誤りの文の並びを返す（なければ空） */
export function validateCheck(check, label = 'check') {
  const problems = [];
  if (!isObject(check)) return [`${label} がない（program の基準には check が要る）`];
  const spec = CHECK_TYPES[check.type];
  if (!spec) {
    return [`${label}.type「${check.type ?? ''}」は使えない（使えるのは ${Object.keys(CHECK_TYPES).join('・')}）`];
  }
  const allowed = new Set(['type', ...spec.required, ...spec.optional]);
  for (const key of Object.keys(check)) if (!allowed.has(key)) problems.push(`${label} に、${check.type} では使わない項目「${key}」がある`);
  for (const key of spec.required) if (!(key in check)) problems.push(`${label} に ${key} がない（${check.type} には要る）`);
  if ('file' in check) checkGlob(check.file, `${label}.file`, problems);
  if (check.type === 'contains' || check.type === 'not_contains') {
    if ('text' in check && !isText(check.text)) problems.push(`${label}.text は、探す文字を空でない文字で書く`);
  }
  if (check.type === 'regex') {
    if ('pattern' in check) {
      if (!isText(check.pattern)) {
        problems.push(`${label}.pattern は、正規表現を空でない文字で書く`);
      } else {
        const flags = check.flags ?? '';
        if (typeof flags !== 'string' || [...flags].some((f) => !REGEX_FLAGS.has(f)) || new Set(flags).size !== flags.length) {
          problems.push(`${label}.flags は、i・m・s・u のうち使うものを並べて書く`);
        } else {
          try {
            new RegExp(check.pattern, flags);
          } catch (error) {
            problems.push(`${label}.pattern が正規表現として読めない（${error.message}）`);
          }
        }
      }
    }
  }
  return problems;
}

/** model の基準の check（省略できる）を確かめる */
function validateModelCheck(check, label) {
  if (check === undefined) return [];
  if (!isObject(check)) return [`${label} は、{ "files": [グロブ] } の形で書く（省いてもよい）`];
  const problems = [];
  for (const key of Object.keys(check)) if (key !== 'files') problems.push(`${label} に、model の基準では使わない項目「${key}」がある`);
  if ('files' in check) {
    if (!Array.isArray(check.files) || check.files.length === 0) problems.push(`${label}.files は、グロブの並びを書く`);
    else check.files.forEach((glob, i) => checkGlob(glob, `${label}.files[${i}]`, problems));
  }
  return problems;
}

/** eval.json の1課題を確かめる。誤りの文の並びを返す（なければ空） */
export function validateTask(task, label = 'eval.json') {
  const problems = [];
  if (!isObject(task)) return [`${label} が JSON のオブジェクトではない`];
  if (!isText(task.id)) problems.push(`${label} に id がない`);
  if (!isText(task.prompt)) problems.push(`${label} に prompt（頼むときの言葉）がない`);
  if ('inputs' in task) {
    if (!Array.isArray(task.inputs)) {
      problems.push(`${label}.inputs は、入力のファイルの場所の並びで書く`);
    } else {
      task.inputs.forEach((p, i) => {
        if (!isText(p) || path.isAbsolute(p) || /^[A-Za-z]:/.test(p) || normalizeRelPath(p).split('/').includes('..')) {
          problems.push(`${label}.inputs[${i}] は、課題のフォルダの中の相対の場所で書く`);
        }
      });
    }
  }
  if ('settings' in task) {
    const s = task.settings;
    if (!isObject(s)) {
      problems.push(`${label}.settings は、{ "maxIterations": 数, "task": {...} } の形で書く`);
    } else {
      if ('maxIterations' in s && !(Number.isInteger(s.maxIterations) && s.maxIterations >= 1)) {
        problems.push(`${label}.settings.maxIterations は、1以上の整数で書く`);
      }
      if ('task' in s) {
        if (!isObject(s.task)) problems.push(`${label}.settings.task は、設定の名前と値の組で書く`);
        else {
          for (const [k, v] of Object.entries(s.task)) {
            if (!['string', 'number', 'boolean'].includes(typeof v)) problems.push(`${label}.settings.task.${k} の値は、文字・数・真偽のどれかで書く`);
          }
        }
      }
    }
  }
  if (!Array.isArray(task.criteria) || task.criteria.length === 0) {
    problems.push(`${label} に criteria（合否の基準）がない`);
  } else {
    const seen = new Set();
    task.criteria.forEach((c, i) => {
      const where = `${label}.criteria[${i}]`;
      if (!isObject(c)) {
        problems.push(`${where} がオブジェクトではない`);
        return;
      }
      if (!isText(c.id)) problems.push(`${where} に id がない`);
      else if (seen.has(c.id)) problems.push(`${where} の id「${c.id}」が重なっている`);
      else seen.add(c.id);
      if (!isText(c.text)) problems.push(`${where} に text（基準の文）がない`);
      if (!GRADINGS.includes(c.grading)) problems.push(`${where}.grading は program か model で書く`);
      else if (c.grading === 'program') problems.push(...validateCheck(c.check, `${where}.check`));
      else problems.push(...validateModelCheck(c.check, `${where}.check`));
    });
  }
  return problems;
}

// ---- 作業フォルダの中のファイル ------------------------------------------------------------------------

/**
 * 作業フォルダの中のファイルの一覧（シンボリックリンクは数えない。node_modules と .git の中は見ない）。
 * inputs は、写した入力の { 相対の場所 → sha256 }。中身が同じ入力は unchangedInput を真にする。
 */
export function listFiles(workDir, { inputs = new Map() } = {}) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (files.length >= MAX_LISTED_FILES) return;
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(abs);
      } else if (entry.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(abs).size;
        } catch {
          continue;
        }
        const rel = normalizeRelPath(path.relative(workDir, abs));
        const file = { path: rel, absPath: abs, size, unchangedInput: false };
        if (inputs.has(rel)) {
          try {
            file.unchangedInput = sha256OfFile(abs) === inputs.get(rel);
          } catch {
            // 読めなければ、入力のままとは言えない
          }
        }
        files.push(file);
      }
    }
  };
  walk(workDir);
  return files;
}

// ---- ファイルの中の文字 ---------------------------------------------------------------------------------

let officeReaderPromise;
/** クリエイターの文書をテキストにする部品（docx・xlsx・pptx）。見つからなければ null */
function loadOfficeReader() {
  officeReaderPromise ??= import(new URL('../../../com.github.copilot/extensions/plugin-creator/doc-text.mjs', import.meta.url).href).then(
    (m) => (typeof m.documentText === 'function' ? m.documentText : null),
    () => null,
  );
  return officeReaderPromise;
}

/** 文字として読めるバイト列なら文字にする（UTF-8、だめなら Shift_JIS）。読めなければ null */
function decodeText(buffer) {
  if (buffer.includes(0)) return null;
  let bytes = buffer;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  for (const label of ['utf-8', 'shift_jis']) {
    try {
      return new TextDecoder(label, { fatal: true }).decode(bytes);
    } catch {
      // 次の文字コードで読む
    }
  }
  return null;
}

/**
 * ファイルの中の文字を読む。
 * @returns {Promise<{ kind: 'text'|'office'|'binary'|'unreadable', text: string|null, truncated: boolean, note?: string }>}
 */
export async function readArtifactText(absPath, { maxChars = CHECK_MAX_CHARS } = {}) {
  const ext = path.extname(absPath).toLowerCase();
  if (OFFICE_EXTENSIONS.has(ext)) {
    const documentText = await loadOfficeReader();
    if (!documentText) return { kind: 'binary', text: null, truncated: false, note: '文書の中の文字を取り出す部品が見つからない' };
    try {
      const out = documentText(absPath, { maxChars });
      return { kind: 'office', text: out.text, truncated: out.truncated };
    } catch (error) {
      return { kind: 'unreadable', text: null, truncated: false, note: error.message };
    }
  }
  return readPlainText(absPath, { maxChars });
}

/**
 * docx・xlsx・pptx でないファイルの中の文字を読む（同期）。docx・xlsx・pptx は読まずに kind を 'office'、text を null にする。
 * 1段目（check_structure.py の input_text）も、同じ決まりで読む。
 */
export function readPlainText(absPath, { maxChars = CHECK_MAX_CHARS } = {}) {
  const ext = path.extname(absPath).toLowerCase();
  if (OFFICE_EXTENSIONS.has(ext)) return { kind: 'office', text: null, truncated: false, note: '文書の中の文字は取り出していない' };
  try {
    const stat = fs.statSync(absPath);
    if (!TEXT_EXTENSIONS.has(ext) && stat.size > 0) {
      // 拡張子から決められないときは、先頭だけ見て、文字かどうかを決める
      const fd = fs.openSync(absPath, 'r');
      try {
        const head = Buffer.alloc(Math.min(8192, stat.size));
        fs.readSync(fd, head, 0, head.length, 0);
        if (head.includes(0)) return { kind: 'binary', text: null, truncated: false, note: '文字にできない形式' };
      } finally {
        fs.closeSync(fd);
      }
    }
    if (stat.size > CHECK_MAX_BYTES) return { kind: 'unreadable', text: null, truncated: false, note: '大きすぎて読めない' };
    const text = decodeText(fs.readFileSync(absPath));
    if (text === null) return { kind: 'binary', text: null, truncated: false, note: '文字にできない形式' };
    const chars = [...text];
    return chars.length > maxChars
      ? { kind: 'text', text: chars.slice(0, maxChars).join(''), truncated: true }
      : { kind: 'text', text, truncated: false };
  } catch (error) {
    return { kind: 'unreadable', text: null, truncated: false, note: error.message };
  }
}

const unifyNewlines = (s) => s.normalize('NFC').replace(/\r\n?/g, '\n');
const namesOf = (files, max = 3) => {
  const names = files.slice(0, max).map((f) => f.path);
  return files.length > max ? `${names.join('、')}、ほか${files.length - max}件` : names.join('、');
};

// ---- program の採点 -------------------------------------------------------------------------------------

/**
 * program の基準を採点する。
 * @param {object} check 基準の check（validateCheck を通ったもの）
 * @param {Array} files listFiles の結果
 * @param {object} [opts]
 * @param {Map<string,string>} [opts.inputs] 写した入力の { 相対の場所 → sha256 }（unchanged に要る）
 * @param {string} [opts.workDir] 作業フォルダ（unchanged に要る）
 * @returns {Promise<{ pass: boolean, reason: string }>}
 */
export async function gradeProgram(check, files, { readText = readArtifactText, inputs = new Map(), workDir } = {}) {
  if (check.type === 'unchanged') return gradeUnchanged(check, inputs, workDir);
  const matcher = globToRegExp(check.file);
  const matched = files.filter((f) => !f.unchangedInput && matcher.test(f.path));
  if (check.type === 'file_exists') return decideProgram(check, matched, []);
  const reads = [];
  for (const file of matched) reads.push(await readText(file.absPath, { maxChars: CHECK_MAX_CHARS }));
  return decideProgram(check, matched, reads);
}

/**
 * unchanged の採点。file に当てはまる課題の入力のファイルが、作業フォルダにすべて残り、中身が写したときと同じなら合格。
 * 入力でないファイルは、当てはまっても見ない。
 */
function gradeUnchanged(check, inputs, workDir) {
  const matcher = globToRegExp(check.file);
  const target = `「${check.file}」`;
  const matched = [...inputs.keys()].filter((rel) => matcher.test(rel)).sort();
  if (matched.length === 0) return { pass: false, reason: `${target}に当てはまる課題の入力のファイルがない` };
  const missing = [];
  const changed = [];
  const listing = new Map();
  for (const rel of matched) {
    const abs = workDir ? findByNormalizedPath(workDir, rel, listing) : null;
    let stat = null;
    try {
      stat = abs ? fs.lstatSync(abs) : null;
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) {
      missing.push(rel);
      continue;
    }
    let same = false;
    try {
      same = sha256OfFile(abs) === inputs.get(rel);
    } catch {
      // 読めなければ、もとのままとは言えない
    }
    if (!same) changed.push(rel);
  }
  const list = (rels) => namesOf(rels.map((p) => ({ path: p })));
  if (missing.length === 0 && changed.length === 0) return { pass: true, reason: `課題の入力のファイルは、もとのまま（${list(matched)}）` };
  const parts = [];
  if (changed.length) parts.push(`中身が変わっている：${list(changed)}`);
  if (missing.length) parts.push(`なくなっている：${list(missing)}`);
  return { pass: false, reason: `${target}に当てはまる課題の入力のファイルが、もとのままではない（${parts.join('。')}）` };
}

/**
 * 作業フォルダの根からの相対の場所（区切りが /、NFC）にあたる、実物の場所を探す。なければ null。
 * 入力の場所は NFC にそろえてあるが、実物の名前は NFD のこともある（macOS で作った濁点のある名前など）。
 * 正規化の形を区別するファイルシステムでも見つかるように、名前を1段ずつ、正規化をそろえて比べる。シンボリックリンクはたどらない。
 * @param {Map<string,string[]>} listing 読んだフォルダの中の名前（同じフォルダを何度も読まないため）
 */
function findByNormalizedPath(root, rel, listing) {
  const direct = path.join(root, ...rel.split('/'));
  if (fs.existsSync(direct)) return direct;
  let dir = root;
  for (const part of rel.split('/')) {
    if (!listing.has(dir)) {
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        // 読めないフォルダの中は、ないものとする
      }
      listing.set(dir, names);
    }
    const name = listing.get(dir).find((n) => n.normalize('NFC') === part);
    if (name === undefined) return null;
    const next = path.join(dir, name);
    let stat;
    try {
      stat = fs.lstatSync(next);
    } catch {
      return null;
    }
    if (stat.isSymbolicLink()) return null;
    dir = next;
  }
  return dir;
}

/**
 * file_exists・contains・not_contains・regex の合否を決める（読むのは呼ぶ側）。
 * @param {Array<{ path: string, size: number }>} matched 当てはまるファイル
 * @param {Array<{ text: string|null, note?: string }>} reads matched と同じ並びの、読んだ文字（file_exists では使わない）
 */
function decideProgram(check, matched, reads) {
  const target = `「${check.file}」`;

  if (check.type === 'file_exists') {
    const filled = matched.filter((f) => f.size > 0);
    if (filled.length > 0) return { pass: true, reason: `${target}に当てはまるファイルがある（${namesOf(filled)}）` };
    if (matched.length > 0) return { pass: false, reason: `${target}に当てはまるファイルはあるが、中身が空です（${namesOf(matched)}）` };
    return { pass: false, reason: `${target}に当てはまるファイルがない` };
  }

  if (matched.length === 0) return { pass: false, reason: `${target}に当てはまるファイルがない` };

  const readable = [];
  const notReadable = [];
  matched.forEach((file, i) => {
    const read = reads[i];
    if (read.text === null) notReadable.push({ file, note: read.note });
    else readable.push({ file, text: unifyNewlines(read.text) });
  });
  const checked = `調べたファイル：${namesOf(matched)}`;
  const unreadableNote = notReadable.length ? `。文字にできないので調べられなかったファイル：${namesOf(notReadable.map((n) => n.file))}` : '';

  if (check.type === 'contains') {
    const needle = unifyNewlines(check.text);
    const hit = readable.find((r) => r.text.includes(needle));
    if (hit) return { pass: true, reason: `「${hit.file.path}」に「${clip(check.text, 40)}」がある` };
    return { pass: false, reason: `「${clip(check.text, 40)}」が見つからない（${checked}）${unreadableNote}` };
  }

  if (check.type === 'not_contains') {
    const needle = unifyNewlines(check.text);
    const hit = readable.find((r) => r.text.includes(needle));
    if (hit) return { pass: false, reason: `「${clip(check.text, 40)}」が「${hit.file.path}」にある` };
    if (notReadable.length > 0) return { pass: false, reason: `「${clip(check.text, 40)}」がないことを確かめきれない${unreadableNote}` };
    return { pass: true, reason: `「${clip(check.text, 40)}」はどのファイルにもない（${checked}）` };
  }

  // regex
  const re = new RegExp(check.pattern, check.flags ?? '');
  const hit = readable.find((r) => re.test(r.text));
  if (hit) return { pass: true, reason: `「${hit.file.path}」に、パターン「${clip(check.pattern, 40)}」に合う箇所がある` };
  return { pass: false, reason: `パターン「${clip(check.pattern, 40)}」に合う箇所が見つからない（${checked}）${unreadableNote}` };
}

// ---- 課題の入力を知っていて初めてできる、基準の確かめ ------------------------------------------------------------

const INPUT_CHECK_HINT =
  '採点は、中身が変わっていない入力を成果物に数えないので、作業をする前の入力で合格してしまう確かめ方は使えない。' +
  'file_exists・contains・not_contains・regex は、もとの入力のままでは合格せず、作業をして初めて合格するものにだけ使う（グロブを作業が作るファイルに絞る、作業が書き足す文字を確かめるなど）。' +
  '入力のファイルを変えていないことは、確かめ方の種類 unchanged（file）で確かめる。作業が変える入力に、もとからある文字が残ることなどは、model で判定する';

/**
 * 課題の入力のファイルと突き合わせて、基準の check を確かめる。誤りの文の並びを返す（なければ空）。
 * 1段目（template/tests/stage1/check_structure.py の input_check_problems）と同じ決まりにする。
 * 2つがずれていないことは、tests/creator/stage1/ の試験（同じ例を両方に通す）が見張る。
 *   - unchanged の file は、課題の入力のファイルのどれかに当てはまらなければならない。
 *   - file_exists・contains・not_contains・regex は、課題の入力のファイル（もとの中身）だけを成果物とみなしたときに
 *     合格してしまうなら誤り。採点は変わっていない入力を数えないので、入力を変えないと合格せず、変えれば中身にかかわらず合格に近づくため。
 *   文字の読み方は採点と同じ（UTF-8、だめなら Shift_JIS。改行と Unicode の正規化をそろえる）。ただし、docx・xlsx・pptx の入力は
 *   文字を取り出さず、文字にできない入力（0 のバイトがある、大きすぎる、文字コードが読めない）と同じく「中身が分からない」として扱う。
 *   1段目の Python では文書の中の文字を採点と同じには取り出せないためで、分からない入力では、合格してしまうとは決めない
 *   （contains・regex は文字にできた入力だけで決め、not_contains は分からない入力があれば誤りにしない）。
 *   file_exists は中身を読まず、大きさだけで決めるので、文書や文字にできない入力も数える。
 * @param {object} task validateTask を通った課題
 * @param {Array<{ path: string, absPath: string, size: number }>} inputFiles 課題の入力を作業フォルダに写したときのファイル
 *   （tasks.mjs の listInputFiles）。path は作業フォルダの根からの相対の場所
 */
export function inputCheckProblems(task, inputFiles, label = 'eval.json') {
  const problems = [];
  // 採点は node_modules と .git の中を見ないので、そこにある入力は成果物の候補にならない
  const candidates = inputFiles.filter((f) => !f.path.split('/').some((part) => SKIP_DIRS.has(part)));
  (task.criteria ?? []).forEach((c, i) => {
    if (!isObject(c) || c.grading !== 'program' || !isObject(c.check)) return;
    const where = `${label}.criteria[${i}].check`;
    const check = c.check;
    const matcher = globToRegExp(check.file);
    if (check.type === 'unchanged') {
      if (!inputFiles.some((f) => matcher.test(f.path))) {
        problems.push(`${where}.file「${check.file}」が、課題の入力のファイルのどれにも当てはまらない（unchanged は、課題の入力を変えていないことを確かめる種類）`);
      }
      return;
    }
    const matched = candidates.filter((f) => matcher.test(f.path));
    if (matched.length === 0) return;
    const reads = check.type === 'file_exists' ? [] : matched.map((f) => readPlainText(f.absPath, { maxChars: CHECK_MAX_CHARS }));
    const verdict = decideProgram(check, matched, reads);
    if (verdict.pass) problems.push(`${where} は、課題の入力のファイルがもとのままでも合格してしまう（${verdict.reason}）。${INPUT_CHECK_HINT}`);
  });
  return problems;
}

// ---- model の判定 ---------------------------------------------------------------------------------------

/**
 * モデルに渡す成果物を集める。check.files があればそのグロブに当てはまるもの、なければ（変わっていない入力を除く）すべて。
 * @returns {Promise<Array<{ path, size, kind, text, truncated, omitted?, note? }>>}
 */
export async function collectArtifacts(criterion, files, { readText = readArtifactText, limits = JUDGE_LIMITS } = {}) {
  const globs = criterion.check?.files;
  const matchers = Array.isArray(globs) ? globs.map(globToRegExp) : null;
  const selected = files.filter((f) => !f.unchangedInput && (!matchers || matchers.some((m) => m.test(f.path))));
  const artifacts = [];
  let used = 0;
  let omittedFiles = 0;
  for (const file of selected) {
    if (artifacts.length >= limits.files) {
      omittedFiles += 1;
      continue;
    }
    const read = await readText(file.absPath, { maxChars: limits.perFileChars });
    if (read.text === null) {
      artifacts.push({ path: file.path, size: file.size, kind: read.kind, text: null, truncated: false, note: read.note });
    } else if (used >= limits.totalChars) {
      artifacts.push({ path: file.path, size: file.size, kind: read.kind, text: null, truncated: false, omitted: true, note: '渡す量の上限に達したので渡していない' });
    } else {
      const room = limits.totalChars - used;
      const chars = [...read.text];
      const text = chars.length > room ? chars.slice(0, room).join('') : read.text;
      used += [...text].length;
      artifacts.push({ path: file.path, size: file.size, kind: read.kind, text, truncated: read.truncated || text.length < read.text.length });
    }
  }
  if (omittedFiles > 0) {
    artifacts.push({ path: `（ほか${omittedFiles}件）`, size: 0, kind: 'omitted', text: null, truncated: false, omitted: true, note: 'ファイルが多いので渡していない' });
  }
  return artifacts;
}

/** モデルに渡す、判定の指示文。ユーザーの試験（Copilot SDK）と開発の試験（Agent SDK）で同じものを使う */
export function buildJudgePrompt({ criterion, task, artifacts }) {
  const files = artifacts.length
    ? artifacts
        .map((a) => {
          if (a.text === null) return `<file path="${a.path}" bytes="${a.size}">（${a.note ?? '中身は渡していません'}）</file>`;
          const cut = a.truncated ? '\n（長いので、ここまでしか渡していません）' : '';
          return `<file path="${a.path}" bytes="${a.size}">\n${a.text}${cut}\n</file>`;
        })
        .join('\n')
    : '（成果物のファイルは1つもありません）';
  return [
    'あなたは、作業の成果物を採点する人です。成果物が、下の「基準」を満たしているかを判定してください。',
    '',
    '判定のしかた:',
    '- 判定するのは、基準に書いてあることだけです。基準に書いていない細かさ（書き方、言い回し、体裁）を求めると、正しい成果物を落としてしまうので、求めません。',
    '- 根拠は、成果物に書かれていることだけです。書かれていないことを推測で補いません。ファイルがない、中身が渡されていない場合は、確かめられないので「満たしていない」にします。',
    '- ツールは使いません。ここに渡した文章だけで判定します。',
    '- 返事は、次の形の JSON 1つだけにします。ほかの文字は書きません。理由は日本語で、1〜3文にします。',
    '  {"pass": true か false, "reason": "理由"}',
    '',
    '<task>',
    `作業の依頼: ${task?.prompt ?? ''}`,
    '</task>',
    '',
    '<criterion>',
    `${criterion.id}: ${criterion.text}`,
    '</criterion>',
    '',
    '<artifacts>',
    files,
    '</artifacts>',
  ].join('\n');
}

/** モデルの返事から、{ pass, reason } を取り出す。読めなければ Error */
export function parseJudgeReply(reply) {
  const text = String(reply ?? '');
  const candidates = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) candidates.push(fenced[1]);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const json = JSON.parse(candidate);
      if (isObject(json) && typeof json.pass === 'boolean') {
        return { pass: json.pass, reason: clip(typeof json.reason === 'string' ? json.reason.trim() : '', REASON_MAX_CHARS) };
      }
    } catch {
      // 次の候補を読む
    }
  }
  throw new Error(`判定の返事を読めなかった（${clip(text.replace(/\s+/g, ' ').trim(), 120)}）`);
}

// ---- 基準1件・実行1回の採点 ---------------------------------------------------------------------------------

/**
 * 基準1件を採点する。例外は投げず、採点できなかったときは pass を偽にして error を真にする。
 * @param {object} args
 * @param {object} args.criterion 基準
 * @param {object} args.task 課題（id、prompt）
 * @param {Array} args.files listFiles の結果
 * @param {Map<string,string>} [args.inputs] 写した入力の { 相対の場所 → sha256 }（unchanged の採点に要る）
 * @param {string} [args.workDir] 作業フォルダ（unchanged の採点に要る）
 * @param {Function} [args.judge] model の基準を判定する関数 ({ criterion, task, artifacts }) => Promise<{ pass, reason }>
 */
export async function gradeCriterion({ criterion, task, files, judge, readText = readArtifactText, inputs = new Map(), workDir }) {
  const base = { id: criterion.id, text: criterion.text, grading: criterion.grading };
  try {
    if (criterion.grading === 'program') {
      const out = await gradeProgram(criterion.check, files, { readText, inputs, workDir });
      return { ...base, pass: out.pass === true, reason: clip(out.reason, REASON_MAX_CHARS) };
    }
    if (typeof judge !== 'function') {
      return { ...base, pass: false, error: true, reason: 'モデルで判定する関数が渡されていないので、採点できなかった' };
    }
    const artifacts = await collectArtifacts(criterion, files, { readText });
    const out = await judge({ criterion: { id: criterion.id, text: criterion.text, check: criterion.check }, task: { id: task?.id, prompt: task?.prompt }, artifacts });
    if (!isObject(out) || typeof out.pass !== 'boolean') throw new Error('判定の関数が { pass, reason } を返さなかった');
    const result = { ...base, pass: out.pass, reason: clip(typeof out.reason === 'string' ? out.reason : '', REASON_MAX_CHARS) };
    if (out.error === true) result.error = true;
    // 判定にモデルを使った分の AI クレジット（判定の関数が数えて返す。見込みと使った分に入れる）
    if (Number.isFinite(out.credits)) result.credits = out.credits;
    if (typeof out.creditsStatus === 'string' && out.creditsStatus !== 'complete') result.creditsStatus = out.creditsStatus;
    return result;
  } catch (error) {
    return { ...base, pass: false, error: true, reason: `採点できなかった: ${clip(error?.message ?? String(error), 200)}` };
  }
}

/** 基準ごとの合否から、得点（合格の数 ÷ 基準の数）を出す */
export function scoreOf(results) {
  return results.length === 0 ? null : results.filter((r) => r.pass).length / results.length;
}

/**
 * 実行1回の成果物を、課題のすべての基準で採点する。
 * @returns {Promise<{ results: Array, passed: number, total: number, score: number|null, errors: number,
 *   judgments: number, judgeCredits: number, judgeCreditsStatus: string }>}
 *   judgments は model の基準の数、judgeCredits はその判定にモデルを使った AI クレジットの合計。
 */
export async function gradeRun({ task, workDir, inputs = new Map(), judge, readText = readArtifactText }) {
  const files = listFiles(workDir, { inputs });
  const results = [];
  for (const criterion of task.criteria) {
    results.push(await gradeCriterion({ criterion, task, files, judge, readText, inputs, workDir }));
  }
  const modelResults = results.filter((r) => r.grading === 'model');
  return {
    results,
    passed: results.filter((r) => r.pass).length,
    total: results.length,
    score: scoreOf(results),
    errors: results.filter((r) => r.error).length,
    judgments: modelResults.length,
    judgeCredits: modelResults.reduce((sum, r) => sum + (r.credits ?? 0), 0),
    judgeCreditsStatus: modelResults.some((r) => r.creditsStatus || r.credits === undefined) ? 'partial' : 'complete',
  };
}
