// 人の判断待ちへの答え方（testing.md 10.4「人の判断待ち」）。生成プラグインありの実行だけで使う。
//
// 生成プラグインの統括が人の判断を求めると、実行は「人の判断待ち」になり、メインのエージェントが質問をチャットに示して手番を終える
// （generated-plugin-structure.md 4.15）。EVAL には人がいないので、質問（ask_user）と同じ決まった返事を、ユーザーのチャットの文として送る。
// メインのエージェントがそれを <名前>_answer で渡し、同じ実行が続く。送らないと、実行は時間切れまで待ったままになる。
//
// 送るのは、次の2つがそろったときである。
//   1. 画面の状態（GET /api/state）が「人の判断待ち」で、統括が手番を終えている（run.status が waiting_human、run.humanWait.waiting が真）
//   2. メインのエージェントの手番が終わっている。統括の手番の終わりの知らせ（system.notification の agent_idle）の後に session.idle が来て、
//      settleMs のあいだイベントがない（初めの手番の終わりでは知らせが2回来るおそれがある。同 11章 #30）
//      知らせか session.idle が届かないときに備え、人の判断待ちを見てから quietMs のあいだ、セッションにイベントがなければ送る
// 同じ質問（記録した時刻と質問の文で見分ける）には1回しか送らない。画面の状態が人の判断待ちでなくなったら（続いた、終わった、止めた）、送らない。

import { FIXED_ANSWER } from './permissions.mjs';

const MAX_LISTED = 50;
const clip = (text, max = 300) => {
  const chars = [...String(text ?? '')];
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max).join('')}…`;
};

/**
 * @param {object} args
 * @param {object} args.tracker events.mjs の createTracker の返り値
 * @param {(prompt: string) => Promise<unknown>} args.send メインのセッションにユーザーの文を送る（session.send({ prompt })）
 * @param {() => number} [args.now]
 * @param {number} args.settleMs メインのエージェントの手番が終わってから、静かであるのを待つ時間
 * @param {number} args.quietMs 知らせか session.idle が届かないときに、静かであるのを待つ時間
 * @param {(record: object) => void} [args.log] 送ったことを、記録のファイルに残す
 * @returns {{ observe: Function, tick: Function, close: Function, stats: object }}
 *   stats：送った数（count）、その質問の文（questions）、送れなかったもの（failures）
 */
export function createHumanWaitAnswerer({ tracker, send, now = Date.now, settleMs, quietMs, log }) {
  const stats = { count: 0, questions: [], failures: [] };
  const answered = new Set();
  let current = null; // { key, question, seenAt }
  let lastSentSeq = 0;
  let sending = false;
  let closed = false;

  /** 画面の状態の要点（screen.mjs の snapshotOf）を受ける。変わったときだけ呼ばれる */
  const observe = (snap) => {
    const hw = snap?.humanWait;
    if (snap?.status !== 'waiting_human' || !hw?.waiting) {
      current = null;
      return;
    }
    const key = `${hw.askedAt ?? ''}\n${hw.question ?? ''}`;
    if (current?.key !== key) current = { key, question: String(hw.question ?? ''), seenAt: now() };
  };

  /** メインのエージェントの手番が終わったか。終わっていれば、どの決まりで分かったか（notified か quiet）、まだなら null */
  const turnEnded = () => {
    const s = tracker.state;
    const t = now();
    if (s.lastNoticeSeq > lastSentSeq && s.lastIdleSeq > s.lastNoticeSeq && !s.busy && t - s.lastEventAt >= settleMs) return 'notified';
    if (t - Math.max(current.seenAt, s.lastEventAt) >= quietMs) return 'quiet';
    return null;
  };

  /** 定期的に呼ぶ。送る条件がそろっていれば、決まった返事を1回送る */
  const tick = async () => {
    if (closed || sending || !current || answered.has(current.key)) return;
    const via = turnEnded();
    if (!via) return;
    const { key, question } = current;
    answered.add(key);
    sending = true;
    lastSentSeq = tracker.state.seq;
    tracker.markSent();
    try {
      await send(FIXED_ANSWER);
      stats.count += 1;
      if (stats.questions.length < MAX_LISTED) stats.questions.push(clip(question));
      log?.({ type: 'eval.human_answer', data: { question: clip(question), via } });
    } catch (error) {
      const message = clip(error?.message ?? String(error), 200);
      if (stats.failures.length < MAX_LISTED) stats.failures.push({ question: clip(question), error: message });
      log?.({ type: 'eval.human_answer_failed', data: { question: clip(question), error: message } });
    } finally {
      sending = false;
    }
  };

  /** 画面の操作が終わったら呼ぶ。この後は送らない */
  const close = () => {
    closed = true;
    current = null;
  };

  return { observe, tick, close, stats };
}
