// 2段目 部品の試験（サーバー）。画面のサーバー（ui/server.mjs）と、窓口の配線（ui/app.mjs）を試す。
// 設計書：generated-plugin-structure.md 10章「2段目 部品の試験（サーバー）」。
// gh での起票そのものは、中心の処理の試験で確かめる（ここでは、承認の窓口が中心の処理に届くことまで）。
// 実行：node --test tests/stage2/ui/server.test.mjs（外部の npm パッケージは要らない）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SAMPLE_TASK, createFakeCore, finishedState, locateUi, prepState } from './fake-core.mjs';

const { uiDir } = locateUi();
const { startServer, serveFile, HttpError, Reply } = await import(pathToFileURL(path.join(uiDir, 'server.mjs')));
const { startApp } = await import(pathToFileURL(path.join(uiDir, 'app.mjs')));

// ---- 道具 ----------------------------------------------------------------

const tempDirs = [];
function tempDir(prefix = 'ui-server-test-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Host を決めて問い合わせる（fetch は Host を変えられないので node:http を使う） */
function raw({ port, path: requestPath = '/', method = 'GET', host, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: requestPath, method, headers: { Host: host ?? `127.0.0.1:${port}`, ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const json = (response) => JSON.parse(response.body.toString('utf8'));

/** 接続できるか。できなければ false（拒まれた、アドレスがない、時間切れ） */
function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 1500 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

function listenOn(host, port = 0) {
  return new Promise((resolve, reject) => {
    const blocker = net.createServer();
    blocker.once('error', reject);
    blocker.listen({ host, port }, () => resolve(blocker));
  });
}

const closeNet = (server) => new Promise((resolve) => server.close(() => resolve()));

function staticFixture() {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>t</title><script src="app.js?k=%%K%%"></script>');
  fs.writeFileSync(path.join(dir, 'app.js'), 'window.x = 1;');
  fs.writeFileSync(path.join(dir, 'style.css'), 'body { color: black; }');
  return dir;
}

async function withServer(options, body) {
  const server = await startServer({ preferredPort: 0, ...options });
  try {
    return await body(server);
  } finally {
    await server.close();
  }
}

// ---- 接続の制限 ---------------------------------------------------------------

describe('接続の制限（REQ-006）', () => {
  test('REQ-006 127.0.0.1 だけで待ち受ける（ほかのアドレスからは開けない）', async () => {
    await withServer({}, async ({ port }) => {
      assert.equal(await canConnect('127.0.0.1', port), true, '127.0.0.1 では開ける');
      // 同じマシンの別のアドレス：0.0.0.0 で待ち受けていれば、どれも開いてしまう
      assert.equal(await canConnect('127.0.0.2', port), false, '127.0.0.2 では開けない');
      assert.equal(await canConnect('::1', port), false, '::1 では開けない');
      for (const list of Object.values(os.networkInterfaces())) {
        for (const address of list ?? []) {
          if (address.family === 'IPv4' && !address.internal) {
            assert.equal(await canConnect(address.address, port), false, `${address.address}（ほかのマシンから見えるアドレス）では開けない`);
          }
        }
      }
    });
  });

  test('REQ-006 合言葉がない・違う問い合わせを、どの窓口でも断る', async () => {
    const routes = { 'GET /api/state': () => ({ ok: true }), 'POST /api/start': () => ({ ok: true }) };
    await withServer({ staticDir: staticFixture(), routes }, async ({ port, token }) => {
      for (const [method, p] of [['GET', '/api/state'], ['POST', '/api/start'], ['GET', '/'], ['GET', '/app.js'], ['GET', '/no-such-file']]) {
        for (const query of ['', '?k=', '?k=wrong', `?k=${token}x`, `?k=${token.slice(1)}`, `?K=${token}`, `?kk=${token}`]) {
          const response = await raw({ port, path: p + query, method, body: method === 'POST' ? '{}' : undefined });
          assert.equal(response.status, 403, `${method} ${p}${query} は断られる`);
          assert.ok(!response.body.toString('utf8').includes(token), '断る応答に合言葉を入れない');
        }
      }
      // 合言葉が合えば通る
      assert.equal((await raw({ port, path: `/api/state?k=${token}` })).status, 200);
      assert.equal((await raw({ port, path: `/api/start?k=${token}`, method: 'POST', body: '{}' })).status, 200);
    });
  });

  test('REQ-006 問い合わせ先の名前（Host）が違う問い合わせを断る', async () => {
    const routes = { 'GET /api/state': () => ({ ok: true }) };
    await withServer({ routes }, async ({ port, token }) => {
      const ask = (host) => raw({ port, path: `/api/state?k=${token}`, host });
      assert.equal((await ask(`127.0.0.1:${port}`)).status, 200);
      assert.equal((await ask(`localhost:${port}`)).status, 200);
      assert.equal((await ask(`LOCALHOST:${port}`)).status, 200, '大文字小文字は区別しない');
      for (const host of [
        `evil.example:${port}`,
        `evil.example`,
        `127.0.0.1.evil.example:${port}`,
        `localhost.evil.example:${port}`,
        `127.0.0.1:${port + 1}`,
        `localhost:${port + 1}`,
        '127.0.0.1',
        `0.0.0.0:${port}`,
        `[::1]:${port}`,
      ]) {
        assert.equal((await ask(host)).status, 403, `Host: ${host} は断られる`);
      }
    });
  });

  test('REQ-006 Host のない古い形式の問い合わせも断る', async () => {
    await withServer({ routes: { 'GET /api/state': () => ({ ok: true }) } }, async ({ port, token }) => {
      const reply = await new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1');
        const chunks = [];
        socket.on('data', (chunk) => chunks.push(chunk));
        socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
        socket.on('error', reject);
        socket.write(`GET /api/state?k=${token} HTTP/1.0\r\n\r\n`);
      });
      assert.match(reply, /^HTTP\/1\.[01] 403 /);
    });
  });

  test('REQ-006 合言葉は起動ごとに違い、URL に入る', async () => {
    const a = await startServer({});
    const b = await startServer({});
    try {
      assert.notEqual(a.token, b.token);
      for (const server of [a, b]) {
        assert.ok(server.token.length >= 32, '推測できない長さ');
        assert.equal(server.url, `http://127.0.0.1:${server.port}/?k=${server.token}`);
      }
    } finally {
      await a.close();
      await b.close();
    }
  });

  test('REQ-006 起動したときに onListen で URL が分かる', async () => {
    let heard;
    await withServer({ onListen: (info) => (heard = info) }, async (server) => {
      assert.deepEqual(heard, { url: server.url, port: server.port, token: server.token });
    });
  });
});

// ---- 起動と終了 ---------------------------------------------------------------

describe('サーバーの起動と終了（REQ-029）', () => {
  test('REQ-029 いつもの番号が空いていれば、その番号で起動する', async () => {
    const probe = await listenOn('127.0.0.1');
    const free = probe.address().port;
    await closeNet(probe);
    await withServer({ preferredPort: free }, async ({ port }) => assert.equal(port, free));
  });

  for (const host of ['127.0.0.1', '0.0.0.0']) {
    test(`REQ-029 いつもの番号をほかのプログラム（${host}）が使っていても、別の番号で起動し、その URL で開ける`, async () => {
      const blocker = await listenOn(host);
      const busy = blocker.address().port;
      try {
        await withServer({ preferredPort: busy, routes: { 'GET /api/state': () => ({ ok: true }) } }, async ({ port, url, token }) => {
          assert.notEqual(port, busy);
          assert.ok(url.includes(`:${port}/`), '示す URL は、実際の番号');
          const response = await fetch(`http://127.0.0.1:${port}/api/state?k=${token}`);
          assert.equal(response.status, 200);
        });
      } finally {
        await closeNet(blocker);
      }
    });
  }

  test('REQ-029 終わる（close）と、待ち受けが止まり、プロセスが残らない。2回呼んでもよい', async () => {
    const server = await startServer({ routes: { 'GET /api/state': () => ({ ok: true }) } });
    // つなぎっぱなしの接続があっても終われる
    const idle = net.connect(server.port, '127.0.0.1');
    await new Promise((resolve) => idle.once('connect', resolve));
    await server.close();
    await server.close();
    assert.equal(await canConnect('127.0.0.1', server.port), false);
    idle.destroy();
  });
});

// ---- 応答の決まり -------------------------------------------------------------

describe('応答の決まり（REQ-006）', () => {
  test('REQ-006 どの応答にも、自分のスクリプトだけを動かす指定（CSP）と nosniff が付く', async () => {
    const routes = {
      'GET /api/state': () => ({ ok: true }),
      'POST /api/start': () => ({ ok: true }),
      'GET /api/boom': () => {
        throw new Error('内部の事情');
      },
      'GET /api/refuse': () => {
        throw new HttpError(409, '断ります');
      },
    };
    await withServer({ staticDir: staticFixture(), routes }, async ({ port, token }) => {
      const requests = [
        ['GET', `/?k=${token}`, 200],
        ['GET', `/app.js?k=${token}`, 200],
        ['GET', `/style.css?k=${token}`, 200],
        ['GET', `/api/state?k=${token}`, 200],
        ['POST', `/api/start?k=${token}`, 200],
        ['GET', `/api/boom?k=${token}`, 500],
        ['GET', `/api/refuse?k=${token}`, 409],
        ['GET', `/nothing?k=${token}`, 404],
        ['GET', '/api/state', 403],
        ['GET', `/api/state?k=${token}`, 200],
      ];
      for (const [method, p, status] of requests) {
        const response = await raw({ port, path: p, method, body: method === 'POST' ? '{}' : undefined });
        assert.equal(response.status, status, `${method} ${p}`);
        const csp = response.headers['content-security-policy'] ?? '';
        assert.match(csp, /script-src 'self'/, `${method} ${p} の CSP`);
        assert.match(csp, /default-src 'none'/);
        assert.match(csp, /font-src 'self'/, `${method} ${p} の CSP（フォントは自分のサーバーのものだけ）`);
        assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'), 'インラインのスクリプトを許さない');
        assert.equal(response.headers['x-content-type-options'], 'nosniff', `${method} ${p} の nosniff`);
      }
    });
  });

  test('REQ-006 Host が違う問い合わせの断りにも、CSP と nosniff が付く', async () => {
    await withServer({}, async ({ port, token }) => {
      const response = await raw({ port, path: `/?k=${token}`, host: 'evil.example' });
      assert.equal(response.status, 403);
      assert.match(response.headers['content-security-policy'], /script-src 'self'/);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
    });
  });

  test('REQ-006 合言葉の入った URL を、ほかのページへ漏らさない（Referrer-Policy）', async () => {
    await withServer({ staticDir: staticFixture() }, async ({ port, token }) => {
      const response = await raw({ port, path: `/?k=${token}` });
      assert.equal(response.headers['referrer-policy'], 'no-referrer');
      assert.equal(response.headers['cache-control'], 'no-store');
    });
  });
});

// ---- 窓口（routes）の決まり ---------------------------------------------------------

describe('窓口の使い方', () => {
  test('REQ-005 パスの :名前、問い合わせの値、JSON の本文が、関数に渡る（合言葉は渡さない）', async () => {
    let seen;
    const routes = {
      'POST /api/issues/:id/file': (req, body) => {
        seen = { params: req.params, query: req.query, body, method: req.method };
        return { received: body };
      },
    };
    await withServer({ routes }, async ({ port, token }) => {
      const response = await raw({
        port,
        path: `/api/issues/${encodeURIComponent('run 1/案#1')}/file?k=${token}&x=1`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ a: [1, 2], b: '日本語' }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(json(response), { received: { a: [1, 2], b: '日本語' } });
      assert.deepEqual(seen, { params: { id: 'run 1/案#1' }, query: { x: '1' }, body: { a: [1, 2], b: '日本語' }, method: 'POST' });
    });
  });

  test('REQ-005 作っていない窓口と、違う種類の問い合わせは 404', async () => {
    await withServer({ routes: { 'GET /api/state': () => ({}), 'POST /api/stop': () => ({}) } }, async ({ port, token }) => {
      assert.equal((await raw({ port, path: `/api/stop?k=${token}` })).status, 404);
      assert.equal((await raw({ port, path: `/api/state?k=${token}`, method: 'POST', body: '{}' })).status, 404);
      assert.equal((await raw({ port, path: `/api/other?k=${token}` })).status, 404);
      assert.equal((await raw({ port, path: `/api/state?k=${token}`, method: 'DELETE' })).status, 404);
    });
  });

  test('REQ-006 壊れた本文は 400、大きすぎる本文は 413、内部の失敗は中身を見せない 500', async () => {
    const routes = {
      'POST /api/start': () => ({ ok: true }),
      'GET /api/boom': () => {
        throw new Error('秘密の内部事情 /home/user/secret');
      },
    };
    await withServer({ routes }, async ({ port, token }) => {
      const broken = await raw({ port, path: `/api/start?k=${token}`, method: 'POST', body: '{not json' });
      assert.equal(broken.status, 400);
      assert.ok(json(broken).error);
      const big = await raw({ port, path: `/api/start?k=${token}`, method: 'POST', body: JSON.stringify({ x: 'a'.repeat(1024 * 1024 + 10) }) });
      assert.equal(big.status, 413);
      const boom = await raw({ port, path: `/api/boom?k=${token}` });
      assert.equal(boom.status, 500);
      assert.ok(!boom.body.toString('utf8').includes('秘密'), '内部の事情を返さない');
      const empty = await raw({ port, path: `/api/start?k=${token}`, method: 'POST' });
      assert.equal(empty.status, 200, '本文がなくても受け付ける');
    });
  });

  test('REQ-005 HttpError は、その状態の番号と平易な文で返り、Reply はそのまま返る', async () => {
    const routes = {
      'GET /api/refuse': () => {
        throw new HttpError(409, 'もう始まっています');
      },
      'GET /api/raw': () => new Reply({ status: 201, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Test': 'yes' }, body: 'こんにちは' }),
    };
    await withServer({ routes }, async ({ port, token }) => {
      const refused = await raw({ port, path: `/api/refuse?k=${token}` });
      assert.equal(refused.status, 409);
      assert.deepEqual(json(refused), { error: 'もう始まっています' });
      const rawReply = await raw({ port, path: `/api/raw?k=${token}` });
      assert.equal(rawReply.status, 201);
      assert.equal(rawReply.headers['x-test'], 'yes');
      assert.equal(rawReply.body.toString('utf8'), 'こんにちは');
    });
  });
});

// ---- 画面の部品（静的ファイル） ------------------------------------------------------

describe('画面の部品の窓口', () => {
  test('REQ-006 最初のページの合言葉の差し込み口が、今の合言葉になる。部品の問い合わせにも合言葉が付く', async () => {
    await withServer({ staticDir: staticFixture() }, async ({ port, token }) => {
      const page = await raw({ port, path: `/?k=${token}` });
      assert.equal(page.status, 200);
      assert.match(page.headers['content-type'], /text\/html/);
      const html = page.body.toString('utf8');
      assert.ok(!html.includes('%%K%%'));
      assert.ok(html.includes(`app.js?k=${token}`));
      const script = await raw({ port, path: `/app.js?k=${token}` });
      assert.match(script.headers['content-type'], /javascript/);
      const css = await raw({ port, path: `/style.css?k=${token}` });
      assert.match(css.headers['content-type'], /text\/css/);
    });
  });

  test('REQ-030 入れ子のフォルダのフォントが、font/woff2 の種類で、バイトのまま出る。CSS の中の合言葉の差し込み口は、今の合言葉になる', async () => {
    const dir = staticFixture();
    fs.writeFileSync(path.join(dir, 'style.css'), "@font-face { font-family: 'X'; src: url('fonts/x/X-Regular.woff2?k=%%K%%') format('woff2'); }");
    fs.mkdirSync(path.join(dir, 'fonts', 'x'), { recursive: true });
    // フォントの中に、差し込み口と同じ並びや、UTF-8 として読めないバイトがあっても、変えずに返す
    const font = Buffer.concat([Buffer.from('wOF2'), Buffer.from([0, 0xff, 0xfe, 0x80]), Buffer.from('%%K%%'), Buffer.from([0xc3, 0x28])]);
    fs.writeFileSync(path.join(dir, 'fonts', 'x', 'X-Regular.woff2'), font);
    await withServer({ staticDir: dir }, async ({ port, token }) => {
      const css = await raw({ port, path: `/style.css?k=${token}` });
      assert.equal(css.status, 200);
      assert.equal(css.body.toString('utf8'), `@font-face { font-family: 'X'; src: url('fonts/x/X-Regular.woff2?k=${token}') format('woff2'); }`);
      const response = await raw({ port, path: `/fonts/x/X-Regular.woff2?k=${token}` });
      assert.equal(response.status, 200);
      assert.equal(response.headers['content-type'], 'font/woff2');
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.match(response.headers['content-security-policy'], /font-src 'self'/);
      assert.ok(response.body.equals(font), 'バイトが変わっている');
      // 合言葉がなければ、フォントも出さない
      assert.equal((await raw({ port, path: '/fonts/x/X-Regular.woff2' })).status, 403);
      // フォルダそのものは出さない
      for (const p of ['/fonts', '/fonts/', '/fonts/x', '/fonts/x/']) {
        assert.equal((await raw({ port, path: `${p}?k=${token}` })).status, 404, p);
      }
    });
  });

  test('REQ-006 画面の部品の置き場所の外のファイルは出さない', async () => {
    const parent = tempDir();
    fs.writeFileSync(path.join(parent, 'secret.txt'), 'secret');
    const dir = path.join(parent, 'static');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'index.html'), 'ok');
    fs.mkdirSync(path.join(dir, 'fonts', 'x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'fonts', 'x', 'a.woff2'), 'font');
    await withServer({ staticDir: dir }, async ({ port, token }) => {
      const nested = ['/fonts/../../secret.txt', '/fonts/x/../../../secret.txt', '/fonts/%2e%2e/%2e%2e/secret.txt', '/fonts/..%2f..%2fsecret.txt', '/fonts/x/%2e%2e%2f%2e%2e%2f%2e%2e%2fsecret.txt', '/fonts/./x/a.woff2', '/fonts//x/a.woff2', '/fonts\\..\\..\\secret.txt'];
      for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/static/../../secret.txt', '/%00', '/a\\..\\secret.txt', '//secret.txt', `/${dir}/index.html`, ...nested]) {
        const response = await raw({ port, path: `${p}?k=${token}` });
        assert.ok([400, 404].includes(response.status), `${p} は出さない（${response.status}）`);
        assert.ok(!response.body.toString('utf8').includes('secret'));
      }
    });
  });
});

// ---- ファイルの窓口 ------------------------------------------------------------

describe('ファイルの窓口（REQ-006、REQ-031）', () => {
  let work;
  let outside;
  let server;
  const ids = {};
  let symlinksWork = true;

  before(async () => {
    work = tempDir('ui-work-');
    outside = tempDir('ui-outside-');
    fs.writeFileSync(path.join(work, 'chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(work, 'photo.jpg'), 'jpeg');
    fs.writeFileSync(path.join(work, 'photo.jpeg'), 'jpeg');
    fs.writeFileSync(path.join(work, 'anim.gif'), 'gif');
    fs.writeFileSync(path.join(work, 'pic.webp'), 'webp');
    fs.writeFileSync(path.join(work, 'UPPER.PNG'), 'png');
    fs.writeFileSync(path.join(work, 'vector.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    fs.writeFileSync(path.join(work, 'page.html'), '<script>alert(1)</script>');
    fs.writeFileSync(path.join(work, 'notes.txt'), 'メモ');
    fs.writeFileSync(path.join(work, 'noext'), 'x');
    fs.writeFileSync(path.join(work, '週報 (1).md'), '# 週報');
    fs.mkdirSync(path.join(work, 'sub'));
    fs.writeFileSync(path.join(work, 'sub', 'inner.png'), 'png');
    fs.writeFileSync(path.join(outside, 'secret.png'), 'secret');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    try {
      fs.symlinkSync(path.join(outside, 'secret.png'), path.join(work, 'link-out.png'));
      fs.symlinkSync(outside, path.join(work, 'link-dir'));
      fs.symlinkSync(path.join(work, 'sub', 'inner.png'), path.join(work, 'link-in.png'));
      fs.symlinkSync(path.join(work, 'page.html'), path.join(work, 'disguised.png'));
    } catch {
      symlinksWork = false;
    }
    Object.assign(ids, {
      png: 'chart.png',
      jpg: 'photo.jpg',
      jpeg: 'photo.jpeg',
      gif: 'anim.gif',
      webp: 'pic.webp',
      upper: 'UPPER.PNG',
      svg: 'vector.svg',
      html: 'page.html',
      txt: 'notes.txt',
      noext: 'noext',
      japanese: '週報 (1).md',
      sub: 'sub/inner.png',
      dir: 'sub',
      missing: 'missing.png',
      parent: `../${path.basename(outside)}/secret.png`,
      absolute: path.join(outside, 'secret.png'),
      absoluteInside: path.join(work, 'chart.png'),
      linkOut: 'link-out.png',
      linkDir: 'link-dir/secret.txt',
      linkIn: 'link-in.png',
      disguised: 'disguised.png',
    });
    // 知らされたファイルの番号と場所の表（本物では、記録のツールで知らされたもの）
    server = await startServer({
      routes: {
        'GET /api/files/:id': async ({ params }) => {
          const entry = ids[params.id];
          if (!entry) throw new HttpError(404, 'ファイルが見つかりません');
          return serveFile({ path: entry, root: work, name: params.id === 'japanese' ? '週報 (1).md' : undefined });
        },
      },
    });
  });
  after(async () => {
    await server.close();
  });

  const fetchFile = (id) => raw({ port: server.port, path: `/api/files/${id}?k=${server.token}` });

  test('REQ-006 知らされていないファイルの番号は出さない', async () => {
    assert.equal((await fetchFile('nothing')).status, 404);
    assert.equal((await fetchFile('..%2F..%2Fetc%2Fpasswd')).status, 404);
  });

  for (const [id, type] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'], ['webp', 'image/webp'], ['upper', 'image/png'], ['sub', 'image/png']]) {
    test(`REQ-031 作業フォルダの中の ${id} は画像として返る`, async () => {
      const response = await fetchFile(id);
      assert.equal(response.status, 200);
      assert.equal(response.headers['content-type'], type);
      assert.ok(!response.headers['content-disposition'], '画像はダウンロードの形にしない');
    });
  }

  for (const id of ['svg', 'html', 'txt', 'noext', 'japanese']) {
    test(`REQ-006 ${id} は画像として出さず、ダウンロードさせる形で返す`, async () => {
      const response = await fetchFile(id);
      assert.equal(response.status, 200);
      assert.equal(response.headers['content-type'], 'application/octet-stream');
      assert.match(response.headers['content-disposition'], /^attachment/);
    });
  }

  test('REQ-006 ダウンロードの名前に日本語があっても、ヘッダーを壊さず、名前が伝わる', async () => {
    const response = await fetchFile('japanese');
    assert.match(response.headers['content-disposition'], /filename\*=UTF-8''%E9%80%B1%E5%A0%B1%20%281%29\.md/);
  });

  test('REQ-006 どのファイルにも、スクリプトを動かさない指定（Content-Security-Policy: sandbox と nosniff）が付く', async () => {
    for (const id of ['png', 'jpg', 'gif', 'webp', 'svg', 'html', 'txt', 'sub']) {
      const response = await fetchFile(id);
      assert.equal(response.headers['content-security-policy'], 'sandbox', id);
      assert.equal(response.headers['x-content-type-options'], 'nosniff', id);
    }
  });

  test('REQ-006 作業フォルダの外のファイルと、ファイルでないものは出さない', async () => {
    for (const id of ['parent', 'absolute', 'dir', 'missing']) {
      assert.equal((await fetchFile(id)).status, 404, id);
    }
  });

  test('REQ-006 作業フォルダの中を指す絶対の場所は出せる', async () => {
    assert.equal((await fetchFile('absoluteInside')).status, 200);
  });

  test('REQ-006 外を指すシンボリックリンク（ファイルでもフォルダでも）は出さない', async (t) => {
    if (!symlinksWork) return t.skip('シンボリックリンクを作れない環境');
    for (const id of ['linkOut', 'linkDir']) {
      const response = await fetchFile(id);
      assert.equal(response.status, 404, id);
      assert.ok(!response.body.toString('utf8').includes('secret'));
    }
  });

  test('REQ-006 中を指すシンボリックリンクは出せる。画像の名前でも、本当のファイルが HTML ならダウンロードの形にする', async (t) => {
    if (!symlinksWork) return t.skip('シンボリックリンクを作れない環境');
    const inside = await fetchFile('linkIn');
    assert.equal(inside.status, 200);
    assert.equal(inside.headers['content-type'], 'image/png');
    const disguised = await fetchFile('disguised');
    assert.equal(disguised.status, 200);
    assert.equal(disguised.headers['content-type'], 'application/octet-stream');
    assert.match(disguised.headers['content-disposition'], /^attachment/);
  });

  test('REQ-006 serveFile は、作業フォルダそのものや、存在しない作業フォルダでも安全に断る', async () => {
    await assert.rejects(serveFile({ path: '.', root: work }), (e) => e instanceof HttpError && e.status === 404);
    await assert.rejects(serveFile({ path: 'chart.png', root: path.join(work, 'no-such-root') }), (e) => e instanceof HttpError && e.status === 404);
  });
});

// ---- 生成プラグインの窓口の配線（app.mjs） ------------------------------------------------

describe('生成プラグインの窓口（app.mjs。設計書 6.3 の窓口の表）', () => {
  let work;
  let outside;
  let core;
  let app;
  const call = (p, options = {}) => fetch(`http://127.0.0.1:${app.port}${p}${p.includes('?') ? '&' : '?'}k=${app.token}`, options);
  const post = (p, body = {}) => call(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  before(async () => {
    work = tempDir('ui-app-work-');
    outside = tempDir('ui-app-outside-');
    fs.writeFileSync(path.join(work, 'chart.png'), 'png');
    fs.writeFileSync(path.join(work, 'report.md'), '# 週報');
    fs.writeFileSync(path.join(outside, 'secret.png'), 'secret');
    core = createFakeCore(finishedState());
    core.replies['ag-work'] = '最後の返事の全文';
    core.files = {
      f1: { path: 'chart.png', name: 'chart.png' },
      f2: { path: path.join(work, 'report.md'), name: '週報.md' },
      f3: { path: path.join(outside, 'secret.png'), name: 'secret.png' },
      f4: path.join(work, 'chart.png'),
    };
    app = await startApp({ core, cwd: work, preferredPort: 0 });
  });
  after(async () => {
    await app.close();
  });

  test('REQ-029 いつもの番号が空いていなくても起動し、示す URL で状態が取れる', async () => {
    const blocker = await listenOn('127.0.0.1');
    try {
      const other = await startApp({ core, cwd: work, preferredPort: blocker.address().port });
      try {
        assert.notEqual(other.port, blocker.address().port);
        const response = await fetch(`http://127.0.0.1:${other.port}/api/state?k=${other.token}`);
        assert.equal(response.status, 200);
      } finally {
        await other.close();
      }
    } finally {
      await closeNet(blocker);
    }
  });

  test('REQ-005 GET /api/state は、中心の処理の状態の全体を返し、画面が読む taskDisplays に、状態の setup.taskDisplays を写す', async () => {
    const state = await (await call('/api/state')).json();
    const expected = core.getState();
    assert.equal(state.version, expected.version);
    assert.equal(state.plugin.title, SAMPLE_TASK.name);
    assert.equal(state.run.status, 'finished');
    assert.deepEqual(state.taskDisplays, SAMPLE_TASK.displays);
    assert.deepEqual(state.taskDisplays, expected.setup.taskDisplays);
  });

  test('REQ-005 状態に setup.taskDisplays がなくても状態は返る（表示の定義は空。task.json を読みに行かない）', async () => {
    const own = createFakeCore(prepState());
    own.set((state) => {
      delete state.setup.taskDisplays;
      return state;
    });
    const other = await startApp({ core: own, cwd: work, preferredPort: 0 });
    try {
      const state = await (await fetch(`http://127.0.0.1:${other.port}/api/state?k=${other.token}`)).json();
      assert.deepEqual(state.taskDisplays, []);
    } finally {
      await other.close();
    }
  });

  test('REQ-005 index.html が配られ、画面の部品（render.js、app.js、style.css）に合言葉が付いている', async () => {
    const html = await (await call('/')).text();
    for (const name of ['render.js', 'app.js', 'style.css']) assert.ok(html.includes(`${name}?k=${app.token}`), name);
    for (const name of ['render.js', 'app.js', 'style.css']) assert.equal((await call(`/${name}`)).status, 200, name);
    assert.equal((await fetch(`http://127.0.0.1:${app.port}/app.js`)).status, 403);
  });

  test('REQ-030 style.css が使う同梱のフォントが、font/woff2 の種類で出る（中身はファイルのまま）', async () => {
    const css = await (await call('/style.css')).text();
    assert.ok(!css.includes('%%K%%'), 'CSS の中に差し込み口が残っている');
    const urls = [...css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1]);
    assert.ok(urls.length >= 2, 'フォントを読み込んでいない');
    for (const url of urls) {
      const [file, query] = url.split('?');
      assert.equal(query, `k=${app.token}`, `${url} に今の合言葉が付いていない`);
      const response = await fetch(`http://127.0.0.1:${app.port}/${url}`);
      assert.equal(response.status, 200, url);
      assert.equal(response.headers.get('content-type'), 'font/woff2', url);
      const body = Buffer.from(await response.arrayBuffer());
      assert.ok(body.equals(fs.readFileSync(path.join(uiDir, 'static', ...file.split('/')))), `${url} の中身がファイルと違う`);
    }
  });

  test('REQ-005 POST /api/start は、画面から送った設定をそのまま中心の処理に渡す（1回の送信で1回）', async () => {
    const settings = { models: { orchestrator: 'a', worker: 'b', verifier: 'c' }, maxIterations: 2, task: { week: '2026-W42', items: 7, attach: true } };
    const before = core.callsOf('start').length;
    const response = await post('/api/start', settings);
    assert.equal(response.status, 200);
    const calls = core.callsOf('start');
    assert.equal(calls.length, before + 1);
    assert.deepEqual(calls.at(-1).args[0], settings);
  });

  test('REQ-007 中心の処理が開始を断ると、その文が 400 で返る', async () => {
    core.refusals.start = new Error('選んだモデルが使えません');
    try {
      const response = await post('/api/start', {});
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: '選んだモデルが使えません' });
    } finally {
      delete core.refusals.start;
    }
  });

  test('REQ-009 POST /api/stop は中心の処理の stop を呼ぶ', async () => {
    const before = core.callsOf('stop').length;
    assert.equal((await post('/api/stop')).status, 200);
    assert.equal(core.callsOf('stop').length, before + 1);
  });

  test('REQ-014 POST /api/issues/<番号>/file は、その案の番号で中心の処理の fileIssue を呼ぶ。断られたら文が返る', async () => {
    const before = core.callsOf('fileIssue').length;
    assert.equal((await post(`/api/issues/${encodeURIComponent('run-1/案 1')}/file`)).status, 200);
    assert.deepEqual(core.callsOf('fileIssue').at(-1).args, ['run-1/案 1']);
    assert.equal(core.callsOf('fileIssue').length, before + 1);
    core.refusals.fileIssue = new Error('起票できません');
    try {
      const response = await post('/api/issues/i1/file');
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: '起票できません' });
    } finally {
      delete core.refusals.fileIssue;
    }
  });

  test('REQ-012 GET /api/agents/<番号>/reply は最後の返事の全文を返す。ないときは 404', async () => {
    assert.deepEqual(await (await call('/api/agents/ag-work/reply')).json(), { text: '最後の返事の全文' });
    assert.equal((await call('/api/agents/ag-none/reply')).status, 404);
  });

  test('REQ-031 GET /api/files/<番号> は、知らされた作業フォルダの中のファイルだけを返す', async () => {
    const png = await call('/api/files/f1');
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.equal(png.headers.get('content-security-policy'), 'sandbox');
    const markdown = await call('/api/files/f2');
    assert.equal(markdown.status, 200);
    assert.match(markdown.headers.get('content-disposition'), /^attachment/);
    assert.equal((await call('/api/files/f4')).status, 200, '場所だけの文字でもよい');
    assert.equal((await call('/api/files/f3')).status, 404, '作業フォルダの外');
    assert.equal((await call('/api/files/unknown')).status, 404, '知らされていない番号');
  });

  test('REQ-005 状態の setup.taskDisplays の値が、そのまま taskDisplays に入る', async () => {
    const own = createFakeCore(prepState());
    own.set((state) => {
      state.setup.taskDisplays = [{ key: 'x', label: 'X', type: 'text', when: 'both' }];
      return state;
    });
    const other = await startApp({ core: own, cwd: work, preferredPort: 0 });
    try {
      const state = await (await fetch(`http://127.0.0.1:${other.port}/api/state?k=${other.token}`)).json();
      assert.deepEqual(state.taskDisplays, [{ key: 'x', label: 'X', type: 'text', when: 'both' }]);
    } finally {
      await other.close();
    }
  });
});

// ---- 画面の部品の決まり（ソースの検査） -------------------------------------------------------

describe('画面の部品の決まり（ソースの検査）', () => {
  const staticDir = path.join(uiDir, 'static');
  const read = (name) => fs.readFileSync(path.join(staticDir, name), 'utf8');
  const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('REQ-006 画面の JavaScript は、文字を HTML として組み込まない（innerHTML などを使わない）', () => {
    for (const name of ['app.js', 'render.js']) {
      const source = withoutComments(read(name));
      for (const forbidden of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function\b/, /\.srcdoc\b/, /createContextualFragment/, /DOMParser/, /setAttribute\(\s*['"]on/i, /\bon(click|load|error)\s*=/i]) {
        assert.doesNotMatch(source, forbidden, `${name} に ${forbidden} がある`);
      }
    }
  });

  test('REQ-030 画面は素の HTML・CSS・JavaScript で、外部の読み込みもビルドも使わない', () => {
    const html = read('index.html');
    assert.doesNotMatch(html, /(src|href)\s*=\s*["']\s*(https?:)?\/\//i, 'index.html が外部を読み込んでいる');
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'インラインのスクリプトがある');
    assert.doesNotMatch(html, /\sstyle\s*=/i, 'インラインの style がある');
    const css = read('style.css');
    assert.doesNotMatch(css, /@import|url\(\s*["']?(https?:)?\/\//i, 'style.css が外部を読み込んでいる');
    // CSS が読み込むのは、同じ置き場所の中のフォント（WOFF2）だけ。フォントの隣には、ライセンスの文を置く
    for (const [, url] of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      const file = url.split('?')[0];
      assert.match(file, /^fonts\/[\w.-]+\/[\w.-]+\.woff2$/, `style.css が ${url} を読み込んでいる`);
      assert.ok(fs.existsSync(path.join(staticDir, ...file.split('/'))), `${file} がない`);
      assert.ok(fs.existsSync(path.join(staticDir, path.dirname(file), 'OFL.txt')), `${path.dirname(file)} にライセンスの文（OFL.txt）がない`);
    }
    for (const name of ['app.js', 'render.js']) {
      const source = withoutComments(read(name));
      assert.doesNotMatch(source, /\bimport\s*\(|^\s*import\s/m, `${name} がモジュールを読み込んでいる`);
      assert.doesNotMatch(source, /fetch\(\s*['"`]https?:/, `${name} が外部に問い合わせている`);
    }
    // サーバー側も、Node.js の標準の部品と相対の場所だけを読み込む
    for (const name of ['server.mjs', 'app.mjs']) {
      const source = fs.readFileSync(path.join(uiDir, name), 'utf8');
      for (const match of source.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
        assert.ok(match[1].startsWith('node:') || match[1].startsWith('.'), `${name} が外部のパッケージ ${match[1]} を使っている`);
      }
    }
    assert.ok(!fs.existsSync(path.join(uiDir, 'package.json')) && !fs.existsSync(path.join(uiDir, 'node_modules')));
  });

  test('REQ-005 窓口の配線（app.mjs）は、作業の定義のファイル（task.json）を読み直さず、中心の処理の状態だけを使う', () => {
    const source = withoutComments(fs.readFileSync(path.join(uiDir, 'app.mjs'), 'utf8'));
    for (const forbidden of [/task\.json/, /taskPath/, /readFileSync|readFile\(/, /from\s+['"]node:fs/]) {
      assert.doesNotMatch(source, forbidden, `app.mjs に ${forbidden} がある`);
    }
  });

  test('REQ-001 画面の試験が示す Playwright の入れ方は、試験の入口（tests/run.py）の案内と同じ（tests/node_modules に入れる）', (t) => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const command = 'npm install --prefix tests --no-save --no-package-lock playwright@';
    const screen = fs.readFileSync(path.join(here, 'screen.test.mjs'), 'utf8');
    assert.ok(screen.includes(command), '画面の試験の案内に、入口と同じ入れ方がない');
    assert.doesNotMatch(screen, /リポジトリの外/, 'リポジトリの外に入れる、という古い案内が残っている');
    const entry = path.join(here, '..', '..', 'run.py');
    if (!fs.existsSync(entry)) return t.skip('試験の入口（tests/run.py）がない');
    const howTo = fs.readFileSync(entry, 'utf8');
    assert.ok(howTo.includes(command), '試験の入口の案内が変わった。画面の試験の案内も合わせる');
    const version = /PLAYWRIGHT_VERSION\s*=\s*"([\d.]+)"/.exec(howTo)?.[1];
    assert.ok(version && screen.includes(`${command}${version}`), `Playwright の版（${version}）が入口と同じでない`);
  });

  test('REQ-025 画面の文字は日本語で、状態の記号（英語）を日本語にする表がある', () => {
    const source = read('app.js');
    for (const symbol of ['preparing', 'starting', 'running', 'summarizing', 'stopping', 'finished', 'standby', 'waiting', 'completed', 'failed', 'stopped', 'unstopped', 'all_passed', 'max_iterations', 'user_stopped', 'aborted']) {
      assert.ok(source.includes(`${symbol}:`), `${symbol} の日本語の表がない`);
    }
  });
});
