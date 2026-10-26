// 2段目 部品の試験（クリエイターのエクステンション）：ツールの断り方と失敗の返し方。
// 実機の Copilot CLI 1.0.102 は、ツールの処理が例外を投げると、モデルに「Tool execution failed」だけを返し、理由の文を捨てる
// （wip/implementation/research/V1-copilot-cli-smoke.md 5節 不具合 2）。そのため、断りも失敗も例外にせず、
// `{ textResultForLlm: <理由の文>, resultType: 'failure' }` を返す（`rejected` は手番が止まるので使わない）。
// 設計書：creator-structure.md 4.3、hearing.md 7章、REQ-049。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { answerEverything, confirmArgs, internalSymbolsIn, knowledge, readyToConfirm, startForTest, tempDir, withRun, writeDraft } from './helpers.mjs';
import { sampleDocx } from './ooxml.mjs';
import { leftWordsIn } from './words.mjs';

const isFailure = (result) => result !== null && typeof result === 'object';

/** 失敗の結果の形：理由の文と failure だけを持つ（error など、ほかの欄を持たない） */
function assertFailure(result, pattern, label = '') {
  assert.ok(isFailure(result), `${label}：失敗の結果が返らず、${JSON.stringify(result)} が返った`);
  assert.deepEqual(Object.keys(result).sort(), ['resultType', 'textResultForLlm'], label);
  assert.equal(result.resultType, 'failure', label);
  assert.equal(typeof result.textResultForLlm, 'string', label);
  assert.match(result.textResultForLlm, pattern, label);
  assert.deepEqual(internalSymbolsIn(result.textResultForLlm), [], `${label}：内部の記号が出ている`);
}

describe('ツールの断り方（例外ではなく、理由の文を結果として返す）', () => {
  test('hearing.md 7.5 すべてのツールの断りは、理由の文が textResultForLlm に入り、resultType が failure で返る（例外を投げない）', async () => {
    await withRun(async (run) => {
      // 記録のツール（断る）
      assertFailure(await run.callRaw('progress', { items: [{ item: '成果', status: '聞いた', quote: 'x' }] }), /^聞くことの名前が違います：「成果」。使える名前：作業の目的、/, 'progress');
      assertFailure(await run.callRaw('progress', { stage: '違う段階' }), /^段階の名前が違います：「違う段階」/, 'progress 段階');
      assertFailure(await run.callRaw('record', { knowledge: [{ quote: 'x' }] }), /^新しい仕事のやり方や決まりに足りない欄：/, 'record');
      assertFailure(await run.callRaw('confirm', confirmArgs()), /^まだ聞いていないことがあるので、作る前の確認はできません：/, 'confirm');
      assertFailure(await run.callRaw('change', { folder: 'ないフォルダ', wants: ['足したい'] }), /^直すプラグインのフォルダ .*ないフォルダ が見つかりません。/, 'change');
      assertFailure(await run.callRaw('change', { folder: '.', wants: ['足したい'] }), /^.* に plugin\.json がありません（探した場所：plugin\.json、/, 'change plugin.json なし');
      // 状態取得ツール、結果の知らせ、文書、起票
      assertFailure(await run.callRaw('state', { include: '違う値' }), /^include の値が違います：「違う値」/, 'state');
      assertFailure(await run.callRaw('results', {}), /^結果のファイルの場所の一覧（paths）を渡してください。/, 'results');
      assertFailure(await run.callRaw('results', { paths: ['ない.json'] }), /^見つかりません：/, 'results 見つからない');
      assertFailure(await run.callRaw('doc_text', {}), /^文書の場所（path）を渡してください。/, 'doc_text');
      assertFailure(await run.callRaw('doc_text', { path: 'ない.docx' }), /^ファイルが見つかりません：/, 'doc_text 見つからない');
      assertFailure(await run.callRaw('issue', { title: '', body: '本文' }), /^Issue の題が空です。/, 'issue');
    });
  });

  test('hearing.md 7.5 段階「生成」に進んだあとの断りも、failure の結果で返る', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      await run.call('confirm', confirmArgs());
      await run.call('progress', { stage: '生成', approvalQuote: '作ってください' });
      assertFailure(await run.callRaw('progress', { stage: '始まり' }), /^お話を聞くことは終わっています（段階は「生成」）。/, 'progress');
      assertFailure(await run.callRaw('record', { knowledge: [knowledge()] }), /^お話を聞くことは終わっています/, 'record');
      assertFailure(await run.callRaw('confirm', confirmArgs()), /^お話を聞くことは終わっています/, 'confirm');
    });
  });

  test('REQ-015 記録のファイルが読めないときの断り（RecordUnreadable）も、failure の結果で返る。壊れた記録は上書きしない', async () => {
    const home = tempDir('failure-broken-home');
    const cwd = tempDir('failure-broken-cwd');
    try {
      const first = await startForTest({ sessionId: 'session-failure', home, cwd });
      await first.call('progress', { stage: '始まり' });
      const file = first.statePath();
      await first.cleanup();
      fs.writeFileSync(file, '{ 壊れた', 'utf8');
      const second = await startForTest({ sessionId: 'session-failure', home, cwd });
      assertFailure(await second.callRaw('progress', { stage: '読む' }), /^お話を聞くことの記録（.*state\.json）を読めません。ファイルを確かめてください。/, 'progress');
      assert.equal(fs.readFileSync(file, 'utf8'), '{ 壊れた');
      await second.cleanup();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('REQ-043 画面を起動できないときの open と、見本を作れないときの confirm の断りも、failure の結果で返る', async () => {
    const loadUi = async () => {
      throw new Error('画面の部品（ひな形の ui/server.mjs）を読み込めません：見つかりません');
    };
    await withRun(
      async (run) => {
        assertFailure(await run.callRaw('open', {}), /^plugin-creator の画面を起動できません：画面の部品/, 'open');
        await readyToConfirm(run);
        assertFailure(await run.callRaw('confirm', confirmArgs()), /^画面の部品（ひな形の ui\/server\.mjs）を読み込めません：見つかりません/, 'confirm');
        assert.equal(run.readState().confirmation, null, '見本を作れなかったときは、確認を受け付けない');
      },
      { extra: { loadUi } },
    );
  });

  test('REQ-027 画面と合格の条件の設定の案が読めない・決まりに合わないときの断りも、failure の結果で返る', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      const draft = path.join(run.cwd, '.plugin-creator-work', 'draft', 'task.json');
      fs.rmSync(draft);
      assertFailure(await run.callRaw('confirm', confirmArgs()), /^画面と合格の条件の設定の案が見つかりません：/, '案がない');
      fs.writeFileSync(draft, '{ 壊れた');
      assertFailure(await run.callRaw('confirm', confirmArgs()), /^画面と合格の条件の設定の案が JSON として読めません：/, 'JSON が壊れている');
      fs.writeFileSync(draft, JSON.stringify({ name: '週報の作成', maxIterationsDefault: 'たくさん' }));
      assertFailure(await run.callRaw('confirm', confirmArgs()), /^画面と合格の条件の設定の案が決まりに合いません/, '決まりに合わない');
    });
  });
});

describe('想定外の失敗（内部の情報を出さず、記録に残す）', () => {
  test('hearing.md 7.5 想定外の例外は、平易な文の failure の結果で返り、スタックと内部の語は返さず、標準エラーの記録に残る', async () => {
    const boom = async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'code')");
    };
    await withRun(
      async (run) => {
        const result = await run.callRaw('issue', { title: '題', body: '本文' });
        assertFailure(result, /^うまくいきませんでした/, 'issue');
        for (const internal of ['TypeError', 'Cannot read', 'undefined', ' at ', '.mjs', 'node:', 'stack']) {
          assert.ok(!result.textResultForLlm.includes(internal), `内部の情報が出ている（${internal}）：${result.textResultForLlm}`);
        }
        assert.deepEqual(leftWordsIn(result.textResultForLlm), []);
        // 記録（エクステンションのログ＝標準エラー）には、原因とスタックが残る
        assert.equal(run.warnings.length, 1);
        assert.match(run.warnings[0], /TypeError: Cannot read properties of undefined \(reading 'code'\)/);
        assert.match(run.warnings[0], /\n\s+at /);
      },
      { extra: { runGh: boom } },
    );
  });

  test('hearing.md 7.5 Error でないものが投げられても、同じように failure の結果で返る', async () => {
    await withRun(
      async (run) => {
        const result = await run.callRaw('issue', { title: '題', body: '本文' });
        assertFailure(result, /^うまくいきませんでした/, 'issue');
        assert.ok(!result.textResultForLlm.includes('文字列のまま'));
        assert.match(run.warnings[0], /文字列のまま/);
      },
      {
        extra: {
          runGh: async () => {
            throw '文字列のまま投げられた';
          },
        },
      },
    );
  });

  test('hearing.md 7.5 想定外の失敗のあとも、ほかのツールは動く（エクステンションは落ちない）', async () => {
    await withRun(
      async (run) => {
        assertFailure(await run.callRaw('issue', { title: '題', body: '本文' }), /^うまくいきませんでした/);
        assert.match(await run.call('progress', { stage: '始まり' }), /^記録しました（段階：始まり）。/);
      },
      {
        extra: {
          runGh: async () => {
            throw new RangeError('想定外');
          },
        },
      },
    );
  });
});

describe('正常な結果の形（変えていない）', () => {
  test('hearing.md 7.5 成功のときは、これまでどおり文字列を返す（ToolResultObject にしない）', async () => {
    const ok = { code: 0, stdout: 'https://github.com/xclang-brain/plugin-creator/issues/7\n', stderr: '', timedOut: false, notFound: false };
    await withRun(
      async (run) => {
        const outputs = {};
        outputs.open = await run.callRaw('open', {});
        outputs.state = await run.callRaw('state', {});
        outputs.progress = await run.callRaw('progress', { stage: '始まり' });
        await answerEverything(run);
        outputs.record = await run.callRaw('record', {
          knowledge: [knowledge(), knowledge({ kind: '合否の決め方', item: '合否の決め方', text: '見出しが順に並んでいれば合格', quote: '実績が先です' })],
        });
        fs.mkdirSync(path.join(run.cwd, 'tests', 'results'), { recursive: true });
        fs.writeFileSync(path.join(run.cwd, 'tests', 'results', 'latest.json'), JSON.stringify({ status: 'passed', stages: [] }));
        outputs.results = await run.callRaw('results', { paths: ['tests/results/latest.json'] });
        fs.writeFileSync(path.join(run.cwd, '週報.docx'), sampleDocx());
        outputs.doc_text = await run.callRaw('doc_text', { path: '週報.docx' });
        outputs.issue = await run.callRaw('issue', { title: '題', body: '本文' });
        writeDraft(run.cwd);
        outputs.confirm = await run.callRaw('confirm', confirmArgs());
        for (const [tool, value] of Object.entries(outputs)) assert.equal(typeof value, 'string', `${tool} の成功の結果が文字列でない：${JSON.stringify(value)}`);
        assert.match(outputs.confirm, /^作る前の確認で示すものを受け付けました。/);
        assert.match(outputs.issue, /^起票しました：https:\/\/github\.com\/xclang-brain\/plugin-creator\/issues\/7$/);
      },
      { extra: { runGh: async () => ok } },
    );
  });
});

describe('どんな引数でも、例外を投げない', () => {
  test('hearing.md 7.5 引数が空・型違い・でたらめでも、どのツールの処理も例外を投げず、文字列か failure の結果を返す', async () => {
    const weird = [undefined, null, [], 'text', 42, true, {}, { items: 'x' }, { items: [null] }, { items: [{}] }, { knowledge: 5 }, { knowledge: [null, 3] }, { assets: {} }, { oss: [[]] }, { paths: 'x' }, { paths: [5] }, { path: 5 }, { title: 5, body: [] }, { knowledgeIds: 'K-01', evalTasks: 'x' }, { stage: 7 }, { include: {} }];
    await withRun(async (run) => {
      let calls = 0;
      for (const tool of ['open', 'state', 'progress', 'record', 'confirm', 'change', 'results', 'doc_text', 'issue']) {
        for (const args of weird) {
          // 例外が出れば、ここで試験が落ちる（callRaw は例外をそのまま投げる）
          const result = await run.callRaw(tool, args);
          calls += 1;
          if (typeof result !== 'string') {
            assert.equal(result.resultType, 'failure', `${tool} ${JSON.stringify(args)}`);
            assert.equal(typeof result.textResultForLlm, 'string');
            assert.ok(result.textResultForLlm.length > 0);
          }
        }
      }
      assert.equal(calls, 9 * weird.length);
    });
  });
});
