// 開発者が答える外側の EVAL（testing.md 6.7）の流れの試験。実際のモデルは使わない（偽物の Agent SDK）。
// 開発者の代わりに、中継のフォルダの問いに答える小さな繰り返し（偽の開発者）を、試験の中で動かす。
// 動かし方（リポジトリの根で）：node --test "tests/dev-eval/runner/outer-human.test.mjs"

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { FIXED_ANSWER } from '../../../skills/test-plugin/scripts/permissions.mjs';
import { createFakeSdk } from './outer-fake-sdk.mjs';
import { answerQuestion, checkWait, createHumanRelay, pendingQuestion, readStatus, TERMINAL_STATES } from './human-relay.mjs';
import { decideSettings } from './inner-settings.mjs';
import { buildHumanLoaded, main, readRequestFile } from './outer.mjs';
import { fixedAnswerRole, runInnerForGenerated } from './outer-inner.mjs';
import { HUMAN_ENV, runOuterOnce } from './outer-run.mjs';
import { loadPersona } from '../personas/validate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..', '..');
const PERSONAS = path.join(here, '..', 'personas');
/** 生成プラグインに入る課題の見本（tests/eval/<課題>/eval.json の形。grade.mjs の validateTask に通る） */
const PLUGIN_TASK = {
  id: 'T-01',
  prompt: '先週の記録をもとに、今週の週報を書いてください。',
  inputs: ['inputs/memo.txt'],
  settings: { maxIterations: 3, task: { week: '2026-W42' } },
  criteria: [{ id: 'C-01', text: '見出し「今週やったこと」がある', grading: 'program', check: { type: 'contains', file: 'out/*.md', text: '今週やったこと' } }],
};
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), `outer-human-${prefix}-`));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const T = (name) => `mcp__plugin-creator__${name}`;
const REQUEST = '週報を作るプラグインを作ってください。\n毎週金曜に、部長に出します。';

/** 変換の代わり（outer-run.test.mjs と同じ）。置き換えた版の入れ物と変換レポートだけを作る */
function fakeConvert(src, out) {
  fs.mkdirSync(path.join(out, '.eval'), { recursive: true });
  const report = {
    plugin: path.basename(src),
    model_map: { 'claude-haiku-5.5': 'claude-haiku-5-5', 'claude-opus-5.5': 'claude-opus-5-5' },
    extension_tools: ['open', 'state', 'progress', 'record', 'confirm', 'results', 'doc_text', 'issue'].map((tool) => ({ from: `plugin-creator_${tool}`, to: T(tool), server: 'plugin-creator', tool, where: 'skills/make-plugin/SKILL.md' })),
    warnings: [],
  };
  fs.writeFileSync(path.join(out, '.eval', 'conversion-report.json'), JSON.stringify(report));
  fs.mkdirSync(path.join(out, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(out, 'agents', 'worker.md'), '---\nname: worker\ndescription: 作業\nmodel: claude-haiku-5-5\n---\n本文\n');
  return { root: out, report, summary: { ok: true } };
}

const okStages = async () => ({ skipped: false, ok: true, stage1: { ok: true }, stage2: { ok: true } });

/**
 * 偽の開発者：中継のフォルダに答えのない問いが出たら、answerFor の答えを置く。試験の仕組みが終わったら止まる。
 * onEnd は、終わりの状態を見たその時に呼ぶ（統括が、その時に読める結果を確かめるため）
 */
function startDeveloper(relayDir, answerFor, { onEnd = () => {} } = {}) {
  const seen = [];
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      const q = pendingQuestion(relayDir);
      const status = readStatus(relayDir);
      if (status && TERMINAL_STATES.includes(status.state)) { onEnd(status); break; }
      if (q && !seen.some((s) => s.id === q.id)) {
        seen.push(q);
        const answer = answerFor(q);
        if (answer !== null) answerQuestion(relayDir, q.id, answer);
      }
      await sleep(5);
    }
  })();
  return { seen, stop: async () => { stop = true; await loop; } };
}

/** 生成プラグインの見本：直下の plugin.json と、課題（T-01）を作業フォルダに作る */
function writeGeneratedPlugin(work, { withTasks = true } = {}) {
  const dir = path.join(work, 'weekly-report');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name: 'weekly-report', version: '0.1.0' }));
  if (withTasks) {
    const taskDir = path.join(dir, 'tests', 'eval', 'T-01');
    fs.mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'inputs', 'memo.txt'), '先週のメモ');
    fs.writeFileSync(path.join(taskDir, 'eval.json'), JSON.stringify(PLUGIN_TASK));
  }
  return dir;
}

/** クリエイター役の台本：質問のツールで 2 つの欄を 1 回で聞き、文章でも聞いて、次の手番で生成プラグインを作る */
function creatorScript({ withTasks = true } = {}) {
  return async (ctx) => {
    if (ctx.turn === 1) {
      await ctx.say('お話を聞かせてください。');
      await ctx.ask([
        { question: '成果物はどんなファイルですか？', header: '成果物', multiSelect: true, options: [{ label: 'Markdown', description: 'md のファイル' }, { label: 'Word', description: 'docx のファイル' }] },
        { question: '宛先はだれですか？', header: '宛先', multiSelect: false, options: [] },
      ]);
      await ctx.say('ありがとうございます。');
      return 'ほかに伝えておきたいことはありますか？';
    }
    writeGeneratedPlugin(ctx.options.cwd, { withTasks });
    return '作りました。';
  };
}

const developerAnswers = (q) => ({
  '成果物はどんなファイルですか？': 'Markdown, Word',
  '宛先はだれですか？': '  部長です。\n（課長にも写しを送ります）',
  'ほかに伝えておきたいことはありますか？': '特にありません',
}[q.question] ?? '分かりません');

test('REQ-015 開発者が答える：最初の依頼は開発者の文。問いは中継のフォルダを通り、答えは変えずにクリエイターへ返る。記録と採点は開発者の形', async (t) => {
  const root = tmp('flow');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relayDir = path.join(root, 'relay');
  const requestFile = path.join(root, 'request.txt');
  fs.writeFileSync(requestFile, `${REQUEST}\n`);
  const memo = path.join(root, 'memo.txt');
  fs.writeFileSync(memo, '先週のメモ');
  const loaded = buildHumanLoaded({ requestFile, files: [{ src: memo, place: '資料/メモ.txt' }] });

  let userRoleCalls = 0;
  const sdk = createFakeSdk({ userRole: () => { userRoleCalls += 1; return 'ユーザー役は呼ばれないはず'; }, agent: creatorScript() });
  const created = [];
  let innerArgs = null;
  let innerEvalArgs = null;
  let innerAnswer = null;
  const developer = startDeveloper(relayDir, developerAnswers);
  const record = await runOuterOnce({
    loaded, runRoot: path.join(root, 'runs'), sandbox: false, convert: fakeConvert, runStages: okStages, query: sdk.query, model: 'claude-opus-5-5', maxExchanges: 5,
    answerer: 'human',
    innerRuns: 2,
    createAnswerer: (args) => { created.push(args); return createHumanRelay({ relayDir, signal: args.signal, pollMs: 5, runDir: args.runDir, workDir: args.workDir }); },
    inner: async (args) => {
      innerArgs = args;
      return runInnerForGenerated({
        ...args,
        chromium: {},
        innerEval: async (o) => {
          innerEvalArgs = o;
          const role = o.userRoleFor(o.tasks[0], 'without', 1);
          innerAnswer = { text: await role({ question: '何を書きますか？', choices: [] }), cost: role.cost() };
          return { kind: 'dev-inner-eval', status: 'completed', scores: { with: 0.5, without: 0, difference: 0.5 } };
        },
      });
    },
  });
  await developer.stop();

  // 最初の依頼は、開発者が書いた文（終わりの改行を除く）。ユーザー役の AI は呼ばない
  const agentCalls = sdk.calls.filter((c) => c.kind === 'agent');
  assert.equal(agentCalls[0].prompt, REQUEST);
  assert.equal(agentCalls[1].prompt, '特にありません', '文章の問いへの開発者の答えが、続きの会話に渡る');
  assert.equal(userRoleCalls, 0);
  assert.equal(record.conversation[0].text, REQUEST);
  // 答えを待つ間に切れないように、待ちの期限なしとキャッシュの 1 時間をクリエイターに渡す
  for (const call of agentCalls) {
    assert.equal(call.options.env.ENABLE_PROMPT_CACHING_1H, '1');
    assert.equal(call.options.env.CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS, '0');
    assert.equal(call.options.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR, '1');
  }
  assert.deepEqual(HUMAN_ENV, { ENABLE_PROMPT_CACHING_1H: '1', CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS: '0' });

  // 中継：問いの前の文、見出し、選択肢、複数選べるか、欄の番号と数。質問のツールの問いと文章の問いで、番号が続く
  assert.deepEqual(developer.seen.map((q) => [q.id, q.index, q.via, q.question]), [
    ['0001', 0, 'AskUserQuestion', '成果物はどんなファイルですか？'],
    ['0002', 1, 'AskUserQuestion', '宛先はだれですか？'],
    ['0003', 2, 'text', 'ほかに伝えておきたいことはありますか？'],
  ]);
  const [q1, q2, q3] = developer.seen;
  assert.deepEqual(q1.notes, ['お話を聞かせてください。']);
  assert.equal(q1.header, '成果物');
  assert.equal(q1.multiSelect, true);
  assert.deepEqual(q1.options, [{ label: 'Markdown', description: 'md のファイル' }, { label: 'Word', description: 'docx のファイル' }]);
  assert.deepEqual([q1.group, q1.groupSize, q2.group, q2.groupSize], [1, 2, 1, 2]);
  assert.deepEqual(q2.notes, [], '前の文は、1 回の呼び出しの最初の欄にだけ付く');
  assert.deepEqual(q3.notes, ['ありがとうございます。']);
  assert.deepEqual([q3.header, q3.options, q3.group, q3.groupSize], ['', [], null, null]);
  // 答えは変えずに返る（複数選んだ名前のつなぎも、前後の空白と改行も）
  assert.deepEqual(record.userRole.answers.map((a) => a.answer), ['Markdown, Word', '  部長です。\n（課長にも写しを送ります）', '特にありません']);
  assert.equal(record.items.find((i) => i.kind === 'user.answer' && i.index === 1).answer, '  部長です。\n（課長にも写しを送ります）');
  // 開発者のファイルは、作業フォルダに置かれる
  assert.equal(fs.readFileSync(path.join(record.dirs.work, '資料', 'メモ.txt'), 'utf8'), '先週のメモ');
  assert.equal(created[0].workDir, record.dirs.work);
  assert.equal(created[0].runDir, record.dirs.run);

  // 記録：答えたのは開発者。ユーザー役の費用はない
  assert.equal(record.answerer, 'human');
  assert.equal(record.models.userRole, 'human');
  assert.equal(record.costUsd.userRole, 0);
  assert.equal(record.persona.id, 'human');
  assert.equal(record.relayDir, relayDir);
  assert.equal(record.stopped.reason, 'generated_without_approval');
  // 採点：ナレッジの観点と課題の入力のファイルの観点はない。ユーザー役の誤りは見ない。会話例の候補にしない
  const ids = record.grading.grades.map((g) => g.id);
  assert.ok(ids.every((id) => !/^(embedded|not-embedded|task):/.test(id)), ids.join(','));
  assert.ok(!ids.includes('input-files-in-repo'));
  assert.ok(!ids.includes('inner-deliverable'), '内側の EVAL の結果は点数に入れない');
  assert.ok(ids.includes('all-items-heard') && ids.includes('no-generation-before-approval') && ids.includes('main-model'));
  assert.deepEqual(record.grading.trace, []);
  assert.deepEqual(record.grading.faults, []);
  assert.equal(record.grading.exampleCandidate, false);
  // 内側の EVAL：生成プラグインの課題で、決まった返事で動かし、結果は点数と別に残す
  assert.equal(innerArgs.answerer, 'human');
  assert.equal(innerArgs.runs, 2);
  assert.equal(innerEvalArgs.runs, 2);
  assert.deepEqual(innerEvalArgs.tasks.map((x) => [x.id, x.personaId]), [['T-01', null]]);
  assert.ok(innerEvalArgs.tasks[0].dir.startsWith(path.join(record.dirs.work, 'weekly-report')));
  assert.deepEqual(innerEvalArgs.tasks[0].json.settings.task, { week: '2026-W42' });
  assert.deepEqual(innerAnswer, { text: FIXED_ANSWER, cost: 0 });
  assert.deepEqual(record.inner, { withScore: 0.5, withoutScore: 0, difference: 0.5, status: 'completed' });
  assert.deepEqual(record.grading.innerSeparate, record.inner);

  // 終わりの状態：会話が最後まで進んだので finished。理由、クリエイターの最後の発言、点数、記録のファイル
  const status = readStatus(relayDir);
  assert.equal(status.state, 'finished');
  assert.equal(status.pending, null);
  assert.equal(status.runDir, record.dirs.run);
  assert.equal(status.workDir, record.dirs.work);
  assert.equal(status.result.reason, 'generated_without_approval');
  assert.equal(status.result.finishedReason, 'generated_without_approval');
  assert.equal(status.result.lastText, '作りました。');
  assert.equal(status.result.score, record.grading.score);
  assert.equal(status.result.recordFile, record.recordFile);
  assert.equal(status.result.inner.withScore, 0.5);
});

test('REQ-015 ユーザー役の AI で答える形は、これまでどおり：環境変数を足さず、答えの記録に欄の番号を足さず、内側の EVAL の引数も変えない', async (t) => {
  const root = tmp('persona');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const loaded = await loadPersona(path.join(PERSONAS, 'weekly-report'), { allStyles: true });
  const sdk = createFakeSdk({ userRole: () => '成果物は weekly_report.md です', agent: creatorScript() });
  let innerArgs = null;
  const record = await runOuterOnce({
    loaded, runRoot: path.join(root, 'runs'), sandbox: false, convert: fakeConvert, runStages: okStages, query: sdk.query, model: 'claude-opus-5-5', maxExchanges: 5,
    inner: async (args) => { innerArgs = args; return { status: 'completed', scores: { with: 1, without: 0, difference: 1 } }; },
  });
  const options = sdk.calls.find((c) => c.kind === 'agent').options;
  assert.equal(options.env.ENABLE_PROMPT_CACHING_1H, undefined);
  assert.equal(options.env.CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS, undefined);
  assert.equal(record.answerer, 'user-role');
  assert.equal(record.models.userRole, 'claude-sonnet-5-5');
  assert.ok(record.costUsd.userRole > 0);
  assert.equal(record.relayDir, undefined);
  assert.deepEqual(Object.keys(record.userRole.answers[0]).sort(), ['answer', 'choices', 'cost', 'header', 'index', 'multiSelect', 'notes', 'question', 'rawAnswer', 'signal', 'via']);
  assert.equal('answerer' in innerArgs, false);
  assert.equal('runs' in innerArgs, false);
  assert.ok(record.grading.grades.some((g) => g.id === 'inner-deliverable'), '内側の EVAL の結果は点数に入る');
  assert.equal(record.grading.innerSeparate, undefined);
  assert.ok(record.grading.trace.length > 0);
});

test('REQ-015 開発者が答える：中断されたら、答えを待つのをやめて interrupted で終わり、採点と記録の後に中継の状態を stopped にする', async (t) => {
  const root = tmp('abort');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relayDir = path.join(root, 'relay');
  const requestFile = path.join(root, 'request.txt');
  fs.writeFileSync(requestFile, REQUEST);
  const loaded = buildHumanLoaded({ requestFile });
  const abort = new AbortController();
  const sdk = createFakeSdk({ userRole: () => 'x', agent: creatorScript() });
  // 偽の開発者は答えず、問いが出たら中断する
  const developer = startDeveloper(relayDir, () => { setTimeout(() => abort.abort(), 20); return null; });
  const seenDuringGrading = [];
  const record = await runOuterOnce({
    loaded, runRoot: path.join(root, 'runs'), sandbox: false, convert: fakeConvert, query: sdk.query, model: 'claude-opus-5-5',
    answerer: 'human', signal: abort.signal,
    createAnswerer: (args) => createHumanRelay({ relayDir, signal: args.signal, pollMs: 5 }),
    // 中断の後も採点は続く。その間、中継は終わりの状態にならない（統括が書きかけの結果を読まないように）
    runStages: async () => { seenDuringGrading.push(readStatus(relayDir)); return okStages(); },
  });
  await developer.stop();
  assert.equal(record.stopped.reason, 'interrupted');
  assert.equal(developer.seen.length, 1);
  assert.equal(seenDuringGrading.length, 0, 'この台本は、答えを待つ間に中断されるので、生成プラグインはできない');
  const status = readStatus(relayDir);
  assert.equal(status.state, 'stopped');
  assert.equal(status.result.reason, 'interrupted');
  assert.equal(status.result.recordFile, record.recordFile, '終わりの状態は、記録を書いた後');
  assert.equal(status.phase, undefined);
});

test('REQ-015 開発者が答える：生成プラグインに課題がなければ、内側の EVAL を動かさずに理由を残す（黙って落とさない）', async (t) => {
  const root = tmp('notasks');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relayDir = path.join(root, 'relay');
  const requestFile = path.join(root, 'request.txt');
  fs.writeFileSync(requestFile, REQUEST);
  const sdk = createFakeSdk({ userRole: () => 'x', agent: creatorScript({ withTasks: false }) });
  let innerEvalCalled = false;
  const developer = startDeveloper(relayDir, developerAnswers);
  const record = await runOuterOnce({
    loaded: buildHumanLoaded({ requestFile }), runRoot: path.join(root, 'runs'), sandbox: false, convert: fakeConvert, runStages: okStages, query: sdk.query, model: 'claude-opus-5-5',
    answerer: 'human',
    createAnswerer: (args) => createHumanRelay({ relayDir, signal: args.signal, pollMs: 5 }),
    inner: (args) => runInnerForGenerated({ ...args, chromium: {}, innerEval: async () => { innerEvalCalled = true; return {}; } }),
  });
  await developer.stop();
  assert.equal(innerEvalCalled, false);
  assert.equal(record.inner.status, 'skipped');
  assert.match(record.inner.reason, /課題/);
  assert.ok(record.inner.taskProblems.some((p) => p.includes('課題のフォルダがない')));
  assert.deepEqual(record.grading.innerSeparate, record.inner);
  assert.ok(!record.grading.grades.some((g) => g.id === 'inner-deliverable'));
});

test('REQ-015 決まった返事のユーザー役：何を聞かれても FIXED_ANSWER で、費用は 0。画面の設定の欄は、課題の値か初めの値のまま', async () => {
  const role = fixedAnswerRole();
  assert.equal(await role({ question: 'どれにしますか？', choices: ['A', 'B'] }), FIXED_ANSWER);
  assert.equal(role.cost(), 0);
  const decided = await decideSettings({
    definitions: [{ key: 'week', label: '週', type: 'text' }, { key: 'tone', label: '文体', type: 'select', options: ['です・ます', 'だ・である'], default: 'です・ます' }, { key: 'note', label: 'メモ', type: 'text', default: '' }],
    fromEval: { week: '2026-W42' },
    userRole: role,
    prompt: '週報を書いてください',
  });
  assert.deepEqual(decided.values, { week: '2026-W42' });
  assert.deepEqual(decided.decisions.map((d) => [d.key, d.source]), [['week', 'eval-json'], ['tone', 'default'], ['note', 'default']]);
});

test('REQ-015 最初の依頼の文のファイル：UTF-8 の空でない文字だけを受ける。開発者のファイルは、なければ断る', (t) => {
  const root = tmp('request');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = (name, content) => { const p = path.join(root, name); fs.writeFileSync(p, content); return p; };
  assert.equal(readRequestFile(file('a.txt', '﻿作ってください。\r\n\r\n')), '作ってください。');
  assert.throws(() => readRequestFile(file('empty.txt', ' \n\n')), /空です/);
  assert.throws(() => readRequestFile(file('bad.txt', Buffer.from([0xff, 0xfe, 0x00]))), /UTF-8/);
  assert.throws(() => readRequestFile(path.join(root, 'ない.txt')), /読めません/);
  const loaded = buildHumanLoaded({ requestFile: file('r.txt', '依頼'), files: [{ src: file('m.txt', 'x'), place: 'm.txt' }] });
  assert.deepEqual(loaded.persona.knowledge, []);
  assert.equal(loaded.dir, null);
  assert.deepEqual(Object.keys(loaded.persona.styles), ['normal']);
  assert.equal(loaded.files[0].src, path.join(root, 'm.txt'));
  assert.notEqual(loaded.files[0].role, 'input', '課題の入力のファイルの観点は採点しない（testing.md 6.7）');
  assert.throws(() => buildHumanLoaded({ requestFile: path.join(root, 'r.txt'), files: [{ src: path.join(root, 'ない.txt'), place: 'x' }] }), /見つかりません/);
  assert.throws(() => buildHumanLoaded({ requestFile: path.join(root, 'r.txt'), files: [{ src: root, place: 'x' }] }), /フォルダは写せません/);
});

test('REQ-015 入口（outer.mjs --human）：始まりの 1 行と starting の状態を出し、開発者の答えで最後まで動き、要約のユーザー役は human', async (t) => {
  const root = tmp('main');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const out = path.join(root, 'out');
  const requestFile = path.join(root, 'request.txt');
  fs.writeFileSync(requestFile, REQUEST);
  const memo = path.join(root, 'memo.txt');
  fs.writeFileSync(memo, 'メモ');
  const converted = fakeConvert(REPO, path.join(root, 'converted', 'plugin-creator')).root;
  const sdk = createFakeSdk({ userRole: () => 'x', agent: creatorScript() });
  const stderr = [];
  const stdout = [];
  t.mock.method(console, 'error', (line) => { stderr.push(String(line)); });
  t.mock.method(console, 'log', (line) => { stdout.push(String(line)); });
  const relayDir = path.join(out, 'relay');
  // 終わりの状態を見たその時に、記録と outer-report.json が書き終わっているか
  let atEnd = null;
  const developer = startDeveloper(relayDir, developerAnswers, {
    onEnd: (status) => {
      const report = JSON.parse(fs.readFileSync(path.join(out, 'outer-report.json'), 'utf8'));
      atEnd = { status, reportStatus: report.status, records: fs.readdirSync(path.join(out, 'records')) };
    },
  });
  const code = await main(['--human', '--request-file', requestFile, '--file', `${memo}=資料/memo.txt`, '--no-sandbox', '--out', out, '--converted', converted, '--max-exchanges', '5'], {
    query: sdk.query,
    runOptions: { runStages: okStages, convert: fakeConvert },
  });
  for (let i = 0; i < 400 && !atEnd; i += 1) await sleep(5); // 偽の開発者が終わりの状態を見るまで
  await developer.stop();
  assert.equal(code, 0, stdout.join('\n'));
  const ready = JSON.parse(stderr[0]);
  assert.deepEqual(ready, { phase: 'human-ready', relayDir, out, pid: process.pid });
  assert.equal(developer.seen.length, 3);
  const summary = JSON.parse(stdout.at(-1));
  assert.equal(summary.ok, true);
  assert.equal(summary.userRoleModel, 'human');
  assert.equal(summary.relayDir, relayDir);
  const recordFile = path.join(out, 'records', 'human-normal-with-claude-opus-5-5-1.json');
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  assert.equal(record.answerer, 'human');
  assert.equal(record.persona.id, 'human');
  assert.equal(fs.readFileSync(path.join(record.dirs.work, '資料', 'memo.txt'), 'utf8'), 'メモ');
  const status = readStatus(relayDir);
  assert.equal(status.state, 'finished');
  assert.equal(status.out, out);
  assert.equal(status.result.lastText, '作りました。');
  assert.equal(status.reportFile, path.join(out, 'outer-report.json'));
  assert.equal(status.phase, undefined);
  assert.equal(status.pidNs !== undefined, true);
  assert.equal(atEnd.reportStatus, 'completed', '終わりの状態は、outer-report.json を書き終えてから');
  assert.deepEqual(atEnd.records, ['human-normal-with-claude-opus-5-5-1.json']);

  // 中継のフォルダが空でなければ、始め直さずに断る（前の実行の問いと答えが混ざらないように）
  stdout.length = 0;
  assert.equal(await main(['--human', '--request-file', requestFile, '--no-sandbox', '--out', out, '--converted', converted], { query: sdk.query }), 2);
  assert.equal(JSON.parse(stdout.at(-1)).error, 'relay_in_use');
  assert.equal(readStatus(relayDir).state, 'finished', '前の実行の状態は書き換えない');

  // 始まりの 1 行の後で始められなかったら（依頼の文が空）、状態を stopped（failed）にする（統括の wait が待ち続けないように）
  stdout.length = 0;
  stderr.length = 0;
  const emptyRequest = path.join(root, 'empty.txt');
  fs.writeFileSync(emptyRequest, '\n');
  const failOut = path.join(root, 'fail');
  assert.equal(await main(['--human', '--request-file', emptyRequest, '--no-sandbox', '--out', failOut], { query: sdk.query }), 2);
  assert.equal(JSON.parse(stdout.at(-1)).error, 'bad_request');
  assert.equal(JSON.parse(stderr[0]).phase, 'human-ready');
  const failed = readStatus(path.join(failOut, 'relay'));
  assert.equal(failed.state, 'stopped');
  assert.equal(failed.result.reason, 'failed');
  assert.match(failed.result.message, /空です/);
  assert.equal(checkWait(path.join(failOut, 'relay')).code, 3);

  // 試しの実行（--dry-run）は、計画だけを出し、中継のフォルダを作らない
  stdout.length = 0;
  const dryOut = path.join(root, 'dry');
  assert.equal(await main(['--human', '--request-file', requestFile, '--out', dryOut, '--dry-run']), 0);
  const plan = JSON.parse(stdout.at(-1));
  assert.equal(plan.human, true);
  assert.equal(plan.runs, 1);
  assert.deepEqual(plan.plan.map((p) => [p.persona, p.arm, p.style]), [['human', 'with', 'normal']]);
  assert.equal(fs.existsSync(dryOut), false);
});
