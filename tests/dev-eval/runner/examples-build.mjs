// 会話例の作成（testing.md 6.6、REQ-037）。外側の EVAL の記録（outer.mjs が書く records/ の JSON）から、
// 模擬ユーザーごとに 1 つ、Markdown の会話例を作る。会話例のために EVAL を足すことはしない。
//
// 選ぶ条件（点数の高さだけでは選ばない。ユーザー役が隠すべきことを漏らすと、点数が上がるため）
//   - クリエイター（with の腕）の会話で、生成まで進んだ（stopped が generated）
//   - 採点の観点（6.5）にすべて合格した（思考力の高いモデルのもの。Claude Haiku 5.5 の会話は使わない）
//   - ユーザー役の誤りがない（聞かれていないのに隠すべきナレッジを話した、自分への指示のことを話した）。6.3 の記録で機械的に除く。最後は全文を読んで確かめる
//   - 話し方は normal（既定。--style で変えられる）
//   - クリエイターの版が、今の plugin.json の版と同じ（版を上げるたびに、その版の会話から作り直す）
//   - 見ない模擬ユーザー（heldout）の会話は載せない（読めば、見ない模擬ユーザーではなくなるため）
//   - 開発者が答えた会話（記録の answerer が human。6.7）は載せない（会話例は、AI が演じたユーザーとの会話と決めているため）
// 冒頭に、AI が演じたユーザーとの会話であることと、plugin-creator の版と日付を書く（冒頭 30 行に「plugin-creator の版：x.y.z」。A3 の 1段目が突き合わせる）。
// 続けて、試験の条件と点数（REQ-037）、聞かれないと話さないことにしていた決まりの一覧（REQ-037）を書く。見ない模擬ユーザーの会話は載せないので、一覧を出してよい。
// 会話例はエンドユーザーが README と画面から読むので、書く言葉は画面と同じ「plugin-creator」にする（仕様 REQ-037 の「クリエイターの版」は開発者の用語）。
// 聞かれないと話さないナレッジを引き出した質問には印を付ける（6.3 の記録：ナレッジごとの聞いたか・答えたか）。
// 外に出してはいけないもの（画面の URL の合言葉とポート番号、作業フォルダなどのパス、会話の番号）は伏せる。伏せ残しがあれば、書かずに断る。
// 会話の表示は GitHub の画面（引用の中の改行が1段落につながる、「## 」が見出しになる）と、クリエイターの画面（text/plain）の両方で崩れないようにする。
// 置き場所はクリエイターのスキルのフォルダの外（既定は examples/）。変換スクリプトが、置き換えた版から外す。
//
// 使い方（リポジトリの根から）:
//   node tests/dev-eval/runner/examples-build.mjs --records <records のフォルダ>… [--out examples] [--style normal] [--version x.y.z] [--clean] [--dry-run]
//   終了コード：0 作った（または --dry-run）、1 作れる会話がなかった、2 始められなかった。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadPersona } from '../personas/validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const PERSONAS_DIR = path.resolve(HERE, '..', 'personas');

/**
 * 会話例が必ず持つ一文（REQ-037：AI が演じたユーザーとの会話であること）。--clean は、この一文があるファイルだけを消す（人が書いたファイルは消さない）。
 * 会話例は外側の EVAL の会話から作るもので（testing.md 6.6）、この一文はエンドユーザーが読む言葉なので、作ったことを示す HTML のコメントは入れない
 * （クリエイターの画面は text/plain で見せるので、コメントが丸見えになる）。
 */
export const GENERATED_MARK = 'この会話は、AI が演じたユーザーと plugin-creator の会話です。';
const NOTICE = `${GENERATED_MARK}人と話すと、質問の数や順番が変わります。`;
const EXAMPLE_HEAD_LINES = 30;

export class ExamplesError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExamplesError';
    this.code = code;
  }
}

// ---- 記録の読み込み ------------------------------------------------------------------------------------------

/** フォルダ（またはファイル）の中の、外側の EVAL の記録（schema が outer-record/1 の JSON）を読む */
export function readRecords(inputs) {
  const records = [];
  const visit = (target) => {
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      throw new ExamplesError('not_found', `記録が見つかりません：${target}`);
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(target).sort()) visit(path.join(target, name));
    } else if (target.endsWith('.json')) {
      try {
        const json = JSON.parse(fs.readFileSync(target, 'utf8'));
        if (json?.schema === 'outer-record/1') records.push({ file: target, record: json });
      } catch {
        // JSON でないファイル（結果の要約など）は飛ばす
      }
    }
  };
  for (const input of inputs) visit(path.resolve(input));
  return records;
}

// ---- 選ぶ ---------------------------------------------------------------------------------------------------

/**
 * 会話例にできる会話を選ぶ。模擬ユーザーごとに、条件を満たす中で点数が最も高いもの（同点なら新しいもの）。
 * @returns {{ selected: Map<string, { file: string, record: object }>, skipped: Array<{ file: string, persona: string, reason: string }> }}
 */
export function selectRecords(items, { pluginVersion, style = 'normal' }) {
  const selected = new Map();
  const skipped = [];
  const skip = (item, reason) => skipped.push({ file: item.file, persona: item.record.persona?.id ?? '?', reason });
  for (const item of items) {
    const r = item.record;
    if (r.heldout || item.file.split(path.sep).includes('records-heldout')) { skip(item, '見ない模擬ユーザーの会話は載せない（6.6）'); continue; }
    if (r.answerer === 'human') { skip(item, '開発者が答えた会話は載せない（6.6、6.7）'); continue; }
    if (r.arm !== 'with') { skip(item, `クリエイターの会話ではない（腕：${r.arm}）`); continue; }
    if (r.style !== style) { skip(item, `話し方が ${style} ではない（${r.style}）`); continue; }
    if (r.stopped?.reason !== 'generated') { skip(item, `生成まで進んでいない（${r.stopped?.reason ?? '不明'}）`); continue; }
    if (!r.grading?.exampleCandidate) {
      const why = !r.grading ? '採点がない' : r.grading.verdict?.failed?.length ? `採点の観点に不合格がある（${r.grading.verdict.failed.join('、')}）` : r.grading.faults?.length ? `ユーザー役の誤りがある（${r.grading.faults.map((f) => f.kind).join('、')}）` : 'Claude Haiku 5.5 の会話は使わない';
      skip(item, why);
      continue;
    }
    if (pluginVersion && r.creator?.version !== pluginVersion) { skip(item, `クリエイターの版が違う（記録 ${r.creator?.version ?? '不明'}、今 ${pluginVersion}）`); continue; }
    const id = r.persona.id;
    const current = selected.get(id);
    if (!current || r.grading.score > current.record.grading.score || (r.grading.score === current.record.grading.score && r.finishedAt > current.record.finishedAt)) selected.set(id, item);
  }
  return { selected, skipped };
}

// ---- 伏せる ---------------------------------------------------------------------------------------------------

const HIDE = Object.freeze({
  port: '（ポート番号）',
  key: '（合言葉）',
  work: '（作業フォルダ）',
  run: '（実行のフォルダ）',
  creator: '（plugin-creator のフォルダ）',
  folder: '（フォルダ）',
  tempFolder: '（一時フォルダ）',
  session: '（会話の番号）',
  runName: '（実行の名前）',
  secret: '（伏せました）',
});

const LOCAL_URL = /((?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)):(\d{2,5})/g;
const SECRET_PARAM = /([?&](?:k|key|token|secret|password|access_token)=)[A-Za-z0-9_\-.~%+/=]{6,}/g;
const GENERIC_PATH = /(?<![\w.])((?:\/(?:tmp|var\/tmp|var\/folders|private\/var|root|home\/[^\s/]+|Users\/[^\s/]+)|[A-Za-z]:\\Users\\[^\s\\]+))((?:[/\\][^\s"'`)）」』、。,;<>|*?]*)?)/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const SECRET_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const RUN_NAME = /\bouter-(?:outer-)?[a-z0-9-]+-(?:with|without|control)-[A-Za-z0-9]{6}\b/g;

/** 記録に残っている、この実行の場所（長い順）。作業フォルダの中は相対の場所にし、それ以外は名前に置き換える */
function knownPlaces(record) {
  const places = [
    [record.dirs?.work, HIDE.work],
    [record.dirs?.run, HIDE.run],
    [record.creator?.converted, HIDE.creator],
    [record.creator?.root, HIDE.creator],
  ]
    .filter(([dir]) => typeof dir === 'string' && dir.length > 1)
    .map(([dir, label]) => [dir.replace(/[/\\]+$/, ''), label]);
  return places.sort((a, b) => b[0].length - a[0].length);
}

/**
 * 会話の文字から、外に出してはいけないものを伏せる（画面の URL のポート番号と合言葉、作業フォルダなどのパス、会話の番号、鍵のような文字）。
 * 作業フォルダの中のパスは、作業フォルダからの相対の場所にする（「weekly-sales-report/README.md」）。
 * @param {string} text
 * @param {object} record 外側の EVAL の記録（場所と会話の番号を読む）
 * @param {Record<string, number>} [stats] 伏せた数を足していく
 */
export function redact(text, record, stats = {}) {
  const count = (kind, n = 1) => { stats[kind] = (stats[kind] ?? 0) + n; };
  let out = String(text ?? '');
  for (const [dir, label] of knownPlaces(record)) {
    const inside = new RegExp(`${escapeRegex(dir)}[/\\\\]`, 'g');
    out = out.replace(inside, () => { count('paths'); return label === HIDE.work ? '' : `${label}/`; });
    out = out.replace(new RegExp(escapeRegex(dir), 'g'), () => { count('paths'); return label; });
  }
  out = out.replace(LOCAL_URL, (_, host) => { count('ports'); return `${host}:${HIDE.port}`; });
  out = out.replace(SECRET_PARAM, (_, head) => { count('keys'); return `${head}${HIDE.key}`; });
  out = out.replace(GENERIC_PATH, (_, _root, rest) => {
    count('paths');
    const last = rest.split(/[/\\]/).filter(Boolean).at(-1);
    return last ? `${HIDE.folder}/${last}` : HIDE.tempFolder;
  });
  out = out.replace(RUN_NAME, () => { count('ids'); return HIDE.runName; });
  out = out.replace(UUID, () => { count('ids'); return HIDE.session; });
  out = out.replace(SECRET_TOKEN, () => { count('keys'); return HIDE.secret; });
  const session = record.sessionId;
  if (typeof session === 'string' && session.length >= 8 && out.includes(session)) {
    count('ids');
    out = out.split(session).join(HIDE.session);
  }
  return out;
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 書き出した後の Markdown に、伏せ残しがないか見る。あれば、その内容の一覧を返す（空なら問題なし）。
 * 伏せる側の見落としに気づくための、別の目の確かめ。
 */
export function findLeaks(markdown, record) {
  const found = [];
  const check = (kind, regex) => {
    for (const m of markdown.matchAll(regex)) found.push({ kind, sample: m[0].slice(0, 60) });
  };
  check('ポート番号つきのアドレス', /(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0):\d{2,5}/g);
  check('URL の合言葉', /[?&](?:k|key|token|secret|password|access_token)=(?!（)[^\s&）」』]{6,}/g);
  check('作業フォルダなどのパス', /(?<![\w.])\/(?:tmp|var|private|root|home|Users)\/[^\s]*/g);
  check('会話の番号', new RegExp(UUID.source, 'gi'));
  check('鍵のような文字', new RegExp(SECRET_TOKEN.source, 'g'));
  for (const [dir] of knownPlaces(record)) if (markdown.includes(dir)) found.push({ kind: '実行の場所', sample: dir.slice(0, 60) });
  return found;
}

// ---- 書く ---------------------------------------------------------------------------------------------------

const isBlank = (line) => line === undefined || line.trim() === '';
const isListLine = (line) => line !== undefined && /^\s*(?:[-*+]|\d+[.)])\s/.test(line);

/**
 * 引用の中に入れる文章を、GitHub の画面で崩れないように整える。
 * - 行が改行だけで続く所は、1段落につながるので、行の終わりに空白 2 つを足す（text/plain の画面では見えない）。コードの囲みの中、表、リストの行どうしは足さない。
 * - 「## 」で始まる行は、引用の中でも見出しになるので、太字にする。
 * - 文字の行の直後の「---」「===」は、前の行を見出しにするので、空行を挟む。
 */
export function prepareQuoteBody(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let fence = null;
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    const opening = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (opening && opening[1][0] === fence[0] && opening[1].length >= fence.length && line.trim() === opening[1]) fence = null;
      out.push(line);
      continue;
    }
    if (opening) {
      fence = opening[1];
      out.push(line);
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(\S.*?)(?:\s+#+)?\s*$/.exec(line);
    if (heading) line = `**${heading[1]}**`;
    const rule = /^\s{0,3}(?:-{3,}|={3,}|\*{3,}|_{3,})\s*$/.test(line);
    if (rule && out.length && !isBlank(out.at(-1))) {
      out[out.length - 1] = out.at(-1).trimEnd();
      out.push('');
    }
    const next = lines[i + 1];
    const keepsLine = !rule && !isBlank(line) && !isBlank(next) && !(isListLine(line) && isListLine(next)) && !line.trimStart().startsWith('|');
    out.push(keepsLine ? `${line.trimEnd()}  ` : line);
  }
  return out.join('\n');
}

const quote = (text) => prepareQuoteBody(text).split('\n').map((l) => (l === '' ? '>' : `> ${l}`)).join('\n');
const regexOf = (p) => new RegExp(p);
const listOf = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** 聞かれないと話さないナレッジ（引き出したかを見る対象） */
export const hiddenKnowledge = (persona) => (persona?.knowledge ?? []).filter((k) => !k.volunteer && k.id !== 'first-run' && k.markers?.asked && k.markers?.answered);

/** 聞かれないと話さないナレッジを引き出した質問（その質問が asked に、答えが answered に当たる）ごとの、答えの番号 → ナレッジの id の並び */
export function markedQuestions(record, persona) {
  const marked = new Map();
  if (!persona) return marked;
  const hidden = hiddenKnowledge(persona);
  for (const item of record.items ?? []) {
    if (item.kind !== 'user.answer') continue;
    const hits = hidden.filter((k) => listOf(k.markers.asked).some((p) => regexOf(p).test(`${item.header ?? ''} ${item.question}`)) && listOf(k.markers.answered).some((p) => regexOf(p).test(item.answer)));
    if (hits.length) marked.set(item.index, hits.map((k) => k.id));
  }
  return marked;
}

/** 聞かれないと話さないナレッジを引き出した質問の答えの番号の集まり */
export const markedAnswers = (record, persona) => new Set(markedQuestions(record, persona).keys());

const cut = (text, max) => {
  const chars = [...String(text ?? '').replace(/\s+/g, ' ').trim()];
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max).join('')}…`;
};
/**
 * 質問から、そのナレッジを引き出した部分を抜き出す。質問の頭には前置きの文が付くことが多いので、
 * ナレッジの asked に当たった一文（なければ最後の一文）を選び、長いときは当たった所の前後を残す。
 */
export function excerptOfQuestion(question, patterns, max = 70) {
  const text = String(question ?? '').replace(/\s+/g, ' ').trim();
  const sentences = text.split(/(?<=[。？！?!])/).map((x) => x.trim()).filter(Boolean);
  const regexes = patterns.map(regexOf);
  const hit = sentences.find((x) => regexes.some((r) => r.test(x)));
  const sentence = hit ?? sentences.at(-1) ?? text;
  const chars = [...sentence];
  if (chars.length <= max) return sentence;
  const at = hit ? Math.min(...regexes.map((r) => r.exec(sentence)?.index ?? Infinity)) : Infinity;
  const start = Number.isFinite(at) ? Math.max(0, Math.min([...sentence.slice(0, at)].length - 15, chars.length - max)) : 0;
  return `${start > 0 ? '…' : ''}${chars.slice(start, start + max).join('')}${start + max < chars.length ? '…' : ''}`;
}

/** ナレッジの最初の一文（長いときは切る） */
const shortFact = (k, max = 45) => cut(String(k.fact).split('。')[0], max);

const GRADE_LABELS = Object.freeze({
  'one-plugin-generated': 'プラグインが1つできた',
  stage1: 'できたプラグインが、構造の検査（1段目）に通った',
  stage2: 'できたプラグインが、部品の試験（2段目）に通った',
  'input-files-in-repo': '試験に使うファイルが、できたプラグインに入っている',
  'inner-deliverable': 'できたプラグインを実際に動かして、成果物を作らせる試験に通った',
  'all-items-heard': '決めておいた項目をすべて聞いてから、作る前の確認に進んだ',
  'no-generation-before-approval': '承認をもらう前に、プラグインを作り始めなかった',
  'hurry-options': '急いでいる合図の後に、残りの項目と3つの進め方を示した',
  'first-run': '初めてやるとしたら何をするかを聞き、想定の1回をたどってもらった',
});

/** 採点の観点 1 つを、エンドユーザーが読める言葉にする */
export function describeGrade(grade, persona) {
  if (GRADE_LABELS[grade.id]) return GRADE_LABELS[grade.id];
  const m = /^(embedded|task|not-embedded):(.+)$/.exec(grade.id);
  const k = m ? persona?.knowledge?.find((x) => x.id === m[2]) : null;
  if (m && k) {
    const what = `「${shortFact(k)}」`;
    if (m[1] === 'embedded') return `ユーザーが話した${what}が、できたプラグインに入っている`;
    if (m[1] === 'task') return `ユーザーが話した${what}が、できたプラグインの試験の課題と合否の基準に入っている`;
    return `決まりではないと言われた${what}が、決まりとして入っていない`;
  }
  if (grade.id === 'main-model') return `plugin-creator が、${grade.detail}`;
  if (grade.id === 'worker-model') return `作業を任せる部品が、${grade.detail}`;
  return grade.detail || grade.id;
}

/** 「試験の条件と点数」の行（REQ-037） */
function conditionLines({ record, persona }) {
  const style = persona?.styles?.[record.style]?.label ?? (record.style === 'normal' ? 'ふつう' : record.style);
  const lines = [
    `- 演じたユーザー：${record.persona.title}`,
    `- ユーザーの話し方：${style}`,
    `- plugin-creator のモデル：${record.models?.creator ?? '不明'}`,
    `- ユーザーを演じた AI のモデル：${record.models?.userRole ?? '不明'}`,
    '- 試験のやり方：AI が演じたユーザーと plugin-creator が会話して、できたプラグインを、あらかじめ決めた観点で採点しました。',
  ];
  const grades = record.grading?.grades;
  const score = record.grading?.score;
  if (Array.isArray(grades) && grades.length) {
    const passed = grades.filter((g) => g.ok).length;
    lines.push(`- 点数：${Number(score ?? passed / grades.length).toFixed(2)}（${grades.length} 個の観点のうち ${passed} 個に合格）`, '', '採点の観点：', '');
    for (const g of grades) lines.push(`- ${g.ok ? '合格' : '不合格'}：${describeGrade(g, persona)}`);
  } else if (typeof score === 'number') {
    lines.push(`- 点数：${score.toFixed(2)}`);
  }
  return lines;
}

/** 「聞かれないと話さないことにしていた決まり」の行（REQ-037）。引き出した質問は、★ の印を付けた質問 */
function hiddenLines({ record, persona, marked, hide }) {
  const hidden = hiddenKnowledge(persona);
  if (hidden.length === 0) return ['このユーザーには、聞かれないと話さないことにしていたことはありません。'];
  const askedAt = new Map(); // ナレッジの id → 引き出した質問の文字の並び
  for (const item of record.items ?? []) {
    if (item.kind !== 'user.answer') continue;
    for (const id of marked.get(item.index) ?? []) {
      const k = hidden.find((x) => x.id === id);
      askedAt.set(id, [...(askedAt.get(id) ?? []), excerptOfQuestion(hide(item.question), listOf(k.markers.asked))]);
    }
  }
  const lines = [
    'このユーザーは、次のことを、具体的に聞かれたときだけ話すことにしてありました（決まりではなく、たまたまそうなっていることも含みます）。「ほかに何かありますか？」のような大まかな質問には話しません。plugin-creator がこれを引き出せるかが、試験の見どころの1つです。',
    '会話の中では、これを引き出した質問の答えの前に ★ の印を付けています。',
    '',
  ];
  hidden.forEach((k, i) => {
    const asks = askedAt.get(k.id) ?? [];
    lines.push(`${i + 1}. ${String(k.fact).trim()}`);
    lines.push(asks.length ? `   - 引き出した質問：${asks.slice(0, 3).map((q) => `「${q}」`).join('、')}（★）` : '   - この会話では、引き出した質問は見つかりませんでした。');
  });
  return lines;
}

/**
 * 会話例の Markdown
 * @param {object} o
 * @param {Record<string, number>} [o.stats] 伏せた数を足していく
 */
export function renderExample({ record, persona, date, pluginVersion, stats = {} }) {
  const version = pluginVersion ?? record.creator?.version;
  if (!version) throw new ExamplesError('no_version', 'クリエイターの版が分かりません。');
  const marked = markedQuestions(record, persona);
  const hide = (text) => redact(text, record, stats);
  const lines = [
    `# 会話例：${record.persona.title}`,
    '',
    `plugin-creator の版：${version}`,
    `会話を行った日：${date ?? record.startedAt?.slice(0, 10)}`,
    '',
    NOTICE,
    '',
    '## 試験の条件と点数',
    '',
    ...conditionLines({ record, persona }),
    '',
    '## 聞かれないと話さないことにしていた決まり',
    '',
    ...hiddenLines({ record, persona, marked, hide }),
    '',
    '## 会話',
    '',
    '---',
    '',
  ];
  for (const c of record.conversation) {
    if (c.role === 'user') {
      if (c.via === 'request') {
        lines.push('**ユーザー（最初の依頼）**', '', quote(hide(c.text)), '');
      } else {
        const ids = marked.get(c.index);
        if (ids) lines.push(`★ この質問で、聞かれないと話さない決まり（上の一覧の ${ids.map((id) => `${hiddenKnowledge(persona).findIndex((k) => k.id === id) + 1} 番`).join('、')}）が出ました。`, '');
        lines.push('**ユーザー**', '', quote(hide(c.text)), '');
      }
    } else if (c.via === 'AskUserQuestion') {
      const options = (c.options ?? []).map((o) => `- ${o.label}${o.description ? `：${o.description}` : ''}`);
      lines.push('**クリエイター（選んで答える質問）**', '', quote(hide([c.question, ...(options.length ? ['', ...options] : [])].join('\n'))), '');
    } else {
      lines.push('**クリエイター**', '', quote(hide(c.text)), '');
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** 会話例の冒頭 30 行に、plugin-creator の版があるか（A3 の 1段目の見方と同じ。「クリエイターの版」の書き方は受けない） */
export function hasVersionInHead(markdown, version) {
  const head = markdown.split('\n').slice(0, EXAMPLE_HEAD_LINES).join('\n');
  const m = /plugin-creator の版[：:]\s*`?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(head);
  return m !== null && (version === undefined || m[1] === version);
}

/**
 * 記録から会話例を作って書く。
 * @param {object} o
 * @param {string[]} o.recordInputs 記録のフォルダ（またはファイル）
 * @param {string} o.outDir 会話例の置き場所
 * @param {string} o.pluginVersion 今の plugin.json の版
 * @param {(id: string) => Promise<object|null>} [o.loadPersonaById]
 */
export async function buildExamples({ recordInputs, outDir, pluginVersion, style = 'normal', clean = false, dryRun = false, loadPersonaById = defaultLoadPersona }) {
  const items = readRecords(recordInputs);
  if (items.length === 0) throw new ExamplesError('no_records', '外側の EVAL の記録（schema が outer-record/1 の JSON）が見つかりません。');
  const { selected, skipped } = selectRecords(items, { pluginVersion, style });
  const written = [];
  for (const [id, item] of selected) {
    const persona = await loadPersonaById(id);
    if (!persona) throw new ExamplesError('no_persona', `模擬ユーザー ${id} の定義を読めません。聞かれないと話さないことにしていた決まりの一覧と、試験の条件を書けないので、会話例を作りません。`);
    const redacted = {};
    const markdown = renderExample({ record: item.record, persona, pluginVersion, date: item.record.startedAt?.slice(0, 10), stats: redacted });
    if (!hasVersionInHead(markdown, pluginVersion)) throw new ExamplesError('no_version', `会話例 ${id} の冒頭に、「plugin-creator の版：x.y.z」が書かれていません。`);
    const leaks = findLeaks(markdown, item.record);
    if (leaks.length) {
      throw new ExamplesError('leak', `会話例 ${id} に、外に出してはいけないものが残っています（${leaks.slice(0, 5).map((l) => `${l.kind}：${l.sample}`).join('、')}）。伏せる処理（redact）を直してください。`);
    }
    const file = path.join(outDir, `${id}.md`);
    if (!dryRun) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(file, markdown);
    }
    written.push({ persona: id, file, record: item.file, score: item.record.grading.score, marked: [...markedAnswers(item.record, persona)].length, redacted });
  }
  const removed = [];
  if (clean && !dryRun && fs.existsSync(outDir)) {
    for (const name of fs.readdirSync(outDir)) {
      const file = path.join(outDir, name);
      if (!name.endsWith('.md') || written.some((w) => w.file === file)) continue;
      if (fs.readFileSync(file, 'utf8').includes(GENERATED_MARK)) {
        fs.rmSync(file);
        removed.push(file);
      }
    }
  }
  return { written, skipped, removed, dryRun };
}

async function defaultLoadPersona(id) {
  try {
    return (await loadPersona(path.join(PERSONAS_DIR, id))).persona;
  } catch {
    return null;
  }
}

// ---- コマンド ---------------------------------------------------------------------------------------------------

export function parseArgs(argv) {
  const out = { records: [], style: 'normal', clean: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const need = () => {
      if (i + 1 >= argv.length) throw new ExamplesError('usage', `${flag} には値が要ります。`);
      i += 1;
      return argv[i];
    };
    if (flag === '--records') out.records.push(need());
    else if (flag === '--out') out.out = need();
    else if (flag === '--style') out.style = need();
    else if (flag === '--version') out.version = need();
    else if (flag === '--clean') out.clean = true;
    else if (flag === '--dry-run') out.dryRun = true;
    else throw new ExamplesError('usage', `知らない引数です：${flag}`);
  }
  if (out.records.length === 0) throw new ExamplesError('usage', '--records（外側の EVAL の記録のフォルダ）が要ります。');
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const pluginVersion = args.version ?? JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'plugin.json'), 'utf8')).version;
    const result = await buildExamples({ recordInputs: args.records, outDir: path.resolve(args.out ?? path.join(REPO_ROOT, 'examples')), pluginVersion, style: args.style, clean: args.clean, dryRun: args.dryRun });
    console.log(JSON.stringify({ ok: true, pluginVersion, ...result, note: '最後は、会話の全文を読んで、ユーザー役の誤り（ナレッジにない決まりを作った、など）がないことを確かめてください。伏せた数（redacted）も見て、外に出してはいけないものが残っていないことを確かめてください。作ったら、README の「置きます」を「あります」に直してください。' }, null, 2));
    return result.written.length > 0 || result.dryRun ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.code ?? 'failed', message: error.message }));
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main();
}
