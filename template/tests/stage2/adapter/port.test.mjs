// 2段目 部品の試験（つなぎ口）：窓口 port（BLUEPRINT 3.2）の呼び出しの形。
// 中心の処理の頼みを、Copilot CLI の呼び出し（session.rpc と session.log）に直す部分を、偽物の SDK で確かめる。
// 待ち時間の上限と、失敗の扱いは中心の処理が持つ。ここでは、呼び出しの形と、失敗がそのまま返ることを見る。
// 設計書：generated-plugin-structure.md 3.2、4.3、4.4、4.6、10章。
// 実行：node --test "tests/stage2/adapter/*.test.mjs"
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { PLUGIN, SETTINGS, TASK, beginRun, cleanupAll, sdkEvent, startChild, startPlugin } from './harness.mjs';

after(cleanupAll);

describe('窓口 port の呼び出しの形（REQ-007、REQ-009）', () => {
  test('REQ-007 startAgent は tasks.startAgent を、種類・名前・指示文・モデルで呼び、統括の番号だけを返す。モデルが空なら渡さない', async () => {
    const p = await startPlugin();
    const started = await p.port.startAgent({ agentType: `${PLUGIN}:orchestrator`, name: '統括 r1', model: 'gpt-6-luna', prompt: '頼まれた作業' });
    assert.deepEqual(Object.keys(started), ['agentId']);
    assert.equal(p.fake.task(started.agentId).displayName, '統括 r1');
    await p.port.startAgent({ agentType: `${PLUGIN}:orchestrator`, name: '統括 r2', model: '', prompt: 'もう一度' });
    await p.port.startAgent({ agentType: `${PLUGIN}:orchestrator`, name: '統括 r3', prompt: 'モデルなし' });
    const [first, second, third] = p.fake.callsOf('tasks.startAgent').map((c) => c.args);
    assert.deepEqual(first, { agentType: `${PLUGIN}:orchestrator`, name: '統括 r1', prompt: '頼まれた作業', model: 'gpt-6-luna' });
    assert.equal('model' in second, false);
    assert.equal('model' in third, false);
  });

  test('REQ-009 cancelAgent は tasks.cancel を、タスクの番号（id）で呼ぶ', async () => {
    const p = await startPlugin();
    const { agentId } = await p.port.startAgent({ agentType: `${PLUGIN}:orchestrator`, name: '統括', prompt: 'p' });
    assert.equal(await p.port.cancelAgent(agentId), undefined);
    assert.deepEqual(
      p.fake.callsOf('tasks.cancel').map((c) => c.args),
      [{ id: agentId }],
    );
    assert.equal(p.fake.task(agentId).status, 'cancelled');
  });

  test('REQ-009 listTasks は、エージェントのタスクだけを窓口の形で返す（シェルなどは除く）。親の番号は、開始のイベントから補う', async () => {
    const p = await startPlugin();
    p.fake.spawn({ agentId: 'ag-root', agentType: `${PLUGIN}:orchestrator`, displayName: '統括 r1', executionMode: 'background' });
    p.fake.spawn({ agentId: 'ag-w', parentAgentId: 'ag-root', agentType: 'worker', displayName: '作業', status: 'idle' });
    p.fake.spawn({ agentId: 'ag-x', agentType: 'explore', displayName: 'ユーザーの別の作業', status: 'completed' });
    p.fake.tasks.push({ type: 'shell', id: 'sh-1', description: '待つ', status: 'running', startedAt: '', command: 'sleep 100', attachmentMode: 'attached' });
    p.fake.tasks.push({ type: 'client', id: 'cl-1', description: '登録されたタスク', status: 'running' });
    const expected = (parents) => [
      { agentId: 'ag-root', displayName: '統括 r1', status: 'running', executionMode: 'background', agentType: `${PLUGIN}:orchestrator`, parentAgentId: parents.root },
      { agentId: 'ag-w', displayName: '作業', status: 'idle', executionMode: 'sync', agentType: `${PLUGIN}:worker`, parentAgentId: parents.w },
      { agentId: 'ag-x', displayName: 'ユーザーの別の作業', status: 'completed', executionMode: 'sync', agentType: 'explore', parentAgentId: null },
    ];
    // tasks.list には親の番号がない。開始のイベントを見る前は分からない
    assert.deepEqual(await p.port.listTasks(), expected({ root: null, w: null }));
    p.fake.emit(sdkEvent.subagentStarted('ag-root', { agentType: `${PLUGIN}:orchestrator` }));
    p.fake.emit(sdkEvent.subagentStarted('ag-w', { agentType: 'worker', parentId: 'ag-root' }));
    assert.deepEqual(await p.port.listTasks(), expected({ root: null, w: 'ag-root' }));
  });

  test('REQ-009 tasks.list の返り値が欠けていても、空の一覧になる', async () => {
    const p = await startPlugin();
    for (const value of [{}, { tasks: 5 }, { tasks: [null, 3, {}] }, null]) {
      p.fake.behave('tasks.list', { value });
      assert.deepEqual(await p.port.listTasks(), [], JSON.stringify(value));
    }
  });

  test('REQ-007 setSubagentSettings は updateSubagentSettings を { subagents: { agents: { <プラグイン>:<エージェント>: { model, effortLevel } } } } で呼ぶ。null で外す', async () => {
    const p = await startPlugin();
    await p.port.setSubagentSettings({
      [`${PLUGIN}:orchestrator`]: { effort: 'high' },
      [`${PLUGIN}:worker`]: { model: 'gpt-6-luna', effort: 'low' },
      [`${PLUGIN}:verifier`]: { model: 'claude-opus-5-5' },
    });
    const agents = {
      [`${PLUGIN}:orchestrator`]: { effortLevel: 'high' },
      [`${PLUGIN}:worker`]: { model: 'gpt-6-luna', effortLevel: 'low' },
      [`${PLUGIN}:verifier`]: { model: 'claude-opus-5-5' },
    };
    assert.deepEqual(p.fake.callsOf('tools.updateSubagentSettings').at(-1).args, { subagents: { agents } });
    assert.deepEqual(p.fake.overrides, { agents });
    await p.port.setSubagentSettings(null);
    assert.deepEqual(p.fake.callsOf('tools.updateSubagentSettings').at(-1).args, { subagents: null });
    assert.equal(p.fake.overrides, null);
    await p.port.setSubagentSettings(undefined);
    assert.deepEqual(p.fake.callsOf('tools.updateSubagentSettings').at(-1).args, { subagents: null });
  });

  test('REQ-007 getCurrentModel は { model, isAuto } を返す。モデルの番号が auto のときが Auto', async () => {
    const p = await startPlugin();
    const cases = [
      [{ modelId: 'claude-opus-5-5' }, { model: 'claude-opus-5-5', isAuto: false }],
      [{ modelId: 'auto', autoTier: 'balanced' }, { model: 'auto', isAuto: true }],
      [{ modelId: 'Auto' }, { model: 'Auto', isAuto: true }],
      [{ modelId: ' auto ' }, { model: ' auto ', isAuto: true }],
      [{ modelId: 'auto-ish' }, { model: 'auto-ish', isAuto: false }],
      [{ autoTier: 'balanced' }, { model: '', isAuto: false }],
      [{}, { model: '', isAuto: false }],
    ];
    for (const [current, expected] of cases) {
      p.fake.currentModel = current;
      assert.deepEqual(await p.port.getCurrentModel(), expected, JSON.stringify(current));
    }
    p.fake.behave('model.getCurrent', { value: null });
    assert.deepEqual(await p.port.getCurrentModel(), { model: '', isAuto: false });
  });

  test('REQ-007 listModels は session.rpc.model.list の一覧から、id と name を取り出す（形が決まっていないので、取り出せる要素だけを使う）', async () => {
    const p = await startPlugin();
    p.fake.models = ['a', { id: 'b', name: 'モデル B', capabilities: {} }, { id: 'c' }, { id: 'd', name: '' }, { name: '番号なし' }, null, 5, { id: '' }, { id: 7 }, ['e'], 'provider/f'];
    assert.deepEqual(await p.port.listModels(), [
      { id: 'a', name: 'a' },
      { id: 'b', name: 'モデル B' },
      { id: 'c', name: 'c' },
      { id: 'd', name: 'd' },
      { id: 'provider/f', name: 'provider/f' },
    ]);
    assert.equal(p.fake.callsOf('model.list').length, 1, 'rpc.models.list ではなく、session.rpc.model.list を呼ぶ');
    for (const value of [{}, { list: 'x' }, null]) {
      p.fake.behave('model.list', { value });
      assert.deepEqual(await p.port.listModels(), [], JSON.stringify(value));
    }
  });

  test('REQ-005 log は session.log に、文のまま渡す', async () => {
    const p = await startPlugin();
    await p.port.log('チャットに書く文');
    assert.deepEqual(p.fake.callsOf('session.log').map((c) => c.args.message), ['チャットに書く文']);
  });

  test('REQ-009 Copilot CLI の呼び出しが失敗したら、どの窓口もそのまま失敗する（時間の上限と失敗の扱いは中心の処理が持つ）', async () => {
    const p = await startPlugin();
    const calls = [
      ['tasks.startAgent', () => p.port.startAgent({ agentType: 'x', name: 'n', prompt: 'p' })],
      ['tasks.cancel', () => p.port.cancelAgent('ag-1')],
      ['tasks.list', () => p.port.listTasks()],
      ['tools.updateSubagentSettings', () => p.port.setSubagentSettings({ a: { model: 'b' } })],
      ['tools.updateSubagentSettings', () => p.port.setSubagentSettings(null)],
      ['model.getCurrent', () => p.port.getCurrentModel()],
      ['model.list', () => p.port.listModels()],
      ['session.log', () => p.port.log('x')],
    ];
    for (const [method, call] of calls) {
      p.fake.behave(method, { error: new Error(`${method} が失敗`) });
      await assert.rejects(call(), new RegExp(`${method.replace('.', '\\.')} が失敗`));
      p.fake.reset(method);
    }
  });
});

describe('中心の処理から見た窓口（REQ-007、REQ-009）', () => {
  test('REQ-007 開始すると、今のモデルを見て、作業と検証のモデルを上書きし、選んだモデルで統括を起動する（この順）', async () => {
    const p = await startPlugin();
    await beginRun(p);
    const methods = p.fake.calls.map((c) => c.method);
    assert.deepEqual(methods.slice(methods.lastIndexOf('model.getCurrent')), ['model.getCurrent', 'tools.updateSubagentSettings', 'tasks.startAgent']);
    assert.deepEqual(p.fake.callsOf('tools.updateSubagentSettings')[0].args, {
      subagents: { agents: { [`${PLUGIN}:worker`]: { model: SETTINGS.models.worker }, [`${PLUGIN}:verifier`]: { model: SETTINGS.models.verifier } } },
    });
    const [start] = p.fake.callsOf('tasks.startAgent');
    assert.equal(start.args.agentType, `${PLUGIN}:orchestrator`);
    assert.equal(start.args.model, SETTINGS.models.orchestrator);
    assert.ok(start.args.name.includes(p.core.getState().run.id), '名前に実行の番号が入る（遅れて起動した統括を探すため）');
    assert.ok(start.args.prompt.includes('2026-W42'), '作業ごとの設定の値');
    for (const criterion of TASK.criteria) assert.ok(start.args.prompt.includes(criterion.text), `基準 ${criterion.id} の文`);
  });

  test('REQ-009 止めると、統括の番号だけを取り消し、止まったかを一覧で確かめて、モデルの上書きを外す', async () => {
    const p = await startPlugin();
    const root = await beginRun(p);
    await startChild(p, { agentId: 'ag-w', parentAgentId: root, agent: 'worker' });
    await p.core.stop();
    await p.core.whenIdle();
    assert.deepEqual(
      p.fake.callsOf('tasks.cancel').map((c) => c.args),
      [{ id: root }],
    );
    assert.equal(p.fake.task(root).status, 'cancelled');
    assert.equal(p.fake.task('ag-w').status, 'cancelled', '統括を取り消すと、下のエージェントも止まる');
    assert.equal(p.fake.overrides, null, '終わったら上書きを外す');
    const run = p.core.getState().run;
    assert.equal(run.status, 'finished');
    assert.equal(run.endReason.kind, 'user_stopped');
    assert.ok(p.fake.callsOf('tasks.list').length >= 1, '止まったことを一覧で確かめる');
  });

  test('REQ-007 モデルの上書きや統括の起動が失敗したら、開始は準備中に戻り、理由が画面に出る', async () => {
    const p = await startPlugin();
    await p.fake.callTool(`${PLUGIN}_open`, { requestText: '週報を作る' });
    p.fake.behave('tasks.startAgent', { error: new Error('このモデルは使えません') });
    await assert.rejects(p.core.start(SETTINGS), /このモデルは使えません/);
    const state = p.core.getState();
    assert.equal(state.run, null);
    assert.match(state.startError.message, /このモデルは使えません/);
    assert.equal(p.fake.overrides, null, '失敗したときは上書きを外す');
  });
});
