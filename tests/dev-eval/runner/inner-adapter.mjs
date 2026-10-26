// 内側の EVAL の Agent SDK 用のつなぎ口（testing.md 4章の後半、7章）。
// 生成プラグインの中心の処理（core/）と画面（ui/）を、Copilot CLI ではなく Agent SDK につなぐ。
// Copilot CLI 用のつなぎ口（生成プラグインの adapter.mjs）と同じく、中心の処理とは窓口 port（BLUEPRINT 3.2）と
// 中立のイベント（3.1）だけでやり取りする。adapter.mjs が手本。
//
//   画面を開くツールと記録のツール … 同じプロセスの MCP サーバー（サーバー名はエクステンションの名前、ツール名は名前の後ろの部分）。
//                                   エージェントの定義の tools と本文のツール名は、変換スクリプトが mcp__<サーバー名>__<ツール名> にしてある。
//   統括を起動する（port.startAgent）… 置き換えた版の統括を、別の query()（Agent SDK の実行）で始める。agent: '<プラグイン>:orchestrator'。
//                                   作業・検証のモデルは、置き換えた版のコピーのエージェントの定義の model を、画面で選んだモデルに書き換えて効かせる。
//                                   エージェントごとの思考の深さ（統括を含む）も、同じコピーの定義の effort に書いて効かせる（統括は query() の effort にも渡す）。
//   統括の使えるツール … 生成プラグインの統括の定義には tools がない（Copilot CLI では、統括は全ツールを持ち、一覧にないツールを adapter.mjs の
//                                   onPreToolUse が拒む）。このつなぎ口は、実行用のコピーの統括の定義に、同じ範囲の tools を書いて効かせる（下の orchestratorTools）。
//   止める（port.cancelAgent）… 統括の query() だけを閉じる。メインの実行は中断しない（設計書 4.4 と同じ範囲）。
//   待っている統括に送る（port.sendMessage。人の判断待ちの答え、設計書 4.15）… 手番を終えた統括の会話（session_id）を resume して、
//                                   送る文を次のユーザーの文にした query() を、同じ統括の番号のまま始める。Copilot CLI と同じく、
//                                   初めの手番の終わりは agent.completed、2回目からは agent.idle（最後の返事つき）を届ける（11章 #19）。
//                                   統括が手番を終えるたびに onOrchestratorTurnEnd を呼ぶ（Copilot CLI がメインのエージェントに知らせる代わり）。
//   状態 … Agent SDK のフック（SubagentStart・SubagentStop・PreToolUse・PostToolUse）と、メッセージ（assistant・result）から作る。
//   記録のツールを呼んだエージェント … フック PreToolUse の tool_use_id と agent_id から知り、MCP の呼び出しの _meta の claudecode/toolUseId と結び付ける。
//
// 確かめたこと（偽の API で本物の Agent SDK 0.3.310 を動かした）は、tasks/D1d.md にある。
// Copilot CLI でしか確かめられないこと（イベントの届き方、Auto、確認の待ちのイベント、/clear など）は、ここでは再現しない（testing.md 4章、9章）。

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { makeQueryOptions, usageLimitPrefixes } from './isolation.mjs';
import { createToolServer, mcpToolName } from './mcp-tools.mjs';
import { modelMapOf, readConversionReport, toClaudeModelId, toCopilotName, copilotModelList } from './model-map.mjs';

const AGENT_TOOL_NAMES = new Set(['Agent', 'Task']);
/**
 * 統括が使ってよいツールのうち、Claude Code の組み込みのもの。生成プラグインの adapter.mjs の ORCHESTRATOR_BUILTIN_TOOLS
 * （view、grep・glob・rg、task・read_agent・list_agents・write_agent）に当たる範囲。
 * view→Read、grep・rg→Grep、glob→Glob、task→Agent。read_agent・list_agents・write_agent に当たるツールは、統括が task を
 * 前面（run_in_background: false）で1体ずつ呼ぶ決まりなので要らない。同じ範囲かは inner-adapter.test.mjs が adapter.mjs と突き合わせる。
 * 記録のツール（plan・review・issue・finish・show）は、core/tools.mjs の TOOL_DEFS で caller に orchestrator を持つものから作る。
 */
export const ORCHESTRATOR_BUILTIN_TOOLS = Object.freeze(['Agent', 'Read', 'Grep', 'Glob']);
/** 統括の query() の最大の手番の数（サブエージェントの手番は別に数える） */
const ORCHESTRATOR_MAX_TURNS = 300;
const GH_STUB = '#!/bin/sh\necho "gh は開発の試験では使えません" >&2\nexit 1\n';

// 予期しない失敗のときにモデルへ返す文。生成プラグインの adapter.mjs（Copilot CLI 用のつなぎ口）と同じ文にそろえる。
// 内部の情報（エラーの文、場所、スタック）はモデルに見せない。くわしくは標準エラーと記録（events.jsonl の tool_error）に残す。
// 同じ文かは inner-adapter.test.mjs が adapter.mjs の文字と突き合わせる。
export const OPEN_FAILED = 'Web管理画面を開けませんでした。ユーザーに、開けなかったことを伝えてください。';
export const RECORD_FAILED = '記録のツールの処理で、予期しない失敗が起きました。もう一度呼んでも同じなら、作業を終えてください。';
export const ANSWER_FAILED = '答えを渡す処理で、予期しない失敗が起きました。ユーザーに、答えを渡せなかったことを伝えてください。';
/** 送れないときの返り値（Copilot CLI 1.0.102・1.0.103 の tasks.sendMessage と同じ文。設計書 11章 #19） */
const NOT_ACCEPTING = 'Agent not found or not accepting messages';
/** ツールの失敗の結果（MCP の形：isError と content の文）。モデルは content の文をそのまま読む */
export const failureResult = (text) => ({ content: [{ type: 'text', text }], isError: true });

const now = () => Date.now();
const newId = (prefix) => `${prefix}-${randomBytes(4).toString('hex')}`;
const text = (value) => (typeof value === 'string' ? value : '');

/** 画面を開くツールの返り値。モデルがそのまま読み、ユーザーに伝える文（生成プラグインの adapter.mjs の describeOpened と同じ形） */
export function describeOpened({ url, notices }) {
  const lines = [`Web管理画面の URL：${url}`];
  const list = Array.isArray(notices) ? notices.filter((n) => typeof n === 'string' && n !== '') : [];
  if (list.length > 0) lines.push('', 'ユーザーに伝えてください：', ...list.map((notice) => `- ${notice}`));
  return lines.join('\n');
}

/** エージェントの定義（Markdown）のフロントマターの1つの項目（1行で書くもの）を書き換える。なければ足す */
export function rewriteField(markdown, key, value) {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(markdown);
  if (!match) throw new Error('エージェントの定義にフロントマターがありません。');
  const line = new RegExp(`^${key}:.*$`, 'm');
  const body = line.test(match[2]) ? match[2].replace(line, `${key}: ${value}`) : `${match[2]}\n${key}: ${value}`;
  return `${match[1]}${body}${match[3]}${markdown.slice(match[0].length)}`;
}

/** エージェントの定義（Markdown）のフロントマターの model を書き換える。なければ足す */
export function rewriteModel(markdown, modelId) {
  return rewriteField(markdown, 'model', modelId);
}

/**
 * エージェントの定義（Markdown）のフロントマターに tools を足す。すでに tools があれば、何も変えない（null）。
 * 変換スクリプトは、tools のないエージェントには tools を書かない（Claude Code では全ツールを継ぐ）。
 */
export function addTools(markdown, tools) {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(markdown);
  if (!match) throw new Error('エージェントの定義にフロントマターがありません。');
  if (/^tools:/m.test(match[2])) return null;
  return `${match[1]}${match[2]}\ntools: ${tools.join(', ')}${match[3]}${markdown.slice(match[0].length)}`;
}

/** フックの入力などの全文を記録に残すと大きいので、要点だけにする */
export function summarizeMessage(message) {
  const base = { type: message.type, subtype: message.subtype };
  if (message.type === 'assistant') {
    const blocks = message.message?.content ?? [];
    return {
      ...base,
      agentId: message.agent_id ?? null,
      model: message.message?.model,
      blocks: blocks.map((b) => (b.type === 'tool_use' ? { tool_use: b.name, input: b.input } : b.type === 'text' ? { text: String(b.text).slice(0, 2000) } : { [b.type]: true })),
    };
  }
  if (message.type === 'result') {
    return { ...base, is_error: message.is_error, result: String(message.result ?? '').slice(0, 2000), errors: message.errors, total_cost_usd: message.total_cost_usd, num_turns: message.num_turns };
  }
  if (message.type === 'system' && message.subtype === 'init') {
    return { ...base, model: message.model, agents: message.agents, plugins: (message.plugins ?? []).map((p) => p.name), plugin_errors: message.plugin_errors, mcp_servers: message.mcp_servers, tools: message.tools };
  }
  if (message.type === 'system' && message.subtype === 'task_started') {
    return { ...base, task_id: message.task_id, tool_use_id: message.tool_use_id, subagent_type: message.subagent_type, is_backgrounded: message.is_backgrounded, description: message.description };
  }
  return base;
}

/**
 * 内側の EVAL のつなぎ口を作る。生成プラグインの中心の処理を起こし、Agent SDK につなぐ。
 * @param {object} options
 * @param {{ query: Function, USAGE_LIMIT_ERROR_PREFIXES?: string[] }} options.sdk Agent SDK（試験は偽物を渡せる）
 * @param {string} options.pluginRoot Copilot CLI 向けの生成プラグイン（中心の処理と画面、エージェントの定義の既定を読む）
 * @param {string} options.convertedRoot 置き換えた版（Claude Code が読む。変換レポートつき）
 * @param {string} options.workDir 作業フォルダ（試すエージェントの cwd）
 * @param {string} options.runDir この実行の置き場所（一時的なホーム、記録、置き換えた版のコピー、偽の gh）。作業フォルダの外
 * @param {object} [options.envExtra] 試すエージェントの環境変数に足すもの
 * @param {string} [options.mainModel] メインのエージェントのモデル（Claude Code の ID）
 * @param {boolean} [options.sandbox] 統括の実行を OS のサンドボックスで動かすか
 * @param {(entry: object) => void} [options.record] 記録（events.jsonl に書く 1 件）を受け取る
 * @param {Function} [options.startUi] (core) => Promise<{ url, close }>。省くと、生成プラグインの ui/app.mjs を使う
 * @param {Function} [options.importModule] モジュールの読み込み（試験用）
 * @param {(turn: { id: string, name: string, lastText: string, turns: number }) => void} [options.onOrchestratorTurnEnd]
 *   統括が手番を終え、中心の処理がそのイベントを処理し終えたときに呼ぶ（Copilot CLI がメインのエージェントに知らせる代わり。4.7、4.15）
 */
export async function createInnerAdapter(options) {
  const {
    sdk, pluginRoot, convertedRoot, workDir, runDir, envExtra = {}, mainModel = 'claude-sonnet-5-5', sandbox = false,
    record = () => {}, importModule = (file) => import(pathToFileURL(file).href), onOrchestratorTurnEnd = null,
  } = options;
  for (const key of ['sdk', 'pluginRoot', 'convertedRoot', 'workDir', 'runDir']) {
    if (!options[key]) throw new Error(`createInnerAdapter には ${key} が要ります。`);
  }

  // ---- 変換レポートから、名前を決める ------------------------------------------------------------
  const report = readConversionReport(convertedRoot);
  const modelMap = modelMapOf(report);
  const pluginName = report.plugin;
  const extension = (report.extensions ?? []).find((e) => e.name === pluginName) ?? (report.extensions ?? [])[0];
  if (!extension) throw new Error('この生成プラグインには、エクステンション（中心の処理と画面）がありません。');
  const serverName = extension.server;
  const reportAgents = new Map((report.agents ?? []).map((a) => [a.name, a]));
  const orchestratorType = `${pluginName}:orchestrator`;

  // ---- 中心の処理と画面を読み込む --------------------------------------------------------------------
  const extDir = path.join(pluginRoot, 'com.github.copilot', 'extensions', extension.name);
  const { createCore } = await importModule(path.join(extDir, 'core', 'index.mjs'));
  // core が投げる断り。同じファイルの同じクラスなので instanceof で見分けられる
  const { RecordRefusal } = await importModule(path.join(extDir, 'core', 'records.mjs'));
  // 統括が呼ぶ記録のツール（名前の後ろの部分）。adapter.mjs と同じく TOOL_DEFS の caller から作る
  const { TOOL_DEFS } = await importModule(path.join(extDir, 'core', 'tools.mjs'));
  const startUi = options.startUi ?? (await (async () => {
    const { startApp } = await importModule(path.join(extDir, 'ui', 'app.mjs'));
    return (core) => startApp({ core, cwd: workDir });
  })());

  fs.mkdirSync(runDir, { recursive: true });
  const binDir = path.join(runDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const ghStub = path.join(binDir, 'gh');
  fs.writeFileSync(ghStub, GH_STUB, { mode: 0o755 });

  // ---- 状態 ---------------------------------------------------------------------------------------
  const agents = new Map(); // agentId → 一覧と記録に使う情報
  const runs = new Map(); // 統括の番号 → 実行
  const toolOwner = new Map(); // tool_use_id → 呼んだエージェントの番号
  const pendingLaunches = []; // Agent ツールの呼び出し（サブエージェントが始まったときに、親を結び付ける）
  const chatLog = [];
  const pendingModels = new Map(); // 始まりのフックより先にメッセージが届いたエージェントの、実際のモデル
  let overrides = null;
  let seq = 0;
  const limitPrefixes = await usageLimitPrefixes(sdk);
  const state = { limitHit: null };

  const emit = (event) => {
    const full = { at: now(), ...event };
    // 記録には、大きな引数（ファイルの中身など）を切り詰めて残す。中心の処理には全文を渡す
    const logged = full.arguments !== undefined && JSON.stringify(full.arguments).length > 2000 ? { ...full, arguments: `${JSON.stringify(full.arguments).slice(0, 2000)}…（切り詰めた）` } : full;
    record({ t: 'event', e: logged });
    core.onEvent(full);
  };

  /** 実際のモデルを、画面の選択と比べられる名前にする。選んだ名前が同じ ID に当たるなら選んだ名前、そうでなければ ID に当たる名前 */
  function neutralModelName(selected, actualId) {
    if (typeof selected === 'string') {
      try {
        if (toClaudeModelId(modelMap, selected) === actualId) return selected;
      } catch {
        // 表にない名前は比べられない
      }
    }
    return toCopilotName(modelMap, actualId) ?? actualId;
  }

  function noteModel(agentId, actualId) {
    const agent = agents.get(agentId);
    if (!agent) {
      if (actualId) pendingModels.set(agentId, actualId);
      return;
    }
    if (!actualId || agent.actualClaudeId === actualId) return;
    agent.actualClaudeId = actualId;
    agent.model = neutralModelName(agent.selectedModel, actualId);
    emit({ type: 'agent.configured', agentId, model: agent.model });
  }

  /** モデルに見えるツール名を、Copilot CLI のときと同じ名前（<エクステンション>_<ツール>）にそろえる（課題の洗い出しが名前で見分けるため） */
  function neutralToolName(name) {
    const prefix = `mcp__${serverName}__`;
    return typeof name === 'string' && name.startsWith(prefix) ? `${extension.name}_${name.slice(prefix.length)}` : name;
  }

  // ---- 記録のツール --------------------------------------------------------------------------------
  // 断るときは、例外を投げず、理由の文を入れた失敗の結果（isError）を返す。モデルが理由を読んで直せる、「作業を終えてください」が届く
  // （MCP の公式の形。ハンドラーが投げた例外は SDK が生の文にして返すので、文を決めたいときは自分で isError を返す。
  //   Copilot CLI 用の adapter.mjs の callTool と同じ扱い。Copilot CLI は例外の文を消すので、あちらは failure の結果を返す。V1 の不具合 2）。
  async function callTool(shortName, args, ctx, root) {
    try {
      if (shortName === 'open') return describeOpened(await core.open({ requestText: args?.requestText }));
      const agentId = toolOwner.get(ctx.toolUseId) ?? ctx.agentId ?? root?.id;
      // 答えを渡すツールは、メインのエージェントが呼ぶ（4.15）。中心の処理の答えの窓口に渡す
      if (shortName === 'answer') return await core.relayHumanAnswer({ answer: args?.answer }, { agentId });
      return await core.handleTool(shortName, args, { agentId });
    } catch (error) {
      if (error instanceof RecordRefusal) {
        record({ t: 'tool_refused', run: root?.id ?? 'main', tool: shortName, reason: error.message });
        return failureResult(error.message);
      }
      console.error(`[内側のつなぎ口] ツール「${shortName}」の処理で予期しない失敗が起きました：`, error);
      record({ t: 'tool_error', run: root?.id ?? 'main', tool: shortName, message: String(error?.message ?? error), stack: String(error?.stack ?? '') });
      return failureResult(shortName === 'open' ? OPEN_FAILED : shortName === 'answer' ? ANSWER_FAILED : RECORD_FAILED);
    }
  }

  function buildToolServer(root) {
    return createToolServer({
      name: serverName,
      tools: core.toolDefinitions.map((definition) => ({
        name: definition.shortName,
        description: definition.description,
        inputSchema: definition.parameters,
        handler: (args, ctx) => callTool(definition.shortName, args, ctx, root),
      })),
      onCall: (event) => record({ t: 'mcp', run: root?.id ?? 'main', ...event }),
    });
  }

  const mcpTools = () => core.toolDefinitions.map((definition) => mcpToolName(serverName, definition.shortName));

  // ---- フック（統括の実行） ---------------------------------------------------------------------------
  // Agent の呼び出しの subagent_type は、プラグインの名前を付けない書き方（worker）でも、始まりのフックの agent_type は <プラグイン>:<名前> になりうる
  function takePendingLaunch(agentType) {
    const index = pendingLaunches.findIndex((p) => p.subagentType === agentType || (typeof p.subagentType === 'string' && p.subagentType !== '' && agentType?.endsWith(`:${p.subagentType}`)));
    return index >= 0 ? pendingLaunches.splice(index, 1)[0] : null;
  }

  function onPreToolUse(root, input) {
    const agentId = input.agent_id ?? root.id;
    if (input.tool_use_id) toolOwner.set(input.tool_use_id, agentId);
    const toolName = neutralToolName(input.tool_name);
    if (AGENT_TOOL_NAMES.has(input.tool_name)) {
      pendingLaunches.push({ toolUseId: input.tool_use_id, owner: agentId, subagentType: input.tool_input?.subagent_type, input: input.tool_input ?? {} });
    }
    emit({ type: 'tool.started', agentId, toolCallId: input.tool_use_id, toolName, arguments: input.tool_input });
    let verdict;
    try {
      verdict = core.preToolUse({ agentId, parentAgentId: agents.get(agentId)?.parentAgentId ?? null, toolName });
    } catch {
      verdict = { deny: false };
    }
    if (verdict?.deny) {
      emit({ type: 'tool.completed', agentId, toolCallId: input.tool_use_id, toolName, success: false, error: String(verdict.reason ?? '') });
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: String(verdict.reason ?? '') } };
    }
    return { continue: true };
  }

  function onToolDone(root, input, success) {
    const agentId = toolOwner.get(input.tool_use_id) ?? input.agent_id ?? root.id;
    toolOwner.delete(input.tool_use_id);
    const error = success ? undefined : typeof input.error === 'string' ? input.error : input.error?.message;
    emit({ type: 'tool.completed', agentId, toolCallId: input.tool_use_id, toolName: neutralToolName(input.tool_name), success, error });
    return { continue: true };
  }

  function onSubagentStart(root, input) {
    const agentId = input.agent_id;
    const launch = takePendingLaunch(input.agent_type);
    const parentAgentId = launch?.owner ?? root.id;
    const selected = overrides?.[input.agent_type]?.model ?? null;
    const description = launch?.input.description;
    agents.set(agentId, {
      agentId, parentAgentId, agentType: input.agent_type, displayName: description ?? input.agent_type, status: 'running',
      executionMode: launch?.input.run_in_background === false ? 'sync' : 'background', selectedModel: selected, model: undefined, actualClaudeId: undefined,
      startedAt: now(), endedAt: null,
    });
    emit({
      type: 'agent.started', agentId, parentAgentId, agentType: input.agent_type, model: undefined,
      executionMode: agents.get(agentId).executionMode, description,
    });
    if (pendingModels.has(agentId)) noteModel(agentId, pendingModels.get(agentId));
    return { continue: true };
  }

  function onSubagentStop(root, input) {
    const agent = agents.get(input.agent_id);
    if (agent && agent.status === 'running') {
      agent.status = 'completed';
      agent.endedAt = now();
    }
    emit({ type: 'agent.completed', agentId: input.agent_id, cancelled: false, response: input.last_assistant_message });
    return { continue: true };
  }

  const makeHooks = (root) => ({
    PreToolUse: [{ hooks: [async (input) => onPreToolUse(root, input)] }],
    PostToolUse: [{ hooks: [async (input) => onToolDone(root, input, true)] }],
    PostToolUseFailure: [{ hooks: [async (input) => onToolDone(root, input, false)] }],
    SubagentStart: [{ hooks: [async (input) => onSubagentStart(root, input)] }],
    SubagentStop: [{ hooks: [async (input) => onSubagentStop(root, input)] }],
  });

  // ---- 統括の実行のメッセージ ---------------------------------------------------------------------------
  function finish(root, status, event) {
    if (root.finalized) return;
    root.finalized = true;
    const agent = agents.get(root.id);
    agent.status = status;
    agent.endedAt = now();
    emit({ agentId: root.id, ...event });
  }

  // 統括の手番の終わり。初めの手番は agent.completed（finish）、2回目からは agent.idle を届ける（Copilot CLI と同じ。11章 #19）
  function endTurn(root, event) {
    root.turnEnded = true;
    root.turns += 1;
    if (root.turns === 1) finish(root, event.type === 'agent.failed' ? 'failed' : 'completed', event);
    else {
      const agent = agents.get(root.id);
      agent.status = event.type === 'agent.failed' ? 'failed' : 'completed';
      agent.endedAt = now();
      emit({ agentId: root.id, ...(event.type === 'agent.failed' ? event : { type: 'agent.idle', response: event.response }) });
    }
    if (event.type !== 'agent.failed' && typeof onOrchestratorTurnEnd === 'function') {
      const turn = { id: root.id, name: root.name, lastText: String(event.response ?? root.lastText ?? ''), turns: root.turns };
      // 中心の処理がイベントを処理し終えてから知らせる（人の判断待ちになったかを、知らせを受けた側が状態で見分けられるように）
      core.whenIdle().then(() => onOrchestratorTurnEnd(turn)).catch(() => {});
    }
  }

  function handleMessage(root, message) {
    if (message.type !== 'stream_event') record({ t: 'sdk', run: root.id, m: summarizeMessage(message) });
    if (typeof message.session_id === 'string' && message.session_id !== '') root.sessionId = message.session_id;
    if (message.type === 'system' && message.subtype === 'init') {
      root.init = {
        model: message.model, agents: message.agents ?? [], plugins: (message.plugins ?? []).map((p) => p.name), pluginErrors: message.plugin_errors ?? [],
        mcpServers: message.mcp_servers ?? [], tools: message.tools ?? [],
      };
      return;
    }
    if (message.type === 'assistant') {
      const owner = message.agent_id ?? root.id;
      noteModel(owner, message.message?.model);
      for (const block of message.message?.content ?? []) {
        if (block.type === 'text' && !message.parent_tool_use_id) root.lastText = block.text;
        if (block.type === 'tool_use' && block.name === 'Skill') root.skillsUsed.push(String(block.input?.skill ?? ''));
      }
      return;
    }
    if (message.type === 'result') {
      root.costUsd = message.total_cost_usd ?? root.costUsd;
      root.numTurns = message.num_turns ?? root.numTurns;
      const failed = message.is_error === true || String(message.subtype).startsWith('error');
      if (root.cancelled || root.turnEnded) return;
      if (!failed) {
        endTurn(root, { type: 'agent.completed', cancelled: false, response: message.result ?? root.lastText });
        return;
      }
      const reason = text(message.result) || (message.errors ?? []).join('、') || `エラーで終わりました（${message.subtype}）`;
      if (limitPrefixes.some((prefix) => reason.startsWith(prefix))) state.limitHit = { message: reason, runId: root.id };
      endTurn(root, { type: 'agent.failed', error: reason });
    }
  }

  async function consume(root, query) {
    try {
      for await (const message of query) handleMessage(root, message);
    } catch (error) {
      if (!root.cancelled && !root.turnEnded) endTurn(root, { type: 'agent.failed', error: `統括の実行が失敗しました：${error?.message ?? error}` });
    }
    if (!root.turnEnded && !root.cancelled) endTurn(root, { type: 'agent.failed', error: '統括の実行が、結果を返さずに終わりました。' });
    root.ended = true;
  }

  // ---- 統括の起動と取り消し ----------------------------------------------------------------------------
  /** 統括が使ってよいツール（Claude Code の名前）：組み込みの読む・探す・エージェントを呼ぶツールと、統括が呼ぶ記録のツール */
  const orchestratorTools = () => [
    ...ORCHESTRATOR_BUILTIN_TOOLS,
    ...TOOL_DEFS.filter((def) => String(def.caller).split(',').includes('orchestrator')).map((def) => mcpToolName(serverName, def.name)),
  ];

  /**
   * 置き換えた版のコピーを作り、エージェントの定義の model と effort を画面で選んだものに書き換える。
   * 統括の定義に tools がなければ、使ってよいツールだけを tools に書く（上の orchestratorTools）。作業・検証の tools は、統括の tools に絞られない。
   */
  function prepareRunPlugin(id, orchestratorCopilotName) {
    const dest = path.join(runDir, `plugin-${id}`);
    fs.cpSync(convertedRoot, dest, { recursive: true });
    const applied = {};
    const appliedEfforts = {};
    const rewrite = (agentName, { model, effort } = {}) => {
      const entry = reportAgents.get(agentName);
      if (!entry) return;
      const file = path.join(dest, entry.file);
      let text = fs.readFileSync(file, 'utf8');
      if (model) {
        const modelId = toClaudeModelId(modelMap, model);
        text = rewriteModel(text, modelId);
        applied[`${pluginName}:${agentName}`] = modelId;
      }
      // 思考の深さは、Claude Code のエージェントの定義の effort（変換スクリプトが reasoningEffort を当てる先と同じ）
      if (effort) {
        text = rewriteField(text, 'effort', effort);
        appliedEfforts[`${pluginName}:${agentName}`] = effort;
      }
      fs.writeFileSync(file, text);
    };
    for (const [type, settings] of Object.entries(overrides ?? {})) {
      const [plugin, ...rest] = type.split(':');
      if (plugin === pluginName && type !== orchestratorType) rewrite(rest.join(':'), settings);
    }
    rewrite('orchestrator', { model: orchestratorCopilotName, effort: overrides?.[orchestratorType]?.effort });
    let tools = null;
    const orchestratorEntry = reportAgents.get('orchestrator');
    if (orchestratorEntry) {
      const file = path.join(dest, orchestratorEntry.file);
      const allowed = orchestratorTools();
      const written = addTools(fs.readFileSync(file, 'utf8'), allowed);
      if (written !== null) {
        fs.writeFileSync(file, written);
        tools = allowed;
        record({ t: 'orchestrator_tools', run: id, tools });
      }
    }
    return { dest, applied, appliedEfforts, tools };
  }

  function cancelRoot(root) {
    if (root.ended || root.cancelled) return;
    root.cancelled = true;
    for (const agent of agents.values()) {
      if (agent.status === 'running') {
        agent.status = 'cancelled';
        agent.endedAt = now();
      }
    }
    // 取り消すと、統括の終わりだけが届く（統括の下の作業・検証の終わりは届かない。設計書 4.4）
    root.finalized = true;
    emit({ type: 'agent.completed', agentId: root.id, cancelled: true, response: root.lastText });
    try {
      root.abort.abort();
      root.query.close();
    } catch {
      // すでに閉じている
    }
  }

  const mainCopilotName = toCopilotName(modelMap, mainModel) ?? mainModel;

  const port = {
    async startAgent({ agentType, name, model, prompt }) {
      if (agentType !== orchestratorType) throw new Error(`統括（${orchestratorType}）のほかは起動できません：${agentType}`);
      const copilotName = model ?? mainCopilotName;
      const claudeId = toClaudeModelId(modelMap, copilotName);
      const id = `orch-${++seq}`;
      const root = {
        id, name, status: 'running', cancelled: false, finalized: false, ended: false, skillsUsed: [], lastText: '', costUsd: 0, numTurns: 0, init: null,
        sessionId: null, turns: 0, turnEnded: false,
      };
      runs.set(id, root);
      agents.set(id, {
        agentId: id, parentAgentId: null, agentType, displayName: name ?? agentType, status: 'running', executionMode: 'background',
        selectedModel: copilotName, model: undefined, actualClaudeId: undefined, startedAt: now(), endedAt: null,
      });
      const copy = prepareRunPlugin(id, copilotName);
      root.plugin = copy;
      root.abort = new AbortController();
      const home = path.join(runDir, `home-${id}`);
      fs.mkdirSync(home, { recursive: true });
      // 同じ統括の続き（sendMessage）でも同じ設定で動かすので、組み立て方を残す
      root.optionsFor = (resume) => makeQueryOptions({
        cwd: workDir, home, model: claudeId, plugins: [copy.dest], mcpServers: { [serverName]: buildToolServer(root) }, mcpTools: mcpTools(),
        hooks: makeHooks(root), agent: orchestratorType, sandbox, maxTurns: ORCHESTRATOR_MAX_TURNS, abortController: root.abort,
        effort: copy.appliedEfforts[orchestratorType],
        // Agent は既定で裏で動く。前面で動かして終わるのを待つかは、統括の指示（run_in_background: false）に従うかで決まる。
        // 環境変数 CLAUDE_CODE_DISABLE_BACKGROUND_TASKS で強制はしない（指示に従うかも試すため）
        envExtra,
        resume,
      });
      root.query = sdk.query({ prompt, options: root.optionsFor(undefined) });
      emit({ type: 'agent.started', agentId: id, parentAgentId: undefined, agentType, model: copilotName, executionMode: 'background', description: undefined });
      root.done = consume(root, root.query);
      return { agentId: id };
    },

    async cancelAgent(agentId) {
      const root = runs.get(agentId);
      if (root) cancelRoot(root);
    },

    // 手番を終えた統括に、続きの文を送る（4.15）。同じ会話（session_id）を resume した query() を、同じ番号のまま始める
    async sendMessage(agentId, message) {
      const root = runs.get(agentId);
      if (!root || root.cancelled || !root.sessionId) return { sent: false, error: NOT_ACCEPTING };
      await root.done; // 前の手番の query() が終わりきるのを待つ
      if (root.cancelled) return { sent: false, error: NOT_ACCEPTING };
      const agent = agents.get(root.id);
      agent.status = 'running';
      agent.endedAt = null;
      root.ended = false;
      root.turnEnded = false;
      root.lastText = '';
      root.query = sdk.query({ prompt: String(message), options: root.optionsFor(root.sessionId) });
      record({ t: 'orchestrator_resumed', run: root.id, turn: root.turns + 1 });
      root.done = consume(root, root.query);
      return { sent: true };
    },

    async listTasks() {
      return [...agents.values()].map((a) => ({
        agentId: a.agentId, displayName: a.displayName, status: a.status, executionMode: a.executionMode, agentType: a.agentType, parentAgentId: a.parentAgentId,
      }));
    },

    // map は { '<プラグイン>:worker': { model?: '<Copilot の名前>', effort? }, ... }。null で外す。効かせるのは、次に統括を起動するとき
    async setSubagentSettings(map) {
      overrides = map === null || map === undefined ? null : { ...map };
    },

    async getCurrentModel() {
      return { model: mainCopilotName, isAuto: false };
    },

    async listModels() {
      return copilotModelList(modelMap);
    },

    async log(line) {
      chatLog.push({ at: now(), text: String(line) });
    },
  };

  const core = createCore({
    port,
    pluginRoot,
    pluginName,
    dataRoot: path.join(runDir, 'plugin-data', pluginName, 'runs'),
    sessionId: newId('dev-eval'),
    cwd: workDir,
    ghCommand: ghStub,
    startUi,
  });

  /** 変換レポートのエージェントの tools が使うツールと、core が出すツールが過不足なく合うか */
  function checkToolNames() {
    const provided = new Set(core.toolDefinitions.map((d) => d.shortName));
    const referenced = new Set((report.extension_tools ?? []).filter((r) => r.server === serverName).map((r) => r.tool));
    return {
      missing: [...referenced].filter((tool) => !provided.has(tool)).sort(),
      unused: [...provided].filter((tool) => !referenced.has(tool)).sort(),
    };
  }

  return {
    pluginName,
    serverName,
    core,
    port,
    /** メインの query() に足すもの（画面を開くツールなど）。実行ごとに別のインスタンス */
    mainParts() {
      return { mcpServers: { [serverName]: buildToolServer(null) }, mcpTools: mcpTools() };
    },
    checkToolNames,
    agents: () => [...agents.values()].map((a) => ({ ...a })),
    runs: () => [...runs.values()].map((r) => ({
      id: r.id, name: r.name, cancelled: r.cancelled, ended: r.ended, init: r.init, skillsUsed: [...r.skillsUsed], costUsd: r.costUsd,
      numTurns: r.numTurns, turns: r.turns, lastText: r.lastText, appliedModels: r.plugin?.applied ?? {}, appliedEfforts: r.plugin?.appliedEfforts ?? {}, orchestratorTools: r.plugin?.tools ?? null,
    })),
    chatLog: () => [...chatLog],
    limitHit: () => state.limitHit,
    /** 統括の実行が終わるのを待つ（なければすぐ返る） */
    async whenRunsEnded() {
      await Promise.all([...runs.values()].map((r) => r.done));
    },
    async shutdown() {
      for (const root of runs.values()) cancelRoot(root);
      await Promise.all([...runs.values()].map((r) => r.done?.catch(() => {})));
      await core.shutdown();
    },
  };
}
