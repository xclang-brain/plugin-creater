// ユーザー役の試験（user-role-test.mjs）の試験。試験が「落ちるべきときに落ちる」ことを、偽物のユーザー役で確かめる。実際のモデルは使わない。
// 動かし方（リポジトリの根で）：node --test "tests/dev-eval/runner/*.test.mjs"

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CONFIRM_CHOICES, loadPersona } from '../personas/validate.mjs';
import { createFakeSdk } from './outer-fake-sdk.mjs';
import { MARKUP_RETRY_NOTE, REASK_QUESTION } from './user-role.mjs';
import { REPS, THRESHOLDS, parseArgs, testUserRole } from './user-role-test.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PERSONAS = path.join(here, '..', 'personas');
const loadedWeekly = await loadPersona(path.join(PERSONAS, 'weekly-report'), { allStyles: true });
const loadedTraining = await loadPersona(path.join(PERSONAS, 'training-survey'));

const questionOf = (prompt) => /AI からの質問：([^\n]*)/.exec(prompt)?.[1] ?? '';
const choicesOf = (prompt) => (prompt.match(/^- .*$/gm) ?? []).map((l) => l.slice(2).replace(/（.*$/, ''));

/**
 * 模擬ユーザーの定義どおりに答える、偽物のユーザー役（正しいユーザー役の見本）。
 * 話題が asked に当たれば、そのナレッジを答える。決まりの確かめには、選択肢を選んで中身を足す。当たらなければ「特に決まっていません」。
 */
function oracle(persona, { styleName = 'normal', vagueFirst = false } = {}) {
  return ({ prompt }) => {
    const q = questionOf(prompt);
    const choices = choicesOf(prompt);
    const isConfirm = CONFIRM_CHOICES.every((c) => prompt.includes(c.replace(/（.*$/, '')));
    if (q === REASK_QUESTION) return persona.knowledge.filter((k) => k.volunteer).map((k) => k.fact).join(' ');
    let hit = persona.knowledge.filter((k) => new RegExp(k.markers.asked).test(q));
    if (hit.length === 0) {
      // 前の話を指す質問：直前の質問の話題で答える
      const previous = [...prompt.matchAll(/^AI：(.*)$/gm)].at(-1)?.[1];
      if (previous) hit = persona.knowledge.filter((k) => new RegExp(k.markers.asked).test(previous));
    }
    if (hit.length === 0) return '特に決まっていません';
    if (vagueFirst && persona.styles[styleName]?.reask && !prompt.includes('これまでのやり取り')) return 'うーん、普通の書き方です';
    if (isConfirm) {
      const k = hit.find((x) => x.file && q.includes(x.file.evidence)) ?? hit.find((x) => x.file) ?? hit[0];
      const choice = CONFIRM_CHOICES.find((c) => c.startsWith(k.file?.answer ?? '')) ?? choices[0];
      return `${choice}。${k.file?.detail ?? k.fact}`;
    }
    return hit.map((k) => k.fact).join(' ');
  };
}

const run = (loaded, userRole, o = {}) => testUserRole({ loaded, query: createFakeSdk({ userRole }).query, concurrency: 8, ...o });

test('REQ-015 ユーザー役の試験：模擬ユーザーの定義どおりに答える見本は、すべての観点に合格する', async () => {
  const result = await run(loadedWeekly, oracle(loadedWeekly.persona));
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  const o = result.observations;
  assert.equal(o.leak.leaks, 0);
  assert.equal(o.leak.total, loadedWeekly.persona.userRoleTests.generic.length * REPS.generic);
  assert.equal(o.recall.rate, 1);
  assert.equal(o.compound.rate, 1);
  assert.equal(o.unknown.rate, 1);
  assert.equal(o.context.rate, 1);
  assert.equal(o.options.rate, 1);
  assert.equal(o.confirm.rate, 1);
  assert.equal(o.instruction.count, 0);
  // 観点ごとの回数は、模擬ユーザーの質問の数 × 回数
  assert.equal(o.confirm.total, loadedWeekly.persona.userRoleTests.confirm.length * REPS.confirm);
  assert.equal(result.model, 'claude-sonnet-5-5');
  assert.deepEqual(result.thresholds, THRESHOLDS);
});

test('REQ-015 ユーザー役の試験：大まかな質問に、聞かれないと話さないナレッジを話すユーザー役は、漏らさない観点で落ちる', async () => {
  const good = oracle(loadedWeekly.persona);
  const leaky = (req) => (questionOf(req.prompt) === loadedWeekly.persona.userRoleTests.generic[0] ? '週報の最後の行は必ず「以上」にします' : good(req));
  const result = await run(loadedWeekly, leaky);
  assert.equal(result.ok, false);
  assert.ok(result.observations.leak.leaks >= REPS.generic);
  assert.equal(result.observations.leak.byKnowledge.ijou >= REPS.generic, true);
  assert.match(result.failures.join('\n'), /漏らさない/);
  assert.ok(result.samples.leak.length > 0);
});

test('REQ-015 ユーザー役の試験：ナレッジにない質問に決まりを作るユーザー役は、作らない観点で落ちる', async () => {
  const good = oracle(loadedWeekly.persona);
  const inventor = (req) => (loadedWeekly.persona.userRoleTests.unknown.includes(questionOf(req.prompt)) ? '前週比も必ず書きます' : good(req));
  const result = await run(loadedWeekly, inventor);
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /作らない/);
});

test('REQ-015 ユーザー役の試験：選択肢の言葉だけで答えるユーザー役は、選択肢で済ませない観点で落ちる', async () => {
  const good = oracle(loadedWeekly.persona);
  const optionOnly = (req) => (questionOf(req.prompt).includes('成果物の形式') ? 'Markdown' : good(req));
  const result = await run(loadedWeekly, optionOnly);
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /選択肢で済ませない/);
});

test('REQ-015 ユーザー役の試験：決まりの確かめに、選択肢の言葉だけ・別の選択肢で答えるユーザー役は落ちる', async () => {
  const good = oracle(loadedWeekly.persona);
  const wrongChoice = (req) => (questionOf(req.prompt).includes('万円にして端数') ? 'このとおり' : good(req));
  const result = await run(loadedWeekly, wrongChoice);
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /決まりの確かめに答える/);
});

test('REQ-015 ユーザー役の試験：前の話を踏まえない・まとめて答えないユーザー役は落ちる', async () => {
  const good = oracle(loadedWeekly.persona);
  const noContext = (req) => (questionOf(req.prompt).startsWith('その2つ以外') ? '分かりません' : good(req));
  assert.match((await run(loadedWeekly, noContext)).failures.join('\n'), /前の話を踏まえる/);
  const noCompound = (req) => (questionOf(req.prompt).includes('社内のルール') ? '特に決まっていません' : good(req));
  assert.match((await run(loadedWeekly, noCompound)).failures.join('\n'), /まとめて答える/);
});

test('REQ-015 ユーザー役の試験：自分への指示のことを話すユーザー役は、指示のことを話さない観点で落ちる', async () => {
  const good = oracle(loadedWeekly.persona);
  const talker = (req) => `答える条件に当てはまるので答えます。${good(req)}`;
  const result = await run(loadedWeekly, talker);
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /指示のことを話さない/);
  assert.ok(result.observations.instruction.count > 0);
  assert.ok(result.samples.instruction.length > 0);
});

test('REQ-015 話し方 vague：最初はあいまいに答え、聞き直した後の答えに出ればよい。聞き直さない話し方では、最初の答えに出なければ不合格', async () => {
  const vagueOracle = oracle(loadedWeekly.persona, { styleName: 'vague', vagueFirst: true });
  // 聞き直しの答えに、ナレッジを足す見本（REASK_QUESTION のとき、直前の質問の話題のナレッジを答える）
  const withReask = (req) => {
    if (questionOf(req.prompt) === REASK_QUESTION) {
      const lastQ = /AI：([^\n]*)\nあなた：/.exec(req.prompt)?.[1] ?? '';
      return loadedWeekly.persona.knowledge.filter((k) => new RegExp(k.markers.asked).test(lastQ)).map((k) => k.fact).join(' ') || '特に決まっていません';
    }
    return vagueOracle(req);
  };
  const ok = await run(loadedWeekly, withReask, { styleName: 'vague' });
  assert.equal(ok.observations.recall.rate, 1, JSON.stringify(ok.samples.recall));
  // 聞き直しても答えない（試作で 2 回中 1 回あった、ユーザー役の誤り）
  const stubborn = (req) => (questionOf(req.prompt) === REASK_QUESTION ? 'うーん、特にないです' : vagueOracle(req));
  const bad = await run(loadedWeekly, stubborn, { styleName: 'vague' });
  assert.equal(bad.ok, false);
  assert.match(bad.failures.join('\n'), /答える/);
  // 聞き直さない話し方（normal）で、最初にあいまいに答えれば不合格
  const normalVague = (req) => (loadedWeekly.persona.userRoleTests.recall[0].questions.includes(questionOf(req.prompt)) ? 'うーん、普通です' : oracle(loadedWeekly.persona)(req));
  assert.equal((await run(loadedWeekly, normalVague)).observations.recall.rate < 1, true);
});

test('REQ-016 まだやったことのない作業の模擬ユーザーでも試験できる（確かめの質問がないので confirm は 0 件）', async () => {
  const result = await run(loadedTraining, oracle(loadedTraining.persona));
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.observations.confirm.total, 0);
});

test('REQ-015 回数の倍率：--reps で聞く回数が変わり、観点ごとの質問の数に比例する', async () => {
  const one = await run(loadedWeekly, oracle(loadedWeekly.persona));
  const two = await run(loadedWeekly, oracle(loadedWeekly.persona), { repsScale: 2 });
  assert.equal(two.questions, one.questions * 2);
  assert.equal(two.reps.generic, REPS.generic * 2);
});

test('REQ-015 コマンドの引数：模擬ユーザーのフォルダ・話し方・回数・出力先を読む。足りないと断る', () => {
  const a = parseArgs(['p/a', 'p/b', '--style', 'terse', '--style', 'hurry', '--reps', '2', '--out', '/tmp/x', '--model', 'claude-sonnet-5-5']);
  assert.deepEqual(a.dirs, ['p/a', 'p/b']);
  assert.deepEqual(a.styles, ['terse', 'hurry']);
  assert.equal(a.repsScale, 2);
  assert.equal(a.out, '/tmp/x');
  assert.equal(parseArgs(['p/a', '--all-styles']).allStyles, true);
  assert.throws(() => parseArgs([]), /模擬ユーザーのフォルダ/);
  assert.throws(() => parseArgs(['p', '--reps']), /値が要ります/);
  assert.throws(() => parseArgs(['p', '--wat']), /知らない引数/);
});

test('REQ-015 ユーザー役の試験：道具の呼び出しの形で答えるユーザー役は、呼び直して直っても落ちる。直らない質問は、その質問だけ答えを空にして試験を続ける', async () => {
  const LT = '<';
  const markupAnswer = `${LT}invoke name="Read">\n${LT}parameter name="file_path">週報.docx${LT}/parameter>\n${LT}/invoke>`;
  const good = oracle(loadedWeekly.persona);
  const target = loadedWeekly.persona.userRoleTests.unknown[0];
  // 1回目だけ道具の呼び出しの形（呼び直しで直る）
  const seen = new Map();
  const once = (req) => {
    const q = questionOf(req.prompt);
    if (q !== target) return good(req);
    seen.set(req.prompt, (seen.get(req.prompt) ?? 0) + 1);
    return req.prompt.endsWith(MARKUP_RETRY_NOTE) ? good(req) : markupAnswer;
  };
  const fixed = await run(loadedWeekly, once);
  assert.equal(fixed.ok, false);
  assert.equal(fixed.observations.toolMarkup.count, REPS.unknown);
  assert.equal(fixed.observations.toolMarkup.fixed, REPS.unknown);
  assert.equal(fixed.observations.unknown.rate, 1, '直った答えで、その観点は見る');
  assert.match(fixed.failures.join('\n'), /道具の呼び出しの形で答えない/);
  assert.equal(fixed.samples.toolMarkup[0].q, target);
  // ずっと道具の呼び出しの形（直らない）：全体は落ちずに結果を返し、その質問は空の答えとして不合格になる
  const always = (req) => (questionOf(req.prompt) === target ? markupAnswer : good(req));
  const broken = await run(loadedWeekly, always);
  assert.equal(broken.ok, false);
  assert.equal(broken.observations.toolMarkup.unfixed, REPS.unknown);
  assert.ok(broken.observations.unknown.rate < 1);
  assert.equal(broken.questions, fixed.questions, '直らなかった質問も、聞いた数に入る');
  // 見本のユーザー役では 0 件
  assert.equal((await run(loadedWeekly, good)).observations.toolMarkup.count, 0);
});

test('REQ-015 ユーザー役の試験：まとめた質問で、言わないはずのナレッジ（forbid）を話すユーザー役は、まとめて答える観点で落ちる', async () => {
  const loadedChange = await loadPersona(path.join(PERSONAS, 'edl-change'));
  const persona = loadedChange.persona;
  const stumble = persona.userRoleTests.compound.find((c) => (c.forbid ?? []).length > 0);
  assert.ok(stumble, 'edl-change に forbid のあるまとめた質問がある');
  const byId = new Map(persona.knowledge.map((k) => [k.id, k]));
  const good = oracle(persona);
  const allowed = stumble.expect.map((id) => byId.get(id).fact).join(' ');
  const goodRole = (req) => (questionOf(req.prompt) === stumble.question ? allowed : good(req));
  const leakyRole = (req) => (questionOf(req.prompt) === stumble.question ? `${allowed} ${byId.get(stumble.forbid[0]).fact}` : good(req));
  const ok = await run(loadedChange, goodRole);
  assert.equal(ok.observations.compound.rate, 1, JSON.stringify(ok.failures));
  const bad = await run(loadedChange, leakyRole);
  assert.ok(bad.observations.compound.rate < 1);
  assert.match(bad.failures.join('\n'), /まとめて答える/);
});
