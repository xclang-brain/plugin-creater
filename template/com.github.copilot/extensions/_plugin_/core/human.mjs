import {
  ANSWER_ALREADY_DELIVERED_MESSAGE,
  ANSWER_DELIVERED_MESSAGE,
  ANSWER_HEAD,
  ANSWER_NOT_DELIVERED_MESSAGE,
  ANSWER_UNKNOWN_MESSAGE,
  LIMITS,
  NOT_WAITING_MESSAGE,
} from './constants.mjs';
import { RecordRefusal } from './records.mjs';
import { requestClose } from './lifecycle.mjs';
import { logEntry } from './log.mjs';
import { resumeFromHumanWait } from './run.mjs';
import { callWithTimeout, errorMessage } from './util.mjs';

// 人の判断待ちの答え（4.15）。メインのエージェントが <名前>_answer で渡した答えを、待っている統括に送る。
// 順番待ちの列の中で動く。成功なら返す文、断るときと渡せなかったときは RecordRefusal を投げる（つなぎ口が失敗の結果にする）。

// 統括に送る文。答えは言い換えずにそのまま入れる
export function buildAnswerMessage(question, answer) {
  return [ANSWER_HEAD, '', '質問：', question, '', '答え：', answer].join('\n');
}

export async function answerHuman(ctx, args, agentId) {
  const run = ctx.run;
  if (!run || run.status === 'finished') throw new RecordRefusal(NOT_WAITING_MESSAGE);
  // 答えは人が出す。この実行のエージェント（統括・作業・検証）からの呼び出しは断る
  if (agentId != null && (run.tree.has(agentId) || ctx.deny.has(agentId))) {
    throw new RecordRefusal('答えは、ユーザーがチャットで答えたときに、メインのエージェントが渡します。このエージェントは渡せません。');
  }
  if (run.status !== 'waiting_human' || !run.humanWait || run.closeRequested || run.closing) throw new RecordRefusal(NOT_WAITING_MESSAGE);
  const answer = typeof args?.answer === 'string' ? args.answer : '';
  if (answer.trim() === '') throw new RecordRefusal('ユーザーの答えの文（answer）を、ユーザーの言葉のまま渡してください。');

  const { question } = run.humanWait;
  // 前の答えの送りが時間切れだった。統括が動いていれば、前の答えが届いている。もう一度送ると答えが 2 回届くので、送らない（4.15）。
  // 一覧が取れないときは、送る
  if (run.humanWait.answerUnknown) {
    const listed = await callWithTimeout(ctx.clock, () => ctx.port.listTasks(), LIMITS.CALL_TIMEOUT_MS);
    if (ctx.run !== run || run.status !== 'waiting_human' || !run.humanWait || run.closeRequested || run.closing) throw new RecordRefusal(NOT_WAITING_MESSAGE);
    const root = listed.status === 'ok' && Array.isArray(listed.value) ? listed.value.find((t) => (t?.agentId ?? t?.id) === run.rootId) : null;
    if (root?.status === 'running') {
      const at = ctx.clock.now();
      logEntry(ctx, run, { t: 'note', at, kind: 'human_answer_already_delivered', question, answer });
      resumeFromHumanWait(ctx, run, at, 'activity');
      return ANSWER_ALREADY_DELIVERED_MESSAGE;
    }
  }
  const message = buildAnswerMessage(question, answer);
  const r = await callWithTimeout(ctx.clock, () => ctx.port.sendMessage(run.rootId, message), LIMITS.CALL_TIMEOUT_MS);
  const now = ctx.clock.now();
  // 待っているあいだに、止められたり、統括が終わったりしていたら、答えは使わない
  if (ctx.run !== run || run.status === 'finished' || run.closeRequested || run.closing) {
    logEntry(ctx, run, { t: 'note', at: now, kind: 'human_answer_late', status: r.status });
    throw new RecordRefusal(NOT_WAITING_MESSAGE);
  }
  if (r.status === 'ok' && r.value?.sent !== false) {
    logEntry(ctx, run, { t: 'human_answer', at: now, question, answer });
    resumeFromHumanWait(ctx, run, now, 'answered');
    return ANSWER_DELIVERED_MESSAGE;
  }
  if (r.status === 'timeout') {
    // 送れたかが分からない。待ちのままにし、統括が動き出したら実行中に戻す（events.mjs、records.mjs）
    logEntry(ctx, run, { t: 'note', at: now, kind: 'human_answer_unknown', question, answer });
    run.humanWait.answerUnknown = true;
    throw new RecordRefusal(ANSWER_UNKNOWN_MESSAGE);
  }
  // 送れなかった（sent が偽、呼び出しの失敗）。統括は続けられないので、実行を終える
  const detail = r.status === 'ok' ? String(r.value?.error ?? '') : errorMessage(r.error);
  logEntry(ctx, run, { t: 'note', at: now, kind: 'human_answer_not_delivered', question, answer, error: detail });
  run.pendingEnd = { kind: 'aborted', detail: 'answer_not_delivered', ...(detail ? { message: detail } : {}) };
  requestClose(ctx, run, { userStop: false });
  throw new RecordRefusal(ANSWER_NOT_DELIVERED_MESSAGE);
}
