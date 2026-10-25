// 生成プラグインのつなぎ口（設計書 3.2）。Copilot SDK の joinSession を引数で受け取り、
// 中心の処理（core/）と画面（ui/）を Copilot CLI につなぐ。
//
// - Copilot CLI に依る部分は、このファイルに集める。中心の処理とは、窓口 port と中立のイベントだけでやり取りする（BLUEPRINT 3.1、3.2）。
// - このファイルは、どの生成プラグインでも中身が同じ。プラグインの名前は plugin.json から読み、根は自分の場所から求める。
// - Copilot SDK を読み込むのは入口の extension.mjs だけで、ここは joinSession を引数で受ける。
//   試験は、偽物のセッションを返す joinSession を渡して、startAdapter を直接呼ぶ。
// - 標準出力は Copilot CLI との通信（JSON-RPC）に使われるので、console.log は使わない。調べるための出力は console.error に出す。

import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCore } from './core/index.mjs';
import { RecordRefusal } from './core/records.mjs';
import { TOOL_DEFS, buildToolDefinitions, toolFullName } from './core/tools.mjs';
import { startApp } from './ui/app.mjs';

const AGENT_FILE_SUFFIX = '.agent.md';
const UNKNOWN_TOOL = '不明なツール';
const TASK_TOOL = 'task'; // 統括が作業・検証を呼ぶ Copilot CLI のツール。引数の description が「担当」の元になる

// 予期しない失敗のときにモデルへ返す文。内部の情報（エラーの文、場所、スタック）は出さない。くわしくは標準エラーに残す。
const OPEN_FAILED = 'Web管理画面を開けませんでした。ユーザーに、開けなかったことを伝えてください。';
const RECORD_FAILED = '記録のツールの処理で、予期しない失敗が起きました。もう一度呼んでも同じなら、作業を終えてください。';

// ---- プラグインの名前と根 --------------------------------------------------------------------------------

// プラグインの根は、このファイル（extensions/<名前>/adapter.mjs）の3つ上。名前は plugin.json の name。
function readPluginName(pluginRoot) {
  const file = path.join(pluginRoot, 'plugin.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (error) {
    throw new Error(`プラグインの設定ファイル（${file}）が読めません：${error.message}`);
  }
  const name = manifest?.name;
  if (typeof name !== 'string' || name === '') throw new Error(`プラグインの設定ファイル（${file}）に name がありません。`);
  return name;
}

// このプラグインのエージェントの名前（agents/<名前>.agent.md の <名前>）
function listOwnAgentNames(pluginRoot) {
  try {
    const files = readdirSync(path.join(pluginRoot, 'com.github.copilot', 'agents'));
    return new Set(files.filter((f) => f.endsWith(AGENT_FILE_SUFFIX)).map((f) => f.slice(0, -AGENT_FILE_SUFFIX.length)));
  } catch {
    return new Set();
  }
}

async function readWorkingDirectory(session) {
  try {
    const cwd = (await session.rpc.workspaces.getWorkspace())?.workspace?.cwd;
    if (typeof cwd === 'string' && cwd !== '') return cwd;
  } catch {
    // 取れなければ、エクステンションの作業フォルダ（Copilot CLI がセッションの作業フォルダで起動する）を使う
  }
  return process.cwd();
}

// ---- 統括エージェントが使ってよいツール -----------------------------------------------------------------------

// 統括の定義（orchestrator.agent.md）には tools を書かない。書くと、Copilot CLI は子（作業・検証）のツールも、統括が持つ範囲に絞る
// （更新履歴 1.0.67・1.0.68。V1 の不具合 1）。そのため統括には全ツールを持たせ、使ってよいツールの一覧（下）にないものを、
// フック onPreToolUse で拒む。一覧にないものを拒む形なので、Copilot CLI の版が上がって新しい書き込みのツールが増えても、
// 統括が書き込める向きには倒れない。ツールの名前は Copilot CLI のもので、子のモデルの族で変わる（V1 の 4 節）。
//
// 一覧は、tools の別名 agent・read・search に当たるツールと、統括が呼ぶ記録のツール（core/tools.mjs で caller に orchestrator を持つもの）。
// 許さないもの（判断はメモの「V1 不具合1の直し」）：edit・execute・web の別名、skill、todo、MCP のツール、ほかのエクステンションのツール、
// 検証の記録のツール（<名前>_verdict）、canvas、sql、スケジュール、ツール検索など。
const ORCHESTRATOR_BUILTIN_TOOLS = Object.freeze([
  'view', // read
  'grep', 'glob', 'rg', // search（Claude の族：grep・glob、GPT の族：rg・glob）
  'task', 'read_agent', 'list_agents', 'write_agent', // agent
]);

// 入力の項目を読む。読めなければ undefined（入力が壊れていても、フックは例外を投げない）
function readField(input, key) {
  try {
    return input?.[key];
  } catch {
    return undefined;
  }
}

// 統括が呼ぶ記録のツールの、名前の後ろの部分（plan・review・issue・finish・show）
const ORCHESTRATOR_RECORD_SHORT_NAMES = TOOL_DEFS.filter((def) => String(def.caller).split(',').includes('orchestrator')).map((def) => def.name);

function orchestratorToolsOf(pluginName) {
  return new Set([...ORCHESTRATOR_BUILTIN_TOOLS, ...ORCHESTRATOR_RECORD_SHORT_NAMES.map((name) => toolFullName(pluginName, name))]);
}

// ---- 許可の求め → 待ちの中身（BLUEPRINT 3.1 の detail） ----------------------------------------------------

const strings = (list) => (Array.isArray(list) ? list.filter((v) => typeof v === 'string' && v !== '') : []);

// 使おうとしているツール。ツールの名前がある求めは、その名前を添える。
function toolKindOf(request, kind) {
  const named = (...names) => names.filter((name) => typeof name === 'string' && name !== '').join('/');
  if (kind === 'mcp') return named(request.serverName, request.toolName) || kind;
  if (kind === 'custom-tool' || kind === 'hook') return named(request.toolName) || kind;
  return kind;
}

// 画面に出す項目を取り出す。エクステンション自身の権限の求めも、種類が分かるように渡す（出すかどうかは中心の処理が決める。4.14）。
function describePermission(request) {
  const req = request !== null && typeof request === 'object' ? request : {};
  const kind = typeof req.kind === 'string' ? req.kind : '';
  const detail = { permissionKind: kind, toolKind: toolKindOf(req, kind) };
  switch (kind) {
    case 'shell':
      detail.command = String(req.fullCommandText ?? '');
      detail.paths = strings(req.possiblePaths);
      detail.urls = strings((Array.isArray(req.possibleUrls) ? req.possibleUrls : []).map((u) => (typeof u === 'string' ? u : u?.url)));
      if (typeof req.warning === 'string' && req.warning !== '') detail.warning = req.warning;
      break;
    case 'write':
      detail.paths = strings([req.fileName]);
      break;
    case 'read':
      detail.paths = strings([req.path]);
      break;
    case 'url':
      detail.urls = strings([req.url]);
      break;
    default:
      break;
  }
  // requestSandboxPermissive が真の求めは、サンドボックスの外ではなく「記録だけにして中で動かし直す」求め。外とは示さない（R2 の 13）。
  detail.sandboxPermissive = Boolean(req.requestSandboxPermissive);
  detail.sandboxBypass = Boolean(req.requestSandboxBypass) && !detail.sandboxPermissive;
  return detail;
}

// ---- Copilot CLI のイベント → 中立のイベント（BLUEPRINT 3.1） --------------------------------------------------

function timeOf(event) {
  const at = Date.parse(event.timestamp);
  return Number.isFinite(at) ? at : Date.now();
}

// 画面の枠の「担当」。統括が task ツールを呼んだときの説明（引数の description）を使う。サブエージェントの開始のイベントには、
// その呼び出しの toolCallId がつくので、開始より前の task の呼び出しのイベントで description を覚えて、toolCallId で引く。
// 見つからないときは、agentDisplayName、agentDescription（エージェントの定義の説明）の順に使う。
// 実機（Copilot CLI 1.0.102）の agentDisplayName は、呼び出しの説明ではなく短い名前（worker など）だった（V1）。
// 親のないもの（統括。tasks.startAgent で起動する）には付けない。統括の担当は、中心の処理が頼まれた作業の要約を持っている。
function taskDescriptionOf(data, called) {
  for (const text of [called, data.agentDisplayName, data.agentDescription]) if (typeof text === 'string' && text.trim() !== '') return text;
  return undefined;
}

const hasRequestId = (data) => typeof data.requestId === 'string' && data.requestId !== '';

function createEventConverter({ pluginName, ownAgentNames }) {
  const prefix = `${pluginName}:`;
  const parents = new Map(); // エージェントの番号 → 親の番号（tasks.list に親の番号がないため、開始のイベントから覚える）
  const toolNames = new Map(); // ツールの呼び出しの番号 → ツールの名前（終わりのイベントに名前がないため、開始から覚える）
  const lastReplies = new Map(); // エージェントの番号 → 最後の返事（フック onSubagentStop で届き、終わりのイベントで使う）
  const calledTasks = new Map(); // ツールの呼び出しの番号 → task の description（開始のイベントで使うか、呼び出しが終わったら消す）

  // このプラグインのエージェントの名前は、'<プラグイン>:<エージェント>' の形にそろえる。ほかのエージェントはそのまま。
  const qualify = (raw) => {
    const name = typeof raw === 'string' ? raw : '';
    return name !== '' && !name.startsWith(prefix) && ownAgentNames.has(name) ? `${prefix}${name}` : name;
  };
  const agentTypeOf = (data) => {
    const candidates = [data.agentType, data.agentName].map(qualify).filter((name) => name !== '');
    return candidates.find((name) => name.startsWith(prefix)) ?? candidates[0] ?? '';
  };

  function convert(event) {
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') return null;
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {};
    const at = timeOf(event);
    const agentId = typeof event.agentId === 'string' && event.agentId !== '' ? event.agentId : undefined;
    switch (event.type) {
      case 'subagent.started': {
        if (!agentId) return null;
        const parentAgentId = typeof data.parentId === 'string' && data.parentId !== '' ? data.parentId : undefined;
        if (parentAgentId) parents.set(agentId, parentAgentId);
        const called = calledTasks.get(data.toolCallId);
        calledTasks.delete(data.toolCallId);
        return {
          type: 'agent.started',
          at,
          agentId,
          parentAgentId,
          agentType: agentTypeOf(data),
          model: data.model,
          executionMode: data.executionMode,
          description: parentAgentId ? taskDescriptionOf(data, called) : undefined,
        };
      }
      case 'subagent.configured':
        return agentId ? { type: 'agent.configured', at, agentId, model: data.model } : null;
      case 'subagent.completed': {
        if (!agentId) return null;
        const response = lastReplies.get(agentId);
        lastReplies.delete(agentId);
        return { type: 'agent.completed', at, agentId, cancelled: Boolean(data.cancelled), response };
      }
      case 'subagent.failed':
        return agentId ? { type: 'agent.failed', at, agentId, error: data.error } : null;
      case 'system.notification':
        return data.kind?.type === 'agent_idle' && typeof data.kind.agentId === 'string'
          ? { type: 'agent.idle', at, agentId: data.kind.agentId }
          : null;

      case 'tool.execution_start':
        if (typeof data.toolCallId === 'string') {
          toolNames.set(data.toolCallId, data.toolName);
          if (data.toolName === TASK_TOOL && typeof data.arguments?.description === 'string') calledTasks.set(data.toolCallId, data.arguments.description);
        }
        return { type: 'tool.started', at, agentId, toolCallId: data.toolCallId, toolName: data.toolName, arguments: data.arguments };
      case 'tool.execution_complete': {
        const toolName = toolNames.get(data.toolCallId) ?? UNKNOWN_TOOL;
        toolNames.delete(data.toolCallId);
        calledTasks.delete(data.toolCallId);
        const error = typeof data.error === 'string' ? data.error : data.error?.message;
        return { type: 'tool.completed', at, agentId, toolCallId: data.toolCallId, toolName, success: data.success, error };
      }

      // 確認の待ち。始めと終わりを requestId で結ぶので、requestId がないイベントは渡さない。
      case 'permission.requested':
        return hasRequestId(data)
          ? { type: 'wait.started', at, requestId: data.requestId, agentId, kind: 'permission', detail: describePermission(data.permissionRequest), resolvedByHook: Boolean(data.resolvedByHook) }
          : null;
      case 'user_input.requested':
        return hasRequestId(data)
          ? { type: 'wait.started', at, requestId: data.requestId, agentId, kind: 'question', detail: { question: String(data.question ?? '') }, resolvedByHook: false }
          : null;
      case 'session_limits_exhausted.requested':
        return hasRequestId(data) ? { type: 'wait.started', at, requestId: data.requestId, agentId, kind: 'limit', detail: {}, resolvedByHook: false } : null;
      case 'permission.completed':
        return hasRequestId(data) ? { type: 'wait.ended', at, requestId: data.requestId, kind: 'permission' } : null;
      case 'user_input.completed':
        return hasRequestId(data) ? { type: 'wait.ended', at, requestId: data.requestId, kind: 'question' } : null;
      case 'session_limits_exhausted.completed':
        return hasRequestId(data) ? { type: 'wait.ended', at, requestId: data.requestId, kind: 'limit', action: data.response?.action } : null;
      default:
        return null;
    }
  }

  return {
    convert,
    qualify,
    parentOf: (agentId) => parents.get(agentId) ?? null,
    noteReply(agentId, reply) {
      if (typeof agentId === 'string' && agentId !== '' && typeof reply === 'string') lastReplies.set(agentId, reply);
    },
  };
}

// ---- 窓口 port（BLUEPRINT 3.2）を session.rpc で作る ----------------------------------------------------------

// 選べるモデルの一覧の要素の形は、型で決まっていない（R2 の (2) の 2）。id と name を取り出せる要素だけを使う。
function readModels(list) {
  const models = [];
  for (const item of Array.isArray(list) ? list : []) {
    const id = typeof item === 'string' ? item : item?.id;
    if (typeof id !== 'string' || id === '') continue;
    models.push({ id, name: typeof item?.name === 'string' && item.name !== '' ? item.name : id });
  }
  return models;
}

function createPort(session, converter) {
  return {
    async startAgent({ agentType, name, model, prompt }) {
      const started = await session.rpc.tasks.startAgent({ agentType, name, prompt, ...(model ? { model } : {}) });
      return { agentId: started.agentId };
    },
    async cancelAgent(agentId) {
      await session.rpc.tasks.cancel({ id: agentId });
    },
    // tasks.list にはシェルなどのタスクも入る。エージェントだけを返す（R2 の (2) の 14）。
    async listTasks() {
      const listed = await session.rpc.tasks.list();
      return (Array.isArray(listed?.tasks) ? listed.tasks : [])
        .filter((task) => task?.type === 'agent')
        .map((task) => ({
          agentId: task.id,
          displayName: task.displayName ?? '',
          status: task.status,
          executionMode: task.executionMode,
          agentType: converter.qualify(task.agentType),
          parentAgentId: converter.parentOf(task.id),
        }));
    },
    // map は { '<プラグイン>:worker': { model?, effort? }, ... }。null で、このセッションの上書きをすべて外す。
    // 思考の深さの項目は effortLevel（rpc.d.ts の SubagentSettingsEntry）。
    async setSubagentSettings(map) {
      const entryOf = (s) => ({ ...(s?.model ? { model: s.model } : {}), ...(s?.effort ? { effortLevel: s.effort } : {}) });
      const agents = map === null || map === undefined ? null : Object.fromEntries(Object.entries(map).map(([agent, s]) => [agent, entryOf(s)]));
      await session.rpc.tools.updateSubagentSettings({ subagents: agents === null ? null : { agents } });
    },
    // Auto の選択は、モデルの番号が 'auto' になる（仮想のモデル auto。CurrentModel の説明）。実機で確かめる（設計書 11章 #7）。
    async getCurrentModel() {
      const current = await session.rpc.model.getCurrent();
      const model = typeof current?.modelId === 'string' ? current.modelId : '';
      return { model, isAuto: model.trim().toLowerCase() === 'auto' };
    },
    // rpc.models.list はクライアントの窓口で、エクステンションからは呼べない。session.rpc.model.list を使う（R2 の (2) の 2）。
    async listModels() {
      const listed = await session.rpc.model.list();
      return readModels(listed?.list);
    },
    async log(text) {
      await session.log(String(text));
    },
  };
}

// ---- 記録のツールの返り値 ------------------------------------------------------------------------------------

// 画面を開くツールの返り値。モデルがそのまま読み、ユーザーに伝える文なので、平易な日本語にする。
function describeOpened({ url, notices }) {
  const lines = [`Web管理画面の URL：${url}`];
  const list = Array.isArray(notices) ? notices.filter((n) => typeof n === 'string' && n !== '') : [];
  if (list.length > 0) lines.push('', 'ユーザーに伝えてください：', ...list.map((notice) => `- ${notice}`));
  return lines.join('\n');
}

// ---- つなぎ口の本体 -----------------------------------------------------------------------------------------

/**
 * Copilot CLI のセッションに加わり、記録のツール・フック・許可の求めの受け口・イベントの受け取りを登録して、
 * 中心の処理（core）と画面を起こす準備をする。画面のサーバーは、画面を開くツールが初めて呼ばれたときに起動する。
 * @param {object} options
 * @param {Function} options.joinSession `@github/copilot-sdk/extension` の joinSession（試験では偽物）
 * @returns {Promise<{ pluginName: string, pluginRoot: string, dataRoot: string, session: object, port: object, core: object, shutdown: () => Promise<void> }>}
 */
export async function startAdapter({ joinSession }) {
  if (typeof joinSession !== 'function') throw new Error('joinSession が渡されていません。');
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const pluginName = readPluginName(pluginRoot);
  const copilotHome = process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
  const dataRoot = path.join(copilotHome, 'plugin-data', pluginName, 'runs');
  const converter = createEventConverter({ pluginName, ownAgentNames: listOwnAgentNames(pluginRoot) });
  const orchestratorAgentType = `${pluginName}:orchestrator`;
  const orchestratorTools = orchestratorToolsOf(pluginName);

  // 中心の処理は、セッションに加わった後でないと作れない（窓口・セッションの番号・作業フォルダが要る）。
  // ツールは加わるときに渡す必要があるので、呼ばれたら中心の処理ができるまで待たせる。
  let core = null;
  let markReady;
  let markFailed;
  const ready = new Promise((resolve, reject) => {
    markReady = resolve;
    markFailed = reject;
  });
  ready.catch(() => {}); // 待つ呼び出しがなくても、未処理の拒否にしない

  // 断るときは、例外を投げず、理由の文を入れた失敗の結果を返す。ツールの処理が例外を投げると、Copilot CLI 1.0.102 は
  // モデルに「Tool execution failed」だけを返し、理由の文が消えるため（V1 の不具合 2）。resultType は failure
  // （denied は「拒まれた」の意味になる。rejected は手番が止まる）。
  async function callTool(shortName, args, invocation) {
    try {
      const readyCore = await ready;
      if (shortName === 'open') return describeOpened(await readyCore.open({ requestText: args?.requestText }));
      return await readyCore.handleTool(shortName, args, { agentId: invocation?.agentId });
    } catch (error) {
      if (error instanceof RecordRefusal) return { textResultForLlm: error.message, resultType: 'failure' };
      console.error(`[つなぎ口] ツール「${pluginName}_${shortName}」の処理で予期しない失敗が起きました：`, error);
      return { textResultForLlm: shortName === 'open' ? OPEN_FAILED : RECORD_FAILED, resultType: 'failure' };
    }
  }

  const deny = (reason) => ({ permissionDecision: 'deny', permissionDecisionReason: reason });

  // 統括が使えなかったツールを断る文。拒まれた理由として、モデルにそのまま届く（「Denied by preToolUse hook: <理由>」。V1）。
  function orchestratorDenyReason(toolName) {
    const shown = typeof toolName === 'string' && toolName !== '' ? toolName.slice(0, 80) : '（名前なし）';
    return (
      `統括エージェントは、ツール「${shown}」を使えません。使えるのは、ファイルを読む・探すツール、作業エージェントと検証エージェントを呼ぶツール（task など）、` +
      `記録のツール（${ORCHESTRATOR_RECORD_SHORT_NAMES.map((name) => `${pluginName}_${name}`).join('、')}）だけです。` +
      '成果物を作る・直す仕事は、試行の実行（2）で、task で作業エージェントに頼んでください。まとめ（5〜8）の間は頼まず、まとめを続けてください。'
    );
  }

  // ツールを使ってよいかの問い合わせ。同期で答え、例外を投げない（投げると拒まずに進む。設計書 4.4）。
  // 順番：止められた実行のエージェントを先に拒む（その理由は「作業を終えてください」で、統括の拒みの理由「作業エージェントに頼む」と食い違うため）。
  // 次に、統括が一覧にないツールを使おうとしたときに拒む。中心の処理が失敗しても、統括の拒みは効かせる。
  function onPreToolUse(input) {
    try {
      const verdict = core?.preToolUse(input);
      if (verdict?.deny) return deny(String(verdict.reason ?? ''));
    } catch (error) {
      console.error('[つなぎ口] ツールの問い合わせを処理できませんでした：', error);
    }
    if (converter.qualify(readField(input, 'agentType')) === orchestratorAgentType) {
      const toolName = readField(input, 'toolName'); // 読めない・文字でないときも、一覧にないので拒む
      if (!orchestratorTools.has(toolName)) return deny(orchestratorDenyReason(toolName));
    }
    return undefined;
  }

  // 子のエージェントが手番を終えるときに、最後の返事が届く。終わりのイベントで中心の処理に渡すため、覚えておく。
  function onSubagentStop(input) {
    try {
      converter.noteReply(input?.agentId, input?.response);
    } catch (error) {
      console.error('[つなぎ口] 子のエージェントの終わりを処理できませんでした：', error);
    }
    return undefined;
  }

  // 許可の求めの受け口は、見るためだけに登録する（設計書 4.14）。中心の処理に渡し、いつも答えない（no-result）。例外を投げない。
  function onPermissionRequest(request) {
    try {
      core?.onPermissionRequest(request);
    } catch (error) {
      console.error('[つなぎ口] 許可の求めを処理できませんでした：', error);
    }
    return { kind: 'no-result' };
  }

  const tools = buildToolDefinitions(pluginName).map((definition) => ({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    skipPermission: definition.skipPermission,
    // ツール検索の裏に回さない（回されると、入口のスキルや統括が「ツールがない」と取り違えるおそれがある。R2 の 3.3）
    defer: 'never',
    handler: (args, invocation) => callTool(definition.shortName, args, invocation),
  }));

  const session = await joinSession({ tools, hooks: { onPreToolUse, onSubagentStop }, onPermissionRequest });

  let port;
  let unsubscribe = () => {};
  try {
    const cwd = await readWorkingDirectory(session);
    port = createPort(session, converter);
    core = createCore({
      port,
      pluginRoot,
      pluginName,
      dataRoot,
      sessionId: session.sessionId,
      cwd,
      startUi: (readyCore) => startApp({ core: readyCore, cwd }),
    });
    unsubscribe = session.on((event) => {
      try {
        const neutral = converter.convert(event);
        if (neutral) core.onEvent(neutral);
      } catch (error) {
        console.error('[つなぎ口] イベントを処理できませんでした：', error);
      }
    });
    markReady(core);
  } catch (error) {
    markFailed(error);
    throw error;
  }

  // Copilot CLI の終了（SIGTERM。5秒後に SIGKILL）で終わる。画面のサーバーは同じプロセスなので、一緒に終わる（設計書 4.2）。
  let stopping = null;
  const shutdown = () => {
    stopping ??= (async () => {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
      try {
        unsubscribe();
      } catch {
        // セッションがもう切れているときは、受け取りをやめられなくてよい
      }
      try {
        await core.shutdown();
      } catch (error) {
        console.error('[つなぎ口] 終わる処理に失敗しました：', error);
      }
    })();
    return stopping;
  };
  function onSignal() {
    shutdown().finally(() => process.exit(0));
  }
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  return { pluginName, pluginRoot, dataRoot, session, port, core, shutdown };
}
