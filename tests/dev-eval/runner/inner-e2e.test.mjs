// 内側の EVAL を、本物の Agent SDK と Claude Code の本体、本物の生成プラグイン（組み立てて置き換えたもの）、本物の画面と Playwright で通す。
// 実際のモデルは使わない：Anthropic API の代わりに、ローカルの偽のサーバー（台本）につなぐ。
// 動かし方：cd tests/dev-eval && node --test "runner/inner-e2e.test.mjs"（Python に PyYAML と jsonschema、Playwright のブラウザーが要る。なければ飛ばす）
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import * as realSdk from '@anthropic-ai/claude-agent-sdk';

import { createScreen } from '../../../skills/test-plugin/scripts/screen.mjs';
import { guardSdk, lastToolResultBlocks, startFakeAnthropic } from './fake-anthropic.mjs';
import { createInnerAdapter, OPEN_FAILED, RECORD_FAILED } from './inner-adapter.mjs';
import { makeQueryOptions } from './isolation.mjs';
import { runInnerArm } from './inner-run.mjs';
import { HUMAN_QUESTION, buildSamplePlugin, pythonHasModules, scriptedModel, tmpDir } from './inner-test-support.mjs';

let chromium = null;
try {
  ({ chromium } = await import('playwright'));
} catch {
  chromium = null;
}
const SKIP = !pythonHasModules() ? 'Python に PyYAML と jsonschema がありません' : !chromium ? 'playwright がありません' : false;

const FAKE_ENV = { ANTHROPIC_API_KEY: 'fake-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };

// 判定の関数（モデルの判定は偽物）
const judge = async ({ criterion }) => ({ pass: true, reason: `${criterion.id} は満たしている` });

test('REQ-005 REQ-007 REQ-008 REQ-012 ありの実行：画面を開く → 設定して開始 → 統括・作業・検証が動く → 終わりを読む → 採点する', { skip: SKIP, timeout: 240_000 }, async (t) => {
  const fixture = buildSamplePlugin();
  const requests = [];
  const api = await startFakeAnthropic(scriptedModel({ workerDelayMs: 1500, verifierDelayMs: 1500, onRequest: (role, body) => requests.push({ role, model: body.model }) }));
  const sdk = guardSdk(realSdk, api); // 守り：偽の API につながっていない query は断る（実際のモデルを呼ばない）
  const screen = createScreen({ chromium, env: { ...process.env, PLUGIN_TEST_BROWSER_CHANNEL: 'chromium' } });
  t.after(async () => {
    await screen.close();
    await api.close();
  });
  const runDir = tmpDir('run-with');
  const result = await runInnerArm({
    arm: 'with', task: fixture.task, runDir, sdk, userRole: async () => 'はい', judge, screen,
    pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot, models: { worker: 'gpt-6-luna', verifier: 'claude-opus-5.5' },
    envExtra: { ...FAKE_ENV, ANTHROPIC_BASE_URL: api.url }, timeoutMs: 180_000, pollMs: 300,
  });

  assert.equal(result.status, 'completed', `${result.reason} / ${JSON.stringify(result.mainError)} / ${result.screenError}`);
  assert.match(result.url, /^http:\/\/127\.0\.0\.1:\d+\/\?k=/);
  assert.ok(result.screen.finished);
  assert.equal(result.screen.endReason.kind, 'all_passed');
  // 成果物が作業フォルダにあり、採点できた
  assert.ok(fs.existsSync(path.join(result.workDir, 'out', 'weekly.md')));
  assert.equal(result.grading.total, 2);
  assert.equal(result.grading.passed, 2);
  // 画面で選んだモデルが効いた：作業は gpt-6-luna → claude-haiku-5-5、検証は claude-opus-5.5 → claude-opus-5-5
  const byRole = (role) => requests.filter((r) => r.role === role).map((r) => r.model);
  assert.ok(byRole('worker').length > 0 && byRole('worker').every((m) => m === 'claude-haiku-5-5'), JSON.stringify(byRole('worker')));
  assert.ok(byRole('verifier').length > 0 && byRole('verifier').every((m) => m === 'claude-opus-5-5'), JSON.stringify(byRole('verifier')));
  assert.ok(byRole('orchestrator').every((m) => m === 'claude-sonnet-5-5'));
  const failed = result.checks.filter((c) => !c.ok);
  assert.deepEqual(failed, [], JSON.stringify(failed));
  assert.ok(fs.existsSync(path.join(runDir, 'events.jsonl')));
});

function recordingUserRole() {
  const calls = [];
  const fn = async (request) => {
    calls.push(request);
    return 'はい、お願いします';
  };
  fn.calls = calls;
  return fn;
}

test('REQ-041 なしの実行：メインのエージェントがチャットで質問して手番を終えたら、ユーザー役が返事をして続く。成果物を同じ基準で採点する', { skip: SKIP, timeout: 120_000 }, async (t) => {
  const fixture = buildSamplePlugin();
  const api = await startFakeAnthropic(scriptedModel({ plain: true, askFirst: true }));
  const sdk = guardSdk(realSdk, api); // 守り：偽の API につながっていない query は断る（実際のモデルを呼ばない）
  t.after(() => api.close());
  const userRole = recordingUserRole();
  const result = await runInnerArm({
    arm: 'without', task: fixture.task, runDir: tmpDir('run-without'), sdk, userRole, judge,
    envExtra: { ...FAKE_ENV, ANTHROPIC_BASE_URL: api.url }, timeoutMs: 100_000,
  });
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.replies, 1);
  assert.equal(userRole.calls.length, 1);
  assert.match(userRole.calls[0].question, /どの週の週報ですか/);
  assert.deepEqual(userRole.calls[0].choices, []);
  assert.equal(result.history[0].via, 'chat');
  assert.equal(result.main.turns, 2);
  assert.ok(fs.existsSync(path.join(result.workDir, 'out', 'weekly.md')));
  assert.equal(result.grading.passed, 2);
  // プラグインは読み込まれず、画面もない
  assert.deepEqual(result.mainInit.plugins.filter((name) => name === 'weekly-report'), []);
  assert.equal(result.url, null);
  assert.deepEqual(result.checks, []);
});

test('REQ-041 なしの実行：質問のツール（AskUserQuestion）の問いにも、ユーザー役が選択肢つきで答える', { skip: SKIP, timeout: 120_000 }, async (t) => {
  const fixture = buildSamplePlugin();
  const seen = [];
  const api = await startFakeAnthropic(scriptedModel({ plain: true, askTool: true, onRequest: (role, body) => seen.push(JSON.stringify(body.messages)) }));
  const sdk = guardSdk(realSdk, api); // 守り：偽の API につながっていない query は断る（実際のモデルを呼ばない）
  t.after(() => api.close());
  const userRole = recordingUserRole();
  const result = await runInnerArm({
    arm: 'without', task: fixture.task, runDir: tmpDir('run-without-tool'), sdk, userRole, judge,
    envExtra: { ...FAKE_ENV, ANTHROPIC_BASE_URL: api.url }, timeoutMs: 100_000,
  });
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(userRole.calls.length, 1);
  assert.equal(userRole.calls[0].question, 'どの週の週報ですか？');
  assert.deepEqual(userRole.calls[0].choices, ['今週', '先週']);
  assert.equal(result.history[0].via, 'AskUserQuestion');
  // 答えは、ツールの返り値としてモデルに届いた
  assert.ok(seen.some((messages) => messages.includes('はい、お願いします')));
  assert.equal(result.replies, 0);
});

test('REQ-005 ありの実行：画面の URL が出る前にメインのエージェントが質問して手番を終えたら、ユーザー役が返事をして URL まで進む', { skip: SKIP, timeout: 240_000 }, async (t) => {
  const fixture = buildSamplePlugin();
  const api = await startFakeAnthropic(scriptedModel({ askFirst: true }));
  const sdk = guardSdk(realSdk, api); // 守り：偽の API につながっていない query は断る（実際のモデルを呼ばない）
  const screen = createScreen({ chromium, env: { ...process.env, PLUGIN_TEST_BROWSER_CHANNEL: 'chromium' } });
  t.after(async () => {
    await screen.close();
    await api.close();
  });
  const userRole = recordingUserRole();
  const result = await runInnerArm({
    arm: 'with', task: fixture.task, runDir: tmpDir('run-with-ask'), sdk, userRole, judge, screen,
    pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot,
    envExtra: { ...FAKE_ENV, ANTHROPIC_BASE_URL: api.url }, timeoutMs: 180_000, pollMs: 300,
  });
  assert.equal(result.status, 'completed', `${result.reason} / ${result.screenError}`);
  assert.equal(result.replies, 1);
  assert.equal(userRole.calls.length, 1);
  assert.ok(result.url);
  assert.equal(result.screen.endReason.kind, 'all_passed');
  assert.equal(result.grading.passed, 2);
});

async function waitFor(check, timeoutMs, label) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`時間内に「${label}」にならなかった`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('REQ-009 止める：統括の実行だけが取り消され、10秒のうちに「終了（ユーザーが止めた）」になり、その後は新しい呼び出しが起きない', { skip: SKIP, timeout: 120_000 }, async (t) => {
  const fixture = buildSamplePlugin();
  const requests = [];
  const api = await startFakeAnthropic(scriptedModel({ verifierDelayMs: 60_000, onRequest: (role) => requests.push(role) }));
  const sdk = guardSdk(realSdk, api); // 守り：偽の API につながっていない query は断る（実際のモデルを呼ばない）
  const runDir = tmpDir('stop-run');
  const adapter = await createInnerAdapter({
    sdk, pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot, workDir: tmpDir('stop-work'), runDir,
    envExtra: { ...FAKE_ENV, ANTHROPIC_BASE_URL: api.url },
  });
  t.after(async () => {
    await adapter.shutdown();
    await api.close();
  });
  await adapter.core.open({ requestText: '週報を作ってください' });
  await adapter.core.start({ models: {}, maxIterations: 1, task: { week: '2026-W42' } });
  const stateOf = async () => adapter.core.getState();
  await waitFor(async () => (await stateOf()).run?.agents.some((a) => a.role === 'verifier' && a.status === 'running'), 60_000, '検証エージェントが実行中');
  const stoppedAt = Date.now();
  await adapter.core.stop();
  const finished = await waitFor(async () => {
    const state = await stateOf();
    return state.run?.status === 'finished' ? state.run : null;
  }, 15_000, '終了');
  assert.ok(Date.now() - stoppedAt < 10_000, `止めてから ${Date.now() - stoppedAt}ms かかった`);
  assert.equal(finished.endReason.kind, 'user_stopped');
  assert.equal(finished.endReason.unstoppable, false);
  assert.deepEqual(finished.unstopped, []);
  // 統括も、その下の作業・検証も、動いていない
  assert.ok(adapter.agents().length >= 3);
  assert.ok(adapter.agents().every((a) => a.status !== 'running'), JSON.stringify(adapter.agents().map((a) => [a.agentType, a.status])));
  // 止めた後は、モデルへの新しい呼び出しがない
  const before = requests.length;
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(requests.length, before);
  // 止めたあとに、Claude Code の本体のプロセスが残っていない
  await adapter.shutdown();
  const left = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).stdout.split('\n').filter((line) => line.includes(runDir));
  assert.deepEqual(left, []);
});

function withoutTaskSettings(task) {
  const json = structuredClone(task.json);
  json.settings = { maxIterations: json.settings?.maxIterations };
  return { ...task, json };
}

test('REQ-007 REQ-031 ありの実行：課題に作業ごとの設定がなくても、ユーザー役が画面の欄を読んで値を決めて入れ、そのまま開始できる', { skip: SKIP, timeout: 240_000 }, async (t) => {
  const fixture = buildSamplePlugin();
  const api = await startFakeAnthropic(scriptedModel({ verifierDelayMs: 300 }));
  const sdk = guardSdk(realSdk, api); // 守り：偽の API につながっていない query は断る（実際のモデルを呼ばない）
  const screen = createScreen({ chromium, env: { ...process.env, PLUGIN_TEST_BROWSER_CHANNEL: 'chromium' } });
  t.after(async () => {
    await screen.close();
    await api.close();
  });
  const questions = [];
  const requests = [];
  const userRole = async (request) => {
    questions.push(request.question);
    requests.push(request);
    return '2026-W44';
  };
  const result = await runInnerArm({
    arm: 'with', task: withoutTaskSettings(fixture.task), runDir: tmpDir('run-settings'), sdk, userRole, judge, screen, pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot,
    envExtra: { ...FAKE_ENV, ANTHROPIC_BASE_URL: api.url }, timeoutMs: 180_000, pollMs: 300,
  });
  assert.equal(result.status, 'completed', `${result.reason} / ${result.screenError}`);
  assert.equal(questions.length, 1);
  assert.match(questions[0], /設定の欄「対象の週」/);
  assert.match(questions[0], /週報を作る週を書きます/);
  // 画面の欄に入れた値が、中心の処理の設定として届いた（統括への指示にも入る）
  assert.equal(result.finalState.settings.task.week, '2026-W44');
  assert.deepEqual(result.settings.map((d) => [d.key, d.source, d.value]), [['week', 'user-role', '2026-W44']]);
  assert.equal(result.grading.passed, 2);
  // 人は、画面を開いたと伝えるチャットの文を、設定の前に読む。その文が、設定の欄を聞くときにユーザー役へ渡る（見せた文は記録に残る）
  assert.equal(requests[0].notes.length, 1);
  assert.match(requests[0].notes[0], /画面を開きました。/);
  assert.match(requests[0].notes[0], /画面で設定して、開始ボタンを押してください。/);
  assert.equal(result.settings[0].notes, requests[0].notes[0]);
});

test('REQ-007 ありの実行：必須の欄をユーザー役が決められなければ、画面は開始できず、入れなかった欄を理由に示して incomplete にする', { skip: SKIP, timeout: 240_000 }, async (t) => {
  const fixture = buildSamplePlugin();
  const api = await startFakeAnthropic(scriptedModel());
  const sdk = guardSdk(realSdk, api); // 守り：偽の API につながっていない query は断る（実際のモデルを呼ばない）
  const screen = createScreen({ chromium, env: { ...process.env, PLUGIN_TEST_BROWSER_CHANNEL: 'chromium' } });
  t.after(async () => {
    await screen.close();
    await api.close();
  });
  const result = await runInnerArm({
    arm: 'with', task: withoutTaskSettings(fixture.task), runDir: tmpDir('run-settings-abstain'), sdk, userRole: async () => '特に決まっていません', judge, screen,
    pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot, envExtra: { ...FAKE_ENV, ANTHROPIC_BASE_URL: api.url }, timeoutMs: 120_000, pollMs: 300,
  });
  assert.equal(result.status, 'incomplete');
  assert.match(result.reason, /画面で開始できませんでした.*対象の週/);
  assert.equal(result.finalState, null);
  assert.deepEqual(result.settings.map((d) => [d.key, d.source, d.note]), [['week', 'default', 'abstain']]);
});

// ---- 記録のツールが断った理由の文が、本物の Agent SDK を通して、モデルへの次の呼び出しに届く（V1 の不具合 2 への合わせ） ----------

test('REQ-011 統括が記録のツールに断られたら、理由の文（やり直しの案内つき）が isError の結果としてモデルに届き、直して呼び直せば実行は最後まで進む', { skip: SKIP, timeout: 240_000 }, async (t) => {
  const fixture = buildSamplePlugin();
  const seen = [];
  const api = await startFakeAnthropic(scriptedModel({ badPlan: true, workerDelayMs: 300, verifierDelayMs: 300, onRequest: (role, body) => { if (role === 'orchestrator') seen.push(lastToolResultBlocks(body)); } }));
  const sdk = guardSdk(realSdk, api); // 守り：偽の API につながっていない query は断る（実際のモデルを呼ばない）
  const screen = createScreen({ chromium, env: { ...process.env, PLUGIN_TEST_BROWSER_CHANNEL: 'chromium' } });
  t.after(async () => {
    await screen.close();
    await api.close();
  });
  const result = await runInnerArm({
    arm: 'with', task: fixture.task, runDir: tmpDir('run-refused'), sdk, userRole: async () => 'はい', judge, screen, pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot,
    envExtra: { ...FAKE_ENV, ANTHROPIC_BASE_URL: api.url }, timeoutMs: 180_000, pollMs: 300,
  });
  const refusals = seen.flat().filter((b) => b.isError);
  assert.equal(refusals.length, 1, JSON.stringify(seen));
  // 理由の文がそのまま届いている（「Tool execution failed」のような一般の文ではない）
  assert.equal(refusals[0].text, '試行の番号が違います。次の試行の番号は 1 です。（やり直しは、あと 3 回までです）');
  // 直して呼び直したあとは、断られず、実行が最後まで進んだ
  assert.equal(result.status, 'completed', `${result.reason} / ${result.screenError}`);
  assert.equal(result.screen.endReason.kind, 'all_passed');
});

/** メインのエージェントが、記録のツール（plan）を呼び、その結果をモデルへの次の呼び出しで返す。次の呼び出しで見えた tool_result を返す */
async function mainCallsPlan(t, { break: breakCore }) {
  const fixture = buildSamplePlugin();
  const results = [];
  const api = await startFakeAnthropic(async ({ body }) => {
    const blocks = lastToolResultBlocks(body);
    results.push(blocks);
    if (blocks.length === 0) return { blocks: [{ type: 'tool_use', name: 'mcp__weekly-report__plan', input: { iteration: 1, criteria: [{ id: 'C-01', text: 'x' }], plan: 'p' } }] };
    return { blocks: [{ type: 'text', text: '終わります' }] };
  });
  const sdk = guardSdk(realSdk, api); // 守り：偽の API につながっていない query は断る（実際のモデルを呼ばない）
  const workDir = tmpDir('refusal-work');
  const adapter = await createInnerAdapter({
    sdk, pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot, workDir, runDir: tmpDir('refusal-run'), envExtra: { ...FAKE_ENV, ANTHROPIC_BASE_URL: api.url },
  });
  t.after(async () => {
    await adapter.shutdown();
    await api.close();
  });
  breakCore?.(adapter.core);
  const parts = adapter.mainParts();
  const options = makeQueryOptions({
    cwd: workDir, home: tmpDir('refusal-home'), model: 'claude-sonnet-5-5', mcpServers: parts.mcpServers, mcpTools: parts.mcpTools, envExtra: { ...FAKE_ENV, ANTHROPIC_BASE_URL: api.url }, maxTurns: 4,
  });
  for await (const m of sdk.query({ prompt: '計画を記録してください', options })) void m;
  return { results, fixture };
}

test('REQ-009 つながりが切れた記録のツールの呼び出しには、「作業を終えてください」の文が isError の結果としてモデルに届く', { skip: SKIP, timeout: 120_000 }, async (t) => {
  const { results, fixture } = await mainCallsPlan(t, {});
  const { pathToFileURL } = await import('node:url');
  const { DISCONNECTED_MESSAGE } = await import(pathToFileURL(path.join(fixture.pluginRoot, 'com.github.copilot', 'extensions', 'weekly-report', 'core', 'constants.mjs')).href);
  const returned = results.flat();
  assert.equal(returned.length, 1, JSON.stringify(results));
  assert.equal(returned[0].isError, true);
  assert.equal(returned[0].text, DISCONNECTED_MESSAGE);
  assert.match(returned[0].text, /作業を終えてください/);
});

test('REQ-011 記録のツールの処理が予期しない例外を投げても、内部の文は届かず、決まった文が isError の結果としてモデルに届く', { skip: SKIP, timeout: 120_000 }, async (t) => {
  const originalError = console.error;
  console.error = () => {};
  t.after(() => { console.error = originalError; });
  const { results } = await mainCallsPlan(t, {
    break: (core) => {
      core.handleTool = async () => {
        throw new TypeError('内部の詳細：undefined の x を読めません');
      };
    },
  });
  const returned = results.flat();
  assert.equal(returned.length, 1, JSON.stringify(results));
  assert.equal(returned[0].isError, true);
  assert.equal(returned[0].text, RECORD_FAILED);
  assert.doesNotMatch(returned[0].text, /内部の詳細|TypeError/);
  assert.notEqual(returned[0].text, OPEN_FAILED);
});

// ---- 統括の tools をなくしたことへの合わせ：統括には使ってよいツールだけが渡り、作業・検証は自分の tools を持つ ----------------------

test('REQ-010 REQ-011 統括は、使ってよいツールだけを持つ（書き込み・コマンド・スキルは持たない）。作業・検証は、統括の tools に絞られず、自分の定義のツールを持つ', { skip: SKIP, timeout: 240_000 }, async (t) => {
  const fixture = buildSamplePlugin();
  const toolsByRole = new Map(); // 役割 → 最初の呼び出しで届いたツールの名前
  const api = await startFakeAnthropic(scriptedModel({
    workerDelayMs: 300,
    verifierDelayMs: 300,
    onRequest: (role, body) => {
      if (!toolsByRole.has(role)) toolsByRole.set(role, (body.tools ?? []).map((tool) => tool.name));
    },
  }));
  const sdk = guardSdk(realSdk, api); // 守り：偽の API につながっていない query は断る（実際のモデルを呼ばない）
  const screen = createScreen({ chromium, env: { ...process.env, PLUGIN_TEST_BROWSER_CHANNEL: 'chromium' } });
  t.after(async () => {
    await screen.close();
    await api.close();
  });
  const runDir = tmpDir('run-orch-tools');
  const result = await runInnerArm({
    arm: 'with', task: fixture.task, runDir, sdk, userRole: async () => 'はい', judge, screen, pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot,
    envExtra: { ...FAKE_ENV, ANTHROPIC_BASE_URL: api.url }, timeoutMs: 180_000, pollMs: 300,
  });
  assert.equal(result.status, 'completed', `${result.reason} / ${result.screenError}`);

  const mcp = (name) => `mcp__weekly-report__${name}`;
  const orchestrator = toolsByRole.get('orchestrator');
  assert.ok(orchestrator, '統括の呼び出しが届いていない');
  // 統括が持つもの：Agent、読む・探す、統括の記録のツール
  for (const name of ['Agent', 'Read', 'Grep', 'Glob', mcp('plan'), mcp('review'), mcp('issue'), mcp('finish'), mcp('show'), mcp('ask')]) {
    assert.ok(orchestrator.includes(name), `統括のツールに ${name} がない：${orchestrator.join(', ')}`);
  }
  // 統括が持たないもの：書き込み・コマンド・スキル・質問・Web、メインと検証の記録のツール
  for (const name of ['Write', 'Edit', 'Bash', 'Skill', 'AskUserQuestion', 'WebFetch', 'WebSearch', 'NotebookEdit', mcp('open'), mcp('verdict'), mcp('answer')]) {
    assert.ok(!orchestrator.includes(name), `統括のツールに ${name} がある：${orchestrator.join(', ')}`);
  }
  // 作業・検証は、統括の tools に絞られず、自分の定義のツールを持つ（統括は Write を持たないが、作業は Write で成果物を作れる）
  const worker = toolsByRole.get('worker');
  for (const name of ['Write', 'Edit', 'Bash', 'Read', mcp('show')]) assert.ok(worker.includes(name), `作業のツールに ${name} がない：${worker.join(', ')}`);
  const verifier = toolsByRole.get('verifier');
  for (const name of ['Read', 'Grep', 'Glob', mcp('verdict')]) assert.ok(verifier.includes(name), `検証のツールに ${name} がない：${verifier.join(', ')}`);
  for (const name of ['Write', 'Edit', 'Bash']) assert.ok(!verifier.includes(name), `検証のツールに ${name} がある：${verifier.join(', ')}`);
  assert.ok(fs.existsSync(path.join(result.workDir, 'out', 'weekly.md')));

  // 書いた tools は、実行の記録に残る
  const events = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const written = events.find((e) => e.t === 'orchestrator_tools');
  assert.ok(written, 'orchestrator_tools の記録がない');
  assert.deepEqual(written.tools.slice(0, 4), ['Agent', 'Read', 'Grep', 'Glob']);
  assert.deepEqual(written.tools.slice(4).sort(), ['ask', 'finish', 'issue', 'plan', 'review', 'show'].map(mcp).sort());
});

test('REQ-007 質問のツールを呼ぶ応答の中の、質問の前にチャットに書いた文が、本物の Agent SDK でも、その問いと一緒にユーザー役へ渡る', { skip: SKIP, timeout: 120_000 }, async (t) => {
  const fixture = buildSamplePlugin();
  const api = await startFakeAnthropic(scriptedModel({ plain: true, askTool: true, askNote: '上のまとめのとおり、今週と先週のどちらかを決めます。' }));
  const sdk = guardSdk(realSdk, api); // 守り：偽の API につながっていない query は断る（実際のモデルを呼ばない）
  t.after(() => api.close());
  const userRole = recordingUserRole();
  const result = await runInnerArm({
    arm: 'without', task: fixture.task, runDir: tmpDir('run-notes-tool'), sdk, userRole, judge,
    envExtra: { ...FAKE_ENV, ANTHROPIC_BASE_URL: api.url }, timeoutMs: 100_000,
  });
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(userRole.calls.length, 1);
  assert.deepEqual(userRole.calls[0].notes, ['上のまとめのとおり、今週と先週のどちらかを決めます。']);
  assert.equal(result.history[0].notes, '上のまとめのとおり、今週と先週のどちらかを決めます。');
});

test('REQ-051 ありの実行：統括が人の判断を求めて手番を終えると、メインのエージェントに知らせ、チャットの質問にユーザー役が答え、答えを渡すツールで同じ統括が続きを始める。結果は 1 つの実行にまとまる', { skip: SKIP, timeout: 240_000 }, async (t) => {
  const fixture = buildSamplePlugin();
  const requests = [];
  const api = await startFakeAnthropic(scriptedModel({ humanWait: true, onRequest: (role, body) => requests.push({ role, body }) }));
  const sdk = guardSdk(realSdk, api);
  const screen = createScreen({ chromium, env: { ...process.env, PLUGIN_TEST_BROWSER_CHANNEL: 'chromium' } });
  t.after(async () => {
    await screen.close();
    await api.close();
  });
  const asked = [];
  const result = await runInnerArm({
    arm: 'with', task: fixture.task, runDir: tmpDir('run-human'), sdk, judge, screen,
    userRole: async (request) => {
      asked.push(request);
      return 'ツールチェーンは /opt/arm/bin です。続けてください';
    },
    pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot,
    envExtra: { ...FAKE_ENV, ANTHROPIC_BASE_URL: api.url }, timeoutMs: 180_000, pollMs: 300,
  });
  assert.equal(result.status, 'completed', `${result.reason} / ${JSON.stringify(result.mainError)} / ${result.screenError} / ${result.notifyError}`);
  assert.equal(result.screen.endReason.kind, 'all_passed');
  assert.equal(result.humanWaits, 1);
  // ユーザー役は、チャットに出た質問を読んで答えた
  const humanTurn = result.history.find((h) => h.via === 'human-wait');
  assert.ok(humanTurn, JSON.stringify(result.history));
  assert.ok(humanTurn.question.includes(HUMAN_QUESTION));
  // 画面には、待っているあいだ「人の判断待ち」が出た
  assert.ok(result.screen.snapshots.some((s) => s.status === 'waiting_human'), JSON.stringify(result.screen.snapshots.map((s) => s.status)));
  // 同じ統括（起動は 1 回）が、答えを受けて 2 回目の手番で続けた。答えは言い換えずに届いた
  assert.equal(result.orchestratorRuns.length, 1);
  assert.equal(result.orchestratorRuns[0].turns, 2);
  const resumed = requests.filter((r) => r.role === 'orchestrator' && JSON.stringify(r.body.messages).includes('人の判断の答えが届きました'));
  assert.ok(resumed.length > 0, '答えのメッセージが統括に届いた');
  assert.ok(JSON.stringify(resumed[0].body.messages).includes('ツールチェーンは /opt/arm/bin です。続けてください'));
  assert.ok(fs.existsSync(path.join(result.workDir, 'out', 'weekly.md')));
  assert.equal(result.grading.passed, 2);
});
