// クリエイターの画面（REQ-043、REQ-044、generated-plugin-structure.md 9章）。
//
// ひな形の生成プラグインの画面のサーバー（ui/server.mjs）と描画の部品（ui/static/render.js、style.css）を、
// 相対パスで読み込んで使う。土台の写しは持たない（ひな形はクリエイターの直下の template/ にあり、エクステンションとしては読み込まれない）。
// 見るだけ：入力の欄、開始と止めるボタン、承認のボタンを出さない。答えや直しはチャットで行う。
// 127.0.0.1 だけで待ち受け、合言葉つきの URL で開く。画面のサーバーはエクステンションと同じプロセスで動くので、
// Copilot CLI を終えるとプロセスが残らない。
//
// 画面のサーバーの形は BLUEPRINT 3.4：startServer({ preferredPort, staticDir, routes, onListen }) -> { url, port, token, close }

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** クリエイターのプラグインの根（com.github.copilot/extensions/plugin-creator/ の 3 つ上） */
export const DEFAULT_PLUGIN_ROOT = path.resolve(here, '..', '..', '..');

/** ひな形の生成プラグインのエクステンションの場所（プラグインの根からの相対） */
const TEMPLATE_EXTENSION = path.join('template', 'com.github.copilot', 'extensions', '_plugin_');

const EXAMPLE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * ひな形の画面の部品を読み込む関数を作る。読み込みは最初に必要になったときだけ行い、失敗してもほかのツールは動く。
 * @returns {() => Promise<{ startServer: Function, HttpError: Function, Reply: Function, templateStaticDir: string, taskSchemaPath: string }>}
 */
export function createUiLoader({ pluginRoot = DEFAULT_PLUGIN_ROOT } = {}) {
  const templateDir = path.join(pluginRoot, TEMPLATE_EXTENSION);
  let loading = null;
  return () => {
    loading ??= (async () => {
      const serverFile = path.join(templateDir, 'ui', 'server.mjs');
      let mod;
      try {
        mod = await import(pathToFileURL(serverFile).href);
      } catch (error) {
        loading = null;
        throw new Error(`画面の部品（plugin-creator が用意した共通の形の ui/server.mjs）を読み込めません：${error.message}`);
      }
      return {
        startServer: mod.startServer,
        HttpError: mod.HttpError,
        Reply: mod.Reply,
        templateStaticDir: path.join(templateDir, 'ui', 'static'),
        taskSchemaPath: path.join(templateDir, 'core', 'task.schema.json'),
      };
    })();
    return loading;
  };
}

/** 状態の全体の「版」。中身が変わると変わる。画面は、版が変わったときだけ描き直す */
export function versionOf(view) {
  return crypto.createHash('sha1').update(JSON.stringify(view)).digest('hex').slice(0, 12);
}

/** 会話例（examples/ の Markdown）の一覧。なければ空 */
export function listExamples(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md') && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * クリエイターの画面を持つ。
 * @param {object} options
 * @param {() => object} options.getView 画面に出す状態（版は付けない。ここで付ける）
 * @param {ReturnType<typeof createUiLoader>} options.loadUi
 * @param {string} [options.examplesDir] 会話例のフォルダ
 * @param {string} [options.staticDir] クリエイターの画面の静的ファイル
 * @param {number} [options.preferredPort]
 */
export function createScreen({ getView, loadUi, examplesDir, staticDir = path.join(here, 'ui', 'static'), preferredPort = 0 }) {
  let server = null;
  let starting = null;

  async function start() {
    const ui = await loadUi();
    const { HttpError, Reply } = ui;
    return ui.startServer({
      preferredPort,
      // 前のものを先に探す。index.html とクリエイターの画面の部分は staticDir、描画の部品とスタイルはひな形から
      staticDir: [staticDir, ui.templateStaticDir],
      routes: {
        'GET /api/state': () => {
          const view = getView();
          return { version: versionOf(view), ...view };
        },
        // 会話例は、一覧にあるファイルだけを、文字として見せる（HTML として動かさない）
        'GET /api/examples/:name': ({ params }) => {
          const name = listExamples(examplesDir).find((n) => n === params.name);
          if (!name) throw new HttpError(404, '会話例が見つかりません');
          const file = path.join(examplesDir, name);
          let body;
          try {
            if (fs.statSync(file).size > EXAMPLE_MAX_BYTES) throw new HttpError(413, '会話例が大きすぎて開けません');
            body = fs.readFileSync(file);
          } catch (error) {
            if (error instanceof HttpError) throw error;
            throw new HttpError(404, '会話例を開けません');
          }
          return new Reply({
            headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Security-Policy': 'sandbox', 'X-Content-Type-Options': 'nosniff' },
            body,
          });
        },
      },
    });
  }

  return {
    /** 画面のサーバーを起動する（起動していれば、何もしない）。@returns {Promise<string>} URL */
    async ensure() {
      if (!server) {
        starting ??= start().then(
          (s) => {
            server = s;
            return s;
          },
          (error) => {
            starting = null;
            throw error;
          },
        );
        await starting;
      }
      return server.url;
    },
    get url() {
      return server?.url ?? null;
    },
    get running() {
      return server !== null;
    },
    async close() {
      const s = server;
      server = null;
      starting = null;
      if (s) await s.close();
    },
  };
}
