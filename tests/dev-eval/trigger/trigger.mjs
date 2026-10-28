// 呼ばれ方の試験（BLUEPRINT D27。ナレッジ「Anthropic の skill-creator」：紛らわしい頼みで呼ばれ方を試して、説明文を直す）。
// スキルの description を変えるのは振る舞いの変更なので（ナレッジ「リファクタリング」）、頼みごとに、最初に呼ばれるスキルを確かめる。
//
//   1. クリエイターを Claude Code 向けに置き換える（convert.py。外側の EVAL と同じ）。
//   2. 頼み（cases.json）ごとに、まっさらな作業フォルダと一時的なホームフォルダを作り、置き換えた版だけを読み込んだ Claude Code（Agent SDK）に、頼みを1つ渡す。
//   3. 最初の Skill のツールの呼び出しを、フック（PreToolUse）で記録して断り、その場で止める。スキルの本文は読まれず、何も作られない。
//      Skill を呼ばずに手番を終えたら、呼ばなかったとして記録する。
//   4. 期待（expect）と比べ、結果のファイル（trigger-report.json）と標準出力に残す。
//
// 開発の試験は Claude Code で動かす見込みの試験である。本物の Copilot CLI と日本語の description で同じように呼ばれるかは、確かめたことにならない。
// 実際のモデルを使うのは、コマンドとして動かしたとき（main）だけ。試験（trigger.test.mjs）は、頼みの一覧の形と採点の関数だけを試し、モデルを呼ばない。
// 統括がユーザーの承認をとってから、実際のモデルで動かすこと（9件で約2ドル・10分の見込み）。
//
// 使い方（リポジトリの根で）:
//   node tests/dev-eval/trigger/trigger.mjs [--model claude-opus-5-5] [--cases <cases.json>] [--only <id,id>] [--out <フォルダ>] [--no-sandbox] [--dry-run]
// 終了コード: 0 すべて期待どおり、1 期待と違うものがある・途中で止まった、2 使い方の誤り・始められなかった

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { REPO_ROOT } from '../runner/creator-tools.mjs';
import { makeQueryOptions, sandboxStatus } from '../runner/isolation.mjs';
import { convertPlugin, defaultRunRoot } from '../runner/outer-run.mjs';
import { loadQuery } from '../runner/user-role.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CASES_FILE = path.join(HERE, 'cases.json');

/** クリエイターのスキル（skills/ のフォルダの名前） */
export const CREATOR_SKILLS = Object.freeze(['make-plugin', 'change-plugin', 'test-plugin', 'make-idea']);
/** クリエイターの名前（置き換えた版のスキルは「<この名前>:<スキル>」で呼ばれる） */
export const CREATOR_NAME = 'plugin-creator';

export const DEFAULTS = Object.freeze({
  model: 'claude-opus-5-5',
  maxTurns: 6, // 最初のスキルを選ぶまでの手番。スキルを呼ばない頼みでも、ここで止まる
  maxBudgetUsd: 1, // 1件の上限（ドル）
});

const CASE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- 頼みの一覧 ------------------------------------------------------------------------------------------

/** cases.json を読む（形は validateCases で確かめる） */
export function loadCases(file = CASES_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 作業フォルダの中の場所として使えるか（作業フォルダの外を指さない、POSIX の相対パス） */
function isSafeRelative(rel) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\\') || path.posix.isAbsolute(rel)) return false;
  return rel.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/**
 * 頼みの一覧の形を確かめる。
 * @returns {string[]} 誤り（平易な日本語）。空なら正しい
 */
export function validateCases(data) {
  const problems = [];
  if (!isObject(data)) return ['頼みの一覧は、JSON のオブジェクトにしてください。'];
  if (data.workspace !== undefined) {
    if (!isObject(data.workspace)) problems.push('workspace は、作業フォルダの中の場所から中身（文字）への対応にしてください。');
    else {
      for (const [rel, text] of Object.entries(data.workspace)) {
        if (!isSafeRelative(rel)) problems.push(`workspace の場所 ${JSON.stringify(rel)} は、作業フォルダの中の相対パス（/ 区切り、.. なし）にしてください。`);
        if (typeof text !== 'string') problems.push(`workspace の ${rel} の中身は、文字にしてください。`);
      }
    }
  }
  if (!Array.isArray(data.cases) || data.cases.length === 0) {
    problems.push('cases に、頼みを1つ以上書いてください。');
    return problems;
  }
  const seen = new Set();
  data.cases.forEach((c, i) => {
    const at = `cases[${i}]`;
    if (!isObject(c)) {
      problems.push(`${at} は、id・request・expect を持つオブジェクトにしてください。`);
      return;
    }
    if (typeof c.id !== 'string' || !CASE_ID.test(c.id)) problems.push(`${at} の id は、英小文字・数字・ハイフンにしてください。`);
    else if (seen.has(c.id)) problems.push(`${at} の id ${c.id} が重なっています。`);
    else seen.add(c.id);
    if (typeof c.request !== 'string' || c.request.trim() === '') problems.push(`${at} の request（頼みの文）がありません。`);
    if (!Array.isArray(c.expect)) problems.push(`${at} の expect は、スキルの名前の一覧にしてください（どれも呼ばないときは空の一覧）。`);
    else {
      const unknown = c.expect.filter((s) => !CREATOR_SKILLS.includes(s));
      if (unknown.length) problems.push(`${at} の expect に、クリエイターにないスキルがあります：${unknown.join('、')}（使えるもの：${CREATOR_SKILLS.join('、')}）`);
      if (new Set(c.expect).size !== c.expect.length) problems.push(`${at} の expect に、同じスキルが2回あります。`);
    }
  });
  return problems;
}

// ---- 採点 ------------------------------------------------------------------------------------------------

/**
 * Skill のツールの引数から、呼んだスキルの名前を決める。クリエイターのスキルなら短い名前（change-plugin など）、
 * ほかのスキル（Claude Code に組み込みのものなど）なら「other:<名前>」。
 */
export function skillOf(toolInput) {
  const raw = String(toolInput?.skill ?? '').trim().replace(/^\//, '');
  const short = raw.startsWith(`${CREATOR_NAME}:`) ? raw.slice(CREATOR_NAME.length + 1) : raw;
  return CREATOR_SKILLS.includes(short) ? short : `other:${raw}`;
}

/**
 * 1件の採点。first は最初に呼んだスキル（skillOf の結果）か、呼ばなかったときは null。
 * expect が空なら、クリエイターのスキルをどれも呼ばなければ合格（ほかのスキルを呼んでもよい）。
 */
export function gradeCase(testCase, first) {
  const got = first ?? null;
  const pass = testCase.expect.length > 0 ? testCase.expect.includes(got) : !CREATOR_SKILLS.includes(got);
  return { id: testCase.id, request: testCase.request, expect: [...testCase.expect], got, pass };
}

/** 全体のまとめ。ok は、すべての頼みが期待どおりで、止まった頼みがないこと */
export function summarize(results) {
  const failed = results.filter((r) => !r.pass).map((r) => r.id);
  const stopped = results.filter((r) => r.error).map((r) => r.id);
  return { total: results.length, passed: results.length - failed.length, failed, stopped, ok: failed.length === 0 && stopped.length === 0 };
}

/**
 * 最初の Skill の呼び出しを記録して断るフック。2つ目からも断る（最初の選択だけを見るため）。
 * @param {{ onCaught?: Function }} [o] onCaught は、最初の呼び出しのときに1回だけ呼ぶ（止めるため）
 */
export function makeSkillCatcher({ onCaught } = {}) {
  let first;
  const hook = async (input) => {
    if (first === undefined) {
      first = skillOf(input?.tool_input);
      onCaught?.(first);
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: '呼ばれ方の試験なので、スキルは読み込みません。ここで終えてください。',
      },
    };
  };
  return { hooks: { PreToolUse: [{ matcher: 'Skill', hooks: [hook] }] }, first: () => first };
}

// ---- 動かす（実際のモデル） --------------------------------------------------------------------------------

/**
 * 始まりの知らせ（init）のスキルの一覧に、クリエイターのスキルがすべてあるか。
 * プラグインのスキルが「plugin-creator:<スキル>」と「<スキル>」のどちらで並ぶかは、実際の実行で確かめていないので、両方を認める。
 */
export function creatorLoaded(skills = []) {
  const names = new Set((skills ?? []).map(String));
  return CREATOR_SKILLS.every((s) => names.has(s) || names.has(`${CREATOR_NAME}:${s}`));
}

/** 作業フォルダに、頼みの一覧の workspace のファイルを置く */
export function placeWorkspace(dir, files = {}) {
  for (const [rel, text] of Object.entries(files)) {
    const target = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
}

/**
 * 頼みを1つ動かす。
 * @returns {Promise<object>} gradeCase の結果に、loaded（クリエイターのスキルが読み込まれたか）、costUsd、error を足したもの
 */
export async function runCase({ testCase, workspace, query, converted, model, runDir, sandbox, maxTurns = DEFAULTS.maxTurns, maxBudgetUsd = DEFAULTS.maxBudgetUsd }) {
  const caseDir = fs.mkdtempSync(path.join(runDir, `${testCase.id}-`));
  const work = path.join(caseDir, 'work');
  const home = path.join(caseDir, 'home');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  placeWorkspace(work, workspace);
  const abortController = new AbortController();
  const catcher = makeSkillCatcher({ onCaught: () => setImmediate(() => abortController.abort()) });
  const options = makeQueryOptions({ cwd: work, home, model, plugins: [converted], hooks: catcher.hooks, sandbox, maxTurns, abortController });
  options.maxBudgetUsd = maxBudgetUsd;
  let loaded = null;
  let costUsd = null;
  let error = null;
  try {
    for await (const m of query({ prompt: testCase.request, options })) {
      if (m.type === 'system' && m.subtype === 'init') {
        loaded = creatorLoaded(m.skills);
      } else if (m.type === 'result') {
        costUsd = m.total_cost_usd ?? null;
      }
      if (catcher.first() !== undefined) break;
    }
  } catch (e) {
    if (!abortController.signal.aborted) error = e.message;
  } finally {
    abortController.abort();
  }
  if (loaded === false) error = error ?? 'クリエイターのスキルが読み込まれませんでした（置き換えた版を確かめてください）。';
  const graded = gradeCase(testCase, catcher.first() ?? null);
  return { ...graded, pass: graded.pass && !error, loaded, costUsd, error };
}

export function parseArgs(argv) {
  const out = { model: DEFAULTS.model, cases: CASES_FILE, only: null, sandbox: true, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const need = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} には値が要ります。`);
      i += 1;
      return argv[i];
    };
    if (a === '--model') out.model = need();
    else if (a === '--cases') out.cases = need();
    else if (a === '--only') out.only = need().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out') out.out = need();
    else if (a === '--no-sandbox') out.sandbox = false;
    else if (a === '--dry-run') out.dryRun = true;
    else throw new Error(`知らない引数です：${a}`);
  }
  return out;
}

/**
 * @param {string[]} argv
 * @param {{ query?: Function, convert?: Function }} [deps] 試験用の差し替え
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  let args;
  let data;
  try {
    args = parseArgs(argv);
    data = loadCases(path.resolve(args.cases));
    const problems = validateCases(data);
    if (problems.length) throw new Error(`頼みの一覧が正しくありません：${problems.join(' ')}`);
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: 'usage', message: error.message }));
    return 2;
  }
  const cases = args.only ? data.cases.filter((c) => args.only.includes(c.id)) : data.cases;
  if (cases.length === 0) {
    console.log(JSON.stringify({ ok: false, error: 'usage', message: `--only に当たる頼みがありません：${args.only.join('、')}` }));
    return 2;
  }
  if (args.dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, model: args.model, cases: cases.map((c) => ({ id: c.id, request: c.request, expect: c.expect })) }, null, 2));
    return 0;
  }
  if (args.sandbox) {
    const status = sandboxStatus();
    if (!status.available) {
      console.log(JSON.stringify({ ok: false, error: 'sandbox_missing', message: `OS のサンドボックスの道具が足りません（${status.missing.join('、')}）。入れるか、--no-sandbox で外してください。` }));
      return 2;
    }
  }
  const out = path.resolve(args.out ?? (fs.mkdirSync(defaultRunRoot(), { recursive: true }), fs.mkdtempSync(path.join(defaultRunRoot(), 'trigger-'))));
  fs.mkdirSync(out, { recursive: true });
  try {
    const converted = (deps.convert ?? convertPlugin)(REPO_ROOT, path.join(out, 'converted', 'creator')).root;
    const query = deps.query ?? (await loadQuery());
    const results = [];
    for (const testCase of cases) {
      const r = await runCase({ testCase, workspace: data.workspace ?? {}, query, converted, model: args.model, runDir: out, sandbox: args.sandbox });
      results.push(r);
      console.error(`[呼ばれ方] ${r.id}：${r.pass ? '期待どおり' : '期待と違う'}（期待 ${r.expect.length ? r.expect.join(' か ') : 'どれも呼ばない'}、呼んだもの ${r.got ?? 'なし'}）${r.error ? ` 止まった：${r.error}` : ''}`);
    }
    const summary = summarize(results);
    const reportFile = path.join(out, 'trigger-report.json');
    fs.writeFileSync(reportFile, `${JSON.stringify({ model: args.model, at: new Date().toISOString(), summary, results }, null, 2)}\n`);
    console.log(JSON.stringify({ ok: summary.ok, summary, reportFile }, null, 2));
    return summary.ok ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: 'failed', message: error.message, out }));
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main();
}
