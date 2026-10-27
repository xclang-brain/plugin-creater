// 2段目 部品の試験（クリエイターのエクステンション）：状態取得ツール、振り返りの材料、再開、記録の置き場所。
// 設計書：hearing.md 7.1、7.5、8章（再開）、11章、12章「2段目」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import {
  PLUGIN_KNOWLEDGE,
  SETTABLE_ITEMS,
  answers,
  changeConfirmArgs,
  confirmArgs,
  internalSymbolsIn,
  knowledge,
  listTree,
  readyToConfirm,
  readyToConfirmChange,
  startChange,
  startForTest,
  tempDir,
  withRun,
  writeDraft,
  writePluginFolder,
} from './helpers.mjs';
import { leftWordsIn } from './words.mjs';

const urlOf = (text) => /画面：(http:\/\/127\.0\.0\.1:\d+\/\?k=\S+)/.exec(text)?.[1];

/** 画面のサーバーの状態の全体（GET /api/state）を取りに行く */
const fetchState = (url) => fetch(`${new URL(url).origin}/api/state?k=${new URL(url).searchParams.get('k')}`);

describe('状態取得ツール（plugin-creator_state）', () => {
  test('REQ-015 記録がないときも呼べて、段階と画面の URL、セッションの番号、記録の場所、make-plugin の読み直しを返す', async () => {
    await withRun(async (run) => {
      const text = await run.call('state');
      assert.match(text, /^段階：（お話を聞くことの記録はまだありません）/m);
      assert.ok(urlOf(text), '画面の URL がない');
      assert.match(text, new RegExp(`セッションの番号：${run.sessionId}`));
      assert.ok(text.includes(`お話を聞くことの記録（state.json）：${run.statePath()}`), '組み立てのスクリプトに渡す state.json のパス');
      assert.match(text, /SKILL\.md の本文がコンテキストになければ、skill ツールで make-plugin を読み直してください。/);
      assert.equal(fs.existsSync(run.statePath()), false, '状態を見るだけでは、記録を作らない');
    });
  });

  test('REQ-043 段階、項目ごとの状態、まだ聞いていない項目、保留（だれが知っているか）、AI の判断を返す。内部の記号は出ない', async () => {
    await withRun(async (run) => {
      await run.call('progress', {
        stage: '項目の点検',
        items: [
          { item: '作業の目的', status: '聞いた', quote: '週報を作る' },
          { item: '成果物', status: '保留', quote: '分からない', holder: '経理の田中さん' },
          { item: 'いつもと違うとき', status: '決まりなし', quote: '特にない' },
        ],
      });
      await run.call('record', {
        knowledge: [
          knowledge({ item: '進め方', text: '提出前に上長が確認する', status: '候補', source: 'ファイルから読んで確かめた', quote: '週報.docx の末尾' }),
          knowledge({ item: '守らないと困ること', text: '数値は税抜きで書く', source: 'AI の判断（ユーザーが任せた）', quote: 'お任せします' }),
        ],
      });
      const text = await run.call('state');
      assert.match(text, /^段階：項目の点検$/m);
      assert.match(text, /^ {2}作業の目的：聞いた$/m);
      assert.match(text, /^ {2}成果物：保留$/m);
      assert.match(text, /^ {2}いつもと違うとき：決まりなし$/m);
      assert.match(text, /^ {2}頼む場面と言い方：未着手$/m);
      assert.match(text, /^ {2}候補の確かめ：未着手（確かめたいこと 1件）$/m);
      assert.match(text, /^まだ聞いていないこと：頼む場面と言い方、受け取るもの、進め方/m);
      assert.match(text, /確かめたいこと（仕事のやり方や決まりのうち、状態が「候補」のもの）：\n {2}K-01（聞くこと：進め方、出どころ：ファイルから読んで確かめた）：提出前に上長が確認する/);
      assert.match(text, /保留：\n {2}成果物（知っている人：経理の田中さん）/);
      assert.match(text, /AI の判断（ユーザーが任せたこと）：\n {2}K-02（守らないと困ること）：数値は税抜きで書く/);
      assert.match(text, /仕事のやり方や決まり：確かめたいこと1件、決まった1件、外した0件/);
      assert.deepEqual(internalSymbolsIn(text), []);
      assert.ok(Buffer.byteLength(text, 'utf8') < 4096, `数 KB 以内にする：${Buffer.byteLength(text, 'utf8')}バイト`);
    });
  });

  test('REQ-017 確かめていない候補の行に、出どころも示す（段階「決まりの確かめ」は、ファイルから読んだ候補だけを確かめる。コンパクションの後に見分けるため）', async () => {
    await withRun(async (run) => {
      await run.call('record', {
        knowledge: [
          knowledge({ item: '進め方', text: 'ファイルから読んだ決まり', status: '候補', source: 'ファイルから読んで確かめた', quote: '週報.docx の2ページ' }),
          knowledge({ item: '成果物', text: '既存のプラグインにあった決まり', status: '候補', source: '既存のプラグインから読んで確かめた', quote: 'SKILL.md の12行目' }),
          knowledge({ item: '作業の目的', text: '頼みの文にあった目的', status: '候補', source: 'ユーザーが自分から話した', quote: '頼みの文' }),
          knowledge({ item: '成果物', text: '決まったもの', status: '決まった' }),
        ],
      });
      const text = await run.call('state');
      const lines = text.split('\n').filter((l) => /^ {2}K-0[1-3]（聞くこと：/.test(l));
      assert.deepEqual(lines, [
        '  K-01（聞くこと：進め方、出どころ：ファイルから読んで確かめた）：ファイルから読んだ決まり',
        '  K-02（聞くこと：成果物、出どころ：既存のプラグインから読んで確かめた）：既存のプラグインにあった決まり',
        '  K-03（聞くこと：作業の目的、出どころ：ユーザーが自分から話した）：頼みの文にあった目的',
      ]);
      assert.ok(!text.includes('決まったもの'), '決まったナレッジは、確かめていない候補の行に出ない');
      assert.deepEqual(internalSymbolsIn(text), []);
    });
  });

  test('REQ-015 引数「最後の問答」で、最後の数件（5件）の問答を返す', async () => {
    await withRun(async (run) => {
      await run.call('progress', { stage: '始まり' });
      for (let i = 1; i <= 4; i += 1) await run.fake.askUser({ message: `問い${i}`, answer: `User responded: 答え${i}` });
      await run.hook('onUserPromptSubmitted', { prompt: 'ユーザーの発言A' });
      await run.fake.askUser({ message: '問い5', answer: 'User cancelled the request.' });
      await run.hook('onUserPromptSubmitted', { prompt: 'ユーザーの発言B' });

      const plain = await run.call('state');
      assert.ok(!plain.includes('最後の問答'), '指定しなければ、問答は返さない');

      const text = await run.call('state', { include: '最後の問答' });
      assert.match(text, /最後の問答（5件）：/);
      assert.ok(!text.includes('問い1') && !text.includes('問い2'), '古い問答は返さない');
      assert.ok(text.includes('問い：問い3') && text.includes('答え：User responded: 答え3'));
      assert.ok(text.includes('ユーザーの発言：ユーザーの発言A'));
      assert.match(text, /問い：問い5\n {4}答え（取り消した（Esc））：User cancelled the request\./);
      assert.ok(text.includes('ユーザーの発言：ユーザーの発言B'));
    });
  });

  test('REQ-049 引数「振り返りの材料」で、質問の改善案の対象のナレッジの番号と、問答の記録のすべてを返す', async () => {
    await withRun(async (run) => {
      await run.call('progress', { stage: '始まり' });
      for (let i = 1; i <= 8; i += 1) await run.fake.askUser({ message: `問い${i}`, answer: `User responded: 答え${i}` });
      await run.call('record', { knowledge: [knowledge({ item: '進め方', source: 'ユーザーが自分から話した', text: '頼みの文にあった', quote: '頼みの文' })] });
      await run.call('progress', { items: [{ item: '進め方', status: '聞いた', quote: '答え3' }] }); // 抜き書きは、それより前の答えの中にある
      await run.call('record', { knowledge: [knowledge({ item: '進め方', source: 'ユーザーが自分から話した', text: '聞いた後に出てきた', quote: 'あ、それと' })] });

      const text = await run.call('state', { include: '振り返りの材料' });
      assert.match(text, /質問の改善案の対象の仕事のやり方や決まり（お話を聞くことで引き出せなかったもの）：\n {2}K-02（聞くこと：進め方）：そのことを聞いた後に、ユーザーが自分から話した/);
      assert.ok(!/K-01（聞くこと/.test(text), '未着手のときに話したものは対象にならない');
      assert.match(text, /問答の記録のすべて（8件。1行が1件の JSON）：/);
      for (let i = 1; i <= 8; i += 1) assert.ok(text.includes(`"message":"問い${i}"`), `問い${i}が材料にない`);
      assert.deepEqual(internalSymbolsIn(text.split('問答の記録のすべて')[0]), []);
    });
  });

  test('REQ-049 頼みの文は、最後の問答では「頼みの文」として示され、振り返りの材料の問答の記録にも入る', async () => {
    await withRun(async (run) => {
      await run.hook('onUserPromptSubmitted', { prompt: '週報づくりを自動化したい' });
      await run.call('progress', { stage: '始まり' });
      await run.fake.askUser({ message: '問い1', answer: 'User responded: 答え1' });

      const last = await run.call('state', { include: '最後の問答' });
      assert.match(last, /最後の問答（2件）：\n {2}\[\d\d:\d\d\] 頼みの文：週報づくりを自動化したい\n/);
      const review = await run.call('state', { include: '振り返りの材料' });
      assert.match(review, /問答の記録のすべて（2件。1行が1件の JSON）：/);
      assert.ok(review.includes('"type":"request","text":"週報づくりを自動化したい"'));
    });
  });

  test('REQ-049 質問の改善案の対象（11章の1つ目の観点）：未着手の項目に話したものは対象にならず、聞いた後に話したものと、確認で足したものは対象になる', async () => {
    await withRun(async (run) => {
      await run.call('record', { knowledge: [knowledge({ item: '成果物', source: 'ユーザーが自分から話した', text: '未着手の項目に話した', quote: '最初の頼み' })] }); // K-01：対象外
      await run.call('progress', answers(['成果物', '進め方', '作業の目的']));
      await run.call('record', {
        knowledge: [
          knowledge({ item: '成果物', source: 'ユーザーが自分から話した', text: '聞いた後に話した', quote: 'そういえば' }), // K-02：対象
          knowledge({ item: '進め方', source: '生成前の確認で足した', text: '確認で足した', quote: '足したい' }), // K-03：対象
          knowledge({ item: '作業の目的', source: 'ヒアリングの答え', text: '聞いて答えた', quote: '答え' }), // K-04：対象外
          knowledge({ item: '進め方', source: 'ユーザーが自分から話した', text: '外したもの', quote: 'x', status: '外した' }), // K-05：外したので対象外
          knowledge({ item: '成果物', source: 'ユーザーが自分から話した', text: '候補のまま', quote: 'x', status: '候補' }), // K-06：候補なので対象外
          knowledge({ item: '成果物', source: 'AI の判断（ユーザーが任せた）', text: 'AI の判断', quote: '任せる' }), // K-07：対象外
        ],
      });
      const targets = run.creator.hearing.retrospectiveTargets();
      assert.deepEqual(targets.map((t) => t.id), ['K-02', 'K-03']);
      assert.deepEqual(targets.map((t) => t.reason), ['そのことを聞いた後に、ユーザーが自分から話した', '作る前の確認で足した']);
      const text = await run.call('state', { include: '振り返りの材料' });
      // 対象の一覧の部分だけを見る（確かめていない候補の行にも「K-06（項目：…」が出る）
      const targetSection = text.split('質問の改善案の対象の仕事のやり方や決まり')[1].split('問答の記録のすべて')[0];
      assert.match(targetSection, /K-02（聞くこと：成果物）/);
      assert.match(targetSection, /K-03（聞くこと：進め方）/);
      assert.ok(!/K-0[14567]（聞くこと/.test(targetSection));
    });
  });

  test('REQ-015 includeの値が違うと、使える値を返して断る', async () => {
    await withRun(async (run) => {
      const r = await run.callSafe('state', { include: '全部' });
      assert.equal(r.ok, false);
      assert.match(r.error, /include の値が違います：「全部」。使える値：最後の問答、振り返りの材料/);
    });
  });

  test('REQ-043 止まっている画面のサーバーを起動し直して、新しい URL を返す。URL が変わったら、チャットで示すよう知らせる', async () => {
    await withRun(async (run) => {
      const first = await run.call('state');
      const firstUrl = urlOf(first);
      assert.ok(run.creator.screen.running);
      assert.equal((await fetchState(firstUrl)).status, 200);

      // 記録があるときに、画面のサーバーが止まった（--continue のあとと同じ）
      await run.call('progress', { stage: '始まり' });
      await run.call('state');
      assert.equal(run.readState().url, firstUrl);
      await run.creator.screen.close();
      assert.equal(run.creator.screen.running, false);

      const second = await run.call('state');
      const secondUrl = urlOf(second);
      assert.ok(secondUrl);
      assert.notEqual(secondUrl, firstUrl);
      assert.ok(run.creator.screen.running);
      assert.equal((await fetchState(secondUrl)).status, 200);
      assert.match(second, /画面の URL が前と変わりました。チャットでユーザーに示してください。/);
      assert.equal(run.readState().url, secondUrl, '新しい URL を記録に残す');

      const third = await run.call('state');
      assert.equal(urlOf(third), secondUrl, '動いているときは同じ URL');
      assert.ok(!third.includes('前と変わりました'));
    });
  });

  test('REQ-043 画面を開くツールは、URL を返す。動いていれば同じ URL を返す', async () => {
    await withRun(async (run) => {
      const a = await run.call('open');
      const b = await run.call('open');
      assert.match(a, /^plugin-creator の画面の用意ができました。次の URL をブラウザーで開いてください：http:\/\/127\.0\.0\.1:\d+\/\?k=/);
      assert.equal(a, b);
    });
  });

  test('REQ-043 画面のサーバーを起動できなくても、状態は返す（理由を添える）', async () => {
    const loadUi = async () => {
      throw new Error('画面の部品（plugin-creator が用意した共通の形の ui/server.mjs）を読み込めません：見つかりません');
    };
    await withRun(
      async (run) => {
        await run.call('progress', { stage: '始まり' });
        const text = await run.call('state');
        assert.match(text, /^段階：始まり$/m);
        assert.match(text, /画面：（起動できていません）/);
        assert.match(text, /画面を起動できませんでした：画面の部品/);
        const open = await run.callSafe('open');
        assert.equal(open.ok, false);
        assert.match(open.error, /plugin-creator の画面を起動できません：画面の部品/);
      },
      { extra: { loadUi } },
    );
  });
});

describe('再開と、記録の置き場所', () => {
  test('REQ-015 同じセッションの番号でエクステンションを起動し直すと、記録が読まれ、続きから進められる', async () => {
    const home = tempDir('resume-home');
    const cwd = tempDir('resume-cwd');
    try {
      const first = await startForTest({ sessionId: 'session-aaaa', home, cwd });
      await first.call('progress', answers(['作業の目的', '成果物'], '聞いた'));
      await first.call('progress', { stage: '項目の点検' });
      await first.call('record', { knowledge: [knowledge()] });
      await first.hook('onUserPromptSubmitted', { prompt: 'ここでやめます' });
      await first.cleanup();

      const second = await startForTest({ sessionId: 'session-aaaa', home, cwd });
      const text = await second.call('state', { include: '最後の問答' });
      assert.match(text, /^段階：項目の点検$/m);
      assert.match(text, /^ {2}作業の目的：聞いた$/m);
      assert.match(text, /^ {2}成果物：聞いた$/m);
      assert.match(text, /仕事のやり方や決まり：確かめたいこと0件、決まった1件、外した0件/);
      assert.match(text, /ユーザーの発言：ここでやめます/);
      // 続きから進める：番号は続き、問答の記録は追記される
      await second.call('record', { knowledge: [knowledge({ text: '続きの決まり' })] });
      assert.deepEqual(second.readState().knowledge.map((k) => k.id), ['K-01', 'K-02']);
      await second.hook('onUserPromptSubmitted', { prompt: '続けます' });
      assert.equal(second.readQa().length, 2);
      await second.cleanup();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('REQ-015 新しいセッションの番号（/clear や新しい会話）では、前の記録を読まず、最初から始まる。前の記録は残る', async () => {
    const home = tempDir('fresh-home');
    const cwd = tempDir('fresh-cwd');
    try {
      const first = await startForTest({ sessionId: 'session-old', home, cwd });
      await first.call('progress', answers(['作業の目的']));
      await first.call('record', { knowledge: [knowledge()] });
      const oldState = fs.readFileSync(first.statePath(), 'utf8');
      await first.cleanup();

      const second = await startForTest({ sessionId: 'session-new', home, cwd });
      const text = await second.call('state');
      assert.match(text, /^段階：（お話を聞くことの記録はまだありません）/m);
      assert.match(text, /お話を聞くことの記録（state\.json）：.*session-new/);
      assert.equal(second.creator.hearing.exists, false);
      // 新しい記録は、新しい番号のフォルダにできる。前の記録は消えず、変わらない
      await second.call('progress', { stage: '始まり' });
      assert.deepEqual(second.readState().knowledge, []);
      assert.equal(fs.readFileSync(first.statePath(), 'utf8'), oldState);
      assert.deepEqual(fs.readdirSync(path.join(home, 'plugin-data', 'plugin-creator', 'hearings')).sort(), ['session-new', 'session-old']);
      await second.cleanup();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('REQ-015 再開のとき、段階が「生成」まで進んだ記録なら、ヒアリングの最中ではない（問答を記録しない）', async () => {
    const home = tempDir('done-home');
    const cwd = tempDir('done-cwd');
    try {
      const first = await startForTest({ sessionId: 'session-done', home, cwd });
      await readyToConfirm(first);
      await first.call('confirm', confirmArgs());
      await first.call('progress', { stage: '生成', approvalQuote: '作る' });
      await first.cleanup();

      const second = await startForTest({ sessionId: 'session-done', home, cwd });
      assert.equal(second.creator.hearing.active, false);
      await second.hook('onUserPromptSubmitted', { prompt: '試験をお願いします' });
      assert.equal(fs.existsSync(second.qaPath()), false);
      const text = await second.call('state');
      assert.match(text, /^段階：生成$/m);
      assert.match(text, /生成の承認：2026-10-22T09:00:00\.000Z/);
      await second.cleanup();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('REQ-027 再開のとき、生成前の確認が残っていれば、状態取得ツールが見本も作り直す。生成に進んだ後は作り直さない', async () => {
    const home = tempDir('restore-home');
    const cwd = tempDir('restore-cwd');
    try {
      const first = await startForTest({ sessionId: 'session-restore', home, cwd });
      await readyToConfirm(first);
      await first.call('confirm', confirmArgs());
      await first.cleanup();

      // 起動し直した直後：見本のサーバーはまだない。状態取得ツールを呼ぶと、作業の定義の案から作り直す
      const second = await startForTest({ sessionId: 'session-restore', home, cwd });
      assert.equal(second.creator.sample.url, null);
      await second.call('state');
      const sampleUrl = second.creator.sample.url;
      assert.match(sampleUrl, /^http:\/\/127\.0\.0\.1:\d+\/\?k=/);
      assert.equal((await fetchState(sampleUrl)).status, 200);
      const view = await (await fetchState(urlOf(await second.call('state')))).json();
      assert.equal(view.confirmation.sampleUrl, sampleUrl);
      await second.call('progress', { stage: '生成', approvalQuote: '作る' });
      await second.cleanup();

      // 生成に進んだ後（作業の定義の案は、組み立てのスクリプトが消す）：作り直さず、失敗の知らせも出さない
      fs.rmSync(path.join(cwd, '.plugin-creator-work'), { recursive: true });
      const third = await startForTest({ sessionId: 'session-restore', home, cwd });
      await third.call('state');
      assert.equal(third.creator.sample.url, null);
      assert.deepEqual(third.warnings, []);
      await third.cleanup();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('REQ-015 記録のファイルが壊れているときは、上書きせず、直すよう知らせて断る', async () => {
    const home = tempDir('broken-home');
    const cwd = tempDir('broken-cwd');
    try {
      const first = await startForTest({ sessionId: 'session-broken', home, cwd });
      await first.call('progress', { stage: '始まり' });
      const file = first.statePath();
      await first.cleanup();
      fs.writeFileSync(file, '{ 壊れた', 'utf8');

      const second = await startForTest({ sessionId: 'session-broken', home, cwd });
      const r = await second.callSafe('progress', { stage: '読む' });
      assert.equal(r.ok, false);
      assert.match(r.error, /お話を聞くことの記録（.*state\.json）を読めません。ファイルを確かめてください。/);
      assert.equal(fs.readFileSync(file, 'utf8'), '{ 壊れた', '壊れた記録を上書きしない');
      assert.equal(second.creator.hearing.active, false, '壊れた記録のときは、問答を記録しない');
      const state = await second.call('state');
      assert.match(state, /お話を聞くことの記録（.*state\.json）を読めません/);
      await second.cleanup();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('REQ-021 記録は COPILOT_HOME の下のクリエイターのフォルダにだけ作られ、作業フォルダには何も作られない', async () => {
    const cwd = tempDir('noscribble-cwd');
    try {
      await withRun(
        async (run) => {
          const homeBefore = listTree(run.home);
          assert.deepEqual(homeBefore, []);
          await run.call('open');
          await run.call('progress', { stage: '始まり', ...answers(SETTABLE_ITEMS) });
          await run.call('record', { knowledge: [knowledge(), knowledge({ kind: '合否の決め方', item: '合否の決め方', text: '見出しが順に並んでいれば合格', quote: '順です' })], assets: [{ name: 'テンプレート', status: '流用する' }] });
          await run.fake.askUser({ message: '質問', answer: 'User responded: はい' });
          await run.hook('onUserPromptSubmitted', { prompt: '発言' });

          // 作業の定義の案と結果のファイルは、作業エージェントや試験の入口が書く。それ以外を、このエクステンションは作業フォルダに書かない
          const draft = writeDraft(cwd);
          const resultFile = makeResultFile(cwd);
          const treeBefore = listTree(cwd);
          assert.ok(treeBefore.includes('.plugin-creator-work/draft/task.json') && treeBefore.includes('latest.json'));
          await run.call('results', { paths: [resultFile] });
          await run.call('confirm', confirmArgs());
          await run.call('state', { include: '振り返りの材料' });
          await run.call('progress', { stage: '生成', approvalQuote: '作る' });
          await run.call('open');
          assert.deepEqual(listTree(cwd), treeBefore, '作業フォルダにファイルが増えた');
          assert.ok(fs.existsSync(draft));

          const tree = listTree(run.home);
          assert.ok(tree.length > 0);
          for (const entry of tree) assert.match(entry, /^plugin-data(\/plugin-creator(\/hearings(\/[^/]+(\/[^/]+)?)?)?)?\/?$/, `想定外の場所：${entry}`);
          assert.deepEqual(
            fs.readdirSync(run.creator.store.dir).sort(),
            ['qa.jsonl', 'results.json', 'state.json'],
          );
        },
        { cwd },
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

function makeResultFile(cwd) {
  const file = path.join(cwd, 'latest.json');
  fs.writeFileSync(file, JSON.stringify({ status: 'passed', stages: [] }), 'utf8');
  return file;
}

describe('今のプラグインを直すときの状態取得と、記録の置き場所', () => {
  /** フォルダの中のファイルの一覧と中身（前後で比べる） */
  const snapshot = (dir) => listTree(dir).map((rel) => [rel, rel.endsWith('/') ? null : fs.readFileSync(path.join(dir, rel), 'utf8')]);

  test('REQ-060 REQ-052 直すときの状態の返り値に、直すプラグイン（フォルダ、名前、今の版）、変えたいこと、引き継いだ決まりの数、足した・直した・外した決まりの4行が出る。最後の行は change-plugin の読み直し', async () => {
    await withRun(async (run) => {
      const { folder } = await startChange(run);
      let text = await run.call('state');
      const real = fs.realpathSync(folder);
      assert.deepEqual(text.split('\n').slice(0, 5), [
        '段階：始まり',
        `直すプラグイン：${real}（edl-sample、今の版 0.1.0）`,
        '変えたいこと：KX-200 のクロスコンパイルとデプロイの手順を組み込みたい',
        '引き継いだ決まり：5件',
        '足した決まり：なし／直した決まり：なし／外した決まり：なし',
      ]);
      assert.match(text, /候補の確かめ：未着手（確かめたいこと 5件）/);
      assert.match(text, /^直す前の確認：まだです。$/m);
      assert.equal(text.split('\n').at(-1), 'SKILL.md の本文がコンテキストになければ、skill ツールで change-plugin を読み直してください。');

      // 決まりを直す・外す・足す
      await run.call('change', { folder, wants: ['デプロイを足したい', '画面は変えない'] });
      await run.call('record', { knowledge: [{ id: 'K-05', text: '機器を1回 reboot し、だめなら人に伝える', quote: '今はこう' }] }); // K-06
      await run.call('record', { knowledge: [{ id: 'K-03', status: '外した', quote: 'もう要らない' }] });
      await run.call('record', { knowledge: [knowledge({ text: 'kxtool で送る' }), knowledge({ text: '確かめ中の決まり', status: '候補', source: 'ファイルから読んで確かめた', quote: 'deploy/SKILL.md' })] }); // K-07、K-08
      text = await run.call('state');
      assert.match(text, /^変えたいこと：デプロイを足したい／画面は変えない$/m);
      assert.match(text, /^足した決まり：K-07／直した決まり：K-05→K-06／外した決まり：K-03$/m);
      assert.deepEqual(internalSymbolsIn(text), []);
      assert.deepEqual(leftWordsIn(text), []);
      assert.ok(Buffer.byteLength(text, 'utf8') < 4096, `数 KB 以内にする：${Buffer.byteLength(text, 'utf8')}バイト`);

      // 確認を受け付けた後
      await run.call('record', { knowledge: [{ id: 'K-08', status: '外した', quote: '違う' }] });
      const added = await readyToConfirmChange(run, { carried: ['K-01', 'K-02', 'K-04'] });
      await run.call('confirm', changeConfirmArgs(['K-01', 'K-02', 'K-04', 'K-06', 'K-07', added]));
      assert.match(await run.call('state'), /^直す前の確認：受け付け済み（.*）。ユーザーの承認はまだです。$/m);
    });
  });

  test('REQ-049 REQ-024 直すときは、確認で足した決まりの出どころと、質問の改善案の対象の理由を「直す前の確認で足した」と示す（「作る前の確認」と言わない）', async () => {
    await withRun(async (run) => {
      await startChange(run);
      await run.call('progress', { items: [{ item: '進め方', status: '聞いた', quote: 'KX-200 のクロスコンパイルとデプロイの手順を組み込みたい' }] });
      await run.call('record', {
        knowledge: [
          knowledge({ item: '進め方', source: '生成前の確認で足した', text: '確認で足した', quote: '足したい' }), // K-06：対象
          knowledge({ item: '進め方', source: '生成前の確認で足した', text: '確認で足した、まだ確かめていない決まり', quote: '足したい', status: '候補' }), // K-07
        ],
      });
      const text = await run.call('state', { include: '振り返りの材料' });
      assert.match(text, /^ {2}K-06（聞くこと：進め方）：直す前の確認で足した$/m);
      assert.match(text, /^ {2}K-07（聞くこと：進め方、出どころ：直す前の確認で足した）：確認で足した、まだ確かめていない決まり$/m);
      assert.ok(!text.includes('作る前の確認'), text);
      assert.deepEqual(leftWordsIn(text.split('問答の記録のすべて')[0]), []);
    });
  });

  test('REQ-060 plugin-creator が作っていないプラグインでは、引き継いだ決まりが0件で、読み取った決まりを1件ずつ確かめることが分かる', async () => {
    await withRun(async (run) => {
      await startChange(run, { plugin: { knowledge: null, task: null, evals: [], version: null } });
      const text = await run.call('state');
      assert.match(text, /^直すプラグイン：.*edl-sample（edl-sample、今の版 なし）$/m);
      assert.match(text, /^引き継いだ決まり：0件（plugin-creator が作っていないプラグインなので、読み取った決まりは1件ずつ確かめる）$/m);
    });
  });

  test('REQ-052 同じセッションの番号で起動し直すと、直す記録が読まれて続きから進む（番号は続き、change-plugin の読み直し）', async () => {
    const home = tempDir('change-resume-home');
    const cwd = tempDir('change-resume-cwd');
    try {
      const first = await startForTest({ sessionId: 'session-change', home, cwd });
      await startChange(first);
      await first.call('record', { knowledge: [{ id: 'K-05', text: '新しい文', quote: '今はこう' }] }); // K-06
      await first.cleanup();

      const second = await startForTest({ sessionId: 'session-change', home, cwd });
      const text = await second.call('state');
      assert.match(text, /^直すプラグイン：.*edl-sample（edl-sample、今の版 0\.1\.0）$/m);
      assert.match(text, /直した決まり：K-05→K-06/);
      assert.match(text, /skill ツールで change-plugin を読み直してください。$/);
      assert.match(await second.call('record', { knowledge: [knowledge({ text: '続きの決まり' })] }), /K-07 を追加/);
      // 同じフォルダで呼び直しても、取り込み直さない
      await second.call('change', { folder: 'edl-sample', wants: ['続きから'] });
      assert.equal(second.readState().knowledge.length, 7);
      await second.cleanup();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('REQ-059 REQ-021 直すときも、記録は COPILOT_HOME の下にだけでき、直すプラグインのフォルダの中身は変わらない（ファイルの一覧と中身を前後で比べる）', async () => {
    await withRun(async (run) => {
      const homeBefore = listTree(run.home);
      assert.deepEqual(homeBefore, []);
      const folder = writePluginFolder(run.cwd);
      const before = snapshot(folder);
      await run.call('open');
      await run.call('change', { folder, wants: ['デプロイを足したい'] });
      await run.call('change', { folder, wants: ['もう一度'] });
      const added = await readyToConfirmChange(run);
      await run.fake.askUser({ message: '質問', answer: 'User responded: はい' });
      await run.call('confirm', changeConfirmArgs([...PLUGIN_KNOWLEDGE.map((k) => k.id), added]));
      await run.call('state', { include: '振り返りの材料' });
      await run.call('progress', { stage: '生成', approvalQuote: 'はい' });
      assert.deepEqual(snapshot(folder), before, '直すプラグインのフォルダが変わった');
      for (const entry of listTree(run.home)) assert.match(entry, /^plugin-data(\/plugin-creator(\/hearings(\/[^/]+(\/[^/]+)?)?)?)?\/?$/, `想定外の場所：${entry}`);
      // 作業フォルダにあるのは、試験が置いた直すフォルダと、作業の定義の案（作業エージェントが書く .plugin-creator-work/）だけ
      assert.deepEqual(fs.readdirSync(run.cwd).sort(), ['.plugin-creator-work', 'edl-sample']);
    });
  });
});
