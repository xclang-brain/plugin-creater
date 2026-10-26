// EVAL のセッションが出すイベントを、記録のファイルに残し、採点と結果に使う分を集める（testing.md 10.4「採点と記録」）。
// 残すイベント：skill.invoked、subagent.*、tool.execution_*、user_input.requested、permission.*、assistant.message、assistant.usage、session.idle
//   （ほかに、止まった理由を知るための session.error、session_limits_exhausted.*、読み込みを知るための session.start、session.extensions_loaded）
// AI クレジットは assistant.usage の copilotUsage.totalNanoAiu を足し上げる。1 AI クレジット = 10億 nano-AIU。

import fs from 'node:fs';
import path from 'node:path';

import { findScreenUrl } from './screen.mjs';
import { nanoAiuToCredits } from './results.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MESSAGE_MAX_CHARS = 20_000;
const FIELD_MAX_CHARS = 2_000;

export function clipText(value, max = FIELD_MAX_CHARS) {
  const text = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…（${chars.length - max}文字省略）`;
}

/** 条件が満たされるか、時間切れか、中断されるまで待つ。@returns {Promise<'done'|'timeout'|'aborted'>} */
export async function waitUntil(check, { timeoutMs, signal, pollMs = 25 } = {}) {
  const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return 'done';
    if (signal?.aborted) return 'aborted';
    if (Date.now() >= deadline) return 'timeout';
    await sleep(pollMs);
  }
}

/** イベント1件を、記録のファイルに書く形にする。記録しない種類は null */
export function compactEvent(event) {
  const d = event?.data ?? {};
  const base = { type: event?.type };
  if (event?.agentId) base.agentId = event.agentId;
  switch (event?.type) {
    case 'session.start':
      return { ...base, data: { copilotVersion: d.copilotVersion, selectedModel: d.selectedModel, sessionId: d.sessionId } };
    case 'session.extensions_loaded':
      return { ...base, data: { extensions: (d.extensions ?? []).map((e) => ({ id: e.id, source: e.source, status: e.status })) } };
    case 'skill.invoked':
      return { ...base, data: { name: d.name, pluginName: d.pluginName } };
    case 'subagent.started':
      return { ...base, data: { agentName: d.agentName, agentType: d.agentType, model: d.model, executionMode: d.executionMode, parentId: d.parentId, toolCallId: d.toolCallId } };
    case 'subagent.completed':
      return { ...base, data: { agentName: d.agentName, model: d.model, cancelled: d.cancelled, durationMs: d.durationMs, totalTokens: d.totalTokens, toolCallId: d.toolCallId } };
    case 'subagent.failed':
      return { ...base, data: { agentName: d.agentName, model: d.model, error: clipText(d.error), toolCallId: d.toolCallId } };
    case 'tool.execution_start':
      return { ...base, data: { toolCallId: d.toolCallId, toolName: d.toolName, arguments: clipText(d.arguments) } };
    case 'tool.execution_complete':
      return { ...base, data: { toolCallId: d.toolCallId, success: d.success, error: d.error?.message, result: clipText(d.result?.content) } };
    case 'user_input.requested':
      return { ...base, data: { requestId: d.requestId, question: clipText(d.question), choices: d.choices } };
    case 'permission.requested':
      return { ...base, data: { requestId: d.requestId, kind: d.permissionRequest?.kind, resolvedByHook: d.resolvedByHook, managedApprovalRequired: d.permissionRequest?.managedApprovalRequired } };
    case 'permission.completed':
      return { ...base, data: { requestId: d.requestId, result: d.result?.kind ?? d.result, decisionSource: d.decisionSource } };
    case 'assistant.message':
      return { ...base, data: { content: clipText(d.content, MESSAGE_MAX_CHARS) } };
    case 'assistant.usage':
      return { ...base, data: { model: d.model, inputTokens: d.inputTokens, outputTokens: d.outputTokens, nanoAiu: d.copilotUsage?.totalNanoAiu, aiCreditsStatus: d.aiCreditsStatus, initiator: d.initiator } };
    case 'system.notification':
      return { ...base, data: { kind: d.kind?.type, agentId: d.kind?.agentId } };
    case 'session.idle':
      return { ...base, data: {} };
    case 'session.error':
      return { ...base, data: { message: clipText(d.message ?? d.error ?? d) } };
    case 'session_limits_exhausted.requested':
      return { ...base, data: { requestId: d.requestId, maxAiCredits: d.maxAiCredits, usedAiCredits: d.usedAiCredits } };
    case 'session_limits_exhausted.completed':
      return { ...base, data: { requestId: d.requestId, action: d.response?.action } };
    default:
      return null;
  }
}

/** 記録のファイル（1行に1イベントの JSON）に追記する */
export function createEventLog(file, now = Date.now) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const started = now();
  return {
    file,
    write(record) {
      try {
        fs.appendFileSync(file, `${JSON.stringify({ t: now() - started, ...record })}\n`);
      } catch {
        // 記録に失敗しても、試験は続ける
      }
    },
  };
}

/** 動いている間に働くと見なすイベント（落ち着いたかを見るため）。session.idle で落ち着く */
const WORK_EVENTS = new Set([
  'user.message',
  'assistant.turn_start',
  'assistant.message',
  'assistant.usage',
  'tool.execution_start',
  'subagent.started',
  'system.notification',
  'permission.requested',
  'user_input.requested',
]);

/**
 * セッションのイベントを集める。createSession の onEvent に tracker.onEvent を渡す。
 * @param {object} [options]
 * @param {{ write: Function }} [options.log] 記録のファイル
 * @param {() => number} [options.now]
 * @param {(event: object) => void} [options.onLimit] 利用の上限の求め（session_limits_exhausted.requested）が来たときに呼ぶ
 */
export function createTracker({ log, now = Date.now, onLimit } = {}) {
  const state = {
    url: null,
    busy: false,
    idleCount: 0,
    lastEventAt: now(),
    lastIdleAt: null,
    // イベントの通し番号と、最後の session.idle・最後の裏のエージェントの知らせの番号（人の判断待ちの答え方で、順番を比べる。human-wait.mjs）
    seq: 0,
    lastIdleSeq: 0,
    lastNoticeSeq: 0,
    sent: false,
    errors: [],
    limit: null,
    copilotVersion: null,
    selectedModel: null,
    extensions: null,
    skills: [],
    subagents: new Map(),
    permissionRequests: 0,
    userInputRequests: 0,
    messages: 0,
    usage: { nano: 0, calls: 0, unknown: 0, partial: false, byModel: new Map() },
  };

  const onEvent = (event) => {
    try {
      state.lastEventAt = now();
      state.seq += 1;
      const record = compactEvent(event);
      if (record) log?.write(record);
      const d = event?.data ?? {};
      if (WORK_EVENTS.has(event?.type)) state.busy = true;
      switch (event?.type) {
        case 'session.idle':
          state.busy = false;
          state.idleCount += 1;
          state.lastIdleAt = now();
          state.lastIdleSeq = state.seq;
          break;
        case 'session.start':
          state.copilotVersion ??= d.copilotVersion ?? null;
          state.selectedModel ??= d.selectedModel ?? null;
          break;
        case 'session.extensions_loaded':
          state.extensions = (d.extensions ?? []).map((e) => ({ id: e.id, source: e.source, status: e.status }));
          break;
        case 'session.error':
          // サブエージェントの中の失敗は、記録のファイルには残るが、セッション全体の失敗には数えない
          if (!event.agentId) state.errors.push(clipText(d.message ?? d.error ?? d, 500));
          break;
        case 'assistant.message':
          if (!event.agentId) {
            state.messages += 1;
            state.url ??= findScreenUrl(d.content);
          }
          break;
        case 'assistant.usage': {
          const nano = d.copilotUsage?.totalNanoAiu;
          state.usage.calls += 1;
          if (Number.isFinite(nano)) {
            state.usage.nano += nano;
            state.usage.byModel.set(d.model, (state.usage.byModel.get(d.model) ?? 0) + nano);
          } else {
            state.usage.unknown += 1;
          }
          if (d.aiCreditsStatus && d.aiCreditsStatus !== 'complete') state.usage.partial = true;
          if (d.model && !state.usage.byModel.has(d.model)) state.usage.byModel.set(d.model, 0);
          break;
        }
        case 'skill.invoked':
          state.skills.push({ name: d.name, pluginName: d.pluginName ?? null });
          break;
        case 'subagent.started':
          state.subagents.set(event.agentId ?? d.toolCallId ?? `n${state.subagents.size}`, {
            agentName: d.agentName,
            agentType: d.agentType ?? null,
            model: d.model ?? null,
            executionMode: d.executionMode ?? null,
            status: 'started',
          });
          break;
        case 'subagent.configured': {
          const found = state.subagents.get(event.agentId);
          if (found && d.model) found.model = d.model;
          break;
        }
        case 'subagent.completed':
        case 'subagent.failed': {
          const found = state.subagents.get(event.agentId ?? d.toolCallId);
          if (found) {
            found.status = event.type === 'subagent.failed' ? 'failed' : d.cancelled ? 'cancelled' : 'completed';
            if (d.model) found.model = d.model;
          }
          break;
        }
        case 'permission.requested':
          state.permissionRequests += 1;
          break;
        case 'user_input.requested':
          state.userInputRequests += 1;
          break;
        case 'system.notification':
          // 裏のエージェント（統括など）が手番を終えた知らせ。メインのエージェントに届くもの（agentId のないもの）だけを数える
          if (!event.agentId && (d.kind?.type === 'agent_idle' || d.kind?.type === 'agent_completed')) state.lastNoticeSeq = state.seq;
          break;
        case 'session_limits_exhausted.requested':
          state.limit = { requestId: d.requestId, maxAiCredits: d.maxAiCredits, usedAiCredits: d.usedAiCredits };
          onLimit?.(event);
          break;
        default:
          break;
      }
    } catch {
      // イベントの処理の失敗で、セッションを止めない
    }
  };

  return {
    onEvent,
    state,
    /** メッセージを送った印（これより後の session.idle が、手番の終わり） */
    markSent() {
      state.sent = true;
      state.busy = true;
      state.idleCount = 0;
    },
    /** 使った AI クレジットと、数え方の状態。status：complete（全部数えた）、partial（一部しか数えていない）、unavailable（送ったのに数えられなかった） */
    credits() {
      const u = state.usage;
      let status = 'complete';
      if (u.calls === 0) status = state.sent ? 'unavailable' : 'complete';
      else if (u.partial || u.unknown > 0) status = u.unknown === u.calls ? 'unavailable' : 'partial';
      return {
        credits: Math.round(nanoAiuToCredits(u.nano) * 1e6) / 1e6,
        status,
        calls: u.calls,
        byModel: Object.fromEntries([...u.byModel].map(([model, nano]) => [model, Math.round(nanoAiuToCredits(nano) * 1e6) / 1e6])),
      };
    },
    /** 最後のイベントから、ms ミリ秒たち、働いていない（session.idle の後）か */
    settled(ms) {
      return !state.busy && now() - state.lastEventAt >= ms;
    },
  };
}
