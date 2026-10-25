// 外側の EVAL の採点（testing.md 6.5）と、ナレッジごとの記録（6.3）。会話の記録と、できた生成プラグインから、機械的に見る。
// 実際のモデルは使わない（純粋な関数と、ファイルの読み込みだけ）。
//
// 採点の観点（grades の id → 要件）
//   one-plugin-generated          生成プラグインが 1 つできた
//   stage1 / stage2               1・2段目の試験に通る（REQ-039）
//   embedded:<ナレッジ>           ナレッジが組み込まれた（markers.embedded にすべて当たる）。聞かれないと話さないナレッジを含む
//   not-embedded:<ナレッジ>       「違う」「たまたま」の決まりが入っていない（markers.excluded に 1 つも当たらない。REQ-017）
//   task:<ナレッジ>               EVAL の課題と合否の基準が、ナレッジの言葉を含む（markers.task にすべて当たる。REQ-038）
//   input-files-in-repo           role が input の示すファイルが、同じ中身で生成プラグインに入っている（REQ-038）
//   inner-deliverable             内側の EVAL の結果（プラグインありのスコアが基準以上）
//   all-items-heard               全項目をヒアリングした（REQ-015）
//   no-generation-before-approval 承認の前に生成しなかった（REQ-020）
//   hurry-options                 急ぐ合図の後に、残りの項目と 3 つの進め方を示す問いがある（REQ-015）
//   first-run                     まだやったことのない作業で、想定の 1 回をたどった（REQ-016）
//   main-model                    メインのエージェントが、指定のモデルで動いた（REQ-045。腕 with だけ）
//   worker-model                  作業エージェントが、費用の低いモデルで動いた（REQ-046。腕 with で、生成プラグインができたときだけ）
// 採点とは別に、設計書（testing.md 6.5）が「記録する」とした数を数える（countRecorded。合否には入れない）：
//   問いの数、1 回の質問のツールの呼び出しの問いの欄の数、保留の項目と AI の判断の数、記録のツールが断った回数とその後に直したか。
// 合格に求めること（6.5 の表）：思考力の高いモデルは「上のすべて」、Claude Haiku 5.5 は all-items-heard と no-generation-before-approval の 2 点。
// 開発者が答えたとき（answerer が human。testing.md 6.7）：ナレッジの一覧（persona.knowledge）が空なので、ナレッジにもとづく観点は出ない。
//   ユーザー役の誤りは確かめず、会話例の候補にしない。内側の EVAL の結果は、呼ぶ側が渡さない（点数に入れず、別に示す）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ITEMS } from '../../../com.github.copilot/extensions/plugin-creator/names.mjs';
import { INSTRUCTION_WORDS } from './user-role.mjs';

// ---- 決まった値 -------------------------------------------------------------------------------------

/** Claude Haiku 5.5 に求める観点（testing.md 6.5 の表） */
export const HAIKU_REQUIRED = Object.freeze(['all-items-heard', 'no-generation-before-approval']);

/** 内側の EVAL のスコアがこれ以上なら合格（プラグインありで、基準がすべて合格） */
export const INNER_PASS_SCORE = 1;

/** 状態を変える記録のツール。断る（失敗の結果を返す）ことがある（hearing.md 7.5） */
export const RECORD_TOOLS = Object.freeze(['progress', 'record', 'confirm']);

const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv']);
const SKIP_PREFIXES = ['tests/results/'];
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const KNOWLEDGE_LIST = 'tests/knowledge.json';
const DRAFT_TASK_SUFFIX = '.plugin-creator-work/draft/task.json';

// ---- 小さな道具 -------------------------------------------------------------------------------------

const toList = (value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);
const regexOf = (pattern) => new RegExp(pattern);
export const matchesAll = (patterns, text) => toList(patterns).every((p) => regexOf(p).test(text));
export const matchesAny = (patterns, text) => toList(patterns).some((p) => regexOf(p).test(text));

export function sha256OfBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** 抜き書きと答えを比べるための正規化（空白と、句読点・かぎ括弧の違いを無視する） */
export function normalizeQuote(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .replace(/[「」『』"'“”‘’、。,.，．・]/gu, '');
}

/** 抜き書きが、答えのどれかの中にあるか。「…」「...」で区切った断片は、すべてが同じ答えの中にあればよい */
export function quoteFound(quote, answers) {
  const parts = String(quote ?? '')
    .split(/…|\.\.\.|⋯/u)
    .map(normalizeQuote)
    .filter((p) => p.length > 0);
  if (parts.length === 0) return false;
  return answers.some((answer) => {
    const text = normalizeQuote(answer);
    return parts.every((p) => text.includes(p));
  });
}

// ---- 生成プラグインのファイル --------------------------------------------------------------------------------

/**
 * 生成プラグインのフォルダの中のファイルを読む。
 * @returns {Array<{ rel: string, size: number, sha256: string, text: string | null }>} text は文字のファイルだけ
 */
export function collectGeneratedFiles(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (SKIP_PREFIXES.some((p) => `${rel}/`.startsWith(p))) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (SKIP_PREFIXES.some((p) => rel.startsWith(p))) continue;
        const buffer = fs.readFileSync(full);
        const isText = buffer.length <= MAX_TEXT_BYTES && !buffer.subarray(0, 8192).includes(0);
        files.push({ rel, size: buffer.length, sha256: sha256OfBuffer(buffer), text: isText ? buffer.toString('utf8') : null });
      }
    }
  };
  walk(dir);
  return files;
}

/** 模擬ユーザーの示すファイルの sha256（元のファイルから） */
export function personaFileHashes(personaFiles) {
  return personaFiles.map((f) => ({ ...f, sha256: sha256OfBuffer(fs.readFileSync(f.src)) }));
}

const isInputCopy = (rel) => /(^|\/)tests\/eval\/[^/]+\/inputs\//.test(rel);

/** 見る範囲（personas/FORMAT.md 2.2 の markers）。入力のファイルの写しは、組み込みの証拠にしない */
export function scopes(generatedFiles, personaFileList) {
  const inputHashes = new Set(personaFileList.map((f) => f.sha256));
  const texts = (predicate) =>
    generatedFiles
      .filter((f) => f.text !== null && !inputHashes.has(f.sha256) && !isInputCopy(f.rel) && predicate(f.rel))
      .map((f) => f.text)
      .join('\n');
  return {
    // 組み込み：ナレッジの一覧そのもの（tests/knowledge.json）は、ナレッジが記録されただけの印なので、証拠にしない
    embedded: texts((rel) => rel !== KNOWLEDGE_LIST),
    // 入ってはいけないもの：一覧も含める（外したナレッジは一覧に入らないはずなので、入っていれば誤り）
    excluded: texts(() => true),
    // EVAL の課題と合否の基準のファイル
    task: generatedFiles
      .filter((f) => f.text !== null && !isInputCopy(f.rel) && (/(^|\/)tests\/eval\/[^/]+\/eval\.json$/.test(f.rel) || /(^|\/)task\.json$/.test(f.rel)))
      .map((f) => f.text)
      .join('\n'),
  };
}

// ---- 会話の記録から ---------------------------------------------------------------------------------------

/** 会話の記録（items）から、問いと答えの組を取り出す */
export function exchangesOf(items) {
  return items
    .filter((i) => i.kind === 'user.answer')
    .map((i) => ({
      seq: i.seq,
      index: i.index,
      via: i.via,
      question: i.question,
      header: i.header ?? '',
      choices: i.choices ?? [],
      answer: i.answer,
      signal: Boolean(i.signal),
    }));
}

const questionTextOf = (e) => `${e.header} ${e.question}`.trim();

/** 記録のツールの呼び出しと結果を組にする */
export function pairToolEvents(toolEvents) {
  const calls = new Map();
  const pairs = [];
  for (const e of toolEvents) {
    if (e.type === 'tool.call') calls.set(e.callId, { call: e, result: null });
    else if (e.type === 'tool.result' && calls.has(e.callId)) calls.get(e.callId).result = e;
  }
  for (const p of calls.values()) pairs.push(p);
  return pairs.sort((a, b) => a.call.seq - b.call.seq);
}

const succeeded = (pair) => pair.result !== null && pair.result.isError === false;

// ---- ナレッジごとの記録 ---------------------------------------------------------------------------------------

/**
 * ナレッジごとに、聞いたか・答えたか・組み込まれたか（testing.md 6.3）。
 * 正しくない型の見分けは、最後に会話を読んで確かめる。
 */
export function knowledgeTrace({ persona, exchanges, scope }) {
  return persona.knowledge.map((k) => {
    const m = k.markers ?? {};
    const asked = exchanges.some((e) => matchesAny(m.asked, questionTextOf(e)));
    const answered = exchanges.some((e) => matchesAny(m.answered, e.answer));
    // 聞かれずに話した：隠すべきナレッジを、その話題でない質問に答えて話した（ユーザー役の誤り。FORMAT.md 5章）。
    // markers.leak は大まかな質問への答えを見る言葉（ユーザー役の試験用）で、自分から話すほかのナレッジの文にも出うるので、ここでは使わない
    const unprompted = !k.volunteer && exchanges.some((e) => matchesAny(m.answered, e.answer) && !matchesAny(m.asked, questionTextOf(e)));
    const leaked = unprompted;
    const embedded = toList(m.embedded).length ? matchesAll(m.embedded, scope.embedded) : null;
    const excludedHit = toList(m.excluded).length ? matchesAny(m.excluded, scope.excluded) : null;
    const taskIncluded = toList(m.task).length ? matchesAll(m.task, scope.task) : null;
    let verdict;
    if (k.id === 'first-run') verdict = asked ? 'ok' : 'not-asked';
    else if (embedded === true && excludedHit !== true) verdict = 'ok';
    else if (embedded === null && excludedHit === false) verdict = 'ok';
    else if (excludedHit === true) verdict = 'wrongly-embedded';
    else if (answered) verdict = 'not-written';
    else if (asked) verdict = 'not-answered';
    else verdict = 'not-asked';
    return {
      id: k.id,
      volunteer: k.volunteer,
      kind: k.file?.kind ?? null,
      asked,
      answered,
      embedded,
      excludedHit,
      taskIncluded,
      unprompted,
      leaked,
      verdict,
    };
  });
}

/** ユーザー役の誤り（6.6 の会話例の選び方で除く）：聞かれていないのに隠すべきナレッジを話した、自分への指示のことを話した */
export function userRoleFaults({ exchanges, trace }) {
  const faults = [];
  for (const t of trace) if (t.leaked) faults.push({ kind: 'leaked', knowledge: t.id });
  for (const e of exchanges) {
    const hit = INSTRUCTION_WORDS.exec(e.answer);
    if (hit) faults.push({ kind: 'instruction-words', answerIndex: e.index, match: hit[0] });
  }
  return faults;
}

// ---- 6.5 の観点 -----------------------------------------------------------------------------------------------

function requiredItems(state) {
  return ITEMS.filter((i) => !i.computed && (!i.rebuildOnly || state?.rebuild));
}

/** 全項目をヒアリングしたか（REQ-015） */
export function gradeAllItemsHeard({ state, items, toolEvents }) {
  const problems = [];
  const answerItems = items.filter((i) => i.kind === 'user.answer');
  const pairs = pairToolEvents(toolEvents).filter((p) => p.call.tool === 'progress' && succeeded(p));
  if (!state) return { ok: false, detail: '記録（state.json）がない' };

  // 1. 生成前の確認に進むまでに、未着手の項目がなくなっている（最後の記録で見る）
  const todo = requiredItems(state).filter((i) => (state.items?.[i.key]?.status ?? 'todo') === 'todo').map((i) => i.name);
  if (todo.length) problems.push(`未着手の項目が残っている：${todo.join('、')}`);

  // 2. 未着手から状態を変えたときの抜き書きが、それより前の答えの中にある
  const changed = new Set();
  for (const { call } of pairs) {
    for (const entry of call.args?.items ?? []) {
      if (!entry?.item || changed.has(entry.item)) continue;
      if (entry.status === '未着手') continue;
      changed.add(entry.item);
      const before = answerItems.filter((a) => a.seq < call.seq).map((a) => a.answer);
      if (!quoteFound(entry.quote, before)) problems.push(`項目「${entry.item}」の抜き書き「${String(entry.quote).slice(0, 40)}」が、それより前の答えにない`);
    }
  }
  return { ok: problems.length === 0, detail: problems.join(' / ') || `${changed.size} 項目の抜き書きが、答えの中にあった` };
}

/** 承認の前に生成しなかったか（REQ-020） */
export function gradeNoGenerationBeforeApproval({ items, toolEvents }) {
  const problems = [];
  const pairs = pairToolEvents(toolEvents).filter((p) => p.call.tool === 'progress' && succeeded(p));
  const approval = pairs.find((p) => p.call.args?.stage === '生成');
  const uses = items.filter((i) => i.kind === 'tool.use');
  const isScaffoldBuild = (u) => u.name === 'Bash' && /scaffold\.py['"]?\s+build/.test(String(u.input?.command ?? ''));
  const isWrite = (u) => ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(u.name);
  const normalizePath = (p) => String(p ?? '').split('\\').join('/');

  if (!approval) {
    const built = uses.filter(isScaffoldBuild);
    if (built.length) problems.push('段階を「生成」に進める記録がないまま、組み立てのスクリプトが動いた');
    return { ok: problems.length === 0, detail: problems.join(' / ') || '承認の記録がない（まだ生成していない）', approved: false };
  }
  const at = approval.call.seq;
  const answersBefore = items.filter((i) => i.kind === 'user.answer' && i.via === 'AskUserQuestion' && i.seq < at);
  const last = answersBefore.at(-1);
  if (!last) problems.push('承認の記録の前に、質問のツールへの答えがない');
  else if (!quoteFound(approval.call.args?.approvalQuote, [last.answer])) problems.push(`承認の抜き書きが、直前の答え（質問のツールへの答え）の中にない`);
  for (const u of uses.filter((x) => x.seq < at && isScaffoldBuild(x))) problems.push(`承認の前に組み立てのスクリプトが動いた：${String(u.input.command).slice(0, 80)}`);
  for (const u of uses.filter((x) => x.seq < at && isWrite(x))) {
    const target = normalizePath(u.input?.file_path ?? u.input?.notebook_path ?? u.input?.path);
    if (!target.endsWith(DRAFT_TASK_SUFFIX)) problems.push(`承認の前に、作業の定義の案のほかのファイルが書かれた：${target}`);
  }
  return { ok: problems.length === 0, detail: problems.join(' / ') || '承認の抜き書きが直前の答えにあり、それより前の書き込みは作業の定義の案だけ', approved: true };
}

/** 急ぐ合図の後に、残りの項目と 3 つの進め方を示す問いがあるか（REQ-015） */
export function gradeHurryOptions({ items, userSignals }) {
  const signal = userSignals[0];
  if (!signal) return null;
  const signalAnswer = items.find((i) => i.kind === 'user.answer' && i.index === signal.answerIndex);
  const from = signalAnswer?.seq ?? 0;
  const after = items.filter((i) => i.kind === 'creator.question' && i.seq > from);
  const text = (q) => `${q.header ?? ''} ${q.question} ${(q.options ?? []).map((o) => `${o.label} ${o.description ?? ''}`).join(' ')}`;
  const hit = after.find((q) => /残り/.test(text(q)) && /このまま続ける/.test(text(q)) && /手早く/.test(text(q)) && /やめて|後で続ける/.test(text(q)));
  return { ok: Boolean(hit), detail: hit ? '合図の後に、残りの項目と 3 つの進め方の問いがあった' : '合図の後に、残りの項目と 3 つの進め方（このまま続ける・残りを手早く聞く・ここでやめて後で続ける）を示す問いがない' };
}

/** まだやったことのない作業で、想定の 1 回をたどったか（REQ-016） */
export function gradeFirstRun({ persona, exchanges, toolEvents }) {
  const firstRun = persona.knowledge.find((k) => k.id === 'first-run');
  const pattern = firstRun?.markers?.asked;
  if (!pattern) return { ok: false, detail: '模擬ユーザーに first-run の asked がない' };
  const asked = exchanges.find((e) => matchesAny(pattern, questionTextOf(e)));
  if (!asked) return { ok: false, detail: '「初めてやるとしたら、最初に何をしますか」に当たる問いがない' };
  const walked = pairToolEvents(toolEvents).some(
    (p) => p.call.tool === 'progress' && succeeded(p) && p.call.seq > asked.seq && (p.call.args?.items ?? []).some((i) => i.item === '前回の1回' && i.status !== '未着手'),
  );
  return { ok: walked, detail: walked ? '問いの後に、想定の 1 回（項目「前回の1回」）を記録した' : '問いの後に、項目「前回の1回」を記録していない（想定の 1 回をたどっていない）' };
}

// ---- 記録する数（testing.md 6.5） -------------------------------------------------------------------------

const REFUSAL_SAMPLES = 5;

/**
 * 設計書が「記録する」とした数を、会話の記録から数える。採点の合否には入れない。
 *   questions        問いの数（質問のツールの問い ＋ 文章の問い）
 *   askToolCalls     質問のツールの呼び出しの数、1 回の呼び出しの問いの欄の数の最大、2 つ以上の欄を置いた呼び出しの数
 *                    （hearing.md 4.1 の「1 回に問いを 1 つ」が守られたかを見る。2 つ以上が 0 回なら守られた）
 *   pending          保留の項目の数と名前
 *   aiDecisions      出どころが「AI の判断（ユーザーが任せた）」のナレッジの数（外したものを除く）
 *   recordRefusals   記録のツール（progress・record・confirm）が断った回数と、その後に同じツールが成功した（直した）回数。
 *                    断りは、ツールの結果が失敗（resultType: 'failure'。MCP では isError）で返ったもの
 * @param {{ items: Array, toolEvents: Array, state: object|null }} args
 */
export function countRecorded({ items = [], toolEvents = [], state = null }) {
  const asks = items.filter((i) => i.kind === 'creator.question');
  const texts = items.filter((i) => i.kind === 'creator.question-text');
  // 1 回の呼び出しの問いの数。group がない古い記録は、問い 1 つごとを 1 回の呼び出しとして数える
  const perCall = new Map();
  asks.forEach((q, n) => perCall.set(q.group ?? `single-${n}`, (perCall.get(q.group ?? `single-${n}`) ?? 0) + 1));
  const sizes = [...perCall.values()];

  const pairs = pairToolEvents(toolEvents);
  const byTool = {};
  const samples = [];
  for (const tool of RECORD_TOOLS) {
    const mine = pairs.filter((p) => p.call.tool === tool);
    const refused = mine.filter((p) => p.result?.isError === true);
    const fixed = refused.filter((r) => mine.some((p) => p.call.seq > r.call.seq && succeeded(p)));
    byTool[tool] = { calls: mine.length, refused: refused.length, fixed: fixed.length, unfixed: refused.length - fixed.length };
    for (const r of refused) if (samples.length < REFUSAL_SAMPLES) samples.push({ tool, seq: r.call.seq, reason: String(r.result.result ?? '').slice(0, 160) });
  }
  const refusedTotal = Object.values(byTool).reduce((n, t) => n + t.refused, 0);
  const fixedTotal = Object.values(byTool).reduce((n, t) => n + t.fixed, 0);

  const pendingItems = ITEMS.filter((i) => state?.items?.[i.key]?.status === 'pending').map((i) => i.name);
  const aiDecisions = (state?.knowledge ?? []).filter((k) => k.source === 'ai_decision' && k.status !== 'dropped').length;
  return {
    questions: { total: asks.length + texts.length, askTool: asks.length, text: texts.length },
    askToolCalls: { calls: sizes.length, maxQuestionsPerCall: sizes.length ? Math.max(...sizes) : 0, callsWithMultiple: sizes.filter((n) => n >= 2).length },
    pending: { count: pendingItems.length, items: pendingItems },
    aiDecisions: { count: aiDecisions },
    recordRefusals: { total: refusedTotal, fixed: fixedTotal, unfixed: refusedTotal - fixedTotal, byTool, samples },
  };
}

// ---- モデル（REQ-045・REQ-046） -----------------------------------------------------------------------------

/** モデルの ID をそろえる（[1m] のような末尾の印と、日付の末尾を除く） */
export function normalizeModelId(id) {
  return String(id ?? '').replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
}

const WORKER_TYPE = /(^|:)worker(-[a-z0-9-]+)?$/;

/**
 * メインのモデルが指定のモデルか（REQ-045）と、作業エージェントが費用の低いモデルで動いたか（REQ-046）。
 * @param {{ requested: string, main: string[], subagents: Array<{ type: string, models: string[] }>, lowCost: string|null }} use
 *   lowCost は、置き換えた版の作業エージェントの定義の model（変換後の ID）。分からなければ null
 * @returns {Array<{ id: string, ok: boolean, detail: string, req: string }>} worker-model は、作業エージェントが動いた（または動くべきだった）ときだけ
 */
export function gradeModels({ use, generatedCount }) {
  const out = [];
  const requested = normalizeModelId(use.requested);
  const main = (use.main ?? []).map(normalizeModelId);
  const wrongMain = main.filter((m) => m !== requested);
  out.push({
    id: 'main-model',
    ok: main.length > 0 && wrongMain.length === 0,
    detail: main.length === 0 ? 'メインのエージェントのメッセージにモデルの記録がない' : wrongMain.length ? `指定は ${requested} だが、${[...new Set(wrongMain)].join('、')} でも動いた` : `指定の ${requested} で動いた`,
    req: 'REQ-045',
  });
  if (generatedCount >= 1) {
    const workers = (use.subagents ?? []).filter((a) => WORKER_TYPE.test(a.type));
    const expected = use.lowCost ? normalizeModelId(use.lowCost) : null;
    if (!expected) {
      out.push({ id: 'worker-model', ok: false, detail: '置き換えた版の作業エージェントの定義に、費用の低いモデルの指定がない', req: 'REQ-046' });
    } else if (workers.length === 0) {
      out.push({ id: 'worker-model', ok: false, detail: '生成プラグインのファイルを書く作業エージェントが動かなかった（メインのエージェントが書いた見込み）', req: 'REQ-046' });
    } else {
      const wrong = workers.flatMap((w) => (w.models.length ? w.models : ['（モデルの記録なし）'])).map(normalizeModelId).filter((m) => m !== expected);
      out.push({
        id: 'worker-model',
        ok: wrong.length === 0,
        detail: wrong.length ? `費用の低いモデルは ${expected} だが、${[...new Set(wrong)].join('、')} でも動いた` : `作業エージェント ${workers.length} 回、費用の低いモデルの ${expected} で動いた`,
        req: 'REQ-046',
      });
    }
  }
  return out;
}

// ---- 全体 -------------------------------------------------------------------------------------------------------

/**
 * 外側の EVAL の 1 回を採点する。
 * @param {object} args
 * @param {object} args.persona
 * @param {Array<{ src: string, place: string, role: string }>} args.personaFiles
 * @param {Array<object>} args.items 会話の記録（順番 seq つき）
 * @param {Array<object>} args.toolEvents 記録のツールの呼び出しと結果（seq つき）
 * @param {object|null} args.state state.json
 * @param {number} args.generatedCount 見つけた生成プラグインの数
 * @param {Array|null} args.generatedFiles 生成プラグインのファイル（1 つできたとき）
 * @param {object|null} args.stages 1・2段目の結果 { stage1: { ok }, stage2: { ok }, skipped?, reason? }
 * @param {object|null} args.inner 内側の EVAL の結果（withScore）。なければ採点に入れない
 * @param {Array} args.userSignals 急ぐ合図の位置 [{ answerIndex }]
 * @param {object|null} args.modelUse 動いたモデル { requested, main, subagents: [{ type, models }], lowCost }。腕 with で渡すと REQ-045・REQ-046 を採点する
 * @param {string} args.model クリエイターのモデルの ID
 * @param {'with'|'without'|'control'} args.arm
 * @param {'user-role'|'human'} [args.answerer] 答えた人。human（開発者が答えた。testing.md 6.7）なら、ユーザー役の誤りを確かめず、会話例の候補にしない
 */
export function gradeOuter({ persona, personaFiles, items, toolEvents, state, generatedCount, generatedFiles, stages, inner, userSignals = [], modelUse = null, model, arm = 'with', answerer = 'user-role' }) {
  const grades = [];
  const add = (id, ok, detail, req) => grades.push({ id, ok: Boolean(ok), detail: detail ?? '', ...(req ? { req } : {}) });
  const exchanges = exchangesOf(items);
  const hashed = personaFileHashes(personaFiles);
  const scope = scopes(generatedFiles ?? [], hashed);

  add('one-plugin-generated', generatedCount === 1, generatedCount === 1 ? '' : `生成プラグインが ${generatedCount} 個見つかった（1 個のはず）`);
  if (stages?.skipped) {
    add('stage1', false, stages.reason ?? '1・2段目を動かせなかった', 'REQ-039');
    add('stage2', false, stages.reason ?? '1・2段目を動かせなかった', 'REQ-039');
  } else {
    add('stage1', stages?.stage1?.ok, stages ? '' : '1・2段目を動かしていない', 'REQ-039');
    add('stage2', stages?.stage2?.ok, stages ? '' : '1・2段目を動かしていない', 'REQ-039');
  }

  const trace = knowledgeTrace({ persona, exchanges, scope });
  for (const k of persona.knowledge) {
    if (k.id === 'first-run') continue;
    const t = trace.find((x) => x.id === k.id);
    if (t.embedded !== null) add(`embedded:${k.id}`, t.embedded, `${k.volunteer ? '自分から話す' : '聞かれないと話さない'}ナレッジが組み込まれたか`, 'REQ-015');
    if (t.excludedHit !== null) add(`not-embedded:${k.id}`, !t.excludedHit, '入ってはいけない書き方が入っていない', 'REQ-017');
    if (t.taskIncluded !== null) add(`task:${k.id}`, t.taskIncluded, 'EVAL の課題と合否の基準にナレッジの言葉があるか', 'REQ-038');
  }

  const inputs = hashed.filter((f) => f.role === 'input');
  if (inputs.length) {
    const have = new Set((generatedFiles ?? []).map((f) => f.sha256));
    const missing = inputs.filter((f) => !have.has(f.sha256)).map((f) => f.place);
    add('input-files-in-repo', missing.length === 0, missing.length ? `生成プラグインに入っていない：${missing.join('、')}` : '', 'REQ-038');
  }

  if (inner) add('inner-deliverable', (inner.withScore ?? 0) >= INNER_PASS_SCORE, `プラグインありのスコア ${inner.withScore}`, 'REQ-041');

  if (arm !== 'without') {
    const heard = gradeAllItemsHeard({ state, items, toolEvents });
    add('all-items-heard', heard.ok, heard.detail, 'REQ-015');
    const approval = gradeNoGenerationBeforeApproval({ items, toolEvents });
    add('no-generation-before-approval', approval.ok, approval.detail, 'REQ-020');
    const hurry = gradeHurryOptions({ items, userSignals });
    if (hurry) add('hurry-options', hurry.ok, hurry.detail, 'REQ-015');
    if (persona.experience === 'never') {
      const first = gradeFirstRun({ persona, exchanges, toolEvents });
      add('first-run', first.ok, first.detail, 'REQ-016');
    }
  }

  if (arm === 'with' && modelUse) for (const g of gradeModels({ use: modelUse, generatedCount })) add(g.id, g.ok, g.detail, g.req);

  const human = answerer === 'human';
  const faults = human ? [] : userRoleFaults({ exchanges, trace });
  const isHaiku = /haiku/i.test(model ?? '');
  const required = isHaiku ? HAIKU_REQUIRED.filter((id) => grades.some((g) => g.id === id)) : grades.map((g) => g.id);
  const failedRequired = grades.filter((g) => required.includes(g.id) && !g.ok).map((g) => g.id);
  const score = grades.length ? grades.filter((g) => g.ok).length / grades.length : 0;
  return {
    grades,
    score,
    trace,
    faults,
    counts: countRecorded({ items, toolEvents, state }),
    verdict: { model, required, ok: failedRequired.length === 0, failed: failedRequired },
    // 会話例の候補（6.6）：採点の観点にすべて合格し、ユーザー役の誤りがない。最後は全文を読んで確かめる
    // 開発者が答えた会話は、会話例にしない（6.6）
    exampleCandidate: !human && !isHaiku && failedRequired.length === 0 && faults.length === 0,
  };
}
