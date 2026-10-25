// 2段目 部品の試験（つなぎ口）：本物の中心の処理（core）と画面のサーバーにつないだ場面。
// 偽物の SDK から、Copilot CLI が流すイベントとフックとツールの呼び出しを再現し、つなぎ口を通した結果が
// 画面の状態（core.getState と画面のサーバー）に正しく出るかを見る。Copilot CLI は要らない。
// 設計書：generated-plugin-structure.md 4.3〜4.14、5.1、5.2、6.1、6.5、10章。
// 実行：node --test "tests/stage2/adapter/*.test.mjs"
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { PLUGIN, SETTINGS, TASK, beginRun, cleanupAll, fetchApi, prepareStart, sdkEvent, startChild, startPlugin, tempDir } from './harness.mjs';

after(cleanupAll);

const planOf = () => ({ iteration: 1, criteria: TASK.criteria.map(({ id, text }) => ({ id, text })), plan: '先週の記録を読み、3行にまとめる' });
const allPass = () => ({ iteration: 1, verdicts: TASK.criteria.map((c) => ({ criterionId: c.id, pass: true })) });

// 記録のツールを、ある エージェントとして呼ぶ。断られたら失敗にする。
function recorder(p) {
  return async (name, args, agentId) => {
    const result = await p.fake.callTool(`${PLUGIN}_${name}`, args, { agentId });
    assert.equal(result.ok, true, `${name}：${result.error}`);
    return result.text;
  };
}

// エージェントが手番を終える：最後の返事のフック → 一覧で idle → 終わりのイベント → 待ちに入った知らせ（本物の Copilot CLI の順）
async function endTurn(p, agentId, reply, { status = 'completed' } = {}) {
  await p.fake.callHook('onSubagentStop', { agentId, response: reply });
  p.fake.task(agentId).status = status;
  p.fake.emit(sdkEvent.subagentCompleted(agentId));
  if (status === 'idle') p.fake.emit(sdkEvent.agentIdle(agentId));
  await p.core.whenIdle();
}

describe('頼んでから終わるまで（REQ-005、REQ-008、REQ-010、REQ-011、REQ-012）', () => {
  test('REQ-011 計画 → 作業 → 検証 → まとめ → 統括の終わり、まで通しで動き、終わった理由は「評価基準をすべて満たした」になる', async () => {
    const p = await startPlugin();
    const call = recorder(p);
    const root = await beginRun(p);
    assert.equal(p.core.getState().run.phase, 'plan');

    await call('plan', planOf(), root);
    await startChild(p, { agentId: 'ag-w', parentAgentId: root, agent: 'worker', model: 'gpt-6-luna' });
    assert.equal(p.core.getState().run.phase, 'do');
    p.fake.emit(sdkEvent.toolStart('ag-w', 'tc-1', 'view', { path: 'notes.md' }));
    p.fake.emit(sdkEvent.toolComplete('ag-w', 'tc-1'));
    await call('show', { key: 'draft', value: '下書きの本文です' }, 'ag-w');
    await endTurn(p, 'ag-w', '下書きを書きました');

    await startChild(p, { agentId: 'ag-v', parentAgentId: root, agent: 'verifier', model: 'claude-opus-5-5' });
    assert.equal(p.core.getState().run.phase, 'study');
    await call('verdict', allPass(), 'ag-v');
    await endTurn(p, 'ag-v', 'すべて合格です');
    assert.equal(p.core.getState().run.status, 'summarizing');

    await call('review', {}, root);
    await call('issue', { title: '作業の指示が長すぎる', body: '作業エージェントへの指示を短くすると、早く終わります。' }, root);
    await call('finish', { summary: '1回の試行で、すべての基準を満たしました。' }, root);
    await endTurn(p, root, '終わりました', { status: 'idle' });

    const run = p.core.getState().run;
    assert.equal(run.status, 'finished');
    assert.deepEqual(run.endReason, { kind: 'all_passed', detail: null, unstoppable: false });
    assert.equal(run.summary, '1回の試行で、すべての基準を満たしました。');
    assert.deepEqual(run.iterations[0].verdicts.map((v) => v.pass), [true, true]);
    assert.deepEqual(run.agents.map((a) => [a.slot, a.status, a.actualModel]), [
      ['orchestrator', 'completed', SETTINGS.models.orchestrator],
      ['worker', 'completed', 'gpt-6-luna'],
      ['verifier', 'completed', 'claude-opus-5-5'],
    ]);
    assert.ok(run.issues.some((i) => i.title === '作業の指示が長すぎる' && i.source === 'orchestrator'), '統括が足した Issue の案が残る');
    assert.deepEqual(
      p.fake.callsOf('tasks.cancel').map((c) => c.args),
      [{ id: root }],
      '手番を終えて idle で残った統括は、取り消す',
    );
    assert.equal(p.fake.overrides, null, '終わったらモデルの上書きを外す');
  });

  test('REQ-008 各エージェントの「担当」は、作業は task を呼んだときの説明、統括は頼まれた作業の要約になる（統括の表示名に置き換わらない）', async () => {
    const p = await startPlugin();
    const root = await beginRun(p);
    await startChild(p, { agentId: 'ag-w', parentAgentId: root, agent: 'worker', description: '先週の記録を3行にまとめる' });
    await startChild(p, { agentId: 'ag-v', parentAgentId: root, agent: 'verifier', description: '3行以内かを確かめる' });
    const tasks = Object.fromEntries(p.core.getState().run.agents.map((a) => [a.slot, a.task]));
    assert.deepEqual(tasks, { orchestrator: '週報を作る', worker: '先週の記録を3行にまとめる', verifier: '3行以内かを確かめる' });
  });

  test('REQ-012 最後の返事は、終わりのフック（onSubagentStop）で届き、画面の窓口（/api/agents/<番号>/reply）から全文が読める', async () => {
    const p = await startPlugin();
    const root = await beginRun(p);
    await startChild(p, { agentId: 'ag-w', parentAgentId: root, agent: 'worker' });
    const reply = '下書きを書きました。\n2行目です。';
    await endTurn(p, 'ag-w', reply);
    assert.equal(p.core.getReply('ag-w'), reply);
    const response = await fetchApi(p, '/api/agents/ag-w/reply');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: reply });
    assert.equal((await fetchApi(p, '/api/agents/ag-nobody/reply')).status, 404);
    const worker = p.core.getState().run.agents.find((a) => a.slot === 'worker');
    assert.ok(worker.replySummary.includes('下書きを書きました'), '状態の全体には要約だけが入る');
  });

  test('REQ-008 実際に動いたモデルがエージェントごとに画面の状態に出て、選んだモデルと違えば課題になる', async () => {
    const p = await startPlugin();
    const root = await beginRun(p);
    await startChild(p, { agentId: 'ag-w', parentAgentId: root, agent: 'worker', model: 'claude-haiku-5-5' }); // 選んだのは gpt-6-luna
    p.fake.emit(sdkEvent.subagentConfigured('ag-w', { model: 'claude-haiku-5-5' }));
    await p.core.whenIdle();
    const worker = p.core.getState().run.agents.find((a) => a.slot === 'worker');
    assert.equal(worker.actualModel, 'claude-haiku-5-5');
    assert.equal(worker.selectedModel, SETTINGS.models.worker);
    await p.core.stop();
    await p.core.whenIdle();
    assert.ok(p.core.getState().run.issues.some((i) => i.title.includes('選んだモデルと実際のモデルが違いました')));
  });

  test('REQ-013 同じツールを同じ引数で続けて呼んだ跡が、課題の一覧に出る（ツールの開始に引数がつくため）', async () => {
    const p = await startPlugin();
    const root = await beginRun(p);
    await startChild(p, { agentId: 'ag-w', parentAgentId: root, agent: 'worker' });
    for (let i = 1; i <= 3; i += 1) {
      p.fake.emit(sdkEvent.toolStart('ag-w', `tc-${i}`, 'bash', { command: 'npm test' }));
      p.fake.emit(sdkEvent.toolComplete('ag-w', `tc-${i}`));
    }
    await p.core.stop();
    await p.core.whenIdle();
    const titles = p.core.getState().run.issues.map((i) => i.title);
    assert.ok(titles.some((t) => t.includes('同じ「bash」を同じ内容で繰り返しました')), titles.join(' / '));
  });

  test('REQ-013 失敗したツールが、ツールの名前つきで課題の一覧に出る（終わりのイベントにない名前を補うため）', async () => {
    const p = await startPlugin();
    const root = await beginRun(p);
    await startChild(p, { agentId: 'ag-w', parentAgentId: root, agent: 'worker' });
    p.fake.emit(sdkEvent.toolStart('ag-w', 'tc-1', 'bash', { command: 'make' }));
    p.fake.emit(sdkEvent.toolComplete('ag-w', 'tc-1', { success: false, error: { message: 'make: 失敗しました' } }));
    await p.core.stop();
    await p.core.whenIdle();
    const issue = p.core.getState().run.issues.find((i) => i.title.includes('ツール「bash」が失敗しました'));
    assert.ok(issue, '課題が出る');
    assert.ok(issue.body.includes('make: 失敗しました'));
  });
});

describe('確認の待ち（REQ-005）', () => {
  test('REQ-005 この実行のエージェントの確認だけが「待ち」になる。メインのエージェントの確認と、エクステンション自身の権限の求めは出ない', async () => {
    const p = await startPlugin();
    const root = await beginRun(p);
    await startChild(p, { agentId: 'ag-w', parentAgentId: root, agent: 'worker' });
    const shell = { kind: 'shell', fullCommandText: 'rm -rf build', possiblePaths: [], possibleUrls: [] };
    p.fake.emit(sdkEvent.permissionRequested('ag-w', 'req-run', shell));
    p.fake.emit(sdkEvent.permissionRequested(undefined, 'req-main', shell)); // ユーザーがチャットでしているほかの作業
    p.fake.emit(sdkEvent.permissionRequested('ag-other', 'req-other', shell)); // この実行のエージェントではない
    p.fake.emit(sdkEvent.permissionRequested('ag-w', 'req-ext', { kind: 'extension-permission-access', extensionName: 'x', capabilities: ['register hooks'] }));
    p.fake.emit(sdkEvent.permissionRequested('ag-w', 'req-hook', shell, { resolvedByHook: true }));
    p.fake.emit(sdkEvent.userInputRequested('ag-w', 'req-q', '保存先はどこですか？'));
    await p.core.whenIdle();
    const waits = p.core.getState().run.waits;
    assert.deepEqual(waits.map((w) => [w.requestId, w.slot, w.kind]), [
      ['req-run', 'worker', 'permission'],
      ['req-q', 'worker', 'question'],
    ]);
    assert.equal(waits[1].detail.question, '保存先はどこですか？');
    assert.equal(p.core.getState().run.agents.find((a) => a.slot === 'worker').status, 'waiting');
    p.fake.emit(sdkEvent.permissionCompleted('req-run'));
    p.fake.emit(sdkEvent.userInputCompleted('req-q'));
    await p.core.whenIdle();
    assert.deepEqual(p.core.getState().run.waits, []);
    assert.equal(p.core.getState().run.agents.find((a) => a.slot === 'worker').status, 'running');
    assert.deepEqual(p.fake.answers, [], '確認には答えない');
  });

  test('REQ-005 エージェントの番号のない利用の上限の待ちは、実行全体の待ちになる。クレジットを足さずに答えて統括が終わると「AI クレジットの上限」', async () => {
    const p = await startPlugin();
    const root = await beginRun(p);
    p.fake.emit(sdkEvent.limitRequested('lim-1'));
    await p.core.whenIdle();
    const waits = p.core.getState().run.waits;
    assert.deepEqual(waits.map((w) => [w.requestId, w.slot, w.kind]), [['lim-1', null, 'limit']]);
    p.fake.emit(sdkEvent.limitCompleted('lim-1', 'cancel'));
    await endTurn(p, root, '', { status: 'idle' });
    const run = p.core.getState().run;
    assert.equal(run.status, 'finished');
    assert.deepEqual(run.endReason, { kind: 'aborted', detail: 'credit_limit', unstoppable: false });
  });
});

describe('止める・遅れて起動した統括（REQ-009）', () => {
  test('REQ-009 止めると、この実行のエージェントだけが止まり、止めた後のツールは拒まれる。ほかの作業は巻き込まない', async () => {
    const p = await startPlugin();
    const root = await beginRun(p);
    await startChild(p, { agentId: 'ag-w', parentAgentId: root, agent: 'worker' });
    p.fake.spawn({ agentId: 'ag-user', agentType: 'explore', status: 'running' }); // ユーザーがチャットでしているほかの作業
    await p.core.stop();
    await p.core.whenIdle();
    assert.equal(p.fake.task(root).status, 'cancelled');
    assert.equal(p.fake.task('ag-w').status, 'cancelled');
    assert.equal(p.fake.task('ag-user').status, 'running', 'ほかの作業は止めない');
    assert.equal(p.core.getState().run.endReason.kind, 'user_stopped');
    const hook = p.fake.config.hooks.onPreToolUse;
    assert.equal(hook({ toolName: 'edit', agentId: 'ag-w' }).permissionDecision, 'deny');
    assert.equal(hook({ toolName: 'edit', agentId: 'ag-user' }), undefined);
    const refused = await p.fake.callTool(`${PLUGIN}_show`, { key: 'draft', value: 'x' }, { agentId: 'ag-w' });
    assert.equal(refused.ok, false, '止めた後の記録のツールは断る');
  });

  test('REQ-009 どの実行の根でもない統括（遅れて起動したもの）は、取り消して拒む。種類が名前だけで届いても見分けられる', async () => {
    const p = await startPlugin();
    const root = await beginRun(p);
    p.fake.spawn({ agentId: 'ag-stray', agentType: 'orchestrator', executionMode: 'background' });
    p.fake.emit(sdkEvent.subagentStarted('ag-stray', { agentType: 'orchestrator', executionMode: 'background' }));
    await p.core.whenIdle();
    assert.deepEqual(
      p.fake.callsOf('tasks.cancel').map((c) => c.args),
      [{ id: 'ag-stray' }],
    );
    assert.equal(p.fake.task('ag-stray').status, 'cancelled');
    assert.notEqual(p.fake.task(root).status, 'cancelled', '本物の統括は取り消さない');
    assert.equal(p.fake.config.hooks.onPreToolUse({ toolName: 'bash', agentId: 'ag-stray' }).permissionDecision, 'deny');
    assert.equal(p.core.getState().run.status, 'running');
  });
});

describe('作業フォルダのファイル（REQ-031、REQ-006）', () => {
  test('REQ-031 作業フォルダの中のファイルは、記録のツールで知らせると画面の窓口から取れる。外のファイルは断る', async () => {
    const p = await startPlugin();
    const root = await beginRun(p);
    await startChild(p, { agentId: 'ag-w', parentAgentId: root, agent: 'worker' });
    writeFileSync(join(p.work, '週報.md'), '# 週報\n');
    const outside = tempDir('adapter-outside-');
    writeFileSync(join(outside, 'secret.md'), '秘密');
    const call = (args) => p.fake.callTool(`${PLUGIN}_show`, args, { agentId: 'ag-w' });

    const shown = await call({ key: 'report', value: '週報.md' });
    assert.equal(shown.ok, true, shown.error);
    const display = p.core.getState().run.displays.report;
    assert.equal(display.name, '週報.md');
    const file = await fetchApi(p, `/api/files/${display.fileId}`);
    assert.equal(file.status, 200);
    assert.equal(await file.text(), '# 週報\n');
    assert.match(file.headers.get('content-disposition'), /^attachment/);

    const refused = await call({ key: 'report', value: join(outside, 'secret.md') });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /作業フォルダの外/);
    mkdirSync(join(p.work, 'sub'));
    assert.equal((await call({ key: 'report', value: 'sub' })).ok, false, 'フォルダは断る');
    assert.equal((await fetchApi(p, '/api/files/f99')).status, 404);
  });
});

describe('エクステンションが起動し直されたとき（REQ-008、REQ-012）', () => {
  // 同じセッションのまま、エクステンションだけが起動し直される（extensions_reload など）。統括は動き続ける
  async function restartDuringRun({ agentsRemain }) {
    const first = await startPlugin();
    const root = await beginRun(first);
    await startChild(first, { agentId: 'ag-w', parentAgentId: root, agent: 'worker' });
    await first.handle.shutdown(); // プロセスが終わった。実行の記録は途中のまま残る
    if (!agentsRemain) first.fake.tasks.length = 0; // /clear の後のように、前の統括はもういない
    const prepared = await prepareStart({ fake: first.fake, copilotHome: first.copilotHome, cwd: first.work });
    const second = prepared.finish(await prepared.launch());
    await second.core.whenIdle();
    return { first, second, root };
  }

  test('REQ-008 同じセッションの終わっていない実行は、動いている統括と下のエージェントを取り消して「途中で終わった（エクステンションが再起動した）」になる', async () => {
    const { second, root } = await restartDuringRun({ agentsRemain: true });
    // 前の実行の木のエージェント（log.jsonl に書いた番号）のうち、動いているものを取り消す
    assert.deepEqual(second.fake.callsOf('tasks.cancel').map((c) => c.args.id).sort(), [root, 'ag-w'].sort());
    assert.equal(second.fake.task(root).status, 'cancelled');
    assert.equal(second.fake.task('ag-w').status, 'cancelled');
    // 取り消す前から、前の実行のエージェントのツールは拒む
    assert.equal(second.fake.config.hooks.onPreToolUse({ toolName: 'edit', agentId: 'ag-w' }).permissionDecision, 'deny');
    await second.fake.callTool(`${PLUGIN}_open`, { requestText: '週報を作る' });
    const previous = second.core.getState().previous;
    assert.deepEqual(previous.endReason, { kind: 'aborted', detail: 'extension_restarted', unstoppable: false });
  });

  test('REQ-008 前の統括がもういないとき（/clear の後など）は、「途中で終わった（途中で切れた）」になる', async () => {
    const { second } = await restartDuringRun({ agentsRemain: false });
    assert.deepEqual(second.fake.callsOf('tasks.cancel'), []);
    await second.fake.callTool(`${PLUGIN}_open`, { requestText: '週報を作る' });
    assert.deepEqual(second.core.getState().previous.endReason, { kind: 'aborted', detail: 'cut_off', unstoppable: false });
  });

  test('REQ-008 別のセッションの実行は、生きている印が新しいうちは、取り消さない', async () => {
    const first = await startPlugin({ sessionId: 'session-A' });
    const root = await beginRun(first);
    await first.handle.shutdown();
    const prepared = await prepareStart({ sessionId: 'session-B', copilotHome: first.copilotHome });
    const second = prepared.finish(await prepared.launch());
    await second.core.whenIdle();
    assert.deepEqual(second.fake.callsOf('tasks.cancel'), [], 'ほかのセッションのエージェントには触れない');
    assert.equal(second.fake.config.hooks.onPreToolUse({ toolName: 'edit', agentId: root }), undefined, '拒む一覧は自分のセッションの記録だけから作る');
  });
});

describe('人の判断待ち（REQ-051）', () => {
  test('REQ-051 統括が質問を記録して手番を終えると、待ちのまま残り、答えを渡すツールで同じ統括に答えが届いて、同じ実行が続く', async () => {
    const p = await startPlugin();
    const call = recorder(p);
    const root = await beginRun(p);
    await call('plan', planOf(), root);
    const asked = await call('ask', { question: 'ビルドが失敗しました。どうしますか？' }, root);
    assert.match(asked, /人の判断待ち/);
    await endTurn(p, root, '人の判断待ち\nビルドが失敗しました。どうしますか？', { status: 'idle' });
    let run = p.core.getState().run;
    assert.equal(run.status, 'waiting_human');
    assert.equal(run.humanWait.question, 'ビルドが失敗しました。どうしますか？');
    assert.equal(p.fake.callsOf('tasks.cancel').length, 0, '待っている統括は取り消さない');
    const state = await (await fetchApi(p, '/api/state')).json();
    assert.equal(state.run.humanWait.question, 'ビルドが失敗しました。どうしますか？', '画面のサーバーの状態にも出る');

    const answered = await p.fake.callTool(`${PLUGIN}_answer`, { answer: 'ツールチェーンは /opt/arm/bin です' });
    assert.equal(answered.ok, true, answered.error);
    const [sent] = p.fake.callsOf('tasks.sendMessage').map((c) => c.args);
    assert.equal(sent.id, root);
    assert.ok(sent.message.includes('ツールチェーンは /opt/arm/bin です'));
    run = p.core.getState().run;
    assert.equal(run.status, 'running');
    assert.equal(p.fake.task(root).status, 'running');

    // 続き：2回目からの手番の終わりは agent_idle だけ（subagent.completed は出ない）
    p.fake.emit(sdkEvent.toolStart(root, 'tc-r', 'view', { path: 'build.log' }));
    await startChild(p, { agentId: 'ag-w', parentAgentId: root, agent: 'worker', model: 'gpt-6-luna' });
    await endTurn(p, 'ag-w', '直しました');
    await startChild(p, { agentId: 'ag-v', parentAgentId: root, agent: 'verifier', model: 'claude-opus-5-5' });
    await call('verdict', allPass(), 'ag-v');
    await endTurn(p, 'ag-v', '合格です');
    await call('finish', { summary: '人の答えの後に合格しました。' }, root);
    await p.fake.callHook('onSubagentStop', { agentId: root, response: '終わりました' });
    p.fake.task(root).status = 'idle';
    p.fake.emit(sdkEvent.agentIdle(root));
    await p.core.whenIdle();
    run = p.core.getState().run;
    assert.equal(run.status, 'finished');
    assert.deepEqual(run.endReason, { kind: 'all_passed', detail: null, unstoppable: false });
    assert.equal(run.agents.find((a) => a.slot === 'orchestrator').replySummary, '終わりました', '2回目からの手番の返事も画面に出る');
    assert.equal(p.fake.callsOf('tasks.startAgent').length, 1);
  });
});
