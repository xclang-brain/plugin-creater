// 開発者が答える外側の EVAL（testing.md 6.7）で、問いに出た、試験の容器の中にしかない画面とファイルを画像にする。
// 開発者は統括と話していて、容器の中の URL（http://127.0.0.1:<番号>/…、http://localhost:…）やファイルを開けないためである。
//
// - 問いの文と問いの前の文（notes）から、容器の中の http の URL と、ある .html のファイルの場所を探す。
//   ファイルの場所は、絶対の場所か、作業フォルダ（baseDir）からの場所。file:// で始まるものも受ける。
// - それぞれを Playwright で開き、ページ全体を写す。URL のページに「開始する」のボタンがあれば押して実行中を写し、
//   続けて「止める」のボタンがあれば押して終わった後を写す（クリエイターが示す見本の画面の、動いている様子を見せるため）。
// - ブラウザーは、テストの手助け（skills/test-plugin/scripts/screen.mjs の launchBrowser）で起動する。
// - 写せなかったときは、理由を errors に残して返す。例外は投げない（中継を止めないため）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { launchBrowser } from '../../../skills/test-plugin/scripts/screen.mjs';

/** 1 つの問いの画像を写す時間の上限 */
export const CAPTURE_TIMEOUT_MS = 90_000;
/** ページを開いた後と、ボタンを押した後に待つ時間（画面が描き終わるのを待つ） */
export const SETTLE_MS = 1500;
const VIEWPORT = { width: 1280, height: 900 };

const LOCAL_URL = /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:[/?#][\w\-.~:/?#@!$&+,;=%]*)?/g;
// .html のファイルの場所の候補。空白、引用符、括弧、Markdown の太字と角括弧、日本語の句読点で区切る（日本語の名前のフォルダは受ける）
const HTML_PATH = /[^\s`'"<>|()*\[\]（）「」『』【】、。，：；]+\.html?(?![\w.])/g;

const firstLine = (text) => String(text ?? '').split('\n').find((line) => line.trim() !== '')?.trim() ?? '';

/**
 * 文から、容器の中の http の URL と、ある .html のファイルを探す（出た順、重なりを除く）。
 * @param {string} text
 * @param {{ baseDir?: string }} [options] 相対の場所を解く作業フォルダ（省くと、相対の場所は探さない）
 * @returns {{ kind: 'url'|'file', source: string, target: string }[]} source は文に出たもの、target は開く URL
 */
export function findLocalSources(text, { baseDir } = {}) {
  const value = String(text ?? '');
  const found = [];
  const seen = new Set();
  const add = (kind, source, target) => {
    if (seen.has(target)) return;
    seen.add(target);
    found.push({ kind, source, target });
  };
  for (const match of value.matchAll(LOCAL_URL)) {
    const url = match[0].replace(/[.,;:!?]+$/, '');
    add('url', url, url);
  }
  for (const match of value.matchAll(HTML_PATH)) {
    const token = match[0];
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token) && !token.startsWith('file://')) continue; // http の URL は上で扱う
    const candidates = [token];
    // 日本語の文に続けて書かれた場所（「見本はdraft/preview.html」）は、後ろの ASCII の部分も試す
    const ascii = /[\x21-\x7e]+$/.exec(token)?.[0];
    if (ascii && ascii !== token) candidates.push(ascii);
    for (const candidate of candidates) {
      const file = resolveHtmlFile(candidate, baseDir);
      if (file) {
        add('file', candidate, pathToFileURL(file).href);
        break;
      }
    }
  }
  return found;
}

function resolveHtmlFile(token, baseDir) {
  let p = token;
  if (p.startsWith('file://')) {
    try {
      p = fileURLToPath(p);
    } catch {
      return null;
    }
  }
  if (!path.isAbsolute(p)) {
    if (!baseDir) return null;
    p = path.resolve(baseDir, p);
  }
  try {
    return fs.statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** ボタンがあって押せれば押して待ち、押したかを返す */
async function clickIfPresent(page, name) {
  const button = page.getByRole('button', { name, exact: true }).first();
  if ((await button.count()) === 0) return false;
  if (!(await button.isEnabled())) return false;
  await button.click({ timeout: 5000 });
  await sleep(SETTLE_MS);
  return true;
}

async function captureOne(browser, item, { outDir, prefix, images, errors }) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  try {
    const page = await context.newPage();
    await page.goto(item.target, { waitUntil: 'load', timeout: 15_000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}); // 画面が通信を続けていても写す
    await sleep(SETTLE_MS);
    const shoot = async (view) => {
      const file = path.join(outDir, `${prefix}${view === 'page' ? '' : `-${view}`}.png`);
      await page.screenshot({ path: file, fullPage: true, timeout: 15_000 });
      images.push({ source: item.source, view, path: file });
    };
    await shoot('page');
    if (item.kind !== 'url') return;
    try {
      if (await clickIfPresent(page, '開始する')) {
        await shoot('running');
        if (await clickIfPresent(page, '止める')) await shoot('finished');
      }
    } catch (error) {
      errors.push({ source: item.source, error: `ボタンを押して写せませんでした：${firstLine(error?.message)}` });
    }
  } catch (error) {
    errors.push({ source: item.source, error: `写せませんでした：${firstLine(error?.message)}` });
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * 文に出た、容器の中の画面とファイルを画像にする。見つからなければ、ブラウザーを起動しない。
 * @param {object} args
 * @param {string[]} args.texts 問いの文と、問いの前の文
 * @param {string} args.outDir 画像を置くフォルダ
 * @param {string} args.id 問いの id（画像の名前の頭）
 * @param {string} [args.baseDir] 相対の場所を解く作業フォルダ
 * @param {object} [args.chromium] Playwright の chromium（試験で差し替える。省くと読み込む）
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{ sources: object[], images: { source: string, view: 'page'|'running'|'finished', path: string }[], errors: { source: string, error: string }[] }>}
 */
export async function captureLocalImages({ texts, outDir, id, baseDir, chromium, timeoutMs = CAPTURE_TIMEOUT_MS, env = process.env }) {
  const sources = findLocalSources((texts ?? []).join('\n'), { baseDir });
  const images = [];
  const errors = [];
  if (sources.length === 0) return { sources, images, errors };
  let browser = null;
  let stopped = false;
  let timer = null;
  const work = (async () => {
    const pw = chromium ?? (await import('playwright')).chromium;
    const launched = await launchBrowser(pw, { env });
    browser = launched.browser;
    if (stopped) {
      await browser.close().catch(() => {}); // 時間切れの後に起動し終えたブラウザーは、すぐ閉じる
      return;
    }
    fs.mkdirSync(outDir, { recursive: true });
    for (const [n, item] of sources.entries()) {
      if (stopped) return;
      await captureOne(browser, item, { outDir, prefix: `${id}-${n + 1}`, images, errors });
    }
  })();
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${Math.round(timeoutMs / 1000)} 秒で写し終わりませんでした。`)), timeoutMs);
  });
  let failure = null;
  try {
    await Promise.race([work, deadline]);
  } catch (error) {
    failure = error;
  }
  clearTimeout(timer);
  stopped = true;
  await browser?.close().catch(() => {});
  // 時間切れのときは、ブラウザーを閉じて、写しかけの手順が終わるのを待つ（閉じたので、すぐ終わる）
  let grace = null;
  await Promise.race([work.catch(() => {}), new Promise((resolve) => { grace = setTimeout(resolve, 10_000); grace.unref?.(); })]);
  clearTimeout(grace);
  if (failure) {
    const done = new Set([...images.map((i) => i.source), ...errors.map((e) => e.source)]);
    for (const s of sources.filter((x) => !done.has(x.source))) errors.push({ source: s.source, error: firstLine(failure?.message) });
  }
  return { sources, images, errors };
}
