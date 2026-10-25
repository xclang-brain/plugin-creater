// 開発者が答える外側の EVAL で、問いに出た容器の中の画面とファイルを画像にする部品（relay-images.mjs。testing.md 6.7）の試験。
// 実際のモデルは使わない。ブラウザーを起動できないときは、ブラウザーを使う試験を飛ばす。
// 動かし方（リポジトリの根で）：node --test "tests/dev-eval/runner/relay-images.test.mjs"

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { launchBrowser } from '../../../skills/test-plugin/scripts/screen.mjs';
import { answerQuestion, createHumanRelay, listQuestionIds } from './human-relay.mjs';
import { captureLocalImages, findLocalSources } from './relay-images.mjs';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), `relay-images-${prefix}-`));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const isPng = (file) => fs.readFileSync(file).subarray(0, 4).equals(PNG);

async function until(fn, label, ms = 30_000) {
  const started = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - started > ms) throw new Error(`待ちきれませんでした：${label}`);
    await sleep(10);
  }
}

// ブラウザーを起動できるか（できなければ、ブラウザーを使う試験を飛ばす）
let chromium = null;
let skipBrowser = false;
try {
  ({ chromium } = await import('playwright'));
  const { browser } = await launchBrowser(chromium);
  await browser.close();
} catch (error) {
  skipBrowser = `ブラウザーを起動できません（${String(error?.message ?? error).split('\n')[0]}）`;
}

/** 見本の画面に似せた小さな画面。「開始する」で実行中、「止める」で終わった後の表示になる */
const SAMPLE_PAGE = `<!doctype html><meta charset="utf-8"><title>見本</title>
<p id="state">開始前</p>
<button id="start" onclick="document.getElementById('state').textContent='実行中';document.getElementById('stop').hidden=false;this.hidden=true">開始する</button>
<button id="stop" hidden onclick="document.getElementById('state').textContent='終わった後'">止める</button>`;

async function startServer(t) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url.startsWith('/plain') ? '<!doctype html><meta charset="utf-8"><p>ボタンのない画面</p>' : SAMPLE_PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('REQ-015 問いの文から、容器の中の http の URL と、ある .html のファイルを探す（ないファイルと外の URL は除く）', (t) => {
  const work = tmp('find');
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  fs.mkdirSync(path.join(work, 'draft', 'mock'), { recursive: true });
  const preview = path.join(work, 'draft', 'mock', 'preview.html');
  fs.writeFileSync(preview, '<p>見本</p>');
  const other = path.join(work, '別.html');
  fs.writeFileSync(other, '<p>別</p>');
  const bold = path.join(work, 'bold.html');
  fs.writeFileSync(bold, '<p>太字</p>');
  const text = [
    'ブラウザーで開いて見てください：http://127.0.0.1:40711/?k=HMi-dC74SQtQF7YdyeO_7cQ554ZEKCBV',
    '（見本：http://127.0.0.1:40711/?k=HMi-dC74SQtQF7YdyeO_7cQ554ZEKCBV ）', // 同じ URL は 1 つにする
    'もう一つ http://localhost:8080/page.html。',
    `次のファイルを開くと見られます。\`${preview}\``,
    '見本はdraft/mock/preview.html です', // 作業フォルダからの場所。上と同じファイルなので 1 つにする
    `${pathToFileURL(other).href}`,
    `太字で書いた場所：**${bold}**、角括弧の中：[draft/mock/preview.html]`, // Markdown の印は場所に含めない
    'ないファイル missing.html、外の URL https://example.com/a.html、IP 127.0.0.1',
  ].join('\n');
  const found = findLocalSources(text, { baseDir: work });
  assert.deepEqual(found.map((f) => [f.kind, f.source]), [
    ['url', 'http://127.0.0.1:40711/?k=HMi-dC74SQtQF7YdyeO_7cQ554ZEKCBV'],
    ['url', 'http://localhost:8080/page.html'],
    ['file', preview],
    ['file', pathToFileURL(other).href],
    ['file', bold],
  ]);
  assert.equal(found[2].target, pathToFileURL(preview).href);
  // 作業フォルダが分からないときは、相対の場所を探さない
  assert.deepEqual(findLocalSources('draft/mock/preview.html'), []);
});

test('REQ-015 中継：問いか問いの前の文に容器の中の画面が出たら、画像の場所と写せなかった理由を問いのファイルに書く。出なければ書かない', async (t) => {
  const relayDir = tmp('relay');
  t.after(() => fs.rmSync(relayDir, { recursive: true, force: true }));
  const calls = [];
  const captureImages = async (args) => {
    calls.push(args);
    const text = args.texts.join('\n');
    if (text.includes('落ちる')) throw new Error('ブラウザーが落ちました');
    const sources = findLocalSources(text);
    return {
      sources,
      images: sources.map((s) => ({ source: s.source, view: 'page', path: path.join(args.outDir, `${args.id}-1.png`) })),
      errors: [{ source: 'http://127.0.0.1:2/', error: '写せませんでした：つながりません' }],
    };
  };
  const relay = createHumanRelay({ relayDir, pollMs: 5, workDir: '/run/work', heartbeatMs: 0, captureImages });

  const first = relay.answer('この画面でよいですか？', ['はい', 'いいえ'], 'AskUserQuestion', { header: '画面' }, ['ブラウザーで開いて見てください：http://127.0.0.1:1/?k=abc']);
  await until(() => listQuestionIds(relayDir).length === 1, '1 つ目の問い');
  const q1 = JSON.parse(fs.readFileSync(path.join(relayDir, 'questions', '0001.json'), 'utf8'));
  assert.deepEqual(q1.images, [{ source: 'http://127.0.0.1:1/?k=abc', view: 'page', path: path.join(relayDir, 'images', '0001-1.png') }]);
  assert.deepEqual(q1.imageErrors, [{ source: 'http://127.0.0.1:2/', error: '写せませんでした：つながりません' }]);
  assert.deepEqual(calls[0].texts, ['この画面でよいですか？', 'ブラウザーで開いて見てください：http://127.0.0.1:1/?k=abc']);
  assert.equal(calls[0].baseDir, '/run/work');
  answerQuestion(relayDir, '0001', 'はい');
  assert.equal((await first).answer, 'はい');

  // 写す関数が落ちても、問いは中継し、理由を残す
  const second = relay.answer('落ちる画面 http://127.0.0.1:3/ はどうですか？', [], 'text');
  await until(() => listQuestionIds(relayDir).length === 2, '2 つ目の問い');
  const q2 = JSON.parse(fs.readFileSync(path.join(relayDir, 'questions', '0002.json'), 'utf8'));
  assert.deepEqual(q2.images, []);
  assert.match(q2.imageErrors[0].error, /ブラウザーが落ちました/);
  answerQuestion(relayDir, '0002', 'よい');
  await second;

  // 容器の中の画面が出ない問いには、images も imageErrors も書かない
  const third = relay.answer('名前は？', [], 'text');
  await until(() => listQuestionIds(relayDir).length === 3, '3 つ目の問い');
  const q3 = JSON.parse(fs.readFileSync(path.join(relayDir, 'questions', '0003.json'), 'utf8'));
  assert.equal('images' in q3, false);
  assert.equal('imageErrors' in q3, false);
  answerQuestion(relayDir, '0003', 'なまえ');
  await third;
  relay.finish({ reason: 'generated' });
});

test('REQ-015 画面の URL は、ページ全体と、「開始する」の後の実行中と、「止める」の後を写す。ボタンのない画面とファイルは 1 枚', { skip: skipBrowser }, async (t) => {
  const base = await startServer(t);
  const work = tmp('shots');
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  fs.writeFileSync(path.join(work, 'preview.html'), '<!doctype html><meta charset="utf-8"><p>図の見本</p>');
  const outDir = path.join(work, 'images');
  const r = await captureLocalImages({
    texts: [`見本：${base}/?k=abc`, `ボタンなし：${base}/plain`, '次のファイルを開いてください：preview.html'],
    outDir,
    id: '0007',
    baseDir: work,
    chromium,
  });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.images.map((i) => [i.source, i.view, path.basename(i.path)]), [
    [`${base}/?k=abc`, 'page', '0007-1.png'],
    [`${base}/?k=abc`, 'running', '0007-1-running.png'],
    [`${base}/?k=abc`, 'finished', '0007-1-finished.png'],
    [`${base}/plain`, 'page', '0007-2.png'],
    ['preview.html', 'page', '0007-3.png'],
  ]);
  for (const image of r.images) assert.ok(isPng(image.path), image.path);
});

test('REQ-015 写せない URL は、理由を残して返す（例外を投げない）。中継を通しても問いは届く', { skip: skipBrowser }, async (t) => {
  const relayDir = tmp('fail');
  t.after(() => fs.rmSync(relayDir, { recursive: true, force: true }));
  // 閉じたポート：一度開いて、閉じた番号を使う
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));

  const relay = createHumanRelay({ relayDir, pollMs: 5, heartbeatMs: 0 });
  const pending = relay.answer(`画面 http://127.0.0.1:${port}/?k=x を見てください。よいですか？`, [], 'text');
  await until(() => listQuestionIds(relayDir).length === 1, '問い', 60_000);
  const q = JSON.parse(fs.readFileSync(path.join(relayDir, 'questions', '0001.json'), 'utf8'));
  assert.deepEqual(q.images, []);
  assert.equal(q.imageErrors.length, 1);
  assert.equal(q.imageErrors[0].source, `http://127.0.0.1:${port}/?k=x`);
  assert.match(q.imageErrors[0].error, /写せませんでした/);
  answerQuestion(relayDir, '0001', 'よい');
  assert.equal((await pending).answer, 'よい');
  relay.finish({ reason: 'generated' });
});
