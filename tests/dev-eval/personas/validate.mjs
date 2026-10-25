// 模擬ユーザーの形を確かめる（FORMAT.md）。ユーザー役と外側の EVAL が読み込むときにも使う。
//   node tests/dev-eval/personas/validate.mjs <模擬ユーザーのフォルダ>… [--all-styles]
// 外部の npm パッケージは使わない。docx・xlsx の中の文字は、クリエイターの文書をテキストにする部品で読み、
// 内側の EVAL の課題と採点は、生成プラグインの試験と同じ grade.mjs を使う（testing.md 10.5）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { documentText } from '../../../com.github.copilot/extensions/plugin-creator/doc-text.mjs';
import { gradeProgram, inputCheckProblems, listFiles, normalizeRelPath, validateTask } from '../../../skills/test-plugin/scripts/grade.mjs';
import { listInputFiles, prepareWorkDir } from '../../../skills/test-plugin/scripts/tasks.mjs';

// ---- 決まった値 -------------------------------------------------------------------------------------

/** `file.answer` に書ける、決まりの確かめの 4 つの答え（hearing.md 6.1） */
export const CONFIRM_ANSWERS = ['このとおり', 'そうしないときもある', '決まりではなく、たまたま', '違う'];

/** 決まりの確かめの質問に付ける選択肢。hearing.md 6.1 の並べる順で、「このとおり」が最後 */
export const CONFIRM_CHOICES = ['そうしないときもある（どんなときか）', '違う（本当はどうか）', '決まりではなく、たまたま', 'このとおり'];

/** 決まりの種類（`file.kind`）と、選ぶ答え */
export const KIND_ANSWER = {
  rule: 'このとおり',
  exception: 'そうしないときもある',
  incidental: '決まりではなく、たまたま',
  wrong: '違う',
};

export const STYLE_KEYS = ['normal', 'terse', 'vague', 'dont-know', 'nothing-special', 'hurry'];
/** 聞き直されたあとに答えが出ればよい話し方 */
export const REASK_STYLES = ['vague', 'dont-know', 'nothing-special'];

const EXPERIENCES = ['done', 'never'];
const FROMS = ['talk', 'file'];
const ROLES = ['output', 'input', 'template'];
const SRC_EXTENSIONS = new Set(['.docx', '.xlsx', '.csv', '.txt', '.md']);
const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx']);
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const TOP_KEYS = ['id', 'title', 'experience', 'request', 'profile', 'files', 'knowledge', 'userRoleTests', 'styles'];
const FILE_KEYS = ['src', 'place', 'role', 'describe', 'reveal'];
const KNOWLEDGE_KEYS = ['id', 'fact', 'reveal', 'volunteer', 'from', 'file', 'markers'];
const KNOWLEDGE_FILE_KEYS = ['path', 'evidence', 'kind', 'answer', 'detail'];
const MARKER_KEYS = ['asked', 'answered', 'leak', 'embedded', 'excluded', 'task'];
const TEST_KEYS = ['generic', 'recall', 'compound', 'unknown', 'abstain', 'context', 'options', 'confirm'];
const STYLE_ITEM_KEYS = ['label', 'instruction', 'reask', 'signal'];

// ---- 小さな道具 -------------------------------------------------------------------------------------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isTextList = (v, min = 0) => Array.isArray(v) && v.length >= min && v.every(isText);
const nfc = (s) => String(s).normalize('NFC');

function regexOf(value) {
  try {
    return new RegExp(value);
  } catch {
    return null;
  }
}

function unknownKeys(obj, allowed, label, errors) {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) errors.push(`${label} に、知らない項目「${key}」がある`);
}

/** 正規表現の文字を確かめ、読めなければ誤りに足して null を返す */
function checkRegex(value, label, errors) {
  if (!isText(value)) {
    errors.push(`${label} は、正規表現を空でない文字で書く`);
    return null;
  }
  const re = regexOf(value);
  if (!re) errors.push(`${label} が正規表現として読めない（${value}）`);
  return re;
}

function checkRegexList(value, label, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label} は、正規表現の並びで書く（1 つ以上）`);
    return [];
  }
  return value.map((v, i) => checkRegex(v, `${label}[${i}]`, errors)).filter(Boolean);
}

/** 示すファイルの中の文字。docx・xlsx は文書をテキストにする部品、それ以外は UTF-8 で読む。読めなければ null */
function sourceText(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  try {
    if (OFFICE_EXTENSIONS.has(ext)) return nfc(documentText(absPath, { maxChars: 200_000 }).text);
    return nfc(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

// ---- 確かめ -------------------------------------------------------------------------------------------

function validateFiles(persona, dir, errors, context) {
  const places = new Set();
  if (!Array.isArray(persona.files)) {
    errors.push('files は、示すファイルの並びで書く（なければ []）');
    return;
  }
  persona.files.forEach((f, i) => {
    const label = `files[${i}]`;
    if (!isObject(f)) {
      errors.push(`${label} がオブジェクトではない`);
      return;
    }
    unknownKeys(f, FILE_KEYS, label, errors);
    for (const key of ['src', 'place', 'describe', 'reveal']) if (!isText(f[key])) errors.push(`${label}.${key} がない`);
    if (!ROLES.includes(f.role)) errors.push(`${label}.role は ${ROLES.join('・')} のどれかで書く`);
    if (isText(f.place)) {
      const place = normalizeRelPath(f.place);
      if (path.isAbsolute(f.place) || /^[A-Za-z]:/.test(f.place) || place.split('/').includes('..') || f.place.includes('\\')) {
        errors.push(`${label}.place は、作業フォルダの中の相対の場所で、区切りは / で書く（.. は使えない）`);
      }
      if (places.has(place)) errors.push(`${label}.place「${f.place}」が重なっている`);
      places.add(place);
    }
    if (isText(f.src)) {
      const src = path.join(dir, ...normalizeRelPath(f.src).split('/'));
      if (normalizeRelPath(f.src).split('/').includes('..') || path.isAbsolute(f.src)) {
        errors.push(`${label}.src は、模擬ユーザーのフォルダの中の相対の場所で書く`);
      } else if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
        errors.push(`${label}.src「${f.src}」のファイルがない`);
      } else if (fs.lstatSync(src).isSymbolicLink()) {
        errors.push(`${label}.src「${f.src}」はシンボリックリンクなので使えない`);
      } else {
        const ext = path.extname(src).toLowerCase();
        if (!SRC_EXTENSIONS.has(ext)) errors.push(`${label}.src の形式「${ext}」は使えない（${[...SRC_EXTENSIONS].join('・')}）`);
        const text = sourceText(src);
        if (text === null) errors.push(`${label}.src「${f.src}」の中の文字を読めない`);
        else context.fileText.set(normalizeRelPath(f.place ?? ''), text);
        context.fileExt.set(normalizeRelPath(f.place ?? ''), ext);
        if (isText(f.place) && path.extname(f.place).toLowerCase() !== ext) errors.push(`${label}.place の拡張子が src と違う`);
      }
    }
  });
  if (persona.experience === 'never') {
    if (persona.files.length > 0) errors.push('experience が never のとき、files は [] にする（まだやったことのない作業にはファイルがない）');
  } else if (persona.experience === 'done') {
    const offices = persona.files.filter((f) => isObject(f) && OFFICE_EXTENSIONS.has(path.extname(String(f.src ?? '')).toLowerCase()));
    if (offices.length === 0) errors.push('experience が done のとき、files に docx か xlsx を 1 つ以上入れる（testing.md 6.1）');
  }
}

function validateKnowledge(persona, errors, warnings, context) {
  const list = persona.knowledge;
  if (!Array.isArray(list) || list.length === 0) {
    errors.push('knowledge は、ナレッジの並びで書く（1 件以上）');
    return;
  }
  const ids = new Set();
  const kindsSeen = new Set();
  const hasHidden = list.some((k) => isObject(k) && k.volunteer === false);
  if (!hasHidden) errors.push('聞かれないと話さないナレッジ（volunteer が false）が 1 件もない（testing.md 6.1）');
  list.forEach((k, i) => {
    const label = `knowledge[${i}]`;
    if (!isObject(k)) {
      errors.push(`${label} がオブジェクトではない`);
      return;
    }
    const name = isText(k.id) ? `knowledge「${k.id}」` : label;
    unknownKeys(k, KNOWLEDGE_KEYS, name, errors);
    if (!isText(k.id) || !ID_PATTERN.test(k.id)) errors.push(`${label}.id は、英小文字・数字・ハイフンで書く`);
    else if (ids.has(k.id)) errors.push(`${label}.id「${k.id}」が重なっている`);
    else ids.add(k.id);
    if (!isText(k.fact)) errors.push(`${name}.fact がない`);
    if (!isText(k.reveal)) errors.push(`${name}.reveal（答える条件）がない`);
    if (typeof k.volunteer !== 'boolean') errors.push(`${name}.volunteer は true か false で書く`);
    if (!FROMS.includes(k.from)) errors.push(`${name}.from は ${FROMS.join(' か ')} で書く`);

    let detailText = '';
    if (k.from === 'file') {
      kindsSeen.add(k.file?.kind);
      if (!isObject(k.file)) {
        errors.push(`${name}.file がない（from が file のとき要る）`);
      } else {
        const f = k.file;
        unknownKeys(f, KNOWLEDGE_FILE_KEYS, `${name}.file`, errors);
        const place = isText(f.path) ? normalizeRelPath(f.path) : '';
        if (!context.fileText.has(place)) errors.push(`${name}.file.path「${f.path ?? ''}」が、files[].place にない`);
        else if (!isText(f.evidence)) errors.push(`${name}.file.evidence がない`);
        else if (!context.fileText.get(place).includes(nfc(f.evidence))) {
          errors.push(`${name}.file.evidence「${f.evidence}」が、ファイル「${f.path}」を文字にした結果にない`);
        }
        if (!Object.hasOwn(KIND_ANSWER, f.kind)) errors.push(`${name}.file.kind は ${Object.keys(KIND_ANSWER).join('・')} のどれかで書く`);
        else if (f.answer !== KIND_ANSWER[f.kind]) errors.push(`${name}.file.answer は、kind が ${f.kind} のとき「${KIND_ANSWER[f.kind]}」にする`);
        if ((f.kind === 'exception' || f.kind === 'wrong') && !isText(f.detail)) {
          errors.push(`${name}.file.detail がない（kind が ${f.kind} のとき、「どんなとき」か「本当はどうか」を書く）`);
        }
        if (f.kind === 'incidental' && k.volunteer !== false) errors.push(`${name} は incidental なので、volunteer を false にする`);
        detailText = String(f.detail ?? '');
      }
    } else if ('file' in k) {
      errors.push(`${name} は from が talk なので、file は書かない`);
    }

    // markers
    if (!isObject(k.markers)) {
      errors.push(`${name}.markers がない`);
      return;
    }
    const m = k.markers;
    unknownKeys(m, MARKER_KEYS, `${name}.markers`, errors);
    const own = `${k.fact ?? ''}\n${detailText}`;
    checkRegex(m.asked, `${name}.markers.asked`, errors);
    const answered = checkRegex(m.answered, `${name}.markers.answered`, errors);
    if (answered && !answered.test(own)) errors.push(`${name}.markers.answered が、fact（と file.detail）の中の言葉に当たらない（答えが当たるか見られない）`);
    if (k.volunteer === false) {
      const leak = checkRegex(m.leak, `${name}.markers.leak`, errors);
      if (leak && !leak.test(own)) errors.push(`${name}.markers.leak が、fact（と file.detail）の中の言葉に当たらない（漏れを見られない）`);
    } else if ('leak' in m) {
      errors.push(`${name}.markers.leak は、volunteer が false のときだけ書く`);
    }
    const hasEmbedded = Array.isArray(m.embedded) && m.embedded.length > 0;
    const hasExcluded = Array.isArray(m.excluded) && m.excluded.length > 0;
    if ('embedded' in m) checkRegexList(m.embedded, `${name}.markers.embedded`, errors);
    if ('excluded' in m) checkRegexList(m.excluded, `${name}.markers.excluded`, errors);
    if ('task' in m) checkRegexList(m.task, `${name}.markers.task`, errors);
    if (!hasEmbedded && !hasExcluded && k.id !== 'first-run') {
      errors.push(`${name}.markers に embedded か excluded を書く（first-run だけは省ける）`);
    }
    if (k.from === 'file' && isObject(k.file)) {
      if ((k.file.kind === 'incidental' || k.file.kind === 'wrong') && !hasExcluded) {
        errors.push(`${name} は ${k.file.kind} なので、markers.excluded を書く（入ってはいけない書き方）`);
      }
      if ((k.file.kind === 'rule' || k.file.kind === 'exception' || k.file.kind === 'wrong') && !hasEmbedded) {
        errors.push(`${name} は ${k.file.kind} なので、markers.embedded を書く（入るべき決まり）`);
      }
      if (k.file.kind === 'incidental' && hasEmbedded) errors.push(`${name} は incidental なので、markers.embedded は書かない`);
    }
  });
  if (persona.experience === 'done') {
    for (const kind of ['rule', 'exception', 'incidental']) {
      if (!kindsSeen.has(kind)) errors.push(`from が file のナレッジに、kind が ${kind} のものがない（本当の決まり・例外のある決まり・たまたまの書き方を 1 つ以上ずつ。testing.md 6.1）`);
    }
  }
  if (persona.experience === 'never') {
    const firstRun = list.find((k) => isObject(k) && k.id === 'first-run');
    if (!firstRun) errors.push('experience が never のとき、id が first-run のナレッジ（想定の 1 回）を入れる（REQ-016）');
    if (list.some((k) => isObject(k) && k.from === 'file')) errors.push('experience が never のとき、from が file のナレッジは書けない');
  }
  context.ids = ids;
  context.knowledgeById = new Map(list.filter((k) => isObject(k) && isText(k.id)).map((k) => [k.id, k]));
  if (list.length < 3) warnings.push('ナレッジが 3 件より少ない');
}

function validateUserRoleTests(persona, errors, context) {
  const t = persona.userRoleTests;
  if (!isObject(t)) {
    errors.push('userRoleTests がない');
    return;
  }
  unknownKeys(t, TEST_KEYS, 'userRoleTests', errors);
  if (!isTextList(t.generic, 3)) errors.push('userRoleTests.generic は、大まかな質問を 3 つ以上、文字で並べる');
  if (!isTextList(t.unknown, 2)) errors.push('userRoleTests.unknown は、ナレッジにないことの質問を 2 つ以上、文字で並べる');
  checkRegex(t.abstain, 'userRoleTests.abstain', errors);

  const covered = new Set();
  // 質問が、そのナレッジの asked に当たること（聞いたかを言葉で見るので、試験の質問が見えないと記録が合わない）
  const askedMatches = (id, question, label) => {
    const re = regexOf(context.knowledgeById.get(id)?.markers?.asked);
    if (re && isText(question) && !re.test(question)) errors.push(`${label} の質問「${question}」が、ナレッジ「${id}」の markers.asked に当たらない`);
  };
  const knowledgeIdOf = (entry, label) => {
    if (!isObject(entry) || !context.ids.has(entry.knowledge)) {
      errors.push(`${label}.knowledge「${entry?.knowledge ?? ''}」が、knowledge の id にない`);
      return null;
    }
    return entry.knowledge;
  };
  if (!Array.isArray(t.recall) || t.recall.length === 0) errors.push('userRoleTests.recall がない');
  else {
    t.recall.forEach((r, i) => {
      const id = knowledgeIdOf(r, `userRoleTests.recall[${i}]`);
      if (id) covered.add(id);
      if (!isTextList(r?.questions, 2)) errors.push(`userRoleTests.recall[${i}].questions は、質問を 2 つ以上、文字で並べる`);
      else if (id) for (const q of r.questions) askedMatches(id, q, `userRoleTests.recall[${i}]`);
    });
  }
  if (!Array.isArray(t.compound) || t.compound.length === 0) errors.push('userRoleTests.compound がない（1 件以上）');
  else {
    t.compound.forEach((c, i) => {
      const label = `userRoleTests.compound[${i}]`;
      if (!isText(c?.question)) errors.push(`${label}.question がない`);
      if (!Array.isArray(c?.expect) || c.expect.length < 2 || c.expect.some((id) => !context.ids.has(id))) {
        errors.push(`${label}.expect は、knowledge の id を 2 つ以上並べる`);
      } else for (const id of c.expect) askedMatches(id, c.question, label);
    });
  }
  if (!Array.isArray(t.context) || t.context.length === 0) errors.push('userRoleTests.context がない（1 件以上）');
  else {
    t.context.forEach((c, i) => {
      const label = `userRoleTests.context[${i}]`;
      if (!isTextList(c?.turns, 2)) errors.push(`${label}.turns は、質問を 2 つ以上並べる`);
      checkRegex(c?.expect, `${label}.expect`, errors);
    });
  }
  if (!Array.isArray(t.options) || t.options.length === 0) errors.push('userRoleTests.options がない（1 件以上）');
  else {
    t.options.forEach((o, i) => {
      const label = `userRoleTests.options[${i}]`;
      if (!isText(o?.question)) errors.push(`${label}.question がない`);
      if (!isTextList(o?.choices, 2)) errors.push(`${label}.choices は、選択肢を 2 つ以上並べる`);
      checkRegex(o?.expect, `${label}.expect`, errors);
    });
  }
  const confirmed = new Set();
  const confirmList = t.confirm ?? [];
  if (!Array.isArray(confirmList)) errors.push('userRoleTests.confirm は並びで書く');
  else {
    confirmList.forEach((c, i) => {
      const label = `userRoleTests.confirm[${i}]`;
      const id = knowledgeIdOf(c, label);
      if (id) {
        confirmed.add(id);
        covered.add(id);
        if (context.knowledgeById.get(id).from !== 'file') errors.push(`${label}.knowledge「${id}」は、from が file のナレッジではない`);
      }
      if (!isText(c?.question)) errors.push(`${label}.question がない`);
      else if (id) askedMatches(id, c.question, label);
      checkRegex(c?.expect, `${label}.expect`, errors);
    });
  }
  for (const [id, k] of context.knowledgeById) {
    if (!covered.has(id)) errors.push(`ナレッジ「${id}」の具体的な質問が、userRoleTests.recall にも confirm にもない`);
    if (k.from === 'file' && !confirmed.has(id)) errors.push(`ファイルから読み取るナレッジ「${id}」の決まりの確かめが、userRoleTests.confirm にない`);
  }
}

function validateStyles(persona, errors, { allStyles }, context) {
  const s = persona.styles;
  if (!isObject(s)) {
    errors.push('styles がない');
    return;
  }
  for (const key of Object.keys(s)) if (!STYLE_KEYS.includes(key)) errors.push(`styles に、使えないキー「${key}」がある（使えるのは ${STYLE_KEYS.join('・')}）`);
  if (!isObject(s.normal)) errors.push('styles.normal がない');
  if (allStyles) for (const key of STYLE_KEYS) if (!isObject(s[key])) errors.push(`styles.${key} がない（話し方の 6 つすべてが要る）`);
  for (const [key, v] of Object.entries(s)) {
    if (!STYLE_KEYS.includes(key)) continue;
    const label = `styles.${key}`;
    if (!isObject(v)) {
      errors.push(`${label} がオブジェクトではない`);
      continue;
    }
    unknownKeys(v, STYLE_ITEM_KEYS, label, errors);
    if (!isText(v.label)) errors.push(`${label}.label がない`);
    if (typeof v.instruction !== 'string') errors.push(`${label}.instruction は文字で書く（normal は空の文字）`);
    else if (key !== 'normal' && v.instruction.trim() === '') errors.push(`${label}.instruction がない`);
    else {
      // 話し方の指示は話し方だけを書く。ナレッジの言葉が入っていると、何を話してよいかが食い違う
      for (const [id, k] of context.knowledgeById) {
        for (const marker of ['answered', 'leak']) {
          const re = isText(k.markers?.[marker]) ? regexOf(k.markers[marker]) : null;
          if (re && re.test(`${v.instruction}\n${v.signal?.text ?? ''}`)) {
            errors.push(`${label} の指示に、ナレッジ「${id}」の言葉（markers.${marker}）が入っている。話し方の指示は話し方だけを書く`);
          }
        }
      }
    }
    if ('reask' in v && typeof v.reask !== 'boolean') errors.push(`${label}.reask は true か false で書く`);
    if (REASK_STYLES.includes(key) && v.reask !== true) errors.push(`${label}.reask は true にする`);
    if (key === 'hurry') {
      const sig = v.signal;
      if (!isObject(sig) || !Number.isInteger(sig.afterAnswers) || sig.afterAnswers < 1 || !isText(sig.text)) {
        errors.push('styles.hurry.signal は { "afterAnswers": 1 以上の整数, "text": 文字 } で書く');
      } else unknownKeys(sig, ['afterAnswers', 'text'], 'styles.hurry.signal', errors);
    } else if ('signal' in v) errors.push(`${label}.signal は、hurry だけに書く`);
  }
}

async function validateInner(persona, dir, errors, context) {
  const innerDir = path.join(dir, 'inner');
  const evalFile = path.join(innerDir, 'eval.json');
  let task;
  try {
    task = JSON.parse(fs.readFileSync(evalFile, 'utf8'));
  } catch (error) {
    errors.push(error.code === 'ENOENT' ? 'inner/eval.json がない' : `inner/eval.json を JSON として読めない（${error.message}）`);
    return;
  }
  const problems = validateTask(task, 'inner/eval.json');
  errors.push(...problems);
  if (problems.length > 0) return;

  const before = errors.length;
  for (const rel of task.inputs ?? []) {
    const source = path.join(innerDir, ...normalizeRelPath(rel).split('/'));
    let stat;
    try {
      stat = fs.lstatSync(source);
    } catch {
      errors.push(`inner/eval.json の入力「${rel}」が見つからない`);
      continue;
    }
    if (stat.isSymbolicLink()) errors.push(`inner/eval.json の入力「${rel}」はシンボリックリンクなので使えない`);
  }
  const inputsOk = errors.length === before;
  // 入力のままで当てはまってしまう採点や、入力に当てはまらない unchanged は、生成プラグインの課題と同じく誤りにする
  if (inputsOk) errors.push(...inputCheckProblems(task, listInputFiles(innerDir, task.inputs ?? []), 'inner/eval.json'));

  const gradedKnowledge = new Set();
  for (const c of task.criteria) {
    if (!context.ids.has(c.knowledge)) errors.push(`inner/eval.json の基準「${c.id}」の knowledge「${c.knowledge ?? ''}」が、knowledge の id にない`);
    else gradedKnowledge.add(c.knowledge);
  }
  for (const [id, k] of context.knowledgeById) {
    if (Array.isArray(k.markers?.task) && k.markers.task.length > 0 && !gradedKnowledge.has(id)) {
      errors.push(`ナレッジ「${id}」は markers.task を持つが、inner/eval.json に基準がない`);
    }
  }

  // 正しい成果物の見本で、program の基準がすべて合格すること
  const goldenDir = path.join(innerDir, 'golden');
  if (!fs.existsSync(goldenDir) || !fs.statSync(goldenDir).isDirectory()) {
    errors.push('inner/golden/ がない（正しい成果物の見本）');
    return;
  }
  if (listFiles(goldenDir).length === 0) {
    errors.push('inner/golden/ にファイルがない');
    return;
  }
  if (!inputsOk) return;
  // 採点と同じく、入力を写した作業フォルダに見本を重ねて採点する（見本にない入力は、写したまま変えていないとみなす）
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-golden-'));
  try {
    const { workDir, inputs } = prepareWorkDir({ task: { dir: innerDir, json: task }, dir: path.join(temp, 'work') });
    fs.cpSync(goldenDir, workDir, { recursive: true });
    const files = listFiles(workDir, { inputs });
    for (const c of task.criteria) {
      if (c.grading !== 'program') continue;
      const result = await gradeProgram(c.check, files, { inputs, workDir });
      if (!result.pass) errors.push(`inner/golden/ の見本が、基準「${c.id}」（${c.text}）に合格しない：${result.reason}`);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/**
 * 模擬ユーザー 1 人のフォルダを確かめる。
 * @param {string} dir 模擬ユーザーのフォルダ
 * @param {{ allStyles?: boolean }} [options] allStyles：話し方の 6 つがそろっているかも見る
 * @returns {Promise<{ ok: boolean, errors: string[], warnings: string[], persona: object|null }>}
 */
export async function validatePersona(dir, { allStyles = false } = {}) {
  const errors = [];
  const warnings = [];
  const absDir = path.resolve(dir);
  let persona = null;
  try {
    persona = JSON.parse(fs.readFileSync(path.join(absDir, 'persona.json'), 'utf8'));
  } catch (error) {
    errors.push(error.code === 'ENOENT' ? 'persona.json がない' : `persona.json を JSON として読めない（${error.message}）`);
    return { ok: false, errors, warnings, persona: null };
  }
  if (!isObject(persona)) return { ok: false, errors: ['persona.json が JSON のオブジェクトではない'], warnings, persona: null };

  unknownKeys(persona, TOP_KEYS, 'persona.json', errors);
  if (!isText(persona.id) || !ID_PATTERN.test(persona.id)) errors.push('id は、英小文字・数字・ハイフンで書く');
  else if (persona.id !== path.basename(absDir)) errors.push(`id「${persona.id}」が、フォルダの名前「${path.basename(absDir)}」と違う`);
  for (const key of ['title', 'request', 'profile']) if (!isText(persona[key])) errors.push(`${key} がない`);
  if (!EXPERIENCES.includes(persona.experience)) errors.push(`experience は ${EXPERIENCES.join(' か ')} で書く`);

  const context = { fileText: new Map(), fileExt: new Map(), ids: new Set(), knowledgeById: new Map() };
  validateFiles(persona, absDir, errors, context);
  validateKnowledge(persona, errors, warnings, context);
  if (context.ids.size > 0) {
    validateUserRoleTests(persona, errors, context);
    await validateInner(persona, absDir, errors, context);
  }
  validateStyles(persona, errors, { allStyles }, context);
  return { ok: errors.length === 0, errors, warnings, persona };
}

/**
 * 模擬ユーザーを読み込む。形に合わなければ Error を投げる。
 * @returns {Promise<{ persona: object, dir: string, files: Array<{ src: string, place: string, role: string, describe: string }> }>}
 *   files の src は、示すファイルの元の絶対の場所
 */
export async function loadPersona(dir, options = {}) {
  const absDir = path.resolve(dir);
  const result = await validatePersona(absDir, options);
  if (!result.ok) {
    throw new Error(`模擬ユーザー「${path.basename(absDir)}」の形が決まりに合わない：\n- ${result.errors.join('\n- ')}`);
  }
  const files = result.persona.files.map((f) => ({
    src: path.join(absDir, ...normalizeRelPath(f.src).split('/')),
    place: normalizeRelPath(f.place),
    role: f.role,
    describe: f.describe,
  }));
  return { persona: result.persona, dir: absDir, files };
}

// ---- コマンド ---------------------------------------------------------------------------------------------

async function main(argv) {
  const allStyles = argv.includes('--all-styles');
  const dirs = argv.filter((a) => !a.startsWith('--'));
  if (dirs.length === 0) {
    console.error('使い方：node validate.mjs <模擬ユーザーのフォルダ>… [--all-styles]');
    return 2;
  }
  let failed = 0;
  for (const dir of dirs) {
    const r = await validatePersona(dir, { allStyles });
    const name = path.basename(path.resolve(dir));
    console.log(`${r.ok ? '合格' : '不合格'}  ${name}`);
    for (const e of r.errors) console.log(`  誤り：${e}`);
    for (const w of r.warnings) console.log(`  注意：${w}`);
    if (!r.ok) failed += 1;
  }
  return failed > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fileURLToPath(pathToFileURL(process.argv[1]))).href) {
  process.exitCode = await main(process.argv.slice(2));
}
