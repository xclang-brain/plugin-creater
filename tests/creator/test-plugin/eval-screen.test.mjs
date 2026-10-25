// 画面の操作（skills/test-plugin/scripts/screen.mjs）の試験。Playwright とそのブラウザーが要る。
// ひな形の本物の画面（ui/app.mjs）を、偽物の中心の処理（ひな形の tests/stage2/ui/fake-core.mjs）につないで、人と同じ流れで操作する。
// 確かめる要件：REQ-041（生成プラグインありのときは、Web管理画面での設定と開始も、人の代わりに試験の仕組みが行う）、REQ-012（終わった理由）、REQ-048（ブラウザー）。
//
// 動かし方：Playwright（ライブラリ）とそのブラウザーが要る。リポジトリには node_modules を置かない。
//   例：NODE_PATH=/path/to/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node --test "tests/creator/test-plugin/eval-screen.test.mjs"
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { TEMPLATE_DIR, cleanupTemp, loadScript, makeTemp } from './helpers.mjs';

// ---- Playwright を見つける（見つからなければ、直し方を示して止まる） -------------------------------

async function loadPlaywright() {
  try {
    const module = await import('playwright');
    const chromium = module.chromium ?? module.default?.chromium;
    if (chromium) return { chromium };
  } catch {
    // 次の探し方へ
  }
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
    'Playwright（ライブラリ）が見つかりません。別のフォルダで npm i playwright@1.56.1 し、その node_modules を NODE_PATH に指定してください（ブラウザーが標準の場所にないときは PLAYWRIGHT_BROWSERS_PATH も）。',
  );
}

const { chromium } = await loadPlaywright();
const screenMod = await loadScript('screen.mjs');
const fake = await import(pathToFileURL(path.join(TEMPLATE_DIR, 'tests', 'stage2', 'ui', 'fake-core.mjs')).href);
const { startApp } = await import(pathToFileURL(path.join(TEMPLATE_DIR, 'com.github.copilot', 'extensions', '_plugin_', 'ui', 'app.mjs')).href);

const screen = screenMod.createScreen({ chromium, env: {} });
before(async () => {
  await screen.prepare();
});
after(async () => {
  await screen.close();
  cleanupTemp();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what, limit = 20_000) {
  const end = Date.now() + limit;
  while (!check()) {
    if (Date.now() > end) throw new Error(`待ちきれなかった：${what}`);
    await sleep(20);
  }
}

/** 本物の画面を、偽物の中心の処理につないで起動する。開始されると、実行中の状態になる */
async function withApp(fn, { hooks = true } = {}) {
  const core = fake.createFakeCore(fake.prepState());
  if (hooks) core.hooks.start = (_settings, c) => c.set(fake.runState('do'));
  const app = await startApp({ core, cwd: makeTemp(), preferredPort: 0 });
  try {
    await fn({ core, app });
  } finally {
    await app.close();
  }
}

const SETTINGS = { maxIterations: 2, task: { week: '2026-W42', items: 7, tone: 'だ・である調', attach: true, folder: '' } };
const operate = (app, extra = {}) => screen.operate({ url: app.url, settings: SETTINGS, pollMs: 40, timeoutMs: 20_000, ...extra });

describe('画面の操作', () => {
  test('REQ-041 画面を開き、設定を入れて開始し、終わった理由が出るまで見て、結果を読む', async () => {
    await withApp(async ({ core, app }) => {
      const snapshots = [];
      const done = operate(app, { onSnapshot: (s) => snapshots.push(s) });
      await until(() => core.callsOf('start').length === 1, '開始');
      await until(() => snapshots.some((s) => s.status === 'running'), '実行中の表示');
      core.set(fake.finishedState({ kind: 'all_passed', detail: null, unstoppable: false }));
      const result = await done;

      assert.deepEqual(core.callsOf('start')[0].args[0], {
        models: { orchestrator: 'claude-opus-5-5', worker: 'claude-haiku-5-5', verifier: 'claude-opus-5-5' },
        efforts: { orchestrator: '', worker: '', verifier: '' },
        maxIterations: 2,
        task: { week: '2026-W42', items: 7, tone: 'だ・である調', attach: true, folder: '' },
      });
      assert.equal(result.finished, true);
      assert.equal(result.timedOut, false);
      assert.deepEqual(result.endReason, { kind: 'all_passed', detail: null, unstoppable: false });
      assert.match(result.endReasonText, /終わった理由：評価基準をすべて満たした/);
      assert.match(result.resultText, /週報を1回で作成しました。/);
      assert.match(result.iterationsText, /試行ごとの評価基準と合否/);
      assert.equal(result.summary, '週報を1回で作成しました。');
      assert.equal(result.iterations.length, 1);
      const statuses = result.snapshots.map((s) => s.status);
      assert.deepEqual(statuses.slice(0, 1), ['running'], '開始の後の状態から記録する');
      assert.equal(statuses.at(-1), 'finished');
      assert.deepEqual(result.snapshots[0].agents, ['orchestrator:standby', 'worker:running', 'verifier:standby']);
      assert.equal(result.snapshots[0].phase, 'do');
    });
  });

  test('REQ-041 チェックボックスの設定は、値のとおりに入れる（偽なら入れない）', async () => {
    await withApp(async ({ core, app }) => {
      const done = operate(app, { settings: { maxIterations: 2, task: { week: '2026-W42', attach: false } } });
      await until(() => core.callsOf('start').length === 1, '開始');
      core.set(fake.finishedState());
      await done;
      assert.equal(core.callsOf('start')[0].args[0].task.attach, false);
    });
  });

  test('REQ-012 途中で終わったときは、その理由の文を読む', async () => {
    await withApp(async ({ core, app }) => {
      const done = operate(app);
      await until(() => core.callsOf('start').length === 1, '開始');
      core.set(fake.finishedState({ kind: 'aborted', detail: 'credit_limit', unstoppable: false }));
      const result = await done;
      assert.equal(result.endReason.kind, 'aborted');
      assert.match(result.endReasonText, /途中で終わった（AI クレジットの上限）/);
    });
  });

  test('REQ-041 実行中の状態の変わり目だけを記録し、状態が変わるたびに onSnapshot を呼ぶ', async () => {
    await withApp(async ({ core, app }) => {
      const seen = [];
      const done = operate(app, { onSnapshot: (s) => seen.push(`${s.status}/${s.phase}`) });
      await until(() => core.callsOf('start').length === 1, '開始');
      await until(() => seen.length >= 1, '実行中の表示');
      core.set(fake.runState('study'));
      await until(() => seen.includes('running/study'), '評価のフェーズ');
      await sleep(150); // 同じ状態が続いても、記録は増えない
      core.set(fake.finishedState());
      const result = await done;
      assert.deepEqual(seen, ['running/do', 'running/study', 'finished/null']);
      assert.deepEqual(result.snapshots.map((s) => `${s.status}/${s.phase}`), seen);
    });
  });

  test('REQ-041 終わらないときは、上限の時間で打ち切り、終わっていないことと、そこまでの記録を返す', async () => {
    await withApp(async ({ app }) => {
      const result = await operate(app, { timeoutMs: 700 });
      assert.equal(result.finished, false);
      assert.equal(result.timedOut, true);
      assert.equal(result.endReason, null);
      assert.ok(result.snapshots.some((s) => s.status === 'running'));
    });
  });

  test('REQ-041 最後の画面の写真を、指定の場所に書く', async () => {
    await withApp(async ({ core, app }) => {
      const png = path.join(makeTemp(), 'sub', 'screen.png');
      fs.mkdirSync(path.dirname(png), { recursive: true });
      const done = operate(app, { screenshotPath: png });
      await until(() => core.callsOf('start').length === 1, '開始');
      core.set(fake.finishedState());
      await done;
      assert.deepEqual([...fs.readFileSync(png).subarray(1, 4)], [...Buffer.from('PNG')]);
    });
  });

  test('REQ-041 試験が止まったら（中断の合図）、画面の操作をやめる', async () => {
    await withApp(async ({ core, app }) => {
      const controller = new AbortController();
      const done = operate(app, { signal: controller.signal });
      await until(() => core.callsOf('start').length === 1, '開始');
      controller.abort();
      await assert.rejects(done, /試験が止まったので、画面の操作をやめました/);
    });
  });

  test('REQ-041 画面のサーバーにつながらなくなったら、そのことを伝えて終える', async () => {
    await withApp(async ({ core, app }) => {
      const seen = [];
      const done = operate(app, { onSnapshot: (s) => seen.push(s.status) });
      await until(() => seen.includes('running'), '画面が実行中の状態を読んだこと'); // 監視が始まってから、サーバーを閉じる
      assert.equal(core.callsOf('start').length, 1);
      await app.close();
      await assert.rejects(done, /画面のサーバーにつながらなくなりました/);
    });
  });
});

describe('画面を操作できないとき', () => {
  test('REQ-041 設定の欄が画面にないときは、どの設定かを伝える', async () => {
    await withApp(async ({ app }) => {
      await assert.rejects(operate(app, { settings: { task: { week: 'W42', nothing: 'x' } } }), /設定「nothing」の欄が画面にありません/);
    });
  });

  test('REQ-041 選択肢にない値を入れようとしたときは、どの設定かを伝える', async () => {
    await withApp(async ({ app }) => {
      await assert.rejects(operate(app, { settings: { task: { week: 'W42', tone: '存在しない文体' } } }), /設定「tone」に「存在しない文体」を入れられませんでした/);
    });
  });

  test('REQ-041 必須の設定が空で開始できないときは、画面の文を伝える', async () => {
    await withApp(async ({ core, app }) => {
      await assert.rejects(operate(app, { settings: { maxIterations: 2 } }), /画面で開始できませんでした（「対象の週」を入力してください。）/);
      assert.equal(core.callsOf('start').length, 0, '開始の呼び出しは送られない');
    });
  });

  test('REQ-041 中心の処理が開始を断ったときは、その理由を伝える', async () => {
    await withApp(async ({ core, app }) => {
      core.refusals.start = new Error('モデルが使えません');
      await assert.rejects(operate(app), /画面で開始できませんでした（モデルが使えません）/);
    });
  });

  test('REQ-041 画面を開けないときは、そのことを伝える', async () => {
    await assert.rejects(
      screen.operate({ url: 'http://127.0.0.1:1/?k=none', settings: {}, pollMs: 40, timeoutMs: 2000 }),
      /画面を開けませんでした/,
    );
  });
});

describe('ブラウザーの起動', () => {
  const fakeChromium = (works) => {
    const calls = [];
    return {
      calls,
      launch: async (options = {}) => {
        const channel = options.channel ?? 'chromium';
        calls.push(channel);
        if (!works.includes(channel)) throw new Error(`Chromium distribution '${channel}' is not found\nくわしい説明`);
        return { channel, close: async () => {} };
      },
    };
  };

  test('REQ-048 手元の Chrome、Edge の順に試し、どちらもなければ Playwright の Chromium を使う', async () => {
    const a = fakeChromium(['chrome', 'chromium']);
    assert.equal((await screenMod.launchBrowser(a, { env: {} })).channel, 'chrome');
    assert.deepEqual(a.calls, ['chrome']);
    const b = fakeChromium(['msedge', 'chromium']);
    assert.equal((await screenMod.launchBrowser(b, { env: {} })).channel, 'msedge');
    assert.deepEqual(b.calls, ['chrome', 'msedge']);
    const c = fakeChromium(['chromium']);
    assert.equal((await screenMod.launchBrowser(c, { env: {} })).channel, 'chromium');
    assert.deepEqual(c.calls, ['chrome', 'msedge', 'chromium']);
  });

  test('REQ-048 環境変数 PLUGIN_TEST_BROWSER_CHANNEL があれば、そのブラウザーだけを試す', async () => {
    const a = fakeChromium(['chrome', 'msedge', 'chromium']);
    assert.equal((await screenMod.launchBrowser(a, { env: { PLUGIN_TEST_BROWSER_CHANNEL: 'msedge' } })).channel, 'msedge');
    assert.deepEqual(a.calls, ['msedge']);
    const b = fakeChromium(['chrome', 'chromium']);
    assert.equal((await screenMod.launchBrowser(b, { env: { PLUGIN_TEST_BROWSER_CHANNEL: 'chromium' } })).channel, 'chromium');
    assert.deepEqual(b.calls, ['chromium']);
  });

  test('REQ-048 どれも起動できないときは、試したものと理由と、直し方を伝える', async () => {
    await assert.rejects(screenMod.launchBrowser(fakeChromium([]), { env: {} }), (error) => {
      assert.equal(error.name, 'ScreenError');
      assert.match(error.message, /ブラウザーを起動できませんでした/);
      assert.match(error.message, /chrome：Chromium distribution 'chrome' is not found/);
      assert.match(error.message, /msedge：/);
      assert.match(error.message, /Playwright の Chromium：/);
      assert.match(error.message, /check_tools\.py --install/);
      assert.doesNotMatch(error.message, /くわしい説明/, '最初の行だけ');
      return true;
    });
  });
});

describe('チャットに出た URL', () => {
  test('REQ-005 チャットの文から、画面の URL を取り出す', () => {
    const find = screenMod.findScreenUrl;
    assert.equal(find('画面を開いてください：http://127.0.0.1:8731/?k=AbC_-123 です'), 'http://127.0.0.1:8731/?k=AbC_-123');
    assert.equal(find('[ここ](http://127.0.0.1:50123/?k=xyz)を開く'), 'http://127.0.0.1:50123/?k=xyz');
    assert.equal(find('`http://localhost:9000/?k=tok`'), 'http://localhost:9000/?k=tok');
    assert.equal(find('1つ目 http://127.0.0.1:1/?k=a と 2つ目 http://127.0.0.1:2/?k=b'), 'http://127.0.0.1:1/?k=a');
    assert.equal(find('http://example.com/?k=a'), null, '手元の画面だけ');
    assert.equal(find('http://example.com:8080/?k=a'), null, 'ポートがあっても、手元以外の host の URL は使わない');
    assert.equal(find('http://127.0.0.1.example.com:8080/?k=a'), null, '手元の host で始まるだけの別の host も使わない');
    assert.equal(find('http://127.0.0.1:8731/'), null, '合言葉のない URL は使えない');
    assert.equal(find(undefined), null);
  });

  test('REQ-041 設定の欄の id は、画面（render.js）の fieldId と同じ作り方', () => {
    assert.equal(screenMod.fieldId('week'), 'setting-week');
    assert.equal(screenMod.fieldId('maxIterations'), 'setting-maxIterations');
    assert.equal(screenMod.fieldId('保存先 (dir)'), 'setting-_____dir_', '\\w と - 以外は1文字ずつ _ になる');
    const render = fs.readFileSync(path.join(TEMPLATE_DIR, 'com.github.copilot', 'extensions', '_plugin_', 'ui', 'static', 'render.js'), 'utf8');
    assert.match(render, /function fieldId\(key\) \{\s*return `setting-\$\{String\(key\)\.replace\(\/\[\^\\w-\]\/g, '_'\)\}`;/, '画面の側が作り方を変えたら、screen.mjs の fieldId も変える');
  });
});
