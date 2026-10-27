// EVAL の実行（skills/test-plugin/scripts/run.mjs）の試験。偽物の Copilot SDK と偽物の画面の操作で動かす。
// 本物の Copilot CLI とモデルは使わない（最終確認で人が確かめる。testing.md 9章）。
// 確かめる要件：REQ-041（あり・なしで同じ課題を何回か実行し、基準で採点する。実行ごとの基準ごとの合否、あり・なしの点数とその差、使った AI クレジット。
//   採点は生成プラグインの外。検証エージェントの合否は使わない）、REQ-040（AI クレジットの上限で、クレジットを足さずに止める）、REQ-005（実行中の確認への答え方）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, mock, test } from 'node:test';

import { FAST_TIMING, SCREEN_URL, createWorld, filesIn, finishedScreen, sleep, usage } from './fake-sdk.mjs';
import { cleanupTemp, loadScript, makeTemp, sampleTask } from './helpers.mjs';

const { runEval, runtimeEnv, readPluginInfo } = await loadScript('run.mjs');
const { ScreenError } = await loadScript('screen.mjs');
after(cleanupTemp);

const ENV = { PATH: '/usr/bin', HOME: '/home/u', COPILOT_CLI_PATH: '/opt/copilot', NOT_SET: undefined };
const GOOD = { with: { 'out/週報.md': '売上は52万円でした\n以上\n' }, without: { 'out/週報.md': '売上は52万でした\n' } };

function run(world, extra = {}) {
  return runEval({ pluginDir: world.pluginDir, runs: 1, sdk: world.sdk, screen: world.screen, timing: FAST_TIMING, workRoot: makeTemp('c3-work-'), env: ENV, ...extra });
}
const ids = (result) => result.runs.map((r) => `${r.task}/${r.variant}/${r.n}`);
const statuses = (result) => result.runs.map((r) => r.status);
const eventsOf = (result, record) =>
  fs.readFileSync(path.join(result.resultsDir, record.events), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
/** ありの実行の作業フォルダに、ファイルを書く（生成プラグインの作業エージェントが書いた成果物の代わり） */
function writeWorkFile(world, rel, text) {
  const file = path.join(world.withWorkDirs.at(-1), ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
/** 画面の操作が止まったままになる偽物（試験全体が止まると、中断の合図で終わる） */
const blockedScreen = () => ({
  operate: ({ signal }) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(new ScreenError('試験が止まったので、画面の操作をやめました。')), { once: true })),
});

describe('実行の流れ', () => {
  test('REQ-041 課題ごとに、あり・なしを回数分実行し、基準ごとの合否・あり・なしの点数とその差・使った AI クレジットを出す', async () => {
    const world = createWorld({ outputs: GOOD });
    const result = await run(world, { runs: 2 });

    assert.equal(result.status, 'completed');
    assert.equal(result.stopped, null);
    assert.deepEqual(ids(result), ['T-01/with/1', 'T-01/without/1', 'T-01/with/2', 'T-01/without/2']);
    assert.deepEqual(statuses(result), ['completed', 'completed', 'completed', 'completed']);

    const [with1, without1] = result.runs;
    assert.deepEqual(with1.criteria.map((c) => [c.id, c.pass]), [['C-01', true], ['C-02', true]]);
    assert.deepEqual(without1.criteria.map((c) => [c.id, c.pass]), [['C-01', true], ['C-02', false]], '「52万」は「52万円」を求める基準で不合格');
    assert.equal(with1.criteria[0].text, '週報のファイルがある');
    assert.equal(with1.criteria[0].grading, 'program');
    assert.match(without1.criteria[1].reason, /52万円/);
    assert.equal(with1.score, 1);
    assert.equal(without1.score, 0.5);
    assert.deepEqual(result.scores, { with: 1, without: 0.5, difference: 0.5, byTask: { 'T-01': { with: 1, without: 0.5, difference: 0.5 } } });

    // 費用：ありは 1 クレジット（10億 nano-AIU）、なしは 0.5 クレジット。2回ずつ
    assert.equal(with1.credits, 1);
    assert.equal(without1.credits, 0.5);
    assert.equal(result.credits, 3);
    assert.deepEqual(result.creditDetail, { with: 2, without: 1, grading: 0, status: 'complete' });
    assert.deepEqual(result.tasks, [{ id: 'T-01', criteria: [{ id: 'C-01', text: '週報のファイルがある', grading: 'program' }, { id: 'C-02', text: '金額を「52万円」の形で書く', grading: 'program' }] }]);
    assert.equal(result.plugin.name, 'weekly-report');
    assert.equal(result.plugin.version, '1.2.3');
    assert.equal(result.options.runs, 2);
    assert.equal(result.versions.copilotCli, '1.0.102');
    assert.equal(result.versions.browser, 'fake');
  });

  test('REQ-041 結果は <結果のフォルダ>/result.json に書かれ、返り値と同じ。実行ごとの記録（イベント、画面）も残る', async () => {
    const world = createWorld({ outputs: GOOD });
    const result = await run(world);
    assert.match(path.basename(result.resultsDir), /^eval-\d{8}-\d{6}$/);
    assert.equal(path.dirname(result.resultsDir), path.join(world.pluginDir, 'tests', 'results'));
    const saved = JSON.parse(fs.readFileSync(path.join(result.resultsDir, 'result.json'), 'utf8'));
    assert.deepEqual(saved, JSON.parse(JSON.stringify(result)));
    assert.equal(saved.kind, 'eval');

    const [withRun, withoutRun] = result.runs;
    assert.equal(withRun.events, 'runs/T-01/with-1/events.jsonl');
    const types = eventsOf(result, withRun).map((e) => e.type);
    assert.deepEqual(types, ['session.start', 'skill.invoked', 'assistant.usage', 'assistant.message', 'session.idle']);
    assert.equal(eventsOf(result, withoutRun).at(-1).type, 'session.idle');
    const screenRecord = JSON.parse(fs.readFileSync(path.join(result.resultsDir, withRun.screen), 'utf8'));
    assert.equal(screenRecord.url, 'http://127.0.0.1:8731/?k=***', '合言葉は残さない');
    assert.equal(screenRecord.endReason.kind, 'all_passed');
    assert.match(screenRecord.note, /採点には使っていない/);
    assert.equal(withoutRun.screen, undefined, 'なしの実行に画面の記録はない');
  });

  test('REQ-041 Copilot CLI には、ありのときだけ --plugin-dir を渡し、どちらも COPILOT_PLUGIN_DIR_ONLY=true にし、同梱のランタイムを使う', async () => {
    const world = createWorld({ outputs: GOOD });
    await run(world);
    const [withClient, withoutClient] = world.sdk.clients;
    assert.deepEqual(withClient.options.connection.args, ['--plugin-dir', world.pluginDir]);
    assert.deepEqual(withoutClient.options.connection.args, []);
    for (const client of [withClient, withoutClient]) {
      const env = client.options.connection.env;
      assert.equal(env.COPILOT_PLUGIN_DIR_ONLY, 'true');
      assert.equal(env.PATH, '/usr/bin');
      assert.equal('COPILOT_CLI_PATH' in env, false, '手元の Copilot CLI に替えない');
      assert.equal('NOT_SET' in env, false, '値のない環境変数は渡さない');
      assert.equal(client.options.logLevel, 'error');
      assert.equal(client.started && client.stopped, true, '起動して、終わったら止める');
    }
  });

  test('REQ-041 セッションは、ありのときだけ requestExtensions: true。作業フォルダをこのセッションだけ信頼し、質問と許可の受け口を渡す', async () => {
    const world = createWorld({ outputs: GOOD });
    await run(world, { model: 'gpt-6-luna' });
    const [withSession, withoutSession] = world.sdk.sessions;
    assert.equal(withSession.config.requestExtensions, true);
    assert.equal(withoutSession.config.requestExtensions, false);
    for (const session of [withSession, withoutSession]) {
      assert.equal(session.config.trustWorkingDirectory, 'session');
      assert.equal(session.config.model, 'gpt-6-luna');
      assert.equal(typeof session.config.onPermissionRequest, 'function');
      assert.equal(typeof session.config.onUserInputRequest, 'function');
      assert.equal(typeof session.config.onEvent, 'function', 'セッションを作る途中のイベントも取りこぼさない');
      assert.equal(session.config.workingDirectory, session.client.options.workingDirectory);
      assert.equal(session.disconnected, true);
      assert.deepEqual(session.sent.map((s) => s.prompt), ['週報を作ってください。対象は 2026-W42 です。']);
    }
    const noModel = createWorld({ outputs: GOOD });
    await run(noModel);
    assert.equal('model' in noModel.sdk.sessions[0].config, false, 'モデルを指定しなければ、Copilot の既定');
  });

  test('REQ-041 実行のたびに、課題の入力のファイルだけを写した、まっさらな作業フォルダで始める（生成プラグインのフォルダの外）', async () => {
    const listings = [];
    const world = createWorld({
      tasks: [sampleTask({ inputs: ['inputs/前回の週報.md'] })],
      files: { 'tests/eval/T-01/inputs/前回の週報.md': '前回', 'tests/eval/T-01/inputs/使わない.md': '写さない' },
      outputs: GOOD,
      behavior: { onCreateSession: (_client, config) => listings.push(filesIn(config.workingDirectory)) },
    });
    await run(world, { runs: 2 });
    assert.equal(listings.length, 4);
    for (const listing of listings) assert.deepEqual(listing, ['inputs/前回の週報.md']);
    const dirs = world.sdk.sessions.map((s) => s.workDir);
    assert.equal(new Set(dirs).size, 4, '実行ごとに別のフォルダ');
    for (const dir of dirs) assert.ok(path.relative(world.pluginDir, dir).startsWith('..'), '生成プラグインのフォルダの中ではない');
  });

  test('REQ-041 画面の操作には、チャットに出た URL・課題の設定・上限の時間・中断の合図を渡す', async () => {
    const world = createWorld({ tasks: [sampleTask({ settings: { maxIterations: 2, task: { week: '2026-W42' } } })], outputs: GOOD });
    await run(world);
    assert.equal(world.screen.prepared, 1, 'ブラウザーは、AI クレジットを使う前に1回だけ起動する');
    assert.equal(world.screen.calls.length, 1, 'なしの実行では、画面を操作しない');
    const [call] = world.screen.calls;
    assert.equal(call.url, SCREEN_URL);
    assert.deepEqual(call.settings, { maxIterations: 2, task: { week: '2026-W42' } });
    assert.ok(call.timeoutMs > 0 && call.timeoutMs <= FAST_TIMING.timeoutMs);
    assert.equal(call.signal instanceof AbortSignal, true);
    assert.match(call.screenshotPath, /runs[\\/]T-01[\\/]with-1[\\/]screen\.png$/);
  });

  test('REQ-041 結果は実行が終わるたびに書き直され、途中では status が running になる', async () => {
    const resultsDir = path.join(makeTemp('c3-results-'), 'eval-x');
    const seen = [];
    const world = createWorld({
      outputs: GOOD,
      screen: {
        operate: async () => {
          const file = path.join(resultsDir, 'result.json');
          seen.push(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
          return finishedScreen();
        },
      },
    });
    const result = await run(world, { runs: 2, resultsDir });
    assert.equal(seen.length, 2);
    assert.equal(seen[0].status, 'running');
    assert.equal(seen[0].runs.length, 0);
    assert.equal(seen[1].status, 'running');
    assert.equal(seen[1].runs.length, 2, '1回目のあり・なしが済んでいる');
    assert.equal(result.status, 'completed');
    assert.equal(result.finishedAt === null, false);
  });

  test('REQ-041 課題が複数でも、課題ごとに回数分、あり・なしを実行し、課題ごとの点数も出る', async () => {
    const world = createWorld({
      tasks: [sampleTask({ id: 'T-01' }), sampleTask({ id: 'T-02' })],
      outputs: { with: GOOD.with, without: {} },
    });
    const result = await run(world, { runs: 1 });
    assert.deepEqual(ids(result), ['T-01/with/1', 'T-01/without/1', 'T-02/with/1', 'T-02/without/1']);
    assert.deepEqual(result.scores.byTask['T-02'], { with: 1, without: 0, difference: 1 });
  });

  test('REQ-041 課題に誤りがあるときは、何も始めずに誤りを伝える。plugin.json がないときも同じ', async () => {
    const bad = createWorld({ tasks: [{ id: 'T-01', prompt: 'p', criteria: [] }] });
    await assert.rejects(run(bad), /課題に誤りがあります/);
    assert.equal(bad.sdk.clients.length, 0);
    const noPlugin = makeTemp('c3-empty-');
    await assert.rejects(runEval({ pluginDir: noPlugin, runs: 1, sdk: bad.sdk, screen: bad.screen }), /plugin\.json が見つかりません/);
  });

  test('REQ-061 課題に bin があれば、あり・なしの両方で、作業フォルダに写した bin を PATH の先頭に足す', async () => {
    const task = sampleTask({ inputs: ['inputs/bin'], bin: 'inputs/bin' });
    const world = createWorld({ tasks: [task], files: { 'tests/eval/T-01/inputs/bin/kxtool': '#!/bin/sh\necho ok\n' }, outputs: GOOD });
    const result = await run(world);
    assert.deepEqual(statuses(result), ['completed', 'completed']);
    for (const [i, client] of world.sdk.clients.entries()) {
      const binDir = path.join(client.options.workingDirectory, 'inputs', 'bin');
      assert.equal(client.options.connection.env.PATH, `${binDir}${path.delimiter}/usr/bin`);
      assert.equal(result.runs[i].binDir, binDir);
      if (process.platform !== 'win32') assert.notEqual(fs.statSync(path.join(binDir, 'kxtool')).mode & 0o111, 0);
    }
    assert.equal('binDir' in (await run(createWorld({ outputs: GOOD }))).runs[0], false, 'bin のない課題には付けない');
  });

  test('REQ-061 agent_ran の基準は、その実行の記録で動いたエージェント（<プラグイン>:<名前> の形も）で採点する', async () => {
    const task = sampleTask({ criteria: [{ id: 'C-01', text: '作業役が動いた', grading: 'program', check: { type: 'agent_ran', agent: 'worker' } }] });
    const world = createWorld({
      tasks: [task],
      files: { 'com.github.copilot/agents/worker.agent.md': '---\ndescription: "x"\n---\n' },
      outputs: GOOD,
      behavior: {
        onSend: async (session) => {
          if (session.variant === 'without') return world.defaultOnSend(session);
          session.emit('subagent.started', { agentName: 'weekly-report:worker', agentType: 'weekly-report:worker', model: 'gpt-6-luna', executionMode: 'sync' }, 'ag-1');
          return world.defaultOnSend(session);
        },
      },
    });
    const result = await run(world);
    assert.deepEqual(result.runs.map((r) => [r.variant, r.criteria[0].pass]), [['with', true], ['without', false]]);
    assert.match(result.runs[0].criteria[0].reason, /weekly-report:worker」が動いた/);
  });

  test('REQ-061 ランタイムに渡す環境の PATH の先頭に、bin の場所を足せる', () => {
    assert.equal(runtimeEnv(ENV, { binDir: '/w/inputs/bin' }).PATH, `/w/inputs/bin${path.delimiter}/usr/bin`);
    assert.equal(runtimeEnv({ HOME: '/h' }, { binDir: '/w/inputs/bin' }).PATH, '/w/inputs/bin');
    assert.equal(runtimeEnv(ENV).PATH, '/usr/bin');
  });

  test('REQ-041 plugin.json から名前と版を読む。ランタイムに渡す環境は、文字の値だけにする', () => {
    const world = createWorld({ pluginName: 'abc' });
    assert.deepEqual(readPluginInfo(world.pluginDir), { name: 'abc', version: '1.2.3', path: world.pluginDir });
    assert.deepEqual(runtimeEnv({ A: '1', B: undefined, COPILOT_CLI_PATH: 'x', COPILOT_PLUGIN_DIR_ONLY: 'false' }), { A: '1', COPILOT_PLUGIN_DIR_ONLY: 'true' });
  });
});

describe('AI クレジット', () => {
  test('REQ-041 assistant.usage の totalNanoAiu を、サブエージェントの分も含めて足し上げ、10億で割って AI クレジットにする', async () => {
    const world = createWorld({
      outputs: GOOD,
      behavior: {
        onSend: async (session) => {
          if (session.variant === 'without') return world.defaultOnSend(session);
          session.emit('assistant.usage', usage(1_500_000_000, { model: 'gpt-6-luna' }));
          session.emit('assistant.usage', usage(250_000_000, { model: 'claude-haiku-5.5', initiator: 'sub-agent' }), 'sub-1');
          session.emit('assistant.usage', usage(250_000_000, { model: 'claude-haiku-5.5', initiator: 'sub-agent' }), 'sub-2');
          session.emit('assistant.message', { content: `画面：${SCREEN_URL}` });
          session.emit('session.idle', {});
        },
      },
    });
    const result = await run(world);
    const withRun = result.runs[0];
    assert.equal(withRun.credits, 2);
    assert.equal(withRun.creditsStatus, 'complete');
    assert.deepEqual(withRun.creditsByModel, { 'gpt-6-luna': 1.5, 'claude-haiku-5.5': 0.5 });
    assert.deepEqual(withRun.models, ['gpt-6-luna', 'claude-haiku-5.5']);
  });

  test('REQ-041 数えきれなかった呼び出し（aiCreditsStatus が partial、費用の項目がない）があれば、状態は partial になり、注意が出る', async () => {
    const world = createWorld({
      outputs: GOOD,
      behavior: {
        onSend: async (session) => {
          if (session.variant === 'without') {
            session.emit('assistant.usage', usage(1_000_000_000, { aiCreditsStatus: 'partial' }));
            session.emit('assistant.usage', { model: 'gpt-6-luna', inputTokens: 5 });
            session.emit('session.idle', {});
            return;
          }
          return world.defaultOnSend(session);
        },
      },
    });
    const result = await run(world);
    assert.equal(result.runs[0].creditsStatus, 'complete');
    assert.equal(result.runs[1].creditsStatus, 'partial');
    assert.equal(result.runs[1].credits, 1);
    assert.equal(result.creditDetail.status, 'partial');
    assert.ok(result.warnings.some((w) => /数えきれなかった/.test(w)));
  });

  test('REQ-041 画面に終わった理由が出た後に届く費用のイベントも、落ち着くまで待って数える', async () => {
    const world = createWorld({
      outputs: GOOD,
      screen: {
        operate: async () => {
          const session = world.sdk.sessions.find((s) => s.variant === 'with');
          // 統括が終わったことが、メインのエージェントに知らされ、もう1手番動く（その費用は後から届く）
          session.emit('system.notification', { kind: { type: 'agent_idle' } });
          setTimeout(() => {
            session.emit('assistant.usage', usage(2_000_000_000));
            session.emit('assistant.message', { content: 'できました' });
            session.emit('session.idle', {});
          }, 120);
          return finishedScreen();
        },
      },
    });
    const result = await run(world);
    assert.equal(result.runs[0].credits, 3, '先の 1 と、後から届いた 2');
  });

  test('REQ-041 送ったのに費用のイベントがひとつも届かなければ、unavailable。何も送らなかった実行は 0 で complete', async () => {
    const world = createWorld({
      outputs: GOOD,
      behavior: {
        onSend: async (session) => {
          if (session.variant === 'with') return world.defaultOnSend(session);
          session.emit('session.idle', {});
        },
      },
    });
    const result = await run(world);
    assert.equal(result.runs[1].creditsStatus, 'unavailable');
    const stopped = createWorld({ behavior: { plugins: () => [] } });
    const stoppedResult = await run(stopped);
    assert.equal(stoppedResult.runs[0].creditsStatus, 'complete');
    assert.equal(stoppedResult.runs[0].credits, 0);
  });
});

describe('許可の求めと質問', () => {
  test('REQ-041 実行中のエージェントの許可の求めに、決めた答えを返し、拒んだ求めを記録する', async () => {
    const answers = [];
    const world = createWorld({
      outputs: GOOD,
      behavior: {
        onSend: async (session) => {
          answers.push(await session.askPermission({ kind: 'extension-permission-access', extensionName: 'plugin:weekly-report:weekly-report', capabilities: ['register hooks'] }));
          answers.push(await session.askPermission({ kind: 'write', fileName: path.join(session.workDir, 'out', 'a.md') }));
          answers.push(await session.askPermission({ kind: 'write', fileName: '/etc/cron.d/evil' }));
          answers.push(await session.askPermission({ kind: 'shell', fullCommandText: 'ls' }));
          return world.defaultOnSend(session);
        },
      },
    });
    const result = await run(world);
    assert.deepEqual(answers.slice(0, 4).map((a) => a.kind), ['approve-once', 'approve-once', 'reject', 'approve-once']);
    const permissions = result.runs[0].permissions;
    assert.equal(permissions.approved, 3);
    assert.equal(permissions.rejected, 1);
    assert.deepEqual(permissions.rejections, [{ kind: 'write', summary: 'ファイルの書き込み：/etc/cron.d/evil', reason: 'outside_write' }]);
    assert.deepEqual(permissions.extensionRequests, [{ name: 'plugin:weekly-report:weekly-report', capabilities: ['register hooks'] }]);
    assert.ok(result.warnings.some((w) => /許可の求めを拒みました/.test(w)));
  });

  test('REQ-041 質問（ask_user）には、あり・なしで同じ決まった返事を返し、質問の数を記録する', async () => {
    const replies = [];
    const world = createWorld({
      outputs: GOOD,
      behavior: {
        onSend: async (session) => {
          replies.push(await session.config.onUserInputRequest({ question: '保存先はどこですか？' }, { sessionId: session.sessionId }));
          return world.defaultOnSend(session);
        },
      },
    });
    const result = await run(world);
    assert.equal(replies.length, 2);
    assert.deepEqual(replies[0], replies[1]);
    assert.equal(replies[0].answer, '課題に書いたこと以外は決まっていません。判断して進めてください');
    assert.deepEqual(result.runs.map((r) => r.questions), [1, 1]);
    assert.deepEqual(result.runs[0].questionTexts, ['保存先はどこですか？']);
  });

  test('REQ-051 ありで、実行が人の判断待ちになり、メインのエージェントが手番を終えたら、質問と同じ決まった返事をチャットで送る（質問ごとに1回）', async () => {
    const FIXED = '課題に書いたこと以外は決まっていません。判断して進めてください';
    const waitingSnap = (question, askedAt) => ({ t: 0, status: 'waiting_human', phase: null, iteration: 1, agents: ['orchestrator:waiting_human'], waits: [], humanWait: { question, askedAt, waiting: true } });
    const runningSnap = { t: 0, status: 'running', phase: 'do', iteration: 1, agents: ['orchestrator:running'], waits: [], humanWait: null };
    const until = async (check, what) => {
      const end = Date.now() + 3000;
      while (!check()) {
        if (Date.now() > end) throw new Error(`待ちきれなかった：${what}`);
        await sleep(5);
      }
    };
    const world = createWorld({
      outputs: GOOD,
      behavior: {
        onSend: async (session, options) => {
          if (options.prompt !== FIXED) return world.defaultOnSend(session);
          // メインのエージェントが、チャットの答えを <名前>_answer で渡して、手番を終える
          session.emit('tool.execution_start', { toolCallId: `a${session.sent.length}`, toolName: 'weekly-report_answer', arguments: { answer: options.prompt } });
          session.emit('session.idle', {});
        },
      },
      screen: {
        operate: async ({ onSnapshot }) => {
          const session = world.sdk.sessions.find((s) => s.variant === 'with');
          const askAndShow = (question, askedAt) => {
            onSnapshot(waitingSnap(question, askedAt));
            // 統括の手番の終わりがメインのエージェントに知らされ、メインのエージェントが質問をチャットに示して手番を終える
            session.emit('system.notification', { kind: { type: 'agent_idle', agentId: 'orch-1' } });
            session.emit('assistant.message', { content: `統括エージェントから質問です：${question}` });
            session.emit('session.idle', {});
          };
          onSnapshot(runningSnap);
          askAndShow('ビルドが失敗しました。どうしますか？', 1);
          await until(() => session.sent.length === 2, '1つ目の決まった返事');
          onSnapshot({ ...runningSnap, iteration: 2 });
          askAndShow('どちらの書式にしますか？', 2);
          await until(() => session.sent.length === 3, '2つ目の決まった返事');
          await sleep(100);
          writeWorkFile(world, 'out/週報.md', GOOD.with['out/週報.md']);
          return finishedScreen();
        },
      },
    });
    const result = await run(world);
    const session = world.sdk.sessions.find((s) => s.variant === 'with');
    assert.deepEqual(session.sent.map((s) => s.prompt), [sampleTask().prompt, FIXED, FIXED], '同じ質問には1回だけ、セッションの send で送る');
    const withRun = result.runs.find((r) => r.variant === 'with');
    assert.equal(withRun.status, 'completed');
    assert.equal(withRun.humanQuestions, 2);
    assert.deepEqual(withRun.humanQuestionTexts, ['ビルドが失敗しました。どうしますか？', 'どちらの書式にしますか？']);
    assert.equal(withRun.humanAnswerFailures, undefined);
    assert.equal(withRun.questions, 0, 'ask_user の質問とは別に数える');
    const logged = eventsOf(result, withRun).filter((e) => e.type === 'eval.human_answer');
    assert.deepEqual(logged.map((e) => e.data.via), ['notified', 'notified']);
    const withoutRun = result.runs.find((r) => r.variant === 'without');
    assert.equal(withoutRun.humanQuestions, 0);
    assert.deepEqual(withoutRun.humanQuestionTexts, []);
  });

  test('REQ-051 人の判断待ちに決まった返事を送れなかったときは、その質問と理由を残し、注意に出す', async () => {
    const world = createWorld({
      outputs: GOOD,
      screen: {
        operate: async ({ onSnapshot }) => {
          const session = world.sdk.sessions.find((s) => s.variant === 'with');
          session.send = async () => {
            throw new Error('送れません');
          };
          onSnapshot({ t: 0, status: 'waiting_human', phase: null, iteration: 1, agents: [], waits: [], humanWait: { question: 'どうしますか？', askedAt: 1, waiting: true } });
          session.emit('system.notification', { kind: { type: 'agent_idle', agentId: 'orch-1' } });
          session.emit('session.idle', {});
          await sleep(200);
          writeWorkFile(world, 'out/週報.md', GOOD.with['out/週報.md']);
          return finishedScreen();
        },
      },
    });
    const result = await run(world);
    const withRun = result.runs.find((r) => r.variant === 'with');
    assert.equal(withRun.humanQuestions, 0);
    assert.deepEqual(withRun.humanAnswerFailures, [{ question: 'どうしますか？', error: '送れません' }]);
    assert.ok(result.warnings.some((w) => /人の判断待ちに、決まった返事をチャットで送れなかった実行があります（T-01 あり 1）/.test(w)));
  });

  test('REQ-041 管理設定で人の承認が要る求めが来たら、自動では許可せず、答えずに（no-result）、試験を止めて理由を示す', async () => {
    const answers = [];
    const world = createWorld({
      tasks: [sampleTask({ id: 'T-01' }), sampleTask({ id: 'T-02' })],
      outputs: GOOD,
      screen: blockedScreen(),
      behavior: {
        onSend: async (session) => {
          answers.push(await session.askPermission({ kind: 'shell', fullCommandText: 'npm install left-pad', managedApprovalRequired: true }));
        },
      },
    });
    const result = await run(world, { runs: 2 });
    assert.deepEqual(answers, [{ kind: 'no-result' }]);
    assert.equal(result.status, 'stopped');
    assert.equal(result.stopped.reason, 'managed_approval');
    assert.match(result.stopped.message, /組織の管理設定で、人の承認が要る確認が出たので、試験を止めました（コマンドの実行：npm install left-pad）/);
    assert.equal(result.stopped.run, 'T-01 あり 1/2');
    assert.deepEqual(statuses(result), ['stopped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
    assert.equal(result.runs[0].score, null, '止まったときに動いていた実行は採点しない');
    assert.deepEqual(result.scores, { with: null, without: null, difference: null, byTask: { 'T-01': { with: null, without: null, difference: null }, 'T-02': { with: null, without: null, difference: null } } });
    assert.equal(world.sdk.clients.length, 1, '止まった後に、新しい実行を始めない');
    assert.equal(world.sdk.clients[0].stopped, true);
    const saved = JSON.parse(fs.readFileSync(path.join(result.resultsDir, 'result.json'), 'utf8'));
    assert.equal(saved.status, 'stopped');
  });
});

describe('試験全体を止める条件', () => {
  test('REQ-040 AI クレジットの上限の求めには、クレジットを足さずに止める（cancel）。以降の実行は始めない', async () => {
    const world = createWorld({
      outputs: GOOD,
      screen: blockedScreen(),
      behavior: {
        onSend: async (session) => {
          session.emit('assistant.usage', usage(3_000_000_000));
          session.emit('assistant.message', { content: `画面：${SCREEN_URL}` });
          await sleep(30);
          session.emit('session_limits_exhausted.requested', { requestId: 'req-9', maxAiCredits: 50, usedAiCredits: 50 });
        },
      },
    });
    const result = await run(world, { runs: 3 });
    assert.deepEqual(world.sdk.sessions[0].limitAnswers, [{ requestId: 'req-9', response: { action: 'cancel' } }]);
    assert.equal(result.status, 'stopped');
    assert.equal(result.stopped.reason, 'credit_limit');
    assert.match(result.stopped.message, /クレジットを足さずに/);
    assert.deepEqual(statuses(result), ['stopped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
    assert.equal(result.runs[0].credits, 3, 'それまでに使った分は数える');
    assert.equal(result.credits, 3);
    assert.equal(world.sdk.clients.length, 1);
    const events = eventsOf(result, result.runs[0]).map((e) => e.type);
    assert.ok(events.includes('session_limits_exhausted.requested'));
  });

  test('REQ-041 生成プラグインが読み込まれていなければ、メッセージを送る前に、読み込まれたものを示して止める', async () => {
    const world = createWorld({
      outputs: GOOD,
      behavior: { plugins: () => [{ name: 'other-plugin', enabled: true, source: 'marketplace' }] },
    });
    const result = await run(world, { runs: 2 });
    assert.equal(result.status, 'stopped');
    assert.equal(result.stopped.reason, 'plugin_not_loaded');
    assert.match(result.stopped.message, /生成プラグイン「weekly-report」が Copilot CLI に読み込まれませんでした（読み込まれたプラグイン：other-plugin）/);
    assert.equal(world.sdk.sessions[0].sent.length, 0, 'AI クレジットを使う前に止める');
    assert.deepEqual(statuses(result), ['stopped', 'skipped', 'skipped', 'skipped']);
    assert.equal(world.screen.calls.length, 0);
  });

  test('REQ-041 --plugin-dir で読み込んだプラグインは、名前でも、読み込み元の場所でも見つける', async () => {
    const byPath = createWorld({
      outputs: GOOD,
      behavior: { plugins: (session) => (session.variant === 'with' ? [{ name: 'renamed-by-runtime', enabled: true, installedFrom: session.client.pluginDir }] : []) },
    });
    const result = await run(byPath);
    assert.equal(result.status, 'completed');
  });

  test('REQ-041 エクステンションが読み込まれない、動き出さない、無効のときは、そう伝えて止める', async () => {
    const ours = (status) => [{ id: 'plugin:weekly-report:weekly-report', name: 'weekly-report', source: 'plugin', status }];
    const missing = await run(createWorld({ outputs: GOOD, behavior: { extensions: () => [{ id: 'user:other', source: 'user', status: 'running' }] } }), { timing: { ...FAST_TIMING, setupWaitMs: 120 } });
    assert.equal(missing.stopped.reason, 'extension_missing');
    assert.match(missing.stopped.message, /エクステンションが読み込まれませんでした.*user:other/);
    const failedWorld = createWorld({ outputs: GOOD, behavior: { extensions: () => ours('failed') } });
    const failed = await run(failedWorld);
    assert.equal(failed.stopped.reason, 'extension_failed');
    assert.match(failed.stopped.message, /動き出しませんでした（状態：plugin:weekly-report:weekly-report failed）/);
    assert.equal(failedWorld.sdk.sessions[0].sent.length, 0);
    const disabled = await run(createWorld({ outputs: GOOD, behavior: { extensions: () => ours('disabled') } }));
    assert.equal(disabled.stopped.reason, 'extension_failed');
  });

  test('REQ-041 エクステンションが starting から running になるのを待ってから、メッセージを送る', async () => {
    let calls = 0;
    const world = createWorld({
      outputs: GOOD,
      behavior: {
        extensions: (session) => {
          if (session.variant !== 'with') return [];
          calls += 1;
          return [{ id: 'plugin:weekly-report:weekly-report', source: 'plugin', status: calls < 3 ? 'starting' : 'running' }];
        },
      },
    });
    const result = await run(world, { timing: { ...FAST_TIMING, setupWaitMs: 2000 } });
    assert.equal(result.status, 'completed');
    assert.ok(calls >= 3);
  });

  test('REQ-048 ブラウザーを起動できなければ、AI クレジットを使う前に止める（セッションは作らない）', async () => {
    const world = createWorld({ outputs: GOOD, screen: { prepareError: 'ブラウザーを起動できませんでした（chrome：なし）。' } });
    const result = await run(world, { runs: 2 });
    assert.equal(result.status, 'stopped');
    assert.equal(result.stopped.reason, 'browser_failed');
    assert.match(result.stopped.message, /ブラウザーを起動できませんでした/);
    assert.equal(world.sdk.clients.length, 0);
    assert.deepEqual(statuses(result), ['skipped', 'skipped', 'skipped', 'skipped']);
  });
});

describe('終わりまで動かなかった実行', () => {
  test('REQ-041 ありで、チャットに URL が出ないまま手番が終わったときは、できていた分を採点し、次の実行に進む', async () => {
    const world = createWorld({
      outputs: GOOD,
      behavior: {
        onSend: async (session) => {
          if (session.variant === 'without') return world.defaultOnSend(session);
          session.emit('assistant.usage', usage(1_000_000_000));
          session.emit('assistant.message', { content: '作業を頼まれました。何をしましょうか。' });
          session.emit('session.idle', {});
        },
      },
    });
    const result = await run(world, { runs: 2 });
    assert.deepEqual(statuses(result), ['incomplete', 'completed', 'incomplete', 'completed']);
    assert.match(result.runs[0].error, /チャットに画面の URL が示されませんでした/);
    assert.equal(result.runs[0].score, 0, '成果物がないので、基準は不合格');
    assert.equal(world.screen.calls.length, 0);
    assert.equal(result.scores.with, 0);
    assert.ok(result.warnings.some((w) => /終わりまで動かなかった実行が 2 回/.test(w)));
  });

  test('REQ-041 画面を操作できなかったとき（欄がない、開始できないなど）は、その理由を残し、できていた分を採点する', async () => {
    const world = createWorld({
      outputs: GOOD,
      screen: { operate: async () => { throw new ScreenError('設定「week」の欄が画面にありません。'); } },
    });
    const result = await run(world);
    assert.equal(result.runs[0].status, 'incomplete');
    assert.equal(result.runs[0].error, '設定「week」の欄が画面にありません。');
    assert.equal(result.runs[0].score, 0);
  });

  test('REQ-041 画面に終わった理由が出ないまま時間切れになったときは、incomplete にして、できていた分を採点する', async () => {
    const world = createWorld({
      outputs: GOOD,
      screen: {
        operate: async () => {
          writeWorkFile(world, 'out/週報.md', '売上は52万円でした');
          return finishedScreen({ finished: false, timedOut: true, endReason: null, endReasonText: '', resultText: '', summary: null });
        },
      },
    });
    const result = await run(world);
    assert.equal(result.runs[0].status, 'incomplete');
    assert.match(result.runs[0].error, /時間切れ.*終わった理由が出ませんでした/);
    assert.equal(result.runs[0].score, 1, 'できていた分は採点する');
  });

  test('REQ-012 実行が「途中で終わった」で終わったときは、incomplete にして、その理由を残す', async () => {
    const world = createWorld({
      outputs: GOOD,
      screen: {
        operate: async () => {
          writeWorkFile(world, 'out/週報.md', '売上は52万円でした');
          return finishedScreen({ endReason: { kind: 'aborted', detail: 'credit_limit', unstoppable: false }, endReasonText: '終わった理由：途中で終わった（AI クレジットの上限）' });
        },
      },
    });
    const result = await run(world);
    const record = result.runs[0];
    assert.equal(record.status, 'incomplete');
    assert.equal(record.endReason.kind, 'aborted');
    assert.equal(record.endReason.text, '途中で終わった（AI クレジットの上限）');
    assert.match(record.error, /実行が途中で終わりました（途中で終わった（AI クレジットの上限））/);
  });

  test('REQ-041 画面に出た終わった理由を、実行の記録に残す（上限の回数に達した場合も採点する）', async () => {
    const world = createWorld({
      outputs: GOOD,
      screen: { operate: async () => finishedScreen({ endReason: { kind: 'max_iterations', detail: null, unstoppable: false }, endReasonText: '終わった理由：上限の回数に達した' }) },
    });
    const result = await run(world);
    assert.equal(result.runs[0].status, 'completed');
    assert.deepEqual(result.runs[0].endReason, { kind: 'max_iterations', detail: null, unstoppable: false, text: '上限の回数に達した' });
  });

  test('REQ-041 なしで、手番が終わらないまま時間切れになったときは、実行を中断し、incomplete にする', async () => {
    const world = createWorld({
      outputs: GOOD,
      behavior: {
        onSend: async (session) => {
          if (session.variant === 'with') return world.defaultOnSend(session);
          session.emit('assistant.usage', usage(200_000_000)); // 動き続けて、手番が終わらない
        },
      },
    });
    const result = await run(world, { timing: { ...FAST_TIMING, timeoutMs: 400, settleMs: 20 } });
    assert.deepEqual(statuses(result), ['completed', 'incomplete']);
    assert.match(result.runs[1].error, /時間切れ：手番が終わりませんでした/);
    assert.ok(world.sdk.sessions[1].abortCalls >= 1, '時間切れの実行は中断してから閉じる');
    assert.equal(result.runs[1].credits, 0.2);
  });
});

describe('試験の仕組みの側の失敗', () => {
  test('REQ-041 セッションがエラーになった実行は、error にして、採点せず、点数に入れない。ほかの実行は続ける', async () => {
    const world = createWorld({
      outputs: GOOD,
      behavior: {
        onSend: async (session) => {
          if (session.variant === 'without' && session.client.id === 2) {
            session.emit('session.error', { message: 'モデルの呼び出しが 5 回失敗しました' });
            session.emit('session.idle', {});
            return;
          }
          return world.defaultOnSend(session);
        },
      },
    });
    const result = await run(world, { runs: 2 });
    assert.deepEqual(statuses(result), ['completed', 'error', 'completed', 'completed']);
    assert.match(result.runs[1].error, /セッションがエラーになりました（モデルの呼び出しが 5 回失敗しました）/);
    assert.equal(result.runs[1].score, null);
    assert.deepEqual(result.runs[1].criteria, []);
    assert.equal(result.scores.without, 0.5, 'error の実行は平均に入らない');
    assert.ok(result.warnings.some((w) => /試験の仕組みの側の失敗で、採点できなかった実行が 1 回/.test(w)));
  });

  test('REQ-041 サブエージェントの中の session.error は、セッション全体の失敗に数えない（記録には残る）', async () => {
    const world = createWorld({
      outputs: GOOD,
      behavior: {
        onSend: async (session) => {
          session.emit('session.error', { message: '作業エージェントの中の失敗' }, 'sub-1');
          return world.defaultOnSend(session);
        },
      },
    });
    const result = await run(world);
    assert.deepEqual(statuses(result), ['completed', 'completed']);
    assert.ok(eventsOf(result, result.runs[0]).some((e) => e.type === 'session.error' && e.agentId === 'sub-1'));
  });

  test('REQ-041 ランタイムの起動やセッションの作成に失敗した実行は、error にして、閉じるものは閉じ、次の実行に進む', async () => {
    const world = createWorld({
      outputs: GOOD,
      behavior: {
        onStart: async (client) => {
          if (client.id === 1) throw new Error('ランタイムが起動しない');
        },
        onCreateSession: async (client) => {
          if (client.id === 2) throw new Error('ログインしていません');
        },
      },
    });
    const result = await run(world, { runs: 2 });
    assert.deepEqual(statuses(result), ['error', 'error', 'completed', 'completed']);
    assert.equal(result.runs[0].error, 'ランタイムが起動しない');
    assert.equal(result.runs[1].error, 'ログインしていません');
    assert.equal(world.sdk.clients.every((c) => c.stopped), true);
    assert.equal(result.status, 'completed');
  });

  test('REQ-041 起動が終わらないときは、上限の時間で失敗にする', async () => {
    const world = createWorld({ outputs: GOOD, behavior: { onStart: (client) => (client.id === 1 ? new Promise(() => {}) : undefined) } });
    const result = await run(world, { timing: { ...FAST_TIMING, sdkCallMs: 120 } });
    assert.equal(result.runs[0].status, 'error');
    assert.match(result.runs[0].error, /起動できませんでした（時間切れ）/);
    assert.equal(result.runs[1].status, 'completed');
  });

  test('REQ-041 画面の操作が ScreenError 以外で失敗したとき（ブラウザーが落ちたなど）は、error にして、点数に入れない', async () => {
    const world = createWorld({
      outputs: GOOD,
      screen: { operate: async () => { throw new Error('Target page, context or browser has been closed'); } },
    });
    const result = await run(world);
    assert.equal(result.runs[0].status, 'error');
    assert.match(result.runs[0].error, /browser has been closed/);
    assert.equal(result.scores.with, null);
  });

  test('REQ-041 閉じるのに時間がかかるセッションは、時間で切り上げ、クライアントは強制的に止める', async () => {
    const world = createWorld({ outputs: GOOD });
    const original = world.sdk.CopilotClient.prototype.stop;
    world.sdk.CopilotClient.prototype.stop = function stop() {
      return this.id === 1 ? new Promise(() => {}) : original.call(this);
    };
    const result = await run(world, { timing: { ...FAST_TIMING, closeMs: 100 } });
    assert.equal(world.sdk.clients[0].forceStopped, true);
    assert.deepEqual(statuses(result), ['completed', 'completed']);
  });
});

describe('採点は生成プラグインの外で行う', () => {
  test('REQ-041 画面に出た検証エージェントの合否は、採点に使わない（成果物がなければ、すべて合格と出ていても不合格）', async () => {
    const world = createWorld({
      outputs: {},
      screen: {
        operate: async () =>
          finishedScreen({
            iterations: [{ n: 1, verdicts: [{ criterionId: 'C-01', pass: true, note: '' }, { criterionId: 'C-02', pass: true, note: '' }] }],
            iterationsText: '試行 1 すべて合格',
          }),
      },
    });
    const result = await run(world);
    assert.equal(result.runs[0].status, 'completed', '実行は終わった');
    assert.deepEqual(result.runs[0].criteria.map((c) => c.pass), [false, false]);
    assert.equal(result.runs[0].score, 0);
    const screenRecord = JSON.parse(fs.readFileSync(path.join(result.resultsDir, result.runs[0].screen), 'utf8'));
    assert.equal(screenRecord.iterations[0].verdicts.length, 2, '合否は記録のために残る');
  });

  test('REQ-041 基準を満たさないように壊した成果物では、その基準だけが不合格になる（ありの実行で確かめる）', async () => {
    const world = createWorld({ outputs: { with: { 'out/週報.md': '売上は52万でした' }, without: {} } });
    const result = await run(world);
    assert.deepEqual(result.runs[0].criteria.map((c) => [c.id, c.pass]), [['C-01', true], ['C-02', false]]);
    assert.equal(result.scores.difference, 0.5);
  });

  test('REQ-041 model の基準は、判定の関数に成果物を渡して採点し、判定に使った AI クレジットを数える', async () => {
    const calls = [];
    const world = createWorld({
      tasks: [sampleTask({ criteria: [{ id: 'C-01', text: '読みやすい', grading: 'model' }, { id: 'C-02', text: '要点が3つ以内', grading: 'model', check: { files: ['out/*.md'] } }] })],
      outputs: GOOD,
    });
    const judge = async ({ criterion, task, artifacts }) => {
      calls.push({ criterion: criterion.id, task: task.id, files: artifacts.map((a) => a.path) });
      return { pass: criterion.id === 'C-01', reason: `${criterion.id} について`, credits: 0.25 };
    };
    const result = await run(world, { judge });
    assert.equal(calls.length, 4, '基準2件 × あり・なし');
    assert.deepEqual(calls[0], { criterion: 'C-01', task: 'T-01', files: ['out/週報.md'] });
    const [withRun] = result.runs;
    assert.deepEqual(withRun.criteria.map((c) => [c.id, c.grading, c.pass]), [['C-01', 'model', true], ['C-02', 'model', false]]);
    assert.equal(withRun.judgments, 2);
    assert.equal(withRun.judgeCredits, 0.5);
    assert.equal(result.creditDetail.grading, 1, '判定の分は、あり・なしの合計');
    assert.equal(result.credits, 1 + 0.5 + 1, 'ありの分 1、なしの分 0.5、判定の分 1');
    assert.equal(result.counts.judgments, 4);
  });

  test('REQ-041 判定の関数が失敗した基準は、採点できなかった印を付けて不合格にする。実行は error にしない', async () => {
    const world = createWorld({
      tasks: [sampleTask({ criteria: [{ id: 'C-01', text: '読みやすい', grading: 'model' }] })],
      outputs: GOOD,
    });
    const result = await run(world, { judge: async () => { throw new Error('判定のセッションが作れない'); } });
    assert.equal(result.runs[0].status, 'completed');
    assert.equal(result.runs[0].criteria[0].pass, false);
    assert.equal(result.runs[0].criteria[0].error, true);
    assert.match(result.runs[0].criteria[0].reason, /採点できなかった.*判定のセッションが作れない/);
  });
});

describe('混ざったものと、使われたもの', () => {
  test('REQ-041 生成プラグイン以外のエクステンションが読み込まれていたら、「ほかのエクステンションが混ざった」と結果に示す', async () => {
    const world = createWorld({
      outputs: GOOD,
      behavior: {
        extensions: (session) => [
          ...(session.variant === 'with' ? [{ id: 'plugin:weekly-report:weekly-report', name: 'weekly-report', source: 'plugin', status: 'running' }] : []),
          { id: 'user:my-helper', name: 'my-helper', source: 'user', status: 'running' },
          { id: 'plugin:another:another', name: 'another', source: 'plugin', status: 'running' },
        ],
      },
    });
    const result = await run(world);
    assert.deepEqual(result.runs[0].foreignExtensions, ['user:my-helper', 'plugin:another:another']);
    assert.deepEqual(result.runs[1].foreignExtensions, ['user:my-helper', 'plugin:another:another'], 'なしの実行では、エクステンションはすべて「ほかの」もの');
    assert.deepEqual(result.runs[0].extensions.map((e) => e.id), ['plugin:weekly-report:weekly-report', 'user:my-helper', 'plugin:another:another']);
    const warning = result.warnings.find((w) => w.startsWith('ほかのエクステンションが混ざった'));
    assert.match(warning, /user:my-helper、plugin:another:another/);
    assert.match(warning, /T-01 あり 1、T-01 なし 1/);
  });

  test('REQ-041 生成プラグイン以外のプラグインが読み込まれていたら、「ほかのプラグインが混ざった」と示す。組み込みのプラグインは数えない', async () => {
    const world = createWorld({
      outputs: GOOD,
      behavior: {
        plugins: (session) => [
          ...(session.variant === 'with' ? [{ name: 'weekly-report', enabled: true, installedFrom: session.client.pluginDir }] : []),
          { name: 'core-tools', enabled: true, source: 'builtin' },
          { name: 'my-other-plugin', enabled: true, source: 'marketplace' },
        ],
      },
    });
    const result = await run(world);
    assert.deepEqual(result.runs[0].foreignPlugins, ['my-other-plugin']);
    assert.deepEqual(result.runs[1].foreignPlugins, ['my-other-plugin']);
    assert.ok(result.warnings.some((w) => w.startsWith('ほかのプラグインが混ざった：my-other-plugin')));
  });

  test('REQ-041 混ざったものがなければ、その注意は出ない', async () => {
    const result = await run(createWorld({ outputs: GOOD }));
    assert.deepEqual(result.runs.map((r) => r.foreignExtensions), [[], []]);
    assert.deepEqual(result.warnings, []);
  });

  test('REQ-041 使われたスキル、サブエージェントとそのモデル、使ったモデルを、実行の記録に残す', async () => {
    const world = createWorld({
      outputs: GOOD,
      behavior: {
        onSend: async (session) => {
          if (session.variant === 'without') return world.defaultOnSend(session);
          session.emit('skill.invoked', { name: 'weekly-report:entry', pluginName: 'weekly-report' });
          session.emit('subagent.started', { agentName: 'weekly-report:orchestrator', agentType: 'weekly-report:orchestrator', model: 'claude-sonnet-5.5', executionMode: 'background' }, 'ag-1');
          session.emit('subagent.started', { agentName: 'weekly-report:worker', agentType: 'weekly-report:worker', model: 'gpt-6-luna', executionMode: 'background' }, 'ag-2');
          session.emit('subagent.configured', { model: 'claude-haiku-5.5', multiTurn: false }, 'ag-2');
          session.emit('subagent.completed', { agentName: 'weekly-report:worker', model: 'claude-haiku-5.5', cancelled: false }, 'ag-2');
          session.emit('subagent.failed', { agentName: 'weekly-report:orchestrator', error: 'だめだった' }, 'ag-1');
          session.emit('assistant.usage', usage(1_000_000_000, { model: 'claude-haiku-5.5' }), 'ag-2');
          session.emit('assistant.message', { content: SCREEN_URL });
          session.emit('session.idle', {});
        },
      },
    });
    const result = await run(world);
    const record = result.runs[0];
    assert.deepEqual(record.skills, [{ name: 'weekly-report:entry', pluginName: 'weekly-report' }]);
    assert.deepEqual(record.subagents, [
      { agentName: 'weekly-report:orchestrator', agentType: 'weekly-report:orchestrator', model: 'claude-sonnet-5.5', executionMode: 'background', status: 'failed' },
      { agentName: 'weekly-report:worker', agentType: 'weekly-report:worker', model: 'claude-haiku-5.5', executionMode: 'background', status: 'completed' },
    ]);
    assert.deepEqual(record.models, ['claude-haiku-5.5']);
    assert.equal(record.copilotVersion, '1.0.102');
  });

  test('REQ-041 サブエージェントのメッセージに URL があっても、チャットに出た URL とは数えない', async () => {
    const world = createWorld({
      outputs: GOOD,
      behavior: {
        onSend: async (session) => {
          if (session.variant === 'without') return world.defaultOnSend(session);
          session.emit('assistant.message', { content: `内部の話：${SCREEN_URL}` }, 'ag-1');
          session.emit('session.idle', {});
        },
      },
    });
    const result = await run(world);
    assert.equal(result.runs[0].status, 'incomplete');
    assert.match(result.runs[0].error, /URL が示されませんでした/);
  });
});

describe('エクステンションの起動（Copilot SDK では、起動のしかたを EVAL の仕組みが決める）', () => {
  const SDK_PATH = '/tools/node_modules/@github/copilot-sdk/dist';
  const request = (id, source = 'plugin') => ({ id, name: id.split(':').at(-1), modulePath: `/x/${id}/extension.mjs`, source });

  test('REQ-041 ありの実行だけ、SDK のフォルダ（extensionSdkPath）と、エクステンションの起動のしかた（extensionLaunchProvider）を渡す', async () => {
    const world = createWorld({ outputs: GOOD });
    await run(world, { extensionSdkPath: SDK_PATH });
    const [withClient, withoutClient] = world.sdk.clients;
    const [withSession, withoutSession] = world.sdk.sessions;
    assert.equal(withSession.config.extensionSdkPath, SDK_PATH);
    assert.equal(typeof withClient.options.extensionLaunchProvider.resolve, 'function');
    assert.equal('extensionSdkPath' in withoutSession.config, false);
    assert.equal('extensionLaunchProvider' in withoutClient.options, false);
  });

  test('REQ-041 SDK のフォルダを渡されなければ、どちらも渡さない', async () => {
    const world = createWorld({ outputs: GOOD });
    await run(world);
    assert.equal('extensionLaunchProvider' in world.sdk.clients[0].options, false);
    assert.equal('extensionSdkPath' in world.sdk.sessions[0].config, false);
  });

  test('REQ-041 起動を引き受けるのは、生成プラグインのエクステンションだけ。ユーザーの・プロジェクトの・ほかのプラグインのものは断る', async () => {
    const world = createWorld({ outputs: GOOD });
    await run(world, { extensionSdkPath: SDK_PATH });
    const provider = world.sdk.clients[0].options.extensionLaunchProvider;
    const ours = await provider.resolve(request('plugin:weekly-report:weekly-report'));
    assert.equal(ours.launch.executable, process.execPath);
    assert.match(ours.launch.args[0], /extension-bootstrap\.mjs$/);
    assert.equal(ours.launch.env.EXTENSION_PATH, '/x/plugin:weekly-report:weekly-report/extension.mjs');
    for (const id of ['user:my-helper', 'project:team-tool', 'plugin:another:another']) {
      assert.deepEqual(await provider.resolve(request(id, id.split(':')[0])), {}, id);
    }
    assert.deepEqual(provider.launched, ['plugin:weekly-report:weekly-report']);
    assert.deepEqual(provider.skipped, ['user:my-helper', 'project:team-tool', 'plugin:another:another']);
  });

  test('REQ-041 起動を断ったエクステンションは「混ざった」に数えず、記録（refusedExtensions）に残す。動いているほかのものは混ざったと示す', async () => {
    const world = createWorld({
      outputs: GOOD,
      behavior: {
        extensions: (session) => [
          ...(session.variant === 'with' ? [{ id: 'plugin:weekly-report:weekly-report', name: 'weekly-report:weekly-report', source: 'plugin', status: 'running' }] : []),
          { id: 'user:my-helper', name: 'my-helper', source: 'user', status: 'failed' },
          { id: 'project:team-tool', name: 'team-tool', source: 'project', status: session.variant === 'with' ? 'running' : 'disabled' },
        ],
      },
    });
    const result = await run(world, { extensionSdkPath: SDK_PATH });
    const [withRun, withoutRun] = result.runs;
    assert.deepEqual(withRun.refusedExtensions, ['user:my-helper']);
    assert.deepEqual(withRun.foreignExtensions, ['project:team-tool']);
    assert.deepEqual(withoutRun.foreignExtensions, []);
    assert.deepEqual(withoutRun.refusedExtensions, ['user:my-helper', 'project:team-tool']);
    assert.equal(result.warnings.filter((w) => w.startsWith('ほかのエクステンションが混ざった')).length, 1);
    assert.match(result.warnings.find((w) => w.startsWith('ほかのエクステンションが混ざった')), /project:team-tool/);
    assert.doesNotMatch(result.warnings.join(''), /user:my-helper/);
  });

  test('REQ-041 実行の記録に、起動したエクステンションと、起動を断ったエクステンションを残す', async () => {
    const world = createWorld({
      outputs: GOOD,
      behavior: {
        onCreateSession: async (client) => {
          const provider = client.options.extensionLaunchProvider;
          if (!provider) return;
          await provider.resolve(request('plugin:weekly-report:weekly-report'));
          await provider.resolve(request('user:my-helper', 'user'));
        },
      },
    });
    const result = await run(world, { extensionSdkPath: SDK_PATH });
    assert.deepEqual(result.runs[0].extensionLaunch, { launched: ['plugin:weekly-report:weekly-report'], refused: ['user:my-helper'] });
    assert.equal('extensionLaunch' in result.runs[1], false);
  });
});

describe('EVAL でできた生成プラグインの実行の記録の片付け（ふだんの作業の記録と同じ場所に入るため）', () => {
  const NAME = 'weekly-report';
  const USER_RECORDS = ['20261001-090000-aaaaaa', '20261002-090000-bbbbbb'];

  /** 生成プラグインのエクステンションが、実行の記録を作る代わり（store.mjs と同じ置き方：<番号>/log.jsonl の1行目が begin） */
  function writeRecord(root, id, begin, finished = true) {
    const dir = path.join(root, id);
    fs.mkdirSync(path.join(dir, 'issues'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'log.jsonl'), `${JSON.stringify({ t: 'begin', runId: id, ...begin })}\n`);
    fs.writeFileSync(path.join(dir, 'alive'), '1');
    if (finished) fs.writeFileSync(path.join(dir, 'result.json'), '{"done":true}');
    return dir;
  }
  /** フォルダの中身（相対の場所と中身）を並べる。前後の比べ合いに使う */
  const treeOf = (dir) =>
    fs
      .readdirSync(dir, { recursive: true })
      .sort()
      .map((rel) => {
        const abs = path.join(dir, rel);
        return fs.statSync(abs).isDirectory() ? `${rel}/` : `${rel}=${fs.readFileSync(abs, 'utf8')}`;
      });

  /**
   * ふだんの作業の記録が2つある COPILOT_HOME で、ありの実行のたびに、生成プラグインが記録を1つ作る世界。
   * onRecord は、記録を作った後（実行の間）に呼ぶ。behavior は、偽物の SDK の動きの上書き
   */
  function setup({ onRecord, behavior = {}, ...options } = {}) {
    const home = makeTemp('c3-copilot-home-');
    const root = path.join(home, 'plugin-data', NAME, 'runs');
    USER_RECORDS.forEach((id, i) => writeRecord(root, id, { cwd: '/home/user/project', sessionId: `user-session-${i}` }));
    const created = [];
    const ctx = { home, root, created, env: { ...ENV, COPILOT_HOME: home }, userTree: treeOf(root) };
    ctx.world = createWorld({
      outputs: GOOD,
      ...options,
      behavior: {
        onSend: async (session) => {
          if (session.variant === 'with') {
            const id = `20261024-12000${created.length + 1}-c0ffe${created.length + 1}`;
            created.push(id);
            writeRecord(root, id, { cwd: session.workDir, sessionId: session.sessionId }, false);
            await onRecord?.({ session, root, id });
          }
          if (behavior.onSend) await behavior.onSend(session, ctx);
          else await ctx.world.defaultOnSend(session);
        },
        ...Object.fromEntries(Object.entries(behavior).filter(([key]) => key !== 'onSend')),
      },
    });
    return ctx;
  }

  test('REQ-041 ありの実行が終わるたびに、その実行でできた記録だけを消す。ふだんの作業の記録・生成プラグインのフォルダ・EVAL の結果は残る', async () => {
    const { world, root, created, env, userTree } = setup();
    const pluginTree = treeOf(world.pluginDir);
    const result = await run(world, { runs: 2, env });

    assert.equal(result.status, 'completed');
    assert.equal(created.length, 2);
    assert.deepEqual(treeOf(root), userTree, 'ふだんの作業の記録は、件数も中身も前と同じ。EVAL の記録は残っていない');
    const [with1, without1, with2] = result.runs;
    assert.deepEqual(with1.pluginRecords, { root, removed: [created[0]], failed: [], unidentified: [], skipped: null });
    assert.deepEqual(with2.pluginRecords.removed, [created[1]]);
    assert.equal('pluginRecords' in without1, false, 'なしの実行は、生成プラグインを読み込まないので、記録を扱わない');

    // 生成プラグインのフォルダは消えない。その tests/results/ の EVAL の結果も残る
    assert.equal(fs.existsSync(result.resultFile), true);
    assert.equal(fs.existsSync(path.join(result.resultsDir, with1.events)), true);
    const notResults = (entry) => !entry.startsWith('tests/results') && !entry.startsWith('tests');
    assert.deepEqual(treeOf(world.pluginDir).filter(notResults), pluginTree.filter(notResults));
    assert.equal(fs.existsSync(path.join(world.pluginDir, 'plugin.json')), true);
    assert.equal(fs.existsSync(path.join(world.pluginDir, 'tests', 'eval', 'T-01', 'eval.json')), true);
    assert.equal(result.warnings.some((w) => /実行の記録/.test(w)), false, '注意は出ない');
  });

  test('REQ-041 消すのは、セッションを閉じた後。閉じ始めるまでは、記録は残っている（エクステンションが書いている間は消さない）', async () => {
    const seen = [];
    const ctx = setup({
      behavior: { onAbort: (session) => session.variant === 'with' && seen.push(fs.existsSync(path.join(ctx.root, ctx.created[0]))) },
    });
    const result = await run(ctx.world, { env: ctx.env });
    assert.deepEqual(seen, [true], 'ありの閉じ始めの時点では、まだ残っている');
    assert.equal(fs.existsSync(path.join(ctx.root, ctx.created[0])), false, '閉じた後に消えた');
    assert.deepEqual(result.runs[0].pluginRecords.removed, ctx.created);
  });

  test('REQ-041 実行が失敗しても（画面の操作が落ちた）、できていた記録は消す', async () => {
    const ctx = setup({ screen: { operate: async () => { throw new Error('ブラウザーが落ちました'); } } });
    const result = await run(ctx.world, { env: ctx.env });
    assert.equal(result.runs[0].status, 'error');
    assert.deepEqual(result.runs[0].pluginRecords.removed, ctx.created);
    assert.deepEqual(treeOf(ctx.root), ctx.userTree);
  });

  test('REQ-041 セッションがエラーになった実行でも、できていた記録は消す。ふだんの作業の記録は残る', async () => {
    const ctx = setup({
      behavior: {
        onSend: async (session) => {
          if (session.variant === 'with') session.emit('session.error', { message: 'モデルの呼び出しに失敗しました' });
          else await ctx.world.defaultOnSend(session);
        },
      },
    });
    const result = await run(ctx.world, { env: ctx.env });
    assert.equal(result.runs[0].status, 'error');
    assert.deepEqual(result.runs[0].pluginRecords.removed, ctx.created);
    assert.deepEqual(treeOf(ctx.root), ctx.userTree);
  });

  test('REQ-041 試験の間にできても、この実行のものと確かめられない記録（ふだんの作業が同時に動いた）は、消さずに注意を出す', async () => {
    const other = '20261024-120009-a1b2c3';
    const ctx = setup({ onRecord: ({ root }) => writeRecord(root, other, { cwd: '/home/user/another-project', sessionId: 'someone-elses-session' }) });
    const result = await run(ctx.world, { env: ctx.env });
    assert.equal(fs.existsSync(path.join(ctx.root, other)), true, '残る');
    assert.deepEqual(result.runs[0].pluginRecords.removed, ctx.created);
    assert.deepEqual(result.runs[0].pluginRecords.unidentified, [other]);
    assert.match(result.warnings.find((w) => /確かめられなかったので、消していません/.test(w)), /1 件増えました.*消していません（実行：T-01 あり 1）/);
  });

  test('REQ-041 消せなかった記録は、場所を示して注意を出す。試験の結果は止めない', async () => {
    const ctx = setup();
    const realRm = fs.rmSync;
    const stub = mock.method(fs, 'rmSync', (target, ...rest) => {
      if (String(target).startsWith(ctx.root) && String(target).includes('20261024-')) throw new Error('EBUSY: 使用中です');
      return realRm(target, ...rest);
    });
    let result;
    try {
      result = await run(ctx.world, { env: ctx.env });
    } finally {
      stub.mock.restore();
    }
    assert.equal(result.status, 'completed');
    assert.equal(result.runs[0].score, 1, '採点は通常どおり');
    assert.deepEqual(result.runs[0].pluginRecords.failed, [{ id: ctx.created[0], message: 'EBUSY: 使用中です' }]);
    const warning = result.warnings.find((w) => /消せませんでした/.test(w));
    assert.ok(warning.includes(path.join(ctx.root, ctx.created[0])), warning);
    assert.match(warning, /手で消してかまいません/);
    assert.deepEqual(treeOf(ctx.root).filter((entry) => !entry.startsWith(ctx.created[0])), ctx.userTree, 'ふだんの作業の記録は残っている');
  });

  test('REQ-041 記録の置き場所を決められないとき（COPILOT_HOME が絶対パスでない）は、何も消さず、そのことを注意に出す', async () => {
    const ctx = setup();
    const result = await run(ctx.world, { env: { ...ENV, COPILOT_HOME: 'relative/home' } });
    assert.equal(result.runs[0].pluginRecords.root, null);
    assert.deepEqual(result.runs[0].pluginRecords.removed, []);
    assert.match(result.warnings.find((w) => /記録の置き場所を決められませんでした/.test(w)), /消していません.*COPILOT_HOME/);
    assert.deepEqual(treeOf(ctx.root).filter((entry) => !ctx.created.some((id) => entry.startsWith(id))), ctx.userTree);
  });
});
