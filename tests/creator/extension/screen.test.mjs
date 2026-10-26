// 2段目 部品の試験（クリエイターのエクステンション）：クリエイターの画面のサーバー（見るだけ）と、画面に出す状態。
// 設計書：generated-plugin-structure.md 9章、REQ-043、REQ-044。ブラウザーでの描画は screen.browser.test.mjs。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EXTENSION_DIR, TEMPLATE_EXTENSION_DIR, confirmArgs, internalSymbolsIn, knowledge, readyToConfirm, startForTest, tempDir, withRun, writeRealInput } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const parts = (url) => ({ origin: new URL(url).origin, token: new URL(url).searchParams.get('k'), port: Number(new URL(url).port) });

/** 画面のサーバーに問い合わせる。合言葉は付ける（options.token で変えられる） */
async function api(url, pathname, { token, method = 'GET', body } = {}) {
  const p = parts(url);
  const key = token === undefined ? p.token : token;
  const response = await fetch(`${p.origin}${pathname}${key === null ? '' : `${pathname.includes('?') ? '&' : '?'}k=${key}`}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return response;
}

const viewOf = async (url) => (await api(url, '/api/state')).json();

/** 文字列の値だけを集める（キーは英語でよい。値が内部の記号になっていないかを見る） */
function stringValues(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringValues(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) stringValues(v, out);
  return out;
}

async function openScreen(run) {
  const text = await run.call('open');
  return /(http:\/\/127\.0\.0\.1:\d+\/\?k=\S+)/.exec(text)[1];
}

describe('クリエイターの画面のサーバー', () => {
  test('REQ-043 127.0.0.1 だけで待ち受け、合言葉つきの URL で開ける。合言葉がない・違う、Host が違う問い合わせは断る', async () => {
    await withRun(async (run) => {
      const url = await openScreen(run);
      const { origin, token, port } = parts(url);
      assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.ok(token && token.length >= 20, '合言葉が短い');

      assert.equal((await api(url, '/api/state')).status, 200);
      assert.equal((await api(url, '/api/state', { token: null })).status, 403, '合言葉なし');
      assert.equal((await api(url, '/api/state', { token: 'wrong-token-value' })).status, 403, '違う合言葉');
      assert.equal((await api(url, '/', { token: null })).status, 403, '画面の本体も合言葉なしでは開けない');
      assert.equal((await api(url, '/creator.js', { token: null })).status, 403, '画面の部品も合言葉なしでは開けない');

      // Host が 127.0.0.1 か localhost でないと断る（DNS を使った別の Web ページからの問い合わせを防ぐ）
      const status = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: `/api/state?k=${token}`, headers: { Host: 'evil.example.com' } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(status, 403);

      // 全部の応答に、スクリプトを自分のサーバーのものだけにする CSP と nosniff が付く
      const response = await api(url, '/api/state');
      assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    });
  });

  test('REQ-043 同じマシンのブラウザーからは開け、ほかのマシンからは開けない（ほかのネットワークの口では待ち受けない）', async () => {
    const others = Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => i.address);
    await withRun(async (run) => {
      const url = await openScreen(run);
      const { port } = parts(url);
      for (const address of others) {
        const refused = await new Promise((resolve) => {
          const socket = net.connect({ host: address, port, timeout: 2000 });
          socket.on('connect', () => {
            socket.destroy();
            resolve(false);
          });
          socket.on('error', () => resolve(true));
          socket.on('timeout', () => {
            socket.destroy();
            resolve(true);
          });
        });
        assert.equal(refused, true, `${address}:${port} でも待ち受けている`);
      }
      // 待ち受けの口そのものも確かめる
      const info = run.creator.screen.url;
      assert.ok(info.startsWith('http://127.0.0.1:'));
    });
  });

  test('REQ-043 画面は見るだけ：答えや直しを受け取る窓口（書き込み）がない', async () => {
    await withRun(async (run) => {
      const url = await openScreen(run);
      for (const [method, pathname] of [
        ['POST', '/api/state'],
        ['POST', '/api/start'],
        ['POST', '/api/stop'],
        ['POST', '/api/issues/1/file'],
        ['POST', '/api/knowledge'],
        ['PUT', '/api/state'],
        ['DELETE', '/api/state'],
      ]) {
        const response = await api(url, pathname, { method, body: {} });
        assert.equal(response.status, 404, `${method} ${pathname}`);
      }
      // 画面の部品にも、入力の欄や送信の仕組みがない
      const html = await (await api(url, '/')).text();
      assert.ok(!/<(input|textarea|select|button|form)\b/i.test(html), 'index.html に入力の欄がある');
      const js = fs.readFileSync(path.join(EXTENSION_DIR, 'ui', 'static', 'creator.js'), 'utf8');
      assert.ok(!/method:\s*['"](POST|PUT|DELETE|PATCH)/i.test(js), 'creator.js が書き込みを送っている');
      assert.ok(!/['"](input|textarea|select|button|form)['"]/.test(js), 'creator.js が入力の欄を作っている');
      assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(js), 'HTML として組み立てている');
    });
  });

  test('generated-plugin-structure.md 9章 画面の本体と部品が返る。描画の部品とスタイルは、ひな形のものをそのまま使う（土台の写しを持たない）', async () => {
    await withRun(async (run) => {
      const url = await openScreen(run);
      const { token } = parts(url);
      const html = await (await api(url, '/')).text();
      assert.ok(!html.includes('%%K%%'), '合言葉の差し込み口が残っている');
      assert.ok(html.includes(`creator.js?k=${token}`) && html.includes(`render.js?k=${token}`) && html.includes(`style.css?k=${token}`));
      assert.match(html, /<title>plugin-creator の画面<\/title>/);

      const templateStatic = path.join(TEMPLATE_EXTENSION_DIR, 'ui', 'static');
      for (const name of ['render.js', 'style.css']) {
        const served = await (await api(url, `/${name}`)).text();
        // 合言葉の差し込み口（style.css の中のフォントの URL）だけは、今の合言葉になる
        assert.equal(served, fs.readFileSync(path.join(templateStatic, name), 'utf8').replaceAll('%%K%%', token), `${name} がひな形と違う`);
        assert.equal(fs.existsSync(path.join(EXTENSION_DIR, 'ui', 'static', name)), false, `${name} の写しを持っている`);
      }
      assert.equal((await api(url, '/creator.js')).status, 200);
      assert.equal((await api(url, '/creator.css')).status, 200);
      assert.equal(fs.existsSync(path.join(EXTENSION_DIR, 'ui', 'server.mjs')), false, '画面のサーバーの写しを持っている');
      assert.deepEqual(
        fs.readdirSync(EXTENSION_DIR).filter((f) => /server|render/.test(f)),
        [],
      );
    });
  });

  test('REQ-043 状態の全体は、日本語の名前で、聞いた項目とまだ聞いていない項目を分けて持ち、変わったときだけ版が変わる', async () => {
    await withRun(async (run) => {
      const url = await openScreen(run);
      const empty = await viewOf(url);
      assert.equal(empty.hearing.exists, false);
      assert.deepEqual(empty.hearing.knowledge, []);
      assert.deepEqual(empty.results, []);
      assert.deepEqual(empty.examples, []);
      assert.equal(empty.confirmation, null);
      assert.equal(typeof empty.version, 'string');
      assert.equal((await viewOf(url)).version, empty.version, '変わっていなければ、版は同じ');

      await run.call('progress', {
        stage: '項目の点検',
        items: [
          { item: '作業の目的', status: '聞いた', quote: '週報を作る' },
          { item: '成果物', status: '保留', quote: '分からない', holder: '田中さん' },
          { item: 'いつもと違うとき', status: '決まりなし', quote: '特にない' },
        ],
      });
      await run.call('record', {
        knowledge: [
          knowledge({ item: '作業の目的', text: '毎週の報告を楽にする', quote: '楽にしたい' }),
          knowledge({ item: '進め方', text: '候補の決まり', status: '候補', source: 'ファイルから読んで確かめた', quote: '週報.docx' }),
          knowledge({ item: '進め方', text: '外した決まり', status: '外した', quote: '違う' }),
        ],
        assets: [{ name: '週報テンプレート', location: 'templates/weekly.docx', status: '流用する' }, { name: '古い集計表', status: '候補' }],
        oss: [{ name: '議事録スキル', kind: '公開のプラグイン', choice: '使わない' }],
      });

      const view = await viewOf(url);
      assert.notEqual(view.version, empty.version);
      assert.equal(view.hearing.exists, true);
      assert.equal(view.hearing.stage, '項目の点検');
      // 聞いた項目と、まだ聞いていない項目が分かれる（仕様 REQ-015 の10項目のうち、未着手のもの）
      assert.deepEqual(view.hearing.notAskedItems, ['頼む場面と言い方', '受け取るもの', '進め方', '合否の決め方', '決まった書き方やルール', '守らないと困ること', '使う道具と環境']);
      const asked = view.hearing.items.filter((i) => i.main && i.done).map((i) => [i.name, i.status]);
      assert.deepEqual(asked, [['作業の目的', '聞いた'], ['成果物', '保留'], ['いつもと違うとき', '決まりなし']]);
      assert.equal(view.hearing.items.find((i) => i.name === '成果物').holder, '田中さん');
      assert.deepEqual(view.hearing.items.find((i) => i.name === '候補の確かめ'), { name: '候補の確かめ', status: '未着手', done: false, main: false, holder: null });

      assert.deepEqual(view.hearing.knowledge.map((k) => [k.id, k.kind, k.item, k.text, k.source, k.quote]), [['K-01', 'それ以外', '作業の目的', '毎週の報告を楽にする', 'お話を聞いた答え', '楽にしたい']]);
      assert.deepEqual(view.hearing.candidates.map((k) => [k.id, k.text]), [['K-02', '候補の決まり']]);
      assert.deepEqual(view.hearing.dropped.map((k) => [k.id, k.text]), [['K-03', '外した決まり']]);
      assert.deepEqual(view.hearing.assets.map((a) => a.name), ['週報テンプレート']);
      assert.deepEqual(view.hearing.assetCandidates.map((a) => a.name), ['古い集計表']);
      assert.deepEqual(view.hearing.oss, [{ name: '議事録スキル', kind: '公開のプラグイン', choice: '使わない', note: null }]);

      // 値に内部の記号が出ない（画面は日本語の名前だけを持つ）
      const leaked = stringValues(view).flatMap((v) => internalSymbolsIn(v));
      assert.deepEqual(leaked, []);
    });
  });

  test('REQ-043 チャットで答えて決まったことが、再読み込みなしで増える：取り直すたびに最新の状態が返る', async () => {
    await withRun(async (run) => {
      const url = await openScreen(run);
      const versions = new Set([(await viewOf(url)).version]);
      for (let i = 1; i <= 3; i += 1) {
        await run.call('record', { knowledge: [knowledge({ text: `決まり${i}` })] });
        const view = await viewOf(url);
        assert.equal(view.hearing.knowledge.length, i);
        versions.add(view.version);
      }
      assert.equal(versions.size, 4, '変わるたびに版が上がる');
    });
  });

  test('REQ-020 REQ-043 生成前の確認で示すナレッジの一覧と、画面の「決まったこと」の一覧の中身が同じ', async () => {
    await withRun(async (run) => {
      const url = await openScreen(run);
      await readyToConfirm(run);
      await run.call('confirm', confirmArgs());
      const view = await viewOf(url);
      assert.equal(view.hearing.knowledge.length, 2);
      assert.deepEqual(view.confirmation.knowledge, view.hearing.knowledge);
    });
  });

  test('REQ-044 REQ-027 生成前の確認で示すもの（ナレッジの一覧、振る舞いの案、Web管理画面の見本、EVAL の課題と合否の基準）が画面の状態にある', async () => {
    await withRun(async (run) => {
      const url = await openScreen(run);
      await readyToConfirm(run);
      const text = await run.call('confirm', confirmArgs({
          evalTasks: [
            { prompt: '今週の週報を作ってください。', inputs: [{ path: 'inputs/前回の週報.docx', provisional: true }, { path: writeRealInput(run.cwd) }], criteria: ['K-02'], settings: { maxIterations: 2, task: { week: '2026-W42', style: '詳細' } } },
            { prompt: '先週の分も作ってください。', criteria: ['K-02'], settings: { task: { week: '2026-W41' } } },
          ],
        }),
      );
      const sampleUrl = /見本：(http:\/\/127\.0\.0\.1:\d+\/\?k=\S+)/.exec(text)[1];
      const c = (await viewOf(url)).confirmation;
      assert.equal(c.behavior, '前回の週報を受け取り、今週の予定と実績を整理して、決まった書き方の週報を作る。');
      assert.equal(c.sampleUrl, sampleUrl);
      assert.notEqual(sampleUrl, url, '見本は、クリエイターの画面とは別のサーバー');
      assert.deepEqual(c.knowledge.map((k) => k.id), ['K-01', 'K-02']);
      // 合否の基準の案は、種類が「合否の決め方」のナレッジの文のまま
      assert.deepEqual(c.criteria, [{ id: 'C-01', text: '見出しが「今週の実績」「来週の予定」の順に並んでいれば合格', knowledge: 'K-02' }]);
      assert.deepEqual(c.evalTasks, [
        {
          prompt: '今週の週報を作ってください。',
          inputs: [{ path: 'inputs/前回の週報.docx', provisional: true }, { path: path.join(run.cwd, 'inputs', '実績.xlsx'), provisional: false }],
          criteria: [{ id: 'K-02', text: '見出しが「今週の実績」「来週の予定」の順に並んでいれば合格' }],
          // 作業ごとの設定は、案の設定の見出し（label）を添えて出す（X4-13）
          settings: { maxIterations: 2, task: [{ key: 'week', label: '対象の週', value: '2026-W42' }, { key: 'style', label: '書き方', value: '詳細' }] },
        },
        {
          prompt: '先週の分も作ってください。',
          inputs: [],
          criteria: [{ id: 'K-02', text: '見出しが「今週の実績」「来週の予定」の順に並んでいれば合格' }],
          settings: { task: [{ key: 'week', label: '対象の週', value: '2026-W41' }] },
        },
      ]);
      assert.equal(c.rebuild, null);
    });
  });

  test('REQ-038 REQ-024 課題の設定の値は、案の設定の見出しで出る。見出しが取れないもの（古い記録、見出しのない設定）だけ、名前（key）のまま出る（X4-13）', async () => {
    const home = tempDir('label-home');
    const cwd = tempDir('label-cwd');
    try {
      const first = await startForTest({ sessionId: 'session-label', home, cwd });
      await readyToConfirm(first);
      await first.call('confirm', confirmArgs({ evalTasks: [{ prompt: '頼む', criteria: ['K-02'], settings: { task: { week: '2026-W42', style: '詳細' } } }] }));
      const file = first.statePath();
      const state = first.readState();
      await first.cleanup();

      const labelsOf = async (settingLabels) => {
        const next = structuredClone(state);
        if (settingLabels === undefined) delete next.confirmation.settingLabels;
        else next.confirmation.settingLabels = settingLabels;
        fs.writeFileSync(file, JSON.stringify(next));
        const run = await startForTest({ sessionId: 'session-label', home, cwd });
        try {
          return (await viewOf(await openScreen(run))).confirmation.evalTasks[0].settings.task;
        } finally {
          await run.cleanup();
        }
      };
      assert.deepEqual(await labelsOf(state.confirmation.settingLabels), [
        { key: 'week', label: '対象の週', value: '2026-W42' },
        { key: 'style', label: '書き方', value: '詳細' },
      ]);
      // 見出しが一部ない・まったくない（この直しの前の記録）：ないものだけ、名前のまま
      assert.deepEqual(await labelsOf({ week: '対象の週' }), [
        { key: 'week', label: '対象の週', value: '2026-W42' },
        { key: 'style', label: 'style', value: '詳細' },
      ]);
      assert.deepEqual(
        (await labelsOf(undefined)).map((item) => item.label),
        ['week', 'style'],
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('REQ-044 作り直しのとき、引き継ぐことと変わることも画面の状態にある', async () => {
    await withRun(async (run) => {
      const url = await openScreen(run);
      await readyToConfirm(run);
      await run.call('progress', { stage: 'できていたことの確認', items: [{ item: 'できていたことの確認', status: '聞いた', quote: '全部引き継ぐ' }] });
      await run.call('confirm', confirmArgs({ rebuild: { keep: ['週報の書き方'], change: ['画面を足す'] } }));
      assert.deepEqual((await viewOf(url)).confirmation.rebuild, { keep: ['週報の書き方'], change: ['画面を足す'] });
    });
  });

  test('REQ-044 試験の結果：知らされたファイルを読んで出す（1・2段目は段階ごとの合否と不合格の理由、EVAL は点数と差と AI クレジット）', async () => {
    await withRun(async (run) => {
      const url = await openScreen(run);
      const latest = path.join(run.cwd, 'tests', 'results', 'latest.json');
      fs.mkdirSync(path.dirname(latest), { recursive: true });
      fs.writeFileSync(
        latest,
        JSON.stringify({
          status: 'failed',
          stages: [
            { id: 'stage1', name: '構造の検査', status: 'passed', failures: [], warnings: ['説明が長い'], counts: { total: 12, passed: 12, failed: 0, skipped: 0 } },
            { id: 'stage2', name: '部品の試験', status: 'failed', failures: [{ test: 'REQ-009 止めると統括だけが取り消される', reason: '取り消されたのは2体' }], warnings: [], counts: { total: 30, passed: 29, failed: 1, skipped: 0 } },
          ],
        }),
      );
      const evalFile = path.join(run.cwd, 'tests', 'results', 'eval-1', 'summary.json');
      fs.mkdirSync(path.dirname(evalFile), { recursive: true });
      fs.writeFileSync(
        evalFile,
        JSON.stringify({
          scores: { with: 0.9, without: 0.4 },
          credits: 12.5,
          runs: [{ task: 'T-01', variant: 'with', score: 1, criteria: [{ id: 'C-01', text: '見出しの順', pass: true }, { id: 'C-02', text: '日付の形', pass: false }] }, { task: 'T-01', variant: 'without', score: 0.5, criteria: [] }],
        }),
      );
      const other = path.join(run.cwd, 'other.json');
      fs.writeFileSync(other, JSON.stringify({ hello: '世界' }));

      const text = await run.call('results', { paths: ['tests/results/latest.json', evalFile, other] });
      assert.equal(text, '試験の結果3件を、plugin-creator の画面に出します。');
      const { results } = await viewOf(url);
      assert.deepEqual(results.map((r) => r.name), ['latest.json', 'summary.json', 'other.json']);

      const stages = results[0].view;
      assert.equal(stages.kind, 'stages');
      assert.equal(stages.overall, '不合格');
      assert.deepEqual(stages.stages.map((s) => [s.name, s.status]), [['ファイルの形の検査', '合格'], ['動きの試験', '不合格']]);
      assert.deepEqual(stages.stages[1].failures, [{ test: 'REQ-009 止めると統括だけが取り消される', reason: '取り消されたのは2体' }]);
      assert.deepEqual(stages.stages[0].warnings, ['説明が長い']);

      const evalView = results[1].view;
      assert.equal(evalView.kind, 'eval');
      assert.deepEqual([evalView.withScore, evalView.withoutScore, evalView.credits], [0.9, 0.4, 12.5]);
      assert.ok(Math.abs(evalView.difference - 0.5) < 1e-9, 'あり・なしの点数の差');
      assert.deepEqual(evalView.runs[0].criteria, [{ id: 'C-01', text: '見出しの順', pass: true }, { id: 'C-02', text: '日付の形', pass: false }]);
      assert.equal(evalView.runs[0].variant, 'あり');
      assert.equal(evalView.runs[1].variant, 'なし');

      assert.equal(results[2].view.kind, 'unknown');
      assert.match(results[2].view.raw, /"hello": "世界"/);
    });
  });

  test('REQ-044 結果のファイルが更新されたら、取り直すと新しい中身が出る。消されたら、読めない理由が出る', async () => {
    await withRun(async (run) => {
      const url = await openScreen(run);
      const file = path.join(run.cwd, 'latest.json');
      fs.writeFileSync(file, JSON.stringify({ status: 'passed', stages: [{ name: '構造の検査', status: 'passed', failures: [] }] }));
      await run.call('results', { paths: ['latest.json'] });
      assert.equal((await viewOf(url)).results[0].view.overall, '合格');

      fs.writeFileSync(file, JSON.stringify({ status: 'failed', stages: [{ name: '構造の検査', status: 'failed', failures: [{ test: 'REQ-004 形', reason: '足りない' }] }] }) + ' '.repeat(5));
      assert.equal((await viewOf(url)).results[0].view.overall, '不合格');

      fs.rmSync(file);
      const gone = (await viewOf(url)).results[0];
      assert.match(gone.error, /見つかりません/);
    });
  });

  test('REQ-044 結果のファイルとして受け付けないもの（ない、フォルダ、JSON でない拡張子、大きすぎる）は、理由を返して断る', async () => {
    await withRun(async (run) => {
      fs.mkdirSync(path.join(run.cwd, 'dir.json'));
      fs.writeFileSync(path.join(run.cwd, 'a.txt'), 'x');
      fs.writeFileSync(path.join(run.cwd, 'big.json'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x20));
      const refuse = async (paths) => (await run.callSafe('results', { paths })).error;
      assert.match(await refuse(['missing.json']), /見つかりません：.*missing\.json/);
      assert.match(await refuse(['dir.json']), /ファイルではありません/);
      assert.match(await refuse(['a.txt']), /JSON のファイルではありません/);
      assert.match(await refuse(['big.json']), /大きすぎて読めません/);
      assert.match(await refuse([]), /結果のファイルの場所の一覧（paths）を渡してください/);
      const broken = path.join(run.cwd, 'broken.json');
      fs.writeFileSync(broken, '{ 壊れた');
      await run.call('results', { paths: ['broken.json'] });
      const url = await openScreen(run);
      assert.match((await viewOf(url)).results[0].error, /JSON として読めません/);
    });
  });

  test('REQ-044 知らされた結果のファイルは、記録のフォルダに残り、起動し直した後（--continue）も画面に出る。同じものは重ならない', async () => {
    const home = tempDir('results-home');
    const cwd = tempDir('results-cwd');
    try {
      const { startForTest } = await import('./helpers.mjs');
      const first = await startForTest({ sessionId: 'session-res', home, cwd });
      const file = path.join(cwd, 'latest.json');
      fs.writeFileSync(file, JSON.stringify({ status: 'passed', stages: [] }));
      await first.call('results', { paths: [file] });
      await first.call('results', { paths: [file] });
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(first.creator.store.dir, 'results.json'), 'utf8')), { paths: [file] });
      await first.cleanup();

      const second = await startForTest({ sessionId: 'session-res', home, cwd });
      const url = await openScreen(second);
      assert.deepEqual((await viewOf(url)).results.map((r) => r.name), ['latest.json']);
      await second.cleanup();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('REQ-044 会話例（リポジトリの examples/ の Markdown）へのリンクを出す。一覧にあるファイルだけを、文字として開ける', async () => {
    const examples = tempDir('examples');
    try {
      fs.writeFileSync(path.join(examples, '議事録の例.md'), '# 会話例\nクリエイターの版：0.1.0\n<script>alert(1)</script>\n');
      fs.writeFileSync(path.join(examples, 'b.md'), '# b');
      fs.writeFileSync(path.join(examples, 'c.txt'), 'テキストは出さない');
      fs.writeFileSync(path.join(examples, '.hidden.md'), '隠しファイルは出さない');
      fs.writeFileSync(path.join(path.dirname(examples), 'secret.md'), '外のファイル');
      await withRun(
        async (run) => {
          const url = await openScreen(run);
          assert.deepEqual((await viewOf(url)).examples, ['b.md', '議事録の例.md']);
          const opened = await api(url, `/api/examples/${encodeURIComponent('議事録の例.md')}`);
          assert.equal(opened.status, 200);
          assert.match(opened.headers.get('content-type'), /^text\/plain; charset=utf-8/, 'HTML として動かさず、文字として見せる');
          assert.equal(opened.headers.get('x-content-type-options'), 'nosniff');
          assert.match(opened.headers.get('content-security-policy'), /sandbox/);
          assert.match(await opened.text(), /<script>alert\(1\)<\/script>/);
          for (const name of ['c.txt', '.hidden.md', 'nothing.md', '../secret.md', '..%2Fsecret.md', '%2e%2e%2fsecret.md']) {
            assert.equal((await api(url, `/api/examples/${name.includes('%') ? name : encodeURIComponent(name)}`)).status, 404, name);
          }
        },
        { extra: { examplesDir: examples } },
      );
    } finally {
      fs.rmSync(path.join(path.dirname(examples), 'secret.md'), { force: true });
      fs.rmSync(examples, { recursive: true, force: true });
    }
  });

  test('REQ-043 Copilot CLI を終えると、クリエイターの画面のサーバーのプロセスが残らない（サーバーはエクステンションと同じプロセスで動く）', async () => {
    const home = tempDir('proc-home');
    const cwd = tempDir('proc-cwd');
    const child = spawn(process.execPath, [path.join(here, 'screen-process.mjs'), home, cwd], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      const line = await new Promise((resolve, reject) => {
        let buffer = '';
        child.stdout.on('data', (chunk) => {
          buffer += chunk;
          if (buffer.includes('\n')) resolve(buffer.split('\n')[0]);
        });
        child.on('exit', (code) => reject(new Error(`先に終わった：${code}`)));
        setTimeout(() => reject(new Error('起動が遅い')), 10_000);
      });
      const { url, pid } = JSON.parse(line);
      assert.equal(pid, child.pid);
      assert.equal((await api(url, '/api/state')).status, 200);

      // 子プロセスを作っていない
      const pgrep = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
      if (pgrep.error === undefined) assert.equal(pgrep.stdout.trim(), '', '子プロセスがある');

      // Copilot CLI がエクステンションを止める（SIGTERM）と、プロセスもサーバーも終わる
      const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
      child.kill('SIGTERM');
      await exited;
      await assert.rejects(api(url, '/api/state'), /fetch failed/);
    } finally {
      child.kill('SIGKILL');
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('REQ-043 shutdown で、クリエイターの画面のサーバーも見本のサーバーも閉じる', async () => {
    await withRun(async (run) => {
      const url = await openScreen(run);
      await readyToConfirm(run);
      const text = await run.call('confirm', confirmArgs());
      const sampleUrl = /見本：(http:\/\/127\.0\.0\.1:\d+\/\?k=\S+)/.exec(text)[1];
      assert.equal((await api(url, '/api/state')).status, 200);
      assert.equal((await api(sampleUrl, '/api/state')).status, 200);
      await run.creator.shutdown();
      await assert.rejects(api(url, '/api/state'), /fetch failed/);
      await assert.rejects(api(sampleUrl, '/api/state'), /fetch failed/);
    });
  });
});
