// 内側のつなぎ口（inner-adapter.mjs）。偽の Agent SDK が、フックを自分で呼んで、統括・作業・検証の動きを再現する。
// 中心の処理は本物（生成プラグインの core/）。実際のモデルも、Claude Code の本体も、ブラウザーも使わない。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { ANSWER_FAILED, addTools, createInnerAdapter, describeOpened, OPEN_FAILED, ORCHESTRATOR_BUILTIN_TOOLS, RECORD_FAILED, rewriteField, rewriteModel } from './inner-adapter.mjs';
import { buildSamplePlugin, pythonHasModules, tmpDir } from './inner-test-support.mjs';
import { deviceEnv } from './inner-run.mjs';

const SKIP = !pythonHasModules() ? 'Python に PyYAML と jsonschema がありません' : false;

/** 偽の Agent SDK。query() が呼ばれるたびに、その options を test に渡す。close() されるまで終わらない */
function fakeSdk() {
  const queries = [];
  const sdk = {
    USAGE_LIMIT_ERROR_PREFIXES: ["You've hit your"],
    query({ prompt, options }) {
      const queue = [];
      let wake = null;
      let closed = false;
      const entry = {
        prompt, options, closed: () => closed,
        push(message) {
          queue.push(message);
          wake?.();
        },
        end() {
          closed = true;
          wake?.();
        },
      };
      queries.push(entry);
      const generator = (async function* generate() {
        for (;;) {
          if (queue.length > 0) {
            yield queue.shift();
            continue;
          }
          if (closed) return;
          await new Promise((resolve) => { wake = resolve; });
        }
      })();
      generator.close = () => entry.end();
      return generator;
    },
  };
  return { sdk, queries };
}

async function setup(t, extra = {}) {
  const fixture = buildSamplePlugin();
  const { sdk, queries } = fakeSdk();
  const events = [];
  const adapter = await createInnerAdapter({
    sdk, pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot, workDir: tmpDir('adapter-work'), runDir: tmpDir('adapter-run'), record: (entry) => events.push(entry),
    ...extra,
  });
  t.after(() => adapter.shutdown());
  return { fixture, adapter, queries, events, neutral: () => events.filter((e) => e.t === 'event').map((e) => e.e) };
}

const hookOf = (query, name) => query.options.hooks[name][0].hooks[0];

async function startRun(adapter, models = {}) {
  await adapter.core.open({ requestText: '週報を作ってください' });
  await adapter.core.start({ models, maxIterations: 1, task: { week: '2026-W42' } });
}

test('REQ-007 統括の起動：統括の定義の本文を効かせ、画面で選んだモデルを置き換えた版のコピーの定義に書く（元の置き換えた版は変えない）', { skip: SKIP }, async (t) => {
  const { fixture, adapter, queries, neutral } = await setup(t);
  await startRun(adapter, { orchestrator: 'claude-opus-5.5', worker: 'gpt-6-luna', verifier: 'gpt-6.1-sol' });
  assert.equal(queries.length, 1);
  const { options, prompt } = queries[0];
  assert.equal(options.agent, 'weekly-report:orchestrator');
  assert.equal(options.model, 'claude-opus-5-5');
  assert.deepEqual(options.settingSources, []);
  assert.deepEqual(options.systemPrompt, { type: 'preset', preset: 'claude_code' });
  assert.deepEqual(Object.keys(options.mcpServers), ['weekly-report']);
  assert.match(prompt, /実行の番号：/);
  assert.match(prompt, /C-01：週報は、見出し/);
  const copy = options.plugins[0].path;
  assert.notEqual(copy, fixture.convertedRoot);
  const model = (root, name) => /^model: (.+)$/m.exec(fs.readFileSync(path.join(root, 'agents', `${name}.md`), 'utf8'))[1];
  assert.equal(model(copy, 'orchestrator'), 'claude-opus-5-5');
  assert.equal(model(copy, 'worker'), 'claude-haiku-5-5');
  assert.equal(model(copy, 'verifier'), 'claude-sonnet-5-5');
  assert.equal(model(fixture.convertedRoot, 'orchestrator'), 'claude-sonnet-5-5');
  assert.equal(model(fixture.convertedRoot, 'worker'), 'claude-haiku-5-5');
  // 統括の始まりが、選んだ Copilot の名前つきで中心の処理に届く
  const started = neutral().find((e) => e.type === 'agent.started');
  assert.equal(started.agentType, 'weekly-report:orchestrator');
  assert.equal(started.model, 'claude-opus-5.5');
  assert.equal(started.executionMode, 'background');
  assert.equal(started.parentAgentId, undefined);
});

test('REQ-061 擬似の機器：統括の query にも、メインと同じ機器の道具（PATH の先頭）と環境変数、サンドボックスの通信と見えない場所を渡し、外への通信の求めを断ってメインと同じ配列に残す', { skip: SKIP }, async (t) => {
  const stateDir = tmpDir('device-state');
  const device = {
    binDir: '/dev-eval/device/bin', env: { KXEMU_GATEWAY: 'http://localhost:4242', KXEMU_ADDRS: '192.168.7.2' },
    sandboxNetwork: { allowedDomains: ['localhost:4242'], strictAllowlist: true }, sandboxFilesystem: { denyRead: [stateDir], denyWrite: [stateDir] },
  };
  const refused = [{ toolName: 'SandboxNetworkAccess', host: 'main.example.com' }]; // メインが先に断ったもの
  const { adapter, queries } = await setup(t, {
    sandbox: true, sandboxNetwork: device.sandboxNetwork, sandboxFilesystem: device.sandboxFilesystem, denyNetwork: true, refused,
    envExtra: deviceEnv({ A: '1' }, device, { PATH: '/usr/bin' }),
  });
  await startRun(adapter);
  assert.equal(queries.length, 1);
  const { options } = queries[0];
  assert.equal(options.agent, 'weekly-report:orchestrator');
  assert.equal(options.env.PATH, `/dev-eval/device/bin${path.delimiter}/usr/bin`);
  assert.equal(options.env.KXEMU_GATEWAY, 'http://localhost:4242');
  assert.equal(options.env.KXEMU_ADDRS, '192.168.7.2');
  assert.equal(options.env.A, '1');
  assert.equal(options.sandbox.enabled, true);
  assert.deepEqual(options.sandbox.network, { allowedDomains: ['localhost:4242'], strictAllowlist: true });
  assert.deepEqual(options.sandbox.filesystem, { denyRead: [stateDir], denyWrite: [stateDir] });
  const decision = await options.canUseTool('SandboxNetworkAccess', { host: 'example.com' }, {});
  assert.equal(decision.behavior, 'deny');
  assert.deepEqual(refused, [{ toolName: 'SandboxNetworkAccess', host: 'main.example.com' }, { toolName: 'SandboxNetworkAccess', host: 'example.com' }]);
});

test('REQ-061 擬似の機器を使わない統括の query は、今までどおり（サンドボックスの通信の設定を足さず、通信の求めも断らない）', { skip: SKIP }, async (t) => {
  const { adapter, queries } = await setup(t, { sandbox: true });
  await startRun(adapter);
  const { options } = queries[0];
  assert.equal(options.sandbox.network, undefined);
  assert.equal(options.sandbox.filesystem, undefined);
  assert.equal((await options.canUseTool('SandboxNetworkAccess', { host: 'example.com' }, {})).behavior, 'allow');
});

test('REQ-007 エージェントごとの思考の深さ：置き換えた版のコピーの定義の effort に書き、統括は query() の effort にも渡す。選ばないエージェントは変えない', { skip: SKIP }, async (t) => {
  const { fixture, adapter, queries } = await setup(t);
  await adapter.core.open({ requestText: '週報を作ってください' });
  await adapter.core.start({ models: {}, efforts: { orchestrator: 'high', worker: 'low' }, maxIterations: 1, task: { week: '2026-W42' } });
  assert.equal(queries.length, 1);
  const { options } = queries[0];
  assert.equal(options.effort, 'high');
  const copy = options.plugins[0].path;
  const effort = (root, name) => /^effort: (.+)$/m.exec(fs.readFileSync(path.join(root, 'agents', `${name}.md`), 'utf8'))?.[1];
  assert.equal(effort(copy, 'orchestrator'), 'high');
  assert.equal(effort(copy, 'worker'), 'low');
  assert.equal(effort(copy, 'verifier'), effort(fixture.convertedRoot, 'verifier'), '選ばないエージェントは定義のまま');
  assert.notEqual(effort(fixture.convertedRoot, 'worker'), 'low', '元の置き換えた版は変えない');
  assert.deepEqual(adapter.runs()[0].appliedEfforts, { 'weekly-report:orchestrator': 'high', 'weekly-report:worker': 'low' });
});

test('REQ-007 統括の起動：選ばないときは、query() に effort を渡さない', { skip: SKIP }, async (t) => {
  const { adapter, queries } = await setup(t);
  await startRun(adapter, {});
  assert.equal('effort' in queries[0].options, false);
});

test('REQ-007 統括の起動：表にないモデルと、統括以外の種類は断る（黙って別のものを起動しない）', { skip: SKIP }, async (t) => {
  const { adapter } = await setup(t);
  await assert.rejects(adapter.port.startAgent({ agentType: 'weekly-report:orchestrator', name: 'x', model: 'gpt-9', prompt: 'p' }), /gpt-9.*対応の表にありません/);
  await assert.rejects(adapter.port.startAgent({ agentType: 'weekly-report:worker', name: 'x', model: 'gpt-6-luna', prompt: 'p' }), /統括（weekly-report:orchestrator）のほかは起動できません/);
  assert.deepEqual(adapter.agents(), []);
});

test('REQ-008 サブエージェント：始まりのフックと Agent の呼び出しから親と説明と実行のしかたを結び付け、モデルは画面の選択と比べられる名前で届く', { skip: SKIP }, async (t) => {
  const { adapter, queries, neutral } = await setup(t);
  await startRun(adapter, { worker: 'gpt-6-luna' });
  const q = queries[0];
  const rootId = adapter.agents()[0].agentId;
  // 統括が Agent で作業を呼ぶ（前面）→ 作業が始まる
  await hookOf(q, 'PreToolUse')({ tool_name: 'Agent', tool_use_id: 'toolu_a1', tool_input: { description: '試行 1 の作業', subagent_type: 'weekly-report:worker', prompt: 'p', run_in_background: false } });
  await hookOf(q, 'SubagentStart')({ agent_id: 'sub-1', agent_type: 'weekly-report:worker' });
  // 作業のメッセージが先に届いても、始まりのあとで反映される（順序が前後しても取りこぼさない）
  q.push({ type: 'assistant', agent_id: 'sub-1', parent_tool_use_id: 'toolu_a1', message: { model: 'claude-haiku-5-5', content: [{ type: 'text', text: '書きます' }] } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const started = neutral().find((e) => e.type === 'agent.started' && e.agentId === 'sub-1');
  assert.equal(started.parentAgentId, rootId);
  assert.equal(started.agentType, 'weekly-report:worker');
  assert.equal(started.description, '試行 1 の作業');
  assert.equal(started.executionMode, 'sync');
  // 画面で選んだ gpt-6-luna は claude-haiku-5-5 に当たるので、選んだ名前のまま届く
  const configured = neutral().find((e) => e.type === 'agent.configured' && e.agentId === 'sub-1');
  assert.equal(configured.model, 'gpt-6-luna');
  // 終わり：最後の返事が届く
  await hookOf(q, 'SubagentStop')({ agent_id: 'sub-1', agent_type: 'weekly-report:worker', last_assistant_message: '成果物：out/weekly.md' });
  const completed = neutral().find((e) => e.type === 'agent.completed' && e.agentId === 'sub-1');
  assert.equal(completed.response, '成果物：out/weekly.md');
  assert.equal(completed.cancelled, false);
  const tasks = await adapter.port.listTasks();
  assert.deepEqual(tasks.map((x) => [x.agentType, x.status, x.parentAgentId === null ? null : 'root']), [['weekly-report:orchestrator', 'running', null], ['weekly-report:worker', 'completed', 'root']]);
  // 裏で呼ぶ（run_in_background を false にしない）と、実行のしかたは background で届く（中心の処理が決まりの違反として記録する）
  await hookOf(q, 'PreToolUse')({ tool_name: 'Agent', tool_use_id: 'toolu_a2', tool_input: { description: '試行 1 の確かめ', subagent_type: 'weekly-report:verifier', prompt: 'p' } });
  await hookOf(q, 'SubagentStart')({ agent_id: 'sub-2', agent_type: 'weekly-report:verifier' });
  assert.equal(neutral().find((e) => e.type === 'agent.started' && e.agentId === 'sub-2').executionMode, 'background');
});

test('REQ-007 実際のモデルが画面の選択と違うときは、実際のモデルに当たる Copilot の名前で届く（違いを画面に出せる）', { skip: SKIP }, async (t) => {
  const { adapter, queries, neutral } = await setup(t);
  await startRun(adapter, { worker: 'gpt-6-luna' });
  const q = queries[0];
  await hookOf(q, 'PreToolUse')({ tool_name: 'Agent', tool_use_id: 'toolu_a1', tool_input: { description: 'd', subagent_type: 'weekly-report:worker', prompt: 'p', run_in_background: false } });
  await hookOf(q, 'SubagentStart')({ agent_id: 'sub-1', agent_type: 'weekly-report:worker' });
  q.push({ type: 'assistant', agent_id: 'sub-1', message: { model: 'claude-sonnet-5-5', content: [] } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(neutral().find((e) => e.type === 'agent.configured' && e.agentId === 'sub-1').model, 'claude-sonnet-5.5');
  assert.equal(adapter.agents().find((a) => a.agentId === 'sub-1').actualClaudeId, 'claude-sonnet-5-5');
});

test('REQ-011 記録のツール：呼んだエージェントを、フックの tool_use_id と MCP の呼び出しの番号で結び付け、中心の処理の決まりで断る', { skip: SKIP }, async (t) => {
  const { adapter, queries } = await setup(t);
  await startRun(adapter);
  const q = queries[0];
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await q.options.mcpServers['weekly-report'].instance.connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  const call = (name, args, id) => client.callTool({ name, arguments: args, _meta: { 'claudecode/toolUseId': id } });
  // 統括の plan：統括のフックが tool_use_id を覚えているので、統括の呼び出しとして受かる
  await hookOf(q, 'PreToolUse')({ tool_name: 'mcp__weekly-report__plan', tool_use_id: 'toolu_p', tool_input: {} });
  const plan = await call('plan', { iteration: 1, criteria: [{ id: 'C-01', text: '週報は、見出し「今週やったこと」と「来週やること」の2つがあれば合格とする。' }, { id: 'C-02', text: '数字は半角で書く（例：3件）。' }], plan: '計画' }, 'toolu_p');
  assert.notEqual(plan.isError, true, JSON.stringify(plan.content));
  // 統括が verdict を呼ぶと、検証エージェントではないので断られ、理由が返る
  await hookOf(q, 'PreToolUse')({ tool_name: 'mcp__weekly-report__verdict', tool_use_id: 'toolu_v', tool_input: {} });
  const verdict = await call('verdict', { iteration: 1, verdicts: [{ criterionId: 'C-01', pass: true }] }, 'toolu_v');
  assert.equal(verdict.isError, true);
  assert.match(verdict.content[0].text, /検証/);
  // 画面を開くツールは、URL と注意を返す
  const opened = await call('open', { requestText: '週報' }, 'toolu_o');
  assert.match(opened.content[0].text, /^Web管理画面の URL：http:\/\/127\.0\.0\.1:\d+\/\?k=/);
  assert.match(opened.content[0].text, /ユーザーに伝えてください：/);
  // 引数の決まり（JSON Schema）は、中心の処理の定義そのまま
  const { tools } = await client.listTools();
  const planTool = tools.find((x) => x.name === 'plan');
  assert.deepEqual(planTool.inputSchema, adapter.core.toolDefinitions.find((d) => d.shortName === 'plan').parameters);
  assert.deepEqual(tools.map((x) => x.name).sort(), ['answer', 'ask', 'finish', 'issue', 'open', 'plan', 'review', 'show', 'verdict']);
  await client.close();
});

test('REQ-008 ツールの開始と終わりは、Copilot CLI のときと同じ名前（<エクステンション>_<ツール>）で届く。失敗の理由も添える', { skip: SKIP }, async (t) => {
  const { adapter, queries, neutral } = await setup(t);
  await startRun(adapter);
  const q = queries[0];
  await hookOf(q, 'PreToolUse')({ tool_name: 'mcp__weekly-report__plan', tool_use_id: 'toolu_1', tool_input: { iteration: 1 } });
  await hookOf(q, 'PostToolUse')({ tool_name: 'mcp__weekly-report__plan', tool_use_id: 'toolu_1', tool_input: {}, tool_response: [] });
  await hookOf(q, 'PreToolUse')({ tool_name: 'Read', tool_use_id: 'toolu_2', tool_input: { file_path: '/x' } });
  await hookOf(q, 'PostToolUseFailure')({ tool_name: 'Read', tool_use_id: 'toolu_2', tool_input: {}, error: 'ファイルがありません' });
  const tools = neutral().filter((e) => e.type.startsWith('tool.'));
  assert.deepEqual(tools.map((e) => [e.type, e.toolName, e.success]), [
    ['tool.started', 'weekly-report_plan', undefined], ['tool.completed', 'weekly-report_plan', true],
    ['tool.started', 'Read', undefined], ['tool.completed', 'Read', false],
  ]);
  assert.equal(tools[3].error, 'ファイルがありません');
  assert.deepEqual(tools[0].arguments, { iteration: 1 });
  assert.equal(tools[0].agentId, adapter.agents()[0].agentId);
});

test('REQ-009 止める：統括の query() だけを閉じ、統括の終わり（cancelled）だけを届け、下のエージェントは取り消しにする。以後のツールは拒む', { skip: SKIP }, async (t) => {
  const { adapter, queries, neutral } = await setup(t);
  await startRun(adapter);
  const q = queries[0];
  await hookOf(q, 'PreToolUse')({ tool_name: 'Agent', tool_use_id: 'toolu_a1', tool_input: { description: 'd', subagent_type: 'weekly-report:worker', prompt: 'p', run_in_background: false } });
  await hookOf(q, 'SubagentStart')({ agent_id: 'sub-1', agent_type: 'weekly-report:worker' });
  await adapter.core.stop();
  for (let i = 0; i < 100 && (await adapter.core.getState()).run?.status !== 'finished'; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  const state = await adapter.core.getState();
  assert.equal(state.run.status, 'finished');
  assert.equal(state.run.endReason.kind, 'user_stopped');
  assert.equal(q.closed(), true);
  assert.deepEqual((await adapter.port.listTasks()).map((x) => x.status), ['cancelled', 'cancelled']);
  const ends = neutral().filter((e) => e.type === 'agent.completed');
  assert.deepEqual(ends.map((e) => [e.agentId, e.cancelled]), [[adapter.agents()[0].agentId, true]]);
  // 止めたあとの、木のエージェントのツールは拒まれる（フックの返す形で）
  const denied = await hookOf(q, 'PreToolUse')({ tool_name: 'Write', tool_use_id: 'toolu_w', agent_id: 'sub-1', tool_input: { file_path: 'x' } });
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /止められた/);
  // 拒んだツールは、開始と失敗の終わりが届く
  const last = neutral().filter((e) => e.type.startsWith('tool.')).slice(-2);
  assert.deepEqual(last.map((e) => [e.type, e.success]), [['tool.started', undefined], ['tool.completed', false]]);
});

test('REQ-012 統括の実行の終わり：結果が成功なら completed（最後の返事つき）、誤りなら failed。利用枠の上限は記録に残す', { skip: SKIP }, async (t) => {
  const { adapter, queries, neutral } = await setup(t);
  await startRun(adapter);
  queries[0].push({ type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: '最後の返事' }] } });
  queries[0].push({ type: 'result', subtype: 'success', is_error: false, result: '最後の返事', total_cost_usd: 0.25, num_turns: 4 });
  queries[0].end();
  await adapter.whenRunsEnded();
  const completed = neutral().find((e) => e.type === 'agent.completed');
  assert.equal(completed.response, '最後の返事');
  assert.equal(completed.cancelled, false);
  assert.equal(adapter.runs()[0].costUsd, 0.25);
  assert.equal(adapter.agents()[0].status, 'completed');
  assert.equal(adapter.limitHit(), null);
});

test('REQ-012 統括の実行が利用枠の上限で誤りになったら failed を届け、limitHit に残す（試験全体を止める合図）', { skip: SKIP }, async (t) => {
  const { adapter, queries, neutral } = await setup(t);
  await startRun(adapter);
  queries[0].push({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your session limit · resets 3pm", total_cost_usd: 0, num_turns: 1 });
  queries[0].end();
  await adapter.whenRunsEnded();
  assert.match(neutral().find((e) => e.type === 'agent.failed').error, /session limit/);
  assert.equal(adapter.limitHit().runId.startsWith('orch-'), true);
  assert.equal(adapter.agents()[0].status, 'failed');
});

test('REQ-012 統括の実行が、結果を返さずに終わったときと、例外で終わったときは failed を届ける', { skip: SKIP }, async (t) => {
  const { adapter, queries, neutral } = await setup(t);
  await startRun(adapter);
  queries[0].end();
  await adapter.whenRunsEnded();
  assert.match(neutral().find((e) => e.type === 'agent.failed').error, /結果を返さずに終わりました/);
  // 例外で終わる query
  const throwing = {
    query: () => ({ [Symbol.asyncIterator]() { return this; }, next: async () => { throw new Error('プロセスが落ちた'); }, close() {} }),
  };
  const events = [];
  const fixture = buildSamplePlugin();
  const second = await createInnerAdapter({ sdk: throwing, pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot, workDir: tmpDir('w'), runDir: tmpDir('r'), record: (e) => events.push(e) });
  t.after(() => second.shutdown());
  await startRun(second);
  await second.whenRunsEnded();
  assert.match(events.find((e) => e.t === 'event' && e.e.type === 'agent.failed').e.error, /プロセスが落ちた/);
});

test('REQ-007 選べるモデルは変換の表の Copilot の名前、今のモデルはメインのモデルに当たる名前（Auto ではない）', { skip: SKIP }, async (t) => {
  const { adapter } = await setup(t);
  assert.deepEqual((await adapter.port.listModels()).map((m) => m.id), ['claude-haiku-5.5', 'gpt-6-luna', 'claude-sonnet-5.5', 'gpt-6.1-sol', 'claude-opus-5.5']);
  assert.deepEqual(await adapter.port.getCurrentModel(), { model: 'claude-sonnet-5.5', isAuto: false });
  const setup1 = (await adapter.core.open({ requestText: 'x' })).url;
  assert.match(setup1, /^http:\/\/127\.0\.0\.1:/);
  const state = await adapter.core.getState();
  // 画面の既定のモデルは、エージェントの定義の既定（統括・検証は sonnet、作業は gpt-6-luna）
  assert.deepEqual(state.setup.defaults, { orchestrator: 'claude-sonnet-5.5', worker: 'gpt-6-luna', verifier: 'claude-sonnet-5.5' });
  assert.equal(state.setup.isAuto, false);
});

test('testing.md 4章 変換レポートのエージェントが使うツールと、中心の処理が出すツールが過不足なく合うかを確かめられる', { skip: SKIP }, async (t) => {
  const { adapter } = await setup(t);
  const check = adapter.checkToolNames();
  assert.deepEqual(check.missing, []);
  assert.deepEqual(check.unused, []);
});

test('testing.md 4章 エージェントの定義の model を書き換える：あれば置き換え、なければ足す。本文は変えない', () => {
  const text = '---\nname: worker\nmodel: claude-haiku-5-5\ntools: Read\n---\n本文の model: 変えない\n';
  assert.equal(rewriteModel(text, 'claude-opus-5-5'), '---\nname: worker\nmodel: claude-opus-5-5\ntools: Read\n---\n本文の model: 変えない\n');
  assert.equal(rewriteModel('---\nname: w\n---\nx', 'claude-opus-5-5'), '---\nname: w\nmodel: claude-opus-5-5\n---\nx');
  assert.throws(() => rewriteModel('本文だけ', 'claude-opus-5-5'), /フロントマター/);
  assert.equal(rewriteField('---\nname: w\neffort: high\n---\neffort: 本文', 'effort', 'low'), '---\nname: w\neffort: low\n---\neffort: 本文');
  assert.equal(rewriteField('---\nname: w\n---\nx', 'effort', 'max'), '---\nname: w\neffort: max\n---\nx');
});

test('REQ-005 画面を開くツールの返り値：URL と、ユーザーに伝える注意の並び', () => {
  assert.equal(describeOpened({ url: 'http://127.0.0.1:1/?k=a', notices: [] }), 'Web管理画面の URL：http://127.0.0.1:1/?k=a');
  assert.equal(describeOpened({ url: 'u', notices: ['A', '', 'B'] }), 'Web管理画面の URL：u\n\nユーザーに伝えてください：\n- A\n- B');
});

test('REQ-008 Agent の呼び出しがプラグインの名前を付けない種類（worker）でも、親と説明を結び付ける', { skip: SKIP }, async (t) => {
  const { adapter, queries, neutral } = await setup(t);
  await startRun(adapter);
  const q = queries[0];
  await hookOf(q, 'PreToolUse')({ tool_name: 'Agent', tool_use_id: 'toolu_a1', tool_input: { description: '試行 1 の作業', subagent_type: 'worker', prompt: 'p', run_in_background: false } });
  await hookOf(q, 'SubagentStart')({ agent_id: 'sub-1', agent_type: 'weekly-report:worker' });
  const started = neutral().find((e) => e.type === 'agent.started' && e.agentId === 'sub-1');
  assert.equal(started.description, '試行 1 の作業');
  assert.equal(started.executionMode, 'sync');
  assert.equal(started.parentAgentId, adapter.agents()[0].agentId);
});

test('REQ-008 作業が Agent でさらにエージェントを呼んだとき、親は呼んだエージェントになる（統括ではない）', { skip: SKIP }, async (t) => {
  const { adapter, queries, neutral } = await setup(t);
  await startRun(adapter);
  const q = queries[0];
  await hookOf(q, 'PreToolUse')({ tool_name: 'Agent', tool_use_id: 'toolu_a1', tool_input: { description: 'd', subagent_type: 'weekly-report:worker', prompt: 'p', run_in_background: false } });
  await hookOf(q, 'SubagentStart')({ agent_id: 'sub-1', agent_type: 'weekly-report:worker' });
  // 作業（sub-1）の中の呼び出しには agent_id が付く
  await hookOf(q, 'PreToolUse')({ tool_name: 'Agent', tool_use_id: 'toolu_a2', agent_id: 'sub-1', tool_input: { description: '孫', subagent_type: 'weekly-report:verifier', prompt: 'p', run_in_background: false } });
  await hookOf(q, 'SubagentStart')({ agent_id: 'sub-2', agent_type: 'weekly-report:verifier' });
  assert.equal(neutral().find((e) => e.type === 'agent.started' && e.agentId === 'sub-2').parentAgentId, 'sub-1');
  assert.deepEqual((await adapter.port.listTasks()).map((x) => [x.agentId === adapter.agents()[0].agentId ? 'root' : x.agentId, x.parentAgentId === adapter.agents()[0].agentId ? 'root' : x.parentAgentId]), [['root', null], ['sub-1', 'root'], ['sub-2', 'sub-1']]);
});

test('REQ-007 サブエージェントの assistant メッセージが、始まりのフックより先に届いても、実際のモデルを取りこぼさない', { skip: SKIP }, async (t) => {
  const { adapter, queries, neutral } = await setup(t);
  await startRun(adapter, { worker: 'gpt-6-luna' });
  const q = queries[0];
  await hookOf(q, 'PreToolUse')({ tool_name: 'Agent', tool_use_id: 'toolu_a1', tool_input: { description: 'd', subagent_type: 'weekly-report:worker', prompt: 'p', run_in_background: false } });
  q.push({ type: 'assistant', agent_id: 'sub-1', message: { model: 'claude-haiku-5-5', content: [] } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(neutral().some((e) => e.type === 'agent.configured' && e.agentId === 'sub-1'), false, '始まりの前は、まだ中心の処理に届けない');
  await hookOf(q, 'SubagentStart')({ agent_id: 'sub-1', agent_type: 'weekly-report:worker' });
  const configured = neutral().find((e) => e.type === 'agent.configured' && e.agentId === 'sub-1');
  assert.equal(configured.model, 'gpt-6-luna');
  const order = neutral().filter((e) => e.agentId === 'sub-1').map((e) => e.type);
  assert.deepEqual(order, ['agent.started', 'agent.configured']);
});

// ---- 記録のツールが断ったときの理由の文が、モデルに届く形（V1 の不具合 2 への合わせ） -------------------------------------

/** MCP の本物のクライアントを、サーバーにメモリの中でつなぐ。config は mcpServers[名前]（統括の実行のものか、adapter.mainParts() のもの） */
async function connectedClient(config) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await config.instance.connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  return client;
}

async function pluginConstants(fixture) {
  const { pathToFileURL } = await import('node:url');
  const file = path.join(fixture.pluginRoot, 'com.github.copilot', 'extensions', 'weekly-report', 'core', 'constants.mjs');
  return import(pathToFileURL(file).href);
}

test('REQ-011 記録のツールが断ったら、例外ではなく、理由の文をそのまま入れた失敗の結果（isError と content の文）を返す。やり直しの回数の案内も届く', { skip: SKIP }, async (t) => {
  const { adapter, queries, events } = await setup(t);
  await startRun(adapter);
  const q = queries[0];
  const client = await connectedClient(q.options.mcpServers['weekly-report']);
  await hookOf(q, 'PreToolUse')({ tool_name: 'mcp__weekly-report__plan', tool_use_id: 'toolu_p', tool_input: {} });
  const refused = await client.callTool({ name: 'plan', arguments: { iteration: 2, criteria: [{ id: 'C-01', text: 'x' }], plan: '計画' }, _meta: { 'claudecode/toolUseId': 'toolu_p' } });
  assert.equal(refused.isError, true);
  assert.deepEqual(refused.content, [{ type: 'text', text: '繰り返しの上限（1 回）を超えます。試行の番号は 1 までです。（やり直しは、あと 3 回までです）' }]);
  // 断りは記録に残る（内部の誤りではない）
  const logged = events.find((e) => e.t === 'tool_refused');
  assert.equal(logged.tool, 'plan');
  assert.match(logged.reason, /繰り返しの上限（1 回）を超えます/);
  assert.equal(events.some((e) => e.t === 'tool_error'), false);
  await client.close();
});

test('REQ-009 「作業を終えてください」の文が、そのままモデルに届く（つながりが切れたとき、止められたとき）', { skip: SKIP }, async (t) => {
  const { fixture, adapter, queries } = await setup(t);
  const { DISCONNECTED_MESSAGE, STOPPED_MESSAGE } = await pluginConstants(fixture);
  await startRun(adapter);
  // メインのエージェントに渡す MCP サーバー（統括の実行のものではない）
  const live = await connectedClient(adapter.mainParts().mcpServers['weekly-report']);
  // 統括ではないエージェント（メイン）の記録は、つながりが切れたものとして断る
  const disconnected = await live.callTool({ name: 'plan', arguments: { iteration: 1, criteria: [{ id: 'C-01', text: 'x' }], plan: 'p' }, _meta: { 'claudecode/toolUseId': 'toolu_none' } });
  assert.equal(disconnected.isError, true);
  assert.equal(disconnected.content[0].text, DISCONNECTED_MESSAGE);
  assert.match(DISCONNECTED_MESSAGE, /作業を終えてください/);
  // 止めた直後（止まる処理の途中）は、止められたものとして断る
  const stopping = adapter.core.stop();
  const stopped = await live.callTool({ name: 'show', arguments: { key: 'draft', value: 'x' }, _meta: { 'claudecode/toolUseId': 'toolu_s' } });
  assert.equal(stopped.isError, true);
  assert.equal(stopped.content[0].text, STOPPED_MESSAGE);
  assert.match(STOPPED_MESSAGE, /作業を終えてください/);
  await stopping;
  await live.close();
});

test('REQ-011 予期しない失敗は、内部の文（エラーの文、場所）をモデルに見せず、決まった文を返す。くわしくは標準エラーと記録に残す', { skip: SKIP }, async (t) => {
  const { adapter, queries, events } = await setup(t);
  await startRun(adapter);
  const client = await connectedClient(adapter.mainParts().mcpServers['weekly-report']);
  const originalError = console.error;
  const stderr = [];
  console.error = (...args) => stderr.push(args.map(String).join(' '));
  t.after(() => { console.error = originalError; });
  const originalHandle = adapter.core.handleTool;
  adapter.core.handleTool = async () => {
    throw new TypeError('内部の詳細：undefined の x を読めません');
  };
  const record = await client.callTool({ name: 'plan', arguments: { iteration: 1, criteria: [{ id: 'C-01', text: 'x' }], plan: 'p' } });
  assert.equal(record.isError, true);
  assert.equal(record.content[0].text, RECORD_FAILED);
  assert.doesNotMatch(record.content[0].text, /内部の詳細|TypeError|undefined/);
  adapter.core.handleTool = originalHandle;
  const originalOpen = adapter.core.open;
  adapter.core.open = async () => {
    throw new Error('画面を開けませんでした：EADDRINUSE 127.0.0.1:8731');
  };
  const opened = await client.callTool({ name: 'open', arguments: { requestText: '週報' } });
  assert.equal(opened.isError, true);
  assert.equal(opened.content[0].text, OPEN_FAILED);
  assert.doesNotMatch(opened.content[0].text, /EADDRINUSE/);
  adapter.core.open = originalOpen;
  const errors = events.filter((e) => e.t === 'tool_error');
  assert.deepEqual(errors.map((e) => e.tool), ['plan', 'open']);
  assert.match(errors[0].message, /内部の詳細/);
  assert.match(errors[0].stack, /TypeError/);
  assert.equal(stderr.length, 2);
  assert.match(stderr[0], /ツール「plan」の処理で予期しない失敗/);
  await client.close();
});

test('V1 の直しへの合わせ：Copilot CLI 用のつなぎ口（adapter.mjs）と、失敗のときの文と画面を開くツールの返り値の文が同じ', { skip: SKIP }, async (t) => {
  const fixture = buildSamplePlugin();
  const source = fs.readFileSync(path.join(fixture.pluginRoot, 'com.github.copilot', 'extensions', 'weekly-report', 'adapter.mjs'), 'utf8');
  const constant = (name) => new RegExp(`const ${name} = '([^']*)';`).exec(source)?.[1];
  if (constant('OPEN_FAILED') === undefined || constant('RECORD_FAILED') === undefined) {
    t.skip('adapter.mjs が、V1 の不具合 2 の直し（断りを失敗の結果で返す形）をまだ含まない');
    return;
  }
  assert.equal(OPEN_FAILED, constant('OPEN_FAILED'));
  assert.equal(RECORD_FAILED, constant('RECORD_FAILED'));
  assert.equal(ANSWER_FAILED, constant('ANSWER_FAILED'));
  // 理由の文を返す形（RecordRefusal は理由をそのまま失敗の結果にする）も、adapter.mjs にある
  assert.match(source, /error instanceof RecordRefusal\) return \{ textResultForLlm: error\.message, resultType: 'failure' \}/);
  // 画面を開くツールの返り値の文は、同じ入力で同じ文になる
  const theirs = /function describeOpened\(\{ url, notices \}\) \{[\s\S]*?\n\}/.exec(source)?.[0];
  assert.ok(theirs, 'adapter.mjs に describeOpened が見つからない');
  const theirDescribe = new Function(`${theirs}; return describeOpened;`)();
  for (const input of [{ url: 'http://127.0.0.1:1/?k=a', notices: [] }, { url: 'u', notices: ['A', '', 'B'] }, { url: 'u' }, { url: 'u', notices: 'x' }]) {
    assert.equal(describeOpened(input), theirDescribe(input), JSON.stringify(input));
  }
});

// ---- 統括の tools をなくしたことへの合わせ（統括は全ツールを持つ決まり。使ってよいツールだけを、実行用のコピーの定義に書いて効かせる） ----

const toolsLine = (root, name) => /^tools: (.*)$/m.exec(fs.readFileSync(path.join(root, 'agents', `${name}.md`), 'utf8'))?.[1];

test('REQ-010 REQ-011 統括の起動：統括の定義に tools がなければ、使ってよいツールだけを、実行用のコピーの定義に書く。元の置き換えた版と、作業・検証の tools は変えない', { skip: SKIP }, async (t) => {
  const { fixture, adapter, queries, events } = await setup(t);
  assert.equal(toolsLine(fixture.convertedRoot, 'orchestrator'), undefined); // 変換は、tools のない統括に tools を書かない（全ツールを継ぐ）
  await startRun(adapter);
  const copy = queries[0].options.plugins[0].path;
  const mcp = (name) => `mcp__weekly-report__${name}`;
  // 組み込みの4つの後ろに、統括が呼ぶ記録のツール（core/tools.mjs の並び順）
  const written = toolsLine(copy, 'orchestrator').split(', ');
  assert.deepEqual(written.slice(0, 4), ['Agent', 'Read', 'Grep', 'Glob']);
  assert.deepEqual(written.slice(4).sort(), ['ask', 'finish', 'issue', 'plan', 'review', 'show'].map(mcp).sort());
  assert.deepEqual(adapter.runs()[0].orchestratorTools, written);
  assert.deepEqual(events.find((e) => e.t === 'orchestrator_tools'), { t: 'orchestrator_tools', run: 'orch-1', tools: written });
  // 元の置き換えた版は変えない。作業・検証の tools は、統括の tools に絞らない（そのまま）
  assert.equal(toolsLine(fixture.convertedRoot, 'orchestrator'), undefined);
  for (const name of ['worker', 'verifier']) assert.equal(toolsLine(copy, name), toolsLine(fixture.convertedRoot, name), name);
  assert.match(toolsLine(copy, 'worker'), /Write/);
  // 本文は変えない
  const body = (root) => fs.readFileSync(path.join(root, 'agents', 'orchestrator.md'), 'utf8').replace(/^---[\s\S]*?\n---/, '');
  assert.equal(body(copy), body(fixture.convertedRoot));
});

test('REQ-010 REQ-011 統括の定義にすでに tools があれば、そのまま使う（書き足さない）', { skip: SKIP }, async (t) => {
  const fixture = buildSamplePlugin();
  const file = path.join(fixture.convertedRoot, 'agents', 'orchestrator.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^model:/m, 'tools: Agent, Read\nmodel:'));
  const { sdk, queries } = fakeSdk();
  const events = [];
  const adapter = await createInnerAdapter({
    sdk, pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot, workDir: tmpDir('adapter-work'), runDir: tmpDir('adapter-run'), record: (entry) => events.push(entry),
  });
  t.after(() => adapter.shutdown());
  await startRun(adapter);
  assert.equal(toolsLine(queries[0].options.plugins[0].path, 'orchestrator'), 'Agent, Read');
  assert.equal(adapter.runs()[0].orchestratorTools, null);
  assert.equal(events.some((e) => e.t === 'orchestrator_tools'), false);
});

test('REQ-010 REQ-011 エージェントの定義に tools を足す：なければ足し、あれば何も変えない（null）。本文は変えない', () => {
  const text = '---\nname: orchestrator\nmodel: claude-sonnet-5-5\n---\n本文の tools: 変えない\n';
  assert.equal(addTools(text, ['Agent', 'Read']), '---\nname: orchestrator\nmodel: claude-sonnet-5-5\ntools: Agent, Read\n---\n本文の tools: 変えない\n');
  assert.equal(addTools('---\nname: w\ntools: Read\n---\nx', ['Agent']), null);
  assert.throws(() => addTools('本文だけ', ['Agent']), /フロントマター/);
});

test('REQ-010 REQ-011 統括の使ってよいツール：Copilot CLI 用のつなぎ口（adapter.mjs）の一覧と、同じ範囲（組み込みは Claude Code の名前に当てる）', { skip: SKIP }, async (t) => {
  const fixture = buildSamplePlugin();
  const source = fs.readFileSync(path.join(fixture.pluginRoot, 'com.github.copilot', 'extensions', 'weekly-report', 'adapter.mjs'), 'utf8');
  const list = /const ORCHESTRATOR_BUILTIN_TOOLS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(source)?.[1];
  if (list === undefined) {
    t.skip('adapter.mjs が、統括の許す一覧（ORCHESTRATOR_BUILTIN_TOOLS）をまだ含まない');
    return;
  }
  const theirs = [...list.replace(/\/\/.*$/gm, '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  // Copilot CLI のツール → Claude Code のツール。当たるツールがないもの（null）は、統括が task を前面で1体ずつ呼ぶので要らない
  const toClaude = { view: 'Read', grep: 'Grep', rg: 'Grep', glob: 'Glob', task: 'Agent', read_agent: null, list_agents: null, write_agent: null };
  for (const name of theirs) {
    assert.ok(name in toClaude, `adapter.mjs の統括の一覧に、内側の EVAL がまだ知らないツール「${name}」がある。inner-adapter.mjs の ORCHESTRATOR_BUILTIN_TOOLS と、この表に足す（足さない理由も添える）`);
  }
  assert.deepEqual([...new Set(theirs.map((name) => toClaude[name]).filter(Boolean))].sort(), [...ORCHESTRATOR_BUILTIN_TOOLS].sort());
  // 記録のツールは、どちらも core/tools.mjs の TOOL_DEFS で caller に orchestrator を持つもの
  assert.match(source, /TOOL_DEFS\.filter\(\(def\) => String\(def\.caller\)\.split\(','\)\.includes\('orchestrator'\)\)/);
});

// ---- 人の判断待ち（生成プラグインの設計書 4.15）：待っている統括に送ると、同じ会話を resume した query() で続く ----

async function mcpClient(server) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  return client;
}

test('REQ-051 人の判断待ち：統括が質問を記録して手番を終えると待ちになり、メインのエージェントの答えで、同じ会話を resume した query() が同じ統括の番号で始まる', { skip: SKIP }, async (t) => {
  const turnEnds = [];
  const { adapter, queries, neutral, events } = await setup(t, { onOrchestratorTurnEnd: (turn) => turnEnds.push(turn) });
  await startRun(adapter);
  const q = queries[0];
  const orch = await mcpClient(q.options.mcpServers['weekly-report']);
  q.push({ type: 'system', subtype: 'init', session_id: 'sess-orch-1', model: 'claude-sonnet-5-5' });
  await hookOf(q, 'PreToolUse')({ tool_name: 'mcp__weekly-report__ask', tool_use_id: 'toolu_a', tool_input: {} });
  const asked = await orch.callTool({ name: 'ask', arguments: { question: 'ビルドが失敗しました。どうしますか？' }, _meta: { 'claudecode/toolUseId': 'toolu_a' } });
  assert.notEqual(asked.isError, true, JSON.stringify(asked.content));
  q.push({ type: 'result', subtype: 'success', is_error: false, result: '人の判断待ち\nビルドが失敗しました。どうしますか？', session_id: 'sess-orch-1' });
  q.end();
  await adapter.whenRunsEnded();
  await adapter.core.whenIdle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(adapter.core.getState().run.status, 'waiting_human');
  assert.deepEqual(turnEnds.map((x) => [x.id, x.turns, x.lastText]), [['orch-1', 1, '人の判断待ち\nビルドが失敗しました。どうしますか？']]);
  assert.equal(neutral().filter((e) => e.type === 'agent.completed').length, 1);

  // メインのエージェントが、答えを渡すツールで渡す
  const main = await mcpClient(adapter.mainParts().mcpServers['weekly-report']);
  const answered = await main.callTool({ name: 'answer', arguments: { answer: 'パスは /opt/arm/bin です' } });
  assert.notEqual(answered.isError, true, JSON.stringify(answered.content));
  assert.equal(queries.length, 2, '同じ統括の続きの query() が始まる');
  assert.equal(queries[1].options.resume, 'sess-orch-1', '同じ会話を resume する');
  assert.match(String(queries[1].prompt), /パスは \/opt\/arm\/bin です/);
  assert.equal(queries[1].options.agent, 'weekly-report:orchestrator');
  assert.equal(adapter.core.getState().run.status, 'running');
  assert.equal(adapter.agents().find((a) => a.agentId === 'orch-1').status, 'running');
  assert.ok(events.some((e) => e.t === 'orchestrator_resumed' && e.run === 'orch-1'));

  // 2回目からの手番の終わりは agent.idle（最後の返事つき）。統括の番号は同じ
  queries[1].push({ type: 'result', subtype: 'success', is_error: false, result: '続けました', session_id: 'sess-orch-1' });
  queries[1].end();
  await adapter.whenRunsEnded();
  const idle = neutral().filter((e) => e.type === 'agent.idle');
  assert.deepEqual(idle.map((e) => [e.agentId, e.response]), [['orch-1', '続けました']]);
  assert.equal(adapter.runs()[0].turns, 2);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(turnEnds.map((x) => x.turns), [1, 2]);
  await orch.close();
  await main.close();
});

test('REQ-051 待っている統括に送れないとき（取り消した、会話の番号が分からない、ない番号）は、例外ではなく sent が偽', { skip: SKIP }, async (t) => {
  const { adapter, queries } = await setup(t);
  await startRun(adapter);
  assert.deepEqual(await adapter.port.sendMessage('orch-1', 'x'), { sent: false, error: 'Agent not found or not accepting messages' }, '会話の番号がまだ分からない');
  assert.deepEqual(await adapter.port.sendMessage('orch-9', 'x'), { sent: false, error: 'Agent not found or not accepting messages' });
  queries[0].push({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  await new Promise((resolve) => setImmediate(resolve));
  await adapter.port.cancelAgent('orch-1');
  assert.deepEqual(await adapter.port.sendMessage('orch-1', 'x'), { sent: false, error: 'Agent not found or not accepting messages' });
  assert.equal(queries.length, 1);
});

test('REQ-051 答えを渡すツールは、人の判断待ちでないときは断りの文を失敗の結果で返す', { skip: SKIP }, async (t) => {
  const { adapter } = await setup(t);
  const main = await mcpClient(adapter.mainParts().mcpServers['weekly-report']);
  const result = await main.callTool({ name: 'answer', arguments: { answer: 'x' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /人の判断を待っていません/);
  await main.close();
});
