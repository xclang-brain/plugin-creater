// 中心の処理：記録のツールの決まり（設計書 4.8、6.2、10章「記録の決まり」）
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { expectRefusal, LIMITS, makeHarness, PLUGIN, slotOf, TASK } from './harness.mjs';

const DISCONNECTED = '画面とのつながりが切れたので、作業を終えてください。';

test('REQ-011 正しい計画は記録され、試行ごとの評価基準と計画が状態に入る。足した基準は認められる', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  const args = h.planArgs(1, { extra: [{ id: 'X-01', text: '誤字がない' }] });
  assert.match(await h.tool('plan', args, h.root), /試行 1 の計画を記録しました/);
  const [it] = h.run().iterations;
  assert.equal(it.n, 1);
  assert.equal(it.plan, '試行 1 の計画');
  assert.deepEqual(it.criteria.map((c) => [c.id, c.fromUser]), [['C-01', true], ['C-02', true], ['X-01', false]]);
  assert.equal(h.run().iteration, 1);
});

test('REQ-011 基準が欠けた計画、文が変わった計画は断られる', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  const missing = { ...h.planArgs(1), criteria: [{ id: 'C-01', text: TASK.criteria[0].text }] };
  assert.match(await expectRefusal(h.tool('plan', missing, h.root)), /足りません（C-02）/);
  const changed = h.planArgs(1);
  changed.criteria[1].text = '来週の予定がある';
  assert.match(await expectRefusal(h.tool('plan', changed, h.root)), /文が変わっています（C-02）/);
  assert.equal(h.run().iterations.length, 0);
});

test('REQ-011 文の前後の空白と改行の形の違いだけなら、文言は変わっていないものとして認める', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  const args = h.planArgs(1);
  args.criteria[0].text = `  ${args.criteria[0].text}\n`;
  await h.tool('plan', args, h.root);
  assert.equal(h.run().iterations.length, 1);
});

test('REQ-011 上限を超える計画、前の試行の次でない番号の計画は断られる', async (t) => {
  const h = await makeHarness(t);
  await h.begin({ maxIterations: 1 });
  assert.match(await expectRefusal(h.tool('plan', h.planArgs(2), h.root)), /上限（1 回）を超えます/);
  const h2 = await makeHarness(t);
  await h2.begin();
  assert.match(await expectRefusal(h2.tool('plan', h2.planArgs(2), h2.root)), /次の試行の番号は 1/);
  await h2.tool('plan', h2.planArgs(1), h2.root);
  assert.match(await expectRefusal(h2.tool('plan', h2.planArgs(1), h2.root)), /次の試行の番号は 2/);
});

test('REQ-010 検証以外からの合否の記録は断られる', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  await h.tool('plan', h.planArgs(1), h.root);
  const worker = await h.spawn('worker');
  await h.complete(worker);
  for (const caller of [h.root, worker]) {
    assert.match(await expectRefusal(h.tool('verdict', h.verdictArgs(1), caller)), /検証エージェントだけ/);
  }
  assert.equal(h.run().iterations[0].verdicts.length, 0);
});

test('REQ-011 作業エージェントが終わる前の合否の記録は断られ、終わった後なら受け付けられる', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  await h.tool('plan', h.planArgs(1), h.root);
  const worker = await h.spawn('worker');
  const verifier = await h.spawn('verifier', { model: 'claude-opus-5-5' });
  assert.match(await expectRefusal(h.tool('verdict', h.verdictArgs(1), verifier)), /作業エージェントが、まだ終わっていません/);
  await h.complete(worker);
  assert.match(await h.tool('verdict', h.verdictArgs(1), verifier), /合否を記録しました（2 件中 2 件が合格）/);
});

test('REQ-011 作業エージェントが一度も動いていない試行の合否の記録は断られる', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  await h.tool('plan', h.planArgs(1), h.root);
  const verifier = await h.spawn('verifier');
  assert.match(await expectRefusal(h.tool('verdict', h.verdictArgs(1), verifier)), /まだ終わっていません/);
});

test('REQ-011 合否の記録は、その試行の評価基準がすべてそろっていて、重なりも知らない番号もないこと', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  await h.tool('plan', h.planArgs(1), h.root);
  const worker = await h.spawn('worker');
  await h.complete(worker);
  const verifier = await h.spawn('verifier');
  const one = { iteration: 1, verdicts: [{ criterionId: 'C-01', pass: true }] };
  assert.match(await expectRefusal(h.tool('verdict', one, verifier)), /足りない評価基準があります（C-02）/);
  const dup = { iteration: 1, verdicts: [{ criterionId: 'C-01', pass: true }, { criterionId: 'C-01', pass: true }] };
  assert.match(await expectRefusal(h.tool('verdict', dup, verifier)), /重なっています/);
  const unknown = { iteration: 1, verdicts: [{ criterionId: 'C-01', pass: true }, { criterionId: 'C-02', pass: true }, { criterionId: 'Z', pass: true }] };
  assert.match(await expectRefusal(h.tool('verdict', unknown, verifier)), /評価基準にない番号/);
  await h.tool('verdict', h.verdictArgs(1, { pass: false }), verifier); // 受け付けられると、やり直しの数え直しになる
  const wrongIteration = { ...h.verdictArgs(1), iteration: 2 };
  assert.match(await expectRefusal(h.tool('verdict', wrongIteration, verifier)), /1 回目/);
  assert.match(await expectRefusal(h.tool('verdict', h.verdictArgs(1), verifier)), /すでに記録されています/);
});

test('REQ-011 すべて合格すると、まとめ中に移り、その後の計画の記録は断られる', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  await h.iterate(1);
  assert.equal(h.run().status, 'summarizing');
  const message = await expectRefusal(h.tool('plan', h.planArgs(2), h.root));
  assert.match(message, /繰り返しはもう終わっています/);
  assert.match(message, new RegExp(`${PLUGIN}_review`));
});

test('REQ-011 合格しなかったときは次の試行に進み、上限の試行の合否が記録されるとまとめ中に移る', async (t) => {
  const h = await makeHarness(t);
  await h.begin({ maxIterations: 2 });
  await h.iterate(1, { pass: (c) => c.id === 'C-01' });
  assert.equal(h.run().status, 'running');
  assert.deepEqual(h.run().iterations[0].verdicts.map((v) => v.pass), [true, false]);
  await h.iterate(2, { pass: false });
  assert.equal(h.run().status, 'summarizing');
  assert.equal(h.run().iterations.length, 2);
});

test('REQ-011 繰り返しの途中のまとめ・振り返りの記録は断られ、「まだ繰り返しの途中です」と返る', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  for (const [name, args] of [['review', {}], ['issue', { title: '題', body: '本文' }], ['finish', { summary: 'まとめ' }]]) {
    assert.match(await expectRefusal(h.tool(name, args, h.root)), /まだ繰り返しの途中です/);
  }
  await h.tool('plan', h.planArgs(1), h.root);
  assert.match(await expectRefusal(h.tool('finish', { summary: 'まとめ' }, h.root)), /まだ繰り返しの途中です/);
});

test('REQ-013 まとめ中の review・issue・finish は統括だけが呼べ、finish は 1 回だけ', async (t) => {
  const h = await makeHarness(t);
  const { verifier } = await h.toSummarizing();
  assert.match(await expectRefusal(h.tool('finish', { summary: 'まとめ' }, verifier)), /統括エージェントだけ/);
  assert.match(await expectRefusal(h.tool('issue', { title: '', body: '本文' }, h.root)), /題/);
  assert.match(await h.tool('issue', { title: '題', body: '本文' }, h.root), /O1/);
  assert.match(await h.tool('finish', { summary: '週報を作りました' }, h.root), /まとめを記録しました/);
  assert.match(await expectRefusal(h.tool('finish', { summary: 'もう一度' }, h.root)), /すでに記録されています/);
  assert.equal(h.run().summary, '週報を作りました');
});

test('REQ-005 今の実行に当たらない記録のツールの呼び出しは断り、「画面とのつながりが切れた」と返す', async (t) => {
  const h = await makeHarness(t);
  // 実行がない
  assert.equal(await expectRefusal(h.tool('plan', h.planArgs(1), 'someone')), DISCONNECTED);
  await h.begin();
  // 実行に当たらないエージェント（古い統括や、チャットでのほかの作業）
  assert.equal(await expectRefusal(h.tool('plan', h.planArgs(1), 'unknown-agent')), DISCONNECTED);
  assert.equal(await expectRefusal(h.tool('plan', h.planArgs(1), undefined)), DISCONNECTED);
  assert.match(await expectRefusal(h.tool('unknown_tool', {}, h.root)), /知らない記録のツール/);
});

test('REQ-008 統括の下の、裏で動かす呼び方の subagent.started は決まりに合わないこととして記録され、課題に入る', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  await h.tool('plan', h.planArgs(1), h.root);
  const worker = await h.spawn('worker', { executionMode: 'background' });
  await h.complete(worker);
  const verifier = await h.spawn('verifier');
  await h.tool('verdict', h.verdictArgs(1), verifier);
  await h.complete(verifier);
  await h.tool('finish', { summary: 'まとめ' }, h.root);
  await h.rootIdle();
  await h.clock.advance(1000);
  const run = h.run();
  assert.equal(run.status, 'finished');
  const issue = run.issues.find((i) => i.title.includes('決まりと違う呼び方'));
  assert.ok(issue, '裏で動かす呼び方が課題に入る');
  assert.ok(issue.body.includes(worker) && issue.body.includes('background'));
  assert.equal(issue.source, 'mechanical');
  // 同期で呼んだ検証は入らない
  assert.ok(!issue.body.includes(verifier));
});

test('REQ-012 記録のやり直しが上限を超えると、実行中なら統括が取り消され、「途中で終わった（記録のやり直しが上限を超えた）」になる', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  const bad = { ...h.planArgs(1), criteria: [{ id: 'C-01', text: TASK.criteria[0].text }] };
  for (let i = 1; i <= LIMITS.RETRY_LIMIT; i += 1) {
    const message = await expectRefusal(h.tool('plan', bad, h.root));
    assert.match(message, /あと \d+ 回までです/);
    assert.equal(h.port.callsOf('cancelAgent').length, 0, 'まだ取り消さない');
  }
  const last = await expectRefusal(h.tool('plan', bad, h.root));
  assert.match(last, /上限（3 回）を超えた/);
  await h.settle();
  await h.clock.advance(1000);
  assert.deepEqual(h.port.argsOf('cancelAgent'), [h.root]);
  const run = h.run();
  assert.equal(run.status, 'finished');
  assert.deepEqual([run.endReason.kind, run.endReason.detail], ['aborted', 'retry_limit']);
  assert.ok(run.issues.some((i) => i.title.includes('やり直しが上限')));
  // 取り消した後の記録は、列に入れずにすぐ断る
  assert.match(await expectRefusal(h.tool('plan', h.planArgs(1), h.root)), /切れた|止められ/);
});

test('REQ-012 記録のやり直しが上限を超えたとき、まとめ中なら統括を取り消し、合否の記録で終わった理由が決まり、課題に出る', async (t) => {
  const h = await makeHarness(t);
  await h.toSummarizing();
  for (let i = 0; i < LIMITS.RETRY_LIMIT; i += 1) await expectRefusal(h.tool('finish', { summary: '' }, h.root));
  await expectRefusal(h.tool('finish', { summary: '' }, h.root));
  await h.settle();
  await h.clock.advance(1000);
  assert.deepEqual(h.port.argsOf('cancelAgent'), [h.root]);
  const run = h.run();
  assert.equal(run.status, 'finished');
  assert.equal(run.endReason.kind, 'all_passed', '合否の記録で決まる');
  assert.ok(run.issues.some((i) => i.title.includes('やり直しが上限')));
  assert.ok(run.issues.some((i) => i.title.includes('まとめを記録しないまま')));
});

test('REQ-012 記録が受け付けられると、やり直しの数え直しになる', async (t) => {
  const h = await makeHarness(t);
  await h.begin();
  const bad = { ...h.planArgs(1), criteria: [] };
  for (let i = 0; i < LIMITS.RETRY_LIMIT; i += 1) await expectRefusal(h.tool('plan', bad, h.root));
  await h.tool('plan', h.planArgs(1), h.root); // 受け付けられる
  const worker = await h.spawn('worker');
  await h.complete(worker);
  for (let i = 0; i < LIMITS.RETRY_LIMIT; i += 1) await expectRefusal(h.tool('plan', bad, h.root));
  await h.settle();
  assert.equal(h.port.callsOf('cancelAgent').length, 0);
  assert.equal(h.run().status, 'running');
});

// ---- 表示（show） ----

async function runWithFiles(t) {
  const h = await makeHarness(t);
  writeFileSync(join(h.cwd, 'chart.png'), 'png');
  writeFileSync(join(h.cwd, 'chart.svg'), '<svg/>');
  mkdirSync(join(h.cwd, 'out'));
  writeFileSync(join(h.cwd, 'out', 'report.md'), '# 週報');
  writeFileSync(join(h.base, 'secret.txt'), 'secret');
  symlinkSync(join(h.base, 'secret.txt'), join(h.cwd, 'link.txt'));
  symlinkSync(join(h.cwd, 'out', 'report.md'), join(h.cwd, 'inner-link.md'));
  await h.begin();
  return h;
}

test('REQ-031 表示の記録は、作業の定義にある表示で、値の形が合うものだけが受け付けられる', async (t) => {
  const h = await makeHarness(t);
  const root = await h.begin();
  const worker = await h.spawn('worker');
  await h.tool('show', { key: 'draft', value: '下書きです' }, worker);
  await h.tool('show', { key: 'meta', value: { 担当: '山田', 件数: 3 } }, root);
  await h.tool('show', { key: 'stats', value: { columns: ['項目', '数'], rows: [['a', 1], ['b', 2]] } }, root);
  await h.tool('show', { key: 'progress', value: { value: 2, max: 4, label: '作成' } }, worker);
  await h.tool('show', { key: 'progress', value: 50 }, worker);
  assert.deepEqual(h.run().displays.draft, '下書きです');
  assert.deepEqual(h.run().displays.meta, { 担当: '山田', 件数: 3 });
  assert.deepEqual(h.run().displays.progress, 50, '値は上書きされる');

  const unknownKey = await expectRefusal(h.tool('show', { key: 'nothing', value: 'x' }, root));
  assert.match(unknownKey, /作業ごとの指示にない表示です：nothing/);
  assert.match(unknownKey, /使える表示の名前（key）：draft、meta、stats、progress、chart、report/);
  assert.doesNotMatch(unknownKey, /番号|作業の定義/, 'key は名前であって番号ではない');
  assert.match(await expectRefusal(h.tool('show', { key: 'draft', value: { a: 1 } }, root)), /文字列で渡してください/);
  assert.match(await expectRefusal(h.tool('show', { key: 'stats', value: { columns: ['a', 'b'], rows: [['x']] } }, root)), /同じ数の値/);
  assert.match(await expectRefusal(h.tool('show', { key: 'progress', value: { value: 5, max: 4 } }, root)), /max 以下/);
  assert.match(await expectRefusal(h.tool('show', { key: 'meta', value: 'x' }, root)), /見出し: 値/);
  // 検証エージェントは表示を記録できない
  const verifier = await h.spawn('verifier');
  assert.match(await expectRefusal(h.tool('show', { key: 'draft', value: 'x' }, verifier)), /統括エージェントか作業エージェント/);
});

test('REQ-031 画像とファイルは、作業フォルダの中のものだけが受け付けられ、窓口には番号で知らされる', async (t) => {
  const h = await runWithFiles(t);
  const worker = await h.spawn('worker');
  await h.tool('show', { key: 'chart', value: 'chart.png' }, worker);
  await h.tool('show', { key: 'report', value: join(h.cwd, 'out', 'report.md') }, worker);
  const { displays } = h.run();
  assert.equal(displays.chart.name, 'chart.png');
  assert.equal(displays.chart.image, true);
  assert.equal(displays.report.name, 'report.md');
  const file = h.core.getFile(displays.report.fileId);
  assert.ok(file.path.endsWith('report.md'));
  assert.equal(h.core.getFile('f999'), null, '知らされていないファイルは出さない');

  // SVG は画像として出さない（ダウンロードさせる）ので、image は false
  await h.tool('show', { key: 'chart', value: 'chart.svg' }, worker);
  assert.equal(h.run().displays.chart.image, false);

  // 中を指すシンボリックリンクは、本当の場所が中なので受け付けられる
  await h.tool('show', { key: 'report', value: 'inner-link.md' }, worker);
  // 作業フォルダの外、外を指すシンボリックリンク、ないファイル、フォルダは断る
  assert.match(await expectRefusal(h.tool('show', { key: 'report', value: join(h.base, 'secret.txt') }, worker)), /作業フォルダの外/);
  assert.match(await expectRefusal(h.tool('show', { key: 'report', value: 'link.txt' }, worker)), /作業フォルダの外/);
  assert.match(await expectRefusal(h.tool('show', { key: 'report', value: '../secret.txt' }, worker)), /作業フォルダの外/);
  assert.match(await expectRefusal(h.tool('show', { key: 'report', value: 'none.txt' }, worker)), /見つかりません/);
  assert.match(await expectRefusal(h.tool('show', { key: 'report', value: 'out' }, worker)), /ファイルではありません/);
});

test('REQ-031 窓口でファイルを出すときも、作業フォルダの外を指すように作り直されたものは出さない', async (t) => {
  const h = await runWithFiles(t);
  const worker = await h.spawn('worker');
  await h.tool('show', { key: 'report', value: 'out/report.md' }, worker);
  const { fileId } = h.run().displays.report;
  assert.ok(h.core.getFile(fileId));
  // 記録の後で、ファイルが外を指すシンボリックリンクに置き換えられた
  const { rmSync } = await import('node:fs');
  rmSync(join(h.cwd, 'out', 'report.md'));
  symlinkSync(join(h.base, 'secret.txt'), join(h.cwd, 'out', 'report.md'));
  assert.equal(h.core.getFile(fileId), null);
});

test('REQ-031 表示の記録の断りは、記録のやり直しの数に入らない', async (t) => {
  const h = await makeHarness(t);
  const root = await h.begin();
  for (let i = 0; i < LIMITS.RETRY_LIMIT + 2; i += 1) await expectRefusal(h.tool('show', { key: 'nothing', value: 'x' }, root));
  await h.settle();
  assert.equal(h.port.callsOf('cancelAgent').length, 0);
  assert.equal(h.run().status, 'running');
});

test('REQ-008 記録のツールの定義は 1 か所にあり、名前の頭にプラグインの名前が付く', async (t) => {
  const h = await makeHarness(t);
  const defs = h.core.toolDefinitions;
  assert.deepEqual(
    defs.map((d) => d.name),
    ['open', 'plan', 'verdict', 'show', 'review', 'issue', 'finish', 'ask', 'answer'].map((n) => `${PLUGIN}_${n}`),
  );
  for (const d of defs) {
    assert.equal(d.parameters.type, 'object');
    assert.equal(d.skipPermission, true);
    assert.ok(d.description.length > 0);
  }
  const plan = defs.find((d) => d.shortName === 'plan');
  assert.deepEqual(plan.parameters.required, ['iteration', 'criteria', 'plan']);
  assert.ok(slotOf(h.state().run ?? { agents: [] }, 'x') === undefined);
});
