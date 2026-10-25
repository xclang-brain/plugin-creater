// 中心の処理：止める（設計書 4.4、5.2、6.1、10章「止める」）
import assert from 'node:assert/strict';
import test from 'node:test';
import { expectRefusal, LIMITS, makeHarness, PLUGIN, slotOf } from './harness.mjs';

test('REQ-009 止めると、統括だけが取り消される。作業・検証の終わりのイベントがなくても、統括の終わりと一覧の状態で終了になる', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  await h.tool('plan', h.planArgs(1), h.root);
  const worker = await h.spawn('worker');
  await h.core.stop();
  assert.equal(h.run().status, 'stopping', '押した時点で、すぐ停止中になる');
  await h.settle();
  // 取り消しの呼び出しは統括だけ。作業は一覧で cancelled になっている（イベントは流していない）
  assert.deepEqual(h.port.argsOf('cancelAgent'), [h.root]);
  assert.equal(h.port.task(worker).status, 'cancelled');
  const run = h.run();
  assert.equal(run.status, 'finished');
  assert.deepEqual([run.endReason.kind, run.endReason.unstoppable], ['user_stopped', false]);
  assert.equal(slotOf(run, 'orchestrator').status, 'stopped');
  assert.equal(slotOf(run, 'worker').status, 'stopped');
  assert.equal(h.port.overrides, null);
});

test('REQ-009 止めるを 2 回押しても、取り消しは 1 回で、終わった後に止めると断られる', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  await h.core.stop();
  const second = await h.core.stop();
  assert.equal(second.already, true);
  await h.settle();
  assert.deepEqual(h.port.argsOf('cancelAgent'), [h.root]);
  assert.match(await expectRefusal(h.core.stop()), /止める実行がありません/);
});

test('REQ-009 止めるを押した時点から、この実行のエージェントのツールだけが拒まれる', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  const worker = await h.spawn('worker');
  h.port.behave('cancelAgent', { hang: true }); // 取り消しが終わる前でも拒む
  await h.core.stop();
  for (const id of [h.root, worker]) {
    const r = h.core.preToolUse({ agentId: id, toolName: 'edit' });
    assert.equal(r.deny, true, id);
    assert.match(r.reason, /止められた/);
  }
  // ほかのエージェント（チャットでのほかの作業）とメインのエージェントは拒まない
  assert.equal(h.core.preToolUse({ agentId: 'other-agent', toolName: 'edit' }).deny, false);
  assert.equal(h.core.preToolUse({ toolName: 'edit' }).deny, false);
  assert.equal(h.core.preToolUse({ agentId: null, toolName: 'edit' }).deny, false);
  // 拒む一覧のエージェントの子は、一覧に足されて拒まれる
  assert.equal(h.core.preToolUse({ agentId: 'grandchild', parentAgentId: worker, toolName: 'edit' }).deny, true);
  assert.equal(h.core.preToolUse({ agentId: 'grandchild', toolName: 'edit' }).deny, true, '足された後は親の番号がなくても拒む');
});

test('REQ-009 ツールを使ってよいかの問い合わせは、同期ですぐ答える（列に入れない）。列が止まっていても答える', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  h.port.behave('cancelAgent', { hang: true });
  await h.core.stop();
  await h.settle();
  const r = h.core.preToolUse({ agentId: h.root, toolName: 'edit' });
  assert.equal(typeof r.then, 'undefined', 'Promise ではない');
  assert.equal(r.deny, true);
});

test('REQ-009 フックの中で失敗しても、例外を投げず、拒む一覧のエージェントのツールは拒まれる', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  await h.core.stop();
  await h.settle();
  const failing = (agentId) =>
    new Proxy({}, {
      get(_, key) {
        if (key === 'agentId') return agentId;
        throw new Error('読めない');
      },
    });
  assert.doesNotThrow(() => h.core.preToolUse(failing(h.root)));
  assert.equal(h.core.preToolUse(failing(h.root)).deny, true);
  assert.equal(h.core.preToolUse(failing('not-listed')).deny, false);
  // 入力そのものが読めなくても、例外を投げない
  assert.doesNotThrow(() => h.core.preToolUse(null));
  assert.doesNotThrow(() => h.core.preToolUse(undefined));
  assert.equal(h.core.preToolUse(null).deny, false);
});

test('REQ-009 止めた後に届いた、拒む一覧のエージェントの子の開始も、拒む一覧に入る', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  h.port.behave('cancelAgent', { hang: true });
  await h.core.stop();
  await h.event({ type: 'agent.started', agentId: 'late-child', parentAgentId: h.root, agentType: `${PLUGIN}:worker`, executionMode: 'sync' });
  // 止める処理が列を使っている間は、イベントは列で待つ。フックの入力に親の番号があれば、その場で拒める
  assert.equal(h.core.preToolUse({ agentId: 'late-child', parentAgentId: h.root, toolName: 'edit' }).deny, true);
  await h.clock.advance(LIMITS.STOP_DEADLINE_MS);
  assert.equal(h.run().status, 'finished');
  assert.equal(h.core.preToolUse({ agentId: 'late-child', toolName: 'edit' }).deny, true);
  // 終わった実行の後に届いた子も同じ
  await h.event({ type: 'agent.started', agentId: 'later-child', parentAgentId: 'late-child', agentType: `${PLUGIN}:worker`, executionMode: 'sync' });
  assert.equal(h.core.preToolUse({ agentId: 'later-child', toolName: 'edit' }).deny, true);
});

test('REQ-009 止めた後の記録のツールの呼び出しは、列に入れずにすぐ断る（列が止まっていても）', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  h.port.behave('cancelAgent', { hang: true });
  await h.core.stop();
  await h.settle();
  assert.match(await expectRefusal(h.tool('plan', h.planArgs(1), h.root)), /止められました/);
  await h.clock.advance(LIMITS.STOP_DEADLINE_MS);
  assert.match(await expectRefusal(h.tool('plan', h.planArgs(1), h.root)), /つながりが切れた/);
});

test('REQ-009 決めた時間（押してから 8 秒）のうちに止まらないと「止めきれなかったエージェントあり」になり、止まっていないエージェントと止め方が状態に入る', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  const worker = await h.spawn('worker');
  h.port.stubborn.add(worker);
  await h.core.stop();
  await h.clock.advance(LIMITS.STOP_DEADLINE_MS - 1);
  assert.equal(h.run().status, 'stopping');
  await h.clock.advance(1);
  const run = h.run();
  assert.equal(run.status, 'finished');
  assert.deepEqual([run.endReason.kind, run.endReason.unstoppable], ['user_stopped', true]);
  assert.deepEqual(run.unstopped.map((u) => [u.agentId, u.role]), [[worker, 'worker']]);
  assert.match(run.unstopped[0].howTo, /Esc を2回押す/);
  assert.equal(slotOf(run, 'worker').status, 'unstopped');
  assert.equal(slotOf(run, 'orchestrator').status, 'stopped');
  assert.ok(run.issues.some((i) => i.title.includes('止めても止まらない')), '課題に入る');
  assert.equal(h.core.preToolUse({ agentId: worker, toolName: 'edit' }).deny, true, '止まらないエージェントのツールは拒み続ける');
});

test('REQ-009 止めきれなかったエージェントが残っていても、次の開始ができる。古いエージェントのツールは拒み続ける', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  const worker = await h.spawn('worker');
  h.port.stubborn.add(worker);
  await h.core.stop();
  await h.clock.advance(LIMITS.STOP_DEADLINE_MS);
  const oldRoot = h.root;
  await h.core.open({ requestText: '次の依頼' });
  assert.equal(h.run(), null);
  assert.equal(h.state().previous.endReason.unstoppable, true);
  const p = h.core.start(h.settings());
  await h.settle();
  await p;
  assert.equal(h.port.callsOf('startAgent').length, 2);
  assert.equal(h.run().status, 'running');
  assert.equal(h.core.preToolUse({ agentId: worker, toolName: 'edit' }).deny, true);
  assert.equal(h.core.preToolUse({ agentId: oldRoot, toolName: 'edit' }).deny, true);
  const newRoot = h.port.tasks.filter((x) => x.agentType === `${PLUGIN}:orchestrator`).at(-1).agentId;
  assert.equal(h.core.preToolUse({ agentId: newRoot, toolName: 'edit' }).deny, false, '新しい実行の統括は拒まない');
});

test('REQ-009 取り消しの呼び出しが返らなくても、押してから 8 秒で終了になる', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  h.port.behave('cancelAgent', { hang: true });
  const pressed = h.clock.now();
  await h.core.stop();
  await h.clock.advance(LIMITS.STOP_DEADLINE_MS - 1);
  assert.equal(h.run().status, 'stopping');
  await h.clock.advance(1);
  const run = h.run();
  assert.equal(h.clock.now() - pressed, LIMITS.STOP_DEADLINE_MS);
  assert.equal(run.status, 'finished');
  assert.equal(run.endReason.kind, 'user_stopped');
  assert.equal(run.endReason.unstoppable, true);
  assert.deepEqual(run.unstopped.map((u) => u.agentId), [h.root]);
});

test('REQ-009 一覧が取れなくても、押してから 8 秒で終了になり、確かめられなかったエージェントが示される', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  const worker = await h.spawn('worker');
  h.port.behave('listTasks', { error: new Error('つながりません') });
  await h.core.stop();
  await h.clock.advance(LIMITS.STOP_DEADLINE_MS);
  const run = h.run();
  assert.equal(run.status, 'finished');
  assert.equal(run.endReason.unstoppable, true);
  assert.deepEqual(new Set(run.unstopped.map((u) => u.agentId)), new Set([h.root, worker]));
});

test('REQ-009 一覧の呼び出しが返らなくても、押してから 8 秒で終了になる（呼び出しの待ち時間の上限）', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  h.port.behave('listTasks', { hang: true });
  await h.core.stop();
  await h.clock.advance(LIMITS.STOP_DEADLINE_MS);
  assert.equal(h.run().status, 'finished');
});

test('REQ-009 止めるの間に増えたエージェント（一覧にだけ載っている子）も、木に入れて止まったかを確かめる', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  const worker = await h.spawn('worker');
  // 一覧にだけ載っている孫（開始のイベントが届いていない）
  h.port.spawn({ agentId: 'ghost', parentAgentId: worker, agentType: 'general-purpose', status: 'running' });
  h.port.stubborn.add('ghost');
  await h.core.stop();
  await h.clock.advance(LIMITS.STOP_DEADLINE_MS);
  const run = h.run();
  assert.deepEqual(run.unstopped.map((u) => u.agentId), ['ghost']);
  assert.equal(h.core.preToolUse({ agentId: 'ghost', toolName: 'edit' }).deny, true);
});

test('REQ-009 止めた後の統括・作業の終わりのイベントは、実行の状態を変えない', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  const worker = await h.spawn('worker');
  await h.core.stop();
  await h.settle();
  const before = JSON.stringify(h.run());
  await h.event({ type: 'agent.completed', agentId: worker, cancelled: true, response: '遅れて届いた' });
  await h.event({ type: 'agent.idle', agentId: h.root });
  assert.equal(JSON.stringify(h.run()), before);
});

test('REQ-009 まとめ中にユーザーが止めたときは、統括が足した Issue の案は出さず、機械的に分かる課題だけになる', async (t) => {
  const h = await makeHarness(t);
  await h.toSummarizing();
  await h.tool('issue', { title: '統括の案', body: '本文' }, h.root);
  await h.tool('finish', { summary: '統括のまとめ' }, h.root);
  await h.core.stop();
  await h.settle();
  const run = h.run();
  assert.equal(run.endReason.kind, 'user_stopped');
  assert.deepEqual(run.issues.filter((i) => i.source === 'orchestrator'), []);
  assert.notEqual(run.summary, '統括のまとめ', 'まとめは記録から機械的に作る');
  assert.match(run.summary, /試行は 1 回です/);
});

test('REQ-013 ユーザーが止めたときは、エージェントを動かさない（取り消しと一覧と上書きの操作だけ）', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  await h.tool('plan', h.planArgs(1), h.root);
  const before = h.port.calls.length;
  await h.core.stop();
  await h.settle();
  const methods = h.port.calls.slice(before).map((c) => c.method);
  assert.deepEqual([...new Set(methods)].sort(), ['cancelAgent', 'listTasks', 'setSubagentSettings']);
  assert.ok(!methods.includes('startAgent'));
});

test('REQ-009 止めたとき、止めた時点のフェーズと機械的なまとめが残る', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  await h.tool('plan', h.planArgs(1), h.root);
  await h.spawn('worker');
  await h.core.stop();
  await h.settle();
  assert.match(h.run().summary, /試行は 1 回です。最後の試行は、合否が記録される前に終わりました。終わった時点のフェーズは「実行」でした。/);
});
