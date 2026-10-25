// クリエイターのエクステンションの置き換え（testing.md 4章）。
//
// 置き換えた版のクリエイターからは、エクステンション（com.github.copilot/extensions/plugin-creator/）が外れる。
// この部品が、そのエクステンションの Copilot CLI に依らない部分（creator.mjs の createCreator）を読み込み、
// 画面を開くツール、記録のツール（progress、record、confirm）、状態取得ツール、試験の結果を知らせるツール、
// 文書をテキストにするツール、質問の改善案の起票を、Agent SDK の同じプロセスの MCP サーバーとして出す。
//   サーバー名：plugin-creator（D1a の変換が、ツール名を mcp__plugin-creator__<短い名前> に置き換える）
//   ツール：open、state、progress、record、confirm、results、doc_text、issue
// - 記録（state.json、qa.jsonl）は、この実行の COPILOT_HOME（copilotHome）に作る。本物のクリエイターと同じ置き場所の形。
// - 問答の記録（qa.jsonl）は、フックがしている記録（hearing.md 7.4）を、この部品が会話の記録から同じ形で作る。
//   エクステンションの同じ関数（hooks.onPostToolUse、hooks.onUserPromptSubmitted）を呼ぶので、形も「ヒアリングの最中だけ」の条件も同じ。
//   コンパクションの後の差し込みは、再現しない（testing.md 4章）。
// - 起票は偽物の gh で受ける。引数と本文と返した URL を issues に残すだけで、本物の plugin-creator に Issue は作らない。
//   返す URL は、起票ごとに違う番号にする（9001、9002、…）。
// - 状態を変えるツールの呼び出しと結果を、events に順に残す（6.5 の「全項目をヒアリングしたか」「承認の前に生成しなかったか」の材料）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createToolServer, mcpToolName } from './mcp-tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** クリエイターのプラグインの根（リポジトリの直下） */
export const REPO_ROOT = path.resolve(here, '..', '..', '..');
export const CREATOR_SERVER_NAME = 'plugin-creator';
const TOOL_PREFIX = 'plugin-creator_';
const FAKE_ISSUE_URL_BASE = 'https://github.com/xclang-brain/plugin-creator/issues/';
const FAKE_ISSUE_FIRST_NUMBER = 9001;

/** エクステンションの creator.mjs を読み込む（クリエイターのプラグインの根を渡す） */
export async function loadCreatorModule(pluginRoot = REPO_ROOT) {
  const file = path.join(pluginRoot, 'com.github.copilot', 'extensions', 'plugin-creator', 'creator.mjs');
  return import(pathToFileURL(file).href);
}

/**
 * エクステンションのツールの返り値を、MCP の結果の形に直す。
 * Copilot CLI 用のツールは、断りも失敗も、例外ではなく `{ textResultForLlm: <理由の文>, resultType: 'failure' }` で返す
 * （実機の Copilot CLI 1.0.102 は、例外を投げると理由の文を消すため。V1 の不具合 2）。MCP の公式の形は、
 * `{ content: [{ type: 'text', text }], isError: true }`。理由の文はそのままモデルに届ける。成功の文字は、文字のまま返す。
 * resultType が success 以外（failure・rejected・denied）なら失敗とみなす。
 * @returns {string | object} 成功は文字列かそのままの返り値、失敗は `{ content, isError: true }`
 */
export function toMcpResult(raw) {
  if (raw === null || typeof raw !== 'object' || typeof raw.textResultForLlm !== 'string') return raw;
  if (raw.resultType === undefined || raw.resultType === 'success') return raw.textResultForLlm;
  return { content: [{ type: 'text', text: raw.textResultForLlm }], isError: true };
}

/** MCP の結果（toMcpResult の返り値）から、記録に残す文と、失敗かどうかを取り出す */
function describeResult(result) {
  if (result !== null && typeof result === 'object' && Array.isArray(result.content)) {
    return { isError: result.isError === true, text: result.content.map((c) => c?.text ?? '').join('\n') };
  }
  return { isError: false, text: String(result ?? '') };
}

/**
 * 偽物の gh。引数と本文を残して、成功の返事を返す（gh issue create の返事に似せて、Issue の URL を 1 行返す）。
 * URL の番号は、起票ごとに 9001 から 1 つずつ増やす（本物と同じく、起票ごとに違う URL になる）。
 */
export function createFakeGh(issues) {
  return async function fakeGh(args, input) {
    const titleArg = (args ?? []).find((a) => typeof a === 'string' && a.startsWith('--title='));
    const url = `${FAKE_ISSUE_URL_BASE}${FAKE_ISSUE_FIRST_NUMBER + issues.length}`;
    issues.push({ args: [...(args ?? [])], title: titleArg ? titleArg.slice('--title='.length) : null, body: String(input ?? ''), url });
    return { code: 0, stdout: `${url}\n`, stderr: '', timedOut: false, notFound: false };
  };
}

/**
 * クリエイターのエクステンションの置き換えを作る。
 * @param {object} args
 * @param {string} args.workDir クリエイターの作業フォルダ（cwd）
 * @param {string} args.copilotHome この実行の COPILOT_HOME（記録の置き場所の上の階層）
 * @param {string} [args.sessionId]
 * @param {{ now: () => number }} [args.clock]
 * @param {string} [args.pluginRoot] クリエイターのプラグインの根（既定はこのリポジトリの直下）
 * @param {(event: object) => void} [args.onEvent] 記録のツールなどの呼び出しの記録を受ける（順番の印づけは呼ぶ側）
 * @param {(text: string) => void} [args.warn]
 * @param {Function} [args.loadUi] ひな形の画面の部品を読み込む関数（試験で差し替える）
 */
export async function createCreatorToolkit({
  workDir,
  copilotHome,
  sessionId = `outer-${Date.now().toString(36)}`,
  clock = { now: () => Date.now() },
  pluginRoot = REPO_ROOT,
  onEvent,
  warn = () => {},
  loadUi,
}) {
  if (!workDir || !copilotHome) throw new Error('createCreatorToolkit には workDir と copilotHome が要ります。');
  fs.mkdirSync(copilotHome, { recursive: true });
  const { createCreator } = await loadCreatorModule(pluginRoot);
  const issues = [];
  const events = [];
  const creator = createCreator({
    sessionId,
    home: copilotHome,
    cwd: workDir,
    clock,
    pluginRoot,
    runGh: createFakeGh(issues),
    warn,
    ...(loadUi ? { loadUi } : {}),
  });

  let callCounter = 0;
  const record = (event) => {
    const e = { at: clock.now(), ...event };
    events.push(e);
    onEvent?.(e);
    return e;
  };

  /** MCP のツールの定義（名前の後ろの部分だけを名前にする）。handler は、成功なら文字、断りや失敗なら `{ content, isError: true }` を返す */
  const tools = creator.tools.map((tool) => {
    const name = tool.name.startsWith(TOOL_PREFIX) ? tool.name.slice(TOOL_PREFIX.length) : tool.name;
    return {
      name,
      description: tool.description,
      inputSchema: tool.parameters,
      handler: async (args, ctx = {}) => {
        callCounter += 1;
        const callId = callCounter;
        record({ type: 'tool.call', callId, tool: name, args, toolUseId: ctx.toolUseId, agentId: ctx.agentId });
        try {
          const result = toMcpResult(await tool.handler(args, ctx));
          const { isError, text } = describeResult(result);
          record({ type: 'tool.result', callId, tool: name, toolUseId: ctx.toolUseId, isError, result: text });
          return result;
        } catch (error) {
          record({ type: 'tool.result', callId, tool: name, toolUseId: ctx.toolUseId, isError: true, result: error?.message ?? String(error) });
          throw error;
        }
      },
    };
  });

  const byName = new Map(tools.map((t) => [t.name, t]));
  const mcpTools = tools.map((t) => mcpToolName(CREATOR_SERVER_NAME, t.name));

  return {
    serverName: CREATOR_SERVER_NAME,
    creator,
    store: creator.store,
    tools,
    mcpTools,
    events,
    issues,
    sessionId,
    copilotHome,

    /** query() 1回ごとに別のインスタンスを渡す（1つのサーバーは1つの接続しか持てない） */
    newServer() {
      return createToolServer({ name: CREATOR_SERVER_NAME, tools });
    },

    /** ツールを直接呼ぶ（試験用。MCP を通さない）。返り値は handler と同じ（成功は文字、断りや失敗は `{ content, isError: true }`） */
    callTool(name, args = {}, ctx = {}) {
      const tool = byName.get(name);
      if (!tool) throw new Error(`知らないツールです：${name}`);
      return tool.handler(args, ctx);
    },

    /**
     * ask_user 1回分の問答を、qa.jsonl に残す。Copilot CLI の ask_user の onPostToolUse と同じ関数を呼ぶ。
     * 質問の改善案の振り返り（state の include）が読む形：question.message、answer、outcome。
     */
    recordAsk({ question, choices = [], header, multiSelect = false, answer }) {
      creator.hooks.onPostToolUse({
        toolName: 'ask_user',
        toolArgs: { message: question, ...(choices.length ? { choices: choices.map((c) => (typeof c === 'string' ? c : c.label)) } : {}), ...(header ? { header } : {}), ...(multiSelect ? { multiSelect } : {}) },
        toolResult: `User responded: ${answer}`,
      });
    },

    /** 文章の問いへの返事（ユーザーが打った発言）を、qa.jsonl に残す */
    recordPrompt(text) {
      creator.hooks.onUserPromptSubmitted({ prompt: text });
    },

    readState() {
      try {
        return creator.store.readState();
      } catch {
        return null;
      }
    },
    readQa() {
      return creator.store.readQa();
    },

    async shutdown() {
      try {
        await creator.shutdown();
      } catch (error) {
        warn(`クリエイターの画面を閉じられませんでした：${error?.message ?? error}`);
      }
    },
  };
}
