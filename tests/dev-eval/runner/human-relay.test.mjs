// 開発者が答える外側の EVAL の中継（human-relay.mjs。testing.md 6.7）の試験。実際のモデルは使わない。
// 動かし方（リポジトリの根で）：node --test "tests/dev-eval/runner/human-relay.test.mjs"

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createFakeSdk } from './outer-fake-sdk.mjs';
import { STALE_MS, answerQuestion, checkWait, createHumanRelay, currentPidNs, finalizeRelayStatus, listQuestionIds, pendingQuestion, readStatus, startHeartbeat, writeRelayStatus } from './human-relay.mjs';
import { createUserRole } from './user-role.mjs';
import { tempDir } from './temp-dirs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, 'human-relay.mjs');
const tmp = (prefix) => tempDir(`human-relay-${prefix}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 条件が成り立つまで待つ（成り立たなければ落とす） */
async function until(fn, label, ms = 5000) {
  const started = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - started > ms) throw new Error(`待ちきれませんでした：${label}`);
    await sleep(5);
  }
}

const runCli = (args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 20_000 });
  return { code: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout) : null, stderr: r.stderr };
};

/** 終わったプロセスの番号（状態の pid が動いていないときの試験に使う） */
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

test('REQ-015 問いのファイル：見出し・問い・選択肢・複数選べるか・問いの前の文・欄の番号を書き、答えのファイルが置かれるまで待つ', async (t) => {
  const relayDir = tmp('question');
  t.after(() => fs.rmSync(relayDir, { recursive: true, force: true }));
  const relay = createHumanRelay({ relayDir, pollMs: 5, runDir: '/run', workDir: '/run/work' });
  assert.equal(readStatus(relayDir).state, 'running');
  assert.equal(readStatus(relayDir).pid, process.pid);
  assert.equal(readStatus(relayDir).workDir, '/run/work');

  let settled = false;
  const pending = relay.answer('どれを使いますか？', [{ label: 'A', description: 'a の説明' }, 'B'], 'AskUserQuestion', { header: '使うもの', multiSelect: true, group: 3, groupSize: 2 }, ['まとめです。', '  ', '足りなければ教えてください。']);
  pending.then(() => { settled = true; });
  await until(() => listQuestionIds(relayDir).length === 1, '問いのファイル');
  const q = JSON.parse(fs.readFileSync(path.join(relayDir, 'questions', '0001.json'), 'utf8'));
  assert.deepEqual({ ...q, askedAt: 'x' }, {
    id: '0001',
    index: 0,
    via: 'AskUserQuestion',
    header: '使うもの',
    question: 'どれを使いますか？',
    options: [{ label: 'A', description: 'a の説明' }, { label: 'B', description: '' }],
    multiSelect: true,
    notes: ['まとめです。', '足りなければ教えてください。'],
    group: 3,
    groupSize: 2,
    askedAt: 'x',
  });
  assert.ok(!Number.isNaN(Date.parse(q.askedAt)));
  const status = readStatus(relayDir);
  assert.equal(status.state, 'waiting');
  assert.equal(status.pending, '0001');
  assert.deepEqual(pendingQuestion(relayDir), q);
  // 答えが置かれるまで、答えは返らない
  await sleep(50);
  assert.equal(settled, false);
  answerQuestion(relayDir, '0001', 'A, B');
  const entry = await pending;
  assert.equal(entry.answer, 'A, B', '複数選べる問いの答え（名前を「, 」でつないだもの）を、そのまま返す');
  assert.equal(entry.rawAnswer, 'A, B');
  assert.equal(readStatus(relayDir).state, 'running');
  assert.equal(readStatus(relayDir).pending, null);
  assert.equal(pendingQuestion(relayDir), null);
});

test('REQ-015 答えの記録の形は、ユーザー役（createUserRole）の記録と同じ。費用は 0、急ぐ合図はない', async (t) => {
  const relayDir = tmp('shape');
  const home = tmp('home');
  t.after(() => { fs.rmSync(relayDir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });
  const persona = { profile: 'p', files: [], knowledge: [], styles: { normal: { label: 'n', instruction: '' } } };
  const sdk = createFakeSdk({ userRole: () => 'A, B' });
  const role = createUserRole({ persona, query: sdk.query, home });
  const relay = createHumanRelay({ relayDir, pollMs: 5 });
  const args = ['どれを使いますか？', [{ label: 'A', description: 'a' }, 'B'], 'AskUserQuestion', { header: '使うもの', multiSelect: true }, ['前の文']];
  const fromRole = await role.answer(...args);
  const waiting = relay.answer(...args);
  await until(() => pendingQuestion(relayDir), '問い');
  answerQuestion(relayDir, '0001', 'A, B');
  const fromRelay = await waiting;
  assert.deepEqual(fromRelay, { ...fromRole, cost: 0 });
  assert.deepEqual(relay.history, role.history);
  assert.deepEqual(relay.signals, []);
  assert.equal(relay.cost, 0);
  assert.equal(relay.answerCount, 1);
  assert.deepEqual(relay.answers, [fromRelay]);
});

test('REQ-015 問いは 1 つずつ、順に中継する：質問のツールの問いと文章の問いで、番号と index が続く', async (t) => {
  const relayDir = tmp('order');
  t.after(() => fs.rmSync(relayDir, { recursive: true, force: true }));
  const relay = createHumanRelay({ relayDir, pollMs: 5 });
  const first = relay.answer('1つ目', [{ label: 'はい', description: '' }], 'AskUserQuestion', { header: 'h', multiSelect: false, group: 1, groupSize: 1 }, []);
  const second = relay.answer('ほかに伝えておきたいことはありますか？', [], 'text', {}, ['ここまでのまとめです。']);
  await until(() => pendingQuestion(relayDir)?.id === '0001', '1 つ目の問い');
  await sleep(30);
  assert.deepEqual(listQuestionIds(relayDir), ['0001'], '前の問いに答えるまで、次の問いは書かない');
  answerQuestion(relayDir, '0001', 'はい');
  await until(() => pendingQuestion(relayDir)?.id === '0002', '2 つ目の問い');
  const q2 = pendingQuestion(relayDir);
  assert.equal(q2.index, 1);
  assert.equal(q2.via, 'text');
  assert.equal(q2.header, '');
  assert.deepEqual(q2.options, []);
  assert.equal(q2.multiSelect, false);
  assert.deepEqual(q2.notes, ['ここまでのまとめです。']);
  assert.equal(q2.group, null);
  assert.equal(q2.groupSize, null);
  answerQuestion(relayDir, '0002', '  先頭の空白も\n途中の改行も、そのまま  ');
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual([a.index, a.via, b.index, b.via], [0, 'AskUserQuestion', 1, 'text']);
  assert.equal(b.answer, '  先頭の空白も\n途中の改行も、そのまま  ', '開発者の答えは変えない');
  assert.equal(b.notes, 'ここまでのまとめです。');
  assert.equal(relay.answerCount, 2);
});

test('REQ-015 中断：答えを待つ間に中断されたら AbortError で断る。終わりの状態は、採点の後の finish まで書かない（phase は stopping）', async (t) => {
  const relayDir = tmp('abort');
  t.after(() => fs.rmSync(relayDir, { recursive: true, force: true }));
  const abort = new AbortController();
  const relay = createHumanRelay({ relayDir, pollMs: 5, signal: abort.signal });
  const waiting = relay.answer('問い', [], 'text', {}, []);
  await until(() => pendingQuestion(relayDir), '問い');
  abort.abort();
  await assert.rejects(waiting, (error) => error.name === 'AbortError');
  let status = readStatus(relayDir);
  assert.deepEqual([status.state, status.pending, status.phase, status.result], ['running', null, 'stopping', undefined], '採点が終わるまで、統括の wait は返らない');
  assert.equal(checkWait(relayDir), null);
  await assert.rejects(relay.answer('次の問い', [], 'text', {}, []), (error) => error.name === 'AbortError');
  assert.deepEqual(listQuestionIds(relayDir), ['0001']);
  relay.finish({ reason: 'interrupted', score: 0, recordFile: '/run/record.json' });
  status = readStatus(relayDir);
  assert.equal(status.state, 'stopped');
  assert.equal(status.phase, undefined, '終わりの状態に、途中の phase を残さない');
  assert.deepEqual(status.result, { reason: 'interrupted', score: 0, recordFile: '/run/record.json', finishedReason: 'interrupted' });
  assert.equal(checkWait(relayDir).code, 3);
});

test('REQ-015 終わりを入口に任せる形（deferTerminal）：finish は結果だけを書き、finalizeRelayStatus が記録の後に終わりにする', (t) => {
  const relayDir = tmp('defer');
  t.after(() => fs.rmSync(relayDir, { recursive: true, force: true }));
  const relay = createHumanRelay({ relayDir, heartbeatMs: 0, deferTerminal: true });
  relay.setStatus({ phase: 'grading' });
  relay.finish({ reason: 'generated', score: 0.5, recordFile: '/run/record.json' });
  let status = readStatus(relayDir);
  assert.deepEqual([status.state, status.phase, status.result.score], ['running', 'saving', 0.5]);
  assert.equal(checkWait(relayDir), null, '記録と outer-report.json を書き終えるまで、wait は返らない');
  finalizeRelayStatus(relayDir, { fallback: { reason: 'ended' }, extra: { reportFile: '/out/outer-report.json' } });
  status = readStatus(relayDir);
  assert.deepEqual([status.state, status.phase, status.reportFile, status.result.reason, status.result.recordFile], ['finished', undefined, '/out/outer-report.json', 'generated', '/run/record.json']);
  // もう終わっていれば、書き換えない
  finalizeRelayStatus(relayDir, { failure: { reason: 'failed', message: 'x' } });
  assert.equal(readStatus(relayDir).state, 'finished');

  // 結果がないまま終わったら fallback、入口が落ちたら failure で stopped
  const other = tmp('defer2');
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  writeRelayStatus(other, { state: 'starting', pid: process.pid });
  finalizeRelayStatus(other, { failure: { reason: 'failed', message: '依頼の文が空です' } });
  assert.deepEqual(readStatus(other).result, { reason: 'failed', message: '依頼の文が空です', finishedReason: 'failed' });
  assert.equal(readStatus(other).state, 'stopped');
});

test('REQ-015 終わり：会話が最後まで進んだら finished、ほかは stopped。結果（理由・最後の発言・点数）を状態に残す', (t) => {
  const relayDir = tmp('finish');
  t.after(() => fs.rmSync(relayDir, { recursive: true, force: true }));
  const relay = createHumanRelay({ relayDir });
  relay.finish({ reason: 'generated', lastText: '作りました。', score: 0.8 });
  assert.equal(readStatus(relayDir).state, 'finished');
  assert.deepEqual(readStatus(relayDir).result, { reason: 'generated', lastText: '作りました。', score: 0.8, finishedReason: 'generated' });
  relay.finish({ reason: 'usage_limit', message: '上限' });
  assert.equal(readStatus(relayDir).state, 'stopped');
  assert.equal(readStatus(relayDir).result.finishedReason, 'usage_limit');
});

test('REQ-015 統括のコマンド wait：答えのない問いがあれば 0 で問いを出す。終わったら 3、プロセスがなければ 4、時間切れは 5', async (t) => {
  const relayDir = tmp('wait');
  t.after(() => fs.rmSync(relayDir, { recursive: true, force: true }));
  // 状態がまだないときは待つ（時間切れで 5）
  assert.deepEqual(runCli(['wait', '--relay', relayDir, '--timeout-seconds', '0.2', '--poll-ms', '20']), { code: 5, out: { state: 'timeout' }, stderr: '' });

  const abort = new AbortController();
  const relay = createHumanRelay({ relayDir, pollMs: 5, signal: abort.signal });
  // 問いが出るまで待ち、出たら返す
  const child = spawn(process.execPath, [CLI, 'wait', '--relay', relayDir, '--poll-ms', '20'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  const exited = new Promise((resolve) => child.on('close', resolve));
  await sleep(150);
  const waiting = relay.answer('名前は？', [], 'text', {}, ['前の文']);
  assert.equal(await exited, 0);
  const q = JSON.parse(stdout);
  assert.equal(q.id, '0001');
  assert.equal(q.question, '名前は？');
  assert.deepEqual(q.notes, ['前の文']);
  // 何度呼んでも、答えるまでは同じ問いを返す
  assert.equal(runCli(['wait', '--relay', relayDir, '--poll-ms', '20']).out.id, '0001');
  answerQuestion(relayDir, '0001', '週報です');
  await waiting;
  assert.equal(runCli(['wait', '--relay', relayDir, '--timeout-seconds', '0.2', '--poll-ms', '20']).code, 5);

  // 終わったら 3 で状態を出す（中断で残った答えのない問いがあっても、問いとしては返さない）
  const leftover = relay.answer('残る問い', [], 'text', {}, []);
  leftover.catch(() => {});
  await until(() => pendingQuestion(relayDir), '残る問い');
  abort.abort(); // 待ちを止める（試験のプロセスが終わるように）。問いのファイルは答えのないまま残る
  relay.finish({ reason: 'generated', lastText: '作りました。' });
  const done = runCli(['wait', '--relay', relayDir, '--poll-ms', '20']);
  assert.equal(done.code, 3);
  assert.equal(done.out.state, 'finished');
  assert.equal(done.out.result.lastText, '作りました。');

  // 終わりを書かずにプロセスがなくなったら 4
  writeRelayStatus(relayDir, { state: 'waiting', pid: deadPid() });
  const dead = runCli(['wait', '--relay', relayDir, '--poll-ms', '20']);
  assert.equal(dead.code, 4);
  assert.equal(dead.out.state, 'dead');
  assert.equal(dead.out.deadBy, 'pid');
  assert.equal(dead.stderr, '');
});

test('REQ-015 wait のプロセスの確かめ：番号の空間が違う（サンドボックスの中と外）ときは pid ではなく heartbeatAt で見る', async (t) => {
  const relayDir = tmp('pidns');
  t.after(() => fs.rmSync(relayDir, { recursive: true, force: true }));
  const relay = createHumanRelay({ relayDir, pollMs: 5 });
  const waiting = relay.answer('名前は？', [], 'text', {}, []);
  waiting.catch(() => {});
  await until(() => pendingQuestion(relayDir), '問い');
  const status = readStatus(relayDir);
  assert.equal(status.pidNs, currentPidNs());
  assert.ok(!Number.isNaN(Date.parse(status.heartbeatAt)));
  // 統括の wait が別の空間で動くと、試験の仕組みの番号は、そこでは別のプロセスか、ないプロセスを指す
  writeRelayStatus(relayDir, { pid: deadPid() });
  const otherNs = { pidNs: 'pid:[1]' };
  assert.equal(checkWait(relayDir, otherNs).code, 0, '別の空間では、番号がなくても、heartbeatAt が新しければ問いを返す');
  assert.equal(checkWait(relayDir, { ...otherNs, now: Date.now() + STALE_MS + 1000 }).code, 4, 'heartbeatAt が古くなったら、プロセスがない');
  assert.equal(checkWait(relayDir, { ...otherNs, now: Date.now() + STALE_MS + 1000 }).output.deadBy, 'heartbeat');
  assert.equal(checkWait(relayDir).output.deadBy, 'pid', '同じ空間なら、番号で見る');
  // heartbeatAt は、updatedAt を変えずに書き直す
  writeRelayStatus(relayDir, { pid: process.pid });
  const before = readStatus(relayDir);
  const stop = startHeartbeat(relayDir, 10);
  await until(() => readStatus(relayDir).heartbeatAt !== before.heartbeatAt, 'heartbeatAt');
  stop();
  assert.equal(readStatus(relayDir).updatedAt, before.updatedAt);
  // コマンドの --stale-seconds
  fs.writeFileSync(path.join(relayDir, 'status.json'), JSON.stringify({ ...readStatus(relayDir), pidNs: 'pid:[1]', heartbeatAt: new Date(Date.now() - 5000).toISOString() }));
  assert.equal(runCli(['wait', '--relay', relayDir, '--poll-ms', '20', '--stale-seconds', '1']).code, 4);
  assert.equal(runCli(['wait', '--relay', relayDir, '--poll-ms', '20', '--stale-seconds', '60']).code, 0);
  assert.equal(runCli(['wait', '--relay', relayDir, '--stale-seconds', '0']).code, 2);
  answerQuestion(relayDir, '0001', 'x');
  await waiting;
});

test('REQ-015 じかに書かれた形の誤った答えのファイル：wait と status は答えのない問いとして返し（invalidAnswer）、answer で置き直せる', async (t) => {
  const relayDir = tmp('invalid');
  t.after(() => fs.rmSync(relayDir, { recursive: true, force: true }));
  const relay = createHumanRelay({ relayDir, pollMs: 5 });
  const waiting = relay.answer('名前は？', [], 'text', {}, []);
  await until(() => pendingQuestion(relayDir), '問い');
  fs.writeFileSync(path.join(relayDir, 'answers', '0001.json'), JSON.stringify({ text: 'はい' }));
  await sleep(30);
  const q = pendingQuestion(relayDir);
  assert.equal(q.id, '0001');
  assert.match(q.invalidAnswer, /形が誤っています/);
  const w = runCli(['wait', '--relay', relayDir, '--poll-ms', '20']);
  assert.equal(w.code, 0);
  assert.match(w.out.invalidAnswer, /answer のコマンドで置き直して/);
  assert.match(runCli(['status', '--relay', relayDir]).out.pending.invalidAnswer, /形が誤っています/);
  assert.deepEqual(runCli(['answer', '--relay', relayDir, '--id', '0001', '--text', 'はい']).out, { ok: true, replaced: true });
  assert.equal((await waiting).answer, 'はい');
  assert.equal(pendingQuestion(relayDir), null);
  assert.match(runCli(['answer', '--relay', relayDir, '--id', '0001', '--text', 'いいえ']).out.message, /もう答えています/);
});

test('REQ-015 統括のコマンド answer：答えのファイルを置く。問いがない・もう答えた・答えが空なら断る。--text-file は最後の改行だけを除く', async (t) => {
  const relayDir = tmp('answer');
  const files = tmp('files');
  t.after(() => { fs.rmSync(relayDir, { recursive: true, force: true }); fs.rmSync(files, { recursive: true, force: true }); });
  const relay = createHumanRelay({ relayDir, pollMs: 5 });
  const first = relay.answer('問い1', [], 'text', {}, []);
  await until(() => pendingQuestion(relayDir), '問い1');

  const unknown = runCli(['answer', '--relay', relayDir, '--id', '0009', '--text', 'x']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.out.message, /問い 0009 はありません/);
  const empty = runCli(['answer', '--relay', relayDir, '--id', '0001', '--text', ' \n ']);
  assert.equal(empty.code, 2);
  assert.match(empty.out.message, /答えが空/);
  assert.equal(runCli(['answer', '--relay', relayDir, '--id', '../x', '--text', 'x']).code, 2);
  assert.equal(runCli(['answer', '--relay', relayDir, '--id', '0001']).code, 2, '--text か --text-file が要る');
  assert.equal(fs.existsSync(path.join(relayDir, 'answers', '0001.json')), false);

  const ok = runCli(['answer', '--relay', relayDir, '--id', '0001', '--text', 'A, B ']);
  assert.deepEqual(ok, { code: 0, out: { ok: true }, stderr: '' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(relayDir, 'answers', '0001.json'), 'utf8')), { answer: 'A, B ' });
  assert.deepEqual(fs.readdirSync(path.join(relayDir, 'answers')), ['0001.json'], '一時ファイルが残らない');
  const again = runCli(['answer', '--relay', relayDir, '--id', '0001', '--text', 'y']);
  assert.equal(again.code, 2);
  assert.match(again.out.message, /もう答えています/);
  assert.equal((await first).answer, 'A, B ');

  const second = relay.answer('問い2', [], 'text', {}, []);
  await until(() => pendingQuestion(relayDir), '問い2');
  const textFile = path.join(files, 'answer.txt');
  fs.writeFileSync(textFile, '1行目\n\n3行目\n');
  assert.equal(runCli(['answer', '--relay', relayDir, '--id', '0002', '--text-file', textFile]).code, 0);
  assert.equal((await second).answer, '1行目\n\n3行目');
  assert.equal(runCli(['answer', '--relay', relayDir, '--id', '0003', '--text-file', path.join(files, 'ない.txt')]).code, 2);
});

test('REQ-015 統括のコマンド status：状態と、答えを待っている問いを出す。中継のフォルダに状態がなければ断る', async (t) => {
  const relayDir = tmp('status');
  t.after(() => fs.rmSync(relayDir, { recursive: true, force: true }));
  assert.equal(runCli(['status', '--relay', relayDir]).code, 2);
  const relay = createHumanRelay({ relayDir, pollMs: 5, runDir: '/r', workDir: '/r/work' });
  let r = runCli(['status', '--relay', relayDir]);
  assert.equal(r.code, 0);
  assert.equal(r.out.status.state, 'running');
  assert.equal(r.out.status.workDir, '/r/work');
  assert.equal(r.out.pending, null);
  const waiting = relay.answer('問い', [{ label: 'はい', description: '' }], 'AskUserQuestion', { header: 'h', multiSelect: false }, []);
  await until(() => pendingQuestion(relayDir), '問い');
  r = runCli(['status', '--relay', relayDir]);
  assert.equal(r.out.status.state, 'waiting');
  assert.equal(r.out.status.pending, '0001');
  assert.equal(r.out.pending.question, '問い');
  answerQuestion(relayDir, '0001', 'はい');
  await waiting;
  assert.equal(runCli(['wat', '--relay', relayDir]).code, 2);
  assert.equal(runCli(['status']).code, 2, '--relay が要る');
});
