// 2段目 部品の試験（クリエイターの画面が流用する、ひな形の描画の部品と見た目）。ブラウザーで確かめる。
// 設計書：generated-plugin-structure.md 9章「クリエイターの画面での流用」。REQ-043（クリエイターの画面は、見るだけで、入力の欄がない）。
// クリエイターの画面は、ひな形の画面のサーバー・描画の部品（render.js）・見た目（style.css）を使い、自分の index.html とスクリプトだけを足す。
// この試験は、クリエイターの試験である（生成プラグインの試験には入れない：REQ-043 は生成プラグインの要件ではない）。
//
// 動かし方：Playwright（ライブラリ）とブラウザーが要る。
//   Playwright：クリエイターのフォルダで `npm install --prefix tests --no-save --no-package-lock playwright@1.56.1` を実行して入れる
//   （tests/node_modules に入る。git には入れない）。開発の環境では、別のフォルダに入れた Playwright の node_modules を NODE_PATH で指定してもよい。
//   ブラウザー：環境変数 PLUGIN_TEST_BROWSER_CHANNEL（chrome、msedge、chromium）があれば、そのブラウザーを使う。
//   なければ、または起動できなければ、Playwright の Chromium を使う（PLAYWRIGHT_BROWSERS_PATH で場所を指定できる）。
//   直接動かすとき：node --test "tests/creator/ui-reuse/screen-reuse.test.mjs"
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TEMPLATE_UI = path.join(REPO, 'template', 'com.github.copilot', 'extensions', '_plugin_', 'ui');
// ブラウザーの中で動かす検査（崩れ、色の差）は、ひな形の画面の試験と同じものを使う
const { contrastProblems, layoutProblems } = await import(pathToFileURL(path.join(REPO, 'template', 'tests', 'stage2', 'ui', 'page-checks.mjs')));
const { startServer } = await import(pathToFileURL(path.join(TEMPLATE_UI, 'server.mjs')));

// ---- Playwright を見つける（見つからなければ、直し方を示して止まる） -------------------------------

async function loadPlaywright() {
  try {
    const module = await import('playwright');
    const chromium = module.chromium ?? module.default?.chromium;
    if (chromium) return { chromium };
  } catch {
    // 次の探し方へ
  }
  // 開発の環境の補い：ES モジュールの import は NODE_PATH を見ないので、自分で探す
  const require = createRequire(import.meta.url);
  for (const dir of (process.env.NODE_PATH ?? '').split(path.delimiter).filter(Boolean)) {
    try {
      const module = require(path.join(dir, 'playwright'));
      if (module.chromium) return { chromium: module.chromium };
    } catch {
      // 次の場所へ
    }
  }
  throw new Error(
    [
      'Playwright（ライブラリ）が見つかりません。この試験には、Playwright が要ります。',
      '  1. クリエイターのフォルダで：npm install --prefix tests --no-save --no-package-lock playwright@1.56.1（tests/node_modules に入る）',
      '  2. もう一度、試験を動かす。',
      '  ブラウザーは、環境変数 PLUGIN_TEST_BROWSER_CHANNEL で指定できる。なければ Playwright の Chromium を使う（PLAYWRIGHT_BROWSERS_PATH で場所を指定できる）。',
      '  開発の環境では、別のフォルダに入れた Playwright の node_modules を NODE_PATH で指定してもよい。',
    ].join('\n'),
  );
}

const { chromium } = await loadPlaywright();

async function launchBrowser() {
  const channel = process.env.PLUGIN_TEST_BROWSER_CHANNEL;
  const failures = [];
  if (channel && channel !== 'chromium') {
    try {
      return await chromium.launch({ channel });
    } catch (error) {
      failures.push(`${channel}：${String(error.message).split('\n')[0]}`);
    }
  }
  try {
    return await chromium.launch();
  } catch (error) {
    failures.push(`Playwright の Chromium：${error.message}`);
    throw new Error(`ブラウザーを起動できません。環境変数 PLUGIN_TEST_BROWSER_CHANNEL か PLAYWRIGHT_BROWSERS_PATH でブラウザーを指定してください。\n${failures.join('\n')}`);
  }
}

let browser;
before(async () => {
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
});

// ---- 道具 ------------------------------------------------------------------------------------

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const EVIL = {
  img: '<img src=x onerror="window.__pwned=1">',
  script: '<script>window.__pwned=1</script>',
};
const visibleText = (page) => page.locator('body').innerText();

// ---- 試験 ------------------------------------------------------------------------------------

describe('クリエイターの画面での流用（REQ-043）', () => {
  test('REQ-043 画面のサーバーと描画の部品と見た目だけで、入力の欄のない見るだけの画面を出せる（自分の部品と、ひな形の部品を一緒に出す）', async () => {
    const own = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ui-creator-')));
    tempDirs.push(own);
    fs.writeFileSync(
      path.join(own, 'index.html'),
      '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>決まったこと</title><link rel="stylesheet" href="style.css?k=%%K%%"></head><body><div id="app" class="page"></div><script src="render.js?k=%%K%%"></script><script src="creator.js?k=%%K%%"></script></body></html>',
    );
    fs.writeFileSync(
      path.join(own, 'creator.js'),
      `const { h, badge, displayPart } = window.PluginUi;
const key = new URLSearchParams(location.search).get('k');
fetch('/api/items?k=' + encodeURIComponent(key)).then((r) => r.json()).then((data) => {
  document.getElementById('app').replaceChildren(
    h('h1', null, '決まったこと'),
    h('section', { class: 'panel' }, h('h2', null, '引き出したナレッジ'), badge('聞いた', 'completed'),
      displayPart({ key: 'k', label: '一覧', type: 'table' }, data.table, { fileUrl: () => '#', open: new Set() }),
      displayPart({ key: 'a', label: '資産', type: 'kv' }, data.kv, { fileUrl: () => '#', open: new Set() }),
      displayPart({ key: 't', label: '注意', type: 'text' }, data.text, { fileUrl: () => '#', open: new Set() })),
  );
});
`,
    );
    const server = await startServer({
      preferredPort: 0,
      staticDir: [own, path.join(TEMPLATE_UI, 'static')],
      routes: {
        'GET /api/items': () => ({
          table: { columns: ['番号', '種類', '内容'], rows: [['K-01', '合否の決め方', '3行以内にまとめる'], ['K-02', 'その他', EVIL.img]] },
          kv: { 流用する資産: '前回の週報', 公開のプラグイン: 'なし' },
          text: EVIL.script,
        }),
      },
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
    try {
      await page.goto(server.url);
      await page.waitForSelector('table');
      const text = await visibleText(page);
      assert.match(text, /決まったこと[\s\S]*引き出したナレッジ[\s\S]*聞いた/);
      assert.match(text, /K-01[\s\S]*合否の決め方[\s\S]*3行以内にまとめる/);
      assert.match(text, /流用する資産\s*前回の週報/);
      assert.ok(text.includes(EVIL.img) && text.includes(EVIL.script), 'HTML は文字として出る');
      assert.equal(await page.evaluate(() => window.__pwned), undefined);
      assert.equal(await page.locator('input, select, textarea, button').count(), 0, '入力の欄もボタンもない');
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('h1')).fontFamily.length > 0 && getComputedStyle(document.body).backgroundColor), 'rgb(233, 237, 241)', '生成プラグインと同じ見た目（style.css）');
      assert.equal(await page.evaluate(() => document.fonts.ready.then(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/["']/g, ''))[0])), 'IBM Plex Sans JP', '生成プラグインと同じ書体（ひな形の同梱のフォント）');
      assert.deepEqual(errors, []);
      assert.deepEqual(await page.evaluate(layoutProblems), []);
      const { problems } = await page.evaluate(contrastProblems, 4.5);
      assert.deepEqual(problems, []);
    } finally {
      await context.close();
      await server.close();
    }
  });
});
