import { LIMITS } from './constants.mjs';
import { baseAgentName, roleOfAgentType } from './analysis.mjs';
import { clone, summarizeText } from './util.mjs';
import { logEntry } from './log.mjs';

// 1 回の実行の状態（メモリ上）と、それを状態の全体（BLUEPRINT 3.5）の run に直す部分。

// waiting_human は、人の判断を待って手番を終えた統括（4.15）。Copilot CLI では idle で残っている
const ACTIVE_AGENT = new Set(['running', 'waiting', 'waiting_human']);
export const isActiveAgent = (rec) => ACTIVE_AGENT.has(rec.status);

function makeSlot(slot, role, label, selectedModel) {
  return {
    slot,
    role,
    label,
    status: 'standby',
    task: '',
    selectedModel: selectedModel ?? '',
    actualModel: '',
    lastActiveAt: null,
    replySummary: '',
    agentId: null,
  };
}

export function createRun(ctx, { id, settings, requestText, isAuto, startedAt }) {
  const slots = [
    makeSlot('orchestrator', 'orchestrator', '統括', settings.models.orchestrator),
    ...ctx.task.workers.map((w) => makeSlot(w.agent, 'worker', w.label, settings.models.worker)),
    makeSlot('verifier', 'verifier', '検証', settings.models.verifier),
  ];
  return {
    id,
    startedAt,
    finishedAt: null,
    sessionId: ctx.sessionId,
    cwd: ctx.cwd,
    status: 'starting',
    endReason: null,
    pendingEnd: null,
    settings,
    requestText,
    isAuto: Boolean(isAuto),
    rootId: null,
    tree: new Map(), // agentId → 木に入れたエージェント
    slots,
    iterations: [], // { n, criteria, plan, verdicts|null, agentIds, workerIds }
    outcome: null, // all_passed | max_iterations | human_ended（まとめ中に入ったとき）
    displays: {},
    files: new Map(),
    summary: null,
    finishRecorded: false,
    draftIssues: [],
    issues: [],
    entries: [],
    waits: [],
    limit: null, // 最後の利用の上限の待ち { requestId, answered, action }
    humanWait: null, // 人の判断待ちの質問 { question, askedAt, iteration, turnEnded, waitingSince, answerUnknown? }（4.15）
    humanEndOpen: false, // 人の指示で終える印を受け付けるか。人の答えが届くと開き、統括がほかのことをすると閉じる（4.15）
    refusals: {},
    stopRequested: false,
    stopAt: null,
    stopSignal: null,
    resolveStop: null,
    closeRequested: false,
    closing: false,
    unstopped: [],
    overridesTouched: false,
    startFailed: false,
  };
}

// 開始中の止めるを待ちの打ち切りに伝える Promise（4.3）
export function attachStopSignal(run) {
  run.stopSignal = new Promise((resolve) => {
    run.resolveStop = resolve;
  });
}

export function slotByName(run, name) {
  return run.slots.find((s) => s.slot === name) ?? null;
}

// エージェントの種類から、枠の名前を決める。枠のないエージェントは null。
export function slotNameForType(ctx, agentType) {
  const base = baseAgentName(agentType, ctx.pluginName);
  if (base === 'orchestrator' || base === 'verifier') return base;
  return ctx.task.workers.some((w) => w.agent === base) ? base : null;
}

export function roleForType(ctx, agentType, parentRec) {
  return roleOfAgentType(agentType, ctx.pluginName) ?? parentRec?.role ?? null;
}

// 自分か、いちばん近い上のエージェントの枠
export function slotNameOf(run, agentId) {
  const seen = new Set();
  let cur = run.tree.get(agentId);
  while (cur && !seen.has(cur.agentId)) {
    if (cur.slotName) return cur.slotName;
    seen.add(cur.agentId);
    cur = cur.parentId ? run.tree.get(cur.parentId) : null;
  }
  return null;
}

// エージェントの記録が変わったとき、枠の表示を合わせる（枠の最新のエージェントのときだけ）
export function syncSlot(run, rec) {
  if (!rec.slotName) return;
  const slot = slotByName(run, rec.slotName);
  if (!slot || slot.agentId !== rec.agentId) return;
  slot.status = rec.status;
  slot.task = rec.description ?? '';
  slot.actualModel = rec.model ?? '';
  slot.lastActiveAt = rec.lastEventAt ?? slot.lastActiveAt;
  slot.replySummary = rec.reply ? summarizeText(rec.reply, LIMITS.REPLY_SUMMARY_CHARS) : '';
}

// 今のフェーズは動いているエージェントで決める（4.5）。検証が動いていれば評価、作業なら実行、統括なら計画。
export function computePhase(run, force = false) {
  if (!force && run.status !== 'running') return null;
  let doing = false;
  let planning = false;
  for (const rec of run.tree.values()) {
    if (!isActiveAgent(rec)) continue;
    if (rec.role === 'verifier') return 'study';
    if (rec.role === 'worker') doing = true;
    if (rec.role === 'orchestrator') planning = true;
  }
  if (doing) return 'do';
  return planning ? 'plan' : null;
}

export function currentIteration(run) {
  return run.iterations.length > 0 ? run.iterations[run.iterations.length - 1] : null;
}

// ---- 人の判断待ち（4.15） ---------------------------------------------------------------------

// 質問を記録した統括が手番を終えた。実行を終えずに「人の判断待ち」にする。統括は取り消さない。
export function enterHumanWait(ctx, run, at) {
  run.status = 'waiting_human';
  run.humanWait.turnEnded = true;
  run.humanWait.waitingSince = at;
  const rec = run.tree.get(run.rootId);
  if (rec) {
    rec.status = 'waiting_human';
    rec.lastEventAt = at;
    syncSlot(run, rec);
  }
  logEntry(ctx, run, { t: 'status', at, status: 'waiting_human' });
}

// 答えが統括に届いた（または統括が動き出した）。実行中に戻す。how は記録に残す、戻ったきっかけ（answered か activity）。
export function resumeFromHumanWait(ctx, run, at, how) {
  if (run.status !== 'waiting_human') return;
  // 人の答えが届いたとみるのは、<名前>_answer で答えを送ったか、送りが時間切れだった（届いて動き出した）ときだけ。
  // ほかのきっかけで統括が動き出しても、人の指示で終える印は受け付けない（4.15）
  if (how === 'answered' || run.humanWait?.answerUnknown) run.humanEndOpen = true;
  run.status = 'running';
  run.humanWait = null;
  const rec = run.tree.get(run.rootId);
  if (rec && rec.status === 'waiting_human') {
    rec.status = 'running';
    rec.lastEventAt = at;
    syncSlot(run, rec);
  }
  logEntry(ctx, run, { t: 'status', at, status: 'running', resumed: how });
}

// 人の指示で終える印を閉じる（4.15）。答えの直後に、統括が印を付けた _review より先に、繰り返しを続けることをした。
// 次の答えが届くまで、印は受け付けない。閉じるのは、統括が _review・_issue・_finish 以外の記録のツールを呼んだとき（records.mjs）と、
// 統括を親とするエージェントが始まったとき（events.mjs）
export function closeHumanEnd(run) {
  run.humanEndOpen = false;
}

// 起票の印から、案の起票の状態を読む（4.11）
export function filingOf(ctx, runId, issueId) {
  const m = ctx.store.readMarker(runId, issueId);
  if (!m) return { state: 'none', url: null, reason: null };
  let { state } = m;
  let reason = m.reason ?? null;
  if (state === 'filing' && ctx.clock.now() - m.startedAt > LIMITS.FILING_STALE_MS) {
    state = 'unknown';
    reason ??= '起票を始めてから時間がたっても結果が分かりません。起票できたかを確かめられません。';
  }
  return { state, url: m.url ?? null, reason };
}

export function viewIssues(ctx, runId, issues) {
  return issues.map((i) => ({ id: i.id, title: i.title, body: i.body, source: i.source, filing: filingOf(ctx, runId, i.id) }));
}

export function viewEndReason(endReason) {
  if (!endReason) return null;
  const out = { kind: endReason.kind, detail: endReason.detail ?? null, unstoppable: Boolean(endReason.unstoppable) };
  if (endReason.message) out.message = endReason.message;
  return out;
}

// 状態の全体の run（BLUEPRINT 3.5）
export function viewRun(ctx, run) {
  const finished = run.status === 'finished';
  const last = currentIteration(run);
  return {
    id: run.id,
    status: run.status,
    endReason: viewEndReason(run.endReason),
    settings: clone(run.settings),
    isAuto: run.isAuto,
    phase: computePhase(run),
    iteration: last ? last.n : 0,
    maxIterations: run.settings.maxIterations,
    agents: run.slots.map((s) => ({ ...s })),
    iterations: run.iterations.map((it) => ({
      n: it.n,
      criteria: it.criteria.map((c) => ({ ...c })),
      plan: it.plan,
      verdicts: (it.verdicts ?? []).map((v) => ({ ...v })),
      agentIds: [...it.agentIds],
    })),
    displays: clone(run.displays),
    summary: run.summary,
    issues: viewIssues(ctx, run.id, finished ? run.issues : run.draftIssues),
    canFile: clone(ctx.canFile),
    unstopped: run.unstopped.map((u) => ({ ...u })),
    waits: run.waits.map((w) => ({ requestId: w.requestId, slot: w.slot, kind: w.kind, detail: clone(w.detail) })),
    humanWait: !finished && run.humanWait
      ? { question: run.humanWait.question, askedAt: run.humanWait.askedAt, iteration: run.humanWait.iteration, waiting: run.status === 'waiting_human' }
      : null,
  };
}
