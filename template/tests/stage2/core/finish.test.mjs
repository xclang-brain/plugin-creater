// 中心の処理：終わり方（設計書 4.8、6.1、10章「終わり方」）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { LIMITS, makeHarness, slotOf } from './harness.mjs';

const reasonOf = (run) => [run.endReason.kind, run.endReason.detail];

test('REQ-012 実行が終わると、残っている統括が取り消され、上書きが外れ、評価基準をすべて満たしたになる', async (t) => {
  const h = await makeHarness(t);
  await h.toSummarizing();
  await h.tool('finish', { summary: '週報を1回で作りました' }, h.root);
  await h.rootIdle();
  assert.equal(h.port.task(h.root).status, 'cancelled', '待ちで残っていた統括が取り消された');
  assert.deepEqual(h.port.argsOf('cancelAgent'), [h.root]);
  const run = h.run();
  assert.equal(run.status, 'finished');
  assert.deepEqual(reasonOf(run), ['all_passed', null]);
  assert.equal(run.endReason.unstoppable, false);
  assert.equal(run.summary, '週報を1回で作りました');
  assert.equal(h.port.overrides, null, '実行が終わったら、上書きを外す');
  const methods = h.port.calls.map((c) => c.method);
  assert.equal(methods.at(-1), 'setSubagentSettings');
  // 終わった実行の木のエージェントは、拒む一覧に入る
  for (const id of [h.root, ...h.port.tasks.map((x) => x.agentId)]) {
    assert.equal(h.core.preToolUse({ agentId: id, toolName: 'edit' }).deny, true, id);
  }
  // 終わった実行のエージェントが残らない
  assert.ok(run.agents.every((a) => !['running', 'waiting'].includes(a.status)));
});

test('REQ-012 終わった理由：上限の試行で合格しなかったときは「上限の回数に達した」', async (t) => {
  const h = await makeHarness(t);
  await h.begin({ maxIterations: 2 });
  await h.iterate(1, { pass: false });
  await h.iterate(2, { pass: false });
  await h.tool('finish', { summary: '2回やりましたが合格しませんでした' }, h.root);
  await h.rootIdle();
  assert.deepEqual(reasonOf(h.run()), ['max_iterations', null]);
});

test('REQ-012 画面で止めずに統括が取り消されると、「途中で終わった（チャットから中断された）」になる', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  await h.tool('plan', h.planArgs(1), h.root);
  h.port.setStatus(h.root, 'cancelled');
  await h.event({ type: 'agent.completed', agentId: h.root, cancelled: true });
  const run = h.run();
  assert.equal(run.status, 'finished');
  assert.deepEqual(reasonOf(run), ['aborted', 'chat_interrupted']);
  assert.equal(slotOf(run, 'orchestrator').status, 'stopped');
  assert.equal(h.port.callsOf('cancelAgent').length, 0, '止まっているので、取り消す必要がない');
});

test('REQ-012 統括が待ちに入ると（繰り返しを終えないまま）、実行中なら「途中で終わった」になり、課題に入る', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  await h.tool('plan', h.planArgs(1), h.root);
  await h.rootIdle();
  const run = h.run();
  assert.equal(run.status, 'finished');
  assert.deepEqual(reasonOf(run), ['aborted', 'orchestrator_ended']);
  assert.deepEqual(h.port.argsOf('cancelAgent'), [h.root]);
  assert.ok(run.issues.some((i) => i.title.includes('実行が途中で終わりました')));
});

test('REQ-012 統括が失敗すると、実行中なら「途中で終わった（統括の失敗）」になり、失敗の内容が残る', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  h.port.setStatus(h.root, 'failed');
  await h.event({ type: 'agent.failed', agentId: h.root, error: 'モデルが応答しませんでした' });
  const run = h.run();
  assert.deepEqual(reasonOf(run), ['aborted', 'orchestrator_failed']);
  assert.equal(run.endReason.message, 'モデルが応答しませんでした');
  assert.equal(slotOf(run, 'orchestrator').status, 'failed');
  assert.ok(run.issues.some((i) => i.body.includes('モデルが応答しませんでした')));
});

test('REQ-012 利用の上限の知らせに、クレジットを足さずに答えたか、答えが出ないままなら「AI クレジットの上限」になる', async (t) => {
  for (const answer of [null, 'cancel']) {
    const h = await makeHarness(t);
    await h.begin();
    await h.event({ type: 'wait.started', requestId: 'lim-1', kind: 'limit', detail: { maxAiCredits: 10, usedAiCredits: 10 } });
    if (answer) await h.event({ type: 'wait.ended', requestId: 'lim-1', kind: 'limit', action: answer });
    h.port.setStatus(h.root, 'cancelled');
    await h.event({ type: 'agent.completed', agentId: h.root, cancelled: true });
    assert.deepEqual(reasonOf(h.run()), ['aborted', 'credit_limit'], `answer=${answer}`);
  }
});

test('REQ-012 クレジットを足して続いた後に統括が終わったときは、AI クレジットの上限にならない', async (t) => {
  for (const action of ['add', 'set', 'unset']) {
    const h = await makeHarness(t);
    await h.begin();
    await h.event({ type: 'wait.started', requestId: 'lim-1', kind: 'limit', detail: {} });
    await h.event({ type: 'wait.ended', requestId: 'lim-1', kind: 'limit', action });
    await h.rootIdle();
    assert.deepEqual(reasonOf(h.run()), ['aborted', 'orchestrator_ended'], action);
  }
});

test('REQ-012 まとめ中に統括が待ちに入るか失敗するか取り消されても、合否の記録で決まる。まとめがなければ「まとめのない終わり」が課題に出る', async (t) => {
  const causes = {
    idle: async (h) => h.rootIdle(),
    failed: async (h) => {
      h.port.setStatus(h.root, 'failed');
      await h.event({ type: 'agent.failed', agentId: h.root, error: '失敗しました' });
    },
    cancelled: async (h) => {
      h.port.setStatus(h.root, 'cancelled');
      await h.event({ type: 'agent.completed', agentId: h.root, cancelled: true });
    },
  };
  for (const [name, cause] of Object.entries(causes)) {
    const h = await makeHarness(t);
    await h.toSummarizing();
    await cause(h);
    const run = h.run();
    assert.equal(run.status, 'finished', name);
    assert.deepEqual(reasonOf(run), ['all_passed', null], `${name}：きっかけによらず合否の記録で決まる`);
    assert.ok(run.issues.some((i) => i.title.includes('まとめを記録しないまま')), `${name}：まとめのない終わり`);
    assert.match(run.summary, /試行は 1 回です/, `${name}：まとめは記録から機械的に作る`);
  }
});

test('REQ-012 まとめ中の取り消しは、きっかけも課題に出る（チャットから中断された可能性、AI クレジットの上限）', async (t) => {
  const h = await makeHarness(t);
  await h.toSummarizing();
  h.port.setStatus(h.root, 'cancelled');
  await h.event({ type: 'agent.completed', agentId: h.root, cancelled: true });
  assert.ok(h.run().issues.some((i) => i.title.includes('まとめ中に統括エージェントが取り消されました')));

  const g = await makeHarness(t);
  await g.toSummarizing();
  await g.event({ type: 'wait.started', requestId: 'lim-2', kind: 'limit', detail: {} });
  await g.rootIdle();
  assert.deepEqual(reasonOf(g.run()), ['all_passed', null]);
  assert.ok(g.run().issues.some((i) => i.title.includes('AI クレジットの上限')));
});

test('REQ-012 まとめ中に上限の回数に達していれば、きっかけによらず「上限の回数に達した」になる', async (t) => {
  const h = await makeHarness(t);
  await h.begin({ maxIterations: 1 });
  await h.iterate(1, { pass: false });
  h.port.setStatus(h.root, 'failed');
  await h.event({ type: 'agent.failed', agentId: h.root, error: 'x' });
  assert.deepEqual(reasonOf(h.run()), ['max_iterations', null]);
});

test('REQ-013 まとめ中にまとめを記録しないまま終わると、それまでに足した Issue の案が残る', async (t) => {
  const h = await makeHarness(t);
  await h.toSummarizing();
  await h.tool('issue', { title: '統括の案', body: '振り返りで見つけたこと' }, h.root);
  await h.rootIdle();
  const run = h.run();
  assert.equal(run.status, 'finished');
  const orchestrator = run.issues.filter((i) => i.source === 'orchestrator');
  assert.deepEqual(orchestrator.map((i) => i.title), ['統括の案']);
  assert.ok(run.issues.some((i) => i.source === 'mechanical' && i.title.includes('まとめを記録しないまま')));
});

test('REQ-012 統括が終わっても、木に動いているエージェントが残っていれば、停止中を通って取り消される', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  await h.tool('plan', h.planArgs(1), h.root);
  const worker = await h.spawn('worker');
  h.port.behave('cancelAgent', { delay: 2000 });
  await h.rootIdle();
  assert.equal(h.run().status, 'stopping', '取り消している間は停止中');
  assert.equal(h.run().endReason, null);
  await h.clock.advance(2000);
  const run = h.run();
  assert.equal(run.status, 'finished');
  assert.deepEqual(reasonOf(run), ['aborted', 'orchestrator_ended']);
  assert.deepEqual(h.port.argsOf('cancelAgent'), [h.root]);
  assert.equal(slotOf(run, 'worker').status, 'stopped');
  assert.equal(h.core.preToolUse({ agentId: worker, toolName: 'edit' }).deny, true);
});

test('REQ-012 途中で終わったときに止まらないエージェントが残ると、「止めきれなかったエージェントあり」が添えられる', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  await h.tool('plan', h.planArgs(1), h.root);
  const worker = await h.spawn('worker');
  h.port.stubborn.add(worker);
  await h.rootIdle();
  assert.equal(h.run().status, 'stopping');
  await h.clock.advance(LIMITS.STOP_DEADLINE_MS);
  const run = h.run();
  assert.equal(run.status, 'finished');
  assert.deepEqual(reasonOf(run), ['aborted', 'orchestrator_ended']);
  assert.equal(run.endReason.unstoppable, true);
  assert.deepEqual(run.unstopped.map((u) => [u.agentId, u.role]), [[worker, 'worker']]);
  assert.match(run.unstopped[0].howTo, /Esc を2回/);
  assert.equal(slotOf(run, 'worker').status, 'unstopped');
});

test('REQ-008 実行の状態は記録のファイルに書かれ、終わったときの状態の全体が result.json に置かれる', async (t) => {
  const h = await makeHarness(t);
  await h.toSummarizing();
  await h.tool('finish', { summary: 'まとめ' }, h.root);
  await h.rootIdle();
  const runId = h.run().id;
  const result = JSON.parse(readFileSync(join(h.dataRoot, runId, 'result.json'), 'utf8'));
  assert.equal(result.status, 'finished');
  assert.equal(result.endReason.kind, 'all_passed');
  assert.equal(result.sessionId, h.sessionId);
  assert.equal(result.cwd, h.cwd);
  assert.ok(result.issues.every((i) => !('filing' in i)), '起票の状態は result.json に書かない');
  const lines = readFileSync(join(h.dataRoot, runId, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].t, 'begin');
  assert.equal(lines[0].sessionId, h.sessionId);
  assert.equal(lines[0].cwd, h.cwd);
  assert.ok(lines.some((l) => l.t === 'tree' && l.agentIds.includes(h.root)), '木に入れたエージェントの番号を書く');
  assert.ok(lines.some((l) => l.t === 'record' && l.tool === 'plan'));
  assert.ok(lines.some((l) => l.t === 'status' && l.status === 'finished'));
});

test('REQ-008 実行中は生きている印を数秒ごとに書き、終わると書かなくなる', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  const alivePath = join(h.dataRoot, h.run().id, 'alive');
  const first = Number(readFileSync(alivePath, 'utf8'));
  await h.clock.advance(LIMITS.ALIVE_INTERVAL_MS);
  assert.equal(Number(readFileSync(alivePath, 'utf8')), first + LIMITS.ALIVE_INTERVAL_MS);
  await h.core.stop();
  await h.clock.advance(1000);
  assert.equal(h.run().status, 'finished');
  const last = readFileSync(alivePath, 'utf8');
  await h.clock.advance(LIMITS.ALIVE_INTERVAL_MS * 3);
  assert.equal(readFileSync(alivePath, 'utf8'), last, '終わった実行の印は書き換わらない');
});
