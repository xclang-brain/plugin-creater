// 外側の EVAL の 1 回（testing.md 3章の手順2〜3、6章）。
//   1. まっさらな作業フォルダに、模擬ユーザーの示すファイルを置く（6.1）。
//   2. 置き換えた版のクリエイターだけを読み込み、Agent SDK で動かす（5章）。クリエイターのエクステンションは、同じプロセスの
//      MCP サーバーとして出す（creator-tools.mjs。4章）。質問のツール（AskUserQuestion）と、文章で質問して手番を終えたときの
//      問いには、ユーザー役が答える（user-role.mjs。6.1）。
//   3. 生成プラグインができたら、1・2段目の試験と、内側の EVAL を動かし、6.5 の観点で採点する（outer-grade.mjs）。
//   4. 会話の全文と採点を、記録（record.json）に残す（6.6）。
// 開発者が答えるとき（6.7）は、ユーザー役の代わりに、中継（human-relay.mjs）を作る関数を引数 createAnswerer で渡し、answerer を human にする。
// 実際のモデルを使うのは、query（Agent SDK）を渡さないときだけ。試験では偽物の query を渡す。
// 統括がユーザーの承認をとってから、実際のモデルで動かすこと。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeQueryOptions, sandboxStatus } from './isolation.mjs';
import { readConversionReport } from './model-map.mjs';
import { collectGeneratedFiles, gradeOuter } from './outer-grade.mjs';
import { createCreatorToolkit, REPO_ROOT } from './creator-tools.mjs';
import { createUserRole, loadQuery } from './user-role.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEV_EVAL = path.resolve(HERE, '..');
const CONVERT = path.join(DEV_EVAL, 'convert.py');
/** 対照のクリエイター（control-creator/）が、本物の組み立てのスクリプトを呼ぶための場所（環境変数 CONTROL_SCAFFOLD で渡す） */
const CONTROL_SCAFFOLD_PATH = path.join(REPO_ROOT, 'skills', 'make-plugin', 'scripts', 'scaffold.py');

/** 外側の EVAL の既定。クリエイターのモデルは、思考力の高いモデルと Claude Haiku 5.5 の 2 つで回す（6.5） */
export const DEFAULTS = Object.freeze({
  model: 'claude-opus-5-5',
  haikuModel: 'claude-haiku-5-5',
  maxExchanges: 150,
  maxTurns: 400,
  stageTimeoutMs: 20 * 60_000,
});

/** 開発者が答えるときに、クリエイターの Claude Code に足す環境変数（testing.md 6.7）。待ちの期限なしは 0（Claude Code 2.1.310 で、0 以下を期限なしに扱う） */
export const HUMAN_ENV = Object.freeze({ ENABLE_PROMPT_CACHING_1H: '1', CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS: '0' });

/** 利用枠の上限のエラーの文（agent-sdk-eval.md） */
export const LIMIT_PATTERN = /hit your (session|usage|weekly)? ?limit|usage limit|rate limit|limit reached|resets at|quota/i;

const CLIP = { toolInput: 1500, toolResult: 1500 };
const clip = (text, max) => {
  const chars = [...String(text ?? '')];
  return chars.length <= max ? String(text ?? '') : `${chars.slice(0, max).join('')}…（以下${chars.length - max}文字を省略）`;
};

// ---- 置き換え --------------------------------------------------------------------------------------------

/**
 * convert.py で、Copilot CLI 向けのプラグインを Claude Code 向けに置き換える（毎回同じ結果になる）。
 * @returns {{ root: string, report: object, summary: object }}
 */
export function convertPlugin(src, out, { python = 'python3', skipValidate = false } = {}) {
  const args = ['-I', CONVERT, src, out, ...(skipValidate ? ['--skip-validate'] : [])];
  const r = spawnSync(python, args, { encoding: 'utf8', timeout: 300_000 });
  let summary = null;
  try {
    summary = JSON.parse(r.stdout);
  } catch {
    // 要点が JSON でなければ、そのまま誤りにする
  }
  if (r.status !== 0) {
    throw new Error(`置き換えに失敗しました（終了コード ${r.status}）：${(r.stdout || r.stderr || '').slice(-600)}`);
  }
  return { root: out, report: readConversionReport(out), summary };
}

// ---- 作業フォルダ ----------------------------------------------------------------------------------------

/** 模擬ユーザーの示すファイルを、作業フォルダの place の場所に写す */
export function placePersonaFiles(workDir, personaFiles) {
  for (const f of personaFiles) {
    const target = path.join(workDir, ...f.place.split('/'));
    if (path.relative(workDir, target).startsWith('..')) throw new Error(`示すファイルの置き場所が作業フォルダの外です：${f.place}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(f.src, target);
  }
}

/** 作業フォルダの中の生成プラグイン（直下に plugin.json があるフォルダ）を探す */
export function findGeneratedPlugins(workDir, depth = 3) {
  const found = [];
  const walk = (dir, n) => {
    if (n < 0) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (dir !== workDir && entries.some((e) => e.isFile() && e.name === 'plugin.json')) {
      found.push(dir);
      return; // 生成プラグインの中は探さない
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink() || e.name === 'node_modules' || e.name === '.git' || e.name === '.plugin-creator-work') continue;
      walk(path.join(dir, e.name), n - 1);
    }
  };
  walk(workDir, depth);
  if (fs.existsSync(path.join(workDir, 'plugin.json'))) found.unshift(workDir);
  return found.sort();
}

// ---- 1・2段目 ----------------------------------------------------------------------------------------------

/**
 * 生成プラグインの 1・2段目の入口（tests/run.py）を動かす。Playwright（1.56.1）は、このリポジトリの開発の試験の道具から、
 * 生成プラグインの tests/node_modules に一時的に写す（run.py は ESM で import するので、全体に入れたものは見つからない）。
 * 写しは終わったら消す（根の外を指すシンボリックリンクは 1段目で不合格になるので、写す）。
 */
export async function runGeneratedStages(pluginDir, { python = 'python3', env = process.env, timeoutMs = DEFAULTS.stageTimeoutMs, nodeModules = path.join(DEV_EVAL, 'node_modules') } = {}) {
  const runPy = path.join(pluginDir, 'tests', 'run.py');
  if (!fs.existsSync(runPy)) return { skipped: true, reason: 'tests/run.py がない（1・2段目の入口がない）' };
  const target = path.join(pluginDir, 'tests', 'node_modules');
  const copied = [];
  for (const name of ['playwright', 'playwright-core']) {
    const from = path.join(nodeModules, name);
    const to = path.join(target, name);
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.mkdirSync(target, { recursive: true });
      fs.cpSync(from, to, { recursive: true });
      copied.push(to);
    }
  }
  const childEnv = { ...env };
  if (!childEnv.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync('/opt/pw-browsers')) childEnv.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
  try {
    const result = await new Promise((resolve) => {
      const child = spawn(python, ['tests/run.py', '--json'], { cwd: pluginDir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: String(error.message) }); });
    });
    let report = null;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      return { skipped: true, reason: `tests/run.py の結果を読めない（終了コード ${result.code}）：${(result.stderr || result.stdout).slice(-300)}` };
    }
    if (result.code === 2) return { skipped: true, reason: `道具が足りなくて止まった：${(report.tools?.missing ?? []).map((m) => m.name ?? m.id ?? m).join('、')}`, report };
    const byId = (id) => (report.stages ?? []).find((s) => s.id === id);
    const summary = (s) => (s ? { ok: s.status === 'passed', status: s.status, counts: s.counts ?? null, failures: (s.failures ?? []).slice(0, 10), failedTests: (s.tests ?? []).filter((t) => t.status === 'failed').slice(0, 10) } : { ok: false, status: 'missing' });
    return { skipped: false, ok: report.ok === true, exitCode: result.code, stage1: summary(byId('stage1')), stage2: summary(byId('stage2')), resultsFile: report.resultsFile ?? null, durationSeconds: report.durationSeconds ?? null };
  } finally {
    for (const dir of copied) fs.rmSync(dir, { recursive: true, force: true });
    try {
      if (fs.existsSync(target) && fs.readdirSync(target).length === 0) fs.rmdirSync(target);
    } catch {
      // 残っていてもよい
    }
  }
}

// ---- 記録 ----------------------------------------------------------------------------------------------------

/** 会話と呼び出しの記録。順番の印（seq）は 1 つの連番で、記録のツールの呼び出しとも共通 */
export function createRecorder(now = Date.now) {
  let seq = 0;
  const items = [];
  return {
    items,
    next: () => (seq += 1),
    add(kind, data = {}) {
      const item = { seq: (seq += 1), at: now(), kind, ...data };
      items.push(item);
      return item;
    },
  };
}

/** 会話の全文（6.6）。クリエイターの発言（質問、生成前の確認、できたことの説明）とユーザー役の答え */
export function conversationOf(items) {
  const out = [];
  for (const i of items) {
    if (i.kind === 'user.request') out.push({ seq: i.seq, role: 'user', via: 'request', text: i.text });
    else if (i.kind === 'creator.text') out.push({ seq: i.seq, role: 'creator', via: 'text', text: i.text, turn: i.turn });
    else if (i.kind === 'creator.question') out.push({ seq: i.seq, role: 'creator', via: 'AskUserQuestion', header: i.header, question: i.question, options: i.options, multiSelect: i.multiSelect });
    else if (i.kind === 'user.answer') out.push({ seq: i.seq, role: 'user', via: i.via, text: i.answer, index: i.index, signal: i.signal });
  }
  return out;
}

const textOfContent = (content) => (Array.isArray(content) ? content.map((c) => c?.text ?? '').join('\n') : String(content ?? ''));

// ---- 1 回の実行 ---------------------------------------------------------------------------------------------

/**
 * 外側の EVAL を 1 回動かす。
 * @param {object} o
 * @param {{ persona: object, dir: string, files: Array<{ src: string, place: string, role: string }> }} o.loaded loadPersona の返り値
 * @param {'with'|'control'|'without'} [o.arm] with＝クリエイター、control＝対照のクリエイター、without＝何も読み込まない
 * @param {string} [o.creatorRoot] Copilot CLI 向けのクリエイター（または対照）のフォルダ。with と control に要る
 * @param {string} [o.convertedCreator] 置き換えた版。なければ runRoot の中に置き換える
 * @param {string} o.runRoot この実行の置き場所の上のフォルダ
 * @param {string} [o.model] クリエイターのモデルの ID
 * @param {string} [o.styleName] ユーザー役の話し方
 * @param {Function} [o.query] Agent SDK の query()。省くと本物
 * @param {Function} [o.userRoleQuery] ユーザー役の query()。省くと query と同じ
 * @param {boolean} [o.sandbox] OS のサンドボックスで動かす（既定は真。道具がなければ始めずに断る）
 * @param {boolean|Function} [o.inner] 内側の EVAL を動かすか。関数なら、それを使う（試験用）
 * @param {Function} [o.runStages] 1・2段目を動かす関数（試験用）
 * @param {Function} [o.convert] 置き換える関数（試験用）
 * @param {Function} [o.createAnswerer] 問いに答えるもの（createUserRole と同じ形）を作る関数 ({ persona, styleName, runDir, workDir, signal }) => answerer。
 *   省くとユーザー役（createUserRole）。開発者が答えるときは、中継（human-relay.mjs の createHumanRelay）を作る関数を渡す（testing.md 6.7）
 * @param {'user-role'|'human'} [o.answerer] 答える人の種類。human なら、記録・採点・内側の EVAL を開発者が答える形にする（testing.md 6.7）
 * @param {number} [o.innerRuns] 内側の EVAL の、あり・なしそれぞれの回数（省くと 1）
 */
export async function runOuterOnce(o) {
  const {
    loaded,
    arm = 'with',
    creatorRoot = REPO_ROOT,
    runRoot,
    model = DEFAULTS.model,
    styleName = 'normal',
    userRoleModel,
    sandbox = true,
    inner = false,
    maxExchanges = DEFAULTS.maxExchanges,
    maxTurns = DEFAULTS.maxTurns,
    maxBudgetUsd,
    envExtra = {},
    signal,
    onProgress = () => {},
    clock = { now: () => Date.now() },
    keepHomes = false,
    createAnswerer,
    answerer: answererKind = 'user-role',
    innerRuns,
  } = o;
  // 開発者が答える（testing.md 6.7）。ナレッジの観点・ユーザー役の誤りの確かめをせず、内側の EVAL は生成プラグインの課題で、点数に入れずに別に示す
  const human = answererKind === 'human';
  if (!['with', 'control', 'without'].includes(arm)) throw new Error(`arm は with・control・without のどれかです：${arm}`);
  const { persona, files: personaFiles } = loaded;
  if (!persona.styles?.[styleName]) throw new Error(`話し方「${styleName}」は、模擬ユーザー ${persona.id} にありません。`);
  if (sandbox) {
    const status = (o.sandboxCheck ?? sandboxStatus)();
    if (!status.available) {
      throw new Error(`OS のサンドボックスの道具が足りません（${status.missing.join('、')}）。入れるか、サンドボックスなしで動かしてください（外すと、コマンドが作業フォルダの外に書けます）。`);
    }
  }
  const query = o.query ?? (await loadQuery());
  const userRoleQuery = o.userRoleQuery ?? query;
  const runConvert = o.convert ?? convertPlugin;
  const runStages = o.runStages ?? runGeneratedStages;

  fs.mkdirSync(runRoot, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(runRoot, `outer-${persona.id}-${arm}-`));
  const dirs = {
    work: path.join(runDir, 'work'),
    agentHome: path.join(runDir, 'agent-home'),
    copilotHome: path.join(runDir, 'copilot-home'),
    userHome: path.join(runDir, 'user-home'),
    converted: path.join(runDir, 'converted'),
  };
  for (const d of [dirs.work, dirs.agentHome, dirs.copilotHome, dirs.userHome]) fs.mkdirSync(d, { recursive: true });
  placePersonaFiles(dirs.work, personaFiles);

  const startedAt = new Date(clock.now()).toISOString();
  const recorder = createRecorder(() => clock.now());
  const refused = [];
  const skills = [];
  const subagents = {}; // Agent の呼び出しの番号 → { type, description, model }
  const models = {}; // 'main' か Agent の呼び出しの番号 → そのエージェントのメッセージに出たモデル（出た順、重ならない）
  const results = [];
  const initInfo = [];
  let agentCostUsd = 0;
  let sessionId;
  let stopped = null;

  // クリエイターの置き換え（置き換えた版と、エクステンションの代わりの MCP サーバー）
  let converted = null;
  let conversion = null;
  if (arm !== 'without') {
    converted = o.convertedCreator ?? (() => {
      const r = runConvert(creatorRoot, path.join(dirs.converted, path.basename(creatorRoot)));
      conversion = { warnings: r.report?.warnings ?? [], extensionTools: r.report?.extension_tools ?? [] };
      return r.root;
    })();
  }
  const report = converted ? readConversionReport(converted) : null;
  // com.github.copilot/rules/ は、Claude Code では読み込まれない。変換スクリプトが .eval/rules.md に写すので、指示として足す（testing.md 4章）
  let rules = '';
  try {
    if (converted) rules = fs.readFileSync(path.join(converted, '.eval', 'rules.md'), 'utf8').trim();
  } catch {
    rules = '';
  }
  if (report && !conversion) conversion = { warnings: report.warnings ?? [], extensionTools: report.extension_tools ?? [] };
  const toolkit = arm === 'with'
    ? await createCreatorToolkit({
        workDir: dirs.work,
        copilotHome: dirs.copilotHome,
        sessionId: `outer-${path.basename(runDir)}`,
        clock,
        pluginRoot: creatorRoot,
        onEvent: (e) => { e.seq = recorder.next(); },
      })
    : null;
  if (toolkit && report) {
    // 置き換えた版が参照するエクステンションのツールが、この部品が出すツールと過不足なく合うか
    const expected = new Set((report.extension_tools ?? []).map((t) => `${t.server}/${t.tool}`));
    const offered = new Set(toolkit.tools.map((t) => `${toolkit.serverName}/${t.name}`));
    const missing = [...expected].filter((x) => !offered.has(x));
    if (missing.length) throw new Error(`置き換えた版が使うエクステンションのツールを、EVAL の仕組みが出していません：${missing.join('、')}`);
  }

  const userRole = createAnswerer
    ? createAnswerer({ persona, styleName, runDir, workDir: dirs.work, signal })
    : createUserRole({
        persona,
        styleName,
        query: userRoleQuery,
        ...(userRoleModel ? { model: userRoleModel } : {}),
        home: dirs.userHome,
        cwd: dirs.userHome,
        envExtra, // 模擬の API につなぐ試験では、ユーザー役も同じ接続先にする（渡さないと、ユーザー役だけ本物のモデルを呼ぶ）
      });
  // 終わった理由と結果を、答えるもの（中継）に知らせる。どの終わり方でも、最後に 1 回（下の finally）
  let finishInfo = { reason: 'exception', message: '外側の EVAL が途中で止まった' };
  try {
    // クリエイターがチャットに書いた文のうち、まだユーザー役に渡していないもの（前の答えの後に書かれたもの）。
    // 人は、質問と一緒にこれを読む。「上のまとめで…」のような質問に答えるために、次の質問と一緒にユーザー役へ渡す（testing.md 6.1）
    const unreadNotes = [];

    // 質問のツール（AskUserQuestion）への答え。ユーザー役が答える
    let askGroup = 0; // 質問のツールの呼び出しの番号。1 回の呼び出しの問いの欄の数を数えるため（testing.md 6.5、hearing.md 4.1）
    const onQuestion = async (questions) => {
      const answers = {};
      askGroup += 1;
      const group = askGroup;
      // 質問の直前の文の処理が、この呼び出しより後になることがあるので、1 回譲ってから受け取る
      await new Promise((resolve) => setImmediate(resolve));
      let notes = unreadNotes.splice(0);
      for (const q of questions) {
        const options = (q.options ?? []).map((opt) => ({ label: String(opt.label ?? ''), description: String(opt.description ?? '') }));
        recorder.add('creator.question', { header: q.header ?? '', question: q.question, options, multiSelect: Boolean(q.multiSelect), group, groupSize: questions.length });
        // 1 回の呼び出しの問いの欄の番号と数は、別の答えるもの（開発者の中継）にだけ渡す（ユーザー役の答えの記録を変えないため）
        const meta = { header: q.header ?? '', multiSelect: Boolean(q.multiSelect), ...(createAnswerer ? { group, groupSize: questions.length } : {}) };
        const entry = await userRole.answer(q.question, options, 'AskUserQuestion', meta, notes);
        notes = []; // 1 回の呼び出しに問いの欄が複数あるときも、前の文は最初の欄にだけ付ける（履歴に入るため）
        answers[q.question] = entry.answer;
        recorder.add('user.answer', { index: entry.index, via: 'AskUserQuestion', question: q.question, header: q.header ?? '', choices: entry.choices, answer: entry.answer, rawAnswer: entry.rawAnswer, signal: entry.signal });
        toolkit?.recordAsk({ question: q.question, choices: options, header: q.header, multiSelect: q.multiSelect, answer: entry.answer });
        onProgress({ phase: 'answer', via: 'AskUserQuestion', index: entry.index });
      }
      return answers;
    };

    let turnNumber = 0;
    /** query() を 1 回動かす（クリエイターが手番を終えるまで） */
    async function runTurn(prompt, resume) {
      turnNumber += 1;
      const abortController = new AbortController();
      const onAbort = () => abortController.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const options = makeQueryOptions({
        cwd: dirs.work,
        home: dirs.agentHome,
        model,
        plugins: converted ? [converted] : [],
        ...(toolkit ? { mcpServers: { [toolkit.serverName]: toolkit.newServer() }, mcpTools: toolkit.mcpTools } : {}),
        sandbox,
        ...(rules ? { systemPromptAppend: rules } : {}),
        onQuestion,
        refused,
        // 裏で動くサブエージェントではなく、前面で 1 体ずつ動かす（設計は task を同期で呼ぶ前提）。
        // コマンドは、毎回、作業フォルダから始める。Claude Code のサンドボックスは、コマンドを始めたフォルダに、保護するファイル
        // （.mcp.json、.claude/ の中など）を /dev/null で重ねる。生成プラグインのフォルダがコマンドの始まりのフォルダになると、
        // そこに中身のない .mcp.json が見えて、生成プラグインの1段目が落ちる（会話例の下読み E1 の 3章の7）。作業フォルダなら、生成プラグインの外
        // 開発者が答えるときは、答えを待つ間に切れないようにする：質問の待ちの期限なし（0）と、プロンプトのキャッシュを 1 時間保つ（testing.md 6.7）
        envExtra: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1', ...(arm === 'control' ? { CONTROL_SCAFFOLD: CONTROL_SCAFFOLD_PATH } : {}), ...(human ? HUMAN_ENV : {}), ...envExtra },
        maxTurns,
        resume,
        abortController,
      });
      if (maxBudgetUsd !== undefined) options.maxBudgetUsd = maxBudgetUsd;
      const turn = { number: turnNumber, result: null, lastText: '' };
      try {
        for await (const m of query({ prompt, options })) {
          sessionId = m.session_id ?? sessionId;
          if (m.type === 'system' && m.subtype === 'init') {
            initInfo.push({ plugins: (m.plugins ?? []).map((p) => p.name), mcp: (m.mcp_servers ?? []).map((s) => `${s.name}:${s.status}`), model: m.model });
          } else if (m.type === 'assistant') {
            const owner = m.parent_tool_use_id ?? 'main';
            if (m.message?.model && !(models[owner] ??= []).includes(m.message.model)) models[owner].push(m.message.model);
            for (const c of m.message?.content ?? []) {
              if (c.type === 'text' && owner === 'main' && c.text?.trim()) {
                recorder.add('creator.text', { text: c.text, turn: turnNumber });
                unreadNotes.push(c.text.trim());
                turn.lastText = c.text;
              } else if (c.type === 'tool_use') {
                if (c.name === 'AskUserQuestion') continue; // onQuestion が問いと答えを記録する
                if (c.name === 'Agent' || c.name === 'Task') subagents[c.id] = { type: c.input?.subagent_type ?? '(general)', description: c.input?.description ?? '' };
                if (c.name === 'Skill') skills.push(c.input?.skill);
                recorder.add('tool.use', { owner, id: c.id, name: c.name, input: shrinkInput(c.input) });
              }
            }
          } else if (m.type === 'user') {
            const owner = m.parent_tool_use_id ?? 'main';
            for (const c of Array.isArray(m.message?.content) ? m.message.content : []) {
              if (c.type === 'tool_result') recorder.add('tool.result', { owner, id: c.tool_use_id, isError: c.is_error === true, text: clip(textOfContent(c.content), CLIP.toolResult) });
            }
          } else if (m.type === 'result') {
            turn.result = m;
            agentCostUsd = m.total_cost_usd ?? agentCostUsd; // 続きの会話の total_cost_usd は、それまでの分を含む合計
            results.push({ subtype: m.subtype, isError: m.is_error === true, turns: m.num_turns, seconds: Math.round((m.duration_ms ?? 0) / 1000), cost: m.total_cost_usd ?? null });
            recorder.add('turn.end', { turn: turnNumber, subtype: m.subtype, isError: m.is_error === true, text: m.result ?? '', cost: m.total_cost_usd ?? null });
          }
        }
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
      return turn;
    }

    const readState = () => (toolkit ? toolkit.readState() : null);
    /** 生成プラグインができて手番が終わったら、会話は終わり。承認（段階「生成」）の記録がないまま作られたときは、その理由で終える（採点で落ちる） */
    const finishedReason = () => {
      if (findGeneratedPlugins(dirs.work).length === 0) return null;
      return arm === 'with' && readState()?.stage !== 'generate' ? 'generated_without_approval' : 'generated';
    };

    recorder.add('user.request', { text: persona.request });
    let prompt = persona.request;
    let exchanges = 0;
    let lastCreatorText = ''; // クリエイターの最後の発言（開発者が答えるとき、終わりの状態に載せる）
    try {
      for (; exchanges < maxExchanges; exchanges += 1) {
        if (signal?.aborted) { stopped = { reason: 'interrupted' }; break; }
        onProgress({ phase: 'turn', n: exchanges + 1 });
        const turn = await runTurn(prompt, sessionId);
        const text = (turn.result?.result ?? '').trim() || turn.lastText.trim();
        if (text) lastCreatorText = text;
        if (!turn.result) { stopped = { reason: 'no_result' }; break; }
        if (turn.result.is_error || turn.result.subtype !== 'success') {
          stopped = { reason: LIMIT_PATTERN.test(`${turn.result.result ?? ''}`) ? 'usage_limit' : turn.result.subtype ?? 'error', message: String(turn.result.result ?? '').slice(0, 300) };
          break;
        }
        const finished = finishedReason();
        if (finished) { stopped = { reason: finished }; break; }
        // 文章で質問して手番を終えたときも、ユーザー役の答えを次の発言として返す（6.1）
        const question = text || '（クリエイターの発言がありませんでした）';
        recorder.add('creator.question-text', { text: question, turn: turn.number });
        // 手番の最後の文は問いそのもの。それより前に書いた文だけを、前の文として渡す
        const notes = unreadNotes.splice(0).filter((n) => n !== question.trim());
        const entry = await userRole.answer(question, [], 'text', {}, notes);
        recorder.add('user.answer', { index: entry.index, via: 'text', question, header: '', choices: [], answer: entry.answer, rawAnswer: entry.rawAnswer, signal: entry.signal });
        toolkit?.recordPrompt(entry.answer);
        onProgress({ phase: 'answer', via: 'text', index: entry.index });
        prompt = entry.answer;
      }
      if (!stopped) stopped = { reason: 'max_exchanges' };
    } catch (error) {
      stopped = { reason: 'exception', message: error?.message ?? String(error) };
    }
    // 開発者の答えを待つ間などに中断されたら、生成まで進んでいなければ、中断として終える（ユーザー役の AI のときは、これまでどおり）
    if (createAnswerer && signal?.aborted && !['generated', 'generated_without_approval'].includes(stopped?.reason)) {
      stopped = { reason: 'interrupted', ...(stopped?.reason ? { detail: stopped.reason } : {}) };
    }
    userRole.setStatus?.({ phase: 'grading' });

    // ---- 生成プラグインの採点 ----
    const plugins = findGeneratedPlugins(dirs.work);
    const pluginDir = plugins.length === 1 ? plugins[0] : null;
    let generatedFiles = null;
    let stages = null;
    let innerResult = null;
    let innerRecord = null;
    if (pluginDir) {
      generatedFiles = collectGeneratedFiles(pluginDir);
      onProgress({ phase: 'stages' });
      try {
        stages = await runStages(pluginDir, {});
      } catch (error) {
        stages = { skipped: true, reason: `1・2段目を動かせなかった：${error.message}` };
      }
      if (inner && stages?.stage1?.ok) {
        onProgress({ phase: 'inner' });
        try {
          const runInner = typeof inner === 'function' ? inner : (await import('./outer-inner.mjs')).runInnerForGenerated;
          innerRecord = await runInner({
            pluginDir, loaded, styleName, query, userRoleQuery, outDir: path.join(runDir, 'inner'), sandbox, convert: runConvert, envExtra, signal, onProgress,
            // 開発者が答えるときは、生成プラグインの課題で、決まった返事で動かす（outer-inner.mjs）
            ...(human ? { answerer: 'human' } : {}),
            ...(innerRuns !== undefined ? { runs: innerRuns } : {}),
          });
          innerResult = { withScore: innerRecord?.scores?.with ?? null, withoutScore: innerRecord?.scores?.without ?? null, difference: innerRecord?.scores?.difference ?? null, status: innerRecord?.status ?? null };
          if (human) {
            if (innerRecord?.reason) innerResult.reason = innerRecord.reason;
            if (innerRecord?.taskProblems?.length) innerResult.taskProblems = innerRecord.taskProblems;
          }
        } catch (error) {
          innerResult = { withScore: null, error: error?.message ?? String(error) };
        }
      }
    }

    // 開発者が答えるときは、内側の EVAL を動かさなかった理由も残す（黙って落とさない）
    if (human && inner && !innerResult) {
      innerResult = { withScore: null, withoutScore: null, difference: null, status: 'skipped', reason: pluginDir ? '生成プラグインが1段目に通らなかったので、動かしていない' : `生成プラグインが 1 つできなかった（${plugins.length} 個）ので、動かしていない` };
    }

    const state = readState();
    const toolEvents = toolkit ? toolkit.events : [];
    const modelUse = {
      requested: model,
      main: models.main ?? [],
      subagents: Object.entries(subagents).map(([id, s]) => ({ type: s.type, models: models[id] ?? [] })),
      lowCost: converted ? readConvertedAgentModel(converted, 'worker') : null,
    };
    const grading = gradeOuter({
      persona,
      personaFiles,
      items: recorder.items,
      toolEvents,
      state,
      generatedCount: plugins.length,
      generatedFiles,
      stages,
      // 開発者が答えるとき、内側の EVAL の結果は点数に入れない（クリエイターが作った基準でクリエイターを採点しない。testing.md 6.7）
      inner: !human && innerResult && innerResult.withScore !== null ? innerResult : null,
      userSignals: userRole.signals,
      modelUse,
      model,
      arm,
      answerer: answererKind,
    });
    if (human) grading.innerSeparate = innerResult;

    const finishedAt = new Date(clock.now()).toISOString();
    const record = {
      schema: 'outer-record/1',
      persona: { id: persona.id, title: persona.title, experience: persona.experience },
      style: styleName,
      arm,
      answerer: human ? 'human' : 'user-role',
      ...(human && userRole.relayDir ? { relayDir: userRole.relayDir } : {}),
      models: { creator: model, userRole: human ? 'human' : userRoleModel ?? 'claude-sonnet-5-5' },
      creator: { root: arm === 'without' ? null : creatorRoot, converted, version: creatorVersion(creatorRoot, arm), conversion },
      sandbox,
      startedAt,
      finishedAt,
      stopped,
      exchanges,
      sessionId: sessionId ?? null,
      initInfo,
      skills: skills.filter(Boolean),
      subagents: Object.entries(subagents).map(([id, s]) => ({ ...s, model: models[id]?.[0] ?? null, models: models[id] ?? [] })),
      mainModel: models.main?.[0] ?? null,
      mainModels: models.main ?? [],
      results,
      costUsd: { creator: agentCostUsd, userRole: human ? 0 : userRole.cost },
      refusedWrites: refused,
      conversation: conversationOf(recorder.items),
      items: recorder.items,
      toolEvents,
      state,
      qa: toolkit ? toolkit.readQa() : [],
      issues: toolkit ? toolkit.issues : [],
      userRole: { answers: userRole.answers, signals: userRole.signals },
      generated: { plugins: plugins.map((p) => path.relative(dirs.work, p)), files: (generatedFiles ?? []).map((f) => ({ rel: f.rel, size: f.size, sha256: f.sha256 })) },
      stages,
      inner: innerResult,
      grading,
      dirs: { run: runDir, work: dirs.work },
    };
    const file = path.join(runDir, 'record.json');
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    record.recordFile = file;

    await toolkit?.shutdown();
    if (!keepHomes) {
      fs.rmSync(path.join(dirs.agentHome, '.claude'), { recursive: true, force: true });
    }
    finishInfo = {
      reason: stopped?.reason ?? null,
      ...(stopped?.message ? { message: stopped.message } : {}),
      lastText: lastCreatorText,
      score: grading.score,
      verdictOk: grading.verdict.ok,
      failed: grading.verdict.failed,
      inner: innerResult,
      recordFile: file,
    };
    return record;
  } catch (error) {
    finishInfo = { reason: 'exception', message: error?.message ?? String(error) };
    throw error;
  } finally {
    await userRole.finish?.(finishInfo);
  }
}

/**
 * 置き換えた版のエージェントの定義（agents/<名前>.md）の frontmatter の model を読む。ないとき・inherit のときは null。
 * 作業エージェントが動くべき「費用の低いモデル」（REQ-046）を、変換後の定義から知るために使う。
 */
export function readConvertedAgentModel(convertedRoot, agentName) {
  try {
    const text = fs.readFileSync(path.join(convertedRoot, 'agents', `${agentName}.md`), 'utf8');
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
    const value = /^model:\s*(.+?)\s*$/m.exec(front)?.[1]?.replace(/^["']|["']$/g, '');
    return value && value !== 'inherit' ? value : null;
  } catch {
    return null;
  }
}

/** 記録に残す tool_use の入力。書き込みの中身などの長い文字は切る（場所は残す） */
function shrinkInput(input) {
  if (input === null || typeof input !== 'object') return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) out[k] = typeof v === 'string' ? clip(v, CLIP.toolInput) : v;
  return out;
}

function creatorVersion(creatorRoot, arm) {
  if (arm === 'without') return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(creatorRoot, 'plugin.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/** この実行の置き場所の既定（リポジトリの外） */
export function defaultRunRoot() {
  return process.env.DEV_EVAL_RUNS || path.join(os.tmpdir(), 'plugin-creator-dev-eval');
}
