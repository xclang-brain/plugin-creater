// Agent SDK で試されるエージェントの隔離（testing.md 5章、ナレッジ agent-sdk-eval.md）。外側の EVAL と内側の EVAL で共通。
//
// - 環境変数は、必要なものだけを渡す。実行のたびに一時的なホームフォルダを使う（agentEnv）。
// - ユーザー設定とプロジェクト設定は読み込ませない（settingSources: []）。
// - コマンドは OS のサンドボックスで動かす（makeSandboxOptions）。サンドボックスの道具があるかは sandboxStatus で見る。
// - ファイルの書き込みのツール（Write、Edit）は作業フォルダの中だけを許す。普段のツールはあらかじめ許可し、
//   canUseTool に回すのは質問（AskUserQuestion）だけにする（裏で動くサブエージェントの許可の求めは、受け付けられずに失敗することがあるため）。
// - Claude Code の本体は、Agent SDK が同梱するもの（SDK と同じ版）を使う。手元の claude には替えない（pathToClaudeCodeExecutable を渡さない）。

import fs from 'node:fs';
import path from 'node:path';

/** 試されるエージェントに渡す環境変数。ほかは渡さない（試験する側のセッションの設定や資格情報が混ざるため） */
export const ENV_ALLOW = Object.freeze([
  'PATH', 'LANG', 'TERM', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', 'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'ANTHROPIC_BASE_URL',
]);

/**
 * 試されるエージェントの環境変数を作る。
 * @param {{ home: string, extra?: object, base?: object }} args home は一時的なホームフォルダ。extra は足す変数（模擬の API の URL など）
 */
export function agentEnv({ home, extra = {}, base = process.env } = {}) {
  if (typeof home !== 'string' || home === '') throw new Error('agentEnv には一時的なホームフォルダ（home）が要ります。');
  const env = {};
  for (const key of ENV_ALLOW) if (base[key] !== undefined) env[key] = base[key];
  return { ...env, HOME: home, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ...extra };
}

// ---- サンドボックス ------------------------------------------------------------------------------

function defaultWhich(command, env = process.env) {
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, command), fs.constants.X_OK);
      return true;
    } catch {
      // 次の場所を探す
    }
  }
  return false;
}

/**
 * OS のサンドボックスの道具があるか。Linux は bubblewrap（bwrap）と socat が要る。macOS は OS の機能で足りる。
 * @returns {{ available: boolean, missing: string[] }} missing は足りないものの名前（平易な日本語のこともある）
 */
export function sandboxStatus({ platform = process.platform, which = defaultWhich } = {}) {
  if (platform === 'darwin') return { available: true, missing: [] };
  if (platform !== 'linux') return { available: false, missing: [`${platform} はサンドボックスに対応していません`] };
  const missing = ['bwrap', 'socat'].filter((command) => !which(command));
  return { available: missing.length === 0, missing };
}

/** Agent SDK の sandbox の設定。サンドボックスが使えないのに始めると、黙って外で動かさず、失敗にする（failIfUnavailable） */
export function makeSandboxOptions({ enabled = true } = {}) {
  if (!enabled) return undefined;
  return { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false };
}

// ---- 許可 ----------------------------------------------------------------------------------------

/** p が cwd の中か。シンボリックリンクをたどった本当の場所で見る（まだないファイルは、あるところまでさかのぼる） */
export function isInsideDir(cwd, p) {
  if (typeof p !== 'string' || p === '') return false;
  const real = (target) => {
    let current = path.resolve(target);
    const rest = [];
    for (;;) {
      try {
        return path.join(fs.realpathSync(current), ...rest.reverse());
      } catch {
        const parent = path.dirname(current);
        if (parent === current) return path.resolve(target);
        rest.push(path.basename(current));
        current = parent;
      }
    }
  };
  const base = real(cwd);
  const target = real(path.resolve(cwd, p));
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);

/**
 * canUseTool。あらかじめ許可していないものだけがここに来る。
 *   AskUserQuestion：onQuestion(questions) の答え（{ 質問の文: 答え }）を返す。onQuestion がなければ断る
 *   Write・Edit などで作業フォルダの外：断って refused に残す
 *   それ以外：許可する
 */
export function makeCanUseTool({ cwd, onQuestion, refused = [] }) {
  return async (toolName, input) => {
    if (toolName === 'AskUserQuestion') {
      if (typeof onQuestion !== 'function') return { behavior: 'deny', message: 'この実行では、ユーザーに質問できません。' };
      const answers = await onQuestion(input?.questions ?? []);
      return { behavior: 'allow', updatedInput: { questions: input?.questions ?? [], answers } };
    }
    if (WRITE_TOOLS.has(toolName)) {
      const target = input?.file_path ?? input?.notebook_path ?? input?.path;
      if (!isInsideDir(cwd, target)) {
        refused.push({ toolName, path: target ?? null });
        return { behavior: 'deny', message: '作業フォルダの外には書き込めません。作業フォルダの中に書いてください。' };
      }
    }
    return { behavior: 'allow', updatedInput: input };
  };
}

/** あらかじめ許可するツール。書き込みは作業フォルダの中だけ。MCP のツールは名前を渡す（mcp__<サーバー名>__<ツール名>） */
export function allowedToolsFor({ mcpTools = [], extra = [] } = {}) {
  return ['Bash', 'Read', 'Write(./**)', 'Edit(./**)', 'Glob', 'Grep', 'Agent', 'TodoWrite', ...mcpTools, ...extra];
}

// ---- 利用枠の上限 ----------------------------------------------------------------------------------------

/**
 * 利用枠の上限の知らせの書き出し（Agent SDK が持つ一覧）。sdk が一覧を持っていなければ（{ query } だけを渡されたとき）、本物の Agent SDK から読む。
 * 結果の文（result）がこれで始まっていたら、モデルの利用枠の上限に達したと見る。
 */
export async function usageLimitPrefixes(sdk) {
  if (Array.isArray(sdk?.USAGE_LIMIT_ERROR_PREFIXES)) return sdk.USAGE_LIMIT_ERROR_PREFIXES;
  try {
    return (await import('@anthropic-ai/claude-agent-sdk')).USAGE_LIMIT_ERROR_PREFIXES ?? [];
  } catch {
    return [];
  }
}

// ---- query() の options ---------------------------------------------------------------------------------

/**
 * query() に渡す options を作る。隔離の決まりは、ここですべて入る。
 * @param {object} args
 * @param {string} args.cwd 作業フォルダ
 * @param {string} args.home この実行の一時的なホームフォルダ
 * @param {string} args.model Claude Code のモデルの ID（別名は使わない。プロバイダーで解決先が変わるため）
 * @param {string[]} [args.plugins] 読み込むプラグインのフォルダ。なければ何も読み込まない
 * @param {object} [args.mcpServers] { サーバー名: 設定 }。同じプロセスの MCP サーバーは実行ごとに別のインスタンスにする
 * @param {string[]} [args.mcpTools] あらかじめ許可する MCP のツールの名前
 * @param {object} [args.hooks]
 * @param {string} [args.agent] メインのスレッドで動かすエージェントの名前（<プラグイン>:<名前>）
 * @param {string} [args.systemPromptAppend] システムプロンプトに足す文
 * @param {boolean} [args.sandbox] 真なら OS のサンドボックスで動かす
 * @param {Function} [args.onQuestion] AskUserQuestion の答え方
 * @param {Array} [args.refused] 断った書き込みを入れる配列
 * @param {object} [args.envExtra] 環境変数に足すもの
 * @param {number} [args.maxTurns]
 * @param {string} [args.effort] 思考の深さ（low・medium・high・xhigh・max）。なければ渡さない
 * @param {string} [args.resume] 続けるセッションの番号
 * @param {AbortController} [args.abortController]
 * @param {object} [args.base] 環境変数のもと（試験用）
 */
export function makeQueryOptions({
  cwd, home, model, plugins = [], mcpServers, mcpTools = [], hooks, agent, systemPromptAppend, sandbox = false,
  onQuestion, refused = [], envExtra = {}, maxTurns, effort, resume, abortController, base = process.env,
}) {
  if (!cwd || !home || !model) throw new Error('makeQueryOptions には cwd・home・model が要ります。');
  const options = {
    cwd,
    model,
    env: agentEnv({ home, extra: envExtra, base }),
    settingSources: [],
    // agent の指示（本文）は、システムプロンプトが claude_code のときだけ入る
    systemPrompt: { type: 'preset', preset: 'claude_code', ...(systemPromptAppend ? { append: systemPromptAppend } : {}) },
    plugins: plugins.map((p) => ({ type: 'local', path: p })),
    allowedTools: allowedToolsFor({ mcpTools }),
    canUseTool: makeCanUseTool({ cwd, onQuestion, refused }),
  };
  if (mcpServers) options.mcpServers = mcpServers;
  if (hooks) options.hooks = hooks;
  if (agent) options.agent = agent;
  const sandboxOptions = makeSandboxOptions({ enabled: sandbox });
  if (sandboxOptions) options.sandbox = sandboxOptions;
  if (maxTurns !== undefined) options.maxTurns = maxTurns;
  if (effort) options.effort = effort;
  if (resume) options.resume = resume;
  if (abortController) options.abortController = abortController;
  return options;
}
