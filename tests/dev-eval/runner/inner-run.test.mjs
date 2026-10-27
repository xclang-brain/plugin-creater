// 内側の EVAL の実行1回の、状態の決め方。偽の Agent SDK（決まったメッセージを返す）で確かめる。実際のモデルも、ブラウザーも使わない。
import assert from 'node:assert/strict';
import test from 'node:test';

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { asksForReply, buildChecks, DEVICE_UNFENCED_WARNING, deviceEnv, entrySkillsOf, modelFields, runInnerArm, standaloneChecks } from './inner-run.mjs';
import { buildSamplePlugin, pythonHasModules, tmpDir } from './inner-test-support.mjs';

const SKIP = !pythonHasModules() ? 'Python に PyYAML と jsonschema がありません' : false;
const judge = async () => ({ pass: true, reason: '満たしている' });

/** 決まったメッセージを返す偽の Agent SDK。turns は query() 1回ごとのメッセージの並び */
function fakeSdk(turns, extra = {}) {
  const calls = [];
  const sdk = {
    USAGE_LIMIT_ERROR_PREFIXES: ["You've hit your", "You're out of usage credits"],
    query: ({ prompt, options }) => {
      calls.push({ prompt, options });
      const messages = turns[Math.min(calls.length - 1, turns.length - 1)];
      return (async function* generate() {
        for (const m of messages) yield { session_id: 'session-1', ...m };
      })();
    },
    calls,
    ...extra,
  };
  return sdk;
}
const init = (plugins = [], mcp = []) => ({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5', plugins: plugins.map((name) => ({ name })), mcp_servers: mcp, skills: [], agents: [], tools: [] });
const say = (text) => ({ type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text }] }, parent_tool_use_id: null });
const done = (text = '', extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.01, num_turns: 1, ...extra });

test('testing.md 7章 チャットで返事や答えを求めているかは、文の終わりの「？」か、依頼の言い方で見る', () => {
  for (const asks of ['どの週の週報ですか？', 'どの週ですか?', '対象の週を教えてください。', '対象の週をお知らせください', '週を指定してください！', 'お願いします。', 'これでよろしいでしょうか。']) {
    assert.equal(asksForReply(asks), true, asks);
  }
  for (const done of ['週報を作りました。ご確認ください。', '完了しました。', '', '3件の問い合わせがあります。', undefined]) {
    assert.equal(asksForReply(done), false, String(done));
  }
  // 長い文でも、終わりの200文字で見る
  assert.equal(asksForReply(`${'あ'.repeat(500)}どれにしますか？`), true);
});

test('REQ-007 画面で選ぶモデルは、画面の欄 model-<役割> に入れる形にする', () => {
  assert.deepEqual(modelFields({ worker: 'gpt-6-luna', verifier: 'claude-opus-5.5' }), { 'model-worker': 'gpt-6-luna', 'model-verifier': 'claude-opus-5.5' });
  assert.deepEqual(modelFields(undefined), {});
  assert.deepEqual(modelFields({ orchestrator: '' }), {});
});

test('REQ-007 REQ-008 動きの確かめ：画面で選んだモデルと実際のモデルが違うと、そのモデルの確かめが不合格になる', () => {
  const map = { 'gpt-6-luna': 'claude-haiku-5-5', 'claude-sonnet-5.5': 'claude-sonnet-5-5' };
  const agents = [
    { agentType: 'p:orchestrator', parentAgentId: null, actualClaudeId: 'claude-sonnet-5-5' },
    { agentType: 'p:worker', parentAgentId: 'orch-1', actualClaudeId: 'claude-sonnet-5-5' },
    { agentType: 'p:verifier', parentAgentId: 'orch-1', actualClaudeId: 'claude-sonnet-5-5' },
  ];
  const screen = { finished: true, endReasonText: '評価基準をすべて満たした', snapshots: [{ phase: 'plan', agents: [] }, { phase: 'do', agents: ['worker:running'] }, { phase: 'study', agents: ['verifier:running'] }] };
  const checks = buildChecks({
    pluginName: 'p', urlShown: true, mainTools: ['Skill', 'mcp__p__open'], skillsUsed: ['p:p'], screen, serverName: 'p', modelMap: map, agents,
    finalState: { settings: { models: { orchestrator: 'claude-sonnet-5.5', worker: 'gpt-6-luna', verifier: 'claude-sonnet-5.5' } } },
  });
  const by = Object.fromEntries(checks.map((c) => [c.id, c.ok]));
  assert.equal(by['skill-used'], true);
  assert.equal(by['screen-opener-called'], true);
  assert.equal(by['url-shown'], true);
  assert.equal(by['phases-shown'], true);
  assert.equal(by['worker-shown-running'], true);
  assert.equal(by['verifier-used'], true);
  assert.equal(by['model-orchestrator'], true);
  assert.equal(by['model-worker'], false, '作業は gpt-6-luna（claude-haiku-5-5）を選んだのに、sonnet で動いた');
  assert.equal(by['model-verifier'], true);
  // 選んでいない役割は確かめない
  const none = buildChecks({ pluginName: 'p', urlShown: false, mainTools: [], skillsUsed: [], screen: null, serverName: 'p', modelMap: map, agents: [], finalState: null });
  assert.ok(!none.some((c) => c.id.startsWith('model-')));
  assert.equal(none.find((c) => c.id === 'url-shown').ok, false);
  assert.equal(none.find((c) => c.id === 'screen-finished').ok, false);
});

test('REQ-041 なしの実行：モデルの利用枠の上限に達したら stopped にして、採点しない（残りを続けない合図）', async () => {
  const fixture = buildSamplePlugin();
  const sdk = fakeSdk([[init(), done("You've hit your session limit · resets 3pm", { is_error: true })]]);
  const run = await runInnerArm({ arm: 'without', task: fixture.task, runDir: tmpDir('limit'), sdk, userRole: async () => '', judge });
  assert.equal(run.status, 'stopped');
  assert.match(run.reason, /利用枠の上限/);
  assert.equal(run.grading, null);
  assert.equal(run.limitHit.where, 'main');
});

test('testing.md 5章 実行の後に、試すエージェントと統括・作業・検証のエージェントのホームの .cache（Playwright の Chromium など）を消す', async () => {
  const fixture = buildSamplePlugin();
  const runDir = tmpDir('cache');
  const put = (home) => {
    fs.mkdirSync(path.join(home, '.cache', 'ms-playwright', 'chromium-1200'), { recursive: true });
    fs.writeFileSync(path.join(home, '.cache', 'ms-playwright', 'chromium-1200', 'chrome'), 'x');
  };
  put(path.join(runDir, 'home-orchestrator-1')); // inner-adapter.mjs の home-<id> の代わり
  const sdk = fakeSdk([[init(), say('週報を作りました。'), done('週報を作りました。')]]);
  const query = sdk.query;
  sdk.query = (params) => { put(params.options.env.HOME); return query(params); };
  const run = await runInnerArm({ arm: 'without', task: fixture.task, runDir, sdk, userRole: async () => '', judge });
  assert.equal(run.status, 'completed', run.reason);
  assert.equal(path.dirname(sdk.calls[0].options.env.HOME), runDir);
  for (const home of ['home-main', 'home-orchestrator-1']) {
    assert.equal(fs.existsSync(path.join(runDir, home)), true, home);
    assert.equal(fs.existsSync(path.join(runDir, home, '.cache')), false, home);
  }
});

test('REQ-041 なしの実行：エージェントが誤りで終わったら incomplete にして、できていた分を採点する', async () => {
  const fixture = buildSamplePlugin();
  const sdk = fakeSdk([[init(), say('途中です'), { type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['手番の上限'], total_cost_usd: 0, num_turns: 80 }]]);
  const run = await runInnerArm({ arm: 'without', task: fixture.task, runDir: tmpDir('maxturns'), sdk, userRole: async () => '', judge });
  assert.equal(run.status, 'incomplete');
  assert.match(run.reason, /誤りで終わりました/);
  assert.equal(run.grading.total, 2);
  assert.equal(run.grading.passed, 1); // program の基準は成果物がなく不合格。model の基準は偽の判定で合格
});

test('REQ-041 なしの実行：返事を求め続けても、返事の上限（maxReplies）で打ち切る', async () => {
  const fixture = buildSamplePlugin();
  const sdk = fakeSdk([[init(), say('どの週ですか？'), done('どの週ですか？')]]);
  const answers = [];
  const run = await runInnerArm({
    arm: 'without', task: fixture.task, runDir: tmpDir('replies'), sdk, userRole: async ({ question }) => { answers.push(question); return '今週です'; }, judge, maxReplies: 3,
  });
  assert.equal(run.status, 'completed');
  assert.equal(run.replies, 3);
  assert.equal(answers.length, 3);
  assert.equal(sdk.calls.length, 4);
  // 2回目からは、前のセッションに続ける
  assert.equal(sdk.calls[0].options.resume, undefined);
  assert.equal(sdk.calls[1].options.resume, 'session-1');
  assert.equal(sdk.calls[1].prompt, '今週です');
  // 隔離：設定は読ませず、プラグインは何も読み込まない
  assert.deepEqual(sdk.calls[0].options.settingSources, []);
  assert.deepEqual(sdk.calls[0].options.plugins, []);
});

test('REQ-004 REQ-005 ありの実行：プラグインが読み込まれなかったら error にする（なしと同じ結果を、ありの結果にしない）', { skip: SKIP }, async () => {
  const fixture = buildSamplePlugin();
  const sdk = fakeSdk([[init([], []), say('こんにちは'), done('こんにちは')]]);
  const run = await runInnerArm({
    arm: 'with', task: fixture.task, runDir: tmpDir('noplugin'), sdk, userRole: async () => '', judge, screen: {}, pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot,
  });
  assert.equal(run.status, 'error');
  assert.match(run.reason, /weekly-report が読み込まれませんでした/);
  assert.equal(run.grading, null);
});

test('REQ-005 ありの実行：画面を開くツールの MCP サーバーにつながらなかったら error にする', { skip: SKIP }, async () => {
  const fixture = buildSamplePlugin();
  const sdk = fakeSdk([[init(['weekly-report'], [{ name: 'weekly-report', status: 'failed' }]), say('こんにちは'), done('こんにちは')]]);
  const run = await runInnerArm({
    arm: 'with', task: fixture.task, runDir: tmpDir('nomcp'), sdk, userRole: async () => '', judge, screen: {}, pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot,
  });
  assert.equal(run.status, 'error');
  assert.match(run.reason, /MCP サーバー（weekly-report）につながりませんでした/);
});

test('REQ-005 ありの実行：チャットに画面の URL が出なければ incomplete にして、成果物がなければ不合格として採点する', { skip: SKIP }, async () => {
  const fixture = buildSamplePlugin();
  const sdk = fakeSdk([[init(['weekly-report'], [{ name: 'weekly-report', status: 'connected' }]), say('作業を始めます。'), done('作業を始めます。')]]);
  const run = await runInnerArm({
    arm: 'with', task: fixture.task, runDir: tmpDir('nourl'), sdk, userRole: async () => '', judge, screen: {}, pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot,
  });
  assert.equal(run.status, 'incomplete');
  assert.match(run.reason, /URL が出ませんでした/);
  assert.equal(run.url, null);
  assert.equal(run.grading.total, 2);
  assert.equal(run.checks.find((c) => c.id === 'url-shown').ok, false);
  // 隔離：置き換えた版だけを読み込み、画面を開くツールを渡す
  const options = sdk.calls[0].options;
  assert.deepEqual(options.plugins, [{ type: 'local', path: fixture.convertedRoot }]);
  assert.deepEqual(Object.keys(options.mcpServers), ['weekly-report']);
  assert.ok(options.allowedTools.includes('mcp__weekly-report__open'));
});

test('REQ-008 動きの確かめ：エージェントの定義が使うツールを、中心の処理が出していなければ、始めずに error にする', { skip: SKIP }, async () => {
  const fixture = buildSamplePlugin();
  const fs = await import('node:fs');
  const path = await import('node:path');
  const reportFile = path.join(fixture.convertedRoot, '.eval', 'conversion-report.json');
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  report.extension_tools.push({ from: 'weekly-report_ghost', to: 'mcp__weekly-report__ghost', extension: 'weekly-report', server: 'weekly-report', tool: 'ghost', where: ['agents/worker.agent.md'] });
  fs.writeFileSync(reportFile, JSON.stringify(report));
  const sdk = fakeSdk([[init()]]);
  const run = await runInnerArm({
    arm: 'with', task: fixture.task, runDir: tmpDir('ghost'), sdk, userRole: async () => '', judge, screen: {}, pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot,
  });
  assert.equal(run.status, 'error');
  assert.match(run.reason, /ghost/);
  assert.equal(sdk.calls.length, 0);
});

test('REQ-041 ユーザー役が答えられないとき（チャットの返事）は、答えなしで進めず、error にして理由を示す', async () => {
  const fixture = buildSamplePlugin();
  const sdk = fakeSdk([[init(), say('どの週ですか？'), done('どの週ですか？')]]);
  const run = await runInnerArm({
    arm: 'without', task: fixture.task, runDir: tmpDir('userrole-chat'), sdk, userRole: async () => { throw new Error('ユーザー役の呼び出しに失敗しました（error_during_execution）'); }, judge,
  });
  assert.equal(run.status, 'error');
  assert.match(run.reason, /ユーザー役の呼び出しに失敗しました/);
  assert.equal(run.grading, null);
});

test('REQ-041 ユーザー役が答えられないとき（質問のツール）は、その実行を止めて error にして理由を示す', async () => {
  const fixture = buildSamplePlugin();
  const sdk = {
    query: ({ options }) => (async function* generate() {
      yield { type: 'system', subtype: 'init', session_id: 's', model: 'x', plugins: [], mcp_servers: [] };
      await options.canUseTool('AskUserQuestion', { questions: [{ question: 'どの週？', options: [{ label: '今週' }, { label: '先週' }] }] });
      yield { type: 'result', subtype: 'success', is_error: false, result: '続けた', total_cost_usd: 0, num_turns: 1, session_id: 's' };
    })(),
  };
  const run = await runInnerArm({
    arm: 'without', task: fixture.task, runDir: tmpDir('userrole-tool'), sdk, userRole: async () => { throw new Error('API が応答しません'); }, judge,
  });
  assert.equal(run.status, 'error');
  assert.match(run.reason, /ユーザー役の呼び出しに失敗しました：API が応答しません/);
});

test('REQ-005 ありの実行：画面の URL が出たあとにメインの実行が誤りで終わっても、画面が最後まで動いていれば、状態を下げない', { skip: SKIP }, async () => {
  const fixture = buildSamplePlugin();
  const url = 'http://127.0.0.1:8731/?k=abc123';
  const sdk = fakeSdk([[init(['weekly-report'], [{ name: 'weekly-report', status: 'connected' }]), say(`画面を開きました：${url}`), { type: 'result', subtype: 'success', is_error: true, result: 'API Error: 500', total_cost_usd: 0, num_turns: 1 }]]);
  const operated = [];
  const screen = {
    operate: async (args) => {
      operated.push(args);
      return { finished: true, timedOut: false, endReason: { kind: 'all_passed' }, endReasonText: '評価基準をすべて満たした', summary: null, snapshots: [] };
    },
  };
  const run = await runInnerArm({
    arm: 'with', task: fixture.task, runDir: tmpDir('after-url'), sdk, userRole: async () => '', judge, screen, pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot,
    models: { worker: 'gpt-6-luna' }, taskSettings: { week: '2026-W42' },
  });
  assert.equal(run.status, 'completed', run.reason);
  assert.equal(run.mainError, 'API Error: 500');
  assert.equal(operated.length, 1);
  assert.equal(operated[0].url, url);
  // 画面の欄に入れるもの：課題の上限の回数、画面で選ぶモデル、足した設定
  assert.deepEqual(operated[0].settings, { maxIterations: 3, task: { 'model-worker': 'gpt-6-luna', week: '2026-W42' } });
});

test('REQ-005 ありの実行：画面の URL が出たあとは、メインの最後の文が返事を求めていても、ユーザー役は返事をしない（人は画面を操作する）', { skip: SKIP }, async () => {
  const fixture = buildSamplePlugin();
  const url = 'http://127.0.0.1:8731/?k=abc123';
  const text = `画面を開きました：${url}\nほかに知りたいことを教えてください。`;
  const sdk = fakeSdk([[init(['weekly-report'], [{ name: 'weekly-report', status: 'connected' }]), say(text), done(text)]]);
  const answers = [];
  const screen = { operate: async () => ({ finished: true, timedOut: false, endReason: { kind: 'all_passed' }, endReasonText: 'ok', summary: null, snapshots: [] }) };
  const run = await runInnerArm({
    arm: 'with', task: fixture.task, runDir: tmpDir('no-reply-after-url'), sdk, userRole: async ({ question }) => { answers.push(question); return 'x'; }, judge, screen,
    pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot,
  });
  assert.equal(run.status, 'completed', run.reason);
  assert.equal(run.replies, 0);
  assert.deepEqual(answers, []);
  assert.equal(sdk.calls.length, 1);
});

test('REQ-004 変換した版の .eval/rules.md（インストラクション）は、ありの実行のシステムプロンプトに足し、なしには足さない', { skip: SKIP }, async () => {
  const fixture = buildSamplePlugin();
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.writeFileSync(path.join(fixture.convertedRoot, '.eval', 'rules.md'), '返事は日本語で書く。\n');
  const screen = { operate: async () => null };
  const withSdk = fakeSdk([[init(['weekly-report'], [{ name: 'weekly-report', status: 'connected' }]), say('こんにちは'), done('こんにちは')]]);
  await runInnerArm({ arm: 'with', task: fixture.task, runDir: tmpDir('rules-with'), sdk: withSdk, userRole: async () => '', judge, screen, pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot });
  assert.equal(withSdk.calls[0].options.systemPrompt.append, '返事は日本語で書く。');
  const withoutSdk = fakeSdk([[init(), say('こんにちは'), done('こんにちは')]]);
  await runInnerArm({ arm: 'without', task: fixture.task, runDir: tmpDir('rules-without'), sdk: withoutSdk, userRole: async () => '', judge });
  assert.equal(withoutSdk.calls[0].options.systemPrompt.append, undefined);
});

/** 作業の定義の settings.task を外した課題（ユーザー役が決める設定の試験用） */
function taskWithoutSettings(task) {
  const json = structuredClone(task.json);
  json.settings = { maxIterations: json.settings?.maxIterations };
  return { ...task, json };
}

const loadedSdk = (url = 'http://127.0.0.1:8731/?k=abc123') =>
  fakeSdk([[init(['weekly-report'], [{ name: 'weekly-report', status: 'connected' }]), say(`画面を開きました：${url}`), done(`画面を開きました：${url}`)]]);
const fakeScreen = (operated) => ({
  operate: async (args) => {
    operated.push(args);
    return { finished: true, timedOut: false, endReason: { kind: 'all_passed' }, endReasonText: 'ok', summary: null, snapshots: [] };
  },
});

test('REQ-007 REQ-031 ありの実行：画面の設定の欄は、ユーザー役が見出しと説明を読み、頼みの文と渡したファイルから決めて入れる。決めた値と聞いた文・答えは記録に残す', { skip: SKIP }, async () => {
  const fixture = buildSamplePlugin();
  const asked = [];
  const operated = [];
  const userRole = async ({ question, choices, via, meta }) => {
    asked.push({ question, choices, via, meta });
    return '2026-W43';
  };
  const run = await runInnerArm({
    arm: 'with', task: taskWithoutSettings(fixture.task), runDir: tmpDir('settings-by-role'), sdk: loadedSdk(), userRole, judge, screen: fakeScreen(operated),
    pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot, models: { worker: 'gpt-6-luna' },
  });
  assert.equal(run.status, 'completed', run.reason);
  // ユーザー役が聞かれたのは、作業ごとの設定の欄（対象の週）。見出し・説明・頼みの文・渡したファイルが入っている
  assert.equal(asked.length, 1);
  assert.equal(asked[0].via, 'setting');
  assert.deepEqual(asked[0].meta, { setting: 'week' });
  assert.match(asked[0].question, /設定の欄「対象の週」/);
  assert.match(asked[0].question, /週報を作る週を書きます/);
  assert.match(asked[0].question, /先週の記録をもとに、今週の週報を書いてください。/);
  assert.match(asked[0].question, /- inputs\/memo\.txt/);
  assert.match(asked[0].question, /この欄は必ず入れます。/);
  // 画面に入れる設定：上限の回数は課題、モデルは試験の仕組み、作業ごとの設定はユーザー役
  assert.deepEqual(operated[0].settings, { maxIterations: 3, task: { 'model-worker': 'gpt-6-luna', week: '2026-W43' } });
  assert.deepEqual(run.settings.map((d) => [d.key, d.source, d.value, d.answer]), [['week', 'user-role', '2026-W43', '2026-W43']]);
  assert.match(run.settings[0].question, /設定の欄「対象の週」/);
  assert.equal(run.history.find((h) => h.via === 'setting').answer, '2026-W43');
  const events = (await import('node:fs')).readFileSync((await import('node:path')).join(run.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.find((e) => e.t === 'settings').decisions.map((d) => d.source), ['user-role']);
});

test('REQ-007 ありの実行：課題の settings.task に同じ鍵があれば、ユーザー役に聞かずそれを使う。--setting の補いは、決めた値を上書きする', { skip: SKIP }, async () => {
  const fixture = buildSamplePlugin();
  let called = 0;
  const operated = [];
  const fromTask = await runInnerArm({
    arm: 'with', task: fixture.task, runDir: tmpDir('settings-eval'), sdk: loadedSdk(), userRole: async () => { called += 1; return 'x'; }, judge, screen: fakeScreen(operated),
    pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot,
  });
  assert.equal(called, 0);
  assert.deepEqual(operated[0].settings.task, { week: '2026-W42' });
  assert.deepEqual(fromTask.settings.map((d) => [d.key, d.source]), [['week', 'eval-json']]);
  const overridden = [];
  const cli = await runInnerArm({
    arm: 'with', task: taskWithoutSettings(fixture.task), runDir: tmpDir('settings-cli'), sdk: loadedSdk(), userRole: async () => { called += 1; return 'x'; }, judge, screen: fakeScreen(overridden),
    pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot, taskSettings: { week: '2026-W50' },
  });
  assert.equal(called, 0);
  assert.deepEqual(overridden[0].settings.task, { week: '2026-W50' });
  assert.deepEqual(cli.settings.map((d) => [d.key, d.source]), [['week', 'cli']]);
});

test('REQ-007 ありの実行：ユーザー役が決められなかった必須の欄は、値を入れずに画面に渡し、理由を記録に残す', { skip: SKIP }, async () => {
  const fixture = buildSamplePlugin();
  const operated = [];
  const run = await runInnerArm({
    arm: 'with', task: taskWithoutSettings(fixture.task), runDir: tmpDir('settings-abstain'), sdk: loadedSdk(), userRole: async () => '特に決まっていません', judge, screen: fakeScreen(operated),
    pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot,
  });
  assert.deepEqual(operated[0].settings.task, {});
  assert.deepEqual(run.settings.map((d) => [d.key, d.source, d.note]), [['week', 'default', 'abstain']]);
});

test('REQ-007 ありの実行：設定をユーザー役が決められずに失敗したら、画面を開始せず、error にして理由を示す', { skip: SKIP }, async () => {
  const fixture = buildSamplePlugin();
  const operated = [];
  const run = await runInnerArm({
    arm: 'with', task: taskWithoutSettings(fixture.task), runDir: tmpDir('settings-fail'), sdk: loadedSdk(), userRole: async () => { throw new Error('API が応答しません'); }, judge, screen: fakeScreen(operated),
    pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot,
  });
  assert.equal(operated.length, 0);
  assert.equal(run.status, 'error');
  assert.match(run.reason, /ユーザー役の呼び出しに失敗しました：API が応答しません/);
  assert.equal(run.grading, null);
});

// ---- チャットに書いた文を、次の質問と一緒にユーザー役に渡す（testing.md 6.1。外側の EVAL と同じ渡し方） ----------------------------------

/** 質問のツールを呼ぶ偽の Agent SDK。steps は順に、{ say: 文 } か { ask: 問いの欄の並び } か { early: 問いの欄の並び, say: 文 }（問いのほうが先に届く） */
function askingSdk(steps, finalText = '終わりました') {
  return {
    query: ({ options }) => (async function* generate() {
      yield { type: 'system', subtype: 'init', session_id: 's', model: 'x', plugins: [], mcp_servers: [] };
      for (const step of steps) {
        if (step.early) {
          // 文の処理が、質問の呼び出しより遅れる場合（Claude Code が質問を先に呼ぶ）
          const pending = options.canUseTool('AskUserQuestion', { questions: step.early }, {});
          yield { type: 'assistant', session_id: 's', message: { model: 'x', content: [{ type: 'text', text: step.say }] }, parent_tool_use_id: null };
          await pending;
        } else if (step.say) {
          yield { type: 'assistant', session_id: 's', message: { model: 'x', content: [{ type: 'text', text: step.say }] }, parent_tool_use_id: null };
        } else {
          await options.canUseTool('AskUserQuestion', { questions: step.ask }, {});
        }
      }
      yield { type: 'result', subtype: 'success', is_error: false, result: finalText, total_cost_usd: 0, num_turns: 1, session_id: 's' };
    })(),
  };
}
const ONE = [{ question: 'どの週？', options: [{ label: '今週' }, { label: '先週' }] }];
const TWO = [{ question: '対象の週は？', options: [{ label: '今週' }] }, { question: '文体は？', options: [{ label: 'です・ます' }] }];

test('REQ-007 質問のツールの問いには、その前にメインのエージェントがチャットに書いた文を一緒に渡し、渡した文は履歴に残る。渡した文は、次の問いには付かない', async () => {
  const fixture = buildSamplePlugin();
  const sdk = askingSdk([{ say: '先に、週を確認します。' }, { say: '週は今週と先週の2つです。' }, { ask: ONE }, { ask: ONE }]);
  const requests = [];
  const run = await runInnerArm({
    arm: 'without', task: fixture.task, runDir: tmpDir('notes-ask'), sdk, userRole: async (request) => { requests.push(request); return '今週'; }, judge,
  });
  assert.equal(run.status, 'completed');
  assert.deepEqual(requests.map((r) => r.notes), [['先に、週を確認します。', '週は今週と先週の2つです。'], []]);
  assert.deepEqual(run.history.map((h) => h.notes), ['先に、週を確認します。\n\n週は今週と先週の2つです。', undefined]);
});

test('REQ-007 文の処理が質問の呼び出しより遅れても、直前の文を取りこぼさない（1 回譲ってから受け取る）', async () => {
  const fixture = buildSamplePlugin();
  const sdk = askingSdk([{ early: ONE, say: '上のまとめのとおりです。' }]);
  const requests = [];
  await runInnerArm({
    arm: 'without', task: fixture.task, runDir: tmpDir('notes-race'), sdk, userRole: async (request) => { requests.push(request); return '今週'; }, judge,
  });
  assert.deepEqual(requests.map((r) => r.notes), [['上のまとめのとおりです。']]);
});

test('REQ-007 1 回の呼び出しに問いの欄が複数あるときは、前の文を最初の欄にだけ付ける', async () => {
  const fixture = buildSamplePlugin();
  const sdk = askingSdk([{ say: '2つ確認します。' }, { ask: TWO }]);
  const requests = [];
  const run = await runInnerArm({
    arm: 'without', task: fixture.task, runDir: tmpDir('notes-two'), sdk, userRole: async (request) => { requests.push(request); return 'はい'; }, judge,
  });
  assert.deepEqual(requests.map((r) => [r.question, r.notes]), [['対象の週は？', ['2つ確認します。']], ['文体は？', []]]);
  assert.deepEqual(run.history.map((h) => h.notes), ['2つ確認します。', undefined]);
});

test('REQ-007 手番の最後の文で返事を求めたときは、問いそのものを前の文に入れず、それより前に書いた文だけを渡す', async () => {
  const fixture = buildSamplePlugin();
  const sdk = fakeSdk([[init(), say('まず資料を確認しました。'), say('どの週ですか？'), done('どの週ですか？')], [init(), say('作りました。'), done('作りました。')]]);
  const requests = [];
  const run = await runInnerArm({
    arm: 'without', task: fixture.task, runDir: tmpDir('notes-chat'), sdk, userRole: async (request) => { requests.push(request); return '今週です'; }, judge,
  });
  assert.equal(run.replies, 1);
  assert.deepEqual(requests.map((r) => [r.question, r.notes]), [['どの週ですか？', ['まず資料を確認しました。']]]);
  assert.equal(run.history[0].via, 'chat');
  assert.equal(run.history[0].notes, 'まず資料を確認しました。');
});

test('REQ-007 サブエージェントの文や、空の文は、ユーザー役に渡す前の文に入れない', async () => {
  const fixture = buildSamplePlugin();
  const sub = { type: 'assistant', message: { model: 'x', content: [{ type: 'text', text: '作業エージェントの途中の文' }] }, parent_tool_use_id: 'toolu_1', agent_id: 'agent-1', subagent_type: 'w:worker' };
  const sdk = fakeSdk([[init(), say('   '), sub, say('確認です。'), done('どの週ですか？')], [init(), done('作りました。')]]);
  const requests = [];
  await runInnerArm({
    arm: 'without', task: fixture.task, runDir: tmpDir('notes-sub'), sdk, userRole: async (request) => { requests.push(request); return '今週です'; }, judge,
  });
  assert.deepEqual(requests.map((r) => r.notes), [['確認です。']]);
});

// ---- 擬似の機器（testing.md 7章）と単体の腕（REQ-062） ----------------------------------------------------------

/** 擬似の機器の代わり（tests/dev-eval/device/kxdevice.mjs の startDevice の返す形。I10）。起動・写し・止めた回数を数える */
function fakeDevice({ failStart = false, console = 'kx200# kxapp run sensor\nAVG=25\n[kxapp] sensor exited (status=0)\n' } = {}) {
  const calls = { started: [], copied: [], stopped: 0 };
  const startDevice = async ({ stateDir }) => {
    calls.started.push(stateDir);
    if (failStart) throw new Error('qemu-arm がありません');
    fs.mkdirSync(stateDir, { recursive: true });
    return {
      env: { KXEMU_GATEWAY: 'http://localhost:4242', KXEMU_ADDRS: '192.168.7.2' },
      binDir: '/dev-eval/device/bin',
      sandboxNetwork: { allowedDomains: ['localhost:4242'], strictAllowlist: true },
      sandboxFilesystem: { denyRead: [stateDir], denyWrite: [stateDir] },
      ready: { isolate: 'bwrap' },
      copyRecordsTo(workDir) {
        calls.copied.push(workDir);
        const dir = path.join(workDir, '.device');
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'console.log'), console);
        fs.writeFileSync(path.join(dir, 'history.jsonl'), '{"seq": 1, "ev": "boot"}\n');
        return { consoleLog: path.join(dir, 'console.log'), history: path.join(dir, 'history.jsonl') };
      },
      async stop() {
        calls.stopped += 1;
      },
    };
  };
  return { startDevice, calls };
}

/** 機器のログだけを見る課題（入力なし） */
function deviceTask() {
  const dir = tmpDir('device-task');
  const json = {
    id: 'D-01', prompt: 'センサーの平均値を直してください。', inputs: [],
    criteria: [{ id: 'C-01', text: '機器のログに AVG=25 と出る', grading: 'program', check: { type: 'contains', file: '.device/console.log', text: 'AVG=25' } }],
  };
  fs.writeFileSync(path.join(dir, 'eval.json'), JSON.stringify(json));
  return { id: json.id, dir, json };
}

test('REQ-061 擬似の機器：PATH の先頭に機器の道具のフォルダを足し、機器の環境変数を足す（試験の仕組みの PATH は後ろに残す）', () => {
  const device = { binDir: '/d/bin', env: { KXEMU_GATEWAY: 'http://localhost:1', KXEMU_ADDRS: '192.168.7.2' } };
  assert.deepEqual(deviceEnv({ A: '1' }, device, { PATH: '/usr/bin' }), { A: '1', KXEMU_GATEWAY: 'http://localhost:1', KXEMU_ADDRS: '192.168.7.2', PATH: `/d/bin${path.delimiter}/usr/bin` });
  assert.equal(deviceEnv({ PATH: '/x' }, device, { PATH: '/usr/bin' }).PATH, `/d/bin${path.delimiter}/x`, '足す変数に PATH があれば、その前に置く');
  assert.equal(deviceEnv({}, device, {}).PATH, '/d/bin');
  assert.deepEqual(deviceEnv({ A: '1' }, null), { A: '1' }, '機器がなければ変えない');
});

test('REQ-061 擬似の機器：実行ごとに起動し、試すエージェントに道具と口だけを渡す。外への通信の求めは断って残す。採点の前に機器の記録を作業フォルダに写し、終わったら止める', async () => {
  const task = deviceTask();
  const runDir = tmpDir('device-run');
  const { startDevice, calls } = fakeDevice();
  const decisions = [];
  const sdk = {
    calls: [],
    query: ({ prompt, options }) => {
      sdk.calls.push({ prompt, options });
      return (async function* generate() {
        yield { type: 'system', subtype: 'init', session_id: 's', model: 'x', plugins: [], mcp_servers: [] };
        decisions.push(await options.canUseTool('SandboxNetworkAccess', { host: 'example.com' }, {}));
        // エージェントが機器の記録と同じ名前のファイルを作っても、試験の仕組みが写す機器の記録で採点する
        fs.mkdirSync(path.join(options.cwd, '.device'), { recursive: true });
        fs.writeFileSync(path.join(options.cwd, '.device', 'console.log'), 'エージェントが書いた AVG=99\n');
        yield { type: 'result', subtype: 'success', is_error: false, result: '直しました。', total_cost_usd: 0, num_turns: 1, session_id: 's' };
      })();
    },
  };
  const run = await runInnerArm({ arm: 'without', task, runDir, sdk, userRole: async () => '', judge, sandbox: true, startDevice });
  assert.equal(run.status, 'completed', run.reason);
  // 機器は作業フォルダの外（実行のフォルダの device）に、1回だけ起動し、終わったら止めた
  assert.deepEqual(calls.started, [path.join(runDir, 'device')]);
  assert.equal(calls.stopped, 1);
  assert.deepEqual(calls.copied, [run.workDir]);
  // 試すエージェントに渡したもの：PATH の先頭の道具、機器の環境変数、サンドボックスの通信と見えない場所
  const { options } = sdk.calls[0];
  assert.ok(options.env.PATH.startsWith(`/dev-eval/device/bin${path.delimiter}`), options.env.PATH);
  assert.equal(options.env.KXEMU_GATEWAY, 'http://localhost:4242');
  assert.equal(options.env.KXEMU_ADDRS, '192.168.7.2');
  assert.deepEqual(options.sandbox.network, { allowedDomains: ['localhost:4242'], strictAllowlist: true });
  assert.deepEqual(options.sandbox.filesystem, { denyRead: [path.join(runDir, 'device')], denyWrite: [path.join(runDir, 'device')] });
  // 外への通信の求めは断り、記録に残す
  assert.equal(decisions[0].behavior, 'deny');
  assert.deepEqual(run.networkRefused, [{ toolName: 'SandboxNetworkAccess', host: 'example.com' }]);
  // 採点は、写した機器の記録で行った（エージェントが書いたファイルではない）
  assert.equal(run.grading.passed, 1);
  assert.match(fs.readFileSync(path.join(run.workDir, '.device', 'console.log'), 'utf8'), /AVG=25/);
  assert.equal(run.device.isolate, 'bwrap');
  assert.equal(run.device.records.consoleLog, path.join(run.workDir, '.device', 'console.log'));
  const saved = JSON.parse(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8'));
  assert.equal(saved.device.binDir, '/dev-eval/device/bin');
  assert.deepEqual(saved.networkRefused, run.networkRefused);
  assert.equal(saved.device.fenced, true);
  assert.deepEqual(saved.warnings, []);
});

test('REQ-061 擬似の機器：サンドボックスなしで動かすと、通信と中身の制限が効いていないことを、機器の記録と result.json の警告に残す', async () => {
  const task = deviceTask();
  const runDir = tmpDir('device-unfenced');
  const { startDevice } = fakeDevice();
  const sdk = fakeSdk([[init(), done('直しました。')]]);
  const run = await runInnerArm({ arm: 'without', task, runDir, sdk, userRole: async () => '', judge, sandbox: false, startDevice });
  assert.equal(run.status, 'completed', run.reason);
  assert.equal(sdk.calls[0].options.sandbox, undefined, 'サンドボックスなしでは、機器の口だけを許す設定も入らない');
  const saved = JSON.parse(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8'));
  assert.equal(saved.device.fenced, false);
  assert.deepEqual(saved.warnings, [DEVICE_UNFENCED_WARNING]);
  assert.match(DEVICE_UNFENCED_WARNING, /擬似の機器の通信と中身の制限が効いていない/);
  // 機器を使わない実行には、この警告を出さない
  const plain = await runInnerArm({ arm: 'without', task, runDir: tmpDir('plain-unfenced'), sdk: fakeSdk([[init(), done('x')]]), userRole: async () => '', judge, sandbox: false });
  assert.deepEqual(plain.warnings, []);
});

test('REQ-061 擬似の機器：機器のない実行は今までどおり（サンドボックスの通信の設定を足さず、通信の求めも断らない）', async () => {
  const task = deviceTask();
  const decisions = [];
  const sdk = {
    calls: [],
    query: ({ options }) => {
      sdk.calls.push(options);
      return (async function* generate() {
        decisions.push(await options.canUseTool('SandboxNetworkAccess', { host: 'example.com' }, {}));
        yield { type: 'result', subtype: 'success', is_error: false, result: '終わり', total_cost_usd: 0, num_turns: 1, session_id: 's' };
      })();
    },
  };
  const run = await runInnerArm({ arm: 'without', task, runDir: tmpDir('no-device'), sdk, userRole: async () => '', judge, sandbox: true });
  assert.equal(sdk.calls[0].sandbox.network, undefined);
  assert.equal(decisions[0].behavior, 'allow');
  assert.deepEqual(run.networkRefused, []);
  assert.equal(run.device, undefined);
  assert.equal(run.grading.passed, 0, '機器の記録がないので不合格');
});

test('REQ-061 擬似の機器：起動できなければ、エージェントを動かさずに error にして理由を残す。途中で失敗しても、機器は止める', async () => {
  const failing = fakeDevice({ failStart: true });
  const run = await runInnerArm({ arm: 'without', task: deviceTask(), runDir: tmpDir('device-fail'), sdk: neverSdkFor(), userRole: async () => '', judge, startDevice: failing.startDevice });
  assert.equal(run.status, 'error');
  assert.match(run.reason, /擬似の機器を起動できませんでした：qemu-arm がありません/);
  assert.equal(run.grading, null);
  assert.ok(fs.existsSync(path.join(run.runDir, 'result.json')));
  // メインの実行が投げても、機器は止める
  const broken = fakeDevice();
  const thrown = await runInnerArm({
    arm: 'without', task: deviceTask(), runDir: tmpDir('device-throw'), userRole: async () => '', judge, startDevice: broken.startDevice,
    sdk: { query: () => { throw new Error('API に届きません'); } },
  });
  assert.equal(thrown.status, 'error');
  assert.equal(broken.calls.stopped, 1);
});

test('REQ-061 擬似の機器（腕 with）：画面から始めた統括の query にも、機器の道具（PATH の先頭）と環境変数、機器の口だけの通信と見えない場所を渡し、外への通信の求めを断って残す', { skip: SKIP }, async () => {
  const fixture = buildSamplePlugin();
  const runDir = tmpDir('device-with');
  const { startDevice, calls: deviceCalls } = fakeDevice();
  const decisions = [];
  const sdk = {
    calls: [],
    query: ({ prompt, options }) => {
      sdk.calls.push({ prompt, options });
      if (options.agent) {
        // 統括：外への通信を求めてから終える
        return (async function* generate() {
          yield { type: 'system', subtype: 'init', session_id: 'orch', model: 'claude-sonnet-5-5', plugins: [], mcp_servers: [] };
          decisions.push(await options.canUseTool('SandboxNetworkAccess', { host: 'orch.example.com' }, {}));
          yield { type: 'result', subtype: 'success', is_error: false, result: '終わりました。', total_cost_usd: 0, num_turns: 1, session_id: 'orch' };
        })();
      }
      // メイン：つなぎ口の画面を開くツールを本物の MCP で呼び、URL をチャットに出す
      return (async function* generate() {
        yield { ...init(['weekly-report'], [{ name: 'weekly-report', status: 'connected' }]), session_id: 'main' };
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await options.mcpServers['weekly-report'].instance.connect(serverSide);
        const client = new Client({ name: 'test', version: '1' });
        await client.connect(clientSide);
        const opened = await client.callTool({ name: 'open', arguments: { requestText: prompt } });
        await client.close();
        const url = /http:\/\/127\.0\.0\.1:\d+\/\?k=[\w-]+/.exec(opened.content[0].text)[0];
        yield { ...say(`画面を開きました：${url}`), session_id: 'main' };
        yield { ...done(`画面を開きました：${url}`), session_id: 'main' };
      })();
    },
  };
  // 画面の代わり：人と同じく、画面の開始の窓口に設定を送って始める
  const screen = {
    operate: async ({ url, settings }) => {
      const u = new URL(url);
      const r = await fetch(`${u.origin}/api/start?k=${u.searchParams.get('k')}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) });
      assert.equal(r.status, 200, await r.text());
      return { finished: true, timedOut: false, endReason: { kind: 'all_passed' }, endReasonText: 'ok', summary: null, snapshots: [] };
    },
  };
  const run = await runInnerArm({
    arm: 'with', task: fixture.task, runDir, sdk, userRole: async () => '', judge, screen, pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot,
    sandbox: true, startDevice, taskSettings: { week: '2026-W42' },
  });
  assert.equal(run.status, 'completed', run.reason);
  const main = sdk.calls.find((c) => !c.options.agent).options;
  const orchestrator = sdk.calls.find((c) => c.options.agent)?.options;
  assert.ok(orchestrator, '画面から統括が始まった');
  assert.equal(orchestrator.agent, 'weekly-report:orchestrator');
  for (const options of [main, orchestrator]) {
    assert.ok(options.env.PATH.startsWith(`/dev-eval/device/bin${path.delimiter}`), options.env.PATH);
    assert.equal(options.env.KXEMU_GATEWAY, 'http://localhost:4242');
    assert.deepEqual(options.sandbox.network, { allowedDomains: ['localhost:4242'], strictAllowlist: true });
    assert.deepEqual(options.sandbox.filesystem, { denyRead: [path.join(runDir, 'device')], denyWrite: [path.join(runDir, 'device')] });
  }
  assert.equal(decisions[0].behavior, 'deny');
  assert.deepEqual(run.networkRefused, [{ toolName: 'SandboxNetworkAccess', host: 'orch.example.com' }], '統括が断られた通信の求めも、同じ記録に残る');
  assert.equal(deviceCalls.stopped, 1);
});

function neverSdkFor() {
  return { query: () => { throw new Error('機器を起動できないときは、エージェントを動かさないはずです'); } };
}

test('REQ-062 単体の腕の確かめ：入口のスキルを使わず、画面を開くツールを呼ばず、統括を始めなかったか', () => {
  const clean = standaloneChecks({ pluginName: 'edl', serverName: 'edl', mainTools: ['Skill', 'Bash', 'Write'], agentTypes: [], skillsUsed: ['edl:cross-compile-rules'], entrySkills: ['embedded-debug-loop'] });
  assert.equal(clean.openCalled, false);
  assert.equal(clean.orchestratorStarted, false);
  assert.equal(clean.entrySkillUsed, false);
  assert.ok(clean.checks.every((c) => c.ok));
  const opened = standaloneChecks({ pluginName: 'edl', serverName: 'edl', mainTools: ['mcp__edl__open'], agentTypes: ['edl:orchestrator'], skillsUsed: ['edl:embedded-debug-loop'], entrySkills: ['embedded-debug-loop'] });
  assert.deepEqual(opened.checks.map((c) => [c.id, c.ok]), [['entry-skill-not-used', false], ['open-not-called', false], ['orchestrator-not-started', false]]);
  // 入口のスキルを渡さないときは、プラグインの名前のスキルを入口とみなす
  assert.equal(standaloneChecks({ pluginName: 'edl', serverName: null, mainTools: [], agentTypes: [], skillsUsed: ['edl:edl'] }).entrySkillUsed, true);
  assert.equal(standaloneChecks({ pluginName: 'edl', serverName: null, mainTools: ['edl_open'], agentTypes: ['general-purpose', 'edl:worker'] }).openCalled, true);
  assert.equal(standaloneChecks({ pluginName: 'edl', serverName: null, mainTools: [], agentTypes: ['edl:worker'] }).orchestratorStarted, false);
});

test('REQ-062 単体の腕：プラグインを読み込み、つなぎ口と画面を使わずに、メインの手番が終わったら採点する。統括を始めたかを記録に残す', { skip: SKIP }, async () => {
  const fixture = buildSamplePlugin();
  fs.writeFileSync(path.join(fixture.convertedRoot, '.eval', 'rules.md'), '返事は日本語で書く。\n');
  const toolUse = (name, input) => ({ type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: `t-${name}`, name, input }] }, parent_tool_use_id: null });
  const sdk = fakeSdk([[
    init(['weekly-report'], []),
    toolUse('Skill', { skill: 'weekly-report:weekly-report' }),
    toolUse('Agent', { subagent_type: 'weekly-report:orchestrator', description: '統括', prompt: '週報' }),
    say('作業を頼みました。'),
    done('作業を頼みました。'),
  ]]);
  const { startDevice, calls } = fakeDevice();
  const run = await runInnerArm({ arm: 'standalone', task: fixture.task, runDir: tmpDir('standalone'), sdk, userRole: async () => '', judge, convertedRoot: fixture.convertedRoot, startDevice });
  assert.equal(run.status, 'completed', run.reason);
  const options = sdk.calls[0].options;
  assert.deepEqual(options.plugins, [{ type: 'local', path: fixture.convertedRoot }], 'プラグインは読み込む');
  assert.equal(options.mcpServers, undefined, 'つなぎ口（画面と記録のツール）は使わない');
  assert.equal(options.systemPrompt.append, '返事は日本語で書く。', 'プラグインのインストラクションは入る');
  assert.deepEqual(run.skillsUsed, ['weekly-report:weekly-report']);
  // 入口のスキル（変換レポートで画面を開くツールを使う skills/weekly-report/SKILL.md）から始めたことが分かる。画面を開くツールは出していないので呼べない
  assert.deepEqual(run.standalone, { openCalled: false, orchestratorStarted: true, entrySkillUsed: true });
  assert.deepEqual(run.checks.map((c) => [c.id, c.ok]), [['entry-skill-not-used', false], ['open-not-called', true], ['orchestrator-not-started', false]]);
  assert.equal(run.screen, null);
  assert.equal(run.grading.total, 2);
  assert.equal(calls.stopped, 1, '単体の腕でも機器を起動して止める');
  // 統括を始めずに終えた実行は、確かめに合格する
  const plain = fakeSdk([[init(['weekly-report'], []), say('週報を書きました。'), done('週報を書きました。')]]);
  const ok = await runInnerArm({ arm: 'standalone', task: fixture.task, runDir: tmpDir('standalone-ok'), sdk: plain, userRole: async () => '', judge, convertedRoot: fixture.convertedRoot });
  assert.ok(ok.checks.every((c) => c.ok), JSON.stringify(ok.checks));
  // プラグインが読み込まれなかったら error（なしと同じ結果を、単体の結果にしない）
  const missing = await runInnerArm({ arm: 'standalone', task: fixture.task, runDir: tmpDir('standalone-missing'), sdk: fakeSdk([[init([], []), done('x')]]), userRole: async () => '', judge, convertedRoot: fixture.convertedRoot });
  assert.equal(missing.status, 'error');
  assert.match(missing.reason, /weekly-report が読み込まれませんでした/);
  await assert.rejects(runInnerArm({ arm: 'standalone', task: fixture.task, runDir: tmpDir('standalone-noconv'), sdk: plain, userRole: async () => '', judge }), /convertedRoot/);
  await assert.rejects(runInnerArm({ arm: 'both', task: fixture.task, runDir: tmpDir('bad-arm'), sdk: plain, userRole: async () => '', judge }), /with・without・standalone/);
});

test('REQ-062 入口のスキル：変換レポートで、画面を開くツールを使う skills/<名前>/SKILL.md のフォルダの名前。見つからなければプラグインの名前', () => {
  const tool = (name, where) => ({ from: `p_${name}`, to: `mcp__p__${name}`, server: 'p', tool: name, where });
  assert.deepEqual(entrySkillsOf({ plugin: 'p', extension_tools: [tool('open', ['skills/start/SKILL.md', 'agents/orchestrator.agent.md']), tool('record', ['skills/rules/SKILL.md'])] }), ['start']);
  assert.deepEqual(entrySkillsOf({ plugin: 'p', extension_tools: [tool('open', 'skills/start/SKILL.md')] }), ['start'], 'where が文字でもよい');
  assert.deepEqual(entrySkillsOf({ plugin: 'p', extension_tools: [] }), ['p']);
  const fixture = SKIP ? null : buildSamplePlugin();
  if (fixture) assert.deepEqual(entrySkillsOf(JSON.parse(fs.readFileSync(path.join(fixture.convertedRoot, '.eval', 'conversion-report.json'), 'utf8'))), ['weekly-report']);
});

const KXDEVICE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'device', 'kxdevice.mjs');
const NO_DEVICE = !fs.existsSync(KXDEVICE) ? '擬似の機器（tests/dev-eval/device/kxdevice.mjs）がない' : spawnSync('python3', ['--version']).status !== 0 ? 'python3 がない' : false;

test('REQ-061 本物の擬似の機器（startDevice の形 I10）：試すエージェントの PATH の kxtool が、渡した環境変数で機器に届き、その記録が作業フォルダに写る', { skip: NO_DEVICE, timeout: 60_000 }, async () => {
  const { startDevice } = await import(KXDEVICE);
  const task = deviceTask();
  task.json.criteria[0].check = { type: 'contains', file: '.device/console.log', text: 'armv7l GNU/Linux' };
  let tool = null;
  const sdk = {
    query: ({ options }) => (async function* generate() {
      // 試すエージェントのコマンドの代わりに、渡された PATH と環境変数のまま kxtool を動かす（サンドボックスの外。偽の SDK）
      tool = spawnSync('kxtool', ['console', '-c', 'uname -a'], { cwd: options.cwd, env: options.env, encoding: 'utf8', timeout: 30_000 });
      yield { type: 'result', subtype: 'success', is_error: false, result: '見ました。', total_cost_usd: 0, num_turns: 1, session_id: 's' };
    })(),
  };
  const run = await runInnerArm({ arm: 'without', task, runDir: tmpDir('real-device'), sdk, userRole: async () => '', judge, startDevice: (o) => startDevice({ ...o, isolate: 'none' }) });
  assert.equal(tool.status, 0, `${tool.stderr}${tool.error?.message ?? ''}`);
  assert.match(tool.stdout, /Linux kx200 .*armv7l/);
  assert.equal(run.status, 'completed', run.reason);
  assert.equal(run.grading.passed, 1, JSON.stringify(run.grading.results));
  assert.match(fs.readFileSync(path.join(run.workDir, '.device', 'history.jsonl'), 'utf8'), /uname -a/);
  assert.equal(run.device.network.strictAllowlist, true);
  assert.match(run.device.network.allowedDomains[0], /^localhost:\d+$/);
});
