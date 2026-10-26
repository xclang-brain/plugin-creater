// 人の判断待ちへの答え方（skills/test-plugin/scripts/human-wait.mjs）の試験。時計とイベントは手で進める。
// 確かめる要件：REQ-041（生成プラグインありの EVAL を、人の代わりに試験の仕組みが動かす）、REQ-051（人の判断待ち。答えはチャットで渡す）。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { loadScript } from './helpers.mjs';

const { createHumanWaitAnswerer } = await loadScript('human-wait.mjs');
const { createTracker } = await loadScript('events.mjs');
const { FIXED_ANSWER } = await loadScript('permissions.mjs');

const SETTLE = 3000;
const QUIET = 60_000;

/** 手で進める時計、イベントの集計、送った文の一覧、答え方をまとめて作る */
function world({ send } = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const tracker = createTracker({ now: clock.now });
  const sent = [];
  const logged = [];
  const human = createHumanWaitAnswerer({
    tracker,
    send: send ?? (async (prompt) => sent.push(prompt)),
    now: clock.now,
    settleMs: SETTLE,
    quietMs: QUIET,
    log: (entry) => logged.push(entry),
  });
  const emit = (type, data = {}, agentId) => tracker.onEvent({ type, data, ...(agentId ? { agentId } : {}) });
  /** 統括が手番を終えた知らせが届き、メインのエージェントが1手番動いて（質問をチャットに示して）手番を終える */
  const mainShowsQuestion = () => {
    emit('system.notification', { kind: { type: 'agent_idle', agentId: 'orch-1', agentType: 'weekly-report:orchestrator' } });
    emit('assistant.message', { content: '統括エージェントから質問です。チャットで答えてください。' });
    emit('session.idle');
  };
  return { clock, tracker, sent, logged, human, emit, mainShowsQuestion };
}

const waiting = (question = 'ビルドが失敗しました。どうしますか？', askedAt = 111) => ({ status: 'waiting_human', humanWait: { question, askedAt, waiting: true } });
const running = () => ({ status: 'running', humanWait: null });

describe('人の判断待ちに、決まった返事を送る', () => {
  test('REQ-051 人の判断待ちで、統括の知らせの後にメインのエージェントの手番が終わり、静かになったら、決まった返事を1回送る', async () => {
    const w = world();
    w.tracker.markSent();
    w.emit('session.idle'); // 画面の URL を示した最初の手番の終わり
    w.human.observe(waiting());
    await w.human.tick();
    assert.deepEqual(w.sent, [], '統括の手番の終わりの知らせの後の手番が、まだ終わっていない');

    w.emit('system.notification', { kind: { type: 'agent_idle', agentId: 'orch-1' } });
    w.clock.advance(SETTLE);
    await w.human.tick();
    assert.deepEqual(w.sent, [], '知らせを受けたメインのエージェントが動いている（session.idle がまだ）');

    w.emit('assistant.message', { content: '質問です' });
    w.emit('session.idle');
    await w.human.tick();
    assert.deepEqual(w.sent, [], 'session.idle の直後は、まだ送らない（もう1回知らせが来るおそれがある）');

    w.clock.advance(SETTLE);
    await w.human.tick();
    assert.deepEqual(w.sent, [FIXED_ANSWER]);
    assert.equal(w.human.stats.count, 1);
    assert.deepEqual(w.human.stats.questions, ['ビルドが失敗しました。どうしますか？']);
    assert.deepEqual(w.logged, [{ type: 'eval.human_answer', data: { question: 'ビルドが失敗しました。どうしますか？', via: 'notified' } }]);
    assert.equal(w.tracker.state.busy, true, '送ったので、メインのエージェントは動いている');
  });

  test('REQ-051 同じ質問には、人の判断待ちのままでも、2回送らない', async () => {
    const w = world();
    w.human.observe(waiting());
    w.mainShowsQuestion();
    w.clock.advance(SETTLE);
    await w.human.tick();
    // 答えが届いたか分からないまま、画面は人の判断待ちのまま。メインのエージェントがまた手番を終えても送らない
    w.mainShowsQuestion();
    w.clock.advance(QUIET);
    w.human.observe(waiting());
    await w.human.tick();
    assert.deepEqual(w.sent, [FIXED_ANSWER]);
    assert.equal(w.human.stats.count, 1);
  });

  test('REQ-051 1つの実行で何回も人の判断を待つときは、質問ごとに1回ずつ送る', async () => {
    const w = world();
    w.human.observe(waiting('1つ目の質問', 111));
    w.mainShowsQuestion();
    w.clock.advance(SETTLE);
    await w.human.tick();

    // 答えが渡って実行中に戻り、統括が続ける。2つ目の質問で、また人の判断待ちになる
    w.emit('tool.execution_start', { toolName: 'weekly-report_answer' });
    w.emit('session.idle');
    w.human.observe(running());
    w.clock.advance(QUIET * 2);
    await w.human.tick();
    assert.equal(w.sent.length, 1, '実行中のあいだは送らない');

    w.human.observe(waiting('2つ目の質問', 222));
    await w.human.tick();
    assert.equal(w.sent.length, 1, '2つ目の質問の知らせの後の手番が、まだ終わっていない');
    w.mainShowsQuestion();
    w.clock.advance(SETTLE);
    await w.human.tick();
    assert.deepEqual(w.sent, [FIXED_ANSWER, FIXED_ANSWER]);
    assert.deepEqual(w.human.stats.questions, ['1つ目の質問', '2つ目の質問']);
  });

  test('REQ-051 前に送った後の知らせしか、手番の終わりの印にしない（前の質問の知らせで、早まって送らない）', async () => {
    const w = world();
    w.human.observe(waiting('1つ目の質問', 111));
    w.mainShowsQuestion();
    w.clock.advance(SETTLE);
    await w.human.tick();
    w.emit('session.idle'); // 1つ目の答えを渡した手番の終わり
    w.clock.advance(SETTLE);
    // 2つ目の質問の知らせがメインのエージェントに届く前に、画面が先に人の判断待ちになった
    w.human.observe(waiting('2つ目の質問', 222));
    await w.human.tick();
    assert.equal(w.sent.length, 1);
  });

  test('REQ-051 人の判断待ちでないとき（質問を記録しただけで統括が手番を終えていない、実行中、終わった、止めた）は送らない', async () => {
    for (const snap of [
      { status: 'running', humanWait: { question: 'まだ手番を終えていない', askedAt: 1, waiting: false } },
      running(),
      { status: 'finished', humanWait: null },
      { status: 'stopping', humanWait: null },
      { status: 'preparing', humanWait: null },
    ]) {
      const w = world();
      w.human.observe(snap);
      w.mainShowsQuestion();
      w.clock.advance(QUIET);
      await w.human.tick();
      assert.deepEqual(w.sent, [], snap.status);
    }
  });

  test('REQ-051 人の判断待ちを見た後に、実行が終わったか止められたら、送らない', async () => {
    const w = world();
    w.human.observe(waiting());
    w.human.observe({ status: 'stopping', humanWait: null });
    w.mainShowsQuestion();
    w.clock.advance(QUIET);
    await w.human.tick();
    assert.deepEqual(w.sent, []);

    const closed = world();
    closed.human.observe(waiting());
    closed.mainShowsQuestion();
    closed.clock.advance(SETTLE);
    closed.human.close(); // 画面の操作が終わった
    await closed.human.tick();
    assert.deepEqual(closed.sent, []);
  });

  test('REQ-051 手番の終わりの知らせか session.idle が届かなくても、セッションが決めた時間静かなら送る', async () => {
    const w = world();
    w.tracker.markSent();
    w.human.observe(waiting());
    w.emit('assistant.message', { content: '質問です' }); // 知らせも session.idle も届かない
    w.clock.advance(QUIET - 1);
    await w.human.tick();
    assert.deepEqual(w.sent, []);
    w.emit('assistant.usage', { model: 'm' });
    w.clock.advance(QUIET - 1);
    await w.human.tick();
    assert.deepEqual(w.sent, [], 'イベントがあれば、そこから数え直す');
    w.clock.advance(1);
    await w.human.tick();
    assert.deepEqual(w.sent, [FIXED_ANSWER]);
    assert.equal(w.logged[0].data.via, 'quiet');
  });

  test('REQ-051 サブエージェントに届いた知らせ（agentId 付き）は、メインのエージェントへの知らせに数えない', async () => {
    const w = world();
    w.human.observe(waiting());
    w.emit('system.notification', { kind: { type: 'agent_idle', agentId: 'worker-1' } }, 'orch-1');
    w.emit('session.idle');
    w.clock.advance(SETTLE);
    await w.human.tick();
    assert.deepEqual(w.sent, []);
  });

  test('REQ-051 送れなかったときは、その質問と理由を残し、同じ質問にはやり直さない', async () => {
    let calls = 0;
    const w = world({
      send: async () => {
        calls += 1;
        throw new Error('セッションが閉じています');
      },
    });
    w.human.observe(waiting());
    w.mainShowsQuestion();
    w.clock.advance(SETTLE);
    await w.human.tick();
    w.clock.advance(QUIET);
    await w.human.tick();
    assert.equal(calls, 1);
    assert.equal(w.human.stats.count, 0);
    assert.deepEqual(w.human.stats.failures, [{ question: 'ビルドが失敗しました。どうしますか？', error: 'セッションが閉じています' }]);
    assert.equal(w.logged[0].type, 'eval.human_answer_failed');
  });

  test('REQ-051 送っている途中に重ねて呼ばれても、1回しか送らない', async () => {
    let release;
    const sent = [];
    const w = world({
      send: (prompt) =>
        new Promise((resolve) => {
          sent.push(prompt);
          release = resolve;
        }),
    });
    w.human.observe(waiting());
    w.mainShowsQuestion();
    w.clock.advance(SETTLE);
    const first = w.human.tick();
    await w.human.tick();
    release();
    await first;
    assert.equal(sent.length, 1);
  });
});
