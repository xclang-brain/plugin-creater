import { LIMITS } from './constants.mjs';
import { callWithTimeout, clone } from './util.mjs';
import {
  closeHumanEnd,
  currentIteration,
  enterHumanWait,
  isActiveAgent,
  resumeFromHumanWait,
  roleForType,
  slotByName,
  slotNameForType,
  slotNameOf,
  syncSlot,
} from './run.mjs';
import { roleOfAgentType } from './analysis.mjs';
import { logEntry } from './log.mjs';
import { requestClose } from './lifecycle.mjs';

// つなぎ口から届く中立のイベント（BLUEPRINT 3.1）を、実行の状態に反映する（4.4、4.5、4.14、6.1）。
// handleEvent は順番待ちの列の中で、1 件ずつ動く。

const EXTENSION_PERMISSION_KINDS = new Set(['extension-permission-access', 'extension-env-access']);

function activeRun(ctx) {
  const run = ctx.run;
  return run && run.status !== 'finished' ? run : null;
}

function logEvent(ctx, run, e, at, patch = null) {
  logEntry(ctx, run, { t: 'event', at, e: patch ? { ...e, ...patch } : e });
}

// どの実行の根でもない統括、または拒む一覧のエージェントの子を取り消す。同じ番号は 1 回だけ。
export function cancelStray(ctx, agentId) {
  ctx.deny.add(agentId);
  if (ctx.strayHandled.has(agentId)) return;
  ctx.strayHandled.add(agentId);
  ctx.queue
    .enqueue(() => callWithTimeout(ctx.clock, () => ctx.port.cancelAgent(agentId), LIMITS.CALL_TIMEOUT_MS))
    .catch(() => {});
}

function addToTree(ctx, run, e, at) {
  const parent = run.tree.get(e.parentAgentId);
  const ownRole = roleOfAgentType(e.agentType, ctx.pluginName);
  const slotName = slotNameForType(ctx, e.agentType);
  const rec = {
    agentId: e.agentId,
    parentId: e.parentAgentId,
    agentType: e.agentType ?? '',
    slotName,
    role: roleForType(ctx, e.agentType, parent),
    status: 'running',
    description: e.description ?? '',
    model: e.model ?? '',
    startedAt: at,
    lastEventAt: at,
    reply: null,
  };
  run.tree.set(e.agentId, rec);
  if (e.parentAgentId === run.rootId) closeHumanEnd(run); // 統括が作業か検証を始めた。人の指示で終える印を閉じる（4.15）
  if (slotName) {
    const slot = slotByName(run, slotName);
    slot.agentId = e.agentId;
    syncSlot(run, rec);
  }
  const it = currentIteration(run);
  if (it && (ownRole === 'worker' || ownRole === 'verifier')) {
    it.agentIds.push(e.agentId);
    if (ownRole === 'worker') it.workerIds.push(e.agentId);
  }
  if (run.status === 'stopping') ctx.deny.add(e.agentId);
  logEntry(ctx, run, { t: 'tree', at, agentIds: [e.agentId] });
}

function onAgentStarted(ctx, e, at) {
  const run = ctx.run;
  const { agentId, parentAgentId } = e;
  // どの実行の根でもない統括は、遅れて起動したもの。取り消して、拒む一覧に入れる（4.3）
  if (e.agentType === `${ctx.pluginName}:orchestrator` && !ctx.knownRoots.has(agentId)) {
    cancelStray(ctx, agentId);
    return;
  }
  if (!run || run.status === 'finished') {
    if (parentAgentId && ctx.deny.has(parentAgentId)) ctx.deny.add(agentId);
    return;
  }
  if (agentId === run.rootId) {
    const rec = run.tree.get(agentId);
    rec.status = rec.status === 'waiting' ? 'waiting' : 'running';
    rec.model = e.model ?? rec.model;
    rec.description = e.description || rec.description;
    rec.lastEventAt = at;
    syncSlot(run, rec);
    logEvent(ctx, run, e, at);
    return;
  }
  if (parentAgentId && run.tree.has(parentAgentId)) {
    addToTree(ctx, run, e, at);
    logEvent(ctx, run, e, at);
    return;
  }
  if (parentAgentId && ctx.deny.has(parentAgentId)) ctx.deny.add(agentId);
}

function onAgentConfigured(ctx, e, at) {
  const run = activeRun(ctx);
  const rec = run?.tree.get(e.agentId);
  if (!rec) return;
  if (e.model) rec.model = e.model;
  rec.lastEventAt = at;
  syncSlot(run, rec);
  logEvent(ctx, run, e, at);
}

function dropWaitsOf(run, agentId) {
  run.waits = run.waits.filter((w) => w.agentId !== agentId);
}

function onAgentEnded(ctx, e, at, kind) {
  const run = activeRun(ctx);
  const rec = run?.tree.get(e.agentId);
  if (!rec) return;
  logEvent(ctx, run, e, at);
  rec.lastEventAt = at;
  // 統括が手番を終えた（取り消し・失敗ではない）とき、人の判断を求める質問があれば、実行を終えずに待つ（4.15）。
  // 初めの手番の終わりには、終わりのイベントが 2 つ（completed と idle）届くので、待ちに入った後の終わりは見送る。
  // ただし、答えの送りが時間切れだった後の手番の終わりは、答えが届いて動いた統括の手番の終わりとみる（2 つ目のイベントは、答えより前に届くため）。
  const turnEnded = kind === 'idle' || (kind === 'completed' && !e.cancelled);
  const hw = run.humanWait;
  if (e.agentId === run.rootId && turnEnded && hw) {
    if (run.status === 'running' && !hw.turnEnded) {
      if (e.response != null) rec.reply = String(e.response);
      enterHumanWait(ctx, run, at);
      return;
    }
    if (run.status === 'waiting_human' && !hw.answerUnknown) {
      if (e.response != null) rec.reply = String(e.response);
      syncSlot(run, rec);
      return;
    }
    if (run.status === 'waiting_human') resumeFromHumanWait(ctx, run, at, 'activity');
  }
  const stopping = run.status === 'stopping';
  if (kind === 'completed') {
    if (e.response != null) rec.reply = String(e.response);
    rec.status = e.cancelled || stopping ? 'stopped' : 'completed';
  } else if (kind === 'failed') {
    rec.error = e.error ?? '';
    rec.status = stopping ? 'stopped' : 'failed';
  } else {
    // 手番を終えて待ちに入った。2回目からの手番の終わりは、これだけが届き、最後の返事もここに付く（11章 #19）
    if (e.response != null) rec.reply = String(e.response);
    if (isActiveAgent(rec)) rec.status = 'completed';
  }
  dropWaitsOf(run, e.agentId);
  syncSlot(run, rec);
  if (e.agentId !== run.rootId) return;
  const cause = kind === 'failed' ? 'failed' : kind === 'completed' && e.cancelled ? 'cancelled' : 'ended';
  rootEnded(ctx, run, cause, kind === 'failed' ? String(e.error ?? '') : '');
}

// 統括が終わった（4.8、6.1）。終わった理由を決めて、実行を終える。
function rootEnded(ctx, run, cause, message) {
  if (run.closeRequested || run.closing || run.status === 'stopping' || run.status === 'finished') return;
  if (run.status === 'summarizing') {
    // まとめ中は、きっかけによらず、合否の記録で決める。まとめの記録がなければ、課題に入る（4.10）
    run.pendingEnd = { kind: run.outcome, detail: null };
    run.rootEndCause = { cause, message, creditLimit: Boolean(run.limit && (!run.limit.answered || run.limit.action === 'cancel')) };
  } else {
    let detail;
    const creditLimit = run.limit && (!run.limit.answered || run.limit.action === 'cancel');
    if (creditLimit) detail = 'credit_limit';
    else if (cause === 'failed') detail = 'orchestrator_failed';
    else if (cause === 'cancelled') detail = 'chat_interrupted';
    else detail = 'orchestrator_ended';
    run.pendingEnd = { kind: 'aborted', detail, ...(message ? { message } : {}) };
  }
  requestClose(ctx, run, { userStop: false });
}

function onToolEvent(ctx, e, at) {
  const run = activeRun(ctx);
  const rec = run?.tree.get(e.agentId);
  if (!rec) return;
  // 人の判断待ちのあいだに統括がツールを使った。答えが届いて動き出したとみる（答えの送りが時間切れだったとき。4.15）
  if (run.status === 'waiting_human' && e.agentId === run.rootId) resumeFromHumanWait(ctx, run, at, 'activity');
  rec.lastEventAt = at;
  syncSlot(run, rec);
  logEvent(ctx, run, e, at);
}

function waitTarget(run, agentId) {
  let cur = run.tree.get(agentId);
  const seen = new Set();
  while (cur && !seen.has(cur.agentId)) {
    if (cur.slotName) return cur;
    seen.add(cur.agentId);
    cur = cur.parentId ? run.tree.get(cur.parentId) : null;
  }
  return run.tree.get(agentId) ?? null;
}

// 確認の待ち（4.14）。この実行の木のエージェントの待ちだけを「待ち」にする。
function onWaitStarted(ctx, e, at) {
  const run = ctx.run;
  if (!run || (run.status !== 'running' && run.status !== 'summarizing')) return;
  if (e.resolvedByHook) return; // ほかのフックが答えを決めた。チャットの確認が出ない
  const detail = e.detail ?? {};
  if (EXTENSION_PERMISSION_KINDS.has(detail.permissionKind) || EXTENSION_PERMISSION_KINDS.has(detail.toolKind)) return;
  if (e.agentId != null && !run.tree.has(e.agentId)) return; // チャットでのほかの作業
  if (e.agentId == null && e.kind !== 'limit') return; // メインのエージェント自身の確認
  if (run.waits.some((w) => w.requestId === e.requestId)) return;
  const slot = e.agentId != null ? slotNameOf(run, e.agentId) : null;
  const safeDetail = clone(detail);
  // サンドボックスの外に出さず、記録だけにして中で動かし直す求めは、「サンドボックスの外」と示さない（R2 #13）
  if (safeDetail.sandboxPermissive) safeDetail.sandboxBypass = false;
  run.waits.push({ requestId: e.requestId, agentId: e.agentId ?? null, slot, kind: e.kind, detail: safeDetail });
  if (e.kind === 'limit') run.limit = { requestId: e.requestId, answered: false, action: null };
  if (e.agentId != null) {
    const target = waitTarget(run, e.agentId);
    if (target && isActiveAgent(target)) target.status = 'waiting';
    const rec = run.tree.get(e.agentId);
    rec.lastEventAt = at;
    if (target) syncSlot(run, target);
  }
  logEvent(ctx, run, e, at);
}

function onWaitEnded(ctx, e, at) {
  const run = ctx.run;
  if (!run || run.status === 'finished') return;
  const index = run.waits.findIndex((w) => w.requestId === e.requestId);
  if (index < 0) return;
  const [wait] = run.waits.splice(index, 1);
  if (wait.kind === 'limit' && run.limit && run.limit.requestId === wait.requestId) {
    run.limit.answered = true;
    run.limit.action = e.action ?? null;
  }
  if (wait.agentId != null) {
    const target = waitTarget(run, wait.agentId);
    if (target) {
      const still = run.waits.some((w) => w.agentId != null && waitTarget(run, w.agentId) === target);
      if (!still && target.status === 'waiting') target.status = 'running';
      target.lastEventAt = at;
      syncSlot(run, target);
    }
  }
  logEvent(ctx, run, e, at, { agentId: wait.agentId });
}

export function handleEvent(ctx, e) {
  if (!e || typeof e.type !== 'string') return;
  const at = Number.isFinite(e.at) ? e.at : ctx.clock.now();
  switch (e.type) {
    case 'agent.started':
      return onAgentStarted(ctx, e, at);
    case 'agent.configured':
      return onAgentConfigured(ctx, e, at);
    case 'agent.completed':
      return onAgentEnded(ctx, e, at, 'completed');
    case 'agent.failed':
      return onAgentEnded(ctx, e, at, 'failed');
    case 'agent.idle':
      return onAgentEnded(ctx, e, at, 'idle');
    case 'tool.started':
    case 'tool.completed':
      return onToolEvent(ctx, e, at);
    case 'wait.started':
      return onWaitStarted(ctx, e, at);
    case 'wait.ended':
      return onWaitEnded(ctx, e, at);
    default:
      return undefined;
  }
}
