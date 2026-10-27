// 開発者が答える外側の EVAL を、続きから始める形（outer.mjs --resume、outer-resume.mjs。testing.md 6.7）の試験。実際のモデルは使わない（偽物の Agent SDK）。
// 止まったプロセスの代わりに、偽物の SDK で会話を途中まで動かし、そのメッセージから Claude Code のセッションの記録（JSONL）の形を作る。
// 行の形は、本物の Claude Code 2.1 の記録（assistant・user の行、promptSource、toolUseResult、subagents/agent-<id>.jsonl と .meta.json）に合わせる。
// 動かし方（リポジトリの根で）：node --test "tests/dev-eval/runner/outer-resume.test.mjs"

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ITEMS } from '../../../com.github.copilot/extensions/plugin-creator/names.mjs';
import { createFakeSdk } from './outer-fake-sdk.mjs';
import { abandonedIds, abandonUnanswered, answerQuestion, checkWait, createHumanRelay, currentPidNs, pendingQuestion, readStatus, TERMINAL_STATES, writeJsonAtomic } from './human-relay.mjs';
import { buildHumanLoaded, main, parseArgs, readResumePromptFile, summarizeRecord } from './outer.mjs';
import { gradeOuter } from './outer-grade.mjs';
import { createMessageRecorder, createRecorder } from './outer-record.mjs';
import { checkReplayAgainstRelay, findSessionTranscript, readResumes, replayTranscript } from './outer-resume.mjs';
import { CONVERSATION_GRADES, runOuterOnce } from './outer-run.mjs';
import { diskOk, tempDir } from './temp-dirs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..', '..');
const tmp = (prefix) => tempDir(`outer-resume-${prefix}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const T = (name) => `mcp__plugin-creator__${name}`;
const SETTABLE = ITEMS.filter((i) => !i.computed && !i.rebuildOnly).map((i) => i.name);
const REQUEST = '週報を作るプラグインを作ってください。';
const SESSION = '0f8d2c3a-1b2c-4d5e-8f90-123456789abc';
const RESUME_PROMPT = '（前の問い「道具を入れてよいですか？」への開発者の答え）入れてよい';
const okStages = async () => ({ skipped: false, ok: true, stage1: { ok: true }, stage2: { ok: true } });

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

/** 終わったプロセスの番号 */
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

/** 偽の開発者：答えのない問いに answerFor の答えを置く（null なら置かない）。終わりの状態を見たら止まる */
function startDeveloper(relayDir, answerFor) {
  const seen = [];
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      const status = readStatus(relayDir);
      if (status && TERMINAL_STATES.includes(status.state) && status.pid === process.pid) break;
      const q = pendingQuestion(relayDir);
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

/** query を包んで、query ごとの発言・メッセージ・質問のツールへの答えを残す（セッションの記録を作るため） */
function recordingQuery(inner) {
  const calls = [];
  const query = ({ prompt, options }) => {
    const call = { prompt, messages: [], answers: new Map() };
    calls.push(call);
    const canUseTool = async (name, input, ctx) => {
      const decision = await options.canUseTool(name, input, ctx);
      if (name === 'AskUserQuestion' && decision.behavior === 'allow') call.answers.set(ctx.toolUseID, decision.updatedInput?.answers ?? {});
      return decision;
    };
    const it = inner({ prompt, options: { ...options, canUseTool } });
    return (async function* () {
      for await (const m of it) {
        call.messages.push(m);
        yield m;
      }
    })();
  };
  return { calls, query };
}

/**
 * query の記録から、Claude Code のセッションの記録（本物の行の形）を書く。
 * 答えのない質問のツールの呼び出し（答えを待つ間にプロセスが止まった）で、その query の記録を切る（次の query は、続きから始めた分）。
 * サブエージェントの記録は <番号>/subagents/agent-<id>.jsonl。metaFor(toolUseId) が偽なら .meta.json を書かない（toolUseResult.agentId から引く）
 * 本物の Claude Code は、答えのない呼び出しで切れたセッションを続けるとき、次の発言の前に、その呼び出しの「中断」の結果
 * （toolDenialKind が interrupted）と、モデルが <synthetic> の文（No response requested.）を書く。これらは SDK のメッセージには流れない
 */
function writeTranscript(agentHome, workDir, calls, { sessionId = SESSION, metaFor = () => true } = {}) {
  const projectDir = path.join(agentHome, '.claude', 'projects', workDir.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(projectDir, { recursive: true });
  const main = [];
  const subs = new Map(); // Agent の呼び出しの番号 → { agentId, lines }
  let clock = Date.parse('2026-10-25T05:00:00.000Z');
  let uuidCounter = 0;
  let parent = null;
  const stamp = () => new Date((clock += 1000)).toISOString();
  const uuid = () => `00000000-0000-4000-8000-${String((uuidCounter += 1)).padStart(12, '0')}`;
  const base = (sidechain, agentId) => ({ parentUuid: parent, isSidechain: sidechain, userType: 'external', entrypoint: 'sdk-ts', cwd: workDir, sessionId, version: '2.1.310', ...(agentId ? { agentId } : {}) });
  const push = (lines, line) => { lines.push(line); parent = line.uuid ?? parent; };
  const asks = new Map(); // AskUserQuestion の番号 → questions
  const agentIdOf = (toolUseId) => {
    if (!subs.has(toolUseId)) subs.set(toolUseId, { agentId: `a${(subs.size + 1).toString(16).padStart(16, '0')}`, lines: [] });
    return subs.get(toolUseId);
  };
  let dangling = null; // 前の query の、答えのないまま切れた質問のツールの呼び出しの番号
  for (const call of calls) {
    let cut = false;
    push(main, { type: 'queue-operation', operation: 'enqueue', timestamp: stamp(), sessionId });
    if (dangling) {
      const interrupted = "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. Check whether it took effect before relying on it or running it again.]";
      push(main, { ...base(false), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: dangling, content: interrupted, is_error: true }] }, uuid: uuid(), timestamp: stamp(), toolUseResult: interrupted, toolDenialKind: 'interrupted' });
      push(main, { ...base(false), type: 'assistant', message: { id: `msg_${uuidCounter}`, model: '<synthetic>', role: 'assistant', type: 'message', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'No response requested.' }] }, uuid: uuid(), timestamp: stamp(), isApiErrorMessage: false });
      dangling = null;
    }
    push(main, { ...base(false), type: 'user', message: { role: 'user', content: [{ type: 'text', text: call.prompt }] }, uuid: uuid(), timestamp: stamp(), promptSource: 'sdk', turnOrigin: 'sdk' });
    push(main, { ...base(false), type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: …' }] }, uuid: uuid(), timestamp: stamp() });
    push(main, { ...base(false), type: 'attachment', attachment: { type: 'total_tokens_reminder', text: '…' }, uuid: uuid(), timestamp: stamp() });
    for (const m of call.messages) {
      const owner = m.parent_tool_use_id ?? null;
      const sub = owner ? agentIdOf(owner) : null;
      const lines = sub ? sub.lines : main;
      if (m.type === 'assistant') {
        const blocks = m.message.content;
        for (const b of blocks) {
          push(lines, { ...base(Boolean(sub), sub?.agentId), type: 'assistant', message: { model: m.message.model, id: `msg_${uuidCounter}`, type: 'message', role: 'assistant', content: [b], stop_reason: b.type === 'tool_use' ? 'tool_use' : 'end_turn' }, uuid: uuid(), timestamp: stamp() });
          if (b.type === 'tool_use' && b.name === 'AskUserQuestion') {
            asks.set(b.id, b.input.questions);
            if (!call.answers.has(b.id)) { cut = true; dangling = b.id; break; }
          }
          if (b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task')) {
            const s = agentIdOf(b.id);
            s.type = b.input.subagent_type;
            s.lines.push({ ...base(true, s.agentId), parentUuid: null, type: 'user', message: { role: 'user', content: b.input.prompt }, uuid: uuid(), timestamp: stamp() });
          }
        }
        if (cut) break;
      } else if (m.type === 'user') {
        for (const c of m.message.content) {
          let toolUseResult = c.content;
          if (asks.has(c.tool_use_id)) toolUseResult = { questions: asks.get(c.tool_use_id), answers: call.answers.get(c.tool_use_id) };
          else if (subs.has(c.tool_use_id) && !owner) toolUseResult = { status: 'completed', agentId: subs.get(c.tool_use_id).agentId, agentType: subs.get(c.tool_use_id).type, content: c.content };
          else if (c.is_error) toolUseResult = `Error: ${c.content?.[0]?.text ?? ''}`;
          // 本物は、失敗の結果の content を文字で持つ
          const content = c.is_error ? (c.content ?? []).map((x) => x.text).join('\n') : c.content;
          push(lines, { ...base(Boolean(sub), sub?.agentId), type: 'user', message: { role: 'user', content: [{ tool_use_id: c.tool_use_id, type: 'tool_result', content, ...(c.is_error ? { is_error: true } : {}) }] }, toolUseResult, uuid: uuid(), timestamp: stamp() });
        }
      } else if (m.type === 'result') {
        push(main, { type: 'last-prompt', lastPrompt: call.prompt, sessionId });
        push(main, { type: 'cost-state', sessionId, totalCostUSD: m.total_cost_usd });
      }
    }
  }
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, `${main.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const subDir = path.join(projectDir, sessionId, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  for (const [toolUseId, s] of subs) {
    fs.writeFileSync(path.join(subDir, `agent-${s.agentId}.jsonl`), `${s.lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    if (metaFor(toolUseId)) fs.writeFileSync(path.join(subDir, `agent-${s.agentId}.meta.json`), JSON.stringify({ agentType: s.type, toolUseId, spawnDepth: 1, finished: true }));
  }
  return file;
}

/** 止まる前の会話：質問のツール、記録のツール、サブエージェントの書き込み、文章の問い。2 回目の手番の質問のツールで、答えを待つ */
function firstScript(ctx) {
  return (async () => {
    if (ctx.turn === 1) {
      await ctx.say('お話を聞きます。');
      await ctx.ask([{ question: '成果物は何ですか？', header: '成果物', multiSelect: false, options: [{ label: 'Markdown', description: 'md' }, { label: 'Word', description: '' }] }]);
      await ctx.tool(T('progress'), { stage: '始まり' });
      await ctx.tool(T('progress'), { items: [{ item: '成果物', status: '聞いた', quote: '' }] }); // 断られる（抜き書きが空）
      await ctx.tool(T('progress'), { items: SETTABLE.map((item) => ({ item, status: '聞いた', quote: '成果物は weekly_report.md です' })) });
      await ctx.subagent({ type: 'plugin-creator:worker', description: '案を書く', model: 'claude-haiku-5-5' }, async (sub) => {
        await sub.say('書きます');
        await sub.tool('Write', { file_path: path.join(ctx.options.cwd, '.plugin-creator-work', 'draft', 'task.json'), content: '{}' });
        return '書きました';
      });
      await ctx.subagent({ type: 'plugin-creator:reader', description: '読む' }, async (sub) => { await sub.say('読みました'); });
      await ctx.say('まとめです。');
      return 'ほかに伝えておきたいことはありますか？';
    }
    await ctx.say('試験の道具について聞きます。');
    await ctx.ask([{ question: '道具を入れてよいですか？', header: '道具', multiSelect: false, options: [{ label: '入れてよい', description: '' }, { label: '入れない', description: '' }] }]);
    return '止まらなかった';
  })();
}

const firstAnswers = (q) => ({ '成果物は何ですか？': '成果物は weekly_report.md です', 'ほかに伝えておきたいことはありますか？': 'ありません' }[q.question] ?? null);

/**
 * 止まった実行を作る：偽物の SDK で 2 回目の手番の問い（0003）まで動かし、そのときにプロセスが止まった形にする
 * （中継の状態は waiting のまま、pid は終わったプロセス、heartbeatAt は古い。セッションの記録は、答えのない呼び出しで切れる）
 */
async function makeStoppedRun(root, { metaFor, answers = firstAnswers, pending = '0003' } = {}) {
  const out = path.join(root, 'out');
  const relayDir = path.join(out, 'relay');
  const requestFile = path.join(root, 'request.txt');
  fs.writeFileSync(requestFile, REQUEST);
  const abort = new AbortController();
  const rec = recordingQuery(createFakeSdk({ agent: firstScript }).query);
  const developer = startDeveloper(relayDir, (q) => {
    const a = answers(q);
    if (a === null) setTimeout(() => abort.abort(), 20);
    return a;
  });
  const record = await runOuterOnce({
    loaded: buildHumanLoaded({ requestFile }), runRoot: path.join(out, 'runs'), sandbox: false, convert: fakeConvert, runStages: okStages, query: rec.query, model: 'claude-opus-5-5',
    answerer: 'human', signal: abort.signal,
    createAnswerer: (args) => createHumanRelay({ relayDir, signal: args.signal, pollMs: 5, runDir: args.runDir, workDir: args.workDir }),
  });
  await developer.stop();
  const runDir = record.dirs.run;
  const transcript = writeTranscript(path.join(runDir, 'agent-home'), record.dirs.work, rec.calls, { metaFor });
  const old = new Date(Date.now() - 60 * 60_000).toISOString();
  writeJsonAtomic(path.join(relayDir, 'status.json'), { state: 'waiting', pid: deadPid(), pidNs: currentPidNs(), out, runDir, workDir: record.dirs.work, pending, updatedAt: old, heartbeatAt: old });
  return { out, relayDir, runDir, transcript, liveRecord: record, calls: rec.calls };
}

/** 答えを待つ問い（id）が出るまで待つ */
async function waitPending(relayDir, id) {
  for (let i = 0; i < 400; i += 1) {
    const q = pendingQuestion(relayDir);
    if (q?.id === id) return q;
    await sleep(5);
  }
  throw new Error(`問い ${id} が出ませんでした`);
}

const strip = (x) => {
  const { seq, at, ...rest } = x;
  return rest;
};

test('REQ-015 続きから始める引数：--resume は --human と --resume-prompt-file と --out が要る。--request-file と --file は使えない', () => {
  const a = parseArgs(['--human', '--resume', 'out/runs/r', '--resume-prompt-file', 'p.txt', '--out', 'out', '--inner']);
  assert.equal(a.resume, 'out/runs/r');
  assert.equal(a.resumePromptFile, 'p.txt');
  assert.equal(a.requestFile, undefined, '--request-file なしで通る');
  assert.throws(() => parseArgs(['--persona', 'p', '--resume', 'r']), /--resume は、開発者が答える形（--human）のときだけ/);
  assert.throws(() => parseArgs(['--persona', 'p', '--resume-prompt-file', 'p.txt']), /--resume-prompt-file は、開発者が答える形/);
  assert.throws(() => parseArgs(['--human', '--resume', 'r', '--out', 'o']), /--resume-prompt-file/);
  assert.throws(() => parseArgs(['--human', '--resume', 'r', '--resume-prompt-file', 'p']), /--out/);
  assert.throws(() => parseArgs(['--human', '--resume', 'r', '--resume-prompt-file', 'p', '--out', 'o', '--request-file', 'q']), /--resume では --request-file は使えません/);
  assert.throws(() => parseArgs(['--human', '--resume', 'r', '--resume-prompt-file', 'p', '--out', 'o', '--file', 'x.txt']), /--resume では --file は使えません/);
  assert.throws(() => parseArgs(['--human', '--request-file', 'q', '--resume-prompt-file', 'p']), /--resume-prompt-file は、--resume/);
  assert.throws(() => parseArgs(['--human', '--resume', 'r', '--resume-prompt-file', 'p', '--out', 'o', '--arms', 'with,without']), /--arms は with だけ/);
  const root = tmp('prompt');
  try {
    fs.writeFileSync(path.join(root, 'p.txt'), '入れてよい\n');
    assert.equal(readResumePromptFile(path.join(root, 'p.txt')), '入れてよい');
    fs.writeFileSync(path.join(root, 'e.txt'), '\n');
    assert.throws(() => readResumePromptFile(path.join(root, 'e.txt')), (e) => e.code === 'bad_resume_prompt' && /続けるときの最初の発言のファイルが空/.test(e.message));
    assert.throws(() => readResumePromptFile(path.join(root, 'ない.txt')), (e) => e.code === 'no_resume_prompt');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('REQ-015 中継の続き：答えのない問いに待たない印を置き、wait と answer はその問いを飛ばす。新しい問いの id と index は続きの番号', async (t) => {
  const relayDir = tmp('relay');
  t.after(() => fs.rmSync(relayDir, { recursive: true, force: true }));
  const stopFirst = new AbortController();
  t.after(() => stopFirst.abort());
  const first = createHumanRelay({ relayDir, pollMs: 5, heartbeatMs: 0, signal: stopFirst.signal });
  const a1 = first.answer('一つ目？', [], 'text');
  await waitPending(relayDir, '0001');
  answerQuestion(relayDir, '0001', '答え1');
  await a1;
  void first.answer('二つ目？', [], 'text').catch(() => {}); // 答えを待つ間に止まった
  await waitPending(relayDir, '0002');
  // 形の誤った答えのファイルも、答えのない問いとして印を置く
  fs.mkdirSync(path.join(relayDir, 'questions'), { recursive: true });
  writeJsonAtomic(path.join(relayDir, 'questions', '0003.json'), { id: '0003', index: 2, via: 'text', question: '三つ目？' });
  writeJsonAtomic(path.join(relayDir, 'answers', '0003.json'), { answer: '' });
  assert.deepEqual(abandonUnanswered(relayDir, { now: () => '2026-10-25T07:00:00.000Z' }), ['0002', '0003']);
  assert.deepEqual(abandonUnanswered(relayDir), [], 'もう印があれば、置き直さない');
  assert.deepEqual(abandonedIds(relayDir), ['0002', '0003']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(relayDir, 'abandoned', '0002.json'), 'utf8')), { id: '0002', abandonedAt: '2026-10-25T07:00:00.000Z', reason: 'resumed' });
  assert.equal(pendingQuestion(relayDir), null, '印のある問いは、答えを待つ問いにしない');
  assert.throws(() => answerQuestion(relayDir, '0002', 'x'), (e) => e.code === 'abandoned');
  // 続きのプロセスの中継：id は 0004 から、index は答えのある問いの数（1）から
  const relay = createHumanRelay({ relayDir, pollMs: 5, heartbeatMs: 0 });
  const p = relay.answer('四つ目？', [], 'text');
  const q = await waitPending(relayDir, '0004');
  assert.deepEqual([q.id, q.index], ['0004', 1]);
  assert.equal(checkWait(relayDir).output.id, '0004', 'wait は、新しい問いを返す（印のある前の問いで止まらない）');
  answerQuestion(relayDir, '0004', '答え4');
  assert.equal((await p).index, 1);
  first.finish({ reason: 'interrupted' });
  relay.finish({ reason: 'generated' });
});

test('REQ-015 セッションの番号：agent-home/.claude/projects/ の直下の <番号>.jsonl のうち、いちばん新しいもの。サブエージェントの記録は数えない', (t) => {
  const home = tmp('session');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.throws(() => findSessionTranscript(home), /続きから始められません/);
  const dir = path.join(home, '.claude', 'projects', '-tmp-work');
  const older = '11111111-1111-4111-8111-111111111111';
  const newer = '22222222-2222-4222-8222-222222222222';
  fs.mkdirSync(path.join(dir, newer, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, `${older}.jsonl`), '{}\n');
  fs.writeFileSync(path.join(dir, `${newer}.jsonl`), '{}\n');
  fs.writeFileSync(path.join(dir, 'notes.jsonl'), '{}\n');
  fs.utimesSync(path.join(dir, `${older}.jsonl`), new Date('2026-10-25T05:00:00Z'), new Date('2026-10-25T05:00:00Z'));
  fs.utimesSync(path.join(dir, `${newer}.jsonl`), new Date('2026-10-25T06:00:00Z'), new Date('2026-10-25T06:00:00Z'));
  // サブエージェントの記録は、いちばん新しくても数えない
  fs.writeFileSync(path.join(dir, newer, 'subagents', '33333333-3333-4333-8333-333333333333.jsonl'), '{}\n');
  assert.deepEqual(findSessionTranscript(home), { sessionId: newer, file: path.join(dir, `${newer}.jsonl`) });
  assert.equal(findSessionTranscript(home, older).file, path.join(dir, `${older}.jsonl`));
  assert.throws(() => findSessionTranscript(home, '44444444-4444-4444-8444-444444444444'), /記録がありません/);
});

test('REQ-015 読み直し：セッションの記録から、動いていた会話と同じ記録（問い・答え・ツール・サブエージェント・記録のツールの呼び出し）と採点を作る', async (t) => {
  const root = tmp('replay');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // 1 つ目のサブエージェントは .meta.json から、2 つ目は Agent の結果の agentId から引く
  let n = 0;
  const run = await makeStoppedRun(root, { metaFor: () => (n += 1) === 1 });
  const live = run.liveRecord;
  const recorder = createRecorder();
  const models = {};
  const subagents = {};
  const skills = [];
  const r = replayTranscript({ file: run.transcript, recorder, messageRecorder: createMessageRecorder({ recorder, models, subagents, skills }) });
  assert.deepEqual(r.problems, []);
  assert.equal(r.request, REQUEST);
  assert.equal(r.turns, 2);
  assert.deepEqual(r.pendingAsks.map((p) => [p.header, p.question]), [['道具', '道具を入れてよいですか？']]);
  assert.deepEqual(r.warnings, [], '答えを待っていた質問のツールの呼び出しは、答えのない問い（pendingAsks）にする');

  // 動いていた会話の記録と比べる。止まった問い（0003）の問いまでは同じ（止まった後の分と、手番の終わりの記録は除く）
  const lastAsk = live.items.findIndex((i) => i.kind === 'creator.question' && i.header === '道具');
  const liveItems = live.items.slice(0, lastAsk + 1).filter((i) => i.kind !== 'turn.end').map(strip);
  const replayed = recorder.items.filter((i) => i.kind !== 'turn.end').map(strip);
  assert.deepEqual(replayed, liveItems);
  // 順番の印（seq）の並び：会話の記録と記録のツールの呼び出しを合わせた並びが同じ
  const order = (items, events) => [...items.filter((i) => i.kind !== 'turn.end').map((i) => [i.seq, i.kind]), ...events.map((e) => [e.seq, `${e.type}:${e.tool}`])].sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const liveEvents = live.toolEvents;
  assert.deepEqual(order(recorder.items, r.toolEvents), order(live.items.slice(0, lastAsk + 1), liveEvents));
  // 記録のツールの呼び出しと結果（断りを含む）
  const ev = (e) => ({ type: e.type, tool: e.tool, isError: e.isError, args: e.args, result: e.result, toolUseId: e.toolUseId });
  assert.deepEqual(r.toolEvents.map(ev), liveEvents.map(ev));
  assert.ok(r.toolEvents.every((e) => /^replay-\d+$/.test(e.callId)));
  // 動いたモデルとサブエージェント
  assert.deepEqual(Object.values(subagents), Object.values(live.subagents.map((s) => ({ type: s.type, description: s.description }))));
  assert.deepEqual(models.main, live.mainModels);
  assert.deepEqual(Object.values(models).slice(1), live.subagents.map((s) => s.models));
  // 採点（全項目をヒアリングしたか、承認の前に生成しなかったか）も同じ
  const grade = (items, toolEvents) => gradeOuter({ persona: { knowledge: [], experience: 'done' }, personaFiles: [], items, toolEvents, state: live.state, generatedCount: 0, generatedFiles: null, stages: null, inner: null, model: 'claude-opus-5-5', answerer: 'human' }).grades.filter((g) => CONVERSATION_GRADES.includes(g.id));
  assert.deepEqual(grade(recorder.items, r.toolEvents), grade(live.items, liveEvents));
  // 中継のフォルダの答えと突き合わせる
  const check = checkReplayAgainstRelay({ items: recorder.items, relayDir: run.relayDir });
  assert.deepEqual([check.ok, check.compared, check.unanswered], [true, 2, ['0003']]);
});

test('REQ-015 入口（outer.mjs --human --resume）：前の実行のフォルダとセッションを続け、待っていた問いに印を置き、記録に前の会話と続きを入れる', async (t) => {
  const root = tmp('main');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = await makeStoppedRun(root);
  const converted = path.join(run.runDir, 'converted', path.basename(REPO));
  const promptFile = path.join(root, 'resume.txt');
  fs.writeFileSync(promptFile, `${RESUME_PROMPT}\n`);
  const workBefore = fs.readdirSync(path.join(run.runDir, 'work')).sort();

  const seen = [];
  const sdk = createFakeSdk({
    agent: async (ctx) => {
      seen.push({ prompt: ctx.prompt, resume: ctx.options.resume, cwd: ctx.options.cwd, home: ctx.options.env.HOME });
      await ctx.say('道具を入れて、試します。');
      await ctx.ask([{ question: '置き場所はここでよいですか？', header: '置き場所', multiSelect: false, options: [{ label: 'はい', description: '' }] }]);
      const dir = path.join(ctx.options.cwd, 'weekly-report');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name: 'weekly-report', version: '0.1.0' }));
      return '作りました。';
    },
  });
  const rec2 = recordingQuery(sdk.query);
  const developer = startDeveloper(run.relayDir, (q) => (q.question === '置き場所はここでよいですか？' ? 'はい' : null));
  const stdout = [];
  const stderr = [];
  t.mock.method(console, 'log', (line) => { stdout.push(String(line)); });
  t.mock.method(console, 'error', (line) => { stderr.push(String(line)); });
  // 試しの実行は、何も書かずに、続きから始められるかを示す
  assert.equal(await main(['--human', '--resume', run.runDir, '--resume-prompt-file', promptFile, '--out', run.out, '--dry-run']), 0);
  const dry = JSON.parse(stdout.at(-1)).resume;
  assert.deepEqual([dry.sessionId, dry.state, dry.lastId, dry.willAbandon, dry.nextId], [SESSION, 'waiting', '0003', ['0003'], '0004']);
  assert.equal(fs.existsSync(path.join(run.relayDir, 'abandoned')), false);

  const code = await main(['--human', '--resume', run.runDir, '--resume-prompt-file', promptFile, '--out', run.out, '--converted', converted, '--no-sandbox', '--max-exchanges', '10'], {
    query: rec2.query,
    diskCheck: diskOk,
    runOptions: { runStages: okStages, convert: () => { throw new Error('置き換え直さないはず'); } },
  });
  await developer.stop();
  assert.equal(code, 0, stdout.join('\n'));
  assert.equal(JSON.parse(stderr[0]).phase, 'human-ready');
  // クリエイターの同じセッションを、前の作業フォルダとホームで続け、最初の発言は統括の文
  assert.deepEqual(seen, [{ prompt: RESUME_PROMPT, resume: SESSION, cwd: path.join(run.runDir, 'work'), home: path.join(run.runDir, 'agent-home') }]);
  assert.deepEqual(fs.readdirSync(path.join(run.runDir, 'work')).filter((n) => n !== 'weekly-report').sort(), workBefore, '示すファイルを置き直さない');
  // 中継：前の問いと答えは残り、待っていた 0003 には印。新しい問いは 0004（index は答えのある問いの数の 2）
  assert.deepEqual(fs.readdirSync(path.join(run.relayDir, 'questions')).sort(), ['0001.json', '0002.json', '0003.json', '0004.json']);
  assert.deepEqual(abandonedIds(run.relayDir), ['0003']);
  // 偽の開発者は、印を置く前の 0003 を見ることがあるが、答えない
  assert.deepEqual(developer.seen.filter((q) => q.id !== '0003').map((q) => [q.id, q.index, q.question]), [['0004', 2, '置き場所はここでよいですか？']]);
  assert.equal(fs.existsSync(path.join(run.relayDir, 'answers', '0003.json')), false);
  const status = readStatus(run.relayDir);
  assert.equal(status.state, 'finished');
  assert.equal(status.pid, process.pid);
  assert.equal(status.result.reason, 'generated_without_approval');
  assert.deepEqual([status.resume.sessionId, status.resume.fromRelayId, status.resume.abandoned], [SESSION, '0003', ['0003']]);
  assert.equal(status.resumes.length, 1);

  const record = JSON.parse(fs.readFileSync(path.join(run.out, 'records', 'human-normal-with-claude-opus-5-5-1.json'), 'utf8'));
  assert.equal(record.dirs.run, run.runDir);
  assert.equal(record.sessionId, SESSION);
  assert.deepEqual(record.resumed.map((x) => [x.sessionId, x.fromRelayId, x.abandoned]), [[SESSION, '0003', ['0003']]]);
  assert.equal(record.replay.reliable, true, JSON.stringify(record.replay.problems));
  assert.equal(record.replay.relayCheck.compared, 2);
  // 会話：最初の依頼（記録から読み直した文）、前の問いと答え、待っていた問い、続きの最初の発言（その問いへの答え）、続きの問いと答え
  assert.equal(record.conversation[0].text, REQUEST);
  const answers = record.items.filter((i) => i.kind === 'user.answer').map((i) => [i.via, i.index, i.question, i.answer]);
  assert.deepEqual(answers, [
    ['AskUserQuestion', 0, '成果物は何ですか？', '成果物は weekly_report.md です'],
    ['text', 1, 'ほかに伝えておきたいことはありますか？', 'ありません'],
    ['resume', null, '道具を入れてよいですか？', RESUME_PROMPT],
    ['AskUserQuestion', 2, '置き場所はここでよいですか？', 'はい'],
  ]);
  assert.equal(record.exchanges, 2, '前の会話の手番の数から数える');
  // 質問のツールの呼び出しの番号は、読み直した呼び出し（成果物、道具）の続き。1 回の呼び出しの問いの数を正しく数える
  assert.deepEqual(record.items.filter((i) => i.kind === 'creator.question').map((i) => [i.header, i.group, i.groupSize]), [['成果物', 1, 1], ['道具', 2, 1], ['置き場所', 3, 1]]);
  assert.deepEqual(record.grading.counts.askToolCalls, { calls: 3, maxQuestionsPerCall: 1, callsWithMultiple: 0 });
  // 記録のツールの呼び出し：前の分（読み直し）の後に、続きの分
  assert.ok(record.toolEvents.length >= 6);
  assert.ok(record.toolEvents.every((e) => /^replay-/.test(String(e.callId))));
  // 採点：前の会話を含めて採点する（全項目をヒアリングしたか、など）
  const byId = Object.fromEntries(record.grading.grades.map((g) => [g.id, g]));
  assert.equal(byId['all-items-heard'].ok, true, byId['all-items-heard'].detail);
  assert.ok(byId['no-generation-before-approval']);
  assert.equal(record.grading.notGraded, undefined);
  assert.deepEqual(record.subagents.map((s) => [s.type, s.model]), [['plugin-creator:worker', 'claude-haiku-5-5'], ['plugin-creator:reader', 'claude-opus-5-5']]);
  // クリエイターのセッションの記録は消さない（また止まったら、続けられるように）。続きから始めた記録を残す
  assert.equal(fs.existsSync(run.transcript), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(run.runDir, 'resumes.json'), 'utf8')).map((x) => [x.sessionId, x.fromRelayId, x.prompt]), [[SESSION, '0003', RESUME_PROMPT]]);
  // 前の記録のツールの記録（state.json）を読み込んで続けた
  assert.ok(record.state && record.state.items);

  // また続きから始める（続けた会話も、セッションの記録に足されている）：前に続けたときの最初の発言は、答え（resume）として読み直す
  stdout.length = 0;
  stderr.length = 0;
  writeTranscript(path.join(run.runDir, 'agent-home'), path.join(run.runDir, 'work'), [...run.calls, ...rec2.calls]);
  const sdk2 = createFakeSdk({ agent: async () => '続けました。' });
  fs.writeFileSync(promptFile, '続けてください');
  assert.equal(await main(['--human', '--resume', run.runDir, '--resume-prompt-file', promptFile, '--out', run.out, '--converted', converted, '--no-sandbox'], { query: sdk2.query, diskCheck: diskOk, runOptions: { runStages: okStages } }), 0, stdout.join('\n'));
  const again = JSON.parse(fs.readFileSync(path.join(run.out, 'records', 'human-normal-with-claude-opus-5-5-1.json'), 'utf8'));
  assert.equal(again.resumed.length, 2);
  assert.deepEqual(again.items.filter((i) => i.kind === 'user.answer' && i.via === 'resume').map((i) => i.answer), [RESUME_PROMPT, '続けてください']);
  assert.equal(again.replay.reliable, true, JSON.stringify(again.replay.problems));
  assert.equal(again.replay.relayCheck.compared, 3);
  assert.deepEqual(again.replay.counts.resumeAnswers, 1);
  // Claude Code が続きから始めるときに足した行（中断の結果と <synthetic> の文）は、動いている会話に流れないので、読み直さない
  assert.equal(again.replay.counts.syntheticLines, 2);
  assert.deepEqual(again.replay.warnings.filter((w) => /答えがない/.test(w)), []);
  assert.deepEqual(again.mainModels, record.mainModels);
  assert.equal(again.grading.grades.find((g) => g.id === 'main-model').ok, true);
  assert.ok(!again.items.some((i) => i.kind === 'creator.text' && i.text === 'No response requested.'));
  assert.ok(!again.items.some((i) => i.kind === 'tool.result' && /Tool call interrupted/.test(i.text)));
  assert.deepEqual(again.items.filter((i) => i.kind === 'creator.question').map((i) => i.group), [1, 2, 3]);
  assert.deepEqual(again.grading.counts.askToolCalls, { calls: 3, maxQuestionsPerCall: 1, callsWithMultiple: 0 });

  // 前の実行のプロセスがまだ動いている見込み（終わりの状態でなく、heartbeatAt が新しい）なら、始めずに断る
  stdout.length = 0;
  writeJsonAtomic(path.join(run.relayDir, 'status.json'), { ...readStatus(run.relayDir), state: 'waiting', pid: process.pid, pidNs: currentPidNs(), heartbeatAt: new Date().toISOString() });
  assert.equal(await main(['--human', '--resume', run.runDir, '--resume-prompt-file', promptFile, '--out', run.out, '--no-sandbox'], { query: sdk.query }), 2);
  assert.equal(JSON.parse(stdout.at(-1)).error, 'relay_alive');
  // 実行のフォルダが中継の状態と違うときも断る
  stdout.length = 0;
  writeJsonAtomic(path.join(run.relayDir, 'status.json'), { ...readStatus(run.relayDir), state: 'stopped' });
  const other = path.join(root, 'other');
  for (const d of ['work', 'agent-home', 'copilot-home']) fs.mkdirSync(path.join(other, d), { recursive: true });
  assert.equal(await main(['--human', '--resume', other, '--resume-prompt-file', promptFile, '--out', run.out, '--no-sandbox'], { query: sdk.query }), 2);
  assert.equal(JSON.parse(stdout.at(-1)).error, 'no_session');
  stdout.length = 0;
  fs.cpSync(path.join(run.runDir, 'agent-home'), path.join(other, 'agent-home'), { recursive: true });
  assert.equal(await main(['--human', '--resume', other, '--resume-prompt-file', promptFile, '--out', run.out, '--no-sandbox'], { query: sdk.query }), 2);
  assert.equal(JSON.parse(stdout.at(-1)).error, 'resume_mismatch');
});

test('REQ-015 読み直しが中継の答えと合わないときは、会話にもとづく観点を採点せず、理由を残す。置き換えた版は実行のフォルダのものを使う', async (t) => {
  const root = tmp('unreliable');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = await makeStoppedRun(root);
  // 中継の答え 0001 が、セッションの記録と違う
  writeJsonAtomic(path.join(run.relayDir, 'answers', '0001.json'), { answer: '別の答え' });
  abandonUnanswered(run.relayDir);
  const sdk = createFakeSdk({
    agent: async (ctx) => {
      const dir = path.join(ctx.options.cwd, 'weekly-report');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'plugin.json'), '{}');
      return '作りました。';
    },
  });
  const record = await runOuterOnce({
    loaded: buildHumanLoaded({ requestFile: path.join(root, 'request.txt') }), runRoot: path.join(root, 'unused'), sandbox: false, query: sdk.query, model: 'claude-opus-5-5', runStages: okStages,
    convert: () => { throw new Error('置き換え直さないはず'); },
    answerer: 'human',
    createAnswerer: (args) => createHumanRelay({ relayDir: run.relayDir, signal: args.signal, pollMs: 5, runDir: args.runDir, workDir: args.workDir }),
    resume: { runDir: run.runDir, prompt: RESUME_PROMPT, fromRelayId: '0003', abandoned: ['0003'] },
  });
  assert.equal(fs.existsSync(path.join(root, 'unused')), false, '新しい実行のフォルダを作らない');
  assert.equal(record.creator.converted, path.join(run.runDir, 'converted', path.basename(REPO)));
  assert.equal(record.replay.reliable, false);
  assert.match(record.replay.problems.join('\n'), /中継の問い 0001 と、読み直した 1 番目の答えで、答えの文が違う/);
  const ids = record.grading.grades.map((g) => g.id);
  for (const id of CONVERSATION_GRADES) assert.ok(!ids.includes(id), id);
  assert.deepEqual(record.grading.notGraded.map((g) => g.id), CONVERSATION_GRADES);
  assert.match(record.grading.notGraded[0].reason, /前の会話を確かに読み直せなかった/);
  assert.ok(ids.includes('one-plugin-generated') && ids.includes('main-model'));
  // 合否が一部の観点だけのものだと、統括が読む場所（終わりの状態の結果、outer-report.json の要約）にも示す
  assert.deepEqual([record.grading.verdict.partial, record.grading.verdict.notGraded], [true, CONVERSATION_GRADES]);
  assert.deepEqual(summarizeRecord(record).notGraded, CONVERSATION_GRADES);
  assert.deepEqual(readStatus(run.relayDir).result.notGraded, CONVERSATION_GRADES);
  // 続きから始めるのは、開発者が答えるときだけ
  await assert.rejects(runOuterOnce({ loaded: buildHumanLoaded({ requestFile: path.join(root, 'request.txt') }), runRoot: root, sandbox: false, query: sdk.query, resume: { runDir: run.runDir, prompt: 'x' } }), /開発者が答えるとき/);
});

test('REQ-015 文章の問いの答えを待つ間に止まった実行を続けると、その問いを記録し、続きの最初の発言をその問いへの答えにする。また続けても同じに読み直す', async (t) => {
  const root = tmp('text');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // 1 回目の手番の終わりの文章の問い（0002）の答えを待つ間に止まる
  const QUESTION = 'ほかに伝えておきたいことはありますか？';
  const run = await makeStoppedRun(root, { answers: (q) => (q.question === QUESTION ? null : firstAnswers(q)), pending: '0002' });
  assert.equal(run.calls.length, 1);
  abandonUnanswered(run.relayDir);
  const prompt = `（前の問い「${QUESTION}」への開発者の答え）ありません`;
  const rec2 = recordingQuery(createFakeSdk({ agent: async () => '続けました。' }).query);
  const record = await runOuterOnce({
    loaded: buildHumanLoaded({ requestFile: path.join(root, 'request.txt') }), runRoot: path.join(root, 'unused'), sandbox: false, query: rec2.query, model: 'claude-opus-5-5', runStages: okStages,
    answerer: 'human', maxExchanges: 2,
    createAnswerer: (args) => createHumanRelay({ relayDir: run.relayDir, signal: args.signal, pollMs: 5, runDir: args.runDir, workDir: args.workDir }),
    resume: { runDir: run.runDir, prompt, fromRelayId: '0002', abandoned: ['0002'] },
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(record.replay.reliable, true, JSON.stringify(record.replay.problems));
  const conv = (items) => items.filter((i) => ['creator.question-text', 'user.answer'].includes(i.kind)).map((i) => (i.kind === 'user.answer' ? ['answer', i.via, i.question, i.answer] : ['question', i.text]));
  const before = conv(record.items).slice(0, 3);
  assert.deepEqual(before, [
    ['answer', 'AskUserQuestion', '成果物は何ですか？', '成果物は weekly_report.md です'],
    ['question', QUESTION],
    ['answer', 'resume', QUESTION, prompt],
  ]);
  assert.deepEqual(readResumes(run.runDir).map((x) => x.question), [{ via: 'text', question: QUESTION, header: '' }]);

  // また続きから始めるとき（続けた会話がセッションの記録に足されている）も、同じ問いと答えに読み直す
  writeTranscript(path.join(run.runDir, 'agent-home'), path.join(run.runDir, 'work'), [...run.calls, ...rec2.calls]);
  const recorder = createRecorder();
  const r = replayTranscript({ file: run.transcript, recorder, messageRecorder: createMessageRecorder({ recorder, models: {}, subagents: {}, skills: [] }), resumes: readResumes(run.runDir) });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(conv(recorder.items).slice(0, 3), before);
  assert.equal(r.counts.resumeAnswers, 1);
});

test('REQ-015 読み直し：Claude Code が処理の前に断った記録のツールの呼び出しは記録しない。続きから始めたときに足す行は読み直さない', (t) => {
  const root = tmp('lines');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, `${SESSION}.jsonl`);
  let n = 0;
  let clock = Date.parse('2026-10-25T05:00:00.000Z');
  const line = (x) => ({ parentUuid: null, isSidechain: false, sessionId: SESSION, version: '2.1.310', uuid: `00000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`, timestamp: new Date((clock += 1000)).toISOString(), ...x });
  const assistant = (content, model = 'claude-opus-5-5', extra = {}) => line({ type: 'assistant', message: { model, role: 'assistant', type: 'message', content }, ...extra });
  const result = (id, content, extra = {}) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: true }] }, ...extra });
  const interrupted = "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. Check whether it took effect before relying on it or running it again.]";
  const lines = [
    line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: REQUEST }] }, promptSource: 'sdk' }),
    // 入力を JSON として読めず、Claude Code の本体が断った（記録のツールの処理まで届かない）
    assistant([{ type: 'tool_use', id: 'toolu_bad', name: T('record'), input: { __unparsedToolInput: { raw: '{' } } }]),
    result('toolu_bad', '<tool_use_error>InputValidationError: mcp__plugin-creator__record was called with input that could not be parsed as JSON</tool_use_error>', { toolUseResult: 'InputValidationError: JSON parse failed (1 bytes)' }),
    // 入力の形が違うと、Claude Code の本体が断った（入力は読めている）
    assistant([{ type: 'tool_use', id: 'toolu_bad2', name: T('progress'), input: { stage: 1 } }]),
    result('toolu_bad2', '<tool_use_error>InputValidationError: stage は文字です</tool_use_error>', { toolUseResult: 'InputValidationError: stage は文字です' }),
    // 記録のツールの処理が断った（動いている会話でも記録する）
    assistant([{ type: 'tool_use', id: 'toolu_refused', name: T('progress'), input: { items: [] } }]),
    result('toolu_refused', 'items が空です', { toolUseResult: 'Error: items が空です' }),
    assistant([{ type: 'text', text: '道具について聞きます。' }]),
    assistant([{ type: 'tool_use', id: 'toolu_ask', name: 'AskUserQuestion', input: { questions: [{ question: '道具を入れてよいですか？', header: '道具', multiSelect: false, options: [{ label: '入れてよい', description: '' }] }] } }]),
    // ここでプロセスが止まり、続きから始めたときに Claude Code が足した行
    { type: 'queue-operation', operation: 'enqueue', timestamp: new Date((clock += 1000)).toISOString(), sessionId: SESSION },
    result('toolu_ask', interrupted, { toolUseResult: interrupted, toolDenialKind: 'interrupted' }),
    assistant([{ type: 'text', text: 'No response requested.' }], '<synthetic>', { isApiErrorMessage: false }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: RESUME_PROMPT }] }, promptSource: 'sdk' }),
    assistant([{ type: 'text', text: '入れます。' }]),
  ];
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const recorder = createRecorder();
  const models = {};
  const r = replayTranscript({ file, recorder, messageRecorder: createMessageRecorder({ recorder, models, subagents: {}, skills: [] }), resumes: [{ prompt: RESUME_PROMPT, question: { via: 'AskUserQuestion', question: '道具を入れてよいですか？', header: '道具' } }] });
  assert.deepEqual([r.problems, r.warnings], [[], []]);
  // 記録のツールの呼び出しは、処理まで届いた 1 つだけ（動いている部品も、それだけを記録する）
  assert.deepEqual(r.toolEvents.map((e) => [e.type, e.tool, e.toolUseId, e.isError ?? null]), [['tool.call', 'progress', 'toolu_refused', null], ['tool.result', 'progress', 'toolu_refused', true]]);
  assert.equal(r.counts.rejectedCreatorToolCalls, 2);
  assert.equal(r.counts.syntheticLines, 2);
  // <synthetic> のモデルと文、中断の結果は記録しない
  assert.deepEqual(models, { main: ['claude-opus-5-5'] });
  assert.ok(!recorder.items.some((i) => i.kind === 'creator.text' && i.text === 'No response requested.'));
  assert.ok(!recorder.items.some((i) => i.kind === 'tool.result' && i.id === 'toolu_ask'));
  // 待っていた質問のツールの問いへの答えは、続きの最初の発言
  assert.deepEqual(recorder.items.filter((i) => i.kind === 'user.answer').map((i) => [i.via, i.header, i.question, i.answer]), [['resume', '道具', '道具を入れてよいですか？', RESUME_PROMPT]]);
  assert.deepEqual(r.pendingAsks, []);
  assert.equal(r.askGroups, 1);
  // 処理の前に断られた呼び出しも、会話の記録（ツールの呼び出しと結果）には残る（動いている会話の SDK のメッセージにも流れる）
  assert.ok(recorder.items.some((i) => i.kind === 'tool.result' && i.id === 'toolu_bad' && i.isError));
});
