// 2段目 部品の試験（つなぎ口）：フック（onPreToolUse）と、許可の求めの受け口（onPermissionRequest）。
// どちらも、例外を投げないこと、すぐ答えることが決まりである（設計書 4.4、4.14）。
// 偽物の SDK は本物の SDK と同じく、フックの例外を「拒まずに進む」にし、許可の求めの受け口の例外を user-not-available の答えにする。
// そのため、例外を投げないことは、登録された関数を直接呼んで確かめる。
// 設計書：generated-plugin-structure.md 4.4、4.14、6.1、10章。
// 実行：node --test "tests/stage2/adapter/*.test.mjs"
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { PLUGIN, TOOLS, beginRun, cleanupAll, delay, holdAfterJoin, sdkEvent, startChild, startPlugin, until } from './harness.mjs';

after(cleanupAll);

// 標準エラーへの出力を捕まえる（わざと失敗させる試験で、出力を散らかさず、残ったことも確かめるため）
async function captureErrors(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

async function stoppedRun() {
  const p = await startPlugin();
  const root = await beginRun(p);
  await startChild(p, { agentId: 'ag-w', parentAgentId: root, agent: 'worker' });
  await startChild(p, { agentId: 'ag-v', parentAgentId: root, agent: 'verifier' });
  await p.core.stop();
  await p.core.whenIdle();
  return { p, root };
}

describe('ツールを使ってよいかの問い合わせ（onPreToolUse。REQ-009）', () => {
  test('REQ-009 実行がないとき、動いている実行のエージェント、メインのエージェントのツールは、通す（何も返さない）', async () => {
    const p = await startPlugin();
    const hook = p.fake.config.hooks.onPreToolUse;
    assert.equal(hook({ toolName: 'bash', agentId: 'ag-1' }), undefined);
    assert.equal(hook({ toolName: 'bash' }), undefined);
    const root = await beginRun(p);
    await startChild(p, { agentId: 'ag-w', parentAgentId: root, agent: 'worker' });
    for (const input of [{ toolName: 'view', agentId: root }, { toolName: 'edit', agentId: 'ag-w', parentAgentId: root }, { toolName: 'bash' }]) {
      assert.equal(hook(input), undefined, JSON.stringify(input));
    }
  });

  test('REQ-009 止めた実行の統括・作業・検証のツールだけを、deny と理由で拒む。メインのエージェントとほかの作業は巻き込まない', async () => {
    const { p, root } = await stoppedRun();
    const hook = p.fake.config.hooks.onPreToolUse;
    for (const agentId of [root, 'ag-w', 'ag-v']) {
      const result = hook({ toolName: 'edit', agentId });
      assert.deepEqual(Object.keys(result).sort(), ['permissionDecision', 'permissionDecisionReason']);
      assert.equal(result.permissionDecision, 'deny');
      assert.match(result.permissionDecisionReason, /止められ/);
      assert.match(result.permissionDecisionReason, /edit/, '理由にツールの名前が入る');
    }
    assert.equal(hook({ toolName: 'edit' }), undefined, 'メインのエージェントのツールは通す');
    assert.equal(hook({ toolName: 'edit', agentId: 'ag-other' }), undefined, 'ユーザーがチャットでしているほかの作業は通す');
    // 拒む一覧のエージェントの子は、新しく現れても拒む
    assert.equal(hook({ toolName: 'edit', agentId: 'ag-late', parentAgentId: 'ag-w' }).permissionDecision, 'deny');
    assert.equal(hook({ toolName: 'edit', agentId: 'ag-late' })?.permissionDecision, 'deny', '一度拒んだ番号は、その後も拒む');
  });

  test('REQ-009 偽物の SDK のフックの呼び方（例外は拒まずに進む）でも、止めた実行のツールは拒まれる', async () => {
    const { p, root } = await stoppedRun();
    assert.deepEqual(await p.fake.callHook('onPreToolUse', { toolName: 'bash', agentId: root }), {
      permissionDecision: 'deny',
      permissionDecisionReason: `この実行は止められたため、ツール「bash」は使えません。`,
    });
    assert.equal(await p.fake.callHook('onPreToolUse', { toolName: 'bash', agentId: 'ag-other' }), undefined);
  });

  test('REQ-009 止めるを押した時点で、同期で答え、すぐ拒む（止める処理が終わるのを待たない）', async () => {
    const p = await startPlugin();
    const root = await beginRun(p);
    const stopping = p.core.stop();
    const result = p.fake.config.hooks.onPreToolUse({ toolName: 'edit', agentId: root });
    assert.ok(!(result instanceof Promise), 'Promise を返さない');
    assert.equal(result.permissionDecision, 'deny');
    await stopping;
    await p.core.whenIdle();
  });

  test('REQ-009 入力が壊れていても、例外を投げない。中で失敗しても、拒む一覧のエージェントは拒む', async () => {
    const { p, root } = await stoppedRun();
    const hook = p.fake.config.hooks.onPreToolUse;
    const hostile = { agentId: root, get toolName() { throw new Error('壊れた入力'); } };
    const verdict = hook(hostile);
    assert.equal(verdict.permissionDecision, 'deny', '中で失敗しても、拒む一覧のエージェントは拒む');
    for (const input of [undefined, null, 5, 'x', [], {}, { agentId: 5 }, { agentId: {}, toolName: {} }, { toolName: 5, agentId: 'ag-other' }]) {
      assert.doesNotThrow(() => hook(input), JSON.stringify(input));
      assert.equal(hook(input), undefined, `拒む一覧にないものは通す：${JSON.stringify(input)}`);
    }
  });

  test('REQ-009 中心の処理がフックの中で失敗しても、フックは例外を投げず、通す。失敗は標準エラーに残す', async () => {
    const p = await startPlugin();
    const hook = p.fake.config.hooks.onPreToolUse;
    p.core.preToolUse = () => {
      throw new Error('中心の処理の失敗');
    };
    const lines = await captureErrors(async () => {
      assert.doesNotThrow(() => hook({ toolName: 'bash', agentId: 'ag-1' }));
      assert.equal(hook({ toolName: 'bash', agentId: 'ag-1' }), undefined);
    });
    assert.equal(lines.length, 2);
    assert.match(lines[0], /つなぎ口/);
    p.core.preToolUse = () => ({ deny: true });
    assert.deepEqual(hook({ toolName: 'bash', agentId: 'ag-1' }), { permissionDecision: 'deny', permissionDecisionReason: '' }, '理由がなくても、形は崩さない');
  });

  test('REQ-009 中心の処理ができる前の問い合わせは通す（実行はまだない）。子のエージェントの終わりのフックも、何もしない', async () => {
    const { prepared, release } = await holdAfterJoin();
    const starting = prepared.launch();
    await until(() => prepared.fake.config !== null);
    const { hooks } = prepared.fake.config;
    assert.equal(hooks.onPreToolUse({ toolName: 'bash', agentId: 'ag-1' }), undefined);
    assert.equal(hooks.onSubagentStop({ agentId: 'ag-1', response: '返事' }), undefined);
    release();
    prepared.finish(await starting);
  });
});

describe('許可の求めの受け口（onPermissionRequest。REQ-005）', () => {
  test('REQ-005 いつも { kind: no-result } を返す（答えない）。すぐ返し、求めは中心の処理に渡す', async () => {
    const p = await startPlugin();
    const seen = [];
    p.core.onPermissionRequest = (request) => seen.push(request);
    const handler = p.fake.config.onPermissionRequest;
    const requests = [{ kind: 'shell', fullCommandText: 'ls' }, { kind: 'write', fileName: 'a.md' }, { kind: 'extension-permission-access' }, {}, null, undefined, 'x', 5];
    for (const request of requests) {
      const result = handler(request, { sessionId: 's', managedSettingsEnabled: false });
      assert.deepEqual(result, { kind: 'no-result' });
      assert.ok(!(result instanceof Promise), 'Promise を返さない');
    }
    assert.deepEqual(seen, requests);
  });

  test('REQ-005 中心の処理が例外を投げても、no-result を返す（投げると SDK が user-not-available で答えてしまう）', async () => {
    const p = await startPlugin();
    p.core.onPermissionRequest = () => {
      throw new Error('中心の処理の失敗');
    };
    const handler = p.fake.config.onPermissionRequest;
    const lines = await captureErrors(async () => {
      assert.doesNotThrow(() => handler({ kind: 'shell' }, { sessionId: 's' }));
      assert.deepEqual(handler({ kind: 'shell' }, { sessionId: 's' }), { kind: 'no-result' });
      // SDK の動きで見る：求めのイベントが届いても、Copilot CLI に返す答えはない
      p.fake.emit(sdkEvent.permissionRequested('ag-1', 'req-1', { kind: 'shell', fullCommandText: 'ls' }));
      await delay(10);
    });
    assert.deepEqual(p.fake.answers, []);
    assert.equal(lines.length, 3);
  });

  test('REQ-005 本物の中心の処理につなぐと、求めのイベントに答えず、待ちが画面の状態に出て、答えが出ると消える', async () => {
    const p = await startPlugin();
    const root = await beginRun(p);
    await startChild(p, { agentId: 'ag-w', parentAgentId: root, agent: 'worker' });
    p.fake.emit(sdkEvent.permissionRequested('ag-w', 'req-1', { kind: 'shell', fullCommandText: 'npm test', possiblePaths: ['/work/out'], possibleUrls: [], warning: '時間がかかります' }));
    await delay(10);
    await p.core.whenIdle();
    assert.deepEqual(p.fake.answers, [], '答えを返さない。答えはチャットで行う');
    const waits = p.core.getState().run.waits;
    assert.equal(waits.length, 1);
    assert.equal(waits[0].requestId, 'req-1');
    assert.equal(waits[0].slot, 'worker');
    assert.equal(waits[0].kind, 'permission');
    assert.equal(waits[0].detail.command, 'npm test');
    assert.equal(waits[0].detail.warning, '時間がかかります');
    p.fake.emit(sdkEvent.permissionCompleted('req-1'));
    await p.core.whenIdle();
    assert.deepEqual(p.core.getState().run.waits, []);
    assert.equal(p.core.getState().run.agents.find((a) => a.slot === 'worker').status, 'running');
  });

  test('REQ-005 中心の処理ができる前の求めには、答えない', async () => {
    const { prepared, release } = await holdAfterJoin();
    const starting = prepared.launch();
    await until(() => prepared.fake.config !== null);
    assert.deepEqual(prepared.fake.config.onPermissionRequest({ kind: 'shell' }, { sessionId: 's' }), { kind: 'no-result' });
    release();
    prepared.finish(await starting);
  });
});

// ---- 統括エージェントが使ってよいツール（V1 の不具合 1。ユーザーの決定） ----------------------------------------------
// 統括の定義には tools を書かない（書くと、子の作業・検証のツールも絞られる）。統括は全ツールを持ち、一覧にないツールをフックで拒む。

const ORCHESTRATOR = `${PLUGIN}:orchestrator`;
const LISTED_BUILTIN = ['view', 'grep', 'glob', 'rg', 'task', 'read_agent', 'list_agents', 'write_agent'];
const LISTED_RECORD = ['plan', 'review', 'issue', 'finish', 'show', 'ask'].map((name) => `${PLUGIN}_${name}`);
// 実機（Copilot CLI 1.0.102）で、tools を書かない統括が受け取ったツール（V1 の生データ）のうち、一覧にないもの
const UNLISTED_OBSERVED = [
  'bash', 'read_bash', 'stop_bash', 'list_bash', 'create', 'edit', 'fetch_copilot_cli_documentation', 'skill', 'list_canvas_capabilities',
  'open_canvas', 'invoke_canvas_action', 'sql', 'session_store_sql', 'manage_schedule', 'tool_search_tool', 'update_todo', 'extensions_reload',
  'extensions_manage', `${PLUGIN}_verdict`, `${PLUGIN}_open`,
];
// 観測にはないが、あり得るツール（GPT の族の編集、Web、メインのエージェント向け、MCP、ほかのエクステンション、将来のツール）
const UNLISTED_POSSIBLE = ['apply_patch', 'str_replace_editor', 'web_fetch', 'web_search', 'ask_user', 'exit_plan_mode', 'lsp', 'report_intent', 'github-mcp-server-search_issues', 'srv-do_it', 'other-plugin_plan', 'brand_new_write_tool'];

describe('統括エージェントが使ってよいツール（フック onPreToolUse。REQ-010、REQ-009）', () => {
  const hookOf = (p) => p.fake.config.hooks.onPreToolUse;
  const asOrchestrator = (toolName, agentType = ORCHESTRATOR) => ({ toolName, agentType, agentId: 'ag-orch' });

  test('REQ-009 一覧のツール（ファイルを読む・探す、エージェントを呼ぶ、統括の記録のツール）は通す。種類は、プラグインの名前つきでも名前だけでもよい', async () => {
    const p = await startPlugin();
    const hook = hookOf(p);
    for (const toolName of [...LISTED_BUILTIN, ...LISTED_RECORD]) {
      assert.equal(hook(asOrchestrator(toolName)), undefined, toolName);
      assert.equal(hook(asOrchestrator(toolName, 'orchestrator')), undefined, `${toolName}（種類が名前だけ）`);
    }
  });

  test('REQ-009 統括の記録のツールの一覧は、中心の処理の定義（caller に orchestrator を持つもの）から決まる', async () => {
    const p = await startPlugin();
    const hook = hookOf(p);
    const callers = (def) => String(def.caller).split(',');
    for (const def of TOOLS.TOOL_DEFS) {
      const name = `${PLUGIN}_${def.name}`;
      assert.equal(hook(asOrchestrator(name)) === undefined, callers(def).includes('orchestrator'), `${name}（caller：${def.caller}）`);
    }
    assert.deepEqual(
      TOOLS.TOOL_DEFS.filter((def) => callers(def).includes('orchestrator')).map((def) => `${PLUGIN}_${def.name}`).sort(),
      [...LISTED_RECORD].sort(),
      '統括が呼ぶ記録のツールは plan・review・issue・finish・show・ask',
    );
  });

  test('REQ-009 一覧にないツールは、deny と理由で拒む。実機で統括が受け取ったツールも、あり得るほかのツールも、検証の記録のツールも', async () => {
    const p = await startPlugin();
    const hook = hookOf(p);
    for (const toolName of [...UNLISTED_OBSERVED, ...UNLISTED_POSSIBLE]) {
      const result = hook(asOrchestrator(toolName));
      assert.deepEqual(Object.keys(result ?? {}).sort(), ['permissionDecision', 'permissionDecisionReason'], toolName);
      assert.equal(result.permissionDecision, 'deny', toolName);
      assert.ok(result.permissionDecisionReason.includes(`「${toolName}」`), `${toolName}：理由にツールの名前が入る`);
      assert.match(result.permissionDecisionReason, /作業エージェントに頼んでください/);
      // 統括の定義（「してはいけないこと」）と同じ言葉と時機：試行の実行（2）で頼む。まとめ（5〜8）の間は頼まず、まとめを続ける
      assert.match(result.permissionDecisionReason, /試行の実行（2）で/);
      assert.match(result.permissionDecisionReason, /まとめ（5〜8）の間は頼まず、まとめを続けてください/);
      assert.doesNotMatch(result.permissionDecisionReason, /undefined|\[object|Error/);
      assert.equal(hook(asOrchestrator(toolName, 'orchestrator')).permissionDecision, 'deny', `${toolName}（種類が名前だけで届いたとき）`);
    }
  });

  test('REQ-009 ツールの名前が読めない・文字でない・大文字小文字が違うときも、一覧にないので拒む。名前が長くても理由は短く切る', async () => {
    const p = await startPlugin();
    const hook = hookOf(p);
    for (const toolName of [undefined, null, '', 5, {}, [], 'View', 'TASK']) {
      const result = hook({ toolName, agentType: ORCHESTRATOR, agentId: 'ag-orch' });
      assert.equal(result?.permissionDecision, 'deny', JSON.stringify(toolName));
    }
    assert.equal(hook({ agentType: ORCHESTRATOR })?.permissionDecision, 'deny');
    const hostile = { agentType: ORCHESTRATOR, get toolName() { throw new Error('壊れた入力'); } };
    assert.equal(hook(hostile).permissionDecision, 'deny');
    const long = hook(asOrchestrator('x'.repeat(500)));
    assert.ok(!long.permissionDecisionReason.includes('x'.repeat(100)), '長い名前は切って示す');
    assert.ok(long.permissionDecisionReason.includes('x'.repeat(80)));
    assert.ok(LISTED_RECORD.every((name) => long.permissionDecisionReason.includes(name)), '使える記録のツールの名前を示す');
  });

  test('REQ-009 作業・検証・メインのエージェント、ほかのプラグインの統括のツールは、今までどおり通す（統括の一覧は統括にだけ効く）', async () => {
    const p = await startPlugin();
    const hook = hookOf(p);
    for (const agentType of [`${PLUGIN}:worker`, `${PLUGIN}:worker-b`, `${PLUGIN}:verifier`, 'worker', 'verifier', 'explore', 'other-plugin:orchestrator', 'general-purpose', undefined, null, '']) {
      for (const toolName of ['bash', 'edit', 'create', 'apply_patch', 'skill', 'web_fetch', `${PLUGIN}_verdict`, `${PLUGIN}_show`, 'srv-do_it']) {
        assert.equal(hook({ toolName, agentType, agentId: 'ag-x' }), undefined, `${agentType}：${toolName}`);
      }
    }
    assert.equal(hook({ toolName: 'bash' }), undefined, 'メインのエージェント（種類も番号もない）');
  });

  test('REQ-009 止められた実行は、統括のツールを、止められた理由で拒む（統括の理由より先）。一覧のツールも拒む', async () => {
    const p = await startPlugin();
    const root = await beginRun(p);
    await p.core.stop();
    await p.core.whenIdle();
    const hook = hookOf(p);
    for (const toolName of ['view', 'task', 'bash', `${PLUGIN}_verdict`]) {
      const result = hook({ toolName, agentType: ORCHESTRATOR, agentId: root });
      assert.equal(result.permissionDecision, 'deny', toolName);
      assert.match(result.permissionDecisionReason, /止められ/, toolName);
      assert.doesNotMatch(result.permissionDecisionReason, /作業エージェントに頼んでください/, '止められた後に「頼め」とは言わない');
    }
  });

  test('REQ-009 動いている実行でも、統括は一覧にないツールを拒まれ、一覧のツールは通る。作業エージェントの編集と実行は通り、実行の状態は変わらない', async () => {
    const p = await startPlugin();
    const root = await beginRun(p);
    await startChild(p, { agentId: 'ag-w', parentAgentId: root, agent: 'worker' });
    const hook = hookOf(p);
    assert.equal(hook({ toolName: 'create', agentType: ORCHESTRATOR, agentId: root }).permissionDecision, 'deny');
    assert.equal(hook({ toolName: 'view', agentType: ORCHESTRATOR, agentId: root }), undefined);
    assert.equal(hook({ toolName: 'create', agentType: `${PLUGIN}:worker`, agentId: 'ag-w', parentAgentId: root }), undefined);
    assert.equal(hook({ toolName: 'bash', agentType: `${PLUGIN}:worker`, agentId: 'ag-w', parentAgentId: root }), undefined);
    assert.equal(p.core.getState().run.status, 'running');
  });

  test('REQ-009 偽物の SDK のフックの呼び方でも、統括の一覧にないツールは拒まれる。拒むときの形は Copilot CLI の拒み方（permissionDecision: deny）', async () => {
    const p = await startPlugin();
    const result = await p.fake.callHook('onPreToolUse', { toolName: 'bash', toolArgs: { command: 'ls' }, agentType: ORCHESTRATOR, agentId: 'ag-orch', parentAgentId: undefined });
    assert.equal(result.permissionDecision, 'deny');
    assert.equal(typeof result.permissionDecisionReason, 'string');
    assert.equal(await p.fake.callHook('onPreToolUse', { toolName: 'view', agentType: ORCHESTRATOR, agentId: 'ag-orch' }), undefined);
  });

  test('REQ-009 中心の処理がフックの中で失敗しても、統括の一覧にないツールは拒む。中心の処理ができる前でも拒む', async () => {
    const p = await startPlugin();
    p.core.preToolUse = () => {
      throw new Error('中心の処理の失敗');
    };
    const original = console.error;
    console.error = () => {};
    try {
      assert.equal(hookOf(p)(asOrchestrator('bash')).permissionDecision, 'deny');
      assert.equal(hookOf(p)(asOrchestrator('view')), undefined);
    } finally {
      console.error = original;
    }
    const { prepared, release } = await holdAfterJoin();
    const starting = prepared.launch();
    await until(() => prepared.fake.config !== null);
    assert.equal(prepared.fake.config.hooks.onPreToolUse(asOrchestrator('edit')).permissionDecision, 'deny');
    assert.equal(prepared.fake.config.hooks.onPreToolUse(asOrchestrator('task')), undefined);
    release();
    prepared.finish(await starting);
  });

  test('REQ-009 拒みは同期で答える（Promise を返さない）', async () => {
    const p = await startPlugin();
    const result = hookOf(p)(asOrchestrator('bash'));
    assert.ok(!(result instanceof Promise));
  });
});
