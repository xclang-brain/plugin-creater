// 2段目 部品の試験（クリエイターのエクステンション）：クリエイターの画面と、Web管理画面の見本を、ブラウザーで確かめる。
// 設計書：generated-plugin-structure.md 9章、REQ-027、REQ-043、REQ-044。
//
// 動かし方：Playwright（ライブラリ）とそのブラウザーが要る。リポジトリには node_modules を置かない。
//   別のフォルダで `npm i playwright@1.56.1` し、そのフォルダの node_modules を NODE_PATH に指定する。
//   ブラウザーは PLAYWRIGHT_BROWSERS_PATH で場所を指定できる（環境に入っているものを使うとき）。
//   例：NODE_PATH=/path/to/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node --test "tests/creator/extension/screen.browser.test.mjs"
// Playwright かブラウザーがないときは、この試験を飛ばす（理由を表示する）。ブラウザーなしで動く部分は screen.test.mjs が確かめる。
// 画面の見た目を人が見たいときは、PLUGIN_UI_SHOTS=<フォルダ> を付けると、画面の写真を書き出す。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { answerEverything, changeConfirmArgs, confirmArgs, knowledge, readyToConfirm, readyToConfirmChange, startChange, tempDir, withRun, writeDraft, writeRealInput } from './helpers.mjs';
import { leftWordsIn } from './words.mjs';

// ---- Playwright を見つける（見つからなければ、この試験を飛ばす） ------------------------------------

async function findChromium() {
  try {
    const module = await import('playwright');
    const chromium = module.chromium ?? module.default?.chromium;
    if (chromium) return chromium;
  } catch {
    // 次の探し方へ
  }
  // ES モジュールの import は NODE_PATH を見ないので、自分で探す
  const require = createRequire(import.meta.url);
  for (const dir of (process.env.NODE_PATH ?? '').split(path.delimiter).filter(Boolean)) {
    try {
      const module = require(path.join(dir, 'playwright'));
      if (module.chromium) return module.chromium;
    } catch {
      // 次の場所へ
    }
  }
  return null;
}

const chromium = await findChromium();
let browser = null;
let skipReason = false;
if (!chromium) {
  skipReason =
    'Playwright（ライブラリ）が見つかりません。別のフォルダで npm i playwright@1.56.1 し、その node_modules を NODE_PATH に指定してください。';
} else {
  try {
    browser = await chromium.launch();
  } catch (error) {
    skipReason = `ブラウザーを起動できません（PLAYWRIGHT_BROWSERS_PATH でブラウザーの場所を指定できます）：${String(error.message).split('\n')[0]}`;
  }
}
after(async () => {
  await browser?.close();
});

const SHOTS = process.env.PLUGIN_UI_SHOTS;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
};

/** ページを開く。コンソールの失敗とページの例外（CSP の違反を含む）を覚えておく */
async function openPage(url, viewport = { width: 1100, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(`pageerror：${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') problems.push(`console.${message.type()}：${message.text()}`);
  });
  page.on('dialog', async (dialog) => {
    problems.push(`dialog：${dialog.message()}`);
    await dialog.dismiss();
  });
  await page.goto(url);
  return { page, context, problems, close: () => context.close() };
}

/** 画面に見える文字（本文と、読み上げの名前などの属性）をすべて集める。段階の名前の札は、引数の値なので words.mjs が見逃す */
async function screenWords(page) {
  return page.evaluate(() => {
    const attributes = [...document.querySelectorAll('[aria-label],[title],[alt],[placeholder]')].flatMap((el) => ['aria-label', 'title', 'alt', 'placeholder'].map((a) => el.getAttribute(a)).filter(Boolean));
    return [document.title, document.body.innerText, ...attributes].join('\n');
  });
}

const openScreenUrl = async (run) => /(http:\/\/127\.0\.0\.1:\d+\/\?k=\S+)/.exec(await run.call('open'))[1];
const WAIT = { timeout: 6000 };

describe('クリエイターの画面（ブラウザー）', { skip: skipReason }, () => {
  test('REQ-043 URL を開くと画面が出る。記録がないうちは、始まっていないと示す。入力の欄やボタンはない（見るだけ）', async () => {
    await withRun(async (run) => {
      const url = await openScreenUrl(run);
      const view = await openPage(url);
      try {
        await view.page.locator('#s-head h1').waitFor(WAIT);
        assert.equal(await view.page.title(), 'plugin-creator の画面');
        assert.equal(await view.page.locator('#s-head h1').textContent(), 'plugin-creator の画面');
        assert.match(await view.page.locator('#stage').textContent(), /お話を聞くことはまだ始まっていません/);
        assert.match(await view.page.locator('#s-head').textContent(), /この画面は見るだけです。答えや直しは、Copilot CLI のチャットで行ってください。/);
        assert.equal(await view.page.locator('input, textarea, select, button, form, [contenteditable], [role="button"]').count(), 0, '入力の欄やボタンがある');
        assert.equal(await view.page.locator('#loading').count(), 0, '読み込み中の表示が残っている');
        assert.deepEqual(view.problems, []);
        await shot(view.page, 'creator-empty');
      } finally {
        await view.close();
      }
    });
  });

  test('REQ-043 チャットで答えて決まったことが、ページを再読み込みしなくても一覧に出る。聞いた項目とまだ聞いていない項目が分かれる', async () => {
    await withRun(async (run) => {
      const url = await openScreenUrl(run);
      const view = await openPage(url);
      try {
        await view.page.locator('#stage').waitFor(WAIT);
        await view.page.evaluate(() => {
          window.__notReloaded = 'same-page';
        });

        await run.call('progress', {
          stage: '項目の点検',
          items: [
            { item: '作業の目的', status: '聞いた', quote: '週報を作る' },
            { item: '成果物', status: '保留', quote: '分からない', holder: '経理の田中さん' },
            { item: 'いつもと違うとき', status: '決まりなし', quote: '特にない' },
          ],
        });
        await view.page.locator('#stage').getByText('項目の点検').waitFor(WAIT);
        const notAsked = await view.page.locator('#not-asked li').allTextContents();
        const asked = await view.page.locator('#asked li').allTextContents();
        assert.deepEqual(notAsked.map((t) => t.trim()), ['頼む場面と言い方未着手', '受け取るもの未着手', '進め方未着手', '合否の決め方未着手', '決まった書き方やルール未着手', '守らないと困ること未着手', '使う道具と環境未着手']);
        assert.deepEqual(asked.map((t) => t.trim()), ['作業の目的聞いた', '成果物保留知っている人：経理の田中さん', 'いつもと違うとき決まりなし']);
        assert.match(await view.page.locator('#not-asked h3').textContent(), /まだ聞いていないこと（7）/);
        assert.match(await view.page.locator('#asked h3').textContent(), /聞いたこと（3）/);
        assert.match(await view.page.locator('#knowledge').textContent(), /まだありません/);

        await run.call('record', { knowledge: [knowledge({ text: '毎週金曜日の17時までに提出する' })] });
        await view.page.locator('#knowledge tbody tr').first().waitFor(WAIT);
        assert.deepEqual((await view.page.locator('#knowledge tbody tr:first-child td').allTextContents()).slice(0, 5), ['K-01', 'それ以外', '進め方', '毎週金曜日の17時までに提出する', 'お話を聞いた答え']);

        await run.call('record', { knowledge: [knowledge({ kind: '合否の決め方', item: '合否の決め方', text: '見出しが順に並んでいれば合格', example: '実績、予定の順', exception: '祝日の週は予定を省く' })] });
        await view.page.locator('#knowledge tbody tr:nth-child(2)').waitFor(WAIT);
        const second = await view.page.locator('#knowledge tbody tr:nth-child(2) td').allTextContents();
        assert.deepEqual(second.slice(0, 7), ['K-02', '合否の決め方', '合否の決め方', '見出しが順に並んでいれば合格', 'お話を聞いた答え', '実績、予定の順', '祝日の週は予定を省く']);

        assert.equal(await view.page.evaluate(() => window.__notReloaded), 'same-page', 'ページが読み込み直されている');
        // 見出しや札で「項目」と言わず、「聞くこと」と言う（references/words.md の表。段階の名前「項目の点検」は、そのまま）
        const pageText = (await view.page.locator('body').innerText()).replaceAll('項目の点検', '');
        assert.ok(!pageText.includes('項目'), '画面に「項目」と出ている');
        assert.match(pageText, /そのほかの聞くこと/);
        assert.deepEqual(await view.page.locator('#knowledge thead th').allTextContents(), ['番号', '種類', '聞くこと', '文', '出どころ', '例', '例外', 'ユーザーの言葉']);
        assert.deepEqual(view.problems, []);
        await shot(view.page, 'creator-hearing');
      } finally {
        await view.close();
      }
    });
  });

  test('REQ-043 候補・流用する資産・標準機能と公開のプラグイン・外したナレッジが、分けて出る', async () => {
    await withRun(async (run) => {
      const url = await openScreenUrl(run);
      const view = await openPage(url);
      try {
        await run.call('record', {
          knowledge: [
            knowledge({ text: '候補の決まり', status: '候補', source: 'ファイルから読んで確かめた', quote: '週報.docx の2ページ' }),
            knowledge({ text: '外した決まり', status: '外した', quote: '違う' }),
          ],
          assets: [{ name: '週報テンプレート', location: 'templates/weekly.docx', note: '毎回使う', status: '流用する' }, { name: '古い集計表', status: '候補' }],
          oss: [{ name: '議事録スキル', kind: '公開のプラグイン', choice: '使わない', note: '書式が違う' }],
        });
        await view.page.locator('#candidates').waitFor(WAIT);
        assert.match(await view.page.locator('#candidates').textContent(), /候補の決まり/);
        assert.match(await view.page.locator('#s-candidates h2').textContent(), /まだ確かめていないこと/);
        assert.match(await view.page.locator('#asset-candidates').textContent(), /古い集計表/);
        assert.match(await view.page.locator('#s-knowledge').textContent(), /週報テンプレート.*templates\/weekly\.docx.*毎回使う/);
        assert.match(await view.page.locator('#s-knowledge').textContent(), /議事録スキル.*公開のプラグイン.*使わない.*書式が違う/);
        // 外したナレッジは畳まれている。開くと見える
        const fold = view.page.locator('#s-candidates details');
        assert.equal(await fold.getAttribute('open'), null);
        await fold.locator('summary').click();
        assert.match(await fold.textContent(), /外した決まり/);
        // 決まったことの一覧には、候補も外したものも入らない
        assert.match(await view.page.locator('#knowledge').textContent(), /まだありません/);
        assert.deepEqual(view.problems, []);
      } finally {
        await view.close();
      }
    });
  });

  test('generated-plugin-structure.md 9章 記録やファイルから来た文字は、文字として出る（HTML として動かない）', async () => {
    await withRun(async (run) => {
      const url = await openScreenUrl(run);
      const view = await openPage(url);
      try {
        const attack = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script><b>太字</b>';
        await run.call('record', { knowledge: [knowledge({ text: attack, quote: attack, example: attack })], assets: [{ name: attack, status: '流用する' }] });
        await view.page.locator('#knowledge tbody tr').first().waitFor(WAIT);
        assert.ok((await view.page.locator('#knowledge').textContent()).includes(attack), '文字としてそのまま出る');
        assert.equal(await view.page.locator('#knowledge img, #knowledge b, #s-knowledge img').count(), 0);
        assert.equal(await view.page.evaluate(() => window.__pwned), undefined);
        // 画像の読み込みの失敗などの「console の警告」は出ない
        assert.deepEqual(view.problems, []);
      } finally {
        await view.close();
      }
    });
  });

  test('REQ-020 REQ-044 生成前の確認で示すもの（ナレッジの一覧、振る舞いの案、Web管理画面の見本、EVAL の課題と合否の基準）がすべて見られる', async () => {
    await withRun(async (run) => {
      const url = await openScreenUrl(run);
      const view = await openPage(url);
      try {
        await readyToConfirm(run);
        // 「対象の週」を必須でなくして、設定の値を省いた課題を出せるようにする（必須で初めの値のない設定があると、省いた課題は断られる）
        writeDraft(run.cwd, {
          settings: [
            { key: 'week', label: '対象の週', type: 'text', default: '', required: false },
            { key: 'style', label: '書き方', type: 'select', default: '簡易', options: ['簡易', '詳細'] },
          ],
        });
        const text = await run.call(
          'confirm',
          confirmArgs({
            evalTasks: [
              { prompt: '今週の週報を作ってください。', inputs: [{ path: 'inputs/前回の週報.docx', provisional: true }, { path: writeRealInput(run.cwd) }], criteria: ['K-02'], settings: { maxIterations: 2, task: { week: '2026-W42', style: '詳細' } } },
              { prompt: '先週の分も作ってください。', criteria: ['K-02'] },
            ],
          }),
        );
        const sampleUrl = /見本：(\S+)/.exec(text)[1];
        await view.page.locator('#s-confirm h2').waitFor(WAIT);
        assert.match(await view.page.locator('#s-confirm h2').textContent(), /作る前の確認で示すもの/);

        // ナレッジの一覧：「決まったこと」の一覧と同じ中身
        const confirmRows = await view.page.locator('#confirm-knowledge tbody tr').evaluateAll((rows) => rows.map((r) => [...r.cells].map((c) => c.textContent)));
        const decidedRows = await view.page.locator('#knowledge tbody tr').evaluateAll((rows) => rows.map((r) => [...r.cells].map((c) => c.textContent)));
        assert.equal(confirmRows.length, 2);
        assert.deepEqual(confirmRows, decidedRows);

        // 振る舞いの案
        assert.equal(await view.page.locator('#confirm-behavior').textContent(), '前回の週報を受け取り、今週の予定と実績を整理して、決まった書き方の週報を作る。');

        // Web管理画面の見本：別のタブで開くリンク
        const link = view.page.locator('#confirm-sample a');
        assert.equal(await link.getAttribute('href'), sampleUrl);
        assert.equal(await link.getAttribute('target'), '_blank');
        assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');

        // EVAL の課題と合否の基準
        const evalText = await view.page.locator('#confirm-eval').textContent();
        assert.match(evalText, /課題 1/);
        assert.match(evalText, /今週の週報を作ってください。/);
        assert.match(evalText, /inputs\/前回の週報\.docx.*仮のファイル/);
        assert.match(evalText, /inputs\/実績\.xlsx/);
        assert.match(evalText, /K-02：見出しが「今週の実績」「来週の予定」の順に並んでいれば合格/);
        // 作業の画面に入れる設定の値（X2-02）：値のある課題は一覧で、ない課題は「ない」と
        assert.match(evalText, /この課題で作業の画面に入れる設定の値.*繰り返しの上限：2.*対象の週：2026-W42.*書き方：詳細/);
        assert.ok(!/week：|style：/.test(evalText), '英字の名前（key）のまま出ていない');
        assert.match(evalText, /作業の画面に入れる設定の値はありません/);
        const criteriaRows = await view.page.locator('#s-confirm table').nth(1).evaluateAll((tables) => [...tables[0].querySelectorAll('tbody tr')].map((r) => [...r.cells].map((c) => c.textContent)));
        assert.deepEqual(criteriaRows, [['C-01', '見出しが「今週の実績」「来週の予定」の順に並んでいれば合格', 'K-02']]);
        assert.deepEqual(view.problems, []);
        await shot(view.page, 'creator-confirm');
      } finally {
        await view.close();
      }
    });
  });

  test('REQ-044 作り直しのとき、引き継ぐことと変わることが見られる', async () => {
    await withRun(async (run) => {
      const url = await openScreenUrl(run);
      const view = await openPage(url);
      try {
        await readyToConfirm(run);
        await run.call('progress', { stage: 'できていたことの確認', items: [{ item: 'できていたことの確認', status: '聞いた', quote: '全部引き継ぐ' }] });
        await run.call('confirm', confirmArgs({ rebuild: { keep: ['週報の書き方'], change: ['画面を足す'] } }));
        await view.page.locator('#confirm-rebuild').waitFor(WAIT);
        const text = await view.page.locator('#confirm-rebuild').textContent();
        assert.match(text, /引き継ぐこと.*週報の書き方/);
        assert.match(text, /変わること.*画面を足す/);
      } finally {
        await view.close();
      }
    });
  });

  test('REQ-056 今のプラグインを直すとき、「変えないので聞かないこと」の欄が、まだ聞いていないこと・聞いたことの欄と別に出る。直すプラグインも見出しの下に出る', async () => {
    await withRun(async (run) => {
      const url = await openScreenUrl(run);
      const view = await openPage(url);
      try {
        await startChange(run);
        await run.call('progress', { items: [{ item: '作業の目的', status: '変えないので聞かない', quote: '目的は今のまま' }, { item: '実行中に見たいこと', status: '変えないので聞かない', quote: '画面も今のまま' }, { item: '進め方', status: '聞いた', quote: '手順を聞いた' }] });
        await view.page.locator('#skipped li').first().waitFor(WAIT);
        assert.match(await view.page.locator('#skipped h3').textContent(), /変えないので聞かないこと（2）/);
        assert.deepEqual((await view.page.locator('#skipped li').allTextContents()).map((t) => t.trim()), ['作業の目的変えないので聞かない', '実行中に見たいこと変えないので聞かない']);
        const notAsked = (await view.page.locator('#not-asked li').allTextContents()).join('、');
        assert.ok(!notAsked.includes('作業の目的'), 'まだ聞いていないことに出ている');
        assert.deepEqual((await view.page.locator('#asked li').allTextContents()).map((t) => t.trim()), ['進め方聞いた']);
        assert.ok(!(await view.page.locator('#other-items').textContent()).includes('実行中に見たいこと'), 'そのほかの聞くことに出ている');
        const head = await view.page.locator('#change-target').textContent();
        assert.match(head, /直すプラグイン：edl-sample（今の版 0\.1\.0）/);
        assert.match(head, /変えたいこと：KX-200 のクロスコンパイルとデプロイの手順を組み込みたい/);
        assert.deepEqual(view.problems, []);
        await shot(view.page, 'creator-change-items');
      } finally {
        await view.close();
      }
    });
  });

  test('REQ-056 REQ-057 plugin-creator が作っていないプラグインを直すときも、「変えないので聞かないこと」の欄が出る。「聞かずに案で示す」は、そのほかの聞くことにその札で出る', async () => {
    await withRun(async (run) => {
      const url = await openScreenUrl(run);
      const view = await openPage(url);
      try {
        await startChange(run, { plugin: { knowledge: null, task: null, evals: [] } });
        await run.call('progress', { items: [{ item: '進め方', status: '聞いた', quote: '手順を聞いた' }, { item: '作業の目的', status: '変えないので聞かない', quote: '目的は今のまま' }, { item: '実行中に見たいこと', status: '聞かずに案で示す', quote: '画面はおまかせ' }] });
        await view.page.locator('#skipped li').first().waitFor(WAIT);
        assert.match(await view.page.locator('#change-target').textContent(), /直すプラグイン：edl-sample（今の版 0\.1\.0）/);
        assert.match(await view.page.locator('#skipped h3').textContent(), /変えないので聞かないこと（1）/);
        assert.deepEqual((await view.page.locator('#skipped li').allTextContents()).map((t) => t.trim()), ['作業の目的変えないので聞かない']);
        const drafted = view.page.locator('#other-items li[data-item="実行中に見たいこと"]');
        assert.equal((await drafted.textContent()).trim(), '実行中に見たいこと聞かずに案で示す');
        assert.equal(await drafted.locator('.badge').getAttribute('class'), 'badge badge-info');
        assert.deepEqual(view.problems, []);
      } finally {
        await view.close();
      }
    });
  });

  test('REQ-057 REQ-044 直す前の確認で、直すフォルダ、版（今 → 直した後）、引き継ぐことと変わること（下見の結果を含む）、決まりの足す・直す・外すが見られる', async () => {
    await withRun(async (run) => {
      const url = await openScreenUrl(run);
      const view = await openPage(url);
      try {
        await startChange(run);
        await run.call('record', { knowledge: [{ id: 'K-05', text: '機器を1回 reboot し、だめなら人に伝える', quote: '今はこう' }] }); // K-06
        await run.call('record', { knowledge: [{ id: 'K-03', status: '外した', quote: 'もう要らない' }] });
        const added = await readyToConfirmChange(run, { carried: ['K-01', 'K-02', 'K-04'] }); // K-07
        const change = [
          'クロスコンパイルとデプロイのやり方を足す',
          '共通の土台を今の版に上げます。上書きされるファイル：tests/run.py',
          '形式を移したために読まれなくなり消すファイル：.github/plugin/plugin.json',
          '土台と重なる機能（エージェントごとの思考の深さの設定）は、消さずに残します',
          '本物の機器に送る手順そのものは試せません。試験では、手元の擬似の機器に送ります',
        ];
        await run.call('confirm', changeConfirmArgs(['K-01', 'K-02', 'K-04', 'K-06', added], { rebuild: { keep: ['ログを入れて原因を探す流れ'], change } }));
        await view.page.locator('#confirm-change').waitFor(WAIT);
        assert.equal(await view.page.locator('#s-confirm h2').textContent(), '直す前の確認で示すもの');
        const block = await view.page.locator('#confirm-change').textContent();
        assert.match(block, /直すフォルダ：.*edl-sample/);
        assert.match(await view.page.locator('#confirm-version').textContent(), /版：今 0\.1\.0 → 直した後 0\.2\.0/);
        assert.deepEqual(await view.page.locator('#confirm-knowledge-changes li').allTextContents(), [`足す：${added}`, '直す（新しい番号に付け直す）：K-05 → K-06', '外す：K-03']);
        const rebuild = await view.page.locator('#confirm-rebuild').textContent();
        assert.match(rebuild, /引き継ぐこと.*ログを入れて原因を探す流れ/);
        for (const text of change) assert.ok(rebuild.includes(text), `変わることに出ていない：${text}`);
        assert.match(await view.page.locator('#s-confirm').textContent(), /直すときに、引き継ぐことと変わること/);
        const criteriaRows = await view.page.locator('#s-confirm table').nth(1).evaluateAll((tables) => [...tables[0].querySelectorAll('tbody tr')].map((r) => r.cells[0].textContent));
        assert.deepEqual(criteriaRows, ['C-01', 'C-02', 'C-03']);
        const words = await screenWords(view.page);
        assert.deepEqual(leftWordsIn(words), [], words);
        assert.deepEqual(view.problems, []);
        await shot(view.page, 'creator-change-confirm');
      } finally {
        await view.close();
      }
      // スマートフォンの幅でも、長いフォルダの場所で横にはみ出さない
      const phone = await openPage(url, { width: 375, height: 800 });
      try {
        await phone.page.locator('#confirm-change').waitFor(WAIT);
        const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(overflow <= 0, `横に ${overflow}px はみ出している`);
      } finally {
        await phone.close();
      }
    });
  });

  test('REQ-027 Web管理画面の見本を、ひな形の生成プラグインの画面で開ける：開始前の設定 → 実行中 → 終わった後。基準はナレッジの文のまま', async () => {
    await withRun(async (run) => {
      await readyToConfirm(run);
      const text = await run.call('confirm', confirmArgs());
      const sampleUrl = /見本：(\S+)/.exec(text)[1];
      const view = await openPage(sampleUrl);
      try {
        const page = view.page;
        // 開始前の設定
        await page.locator('#s-setup h2').waitFor(WAIT);
        assert.equal(await page.title(), '週報の作成 - Web管理画面');
        assert.equal(await page.locator('#s-head h1').textContent(), '週報の作成');
        assert.match(await page.locator('#s-notices').textContent(), /これは作業の画面の見本です。表示は仮のデータで、実際には何も動きません。/);
        assert.equal(await page.locator('#setting-week').inputValue(), '（見本）', '必須の設定に仮の値が入っている');
        assert.equal(await page.locator('#setting-style').inputValue(), '簡易');
        assert.equal(await page.locator('#setting-style option').count(), 2);
        await shot(page, 'sample-1-setup');

        // 開始する → 実行中の見本
        await page.locator('#start').click();
        await page.locator('#run-status').getByText('実行中').waitFor(WAIT);
        assert.match(await page.locator('#s-iterations').textContent(), /見出しが「今週の実績」「来週の予定」の順に並んでいれば合格/);
        assert.match(await page.locator('#s-iterations').textContent(), /ユーザーと確かめた基準/);
        assert.match(await page.locator('#s-displays').textContent(), /下書き.*（見本）ここに「下書き」の文章が出ます/);
        assert.match(await page.locator('#s-displays').textContent(), /要点.*見出し1.*（見本）仮の値/);
        assert.match(await page.locator('#s-displays').textContent(), /進み具合.*60%/);
        assert.equal(await page.locator('#s-displays .display[data-key="table"]').count(), 0, '終わった後に見せる表示は、実行中には出ない');
        assert.equal(await page.locator('#stop').count(), 1);
        await shot(page, 'sample-2-running');

        // 止める → 終わった後の見本
        await page.locator('#stop').click();
        await page.locator('#end-reason').waitFor(WAIT);
        assert.match(await page.locator('#end-reason').textContent(), /評価基準をすべて満たした/);
        assert.match(await page.locator('#s-iterations').textContent(), /すべて合格/);
        const table = await page.locator('.display[data-key="table"] tbody tr').count();
        assert.equal(table, 2);
        await page.locator('.display[data-key="chart"] img').waitFor(WAIT);
        const imageOk = await page.locator('.display[data-key="chart"] img').evaluate((img) => img.complete && img.naturalWidth > 0);
        assert.equal(imageOk, true, '仮の画像が表示されない');
        assert.match(await page.locator('.display[data-key="report"] a').textContent(), /見本のファイル\.txt/);
        assert.match(await page.locator('#s-end').textContent(), /（見本）仮のまとめです/);
        assert.deepEqual(view.problems, []);
        await shot(page, 'sample-3-finished');
      } finally {
        await view.close();
      }
    });
  });

  test('REQ-044 試験の結果：1・2段目の段階ごとの合否と不合格の理由、EVAL の点数・差・AI クレジットが見られる', async () => {
    await withRun(async (run) => {
      const url = await openScreenUrl(run);
      const view = await openPage(url);
      try {
        const dir = path.join(run.cwd, 'tests', 'results');
        fs.mkdirSync(path.join(dir, 'eval-1'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'latest.json'),
          JSON.stringify({
            status: 'failed',
            stages: [
              { id: 'stage1', name: '構造の検査', status: 'passed', failures: [], warnings: ['説明が長い'], counts: { total: 12, passed: 12, failed: 0 } },
              { id: 'stage2', name: '部品の試験', status: 'failed', failures: [{ test: 'REQ-009 止めると統括だけが取り消される', reason: '取り消されたのは2体' }], counts: { total: 30, passed: 29, failed: 1 } },
            ],
          }),
        );
        fs.writeFileSync(
          path.join(dir, 'eval-1', 'summary.json'),
          JSON.stringify({ scores: { with: 0.9, without: 0.4 }, credits: 12.5, runs: [{ task: 'T-01', variant: 'with', score: 1, criteria: [{ id: 'C-01', text: '見出しの順', pass: true }, { id: 'C-02', text: '日付の形', pass: false }] }] }),
        );
        await run.call('results', { paths: ['tests/results/latest.json', 'tests/results/eval-1/summary.json'] });
        await view.page.locator('#s-results h2').waitFor(WAIT);
        const text = await view.page.locator('#s-results').textContent();
        assert.match(text, /latest\.json.*不合格/);
        assert.match(text, /ファイルの形の検査.*合格.*12件中、合格12、不合格0/);
        assert.match(text, /動きの試験.*不合格.*30件中、合格29、不合格1/);
        assert.match(text, /動きの試験：REQ-009 止めると統括だけが取り消される/);
        assert.match(text, /取り消されたのは2体/);
        assert.match(text, /ファイルの形の検査：説明が長い/);
        assert.match(text, /できあがるプラグインありの点数0\.9/);
        assert.match(text, /できあがるプラグインなしの点数0\.4/);
        assert.match(text, /点数の差0\.5/);
        assert.match(text, /使った AI クレジット12\.5/);
        assert.match(text, /C-01：合格/);
        assert.match(text, /C-02：不合格/);
        assert.deepEqual(view.problems, []);
        await shot(view.page, 'creator-results');
      } finally {
        await view.close();
      }
    });
  });

  test('REQ-024 REQ-043 画面に出る文（見出し、説明、表の見出し、名前の札、表の読み上げの名前）に、表の左の言葉が出ない', async () => {
    await withRun(async (run) => {
      const url = await openScreenUrl(run);
      const view = await openPage(url);
      try {
        // 始まる前
        await view.page.locator('#s-head h1').waitFor(WAIT);
        const before = await screenWords(view.page);
        assert.deepEqual(leftWordsIn(before), [], before);
        assert.match(before, /お話を聞くことはまだ始まっていません/);

        // 聞いたこと、確かめたいこと、外したこと、資産、標準機能と公開のプラグイン、作る前の確認、作り直し、試験の結果が、すべて出ている状態
        await answerEverything(run, { except: ['成果物'] });
        await run.call('progress', { items: [{ item: '成果物', status: '保留', quote: '分からない', holder: '経理の山田さん' }] });
        await run.call('record', {
          knowledge: [
            knowledge({ text: '毎週金曜日の17時までに提出する' }),
            knowledge({ kind: '合否の決め方', item: '合否の決め方', text: '見出しが順に並んでいれば合格', quote: '実績が先です' }),
            knowledge({ text: '提出前に上長が確認する', status: '候補', source: 'ファイルから読んで確かめた', quote: '週報.docx の末尾' }),
            knowledge({ text: '外す決まり', status: '外した', source: 'ユーザーが自分から話した', quote: '違う' }),
          ],
          assets: [{ name: '週報テンプレート', location: 'templates/weekly.docx', status: '流用する' }, { name: '古い集計表', status: '候補' }],
          oss: [{ name: '議事録の部品', kind: '公開のプラグイン', choice: '使わない', note: '書式が違う' }],
        });
        await view.page.locator('#candidates').waitFor(WAIT);
        const middle = await screenWords(view.page);
        assert.deepEqual(leftWordsIn(middle), [], middle);
        assert.match(middle, /まだ確かめていないこと/);
        assert.match(middle, /お話を聞いた答え/);

        await run.call('record', { knowledge: [{ id: 'K-03', status: '決まった', quote: 'はい' }] });
        await run.call('progress', { items: [{ item: '成果物', status: '聞いた', quote: 'Word の週報' }] });
        await run.call('progress', { stage: 'できていたことの確認', items: [{ item: 'できていたことの確認', status: '聞いた', quote: '全部引き継ぐ' }] });
        await run.call('progress', { stage: '生成前の確認' });
        writeDraft(run.cwd);
        await run.call('confirm', confirmArgs({ knowledgeIds: ['K-01', 'K-02', 'K-03'], rebuild: { keep: ['週報の書き方'], change: ['画面を足す'] } }));
        const dir = path.join(run.cwd, 'tests', 'results');
        fs.mkdirSync(path.join(dir, 'eval-1'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'latest.json'),
          JSON.stringify({
            status: 'failed',
            stages: [
              { id: 'stage1', name: '構造の検査', status: 'passed', failures: [], warnings: ['説明が長い'], counts: { total: 12, passed: 12, failed: 0 } },
              { id: 'stage2', name: '部品の試験', status: 'failed', failures: [{ test: 'REQ-009 止める', reason: '取り消されたのは2体' }], counts: { total: 30, passed: 29, failed: 1 } },
            ],
          }),
        );
        fs.writeFileSync(path.join(dir, 'eval-1', 'summary.json'), JSON.stringify({ scores: { with: 0.9, without: 0.4 }, credits: 12.5, runs: [{ task: 'T-01', variant: 'with', score: 1, criteria: [{ id: 'C-01', text: '見出しの順', pass: true }] }] }));
        fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ memo: '形が決まっていない結果' }));
        await run.call('results', { paths: ['tests/results/latest.json', 'tests/results/eval-1/summary.json', 'tests/results/other.json'] });
        await view.page.locator('#s-results h2').waitFor(WAIT);
        await view.page.locator('#confirm-rebuild').waitFor(WAIT);
        const fold = view.page.locator('#s-candidates details');
        if ((await fold.count()) > 0 && (await fold.getAttribute('open')) === null) await fold.locator('summary').click();
        const after = await screenWords(view.page);
        assert.deepEqual(leftWordsIn(after), [], after);
        // 空振りでないことの確かめ：表の右の言葉で話している
        for (const word of ['作る前の確認で示すもの', '作業の画面の見本', '試しに動かして採点する試験の課題と合格の条件', '仕事のやり方や決まり', 'できあがるプラグインの試験の結果', 'ファイルの形の検査', '動きの試験', 'お話を聞くことの進み具合']) {
          assert.ok(after.includes(word), `表の右の言葉が出ていない：${word}`);
        }
        assert.deepEqual(view.problems, []);
      } finally {
        await view.close();
      }
    });
  });

  test('REQ-044 会話例へのリンクから、会話例を開ける', async () => {
    const examples = tempDir('examples-ui');
    try {
      fs.writeFileSync(path.join(examples, '議事録の例.md'), '# 会話例\nクリエイターの版：0.1.0\nAI が演じたユーザーとの会話です。\n');
      await withRun(
        async (run) => {
          const url = await openScreenUrl(run);
          const view = await openPage(url);
          try {
            const link = view.page.locator('#examples a');
            await link.waitFor(WAIT);
            assert.equal(await link.textContent(), '議事録の例.md');
            const popup = view.page.waitForEvent('popup');
            await link.click();
            const opened = await popup;
            await opened.waitForLoadState();
            assert.match(await opened.locator('body').textContent(), /AI が演じたユーザーとの会話です。/);
            await opened.close();
          } finally {
            await view.close();
          }
        },
        { extra: { examplesDir: examples } },
      );
    } finally {
      fs.rmSync(examples, { recursive: true, force: true });
    }
  });

  test('REQ-043 会話例がまだなければ「まだありません」と出る', async () => {
    await withRun(async (run) => {
      const view = await openPage(await openScreenUrl(run));
      try {
        await view.page.locator('#s-examples h2').waitFor(WAIT);
        assert.match(await view.page.locator('#s-examples').textContent(), /会話例はまだありません/);
      } finally {
        await view.close();
      }
    });
  });

  test('REQ-043 サーバーが止まると、止まったことと直し方が出る（画面の更新は止まる）', async () => {
    await withRun(async (run) => {
      const url = await openScreenUrl(run);
      const view = await openPage(url);
      try {
        await view.page.locator('#stage').waitFor(WAIT);
        await run.creator.screen.close();
        await view.page.locator('#connection-lost').waitFor({ timeout: 8000 });
        assert.match(await view.page.locator('#connection-lost').textContent(), /サーバーにつながりません。Copilot CLI を終えたか、チャットで \/clear をしたかもしれません。/);
      } finally {
        await view.close();
      }
    });
  });

  test('generated-plugin-structure.md 9章 スマートフォンの幅でも、横にはみ出さない（表は入れ物の中で動かせる）', async () => {
    await withRun(async (run) => {
      const url = await openScreenUrl(run);
      await readyToConfirm(run);
      await run.call('confirm', confirmArgs());
      const view = await openPage(url, { width: 375, height: 800 });
      try {
        await view.page.locator('#s-confirm h2').waitFor(WAIT);
        const overflow = await view.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(overflow <= 0, `横に ${overflow}px はみ出している`);
        await shot(view.page, 'creator-confirm-phone');
      } finally {
        await view.close();
      }
    });
  });

  test('generated-plugin-structure.md 9章 色の差が足りている：本文と背景は 4.5:1 以上（ひな形のスタイルを使う）', async () => {
    await withRun(async (run) => {
      const url = await openScreenUrl(run);
      await answerEverything(run);
      await run.call('record', { knowledge: [knowledge()] });
      const view = await openPage(url);
      try {
        await view.page.locator('#knowledge tbody tr').first().waitFor(WAIT);
        const ratios = await view.page.evaluate(() => {
          const parse = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number);
          const lum = ([r, g, b]) => {
            const f = (v) => {
              const s = v / 255;
              return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            };
            return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
          };
          const ratio = (a, b) => {
            const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
            return (hi + 0.05) / (lo + 0.05);
          };
          const out = {};
          for (const [name, selector, bgSelector] of [
            ['本文', '#s-knowledge td', '#s-knowledge'],
            ['見出し', '#s-knowledge h2', '#s-knowledge'],
            ['補足', '#s-head .help', 'body'],
            ['札', '#stage .badge', '#stage .badge'],
          ]) {
            const el = document.querySelector(selector);
            const bg = getComputedStyle(document.querySelector(bgSelector)).backgroundColor;
            out[name] = ratio(parse(getComputedStyle(el).color), parse(bg));
          }
          return out;
        });
        for (const [name, value] of Object.entries(ratios)) assert.ok(value >= 4.5, `${name}の色の差が ${value.toFixed(2)}:1`);
      } finally {
        await view.close();
      }
    });
  });
});
