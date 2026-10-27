// 内側の EVAL の入口（testing.md 3章の手順4、7章）。模擬ユーザーごとの内側の課題と採点の基準（<模擬ユーザー>/inner/eval.json）を、
// 置き換えた生成プラグインあり・なしで繰り返し動かし、成果物を採点して、あり・なしの点数とその差を出す。
// 実際のモデルを使う。統括がユーザーの承認をとってから動かすこと（RESUME.md、common.md）。
//
// 使い方（リポジトリの根から。事前に cd tests/dev-eval && npm install）:
//   node tests/dev-eval/runner/inner.mjs --plugin <生成プラグインのフォルダ> --persona <模擬ユーザーのフォルダ> [--persona …]
//        [--converted <置き換えた版>] [--runs 1] [--arms with,without,standalone] [--out <結果のフォルダ>] [--style normal]
//        [--model claude-sonnet-5-5] [--judge-model claude-sonnet-5-5]
//        [--orchestrator-model <Copilot の名前>] [--worker-model …] [--verifier-model …]   画面で選ぶモデル（省くと画面の既定）
//        [--setting 鍵=値]…   画面の作業ごとの設定の欄に入れる値。ふつうは、ユーザー役が欄の見出しと説明を読み、模擬ユーザーのナレッジと
//                              課題（頼みの文と入力のファイル）から決める。これは、決めた値を上書きするときに使う
//        [--no-sandbox] [--timeout-minutes 30] [--pass-env NAME,NAME]
//   --converted を省くと、convert.py で <結果のフォルダ>/converted に置き換える。
//   --arms の standalone は、プラグインを読み込むが画面と記録のツールを使わない単体の腕（REQ-062）。課題は模擬ユーザーの inner/standalone.json。
//   模擬ユーザーに device（例：kx200）があれば、腕ごとの実行のたびに擬似の機器（tests/dev-eval/device/）を起動して使う（testing.md 7章）。
//   サンドボックス（bubblewrap、socat）が既定で要る。ないときは始めずに断る。--no-sandbox で外せる（結果に警告が残る。擬似の機器の通信と中身の
//   制限も効かないので、その警告も残る）。
//   / と OS の一時フォルダと結果のフォルダ（--out）の空きが 2GB 未満なら、始めずに断る（disk.mjs）。サンドボックスの道具と空きは、
//   結果のフォルダを作って置き換える前に確かめる（外側の EVAL と同じ順）。
//   終了コード：0 最後まで動いた（点数が低くても 0）、1 途中で止まった（利用枠の上限、中断）、2 始められなかった。
//   標準出力は結果の JSON、進み具合は標準エラー出力。結果は <結果のフォルダ>/inner-result.json に、実行が1つ終わるたびに書き直す。
//   実行ごとの記録（result.json、events.jsonl、screen.png、作業フォルダ work/）は <結果のフォルダ>/inner-runs/<課題>/<with|without|standalone>-<回>/ にある
//   （単体の腕の <課題> は、単体の課題の id）。ユーザー役のホームは <結果のフォルダ>/user-<課題>-<腕>-<回>-*/ にある。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createScreen } from '../../../skills/test-plugin/scripts/screen.mjs';
import { createAgentSdkJudge } from './inner-judge.mjs';
import { ARMS, DEFAULTS, DEVICE_UNFENCED_WARNING, runInnerArm } from './inner-run.mjs';
import { checkFreeSpace } from './disk.mjs';
import { sandboxStatus } from './isolation.mjs';
import { readConversionReport } from './model-map.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONVERT = path.resolve(HERE, '..', 'convert.py');

/** 始められないときの誤り。message は平易な日本語 */
export class InnerEvalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InnerEvalError';
    this.code = code;
  }
}

/**
 * 始める前の確かめ。サンドボックスの道具（sandbox のとき）、次にディスクの空き（/ と OS の一時フォルダと outDir）。外側の EVAL（outer.mjs）と
 * 同じ順である。足りなければ InnerEvalError（sandbox_missing・disk_low）を投げる（testing.md 5章）。outDir はまだなくてよい（置かれる場所で見る）
 */
export function preflight({ sandbox, sandboxCheck = sandboxStatus, diskCheck = checkFreeSpace, outDir }) {
  if (sandbox) {
    const status = sandboxCheck();
    if (!status.available) {
      throw new InnerEvalError('sandbox_missing', `OS のサンドボックスの道具が足りません（${status.missing.join('、')}）。入れるか、--no-sandbox で外してください（外すと、コマンドが作業フォルダの外に書けます）。`);
    }
  }
  // 足りないまま動かすと、環境の誤り（ENOSPC）で採点が乱れる
  const disk = diskCheck({ dirs: [outDir] });
  if (!disk.ok) throw new InnerEvalError('disk_low', disk.message);
}

const mean = (values) => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);

/** 実行の記録から、結果のファイルに残す要点だけを取り出す（全文は実行ごとのフォルダの result.json と events.jsonl） */
export function summarizeRun(run, { task, arm, n }) {
  return {
    task, arm, n, status: run.status, reason: run.reason,
    score: run.grading?.score ?? null, passed: run.grading?.passed ?? null, total: run.grading?.total ?? null,
    criteria: (run.grading?.results ?? []).map((r) => ({ id: r.id, text: r.text, grading: r.grading, pass: r.pass, reason: r.reason, ...(r.error ? { error: true } : {}) })),
    replies: run.replies, url: run.url, endReason: run.screen?.endReason ?? null, endReasonText: run.screen?.endReasonText ?? '',
    checks: run.checks, settings: run.settings ?? [], finalModels: run.finalState?.settings?.models ?? null,
    ...(run.device ? { device: run.device, networkRefused: run.networkRefused ?? [] } : {}),
    ...(run.standalone ? { standalone: run.standalone } : {}),
    ...(run.warnings?.length ? { warnings: run.warnings } : {}),
    agents: (run.agents ?? []).map((a) => ({ agentType: a.agentType, status: a.status, selectedModel: a.selectedModel, actualClaudeId: a.actualClaudeId, executionMode: a.executionMode })),
    skillsUsed: run.skillsUsed, costUsd: run.costUsd, seconds: run.seconds, runDir: run.runDir, workDir: run.workDir,
  };
}

/** あり・なしの点数。採点した実行（score がある）の平均。差は「あり」から「なし」を引く。単体の腕（standalone）を回したときは、その点数も出す */
export function scoresOf(runs) {
  const scored = (arm, task) => runs.filter((r) => r.arm === arm && r.score !== null && (task === undefined || r.task === task)).map((r) => r.score);
  const ran = (arm, task) => runs.some((r) => r.arm === arm && (task === undefined || r.task === task));
  const withScore = mean(scored('with'));
  const withoutScore = mean(scored('without'));
  const taskIds = [...new Set(runs.map((r) => r.task))];
  const byTask = {};
  for (const id of taskIds) {
    const w = mean(scored('with', id));
    const o = mean(scored('without', id));
    byTask[id] = { with: w, without: o, difference: w !== null && o !== null ? w - o : null, ...(ran('standalone', id) ? { standalone: mean(scored('standalone', id)) } : {}) };
  }
  return {
    with: withScore, without: withoutScore, difference: withScore !== null && withoutScore !== null ? withScore - withoutScore : null,
    ...(ran('standalone') ? { standalone: mean(scored('standalone')) } : {}),
    byTask,
  };
}

/** 擬似の機器を起動する関数（模擬ユーザーの device → tests/dev-eval/device の startDevice）。知らない機器は断る */
export const DEVICE_STARTERS = Object.freeze({
  kx200: async () => (await import('../device/kxdevice.mjs')).startDevice,
});

function readVersions({ sdkDir }) {
  const read = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };
  const sdkPackage = read(path.join(sdkDir, 'package.json'));
  return { agentSdk: sdkPackage.version ?? null, claudeCode: sdkPackage.claudeCodeVersion ?? null, node: process.version };
}

/**
 * 内側の EVAL を動かす。
 * @param {object} o
 * @param {{ query: Function }} o.sdk Agent SDK
 * @param {object} o.chromium Playwright の chromium
 * @param {string} o.pluginRoot Copilot CLI 向けの生成プラグイン
 * @param {string} o.convertedRoot 置き換えた版
 * @param {Array<{ id: string, dir: string, json: object, personaId?: string, device?: string|null, standalone?: object|null }>} o.tasks 課題（dir は eval.json のあるフォルダ）。
 *   device は擬似の機器の名前（DEVICE_STARTERS の鍵）。standalone は単体の腕の課題（同じ形。腕 standalone で使う）
 * @param {(task: object, arm: string, n: number) => Function} o.userRoleFor その実行のユーザー役（{ question, choices } => 答え）
 * @param {string} o.outDir 結果の置き場所
 * @param {Array<'with'|'without'|'standalone'>} [o.arms]
 * @param {Function} [o.startDevice] 擬似の機器を起動する関数（試験で差し替える。省くと、課題の device から DEVICE_STARTERS で選ぶ）
 * @param {Function} [o.diskCheck] ディスクの空きを確かめる関数（既定は disk.mjs の checkFreeSpace。試験で差し替える）。足りなければ始めない（preflight）
 */
export async function innerEval(o) {
  const {
    sdk, chromium, pluginRoot, convertedRoot, tasks, userRoleFor, outDir, runs = 1, arms = ['with', 'without'], models, taskSettings, model = DEFAULTS.model,
    judgeModel, envExtra = {}, sandbox = true, timeoutMs = DEFAULTS.timeoutMs, signal, pollMs, onProgress = () => {}, env = process.env, judge: injectedJudge,
    sandboxCheck = sandboxStatus, diskCheck = checkFreeSpace,
  } = o;
  if (!tasks?.length) throw new InnerEvalError('usage', '課題が1つもありません。');
  for (const task of tasks) {
    if (task.device && !o.startDevice && !Object.hasOwn(DEVICE_STARTERS, task.device)) throw new InnerEvalError('usage', `知らない擬似の機器です：${task.device}（使えるもの：${Object.keys(DEVICE_STARTERS).join('、')}）`);
  }
  // サンドボックスの道具とディスクの空き。コマンドラインの入口（main）は置き換えの前にも確かめるが、外側の EVAL から呼ぶときのために、ここでも確かめる
  preflight({ sandbox, sandboxCheck, diskCheck, outDir });
  readConversionReport(convertedRoot); // 置き換えていなければ、ここで断る
  fs.mkdirSync(outDir, { recursive: true });
  const screen = arms.includes('with') ? createScreen({ chromium, env }) : null;
  if (screen) await screen.prepare(); // 実際のモデルを使う前に、ブラウザーを起動できると確かめる
  const judge = injectedJudge ?? createAgentSdkJudge({ sdk, model: judgeModel ?? model, envExtra });
  const versions = readVersions({ sdkDir: path.resolve(HERE, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk') });
  const record = {
    kind: 'dev-inner-eval', status: 'running', stopped: null, startedAt: new Date().toISOString(), finishedAt: null, plugin: readConversionReport(convertedRoot).plugin,
    options: { runs, arms, model, judgeModel: judgeModel ?? model, models: models ?? null, sandbox, timeoutMs },
    versions,
    tasks: tasks.map((t) => ({
      id: t.id, personaId: t.personaId ?? null, device: t.device ?? null, criteria: (t.json.criteria ?? []).map((c) => ({ id: c.id, grading: c.grading })),
      ...(t.standalone ? { standalone: { id: t.standalone.id, criteria: (t.standalone.json.criteria ?? []).map((c) => ({ id: c.id, grading: c.grading })) } } : {}),
    })),
    runs: [], scores: null, costUsd: null, warnings: sandbox ? [] : ['OS のサンドボックスなしで動かした（コマンドが作業フォルダの外に書ける）'], resultFile: path.join(outDir, 'inner-result.json'),
  };
  // 擬似の機器の通信と中身の制限は、サンドボックスの設定なので、サンドボックスなしでは効かない（機器の記録を隔離の裏付けにしない）
  if (!sandbox && tasks.some((t) => t.device)) record.warnings.push(DEVICE_UNFENCED_WARNING);
  const save = () => {
    record.scores = scoresOf(record.runs);
    const sum = (key) => record.runs.reduce((acc, r) => acc + (r.costUsd?.[key] ?? 0), 0);
    record.costUsd = { main: sum('main'), orchestrator: sum('orchestrator'), judge: judge.costUsd ?? 0, userRole: record.runs.reduce((acc, r) => acc + (r.userRoleCostUsd ?? 0), 0) };
    fs.writeFileSync(record.resultFile, `${JSON.stringify(record, null, 2)}\n`);
  };
  save();

  let stopped = null;
  try {
    for (const task of tasks) {
      for (let n = 1; n <= runs; n += 1) {
        for (const arm of ARMS) {
          if (!arms.includes(arm)) continue;
          // 単体の腕は、単体の課題（inner/standalone.json）で動かす
          const armTask = arm === 'standalone' ? task.standalone : task;
          if (!armTask) {
            record.runs.push({ task: task.id, arm, n, status: 'skipped', reason: '単体の課題（inner/standalone.json）がないので始めなかった', score: null, criteria: [] });
            continue;
          }
          if (stopped || signal?.aborted) {
            record.runs.push({ task: armTask.id, arm, n, status: 'skipped', reason: stopped ? stopped.message : '中断されたので始めなかった', score: null, criteria: [] });
            continue;
          }
          onProgress({ phase: 'start', task: armTask.id, arm, n });
          const runDir = path.join(outDir, 'inner-runs', armTask.id, `${arm}-${n}`);
          const userRole = userRoleFor(task, arm, n);
          const startDevice = task.device ? o.startDevice ?? (await DEVICE_STARTERS[task.device]()) : undefined;
          const run = await runInnerArm({
            arm, task: armTask, runDir, sdk, userRole, judge, screen, pluginRoot, convertedRoot, models, taskSettings, envExtra, sandbox, signal, model, timeoutMs, pollMs, startDevice,
          });
          const summary = { ...summarizeRun(run, { task: armTask.id, arm, n }), userRoleCostUsd: userRole.cost?.() ?? 0 };
          record.runs.push(summary);
          save();
          onProgress({ phase: 'end', task: armTask.id, arm, n, status: run.status, score: summary.score, reason: run.reason });
          if (run.status === 'stopped') {
            stopped = { reason: run.limitHit ? 'usage_limit' : 'interrupted', message: run.reason, run: `${armTask.id}/${arm}-${n}` };
          }
        }
      }
    }
  } finally {
    await screen?.close();
    judge.close?.();
  }
  record.stopped = stopped;
  record.status = stopped ? 'stopped' : 'completed';
  record.finishedAt = new Date().toISOString();
  save();
  return record;
}

// ---- コマンドライン ----------------------------------------------------------------------------------------

export function parseArgs(argv) {
  const out = { personas: [], runs: 1, arms: ['with', 'without'], style: 'normal', sandbox: true, passEnv: [], models: {}, settings: {} };
  const need = (i, flag) => {
    if (i + 1 >= argv.length) throw new InnerEvalError('usage', `${flag} には値が要ります。`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case '--plugin': out.plugin = need(i, flag); i += 1; break;
      case '--persona': out.personas.push(need(i, flag)); i += 1; break;
      case '--converted': out.converted = need(i, flag); i += 1; break;
      case '--runs': out.runs = Number(need(i, flag)); i += 1; break;
      case '--arms': out.arms = need(i, flag).split(',').map((s) => s.trim()); i += 1; break;
      case '--out': out.out = need(i, flag); i += 1; break;
      case '--style': out.style = need(i, flag); i += 1; break;
      case '--model': out.model = need(i, flag); i += 1; break;
      case '--judge-model': out.judgeModel = need(i, flag); i += 1; break;
      case '--orchestrator-model': out.models.orchestrator = need(i, flag); i += 1; break;
      case '--worker-model': out.models.worker = need(i, flag); i += 1; break;
      case '--verifier-model': out.models.verifier = need(i, flag); i += 1; break;
      case '--setting': {
        const pair = need(i, flag);
        const at = pair.indexOf('=');
        if (at <= 0) throw new InnerEvalError('usage', `--setting は 鍵=値 の形にしてください：${pair}`);
        out.settings[pair.slice(0, at)] = pair.slice(at + 1);
        i += 1;
        break;
      }
      case '--timeout-minutes': out.timeoutMs = Number(need(i, flag)) * 60_000; i += 1; break;
      case '--pass-env': out.passEnv = need(i, flag).split(',').map((s) => s.trim()).filter(Boolean); i += 1; break;
      case '--no-sandbox': out.sandbox = false; break;
      case '--sandbox': out.sandbox = true; break;
      default: throw new InnerEvalError('usage', `知らない引数です：${flag}`);
    }
  }
  if (!out.plugin) throw new InnerEvalError('usage', '--plugin（生成プラグインのフォルダ）が要ります。');
  if (out.personas.length === 0) throw new InnerEvalError('usage', '--persona（模擬ユーザーのフォルダ）が1つ以上要ります。');
  if (!Number.isInteger(out.runs) || out.runs < 1) throw new InnerEvalError('usage', '--runs は1以上の整数にしてください。');
  if (!out.arms.every((a) => ARMS.includes(a)) || out.arms.length === 0) throw new InnerEvalError('usage', '--arms は with・without・standalone（コンマ区切り）にしてください。');
  if (out.timeoutMs !== undefined && !(out.timeoutMs > 0)) throw new InnerEvalError('usage', '--timeout-minutes は正の数にしてください。');
  return out;
}

async function loadPersonaTask(personaDir) {
  const { loadPersona } = await import('../personas/validate.mjs');
  const loaded = await loadPersona(personaDir);
  return { persona: loaded.persona, task: personaTaskOf(loaded) };
}

/**
 * 模擬ユーザーの内側の課題（inner/eval.json）。単体の課題（inner/standalone.json）と擬似の機器（persona.device）があれば付ける。
 * 単体の課題の入力は、eval.json と同じフォルダのものを使う（personas/FORMAT.md 3章）
 */
export function personaTaskOf(loaded) {
  const dir = path.join(loaded.dir, 'inner');
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'eval.json'), 'utf8'));
  const standaloneFile = path.join(dir, 'standalone.json');
  const standaloneJson = fs.existsSync(standaloneFile) ? JSON.parse(fs.readFileSync(standaloneFile, 'utf8')) : null;
  return {
    id: json.id, dir, json, personaId: loaded.persona.id, device: loaded.persona.device ?? null,
    standalone: standaloneJson ? { id: standaloneJson.id, dir, json: standaloneJson, personaId: loaded.persona.id } : null,
  };
}

function convertPlugin(pluginRoot, convertedRoot) {
  const run = spawnSync('python3', ['-I', CONVERT, pluginRoot, convertedRoot], { encoding: 'utf8', timeout: 300_000 });
  if (run.status !== 0) throw new InnerEvalError('convert_failed', `置き換えに失敗しました（終了コード ${run.status}）：${(run.stdout || run.stderr).slice(-600)}`);
}

/**
 * D1c のユーザー役（createUserRole の返り値）を、内側の EVAL が呼ぶ形 ({ question, choices, via, meta, notes }) => 答えの文字 にする。
 * notes は、メインのエージェントが質問の前にチャットに書いた文（文字の並び）。人は質問と一緒にこれを読むので、ユーザー役にも渡す（testing.md 6.1）。
 * via は、質問のしかた（AskUserQuestion、text、setting）。省くと、選択肢があれば AskUserQuestion、なければ text。
 */
export function userRoleFunction(role) {
  const fn = async ({ question, choices, via, meta, notes }) =>
    (await role.answer(question, choices ?? [], via ?? ((choices ?? []).length > 0 ? 'AskUserQuestion' : 'text'), meta ?? {}, notes ?? [])).answer;
  fn.cost = () => role.cost;
  return fn;
}

/** 始められなかった誤りを、{ error, message } にする。部品（npm のパッケージ）が入っていないときは、入れ方を示す */
export function describeFailure(error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') {
    return { error: 'tools_missing', message: `必要な部品が入っていません。tests/dev-eval で npm install を実行してください（${String(error.message).split('\n')[0]}）。` };
  }
  return { error: error?.code ?? 'failed', message: error?.message ?? String(error) };
}

/** deps は試験用：sdk（Agent SDK）と chromium と diskCheck（ディスクの空きの確かめ。disk.mjs の checkFreeSpace）を差し替える */
export async function main(argv = process.argv.slice(2), deps = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: 'usage', message: error.message }));
    return 2;
  }
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  try {
    const sdk = deps.sdk ?? (await import('@anthropic-ai/claude-agent-sdk'));
    const chromium = deps.chromium ?? (await import('playwright')).chromium;
    const { createUserRole } = await import('./user-role.mjs');
    const pluginRoot = path.resolve(args.plugin);
    // 結果のフォルダを作って置き換える前に、サンドボックスの道具とディスクの空きを確かめる（始めずに断る。testing.md 5章）
    const diskCheck = deps.diskCheck ?? checkFreeSpace;
    preflight({ sandbox: args.sandbox, diskCheck, outDir: path.resolve(args.out ?? os.tmpdir()) });
    const outDir = path.resolve(args.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-creator-dev-inner-')));
    fs.mkdirSync(outDir, { recursive: true });
    const convertedRoot = path.resolve(args.converted ?? path.join(outDir, 'converted'));
    if (!args.converted) convertPlugin(pluginRoot, convertedRoot);
    const loaded = [];
    for (const dir of args.personas) loaded.push(await loadPersonaTask(path.resolve(dir)));
    const envExtra = Object.fromEntries(args.passEnv.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
    const personaOf = new Map(loaded.map((l) => [l.task.id, l.persona]));
    // ユーザー役のホームは、結果のフォルダに置く（OS の一時フォルダに残さない。outer-inner.mjs と同じ）
    const userRoleFor = (task, arm, n) => {
      const home = fs.mkdtempSync(path.join(outDir, `user-${task.id}-${arm}-${n}-`));
      const role = createUserRole({ persona: personaOf.get(task.id), styleName: args.style, query: sdk.query, home, envExtra });
      return userRoleFunction(role);
    };
    const record = await innerEval({
      sdk, chromium, pluginRoot, convertedRoot, tasks: loaded.map((l) => l.task), userRoleFor, outDir, runs: args.runs, arms: args.arms, models: args.models, taskSettings: args.settings,
      model: args.model, judgeModel: args.judgeModel, envExtra, sandbox: args.sandbox, timeoutMs: args.timeoutMs, signal: abort.signal, diskCheck,
      onProgress: (p) => console.error(p.phase === 'start' ? `[内側の EVAL] ${p.task} ${p.arm} ${p.n} 回目を始める` : `[内側の EVAL] ${p.task} ${p.arm} ${p.n} 回目：${p.status}${p.score !== null && p.score !== undefined ? `（点数 ${p.score}）` : ''}${p.reason ? ` ${p.reason}` : ''}`),
    });
    console.log(JSON.stringify(record, null, 2));
    return record.status === 'stopped' ? 1 : 0;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, ...describeFailure(error) }));
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main();
}
