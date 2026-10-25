// 2段目 部品の試験（クリエイターの画面が流用する、ひな形の画面のサーバー）。
// 設計書：generated-plugin-structure.md 9章「クリエイターの画面での流用」。REQ-043（クリエイターの画面は、土台の画面のサーバーを使う）。
// クリエイターの画面は、ひな形の画面のサーバー（template/.../ui/server.mjs）に、自分の部品の置き場所とひな形の部品の置き場所を渡して出す。
// この試験は、クリエイターの試験である（生成プラグインの試験には入れない：REQ-043 は生成プラグインの要件ではない）。
// 実行：node --test "tests/creator/ui-reuse/server-reuse.test.mjs"（外部のパッケージは要らない）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TEMPLATE_UI = path.join(REPO, 'template', 'com.github.copilot', 'extensions', '_plugin_', 'ui');
const { startServer } = await import(pathToFileURL(path.join(TEMPLATE_UI, 'server.mjs')));

const tempDirs = [];
const tempDir = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ui-reuse-')));
  tempDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function get({ port, path: requestPath }) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: requestPath, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      })
      .on('error', reject);
  });
}

test('REQ-043 画面の部品の置き場所を複数にでき、前のものが先に使われる（クリエイターの画面が、自分の部品とひな形の部品を一緒に出すため）', async () => {
  const first = tempDir();
  const second = tempDir();
  fs.writeFileSync(path.join(first, 'index.html'), 'first index');
  fs.writeFileSync(path.join(first, 'app.js'), 'first app');
  fs.writeFileSync(path.join(second, 'index.html'), 'second index');
  fs.writeFileSync(path.join(second, 'render.js'), 'second render');
  const server = await startServer({ preferredPort: 0, staticDir: [first, second] });
  try {
    const read = async (p) => (await get({ port: server.port, path: `${p}?k=${server.token}` })).body;
    assert.equal(await read('/'), 'first index');
    assert.equal(await read('/app.js'), 'first app');
    assert.equal(await read('/render.js'), 'second render');
  } finally {
    await server.close();
  }
});

test('REQ-043 ひな形の描画の部品（render.js）と見た目（style.css）が、画面のサーバーから出る（クリエイターの画面と同じ見た目にするため）', async () => {
  const own = tempDir();
  fs.writeFileSync(path.join(own, 'index.html'), '<!doctype html><title>t</title>');
  const server = await startServer({ preferredPort: 0, staticDir: [own, path.join(TEMPLATE_UI, 'static')] });
  try {
    for (const name of ['render.js', 'style.css']) {
      const response = await get({ port: server.port, path: `/${name}?k=${server.token}` });
      assert.equal(response.status, 200, name);
      assert.ok(response.body.length > 100, name);
    }
    // style.css が読み込む同梱のフォントも、ひな形の置き場所から出る（クリエイターは写しを持たない）
    const font = await get({ port: server.port, path: `/fonts/ibm-plex-sans-jp/IBMPlexSansJP-Regular.woff2?k=${server.token}` });
    assert.equal(font.status, 200, 'フォント');
    assert.equal(font.headers['content-type'], 'font/woff2');
    assert.equal((await get({ port: server.port, path: '/render.js' })).status, 403, '合言葉がなければ、部品も出さない');
  } finally {
    await server.close();
  }
});
