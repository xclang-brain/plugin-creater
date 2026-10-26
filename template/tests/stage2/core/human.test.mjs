// 中心の処理：人の判断待ち（設計書 4.15、6.1、10章「人の判断待ち」）
// 統括が質問を記録して手番を終えても実行は終わらず、メインのエージェントが渡した答えを同じ統括に送って、同じ実行を続ける。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { LIMITS, expectRefusal, makeHarness, slotOf } from './harness.mjs';

const QUESTION = '試行 1 のビルドが失敗しました（ツールチェーンが見つかりません）。どうしますか？';
const ANSWER = 'ツールチェーンのパスは /opt/arm/bin です。続けて';

// 統括が手番を終える。初めの手番の終わりは completed と idle の 2 つ、2回目からは idle だけ（11章 #19）
async function rootTurnEnd(h, { first = true, response = `人の判断待ち\n${QUESTION}` } = {}) {
  h.port.setStatus(h.root, 'idle');
  if (first) await h.event({ type: 'agent.completed', agentId: h.root, cancelled: false, response });
  await h.event({ type: 'agent.idle', agentId: h.root, ...(first ? {} : { response }) });
}

// 試行 1 を不合格で終え、統括が質問を記録して手番を終えた状態にする
async function toWaiting(h, extra = {}) {
  await h.begin(extra);
  await h.iterate(1, { pass: false });
  const text = await h.tool('ask', { question: QUESTION }, h.root);
  assert.match(text, /人の判断待ち/);
  await rootTurnEnd(h);
}

const answer = (h, text = ANSWER, agentId) => h.core.relayHumanAnswer({ answer: text }, { agentId });
const logOf = (h, runId) =>
  readFileSync(join(h.dataRoot, runId, 'log.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

test('REQ-051 質問を記録した統括が手番を終えると、実行は終わらず「人の判断待ち」になり、統括は取り消されない', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  const run = h.run();
  assert.equal(run.status, 'waiting_human');
  assert.equal(run.endReason, null);
  assert.equal(h.port.callsOf('cancelAgent').length, 0, '待っている統括は取り消さない');
  assert.equal(h.port.task(h.root).status, 'idle');
  assert.equal(slotOf(run, 'orchestrator').status, 'waiting_human');
  assert.deepEqual(run.humanWait, { question: QUESTION, askedAt: run.humanWait.askedAt, iteration: 1, waiting: true });
  assert.equal(run.phase, null, '待っているあいだは、計画・実行・評価のどれでもない');
  assert.ok(h.state().notices.length > 0, '実行中の注意（/clear しない、チャットで答える）は出たまま');
  // 初めの手番の終わりの 2 つ目のイベントが、さらに遅れて届いても、待ちのまま
  await h.event({ type: 'agent.idle', agentId: h.root });
  assert.equal(h.run().status, 'waiting_human');
});

test('REQ-051 質問を記録していない手番の終わりは、これまでどおり実行を終える', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  await h.iterate(1, { pass: false });
  await rootTurnEnd(h);
  const run = h.run();
  assert.equal(run.status, 'finished');
  assert.deepEqual([run.endReason.kind, run.endReason.detail], ['aborted', 'orchestrator_ended']);
});

test('REQ-051 答えを渡すと、質問と答え（言い換えない）を入れた文が同じ統括に送られ、同じ実行が続いて、結果が 1 つの実行にまとまる', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h, { maxIterations: 3 });
  const runId = h.run().id;
  const text = await answer(h);
  assert.match(text, /渡しました/);
  const [[agentId, message]] = h.port.callsOf('sendMessage').map((c) => c.args);
  assert.equal(agentId, h.root, '待っている統括に送る');
  assert.ok(message.includes(QUESTION), '質問が入る');
  assert.ok(message.includes(`答え：\n${ANSWER}`), '答えがそのまま入る');
  let run = h.run();
  assert.equal(run.status, 'running');
  assert.equal(run.humanWait, null);
  assert.equal(slotOf(run, 'orchestrator').status, 'running');
  // 同じ統括が、待つ前の続きから進める。試行の番号は 2、上限は 3 のまま
  await h.event({ type: 'tool.started', agentId: h.root, toolCallId: 'tc-r1', toolName: 'weekly-report_plan', arguments: {} });
  await expectRefusal(h.tool('plan', h.planArgs(1), h.root));
  await h.iterate(2);
  run = h.run();
  assert.equal(run.status, 'summarizing');
  assert.equal(run.maxIterations, 3);
  await h.tool('review', {}, h.root);
  await h.tool('finish', { summary: '人の答えの後に、2回目で合格しました' }, h.root);
  await rootTurnEnd(h, { first: false, response: '実行の番号：x' });
  run = h.run();
  assert.equal(run.status, 'finished');
  assert.equal(run.id, runId, '同じ実行');
  assert.deepEqual([run.endReason.kind, run.endReason.detail], ['all_passed', null]);
  assert.deepEqual(run.iterations.map((i) => i.n), [1, 2], '待つ前と後の試行が 1 つの実行にまとまる');
  assert.equal(h.port.callsOf('startAgent').length, 1, '統括を起動し直さない');
  const log = logOf(h, runId);
  assert.ok(log.some((e) => e.t === 'human_answer' && e.answer === ANSWER && e.question === QUESTION), '記録に答えが残る');
  assert.deepEqual(
    log.filter((e) => e.t === 'status').map((e) => e.status),
    ['running', 'waiting_human', 'running', 'finished'],
  );
});

test('REQ-051 1 つの実行の中で、何回でも人の判断を待てる。2回目からの手番の終わり（idle だけ）でも待ちになる', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  await answer(h);
  await h.tool('ask', { question: 'もう一度聞きます。どうしますか？' }, h.root);
  await rootTurnEnd(h, { first: false });
  assert.equal(h.run().status, 'waiting_human');
  assert.equal(h.run().humanWait.question, 'もう一度聞きます。どうしますか？');
  assert.equal(slotOf(h.run(), 'orchestrator').replySummary.startsWith('人の判断待ち'), true, '2回目からの手番の返事も、枠に出る');
  await answer(h, '止めずに続けて');
  assert.equal(h.run().status, 'running');
  assert.equal(h.port.callsOf('sendMessage').length, 2);
});

test('REQ-051 答えを送れなかった（sent が偽）ときは、「途中で終わった（人の答えを統括エージェントに渡せなかった）」になる', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  h.port.behave('sendMessage', { value: { sent: false, error: 'Agent not found or not accepting messages' } });
  const reason = await expectRefusal(answer(h));
  assert.match(reason, /渡せませんでした/);
  await h.settle();
  const run = h.run();
  assert.equal(run.status, 'finished');
  assert.deepEqual([run.endReason.kind, run.endReason.detail], ['aborted', 'answer_not_delivered']);
  assert.deepEqual(h.port.argsOf('cancelAgent'), [h.root], '待ちで残っていた統括は取り消す');
  assert.ok(run.issues.some((i) => i.title.includes('人の答えを統括エージェントに渡せなかった')));
});

test('REQ-051 答えを送る呼び出しが失敗したときも、「途中で終わった（人の答えを統括エージェントに渡せなかった）」になる', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  h.port.behave('sendMessage', { error: new Error('method not found') });
  await expectRefusal(answer(h));
  await h.settle();
  assert.deepEqual([h.run().endReason.kind, h.run().endReason.detail], ['aborted', 'answer_not_delivered']);
});

test('REQ-051 答えを送る呼び出しが時間切れのときは、待ちのまま。統括の動きが届くと実行中に戻る', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  h.port.behave('sendMessage', { hang: true, times: 1 });
  const pending = expectRefusal(answer(h));
  await h.clock.advance(LIMITS.CALL_TIMEOUT_MS + 1);
  assert.match(await pending, /分かりませんでした/);
  assert.equal(h.run().status, 'waiting_human');
  await h.event({ type: 'tool.started', agentId: h.root, toolCallId: 'tc-r1', toolName: 'view', arguments: { path: 'a' } });
  assert.equal(h.run().status, 'running');
  assert.equal(h.run().humanWait, null);
});

test('REQ-051 時間切れの後に、統括が記録のツールを呼んでも、実行中に戻って記録される', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  h.port.behave('sendMessage', { hang: true, times: 1 });
  const pending = expectRefusal(answer(h));
  await h.clock.advance(LIMITS.CALL_TIMEOUT_MS + 1);
  await pending;
  assert.match(await h.tool('plan', h.planArgs(2), h.root), /記録しました/);
  assert.equal(h.run().status, 'running');
});

test('REQ-051 時間切れの後に、統括がツールを使わずに手番を終えたら、待ちのまま残さず、ふだんの手番の終わりとして扱う', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  h.port.behave('sendMessage', { hang: true, times: 1 });
  const pending = expectRefusal(answer(h));
  await h.clock.advance(LIMITS.CALL_TIMEOUT_MS + 1);
  await pending;
  h.port.setStatus(h.root, 'running');
  await rootTurnEnd(h, { first: false, response: '分かりました' });
  await h.settle();
  const run = h.run();
  assert.equal(run.status, 'finished', '答えが届いて動いた統括の手番の終わり。待ちの 2 つ目のイベントとして見送らない');
  assert.deepEqual([run.endReason.kind, run.endReason.detail], ['aborted', 'orchestrator_ended']);
});

test('REQ-051 時間切れの後にもう一度答えたとき、統括が動いていれば（前の答えが届いていた）、もう一度は送らない', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  h.port.behave('sendMessage', { hang: true, times: 1 });
  const pending = expectRefusal(answer(h));
  await h.clock.advance(LIMITS.CALL_TIMEOUT_MS + 1);
  await pending;
  h.port.setStatus(h.root, 'running');
  assert.match(await answer(h, 'もう一度：続けて'), /届いていました/);
  assert.equal(h.port.callsOf('sendMessage').length, 1, '答えが 2 回届かない');
  assert.equal(h.run().status, 'running');
  assert.equal(h.run().humanWait, null);
});

test('REQ-051 時間切れの後にもう一度答えたとき、統括が待ったままなら、もう一度送る', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  h.port.behave('sendMessage', { hang: true, times: 1 });
  const pending = expectRefusal(answer(h));
  await h.clock.advance(LIMITS.CALL_TIMEOUT_MS + 1);
  await pending;
  assert.match(await answer(h), /渡しました/);
  assert.equal(h.port.callsOf('sendMessage').length, 2);
  assert.equal(h.run().status, 'running');
});

test('REQ-051 人の判断待ちのあいだに、統括でないエージェントが記録のツールを呼んでも、待ちのまま', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  await h.tool('plan', h.planArgs(1), h.root);
  const worker = await h.spawn('worker');
  await h.tool('ask', { question: QUESTION }, h.root);
  await rootTurnEnd(h);
  assert.equal(h.run().status, 'waiting_human');
  await h.tool('show', { key: 'no-such-key', value: 'x' }, worker).catch(() => {});
  assert.equal(h.run().status, 'waiting_human');
  assert.equal(h.run().humanWait.question, QUESTION);
});

test('REQ-051 人の判断を求める質問の記録の決まり：統括だけ、繰り返しの途中だけ、答えを待っている質問がないときだけ', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  await h.tool('plan', h.planArgs(1), h.root);
  const worker = await h.spawn('worker');
  assert.match(await expectRefusal(h.tool('ask', { question: QUESTION }, worker)), /統括エージェントだけ/);
  assert.match(await expectRefusal(h.tool('ask', { question: '  ' }, h.root)), /質問の文/);
  await h.tool('ask', { question: QUESTION }, h.root);
  assert.match(await expectRefusal(h.tool('ask', { question: 'もう1つ' }, h.root)), /答えを待っている質問があります/);
  assert.equal(h.run().status, 'running', '手番を終えるまでは、実行中のまま');

  const g = await makeHarness(t);
  await g.toSummarizing();
  assert.match(await expectRefusal(g.tool('ask', { question: QUESTION }, g.root)), /まとめの間は/);
});

test('REQ-051 答えを渡すツールの決まり：人の判断待ちのときだけ、この実行のエージェントからは渡せない、答えが空なら断る', async (t) => {
  const h = await makeHarness(t);
  assert.match(await expectRefusal(answer(h)), /人の判断を待っていません/, '実行がない');
  await h.begin();
  await h.tool('plan', h.planArgs(1), h.root);
  assert.match(await expectRefusal(answer(h)), /人の判断を待っていません/, '実行中だが待っていない');
  await h.tool('ask', { question: QUESTION }, h.root);
  assert.match(await expectRefusal(answer(h)), /人の判断を待っていません/, '統括がまだ手番を終えていない');
  await rootTurnEnd(h);
  assert.match(await expectRefusal(answer(h, ANSWER, h.root)), /メインのエージェントが渡します/, '統括からは渡せない');
  assert.match(await expectRefusal(answer(h, '   ')), /答えの文/);
  assert.equal(h.port.callsOf('sendMessage').length, 0);
  assert.equal(h.run().status, 'waiting_human');
});

test('REQ-051 人の判断待ちのあいだに止めると、待っている統括が取り消され、「ユーザーが止めた」になる。答えは渡せない', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  h.core.stop();
  await h.settle();
  await h.clock.advance(LIMITS.STOP_POLL_MS);
  const run = h.run();
  assert.deepEqual(h.port.argsOf('cancelAgent'), [h.root]);
  assert.equal(run.status, 'finished');
  assert.deepEqual([run.endReason.kind, run.endReason.unstoppable], ['user_stopped', false]);
  assert.equal(slotOf(run, 'orchestrator').status, 'stopped');
  assert.equal(run.humanWait, null);
  assert.match(await expectRefusal(answer(h)), /人の判断を待っていません/);
});

test('REQ-051 人の判断待ちのあいだに、統括がチャットから取り消されると「途中で終わった（チャットから中断された）」になる', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  h.port.setStatus(h.root, 'cancelled');
  await h.event({ type: 'agent.completed', agentId: h.root, cancelled: true });
  assert.deepEqual([h.run().endReason.kind, h.run().endReason.detail], ['aborted', 'chat_interrupted']);
});

test('REQ-051 人の判断を待っていた時間は、エージェントが動かなかった課題に入らない', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  await h.clock.advance(LIMITS.STALL_MS * 4);
  await answer(h);
  await h.event({ type: 'tool.started', agentId: h.root, toolCallId: 'tc-r1', toolName: 'view', arguments: { path: 'a' } });
  await h.iterate(2);
  await h.tool('finish', { summary: 'まとめ' }, h.root);
  await rootTurnEnd(h, { first: false });
  const run = h.run();
  assert.equal(run.status, 'finished');
  assert.ok(!run.issues.some((i) => i.title.includes('動きませんでした')), run.issues.map((i) => i.title).join(' / '));

  // 比べ：待ちでないときに同じだけ動かなければ、課題に入る（洗い出しそのものは働いている）
  const g = await makeHarness(t);
  await g.begin();
  await g.iterate(1, { pass: false });
  await g.clock.advance(LIMITS.STALL_MS * 4);
  await g.event({ type: 'tool.started', agentId: g.root, toolCallId: 'tc-g1', toolName: 'view', arguments: { path: 'a' } });
  await g.iterate(2);
  await g.tool('finish', { summary: 'まとめ' }, g.root);
  await g.rootIdle();
  assert.ok(g.run().issues.some((i) => i.title.includes('統括エージェントが') && i.title.includes('動きませんでした')));
});

test('REQ-051 人の判断待ちのまま止めて終わっても、待っていた時間は課題に入らない', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  await h.clock.advance(LIMITS.STALL_MS * 2);
  h.core.stop();
  await h.settle();
  await h.clock.advance(LIMITS.STOP_POLL_MS);
  assert.ok(!h.run().issues.some((i) => i.title.includes('動きませんでした')), h.run().issues.map((i) => i.title).join(' / '));
});

// ---- 人が終えるよう答えたとき（4.15） --------------------------------------------------------------

const END = { endedByHuman: true };

// 試行 1 の作業の後（合否の記録の前）に、統括が人に聞いて手番を終えた状態にする（例：ビルドが失敗した）
async function toWaitingBeforeVerdict(h, extra = {}) {
  await h.begin(extra);
  await h.tool('plan', h.planArgs(1), h.root);
  const worker = await h.spawn('worker');
  await h.complete(worker);
  await h.tool('ask', { question: QUESTION }, h.root);
  await rootTurnEnd(h);
}

test('REQ-051 人が終えるよう答えると、印を付けた _review で繰り返しの途中でもまとめに進み、「人の指示で終えた」で終わる。試行・まとめ・統括の Issue の案が残る', async (t) => {
  const h = await makeHarness(t);
  await toWaitingBeforeVerdict(h, { maxIterations: 3 });
  await answer(h, 'やめて');
  const review = await h.tool('review', END, h.root);
  assert.match(review, /機械的に洗い出した課題/);
  assert.match(review, /試行 1：合否の記録がありません/);
  assert.equal(h.run().status, 'summarizing');
  const verifier = await h.spawn('verifier');
  assert.match(await expectRefusal(h.tool('verdict', h.verdictArgs(1, { pass: false }), verifier)), /繰り返しはもう終わっています/);
  await h.complete(verifier);
  await h.tool('issue', { title: 'ビルドの道具の場所を設定で渡せるようにする', body: 'ビルドの道具が見つからず、人に聞きました。' }, h.root);
  await h.tool('finish', { summary: '人の指示で、試行 1 の途中で終えました。' }, h.root);
  await rootTurnEnd(h, { first: false, response: '実行の番号：x' });
  const run = h.run();
  assert.equal(run.status, 'finished');
  assert.deepEqual([run.endReason.kind, run.endReason.detail], ['human_ended', null]);
  assert.equal(run.summary, '人の指示で、試行 1 の途中で終えました。');
  assert.deepEqual(run.iterations.map((i) => i.n), [1], 'それまでの試行が残る');
  assert.ok(run.issues.some((i) => i.source === 'orchestrator' && i.title === 'ビルドの道具の場所を設定で渡せるようにする'), '統括の Issue の案が残る');
  const titles = run.issues.map((i) => i.title).join(' / ');
  assert.ok(!run.issues.some((i) => i.title.includes('試行 1') || i.title.includes('途中で終わりました') || i.title.includes('まとめを記録しない')), titles);
  assert.deepEqual(h.port.argsOf('cancelAgent'), [h.root], '残った統括は取り消す');
});

test('REQ-051 人の答えが届いていない実行では、印を付けた _review は断られ、繰り返しを抜けられない', async (t) => {
  const h = await makeHarness(t);
  await h.begin({ maxIterations: 3 });
  await h.iterate(1, { pass: false });
  assert.match(await expectRefusal(h.tool('review', END, h.root)), /いまは endedByHuman を付けられません/);
  assert.match(await expectRefusal(h.tool('finish', { summary: 'まとめ' }, h.root)), /まだ繰り返しの途中です/);
  assert.equal(h.run().status, 'running');
  // 質問を記録しても、答えが届く前は断る（答えを待つよう返す）
  await h.tool('ask', { question: QUESTION }, h.root);
  assert.match(await expectRefusal(h.tool('review', END, h.root)), /答えを待っている質問があります/);
  assert.equal(h.run().status, 'running');
});

test('REQ-051 答えを待っている質問があるときは、印を付けた _review は断られる。印のない _review の断りには、印のことが添えられる', async (t) => {
  const h = await makeHarness(t);
  await toWaitingBeforeVerdict(h, { maxIterations: 3 });
  await answer(h, 'このまま続けて');
  assert.match(await expectRefusal(h.tool('review', {}, h.root)), /まだ繰り返しの途中です[\s\S]*endedByHuman/);
  await h.tool('ask', { question: 'もう一度聞きます。終えますか、続けますか？' }, h.root);
  assert.match(await expectRefusal(h.tool('review', END, h.root)), /答えを待っている質問があります/);
  assert.equal(h.run().status, 'running');
  await rootTurnEnd(h, { first: false });
  await answer(h, 'ここで終わりにして');
  await h.tool('review', END, h.root);
  assert.equal(h.run().status, 'summarizing');
});

test('REQ-051 まとめ中の印は、終わった理由を変えない（繰り返しは合否の記録で終わっている）', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h, { maxIterations: 3 });
  await answer(h, '続けて');
  await h.iterate(2);
  assert.equal(h.run().status, 'summarizing');
  await h.tool('review', END, h.root);
  await h.tool('finish', { summary: 'まとめ' }, h.root);
  await rootTurnEnd(h, { first: false });
  assert.deepEqual([h.run().endReason.kind, h.run().endReason.detail], ['all_passed', null]);
});

test('REQ-051 人の指示で終えた後に、統括がまとめを記録しないまま終わると、「人の指示で終えた」のまま「まとめのない終わり」が課題に出る', async (t) => {
  const h = await makeHarness(t);
  await toWaitingBeforeVerdict(h);
  await answer(h, 'やめて');
  await h.tool('review', END, h.root);
  await rootTurnEnd(h, { first: false });
  const run = h.run();
  assert.deepEqual([run.endReason.kind, run.endReason.detail], ['human_ended', null]);
  assert.ok(run.issues.some((i) => i.title.includes('まとめを記録しない')), run.issues.map((i) => i.title).join(' / '));
  assert.match(run.summary, /試行は 1 回です/, 'まとめは記録から機械的に作る');
});

test('REQ-051 人の指示で終えた後のまとめ中に止めると、「ユーザーが止めた」になる（止めるボタンの振る舞いは変わらない）', async (t) => {
  const h = await makeHarness(t);
  await toWaitingBeforeVerdict(h);
  await answer(h, 'やめて');
  await h.tool('review', END, h.root);
  await h.tool('issue', { title: '案', body: '本文' }, h.root);
  h.core.stop();
  await h.settle();
  await h.clock.advance(LIMITS.STOP_POLL_MS);
  const run = h.run();
  assert.deepEqual([run.endReason.kind, run.endReason.unstoppable], ['user_stopped', false]);
  assert.ok(!run.issues.some((i) => i.source === 'orchestrator'), '止めたときは、統括の案を出さない');
});

test('REQ-051 答えの送りが時間切れの後に、統括が印を付けた _review を呼んでも受け付ける（答えが届いて動き出した）', async (t) => {
  const h = await makeHarness(t);
  await toWaitingBeforeVerdict(h);
  h.port.behave('sendMessage', { hang: true, times: 1 });
  const pending = expectRefusal(answer(h, 'やめて'));
  await h.clock.advance(LIMITS.CALL_TIMEOUT_MS + 1);
  await pending;
  assert.equal(h.run().status, 'waiting_human');
  await h.tool('review', END, h.root);
  assert.equal(h.run().status, 'summarizing');
});

test('REQ-051 統括に送る答えの文に、終えるよう言う答えのときはまとめに進むことが入る', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  await answer(h, 'やめて');
  const [[, message]] = h.port.callsOf('sendMessage').map((c) => c.args);
  assert.match(message, /^人の判断の答えが届きました。/);
  assert.match(message, /ここで終えるよう言っているときは[\s\S]*まとめに進んでください/);
  assert.ok(message.endsWith('答え：\nやめて'), '答えはそのまま入る');
});

test('REQ-051 答えを渡さないまま、待っている統括が動き出しても、人の答えが届いたとはみず、印を付けた _review は断られる', async (t) => {
  const h = await makeHarness(t);
  await toWaitingBeforeVerdict(h, { maxIterations: 3 });
  // <名前>_answer を通らずに、統括が動き出した（例：メインのエージェントが直接メッセージを送った）
  await h.event({ type: 'tool.started', agentId: h.root, toolCallId: 'tc-x1', toolName: 'weekly-report_review', arguments: {} });
  assert.equal(h.run().status, 'running');
  assert.match(await expectRefusal(h.tool('review', END, h.root)), /いまは endedByHuman を付けられません/);
  assert.equal(h.run().status, 'running');
});

test('REQ-051 「続けて」と答えた後に計画が記録されると、後で印を付けた _review は断られ、「まだ繰り返しの途中です」の断りに印のことが添えられない', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h, { maxIterations: 3 });
  await answer(h, '続けて');
  await h.iterate(2, { pass: false });
  assert.equal(h.run().status, 'running');
  const reason = await expectRefusal(h.tool('review', END, h.root));
  assert.match(reason, /いまは endedByHuman を付けられません/);
  assert.match(reason, /weekly-report_ask で、ここで終えるかを聞いてください/, '終えるには聞き直すよう返す');
  assert.match(reason, /いまここで終えるよう言っていたのに[\s\S]*weekly-report_ask で、ここで終えるかを聞き直してください/, '順を間違えたときも、聞き直すよう返す');
  const plain = await expectRefusal(h.tool('review', {}, h.root));
  assert.match(plain, /まだ繰り返しの途中です/);
  assert.doesNotMatch(plain, /endedByHuman/, '印を受け付けないときは、印のことを添えない');
  assert.doesNotMatch(await expectRefusal(h.tool('finish', { summary: 'まとめ' }, h.root)), /endedByHuman/);
  assert.equal(h.run().status, 'running');
});

test('REQ-051 終えるよう言う答えの直後なら、ファイルを読んだり、印を付け忘れた _review が断られたりした後でも、印を付けた _review を受け付ける', async (t) => {
  const h = await makeHarness(t);
  await toWaitingBeforeVerdict(h, { maxIterations: 3 });
  await answer(h, 'やめて');
  await h.event({ type: 'tool.started', agentId: h.root, toolCallId: 'tc-v1', toolName: 'view', arguments: { path: 'a' } });
  await h.event({ type: 'tool.completed', agentId: h.root, toolCallId: 'tc-v1', toolName: 'view', success: true });
  assert.match(await expectRefusal(h.tool('review', {}, h.root)), /まだ繰り返しの途中です[\s\S]*endedByHuman を true にして呼び/);
  assert.match(await expectRefusal(h.tool('issue', { title: '案', body: '本文' }, h.root)), /endedByHuman/);
  await h.tool('review', END, h.root);
  assert.equal(h.run().status, 'summarizing');
});

test('REQ-051 答えの後に、統括が計画などの記録を呼ぶか、作業か検証のエージェントを始めると、印を付けた _review は断られる', async (t) => {
  // 計画の記録（受け付けられた）
  const a = await makeHarness(t);
  await toWaiting(a, { maxIterations: 3 });
  await answer(a, 'やめて');
  await a.tool('plan', a.planArgs(2), a.root);
  assert.match(await expectRefusal(a.tool('review', END, a.root)), /いまは endedByHuman を付けられません/);

  // 計画の記録（断られた）
  const b = await makeHarness(t);
  await toWaiting(b, { maxIterations: 3 });
  await answer(b, 'やめて');
  await expectRefusal(b.tool('plan', b.planArgs(5), b.root));
  assert.match(await expectRefusal(b.tool('review', END, b.root)), /いまは endedByHuman を付けられません/);

  // 表示の記録
  const c = await makeHarness(t);
  await toWaiting(c, { maxIterations: 3 });
  await answer(c, 'やめて');
  await c.tool('show', { key: 'no-such-key', value: 'x' }, c.root).catch(() => {});
  assert.match(await expectRefusal(c.tool('review', END, c.root)), /いまは endedByHuman を付けられません/);

  // 検証のエージェントを始めた（合否の記録の前に聞いていた）
  const d = await makeHarness(t);
  await toWaitingBeforeVerdict(d, { maxIterations: 3 });
  await answer(d, 'やめて');
  await d.spawn('verifier');
  assert.match(await expectRefusal(d.tool('review', END, d.root)), /いまは endedByHuman を付けられません/);
  assert.equal(d.run().status, 'running');

  // 比べ：作業エージェントが呼んだエージェントは、統括のしたことではないので数えない
  const e = await makeHarness(t);
  await e.begin({ maxIterations: 3 });
  await e.tool('plan', e.planArgs(1), e.root);
  const worker = await e.spawn('worker');
  await e.tool('ask', { question: QUESTION }, e.root);
  await rootTurnEnd(e);
  await answer(e, 'やめて');
  await e.spawn('helper', { parent: worker });
  await e.tool('review', END, e.root);
  assert.equal(e.run().status, 'summarizing');
});

test('REQ-051 後で終えるよう言う答えでは、続けた後の試行が不合格でも、聞き直す前の印は断られる。聞き直して「終えて」と答えると、「人の指示で終えた」で終わる', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h, { maxIterations: 4 });
  await answer(h, 'あと1回だけ試して、だめなら終えて');
  await h.iterate(2, { pass: false });
  assert.equal(h.run().status, 'running');
  assert.match(await expectRefusal(h.tool('review', END, h.root)), /いまは endedByHuman を付けられません[\s\S]*weekly-report_ask/, '聞かずに終えられない');
  await h.tool('ask', { question: '試行2も失敗しました。終えますか？' }, h.root);
  await rootTurnEnd(h, { first: false, response: '人の判断待ち\n試行2も失敗しました。終えますか？' });
  assert.equal(h.run().status, 'waiting_human');
  assert.equal(h.run().humanWait.iteration, 2);
  await answer(h, '終えて');
  await h.tool('review', END, h.root);
  assert.equal(h.run().status, 'summarizing');
  await h.tool('finish', { summary: '人の指示で、試行 2 の後に終えました。' }, h.root);
  await rootTurnEnd(h, { first: false, response: '実行の番号：x' });
  const run = h.run();
  assert.deepEqual([run.endReason.kind, run.endReason.detail], ['human_ended', null]);
  assert.deepEqual(run.iterations.map((i) => i.n), [1, 2]);
  assert.equal(h.port.callsOf('sendMessage').length, 2, '答えは 2 回届いた');
});

test('REQ-051 統括に送る答えの文は、いまここで終えるときは先に印を付けること、後で終えるときは続けて聞き直すことを伝える', async (t) => {
  const h = await makeHarness(t);
  await toWaiting(h);
  await answer(h, '続けて');
  const [[, message]] = h.port.callsOf('sendMessage').map((c) => c.args);
  assert.match(message, /いまここで終えるよう言っているときは[\s\S]*ほかの記録やエージェントの呼び出しより先に/);
  assert.match(message, /後で終えるよう言っているときは、いまは続けて、その時が来たら、終えるかをもう一度聞いてください/);
});
