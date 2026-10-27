// 内側の EVAL の入口：引数、点数の出し方、あり・なしを回して比べる流れ。
// 動く試験は、本物の Agent SDK と Claude Code の本体、本物の生成プラグインの画面と Playwright を、偽の API につないで通す（実際のモデルは使わない）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as realSdk from '@anthropic-ai/claude-agent-sdk';

import { firstUserText, guardSdk, startFakeAnthropic } from './fake-anthropic.mjs';
import { DEVICE_STARTERS, describeFailure, InnerEvalError, innerEval, main, parseArgs, personaTaskOf, scoresOf, summarizeRun, userRoleFunction } from './inner.mjs';
import { DEVICE_UNFENCED_WARNING } from './inner-run.mjs';
import { runInnerForGenerated } from './outer-inner.mjs';
import { buildSamplePlugin, pythonHasModules, scriptedModel, tmpDir } from './inner-test-support.mjs';
import { diskOk } from './temp-dirs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERSONAS = path.resolve(HERE, '..', 'personas');
let chromium = null;
try {
  ({ chromium } = await import('playwright'));
} catch {
  chromium = null;
}
const SKIP = !pythonHasModules() ? 'Python に PyYAML と jsonschema がありません' : !chromium ? 'playwright がありません' : false;
/** 呼ばれたら失敗する sdk（始める前に断る試験用） */
const neverSdk = { query: () => { throw new Error('この試験では query を呼ばないはずです'); } };
const FAKE_ENV = { ANTHROPIC_API_KEY: 'fake-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
const BROWSER_ENV = { ...process.env, PLUGIN_TEST_BROWSER_CHANNEL: 'chromium' };

test('REQ-041 引数：必須の引数と、値の形を確かめる', () => {
  const ok = parseArgs(['--plugin', '/p', '--persona', '/a', '--persona', '/b', '--runs', '3', '--arms', 'with', '--worker-model', 'gpt-6-luna', '--setting', 'week=2026-W42', '--no-sandbox', '--timeout-minutes', '5', '--pass-env', 'A,B']);
  assert.equal(ok.plugin, '/p');
  assert.deepEqual(ok.personas, ['/a', '/b']);
  assert.equal(ok.runs, 3);
  assert.deepEqual(ok.arms, ['with']);
  assert.deepEqual(ok.models, { worker: 'gpt-6-luna' });
  assert.deepEqual(ok.settings, { week: '2026-W42' });
  assert.equal(ok.sandbox, false);
  assert.equal(ok.timeoutMs, 300_000);
  assert.deepEqual(ok.passEnv, ['A', 'B']);
  const defaults = parseArgs(['--plugin', '/p', '--persona', '/a']);
  assert.equal(defaults.sandbox, true);
  assert.deepEqual(defaults.arms, ['with', 'without']);
  assert.equal(defaults.runs, 1);
  const bad = (argv, pattern) => assert.throws(() => parseArgs(argv), (e) => e instanceof InnerEvalError && pattern.test(e.message));
  bad(['--persona', '/a'], /--plugin/);
  bad(['--plugin', '/p'], /--persona/);
  bad(['--plugin', '/p', '--persona', '/a', '--runs', '0'], /--runs/);
  bad(['--plugin', '/p', '--persona', '/a', '--arms', 'both'], /--arms/);
  bad(['--plugin', '/p', '--persona', '/a', '--setting', 'noequals'], /鍵=値/);
  bad(['--plugin', '/p', '--persona', '/a', '--nothing'], /知らない引数/);
  bad(['--plugin', '/p', '--persona'], /値が要ります/);
  bad(['--plugin', '/p', '--persona', '/a', '--timeout-minutes', '0'], /正の数/);
  // 単体の腕（REQ-062）
  assert.deepEqual(parseArgs(['--plugin', '/p', '--persona', '/a', '--arms', 'with,without,standalone']).arms, ['with', 'without', 'standalone']);
  bad(['--plugin', '/p', '--persona', '/a', '--arms', 'with,alone'], /standalone/);
});

test('REQ-041 点数：採点した実行（score がある）の平均。差は「あり」から「なし」を引く。採点しない実行は平均に入れない', () => {
  const runs = [
    { task: 'T-01', arm: 'with', score: 1 },
    { task: 'T-01', arm: 'with', score: 0.5 },
    { task: 'T-01', arm: 'without', score: 0.25 },
    { task: 'T-01', arm: 'without', score: null }, // error・stopped・skipped
    { task: 'T-02', arm: 'with', score: 0 },
    { task: 'T-02', arm: 'without', score: null },
  ];
  const scores = scoresOf(runs);
  assert.equal(scores.with, 0.5);
  assert.equal(scores.without, 0.25);
  assert.equal(scores.difference, 0.25);
  assert.deepEqual(scores.byTask['T-01'], { with: 0.75, without: 0.25, difference: 0.5 });
  assert.deepEqual(scores.byTask['T-02'], { with: 0, without: null, difference: null });
  assert.deepEqual(scoresOf([]), { with: null, without: null, difference: null, byTask: {} });
  // 単体の腕を回したときだけ、その点数を出す（REQ-062）
  const alone = scoresOf([...runs, { task: 'T-09', arm: 'standalone', score: 0.75 }, { task: 'T-09', arm: 'standalone', score: null }]);
  assert.equal(alone.standalone, 0.75);
  assert.deepEqual(alone.byTask['T-09'], { with: null, without: null, difference: null, standalone: 0.75 });
  assert.equal(alone.byTask['T-01'].standalone, undefined);
});

// ---- 単体の腕と擬似の機器（REQ-062、testing.md 7章） ---------------------------------------------------------------

/** 擬似の機器の代わり（I10 の形）。起動と止めた回数を数える */
function fakeDevice() {
  const calls = { started: [], stopped: 0 };
  return {
    calls,
    startDevice: async ({ stateDir }) => {
      calls.started.push(stateDir);
      return {
        env: { KXEMU_GATEWAY: 'http://localhost:4242', KXEMU_ADDRS: '192.168.7.2' }, binDir: '/dev-eval/device/bin', ready: { isolate: 'none' },
        sandboxNetwork: { allowedDomains: ['localhost:4242'], strictAllowlist: true }, sandboxFilesystem: { denyRead: [stateDir], denyWrite: [stateDir] },
        copyRecordsTo: (workDir) => ({ consoleLog: path.join(workDir, '.device', 'console.log'), history: path.join(workDir, '.device', 'history.jsonl') }),
        stop: async () => { calls.stopped += 1; },
      };
    },
  };
}

test('REQ-062 模擬ユーザーの課題：inner/standalone.json があれば単体の課題を、persona.device があれば擬似の機器の名前を付ける', () => {
  const dir = tmpDir('persona-task');
  fs.mkdirSync(path.join(dir, 'inner'));
  fs.writeFileSync(path.join(dir, 'inner', 'eval.json'), JSON.stringify({ id: 'T-01', prompt: 'A', criteria: [] }));
  const plain = personaTaskOf({ dir, persona: { id: 'p' } });
  assert.deepEqual([plain.id, plain.device, plain.standalone], ['T-01', null, null]);
  fs.writeFileSync(path.join(dir, 'inner', 'standalone.json'), JSON.stringify({ id: 'T-02', prompt: 'B', criteria: [] }));
  const both = personaTaskOf({ dir, persona: { id: 'p', device: 'kx200' } });
  assert.equal(both.device, 'kx200');
  assert.deepEqual([both.standalone.id, both.standalone.dir, both.standalone.json.prompt, both.standalone.personaId], ['T-02', path.join(dir, 'inner'), 'B', 'p']);
  assert.equal(typeof DEVICE_STARTERS.kx200, 'function');
});

test('REQ-062 単体の腕だけを回す：単体の課題で動かし、腕ごとに擬似の機器を起動して止める。単体の課題がなければ始めない', { skip: SKIP }, async () => {
  const fixture = buildSamplePlugin();
  const sdk = {
    calls: [],
    query: ({ options }) => {
      sdk.calls.push(options);
      return (async function* generate() {
        yield { type: 'system', subtype: 'init', session_id: 's', model: 'x', plugins: [{ name: 'weekly-report' }], mcp_servers: [] };
        yield { type: 'result', subtype: 'success', is_error: false, result: '書きました。', total_cost_usd: 0, num_turns: 1, session_id: 's' };
      })();
    },
  };
  const device = fakeDevice();
  const standalone = { id: 'S-01', dir: fixture.task.dir, json: { ...fixture.task.json, id: 'S-01' } };
  const outDir = tmpDir('standalone-eval');
  const record = await innerEval({
    sdk, chromium: null, pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot, outDir, runs: 1, arms: ['standalone'], sandbox: false, diskCheck: diskOk, judge: async () => ({ pass: true, reason: '' }),
    tasks: [{ ...fixture.task, device: 'kx200', standalone }, { ...fixture.task, id: 'T-09' }], userRoleFor: () => async () => '', startDevice: device.startDevice,
  });
  assert.deepEqual(record.runs.map((r) => [r.task, r.arm, r.status]), [['S-01', 'standalone', 'completed'], ['T-09', 'standalone', 'skipped']]);
  assert.match(record.runs[1].reason, /単体の課題/);
  assert.equal(record.runs[0].standalone.orchestratorStarted, false);
  assert.ok(record.runs[0].device, '機器を使った実行は、機器の記録を要点に残す');
  assert.deepEqual(record.runs[0].networkRefused, []);
  assert.ok(typeof record.scores.standalone === 'number');
  assert.deepEqual(device.calls.started, [path.join(outDir, 'inner-runs', 'S-01', 'standalone-1', 'device')]);
  assert.equal(device.calls.stopped, 1);
  assert.deepEqual(sdk.calls[0].plugins, [{ type: 'local', path: fixture.convertedRoot }]);
  assert.equal(record.tasks[0].device, 'kx200');
  assert.equal(record.tasks[0].standalone.id, 'S-01');
  // サンドボックスなしで機器を使ったので、機器の通信と中身の制限が効いていないことを、全体と実行の要点に残す
  assert.ok(record.warnings.includes(DEVICE_UNFENCED_WARNING), JSON.stringify(record.warnings));
  assert.deepEqual(record.runs[0].warnings, [DEVICE_UNFENCED_WARNING]);
  assert.equal(record.runs[0].device.fenced, false);
  // 知らない機器は、始める前に断る
  await assert.rejects(
    innerEval({ sdk: neverSdk, chromium: null, pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot, outDir: tmpDir('x'), arms: ['without'], sandbox: false, tasks: [{ ...fixture.task, device: 'kx999' }], userRoleFor: () => async () => '' }),
    (e) => e instanceof InnerEvalError && /kx999/.test(e.message),
  );
});

test('REQ-061 外側から呼ぶ内側の EVAL：模擬ユーザーの device を課題に付けて渡す', async () => {
  const personaDir = tmpDir('outer-inner');
  fs.mkdirSync(path.join(personaDir, 'inner'));
  fs.writeFileSync(path.join(personaDir, 'inner', 'eval.json'), JSON.stringify({ id: 'T-01', prompt: 'A', criteria: [] }));
  let seen = null;
  await runInnerForGenerated({
    pluginDir: '/p', loaded: { dir: personaDir, persona: { id: 'edl', device: 'kx200' } }, styleName: 'normal', query: () => {}, outDir: tmpDir('outer-inner-out'), sandbox: false,
    convert: () => {}, chromium: {}, innerEval: async (o) => { seen = o; return { status: 'completed' }; },
  });
  assert.equal(seen.tasks[0].device, 'kx200');
  assert.deepEqual(seen.arms, ['with', 'without']);
});

test('REQ-041 結果の要点：基準ごとの合否と理由、画面の終わった理由、確かめ、費用を残す', () => {
  const run = {
    status: 'completed', reason: null, grading: { score: 0.5, passed: 1, total: 2, results: [{ id: 'C-01', text: 'a', grading: 'program', pass: true, reason: 'ok' }, { id: 'C-02', text: 'b', grading: 'model', pass: false, reason: 'ng', error: true }] },
    replies: 1, url: 'http://127.0.0.1:1/?k=a', screen: { endReason: { kind: 'all_passed' }, endReasonText: '評価基準をすべて満たした' }, checks: [{ id: 'x', ok: true }],
    finalState: { settings: { models: { worker: 'gpt-6-luna' } } }, agents: [{ agentType: 'p:worker', status: 'completed', selectedModel: 'gpt-6-luna', actualClaudeId: 'claude-haiku-5-5', executionMode: 'sync', extra: 1 }],
    skillsUsed: ['p:p'], costUsd: { main: 0.1, orchestrator: 0.2 }, seconds: 12, runDir: '/r', workDir: '/r/work',
  };
  const out = summarizeRun(run, { task: 'T-01', arm: 'with', n: 2 });
  assert.equal(out.score, 0.5);
  assert.deepEqual(out.criteria[1], { id: 'C-02', text: 'b', grading: 'model', pass: false, reason: 'ng', error: true });
  assert.equal(out.endReasonText, '評価基準をすべて満たした');
  assert.deepEqual(out.agents[0], { agentType: 'p:worker', status: 'completed', selectedModel: 'gpt-6-luna', actualClaudeId: 'claude-haiku-5-5', executionMode: 'sync' });
  assert.equal(out.n, 2);
  const stopped = summarizeRun({ status: 'stopped', reason: '上限', grading: null }, { task: 'T-01', arm: 'without', n: 1 });
  assert.equal(stopped.score, null);
  assert.deepEqual(stopped.criteria, []);
});

test('testing.md 11.1 サンドボックスの道具がなければ、実際のモデルを使う前に断る（--no-sandbox で外せる）', async () => {
  const fixture = buildSamplePlugin();
  await assert.rejects(
    innerEval({
      sdk: neverSdk, chromium, pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot, tasks: [fixture.task], userRoleFor: () => async () => '', outDir: tmpDir('nosandbox'),
      sandbox: true, sandboxCheck: () => ({ available: false, missing: ['bwrap', 'socat'] }),
    }),
    (error) => error instanceof InnerEvalError && error.code === 'sandbox_missing' && /bwrap、socat/.test(error.message) && /--no-sandbox/.test(error.message),
  );
  await assert.rejects(
    innerEval({ sdk: neverSdk, chromium, pluginRoot: fixture.pluginRoot, convertedRoot: tmpDir('notconverted'), tasks: [fixture.task], userRoleFor: () => async () => '', outDir: tmpDir('x'), sandbox: false, diskCheck: diskOk }),
    /変換レポートがありません/,
  );
  await assert.rejects(innerEval({ sdk: neverSdk, chromium, pluginRoot: '/p', convertedRoot: '/c', tasks: [], userRoleFor: () => async () => '', outDir: tmpDir('x') }), /課題が1つもありません/);
});

test('testing.md 5章 ディスクの空き（/ と OS の一時フォルダと結果のフォルダ）が足りなければ、実際のモデルを使う前に断る（disk_low）。確かめの順は外側の EVAL と同じ', async () => {
  const lowDisk = () => ({ ok: false, low: [{ path: '/', freeBytes: 1 }], message: 'ディスクの空きが足りないので始めません（/ の空き 0.0 GB。2.0 GB 以上が要ります）。' });
  const outDir = tmpDir('disk');
  const seen = [];
  await assert.rejects(
    innerEval({
      sdk: neverSdk, chromium: null, pluginRoot: '/p', convertedRoot: '/c', tasks: [{ id: 'T-01', dir: '/t', json: { criteria: [] } }], userRoleFor: () => async () => '', outDir,
      sandbox: false, diskCheck: (o) => { seen.push(o); return lowDisk(); },
    }),
    (error) => error instanceof InnerEvalError && error.code === 'disk_low' && /\/ の空き 0\.0 GB/.test(error.message),
  );
  assert.deepEqual(seen, [{ dirs: [outDir] }], '結果のフォルダも見る');
  // サンドボックスの道具が先（outer.mjs と同じ順）
  await assert.rejects(
    innerEval({
      sdk: neverSdk, chromium: null, pluginRoot: '/p', convertedRoot: '/c', tasks: [{ id: 'T-01', dir: '/t', json: { criteria: [] } }], userRoleFor: () => async () => '', outDir,
      sandbox: true, sandboxCheck: () => ({ available: false, missing: ['bwrap'] }), diskCheck: lowDisk,
    }),
    (error) => error.code === 'sandbox_missing',
  );
  // コマンドラインの入口は、結果のフォルダを作って置き換える前に断る（終了コード 2）
  const out = path.join(tmpDir('disk-main'), 'out');
  const saved = console.log;
  const printed = [];
  console.log = (line) => printed.push(String(line));
  let code;
  try {
    code = await main(['--plugin', '/nonexistent', '--persona', path.join(PERSONAS, 'weekly-report'), '--out', out, '--no-sandbox'], { sdk: neverSdk, chromium: {}, diskCheck: lowDisk });
  } finally {
    console.log = saved;
  }
  assert.equal(code, 2);
  assert.equal(JSON.parse(printed.at(-1)).error, 'disk_low');
  assert.equal(fs.existsSync(out), false, '結果のフォルダも置き換えた版も作らない');
});

test('REQ-041 あり・なしを回して、点数とその差を出し、実行ごとの記録を残す。利用枠の上限では残りを始めない', { skip: SKIP, timeout: 300_000 }, async (t) => {
  const fixture = buildSamplePlugin();
  // ありは見出しがある週報を作り、なしは見出しがない週報を作る（差が出る）
  const api = await startFakeAnthropic(scriptedModel({ workerDelayMs: 1500, verifierDelayMs: 1500, plainContent: '# 週報\n- 3件\n' }));
  const sdk = guardSdk(realSdk, api); // 守り：偽の API につながっていない query は断る（実際のモデルを呼ばない）
  t.after(() => api.close());
  const outDir = tmpDir('inner-eval');
  const progress = [];
  const record = await innerEval({
    sdk, chromium, pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot, tasks: [fixture.task], userRoleFor: () => async () => 'はい', outDir, runs: 1,
    envExtra: { ...FAKE_ENV, ANTHROPIC_BASE_URL: api.url }, sandbox: false, diskCheck: diskOk, timeoutMs: 120_000, pollMs: 300, env: BROWSER_ENV, onProgress: (p) => progress.push(`${p.phase}:${p.arm}`),
  });
  assert.equal(record.status, 'completed');
  assert.equal(record.stopped, null);
  assert.equal(record.kind, 'dev-inner-eval');
  assert.equal(record.plugin, 'weekly-report');
  assert.equal(record.runs.length, 2);
  assert.deepEqual(record.runs.map((r) => [r.arm, r.status]), [['with', 'completed'], ['without', 'completed']]);
  assert.deepEqual(progress, ['start:with', 'end:with', 'start:without', 'end:without']);
  // どちらも基準は2つ。ありは2つ合格、なしは1つ（見出しがない。もう1つは偽の判定が合格にする）合格
  assert.equal(record.scores.with, 1);
  assert.equal(record.scores.without, 0.5);
  assert.equal(record.scores.difference, 0.5);
  assert.deepEqual(record.runs[1].criteria.map((c) => [c.id, c.pass]), [['C-01', false], ['C-02', true]]);
  assert.ok(record.runs[0].checks.every((c) => c.ok), JSON.stringify(record.runs[0].checks.filter((c) => !c.ok)));
  assert.ok(record.warnings.some((w) => /サンドボックスなし/.test(w)));
  assert.equal(record.versions.agentSdk, '0.3.310');
  assert.equal(record.versions.claudeCode, '2.1.310');
  assert.ok(record.costUsd.judge > 0 && record.costUsd.orchestrator > 0);
  // 結果のファイルと、実行ごとの記録
  const saved = JSON.parse(fs.readFileSync(record.resultFile, 'utf8'));
  assert.equal(saved.status, 'completed');
  for (const arm of ['with-1', 'without-1']) {
    assert.ok(fs.existsSync(path.join(outDir, 'inner-runs', 'T-01', arm, 'result.json')), arm);
    assert.ok(fs.existsSync(path.join(outDir, 'inner-runs', 'T-01', arm, 'events.jsonl')), arm);
  }
  assert.ok(fs.existsSync(path.join(outDir, 'inner-runs', 'T-01', 'with-1', 'screen.png')));
});

test('REQ-041 利用枠の上限で止まった実行があれば、残りの実行は始めずに skipped にし、全体を stopped にする', { skip: SKIP, timeout: 120_000 }, async () => {
  const fixture = buildSamplePlugin();
  const fakeSdk = {
    USAGE_LIMIT_ERROR_PREFIXES: ["You've hit your"],
    query: () => (async function* generate() {
      yield { type: 'system', subtype: 'init', session_id: 's', model: 'x', plugins: [], mcp_servers: [] };
      yield { type: 'result', subtype: 'success', is_error: true, result: "You've hit your session limit · resets 3pm", total_cost_usd: 0, num_turns: 1, session_id: 's' };
    })(),
  };
  const record = await innerEval({
    sdk: fakeSdk, chromium, pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot, tasks: [fixture.task], userRoleFor: () => async () => '', outDir: tmpDir('limit'), runs: 2,
    arms: ['without'], sandbox: false, diskCheck: diskOk, judge: async () => ({ pass: true, reason: '' }),
  });
  assert.equal(record.status, 'stopped');
  assert.equal(record.stopped.reason, 'usage_limit');
  assert.deepEqual(record.runs.map((r) => r.status), ['stopped', 'skipped']);
  assert.equal(record.scores.without, null);
  assert.equal(record.stopped.run, `${fixture.task.id}/without-1`);
  // 機器を使わない課題では、機器の警告を出さない
  assert.ok(!record.warnings.includes(DEVICE_UNFENCED_WARNING));
  // 単体の腕で止まったときは、単体の課題の実行のフォルダ（inner-runs/<単体の課題>/standalone-<回>）を示す
  const standalone = { id: 'S-01', dir: fixture.task.dir, json: { ...fixture.task.json, id: 'S-01' } };
  const alone = await innerEval({
    sdk: fakeSdk, chromium: null, pluginRoot: fixture.pluginRoot, convertedRoot: fixture.convertedRoot, tasks: [{ ...fixture.task, standalone }], userRoleFor: () => async () => '',
    outDir: tmpDir('limit-standalone'), arms: ['standalone'], sandbox: false, diskCheck: diskOk, judge: async () => ({ pass: true, reason: '' }),
  });
  assert.equal(alone.stopped.run, 'S-01/standalone-1');
  assert.ok(fs.existsSync(path.join(alone.runs[0].runDir, 'result.json')));
  assert.equal(path.relative(path.dirname(alone.resultFile), alone.runs[0].runDir), path.join('inner-runs', 'S-01', 'standalone-1'));
});

test('REQ-041 コマンドライン：模擬ユーザーの inner/ の課題を、置き換えた生成プラグインあり・なしで回し、結果を標準出力と inner-result.json に出す', { skip: SKIP, timeout: 300_000 }, async (t) => {
  const fixture = buildSamplePlugin();
  const persona = path.join(PERSONAS, 'weekly-report');
  // 模擬ユーザーの基準（weekly_report.md、見出し2つ、47万円、1万円未満、最後の行が「以上」）を満たす中身を、ありだけが書く
  const good = '■今週の売上\n合計 47万円\n田中 1万円未満\n■来週の予定\n- 訪問\n以上\n';
  const userRoleQuestions = [];
  const api = await startFakeAnthropic(scriptedModel({ deliverable: 'weekly_report.md', content: good, plainContent: 'できました\n', verifierDelayMs: 300, onRequest: (role, body) => { if (role === 'user-role') userRoleQuestions.push(firstUserText(body)); } }));
  const sdk = guardSdk(realSdk, api); // 守り：偽の API につながっていない query は断る（実際のモデルを呼ばない）
  t.after(() => api.close());
  const outDir = tmpDir('cli');
  const saved = { env: { ...process.env }, log: console.log };
  Object.assign(process.env, FAKE_ENV, { ANTHROPIC_BASE_URL: api.url, PLUGIN_TEST_BROWSER_CHANNEL: 'chromium' });
  const printed = [];
  console.log = (line) => printed.push(String(line));
  let code;
  try {
    code = await main(['--plugin', fixture.pluginRoot, '--persona', persona, '--out', outDir, '--no-sandbox', '--timeout-minutes', '4', '--pass-env', 'ANTHROPIC_API_KEY,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'], { sdk, diskCheck: diskOk });
  } finally {
    console.log = saved.log;
    process.env = saved.env;
  }
  assert.equal(code, 0, printed.join('\n'));
  const record = JSON.parse(printed.join('\n'));
  assert.equal(record.status, 'completed');
  assert.equal(record.runs.length, 2);
  assert.deepEqual(record.runs.map((r) => r.status), ['completed', 'completed']);
  assert.equal(record.runs[0].task, 'T-01');
  assert.equal(record.runs[0].total, 7);
  assert.equal(record.runs[0].passed, 7, JSON.stringify(record.runs[0].criteria.filter((c) => !c.pass)));
  assert.ok(record.runs[1].passed < 7);
  assert.ok(record.scores.difference > 0);
  // 画面の設定の欄（対象の週）は、--setting なしで、ユーザー役が決めた。聞いた文には、模擬ユーザーの頼みの文と渡したファイルの先頭が入っている
  assert.deepEqual(record.runs[0].settings.map((d) => [d.key, d.source, d.value]), [['week', 'user-role', '2026-W42']]);
  assert.deepEqual(record.runs[1].settings, []);
  assert.equal(userRoleQuestions.length, 1);
  const salesHead = fs.readFileSync(path.join(persona, 'inner', 'inputs', 'sales.csv'), 'utf8').split('\n')[0].trim();
  assert.match(userRoleQuestions[0], /あなたが頼んだこと：inputs\/sales\.csv から、今週の週報を作ってください。/);
  assert.ok(userRoleQuestions[0].includes(salesHead), salesHead);
  assert.ok(fs.existsSync(path.join(outDir, 'inner-result.json')));
  assert.ok(fs.existsSync(path.join(outDir, 'converted', '.claude-plugin', 'plugin.json')));
});

test('REQ-041 コマンドライン：引数の誤りと、置き換えられない・読めない課題は、始めずに終了コード 2 で理由を示す', async () => {
  const saved = console.log;
  const printed = [];
  console.log = (line) => printed.push(String(line));
  try {
    assert.equal(await main(['--persona', '/a']), 2);
    assert.equal(await main(['--plugin', '/nonexistent', '--persona', '/nonexistent', '--out', tmpDir('bad'), '--no-sandbox'], { diskCheck: diskOk }), 2);
  } finally {
    console.log = saved;
  }
  const first = JSON.parse(printed[0]);
  assert.equal(first.ok, false);
  assert.equal(first.error, 'usage');
  assert.equal(JSON.parse(printed[1]).ok, false);
});

test('REQ-041 始められなかった誤り：部品（npm のパッケージ）が入っていないときは、入れ方を示す', () => {
  const missing = Object.assign(new Error("Cannot find package 'playwright' imported from /x/inner.mjs\n  at foo"), { code: 'ERR_MODULE_NOT_FOUND' });
  assert.deepEqual(describeFailure(missing), { error: 'tools_missing', message: "必要な部品が入っていません。tests/dev-eval で npm install を実行してください（Cannot find package 'playwright' imported from /x/inner.mjs）。" });
  assert.deepEqual(describeFailure(new InnerEvalError('sandbox_missing', '足りません')), { error: 'sandbox_missing', message: '足りません' });
  assert.deepEqual(describeFailure(new Error('x')), { error: 'failed', message: 'x' });
});

test('REQ-007 ユーザー役の関数：質問のしかた（via）と印（meta）をユーザー役に渡す。省いたときは、選択肢の有無で決める', async () => {
  const calls = [];
  const role = { cost: 0.5, answer: async (...args) => { calls.push(args); return { answer: '答え' }; } };
  const fn = userRoleFunction(role);
  assert.equal(await fn({ question: 'Q1', choices: ['a'] }), '答え');
  assert.equal(await fn({ question: 'Q2' }), '答え');
  assert.equal(await fn({ question: 'Q3', choices: [], via: 'setting', meta: { setting: 'week' } }), '答え');
  assert.deepEqual(calls, [['Q1', ['a'], 'AskUserQuestion', {}, []], ['Q2', [], 'text', {}, []], ['Q3', [], 'setting', { setting: 'week' }, []]]);
  assert.equal(fn.cost(), 0.5);
});

test('REQ-007 ユーザー役の関数：メインのエージェントが質問の前にチャットに書いた文（notes）も、そのままユーザー役に渡す', async () => {
  const calls = [];
  const role = { cost: 0, answer: async (...args) => { calls.push(args); return { answer: '答え' }; } };
  const fn = userRoleFunction(role);
  await fn({ question: 'どちらですか？', choices: ['今週', '先週'], notes: ['まとめを書きます。', '週は2つあります。'] });
  await fn({ question: 'どの週ですか？', notes: ['確認です。'] });
  assert.deepEqual(calls, [
    ['どちらですか？', ['今週', '先週'], 'AskUserQuestion', {}, ['まとめを書きます。', '週は2つあります。']],
    ['どの週ですか？', [], 'text', {}, ['確認です。']],
  ]);
});
