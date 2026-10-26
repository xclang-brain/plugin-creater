// 2段目 部品の試験（クリエイターのエクステンション）：記録のツール（progress、record、confirm）。
// 設計書：hearing.md 5.7、6.3、7.1〜7.3、7.5、11章、12章「2段目」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, test } from 'node:test';

import {
  MAIN_ITEM_NAMES,
  PLUGIN_EVALS,
  PLUGIN_KNOWLEDGE,
  SETTABLE_ITEMS,
  UNCHANGED_ITEMS,
  answerEverything,
  answers,
  changeConfirmArgs,
  confirmArgs,
  internalSymbolsIn,
  knowledge,
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

const ALL_ITEM_NAMES_JA = '作業の目的、頼む場面と言い方、受け取るもの';

describe('進み具合（plugin-creator_progress）', () => {
  test('REQ-015 初めて呼ぶと、COPILOT_HOME の下のクリエイターのフォルダに state.json ができる', async () => {
    await withRun(async (run) => {
      assert.equal(fs.existsSync(run.statePath()), false);
      const text = await run.call('progress', { stage: '始まり' });
      assert.ok(fs.existsSync(run.statePath()));
      assert.equal(run.statePath(), path.join(run.home, 'plugin-data', 'plugin-creator', 'hearings', run.sessionId, 'state.json'));
      assert.match(text, /^記録しました（段階：始まり）。/);
      const state = run.readState();
      assert.equal(state.sessionId, run.sessionId);
      assert.equal(state.stage, 'start');
    });
  });

  test('REQ-015 項目の名前が違うと、使える項目の名前を平易な日本語で返して断る（何も記録しない）', async () => {
    await withRun(async (run) => {
      const r = await run.callSafe('progress', { items: [{ item: '成果', status: '聞いた', quote: 'はい' }] });
      assert.equal(r.ok, false);
      assert.match(r.error, /聞くことの名前が違います：「成果」/);
      assert.ok(r.error.includes(ALL_ITEM_NAMES_JA));
      assert.ok(r.error.includes('合否の決め方'));
      assert.deepEqual(internalSymbolsIn(r.error), []);
      assert.equal(fs.existsSync(run.statePath()), false, '断ったときは記録を作らない');
    });
  });

  test('REQ-015 状態の名前が違うと、使える状態の名前を返して断る。「未着手」には変えられない', async () => {
    await withRun(async (run) => {
      const bad = await run.callSafe('progress', { items: [{ item: '成果物', status: '済み', quote: 'はい' }] });
      assert.equal(bad.ok, false);
      assert.match(bad.error, /状態の名前が違います：「済み」/);
      assert.ok(bad.error.includes('聞いた、決まりなし、保留'));

      const todo = await run.callSafe('progress', { items: [{ item: '成果物', status: '未着手', quote: 'はい' }] });
      assert.equal(todo.ok, false);
      assert.match(todo.error, /「成果物」を「未着手」には戻せません/);
    });
  });

  test('REQ-015 ユーザーの言葉の抜き書きがないと、状態を変えるのを断る（モデルが自分の判断で項目を済ませない）', async () => {
    await withRun(async (run) => {
      for (const quote of [undefined, '', '   ']) {
        const r = await run.callSafe('progress', { items: [{ item: '成果物', status: '聞いた', ...(quote === undefined ? {} : { quote }) }] });
        assert.equal(r.ok, false);
        assert.match(r.error, /「成果物」の状態を変えるには、ユーザーの言葉の抜き書き（quote）を添えてください/);
      }
      assert.equal(fs.existsSync(run.statePath()), false);
    });
  });

  test('REQ-015 状態の移り方：未着手から聞いた・決まりなし・保留へ。聞いた・決まりなし・保留どうしは行き来できるが、未着手には戻せない', async () => {
    await withRun(async (run) => {
      const set = (status, extra = {}) => run.call('progress', { items: [{ item: '成果物', status, quote: `${status}と言った`, ...extra }] });
      const state = () => run.readState().items.output;

      await set('聞いた');
      assert.equal(state().status, 'asked');
      await set('保留', { holder: '経理の田中さん' });
      assert.equal(state().status, 'pending');
      assert.equal(state().holder, '経理の田中さん');
      await set('決まりなし');
      assert.equal(state().status, 'none');
      assert.equal(state().holder, null, '保留でなくなったら、だれが知っているかは消える');
      await set('聞いた');
      assert.equal(state().status, 'asked');
      assert.equal(state().quote, '聞いたと言った');

      const back = await run.callSafe('progress', { items: [{ item: '成果物', status: '未着手', quote: 'やっぱり' }] });
      assert.equal(back.ok, false);
      assert.equal(state().status, 'asked', '断ったので、状態は変わらない');
    });
  });

  test('REQ-015 だれが知っているか（holder）は、保留のときだけ残る', async () => {
    await withRun(async (run) => {
      await run.call('progress', { items: [{ item: '成果物', status: '聞いた', quote: '決まっている', holder: '山田さん' }] });
      assert.equal(run.readState().items.output.holder, null);
      await run.call('progress', { items: [{ item: '成果物', status: '保留', quote: '分からない', holder: '山田さん' }] });
      assert.equal(run.readState().items.output.holder, '山田さん');
    });
  });

  test('REQ-015 段階の名前が違うと、使える段階の名前を返して断る。段階も項目も渡さないときも断る', async () => {
    await withRun(async (run) => {
      const bad = await run.callSafe('progress', { stage: '最後' });
      assert.equal(bad.ok, false);
      assert.match(bad.error, /段階の名前が違います：「最後」/);
      for (const name of ['始まり', '実物を受け取る', '読む', '前回の1回', '決まりの確かめ', '項目の点検', '資産と公開のプラグイン', '画面', '生成前の確認', '生成']) assert.ok(bad.error.includes(name), name);
      assert.deepEqual(internalSymbolsIn(bad.error), []);

      const none = await run.callSafe('progress', {});
      assert.equal(none.ok, false);
      assert.match(none.error, /段階（stage）か聞くこと（items）のどちらかを渡してください/);
    });
  });

  test('REQ-015 1つでも誤りがあると、同じ呼び出しのほかの項目も記録しない', async () => {
    await withRun(async (run) => {
      await run.call('progress', { stage: '始まり' });
      const r = await run.callSafe('progress', {
        stage: '項目の点検',
        items: [
          { item: '作業の目的', status: '聞いた', quote: '週報を作る' },
          { item: '存在しない項目', status: '聞いた', quote: 'x' },
        ],
      });
      assert.equal(r.ok, false);
      const state = run.readState();
      assert.equal(state.stage, 'start');
      assert.deepEqual(state.items, {});
    });
  });

  test('REQ-017 項目「候補の確かめ」は、ツールでは変えられない（エクステンションが計算する）', async () => {
    await withRun(async (run) => {
      const r = await run.callSafe('progress', { items: [{ item: '候補の確かめ', status: '聞いた', quote: 'はい' }] });
      assert.equal(r.ok, false);
      assert.match(r.error, /「候補の確かめ」の状態は、確かめたいこと（仕事のやり方や決まりのうち、状態が「候補」のもの）があるかどうかで自動で決まります/);
    });
  });

  test('REQ-015 REQ-024 返り値は短い1行の平易な日本語で、まだ聞いていない項目を示す（内部の記号を出さない）', async () => {
    await withRun(async (run) => {
      const first = await run.call('progress', { stage: '始まり' });
      assert.ok(!first.includes('\n'));
      assert.ok(first.length < 120, `長すぎる：${first.length}文字`);
      assert.match(first, /まだ聞いていないこと：作業の目的、頼む場面と言い方、受け取るもの、進め方、成果物、合否の決め方、ほか10件/);
      assert.deepEqual(internalSymbolsIn(first), []);

      const some = await run.call('progress', answers(SETTABLE_ITEMS.filter((n) => n !== '成果物' && n !== '合否の決め方')));
      assert.equal(some, '記録しました。まだ聞いていないこと：成果物、合否の決め方');

      const done = await run.call('progress', answers(['成果物', '合否の決め方']));
      assert.equal(done, '記録しました。まだ聞いていないことはありません。');
    });
  });

  test('REQ-033 作り直しのとき（段階「できていたことの確認」に入る）だけ、項目「できていたことの確認」を聞く', async () => {
    await withRun(async (run) => {
      await answerEverything(run);
      const normal = await run.call('progress', { stage: '項目の点検' });
      assert.match(normal, /まだ聞いていないことはありません/);

      const rebuild = await run.call('progress', { stage: 'できていたことの確認' });
      assert.match(rebuild, /まだ聞いていないこと：できていたことの確認/);
      assert.equal(run.readState().rebuild, true);

      const refused = await run.callSafe('confirm', confirmArgs());
      assert.equal(refused.ok, false);
      assert.match(refused.error, /できていたことの確認/);

      const answered = await run.call('progress', { items: [{ item: 'できていたことの確認', status: '聞いた', quote: '全部引き継ぐ' }] });
      assert.match(answered, /まだ聞いていないことはありません/);
    });
  });

  test('hearing.md 7.1 並べて呼んでも、記録は失われない（状態を変えるツールは順に1つずつ動く）', async () => {
    await withRun(async (run) => {
      await Promise.all(MAIN_ITEM_NAMES.map((name) => run.call('progress', { items: [{ item: name, status: '聞いた', quote: `${name}です` }] })));
      const items = run.readState().items;
      assert.equal(Object.keys(items).length, 10);

      await Promise.all([1, 2, 3, 4, 5].map((i) => run.call('record', { knowledge: [knowledge({ text: `決まり${i}` })] })));
      assert.deepEqual(run.readState().knowledge.map((k) => k.id), ['K-01', 'K-02', 'K-03', 'K-04', 'K-05']);
    });
  });

  test('hearing.md 7.1 state.json は一時ファイルに書いてから名前を変えて置く（書きかけが残らない）', async () => {
    await withRun(async (run) => {
      const renames = [];
      const writes = [];
      const realRename = fs.renameSync;
      const realWrite = fs.writeFileSync;
      fs.renameSync = (from, to) => {
        renames.push([from, to]);
        return realRename(from, to);
      };
      fs.writeFileSync = (file, ...rest) => {
        writes.push(String(file));
        return realWrite(file, ...rest);
      };
      try {
        await run.call('progress', { stage: '始まり' });
      } finally {
        fs.renameSync = realRename;
        fs.writeFileSync = realWrite;
      }
      assert.equal(renames.length, 1);
      assert.match(path.basename(renames[0][0]), /^state\.json\.tmp-/);
      assert.equal(renames[0][1], run.statePath());
      assert.ok(!writes.includes(run.statePath()), 'state.json に直接書いている');
      assert.deepEqual(fs.readdirSync(path.dirname(run.statePath())), ['state.json'], '一時ファイルが残っている');
    });
  });
});

describe('ユーザーに話す言葉', () => {
  test('REQ-024 ユーザーに見える返り値と断る文は、「項目」と言わず、「聞くこと」と言う（references/words.md の表。段階の名前「項目の点検」は、そのまま）', async () => {
    await withRun(async (run) => {
      const seen = [];
      const take = (r) => seen.push(r.ok === undefined ? r : r.ok ? r.text : r.error);
      const call = async (tool, args) => take(await run.callSafe(tool, args));
      await call('progress', { stage: '始まり' });
      await call('progress', {});
      await call('progress', { items: [] });
      await call('progress', { items: [{ item: '成果', status: '聞いた', quote: 'x' }] });
      await call('progress', { items: [{ item: '成果物', status: '聞いた' }] });
      await call('progress', { items: [{ item: '成果物', status: '保留', quote: '分からない' }] });
      await call('progress', { items: [{ item: '候補の確かめ', status: '聞いた', quote: 'x' }] });
      await call('record', { knowledge: [{ quote: 'x' }] });
      await call('record', { knowledge: [knowledge({ item: '前回の1回' })] });
      await call('record', { knowledge: [knowledge({ status: '候補', source: 'ファイルから読んで確かめた' })] });
      await call('confirm', confirmArgs());
      await answerEverything(run, { except: ['成果物', '合否の決め方'] });
      await call('confirm', confirmArgs());
      await call('progress', answers(['成果物', '合否の決め方']));
      await call('state', {});
      await call('state', { include: '振り返りの材料' });
      await call('record', { knowledge: [{ id: 'K-01', item: '成果物', quote: 'x' }] });
      assert.ok(seen.length >= 15);
      for (const text of seen) {
        const withoutStageName = String(text).replaceAll('項目の点検', '');
        assert.ok(!withoutStageName.includes('項目'), `「項目」と出ている：${text}`);
      }
      // 話す言葉は、聞くこと
      assert.ok(seen.some((t) => /まだ聞いていないこと：/.test(t)));
      assert.ok(seen.some((t) => /聞くことの名前が違います/.test(t)));
      assert.ok(seen.some((t) => /^聞くことの状態：$/m.test(t)));
    });
  });
});

describe('決まったこと（plugin-creator_record）', () => {
  test('REQ-015 ナレッジの欄を確かめる：足りない欄、種類・項目・出どころ・状態の名前、文、ユーザーの言葉', async () => {
    await withRun(async (run) => {
      const refuse = async (entry, pattern) => {
        const r = await run.callSafe('record', { knowledge: [entry] });
        assert.equal(r.ok, false, JSON.stringify(entry));
        assert.match(r.error, pattern);
        assert.deepEqual(internalSymbolsIn(r.error), []);
        return r.error;
      };
      await refuse({ quote: 'x' }, /新しい仕事のやり方や決まりに足りない欄：種類、聞くこと、文、出どころ、状態/);
      await refuse(knowledge({ quote: undefined }), /ユーザーの言葉の抜き書き（quote）を添えてください/);
      await refuse(knowledge({ quote: '  ' }), /ユーザーの言葉の抜き書き（quote）を添えてください/);
      assert.ok((await refuse(knowledge({ kind: '基準' }), /種類が違います：「基準」/)).includes('合否の決め方、それ以外'));
      const itemError = await refuse(knowledge({ item: '前回の1回' }), /聞くことが違います：「前回の1回」/);
      assert.ok(itemError.includes('作業の目的') && itemError.includes('いつもと違うとき') && !itemError.includes('候補の確かめ'));
      assert.ok((await refuse(knowledge({ source: '推測' }), /出どころが違います：「推測」/)).includes('AI の判断（ユーザーが任せた）'));
      assert.ok((await refuse(knowledge({ status: '済み' }), /状態が違います：「済み」/)).includes('候補、決まった、外した'));
      await refuse(knowledge({ text: '   ' }), /新しい仕事のやり方や決まりに足りない欄：文/);
      assert.equal(fs.existsSync(run.statePath()), false, '断ったときは記録を作らない');
    });
  });

  test('hearing.md 7.3 番号 K-01 は記録の順に付き、使い回さない（外したナレッジの番号も残る）', async () => {
    await withRun(async (run) => {
      const first = await run.call('record', { knowledge: [knowledge({ text: 'A' }), knowledge({ text: 'B' })] });
      assert.match(first, /仕事のやり方や決まり K-01、K-02 を追加/);
      await run.call('record', { knowledge: [{ id: 'K-01', status: '外した', quote: 'やっぱり違う' }] });
      await run.call('record', { knowledge: [knowledge({ text: 'C' })] });
      const rows = run.readState().knowledge;
      assert.deepEqual(rows.map((k) => [k.id, k.text, k.status]), [['K-01', 'A', 'dropped'], ['K-02', 'B', 'decided'], ['K-03', 'C', 'decided']]);

      for (let i = 0; i < 8; i += 1) await run.call('record', { knowledge: [knowledge({ text: `追加${i}` })] });
      assert.deepEqual(run.readState().knowledge.map((k) => k.id).slice(-3), ['K-09', 'K-10', 'K-11']);
    });
  });

  test('REQ-049 記録の時刻と、記録のときに項目が未着手でなかったかが、自動で付く', async () => {
    await withRun(async (run) => {
      await run.call('record', { knowledge: [knowledge({ item: '進め方', source: 'ユーザーが自分から話した', text: '頼みの文にあった' })] });
      run.clock.advance(60_000);
      await run.call('progress', { items: [{ item: '進め方', status: '聞いた', quote: '順に説明した' }] });
      run.clock.advance(60_000);
      await run.call('record', { knowledge: [knowledge({ item: '進め方', source: 'ユーザーが自分から話した', text: '聞いた後に出てきた' })] });
      await run.call('progress', { items: [{ item: '成果物', status: '保留', quote: '分からない' }] });
      await run.call('record', { knowledge: [knowledge({ item: '成果物', text: '保留の項目に記録' })] });
      await run.call('progress', { items: [{ item: '合否の決め方', status: '決まりなし', quote: '特にない' }] });
      await run.call('record', { knowledge: [knowledge({ item: '合否の決め方', text: '決まりなしの項目に記録' })] });

      const [a, b, c, d] = run.readState().knowledge;
      assert.equal(a.itemTouchedAtRecord, false, '未着手の項目に記録した');
      assert.equal(b.itemTouchedAtRecord, true, '聞いた項目に記録した');
      assert.equal(c.itemTouchedAtRecord, true, '保留の項目に記録した');
      assert.equal(d.itemTouchedAtRecord, true, '決まりなしの項目に記録した');
      assert.equal(a.recordedAt, '2026-10-22T09:00:00.000Z');
      assert.equal(b.recordedAt, '2026-10-22T09:02:00.000Z');
      assert.equal(a.itemName, '進め方');
    });
  });

  test('REQ-049 ナレッジは番号を渡すと更新できる（記録の時刻と、記録のときの項目の状態は変わらない）。候補には戻せない', async () => {
    await withRun(async (run) => {
      await run.call('record', { knowledge: [knowledge({ text: '最初の文', status: '候補', source: 'ファイルから読んで確かめた', quote: '週報.docx の2ページ' })] });
      const before = run.readState().knowledge[0];
      run.clock.advance(5000);
      const text = await run.call('record', { knowledge: [{ id: 'K-01', text: '直した文', status: '決まった', quote: 'そのとおり', example: '例です', exception: '祝日のときは翌営業日' }] });
      assert.match(text, /仕事のやり方や決まり K-01 を更新/);
      const after = run.readState().knowledge[0];
      assert.equal(after.text, '直した文');
      assert.equal(after.status, 'decided');
      assert.equal(after.example, '例です');
      assert.equal(after.exception, '祝日のときは翌営業日');
      assert.equal(after.quote, 'そのとおり');
      assert.equal(after.source, 'file', '渡さなかった欄は変わらない');
      assert.equal(after.recordedAt, before.recordedAt);
      assert.equal(after.itemTouchedAtRecord, before.itemTouchedAtRecord);
      assert.notEqual(after.updatedAt, before.updatedAt);

      // 項目を直したときは、日本語の項目の名前もそろう
      await run.call('record', { knowledge: [{ id: 'K-01', item: '成果物', quote: '成果物の決まりだった' }] });
      assert.deepEqual([run.readState().knowledge[0].item, run.readState().knowledge[0].itemName], ['output', '成果物']);

      const back = await run.callSafe('record', { knowledge: [{ id: 'K-01', status: '候補', quote: 'x' }] });
      assert.equal(back.ok, false);
      assert.match(back.error, /仕事のやり方や決まり K-01 を「候補」には戻せません/);

      const unknown = await run.callSafe('record', { knowledge: [{ id: 'K-09', text: 'x', quote: 'x' }] });
      assert.equal(unknown.ok, false);
      assert.match(unknown.error, /仕事のやり方や決まり K-09 は見つかりません。今ある番号：K-01/);

      const noQuote = await run.callSafe('record', { knowledge: [{ id: 'K-01', text: 'x' }] });
      assert.equal(noQuote.ok, false);
      assert.match(noQuote.error, /ユーザーの言葉の抜き書き/);
    });
  });

  test('REQ-017 確かめていない候補が残っていると、項目「候補の確かめ」が未着手になる。確かめると聞いたになる', async () => {
    await withRun(async (run) => {
      await answerEverything(run);
      assert.match(await run.call('progress', { stage: '決まりの確かめ' }), /まだ聞いていないことはありません/);

      const added = await run.call('record', { knowledge: [knowledge({ status: '候補', source: 'ファイルから読んで確かめた', quote: '週報.docx の1ページ' })] });
      assert.match(added, /確かめたいこと：1件/);
      assert.match(await run.call('progress', { stage: '決まりの確かめ' }), /まだ聞いていないこと：候補の確かめ/);
      assert.match(await run.call('state'), /候補の確かめ：未着手（確かめたいこと 1件）/);

      const refused = await run.callSafe('confirm', confirmArgs());
      assert.equal(refused.ok, false);
      assert.match(refused.error, /まだ聞いていないことがあるので、作る前の確認はできません：候補の確かめ/);

      // 「外した」でも、確かめたことになる
      const checked = await run.call('record', { knowledge: [{ id: 'K-01', status: '外した', quote: '決まりではなく、たまたま' }] });
      assert.match(checked, /確かめたいことはありません/);
      assert.match(await run.call('progress', { stage: '項目の点検' }), /まだ聞いていないことはありません/);
      assert.match(await run.call('state'), /候補の確かめ：聞いた/);
    });
  });

  test('REQ-018 流用する資産と、標準機能と公開のプラグインの選んだ結果を記録する（名前が同じものは更新する）', async () => {
    await withRun(async (run) => {
      const text = await run.call('record', {
        assets: [{ name: '週報テンプレート', location: 'templates/weekly.docx', note: '毎回これを使う', status: '流用する' }, { name: '古い集計表', status: '候補' }],
        oss: [{ name: 'Awesome Copilot の議事録スキル', kind: '公開のプラグイン', choice: '使わない', note: '書式が違う' }],
      });
      assert.match(text, /資産2件、標準機能と公開のプラグイン1件/);
      await run.call('record', { assets: [{ name: '古い集計表', status: '流用しない' }], oss: [{ name: 'Awesome Copilot の議事録スキル', kind: '公開のプラグイン', choice: '使う' }] });
      const state = run.readState();
      assert.deepEqual(state.assets.map((a) => [a.name, a.status]), [['週報テンプレート', 'reuse'], ['古い集計表', 'skip']]);
      assert.deepEqual(state.ossChoices.map((o) => [o.name, o.kind, o.choice]), [['Awesome Copilot の議事録スキル', 'public_plugin', 'use']]);

      const bad = await run.callSafe('record', { assets: [{ name: 'x', status: '使う' }] });
      assert.match(bad.error, /資産の状態が違います：「使う」。使える名前：候補、流用する、流用しない/);
      const badOss = await run.callSafe('record', { oss: [{ name: 'x', kind: '自作', choice: '使う' }] });
      assert.match(badOss.error, /使える名前：標準機能、公開のプラグイン/);
      const empty = await run.callSafe('record', {});
      assert.match(empty.error, /仕事のやり方や決まり（knowledge）、資産（assets）、標準機能と公開のプラグイン（oss）のどれかを渡してください/);
    });
  });

  test('REQ-024 返り値は短い1行の平易な日本語（内部の記号を出さない）', async () => {
    await withRun(async (run) => {
      const text = await run.call('record', { knowledge: [knowledge(), knowledge({ status: '候補' })] });
      assert.ok(!text.includes('\n'));
      assert.deepEqual(internalSymbolsIn(text), []);
      assert.equal(text, '記録しました（仕事のやり方や決まり K-01、K-02 を追加）。確かめたいこと：1件');
    });
  });
});

describe('生成前の確認（plugin-creator_confirm）と、段階「生成」', () => {
  test('REQ-020 未着手の項目が残っていると、生成前の確認で示すものを受け付けず、残りの項目を返す', async () => {
    await withRun(async (run) => {
      await run.call('progress', answers(SETTABLE_ITEMS.filter((n) => !['成果物', '合否の決め方'].includes(n))));
      const r = await run.callSafe('confirm', confirmArgs());
      assert.equal(r.ok, false);
      assert.equal(r.error, 'まだ聞いていないことがあるので、作る前の確認はできません：成果物、合否の決め方。聞いてから、もう一度知らせてください。');
      assert.deepEqual(internalSymbolsIn(r.error), []);
      assert.equal(run.readState().confirmation, null);
    });
  });

  test('REQ-020 記録がまだないときも、受け付けず、残りの項目を返す', async () => {
    await withRun(async (run) => {
      const r = await run.callSafe('confirm', confirmArgs());
      assert.equal(r.ok, false);
      assert.match(r.error, /まだ聞いていないことがあるので、作る前の確認はできません：作業の目的、頼む場面と言い方/);
    });
  });

  test('REQ-020 生成前の確認を受け付ける前は、段階を「生成」に進める記録を受け付けない', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      const r = await run.callSafe('progress', { stage: '生成', approvalQuote: '作ってください' });
      assert.equal(r.ok, false);
      assert.match(r.error, /段階を「生成」に進める前に、作る前の確認で示すものを plugin-creator_confirm で知らせて/);
      assert.equal(run.readState().stage, 'start');
      assert.equal(run.readState().approvedAt, null);
    });
  });

  test('REQ-020 受け付けた後でも、よいと答えたユーザーの言葉の抜き書きがないと、「生成」に進まない', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      await run.call('confirm', confirmArgs());
      for (const approvalQuote of [undefined, '', '  ']) {
        const r = await run.callSafe('progress', { stage: '生成', ...(approvalQuote === undefined ? {} : { approvalQuote }) });
        assert.equal(r.ok, false);
        assert.match(r.error, /よいと答えたユーザーの言葉の抜き書き（approvalQuote）を添えてください/);
      }
      assert.notEqual(run.readState().stage, 'generate');
      assert.equal(run.readState().approvedAt, null);
    });
  });

  test('REQ-020 抜き書きを添えると段階が「生成」に進み、その記録の時刻が承認の時刻として残る', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      const accepted = await run.call('confirm', confirmArgs());
      assert.match(accepted, /^作る前の確認で示すものを受け付けました。画面で見られます。作業の画面の見本：http:\/\/127\.0\.0\.1:\d+\/\?k=/);
      const confirmation = run.readState().confirmation;
      assert.deepEqual(confirmation.knowledgeIds, ['K-01', 'K-02']);
      assert.equal(confirmation.at, '2026-10-22T09:00:00.000Z');
      assert.equal(confirmation.taskPath, path.join(run.cwd, '.plugin-creator-work', 'draft', 'task.json'));

      run.clock.advance(90_000);
      const text = await run.call('progress', { stage: '生成', approvalQuote: 'はい、作ってください' });
      assert.match(text, /^記録しました（段階：生成）。/);
      const state = run.readState();
      assert.equal(state.stage, 'generate');
      assert.equal(state.approvedAt, '2026-10-22T09:01:30.000Z');
      assert.equal(state.approvalQuote, 'はい、作ってください');
    });
  });

  test('REQ-020 段階が「生成」に進んだ後は、記録のツールが変更を断る（やり直しは /clear してから）', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      await run.call('confirm', confirmArgs());
      await run.call('progress', { stage: '生成', approvalQuote: '作ってください' });
      const before = fs.readFileSync(run.statePath(), 'utf8');
      for (const [tool, args] of [
        ['progress', { stage: '始まり' }],
        ['progress', { items: [{ item: '成果物', status: '保留', quote: 'x' }] }],
        ['record', { knowledge: [knowledge()] }],
        ['confirm', confirmArgs()],
      ]) {
        const r = await run.callSafe(tool, args);
        assert.equal(r.ok, false, tool);
        assert.match(r.error, /お話を聞くことは終わっています（段階は「生成」）。やり直すときは、\/clear してから頼み直してください。/);
      }
      assert.equal(fs.readFileSync(run.statePath(), 'utf8'), before);
    });
  });

  test('REQ-020 示すナレッジの番号が、見つからない・外した・決まっていないものは、断る', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      await run.call('record', { knowledge: [knowledge({ text: '外すもの' })] });
      await run.call('record', { knowledge: [{ id: 'K-03', status: '外した', quote: '違う' }] });
      const missing = await run.callSafe('confirm', confirmArgs({ knowledgeIds: ['K-01', 'K-09'] }));
      assert.match(missing.error, /仕事のやり方や決まりの番号が見つかりません：K-09/);
      const dropped = await run.callSafe('confirm', confirmArgs({ knowledgeIds: ['K-01', 'K-03'] }));
      assert.match(dropped.error, /外した仕事のやり方や決まりは示せません：K-03/);
    });
  });

  test('REQ-020 示すもの（ナレッジの番号、振る舞いの案、作業の定義の案のパス、EVAL の課題）が足りないと、何が足りないかを返して断る', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      const cases = [
        [{ knowledgeIds: [] }, /仕事のやり方や決まりの番号の一覧（knowledgeIds）/],
        [{ behavior: ' ' }, /振る舞いの案（behavior）/],
        [{ taskPath: '' }, /画面と合格の条件の設定の案のパス（taskPath）/],
        [{ evalTasks: [] }, /試しに動かして採点する試験の課題の案（evalTasks）を、1つ以上/],
        [{ evalTasks: [{ prompt: '' }] }, /試しに動かして採点する試験の課題 1 に、頼むときの言葉（prompt）がありません/],
      ];
      for (const [override, pattern] of cases) {
        const r = await run.callSafe('confirm', confirmArgs(override));
        assert.equal(r.ok, false, JSON.stringify(override));
        assert.match(r.error, pattern);
      }
    });
  });

  test('REQ-038 EVAL の課題の実物の入力は、あるファイルの絶対パスだけを受け付け、フォルダ・無いファイル・相対パスは確認の前に断る', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      const task = (inputs) => ({ evalTasks: [{ ...confirmArgs().evalTasks[0], inputs }] });
      const folder = path.join(run.cwd, 'sample-target');
      fs.mkdirSync(folder, { recursive: true });
      const cases = [
        [[{ path: folder }], /入力のファイル .*sample-target はファイルではありません。フォルダは渡せないので、フォルダの中で使うファイルを1つずつ渡してください/],
        [[{ path: path.join(run.cwd, 'ない.xlsx') }], /入力のファイル .*ない\.xlsx がありません/],
        [[{ path: 'inputs/実績.xlsx' }], /入力のファイル inputs\/実績\.xlsx は、実物のファイルの絶対パスで渡してください/],
      ];
      for (const [inputs, pattern] of cases) {
        const r = await run.callSafe('confirm', confirmArgs(task(inputs)));
        assert.equal(r.ok, false, JSON.stringify(inputs));
        assert.match(r.error, pattern);
      }
      // あるファイルの絶対パスと、仮のファイル（まだない置き場所）は受け付ける
      const file = path.join(folder, 'src', 'reader.c');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'int main(void) { return 0; }\n');
      const ok = await run.callSafe('confirm', confirmArgs(task([{ path: file }, { path: 'tests/eval/T-01/inputs/仮.md', provisional: true }])));
      assert.equal(ok.ok, true, ok.error);
    });
  });

  test('REQ-038 EVAL の課題の基準にできるのは、示すナレッジのうち「合否の決め方」のものだけ', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      const notCriterion = await run.callSafe('confirm', confirmArgs({ evalTasks: [{ prompt: 'x', criteria: ['K-01'] }] }));
      assert.match(notCriterion.error, /仕事のやり方や決まり K-01 は種類が「合否の決め方」ではないので、試しに動かして採点する試験の課題の合格の条件にできません/);
      const notListed = await run.callSafe('confirm', confirmArgs({ knowledgeIds: ['K-02'], evalTasks: [{ prompt: 'x', criteria: ['K-01'] }] }));
      assert.match(notListed.error, /仕事のやり方や決まり K-01 が、示す一覧（knowledgeIds）にありません/);
    });
  });

  test('REQ-027 作業の定義の案は、作業フォルダの .plugin-creator-work/draft/task.json に置く。置き場所が違う・ないときは断る', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      const wrongPlace = await run.callSafe('confirm', confirmArgs({ taskPath: 'task.json' }));
      assert.match(wrongPlace.error, /画面と合格の条件の設定の案は、作業フォルダの \.plugin-creator-work\/draft\/task\.json に置いてください/);

      fs.rmSync(path.join(run.cwd, '.plugin-creator-work'), { recursive: true });
      const missing = await run.callSafe('confirm', confirmArgs());
      assert.match(missing.error, /画面と合格の条件の設定の案が見つかりません/);

      const file = writeDraft(run.cwd);
      fs.writeFileSync(file, '{ これは JSON ではない', 'utf8');
      const broken = await run.callSafe('confirm', confirmArgs());
      assert.match(broken.error, /画面と合格の条件の設定の案が JSON として読めません/);
      assert.equal(run.readState().confirmation, null);
    });
  });

  test('REQ-027 作業の定義の案が、ひな形の決まり（task.schema.json）に合わないと、直す点を返して断る', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      writeDraft(run.cwd, {
        name: '',
        maxIterationsDefault: 0,
        settings: [{ key: '1bad', label: '週', type: 'dropdown' }],
        displays: [{ key: 'x', label: 'X', type: 'text' }],
        extra: true,
      });
      const r = await run.callSafe('confirm', confirmArgs());
      assert.equal(r.ok, false);
      assert.match(r.error, /画面と合格の条件の設定の案が決まりに合いません/);
      assert.match(r.error, /task\.json\.name：空にできません/);
      assert.match(r.error, /task\.json\.maxIterationsDefault：1 以上にしてください/);
      assert.match(r.error, /task\.json\.settings\[0\]\.key：書き方が決まりに合いません/);
      assert.match(r.error, /task\.json\.settings\[0\]\.type：使える値は/);
      assert.match(r.error, /task\.json\.displays\[0\]：「when」がありません/);
      assert.match(r.error, /決まりにない名前「extra」があります/);
      assert.equal(run.readState().confirmation, null, '断ったときは、確認を受け付けたことにしない');
    });
  });

  test('REQ-027 合否の決め方のナレッジがないと、基準を作れないので断る', async () => {
    await withRun(async (run) => {
      await answerEverything(run);
      await run.call('record', { knowledge: [knowledge()] });
      writeDraft(run.cwd);
      const r = await run.callSafe('confirm', confirmArgs({ knowledgeIds: ['K-01'], evalTasks: [{ prompt: 'x' }] }));
      assert.equal(r.ok, false);
      assert.match(r.error, /種類が「合否の決め方」の仕事のやり方や決まりがありません/);
    });
  });

  test('REQ-035 作り直しのときは、引き継ぐことと変わること（rebuild）も知らせないと断る', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      await run.call('progress', { stage: 'できていたことの確認', items: [{ item: 'できていたことの確認', status: '聞いた', quote: '全部引き継ぐ' }] });
      const refused = await run.callSafe('confirm', confirmArgs());
      assert.equal(refused.ok, false);
      assert.match(refused.error, /作り直しのときは、引き継ぐことと変わること（rebuild）も知らせてください/);
      const ok = await run.call('confirm', confirmArgs({ rebuild: { keep: ['週報の書き方'], change: ['画面を足す'] } }));
      assert.match(ok, /受け付けました/);
      assert.deepEqual(run.readState().confirmation.rebuild, { keep: ['週報の書き方'], change: ['画面を足す'] });
    });
  });

  test('REQ-020 示すナレッジの番号は、重なりを除き、番号の小さい順にそろえて残す（見本の基準の並びと、生成の基準の並びを同じにする）', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      await run.call('record', { knowledge: [knowledge({ kind: '合否の決め方', item: '合否の決め方', text: '二つ目の基準', quote: 'もう1つ' })] });
      const text = await run.call('confirm', confirmArgs({ knowledgeIds: ['K-03', 'K-01', 'K-02', 'K-03'], evalTasks: [{ prompt: 'x', criteria: ['K-03', 'K-02'], settings: { task: { week: 'W42' } } }] }));
      assert.deepEqual(run.readState().confirmation.knowledgeIds, ['K-01', 'K-02', 'K-03']);

      // 見本の基準は、番号の小さい順：C-01 が K-02、C-02 が K-03
      const sampleUrl = new URL(/見本：(\S+)/.exec(text)[1]);
      const api = (pathname, method = 'GET') => fetch(`${sampleUrl.origin}${pathname}?k=${sampleUrl.searchParams.get('k')}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      await api('/api/start', 'POST');
      const state = await (await api('/api/state')).json();
      assert.deepEqual(
        state.run.iterations[0].criteria.map((c) => [c.id, c.text]),
        [['C-01', '見出しが「今週の実績」「来週の予定」の順に並んでいれば合格'], ['C-02', '二つ目の基準']],
      );
    });
  });

  test('REQ-020 REQ-043 決まったナレッジは、すべて示す。示す一覧に入っていないものがあれば、断る（画面の一覧と確認の一覧を同じにする）', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      await run.call('record', { knowledge: [knowledge({ text: '3つ目の決まり' }), knowledge({ text: '4つ目の決まり' })] });
      const refused = await run.callSafe('confirm', confirmArgs({ knowledgeIds: ['K-01', 'K-02'] }));
      assert.equal(refused.ok, false);
      assert.match(refused.error, /決まった仕事のやり方や決まりのすべてを、示す一覧（knowledgeIds）に入れてください。入っていないもの：K-03、K-04/);
      assert.equal(run.readState().confirmation, null);
      // 外したものは、入れなくてよい
      await run.call('record', { knowledge: [{ id: 'K-04', status: '外した', quote: '違った' }] });
      const ok = await run.call('confirm', confirmArgs({ knowledgeIds: ['K-01', 'K-02', 'K-03'] }));
      assert.match(ok, /受け付けました/);
    });
  });

  test('REQ-020 確認で示したあとに、決まったナレッジが変わったら（足した・直した・外した）、示し直すまで「生成」に進めない', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      await run.call('confirm', confirmArgs());
      const approve = () => run.callSafe('progress', { stage: '生成', approvalQuote: 'はい、作ってください' });
      const reconfirm = (ids) => run.call('confirm', confirmArgs({ knowledgeIds: ids }));

      // 足した
      await run.call('record', { knowledge: [knowledge({ text: '確認のあとで足した決まり', source: '生成前の確認で足した' })] });
      let r = await approve();
      assert.equal(r.ok, false);
      assert.match(r.error, /作る前の確認で示した仕事のやり方や決まりの一覧と、今の「決まった」ものが違います（示していない：K-03）。plugin-creator_confirm で示し直して、ユーザーによいと答えてもらってください。/);
      assert.deepEqual(internalSymbolsIn(r.error), []);
      assert.equal(run.readState().stage, 'start');
      await reconfirm(['K-01', 'K-02', 'K-03']);

      // 直した（文、例、例外のどれでも）
      await run.call('record', { knowledge: [{ id: 'K-01', text: '直した文', quote: '直して' }] });
      r = await approve();
      assert.match(r.error, /（直した：K-01）/);
      await reconfirm(['K-01', 'K-02', 'K-03']);
      await run.call('record', { knowledge: [{ id: 'K-01', exception: '祝日は翌営業日', quote: '例外があった' }] });
      assert.match((await approve()).error, /（直した：K-01）/);
      await reconfirm(['K-01', 'K-02', 'K-03']);

      // 外した
      await run.call('record', { knowledge: [{ id: 'K-03', status: '外した', quote: 'やっぱり要らない' }] });
      assert.match((await approve()).error, /（決まったものでなくなった：K-03）/);
      await reconfirm(['K-01', 'K-02']);

      // ユーザーの言葉の抜き書きや出どころの直しは、ユーザーが確かめる中身ではないので、示し直さなくてよい
      await run.call('record', { knowledge: [{ id: 'K-01', quote: '言い直した', source: 'ユーザーが自分から話した' }] });
      const done = await approve();
      assert.equal(done.ok, true, done.error);
      assert.equal(run.readState().stage, 'generate');
    });
  });

  test('REQ-020 確認で示した中身の写しを、記録に残す（番号、種類、項目、文、例、例外）', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      await run.call('record', { knowledge: [{ id: 'K-02', example: '実績、予定の順', quote: '例を足す' }] });
      await run.call('confirm', confirmArgs());
      assert.deepEqual(run.readState().confirmation.knowledge, [
        { id: 'K-01', kind: 'other', item: 'procedure', text: '毎週金曜日の17時までに提出する', example: null, exception: null },
        { id: 'K-02', kind: 'criterion', item: 'criteria', text: '見出しが「今週の実績」「来週の予定」の順に並んでいれば合格', example: '実績、予定の順', exception: null },
      ]);
    });
  });

  test('REQ-020 示し直すと（直したあと）、確認の中身が新しいものに替わる。ユーザーの指摘の文言は残さない', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      await run.call('confirm', confirmArgs());
      await run.call('record', { knowledge: [knowledge({ text: '確認で足した決まり', source: '生成前の確認で足した' })] });
      await run.call('confirm', confirmArgs({ knowledgeIds: ['K-01', 'K-02', 'K-03'], behavior: '直した案：前回の週報を受け取り、決まった書き方で今週の週報を作る。' }));
      const confirmation = run.readState().confirmation;
      assert.deepEqual(confirmation.knowledgeIds, ['K-01', 'K-02', 'K-03']);
      assert.match(confirmation.behavior, /^直した案/);
    });
  });
});

describe('課題の設定の値（plugin-creator_confirm の evalTasks.settings。X2-02）', () => {
  const task = (settings) => ({ prompt: '今週の週報を作ってください。', criteria: ['K-02'], ...(settings === undefined ? {} : { settings }) });

  test('REQ-038 REQ-020 課題ごとの、作業の画面に入れる設定の値（繰り返しの上限と作業ごとの設定）を渡すと、記録に残る。省くと空のまとまり', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      // 案の設定：対象の週（文字。必須でない）、書き方（選択肢）、厳しく見る（チェック）、件数（数）
      writeDraft(run.cwd, {
        settings: [
          { key: 'week', label: '対象の週', type: 'text', default: '', required: false },
          { key: 'style', label: '書き方', type: 'select', default: '簡易', options: ['簡易', '詳細'] },
          { key: 'strict', label: '厳しく見る', type: 'checkbox', default: false },
          { key: 'count', label: '件数', type: 'number', default: 3 },
        ],
      });
      await run.call('confirm', confirmArgs({
        evalTasks: [
          task({ maxIterations: 2, task: { week: '2026-W42', style: '詳細', strict: true, count: 3 } }),
          task({ task: { week: '2026-W43' } }),
          task({ maxIterations: 5 }),
          task(),
          task({}),
        ],
      }));
      assert.deepEqual(
        run.readState().confirmation.evalTasks.map((t) => t.settings),
        [{ maxIterations: 2, task: { week: '2026-W42', style: '詳細', strict: true, count: 3 } }, { task: { week: '2026-W43' } }, { maxIterations: 5 }, {}, {}],
      );
      // 案の設定の見出し（label）も残す。画面に、英字の名前（key）でなく見出しで出すため（X4-13）
      assert.deepEqual(run.readState().confirmation.settingLabels, { week: '対象の週', style: '書き方', strict: '厳しく見る', count: '件数' });
    });
  });

  test('REQ-038 設定の値の名前（key）が作業の定義の案の設定にない・値の型や選択肢が合わない・必須の設定に値がないときは、何が違うかと案にある名前を返して断る。確認は受け付けない（X4-04）', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      writeDraft(run.cwd, {
        settings: [
          { key: 'week', label: '対象の週', type: 'text', default: '', required: true },
          { key: 'style', label: '書き方', type: 'select', default: '簡易', options: ['簡易', '詳細'] },
          { key: 'strict', label: '厳しく見る', type: 'checkbox', default: false },
          { key: 'count', label: '件数', type: 'number', default: 3 },
          { key: 'report', label: '週報の場所', type: 'path', default: '' },
        ],
      });
      const cases = [
        // 名前が案にない（書き間違い）：案にある名前を示す
        [{ weeks: '2026-W42' }, [/作業ごとの設定「weeks」が、画面と合格の条件の設定の案の設定にありません（案にある設定の名前：week、style、strict、count、report）。/, /必須の設定「対象の週」（week）の値がありません/]],
        // 型が合わない
        [{ week: 202642 }, [/課題 1 の作業ごとの設定「week」の値は、文字で渡してください。/]],
        [{ week: 'W42', count: '3' }, [/「count」の値は、数で渡してください。/]],
        [{ week: 'W42', strict: 'true' }, [/「strict」の値は、true か false で渡してください。/]],
        [{ week: 'W42', report: 5 }, [/「report」の値は、文字で渡してください。/]],
        // 選択肢にない
        [{ week: 'W42', style: '超詳細' }, [/「style」の値 「超詳細」 が、案の選択肢（簡易、詳細）にありません。/]],
        // 必須で初めの値のない設定に値がない（空の文字も同じ）
        [{ style: '詳細' }, [/必須の設定「対象の週」（week）の値がありません（案に初めの値がないので、画面で開始できません）。/]],
        [{ week: '  ' }, [/必須の設定「対象の週」（week）の値がありません/]],
      ];
      for (const [given, patterns] of cases) {
        const r = await run.callSafe('confirm', confirmArgs({ evalTasks: [task({ task: given })] }));
        assert.equal(r.ok, false, JSON.stringify(given));
        assert.match(r.error, /^課題の、作業の画面に入れる設定の値（settings\.task）が、画面と合格の条件の設定の案（.*task\.json）に合いません。直してから、もう一度知らせてください。/);
        for (const pattern of patterns) assert.match(r.error, pattern, JSON.stringify(given));
        assert.deepEqual(leftWordsIn(r.error), [], r.error);
        assert.deepEqual(internalSymbolsIn(r.error), []);
        assert.equal(run.readState().confirmation, null, '確認は受け付けない');
      }
      // 2つ目の課題の誤りは、2つ目と示す。1つ目が合っていても断る
      const second = await run.callSafe('confirm', confirmArgs({ evalTasks: [task({ task: { week: 'W42' } }), task({ task: { week: 'W43', style: 'x' } })] }));
      assert.match(second.error, /課題 2 の作業ごとの設定「style」の値/);
      // 合っていれば受け付ける。設定の値を省いた課題や、task を省いた課題は、比べない（1段目と同じ）
      const ok = await run.call('confirm', confirmArgs({ evalTasks: [task({ task: { week: 'W42', style: '詳細', strict: true, count: 2, report: 'inputs/a.docx' } }), task({ task: { week: 'W43' } }), task({ maxIterations: 2, task: { week: 'W44' } })] }));
      assert.match(ok, /受け付けました/);
    });
  });

  test('REQ-038 作業ごとの設定（task）を省いた課題も、空の値として比べる：案に必須で初めの値のない設定があれば断る。なければ省ける（X4-04 の続き）', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      // 既定の案：「対象の週」は必須で、初めの値がない
      for (const omitted of [undefined, {}, { maxIterations: 2 }, { task: {} }]) {
        const r = await run.callSafe('confirm', confirmArgs({ evalTasks: [task(omitted)] }));
        assert.equal(r.ok, false, JSON.stringify(omitted));
        assert.match(r.error, /課題 1 の作業ごとの設定に、必須の設定「対象の週」（week）の値がありません（案に初めの値がないので、画面で開始できません）。/, JSON.stringify(omitted));
        assert.equal(run.readState().confirmation, null);
      }
      // 2つ目の課題だけが省いている：2つ目と示す
      const second = await run.callSafe('confirm', confirmArgs({ evalTasks: [task({ task: { week: 'W42' } }), task()] }));
      assert.match(second.error, /課題 2 の作業ごとの設定に、必須の設定「対象の週」（week）の値がありません/);
      // 初めの値がある・必須でない・チェックの設定なら、省いてよい
      for (const week of [{ default: '2026-W01' }, { required: false }, { type: 'checkbox', default: false }]) {
        writeDraft(run.cwd, { settings: [{ key: 'week', label: '対象の週', type: 'text', default: '', required: true, ...week }] });
        const ok = await run.callSafe('confirm', confirmArgs({ evalTasks: [task()] }));
        assert.equal(ok.ok, true, `${JSON.stringify(week)}：${ok.error}`);
      }
    });
  });

  test('REQ-038 案の設定が1つもないときは、案にある設定の名前は「なし」と示す', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      writeDraft(run.cwd, { settings: [] });
      const r = await run.callSafe('confirm', confirmArgs({ evalTasks: [task({ task: { week: 'W42' } })] }));
      assert.match(r.error, /「week」が、画面と合格の条件の設定の案の設定にありません（案にある設定の名前：（なし））。/);
    });
  });

  test('REQ-038 設定の値の形が違う・使えない名前があるときは、何が違うかを返して断る（ユーザーがよいと答えた値が黙って落ちないように）。確認は受け付けない', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      const cases = [
        [{ maxIterations: 0 }, /課題 1 の設定（settings）の繰り返しの上限（maxIterations）は、1以上の整数で渡してください。/],
        [{ maxIterations: 1.5 }, /繰り返しの上限（maxIterations）は、1以上の整数/],
        [{ maxIterations: '3' }, /繰り返しの上限（maxIterations）は、1以上の整数/],
        [{ iterations: 3 }, /設定（settings）に、使えない名前があります：iterations。使える名前：maxIterations、task/],
        [{ task: ['week'] }, /作業ごとの設定の値（task）は、設定の名前と値の組で渡してください。/],
        [{ task: 'week=1' }, /作業ごとの設定の値（task）は、設定の名前と値の組/],
        [{ task: { week: { a: 1 } } }, /作業ごとの設定「week」の値は、文字・数・真偽のどれかで渡してください。/],
        [{ task: { week: null } }, /作業ごとの設定「week」の値は、文字・数・真偽のどれか/],
        [['x'], /設定（settings）は、繰り返しの上限（maxIterations）と作業ごとの設定の値（task）を持つものにしてください。/],
        ['x', /設定（settings）は、繰り返しの上限/],
      ];
      for (const [settings, pattern] of cases) {
        const r = await run.callSafe('confirm', confirmArgs({ evalTasks: [task(settings)] }));
        assert.equal(r.ok, false, JSON.stringify(settings));
        assert.match(r.error, pattern, JSON.stringify(settings));
        assert.deepEqual(leftWordsIn(r.error), [], r.error);
        assert.deepEqual(internalSymbolsIn(r.error), []);
        assert.equal(run.readState().confirmation, null);
      }
      // 2つ目の課題の誤りは、2つ目と示す
      const second = await run.callSafe('confirm', confirmArgs({ evalTasks: [task({ maxIterations: 2 }), task({ maxIterations: 0 })] }));
      assert.match(second.error, /課題 2 の設定（settings）/);
    });
  });

  test('REQ-038 settings は、confirm の引数の定義にある：繰り返しの上限は1以上の整数、作業ごとの設定は文字・数・真偽の値の組。説明の文がある', async () => {
    await withRun(async (run) => {
      const item = run.fake.tool('plugin-creator_confirm').parameters.properties.evalTasks.items;
      assert.deepEqual(item.required, ['prompt']);
      const settings = item.properties.settings;
      assert.equal(settings.type, 'object');
      assert.equal(settings.additionalProperties, false);
      assert.deepEqual(Object.keys(settings.properties), ['maxIterations', 'task']);
      assert.equal(settings.properties.maxIterations.type, 'integer');
      assert.equal(settings.properties.maxIterations.minimum, 1);
      assert.deepEqual(settings.properties.task.additionalProperties.type, ['string', 'number', 'boolean']);
      for (const schema of [settings, settings.properties.maxIterations, settings.properties.task]) assert.ok(schema.description.length >= 10);
    });
  });
});

describe('確認で示した作業の定義の案が変わったら、示し直すまで「生成」に進めない（plugin-creator_confirm と progress。X2-12）', () => {
  const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const draftFile = (run) => path.join(run.cwd, '.plugin-creator-work', 'draft', 'task.json');
  const approve = (run) => run.callSafe('progress', { stage: '生成', approvalQuote: 'はい、作ってください' });

  test('REQ-020 REQ-027 確認を受け付けると、示した案（draft/task.json）の中身の印（sha256）を記録に残す', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      await run.call('confirm', confirmArgs());
      const confirmation = run.readState().confirmation;
      assert.equal(confirmation.taskPath, draftFile(run));
      assert.equal(confirmation.taskHash, sha256(draftFile(run)));
      assert.match(confirmation.taskHash, /^[0-9a-f]{64}$/);
    });
  });

  test('REQ-020 REQ-027 示したあとに案だけを直して示し直さないと断る。示し直せば進める。中身が同じなら（書き直しても）進める', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      await run.call('confirm', confirmArgs());
      const original = fs.readFileSync(draftFile(run), 'utf8');

      fs.writeFileSync(draftFile(run), original.replace('週報の作成', '週報の作成（直した）'));
      const refused = await approve(run);
      assert.equal(refused.ok, false);
      assert.match(refused.error, /^作る前の確認で示した画面と合格の条件の設定の案が、示したあとに変わっています（.*task\.json）。作業の画面の見本を直したときは、plugin-creator_confirm で示し直して、ユーザーによいと答えてもらってください。$/);
      assert.deepEqual(leftWordsIn(refused.error), []);
      assert.deepEqual(internalSymbolsIn(refused.error), []);
      assert.equal(run.readState().stage, 'start');
      assert.equal(run.readState().approvedAt, null);

      // 示し直す：新しい印になり、進める
      await run.call('confirm', confirmArgs());
      assert.equal(run.readState().confirmation.taskHash, sha256(draftFile(run)));
      const done = await approve(run);
      assert.equal(done.ok, true, done.error);
      assert.equal(run.readState().stage, 'generate');
    });
  });

  test('REQ-020 案を書き直しただけで中身が同じなら（作業エージェントが同じ案を書き直した）、そのまま進める', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      await run.call('confirm', confirmArgs());
      fs.writeFileSync(draftFile(run), fs.readFileSync(draftFile(run)));
      const done = await approve(run);
      assert.equal(done.ok, true, done.error);
    });
  });

  test('REQ-020 案が消えていても（見つからなくなった）、示し直すまで進めない', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      await run.call('confirm', confirmArgs());
      fs.rmSync(draftFile(run));
      const refused = await approve(run);
      assert.equal(refused.ok, false);
      assert.match(refused.error, /^作る前の確認で示した画面と合格の条件の設定の案が、見つからなくなりました（.*task\.json）。/);
      assert.equal(run.readState().stage, 'start');
    });
  });

  test('REQ-020 案が変わり、ナレッジも変わったときは、ナレッジの食い違いを先に断る。両方を示し直すと進める', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      await run.call('confirm', confirmArgs());
      writeDraft(run.cwd, { name: '別の名前' });
      await run.call('record', { knowledge: [{ id: 'K-01', text: '直した文', quote: '直して' }] });
      assert.match((await approve(run)).error, /今の「決まった」ものが違います（直した：K-01）/);
      await run.call('confirm', confirmArgs());
      const done = await approve(run);
      assert.equal(done.ok, true, done.error);
    });
  });

  test('REQ-015 REQ-020 印のない古い記録（この直しの前の確認）は、比べずに進める。再開した記録でも、案が変わっていれば断る', async () => {
    const home = tempDir('hash-home');
    const cwd = tempDir('hash-cwd');
    try {
      const first = await startForTest({ sessionId: 'session-hash', home, cwd });
      await readyToConfirm(first);
      await first.call('confirm', confirmArgs());
      const file = first.statePath();
      const state = first.readState();
      await first.cleanup();

      // 案を直した記録は、再開しても断る
      fs.writeFileSync(path.join(cwd, '.plugin-creator-work', 'draft', 'task.json'), fs.readFileSync(path.join(cwd, '.plugin-creator-work', 'draft', 'task.json'), 'utf8').replace('週報の作成', '直した'));
      const second = await startForTest({ sessionId: 'session-hash', home, cwd });
      assert.match((await second.callSafe('progress', { stage: '生成', approvalQuote: 'はい' })).error, /示したあとに変わっています/);
      await second.cleanup();

      // 印を消した記録（古い版が書いたもの）は、比べない
      delete state.confirmation.taskHash;
      fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
      const third = await startForTest({ sessionId: 'session-hash', home, cwd });
      const done = await third.callSafe('progress', { stage: '生成', approvalQuote: 'はい' });
      assert.equal(done.ok, true, done.error);
      await third.cleanup();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});


describe('抜き書きは、ユーザーの言葉の中にある（plugin-creator_progress と record。外側の EVAL の1回目で落ちた2観点への守り）', () => {
  const ANSWER = '1. 売上データの sales.csv（日付・担当・金額）をもらいます。2. 売上集計表.xlsx に貼り付けて、万円にして切り捨てます。';
  const progressOf = (run, item, quote, status = '聞いた') => run.callSafe('progress', { items: [{ item, status, quote }] });

  test('REQ-015 未着手の項目を変えるときの抜き書きが、それより前の答えのどれにも見つからないときは、断る。何も記録しない', async () => {
    await withRun(async (run) => {
      await run.call('progress', { stage: '始まり' });
      await run.fake.askUser({ message: '前回はどうやりましたか？', answer: `User responded: ${ANSWER}` });
      // 手順を「→」でつないだ要約（EVAL 1回目の誤り）
      const summary = await progressOf(run, '前回の1回', 'sales.csv をもらう→売上集計表.xlsx に貼り付け→万円にして切り捨て');
      assert.equal(summary.ok, false);
      assert.equal(summary.error, '「前回の1回」の抜き書き（quote）が、ユーザーの答えの中に見つかりません。1つの答えの言葉を、そのまま写してください（要約しない。間を省くときは「…」でつなぐ）。');
      assert.deepEqual(leftWordsIn(summary.error), []);
      assert.deepEqual(internalSymbolsIn(summary.error), []);
      assert.equal(run.readState().items['last_case'], undefined, '何も記録しない');
      // 答えの言葉をそのまま写せば通る。間を省くときは「…」
      assert.equal((await progressOf(run, '前回の1回', '売上データの sales.csv（日付・担当・金額）をもらいます')).ok, true);
      assert.equal(run.readState().items.last_case.status, 'asked');
      assert.equal((await progressOf(run, '進め方', 'sales.csv（日付・担当・金額）をもらいます…万円にして切り捨てます')).ok, true);
    });
  });

  test('REQ-015 打った発言（質問のツールを使わずに答えたとき）も、ユーザーの言葉として数える。別々の答えをつなぎ合わせたものは断る', async () => {
    await withRun(async (run) => {
      await run.call('progress', { stage: '始まり' });
      await run.fake.askUser({ message: '納期は？', answer: 'User responded: 毎週金曜日の17時まで' });
      await run.hook('onUserPromptSubmitted', { prompt: '提出先は部長です。紙では出しません。' });
      assert.equal((await progressOf(run, '成果物', '提出先は部長です')).ok, true, '打った発言');
      assert.equal((await progressOf(run, '受け取るもの', '毎週金曜日の17時まで')).ok, true, '質問のツールへの答え');
      const joined = await progressOf(run, '進め方', '毎週金曜日の17時まで…紙では出しません');
      assert.equal(joined.ok, false, '「…」の断片は、同じ答えの中になければならない');
      assert.match(joined.error, /^「進め方」の抜き書き（quote）が、ユーザーの答えの中に見つかりません。/);
    });
  });

  test('REQ-015 確かめるのは、未着手から変えるときだけ。聞いた・決まりなし・保留どうしの変更と、同じ呼び出しの2つ目以降は確かめない。1つでも見つからなければ、全部記録しない', async () => {
    await withRun(async (run) => {
      await run.call('progress', { stage: '始まり' });
      await run.fake.askUser({ message: '目的は？', answer: 'User responded: 週報を楽にしたいです' });
      assert.equal((await progressOf(run, '作業の目的', '週報を楽にしたい')).ok, true);
      // 聞いた → 保留：抜き書きは、答えの中になくてよい（未着手から変えるときだけ確かめる）
      assert.equal((await progressOf(run, '作業の目的', 'あとで考えます', '保留')).ok, true);
      // 1つの呼び出しの中で、1つが見つからないと、ほかも記録しない
      const mixed = await run.callSafe('progress', {
        items: [
          { item: '進め方', status: '聞いた', quote: '週報を楽にしたい' },
          { item: '成果物', status: '聞いた', quote: 'どこにもない言葉' },
        ],
      });
      assert.equal(mixed.ok, false);
      assert.match(mixed.error, /^「成果物」の抜き書き/);
      assert.equal(run.readState().items.procedure, undefined);
    });
  });

  test('REQ-015 問答の記録にユーザーの言葉が1件もないときは、確かめずに通す（問答の記録のフックの形は、本物の Copilot CLI でまだ確かめていないため）。取り消しと断りだけのときも同じ', async () => {
    await withRun(async (run) => {
      assert.equal((await progressOf(run, '作業の目的', 'まだ何も記録がないときの言葉')).ok, true);
      await run.fake.askUser({ message: '問い', answer: 'User cancelled the request.' });
      assert.equal((await progressOf(run, '成果物', '取り消しだけのとき')).ok, true);
      // 答えが1件でもあれば、確かめる
      await run.fake.askUser({ message: '問い', answer: 'User responded: はい' });
      assert.equal((await progressOf(run, '進め方', '記録のない言葉')).ok, false);
    });
  });

  test('REQ-020 REQ-049 作る前の確認で足したナレッジの抜き書きが、選んだ選択肢の文だけなら断る（「違うところはない」を選んだだけで、AI の案を足した決まりとして記録しない）', async () => {
    await withRun(async (run) => {
      await run.call('progress', { stage: '始まり' });
      const choice = '違うところはない（この一覧と案で合っている）';
      await run.fake.askUser({ message: '足りないことや違うところはありますか？', choices: [choice, '直したい'], answer: `User responded: ${choice}` });
      const added = (quoteText, over = {}) => run.callSafe('record', { knowledge: [knowledge({ source: '生成前の確認で足した', quote: quoteText, text: 'AI の案の決まり', ...over })] });

      const refused = await added(choice);
      assert.equal(refused.ok, false);
      assert.equal(
        refused.error,
        '作る前の確認で足すのは、ユーザーが答えの中で自分の言葉で述べた決まりだけです。抜き書き（quote）に、その決まりを述べたユーザーの言葉を入れてください。示したものに「違うところはない」と答えただけなら、記録しないでください。',
      );
      assert.deepEqual(leftWordsIn(refused.error), []);
      assert.equal(run.readState().knowledge.length, 0, '何も記録しない');
      // かぎ括弧と句読点の違いは同じ
      assert.equal((await added(`「${choice}」。`)).ok, false);

      // ユーザーが自分の言葉で述べた決まりなら通る
      await run.hook('onUserPromptSubmitted', { prompt: '祝日の週は、月曜の17時までにしてください' });
      assert.equal((await added('祝日の週は、月曜の17時までにしてください')).ok, true);
      // 選ばれていない選択肢の文は、選んだ選択肢の文ではない
      assert.equal((await added('直したい')).ok, true);
      // 出どころが「生成前の確認で足した」でなければ、確かめない
      assert.equal((await run.callSafe('record', { knowledge: [knowledge({ source: 'ヒアリングの答え', quote: choice, text: '別の決まり' })] })).ok, true);
      // 番号を付けた更新は、確かめない（新しいナレッジだけ）
      assert.equal((await run.callSafe('record', { knowledge: [{ id: 'K-01', text: '直した文', quote: choice }] })).ok, true);
    });
  });
});

describe('今のプラグインを直す（plugin-creator_change と、直すときの記録・確認。BLUEPRINT 5 C1）', () => {
  const CHANGE_KEYS = ['folder', 'manifest', 'name', 'version', 'generated', 'carried', 'removed', 'maxId', 'criteriaIds', 'evalPrompts', 'wants', 'startedAt'];
  const ALL_IDS = PLUGIN_KNOWLEDGE.map((k) => k.id);

  test('REQ-052 フォルダと変えたいことを渡すと、直す記録ができる（直すフォルダの実パス、名前、今の版、変えたいことなど）。返り値は平易な日本語で、内部の記号を出さない', async () => {
    await withRun(async (run) => {
      assert.equal(fs.existsSync(run.statePath()), false);
      const { folder, text } = await startChange(run);
      assert.equal(
        text,
        '直すプラグインとして記録しました（edl-sample、今の版 0.1.0）。仕事のやり方や決まり K-01〜K-05 の5件を、確かめたいこととして取り込みました。新しい決まりは K-06 から付きます。',
      );
      assert.deepEqual(internalSymbolsIn(text), []);
      assert.deepEqual(leftWordsIn(text), []);
      const state = run.readState();
      assert.equal(state.stage, 'start');
      assert.equal(state.rebuild, false);
      assert.deepEqual(Object.keys(state.change), CHANGE_KEYS, '記録の形（BLUEPRINT 4.1。取り決め I1）');
      assert.deepEqual(state.change, {
        folder: fs.realpathSync(folder),
        manifest: 'plugin.json',
        name: 'edl-sample',
        version: '0.1.0',
        generated: true,
        carried: ALL_IDS,
        removed: [],
        maxId: 5,
        criteriaIds: { 'K-02': 'C-01', 'K-04': 'C-02' },
        evalPrompts: [PLUGIN_EVALS[0].prompt],
        wants: ['KX-200 のクロスコンパイルとデプロイの手順を組み込みたい'],
        startedAt: '2026-10-22T09:00:00.000Z',
      });
      assert.equal(state.knowledgeCounter, 5);
      // 絶対パスでも渡せる
      const again = await run.callSafe('change', { folder, wants: ['別の言い方'] });
      assert.equal(again.ok, true, again.error);
    });
  });

  test('REQ-052 plugin.json は、直下・.plugin/・.github/plugin/・.claude-plugin/ の順に探す。見つけた場所を記録する', async () => {
    for (const manifestAt of ['plugin.json', '.plugin/plugin.json', '.github/plugin/plugin.json', '.claude-plugin/plugin.json']) {
      await withRun(async (run) => {
        await startChange(run, { plugin: { manifestAt } });
        assert.equal(run.readState().change.manifest, manifestAt);
      });
    }
    // 直下と .github/plugin/ の両方にあれば、直下を使う
    await withRun(async (run) => {
      const folder = writePluginFolder(run.cwd, { manifestAt: '.github/plugin/plugin.json', extraFiles: { 'plugin.json': { name: 'edl-sample', version: '0.3.0' } } });
      await run.call('change', { folder, wants: ['足したい'] });
      assert.deepEqual([run.readState().change.manifest, run.readState().change.version], ['plugin.json', '0.3.0']);
    });
  });

  test('REQ-052 フォルダがない・フォルダでない・plugin.json がない・引数が足りないときは、理由を返して断り、記録を作らない', async () => {
    await withRun(async (run) => {
      fs.writeFileSync(path.join(run.cwd, 'memo.txt'), 'x');
      fs.mkdirSync(path.join(run.cwd, 'empty'));
      const cases = [
        [{ wants: ['足したい'] }, /^直すプラグインのフォルダ（folder）を渡してください。/],
        [{ folder: ' ', wants: ['足したい'] }, /^直すプラグインのフォルダ（folder）を渡してください。/],
        [{ folder: 'empty' }, /^変えたいこと（wants）を、1件以上の文の一覧で渡してください。/],
        [{ folder: 'empty', wants: [' '] }, /^変えたいこと（wants）を、1件以上の文の一覧で渡してください。/],
        [{ folder: 'empty', wants: [1] }, /^変えたいこと（wants）は、文の一覧で渡してください。/],
        [{ folder: 'ない', wants: ['足したい'] }, /^直すプラグインのフォルダ .*ない が見つかりません。/],
        [{ folder: 'memo.txt', wants: ['足したい'] }, /memo\.txt はフォルダではありません。/],
        [{ folder: 'empty', wants: ['足したい'] }, /empty に plugin\.json がありません（探した場所：plugin\.json、\.plugin\/plugin\.json、\.github\/plugin\/plugin\.json、\.claude-plugin\/plugin\.json）。/],
      ];
      for (const [args, pattern] of cases) {
        const r = await run.callSafe('change', args);
        assert.equal(r.ok, false, JSON.stringify(args));
        assert.match(r.error, pattern);
        assert.deepEqual(internalSymbolsIn(r.error), []);
      }
      assert.equal(fs.existsSync(run.statePath()), false, '断ったときは記録を作らない');
    });
  });

  test('REQ-052 作るお話の記録があるセッションでは断る（/clear の案内）。同じフォルダで呼び直すと変えたいことだけが変わり、取り込み直さない。違うフォルダは断る', async () => {
    await withRun(async (run) => {
      await run.call('progress', { stage: '始まり' });
      writePluginFolder(run.cwd);
      const made = await run.callSafe('change', { folder: 'edl-sample', wants: ['足したい'] });
      assert.equal(made.ok, false);
      assert.equal(made.error, 'このセッションでは、新しく作るか作り直すお話を聞いています。今のプラグインを直すときは、/clear してから頼み直してください。');
      assert.equal(run.readState().change, null);
    });
    await withRun(async (run) => {
      const { folder } = await startChange(run);
      await run.call('record', { knowledge: [{ id: 'K-01', status: '決まった', quote: 'そのとおり' }] });
      // 決まりの一覧を書き換えても、呼び直しでは取り込み直さない
      fs.writeFileSync(path.join(folder, 'tests', 'knowledge.json'), JSON.stringify([{ id: 'K-01', kind: 'other', item: '進め方', text: '書き換えた' }]));
      const again = await run.call('change', { folder: 'edl-sample', wants: ['デプロイのやり方を足したい', '画面は変えない'] });
      assert.equal(again, '直すプラグインの記録は、もうあります（edl-sample、今の版 0.1.0）。変えたいことを置き換えました。決まりは取り込み直していません。');
      const state = run.readState();
      assert.deepEqual(state.change.wants, ['デプロイのやり方を足したい', '画面は変えない']);
      assert.deepEqual(state.knowledge.map((k) => [k.id, k.status]), [['K-01', 'decided'], ['K-02', 'candidate'], ['K-03', 'candidate'], ['K-04', 'candidate'], ['K-05', 'candidate']]);
      assert.equal(state.knowledge[0].text, PLUGIN_KNOWLEDGE[0].text);

      writePluginFolder(run.cwd, { dir: 'other' });
      const other = await run.callSafe('change', { folder: 'other', wants: ['足したい'] });
      assert.equal(other.ok, false);
      assert.match(other.error, /^このセッションでは、別のプラグイン（.*edl-sample）を直すお話を聞いています。ほかのプラグインを直すときは、\/clear してから頼み直してください。$/);
    });
  });

  test('REQ-049 記録を作る前の発言は、直す記録を作ったときに、頼みの文として追記される', async () => {
    await withRun(async (run) => {
      await run.hook('onUserPromptSubmitted', { prompt: 'このプラグインにデプロイを足したい' });
      await startChange(run);
      assert.deepEqual(run.readQa().map((e) => [e.type, e.text]), [['request', 'このプラグインにデプロイを足したい']]);
    });
  });

  test('REQ-054 REQ-058 決まりの一覧の決まりが、元の番号・種類・聞くこと・文のまま、確かめたいこと（出どころ「既存のプラグインから読んで確かめた」）として入る。「候補の確かめ」が未着手になる', async () => {
    await withRun(async (run) => {
      await startChange(run);
      const rows = run.readState().knowledge;
      assert.deepEqual(
        rows.map((k) => [k.id, k.kind, k.item, k.itemName, k.text]),
        [
          ['K-01', 'other', 'procedure', '進め方', PLUGIN_KNOWLEDGE[0].text],
          ['K-02', 'criterion', 'criteria', '合否の決め方', PLUGIN_KNOWLEDGE[1].text],
          ['K-03', 'other', 'rules', '決まった書き方やルール', PLUGIN_KNOWLEDGE[2].text],
          ['K-04', 'criterion', 'criteria', '合否の決め方', PLUGIN_KNOWLEDGE[3].text],
          ['K-05', 'other', 'exceptions', 'いつもと違うとき', PLUGIN_KNOWLEDGE[4].text],
        ],
      );
      for (const k of rows) {
        assert.deepEqual(
          { source: k.source, status: k.status, carried: k.carried, quote: k.quote, example: k.example, exception: k.exception, itemTouchedAtRecord: k.itemTouchedAtRecord },
          { source: 'existing_plugin', status: 'candidate', carried: true, quote: `tests/knowledge.json の ${k.id}`, example: null, exception: null, itemTouchedAtRecord: false },
        );
      }
      assert.match(await run.call('state'), /候補の確かめ：未着手（確かめたいこと 5件）/);
      await answerEverything(run);
      const refused = await run.callSafe('confirm', changeConfirmArgs(ALL_IDS));
      assert.match(refused.error, /^まだ聞いていないことがあるので、直す前の確認はできません：候補の確かめ。/);
      // 1回の問いの答えで、まとめて「決まった」にできる
      const checked = await run.call('record', { knowledge: ALL_IDS.map((id) => ({ id, status: '決まった', quote: '一覧のとおりです' })) });
      assert.match(checked, /K-01、K-02、K-03、K-04、K-05 を更新）。確かめたいことはありません。/);
    });
  });

  test('REQ-058 新しい決まりの番号は、決まりの一覧と外した決まりの一覧（tests/knowledge-removed.json）の番号の最大の次から付く。本文にだけある番号は数えない（D15）', async () => {
    await withRun(async (run) => {
      const removed = [{ id: 'K-08', kind: 'other', item: '進め方', text: '前に外した決まり', replacedBy: 'K-05' }, { id: 'K-09', kind: 'other', item: '進め方', text: 'もう1つ前に外した決まり' }];
      const { text } = await startChange(run, { plugin: { removed, extraFiles: { 'skills/demo/SKILL.md': '例：K-30 の決まりに従う\n' } } });
      assert.match(text, /新しい決まりは K-10 から付きます。/);
      const state = run.readState();
      assert.deepEqual([state.change.removed, state.change.maxId, state.knowledgeCounter], [['K-08', 'K-09'], 9, 9]);
      const added = await run.call('record', { knowledge: [knowledge({ text: '新しい決まり' })] });
      assert.match(added, /K-10 を追加/);
    });
  });

  test('REQ-058 引き継いだ決まりの文・種類・聞くこと・例・例外のどれかを直すと、元の番号を外し、新しい番号（replaces＝元の番号）にする。状態だけの直しと、この会話で足した決まりの直しは番号を変えない', async () => {
    await withRun(async (run) => {
      await startChange(run);
      // 文を直す
      const text = await run.call('record', { knowledge: [{ id: 'K-05', text: 'デプロイできないときは、機器を1回 reboot し、それでもだめなら人に伝える', status: '決まった', quote: '今はこうです' }] });
      assert.equal(text, '記録しました（仕事のやり方や決まり K-05 の中身を直したので、K-05 を外して K-06 にしました）。確かめたいこと：4件');
      assert.deepEqual(internalSymbolsIn(text), []);
      let state = run.readState();
      const old = state.knowledge.find((k) => k.id === 'K-05');
      const neu = state.knowledge.find((k) => k.id === 'K-06');
      assert.deepEqual([old.status, old.text, old.quote], ['dropped', PLUGIN_KNOWLEDGE[4].text, '今はこうです']);
      assert.deepEqual(
        { id: neu.id, kind: neu.kind, item: neu.item, itemName: neu.itemName, text: neu.text, source: neu.source, status: neu.status, replaces: neu.replaces, carried: neu.carried },
        { id: 'K-06', kind: 'other', item: 'exceptions', itemName: 'いつもと違うとき', text: 'デプロイできないときは、機器を1回 reboot し、それでもだめなら人に伝える', source: 'answer', status: 'decided', replaces: 'K-05', carried: undefined },
      );
      // 例だけ・例外だけの直しも、中身の直し（REQ-058、決定17）
      await run.call('record', { knowledge: [{ id: 'K-03', example: 'logs/device.log', quote: '例です' }] });
      await run.call('record', { knowledge: [{ id: 'K-01', exception: '急ぐときは省く', quote: '例外があります' }] });
      // 種類・聞くことの直し
      await run.call('record', { knowledge: [{ id: 'K-02', kind: 'それ以外', quote: '合否ではない' }] });
      state = run.readState();
      assert.deepEqual(
        state.knowledge.filter((k) => k.replaces).map((k) => [k.id, k.replaces, k.kind, k.example, k.exception, k.status]),
        [['K-06', 'K-05', 'other', null, null, 'decided'], ['K-07', 'K-03', 'other', 'logs/device.log', null, 'decided'], ['K-08', 'K-01', 'other', null, '急ぐときは省く', 'decided'], ['K-09', 'K-02', 'other', null, null, 'decided']],
      );
      // 状態だけの直しは番号を変えない。同じ文を渡しても変えない
      const same = await run.call('record', { knowledge: [{ id: 'K-04', status: '決まった', text: PLUGIN_KNOWLEDGE[3].text, quote: 'そのとおり' }] });
      assert.match(same, /K-04 を更新/);
      // この会話で足した決まりの直しは、番号を変えない（まだプラグインに入っていない）
      await run.call('record', { knowledge: [{ id: 'K-06', text: '直した後の文をもう一度直す', quote: 'こう直します' }] });
      state = run.readState();
      assert.equal(state.knowledge.find((k) => k.id === 'K-06').text, '直した後の文をもう一度直す');
      assert.equal(state.knowledge.length, 9);
      assert.equal(state.knowledgeCounter, 9);
    });
  });

  test('REQ-058 付け直した元の決まりは、直すことも「決まった」に戻すこともできない。付け直した決まりを外せば、元の決まりをまた扱える', async () => {
    await withRun(async (run) => {
      await startChange(run);
      await run.call('record', { knowledge: [{ id: 'K-05', text: '新しい文', quote: '今はこう' }] }); // K-06
      for (const change of [{ status: '決まった' }, { text: 'さらに直す' }, { status: '外した' }]) {
        const r = await run.callSafe('record', { knowledge: [{ id: 'K-05', quote: '戻したい', ...change }] });
        assert.equal(r.ok, false, JSON.stringify(change));
        assert.equal(r.error, '仕事のやり方や決まり K-05 は、中身を直して K-06 にしました。直すときは K-06 を渡してください。');
      }
      await run.call('record', { knowledge: [{ id: 'K-06', status: '外した', quote: 'やっぱり元のまま' }] });
      await run.call('record', { knowledge: [{ id: 'K-05', status: '決まった', quote: '元のままでいい' }] });
      assert.equal(run.readState().knowledge.find((k) => k.id === 'K-05').status, 'decided');
    });
  });

  test('REQ-058 引き継いだ決まりの中身を直すときの状態は「決まった」だけ。「候補」「外した」と一緒に中身を直すと断り、何も変えない（直した決まりが、外した決まりに見えないように）', async () => {
    await withRun(async (run) => {
      await startChange(run);
      for (const status of ['候補', '外した']) {
        const r = await run.callSafe('record', { knowledge: [{ id: 'K-05', text: '新しい', status, quote: '今はこう' }] });
        assert.equal(r.ok, false, status);
        assert.equal(
          r.error,
          '仕事のやり方や決まり K-05 は引き継いだ決まりなので、中身（種類・聞くこと・文・例・例外）を直すのは、ユーザーが今の中身を答えたときだけです。状態は「決まった」で渡してください。決まりでなくなったときは、中身を変えずに、状態を「外した」にしてください。',
        );
        assert.deepEqual(internalSymbolsIn(r.error), []);
        assert.deepEqual(leftWordsIn(r.error), []);
      }
      const state = run.readState();
      assert.deepEqual([state.knowledge.length, state.knowledgeCounter, state.knowledge[4].status], [5, 5, 'candidate'], '断ったときは何も変えない');
      // 状態を省くか「決まった」なら付け直し、決まりの変わり方には「直した」と出る
      await run.call('record', { knowledge: [{ id: 'K-05', text: '新しい', quote: '今はこう' }] });
      await run.call('record', { knowledge: [{ id: 'K-04', text: '新しい合否の決め方', status: '決まった', quote: '今はこう' }] });
      assert.deepEqual(run.readState().knowledge.filter((k) => k.replaces).map((k) => [k.id, k.replaces, k.status]), [['K-06', 'K-05', 'decided'], ['K-07', 'K-04', 'decided']]);
      assert.match(await run.call('state'), /^足した決まり：なし／直した決まり：K-05→K-06、K-04→K-07／外した決まり：なし$/m);
    });
  });

  test('REQ-058 中身を変えない記録（同じ種類・聞くこと・文を添えて「決まった」にする）の後も、引き継いだ決まりの種類・聞くこと・文は、決まりの一覧のファイルと同じ文字のまま（組み立てのスクリプトは、そのまま比べる）', async () => {
    await withRun(async (run) => {
      const { folder } = await startChange(run);
      const file = JSON.parse(fs.readFileSync(path.join(folder, 'tests', 'knowledge.json'), 'utf8'));
      await run.call('record', { knowledge: file.map((k) => ({ id: k.id, kind: k.kind === 'criterion' ? '合否の決め方' : 'それ以外', item: k.item, text: k.text, status: '決まった', quote: '一覧のとおりです' })) });
      const state = run.readState();
      assert.equal(state.knowledge.length, file.length, '付け直していない');
      const decided = state.knowledge.filter((k) => k.status === 'decided');
      assert.deepEqual(decided.map((k) => [k.id, k.kind, k.itemName, k.text]), file.map((k) => [k.id, k.kind, k.item, k.text]));
    });
  });

  test('REQ-054 D29 決まりの一覧・作業の定義・外した決まりの一覧・課題・plugin.json が壊れているときは、理由を返して断り、記録を作らない', async () => {
    const cases = [
      [{ knowledge: '[ 壊れた' }, /^直すプラグインの tests\/knowledge\.json を、JSON として読めません（/],
      [{ knowledge: { id: 'K-01' } }, /^直すプラグインの tests\/knowledge\.json の形が違います：決まりの一覧（\[ \]）ではありません。/],
      [{ knowledge: [{ id: 'X-01', kind: 'other', item: '進め方', text: 'x' }] }, /tests\/knowledge\.json の形が違います：1件目の番号（id）が K-数字 の形ではありません/],
      [{ knowledge: [{ id: 'K-01', kind: 'rule', item: '進め方', text: 'x' }] }, /K-01 の種類（kind）が、合否の決め方（criterion）かそれ以外（other）のどちらでもありません/],
      [{ knowledge: [{ id: 'K-01', kind: 'other', item: '前回の1回', text: 'x' }] }, /K-01 の聞くこと（item）が、10の聞くことの名前（作業の目的、頼む場面と言い方、.*、いつもと違うとき）のどれでもありません/],
      // 組み立てのスクリプトは、元の聞くこと・文と、記録のものを、そのまま比べる。前後の空白や記号の名前は、取り込まずに断る（直す段で初めて断られないため）
      [{ knowledge: [{ id: 'K-01', kind: 'other', item: 'procedure', text: 'x' }] }, /K-01 の聞くこと（item）が、10の聞くことの名前（.*）のどれでもありません/],
      [{ knowledge: [{ id: 'K-01', kind: 'other', item: ' 合否の決め方', text: 'x' }] }, /K-01 の聞くこと（item）の初めか終わりに、空白か改行があります/],
      [{ knowledge: [{ id: 'K-01', kind: 'other', item: '進め方', text: ' ' }] }, /K-01 の文（text）が空です/],
      [{ knowledge: [{ id: 'K-01', kind: 'other', item: '進め方', text: 'ビルドの前に git pull する\n' }] }, /K-01 の文（text）の初めか終わりに、空白か改行があります/],
      [{ knowledge: [{ id: 'K-01', kind: 'other', item: '進め方', text: 'a' }, { id: 'K-01', kind: 'other', item: '進め方', text: 'b' }] }, /番号 K-01 が重なっています/],
      [{ task: '{' }, /^直すプラグインの com\.github\.copilot\/extensions\/edl-sample\/task\.json を、JSON として読めません/],
      [{ task: { name: 'x' } }, /task\.json の形が違います：合格の条件の一覧（criteria）がありません/],
      [{ task: { criteria: [{ id: '1', knowledge: 'K-02' }] } }, /合格の条件（criteria）の 1件目の番号/],
      [{ removed: '{' }, /^直すプラグインの tests\/knowledge-removed\.json を、JSON として読めません/],
      [{ removed: [{ id: 'X-1' }] }, /tests\/knowledge-removed\.json の形が違います：1件目の番号（id）が K-数字 の形ではありません/],
      [{ evals: [{ id: 'T-01', prompt: ' ' }] }, /tests\/eval\/T-01\/eval\.json の形が違います：頼むときの言葉（prompt）がありません/],
    ];
    for (const [plugin, pattern] of cases) {
      await withRun(async (run) => {
        writePluginFolder(run.cwd, plugin);
        const r = await run.callSafe('change', { folder: 'edl-sample', wants: ['足したい'] });
        assert.equal(r.ok, false, JSON.stringify(plugin));
        assert.match(r.error, pattern, JSON.stringify(plugin));
        assert.match(r.error, /ファイルを(確かめて|直すか、git で前の中身に戻して)から、もう一度頼んでください。$/);
        assert.deepEqual(leftWordsIn(r.error), [], r.error);
        // 内部の記号は出さない。ただし、種類のファイルに書く値は、ファイルを直すのに要るので、日本語の名前と並べた形でだけ見逃す
        assert.deepEqual(internalSymbolsIn(r.error.replaceAll('合否の決め方（criterion）', '')), [], r.error);
        assert.equal(fs.existsSync(run.statePath()), false);
      });
    }
    await withRun(async (run) => {
      writePluginFolder(run.cwd, { extraFiles: { 'plugin.json': '{ "name": "../x" }' } });
      const r = await run.callSafe('change', { folder: 'edl-sample', wants: ['足したい'] });
      assert.match(r.error, /plugin\.json の形が違います：プラグインの名前（name）がないか、フォルダの区切りを含んでいます/);
    });
  });

  test('REQ-054 D29 生成プラグインかは、決まりの一覧と作業の定義（task.json）の両方があるかで見分ける。片方だけなら作っていないプラグインとして扱い、決まりを取り込まない', async () => {
    const generatedOf = async (plugin) =>
      withRun(async (run) => {
        const { text } = await startChange(run, { plugin });
        const state = run.readState();
        return { text, generated: state.change.generated, carried: state.change.carried, rows: state.knowledge.length, criteriaIds: state.change.criteriaIds, evalPrompts: state.change.evalPrompts, maxId: state.change.maxId };
      });
    const both = await generatedOf({});
    assert.deepEqual([both.generated, both.rows], [true, 5]);

    for (const plugin of [{ task: null }, { knowledge: null }, { task: null, knowledge: null }]) {
      const r = await generatedOf(plugin);
      assert.deepEqual([r.generated, r.carried, r.rows, r.criteriaIds, r.evalPrompts], [false, [], 0, {}, []], JSON.stringify(plugin));
      assert.match(
        r.text,
        /^直すプラグインとして記録しました（edl-sample、今の版 0\.1\.0）。決まりの一覧（tests\/knowledge\.json）と com\.github\.copilot\/extensions\/edl-sample\/task\.json がそろっていないので、plugin-creator が作っていないプラグインとして扱います。読み取った決まりは、1件ずつ確かめてください。新しい決まりは K-\d+ から付きます。$/,
      );
    }
    // 決まりの一覧だけがあるとき：取り込まないが、その番号とは重ならないように付ける
    assert.equal((await generatedOf({ task: null })).maxId, 5);
    assert.equal((await generatedOf({ knowledge: null })).maxId, 0);
    // 生成プラグインでないときは、組み立てのスクリプト（plugin_kind）と同じく、全体の形だけを見る：一覧の中身の形や、外した決まりの一覧は見ない
    const loose = await generatedOf({ task: null, knowledge: [{ id: 'K-12', kind: '何か' }, 'メモ'], removed: '{ 壊れた' });
    assert.deepEqual([loose.generated, loose.maxId], [false, 12]);
    // 決まりの一覧が空の生成プラグイン
    const empty = await generatedOf({ knowledge: [], removed: [{ id: 'K-03', kind: 'other', item: '進め方', text: 'x' }] });
    assert.match(empty.text, /決まりの一覧（tests\/knowledge\.json）に決まりがないので、取り込んだものはありません。新しい決まりは K-04 から付きます。$/);
  });

  test('REQ-054 直すときは、段階と聞くこと「できていたことの確認」を断る（できていたことは、すべて引き継ぐ）', async () => {
    await withRun(async (run) => {
      await startChange(run);
      for (const args of [{ stage: 'できていたことの確認' }, { items: [{ item: 'できていたことの確認', status: '聞いた', quote: '全部' }] }]) {
        const r = await run.callSafe('progress', args);
        assert.equal(r.ok, false);
        assert.equal(r.error, '今のプラグインを直すときは、できていたことは聞かずに、すべて引き継ぎます。段階と聞くこと「できていたことの確認」は使いません。');
      }
      const state = run.readState();
      assert.equal(state.rebuild, false);
      assert.equal(state.stage, 'start');
    });
  });

  test('REQ-056 「変えないので聞かない」は、直すときだけ、未着手からだけ使える。「前回の1回」には使えない', async () => {
    await withRun(async (run) => {
      const notChange = await run.callSafe('progress', { items: [{ item: '成果物', status: '変えないので聞かない', quote: 'x' }] });
      assert.equal(notChange.ok, false);
      assert.equal(notChange.error, '「変えないので聞かない」は、今のプラグインを直すときだけ使えます。「成果物」は、聞いてから記録してください。');
      assert.equal(fs.existsSync(run.statePath()), false);
    });
    await withRun(async (run) => {
      await startChange(run);
      const ok = await run.call('progress', { items: [{ item: '成果物', status: '変えないので聞かない', quote: '成果物は今のまま' }] });
      assert.match(ok, /^記録しました。まだ聞いていないこと：/);
      assert.ok(!ok.includes('成果物'), '変えないので聞かないものは、まだ聞いていないことに入らない');
      assert.equal(run.readState().items.output.status, 'unchanged');
      // 同じ状態にし直すのはよい。聞いたなどの後からは、できない
      assert.equal((await run.callSafe('progress', { items: [{ item: '成果物', status: '変えないので聞かない', quote: '今のまま' }] })).ok, true);
      await run.call('progress', { items: [{ item: '進め方', status: '聞いた', quote: '手順を聞いた' }] });
      const fromAsked = await run.callSafe('progress', { items: [{ item: '進め方', status: '変えないので聞かない', quote: 'x' }] });
      assert.equal(fromAsked.error, '「進め方」は、もう聞いているので（今の状態：聞いた）、「変えないので聞かない」にはできません。「変えないので聞かない」にできるのは、状態が「未着手」のものだけです。');
      const lastCase = await run.callSafe('progress', { items: [{ item: '前回の1回', status: '変えないので聞かない', quote: 'x' }] });
      assert.equal(lastCase.error, '「前回の1回」は、変えるところに関わる最近の1回をいつも聞くので、「変えないので聞かない」にはできません。');
      // 変えないので聞かない → 聞いた、には変えられる（聞くことになったとき）
      assert.equal((await run.callSafe('progress', { items: [{ item: '成果物', status: '聞いた', quote: '成果物も変える' }] })).ok, true);
      assert.equal(run.readState().items.output.status, 'asked');
    });
  });

  test('REQ-056 「変えないので聞かない」に変えるときも、そこから変えるときも、抜き書きがユーザーの答えの中にあることを確かめる', async () => {
    await withRun(async (run) => {
      await startChange(run);
      await run.fake.askUser({ message: '変えるのはデプロイのところです。ほかは今のまま引き継ぎます。違うところはありますか？', answer: 'User responded: ない。画面と成果物は今のままでいい' });
      const bad = await run.callSafe('progress', { items: [{ item: '成果物', status: '変えないので聞かない', quote: '成果物は変えない' }] });
      assert.equal(bad.ok, false);
      assert.match(bad.error, /^「成果物」の抜き書き（quote）が、ユーザーの答えの中に見つかりません。/);
      assert.equal((await run.callSafe('progress', { items: [{ item: '成果物', status: '変えないので聞かない', quote: '画面と成果物は今のままでいい' }] })).ok, true);
      // 変えないので聞かない → 聞いた：答えの中にない抜き書きは断る（変えないので聞かないを経由して、確かめをすり抜けない）
      const skipped = await run.callSafe('progress', { items: [{ item: '成果物', status: '聞いた', quote: '聞いていない言葉' }] });
      assert.equal(skipped.ok, false);
      assert.match(skipped.error, /^「成果物」の抜き書き（quote）が、ユーザーの答えの中に見つかりません。/);
    });
  });

  test('REQ-056 plugin-creator が作っていないプラグインを直すときは、どの聞くことも「変えないので聞かない」にできない', async () => {
    await withRun(async (run) => {
      await startChange(run, { plugin: { knowledge: null, task: null, evals: [] } });
      for (const item of ['作業の目的', '成果物', '開始前に設定したいこと', '実行中に見たいこと', '終わった後に見たい結果と見せ方', '資産']) {
        const r = await run.callSafe('progress', { items: [{ item, status: '変えないので聞かない', quote: 'x' }] });
        assert.equal(r.ok, false, item);
        assert.equal(r.error, 'plugin-creator が作っていないプラグインを直すときは、プラグインの形を変えること自体が変えるところなので、「変えないので聞かない」は使えません。聞くことは、すべて聞いてください。');
      }
      assert.deepEqual(run.readState().items, {});
    });
  });

  test('REQ-056 REQ-049 「変えないので聞かない」の聞くことは未着手に数えず、確認を受け付ける。その聞くことに自分から話した決まりは、質問の改善案の対象にならない', async () => {
    await withRun(async (run) => {
      await startChange(run);
      const added = await readyToConfirmChange(run);
      const r = await run.callSafe('confirm', changeConfirmArgs([...ALL_IDS, added]));
      assert.equal(r.ok, true, r.error);
      assert.match(r.text, /^直す前の確認で示すものを受け付けました。画面で見られます。作業の画面の見本：http:\/\/127\.0\.0\.1:\d+\/\?k=/);

      await run.call('record', { knowledge: [knowledge({ item: '成果物', source: 'ユーザーが自分から話した', text: '変えないので聞かなかった聞くことに話した決まり' })] });
      await run.call('record', { knowledge: [knowledge({ item: '進め方', source: 'ユーザーが自分から話した', text: '聞いた後に話した決まり' })] });
      const rows = run.readState().knowledge;
      assert.equal(rows.find((k) => k.text === '変えないので聞かなかった聞くことに話した決まり').itemTouchedAtRecord, false);
      assert.equal(rows.find((k) => k.text === '聞いた後に話した決まり').itemTouchedAtRecord, true);
      const material = await run.call('state', { include: '振り返りの材料' });
      const targets = material.split('問答の記録のすべて')[0];
      assert.match(targets, /K-08（聞くこと：進め方）：そのことを聞いた後に、ユーザーが自分から話した/);
      assert.ok(!/K-07（聞くこと/.test(targets), '変えないので聞かなかった聞くことに話したものは、対象にならない');
    });
  });

  test('REQ-057 直すときの確認：引き継ぐことと変わること（変わることは1件以上）と、新しい版の案が要る。版は形が合い、今の版より大きいこと。受け付けると、版と合格の条件の番号を記録に残す', async () => {
    await withRun(async (run) => {
      await startChange(run);
      const added = await readyToConfirmChange(run);
      const ids = [...ALL_IDS, added];
      const cases = [
        [{ rebuild: undefined }, '直すときは、引き継ぐことと変わること（rebuild）も知らせてください。変わること（rebuild.change）は1件以上にしてください。'],
        [{ rebuild: { keep: ['流れ'], change: [' '] } }, '直すときは、引き継ぐことと変わること（rebuild）も知らせてください。変わること（rebuild.change）は1件以上にしてください。'],
        [{ version: undefined }, '直すときは、新しい版の案（version。例：0.2.0）も知らせてください。ユーザーがよいと答えた版にします。'],
        [{ version: 'v0.2.0' }, '新しい版の案（version）は、0.2.0 のように、数を「.」で3つつないだ形で渡してください（今：「v0.2.0」）。'],
        [{ version: '0.2' }, '新しい版の案（version）は、0.2.0 のように、数を「.」で3つつないだ形で渡してください（今：「0.2」）。'],
        [{ version: '0.1.0' }, '新しい版の案 0.1.0 は、今の版 0.1.0 より大きくしてください。'],
        [{ version: '0.0.9' }, '新しい版の案 0.0.9 は、今の版 0.1.0 より大きくしてください。'],
        [{ version: 2 }, '新しい版の案（version）は、0.2.0 のような文字で渡してください。'],
      ];
      for (const [override, message] of cases) {
        const r = await run.callSafe('confirm', changeConfirmArgs(ids, override));
        assert.equal(r.ok, false, JSON.stringify(override));
        assert.equal(r.error, message);
        assert.equal(run.readState().confirmation, null);
      }
      // 数ごとに比べる（0.10.0 は 0.9.0 より大きい）
      assert.equal((await run.callSafe('confirm', changeConfirmArgs(ids, { version: '0.10.0' }))).ok, true);
      await run.call('confirm', changeConfirmArgs(ids));
      const c = run.readState().confirmation;
      assert.equal(c.version, '0.2.0');
      assert.deepEqual(c.rebuild.change, ['クロスコンパイルとデプロイのルールのスキルを足す', '土台を今の版に上げる（上書きされるファイル：tests/run.py）']);
      assert.deepEqual(c.criteria, [{ id: 'C-01', knowledge: 'K-02' }, { id: 'C-02', knowledge: 'K-04' }, { id: 'C-03', knowledge: added }]);
    });
  });

  test('REQ-057 D16 今の版が plugin.json にないときは、版の形だけを見る。作るときに版を渡すと断る', async () => {
    await withRun(async (run) => {
      const { text } = await startChange(run, { plugin: { version: null } });
      assert.match(text, /（edl-sample、今の版 なし）/);
      const added = await readyToConfirmChange(run);
      assert.equal((await run.callSafe('confirm', changeConfirmArgs([...ALL_IDS, added], { version: '0.0.1' }))).ok, true);
    });
    await withRun(async (run) => {
      await readyToConfirm(run);
      const r = await run.callSafe('confirm', confirmArgs({ version: '0.2.0' }));
      assert.equal(r.error, '新しい版の案（version）は、今のプラグインを直すときだけ渡してください。');
      await run.call('confirm', confirmArgs());
      const c = run.readState().confirmation;
      assert.equal('version' in c, false, '作るときは版を記録しない');
      assert.deepEqual(c.criteria, [{ id: 'C-01', knowledge: 'K-02' }], '合格の条件の番号は、作るときも記録する（組み立ては読まない）');
    });
  });

  test('REQ-061 D17 直すときは、引き継いだ課題と頼むときの言葉が違う課題（変えたところを試す課題）が1つ以上ないと断る。合格の条件は引き継いだ決まりでもよい', async () => {
    await withRun(async (run) => {
      await startChange(run);
      const added = await readyToConfirmChange(run);
      const ids = [...ALL_IDS, added];
      const carriedOnly = changeConfirmArgs(ids).evalTasks.slice(0, 1);
      for (const evalTasks of [carriedOnly, [{ ...carriedOnly[0], prompt: `  ${PLUGIN_EVALS[0].prompt.replace('。', '。 ')} ` }]]) {
        const r = await run.callSafe('confirm', changeConfirmArgs(ids, { evalTasks }));
        assert.equal(r.ok, false);
        assert.equal(r.error, '直すときは、変えたところを試す、試しに動かして採点する試験の課題を1つ以上足してください。今のプラグインから引き継いだ課題と、頼むときの言葉（prompt）が同じ課題しかありません。');
      }
      // 足した課題の合格の条件が、引き継いだ合否の決め方の決まり（K-02）でも受け付ける
      const reused = [...carriedOnly, { prompt: 'KX-200 で動かして、平均値を確かめてください。', criteria: ['K-02'], settings: { task: { week: 'W42' } } }];
      const ok = await run.callSafe('confirm', changeConfirmArgs(ids, { evalTasks: reused }));
      assert.equal(ok.ok, true, ok.error);
      // 引き継ぐ課題の入力は、プラグインの中の場所（仮のファイル）で渡せる
      assert.deepEqual(run.readState().confirmation.evalTasks[0].inputs, [{ path: 'tests/eval/T-01/inputs/src/main.c', provisional: true }]);
    });
  });

  test('REQ-061 D32 課題のない、plugin-creator が作っていないプラグインでは、作業全体を試す課題と変えたところを試す課題の2つで、確認を受け付ける', async () => {
    await withRun(async (run) => {
      await startChange(run, { plugin: { knowledge: null, task: null, evals: [] } });
      await answerEverything(run);
      const r1 = await run.call('record', {
        knowledge: [
          knowledge({ kind: '合否の決め方', item: '合否の決め方', text: '機器のログに AVG=25 と出れば合格', source: 'ファイルから読んで確かめた', quote: 'skills/debug/SKILL.md の「合格」の節', status: '決まった' }),
          knowledge({ kind: '合否の決め方', item: '合否の決め方', text: 'kxtool で送っていれば合格', quote: 'kxtool で送ります' }),
        ],
      });
      assert.match(r1, /K-01、K-02 を追加/);
      writeDraft(run.cwd);
      const r = await run.callSafe('confirm', confirmArgs({
        knowledgeIds: ['K-01', 'K-02'],
        evalTasks: [
          { prompt: 'センサーの平均値の誤りを、最初から最後まで直してください。', criteria: ['K-01'], settings: { task: { week: 'W42' } } },
          { prompt: 'KX-200 にデプロイして、機器のログを保存してください。', criteria: ['K-02'], settings: { task: { week: 'W42' } } },
        ],
        rebuild: { keep: ['デバッグの流れ'], change: ['生成プラグインの形にする（統括・作業・検証の役に分かれる）', 'デプロイの決まりを足す'] },
        version: '1.0.0',
      }));
      assert.equal(r.ok, true, r.error);
      assert.deepEqual(run.readState().confirmation.criteria, [{ id: 'C-01', knowledge: 'K-01' }, { id: 'C-02', knowledge: 'K-02' }]);
    });
  });

  test('REQ-058 D14 合格の条件の番号：引き継いだ合否の決め方は元の task.json の番号のまま。直した・足した合否の決め方は、元の番号の最大の続き。見本にも同じ番号が出る', async () => {
    await withRun(async (run) => {
      await startChange(run, { plugin: { task: { ...PLUGIN_TASKLIKE, criteria: [{ id: 'C-03', text: 'x', knowledge: 'K-02' }, { id: 'C-07', text: 'y', knowledge: 'K-04' }] } } });
      await run.call('record', { knowledge: [{ id: 'K-04', text: 'dbg_log.h も dbg_log.c も変えていなければ合格', status: '決まった', quote: '今は c も' }] }); // K-06
      const added = await readyToConfirmChange(run, { carried: ['K-01', 'K-02', 'K-03', 'K-05'] }); // K-07
      const ids = ['K-01', 'K-02', 'K-03', 'K-05', 'K-06', added];
      const evalTasks = [
        { prompt: PLUGIN_EVALS[0].prompt, criteria: ['K-02', 'K-06'], settings: { task: { week: 'W42' } } },
        { prompt: 'KX-200 にデプロイしてください。', criteria: [added], settings: { task: { week: 'W42' } } },
      ];
      const text = await run.call('confirm', changeConfirmArgs(ids, { evalTasks }));
      assert.deepEqual(run.readState().confirmation.criteria, [{ id: 'C-03', knowledge: 'K-02' }, { id: 'C-08', knowledge: 'K-06' }, { id: 'C-09', knowledge: added }]);

      const sampleUrl = new URL(/見本：(\S+)/.exec(text)[1]);
      const api = (pathname, method = 'GET') => fetch(`${sampleUrl.origin}${pathname}?k=${sampleUrl.searchParams.get('k')}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      await api('/api/start', 'POST');
      const state = await (await api('/api/state')).json();
      assert.deepEqual(state.run.iterations[0].criteria.map((c) => c.id), ['C-03', 'C-08', 'C-09']);
    });
  });

  test('REQ-020 REQ-059 直すときも、確認の後に決まりが変われば（付け直しを含む）、示し直すまで「生成」に進めない', async () => {
    await withRun(async (run) => {
      await startChange(run);
      const added = await readyToConfirmChange(run);
      await run.call('confirm', changeConfirmArgs([...ALL_IDS, added]));
      await run.call('record', { knowledge: [{ id: 'K-03', text: 'ログは logs/kx200.log に保存する', quote: '場所が変わった' }] }); // K-07
      const r = await run.callSafe('progress', { stage: '生成', approvalQuote: 'はい、直してください' });
      assert.equal(r.ok, false);
      assert.equal(r.error, '直す前の確認で示した仕事のやり方や決まりの一覧と、今の「決まった」ものが違います（示していない：K-07。決まったものでなくなった：K-03）。plugin-creator_confirm で示し直して、ユーザーによいと答えてもらってください。');
      await run.call('confirm', changeConfirmArgs(['K-01', 'K-02', 'K-04', 'K-05', 'K-07', added]));
      const done = await run.callSafe('progress', { stage: '生成', approvalQuote: 'はい、直してください' });
      assert.equal(done.ok, true, done.error);
      const state = run.readState();
      assert.equal(state.stage, 'generate');
      // 組み立てのスクリプトが読むもの（取り決め I1・I4）
      assert.deepEqual(state.confirmation.criteria, [{ id: 'C-01', knowledge: 'K-02' }, { id: 'C-02', knowledge: 'K-04' }, { id: 'C-03', knowledge: added }]);
      assert.equal(state.confirmation.version, '0.2.0');
      assert.deepEqual(state.knowledge.filter((k) => k.status === 'decided').map((k) => [k.id, k.itemName]), [['K-01', '進め方'], ['K-02', '合否の決め方'], ['K-04', '合否の決め方'], ['K-05', 'いつもと違うとき'], [added, '合否の決め方'], ['K-07', '決まった書き方やルール']]);
      assert.deepEqual(state.knowledge.find((k) => k.id === 'K-07').replaces, 'K-03');
    });
  });
});

const PLUGIN_TASKLIKE = { name: '組み込みのデバッグ', maxIterationsDefault: 3, workers: [{ agent: 'worker', label: 'デバッグする係' }], settings: [], displays: [] };
