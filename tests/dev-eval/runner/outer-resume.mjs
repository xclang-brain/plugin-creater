// 開発者が答える外側の EVAL を、続きから始めるための部品（outer.mjs --resume。testing.md 6.7）。
// 試験の仕組みのプロセスが止まっても、実行のフォルダ（work、agent-home、copilot-home）は残る。そこから続ける。
//
// - クリエイターのセッションの番号は、agent-home/.claude/projects/<作業フォルダの印>/<番号>.jsonl（Claude Code のセッションの記録）から知る。
//   サブエージェントの記録（<番号>/subagents/）は数えない。いちばん新しく書かれたものを使う。
// - 止まったプロセスの記録（会話の記録 items と、記録のツールの呼び出し toolEvents）は、メモリーにあったので消えている。
//   セッションの記録には、メッセージ（assistant・user）がそのまま残るので、動いている会話と同じ関数（outer-record.mjs の
//   createMessageRecorder）で記録に直す（読み直し）。サブエージェントのメッセージも、動いている会話では記録するので、
//   <番号>/subagents/agent-<id>.jsonl（.meta.json の toolUseId が、Agent の呼び出しの番号）から、その Agent の結果の前に読み直す。
//   - 質問のツール（AskUserQuestion）の問いと答えは、呼び出しの入力と、結果の toolUseResult.answers から記録する。結果のない呼び出し
//     （プロセスが止まったときに答えを待っていた問い）は、問いだけを記録する。
//   - 文章の問いは、次の発言（promptSource が sdk の user のメッセージ）の前の、メインのエージェントの最後の文。
//   - 記録のツール（mcp__plugin-creator__*）の呼び出しと結果は、toolEvents の形にする（callId は replay-<n>。新しいプロセスの番号と重ならない）。
//     Claude Code の本体が呼び出しを断って、記録のツールの処理まで届かなかった呼び出し（入力を JSON として読めないなど。結果が
//     <tool_use_error> で始まる）は、動いている会話でも記録されないので、読み直さない。
//   - 前に続きから始めたときの最初の発言（<実行のフォルダ>/resumes.json の prompt と同じ文）は、答え（via: resume）として記録する。
//     そのとき待っていた問いが文章の問いなら、resumes.json の question から、その問い（creator.question-text）も記録する。
//   - Claude Code が続きから始めるときに足す行（答えのないまま止まった呼び出しの「中断」の結果〔toolDenialKind が interrupted〕と、
//     モデルが <synthetic> の「No response requested.」）は、動いている会話には流れないので、読み直さない。
// - 読み直した答えは、中継のフォルダの問いと答え（開発者の答えのただ 1 つの元）と、順に突き合わせる。合わないとき・記録が読めないときは、
//   会話にもとづく観点（全項目をヒアリングしたか、承認の前に生成しなかったか）を採点しない（outer-run.mjs）。

import fs from 'node:fs';
import path from 'node:path';

import { CREATOR_SERVER_NAME } from './creator-tools.mjs';
import { abandonedIds, listQuestionIds, readJson, readRelayAnswer, relayPaths } from './human-relay.mjs';
import { normalizeChoices } from './user-role.mjs';
import { questionItemData, textOfContent } from './outer-record.mjs';

const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const RESUMES_FILE = 'resumes.json';
/** 文章の問いで、クリエイターの発言がなかったときの問いの文（outer-run.mjs と同じ） */
export const NO_TEXT_QUESTION = '（クリエイターの発言がありませんでした）';

/** 実行のフォルダの、続きから始めるのに要る子のフォルダ */
export const runDirsOf = (runDir) => ({
  work: path.join(runDir, 'work'),
  agentHome: path.join(runDir, 'agent-home'),
  copilotHome: path.join(runDir, 'copilot-home'),
  userHome: path.join(runDir, 'user-home'),
  converted: path.join(runDir, 'converted'),
});

/**
 * クリエイターのセッションの記録を探す。agent-home/.claude/projects/<印>/ の直下の <番号>.jsonl のうち、いちばん新しく書かれたもの。
 * @returns {{ sessionId: string, file: string }}
 */
export function findSessionTranscript(agentHome, sessionId) {
  const projects = path.join(agentHome, '.claude', 'projects');
  const found = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(projects, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    throw new Error(`クリエイターのセッションの記録のフォルダがありません（${projects}）。続きから始められません。`);
  }
  for (const d of dirs) {
    const dir = path.join(projects, d.name);
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const m = e.isFile() ? SESSION_FILE.exec(e.name) : null;
      if (!m) continue;
      const file = path.join(dir, e.name);
      found.push({ sessionId: m[1], file, mtimeMs: fs.statSync(file).mtimeMs });
    }
  }
  if (sessionId) {
    const hit = found.find((f) => f.sessionId === sessionId);
    if (!hit) throw new Error(`クリエイターのセッション ${sessionId} の記録がありません（${projects}）。`);
    return { sessionId: hit.sessionId, file: hit.file };
  }
  if (found.length === 0) throw new Error(`クリエイターのセッションの記録（<番号>.jsonl）がありません（${projects}）。続きから始められません。`);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
  return { sessionId: found[0].sessionId, file: found[0].file };
}

/** 前に続きから始めた記録（<実行のフォルダ>/resumes.json）。ないときは空 */
export function readResumes(runDir) {
  const list = readJson(path.join(runDir, RESUMES_FILE));
  return Array.isArray(list) ? list : [];
}

export function writeResumes(runDir, list) {
  const file = path.join(runDir, RESUMES_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** JSONL を読む。読めない行は、最後の行（書きかけ）なら warnings、それ以外は problems に入れて飛ばす */
function readJsonl(file, problems, warnings) {
  const raw = fs.readFileSync(file, 'utf8').split('\n');
  const lines = [];
  raw.forEach((text, n) => {
    if (!text.trim()) return;
    try {
      lines.push(JSON.parse(text));
    } catch {
      const last = raw.slice(n + 1).every((t) => !t.trim());
      (last ? warnings : problems).push(`${path.basename(file)} の ${n + 1} 行目を読めない${last ? '（最後の書きかけの行）' : ''}`);
    }
  });
  return lines;
}

/** サブエージェントの記録の一覧。Agent の呼び出しの番号（.meta.json の toolUseId）と、エージェントの番号から引く */
function subagentFilesOf(transcriptFile) {
  const dir = path.join(transcriptFile.replace(/\.jsonl$/, ''), 'subagents');
  const byToolUseId = new Map();
  const byAgentId = new Map();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { byToolUseId, byAgentId };
  }
  for (const name of names) {
    const m = /^agent-(.+)\.jsonl$/.exec(name);
    if (!m) continue;
    const entry = { agentId: m[1], file: path.join(dir, name) };
    byAgentId.set(m[1], entry);
    const meta = readJson(path.join(dir, `agent-${m[1]}.meta.json`));
    if (typeof meta?.toolUseId === 'string') byToolUseId.set(meta.toolUseId, entry);
  }
  return { byToolUseId, byAgentId };
}

/** Claude Code が続きから始めるときに足す行か（動いている会話の SDK のメッセージには流れない）。API の誤りの知らせ（isApiErrorMessage）は流れるので除かない */
export function isResumeSynthetic(line) {
  if (line?.type === 'assistant') return line.message?.model === '<synthetic>' && line.isApiErrorMessage !== true;
  if (line?.type === 'user') return line.toolDenialKind === 'interrupted' || (typeof line.toolUseResult === 'string' && line.toolUseResult.startsWith('[Tool call interrupted'));
  return false;
}

/** Claude Code の本体が、ツールの処理を動かす前に断った結果か（入力の誤りなど。MCP のツールの処理が返した断りには付かない） */
const rejectedBeforeCall = (c) => textOfContent(c?.content).trimStart().startsWith('<tool_use_error>');

const toolResultsOf = (line) => (Array.isArray(line.message?.content) ? line.message.content.filter((c) => c?.type === 'tool_result') : []);
const timeOf = (line) => {
  const t = Date.parse(line.timestamp ?? '');
  return Number.isFinite(t) ? t : undefined;
};

/**
 * セッションの記録を、会話の記録（recorder の items）と記録のツールの呼び出し（toolEvents）に読み直す。
 * @param {object} args
 * @param {string} args.file メインのセッションの記録
 * @param {ReturnType<import('./outer-record.mjs').createRecorder>} args.recorder
 * @param {ReturnType<import('./outer-record.mjs').createMessageRecorder>} args.messageRecorder
 * @param {Array<{ prompt: string, question?: { via: string, question: string, header?: string } }>} [args.resumes] 前に続きから始めた記録（resumes.json）。
 *   prompt はそのときの最初の発言、question はそのとき待っていた問い
 * @param {string} [args.serverName] 記録のツールの MCP サーバーの名前
 * @returns {{ request: string|null, turns: number, lastText: string, askGroups: number, lastCost: number|null, toolEvents: Array, pendingAsks: Array, problems: string[], warnings: string[], counts: object }}
 *   lastText は最後の手番のメインのエージェントの最後の文、askGroups は質問のツールの呼び出しの数（動いている会話の番号の続きにする）
 */
export function replayTranscript({ file, recorder, messageRecorder, resumes = [], serverName = CREATOR_SERVER_NAME }) {
  const problems = [];
  const warnings = [];
  const prefix = `mcp__${serverName}__`;
  const mainLines = readJsonl(file, problems, warnings);
  const subFiles = subagentFilesOf(file);
  const toolEvents = [];
  const pendingAsks = []; // 結果のない質問のツールの問い（止まったときに答えを待っていた問い）
  const uses = new Map(); // tool_use の番号 → { name, owner, agentId, done }
  const results = new Map(); // tool_use の番号 → 結果の行（toolUseResult を見る）
  const callIds = new Map();
  const replayedAgents = new Set();
  const counts = { lines: mainLines.length, prompts: 0, askQuestions: 0, askAnswers: 0, textQuestions: 0, resumeAnswers: 0, toolUses: 0, creatorToolCalls: 0, rejectedCreatorToolCalls: 0, syntheticLines: 0, subagents: 0, subagentLines: 0 };
  let callCounter = 0;
  let request = null;
  let turn = 0;
  let lastText = '';
  let lastCost = null;
  let answerIndex = 0;
  let askGroup = 0;
  const seen = new Set();

  const collectResults = (lines) => {
    for (const line of lines) if (line.type === 'user' && !isResumeSynthetic(line)) for (const c of toolResultsOf(line)) if (!results.has(c.tool_use_id)) results.set(c.tool_use_id, line);
  };
  collectResults(mainLines);

  const onAssistant = (line, owner, agentId) => {
    const at = timeOf(line);
    messageRecorder.handle({ type: 'assistant', message: line.message, parent_tool_use_id: owner === 'main' ? null : owner }, { turn, at, onText: (text) => { lastText = text; } });
    for (const c of line.message?.content ?? []) {
      if (c?.type !== 'tool_use') continue;
      counts.toolUses += 1;
      uses.set(c.id, { name: c.name, owner, agentId, done: false });
      if (typeof c.name === 'string' && c.name.startsWith(prefix)) {
        // 処理まで届かなかった呼び出しは、記録のツールの部品が記録しない（動いている会話と同じにする）
        const result = toolResultsOf(results.get(c.id) ?? {}).find((x) => x.tool_use_id === c.id);
        if ((result && rejectedBeforeCall(result)) || Object.hasOwn(c.input ?? {}, '__unparsedToolInput')) {
          counts.rejectedCreatorToolCalls += 1;
          continue;
        }
        callCounter += 1;
        const callId = `replay-${callCounter}`;
        callIds.set(c.id, callId);
        counts.creatorToolCalls += 1;
        toolEvents.push({ at: at ?? null, type: 'tool.call', callId, tool: c.name.slice(prefix.length), args: c.input ?? {}, toolUseId: c.id, agentId, seq: recorder.next() });
      }
      if (c.name === 'AskUserQuestion') {
        // 動いている会話では、答えを受けた側（outer-run.mjs の onQuestion）が、問いの欄ごとに問いと答えを記録する
        askGroup += 1;
        const questions = Array.isArray(c.input?.questions) ? c.input.questions : [];
        const resultLine = results.get(c.id);
        const answers = resultLine?.toolUseResult?.answers;
        for (const q of questions) {
          const data = questionItemData(q, askGroup, questions.length);
          recorder.add('creator.question', { ...data, ...(at === undefined ? {} : { at }) });
          counts.askQuestions += 1;
          const answer = answers && typeof answers[q.question] === 'string' ? answers[q.question] : null;
          if (answer === null) {
            // 続きから始めたときに Claude Code が足す「中断」の結果は、上で除いている。それ以外で答えのない結果は、知らせる
            if (resultLine) warnings.push(`質問のツールの問い「${String(q.question).slice(0, 30)}」の結果に、答えがない`);
            pendingAsks.push({ toolUseId: c.id, header: data.header, question: data.question });
            continue;
          }
          const answerAt = timeOf(resultLine);
          recorder.add('user.answer', { index: answerIndex, via: 'AskUserQuestion', question: q.question, header: data.header, choices: normalizeChoices(data.options), answer, rawAnswer: answer, signal: false, ...(answerAt === undefined ? {} : { at: answerAt }) });
          answerIndex += 1;
          counts.askAnswers += 1;
        }
      }
    }
  };

  const replaySubagent = (toolUseId, resultLine) => {
    if (replayedAgents.has(toolUseId)) return;
    replayedAgents.add(toolUseId);
    const agentId = resultLine?.toolUseResult?.agentId;
    const entry = subFiles.byToolUseId.get(toolUseId) ?? (typeof agentId === 'string' ? subFiles.byAgentId.get(agentId) : undefined);
    if (!entry) {
      problems.push(`サブエージェント（Agent の呼び出し ${toolUseId}）の記録がない`);
      return;
    }
    counts.subagents += 1;
    const lines = readJsonl(entry.file, problems, warnings);
    collectResults(lines);
    for (const line of lines) {
      if (line.uuid && seen.has(`${entry.agentId}:${line.uuid}`)) continue;
      if (line.uuid) seen.add(`${entry.agentId}:${line.uuid}`);
      if (isResumeSynthetic(line)) { counts.syntheticLines += 1; continue; }
      if (line.type === 'assistant') { counts.subagentLines += 1; onAssistant(line, toolUseId, entry.agentId); }
      else if (line.type === 'user' && toolResultsOf(line).length) { counts.subagentLines += 1; onToolResults(line, toolUseId); }
    }
  };

  function onToolResults(line, owner) {
    const at = timeOf(line);
    for (const c of toolResultsOf(line)) {
      const use = uses.get(c.tool_use_id);
      if (use) use.done = true;
      // サブエージェントのメッセージは、動いている会話では、Agent の呼び出しと結果の間に流れる
      if (use && (use.name === 'Agent' || use.name === 'Task')) replaySubagent(c.tool_use_id, line);
      const callId = callIds.get(c.tool_use_id);
      if (callId) toolEvents.push({ at: at ?? null, type: 'tool.result', callId, tool: use.name.slice(prefix.length), toolUseId: c.tool_use_id, isError: c.is_error === true, result: textOfContent(c.content), seq: recorder.next() });
    }
    messageRecorder.handle({ type: 'user', message: line.message, parent_tool_use_id: owner === 'main' ? null : owner }, { at });
  }

  // 発言（ユーザーが打った文）。Claude Code 2.1 の記録では promptSource が sdk。その印がない記録では、メタでも結果でもない user のメッセージ
  const hasPromptSource = mainLines.some((l) => l.type === 'user' && l.promptSource !== undefined);
  if (!hasPromptSource) warnings.push('発言の印（promptSource）がない記録なので、メタでも結果でもない user のメッセージを発言とみなした');
  const isPrompt = (l) => l.type === 'user' && !l.isMeta && !l.isSidechain && toolResultsOf(l).length === 0 && (hasPromptSource ? l.promptSource === 'sdk' : !l.isCompactSummary);

  for (const line of mainLines) {
    if (line.uuid) {
      if (seen.has(line.uuid)) continue;
      seen.add(line.uuid);
    }
    if (isResumeSynthetic(line)) counts.syntheticLines += 1;
    else if (line.type === 'cost-state' && typeof line.totalCostUSD === 'number') lastCost = line.totalCostUSD;
    else if (line.type === 'assistant' && !line.isSidechain) onAssistant(line, 'main', undefined);
    else if (line.type === 'user' && !line.isSidechain && toolResultsOf(line).length) onToolResults(line, 'main');
    else if (isPrompt(line)) {
      counts.prompts += 1;
      const at = timeOf(line);
      const stamp = at === undefined ? {} : { at };
      const text = textOfContent(line.message?.content);
      if (request === null) {
        request = text;
        turn = 1;
        recorder.add('user.request', { text, ...stamp });
        continue;
      }
      // 前の手番が終わった（結果のメッセージは記録に残らないので、終わり方と費用は分からない）
      recorder.add('turn.end', { turn, subtype: null, isError: null, text: lastText, cost: null, replayed: true, ...stamp });
      const resumed = resumes.find((x) => x?.prompt === text);
      if (resumed) {
        // そのとき待っていた問い。質問のツールなら、答えのない問い（pendingAsks）。文章の問いなら、resumes.json の question
        const pending = pendingAsks.splice(0).at(-1);
        const asked = pending ? { question: pending.question, header: pending.header } : resumeQuestionItem(recorder, resumed.question, turn, stamp);
        recorder.add('user.answer', { index: null, via: 'resume', question: asked.question, header: asked.header, choices: [], answer: text, rawAnswer: text, signal: false, ...stamp });
        counts.resumeAnswers += 1;
      } else {
        const question = lastText.trim() || NO_TEXT_QUESTION;
        recorder.add('creator.question-text', { text: question, turn, ...stamp });
        recorder.add('user.answer', { index: answerIndex, via: 'text', question, header: '', choices: [], answer: text, rawAnswer: text, signal: false, ...stamp });
        answerIndex += 1;
        counts.textQuestions += 1;
      }
      turn += 1;
      lastText = '';
    }
  }
  // 結果のないまま止まった Agent の呼び出しも、サブエージェントの仕事は記録する（動いている会話では、流れた分は記録していた）
  for (const [id, use] of uses) {
    if (!use.done && (use.name === 'Agent' || use.name === 'Task') && use.owner === 'main') replaySubagent(id, null);
  }
  const dangling = [...uses.entries()].filter(([, u]) => !u.done && u.name !== 'AskUserQuestion').map(([id, u]) => `${u.name}（${id}）`);
  if (dangling.length) warnings.push(`結果のないまま止まったツールの呼び出し：${dangling.join('、')}`);
  if (request === null) problems.push('最初の依頼の文（発言）が、セッションの記録にない');
  return { request, turns: turn, lastText, askGroups: askGroup, lastCost, toolEvents, pendingAsks, problems, warnings, counts: { ...counts, items: recorder.items.length, toolEvents: toolEvents.length, pendingAsks: pendingAsks.length } };
}

/**
 * 続きから始めたときに待っていた問い（質問のツールの答えのない問いがないとき）を記録し、答えに書く問いの文と見出しを返す。
 * 文章の問いなら、その問い（creator.question-text）を記録する（動いている会話では、答えを待つ前に記録していた）。
 * @param {ReturnType<import('./outer-record.mjs').createRecorder>} recorder
 * @param {{ via: string, question: string, header?: string }|null|undefined} question
 * @param {number} turn
 * @param {object} [stamp] 記録の時刻（{ at }）
 */
export function resumeQuestionItem(recorder, question, turn, stamp = {}) {
  if (!question || typeof question.question !== 'string') return { question: '', header: '' };
  if (question.via === 'text') recorder.add('creator.question-text', { text: question.question, turn, ...stamp });
  return { question: question.question, header: question.header ?? '' };
}

/**
 * 止まったときに待っていた問い（中継のフォルダの、待たない印を置いた問いのうち最後のもの）。続きの最初の発言は、この問いへの答え
 * @returns {{ id: string, via: string, question: string, header: string }|null}
 */
export function abandonedQuestionOf(relayDir, abandoned = []) {
  for (const id of [...abandoned].sort().reverse()) {
    const q = readJson(path.join(relayPaths(relayDir).questions, `${id}.json`));
    if (q && typeof q.question === 'string') return { id, via: q.via ?? 'text', question: q.question, header: q.header ?? '' };
  }
  return null;
}

/**
 * 読み直した答えを、中継のフォルダの問いと答えに、順に突き合わせる（答えの道すじ、問いの文、答えの文が同じか）。
 * 続きから始めたときの最初の発言（via: resume）は、中継を通らないので除く。待たない印のある問いと、答えのない問いも除く。
 * @returns {{ ok: boolean, compared: number, relayAnswered: number, replayedAnswers: number, unanswered: string[], abandoned: string[], problems: string[] }}
 */
export function checkReplayAgainstRelay({ items, relayDir }) {
  const abandoned = new Set(abandonedIds(relayDir));
  const relay = listQuestionIds(relayDir).map((id) => ({ id, q: readJson(path.join(relayPaths(relayDir).questions, `${id}.json`)), answer: abandoned.has(id) ? null : readRelayAnswer(relayDir, id) }));
  const answered = relay.filter((r) => r.answer !== null);
  const replayed = items.filter((i) => i.kind === 'user.answer' && i.via !== 'resume');
  const problems = [];
  const n = Math.max(answered.length, replayed.length);
  for (let k = 0; k < n; k += 1) {
    const r = answered[k];
    const a = replayed[k];
    if (!r) { problems.push(`読み直した ${k + 1} 番目の答え（${a.via}）が、中継のフォルダにない`); continue; }
    if (!a) { problems.push(`中継の問い ${r.id} の答えが、セッションの記録にない（クリエイターに届いていない見込み）`); continue; }
    const diff = [];
    if (r.q?.via !== a.via) diff.push(`道すじ（${r.q?.via} と ${a.via}）`);
    if (r.q?.question !== a.question) diff.push('問いの文');
    if (r.answer !== a.answer) diff.push('答えの文');
    if (diff.length) problems.push(`中継の問い ${r.id} と、読み直した ${k + 1} 番目の答えで、${diff.join('・')}が違う`);
  }
  return {
    ok: problems.length === 0,
    compared: Math.min(answered.length, replayed.length),
    relayAnswered: answered.length,
    replayedAnswers: replayed.length,
    unanswered: relay.filter((r) => r.answer === null && !abandoned.has(r.id)).map((r) => r.id),
    abandoned: [...abandoned],
    problems,
  };
}
