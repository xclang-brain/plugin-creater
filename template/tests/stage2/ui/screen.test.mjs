// 2段目 部品の試験（画面）。Playwright でブラウザーを操作し、偽物の中心の処理（fake-core.mjs）から状態を流して確かめる。
// 設計書：generated-plugin-structure.md 10章「2段目 部品の試験（画面）」。
//
// 動かし方：Playwright（ライブラリ）とブラウザーが要る。ふつうは試験の入口（python3 tests/run.py）から動かす。
//   入口が、足りない道具を示して止まり、入れ方を案内する。
//   Playwright：生成プラグインのフォルダで `npm install --prefix tests --no-save --no-package-lock playwright@1.56.1` を実行して入れる
//   （tests/node_modules に入る。git には入れない。ここからふつうに見つかる）。
//   ブラウザー：手元の Chrome か Edge を使う（入口が見つけて、環境変数 PLUGIN_TEST_BROWSER_CHANNEL＝chrome か msedge で渡す）。
//   どちらもないときは、Playwright の Chromium を使う（環境に入っているときは PLAYWRIGHT_BROWSERS_PATH で場所を指定できる）。
//   開発の環境では、別のフォルダに入れた Playwright の node_modules を NODE_PATH で指定してもよい。
//   直接動かすとき：node --test "tests/stage2/ui/screen.test.mjs"
// 画面の見た目を人が見たいときは、PLUGIN_UI_SHOTS=<フォルダ> を付けると、画面の写真を書き出す。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

import { contrastProblems, layoutProblems } from './page-checks.mjs';
import { ALL_DISPLAYS_TASK, LONG, LONG_COMMAND, MODELS, SAMPLE_TASK, createFakeCore, finishedState, locateUi, prepState, richFinished, richPrep, richRunning, runState } from './fake-core.mjs';

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
      'Playwright（ライブラリ）が見つかりません。画面の試験には、Playwright が要ります。',
      '  1. 生成プラグインのフォルダで：npm install --prefix tests --no-save --no-package-lock playwright@1.56.1（tests/node_modules に入る）',
      '  2. もう一度、試験を動かす：python3 tests/run.py',
      '  ブラウザーは、手元の Chrome か Edge を使う。どちらもないときは、Playwright の Chromium を使う（PLAYWRIGHT_BROWSERS_PATH で場所を指定できる）。',
      '  開発の環境では、別のフォルダに入れた Playwright の node_modules を NODE_PATH で指定してもよい。',
    ].join('\n'),
  );
}

const { chromium } = await loadPlaywright();
const { uiDir } = locateUi();
const { startApp } = await import(pathToFileURL(path.join(uiDir, 'app.mjs')));

// ブラウザー：環境変数 PLUGIN_TEST_BROWSER_CHANNEL（chrome か msedge。試験の入口 tests/run.py が、手元の Chrome か Edge を見つけて渡す）が
// あれば、そのブラウザーを使う。なければ、または起動できなければ、Playwright の Chromium を使う。
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
    throw new Error(`ブラウザーを起動できません。Chrome か Edge を入れるか、PLAYWRIGHT_BROWSERS_PATH でブラウザーの場所を指定してください。\n${failures.join('\n')}`);
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

function makePng(width, height) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 8ビット
  header[9] = 2; // RGB
  const rows = Buffer.alloc((width * 3 + 1) * height, 0x66);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0; // フィルターなし
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const EVIL = {
  img: '<img src=x onerror="window.__pwned=1">',
  script: '<script>window.__pwned=1</script>',
  svg: '"><svg onload="window.__pwned=1">',
  anchor: '<a href="javascript:window.__pwned=1">押す</a>',
};

/**
 * 画面を起動してブラウザーで開き、fn に渡す。終わったら片付ける。
 * options：state（初めの状態）、viewport、task（作業の定義。displays が状態の setup.taskDisplays に入る）、setup(core, { work })、contextOptions、
 * allowErrors（わざと断られる操作を試すときに、出てよいエラーの形。true なら何でも、正規表現の配列ならその形だけ）
 */
async function withScreen(options, fn) {
  const { state = prepState(), viewport = { width: 1280, height: 720 }, task = SAMPLE_TASK, setup, allowErrors = false, contextOptions = {} } = options;
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ui-screen-')));
  tempDirs.push(work);
  fs.writeFileSync(path.join(work, 'chart.png'), makePng(40, 20));
  fs.writeFileSync(path.join(work, 'report.md'), '# 週報');
  const core = createFakeCore(state);
  // 作業の定義の表示の定義は、中心の処理が状態の setup.taskDisplays に入れて渡す
  core.setSilently((s) => {
    s.setup.taskDisplays = task.displays ?? [];
    return s;
  });
  core.files = { f1: { path: 'chart.png', name: 'chart.png' }, f2: { path: 'report.md', name: '週報.md' } };
  core.replies = { 'ag-orch': '統括の最後の返事の全文です。\n2行目です。', 'ag-work': '作業の最後の返事の全文です。\n2行目です。' };
  await setup?.(core, { work });
  const app = await startApp({ core, cwd: work, preferredPort: 0 });
  const context = await browser.newContext({ viewport, ...contextOptions });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('request', (request) => requests.push(request.url()));
  const open = async () => {
    await page.goto(app.url);
    await page.waitForFunction(() => !document.getElementById('loading'), null, { timeout: 5000 });
  };
  try {
    await open();
    const result = await fn({ page, core, app, work, errors, requests, open, context });
    const allowed = (message) => allowErrors === true || (Array.isArray(allowErrors) && allowErrors.some((pattern) => pattern.test(message)));
    assert.deepEqual(errors.filter((message) => !allowed(message)), [], '画面にエラーが出た');
    return result;
  } finally {
    await context.close();
    await app.close();
  }
}

const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 6000 });
const HTTP_400 = /status of 400/;
const HTTP_403 = /status of 403/;
const HTTP_404 = /status of 404/;
// 起票できないときの手順（中心の処理が決める文。core/github.mjs の STEP_* と同じ書き方の見本）
const FILE_STEPS = [
  'GitHub にこのプラグインを公開する。',
  'プラグインの設定ファイル（plugin.json）の repository に、公開したリポジトリの GitHub の URL を書く。そのあと、手元のフォルダからインストールしたときは、Copilot CLI を終了して起動し直すか、/clear で新しい会話を始める。GitHub などからインストールしたときは、直した plugin.json を GitHub に送り、このプラグインをアンインストールしてから、もう一度インストールする。',
  'gh（GitHub の公式のコマンド）を入れて、gh auth login でログインする。',
];
const openAllFolds = (page) => page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));

/** ブラウザーの外（試験の側）の条件を、決めた時間まで待つ */
async function eventually(check, message, timeout = 6000) {
  const startedAt = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - startedAt > timeout) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
const textOf = (page, selector) => page.locator(selector).first().innerText();
const visibleText = (page) => page.locator('body').innerText();

async function shot(page, name) {
  if (process.env.PLUGIN_UI_SHOTS) {
    fs.mkdirSync(process.env.PLUGIN_UI_SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.PLUGIN_UI_SHOTS, `${name}.png`), fullPage: true });
  }
}

// ---- 実行中の表示 ----------------------------------------------------------------------------------

describe('実行中の表示（REQ-005、REQ-008）', () => {
  test('REQ-008 役割ごとの枠に、役割・状態（文字）・担当・モデル・最後に動いた時刻が出る', async () => {
    const state = runState('do');
    state.run.agents.splice(2, 0, { ...state.run.agents[1], slot: 'worker-b', label: '集計をする係', task: '集計する', agentId: 'ag-work-b', status: 'completed' });
    await withScreen({ state }, async ({ page }) => {
      const cards = page.locator('#agents .agent');
      assert.equal(await cards.count(), 4, '統括1・作業2・検証1');
      assert.deepEqual(await cards.evaluateAll((els) => els.map((el) => el.dataset.role)), ['orchestrator', 'worker', 'worker', 'verifier']);
      const worker = page.locator('.agent[data-slot="worker"]');
      const workerText = await worker.innerText();
      assert.match(workerText, /作業エージェント/);
      assert.match(workerText, /週報を書く係/);
      assert.match(workerText, /週報の下書きを書く/, '担当している作業');
      assert.match(workerText, /実行中/, '状態が文字で出る');
      assert.match(workerText, /claude-haiku-5-5/);
      assert.match(workerText, /\d\d:\d\d:\d\d/, '最後に動いた時刻');
      assert.match(await page.locator('.agent[data-slot="worker-b"]').innerText(), /集計をする係[\s\S]*完了/);
      assert.match(await page.locator('.agent[data-role="orchestrator"]').innerText(), /統括エージェント/);
      assert.match(await page.locator('.agent[data-role="verifier"]').innerText(), /検証エージェント[\s\S]*待機/);
    });
  });

  test('REQ-008 今が計画・実行・評価のどれかと、試行の番号が出る', async () => {
    await withScreen({ state: runState('plan') }, async ({ page, core }) => {
      const active = () => page.locator('#phases [data-active="true"]').evaluateAll((els) => els.map((el) => el.dataset.phase));
      assert.deepEqual(await page.locator('#phases li').evaluateAll((els) => els.map((el) => el.dataset.phase)), ['plan', 'do', 'study']);
      assert.deepEqual(await active(), ['plan']);
      assert.match(await textOf(page, '#phases'), /計画[\s\S]*（いま）/, '色だけでなく文字でも示す');
      assert.match(await textOf(page, '#trial'), /試行 1 回目（上限 3 回）/);
      core.set((s) => {
        s.run.phase = 'study';
        s.run.iteration = 2;
        return s;
      });
      await until(page, () => document.querySelector('#phases [data-active="true"]')?.dataset.phase === 'study');
      assert.deepEqual(await active(), ['study']);
      assert.match(await textOf(page, '#trial'), /試行 2 回目/);
    });
  });

  test('REQ-008 データの受け渡しの図が、統括→作業→統括→検証→統括の順に出て、動いているところが強調される', async () => {
    await withScreen({ state: runState('plan') }, async ({ page, core }) => {
      const order = await page.locator('#flow li').evaluateAll((els) => els.map((el) => el.dataset.flow));
      assert.deepEqual(order, ['orchestrator-plan', 'to-worker', 'worker', 'to-orchestrator', 'orchestrator-check', 'to-verifier', 'verifier', 'to-orchestrator-last', 'orchestrator-last']);
      const nodes = await page.locator('#flow li.flow-node').evaluateAll((els) => els.map((el) => el.firstChild.textContent));
      assert.deepEqual(nodes, ['統括', '作業', '統括', '検証', '統括']);
      const active = () => page.locator('#flow li[data-active="true"]').evaluateAll((els) => els.map((el) => el.dataset.flow));
      assert.deepEqual(await active(), ['orchestrator-plan']);
      for (const [phase, expected] of [['do', ['to-worker', 'worker']], ['study', ['to-verifier', 'verifier']]]) {
        core.set((s) => {
          s.run.phase = phase;
          return s;
        });
        await until(page, (p) => document.querySelector('#phases [data-active="true"]')?.dataset.phase === p, phase);
        assert.deepEqual(await active(), expected, phase);
      }
      core.set((s) => {
        s.run.status = 'finished';
        s.run.phase = null;
        s.run.endReason = { kind: 'all_passed', detail: null, unstoppable: false };
        return s;
      });
      await until(page, () => document.querySelectorAll('#flow li[data-active="true"]').length === 0);
    });
  });

  test('REQ-008 エージェントの状態の7種類が、どれも色だけでなく文字で出る', async () => {
    const state = runState('do');
    const statuses = ['standby', 'running', 'waiting', 'completed', 'failed', 'stopped', 'unstopped'];
    state.run.agents = statuses.map((status, i) => ({ ...state.run.agents[0], slot: `s${i}`, role: 'worker', label: `枠${i}`, status, agentId: null }));
    await withScreen({ state }, async ({ page }) => {
      const expected = ['待機', '実行中', '待ち（チャットで確認を待っています）', '完了', '失敗', '停止', '止まっていません'];
      const labels = await page.locator('#agents .agent .agent-status').evaluateAll((els) => els.map((el) => el.textContent.trim()));
      assert.deepEqual(labels, expected);
    });
  });

  test('REQ-008 全体の状態（準備中・開始中・実行中・まとめ中・停止中・終了）が文字で出る', async () => {
    await withScreen({ state: runState('do') }, async ({ page, core }) => {
      for (const [status, label] of [['starting', '開始中'], ['running', '実行中'], ['summarizing', 'まとめ中'], ['stopping', '停止中']]) {
        core.set((s) => {
          s.run.status = status;
          return s;
        });
        await until(page, (l) => document.querySelector('#run-status')?.textContent.trim() === l, label);
      }
      core.set(prepState());
      await until(page, () => document.querySelector('#run-status')?.textContent.trim() === '準備中');
    });
  });

  test('REQ-008 再読み込みなしで表示が変わる。版の番号が変わらないあいだは描き直さない', async () => {
    await withScreen({ state: runState('plan') }, async ({ page, core }) => {
      let navigations = 0;
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) navigations += 1;
      });
      await page.evaluate(() => {
        window.__marker = 'same-page';
        window.__mutations = 0;
        new MutationObserver((list) => (window.__mutations += list.length)).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      });
      // 版の番号を上げずに中身を変えても、描き直さない
      core.setSilently((s) => {
        s.run.agents[0].task = '版が変わらないので出ない';
        return s;
      });
      await page.waitForTimeout(2500);
      assert.equal(await page.evaluate(() => window.__mutations), 0, '版が同じなのに描き直した');
      assert.ok(!(await visibleText(page)).includes('版が変わらないので出ない'));
      // 版の番号が上がると、再読み込みなしで変わる
      core.set((s) => {
        s.run.phase = 'do';
        s.run.agents[1].status = 'running';
        s.run.agents[1].task = '作業を始めた';
        return s;
      });
      await until(page, () => document.body.innerText.includes('作業を始めた'));
      assert.equal(await page.evaluate(() => window.__marker), 'same-page', '再読み込みされた');
      assert.equal(navigations, 0);
      assert.ok((await page.evaluate(() => window.__mutations)) > 0);
      // 版が上がったときは、版が同じまま取り残していた変更も出る
      assert.ok((await visibleText(page)).includes('版が変わらないので出ない'));
    });
  });

  test('REQ-008 画面からの問い合わせは、すべて合言葉つきである', async () => {
    await withScreen({ state: runState('do') }, async ({ page, core, requests, app }) => {
      core.set((s) => s);
      await page.waitForTimeout(1500);
      const own = requests.filter((url) => url.startsWith(`http://127.0.0.1:${app.port}/`));
      assert.ok(own.length >= 5, '部品と状態の問い合わせがある');
      for (const url of own) {
        if (url.startsWith('data:')) continue;
        assert.equal(new URL(url).searchParams.get('k'), app.token, url);
      }
    });
  });

  test('REQ-008 実行中は /clear しない注意が出る（準備中と終了後には出ない。中心の処理の注意と重ねない）', async () => {
    await withScreen({ state: prepState() }, async ({ page, core }) => {
      assert.equal(await page.locator('#clear-notice').count(), 0, '準備中');
      core.set(runState('do'));
      await until(page, () => document.querySelector('#clear-notice'));
      assert.match(await textOf(page, '#clear-notice'), /\/clear/);
      core.set((s) => {
        s.notices = ['実行中は /clear を使わないでください。実行が途中で切れます。'];
        return s;
      });
      await until(page, () => !document.querySelector('#clear-notice') && document.body.innerText.includes('実行が途中で切れます'));
      assert.equal((await visibleText(page)).match(/\/clear/g).length, 1, '同じ注意を2回出さない');
      core.set(finishedState());
      await until(page, () => document.querySelector('#run-status')?.textContent.includes('終了'));
      assert.ok(!(await visibleText(page)).includes('/clear'));
    });
  });

  test('REQ-008 サーバーにつながらなくなると、そのことが出る。つながり直すと消える', async () => {
    await withScreen({ state: runState('do'), allowErrors: true }, async ({ page }) => {
      await page.route('**/api/state**', (route) => route.abort());
      await until(page, () => document.getElementById('connection-lost'));
      const message = await textOf(page, '#connection-lost');
      assert.match(message, /サーバーにつながりません/);
      assert.match(message, /\/clear/);
      assert.ok((await page.locator('#agents .agent').count()) > 0, '最後に見えていた内容は残る');
      await page.unroute('**/api/state**');
      await until(page, () => !document.getElementById('connection-lost'));
    });
  });

  test('REQ-008 画面のサーバーが終わると、つながらないことが出る', async () => {
    await withScreen({ state: runState('do'), allowErrors: true }, async ({ page, app }) => {
      await app.close();
      await until(page, () => document.getElementById('connection-lost'));
      assert.match(await textOf(page, '#connection-lost'), /つながりません/);
    });
  });
});

// ---- 確認の待ち ---------------------------------------------------------------------------------------

describe('確認の待ち（REQ-005）', () => {
  const permissionWait = (detail = {}) => ({
    requestId: 'r1',
    slot: 'worker',
    kind: 'permission',
    detail: { permissionKind: 'shell', toolKind: 'shell', command: LONG_COMMAND, paths: ['/work/out'], urls: ['https://example.com/a'], warning: 'ファイルを消すかもしれません。', sandboxBypass: false, ...detail },
  });

  test('REQ-005 許可の求めが、「チャットで確認を待っています」と、コマンドの全文と注意つきで出る。待ちの終わりで消える', async () => {
    const state = runState('do');
    state.run.agents[1].status = 'waiting';
    state.run.waits = [permissionWait()];
    await withScreen({ state }, async ({ page, core }) => {
      const waits = page.locator('#s-waits');
      const text = await waits.innerText();
      assert.match(text, /チャットで確認を待っています/);
      assert.match(text, /作業エージェント（週報を書く係）/, '誰の確認か');
      assert.match(text, /許可/);
      assert.match(text, /コマンドの実行/);
      assert.ok(text.replace(/\s/g, '').includes(LONG_COMMAND.replace(/\s/g, '')), 'コマンドの全文');
      assert.match(text, /\/work\/out/);
      assert.match(text, /https:\/\/example\.com\/a/);
      assert.match(text, /注意[\s\S]*ファイルを消すかもしれません/);
      assert.match(await textOf(page, '.agent[data-slot="worker"]'), /待ち（チャットで確認を待っています）/);
      // 待ちの終わり
      core.set((s) => {
        s.run.waits = [];
        s.run.agents[1].status = 'running';
        return s;
      });
      await until(page, () => document.getElementById('s-waits').hidden);
      assert.ok(!(await visibleText(page)).includes('チャットで確認を待っています（'), '待ちが消える');
      assert.doesNotMatch(await textOf(page, '.agent[data-slot="worker"] .agent-status'), /待ち/);
    });
  });

  test('REQ-005 画面には、確認に答えるボタンがない', async () => {
    const state = runState('do');
    state.run.waits = [permissionWait({ sandboxBypass: true }), { requestId: 'r2', slot: null, kind: 'limit', detail: {} }, { requestId: 'r3', slot: 'verifier', kind: 'question', detail: { question: 'どちらにしますか？' } }];
    await withScreen({ state }, async ({ page }) => {
      assert.equal(await page.locator('#s-waits button, #s-waits input, #s-waits select, #s-waits textarea, #s-waits [role="button"], #s-waits a').count(), 0, '待ちの欄に操作の部品がない');
      const buttons = await page.locator('button').evaluateAll((els) => els.map((el) => el.textContent.trim()));
      assert.deepEqual(buttons, ['止める'], 'ボタンは止めるだけ');
      assert.match(await textOf(page, '#s-waits'), /答えるボタンはありません/);
    });
  });

  test('REQ-005 質問と利用の上限の待ちが出る。エージェントの番号のない待ちは、実行全体の待ちとして出る', async () => {
    const state = runState('do');
    state.run.waits = [
      { requestId: 'q1', slot: 'verifier', kind: 'question', detail: { question: 'どちらの形式にしますか？' } },
      { requestId: 'l1', slot: null, kind: 'limit', detail: {} },
    ];
    await withScreen({ state }, async ({ page }) => {
      const question = await page.locator('.wait[data-request-id="q1"]').innerText();
      assert.match(question, /検証エージェント の確認：質問/);
      assert.match(question, /どちらの形式にしますか？/);
      const limit = await page.locator('.wait[data-request-id="l1"]').innerText();
      assert.match(limit, /実行全体 の確認：AI クレジットの上限/);
    });
  });

  test('REQ-005 サンドボックスの外で動かす求めだけを目立たせる（記録だけにして中で動かし直す求めは、外とは書かない）', async () => {
    const state = runState('do');
    state.run.waits = [permissionWait({ sandboxBypass: true })];
    await withScreen({ state }, async ({ page, core }) => {
      assert.match(await textOf(page, '#s-waits'), /サンドボックス）の外で動かす求めです/);
      core.set((s) => {
        s.run.waits = [permissionWait({ sandboxBypass: true, sandboxPermissive: true })];
        return s;
      });
      await until(page, () => document.querySelector('.wait') && !document.querySelector('[data-sandbox-bypass]'));
      assert.ok(!(await visibleText(page)).includes('外で動かす'));
      core.set((s) => {
        s.run.waits = [permissionWait({ sandboxBypass: false })];
        return s;
      });
      await page.waitForTimeout(1500);
      assert.equal(await page.locator('[data-sandbox-bypass]').count(), 0);
    });
  });

  test('REQ-005 許可の種類（ファイルの書き込み・場所の利用など）が日本語で出る', async () => {
    const state = runState('do');
    state.run.waits = [permissionWait({ permissionKind: 'write', toolKind: undefined, command: undefined, paths: ['/work/a.md'], urls: undefined, warning: undefined })];
    await withScreen({ state }, async ({ page, core }) => {
      assert.match(await textOf(page, '#s-waits'), /ファイルの書き込み/);
      core.set((s) => {
        s.run.waits = [permissionWait({ permissionKind: 'path' })];
        return s;
      });
      await until(page, () => document.body.innerText.includes('場所（フォルダやファイル）の利用'));
    });
  });
});

// ---- 止める ------------------------------------------------------------------------------------------

describe('止める（REQ-009、REQ-012）', () => {
  test('REQ-009 止めるを押すとすぐ押せなくなり、中心の処理には1回だけ届く。終わると「終了（ユーザーが止めた）」になる', async () => {
    await withScreen({ state: runState('do') }, async ({ page, core }) => {
      core.hooks.stop = (c) =>
        c.set((s) => {
          s.run.status = 'finished';
          s.run.phase = null;
          s.run.endReason = { kind: 'user_stopped', detail: null, unstoppable: false };
          s.run.agents = s.run.agents.map((a) => ({ ...a, status: 'stopped' }));
          return s;
        });
      const startedAt = Date.now();
      // 続けて2回押す。1回目の直後に押せなくなっていれば、2回目は効かない
      const disabledRightAfter = await page.evaluate(() => {
        const button = document.getElementById('stop');
        button.click();
        const disabled = button.disabled;
        button.click();
        return disabled;
      });
      assert.equal(disabledRightAfter, true, '押したらすぐ押せなくなる');
      await until(page, () => document.querySelector('#run-status')?.textContent.trim() === '終了（ユーザーが止めた）');
      assert.ok(Date.now() - startedAt < 10_000, '10秒のうちに終了の表示になる');
      assert.equal(core.callsOf('stop').length, 1, '2回押しても1回');
      assert.equal(await page.locator('#stop').count(), 0, '終わったら止めるボタンはない');
      assert.match(await textOf(page, '#end-reason'), /ユーザーが止めた/);
      assert.deepEqual(await page.locator('#agents .agent-status').evaluateAll((els) => els.map((el) => el.textContent.trim())), ['停止', '停止', '停止']);
    });
  });

  test('REQ-009 停止中は、止めているところが文字で出て、止めるボタンは押せない', async () => {
    const state = runState('do');
    state.run.status = 'stopping';
    await withScreen({ state }, async ({ page }) => {
      assert.equal(await textOf(page, '#run-status'), '停止中');
      assert.equal(await page.locator('#stop').isDisabled(), true);
      assert.match(await textOf(page, '#stop'), /止めています/);
    });
  });

  test('REQ-009 止めるボタンは、開始中・実行中・まとめ中だけにある', async () => {
    await withScreen({ state: prepState() }, async ({ page, core }) => {
      assert.equal(await page.locator('#stop').count(), 0, '準備中');
      for (const status of ['starting', 'running', 'summarizing']) {
        core.set((s) => ({ ...s, run: { ...runState('do').run, status } }));
        await until(page, () => document.querySelector('#stop'));
        assert.equal(await page.locator('#stop').isDisabled(), false, status);
        core.set(prepState());
        await until(page, () => !document.querySelector('#stop'));
      }
      core.set(finishedState());
      await until(page, () => document.querySelector('#run-status')?.textContent.includes('終了'));
      assert.equal(await page.locator('#stop').count(), 0, '終了後');
    });
  });

  test('REQ-009 止められなかったときは、断りの文が出て、もう一度押せる', async () => {
    await withScreen({ state: runState('do'), allowErrors: [HTTP_400] }, async ({ page, core }) => {
      core.refusals.stop = new Error('いま止められません。少し待ってください。');
      await page.click('#stop');
      await until(page, () => document.querySelector('.top-message'));
      assert.match(await textOf(page, '.top-message'), /いま止められません/);
      assert.equal(await page.locator('#stop').isDisabled(), false);
      delete core.refusals.stop;
      await page.click('#stop');
      await eventually(() => core.callsOf('stop').length === 2, '2回目の止めるが届かない');
    });
  });

  test('REQ-009 止めきれなかったエージェントと止め方が出て、終わった理由に「止めきれなかったエージェントあり」が添えられる', async () => {
    const state = finishedState({ kind: 'user_stopped', detail: null, unstoppable: true });
    state.run.agents[1].status = 'unstopped';
    state.run.unstopped = [{ agentId: 'ag-work', role: 'worker', howTo: 'チャットで Esc を2回押してください。' }];
    await withScreen({ state }, async ({ page }) => {
      assert.match(await textOf(page, '#run-status'), /終了（ユーザーが止めた）[\s\S]*止めきれなかったエージェントあり/);
      const unstopped = await textOf(page, '#s-unstopped');
      assert.match(unstopped, /止まっていないエージェント/);
      assert.match(unstopped, /作業エージェント/);
      assert.match(unstopped, /チャットで Esc を2回押してください。/);
      assert.match(await textOf(page, '#end-reason'), /ユーザーが止めた[\s\S]*止めきれなかったエージェントあり/);
      assert.match(await textOf(page, '#end-reason'), /チャットに残った確認には、どちらで答えても動きません/);
      assert.match(await textOf(page, '.agent[data-slot="worker"] .agent-status'), /止まっていません/);
    });
  });

  test('REQ-009 止め方の案内が空のときは、標準の案内（Esc を2回押すか Copilot CLI を終える）が出る', async () => {
    const state = finishedState({ kind: 'user_stopped', detail: null, unstoppable: true });
    state.run.unstopped = [{ agentId: 'ag-work', role: 'worker', howTo: '' }];
    await withScreen({ state }, async ({ page }) => {
      assert.match(await textOf(page, '#s-unstopped'), /Esc を2回押すか、Copilot CLI を終えてください/);
    });
  });
});

// ---- 結果の確認 --------------------------------------------------------------------------------------------

describe('結果の確認（REQ-011、REQ-012、REQ-013）', () => {
  test('REQ-012 終わった理由が、どれも日本語で出る（途中で終わったときは理由つき）', async () => {
    const cases = [
      [{ kind: 'all_passed' }, '評価基準をすべて満たした', '終了（評価基準をすべて満たした）'],
      [{ kind: 'max_iterations' }, '上限の回数に達した', '終了（上限の回数に達した）'],
      [{ kind: 'user_stopped' }, 'ユーザーが止めた', '終了（ユーザーが止めた）'],
      [{ kind: 'aborted', detail: 'cut_off' }, '途中で終わった（途中で切れた）', '終了（途中で終わった）'],
      [{ kind: 'aborted', detail: 'credit_limit' }, '途中で終わった（AI クレジットの上限）', '終了（途中で終わった）'],
      [{ kind: 'aborted', detail: 'chat_interrupted' }, '途中で終わった（チャットから中断された）', '終了（途中で終わった）'],
      [{ kind: 'aborted', detail: 'orchestrator_failed' }, '途中で終わった（統括エージェントの失敗）', '終了（途中で終わった）'],
      [{ kind: 'aborted', detail: 'orchestrator_ended' }, '途中で終わった（繰り返しを終えないまま統括エージェントが終わった）', '終了（途中で終わった）'],
      [{ kind: 'aborted', detail: 'retry_limit' }, '途中で終わった（記録のやり直しが上限を超えた）', '終了（途中で終わった）'],
      [{ kind: 'aborted', detail: 'extension_restarted' }, '途中で終わった（エクステンションが再起動した）', '終了（途中で終わった）'],
    ];
    await withScreen({ state: finishedState({ kind: 'all_passed', detail: null, unstoppable: false }) }, async ({ page, core }) => {
      for (const [reason, expected, pill] of cases) {
        core.set((s) => {
          s.run.endReason = { detail: null, unstoppable: false, ...reason };
          return s;
        });
        await until(page, (text) => document.querySelector('#end-reason')?.innerText.includes(text), expected);
        assert.match(await textOf(page, '#end-reason'), new RegExp(`終わった理由：\\s*${expected.replace(/[()（）]/g, '\\$&')}`));
        assert.equal(await textOf(page, '#run-status'), pill);
        assert.equal(await page.locator('#s-unstopped').isHidden(), true);
      }
    });
  });

  test('REQ-012 まとめが出る（長いまとめは最初は畳まれている）', async () => {
    const state = finishedState();
    await withScreen({ state }, async ({ page, core }) => {
      assert.match(await textOf(page, '#s-end'), /まとめ[\s\S]*週報を1回で作成しました。/);
      const long = 'まとめが続きます。'.repeat(60);
      core.set((s) => {
        s.run.summary = long;
        return s;
      });
      await until(page, () => document.querySelector('#s-end details'));
      assert.equal(await page.locator('#s-end details').getAttribute('open'), null);
      assert.ok(!(await textOf(page, '#s-end')).includes(long.slice(0, 40)), '畳まれた中身は見えない');
      await page.click('#s-end summary');
      assert.ok((await textOf(page, '#s-end')).includes(long.slice(0, 40)));
    });
  });

  test('REQ-011 試行ごとに、評価基準・合否（文字）・指摘・計画が出て、ユーザーと確かめた基準が分かる', async () => {
    const state = finishedState({ kind: 'all_passed', detail: null, unstoppable: false });
    state.run.iterations = [
      {
        n: 1,
        criteria: [
          { id: 'C-01', text: '先週の実績が3行以内にまとまっている', fromUser: true },
          { id: 'C-02', text: '来週の予定に担当者が書いてある', fromUser: true },
          { id: 'C-03', text: '誤字がない', fromUser: false },
        ],
        plan: '先週の記録を読み、3行にまとめる。',
        verdicts: [
          { criterionId: 'C-01', pass: true, note: '' },
          { criterionId: 'C-02', pass: false, note: '担当者が書かれていません' },
          { criterionId: 'C-03', pass: true, note: '' },
        ],
        agentIds: ['ag-work'],
      },
      {
        n: 2,
        criteria: [
          { id: 'C-01', text: '先週の実績が3行以内にまとまっている', fromUser: true },
          { id: 'C-02', text: '来週の予定に担当者が書いてある', fromUser: true },
        ],
        plan: '前の試行の指摘に対応して、担当者を足す。',
        verdicts: [
          { criterionId: 'C-01', pass: true, note: '' },
          { criterionId: 'C-02', pass: true, note: '' },
        ],
        agentIds: [],
      },
    ];
    await withScreen({ state }, async ({ page }) => {
      const first = page.locator('.iteration[data-iteration="1"]');
      const firstText = await first.innerText();
      assert.match(firstText, /試行 1[\s\S]*不合格あり/);
      assert.match(await first.locator('.criterion[data-criterion="C-01"]').innerText(), /C-01[\s\S]*先週の実績が3行以内[\s\S]*ユーザーと確かめた基準[\s\S]*合格/);
      const c2 = await first.locator('.criterion[data-criterion="C-02"]').innerText();
      assert.match(c2, /不合格/);
      assert.match(c2, /指摘：担当者が書かれていません/);
      const c3 = await first.locator('.criterion[data-criterion="C-03"]').innerText();
      assert.ok(!c3.includes('ユーザーと確かめた基準'), 'ユーザーと確かめていない基準には付かない');
      assert.match(c3, /誤字がない[\s\S]*合格/);
      const second = page.locator('.iteration[data-iteration="2"]');
      assert.match(await second.innerText(), /試行 2[\s\S]*すべて合格/);
      // 計画は畳まれていて、開くと2回目の計画に前の指摘への対応がある
      assert.ok(!(await second.innerText()).includes('前の試行の指摘に対応'));
      await second.locator('summary', { hasText: '計画を開く' }).click();
      assert.match(await second.innerText(), /前の試行の指摘に対応して、担当者を足す。/);
    });
  });

  test('REQ-011 まだ評価していない基準は「評価前」と出る', async () => {
    await withScreen({ state: runState('do') }, async ({ page }) => {
      const items = await page.locator('.iteration[data-iteration="1"] .criterion').evaluateAll((els) => els.map((el) => el.innerText));
      assert.equal(items.length, 3);
      for (const item of items) assert.match(item, /評価前/);
      assert.match(await textOf(page, '.iteration[data-iteration="1"] .iteration-head'), /評価前/);
    });
  });

  test('REQ-012 各エージェントの最後の返事の全文は、最初は畳まれていて、開いたときに取る（開いたままにしておける）', async () => {
    await withScreen({ state: finishedState() }, async ({ page, core }) => {
      const fold = page.locator('.agent[data-slot="worker"] details');
      assert.equal(await fold.getAttribute('open'), null);
      assert.equal(core.callsOf('getReply').length, 0, '開くまでは取らない');
      assert.equal(await page.locator('.agent[data-slot="worker"] .reply-full').isVisible(), false, '畳まれた中身は見えない');
      await fold.locator('summary').click();
      await until(page, () => document.querySelector('.agent[data-slot="worker"] .reply-full')?.innerText.includes('作業の最後の返事の全文です。'));
      assert.equal(await page.locator('.agent[data-slot="worker"] .reply-full').innerText(), '作業の最後の返事の全文です。\n2行目です。');
      assert.equal(core.callsOf('getReply').length, 1);
      // 状態が変わって描き直されても、開いたまま
      core.set((s) => {
        s.run.agents[1].lastActiveAt = Date.UTC(2026, 9, 22, 3, 9, 9);
        return s;
      });
      await until(page, () => document.body.innerText.includes('03:09:09') || /\d\d:09:09/.test(document.body.innerText));
      assert.equal(await page.locator('.agent[data-slot="worker"] details').getAttribute('open'), '');
      assert.equal(await page.locator('.agent[data-slot="worker"] .reply-full').isVisible(), true);
    });
  });

  test('REQ-012 試行で動いたエージェントの返事の全文も、畳まれていて、開くと読める', async () => {
    await withScreen({ state: finishedState() }, async ({ page }) => {
      const fold = page.locator('.iteration[data-iteration="1"] details', { hasText: 'この試行で動いたエージェント' });
      await fold.locator('summary').first().click();
      await fold.locator('details summary').click();
      await until(page, () => [...document.querySelectorAll('.iteration .reply-full')].some((el) => el.innerText.includes('作業の最後の返事の全文です。')));
    });
  });

  test('REQ-012 返事の全文を取れなかったときは、そのことが出る', async () => {
    await withScreen({ state: finishedState(), allowErrors: [HTTP_404] }, async ({ page, core }) => {
      delete core.replies['ag-work'];
      await page.locator('.agent[data-slot="worker"] details summary').click();
      await until(page, () => document.querySelector('.agent[data-slot="worker"] .reply-full')?.innerText.includes('取得できませんでした'));
    });
  });

  test('REQ-013 課題と Issue の案が出る。案は、自動で見つけたものと統括の振り返りが分かれ、本文は畳まれている', async () => {
    const state = finishedState();
    state.run.issues = [
      { id: 'i1', title: '失敗したツールがある', body: '本文1\n詳しく', source: 'mechanical', filing: { state: 'none', url: null, reason: null } },
      { id: 'i2', title: '振り返りの案', body: '本文2', source: 'orchestrator', filing: { state: 'none', url: null, reason: null } },
    ];
    await withScreen({ state }, async ({ page }) => {
      const first = await textOf(page, '.issue[data-issue-id="i1"]');
      assert.match(first, /失敗したツールがある/);
      assert.match(first, /実行の記録から自動で見つけた課題/);
      assert.match(await textOf(page, '.issue[data-issue-id="i2"]'), /統括エージェントが振り返って足した課題/);
      assert.ok(!first.includes('詳しく'), '本文は畳まれている');
      await page.locator('.issue[data-issue-id="i1"] summary').click();
      assert.match(await textOf(page, '.issue[data-issue-id="i1"]'), /本文1\n詳しく/);
      assert.match(await textOf(page, '#s-issues'), /Issue は、GitHub に登録する課題の記録です/, '専門用語の説明');
    });
  });

  test('REQ-013 課題がないときは、そのことが出る', async () => {
    await withScreen({ state: finishedState() }, async ({ page }) => {
      assert.match(await textOf(page, '#s-issues'), /課題は見つかりませんでした/);
    });
  });
});

// ---- 起票の承認 ----------------------------------------------------------------------------------------------

describe('Issue の起票の承認（REQ-014）', () => {
  const issue = (id, state, extra = {}) => ({ id, title: `案 ${id}`, body: '本文', source: 'mechanical', filing: { state, url: null, reason: null, ...extra } });

  test('REQ-014 承認ボタンを押すと、押せなくなり、その案の番号で1回だけ中心の処理に届く（ほかの案には効かない）', async () => {
    const state = finishedState();
    state.run.issues = [issue('i1', 'none'), issue('i2', 'none')];
    await withScreen({ state }, async ({ page, core }) => {
      core.hooks.fileIssue = (id, c) =>
        c.set((s) => {
          s.run.issues.find((i) => i.id === id).filing = { state: 'filed', url: 'https://github.com/o/r/issues/7', reason: null };
          return s;
        });
      const first = page.locator('.issue[data-issue-id="i1"] .approve');
      const second = page.locator('.issue[data-issue-id="i2"] .approve');
      assert.equal(await first.isEnabled(), true);
      await first.click({ clickCount: 2, delay: 0 });
      assert.equal(await first.isDisabled(), true, '押したらすぐ押せなくなる');
      await until(page, () => document.querySelector('.issue[data-issue-id="i1"] a[href^="https://github.com/"]'));
      assert.deepEqual(core.callsOf('fileIssue').map((c) => c.args[0]), ['i1'], '2回押しても1回、承認していない案には届かない');
      assert.equal(await page.locator('.issue[data-issue-id="i1"] .approve').isDisabled(), true, '起票済みは押せない');
      assert.match(await textOf(page, '.issue[data-issue-id="i1"]'), /起票済み/);
      assert.equal(await page.locator('.issue[data-issue-id="i1"] a').getAttribute('href'), 'https://github.com/o/r/issues/7');
      assert.equal(await second.isEnabled(), true, '承認していない案は、押せるまま');
      assert.match(await textOf(page, '.issue[data-issue-id="i2"]'), /未起票/);
    });
  });

  test('REQ-014 起票の状態（未起票・起票中・起票済み・失敗・分からない）が文字で出て、押せるかが決まる', async () => {
    const state = finishedState();
    state.run.issues = [
      issue('i1', 'none'),
      issue('i2', 'filing'),
      issue('i3', 'filed', { url: 'https://github.com/o/r/issues/2' }),
      issue('i4', 'failed', { reason: '時間切れです。' }),
      issue('i5', 'unknown', { reason: '起票できたか分かりません。' }),
    ];
    await withScreen({ state }, async ({ page }) => {
      const row = async (id) => ({
        text: await textOf(page, `.issue[data-issue-id="${id}"]`),
        enabled: await page.locator(`.issue[data-issue-id="${id}"] .approve`).isEnabled(),
        button: await textOf(page, `.issue[data-issue-id="${id}"] .approve`),
      });
      assert.deepEqual([(await row('i1')).enabled, (await row('i1')).button], [true, '承認して起票する']);
      assert.deepEqual([(await row('i2')).enabled, (await row('i2')).button], [false, '起票しています…']);
      assert.match((await row('i2')).text, /起票中/);
      assert.deepEqual([(await row('i3')).enabled, (await row('i3')).button], [false, '起票済み']);
      const failed = await row('i4');
      assert.match(failed.text, /起票に失敗/);
      assert.match(failed.text, /時間切れです。/);
      assert.deepEqual([failed.enabled, failed.button], [true, 'もう一度承認して起票する']);
      const unknown = await row('i5');
      assert.match(unknown.text, /起票したか分かりません/);
      assert.deepEqual([unknown.enabled, unknown.button], [true, 'もう一度承認して起票する']);
    });
  });

  test('REQ-014 起票できないときは、承認ボタンが押せず、起票できるようにする手順が出る（案は並ぶ）', async () => {
    const state = finishedState();
    state.run.issues = [issue('i1', 'none'), issue('i2', 'failed', { reason: '前の理由' })];
    state.run.canFile = { ok: false, reason: 'このプラグインの設定ファイル（plugin.json）に repository が書かれていません。', code: 'no_repository', steps: FILE_STEPS };
    await withScreen({ state }, async ({ page, core }) => {
      assert.equal(await page.locator('.issue').count(), 2, '案は並ぶ');
      for (const id of ['i1', 'i2']) assert.equal(await page.locator(`.issue[data-issue-id="${id}"] .approve`).isDisabled(), true);
      const box = await textOf(page, '#cannot-file');
      assert.match(box, /今は Issue を起票できません/);
      assert.match(box, /repository が書かれていません。/);
      assert.match(box, /起票できるようにする手順：/);
      assert.deepEqual(await page.locator('#cannot-file ol li').allInnerTexts(), FILE_STEPS, '中心の処理が決めた手順をそのまま出す');
      assert.equal(core.callsOf('fileIssue').length, 0);
      // 中心の処理が手順を決めているときは、その手順を出す
      core.set((s) => {
        s.run.canFile = { ok: false, reason: 'repository がありません。', steps: ['リポジトリを書く。', 'アンインストールしてから、もう一度インストールする。'] };
        return s;
      });
      await until(page, () => document.getElementById('cannot-file')?.innerText.includes('リポジトリを書く。'));
      assert.deepEqual(await page.locator('#cannot-file ol li').allInnerTexts(), ['リポジトリを書く。', 'アンインストールしてから、もう一度インストールする。']);
      // 起票できるようになったら、手順は消えてボタンが押せる
      core.set((s) => {
        s.run.canFile = { ok: true, reason: null, steps: [] };
        return s;
      });
      await until(page, () => !document.getElementById('cannot-file'));
      assert.equal(await page.locator('.issue[data-issue-id="i1"] .approve').isEnabled(), true);
      // 起票できるかを確かめている間は、手順がない。理由だけを出し、手順の見出しは出さない
      core.set((s) => {
        s.run.canFile = { ok: false, reason: '起票できるかを確かめています。', code: 'checking', steps: [] };
        return s;
      });
      await until(page, () => document.getElementById('cannot-file'));
      assert.match(await textOf(page, '#cannot-file'), /起票できるかを確かめています。/);
      assert.ok(!(await textOf(page, '#cannot-file')).includes('手順'));
      assert.equal(await page.locator('#cannot-file ol').count(), 0);
      assert.equal(await page.locator('.issue[data-issue-id="i1"] .approve').isDisabled(), true);
    });
  });

  test('REQ-014 中心の処理が起票を断ると、その文が出て、もう一度承認できる', async () => {
    const state = finishedState();
    state.run.issues = [issue('i1', 'none')];
    await withScreen({ state, allowErrors: [HTTP_400] }, async ({ page, core }) => {
      core.refusals.fileIssue = new Error('この案は、もう起票されています。');
      await page.click('.approve');
      await until(page, () => document.querySelector('.issue .alert-error'));
      assert.match(await textOf(page, '.issue .alert-error'), /この案は、もう起票されています。/);
      await until(page, () => !document.querySelector('.approve').disabled);
      delete core.refusals.fileIssue;
      await page.click('.approve');
      await eventually(() => core.callsOf('fileIssue').length === 2, '2回目の承認が届かない');
    });
  });

  test('REQ-014 起票した Issue の場所が http(s) でなければ、リンクにしない', async () => {
    const state = finishedState();
    state.run.issues = [issue('i1', 'filed', { url: 'javascript:window.__pwned=1' }), issue('i2', 'filed', { url: 'https://github.com/o/r/issues/9' })];
    await withScreen({ state }, async ({ page }) => {
      assert.equal(await page.locator('.issue[data-issue-id="i1"] a').count(), 0);
      assert.equal(await page.locator('.issue[data-issue-id="i2"] a').getAttribute('rel'), 'noopener noreferrer');
      assert.equal(await page.locator('.issue[data-issue-id="i2"] a').getAttribute('target'), '_blank');
    });
  });
});

// ---- 前の結果 -------------------------------------------------------------------------------------------------

describe('準備中に開ける前の結果（REQ-008、REQ-012、REQ-014）', () => {
  test('REQ-008 途中で切れた実行の後に画面を開くと、「途中で終わった（途中で切れた）」と出る', async () => {
    const state = prepState({ previous: { endReason: { kind: 'aborted', detail: 'cut_off', unstoppable: false }, summary: null, finishedAt: Date.UTC(2026, 9, 21, 12, 0, 0), issues: [] } });
    await withScreen({ state }, async ({ page }) => {
      assert.equal(await page.locator('#s-previous > details').getAttribute('open'), null, '最初は畳まれている');
      assert.ok(!(await visibleText(page)).includes('途中で終わった（途中で切れた）'));
      await page.click('#s-previous summary');
      assert.match(await textOf(page, '#s-previous'), /終わった理由：\s*途中で終わった（途中で切れた）/);
      assert.match(await textOf(page, '#s-previous'), /終わった時刻：\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d/);
    });
  });

  test('REQ-014 終わった後に準備中に戻っても、前の結果と、承認していない Issue の案を開け、承認できる', async () => {
    const state = prepState({
      previous: {
        endReason: { kind: 'all_passed', detail: null, unstoppable: false },
        summary: '前回のまとめです。',
        finishedAt: Date.now(),
        issues: [
          { id: 'p1', title: '前の案', body: '本文', source: 'mechanical', filing: { state: 'none', url: null, reason: null } },
          { id: 'p2', title: '起票済みの前の案', body: '本文', source: 'orchestrator', filing: { state: 'filed', url: 'https://github.com/o/r/issues/5', reason: null } },
        ],
      },
    });
    await withScreen({ state }, async ({ page, core }) => {
      await page.click('#s-previous summary');
      const text = await textOf(page, '#s-previous');
      assert.match(text, /評価基準をすべて満たした/);
      assert.match(text, /前回のまとめです。/);
      assert.equal(await page.locator('.issue[data-issue-id="p1"] .approve').isEnabled(), true);
      assert.equal(await page.locator('.issue[data-issue-id="p2"] .approve').isDisabled(), true);
      await page.click('.issue[data-issue-id="p1"] .approve');
      await eventually(() => core.callsOf('fileIssue').length === 1, '承認が届かない');
      assert.deepEqual(core.callsOf('fileIssue')[0].args, ['p1']);
      assert.equal(await page.locator('#s-previous > details').getAttribute('open'), '', '操作の後も開いたまま');
    });
  });

  test('REQ-012 前の結果がないときは、その欄を出さない。実行が始まると隠れる', async () => {
    await withScreen({ state: prepState() }, async ({ page, core }) => {
      assert.equal(await page.locator('#s-previous').isHidden(), true);
      core.set(richPrep());
      await until(page, () => !document.getElementById('s-previous').hidden);
      core.set(runState('do'));
      await until(page, () => document.getElementById('s-previous').hidden);
    });
  });
});

// ---- 開始前の設定 ----------------------------------------------------------------------------------------------

describe('開始前の設定（REQ-005、REQ-007、REQ-031）', () => {
  test('REQ-007 役割ごとのモデルの初めの値は、統括と検証が思考力の高いモデル、作業が費用の低いモデルで、繰り返しの上限の既定がある', async () => {
    await withScreen({ state: prepState() }, async ({ page }) => {
      assert.equal(await page.inputValue('#setting-model-orchestrator'), 'claude-opus-5-5');
      assert.equal(await page.inputValue('#setting-model-worker'), 'claude-haiku-5-5');
      assert.equal(await page.inputValue('#setting-model-verifier'), 'claude-opus-5-5');
      assert.equal(await page.inputValue('#setting-maxIterations'), '3');
      for (const role of ['orchestrator', 'worker', 'verifier']) {
        const options = await page.locator(`#setting-model-${role} option`).evaluateAll((els) => els.map((el) => [el.value, el.textContent]));
        assert.deepEqual(options, MODELS.map((m) => [m.id, m.name]), '選べるモデルの一覧から出る');
      }
      assert.match(await textOf(page, '#s-setup'), /統括エージェントのモデル/);
      assert.match(await textOf(page, '#s-setup'), /最初は、統括と検証に思考力の高いモデル、作業に費用の低いモデルが選ばれています/);
      assert.equal(await textOf(page, '#override-notice'), '実行が終わると、このチャットでほかのエージェントに設定したモデルの指定も消えます。', '上書きを外すと、ほかも消えること（中心の処理の文をそのまま出す）');
    });
  });

  test('REQ-007 モデルの指定が消えることの注意は、中心の処理の文だけを出す（画面は文を足さない）', async () => {
    const state = prepState();
    state.setup.overrideNotice = null;
    await withScreen({ state }, async ({ page, core }) => {
      assert.equal(await page.locator('#override-notice').count(), 0, '文がなければ出さない');
      assert.ok(!(await visibleText(page)).includes('モデルの指定'));
      core.set((s) => {
        s.setup.overrideNotice = '試験用の注意の文です。';
        return s;
      });
      await until(page, () => document.getElementById('override-notice'));
      assert.equal(await textOf(page, '#override-notice'), '試験用の注意の文です。');
    });
  });

  test('REQ-031 作業ごとの設定（文字・数・選択・チェック・場所）が、定義のとおりに出る', async () => {
    await withScreen({ state: prepState() }, async ({ page }) => {
      assert.match(await textOf(page, '#task-settings'), /対象の週\s*（必須）/);
      assert.match(await textOf(page, '#task-settings'), /例：2026-W42/, '説明');
      assert.equal(await page.getAttribute('#setting-week', 'type'), 'text');
      assert.equal(await page.getAttribute('#setting-items', 'type'), 'number');
      assert.equal(await page.inputValue('#setting-items'), '5');
      assert.equal(await page.evaluate(() => document.getElementById('setting-tone').tagName), 'SELECT');
      assert.deepEqual(await page.locator('#setting-tone option').evaluateAll((els) => els.map((el) => el.value)), ['です・ます調', 'だ・である調']);
      assert.equal(await page.inputValue('#setting-tone'), 'です・ます調');
      assert.equal(await page.getAttribute('#setting-attach', 'type'), 'checkbox');
      assert.equal(await page.isChecked('#setting-attach'), false);
      assert.equal(await page.getAttribute('#setting-folder', 'type'), 'text');
      assert.match(await page.getAttribute('#setting-folder', 'placeholder'), /場所/);
      // 見出しと入力欄が結び付いている（見出しを押すと入力欄に移る）
      assert.equal(await page.locator('label[for="setting-week"]').count(), 1);
    });
  });

  test('REQ-007 設定を変えて開始すると、変えた設定が中心の処理に1回だけ届き、開始ボタンはすぐ押せなくなる', async () => {
    await withScreen({ state: prepState() }, async ({ page, core }) => {
      core.hooks.start = (settings, c) => c.set(runState('plan'));
      await page.selectOption('#setting-model-orchestrator', 'gpt-6-luna');
      await page.selectOption('#setting-model-worker', 'claude-opus-5-5');
      await page.selectOption('#setting-model-verifier', 'claude-haiku-5-5');
      await page.fill('#setting-maxIterations', '2');
      await page.fill('#setting-week', '2026-W43');
      await page.fill('#setting-items', '7');
      await page.selectOption('#setting-tone', 'だ・である調');
      await page.check('#setting-attach');
      await page.fill('#setting-folder', '/tmp/out');
      await page.click('#start', { clickCount: 2, delay: 0 });
      assert.equal(await page.locator('#start').isDisabled().catch(() => true), true, '押したらすぐ押せなくなる');
      await until(page, () => document.querySelector('#s-monitor') && !document.getElementById('s-monitor').hidden);
      const calls = core.callsOf('start');
      assert.equal(calls.length, 1, '2回押しても1回');
      assert.deepEqual(calls[0].args[0], {
        models: { orchestrator: 'gpt-6-luna', worker: 'claude-opus-5-5', verifier: 'claude-haiku-5-5' },
        maxIterations: 2,
        task: { week: '2026-W43', items: 7, tone: 'だ・である調', attach: true, folder: '/tmp/out' },
      });
      assert.equal(await page.locator('#s-setup').isHidden(), true, '開始後は設定の欄を隠す');
      assert.equal(await textOf(page, '#run-status'), '実行中');
    });
  });

  test('REQ-031 設定を変えずに開始すると、定義の初めの値で開始される', async () => {
    await withScreen({ state: prepState() }, async ({ page, core }) => {
      await page.fill('#setting-week', '2026-W42');
      await page.click('#start');
      await eventually(() => core.callsOf('start').length === 1, '開始が届かない');
      assert.deepEqual(core.callsOf('start')[0].args[0], {
        models: { orchestrator: 'claude-opus-5-5', worker: 'claude-haiku-5-5', verifier: 'claude-opus-5-5' },
        maxIterations: 3,
        task: { week: '2026-W42', items: 5, tone: 'です・ます調', attach: false, folder: '' },
      });
    });
  });

  test('REQ-005 必須の項目が空、繰り返しの上限が1未満のときは、送らずに、直す点を出す', async () => {
    await withScreen({ state: prepState() }, async ({ page, core }) => {
      await page.click('#start');
      assert.match(await textOf(page, '#start-message'), /「対象の週」を入力してください。/);
      assert.equal(await page.locator('#start').isDisabled(), false);
      await page.fill('#setting-week', '2026-W42');
      for (const bad of ['0', '', '1.5', '-2']) {
        await page.fill('#setting-maxIterations', bad);
        await page.click('#start');
        assert.match(await textOf(page, '#start-message'), /繰り返しの上限の回数は、1以上の整数で入力してください。/, `上限が「${bad}」`);
      }
      assert.equal(core.callsOf('start').length, 0, '送られていない');
    });
  });

  test('REQ-007 中心の処理が開始を断ると、その文が出て、設定は残り、もう一度開始できる', async () => {
    await withScreen({ state: prepState(), allowErrors: [HTTP_400] }, async ({ page, core }) => {
      core.refusals.start = new Error('選んだモデルが使えません。別のモデルを選んでください。');
      await page.fill('#setting-week', '2026-W42');
      await page.selectOption('#setting-model-worker', 'gpt-6-luna');
      await page.click('#start');
      await until(page, () => !document.getElementById('start-message').hidden);
      assert.match(await textOf(page, '#start-message'), /選んだモデルが使えません/);
      await until(page, () => !document.getElementById('start').disabled);
      assert.equal(await page.inputValue('#setting-week'), '2026-W42', '入力は残る');
      assert.equal(await page.inputValue('#setting-model-worker'), 'gpt-6-luna');
      delete core.refusals.start;
      await page.click('#start');
      await eventually(() => core.callsOf('start').length === 2, '2回目の開始が届かない');
      assert.equal(core.callsOf('start')[1].args[0].models.worker, 'gpt-6-luna');
    });
  });

  test('REQ-007 開始できずに準備中に戻ったときは、その理由が出る（画面を開き直しても出る）。もう一度開始できる', async () => {
    const state = prepState({ startError: { message: '選んだモデルが使えませんでした。起動したかは分かりません。もう一度開始できます。', unknownLaunch: true } });
    await withScreen({ state }, async ({ page, core, open }) => {
      assert.match(await textOf(page, '#start-message'), /選んだモデルが使えませんでした。起動したかは分かりません。もう一度開始できます。/);
      assert.equal(await page.locator('#start').isEnabled(), true);
      await open();
      assert.match(await textOf(page, '#start-message'), /選んだモデルが使えませんでした/);
      core.set((s) => ({ ...s, startError: null }));
      await until(page, () => document.getElementById('start-message').hidden);
    });
  });

  test('REQ-008 入力している途中で状態の版が変わっても、入力は消えない', async () => {
    await withScreen({ state: prepState() }, async ({ page, core }) => {
      await page.fill('#setting-week', '入力の途中');
      await page.selectOption('#setting-model-verifier', 'gpt-6-luna');
      core.set((s) => {
        s.notices = ['別の注意'];
        return s;
      });
      await until(page, () => document.body.innerText.includes('別の注意'));
      assert.equal(await page.inputValue('#setting-week'), '入力の途中');
      // 設定の欄そのものが作り直されても（選べるモデルが増えたとき）、入力は残る
      core.set((s) => {
        s.setup.models = [...s.setup.models, { id: 'new-model', name: '新しいモデル' }];
        return s;
      });
      await until(page, () => document.querySelector('#setting-model-worker option[value="new-model"]'));
      assert.equal(await page.inputValue('#setting-week'), '入力の途中');
      assert.equal(await page.inputValue('#setting-model-verifier'), 'gpt-6-luna');
    });
  });

  test('REQ-007 選べるモデルの一覧に初めの値がなくても、初めの値は選ばれている', async () => {
    const state = prepState();
    state.setup.models = [];
    await withScreen({ state }, async ({ page }) => {
      assert.equal(await page.inputValue('#setting-model-orchestrator'), 'claude-opus-5-5');
      assert.equal(await page.inputValue('#setting-model-worker'), 'claude-haiku-5-5');
    });
  });

  test('REQ-007 Auto のときは「Auto のため、役割ごとのモデルが効かないことがあります」と出て、役割ごとのモデルは選べる', async () => {
    const state = prepState();
    state.setup.isAuto = true;
    await withScreen({ state }, async ({ page, core }) => {
      assert.match(await textOf(page, '#auto-notice'), /Auto のため、役割ごとのモデルが効かないことがあります/);
      await page.selectOption('#setting-model-worker', 'gpt-6-luna');
      await page.fill('#setting-week', 'w');
      await page.click('#start');
      await eventually(() => core.callsOf('start').length === 1, '開始が届かない');
      assert.equal(core.callsOf('start')[0].args[0].models.worker, 'gpt-6-luna');
    });
    await withScreen({ state: prepState() }, async ({ page }) => {
      assert.equal(await page.locator('#auto-notice').count(), 0, 'Auto でなければ出ない');
    });
  });

  test('REQ-007 Auto のとき、エージェントごとに実際に動いたモデルが出て、選んだモデルと違えばそのことが出る', async () => {
    const state = runState('do');
    state.run.isAuto = true;
    state.run.agents[1].actualModel = 'gpt-6-luna';
    await withScreen({ state }, async ({ page, core }) => {
      assert.match(await textOf(page, '#auto-notice'), /Auto のため、役割ごとのモデルが効かないことがあります/);
      const worker = await textOf(page, '.agent[data-slot="worker"]');
      assert.match(worker, /選んだモデル\s*claude-haiku-5-5/);
      assert.match(worker, /実際に動いたモデル\s*gpt-6-luna/);
      assert.match(worker, /選んだモデルと違います/);
      const orchestrator = await textOf(page, '.agent[data-slot="orchestrator"]');
      assert.match(orchestrator, /実際に動いたモデル\s*claude-opus-5-5/);
      assert.ok(!orchestrator.includes('選んだモデルと違います'));
      assert.match(await textOf(page, '.agent[data-slot="verifier"]'), /実際に動いたモデル\s*（まだ分かりません）/);
      core.set((s) => {
        s.run.isAuto = false;
        return s;
      });
      await until(page, () => !document.getElementById('auto-notice'));
    });
  });

  test('REQ-005 設定 → 開始 → 監視 → 結果 → 起票の承認が、画面だけでできる', async () => {
    await withScreen({ state: prepState() }, async ({ page, core }) => {
      core.hooks.start = (settings, c) => c.set(runState('plan'));
      core.hooks.fileIssue = (id, c) =>
        c.set((s) => {
          s.run.issues.find((i) => i.id === id).filing = { state: 'filed', url: 'https://github.com/o/r/issues/1', reason: null };
          return s;
        });
      await page.fill('#setting-week', '2026-W42');
      await page.click('#start');
      await until(page, () => document.querySelector('#phases [data-active="true"]'));
      core.set((s) => {
        s.run.phase = 'do';
        s.run.agents[1].status = 'running';
        return s;
      });
      await until(page, () => document.querySelector('#phases [data-active="true"]')?.dataset.phase === 'do');
      core.set(() => {
        const done = finishedState();
        done.run.issues = [{ id: 'i1', title: '案', body: '本文', source: 'mechanical', filing: { state: 'none', url: null, reason: null } }];
        return done;
      });
      await until(page, () => document.querySelector('.approve'));
      await page.click('.approve');
      await until(page, () => document.querySelector('.issue a[href^="https://github.com/"]'));
      assert.deepEqual(core.callsOf('fileIssue').map((c) => c.args[0]), ['i1']);
    });
  });
});

// ---- 作業ごとの表示 ---------------------------------------------------------------------------------------------

describe('作業ごとの表示（REQ-031）', () => {
  const displays = {
    draft: '下書きの本文',
    meta: { 週: '2026-W42', 件数: 5 },
    stats: { columns: ['項目', '件数'], rows: [['A', 1], ['B', 2]] },
    progress: { value: 40, max: 100 },
    chart: { fileId: 'f1', name: 'chart.png' },
    report: { fileId: 'f2', name: '週報.md' },
  };

  test('REQ-031 実行中の表示（文章・値の一覧・進み具合・画像）が、定義の見出しつきで出る。終わった後の表示は出ない', async () => {
    const state = runState('do');
    state.run.displays = displays;
    await withScreen({ state }, async ({ page }) => {
      const keys = await page.locator('#s-displays .display').evaluateAll((els) => els.map((el) => el.dataset.key));
      assert.deepEqual(keys, ['draft', 'meta', 'progress', 'chart'], '定義の順で、実行中と両方の表示だけ');
      assert.match(await textOf(page, '.display[data-key="draft"]'), /下書き[\s\S]*下書きの本文/);
      assert.match(await textOf(page, '.display[data-key="meta"]'), /概要[\s\S]*週\s*2026-W42[\s\S]*件数\s*5/);
      const bar = page.locator('.display[data-key="progress"] progress');
      assert.equal(await bar.getAttribute('value'), '40');
      assert.equal(await bar.getAttribute('max'), '100');
      assert.match(await textOf(page, '.display[data-key="progress"]'), /40%/);
      const image = page.locator('.display[data-key="chart"] img');
      await until(page, () => document.querySelector('.display[data-key="chart"] img')?.complete);
      assert.deepEqual(await image.evaluate((el) => [el.naturalWidth, el.naturalHeight]), [40, 20], '画像が表示される');
      assert.equal(await image.getAttribute('alt'), 'chart.png');
    });
  });

  test('REQ-031 終わった後の表示（表・ファイルへのリンク）が出て、実行中だけの表示は出ない', async () => {
    const state = finishedState();
    state.run.displays = displays;
    await withScreen({ state }, async ({ page, app }) => {
      const keys = await page.locator('#s-displays .display').evaluateAll((els) => els.map((el) => el.dataset.key));
      assert.deepEqual(keys, ['meta', 'stats', 'chart', 'report']);
      const table = page.locator('.display[data-key="stats"] table');
      assert.deepEqual(await table.locator('th').allInnerTexts(), ['項目', '件数']);
      assert.deepEqual(await table.locator('tbody tr').evaluateAll((rows) => rows.map((r) => [...r.children].map((c) => c.textContent))), [['A', '1'], ['B', '2']]);
      const link = page.locator('.display[data-key="report"] a');
      assert.match(await link.innerText(), /週報\.md/);
      assert.equal(await link.getAttribute('download'), '週報.md');
      const response = await page.request.get(new URL(await link.getAttribute('href'), app.url).toString());
      assert.equal(response.status(), 200);
      assert.match(response.headers()['content-disposition'], /^attachment/, 'ファイルはダウンロードの形');
      assert.equal(response.headers()['content-security-policy'], 'sandbox');
    });
  });

  test('REQ-031 値がまだない表示は「まだありません」、形の合わない値は「表示できない形の値です」と出る', async () => {
    const state = runState('do');
    state.run.displays = { meta: 'これは値の一覧ではない', progress: 'abc', chart: { name: '番号なし' } };
    await withScreen({ state }, async ({ page }) => {
      assert.match(await textOf(page, '.display[data-key="draft"]'), /まだありません/);
      assert.match(await textOf(page, '.display[data-key="meta"]'), /表示できない形の値です/);
      assert.match(await textOf(page, '.display[data-key="progress"]'), /表示できない形の値です/);
      assert.match(await textOf(page, '.display[data-key="chart"]'), /表示できない形の値です/);
    });
  });

  test('REQ-031 作業の定義にない表示の値も、文字で出る。定義が読めないときも画面は開く', async () => {
    const state = runState('do');
    state.run.displays = { extra: '定義にない値' };
    await withScreen({ state, task: { name: 'x' } }, async ({ page }) => {
      assert.match(await textOf(page, '.display[data-key="extra"]'), /extra[\s\S]*定義にない値/);
    });
  });

  test('REQ-030 長い文章の表示は最初は畳まれ、押すと開く。短い文章は畳まない', async () => {
    const long = '長い文章が続きます。'.repeat(60);
    const state = runState('do');
    state.run.displays = { draft: long };
    await withScreen({ state }, async ({ page, core }) => {
      const fold = page.locator('.display[data-key="draft"] details');
      assert.equal(await fold.count(), 1);
      assert.equal(await fold.getAttribute('open'), null);
      assert.ok(!(await textOf(page, '.display[data-key="draft"]')).includes('長い文章が続きます。長い'), '畳まれた中身は見えない');
      await fold.locator('summary').click();
      assert.ok((await textOf(page, '.display[data-key="draft"]')).includes(long.slice(0, 60)));
      core.set((s) => {
        s.run.displays = { draft: '短い文章' };
        return s;
      });
      await until(page, () => document.querySelector('.display[data-key="draft"]')?.innerText.includes('短い文章'));
      assert.equal(await page.locator('.display[data-key="draft"] details').count(), 0);
    });
  });
});

// ---- 文字として出す（HTML を入れても動かない） ------------------------------------------------------------------------

describe('エージェントや記録から来た文字（REQ-005、REQ-006）', () => {
  function evilState(base) {
    const e = (key) => `${EVIL[key]} ${key}`;
    const state = base;
    state.plugin.title = `題 ${e('img')}`;
    state.notices = [e('script')];
    if (state.run) {
      state.run.agents = state.run.agents.map((a, i) => ({ ...a, task: e('img'), replySummary: e('svg'), label: i === 1 ? e('anchor') : a.label }));
      state.run.iterations = [{ n: 1, criteria: [{ id: 'C-01', text: e('img'), fromUser: true }], plan: e('script'), verdicts: [{ criterionId: 'C-01', pass: false, note: e('svg') }], agentIds: ['ag-work'] }];
      state.run.displays = { draft: e('script'), meta: { [e('img')]: e('anchor') }, stats: { columns: [e('img')], rows: [[e('script')]] }, progress: { value: 1, max: 2, label: e('img') }, chart: { fileId: 'f1', name: e('img') }, report: { fileId: 'f2', name: e('anchor') } };
      state.run.summary = e('script');
      state.run.waits = [{ requestId: 'r1', slot: 'worker', kind: 'permission', detail: { permissionKind: 'shell', toolKind: e('img'), command: e('script'), paths: [e('img')], urls: [e('svg')], warning: e('anchor'), sandboxBypass: true } }, { requestId: 'r2', slot: 'verifier', kind: 'question', detail: { question: e('script') } }];
      state.run.issues = [{ id: 'i1', title: e('img'), body: e('script'), source: 'mechanical', filing: { state: 'failed', url: null, reason: e('svg') } }];
      state.run.unstopped = [{ agentId: 'ag-work', role: 'worker', howTo: e('script') }];
      state.run.endReason = state.run.status === 'finished' ? { kind: 'aborted', detail: e('img'), unstoppable: true } : null;
      state.run.canFile = { ok: false, reason: e('svg'), steps: [e('script')] };
    }
    state.setup.models = [{ id: 'm1', name: e('img') }, ...state.setup.models];
    state.setup.taskSettings = [{ key: 'week', label: e('img'), type: 'text', default: e('script'), required: true, help: e('svg'), options: [] }];
    return state;
  }

  async function assertNoInjection(page) {
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.__pwned), undefined, 'スクリプトが動いた');
    const found = await page.evaluate(() => ({
      scripts: document.querySelectorAll('script').length,
      images: [...document.querySelectorAll('img')].filter((img) => !img.closest('.display-image-ok')).map((img) => img.getAttribute('src')),
      svgs: document.querySelectorAll('svg').length,
      handlers: [...document.querySelectorAll('*')].filter((el) => [...el.attributes].some((a) => a.name.startsWith('on'))).length,
      scriptLinks: [...document.querySelectorAll('a')].filter((a) => /^javascript:/i.test(a.getAttribute('href') ?? '')).length,
      brokenImages: document.querySelectorAll('img[src="x"]').length,
    }));
    assert.equal(found.scripts, 2, '画面の2つのスクリプトのほかに、スクリプトの要素が増えていない');
    assert.equal(found.svgs, 0);
    assert.equal(found.handlers, 0);
    assert.equal(found.scriptLinks, 0);
    assert.equal(found.brokenImages, 0);
    for (const src of found.images) assert.match(src, /^\/api\/files\//, '画像は、窓口のものだけ');
  }

  test('REQ-006 返事・表示の値・Issue の案・確認の待ちなどに HTML やスクリプトを入れても、文字として出るだけで動かない（実行中）', async () => {
    await withScreen({ state: evilState(richRunning()), task: ALL_DISPLAYS_TASK }, async ({ page, core }) => {
      core.replies['ag-work'] = `${EVIL.script}\n${EVIL.img}`;
      await page.locator('.agent[data-slot="worker"] details summary').click();
      await until(page, () => document.querySelector('.agent[data-slot="worker"] .reply-full')?.innerText.includes('<script>'));
      const text = await visibleText(page);
      for (const literal of [EVIL.img, EVIL.script, EVIL.svg]) assert.ok(text.includes(literal), `文字としてそのまま出る：${literal}`);
      assert.equal(await page.locator('.agent[data-slot="worker"] .reply-full').innerText(), `${EVIL.script}\n${EVIL.img}`);
      await assertNoInjection(page);
    });
  });

  test('REQ-006 同じく、終わった後の画面と、準備中の画面でも動かない', async () => {
    await withScreen({ state: evilState(richFinished()), task: ALL_DISPLAYS_TASK }, async ({ page, core }) => {
      assert.ok((await visibleText(page)).includes(EVIL.script));
      await assertNoInjection(page);
      const prep = evilState(richPrep());
      prep.previous.summary = `${EVIL.script} ${EVIL.img}`;
      prep.previous.issues[0].title = EVIL.svg;
      core.set(prep);
      await until(page, () => !document.getElementById('s-setup').hidden);
      await page.click('#s-previous summary');
      assert.ok((await visibleText(page)).includes(EVIL.svg));
      await assertNoInjection(page);
    });
  });

  test('REQ-006 画面の応答の CSP が、インラインのスクリプトを止める（画面の側に穴があっても動かない）', async () => {
    // CSP が止めたときのブラウザーのメッセージは、版で文が違う（古い Chromium は「Refused to execute inline …」、
    // 新しい Chromium は「Executing inline script / event handler violates …」）。どちらも、止めたという知らせなので見逃す
    const blocked = [/Refused to execute inline/, /Executing inline (script|event handler) violates the following Content Security Policy directive/];
    await withScreen({ state: runState('do'), allowErrors: blocked }, async ({ page, app }) => {
      const policy = (await page.request.get(app.url)).headers()['content-security-policy'];
      assert.match(policy, /script-src 'self'/);
      // 実際にインラインのスクリプトを足そうとしても、動かない
      const violations = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const seen = [];
            document.addEventListener('securitypolicyviolation', (event) => seen.push(event.violatedDirective));
            const script = document.createElement('script');
            script.textContent = 'window.__pwned = 1';
            document.body.appendChild(script);
            const img = document.createElement('div');
            img.setAttribute('onclick', 'window.__pwned = 2');
            document.body.appendChild(img);
            img.click();
            setTimeout(() => resolve(seen), 200);
          }),
      );
      assert.ok(violations.some((v) => v.startsWith('script-src')), `CSP が止めた：${violations}`);
      assert.equal(await page.evaluate(() => window.__pwned), undefined);
    });
  });
});

// ---- 見た目 ------------------------------------------------------------------------------------------------------------

describe('見た目（REQ-030）', () => {
  test('REQ-030 フェーズとエージェントの状態が、画面を開いてすぐ、スクロールせずに見える（ノートパソコンから大きな画面まで）', async () => {
    const state = runState('do');
    state.run.agents.splice(2, 0, { ...state.run.agents[1], slot: 'worker-b', label: '集計をする係', agentId: 'ag-work-b' });
    state.run.waits = [{ requestId: 'r1', slot: 'worker', kind: 'permission', detail: { permissionKind: 'shell', command: LONG_COMMAND, warning: '注意', sandboxBypass: true } }];
    state.run.isAuto = true;
    for (const viewport of [{ width: 1024, height: 640 }, { width: 1280, height: 720 }, { width: 1440, height: 800 }, { width: 1920, height: 1080 }]) {
      await withScreen({ state, viewport }, async ({ page }) => {
        const rects = await page.evaluate(() => {
          const box = (el) => {
            const r = el.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
          };
          return {
            scrollY: window.scrollY,
            height: window.innerHeight,
            phases: box(document.getElementById('phases')),
            cards: [...document.querySelectorAll('#agents .agent')].map((el) => ({ ...box(el), status: box(el.querySelector('.agent-status')), text: el.querySelector('.agent-status').textContent })),
          };
        });
        const label = `${viewport.width}x${viewport.height}`;
        assert.equal(rects.scrollY, 0);
        assert.ok(rects.phases.top >= 0 && rects.phases.bottom <= rects.height, `${label}：フェーズが見える`);
        assert.equal(rects.cards.length, 4);
        for (const card of rects.cards) {
          assert.ok(card.status.top >= 0 && card.status.bottom <= rects.height, `${label}：エージェントの状態（${card.text}）が見える`);
        }
        await shot(page, `running-${label}`);
      });
    }
  });

  const WIDTHS = [320, 375, 480, 768, 1024, 1280, 1600, 1920];
  const SCREENS = [
    ['実行中', () => richRunning(), ALL_DISPLAYS_TASK],
    ['終了後', () => richFinished(), ALL_DISPLAYS_TASK],
    ['準備中', () => richPrep(), SAMPLE_TASK],
  ];

  for (const [name, makeState, task] of SCREENS) {
    test(`REQ-030 ${name}の画面は、ブラウザーの幅を変えても、重なったり、はみ出したりしない（${WIDTHS[0]}〜${WIDTHS.at(-1)}px）`, async () => {
      await withScreen({ state: makeState(), task, viewport: { width: 1280, height: 800 } }, async ({ page, core }) => {
        if (name === '準備中') await page.click('#s-previous summary');
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: 800 });
          await page.waitForTimeout(100);
          const problems = await page.evaluate(layoutProblems);
          assert.deepEqual(problems, [], `${name} ${width}px`);
          if (width === 375 || width === 1280) await shot(page, `${name}-${width}`);
        }
        void core;
      });
    });

    test(`REQ-030 ${name}の画面は、文字を200%にしても崩れない（幅を半分にした200%の拡大と、文字だけの200%）`, async () => {
      await withScreen({ state: makeState(), task, viewport: { width: 1280, height: 800 } }, async ({ page }) => {
        if (name === '準備中') await page.click('#s-previous summary');
        // 200%の拡大：同じ画面の幅が、見かけ上、半分になる
        await page.setViewportSize({ width: 640, height: 400 });
        assert.deepEqual(await page.evaluate(layoutProblems), [], `${name} 拡大200%（幅640px）`);
        // 文字だけを200%にする
        for (const width of [1280, 640]) {
          await page.setViewportSize({ width, height: 800 });
          await page.evaluate(() => {
            document.documentElement.style.fontSize = '200%';
          });
          assert.deepEqual(await page.evaluate(layoutProblems), [], `${name} 文字200%（幅${width}px）`);
          await shot(page, `${name}-文字200-${width}`);
          await page.evaluate(() => {
            document.documentElement.style.fontSize = '';
          });
        }
        // 文字が実際に大きくなっている（試験が空振りでない）
        await page.evaluate(() => {
          document.documentElement.style.fontSize = '200%';
        });
        assert.ok((await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('h1, h2')).fontSize))) >= 32);
      });
    });

    test(`REQ-030 ${name}の画面の、文字と背景の色の差が 4.5:1 以上（WCAG 2.2）`, async () => {
      await withScreen({ state: makeState(), task, allowErrors: [HTTP_404] }, async ({ page }) => {
        if (name === '準備中') await page.click('#s-previous summary');
        // 畳みを全部開いて、中の文字も調べる
        await openAllFolds(page);
        const { problems, checked } = await page.evaluate(contrastProblems, 4.5);
        assert.ok(checked > 40, `調べた文字の数が少なすぎる（${checked}）`);
        assert.deepEqual(problems, [], `${name} の色の差が足りない文字`);
      });
    });
  }

  test('REQ-030 状態の札（色の違う全種類）と、押せないボタンも、色の差が 4.5:1 以上', async () => {
    const state = richFinished();
    state.run.agents = ['standby', 'running', 'waiting', 'completed', 'failed', 'stopped', 'unstopped'].map((status, i) => ({ ...state.run.agents[0], slot: `s${i}`, role: 'worker', label: `枠${i}`, status, agentId: null }));
    await withScreen({ state, task: ALL_DISPLAYS_TASK }, async ({ page }) => {
      const { problems } = await page.evaluate(contrastProblems, 4.5);
      assert.deepEqual(problems, []);
      assert.ok((await page.locator('button:disabled').count()) > 0, '押せないボタンも含めて調べた');
    });
  });

  test('REQ-030 どの生成プラグインでも、共通部分の画面の構成と見た目が同じである（作業の定義が違っても）', async () => {
    const other = {
      ...SAMPLE_TASK,
      name: '議事録の整理',
      workers: [{ agent: 'worker', label: '議事録をまとめる係' }],
      settings: [{ key: 'file', label: '議事録のファイル', type: 'path', default: '', required: true, help: '', options: [] }],
      displays: [{ key: 'notes', label: 'メモ', type: 'text', when: 'both' }],
    };
    const make = (title, label) => {
      const state = runState('do');
      state.plugin.title = title;
      state.run.agents[1].label = label;
      state.setup.taskSettings = title === other.name ? other.settings : SAMPLE_TASK.settings;
      return state;
    };
    const capture = (screenState, task) =>
      withScreen({ state: screenState, task }, ({ page }) =>
        page.evaluate(() => {
          const skeleton = (root) => [...root.querySelectorAll('*')].map((el) => `${el.tagName}.${el.className}`);
          const style = (selector) => {
            const el = document.querySelector(selector);
            const s = getComputedStyle(el);
            return [s.fontFamily, s.fontSize, s.fontWeight, s.color, s.backgroundColor, s.borderTopColor, s.borderTopWidth, s.borderRadius, s.paddingTop, s.paddingLeft].join('|');
          };
          return {
            head: skeleton(document.getElementById('s-head')).filter((s) => !s.startsWith('H1')),
            monitor: skeleton(document.getElementById('s-monitor')),
            order: [...document.querySelectorAll('.page > *, .main > *')].filter((el) => !el.hidden).map((el) => el.id),
            styles: ['h1', '.top-state .badge', '#stop', '.phase', '.phase.is-active', '.agent', '.agent .badge', '.flow-node', '.panel', 'body'].map(style),
          };
        }),
      );
    const a = await capture(make(SAMPLE_TASK.name, '週報を書く係'), SAMPLE_TASK);
    const b = await capture(make(other.name, other.settings[0].label), other);
    assert.deepEqual(b, a);
    // 準備中の共通部分（モデルと繰り返しの設定）も同じ構成
    const prepOf = (title, settings, task) => {
      const state = prepState();
      state.plugin.title = title;
      state.setup.taskSettings = settings;
      return withScreen({ state, task }, ({ page }) => page.evaluate(() => [...document.querySelectorAll('#s-setup > *')].slice(0, 3).map((el) => `${el.tagName}.${el.className}:${el.querySelector('legend')?.textContent ?? el.textContent}`)));
    };
    assert.deepEqual(await prepOf(other.name, other.settings, other), await prepOf(SAMPLE_TASK.name, SAMPLE_TASK.settings, SAMPLE_TASK));
  });
});

// ---- 平易な日本語 ------------------------------------------------------------------------------------------------------------

describe('分かりやすい表示（REQ-025）', () => {
  const SYMBOLS = [
    'preparing', 'starting', 'running', 'summarizing', 'stopping', 'finished', 'standby', 'waiting', 'completed', 'failed', 'stopped', 'unstopped',
    'all_passed', 'max_iterations', 'user_stopped', 'aborted', 'mechanical', 'orchestrator', 'verifier', 'worker', 'permission', 'question', 'limit',
    'cut_off', 'credit_limit', 'chat_interrupted', 'orchestrator_failed', 'orchestrator_ended', 'retry_limit', 'extension_restarted', 'filing', 'filed', 'unknown', 'none',
    'undefined', 'null', 'NaN', '\\[object',
  ];

  for (const [name, makeState, task] of [
    ['準備中', () => richPrep(), SAMPLE_TASK],
    ['実行中', () => richRunning(), ALL_DISPLAYS_TASK],
    ['終了後', () => richFinished(), ALL_DISPLAYS_TASK],
  ]) {
    test(`REQ-025 ${name}の画面に、状態の記号（英語）や undefined・null が出ない`, async () => {
      await withScreen({ state: makeState(), task, allowErrors: [HTTP_404] }, async ({ page }) => {
        if (name === '準備中') await page.click('#s-previous summary');
        await openAllFolds(page);
        const text = (await visibleText(page)).replace(/claude-[\w.-]+|gpt-[\w.-]+/g, '');
        const found = SYMBOLS.filter((symbol) => new RegExp(`(^|[^A-Za-z_])${symbol}($|[^A-Za-z_])`).test(text));
        assert.deepEqual(found, [], `${name} に出ている記号`);
      });
    });
  }

  test('REQ-025 画面の文に、内部の用語（生成プラグイン・クリエイター）と、説明のない「セッション」が出ない', async () => {
    const withSteps = finishedState();
    withSteps.run.issues = [{ id: 'i1', title: '案', body: '本文', source: 'mechanical', filing: { state: 'none', url: null, reason: null } }];
    withSteps.run.canFile = { ok: false, reason: 'gh でログインしていません。', code: 'not_logged_in', steps: FILE_STEPS };
    const previousWithSteps = richPrep();
    previousWithSteps.previous.canFile = { ok: false, reason: 'gh でログインしていません。', code: 'not_logged_in', steps: FILE_STEPS };
    for (const [name, state] of [['準備中', richPrep()], ['実行中', richRunning()], ['終了後', richFinished()], ['起票の手順', withSteps], ['前の結果の起票の手順', previousWithSteps]]) {
      await withScreen({ state, task: ALL_DISPLAYS_TASK, allowErrors: [HTTP_404] }, async ({ page }) => {
        if (name.startsWith('準備中') || name.startsWith('前の結果')) await page.click('#s-previous summary');
        await openAllFolds(page);
        const text = await visibleText(page);
        assert.doesNotMatch(text, /生成プラグイン|クリエイター|セッション/, `${name}の画面に内部の用語が出ている`);
        assert.ok(!(await page.title()).match(/生成プラグイン|クリエイター|セッション/));
        assert.match(text, /このプラグインの GitHub リポジトリに起票されます/);
        if (name.includes('起票の手順')) assert.deepEqual(await page.locator('#cannot-file ol li').allInnerTexts(), FILE_STEPS);
      });
    }
  });

  test('REQ-025 知らない終わった理由の記号は、そのまま出る（隠さない）。知っている記号だけが日本語になる', async () => {
    await withScreen({ state: finishedState({ kind: 'aborted', detail: 'some_new_reason', unstoppable: false }) }, async ({ page }) => {
      assert.match(await textOf(page, '#end-reason'), /途中で終わった（some_new_reason）/);
    });
  });
});

// ---- 合言葉 ---------------------------------------------------------------------------------------------------------------------

describe('画面を開く（REQ-005、REQ-006）', () => {
  test('REQ-006 合言葉のない URL や、違う合言葉の URL では、画面が開かない', async () => {
    await withScreen({ state: runState('do'), allowErrors: [HTTP_403] }, async ({ page, app }) => {
      const base = `http://127.0.0.1:${app.port}`;
      for (const url of [`${base}/`, `${base}/?k=wrong`, `${base}/api/state`, `${base}/app.js`]) {
        const response = await page.goto(url);
        assert.equal(response.status(), 403, url);
      }
      const ok = await page.goto(app.url);
      assert.equal(ok.status(), 200);
      await until(page, () => document.querySelector('#agents .agent'));
    });
  });

  test('REQ-005 示された URL を開くと画面が表示され、題と状態が出る（開始前から終了後まで、同じ URL で）', async () => {
    await withScreen({ state: prepState() }, async ({ page, core }) => {
      assert.equal(await page.title(), '週報の作成 - Web管理画面');
      assert.equal(await page.locator('h1').innerText(), '週報の作成');
      assert.equal(await textOf(page, '#run-status'), '準備中');
      assert.equal(await page.evaluate(() => document.documentElement.lang), 'ja');
      core.set(finishedState());
      await until(page, () => document.querySelector('#run-status')?.textContent.includes('終了'));
    });
  });
});
