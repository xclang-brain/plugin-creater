// 外側の EVAL の 1 回（testing.md 3章の手順2〜3、6章）。
//   1. まっさらな作業フォルダに、模擬ユーザーの示すファイルを置く（6.1）。
//   2. 置き換えた版のクリエイターだけを読み込み、Agent SDK で動かす（5章）。クリエイターのエクステンションは、同じプロセスの
//      MCP サーバーとして出す（creator-tools.mjs。4章）。質問のツール（AskUserQuestion）と、文章で質問して手番を終えたときの
//      問いには、ユーザー役が答える（user-role.mjs。6.1）。
//   3. 生成プラグインができたら、1・2段目の試験と、内側の EVAL を動かし、6.5 の観点で採点する（outer-grade.mjs）。
//   4. 会話の全文と採点を、記録（record.json）に残す（6.6）。
// 開発者が答えるとき（6.7）は、ユーザー役の代わりに、中継（human-relay.mjs）を作る関数を引数 createAnswerer で渡し、answerer を human にする。
// 止まった実行を続きから始めるとき（outer.mjs --resume）は、引数 resume で、前の実行のフォルダとクリエイターへの最初の発言を渡す。
// 改善の模擬ユーザー（persona.kind が change。testing.md 6章）では、題材のリポジトリを作業フォルダに置き（outer-change.mjs）、
// 問いに答える直前・記録のツールのたび・手番の終わりに、直すプラグインのフォルダの HEAD と git status を記録する（repo.snapshot）。
// 終わりは「承認の後に HEAD が進み、直すフォルダに変更が残っていない」で見分け、直したフォルダの 1・2段目を動かして、outer-grade-change.mjs で採点する。
// 前の会話の記録は、クリエイターのセッションの記録から読み直す（outer-resume.mjs）。
// 実際のモデルを使うのは、query（Agent SDK）を渡さないときだけ。試験では偽物の query を渡す。
// 統括がユーザーの承認をとってから、実際のモデルで動かすこと。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DISK_ERROR, diskErrorsOnly, removeAgentCache, removeSessionRecords } from './disk.mjs';
import { makeQueryOptions, sandboxStatus } from './isolation.mjs';
import { readConversionReport } from './model-map.mjs';
import { collectGeneratedFiles, gradeOuter, personaFileHashes } from './outer-grade.mjs';
import { changeEnded, changePaths, changeRecordOf, collectChangeRepo, manifestOf, placeWorkspace, readBaseline, takeBaseline, takeSnapshot } from './outer-change.mjs';
import { gradeChange } from './outer-grade-change.mjs';
import { createCreatorToolkit, REPO_ROOT } from './creator-tools.mjs';
import { createUserRole, LIMIT_PATTERN, loadQuery } from './user-role.mjs';
import { conversationOf, createMessageRecorder, createRecorder, questionItemData } from './outer-record.mjs';
import { abandonedQuestionOf, checkReplayAgainstRelay, findSessionTranscript, NO_TEXT_QUESTION, readResumes, replayTranscript, resumeQuestionItem, runDirsOf, writeResumes } from './outer-resume.mjs';

export { conversationOf, createRecorder };

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

/** 利用枠の上限のエラーの文（agent-sdk-eval.md）。ユーザー役の呼び出しでも使うので、user-role.mjs が持つ */
export { LIMIT_PATTERN };

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

/** 始める前から作業フォルダにあったプラグイン（作り直しで示した元のプラグイン）の記録。実行のフォルダに置き、続きから始めるときも使う */
export const PREEXISTING_PLUGINS_FILE = 'preexisting-plugins.json';

/**
 * 始める前から作業フォルダにあったプラグインを、作業フォルダからの相対の場所で記録して返す。続きから始めるときは、記録を読む（なければ空）。
 * 作り直しでは、示したファイルに元のプラグインが入るので、これを生成プラグインと取り違えないためである。
 */
export function preexistingPlugins(runDir, workDir, { resume = false } = {}) {
  const file = path.join(runDir, PREEXISTING_PLUGINS_FILE);
  if (resume) return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  const list = findGeneratedPlugins(workDir).map((d) => path.relative(workDir, d).split(path.sep).join('/'));
  fs.writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`);
  return list;
}

// ---- 1・2段目 ----------------------------------------------------------------------------------------------

/**
 * 生成プラグインの 1・2段目の入口（tests/run.py）を動かす。Playwright（1.56.1）は、このリポジトリの開発の試験の道具から、
 * 生成プラグインの tests/node_modules に一時的に写す（run.py は ESM で import するので、全体に入れたものは見つからない）。
 * 写しは終わったら消す（根の外を指すシンボリックリンクは 1段目で不合格になるので、写す）。
 * run.py には、1回ごとの一時フォルダ（tmpRoot の下の dev-eval-stages-*）を TMPDIR で渡し、終わったら消す。生成プラグインの試験の残り
 * （画面の試験が chrome・msedge を試して見つからないときに Playwright が残す playwright-artifacts-*・playwright_chromiumdev_profile-* など）を、
 * OS の一時フォルダにためないためである（testing.md 5章）。
 * 段階の不合格がすべてディスクの誤りなら、その段階に diskErrorsOnly を、run.py がディスクの誤りで結果を出せずに落ちたら diskError を付ける
 * （採点は、環境で止まったとして点数に入れない。outer-grade.mjs の environmentNotGraded。testing.md 6.5）。
 */
export async function runGeneratedStages(pluginDir, { python = 'python3', env = process.env, timeoutMs = DEFAULTS.stageTimeoutMs, nodeModules = path.join(DEV_EVAL, 'node_modules'), tmpRoot = os.tmpdir() } = {}) {
  const runPy = path.join(pluginDir, 'tests', 'run.py');
  if (!fs.existsSync(runPy)) return { skipped: true, reason: 'tests/run.py がない（1・2段目の入口がない）' };
  const target = path.join(pluginDir, 'tests', 'node_modules');
  const copied = [];
  let tmp = null;
  try {
    for (const name of ['playwright', 'playwright-core']) {
      const from = path.join(nodeModules, name);
      const to = path.join(target, name);
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.mkdirSync(target, { recursive: true });
        copied.push(to); // 写す途中で落ちても（ENOSPC など）、写しかけを消す
        fs.cpSync(from, to, { recursive: true });
      }
    }
    tmp = fs.mkdtempSync(path.join(tmpRoot, 'dev-eval-stages-'));
    const childEnv = { ...env, TMPDIR: tmp };
    if (!childEnv.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync('/opt/pw-browsers')) childEnv.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
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
      // 結果のファイル（tests/results/latest.json）を書けずに落ちたときなど。理由がディスクの誤りなら印を付ける（道具が足りないときは付けない）
      const disk = DISK_ERROR.test(`${result.stderr}\n${result.stdout}`);
      return { skipped: true, reason: `tests/run.py の結果を読めない（終了コード ${result.code}）：${(result.stderr || result.stdout).slice(-300)}`, ...(disk ? { diskError: true } : {}) };
    }
    if (result.code === 2) return { skipped: true, reason: `道具が足りなくて止まった：${(report.tools?.missing ?? []).map((m) => m.name ?? m.id ?? m).join('、')}`, report };
    const byId = (id) => (report.stages ?? []).find((s) => s.id === id);
    const summary = (s) => (s ? { ok: s.status === 'passed', status: s.status, counts: s.counts ?? null, failures: (s.failures ?? []).slice(0, 10), failedTests: (s.tests ?? []).filter((t) => t.status === 'failed').slice(0, 10) } : { ok: false, status: 'missing' });
    // 段階の不合格がすべてディスクの誤り（ENOSPC・EIO）なら、印を付ける（採点は、環境で止まったとして点数に入れない。testing.md 6.5）。
    // 記録の failures は 10 件までなので、ここで全件を見る
    const marked = (id) => {
      const stage = byId(id);
      return { ...summary(stage), ...(diskErrorsOnly(stage) ? { diskErrorsOnly: true } : {}) };
    };
    return {
      skipped: false, ok: report.ok === true, exitCode: result.code, stage1: marked('stage1'), stage2: marked('stage2'),
      resultsFile: report.resultsFile ?? null, durationSeconds: report.durationSeconds ?? null,
    };
  } finally {
    for (const dir of copied) fs.rmSync(dir, { recursive: true, force: true });
    try {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
      if (fs.existsSync(target) && fs.readdirSync(target).length === 0) fs.rmdirSync(target);
    } catch {
      // 残っていてもよい（止めた子プロセスがまだ書いているときなど）
    }
  }
}

/** 会話が終わったとき（終わりの理由）。生成プラグインができた、または改善の模擬ユーザーで直すフォルダを直した・新しいフォルダに作った */
export const FINISHED_REASONS = Object.freeze(['generated', 'generated_without_approval', 'changed', 'changed_without_approval', 'generated_new_folder']);

/** ユーザー役が答えられずに会話を止めたときの終わりの理由（試験の仕組みの失敗。クリエイターの誤りではない） */
export const USER_ROLE_FAILED = 'user_role_failed';

/** 続きから始めたとき、読み直しが確かでなければ採点しない観点（会話の全体にもとづく観点） */
export const CONVERSATION_GRADES = Object.freeze(['all-items-heard', 'no-generation-before-approval']);

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
 * @param {string} [o.fixturesDir] 改善の模擬ユーザーの題材の置き場所（試験用。省くと tests/dev-eval/fixtures）
 * @param {{ runDir: string, prompt: string, sessionId?: string, relayDir?: string, fromRelayId?: string|null, abandoned?: string[] }} [o.resume]
 *   止まった実行を続きから始める（開発者が答えるときだけ。testing.md 6.7）。runDir は前の実行のフォルダ（その中の work などを使い、
 *   示すファイルは置き直さない）。prompt は、続けるセッションに送る最初の発言。sessionId を省くと、agent-home のセッションの記録から探す。
 *   relayDir は、読み直した答えを突き合わせる中継のフォルダ（省くと、答えるものの relayDir）。fromRelayId と abandoned は、
 *   続きから始めた時点の最後の問いの id と、待たない印を置いた問いの id（記録の resumed に残す）
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
  const resume = o.resume ?? null;
  if (!['with', 'control', 'without'].includes(arm)) throw new Error(`arm は with・control・without のどれかです：${arm}`);
  if (resume) {
    if (!human) throw new Error('続きから始める（resume）のは、開発者が答えるとき（answerer が human）だけです。');
    if (typeof resume.prompt !== 'string' || resume.prompt.trim() === '') throw new Error('続きから始めるときは、最初の発言（resume.prompt）が要ります。');
    if (!resume.runDir || !fs.existsSync(path.join(resume.runDir, 'work'))) throw new Error(`続きから始める実行のフォルダがありません（${resume.runDir}）。`);
  }
  let { persona } = loaded;
  const { files: personaFiles } = loaded;
  // 改善の模擬ユーザー（testing.md 6章）。直すプラグインのフォルダを直す（新しいフォルダに作らない）
  const change = persona.kind === 'change';
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

  // 続きから始めるときは、前の実行のフォルダをそのまま使う（記録のツールの記録の置き場所も、フォルダの名前から決まるので同じになる）
  let runDir;
  if (resume) runDir = path.resolve(resume.runDir);
  else {
    fs.mkdirSync(runRoot, { recursive: true });
    runDir = fs.mkdtempSync(path.join(runRoot, `outer-${persona.id}-${arm}-`));
  }
  const dirs = runDirsOf(runDir);
  for (const d of [dirs.work, dirs.agentHome, dirs.copilotHome, dirs.userHome]) fs.mkdirSync(d, { recursive: true });
  let baseline = null;
  if (!resume) {
    // role が repo のファイルは、題材のリポジトリの初めのコミットの前に置く（placeWorkspace）
    placePersonaFiles(dirs.work, change ? personaFiles.filter((f) => f.role !== 'repo') : personaFiles);
    if (change) {
      const placed = placeWorkspace(dirs.work, persona, loaded.dir, { ...(o.fixturesDir ? { fixturesDir: o.fixturesDir } : {}), originDir: path.join(runDir, 'origin.git') });
      baseline = takeBaseline(runDir, { workDir: dirs.work, persona, originDir: placed.originDir, now: clock.now });
    }
  } else if (change) baseline = readBaseline(runDir);
  // 改善の模擬ユーザーの直すフォルダも、始める前からあるプラグインに入る（新しいフォルダの見分けに使う）。直すフォルダのマニフェストが
  // 直下にないとき（.claude-plugin/ など）は、始める前の記録に入らないが、直して直下に plugin.json ができても、新しいフォルダに数えない
  const preexisting = preexistingPlugins(runDir, dirs.work, { resume: Boolean(resume) });
  const targetRel = change ? path.relative(dirs.work, changePaths(dirs.work, persona).targetDir).split(path.sep).join('/') : null;
  const generatedPlugins = () => findGeneratedPlugins(dirs.work)
    .map((d) => ({ d, rel: path.relative(dirs.work, d).split(path.sep).join('/') }))
    .filter(({ rel }) => !preexisting.includes(rel) && rel !== targetRel)
    .map(({ d }) => d);
  // 続きから始めるときのセッションの番号と、その記録（ここで探せなければ、何も動かさずに断る）
  const transcript = resume ? findSessionTranscript(dirs.agentHome, resume.sessionId) : null;

  const startedAt = new Date(clock.now()).toISOString();
  const recorder = createRecorder(() => clock.now());
  const refused = [];
  const skills = [];
  const subagents = {}; // Agent の呼び出しの番号 → { type, description, model }
  const models = {}; // 'main' か Agent の呼び出しの番号 → そのエージェントのメッセージに出たモデル（出た順、重ならない）
  const results = [];
  const initInfo = [];
  let agentCostUsd = 0;
  let sessionId = transcript?.sessionId;
  let stopped = null;
  const messageRecorder = createMessageRecorder({ recorder, models, subagents, skills });
  /** 改善の模擬ユーザーで、直すフォルダの HEAD と git status を記録する（承認の前に変わっていないかを見る材料） */
  const snapshot = (reason) => {
    if (!change) return null;
    const { at, ...s } = takeSnapshot({ workDir: dirs.work, persona, reason, now: clock.now });
    recorder.add('repo.snapshot', s);
    return { at, ...s };
  };

  // クリエイターの置き換え（置き換えた版と、エクステンションの代わりの MCP サーバー）
  let converted = null;
  let conversion = null;
  // 続きから始めるときは、実行のフォルダの中の置き換えた版があれば、それを使う（前の実行と同じクリエイターで続ける）
  const keptConverted = resume ? path.join(dirs.converted, path.basename(creatorRoot)) : null;
  if (arm !== 'without') {
    converted = o.convertedCreator ?? (keptConverted && fs.existsSync(path.join(keptConverted, '.eval', 'conversion-report.json')) ? keptConverted : null) ?? (() => {
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
        onEvent: (e) => {
          // 記録のツールが動く前のスナップショットを、呼び出しより前の順番にする（承認の呼び出しの直前の状態が、承認の前に入る）
          if (e.type === 'tool.call') snapshot(`tool:${e.tool}`);
          e.seq = recorder.next();
        },
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

    // ユーザー役が答えられなかった（呼び直しても呼び出しが失敗した、答えが道具の呼び出しの形のまま。user-role.mjs）ときは、試験の仕組みの
    // 失敗としてこの会話を止める（理由 user_role_failed）。質問のツールの答えの失敗は、そのままだと Agent SDK がクリエイターに誤りとして渡し、
    // クリエイターが本物の利用者では起きない問題に対応してしまうので、手番も中断する（testing.md 6.1）。
    // ユーザー役が利用枠の上限に当たったときは、クリエイターと同じく理由を usage_limit にする（比べる EVAL の全体を止めるため。outer.mjs の runPlan）
    let userRoleFailure = null;
    let turnAbort = null;
    const answerOrStop = async (...args) => {
      try {
        return await userRole.answer(...args);
      } catch (error) {
        userRoleFailure ??= error;
        turnAbort?.abort();
        throw error;
      }
    };
    const userRoleStop = () => {
      const message = String(userRoleFailure?.message ?? userRoleFailure).slice(0, 300);
      // user-role.mjs は利用枠の上限を code で知らせる。code のない誤り（別の答えるものなど）は、文で見る
      const limited = userRoleFailure?.code ? userRoleFailure.code === 'usage_limit' : LIMIT_PATTERN.test(message);
      return { reason: limited ? 'usage_limit' : USER_ROLE_FAILED, message };
    };

    // 質問のツール（AskUserQuestion）への答え。ユーザー役が答える
    let askGroup = 0; // 質問のツールの呼び出しの番号。1 回の呼び出しの問いの欄の数を数えるため（testing.md 6.5、hearing.md 4.1）
    const onQuestion = async (questions) => {
      const answers = {};
      askGroup += 1;
      const group = askGroup;
      // 質問の直前の文の処理が、この呼び出しより後になることがあるので、1 回譲ってから受け取る
      await new Promise((resolve) => setImmediate(resolve));
      let notes = unreadNotes.splice(0);
      snapshot('question');
      for (const q of questions) {
        const item = questionItemData(q, group, questions.length);
        const { options } = item;
        recorder.add('creator.question', item);
        // 1 回の呼び出しの問いの欄の番号と数は、別の答えるもの（開発者の中継）にだけ渡す（ユーザー役の答えの記録を変えないため）
        const meta = { header: q.header ?? '', multiSelect: Boolean(q.multiSelect), ...(createAnswerer ? { group, groupSize: questions.length } : {}) };
        const entry = await answerOrStop(q.question, options, 'AskUserQuestion', meta, notes);
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
    async function runTurn(prompt, resumeSessionId) {
      turnNumber += 1;
      const abortController = new AbortController();
      turnAbort = abortController;
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
        resume: resumeSessionId,
        abortController,
      });
      if (maxBudgetUsd !== undefined) options.maxBudgetUsd = maxBudgetUsd;
      const turn = { number: turnNumber, result: null, lastText: '' };
      try {
        for await (const m of query({ prompt, options })) {
          sessionId = m.session_id ?? sessionId;
          if (m.type === 'system' && m.subtype === 'init') {
            initInfo.push({ plugins: (m.plugins ?? []).map((p) => p.name), mcp: (m.mcp_servers ?? []).map((s) => `${s.name}:${s.status}`), model: m.model });
          } else if (m.type === 'assistant' || m.type === 'user') {
            messageRecorder.handle(m, {
              turn: turnNumber,
              onText: (text) => {
                unreadNotes.push(text.trim());
                turn.lastText = text;
              },
            });
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
    const finishedReason = (turnSnapshot) => {
      if (change) {
        const newPlugins = generatedPlugins().map((d) => path.relative(dirs.work, d).split(path.sep).join('/'));
        return changeEnded({ baseline, snapshot: turnSnapshot, approved: arm !== 'with' || readState()?.stage === 'generate', newPlugins });
      }
      if (generatedPlugins().length === 0) return null;
      return arm === 'with' && readState()?.stage !== 'generate' ? 'generated_without_approval' : 'generated';
    };

    let prompt = persona.request;
    let exchanges = 0;
    let replay = null;
    let resumes = [];
    if (resume) {
      // 止まった実行の会話を、セッションの記録から読み直す。記録のツールの呼び出しは、新しい部品の events の前に置く
      const previous = readResumes(runDir);
      const r = replayTranscript({ file: transcript.file, recorder, messageRecorder, resumes: previous.filter((x) => typeof x?.prompt === 'string'), ...(toolkit ? { serverName: toolkit.serverName } : {}) });
      // 質問のツールの呼び出しの番号は、読み直した呼び出しの続きにする（1 回の呼び出しの問いの数を、正しく数えるため）
      askGroup = r.askGroups;
      const relayDir = resume.relayDir ?? userRole.relayDir ?? null;
      const relayCheck = relayDir ? checkReplayAgainstRelay({ items: recorder.items, relayDir }) : null;
      const reliable = r.problems.length === 0 && (relayCheck === null || relayCheck.ok);
      replay = {
        transcript: transcript.file,
        sessionId,
        reliable,
        problems: [...r.problems, ...(relayCheck?.problems ?? [])],
        warnings: r.warnings,
        counts: r.counts,
        relayCheck,
        toolEvents: r.toolEvents,
        pendingAsks: r.pendingAsks,
      };
      if (r.request !== null) persona = { ...persona, request: r.request };
      if (r.lastCost !== null) agentCostUsd = r.lastCost; // 続きの会話の total_cost_usd は、それまでの分を含む合計
      turnNumber = r.turns;
      exchanges = r.turns;
      // 前のプロセスが答えを待っていた問いへの答えは、統括が最初の発言に入れる。続きの最初の発言を、その問いへの答えとして記録する。
      // 待っていた問いは、質問のツールなら、読み直した答えのない問い。文章の問いなら、中継のフォルダの、待たない印を置いた問い
      // （文章の問いは、セッションの記録には問いとして残らない。また続きから始めたときのために、resumes.json にも残す）
      const pending = r.pendingAsks.at(-1);
      const relayQuestion = relayDir ? abandonedQuestionOf(relayDir, resume.abandoned ?? []) : null;
      const waited = pending
        ? { via: 'AskUserQuestion', question: pending.question, header: pending.header }
        : relayQuestion ? { via: relayQuestion.via, question: relayQuestion.question, header: relayQuestion.header } : null;
      resumes = [...previous, { at: new Date(clock.now()).toISOString(), sessionId, fromRelayId: resume.fromRelayId ?? null, abandoned: resume.abandoned ?? [], prompt: resume.prompt, question: waited }];
      writeResumes(runDir, resumes);
      const asked = pending ? { question: pending.question, header: pending.header } : resumeQuestionItem(recorder, waited, turnNumber);
      recorder.add('run.resumed', { sessionId, fromRelayId: resume.fromRelayId ?? null, abandoned: resume.abandoned ?? [], reliable });
      recorder.add('user.answer', { index: null, via: 'resume', question: asked.question, header: asked.header, choices: [], answer: resume.prompt, rawAnswer: resume.prompt, signal: false });
      toolkit?.recordPrompt(resume.prompt);
      onProgress({ phase: 'resumed', sessionId, reliable, counts: r.counts });
      prompt = resume.prompt;
    } else {
      recorder.add('user.request', { text: persona.request });
    }
    let lastCreatorText = ''; // クリエイターの最後の発言（開発者が答えるとき、終わりの状態に載せる）
    try {
      for (; exchanges < maxExchanges; exchanges += 1) {
        if (signal?.aborted) { stopped = { reason: 'interrupted' }; break; }
        onProgress({ phase: 'turn', n: exchanges + 1 });
        const turn = await runTurn(prompt, sessionId);
        if (userRoleFailure) { stopped = userRoleStop(); break; }
        const turnSnapshot = snapshot('turn-end');
        const text = (turn.result?.result ?? '').trim() || turn.lastText.trim();
        if (text) lastCreatorText = text;
        if (!turn.result) { stopped = { reason: 'no_result' }; break; }
        if (turn.result.is_error || turn.result.subtype !== 'success') {
          stopped = { reason: LIMIT_PATTERN.test(`${turn.result.result ?? ''}`) ? 'usage_limit' : turn.result.subtype ?? 'error', message: String(turn.result.result ?? '').slice(0, 300) };
          break;
        }
        const finished = finishedReason(turnSnapshot);
        if (finished) { stopped = { reason: finished }; break; }
        // 文章で質問して手番を終えたときも、ユーザー役の答えを次の発言として返す（6.1）
        const question = text || NO_TEXT_QUESTION;
        recorder.add('creator.question-text', { text: question, turn: turn.number });
        // 手番の最後の文は問いそのもの。それより前に書いた文だけを、前の文として渡す
        const notes = unreadNotes.splice(0).filter((n) => n !== question.trim());
        const entry = await answerOrStop(question, [], 'text', {}, notes);
        recorder.add('user.answer', { index: entry.index, via: 'text', question, header: '', choices: [], answer: entry.answer, rawAnswer: entry.rawAnswer, signal: entry.signal });
        toolkit?.recordPrompt(entry.answer);
        onProgress({ phase: 'answer', via: 'text', index: entry.index });
        prompt = entry.answer;
      }
      if (!stopped) stopped = { reason: 'max_exchanges' };
    } catch (error) {
      stopped = userRoleFailure ? userRoleStop() : { reason: 'exception', message: error?.message ?? String(error) };
    }
    // 開発者の答えを待つ間などに中断されたら、生成まで進んでいなければ、中断として終える（ユーザー役の AI のときは、これまでどおり）
    if (createAnswerer && signal?.aborted && !FINISHED_REASONS.includes(stopped?.reason)) {
      stopped = { reason: 'interrupted', ...(stopped?.reason ? { detail: stopped.reason } : {}) };
    }
    userRole.setStatus?.({ phase: 'grading' });
    // クリエイターが入れたもの（.cache/ms-playwright の Chromium など。1回で約 1GB）は、1・2段目を動かす前に消す。実行ごとにたまって、
    // ディスクをあふれさせないため（testing.md 5章）。開発者が答えるときは、セッションの記録（.claude）と同じく残す（続きから始めたときに、
    // クリエイターが入れたブラウザーがなくなって、入れ直しを開発者に聞くことがないように）
    if (!keepHomes && !human) removeAgentCache(dirs.agentHome);

    // ---- 生成プラグインの採点 ----
    const plugins = generatedPlugins();
    // 改善の模擬ユーザーでは、直したフォルダを採点する。材料（リポジトリと直したファイル）は、1・2段目の結果のファイルが混ざる前に集める
    const changeRepo = change
      ? collectChangeRepo({ workDir: dirs.work, persona, baseline, newPlugins: plugins.map((d) => path.relative(dirs.work, d).split(path.sep).join('/')) })
      : null;
    const changedDir = change ? changePaths(dirs.work, persona).targetDir : null;
    // 直すフォルダのマニフェストは、直下のほかに .plugin/・.github/plugin/・.claude-plugin/ にあってもよい（エクステンションと同じ探し方）
    const pluginDir = change ? (manifestOf(changedDir) ? changedDir : null) : plugins.length === 1 ? plugins[0] : null;
    let generatedFiles = null;
    let stages = null;
    let innerResult = null;
    let innerRecord = null;
    if (pluginDir) {
      if (!change) generatedFiles = collectGeneratedFiles(pluginDir);
      onProgress({ phase: 'stages' });
      try {
        stages = await runStages(pluginDir, {});
      } catch (error) {
        // Playwright の写しや一時フォルダを作れなかったときなど。理由がディスクの誤りなら印を付ける（採点しない。testing.md 6.5）
        stages = { skipped: true, reason: `1・2段目を動かせなかった：${error.message}`, ...(DISK_ERROR.test(String(error?.message ?? error)) ? { diskError: true } : {}) };
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
          // code（disk_low など）も残す。ディスクの空きが足りずに始めなかったときは、環境で止まったとして採点しない（outer-grade.mjs の environmentNotGraded）
          innerResult = { withScore: null, error: error?.message ?? String(error), ...(error?.code ? { code: error.code } : {}) };
        }
      }
    }

    // 開発者が答えるときは、内側の EVAL を動かさなかった理由も残す（黙って落とさない）
    if (human && inner && !innerResult) {
      innerResult = { withScore: null, withoutScore: null, difference: null, status: 'skipped', reason: pluginDir ? '生成プラグインが1段目に通らなかったので、動かしていない' : `生成プラグインが 1 つできなかった（${plugins.length} 個）ので、動かしていない` };
    }

    const state = readState();
    const toolEvents = [...(replay?.toolEvents ?? []), ...(toolkit ? toolkit.events : [])];
    // 続きから始めて、前の会話を確かに読み直せなかったときは、会話の全体にもとづく観点を、一部の記録で採点しない
    const notGraded = replay && !replay.reliable
      ? Object.fromEntries(CONVERSATION_GRADES.map((id) => [id, `続きから始めた実行で、前の会話を確かに読み直せなかったので採点しない（${replay.problems.slice(0, 3).join(' / ')}）`]))
      : {};
    // 内側の EVAL の結果を点数に入れるのは、点数が出たとき。ディスクの空きが足りずに始めなかったとき（disk_low）も渡し、環境で止まったとして
    // 採点しなかった観点に残す。開発者が答えるとき、内側の EVAL の結果は点数に入れない（クリエイターが作った基準でクリエイターを採点しない。testing.md 6.7）
    const innerForGrading = !human && innerResult && (innerResult.withScore !== null || innerResult.code === 'disk_low') ? innerResult : null;
    const modelUse = {
      requested: model,
      main: models.main ?? [],
      subagents: Object.entries(subagents).map(([id, s]) => ({ type: s.type, models: models[id] ?? [] })),
      lowCost: converted ? readConvertedAgentModel(converted, 'worker') : null,
    };
    const grading = change
      ? gradeChange({
          persona,
          record: { skills: skills.filter(Boolean) },
          state,
          items: recorder.items,
          toolEvents,
          stages,
          repo: changeRepo,
          personaFiles: personaFileHashes(personaFiles),
          modelUse,
          model,
          arm,
          answerer: answererKind,
          inner: innerForGrading,
        })
      : gradeOuter({
          persona,
          personaFiles,
          items: recorder.items,
          toolEvents,
          state,
          generatedCount: plugins.length,
          generatedFiles,
          stages,
          inner: innerForGrading,
          userSignals: userRole.signals,
          modelUse,
          model,
          arm,
          answerer: answererKind,
          notGraded,
        });
    if (human) grading.innerSeparate = innerResult;

    const finishedAt = new Date(clock.now()).toISOString();
    const record = {
      schema: 'outer-record/1',
      persona: { id: persona.id, title: persona.title, experience: persona.experience, ...(change ? { kind: 'change' } : {}) },
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
      ...(resume
        ? {
            resumed: resumes.map((x) => ({ at: x.at, sessionId: x.sessionId, fromRelayId: x.fromRelayId, abandoned: x.abandoned ?? [] })),
            replay: { transcript: replay.transcript, reliable: replay.reliable, problems: replay.problems, warnings: replay.warnings, counts: replay.counts, relayCheck: replay.relayCheck, pendingAsks: replay.pendingAsks },
          }
        : {}),
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
      ...(change ? { change: changeRecordOf(changeRepo, recorder.items) } : {}),
      stages,
      inner: innerResult,
      grading,
      dirs: { run: runDir, work: dirs.work },
    };
    const file = path.join(runDir, 'record.json');
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    record.recordFile = file;

    await toolkit?.shutdown();
    // 開発者が答えるときは、クリエイターのセッションの記録を消さない（止まったときに、続きから始められるように）
    if (!keepHomes && !human) removeSessionRecords(dirs.agentHome);
    finishInfo = {
      reason: stopped?.reason ?? null,
      ...(stopped?.message ? { message: stopped.message } : {}),
      lastText: lastCreatorText,
      score: grading.score,
      verdictOk: grading.verdict.ok,
      failed: grading.verdict.failed,
      // 採点しなかった観点（合否は残りの観点だけで決めた。続きから始めて、前の会話を確かに読み直せなかったときなど）
      ...(grading.notGraded?.length ? { notGraded: grading.notGraded.map((g) => g.id) } : {}),
      // 環境（ディスクがいっぱい）の影響を受けた回（outer-grade.mjs の environmentOf）
      ...(grading.environment ? { environment: grading.environment } : {}),
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
