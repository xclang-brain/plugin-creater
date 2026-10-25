// 中心の処理：人の判断待ち（設計書 4.15、6.1、10章「人の判断待ち」）
// 統括が質問を記録して手番を終えても実行は終わらず、メインのエージェントが渡した答えを同じ統括に送って、同じ実行を続ける。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { LIMITS, expectRefusal, makeHarness, slotOf } from './harness.mjs';

const QUESTION = '試行 1 のビルドが失敗しました（ツールチェーンが見つかりません）。どうしますか？';
const ANSWER = 'ツールチェーンのパスは /opt/arm/bin です。続けて';

// 統括が手番を終える。初めの手番の終わりは completed と idle の 2 つ、2回目からは idle だけ（11章 #19）
async function rootTurnEnd(h, { first = true, response = `人の判断待ち\n${QUESTION}` } = {}) {
  h.port.setStatus(h.root, 'idle');
  if (first) await h.event({ type: 'agent.completed', agentId: h.root, cancelled: false, response });
  await h.event({ type: 'agent.idle', agentId: h.root, ...(first ? {} : { response }) });
}

// 試行 1 を不合格で終え、統括が質問を記録して手番を終えた状態にする
async function toWaiting(h, extra = {}) {
  await h.begin(extra);
  await h.iterate(1, { pass: false });
  const text = await h.tool('ask', { question: QUESTION }, h.root);
  assert.match(text, /人の判断待ち/);
  await rootTurnEnd(h);
}

const answer = (h, text = ANSWER, agentId) => h.core.relayHumanAnswer({ answer: text }, { agentId });
const logOf = (h, runId) =>
  readFileSync(join(h.dataRoot, runId, 'log.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

test('REQ-051 質問を記録した統括が手番を終えると、実行は終わらず「人の判断待ち」になり、統括は取り消されない', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  const run = h.run();
  assert.equal(run.status, 'waiting_human');
  assert.equal(run.endReason, null);
  assert.equal(h.port.callsOf('cancelAgent').length, 0, '待っている統括は取り消さない');
  assert.equal(h.port.task(h.root).status, 'idle');
  assert.equal(slotOf(run, 'orchestrator').status, 'waiting_human');
  assert.deepEqual(run.humanWait, { question: QUESTION, askedAt: run.humanWait.askedAt, iteration: 1, waiting: true });
  assert.equal(run.phase, null, '待っているあいだは、計画・実行・評価のどれでもない');
  assert.ok(h.state().notices.length > 0, '実行中の注意（/clear しない、チャットで答える）は出たまま');
  // 初めの手番の終わりの 2 つ目のイベントが、さらに遅れて届いても、待ちのまま
  await h.event({ type: 'agent.idle', agentId: h.root });
  assert.equal(h.run().status, 'waiting_human');
});

test('REQ-051 質問を記録していない手番の終わりは、これまでどおり実行を終える', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  await h.iterate(1, { pass: false });
  await rootTurnEnd(h);
  const run = h.run();
  assert.equal(run.status, 'finished');
  assert.deepEqual([run.endReason.kind, run.endReason.detail], ['aborted', 'orchestrator_ended']);
});

test('REQ-051 答えを渡すと、質問と答え（言い換えない）を入れた文が同じ統括に送られ、同じ実行が続いて、結果が 1 つの実行にまとまる', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h, { maxIterations: 3 });
  const runId = h.run().id;
  const text = await answer(h);
  assert.match(text, /渡しました/);
  const [[agentId, message]] = h.port.callsOf('sendMessage').map((c) => c.args);
  assert.equal(agentId, h.root, '待っている統括に送る');
  assert.ok(message.includes(QUESTION), '質問が入る');
  assert.ok(message.includes(`答え：\n${ANSWER}`), '答えがそのまま入る');
  let run = h.run();
  assert.equal(run.status, 'running');
  assert.equal(run.humanWait, null);
  assert.equal(slotOf(run, 'orchestrator').status, 'running');
  // 同じ統括が、待つ前の続きから進める。試行の番号は 2、上限は 3 のまま
  await h.event({ type: 'tool.started', agentId: h.root, toolCallId: 'tc-r1', toolName: 'weekly-report_plan', arguments: {} });
  await expectRefusal(h.tool('plan', h.planArgs(1), h.root));
  await h.iterate(2);
  run = h.run();
  assert.equal(run.status, 'summarizing');
  assert.equal(run.maxIterations, 3);
  await h.tool('review', {}, h.root);
  await h.tool('finish', { summary: '人の答えの後に、2回目で合格しました' }, h.root);
  await rootTurnEnd(h, { first: false, response: '実行の番号：x' });
  run = h.run();
  assert.equal(run.status, 'finished');
  assert.equal(run.id, runId, '同じ実行');
  assert.deepEqual([run.endReason.kind, run.endReason.detail], ['all_passed', null]);
  assert.deepEqual(run.iterations.map((i) => i.n), [1, 2], '待つ前と後の試行が 1 つの実行にまとまる');
  assert.equal(h.port.callsOf('startAgent').length, 1, '統括を起動し直さない');
  const log = logOf(h, runId);
  assert.ok(log.some((e) => e.t === 'human_answer' && e.answer === ANSWER && e.question === QUESTION), '記録に答えが残る');
  assert.deepEqual(
    log.filter((e) => e.t === 'status').map((e) => e.status),
    ['running', 'waiting_human', 'running', 'finished'],
  );
});

test('REQ-051 1 つの実行の中で、何回でも人の判断を待てる。2回目からの手番の終わり（idle だけ）でも待ちになる', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  await answer(h);
  await h.tool('ask', { question: 'もう一度聞きます。どうしますか？' }, h.root);
  await rootTurnEnd(h, { first: false });
  assert.equal(h.run().status, 'waiting_human');
  assert.equal(h.run().humanWait.question, 'もう一度聞きます。どうしますか？');
  assert.equal(slotOf(h.run(), 'orchestrator').replySummary.startsWith('人の判断待ち'), true, '2回目からの手番の返事も、枠に出る');
  await answer(h, '止めずに続けて');
  assert.equal(h.run().status, 'running');
  assert.equal(h.port.callsOf('sendMessage').length, 2);
});

test('REQ-051 答えを送れなかった（sent が偽）ときは、「途中で終わった（人の答えを統括エージェントに渡せなかった）」になる', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  h.port.behave('sendMessage', { value: { sent: false, error: 'Agent not found or not accepting messages' } });
  const reason = await expectRefusal(answer(h));
  assert.match(reason, /渡せませんでした/);
  await h.settle();
  const run = h.run();
  assert.equal(run.status, 'finished');
  assert.deepEqual([run.endReason.kind, run.endReason.detail], ['aborted', 'answer_not_delivered']);
  assert.deepEqual(h.port.argsOf('cancelAgent'), [h.root], '待ちで残っていた統括は取り消す');
  assert.ok(run.issues.some((i) => i.title.includes('人の答えを統括エージェントに渡せなかった')));
});

test('REQ-051 答えを送る呼び出しが失敗したときも、「途中で終わった（人の答えを統括エージェントに渡せなかった）」になる', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  h.port.behave('sendMessage', { error: new Error('method not found') });
  await expectRefusal(answer(h));
  await h.settle();
  assert.deepEqual([h.run().endReason.kind, h.run().endReason.detail], ['aborted', 'answer_not_delivered']);
});

test('REQ-051 答えを送る呼び出しが時間切れのときは、待ちのまま。統括の動きが届くと実行中に戻る', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  h.port.behave('sendMessage', { hang: true, times: 1 });
  const pending = expectRefusal(answer(h));
  await h.clock.advance(LIMITS.CALL_TIMEOUT_MS + 1);
  assert.match(await pending, /分かりませんでした/);
  assert.equal(h.run().status, 'waiting_human');
  await h.event({ type: 'tool.started', agentId: h.root, toolCallId: 'tc-r1', toolName: 'view', arguments: { path: 'a' } });
  assert.equal(h.run().status, 'running');
  assert.equal(h.run().humanWait, null);
});

test('REQ-051 時間切れの後に、統括が記録のツールを呼んでも、実行中に戻って記録される', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  h.port.behave('sendMessage', { hang: true, times: 1 });
  const pending = expectRefusal(answer(h));
  await h.clock.advance(LIMITS.CALL_TIMEOUT_MS + 1);
  await pending;
  assert.match(await h.tool('plan', h.planArgs(2), h.root), /記録しました/);
  assert.equal(h.run().status, 'running');
});

test('REQ-051 時間切れの後に、統括がツールを使わずに手番を終えたら、待ちのまま残さず、ふだんの手番の終わりとして扱う', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  h.port.behave('sendMessage', { hang: true, times: 1 });
  const pending = expectRefusal(answer(h));
  await h.clock.advance(LIMITS.CALL_TIMEOUT_MS + 1);
  await pending;
  h.port.setStatus(h.root, 'running');
  await rootTurnEnd(h, { first: false, response: '分かりました' });
  await h.settle();
  const run = h.run();
  assert.equal(run.status, 'finished', '答えが届いて動いた統括の手番の終わり。待ちの 2 つ目のイベントとして見送らない');
  assert.deepEqual([run.endReason.kind, run.endReason.detail], ['aborted', 'orchestrator_ended']);
});

test('REQ-051 時間切れの後にもう一度答えたとき、統括が動いていれば（前の答えが届いていた）、もう一度は送らない', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  h.port.behave('sendMessage', { hang: true, times: 1 });
  const pending = expectRefusal(answer(h));
  await h.clock.advance(LIMITS.CALL_TIMEOUT_MS + 1);
  await pending;
  h.port.setStatus(h.root, 'running');
  assert.match(await answer(h, 'もう一度：続けて'), /届いていました/);
  assert.equal(h.port.callsOf('sendMessage').length, 1, '答えが 2 回届かない');
  assert.equal(h.run().status, 'running');
  assert.equal(h.run().humanWait, null);
});

test('REQ-051 時間切れの後にもう一度答えたとき、統括が待ったままなら、もう一度送る', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  h.port.behave('sendMessage', { hang: true, times: 1 });
  const pending = expectRefusal(answer(h));
  await h.clock.advance(LIMITS.CALL_TIMEOUT_MS + 1);
  await pending;
  assert.match(await answer(h), /渡しました/);
  assert.equal(h.port.callsOf('sendMessage').length, 2);
  assert.equal(h.run().status, 'running');
});

test('REQ-051 人の判断待ちのあいだに、統括でないエージェントが記録のツールを呼んでも、待ちのまま', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  await h.tool('plan', h.planArgs(1), h.root);
  const worker = await h.spawn('worker');
  await h.tool('ask', { question: QUESTION }, h.root);
  await rootTurnEnd(h);
  assert.equal(h.run().status, 'waiting_human');
  await h.tool('show', { key: 'no-such-key', value: 'x' }, worker).catch(() => {});
  assert.equal(h.run().status, 'waiting_human');
  assert.equal(h.run().humanWait.question, QUESTION);
});

test('REQ-051 人の判断を求める質問の記録の決まり：統括だけ、繰り返しの途中だけ、答えを待っている質問がないときだけ', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  await h.tool('plan', h.planArgs(1), h.root);
  const worker = await h.spawn('worker');
  assert.match(await expectRefusal(h.tool('ask', { question: QUESTION }, worker)), /統括エージェントだけ/);
  assert.match(await expectRefusal(h.tool('ask', { question: '  ' }, h.root)), /質問の文/);
  await h.tool('ask', { question: QUESTION }, h.root);
  assert.match(await expectRefusal(h.tool('ask', { question: 'もう1つ' }, h.root)), /答えを待っている質問があります/);
  assert.equal(h.run().status, 'running', '手番を終えるまでは、実行中のまま');

  const g = await makeHarness(t);
  await g.toSummarizing();
  assert.match(await expectRefusal(g.tool('ask', { question: QUESTION }, g.root)), /まとめの間は/);
});

test('REQ-051 答えを渡すツールの決まり：人の判断待ちのときだけ、この実行のエージェントからは渡せない、答えが空なら断る', async (t) => {
  const h = await makeHarness(t);
  assert.match(await expectRefusal(answer(h)), /人の判断を待っていません/, '実行がない');
  await h.begin();
  await h.tool('plan', h.planArgs(1), h.root);
  assert.match(await expectRefusal(answer(h)), /人の判断を待っていません/, '実行中だが待っていない');
  await h.tool('ask', { question: QUESTION }, h.root);
  assert.match(await expectRefusal(answer(h)), /人の判断を待っていません/, '統括がまだ手番を終えていない');
  await rootTurnEnd(h);
  assert.match(await expectRefusal(answer(h, ANSWER, h.root)), /メインのエージェントが渡します/, '統括からは渡せない');
  assert.match(await expectRefusal(answer(h, '   ')), /答えの文/);
  assert.equal(h.port.callsOf('sendMessage').length, 0);
  assert.equal(h.run().status, 'waiting_human');
});

test('REQ-051 人の判断待ちのあいだに止めると、待っている統括が取り消され、「ユーザーが止めた」になる。答えは渡せない', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  h.core.stop();
  await h.settle();
  await h.clock.advance(LIMITS.STOP_POLL_MS);
  const run = h.run();
  assert.deepEqual(h.port.argsOf('cancelAgent'), [h.root]);
  assert.equal(run.status, 'finished');
  assert.deepEqual([run.endReason.kind, run.endReason.unstoppable], ['user_stopped', false]);
  assert.equal(slotOf(run, 'orchestrator').status, 'stopped');
  assert.equal(run.humanWait, null);
  assert.match(await expectRefusal(answer(h)), /人の判断を待っていません/);
});

test('REQ-051 人の判断待ちのあいだに、統括がチャットから取り消されると「途中で終わった（チャットから中断された）」になる', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  h.port.setStatus(h.root, 'cancelled');
  await h.event({ type: 'agent.completed', agentId: h.root, cancelled: true });
  assert.deepEqual([h.run().endReason.kind, h.run().endReason.detail], ['aborted', 'chat_interrupted']);
});

test('REQ-051 人の判断を待っていた時間は、エージェントが動かなかった課題に入らない', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  await h.clock.advance(LIMITS.STALL_MS * 4);
  await answer(h);
  await h.event({ type: 'tool.started', agentId: h.root, toolCallId: 'tc-r1', toolName: 'view', arguments: { path: 'a' } });
  await h.iterate(2);
  await h.tool('finish', { summary: 'まとめ' }, h.root);
  await rootTurnEnd(h, { first: false });
  const run = h.run();
  assert.equal(run.status, 'finished');
  assert.ok(!run.issues.some((i) => i.title.includes('動きませんでした')), run.issues.map((i) => i.title).join(' / '));

  // 比べ：待ちでないときに同じだけ動かなければ、課題に入る（洗い出しそのものは働いている）
  const g = await makeHarness(t);
  await g.begin();
  await g.iterate(1, { pass: false });
  await g.clock.advance(LIMITS.STALL_MS * 4);
  await g.event({ type: 'tool.started', agentId: g.root, toolCallId: 'tc-g1', toolName: 'view', arguments: { path: 'a' } });
  await g.iterate(2);
  await g.tool('finish', { summary: 'まとめ' }, g.root);
  await g.rootIdle();
  assert.ok(g.run().issues.some((i) => i.title.includes('統括エージェントが') && i.title.includes('動きませんでした')));
});

test('REQ-051 人の判断待ちのまま止めて終わっても、待っていた時間は課題に入らない', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  await h.clock.advance(LIMITS.STALL_MS * 2);
  h.core.stop();
  await h.settle();
  await h.clock.advance(LIMITS.STOP_POLL_MS);
  assert.ok(!h.run().issues.some((i) => i.title.includes('動きませんでした')), h.run().issues.map((i) => i.title).join(' / '));
});
