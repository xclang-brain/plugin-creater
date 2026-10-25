// 画面のサーバー（汎用）。生成プラグインの画面も、クリエイターの画面も、これを読み込んで使う。
// 設計書：docs/design/generated-plugin-structure.md の 4.2、6.3、9章。
//
// 決まり
// - 127.0.0.1 だけで待ち受ける。いつもの番号がふさがっていたら、OS に空いている番号を選ばせる。
// - 起動ごとに乱数の合言葉を作り、URL に入れる（?k=<合言葉>）。
// - 全部の問い合わせで、合言葉と Host（127.0.0.1 か localhost と番号）を確かめる。画面の部品（静的ファイル）も同じ。
// - 全部の応答に、スクリプトを自分のサーバーのものだけにする CSP と nosniff を付ける。フォントも自分のサーバーのもの（同梱の書体）だけにする。
// - ファイルの窓口の確かめは serveFile() に持つ。生成プラグインの routes から使う。
//
// 外部の npm パッケージは使わない（Node.js の標準の部品だけ）。

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const MAX_BODY_BYTES = 1024 * 1024; // 画面から送る内容は小さい
const MAX_FILE_BYTES = 50 * 1024 * 1024;

// 自分のサーバーのスクリプトだけを動かす。エージェントが書いた文字の中のスクリプトは動かない（6.3）。
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', // URL の合言葉をほかへ漏らさない
  'Cache-Control': 'no-store',
};

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

// 画像として返す種類は、これだけ（SVG と HTML は含めない。6.3）
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** routes の関数から投げると、その状態の番号と文で断る。message は画面に出るので平易な日本語にする。 */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** routes の関数がこれを返すと、JSON にせず、そのまま返す（ファイルの窓口用）。 */
export class Reply {
  constructor({ status = 200, headers = {}, body = '' } = {}) {
    this.status = status;
    this.headers = headers;
    this.body = body;
  }
}

function send(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(value));
}

function compileRoutes(routes) {
  return Object.entries(routes).map(([key, handler]) => {
    const [method, pattern] = key.split(' ');
    const names = [];
    const source = pattern
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/:(\w+)/g, (_, name) => {
        names.push(name);
        return '([^/]+)';
      });
    return { method, names, handler, re: new RegExp(`^${source}$`) };
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooBig = true;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) return reject(new HttpError(413, '送られた内容が大きすぎます'));
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, '送られた内容を読み取れません'));
      }
    });
    req.on('error', reject);
  });
}

// 置き場所の中の入れ子のフォルダ（fonts/… など）のファイルも出す。. と .. を含むパスと、置き場所の外は出さない
async function readStatic(staticDirs, relativePath) {
  if (!/^[\w.-]+(\/[\w.-]+)*$/.test(relativePath) || relativePath.split('/').some((p) => p === '.' || p === '..')) {
    return null;
  }
  for (const dir of staticDirs) {
    const file = path.resolve(dir, relativePath);
    if (!file.startsWith(dir + path.sep)) continue;
    try {
      return { file, data: await fsp.readFile(file) };
    } catch {
      // 次の置き場所を探す
    }
  }
  return null;
}

/**
 * 画面のサーバーを起動する。
 * @param {object} options
 * @param {number} [options.preferredPort] いつもの番号。ふさがっていたら OS に選ばせる。0 なら最初から OS に選ばせる。
 * @param {string|string[]} [options.staticDir] 画面の部品（index.html など）の置き場所。複数なら前のものを先に探す
 *   （クリエイターの画面が、自分の部品と、ひな形の描画の部品の両方を出すため）。
 * @param {Record<string, Function>} [options.routes] 'GET /api/state': (req) => 値 、'POST /api/start': (req, body) => 値。
 *   パスに :名前 を書くと req.params で受け取れる。値は JSON で返す。Reply を返すとそのまま返す。HttpError で断る。
 * @param {Function} [options.onListen] 待ち受けを始めたときに ({ url, port, token }) で呼ぶ
 * @returns {Promise<{ url: string, port: number, token: string, close: () => Promise<void> }>}
 */
export async function startServer({ preferredPort = 0, staticDir, routes = {}, onListen } = {}) {
  const token = crypto.randomBytes(24).toString('base64url');
  const tokenBytes = Buffer.from(token);
  const staticDirs = [].concat(staticDir ?? []).map((dir) => path.resolve(dir));
  const compiled = compileRoutes(routes);
  let port = 0;

  const tokenOk = (given) => {
    if (typeof given !== 'string') return false;
    const bytes = Buffer.from(given);
    return bytes.length === tokenBytes.length && crypto.timingSafeEqual(bytes, tokenBytes);
  };
  const hostOk = (host) => {
    const value = String(host ?? '').toLowerCase();
    return value === `127.0.0.1:${port}` || value === `localhost:${port}`;
  };

  async function handle(req, res) {
    const raw = req.url ?? '/';
    if (!raw.startsWith('/') || raw.startsWith('//')) return sendJson(res, 400, { error: '問い合わせの形が正しくありません' });
    const queryAt = raw.indexOf('?');
    const rawPath = queryAt < 0 ? raw : raw.slice(0, queryAt);
    const query = new URLSearchParams(queryAt < 0 ? '' : raw.slice(queryAt + 1));

    if (!hostOk(req.headers.host) || !tokenOk(query.get('k'))) {
      return sendJson(res, 403, { error: 'このアドレスでは開けません。チャットで示された URL を開いてください' });
    }
    query.delete('k');

    // 窓口は、元の文字のまま（% の符号を戻す前に）合わせてから、:名前 の部分だけを戻す（番号に / があってもよいように）
    for (const route of compiled) {
      if (route.method !== req.method) continue;
      const match = route.re.exec(rawPath);
      if (!match) continue;
      let params;
      try {
        params = Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(match[i + 1])]));
      } catch {
        return sendJson(res, 400, { error: '問い合わせの形が正しくありません' });
      }
      const pathname = rawPath;
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
      const result = await route.handler({ method: req.method, path: pathname, params, query: Object.fromEntries(query), headers: req.headers }, body);
      if (result instanceof Reply) return send(res, result.status, result.headers, result.body);
      return sendJson(res, 200, result ?? {});
    }

    if (req.method === 'GET') {
      let pathname;
      try {
        pathname = decodeURIComponent(rawPath);
      } catch {
        return sendJson(res, 400, { error: '問い合わせの形が正しくありません' });
      }
      const name = pathname === '/' ? 'index.html' : pathname.slice(1);
      const found = await readStatic(staticDirs, name);
      if (found) {
        const ext = path.extname(found.file).toLowerCase();
        const type = STATIC_TYPES[ext] ?? 'application/octet-stream';
        // 画面の部品の中の合言葉の差し込み口を、今の合言葉にする（静的ファイルの問い合わせにも合言葉を付けるため）。
        // index.html（スクリプトと CSS の URL）と CSS（フォントの URL）だけ。ほかのファイル（フォントなど）は、バイトのまま返す
        const data = name === 'index.html' || ext === '.css' ? found.data.toString('utf8').replaceAll('%%K%%', token) : found.data;
        return send(res, 200, { 'Content-Type': type }, data);
      }
    }
    return sendJson(res, 404, { error: '見つかりません' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (res.headersSent) return res.destroy();
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
      // 中身は返さない（画面に内部の事情を出さない）
      sendJson(res, 500, { error: '処理に失敗しました' });
    });
  });

  const listen = (wantedPort) =>
    new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ port: wantedPort, host: '127.0.0.1', exclusive: true });
    });

  try {
    await listen(preferredPort);
  } catch (error) {
    if (preferredPort === 0 || (error.code !== 'EADDRINUSE' && error.code !== 'EACCES')) throw error;
    await listen(0);
  }
  port = server.address().port;

  const url = `http://127.0.0.1:${port}/?k=${token}`;
  let closing = null;
  const close = () => {
    closing ??= new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closing;
  };
  onListen?.({ url, port, token });
  return { url, port, token, close };
}

/**
 * ファイルの窓口の確かめ。作業フォルダ（root）の中のファイルだけを返す。
 * - 本当の場所（シンボリックリンクをたどった後）が root の中か確かめる。
 * - png・jpeg・gif・webp だけを画像として返す。SVG や HTML を含むほかは、ダウンロードさせる形で返す。
 * - どれにも、スクリプトを動かさない指定（Content-Security-Policy: sandbox と nosniff）を付ける。
 * @returns {Promise<Reply>} 見つからないときと、root の外のときは HttpError(404)
 */
export async function serveFile({ path: filePath, root, name }) {
  const notFound = new HttpError(404, 'ファイルが見つかりません');
  let real;
  let stat;
  try {
    const realRoot = await fsp.realpath(root);
    real = await fsp.realpath(path.resolve(root, String(filePath)));
    const relative = path.relative(realRoot, real);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw notFound;
    stat = await fsp.stat(real);
  } catch {
    throw notFound;
  }
  if (!stat.isFile()) throw notFound;
  if (stat.size > MAX_FILE_BYTES) throw new HttpError(413, 'ファイルが大きすぎて開けません');

  const headers = {
    'Content-Security-Policy': 'sandbox',
    'X-Content-Type-Options': 'nosniff',
  };
  const imageType = IMAGE_TYPES[path.extname(real).toLowerCase()];
  if (imageType) {
    headers['Content-Type'] = imageType;
  } else {
    const shown = String(name ?? path.basename(real)).replace(/[\u0000-\u001f"\\/]/g, '_');
    headers['Content-Type'] = 'application/octet-stream';
    headers['Content-Disposition'] = `attachment; filename="${shown.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(shown).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
  }
  return new Reply({ status: 200, headers, body: await fsp.readFile(real) });
}
