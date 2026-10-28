// ユーザーに話す言葉の試験（skills/make-plugin/references/words.md の表。ユーザーの答え22）。
// ツールの返り値、断る文、見本の文、画面のソースの文に、表の左の言葉（ナレッジ、ヒアリング、候補、生成前の確認など）が出ないことを確かめる。
// ブラウザーに出る画面の文は screen.browser.test.mjs が確かめる。
// 引数の値（段階、項目、状態、種類、出どころの名前。BLUEPRINT 7章）は変えないので、その場所だけ見逃す（words.mjs）。
// 設計書：hearing.md 10.2 の言葉の決まり、REQ-024、REQ-043。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  EXTENSION_DIR,
  answerEverything,
  answers,
  changeConfirmArgs,
  confirmArgs,
  internalSymbolsIn,
  knowledge,
  readyToConfirm,
  readyToConfirmChange,
  startChange,
  withRun,
  writeDraft,
  writePluginFolder,
} from './helpers.mjs';
import { LEFT_WORDS, leftWordsIn, withoutComments } from './words.mjs';

describe('言葉の見張り（words.mjs）が、言い換え忘れを見つける', () => {
  test('REQ-024 表の左の言葉は見つけ、引数の値として出ている場所だけ見逃す', () => {
    assert.deepEqual(leftWordsIn('確かめていない候補が1件あります'), ['候補']);
    assert.deepEqual(leftWordsIn('生成前の確認で示すものを受け付けました'), ['生成前の確認']);
    assert.deepEqual(leftWordsIn('ナレッジ K-01 を追加。ヒアリングは終わっています'), ['ナレッジ', 'ヒアリング']);
    assert.deepEqual(leftWordsIn('項目の状態を変えます'), ['項目']);
    assert.deepEqual(leftWordsIn('Web管理画面の見本で EVAL を動かす'), ['Web管理画面', 'EVAL']);
    // 見逃す場所：「」で括った名前、「使える名前：」の一覧、「段階：」のあとの段階の名前、項目や段階の名前そのもの
    assert.deepEqual(leftWordsIn('状態が「候補」のもの。段階を「生成前の確認」に進めます。'), []);
    assert.deepEqual(leftWordsIn('段階の名前が違います：「x」。使える名前：始まり、項目の点検、生成前の確認、生成'), []);
    assert.deepEqual(leftWordsIn('段階：生成前の確認\n候補の確かめ：未着手（確かめたいこと 1件）\nまだ聞いていないこと：候補の確かめ'), []);
    assert.deepEqual(leftWordsIn('今の段階：項目の点検'), []);
  });
});

describe('ツールの返り値と断る文（REQ-024）', () => {
  test('REQ-024 すべてのツールの返り値と断る文に、表の左の言葉が出ない（段階・項目・状態・種類・出どころの名前を除く）', async () => {
    await withRun(async (run) => {
      const seen = [];
      const call = async (tool, args) => {
        const r = await run.callSafe(tool, args);
        seen.push(r.ok ? r.text : r.error);
        return r;
      };

      // 画面と状態（記録がまだないとき）
      await call('open', {});
      await call('state', {});

      // 段階と、聞くことの状態
      await call('progress', { stage: '始まり' });
      await call('progress', {});
      await call('progress', { stage: '違う段階' });
      await call('progress', { items: [] });
      await call('progress', { items: [{ item: '成果', status: '聞いた', quote: 'x' }] });
      await call('progress', { items: [{ item: '成果物', status: '済み', quote: 'x' }] });
      await call('progress', { items: [{ item: '成果物', status: '未着手', quote: 'x' }] });
      await call('progress', { items: [{ item: '成果物', status: '聞いた' }] });
      await call('progress', { items: [{ item: '候補の確かめ', status: '聞いた', quote: 'x' }] });
      await call('progress', { items: [{ item: '成果物', status: '保留', quote: '分からない', holder: '経理の山田さん' }] });
      await call('progress', { stage: '生成', approvalQuote: '作ってください' });

      // 決まったこと：足りない欄、違う名前、更新、候補に戻す、資産、標準機能と公開のプラグイン
      await call('record', {});
      await call('record', { knowledge: [{ quote: 'x' }] });
      await call('record', { knowledge: [knowledge({ kind: '種類違い' })] });
      await call('record', { knowledge: [knowledge({ item: '前回の1回' })] });
      await call('record', { knowledge: [knowledge({ text: ' ' })] });
      await call('record', { knowledge: [knowledge({ source: '出どころ違い' })] });
      await call('record', { knowledge: [knowledge({ status: '済み' })] });
      await call('record', { knowledge: [knowledge({ quote: ' ' })] });
      await call('record', { knowledge: [knowledge({ text: '毎週金曜日の17時までに提出する', example: '金曜の夕方', exception: '祝日の週は月曜' })] }); // K-01
      await call('record', { knowledge: [knowledge({ kind: '合否の決め方', item: '合否の決め方', text: '見出しが「実績」「予定」の順に並んでいれば合格', quote: '実績が先です' })] }); // K-02
      await call('record', { knowledge: [knowledge({ text: '提出前に上長が確認する', status: '候補', source: 'ファイルから読んで確かめた', quote: '週報.docx の末尾' })] }); // K-03
      await call('record', { knowledge: [knowledge({ text: '別の表の決まり', status: '候補', source: '既存のプラグインから読んで確かめた', quote: 'SKILL.md の12行目' })] }); // K-04
      await call('record', { knowledge: [knowledge({ text: '頼みの文にあった目的', status: '候補', source: 'ユーザーが自分から話した', quote: '頼みの文' })] }); // K-05
      await call('record', { knowledge: [{ id: 'K-01', text: '毎週金曜日の17時までに提出し直す', quote: '直しました' }] });
      await call('record', { knowledge: [{ id: 'K-01', status: '候補', quote: 'x' }] });
      await call('record', { knowledge: [{ id: 'K-99', text: 'x', quote: 'x' }] });
      await call('record', { assets: [{ name: '古い集計表', status: '済み' }] });
      await call('record', { oss: [{ name: '議事録の部品', kind: '種類違い', choice: '使う' }] });
      await call('record', { oss: [{ name: '議事録の部品', kind: '公開のプラグイン', choice: '使う', note: '書式が合う' }], assets: [{ name: '週報テンプレート', status: '流用する' }, { name: '古い集計表', status: '候補' }] });

      // 状態（確かめたいことが残っている）
      await call('state', {});
      await call('state', { include: '最後の問答' });
      await call('state', { include: '振り返りの材料' });
      await call('state', { include: '違う値' });

      // 作る前の確認：まだ聞いていないことが残っている
      await call('confirm', confirmArgs());
      await answerEverything(run);
      await call('progress', { stage: '決まりの確かめ' });
      const stillOpen = await call('confirm', confirmArgs());
      assert.match(stillOpen.error, /まだ聞いていないことがあるので、作る前の確認はできません：候補の確かめ/);
      await call('record', { knowledge: [{ id: 'K-03', status: '決まった', quote: 'はい、そのとおり' }, { id: 'K-04', status: '外した', quote: '違います' }, { id: 'K-05', status: '外した', quote: '違います' }] });
      await call('progress', { stage: '生成前の確認' });
      await call('state', {});

      // 作る前の確認：示すものの足りなさと違い
      await call('confirm', confirmArgs({ knowledgeIds: [] }));
      await call('confirm', confirmArgs({ behavior: ' ' }));
      await call('confirm', confirmArgs({ taskPath: ' ' }));
      await call('confirm', confirmArgs({ evalTasks: [] }));
      await call('confirm', confirmArgs({ evalTasks: [{ prompt: ' ' }] }));
      await call('confirm', confirmArgs({ evalTasks: [{ prompt: '頼む', inputs: [{ path: ' ' }] }] }));
      await call('confirm', confirmArgs({ knowledgeIds: ['K-99', 'K-01', 'K-02', 'K-03'] }));
      await call('confirm', confirmArgs({ knowledgeIds: ['K-01', 'K-02', 'K-03', 'K-04'] }));
      await call('confirm', confirmArgs({ knowledgeIds: ['K-01', 'K-02'] }));
      await call('confirm', confirmArgs({ knowledgeIds: ['K-01', 'K-02', 'K-03'], evalTasks: [{ prompt: '頼む', criteria: ['K-01'] }] }));
      await call('confirm', confirmArgs({ knowledgeIds: ['K-01', 'K-02', 'K-03'], evalTasks: [{ prompt: '頼む', criteria: ['K-09'] }] }));
      await call('confirm', confirmArgs({ knowledgeIds: ['K-01', 'K-02', 'K-03'], evalTasks: [{ prompt: '頼む', settings: { maxIterations: 0 } }] }));
      await call('confirm', confirmArgs({ knowledgeIds: ['K-01', 'K-02', 'K-03'], evalTasks: [{ prompt: '頼む', settings: { iterations: 3 } }] }));
      await call('confirm', confirmArgs({ knowledgeIds: ['K-01', 'K-02', 'K-03'], evalTasks: [{ prompt: '頼む', settings: { task: { week: { a: 1 } } } }] }));
      await call('confirm', confirmArgs({ knowledgeIds: ['K-01', 'K-02', 'K-03'], evalTasks: [{ prompt: '頼む', settings: 'x' }] }));
      await call('confirm', confirmArgs({ knowledgeIds: ['K-01', 'K-02', 'K-03'], taskPath: 'other/task.json' }));
      await call('confirm', confirmArgs({ knowledgeIds: ['K-01', 'K-02', 'K-03'] })); // 案がまだない
      const draft = writeDraft(run.cwd);
      fs.writeFileSync(draft, '{ 壊れた');
      await call('confirm', confirmArgs({ knowledgeIds: ['K-01', 'K-02', 'K-03'] }));
      writeDraft(run.cwd, { maxIterationsDefault: 'たくさん' });
      await call('confirm', confirmArgs({ knowledgeIds: ['K-01', 'K-02', 'K-03'] }));
      writeDraft(run.cwd);
      await call('confirm', confirmArgs({ knowledgeIds: ['K-01', 'K-02', 'K-03'], evalTasks: [{ prompt: '頼む', settings: { task: { weeks: 'x', style: '超詳細' } } }] }));
      await call('confirm', confirmArgs({ knowledgeIds: ['K-01', 'K-02', 'K-03'], evalTasks: [{ prompt: '頼む', settings: { task: { style: '詳細' } } }] }));
      const accepted = await call('confirm', confirmArgs({ knowledgeIds: ['K-01', 'K-02', 'K-03'] }));
      assert.equal(accepted.ok, true, accepted.error);
      assert.match(accepted.text, /^作る前の確認で示すものを受け付けました。画面で見られます。作業の画面の見本：http:\/\/127\.0\.0\.1:\d+\/\?k=/);

      // 生成に進める：示したあとに作業の定義の案が変わる・消えると断る
      writeDraft(run.cwd, { name: '別の名前' });
      await call('progress', { stage: '生成', approvalQuote: '作ってください' });
      fs.rmSync(draft);
      await call('progress', { stage: '生成', approvalQuote: '作ってください' });
      writeDraft(run.cwd);

      // 生成に進める：示したあとに決まったことが変わると断る
      await call('progress', { stage: '生成' });
      await call('record', { knowledge: [knowledge({ text: '確認のあとで足した決まり', source: '生成前の確認で足した', quote: '足したい' })] });
      await call('progress', { stage: '生成', approvalQuote: '作ってください' });
      await call('confirm', confirmArgs({ knowledgeIds: ['K-01', 'K-02', 'K-03', 'K-06'] }));
      await call('state', { include: '振り返りの材料' });
      const generated = await call('progress', { stage: '生成', approvalQuote: '作ってください' });
      assert.equal(generated.ok, true, generated.error);

      // 生成に進んだあと
      await call('progress', { items: [{ item: '成果物', status: '聞いた', quote: 'x' }] });
      await call('record', { knowledge: [knowledge()] });
      await call('confirm', confirmArgs());
      await call('state', {});

      // 試験の結果、文書、起票
      await call('results', {});
      await call('results', { paths: ['tests/results/ない.json'] });
      fs.mkdirSync(path.join(run.cwd, 'tests', 'results'), { recursive: true });
      fs.writeFileSync(path.join(run.cwd, 'tests', 'results', 'latest.json'), JSON.stringify({ status: 'passed', stages: [] }));
      await call('results', { paths: ['tests/results/latest.json'] });
      await call('doc_text', {});
      await call('doc_text', { path: 'ない.docx' });
      fs.writeFileSync(path.join(run.cwd, 'メモ.txt'), 'x');
      await call('doc_text', { path: 'メモ.txt' });
      await call('issue', { title: '', body: '本文' });
      await call('issue', { title: '題', body: ' ' });

      assert.ok(seen.length >= 80, `${seen.length}件`);
      const found = seen.map((text) => [text, leftWordsIn(text)]).filter(([, words]) => words.length > 0);
      assert.deepEqual(found, [], `表の左の言葉が出ている：\n${found.map(([t, w]) => `${w.join('、')} ← ${t}`).join('\n')}`);

      // 試験が空振りでないことの確かめ：表の右の言葉で話している
      const all = seen.join('\n');
      assert.ok(!all.includes('クリエイター'), '「クリエイター」はユーザーに説明していない言葉。画面は「plugin-creator の画面」と呼ぶ（X2-18）');
      assert.ok(all.includes('plugin-creator の画面'));
      for (const word of ['仕事のやり方や決まり', 'お話を聞くことは終わっています', '確かめたいこと', '作る前の確認', '聞くこと', '作業の画面の見本', '画面と合格の条件の設定', '試しに動かして採点する試験の課題', '合格の条件']) {
        assert.ok(all.includes(word), `表の右の言葉が1度も出ていない：${word}`);
      }
    });
  });

  test('REQ-024 REQ-027 種類が「合否の決め方」のものがないと断る文にも、表の左の言葉が出ない', async () => {
    await withRun(async (run) => {
      await answerEverything(run);
      await run.call('record', { knowledge: [knowledge()] });
      writeDraft(run.cwd);
      const refused = await run.callSafe('confirm', confirmArgs({ knowledgeIds: ['K-01'], evalTasks: [{ prompt: '頼む' }] }));
      assert.equal(refused.ok, false);
      assert.match(refused.error, /^種類が「合否の決め方」の仕事のやり方や決まりがありません。合格の条件は、/);
      assert.deepEqual(leftWordsIn(refused.error), []);
    });
  });

  test('REQ-024 抜き書きの確かめ（ユーザーの答えの中にない、選んだ選択肢の文だけ）の断る文にも、表の左の言葉が出ない', async () => {
    await withRun(async (run) => {
      await run.call('progress', { stage: '始まり' });
      const choice = '違うところはない（この一覧と案で合っている）';
      await run.fake.askUser({ message: '足りないことや違うところはありますか？', choices: [choice], answer: `User responded: ${choice}` });
      const notFound = await run.callSafe('progress', { items: [{ item: '成果物', status: '聞いた', quote: '要約した言葉' }] });
      const onlyChoice = await run.callSafe('record', { knowledge: [knowledge({ source: '生成前の確認で足した', quote: choice })] });
      for (const refused of [notFound, onlyChoice]) {
        assert.equal(refused.ok, false);
        assert.deepEqual(leftWordsIn(refused.error), [], refused.error);
        assert.deepEqual(internalSymbolsIn(refused.error), []);
      }
      assert.match(notFound.error, /ユーザーの答えの中に見つかりません/);
      assert.match(onlyChoice.error, /自分の言葉で述べた決まりだけです/);
    });
  });

  test('REQ-024 会話の自動の要約のあとの差し込みの文にも、表の左の言葉が出ない（作るときと、今のプラグインを直すとき）', async () => {
    const { COMPACTION_NOTICE, COMPACTION_NOTICE_CHANGE } = await import(pathToFileURL(path.join(EXTENSION_DIR, 'hooks.mjs')).href);
    assert.deepEqual(leftWordsIn(COMPACTION_NOTICE), []);
    assert.deepEqual(leftWordsIn(COMPACTION_NOTICE_CHANGE), []);
  });

  test('REQ-024 REQ-052 今のプラグインを直すときの返り値と断る文にも、表の左の言葉と内部の記号が出ない', async () => {
    await withRun(async (run) => {
      const seen = [];
      const call = async (tool, args) => {
        const r = await run.callSafe(tool, args);
        seen.push(r.ok ? r.text : r.error);
        return r;
      };
      // 直すフォルダの誤り
      await call('change', {});
      await call('change', { folder: 'x' });
      await call('change', { folder: 'x', wants: [] });
      await call('change', { folder: 'x', wants: [3] });
      await call('change', { folder: 'ないフォルダ', wants: ['足したい'] });
      writePluginFolder(run.cwd, { dir: 'broken', knowledge: '{ 壊れた' });
      await call('change', { folder: 'broken', wants: ['足したい'] });
      writePluginFolder(run.cwd, { dir: 'bad-shape', knowledge: [{ id: 'K-1x', kind: 'other', item: '進め方', text: 'x' }] });
      await call('change', { folder: 'bad-shape', wants: ['足したい'] });
      writePluginFolder(run.cwd, { dir: 'not-made', knowledge: null });
      fs.writeFileSync(path.join(run.cwd, 'file.txt'), 'x');
      await call('change', { folder: 'file.txt', wants: ['足したい'] });
      await call('change', { folder: '.', wants: ['足したい'] });

      // 記録を作る・呼び直す・違うフォルダ
      const { folder } = await startChange(run);
      seen.push((await startChange(run)).text);
      await call('change', { folder: 'not-made', wants: ['足したい'] });

      // 変えないので聞かない、聞かずに案で示す、できていたことの確認、付け直し
      await call('progress', { items: [{ item: '前回の1回', status: '変えないので聞かない', quote: 'x' }] });
      await call('progress', { items: [{ item: 'いつもと違うとき', status: '聞いた', quote: 'x' }] });
      await call('progress', { items: [{ item: 'いつもと違うとき', status: '変えないので聞かない', quote: 'x' }] });
      await call('progress', { items: [{ item: '成果物', status: '聞かずに案で示す', quote: 'x' }] });
      await call('progress', { items: [{ item: 'いつもと違うとき', status: '聞かずに案で示す', quote: 'x' }] });
      await call('progress', { items: [{ item: '資産', status: '聞かずに案で示す', quote: 'x' }] });
      await call('progress', { stage: 'できていたことの確認' });
      await call('progress', { items: [{ item: 'できていたことの確認', status: '聞いた', quote: 'x' }] });
      await call('record', { knowledge: [{ id: 'K-05', text: 'デプロイできないときは、機器を1回 reboot し、それでもだめなら人に伝える', quote: '今はこうです' }] });
      await call('record', { knowledge: [{ id: 'K-05', status: '決まった', quote: '戻したい' }] });
      await call('state', {});

      // 直す前の確認の断り
      const added = await readyToConfirmChange(run, { carried: ['K-01', 'K-02', 'K-03', 'K-04'] });
      const ids = ['K-01', 'K-02', 'K-03', 'K-04', 'K-06', added];
      await call('confirm', changeConfirmArgs(ids, { rebuild: undefined }));
      await call('confirm', changeConfirmArgs(ids, { rebuild: { keep: ['x'], change: [] } }));
      await call('confirm', changeConfirmArgs(ids, { version: undefined }));
      await call('confirm', changeConfirmArgs(ids, { version: '1.0' }));
      await call('confirm', changeConfirmArgs(ids, { version: '0.1.0' }));
      await call('confirm', changeConfirmArgs(ids, { version: 2 }));
      await call('confirm', changeConfirmArgs(ids, { evalTasks: [changeConfirmArgs(ids).evalTasks[0]] }));
      const accepted = await call('confirm', changeConfirmArgs(ids));
      assert.equal(accepted.ok, true, accepted.error);
      assert.match(accepted.text, /^直す前の確認で示すものを受け付けました。/);
      await call('state', { include: '振り返りの材料' });
      assert.ok(folder);

      assert.ok(seen.length >= 25, `${seen.length}件`);
      if (process.env.SHOW_WORDS) console.log(seen.join("\n---\n"));
      const found = seen.map((text) => [text, leftWordsIn(text), internalSymbolsIn(text)]).filter(([, words, symbols]) => words.length > 0 || symbols.length > 0);
      assert.deepEqual(found, [], `表の左の言葉か内部の記号が出ている：\n${found.map(([t, w, s]) => `${[...w, ...s].join('、')} ← ${t}`).join('\n')}`);
      const all = seen.join('\n');
      assert.ok(!all.includes('クリエイター'), '「クリエイター」はユーザーに説明していない言葉');
      for (const word of ['直すプラグイン', '直す前の確認', '変えないので聞かない', '聞かずに案で示す', '確かめたいこと', '引き継いだ決まり']) assert.ok(all.includes(word), `言葉が1度も出ていない：${word}`);
    });
  });

  test('REQ-024 REQ-056 今のプラグインを直すときの、頼みの文に関わる抜き書きの断りにも、表の左の言葉と内部の記号が出ない', async () => {
    await withRun(async (run) => {
      await run.hook('onUserPromptSubmitted', { prompt: 'デプロイを足したい。いつもは 1. ビルド 2. 送る、の順です' });
      await startChange(run);
      await run.fake.askUser({ message: '最近の1回で、したことは何ですか？', answer: 'User responded: 電源を入れ直しました' });
      const refused = [];
      for (const [item, quote] of [['前回の1回', '1. ビルド 2. 送る'], ['前回の1回', '別の言葉'], ['成果物', '別の言葉']]) {
        const r = await run.callSafe('progress', { items: [{ item, status: '聞いた', quote }] });
        assert.equal(r.ok, false, `${item}：${quote}`);
        refused.push(r.error);
      }
      assert.match(refused[0], /頼みの文からは取れません/);
      assert.match(refused[2], /ユーザーの答えと頼みの文の中に見つかりません/);
      for (const text of refused) {
        assert.deepEqual(leftWordsIn(text), [], text);
        assert.deepEqual(internalSymbolsIn(text), [], text);
      }
    });
  });

  test('REQ-024 状態の返り値は、確かめたいこと・お話を聞くこと・仕事のやり方や決まりで話し、出どころも表の言葉で示す', async () => {
    await withRun(async (run) => {
      await run.call('progress', { stage: '決まりの確かめ' });
      await run.call('record', { knowledge: [knowledge({ text: '提出前に上長が確認する', status: '候補', source: 'ファイルから読んで確かめた', quote: '週報.docx の末尾' })] });
      await run.call('record', { knowledge: [knowledge({ text: '確認のあとで足した決まり', source: '生成前の確認で足した', quote: '足したい' })] });
      await run.call('record', { knowledge: [knowledge({ text: '聞いて答えた決まり', quote: '答え' })] });
      const text = await run.call('state', { include: '振り返りの材料' });
      assert.match(text, /^確かめたいこと（仕事のやり方や決まりのうち、状態が「候補」のもの）：$/m);
      assert.match(text, /仕事のやり方や決まり：確かめたいこと1件、決まった2件、外した0件/);
      assert.match(text, /作る前の確認で足した/);
      assert.deepEqual(leftWordsIn(text), []);
    });
  });
});

describe('見本の文（sample.mjs）', () => {
  test('REQ-024 REQ-027 作業の画面の見本の注意、仮のまとめ、仮の計画に、表の左の言葉が出ない', async () => {
    const { buildSampleState, injectCriteria } = await import(pathToFileURL(path.join(EXTENSION_DIR, 'sample.mjs')).href);
    const task = injectCriteria(
      { name: '週報の作成', maxIterationsDefault: 3, workers: [{ agent: 'worker', label: '週報を書く係' }], settings: [], displays: [] },
      [{ id: 'K-02', kind: 'criterion', text: '見出しが順に並んでいれば合格' }],
    );
    for (const mode of ['preparing', 'running', 'finished']) {
      const text = JSON.stringify(buildSampleState({ task, mode, version: 1, nowMs: 0 }), null, 1);
      assert.deepEqual(leftWordsIn(text), [], mode);
      if (mode === 'preparing') assert.match(text, /これは作業の画面の見本です。/);
      if (mode === 'finished') assert.match(text, /すべての合格の条件を満たしました。/);
    }
  });
});

describe('ソースの文（ユーザーに見える文を持つファイルのすべて）', () => {
  // 注釈を除いた文字列に、表の左の言葉がないこと。実行して通らない道筋（まれな失敗の文など）の言い換え忘れも見つけるため。
  // 入れないもの：モデルに送るツールの説明の文（descriptions.mjs。ユーザーの答え22で変えない）、名前の表（names.mjs。引数の値の定義）、
  // ツールの定義（tool-defs.mjs。引数の値を並べるだけ）、定数（constants.mjs）
  const FILES = [
    'creator.mjs',
    'change.mjs',
    'hearing.mjs',
    'report.mjs',
    'hooks.mjs',
    'store.mjs',
    'sample.mjs',
    'results.mjs',
    'screen.mjs',
    'issue.mjs',
    'doc-text.mjs',
    'eval-settings.mjs',
    'quote.mjs',
    'zip.mjs',
    'schema-check.mjs',
    'extension.mjs',
    'ui/static/creator.js',
    'ui/static/index.html',
  ];

  for (const file of FILES) {
    test(`REQ-024 REQ-043 ${file} の文に、表の左の言葉がない`, () => {
      const source = withoutComments(fs.readFileSync(path.join(EXTENSION_DIR, file), 'utf8'))
        // 試験の入口（tests/run.py）が書く段階の名前を、ユーザーに話す言葉に直す表の左側（入力の名前）だけは、左の言葉のまま持つ
        .split('\n')
        .filter((line) => !line.includes('STAGE_NAME_DISPLAY ='))
        .join('\n');
      const found = [];
      source.split('\n').forEach((line, i) => {
        const words = leftWordsIn(line);
        if (words.length) found.push(`${file}:${i + 1} ${words.join('、')} ← ${line.trim().slice(0, 100)}`);
      });
      assert.deepEqual(found, []);
      // 同じ画面を「クリエイターの画面」と呼ばない。ユーザーに説明していない言葉で、スキルと README は「plugin-creator の画面」と呼ぶ（X2-18）
      assert.ok(!source.includes('クリエイター'), `${file} の文に「クリエイター」がある`);
    });
  }

  test('REQ-024 見張りの言葉の一覧が、references/words.md の表の左の言葉と同じである（表を変えたら、見張りも変える）', () => {
    const table = fs.readFileSync(path.join(EXTENSION_DIR, '..', '..', '..', 'skills', 'make-plugin', 'references', 'words.md'), 'utf8');
    const rows = table.split('\n').filter((l) => /^\| /.test(l) && !/^\| (内部の言葉|---)/.test(l));
    const left = rows.flatMap((l) => l.split('|')[1].split('、')).map((w) => w.trim()).filter(Boolean);
    assert.deepEqual(left.filter((w) => !LEFT_WORDS.includes(w)), [], '表にあって、見張りにない言葉');
    assert.deepEqual(LEFT_WORDS.filter((w) => !left.includes(w)), [], '見張りにあって、表にない言葉');
  });
});
