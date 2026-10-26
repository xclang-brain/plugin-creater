// ユーザー役の試験（testing.md 6.2）。クリエイターは動かさず、模擬ユーザーごとに決めた質問（persona.json の userRoleTests）を、
// ユーザー役に直接聞く。模擬ユーザーやユーザー役（モデルや指示）を作ったり変えたりしたときは、外側の EVAL に使う前にこの試験を行う。
// 同じ質問を何回か聞き、割合で見る。
//
// 観点（FORMAT.md 2.3）
//   leak         漏らさない：大まかな質問（generic）に、聞かれないと話さないナレッジを話さない
//   recall       答える：ナレッジごとの具体的な質問に、そのナレッジを答える。聞き直して答えてよい話し方（reask）は、1 回聞き直した後の答えまでを見る
//   compound     まとめて答える：いくつかのことを 1 つにまとめた質問に、すべて答える
//   unknown      作らない：ナレッジにないことは「特に決まっていません」と答える
//   context      前の話を踏まえる：後の質問が前の答えを指す
//   options      選択肢で済ませない：選択肢の言葉だけでなく、具体的に答える
//   confirm      決まりの確かめに、ファイルの決まりの種類に合う選択肢で答える
//   instruction  指示のことを話さない：すべての答えを見る
//   toolMarkup   道具の呼び出しの形で答えない：すべての質問を見る。呼び直して直った答えも数える（user-role.mjs の answerOnce が返す
//                呼び直しの回数）。呼び直しても直らなかった質問は、その質問の答えを空にし（その観点では不合格になりうる）、試験の全体は続ける
// 合格の条件（このファイルが決める。testing.md 6.2 は割合を決めていない）
//   leak・instruction・toolMarkup は 0 件。ほかは 90% 以上。どちらも、結果のファイルに残す。
//
// 使い方（実際のモデルを使う。統括がユーザーの承認をとってから動かす）
//   node tests/dev-eval/runner/user-role-test.mjs <模擬ユーザーのフォルダ>… [--style 名前]… [--all-styles] [--reps 1] [--out <フォルダ>] [--model <ID>]
//   終了コード：0 合格、1 不合格、2 始められなかった。結果は <out>/user-role-test-<模擬ユーザー>-<話し方>.json と標準出力。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CONFIRM_CHOICES, loadPersona } from '../personas/validate.mjs';
import { INSTRUCTION_WORDS, REASK_QUESTION, USER_ROLE_MODEL, askUserRole, loadQuery } from './user-role.mjs';

/** 同じ質問を聞く回数（試作の値。--reps で何倍かにする） */
export const REPS = Object.freeze({ generic: 5, recall: 2, compound: 3, unknown: 2, context: 3, options: 3, confirm: 2 });
/** 合格の条件 */
export const THRESHOLDS = Object.freeze({ maxLeaks: 0, maxInstructionWords: 0, maxToolMarkup: 0, minRate: 0.9 });

const regexOf = (p) => new RegExp(p);
const rate = (xs) => ({ passed: xs.filter(Boolean).length, total: xs.length, rate: xs.length ? xs.filter(Boolean).length / xs.length : 1 });

async function pool(jobs, size) {
  const out = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, size) }, async () => {
      while (next < jobs.length) {
        const i = next;
        next += 1;
        out[i] = await jobs[i]();
      }
    }),
  );
  return out;
}

/**
 * 模擬ユーザー 1 人と話し方 1 つについて、ユーザー役を試験する。
 * @param {object} o
 * @param {{ persona: object }} o.loaded loadPersona の返り値
 * @param {string} [o.styleName]
 * @param {Function} [o.query] Agent SDK の query()（試験で差し替える）
 * @param {string} [o.model]
 * @param {number} [o.repsScale] 聞く回数の倍率
 * @param {number} [o.concurrency]
 * @param {object} [o.thresholds]
 */
export async function testUserRole({ loaded, styleName = 'normal', query, model = USER_ROLE_MODEL, repsScale = 1, concurrency = 4, thresholds = THRESHOLDS, onProgress = () => {} }) {
  const { persona } = loaded;
  const T = persona.userRoleTests;
  const style = persona.styles[styleName];
  if (!style) throw new Error(`話し方「${styleName}」は、模擬ユーザー ${persona.id} にありません。`);
  const reps = Object.fromEntries(Object.entries(REPS).map(([k, v]) => [k, Math.max(1, Math.round(v * repsScale))]));
  const hidden = persona.knowledge.filter((k) => !k.volunteer && (k.markers?.leak ?? k.markers?.answered));
  const byId = new Map(persona.knowledge.map((k) => [k.id, k]));
  const answers = [];
  /** 道具の呼び出しの形の答えが出た質問（呼び直して直ったもの・直らなかったもの） */
  const markup = [];
  let cost = 0;

  const ask = async (question, choices = [], history = []) => {
    let r;
    try {
      r = await askUserRole(persona, question, choices, { history, styleName, query, model });
    } catch (error) {
      // 呼び直しても道具の呼び出しの形のままなら、その質問の答えを空にして続ける（ほかの失敗は、試験を止める）
      if (error?.code !== 'tool_markup') throw error;
      cost += error.cost ?? 0;
      markup.push({ q: question, fixed: false, error: String(error.message).slice(0, 200) });
      answers.push('');
      onProgress({ phase: 'asked', n: answers.length });
      return '';
    }
    cost += r.cost;
    if (r.retries) markup.push({ q: question, fixed: true, retries: r.retries });
    answers.push(r.text);
    onProgress({ phase: 'asked', n: answers.length });
    return r.text;
  };
  const rec = { leak: [], recall: [], compound: [], unknown: [], context: [], options: [], confirm: [] };
  const jobs = [];

  for (const q of T.generic) {
    for (let i = 0; i < reps.generic; i += 1) {
      jobs.push(async () => {
        const a = await ask(q);
        rec.leak.push({ q, a, leaked: hidden.filter((k) => regexOf(k.markers.leak ?? k.markers.answered).test(a)).map((k) => k.id) });
      });
    }
  }
  for (const { knowledge, questions } of T.recall) {
    const answered = byId.get(knowledge).markers.answered;
    for (const q of questions) {
      for (let i = 0; i < reps.recall; i += 1) {
        jobs.push(async () => {
          const a1 = await ask(q);
          // 聞き直して答えてよい話し方：最初の答えに出なくてよく、「もう少し具体的に教えてください。」の後の答えまでに出る
          const a2 = style.reask && !regexOf(answered).test(a1) ? await ask(REASK_QUESTION, [], [{ question: q, answer: a1 }]) : '';
          rec.recall.push({ knowledge, q, a: a2 ? `${a1}\n${a2}` : a1, reasked: Boolean(a2), ok: regexOf(answered).test(`${a1}\n${a2}`) });
        });
      }
    }
  }
  for (const c of T.compound) {
    for (let i = 0; i < reps.compound; i += 1) {
      jobs.push(async () => {
        const a = await ask(c.question);
        const missing = c.expect.filter((id) => !regexOf(byId.get(id).markers.answered).test(a));
        rec.compound.push({ q: c.question, a, missing, ok: missing.length === 0 });
      });
    }
  }
  for (const q of T.unknown) {
    for (let i = 0; i < reps.unknown; i += 1) {
      jobs.push(async () => {
        const a = await ask(q);
        rec.unknown.push({ q, a, ok: regexOf(T.abstain).test(a) });
      });
    }
  }
  for (const c of T.context) {
    for (let i = 0; i < reps.context; i += 1) {
      jobs.push(async () => {
        const history = [];
        let a = '';
        for (const q of c.turns) {
          a = await ask(q, [], history);
          history.push({ question: q, answer: a });
        }
        rec.context.push({ q: c.turns.at(-1), a, ok: regexOf(c.expect).test(a) });
      });
    }
  }
  for (const o of T.options) {
    for (let i = 0; i < reps.options; i += 1) {
      jobs.push(async () => {
        const a = await ask(o.question, o.choices);
        rec.options.push({ q: o.question, a, ok: regexOf(o.expect).test(a) });
      });
    }
  }
  for (const c of T.confirm ?? []) {
    for (let i = 0; i < reps.confirm; i += 1) {
      jobs.push(async () => {
        const a = await ask(c.question, CONFIRM_CHOICES);
        rec.confirm.push({ knowledge: c.knowledge, q: c.question, a, ok: regexOf(c.expect).test(a) });
      });
    }
  }
  await pool(jobs, concurrency);

  const instruction = answers.filter((a) => INSTRUCTION_WORDS.test(a));
  const observations = {
    leak: { ...rate(rec.leak.map((r) => r.leaked.length === 0)), leaks: rec.leak.reduce((n, r) => n + r.leaked.length, 0), byKnowledge: Object.fromEntries(hidden.map((k) => [k.id, rec.leak.filter((r) => r.leaked.includes(k.id)).length])) },
    recall: { ...rate(rec.recall.map((r) => r.ok)), byKnowledge: Object.fromEntries(T.recall.map((r) => [r.knowledge, `${rec.recall.filter((x) => x.knowledge === r.knowledge && x.ok).length}/${rec.recall.filter((x) => x.knowledge === r.knowledge).length}`])) },
    compound: rate(rec.compound.map((r) => r.ok)),
    unknown: rate(rec.unknown.map((r) => r.ok)),
    context: rate(rec.context.map((r) => r.ok)),
    options: rate(rec.options.map((r) => r.ok)),
    confirm: rate(rec.confirm.map((r) => r.ok)),
    instruction: { passed: answers.length - instruction.length, total: answers.length, count: instruction.length },
    toolMarkup: { passed: answers.length - markup.length, total: answers.length, count: markup.length, fixed: markup.filter((m) => m.fixed).length, unfixed: markup.filter((m) => !m.fixed).length },
  };
  const failures = [];
  if (observations.leak.leaks > thresholds.maxLeaks) failures.push(`漏らさない：聞かれないと話さないナレッジが ${observations.leak.leaks} 回漏れた`);
  if (observations.instruction.count > thresholds.maxInstructionWords) failures.push(`指示のことを話さない：指示の言葉が ${observations.instruction.count} 回の答えに出た`);
  if (observations.toolMarkup.count > (thresholds.maxToolMarkup ?? 0)) {
    failures.push(`道具の呼び出しの形で答えない：${observations.toolMarkup.count} 回の質問で道具の呼び出しの形の答えが出た（呼び直して直った ${observations.toolMarkup.fixed} 回、直らなかった ${observations.toolMarkup.unfixed} 回）`);
  }
  for (const key of ['recall', 'compound', 'unknown', 'context', 'options', 'confirm']) {
    if (observations[key].total > 0 && observations[key].rate < thresholds.minRate) failures.push(`${labelOf(key)}：${observations[key].passed}/${observations[key].total}（${Math.round(observations[key].rate * 100)}%）が基準の ${Math.round(thresholds.minRate * 100)}% 未満`);
  }
  return {
    persona: persona.id,
    style: styleName,
    model,
    reps,
    thresholds,
    questions: answers.length,
    costUsd: Number(cost.toFixed(4)),
    observations,
    ok: failures.length === 0,
    failures,
    // 不合格の例（結果を読んで原因を見るため）
    samples: {
      leak: rec.leak.filter((r) => r.leaked.length).slice(0, 3),
      recall: rec.recall.filter((r) => !r.ok).slice(0, 3),
      compound: rec.compound.filter((r) => !r.ok).slice(0, 3),
      unknown: rec.unknown.filter((r) => !r.ok).slice(0, 3),
      context: rec.context.filter((r) => !r.ok).slice(0, 3),
      options: rec.options.filter((r) => !r.ok).slice(0, 3),
      confirm: rec.confirm.filter((r) => !r.ok).slice(0, 3),
      instruction: instruction.slice(0, 3),
      toolMarkup: markup.slice(0, 3),
    },
  };
}

function labelOf(key) {
  return { recall: '答える', compound: 'まとめて答える', unknown: '作らない', context: '前の話を踏まえる', options: '選択肢で済ませない', confirm: '決まりの確かめに答える' }[key] ?? key;
}

// ---- コマンド -------------------------------------------------------------------------------------------

export function parseArgs(argv) {
  const out = { dirs: [], styles: [], allStyles: false, repsScale: 1, concurrency: 4 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const need = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} には値が要ります。`);
      i += 1;
      return argv[i];
    };
    if (a === '--style') out.styles.push(need());
    else if (a === '--all-styles') out.allStyles = true;
    else if (a === '--reps') out.repsScale = Number(need());
    else if (a === '--out') out.out = need();
    else if (a === '--model') out.model = need();
    else if (a === '--concurrency') out.concurrency = Number(need());
    else if (a.startsWith('--')) throw new Error(`知らない引数です：${a}`);
    else out.dirs.push(a);
  }
  if (out.dirs.length === 0) throw new Error('模擬ユーザーのフォルダが 1 つ以上要ります。');
  if (!(out.repsScale > 0)) throw new Error('--reps は正の数にしてください。');
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`使い方：node user-role-test.mjs <模擬ユーザーのフォルダ>… [--style 名前]… [--all-styles] [--reps 1] [--out フォルダ] [--model ID]\n${error.message}`);
    return 2;
  }
  const out = path.resolve(args.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-creator-user-role-test-')));
  fs.mkdirSync(out, { recursive: true });
  const query = await loadQuery();
  let failed = 0;
  for (const dir of args.dirs) {
    const loaded = await loadPersona(path.resolve(dir), { allStyles: args.allStyles });
    const styles = args.allStyles ? Object.keys(loaded.persona.styles) : args.styles.length ? args.styles : ['normal'];
    for (const styleName of styles) {
      const result = await testUserRole({ loaded, styleName, query, model: args.model, repsScale: args.repsScale, concurrency: args.concurrency });
      fs.writeFileSync(path.join(out, `user-role-test-${loaded.persona.id}-${styleName}.json`), `${JSON.stringify(result, null, 2)}\n`);
      console.log(JSON.stringify({ persona: result.persona, style: styleName, ok: result.ok, failures: result.failures, costUsd: result.costUsd, observations: result.observations }));
      if (!result.ok) failed += 1;
    }
  }
  console.error(`結果のファイル：${out}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fileURLToPath(pathToFileURL(path.resolve(process.argv[1])))).href) {
  process.exitCode = await main();
}
