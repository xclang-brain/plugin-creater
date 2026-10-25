// 外側の EVAL から、内側の EVAL（inner.mjs。D1d）を呼ぶ。できた生成プラグインを置き換え、模擬ユーザーの内側の課題
// （<模擬ユーザー>/inner/eval.json）で、プラグインあり・なしを動かして採点する（testing.md 3章の手順4、7章）。
// 実際のモデルと画面のブラウザー（Playwright）を使う。試験では outer-run.mjs の引数 inner に関数を渡して差し替える。
// 開発者が答えた外側の EVAL（answerer が human。testing.md 6.7）では、模擬ユーザーの課題がないので、生成プラグインに入った課題と
// 合否の基準（tests/eval/<課題>/eval.json）で動かす。エージェントの問いと画面の設定の欄には、決まった返事（FIXED_ANSWER）を返し、
// 開発者には聞かない（ユーザーの試験の 10.4 と同じ。プラグインなしのときに、開発者のナレッジが伝わらないように）。画面の設定は、
// 課題の settings.task の値を入れ、ない欄は初めの値のまま（inner-settings.mjs の decideSettings）。課題がなければ、動かさずに理由を返す。

import fs from 'node:fs';
import path from 'node:path';

import { FIXED_ANSWER } from '../../../skills/test-plugin/scripts/permissions.mjs';
import { loadTasks } from '../../../skills/test-plugin/scripts/tasks.mjs';
import { createUserRole } from './user-role.mjs';

/** 開発者が答えたときの、内側の EVAL のユーザー役：何を聞かれても決まった返事を返す。費用はかからない */
export function fixedAnswerRole() {
  const fn = async () => FIXED_ANSWER;
  fn.cost = () => 0;
  return fn;
}

/**
 * @param {object} o
 * @param {string} o.pluginDir できた生成プラグイン（Copilot CLI 向け）
 * @param {{ persona: object, dir: string }} o.loaded 模擬ユーザー
 * @param {string} o.styleName
 * @param {Function} o.query Agent SDK の query()
 * @param {Function} [o.userRoleQuery]
 * @param {string} o.outDir
 * @param {boolean} o.sandbox
 * @param {Function} o.convert 置き換える関数（convertPlugin）
 * @param {number} [o.runs]
 * @param {Function} [o.innerEval] inner.mjs の innerEval（試験で差し替える）
 * @param {object} [o.chromium] Playwright の chromium（試験で差し替える）
 * @param {'user-role'|'human'} [o.answerer] human なら、生成プラグインの課題と決まった返事で動かす（上の説明）
 */
export async function runInnerForGenerated(o) {
  const { pluginDir, loaded, styleName, query, userRoleQuery = query, outDir, sandbox, convert, envExtra = {}, signal, onProgress = () => {}, runs = 1 } = o;
  if (o.answerer === 'human') return runInnerWithPluginTasks(o);
  const innerEval = o.innerEval ?? (await import('./inner.mjs')).innerEval;
  const chromium = o.chromium ?? (await import('playwright')).chromium;
  fs.mkdirSync(outDir, { recursive: true });
  const convertedRoot = path.join(outDir, 'converted');
  convert(pluginDir, convertedRoot);
  const evalDir = path.join(loaded.dir, 'inner');
  const json = JSON.parse(fs.readFileSync(path.join(evalDir, 'eval.json'), 'utf8'));
  const task = { id: json.id, dir: evalDir, json, personaId: loaded.persona.id };
  const userRoleFor = (_task, arm, n) => {
    const home = fs.mkdtempSync(path.join(outDir, `user-${arm}-${n}-`));
    const role = createUserRole({ persona: loaded.persona, styleName, query: userRoleQuery, home, envExtra });
    const fn = async ({ question, choices }) => (await role.answer(question, choices ?? [], (choices ?? []).length > 0 ? 'AskUserQuestion' : 'text')).answer;
    fn.cost = () => role.cost;
    return fn;
  };
  return innerEval({
    sdk: { query },
    chromium,
    pluginRoot: pluginDir,
    convertedRoot,
    tasks: [task],
    userRoleFor,
    outDir,
    runs,
    arms: ['with', 'without'],
    sandbox,
    envExtra,
    signal,
    onProgress: (p) => onProgress({ ...p, phase: `inner-${p.phase}` }),
  });
}

/** 開発者が答えたとき：生成プラグインの課題で、決まった返事で動かす。課題がなければ、動かさずに理由と課題の誤りを返す */
async function runInnerWithPluginTasks(o) {
  const { pluginDir, query, outDir, sandbox, convert, envExtra = {}, signal, onProgress = () => {}, runs = 1 } = o;
  const { tasks, problems } = loadTasks(pluginDir);
  if (tasks.length === 0) {
    return { kind: 'dev-inner-eval', status: 'skipped', reason: '生成プラグインに、動かせる課題（tests/eval/<課題>/eval.json）がない', taskProblems: problems, scores: null };
  }
  const innerEval = o.innerEval ?? (await import('./inner.mjs')).innerEval;
  const chromium = o.chromium ?? (await import('playwright')).chromium;
  fs.mkdirSync(outDir, { recursive: true });
  const convertedRoot = path.join(outDir, 'converted');
  convert(pluginDir, convertedRoot);
  const record = await innerEval({
    sdk: { query },
    chromium,
    pluginRoot: pluginDir,
    convertedRoot,
    tasks: tasks.map((t) => ({ ...t, personaId: null })),
    userRoleFor: () => fixedAnswerRole(),
    outDir,
    runs,
    arms: ['with', 'without'],
    sandbox,
    envExtra,
    signal,
    onProgress: (p) => onProgress({ ...p, phase: `inner-${p.phase}` }),
  });
  // 読めなかった課題があれば、動かした課題と別に残す（黙って落とさない）
  if (problems.length) record.taskProblems = problems;
  return record;
}
