// 外側の EVAL の入口（outer.mjs）の試験。実際のモデルは使わない（偽物の Agent SDK）。
// 見ない模擬ユーザーの置き場所（tests/dev-eval/heldout/）は、この試験でも読まない。一時フォルダに作った写しで、読み込みの仕組みだけを試す。
// 動かし方（リポジトリの根で）：node --test "tests/dev-eval/runner/*.test.mjs"

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadPersona } from '../personas/validate.mjs';
import {
  CONTROL_DIR,
  HELDOUT_DIR,
  OuterEvalError,
  aggregateCounts,
  discoverPersonaDirs,
  estimateUsd,
  evaluateControl,
  loadPersonas,
  main,
  parseArgs,
  planRuns,
  runPlan,
  summarizeAll,
  summarizeRecord,
} from './outer.mjs';
import { createFakeSdk } from './outer-fake-sdk.mjs';
import { USER_ROLE_FAILED } from './outer-run.mjs';
import { diskOk, tempDir } from './temp-dirs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PERSONAS = path.join(here, '..', 'personas');
const REPO = path.resolve(here, '..', '..', '..');
const tmp = (prefix) => tempDir(`outer-cli-${prefix}`);
const weekly = await loadPersona(path.join(PERSONAS, 'weekly-report'), { allStyles: true });
const training = await loadPersona(path.join(PERSONAS, 'training-survey'));

function fakeConvert(src, out) {
  fs.mkdirSync(path.join(out, '.eval'), { recursive: true });
  const report = { plugin: path.basename(src), model_map: { 'claude-opus-5.5': 'claude-opus-5-5' }, extension_tools: [], warnings: [] };
  fs.writeFileSync(path.join(out, '.eval', 'conversion-report.json'), JSON.stringify(report));
  return { root: out, report };
}

test('REQ-015 引数：模擬ユーザー・話し方・腕・モデル・回数を読む。モデルは別名でなく ID だけ', () => {
  const a = parseArgs(['--persona', 'p/a', '--persona', 'p/b', '--style', 'terse', '--arms', 'with,control,without', '--models', 'claude-opus-5-5,claude-haiku-5-5', '--runs', '2', '--inner', '--no-sandbox', '--dry-run', '--max-exchanges', '50', '--timeout-minutes', '30']);
  assert.deepEqual(a.personas, ['p/a', 'p/b']);
  assert.deepEqual(a.arms, ['with', 'control', 'without']);
  assert.deepEqual(a.models, ['claude-opus-5-5', 'claude-haiku-5-5']);
  assert.equal(a.runs, 2);
  assert.equal(a.sandbox, false);
  assert.equal(a.inner, true);
  assert.equal(a.timeoutMs, 30 * 60_000);
  assert.deepEqual(parseArgs(['--persona', 'p']).models, ['claude-opus-5-5'], '既定は思考力の高いモデル');
  assert.equal(parseArgs(['--persona', 'p']).sandbox, true, '既定はサンドボックスあり');
  assert.throws(() => parseArgs([]), /--persona/);
  assert.equal(parseArgs(['--heldout']).heldout, true);
  assert.throws(() => parseArgs(['--persona', 'p', '--models', 'opus']), /ID/);
  assert.throws(() => parseArgs(['--persona', 'p', '--arms', 'both']), /--arms/);
  assert.throws(() => parseArgs(['--persona', 'p', '--runs', '0']), /--runs/);
  assert.throws(() => parseArgs(['--persona', 'p', '--wat']), OuterEvalError);
});

test('REQ-015 引数（開発者が答える形。testing.md 6.7）：--human・--request-file・--relay・--file・--inner-runs を読み、使えない引数を断る', () => {
  const a = parseArgs(['--human', '--request-file', 'req.txt', '--relay', 'r', '--file', 'a/週報.docx', '--file', 'b/memo.txt=資料/メモ.txt', '--inner', '--inner-runs', '2', '--models', 'claude-haiku-5-5', '--arms', 'with', '--runs', '1', '--dry-run']);
  assert.equal(a.human, true);
  assert.equal(a.requestFile, 'req.txt');
  assert.equal(a.relay, 'r');
  assert.deepEqual(a.files, [{ src: 'a/週報.docx', place: '週報.docx' }, { src: 'b/memo.txt', place: '資料/メモ.txt' }]);
  assert.equal(a.innerRuns, 2);
  assert.deepEqual(a.models, ['claude-haiku-5-5']);
  assert.deepEqual(a.personas, [], '模擬ユーザーなしで通る');
  assert.equal(parseArgs(['--human', '--request-file', 'q']).human, true);
  assert.equal(parseArgs(['--human', '--request-file', 'q', '--file', 'x\\y.txt=dir\\y.txt']).files[0].place, 'dir/y.txt');
  // 使えない引数
  const human = ['--human', '--request-file', 'q'];
  assert.throws(() => parseArgs(['--human']), /--request-file/);
  for (const extra of [['--persona', 'p'], ['--heldout'], ['--style', 'normal'], ['--all-styles'], ['--user-model', 'claude-sonnet-5-5']]) {
    assert.throws(() => parseArgs([...human, ...extra]), new RegExp(`--human では ${extra[0]} は使えません`), extra.join(' '));
  }
  assert.throws(() => parseArgs([...human, '--arms', 'with,without']), /--arms は with だけ/);
  assert.throws(() => parseArgs([...human, '--arms', 'control']), /--arms は with だけ/);
  assert.throws(() => parseArgs([...human, '--runs', '2']), /--runs は 1 だけ/);
  assert.throws(() => parseArgs([...human, '--models', 'claude-opus-5-5,claude-haiku-5-5']), /--models は 1 つだけ/);
  assert.throws(() => parseArgs([...human, '--models', 'opus']), /ID/);
  assert.throws(() => parseArgs([...human, '--max-exchanges', '0']), /--max-exchanges/);
  assert.throws(() => parseArgs([...human, '--inner-runs', '0']), /--inner-runs/);
  // ファイルの置き場所は、作業フォルダの中の相対の場所
  assert.throws(() => parseArgs([...human, '--file', 'a.txt=/etc/a.txt']), /絶対の場所/);
  assert.throws(() => parseArgs([...human, '--file', 'a.txt=C:\\a.txt']), /絶対の場所/);
  assert.throws(() => parseArgs([...human, '--file', 'a.txt=../a.txt']), /「\.\.」/);
  assert.throws(() => parseArgs([...human, '--file', 'a.txt=x/../../a.txt']), /「\.\.」/);
  assert.throws(() => parseArgs([...human, '--file', 'a.txt=']), /置き場所が空/);
  assert.throws(() => parseArgs([...human, '--file', 'a.txt=.']), /置き場所が空/, '「.」は作業フォルダそのものを指す');
  assert.throws(() => parseArgs([...human, '--file', 'a.txt=./.']), /置き場所が空/);
  assert.throws(() => parseArgs([...human, '--file', 'a.txt=dir/']), /置き場所が空/);
  assert.equal(parseArgs([...human, '--file', 'a.txt=./dir//a.txt']).files[0].place, 'dir/a.txt');
  assert.throws(() => parseArgs([...human, '--file', 'a.txt', '--file', 'b/a.txt']), /重なって/);
  // --human のときだけの引数
  assert.throws(() => parseArgs(['--persona', 'p', '--request-file', 'q']), /--human/);
  assert.throws(() => parseArgs(['--persona', 'p', '--relay', 'r']), /--human/);
  assert.throws(() => parseArgs(['--persona', 'p', '--file', 'a.txt']), /--human/);
  // 内側の EVAL の回数は、模擬ユーザーでも使える。既定はない（runOuterOnce の既定の 1 回）
  assert.equal(parseArgs(['--persona', 'p', '--inner-runs', '3']).innerRuns, 3);
  assert.equal(parseArgs(['--persona', 'p']).innerRuns, undefined);
  assert.equal(parseArgs(['--persona', 'p']).human, false);
});

test('REQ-015 計画：模擬ユーザー × 話し方 × 腕 × モデル × 回数。対照とプラグインなしは最初のモデルだけ', async () => {
  const personas = await loadPersonas({ dirs: [path.join(PERSONAS, 'weekly-report'), path.join(PERSONAS, 'training-survey')], heldout: false });
  const plan = planRuns({ personas, styles: ['normal', 'hurry'].slice(0, 1), arms: ['with', 'control', 'without'], models: ['claude-opus-5-5', 'claude-haiku-5-5'], runs: 2, inner: true });
  // 2 人 × (with: 2 モデル + control: 1 + without: 1) × 2 回
  assert.equal(plan.length, 2 * (2 + 1 + 1) * 2);
  assert.ok(plan.filter((p) => p.arm === 'control').every((p) => p.model === 'claude-opus-5-5'));
  assert.ok(plan.filter((p) => p.arm === 'with').every((p) => p.inner === true));
  assert.ok(plan.filter((p) => p.arm !== 'with').every((p) => p.inner === false));
  const all = planRuns({ personas: [personas[0]], allStyles: true, arms: ['with'], models: ['claude-opus-5-5'], runs: 1 });
  assert.deepEqual(all.map((p) => p.style), ['normal', 'terse', 'vague', 'dont-know', 'nothing-special', 'hurry']);
  assert.throws(() => planRuns({ personas: [personas[1]], styles: ['hurry'], arms: ['with'], models: ['claude-opus-5-5'], runs: 1 }), /話し方「hurry」/);
  assert.ok(estimateUsd(plan) > 0);
  // 作る流れの外側は実測の約7ドル、内側の EVAL を足すと約2ドル増える（testing.md 8.1）
  assert.equal(estimateUsd(planRuns({ personas: [personas[0]], arms: ['with'], models: ['claude-opus-5-5'], runs: 1, inner: false })), 7);
  assert.equal(estimateUsd(planRuns({ personas: [personas[0]], arms: ['with'], models: ['claude-opus-5-5'], runs: 1, inner: true })), 9);
  // 改善の模擬ユーザーは約15ドル（推定）
  assert.equal(estimateUsd([{ persona: 'x', kind: 'change', arm: 'with', inner: false }, { persona: 'x', kind: 'change', arm: 'with', inner: true }]), 15 + 17);
  assert.ok(plan.every((p) => p.kind === 'create'));
});

test('REQ-015 見ない模擬ユーザー：実行のときに、置き場所から読み込む。置き場所の既定は tests/dev-eval/heldout/（この試験は中身を読まない）', async () => {
  assert.ok(HELDOUT_DIR.split(path.sep).join('/').endsWith('tests/dev-eval/heldout'));
  assert.ok(CONTROL_DIR.split(path.sep).join('/').endsWith('tests/dev-eval/control-creator'));
  // 一時フォルダに作った写しで、読み込みの仕組みを試す
  const fake = tmp('heldout');
  fs.cpSync(path.join(PERSONAS, 'training-survey'), path.join(fake, 'training-survey'), { recursive: true });
  fs.mkdirSync(path.join(fake, 'not-a-persona'));
  assert.deepEqual(discoverPersonaDirs(fake).map((d) => path.basename(d)), ['training-survey']);
  assert.deepEqual(discoverPersonaDirs(path.join(fake, 'ない')), []);
  const loaded = await loadPersonas({ dirs: [path.join(PERSONAS, 'weekly-report')], heldout: true, heldoutDir: fake });
  assert.deepEqual(loaded.map((p) => [p.loaded.persona.id, p.heldout]), [['weekly-report', false], ['training-survey', true]]);
  // 見つからなければ、断る
  await assert.rejects(() => loadPersonas({ dirs: [], heldout: true, heldoutDir: path.join(fake, 'ない') }), /見ない模擬ユーザーが見つかりません/);
  // id が重なれば断る
  await assert.rejects(() => loadPersonas({ dirs: [path.join(PERSONAS, 'training-survey')], heldout: true, heldoutDir: fake }), /id が重なっています/);
  // 形が決まりに合わない見ない模擬ユーザーは、断る
  fs.writeFileSync(path.join(fake, 'training-survey', 'persona.json'), '{"id":"training-survey"}');
  await assert.rejects(() => loadPersonas({ dirs: [], heldout: true, heldoutDir: fake }), /形が決まりに合わない/);
  fs.rmSync(fake, { recursive: true, force: true });
});

/** 偽物の Agent SDK で、1 回の実行を作る（外側の EVAL の流れの全体を通す） */
async function makeRecord({ loaded, arm = 'with', embedded = false, heldout = false }) {
  const { runOuterOnce } = await import('./outer-run.mjs');
  const runRoot = tmp('rec');
  const sdk = createFakeSdk({ userRole: () => '特に決まっていません', agent: async () => '終わり' });
  const record = await runOuterOnce({ loaded, arm, runRoot, sandbox: false, query: sdk.query, convert: fakeConvert, maxExchanges: 1, runStages: async () => ({ skipped: true, reason: 'x' }) });
  record.heldout = heldout;
  if (embedded) for (const t of record.grading.trace) if (!t.volunteer) t.embedded = true;
  fs.rmSync(runRoot, { recursive: true, force: true });
  return record;
}

test('REQ-015 見ない模擬ユーザーの要約は、模擬ユーザーの名前とナレッジの名前を伏せる。ふつうの模擬ユーザーは、そのまま出す', async () => {
  const record = await makeRecord({ loaded: weekly });
  const open = summarizeRecord(record);
  assert.equal(open.persona, 'weekly-report');
  assert.ok(open.failed.some((id) => id === 'embedded:headings'));
  assert.ok(open.trace.some((t) => t.id === 'headings'));
  const redacted = summarizeRecord(record, { heldout: true });
  assert.equal(redacted.persona, '(見ない模擬ユーザー)');
  assert.ok(!JSON.stringify(redacted).includes('headings'));
  assert.ok(!JSON.stringify(redacted).includes('weekly'));
  assert.ok(redacted.failed.some((id) => /^embedded:#\d+$/.test(id)));
  assert.equal(redacted.trace, undefined);
  assert.equal(redacted.exampleCandidate, false, '見ない模擬ユーザーの会話は、会話例にしない');
  assert.equal(typeof redacted.faults, 'number');
});

test('REQ-015 対照のクリエイターの確かめ：聞かれないと話さないナレッジが組み込まれていなければ ok。組み込まれていれば、試験を疑う', async () => {
  const control = await makeRecord({ loaded: weekly, arm: 'control' });
  assert.deepEqual(evaluateControl([control]), { ok: true, runs: 1, problems: [] });
  const bad = await makeRecord({ loaded: weekly, arm: 'control', embedded: true });
  const r = evaluateControl([bad]);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /対照のクリエイターが、聞かれないと話さないナレッジ headings を組み込んだ/);
  const hidden = await makeRecord({ loaded: weekly, arm: 'control', embedded: true, heldout: true });
  const rh = evaluateControl([hidden]);
  assert.ok(!rh.problems.join('').includes('headings') && !rh.problems.join('').includes('weekly-report'), '見ない模擬ユーザーの名前を出さない');
  assert.equal(evaluateControl([await makeRecord({ loaded: weekly })]), null, '対照がなければ確かめない');
});

test('REQ-015 計画どおりに動かし、実行が終わるたびに結果のファイルを書く。あり・なしの差と対照の確かめが要約に入る', async () => {
  const outDir = tmp('plan');
  const personas = [{ loaded: weekly, heldout: false }];
  const plan = planRuns({ personas, arms: ['with', 'control', 'without'], models: ['claude-opus-5-5'], runs: 1 });
  const personaById = new Map(personas.map((p) => [p.loaded.persona.id, p]));
  const converted = fakeConvert(CONTROL_DIR, path.join(outDir, 'converted', 'c')).root;
  const sdk = createFakeSdk({ userRole: () => '特に決まっていません', agent: async () => '終わり' });
  const seen = [];
  const report = await runPlan({
    plan, personaById, outDir, creatorRoot: REPO, controlRoot: '/dummy-control', convertedCreator: converted, convertedControl: converted, diskCheck: diskOk,
    common: { query: sdk.query, sandbox: false, convert: fakeConvert, maxExchanges: 1, runStages: async () => ({ skipped: true, reason: 'x' }) },
    onProgress: (p) => seen.push(p.phase),
  });
  assert.equal(report.status, 'completed');
  assert.equal(report.summaries.length, 3);
  assert.deepEqual(seen.filter((x) => x === 'start' || x === 'end'), ['start', 'end', 'start', 'end', 'start', 'end']);
  assert.deepEqual(report.summaries.map((s) => s.arm), ['with', 'control', 'without']);
  assert.ok(report.summary.control.ok);
  assert.equal(typeof report.summary.delta, 'number');
  assert.ok(fs.existsSync(path.join(outDir, 'outer-report.json')));
  assert.equal(fs.readdirSync(path.join(outDir, 'records')).length, 3);
  const onDisk = JSON.parse(fs.readFileSync(path.join(outDir, 'outer-report.json'), 'utf8'));
  assert.equal(onDisk.status, 'completed');
  assert.ok(Object.keys(summarizeAll([], []).scores).length === 0);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('REQ-015 利用枠の上限で止まったら、残りは飛ばして status を stopped にする。見ない模擬ユーザーの記録は別のフォルダに書く', async () => {
  const outDir = tmp('limit');
  const personas = [{ loaded: weekly, heldout: false }, { loaded: training, heldout: true }];
  const plan = planRuns({ personas, arms: ['with'], models: ['claude-opus-5-5'], runs: 1 });
  const personaById = new Map(personas.map((p) => [p.loaded.persona.id, p]));
  const converted = fakeConvert('/x/creator', path.join(outDir, 'converted', 'c')).root;
  let calls = 0;
  const sdk = createFakeSdk({
    userRole: () => 'x',
    agent: async () => {
      calls += 1;
      if (calls === 1) throw new Error("You've hit your session limit. Resets at 3pm");
      return '終わり';
    },
  });
  const report = await runPlan({ plan, personaById, outDir, creatorRoot: REPO, controlRoot: '/y', convertedCreator: converted, diskCheck: diskOk, common: { query: sdk.query, sandbox: false, convert: fakeConvert, maxExchanges: 1, runStages: async () => ({ skipped: true, reason: 'x' }) } });
  assert.equal(report.status, 'stopped');
  assert.equal(report.stopped.reason, 'usage_limit');
  assert.equal(calls, 1, '止まった後は、次の実行を始めない');
  assert.equal(report.summaries[1].stopped, 'skipped');
  assert.equal(report.summaries[1].persona, 'heldout', '飛ばした見ない模擬ユーザーの名前を出さない');
  // 見ない模擬ユーザーの記録は、records-heldout/ に分ける
  const outDir2 = tmp('heldout-out');
  const plan2 = planRuns({ personas: [personas[1]], arms: ['with'], models: ['claude-opus-5-5'], runs: 1 });
  const report2 = await runPlan({ plan: plan2, personaById, outDir: outDir2, creatorRoot: REPO, controlRoot: '/y', convertedCreator: converted, diskCheck: diskOk, common: { query: createFakeSdk({ userRole: () => 'x', agent: async () => '終わり' }).query, sandbox: false, convert: fakeConvert, maxExchanges: 1, runStages: async () => ({ skipped: true, reason: 'x' }) } });
  assert.equal(report2.heldoutRecordsDir, path.join(outDir2, 'records-heldout'));
  assert.ok(fs.existsSync(path.join(outDir2, 'records-heldout')));
  assert.ok(!fs.existsSync(path.join(outDir2, 'records')));
  assert.ok(!JSON.stringify(report2.summaries).includes('training-survey'));
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.rmSync(outDir2, { recursive: true, force: true });
});

test('testing.md 5章 ディスクの空き：1 回ごとに始める前に確かめ、足りなければ残りを飛ばして status を stopped（disk_low）にする', async () => {
  const outDir = tmp('disk');
  const personas = [{ loaded: weekly, heldout: false }];
  const plan = planRuns({ personas, arms: ['with', 'without'], models: ['claude-opus-5-5'], runs: 1 });
  const personaById = new Map(personas.map((p) => [p.loaded.persona.id, p]));
  const converted = fakeConvert('/x/creator', path.join(outDir, 'converted', 'c')).root;
  let checks = 0;
  const diskCheck = () => (++checks === 1 ? { ok: true, low: [], message: '' } : { ok: false, low: [{ path: '/', freeBytes: 1 }], message: 'ディスクの空きが足りないので始めません（/ の空き 0.0 GB）' });
  let runs = 0;
  const sdk = createFakeSdk({ userRole: () => 'x', agent: async () => { runs += 1; return '終わり'; } });
  const report = await runPlan({ plan, personaById, outDir, creatorRoot: REPO, controlRoot: '/y', convertedCreator: converted, diskCheck, common: { query: sdk.query, sandbox: false, convert: fakeConvert, maxExchanges: 1, runStages: async () => ({ skipped: true, reason: 'x' }) } });
  assert.equal(runs, 1, '空きが足りなくなった後は、次の実行を始めない');
  assert.equal(report.status, 'stopped');
  assert.equal(report.stopped.reason, 'disk_low');
  assert.match(report.stopped.message, /ディスクの空きが足りない/);
  assert.equal(report.stopped.at, 'weekly-report/without/claude-opus-5-5/1');
  assert.deepEqual(report.summaries.map((x) => x.stopped), ['max_exchanges', 'skipped']);
  // 1 回ごとの確かめも、結果のフォルダ（実行のフォルダとクリエイターのホームが入る）を見る
  const seen = [];
  await runPlan({ plan: plan.slice(0, 1), personaById, outDir, creatorRoot: REPO, controlRoot: '/y', convertedCreator: converted, diskCheck: (o) => { seen.push(o); return { ok: false, low: [], message: 'x' }; }, common: { query: sdk.query, sandbox: false } });
  assert.deepEqual(seen, [{ dirs: [outDir] }]);
});

test('testing.md 5章 ディスクの空き：始める前に足りなければ、結果のフォルダも置き換えも実行もせずに断る（終了コード 2、disk_low）。結果のフォルダの空きも見る', async () => {
  const outDir = path.join(tmp('disk-main'), 'out');
  const printed = [];
  const original = console.log;
  console.log = (text) => printed.push(text);
  let code;
  const seen = [];
  try {
    code = await main(['--persona', path.join(PERSONAS, 'weekly-report'), '--no-sandbox', '--out', outDir], {
      diskCheck: (o) => { seen.push(o); return { ok: false, low: [], message: 'ディスクの空きが足りないので始めません（/tmp の空き 0.1 GB。2.0 GB 以上が要ります）。' }; },
      query: () => { throw new Error('呼ばない'); },
    });
  } finally {
    console.log = original;
  }
  assert.equal(code, 2);
  const out = JSON.parse(printed.at(-1));
  assert.equal(out.ok, false);
  assert.equal(out.error, 'disk_low');
  assert.match(out.message, /\/tmp の空き 0\.1 GB/);
  assert.deepEqual(seen, [{ dirs: [outDir] }], '結果のフォルダ（--out）も見る');
  assert.equal(fs.existsSync(outDir), false, '結果のフォルダを作る前に断る');
});

test('testing.md 6.5 要約：環境で止まって採点しなかった観点（2段目がディスクの誤りだけで落ちた）を、notGraded と environmentStopped に出す', async () => {
  const record = await makeRecord({ loaded: weekly });
  record.grading.notGraded = [{ id: 'stage2', reason: '環境で止まった（ディスクがいっぱい）', environment: true, req: 'REQ-039' }];
  const s = summarizeRecord(record);
  assert.deepEqual(s.notGraded, ['stage2']);
  assert.deepEqual(s.environmentStopped, ['stage2']);
  // 続きから始めた実行の採点しなかった観点は、環境ではない
  record.grading.notGraded = [{ id: 'all-items-heard', reason: '読み直せなかった' }];
  assert.equal(summarizeRecord(record).environmentStopped, undefined);
});

test('REQ-015 記録する数は、各回の要約と全体の要約に出る。見ない模擬ユーザーでは、断りの理由の文を伏せる', async () => {
  const record = await makeRecord({ loaded: weekly });
  record.grading.counts = {
    questions: { total: 5, askTool: 4, text: 1 },
    askToolCalls: { calls: 3, maxQuestionsPerCall: 2, callsWithMultiple: 1 },
    pending: { count: 1, items: ['資産'] },
    aiDecisions: { count: 2 },
    recordRefusals: { total: 3, fixed: 2, unfixed: 1, byTool: {}, samples: [{ tool: 'progress', seq: 1, reason: '抜き書きがありません' }] },
    nonJapaneseTexts: { count: 2, samples: [{ seq: 7, text: 'Now extract.' }, { seq: 9, text: 'K-25 next.' }] },
    flowShown: { shown: true, seq: 3 },
  };
  const open = summarizeRecord(record);
  assert.equal(open.counts.questions.total, 5);
  assert.equal(open.counts.recordRefusals.samples.length, 1);
  const hidden = summarizeRecord(record, { heldout: true });
  assert.equal(hidden.counts.questions.total, 5, '数は出す');
  assert.deepEqual(hidden.counts.recordRefusals.samples, [], '理由の文は伏せる');
  assert.equal(hidden.counts.nonJapaneseTexts.count, 2, '日本語でない文の数は出す');
  assert.deepEqual(hidden.counts.nonJapaneseTexts.samples, [], '日本語でない文そのものは伏せる（ナレッジの手がかりになりうるため）');
  assert.equal(record.grading.counts.recordRefusals.samples.length, 1, 'もとの記録は変えない');

  const second = { ...open, counts: { ...open.counts, askToolCalls: { calls: 1, maxQuestionsPerCall: 3, callsWithMultiple: 1 }, recordRefusals: { total: 1, fixed: 0, unfixed: 1 } } };
  const total = aggregateCounts([open, second, { arm: 'with' /* 飛ばした実行には数がない */ }]);
  assert.equal(total.runs, 2);
  assert.equal(total.questions.total, 10);
  assert.deepEqual(total.askToolCalls, { calls: 4, maxQuestionsPerCall: 3, callsWithMultiple: 2 });
  assert.equal(total.pending, 2);
  assert.equal(total.aiDecisions, 4);
  assert.deepEqual(total.recordRefusals, { total: 4, fixed: 2, unfixed: 2 });
  assert.equal(total.nonJapaneseTexts, 4, '英語の覚え書きのようなチャットの文の数の合計（数のない古い記録は 0 とする）');
  assert.equal(aggregateCounts([open, { ...open, counts: { ...open.counts, nonJapaneseTexts: undefined } }]).nonJapaneseTexts, 2);
  assert.equal(total.flowShown, 2, '最初の問いより前に、これからの流れを示した回の数');
  assert.equal(aggregateCounts([open, { ...open, counts: { ...open.counts, flowShown: { shown: false, seq: null } } }, { ...open, counts: { ...open.counts, flowShown: undefined } }]).flowShown, 1, '示さなかった回と、数のない古い記録は数えない');
  assert.deepEqual(aggregateCounts([]), { runs: 0, questions: { total: 0, askTool: 0, text: 0 }, askToolCalls: { calls: 0, maxQuestionsPerCall: 0, callsWithMultiple: 0 }, pending: 0, aiDecisions: 0, recordRefusals: { total: 0, fixed: 0, unfixed: 0 }, nonJapaneseTexts: 0, flowShown: 0 });
  const all = summarizeAll([record], [open, second]);
  assert.equal(all.counts['with:claude-opus-5-5'].runs, 2);
  assert.equal(all.counts['with:claude-opus-5-5'].questions.total, 10);
});

test('REQ-015 ユーザー役が答えられずに止まった回（user_role_failed）は、平均点・合格の数・記録する数・あり・なしの差に入れず、別に数える', () => {
  const counts = (total) => ({ questions: { total, askTool: total, text: 0 }, askToolCalls: { calls: total, maxQuestionsPerCall: 1, callsWithMultiple: 0 }, pending: { count: 0 }, aiDecisions: { count: 0 }, recordRefusals: { total: 0, fixed: 0, unfixed: 0 }, nonJapaneseTexts: { count: 0 } });
  const run = (arm, score, verdictOk, stopped, n) => ({ arm, model: 'claude-opus-5-5', stopped, score, verdictOk, costUsd: 1, counts: counts(n) });
  const all = summarizeAll([], [
    run('with', 1, true, 'generated', 10),
    run('with', 0.5, false, USER_ROLE_FAILED, 3),
    run('without', 0.25, false, 'max_exchanges', 1),
  ]);
  assert.deepEqual(all.scores['with:claude-opus-5-5'], { runs: 1, score: 1, verdictOk: 1, userRoleFailed: 1, environmentAffected: 0 });
  assert.deepEqual(all.scores['without:claude-opus-5-5'], { runs: 1, score: 0.25, verdictOk: 0, userRoleFailed: 0, environmentAffected: 0 });
  assert.equal(all.counts['with:claude-opus-5-5'].runs, 1);
  assert.equal(all.counts['with:claude-opus-5-5'].questions.total, 10);
  assert.equal(all.delta, 0.75);
  assert.equal(all.costUsd, 3, '費用は、止まった回の分も数える');
  // その腕・モデルの回が、すべてユーザー役の失敗で止まったとき
  const only = summarizeAll([], [run('with', 0.5, false, USER_ROLE_FAILED, 3), run('without', 0.25, false, 'max_exchanges', 1)]);
  assert.deepEqual(only.scores['with:claude-opus-5-5'], { runs: 0, score: null, verdictOk: 0, userRoleFailed: 1, environmentAffected: 0 });
  assert.equal(only.delta, null);
});

test('testing.md 6.5 環境（ディスクがいっぱい）の影響を受けた回は、平均点・合格の数・記録する数・あり・なしの差に入れず、腕・モデルごとに別に数える', async () => {
  const counts = (total) => ({ questions: { total, askTool: total, text: 0 }, askToolCalls: { calls: total, maxQuestionsPerCall: 1, callsWithMultiple: 0 }, pending: { count: 0 }, aiDecisions: { count: 0 }, recordRefusals: { total: 0, fixed: 0, unfixed: 0 }, nonJapaneseTexts: { count: 0 } });
  const run = (arm, score, verdictOk, n, extra = {}) => ({ arm, model: 'claude-opus-5-5', stopped: 'changed', score, verdictOk, costUsd: 1, counts: counts(n), ...extra });
  const all = summarizeAll([], [
    run('with', 0.9, false, 10),
    run('with', 0.971, true, 4, { environmentAffected: true, notGraded: ['stage2'], environmentStopped: ['stage2'] }),
    run('with', 0.5, false, 2, { stopped: USER_ROLE_FAILED, environmentAffected: true }),
    run('without', 0.4, false, 1),
  ]);
  assert.deepEqual(all.scores['with:claude-opus-5-5'], { runs: 1, score: 0.9, verdictOk: 0, userRoleFailed: 1, environmentAffected: 1 }, 'ユーザー役の失敗で止まった回は、そちらだけに数える');
  assert.equal(all.counts['with:claude-opus-5-5'].questions.total, 10);
  assert.ok(Math.abs(all.delta - 0.5) < 1e-9);
  assert.equal(all.costUsd, 4);
  // 1 回の要約：記録の grading.environment から environmentAffected を出す
  const record = await makeRecord({ loaded: weekly });
  assert.equal(summarizeRecord(record).environmentAffected, undefined);
  record.grading.environment = { notGraded: [], toolResults: [539] };
  assert.equal(summarizeRecord(record).environmentAffected, true);
});
