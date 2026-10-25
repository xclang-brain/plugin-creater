// 中心の処理：状態の届け方、役割ごとのモデル、画面を開く（設計書 3.5、4.2、4.5、4.6）
import assert from 'node:assert/strict';
import test from 'node:test';
import { LIMITS, makeHarness, PLUGIN, slotOf, TASK } from './harness.mjs';

const TWO_WORKERS = {
  ...TASK,
  workers: [
    { agent: 'worker', label: '下書きを書く係' },
    { agent: 'worker-review', label: '見直す係' },
  ],
};

test('REQ-008 エージェントの枠は、役割ごとに決まった数で出る（統括 1、作業は定義の数、検証 1）', async (t) => {
  const h = await makeHarness(t, { task: TWO_WORKERS });
  await h.begin();
  const { agents } = h.run();
  assert.deepEqual(agents.map((a) => [a.slot, a.role, a.label]), [
    ['orchestrator', 'orchestrator', '統括'],
    ['worker', 'worker', '下書きを書く係'],
    ['worker-review', 'worker', '見直す係'],
    ['verifier', 'verifier', '検証'],
  ]);
  assert.deepEqual(agents.map((a) => a.status), ['running', 'standby', 'standby', 'standby']);
  assert.deepEqual(agents.map((a) => a.selectedModel), ['claude-opus-5-5', 'gpt-6-luna', 'gpt-6-luna', 'claude-opus-5-5']);
  assert.equal(agents[0].agentId, h.root);
});

test('REQ-008 作業が 2 体以上のとき、作業ごとのモデルの上書きが、それぞれのエージェントの名前に付く', async (t) => {
  const h = await makeHarness(t, { task: TWO_WORKERS });
  await h.begin();
  assert.deepEqual(h.port.overrides, {
    [`${PLUGIN}:worker`]: { model: 'gpt-6-luna' },
    [`${PLUGIN}:worker-review`]: { model: 'gpt-6-luna' },
    [`${PLUGIN}:verifier`]: { model: 'claude-opus-5-5' },
  });
});

test('REQ-007 作業が 2 体以上のとき、思考の深さは作業エージェントごとに選べる', async (t) => {
  const h = await makeHarness(t, { task: TWO_WORKERS });
  await h.core.open({ requestText: 'x' });
  assert.deepEqual(h.state().setup.effortAgents, [
    { agent: 'orchestrator', label: '統括' },
    { agent: 'worker', label: '作業（下書きを書く係）' },
    { agent: 'worker-review', label: '作業（見直す係）' },
    { agent: 'verifier', label: '検証' },
  ]);
  const p = h.core.start(h.settings({ efforts: { 'worker-review': 'xhigh', verifier: 'max' } }));
  await h.settle();
  await p;
  assert.deepEqual(h.port.overrides, {
    [`${PLUGIN}:worker`]: { model: 'gpt-6-luna' },
    [`${PLUGIN}:worker-review`]: { model: 'gpt-6-luna', effort: 'xhigh' },
    [`${PLUGIN}:verifier`]: { model: 'claude-opus-5-5', effort: 'max' },
  });
});

test('REQ-008 今が計画・実行・評価のどれかは、動いているエージェントで決まる', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  assert.equal(h.run().phase, 'plan', '統括だけが動いている');
  await h.tool('plan', h.planArgs(1), h.root);
  const worker = await h.spawn('worker');
  assert.equal(h.run().phase, 'do');
  await h.event({ type: 'wait.started', requestId: 'p-1', agentId: worker, kind: 'permission', detail: { toolKind: 'shell', command: 'ls' } });
  assert.equal(h.run().phase, 'do', '確認の待ちも、動いているうち');
  await h.event({ type: 'wait.ended', requestId: 'p-1', kind: 'permission' });
  await h.complete(worker);
  assert.equal(h.run().phase, 'plan', '作業が終わって、統括だけが動いている');
  const verifier = await h.spawn('verifier');
  assert.equal(h.run().phase, 'study');
  await h.tool('verdict', h.verdictArgs(1), verifier);
  await h.complete(verifier);
  assert.equal(h.run().status, 'summarizing');
  assert.equal(h.run().phase, null, 'まとめ中はフェーズを出さない');
  await h.rootIdle();
  assert.equal(h.run().phase, null);
  assert.equal(h.run().iteration, 1);
});

test('REQ-008 エージェントごとに、担当、実際のモデル、最後に動いた時刻が状態に入り、試行ごとに起動し直したエージェントは同じ枠で入れ替わる', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  await h.tool('plan', h.planArgs(1), h.root);
  await h.clock.advance(5000);
  const first = await h.spawn('worker', { id: 'w-1', description: '週報の下書きを書く', model: 'gpt-6-luna' });
  let slot = slotOf(h.run(), 'worker');
  assert.deepEqual([slot.agentId, slot.task, slot.actualModel, slot.status], ['w-1', '週報の下書きを書く', 'gpt-6-luna', 'running']);
  assert.equal(slot.lastActiveAt, h.clock.now());
  await h.clock.advance(1000);
  await h.event({ type: 'agent.configured', agentId: first, model: 'gpt-6-luna-high' });
  slot = slotOf(h.run(), 'worker');
  assert.equal(slot.actualModel, 'gpt-6-luna-high');
  assert.equal(slot.lastActiveAt, h.clock.now());
  await h.event({ type: 'tool.started', agentId: first, toolCallId: 't', toolName: 'view' });
  assert.equal(slotOf(h.run(), 'worker').lastActiveAt, h.clock.now());
  await h.complete(first);
  await h.tool('plan', { ...h.planArgs(2) }, h.root);
  const second = await h.spawn('worker', { id: 'w-2', description: '直して書く' });
  slot = slotOf(h.run(), 'worker');
  assert.deepEqual([slot.agentId, slot.task, slot.status, slot.replySummary], [second, '直して書く', 'running', ''], '同じ枠の中で入れ替わる');
  // 起動ごとの履歴は、試行ごとの表に出る
  assert.deepEqual(h.run().iterations.map((i) => i.agentIds), [['w-1'], ['w-2']]);
});

test('REQ-008 最後の返事は、状態には要約だけが入り、全文は別の窓口で取れる', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  const worker = await h.spawn('worker');
  const long = `${'とても長い返事です。'.repeat(60)}\n終わり`;
  await h.complete(worker, { response: long });
  const slot = slotOf(h.run(), 'worker');
  assert.ok(slot.replySummary.length <= LIMITS.REPLY_SUMMARY_CHARS + 1);
  assert.ok(slot.replySummary.endsWith('…'));
  assert.ok(!slot.replySummary.includes('\n'));
  assert.ok(!JSON.stringify(h.state()).includes('終わり'), '全文は状態に入らない');
  assert.equal(h.core.getReply(worker), long);
  assert.equal(h.core.getReply('unknown'), null);
  const short = await h.spawn('worker', { id: 'w-2' });
  await h.complete(short, { response: '  できました  ' });
  assert.equal(slotOf(h.run(), 'worker').replySummary, 'できました');
});

test('REQ-008 終わったエージェントが「実行中」のまま残らない（完了・失敗・手番の終わり）', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  await h.tool('plan', h.planArgs(1), h.root);
  const worker = await h.spawn('worker');
  await h.complete(worker);
  assert.equal(slotOf(h.run(), 'worker').status, 'completed');
  const verifier = await h.spawn('verifier');
  h.port.setStatus(verifier, 'failed');
  await h.event({ type: 'agent.failed', agentId: verifier, error: '失敗' });
  assert.equal(slotOf(h.run(), 'verifier').status, 'failed');
  const again = await h.spawn('worker', { id: 'w-3' });
  await h.event({ type: 'agent.idle', agentId: again });
  assert.equal(slotOf(h.run(), 'worker').status, 'completed');
});

test('REQ-008 状態の版の番号は、状態が変わるたびに上がり、変わらないときは同じ', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  const v1 = h.state().version;
  assert.equal(h.state().version, v1);
  await h.tool('plan', h.planArgs(1), h.root);
  const v2 = h.state().version;
  assert.ok(v2 > v1);
  await h.spawn('worker');
  assert.ok(h.state().version > v2);
});

test('REQ-005 画面を開くと URL が返り、実行中に開くツールがまた呼ばれたら、新しく始めず今の URL を返す', async (t) => {
  const h = await makeHarness(t);
  const first = await h.core.open({ requestText: '最初の依頼' });
  assert.equal(first.url, 'http://127.0.0.1:9/?k=test');
  assert.ok(first.notices.some((n) => n.includes('/clear')));
  assert.ok(first.notices.some((n) => n.includes('チャットで答えてください')));
  assert.equal(h.state().setup.requestText, '最初の依頼');
  const p = h.core.start(h.settings());
  await h.settle();
  await p;
  const id = h.run().id;
  const again = await h.core.open({ requestText: '別の依頼' });
  assert.equal(again.url, first.url);
  // 新しい頼みの文は受け付けない。黙って捨てずに、始められないことを知らせる（準備中の知らせにはない文）
  const busy = 'いまの実行が終わるまで、新しい作業は始められません。今の画面で実行の様子を見られます。変えた作業を頼むときは、画面で止めてから、もう一度チャットで頼んでください。';
  assert.ok(!first.notices.includes(busy), '準備中には出さない');
  assert.equal(again.notices[0], busy);
  assert.ok(again.notices.some((n) => n.includes('/clear')), '準備中と同じ知らせも付く');
  assert.ok(again.notices.some((n) => n.includes('チャットで答えてください')));
  assert.equal(h.run().id, id, '新しい実行を始めない');
  assert.equal(h.state().setup.requestText, '最初の依頼', '実行中は依頼の文を変えない');
  assert.equal(h.uiCalls.length, 1, '画面は 1 回だけ起こす');
  assert.equal(h.port.callsOf('startAgent').length, 1);
});

test('REQ-005 終わった後に開くツールが呼ばれたら、新しい実行の準備に戻り、前の結果と案を開ける', async (t) => {
  const h = await makeHarness(t);
  await h.toSummarizing();
  await h.tool('issue', { title: '案', body: '本文' }, h.root);
  await h.tool('finish', { summary: '週報ができました' }, h.root);
  await h.rootIdle();
  const finishedId = h.run().id;
  const reopened = await h.core.open({ requestText: '次の依頼' });
  assert.ok(!reopened.notices.some((n) => n.includes('新しい作業は始められません')), '終わった後は、新しい作業を始められる');
  const state = h.state();
  assert.equal(state.run, null);
  assert.equal(state.previous.runId, finishedId);
  assert.equal(state.previous.endReason.kind, 'all_passed');
  assert.equal(state.previous.summary, '週報ができました');
  assert.deepEqual(state.previous.issues.map((i) => [i.id, i.title, i.filing.state]), [['O1', '案', 'none']]);
  assert.ok(state.previous.finishedAt > 0);
  assert.equal(state.setup.requestText, '次の依頼');
  assert.equal(h.uiCalls.length, 1);
  // 準備中に戻ったので、また開始できる
  const p = h.core.start(h.settings());
  await h.settle();
  await p;
  assert.equal(h.run().status, 'running');
  assert.equal(h.state().previous, null, '実行中は前の結果を出さない');
});

test('REQ-007 開始前の設定の初めの値は、エージェントの定義の model から決まり、選択肢は選べるモデルの一覧から出る', async (t) => {
  const h = await makeHarness(t);
  await h.core.open({ requestText: 'x' });
  const { setup } = h.state();
  assert.deepEqual(setup.models.map((m) => m.id), ['claude-opus-5-5', 'gpt-6-luna', 'claude-haiku-5-5']);
  // 統括と検証は思考力の高いモデル、作業は費用の低いモデル（定義の model の最初に選べるもの）
  assert.deepEqual(setup.defaults, { orchestrator: 'claude-opus-5-5', worker: 'claude-haiku-5-5', verifier: 'claude-opus-5-5' });
  assert.equal(setup.maxIterationsDefault, 3);
  // 思考の深さの選択肢は、公式の --effort の値。統括・作業・検証のそれぞれに選ぶ
  assert.deepEqual(setup.effortLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(setup.effortAgents.map((a) => a.agent), ['orchestrator', 'worker', 'verifier']);
  assert.deepEqual(setup.taskSettings.map((s) => s.key), ['week', 'items', 'tone', 'attach']);
  assert.equal(setup.isAuto, false);
  assert.equal(setup.autoNotice, null);
  assert.match(setup.overrideNotice, /このチャットでほかのエージェントに設定したモデルと思考の深さの指定も消えます/);
  assert.doesNotMatch(setup.overrideNotice, /セッション|サブエージェント/, '説明のない言葉を使わない（REQ-025）');
});

test('REQ-007 定義の model の最初が選べるモデルになければ、その次のものを使う。リストにないときは今のモデル', async (t) => {
  const h = await makeHarness(t);
  h.port.models = [{ id: 'gpt-6-luna', name: 'GPT-6 Luna' }, { id: 'claude-opus-5-5', name: 'Opus' }];
  h.port.currentModel = { model: 'gpt-6-luna', isAuto: false };
  await h.core.open({ requestText: 'x' });
  // 作業の定義は [claude-haiku-5-5, gpt-6-luna]：最初は選べないので 2 番目
  assert.equal(h.state().setup.defaults.worker, 'gpt-6-luna');
  const g = await makeHarness(t);
  g.port.models = [{ id: 'a-model', name: 'A' }, { id: 'b-model', name: 'B' }];
  g.port.currentModel = { model: 'b-model', isAuto: false };
  await g.core.open({ requestText: 'x' });
  assert.deepEqual(g.state().setup.defaults, { orchestrator: 'b-model', worker: 'b-model', verifier: 'b-model' });
});

test('REQ-007 選べるモデルの一覧が取れないか形が違うときは、定義の既定と今のモデルだけを選択肢にする', async (t) => {
  const h = await makeHarness(t);
  h.port.behave('listModels', { error: new Error('取れません') });
  await h.core.open({ requestText: 'x' });
  assert.deepEqual(h.state().setup.models.map((m) => m.id).sort(), ['claude-haiku-5-5', 'claude-opus-5-5']);
  // 要素が文字列や別の名前の項目でも読める（形が型で決まっていない）
  const g = await makeHarness(t);
  g.port.models = ['m-1', { modelId: 'm-2', displayName: '二番目' }, { id: 'm-3', name: '三番目' }, 42, null, { id: 'm-1' }];
  await g.core.open({ requestText: 'x' });
  assert.deepEqual(g.state().setup.models, [{ id: 'm-1', name: 'm-1' }, { id: 'm-2', name: '二番目' }, { id: 'm-3', name: '三番目' }]);
});

test('REQ-007 モデルが Auto のときも、同じ手順で開始し、「効かないことがあります」と実際のモデルを示す', async (t) => {
  const h = await makeHarness(t);
  h.port.currentModel = { model: 'auto', isAuto: true };
  await h.core.open({ requestText: 'x' });
  assert.equal(h.state().setup.isAuto, true);
  assert.equal(h.state().setup.autoNotice, 'Auto のため、役割ごとのモデルが効かないことがあります');
  const p = h.core.start(h.settings());
  await h.settle();
  await p;
  // 選んだモデルで統括を起動し、作業・検証の上書きもする
  assert.equal(h.port.argsOf('startAgent')[0].model, 'claude-opus-5-5');
  assert.deepEqual(h.port.overrides, { [`${PLUGIN}:worker`]: { model: 'gpt-6-luna' }, [`${PLUGIN}:verifier`]: { model: 'claude-opus-5-5' } });
  assert.equal(h.run().isAuto, true);
  h.root = h.port.tasks[0].agentId;
  await h.event({ type: 'agent.started', agentId: h.root, agentType: `${PLUGIN}:orchestrator`, model: 'gpt-6-luna', executionMode: 'background' });
  const slot = slotOf(h.run(), 'orchestrator');
  assert.equal(slot.selectedModel, 'claude-opus-5-5');
  assert.equal(slot.actualModel, 'gpt-6-luna', '実際に動いたモデルを、選んだモデルと分けて出す');
});

test('REQ-005 画面を起こす部品が失敗したときは、平易な日本語の Error になり、次の呼び出しでまた試す', async (t) => {
  let fail = true;
  const h = await makeHarness(t, {
    startUi: async () => {
      if (fail) throw new Error('ポートを開けません');
      return { url: 'http://127.0.0.1:1/?k=a', close: async () => {} };
    },
  });
  await assert.rejects(h.core.open({ requestText: 'x' }), /画面を開けませんでした：ポートを開けません/);
  fail = false;
  assert.equal((await h.core.open({ requestText: 'x' })).url, 'http://127.0.0.1:1/?k=a');
});

test('REQ-031 開始の設定で省いた作業ごとの項目は、定義の初めの値になる', async (t) => {
  const h = await makeHarness(t);
  await h.core.open({ requestText: 'x' });
  const p = h.core.start({ maxIterations: 2, task: { week: '2026-W01' } });
  await h.settle();
  await p;
  const { settings } = h.run();
  assert.deepEqual(settings.task, { week: '2026-W01', items: 5, tone: 'desu', attach: false });
  assert.deepEqual(settings.models, { orchestrator: 'claude-opus-5-5', worker: 'claude-haiku-5-5', verifier: 'claude-opus-5-5' });
  assert.equal(settings.maxIterations, 2);
});

test('REQ-005 状態の全体に、実行中は /clear しないことと、確認はチャットで答えることの注意が入る', async (t) => {
  const h = await makeHarness(t);
  await h.core.open({ requestText: 'x' });
  assert.deepEqual(h.state().notices, []);
  const p = h.core.start(h.settings());
  await h.settle();
  await p;
  const { notices } = h.state();
  assert.ok(notices.some((n) => n.includes('/clear')));
  assert.ok(notices.some((n) => n.includes('チャットで答えてください')));
});

test('REQ-031 作業ごとの表示の定義（displays）は、状態の全体の setup.taskDisplays に必ず入る', async (t) => {
  const h = await makeHarness(t);
  assert.deepEqual(h.state().setup.taskDisplays, TASK.displays, '画面を開く前から');
  await h.core.open({ requestText: 'x' });
  assert.deepEqual(h.state().setup.taskDisplays, TASK.displays);
  await h.begin();
  assert.deepEqual(h.state().setup.taskDisplays, TASK.displays, '実行中も');
});

test('REQ-014 準備中に開ける前の結果（previous）にも、起票できるかとその理由と手順（canFile）が入る', async (t) => {
  const h = await makeHarness(t); // gh が入っていない環境
  await h.toSummarizing();
  await h.tool('finish', { summary: 'まとめ' }, h.root);
  await h.rootIdle();
  await h.core.open({ requestText: '次の依頼' });
  const { previous } = h.state();
  assert.ok(previous.canFile, 'canFile がある');
  for (const key of ['ok', 'reason', 'steps']) assert.ok(key in previous.canFile, key);
  assert.equal(typeof previous.canFile.ok, 'boolean');
  assert.ok(Array.isArray(previous.canFile.steps));
  // 実行中の run.canFile も同じ形
  const p = h.core.start(h.settings());
  await h.settle();
  await p;
  assert.deepEqual(Object.keys(h.run().canFile).sort(), Object.keys(previous.canFile).sort());
});

test('REQ-005 開始中や停止中に画面を開くツールが呼ばれても、新しい作業は始められないと知らせる', async (t) => {
  const h = await makeHarness(t);
  await h.core.open({ requestText: '最初の依頼' });
  h.port.behave('startAgent', { delay: 3000 });
  const started = h.core.start(h.settings());
  await h.settle();
  assert.equal(h.run().status, 'starting');
  const whileStarting = await h.core.open({ requestText: '別の依頼' });
  assert.match(whileStarting.notices[0], /新しい作業は始められません/);
  assert.equal(h.state().setup.requestText, '最初の依頼');
  await h.clock.advance(3000);
  await started;
  h.port.behave('cancelAgent', { hang: true });
  await h.core.stop();
  assert.equal(h.run().status, 'stopping');
  const whileStopping = await h.core.open({ requestText: '別の依頼' });
  assert.match(whileStopping.notices[0], /新しい作業は始められません/);
  await h.clock.advance(LIMITS.STOP_DEADLINE_MS);
  assert.equal(h.run().status, 'finished');
});
