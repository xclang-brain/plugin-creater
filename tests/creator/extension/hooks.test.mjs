// 2段目 部品の試験（クリエイターのエクステンション）：フック（問答の記録と、コンパクションの後の差し込み）。
// 設計書：hearing.md 2.5、5.5、7.4、8章、12章「2段目」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';

import { answerEverything, readyToConfirm, tempDir, withRun } from './helpers.mjs';

const CANCELLED = 'User cancelled the request.';
const UNAVAILABLE = 'The user is not available to respond and will review your work later. Work autonomously and make good decisions. If the request is genuinely ambiguous or unresolvable, stop and call task_complete.';

/** ヒアリングの最中にする（記録を作る） */
const startHearing = (run) => run.call('progress', { stage: '始まり' });

describe('問答の記録（onPostToolUse、onUserPromptSubmitted）', () => {
  test('REQ-049 ask_user の確定・取り消し・断りと、打った発言が qa.jsonl に記録され、差し込みは返らない', async () => {
    await withRun(async (run) => {
      await startHearing(run);

      const after1 = await run.fake.askUser({ message: '今週の週報は、いつまでに出しますか？', answer: 'User responded: 金曜の17時までです' });
      const after2 = await run.fake.askUser({ message: '提出先はどなたですか？', answer: CANCELLED });
      const after3 = await run.fake.askUser({ message: 'ほかにありますか？', answer: UNAVAILABLE });
      const prompt = await run.hook('onUserPromptSubmitted', { prompt: '早くしてください' });

      // 差し込みは返さない（onPostToolUse の差し込みは画面に出るため。hearing.md 2.5）
      for (const returned of [after1, after2, after3, prompt]) assert.equal(returned, undefined);

      const qa = run.readQa();
      assert.equal(qa.length, 4);
      assert.deepEqual(qa.map((e) => e.type), ['ask_user', 'ask_user', 'ask_user', 'user_prompt']);
      assert.equal(qa[0].question.message, '今週の週報は、いつまでに出しますか？');
      assert.ok(qa[0].question.requestedSchema, '問いの欄の定義も残る');
      assert.equal(qa[0].answer, 'User responded: 金曜の17時までです');
      assert.deepEqual(qa.map((e) => e.outcome), ['answered', 'cancelled', 'unavailable', undefined]);
      assert.equal(qa[1].answer, CANCELLED);
      assert.equal(qa[2].answer, UNAVAILABLE);
      assert.equal(qa[3].text, '早くしてください');
      for (const entry of qa) assert.equal(entry.at, '2026-10-22T09:00:00.000Z');
    });
  });

  test('REQ-049 追記だけをする（前の記録を書き換えない）。時刻は記録した時刻', async () => {
    await withRun(async (run) => {
      await startHearing(run);
      await run.hook('onUserPromptSubmitted', { prompt: '1つ目' });
      const first = fs.readFileSync(run.qaPath(), 'utf8');
      run.clock.advance(1000);
      await run.hook('onUserPromptSubmitted', { prompt: '2つ目' });
      const second = fs.readFileSync(run.qaPath(), 'utf8');
      assert.ok(second.startsWith(first), '前の行が変わっている');
      assert.deepEqual(run.readQa().map((e) => e.at), ['2026-10-22T09:00:00.000Z', '2026-10-22T09:00:01.000Z']);
    });
  });

  test('REQ-049 ヒアリングの最中でないとき（このセッションの記録がない）は、問答も発言も記録しない', async () => {
    await withRun(async (run) => {
      await run.fake.askUser({ message: '質問', answer: 'User responded: はい' });
      await run.hook('onUserPromptSubmitted', { prompt: '試験を頼みます' });
      assert.equal(fs.existsSync(run.qaPath()), false);
      assert.equal(fs.existsSync(run.creator.store.dir), false, '記録のフォルダも作らない');
    });
  });

  test('REQ-049 記録ができる前に打たれた発言は、記録を作ったときに、頼みの文として qa.jsonl の初めに追記される', async () => {
    await withRun(async (run) => {
      await run.hook('onUserPromptSubmitted', { prompt: '週報づくりを自動化したい' });
      run.clock.advance(1000);
      await run.hook('onUserPromptSubmitted', { prompt: '毎週金曜に出しています' });
      assert.equal(fs.existsSync(run.qaPath()), false, '記録ができる前は、ファイルに書かない');

      run.clock.advance(1000);
      await startHearing(run);
      await run.hook('onUserPromptSubmitted', { prompt: '記録ができた後の発言' });

      const qa = run.readQa();
      assert.deepEqual(qa.map((e) => e.type), ['request', 'request', 'user_prompt']);
      assert.deepEqual(qa.map((e) => e.text), ['週報づくりを自動化したい', '毎週金曜に出しています', '記録ができた後の発言']);
      assert.deepEqual(qa.map((e) => e.at), ['2026-10-22T09:00:00.000Z', '2026-10-22T09:00:01.000Z', '2026-10-22T09:00:02.000Z'], '時刻は打たれた時刻');
    });
  });

  test('REQ-049 頼みの文は、記録を作ったときに1回だけ追記され、抜き書きの確かめでユーザーの答えに数えない', async () => {
    await withRun(async (run) => {
      await run.hook('onUserPromptSubmitted', { prompt: '週報づくりを自動化したい' });
      await startHearing(run);
      await run.call('progress', { stage: '始まり' });
      assert.equal(run.readQa().filter((e) => e.type === 'request').length, 1, '記録を作るのは1回なので、頼みの文も1回');

      await run.fake.askUser({ message: '成果物は何ですか？', answer: 'User responded: 週報の Word ファイルです' });
      const fromRequest = await run.callSafe('progress', { items: [{ item: '作業の目的', status: '聞いた', quote: '週報づくりを自動化したい' }] });
      assert.equal(fromRequest.ok, false, '頼みの文の言葉は、ユーザーの答えの抜き書きにならない');
      const fromAnswer = await run.callSafe('progress', { items: [{ item: '成果物', status: '聞いた', quote: '週報の Word ファイルです' }] });
      assert.equal(fromAnswer.ok, true, fromAnswer.error);
    });
  });

  test('REQ-049 前の記録があるセッションに戻ったときは、記録の前の発言として覚えない（打った発言として追記する）', async () => {
    const home = tempDir('pc-hooks-home-');
    try {
      await withRun((run) => startHearing(run), { home });
      await withRun(async (run) => {
        await run.hook('onUserPromptSubmitted', { prompt: '続きをお願いします' });
        assert.deepEqual(run.readQa().map((e) => e.type), ['user_prompt']);
      }, { home });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('REQ-049 ヒアリングの最中でなくなったとき（段階が「生成」に進んだ後）は、問答も発言も記録しない', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      await run.hook('onUserPromptSubmitted', { prompt: '確認の途中の発言' });
      await run.call('confirm', {
        knowledgeIds: ['K-01', 'K-02'],
        behavior: '案',
        taskPath: '.plugin-creator-work/draft/task.json',
        evalTasks: [{ prompt: '課題', criteria: ['K-02'], settings: { task: { week: 'W42' } } }],
      });
      await run.fake.askUser({ message: 'この内容で作ってよいですか？', answer: 'User responded: 作る' });
      assert.equal(run.readQa().length, 2, '生成に進む前の問答は記録される');

      await run.call('progress', { stage: '生成', approvalQuote: '作る' });
      await run.fake.askUser({ message: '試験に進みますか？', answer: 'User responded: はい' });
      await run.hook('onUserPromptSubmitted', { prompt: '次は試験をお願いします' });
      assert.equal(run.readQa().length, 2, '生成に進んだ後は、問答も発言も記録しない');
    });
  });

  test('REQ-049 ask_user 以外のツールの結果は記録しない', async () => {
    await withRun(async (run) => {
      await startHearing(run);
      const returned = await run.hook('onPostToolUse', { toolName: 'view', toolArgs: { path: 'a.md' }, toolResult: { textResultForLlm: '中身', resultType: 'success' } });
      assert.equal(returned, undefined);
      assert.equal(fs.existsSync(run.qaPath()), false);
    });
  });

  test('REQ-049 ask_user の引数が JSON の文字で来ても、結果が文字で来ても、記録できる', async () => {
    await withRun(async (run) => {
      await startHearing(run);
      await run.hook('onPostToolUse', { toolName: 'ask_user', toolArgs: JSON.stringify({ message: '文字で来た問い' }), toolResult: 'User responded: はい' });
      const [entry] = run.readQa();
      assert.equal(entry.question.message, '文字で来た問い');
      assert.equal(entry.answer, 'User responded: はい');
    });
  });

  test('REQ-049 フックの関数は例外を投げない（おかしな入力でも、記録に失敗しても）', async () => {
    await withRun(async (run) => {
      await startHearing(run);
      const { onPostToolUse, onUserPromptSubmitted, onPreToolUse } = run.fake.config.hooks;
      for (const input of [undefined, null, 42, 'text', {}, { toolName: 'ask_user' }, { toolName: 'ask_user', toolResult: 42 }, { prompt: 42 }]) {
        for (const hook of [onPostToolUse, onUserPromptSubmitted, onPreToolUse]) assert.doesNotThrow(() => hook(input));
      }
      // 書き込めないとき（問答の記録の置き場所が、フォルダになっている）
      const circular = {};
      circular.self = circular;
      assert.doesNotThrow(() => onPostToolUse({ toolName: 'ask_user', toolArgs: circular, toolResult: 'x' }));
      fs.rmSync(run.qaPath(), { force: true });
      fs.mkdirSync(run.qaPath());
      assert.doesNotThrow(() => onUserPromptSubmitted({ prompt: 'x' }));
      assert.ok(run.warnings.length >= 2, '失敗は標準エラーに知らせる');
    });
  });
});

describe('コンパクションの後の差し込み（onPreToolUse）', () => {
  const complete = (run, data = {}, options) => run.fake.emit('session.compaction_complete', { success: true, ...data }, options);
  const preToolUse = (run, input = {}) => run.hook('onPreToolUse', { toolName: 'view', toolArgs: {}, ...input });

  test('REQ-015 session.compaction_complete の後、次のメインのエージェントの onPreToolUse でだけ、1回、1KB 未満の差し込みが返る', async () => {
    await withRun(async (run) => {
      await startHearing(run);
      assert.equal(await preToolUse(run), undefined, 'コンパクションの前は差し込まない');

      complete(run);
      const first = await preToolUse(run);
      assert.ok(first?.additionalContext, '差し込みが返らない');
      assert.ok(Buffer.byteLength(first.additionalContext, 'utf8') < 1000, '1KB 未満にする');
      assert.deepEqual(Object.keys(first), ['additionalContext']);
      assert.ok(first.additionalContext.includes('make-plugin'));
      assert.ok(first.additionalContext.includes('skill ツール'));
      assert.ok(first.additionalContext.includes('plugin-creator_state'));

      assert.equal(await preToolUse(run), undefined, '1回だけ');
      assert.equal(await preToolUse(run, { toolName: 'ask_user' }), undefined, '1回だけ');
    });
  });

  test('REQ-015 サブエージェントのツールの呼び出しには差し込まない（次のメインのエージェントの呼び出しで差し込む）', async () => {
    await withRun(async (run) => {
      await startHearing(run);
      complete(run);
      assert.equal(await preToolUse(run, { agentId: 'agent-reader-1', agentType: 'plugin-creator:reader' }), undefined);
      assert.equal(await preToolUse(run, { agentId: 'agent-reader-1' }), undefined);
      assert.ok((await preToolUse(run))?.additionalContext, 'メインのエージェントの呼び出しで差し込む');
      assert.equal(await preToolUse(run), undefined);
    });
  });

  test('REQ-015 サブエージェントのコンパクションの完了と、失敗したコンパクションでは、差し込みの用意をしない', async () => {
    await withRun(async (run) => {
      await startHearing(run);
      complete(run, {}, { agentId: 'agent-reader-1' });
      assert.equal(await preToolUse(run), undefined, 'サブエージェントのコンパクション');
      complete(run, { success: false });
      assert.equal(await preToolUse(run), undefined, '失敗したコンパクション');
      run.fake.emit('session.compaction_start', {});
      assert.equal(await preToolUse(run), undefined, '始まりのイベントでは用意しない');
    });
  });

  test('REQ-015 ヒアリングの最中でないとき（記録がない）は、差し込まない', async () => {
    await withRun(async (run) => {
      complete(run);
      assert.equal(await preToolUse(run), undefined);
      // あとで記録ができても、前のコンパクションの分は差し込まない
      await startHearing(run);
      assert.equal(await preToolUse(run), undefined);
    });
  });

  test('REQ-015 差し込みを返す前に段階が「生成」に進んでいたら、差し込まない', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      await run.call('confirm', {
        knowledgeIds: ['K-01', 'K-02'],
        behavior: '案',
        taskPath: '.plugin-creator-work/draft/task.json',
        evalTasks: [{ prompt: '課題', criteria: ['K-02'], settings: { task: { week: 'W42' } } }],
      });
      complete(run);
      await run.call('progress', { stage: '生成', approvalQuote: '作る' });
      assert.equal(await preToolUse(run), undefined);
      complete(run);
      assert.equal(await preToolUse(run), undefined, '生成に進んだ後のコンパクションでも差し込まない');
    });
  });

  test('REQ-015 コンパクションが2回あれば、それぞれの後に1回ずつ差し込む', async () => {
    await withRun(async (run) => {
      await answerEverything(run);
      complete(run);
      assert.ok((await preToolUse(run))?.additionalContext);
      assert.equal(await preToolUse(run), undefined);
      complete(run);
      complete(run); // 続けて2回来ても、差し込みは1回
      assert.ok((await preToolUse(run))?.additionalContext);
      assert.equal(await preToolUse(run), undefined);
    });
  });

  test('REQ-015 問答の記録のフック（onPostToolUse、onUserPromptSubmitted）は、コンパクションの後でも差し込みを返さない', async () => {
    await withRun(async (run) => {
      await startHearing(run);
      complete(run);
      assert.equal(await run.fake.askUser({ message: '質問', answer: 'User responded: はい' }), undefined);
      assert.equal(await run.hook('onUserPromptSubmitted', { prompt: '発言' }), undefined);
      // askUser は onPreToolUse も通る。ここで差し込みを使い切っている
      assert.equal(await preToolUse(run), undefined);
    });
  });
});
