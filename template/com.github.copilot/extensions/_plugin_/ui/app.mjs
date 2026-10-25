// 生成プラグインの Web管理画面の窓口。設計書 6.3 の窓口の表を、中心の処理（core）の API につなぐ。
// 中心の処理の API：wip/implementation/BLUEPRINT.md 3.3（core.getState、start、stop、fileIssue、getReply、getFile）。
//
// 中心の処理に求めること
// - core.getState()              状態の全体（BLUEPRINT 3.5）。
// - core.start(settings)         { models: { orchestrator, worker, verifier }, efforts: { <エージェント>: 思考の深さか '' }, maxIterations, task: { <key>: value } }。断るときは Error を投げる（message は平易な日本語）。
// - core.stop()
// - core.fileIssue(issueId)      断るときは Error を投げる。
// - core.getReply(agentId)       最後の返事の全文（文字）。なければ null。
// - core.getFile(fileId)         記録のツールで知らされたファイル { path, name? }（path は文字でもよい）。なければ null。
//
// 作業の定義（task.json）の表示の定義（displays）は、中心の処理が状態の全体の setup.taskDisplays に入れて渡す。
// 画面は状態の応答の taskDisplays として読むので、ここで同じ値を taskDisplays に写して返す。

import { fileURLToPath } from 'node:url';

import { HttpError, serveFile, startServer } from './server.mjs';

// 土台の既定の番号。ふさがっていたら OS が空いている番号を選ぶ（server.mjs）。
export const DEFAULT_PORT = 8731;

const STATIC_DIR = fileURLToPath(new URL('./static/', import.meta.url));

// 中心の処理が断るときの Error は、画面に出す文として 400 で返す
async function refuseAsBadRequest(action) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, error instanceof Error && error.message ? error.message : '受け付けられませんでした');
  }
}

/**
 * 生成プラグインの画面を起動する。
 * @param {object} options
 * @param {object} options.core 中心の処理
 * @param {string} options.cwd 作業フォルダ。ファイルの窓口はこの中のものだけを返す
 * @param {number} [options.preferredPort] いつもの番号
 * @returns {Promise<{ url: string, port: number, token: string, close: () => Promise<void> }>}
 */
export async function startApp({ core, cwd, preferredPort = DEFAULT_PORT }) {
  const routes = {
    'GET /api/state': async () => {
      const state = await core.getState();
      return { ...state, taskDisplays: state.setup?.taskDisplays ?? [] };
    },

    'GET /api/agents/:id/reply': async ({ params }) => {
      const reply = await core.getReply(params.id);
      if (reply == null) throw new HttpError(404, '返事が見つかりません');
      return { text: typeof reply === 'string' ? reply : String(reply.text ?? '') };
    },

    'GET /api/files/:id': async ({ params }) => {
      const file = await core.getFile(params.id);
      if (!file) throw new HttpError(404, 'ファイルが見つかりません');
      const filePath = typeof file === 'string' ? file : file.path;
      // 作業フォルダの中かの確かめは、ここでもう一度行う（server.mjs の serveFile）
      return serveFile({ path: filePath, root: cwd, name: typeof file === 'string' ? undefined : file.name });
    },

    'POST /api/start': async (_req, body) => {
      await refuseAsBadRequest(() => core.start(body));
      return { ok: true };
    },

    'POST /api/stop': async () => {
      await refuseAsBadRequest(() => core.stop());
      return { ok: true };
    },

    'POST /api/issues/:id/file': async ({ params }) => {
      await refuseAsBadRequest(() => core.fileIssue(params.id));
      return { ok: true };
    },
  };

  return startServer({ preferredPort, staticDir: STATIC_DIR, routes });
}
