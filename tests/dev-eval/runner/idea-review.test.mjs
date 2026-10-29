// アイデア創出スキルの中身と良さの判定（idea-review.mjs）の試験（アイデア創出の設計 7.2、REQ-077）。実際のモデルは使わない。
// 作った回のフォルダで、頼みの文、説明のファイルの見つけ方、返事の読み取り、合否のまとめを確かめ、偽の query() で入口を最後まで動かす。
// 持たせるツールは、本物の Agent SDK と Claude Code の本体を偽の API につないで確かめる。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import * as realSdk from '@anthropic-ai/claude-agent-sdk';

import {
  aggregateOk,
  buildIdeaPrompt,
  buildProcessPrompt,
  explanationFiles,
  extractJson,
  IDEA_FAIL_CONDITIONS,
  IDEA_TOOLS,
  ideaPassed,
  main,
  normalizeIdea,
  normalizeProcess,
  planSessions,
  PROCESS_ITEMS,
  PROCESS_TOOLS,
  RETRY_NOTE,
  REVIEW_MODEL,
  reviewRun,
} from './idea-review.mjs';
import { guardSdk, lastToolResultBlocks, startFakeAnthropic } from './fake-anthropic.mjs';
import { isInsideDir } from './isolation.mjs';
import { tempDir } from './temp-dirs.mjs';

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** 作る過程の判定や記録に入れる目印。アイデアの良さの判定の頼みの文に入っていてはいけない */
const INTERNAL_MARKS = ['JUDGE-MARK', 'PRIOR-MARK', 'READING-MARK', 'DRAFT-MARK', 'SIMILAR-MARK', 'RANKED-MARK', 'PASSED-MARK', 'SELECTION-MARK', 'RESTRICTION-MARK', 'WHYS-MARK'];

/** 最後まで進んだ回のフォルダ（説明したアイデアは2つ） */
function sampleRun() {
  const runDir = path.join(tempDir('idea-review'), 'runs', '20261028-1000');
  write(path.join(runDir, 'state.md'), '# 状態\n- 状態：終わり\n');
  write(path.join(runDir, 'restriction.md'), '# 制限\n## 目的\nRESTRICTION-MARK\n## 範囲\n…\n');
  write(path.join(runDir, 'research', 'plan.md'), '# 調べる計画\n');
  write(path.join(runDir, 'research', 'index.md'), '- 1 | 作品 | https://example.com/1 | 製品 | 評価：あり | 受賞\n');
  write(path.join(runDir, 'research', 'overview.md'), '# まとめ\n');
  for (const n of [1, 2, 10]) write(path.join(runDir, 'research', `deep-${n}.md`), `## ${n}\n`);
  for (const a of [1, 2]) {
    write(path.join(runDir, 'essence', `whys-${a}.md`), 'WHYS-MARK なぜ評価されているのか');
    write(path.join(runDir, 'essence', `opinion-${a}-r1.md`), '意見');
    write(path.join(runDir, 'essence', `final-${a}.md`), '出し直し');
  }
  write(path.join(runDir, 'essence', 'index.md'), '## E1 …\n- なぜ：… → … → …\n');
  for (const c of ['c01', 'c02']) {
    write(path.join(runDir, 'combine', c, 'ideas-r0.md'), '案');
    write(path.join(runDir, 'combine', c, 'passed-ideas.md'), '## 1 案（通った回：r1）\n');
    write(path.join(runDir, 'combine', c, 'prior-r1.md'), 'PRIOR-MARK');
    for (const p of [1, 2]) write(path.join(runDir, 'combine', c, `judge-${p}-r1.md`), 'JUDGE-MARK 新しさ 役立つ 価値');
  }
  write(path.join(runDir, 'combine', 'passed.md'), 'PASSED-MARK');
  write(path.join(runDir, 'combine', 'ranked.md'), 'RANKED-MARK');
  write(path.join(runDir, 'selection.md'), 'SELECTION-MARK');
  write(path.join(runDir, 'explain', '1.md'), '# 見守りの案\n説明の本文 EXPLAIN-ONE\n');
  write(path.join(runDir, 'explain', '2.md'), '# 記録の案\n説明の本文 EXPLAIN-TWO\n');
  write(path.join(runDir, 'explain', '1', 'draft-1.md'), '# 古い版\nDRAFT-MARK\n');
  write(path.join(runDir, 'explain', '1', 'reading-1-1.md'), 'READING-MARK');
  write(path.join(runDir, 'explain', '1', 'similar.md'), 'SIMILAR-MARK');
  write(path.join(runDir, 'explain', 'notes.md'), 'メモ');
  return runDir;
}

const processReply = (ok = true) => `調べました。\n\`\`\`json\n${JSON.stringify({
  process: { items: PROCESS_ITEMS.map((i) => ({ id: i.id, title: i.title, ok, evidence: 'essence/whys-1.md「なぜ評価されているのか」' })) },
})}\n\`\`\``;

const IDEA = (name, verdict = 'pass', extra = {}) => ({
  idea: {
    name,
    verdict,
    closest: [{ name: '近い製品', url: 'https://example.com/near', why_close: '同じ困りごと' }],
    novelty: { ok: verdict === 'pass', reason: '違いが価値の中心' },
    usefulness: { ok: true, reason: '困りごとの声がある' },
    value: { ok: true, reason: '利用者が多い' },
    benefit: { ok: true, sentence: '一人で暮らす高齢の親を持つ人が、離れていても安心できる', reason: 'メリットが1文で言える' },
    readability: { ok: true, unclear: [], reason: '分からない言葉はない' },
    queries: ['言い方1', '言い方2', '言い方3'],
    reasons: [],
    ...extra,
  },
});
const ideaReply = (value) => `探しました。\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n以上です。`;

/**
 * 偽の query()。script({ kind, prompt, options, attempt }) が { text, tools } を返す。tools は、メインのスレッドで呼んだことにするツールの名前。
 * kind は、持たせたツールで見分ける（Read があればプロセスの中身）。attempt は、同じ頼み（説明の目印）での何回目か。
 */
function fakeQuery(script) {
  const calls = [];
  const query = ({ prompt, options }) => {
    const kind = options.tools.includes('Read') ? 'process' : 'idea';
    const key = kind === 'process' ? 'process' : (prompt.match(/EXPLAIN-\w+/)?.[0] ?? 'idea');
    const attempt = calls.filter((c) => c.key === key).length + 1;
    calls.push({ kind, key, attempt, prompt, options });
    const reply = script({ kind, key, prompt, options, attempt });
    return (async function* generate() {
      yield { type: 'system', subtype: 'init', session_id: 's' };
      for (const name of reply.tools ?? []) {
        yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: `t-${name}`, name, input: {} }] } };
      }
      yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: reply.text }] } };
      yield { type: 'result', subtype: 'success', is_error: false, result: reply.text, total_cost_usd: 0.5 };
    })();
  };
  return { query, calls };
}

/** 入口を偽の query() で動かす。標準出力と進み具合は集める */
async function runMain(args, query) {
  const printed = [];
  const logs = [];
  const code = await main(args, { query, print: (s) => printed.push(s), log: (x) => logs.push(x) });
  return { code, printed: printed.join(''), logs };
}

test('REQ-077 プロセスの中身の頼みの文：7.2 の項目と、読むファイル（組ごとの判定・先行例、分けた一覧も）が入り、説明と読み手の記録は入らない', () => {
  const runDir = sampleRun();
  const prompt = buildProcessPrompt(runDir);
  for (const item of PROCESS_ITEMS) assert.ok(prompt.includes(item.text), item.id);
  assert.match(prompt, /機能の言い換えで止まっていない/);
  assert.match(prompt, /制限を判定に使っていない/);
  assert.match(prompt, /だめな理由を示す役が働いている/);
  assert.match(prompt, /製品・OSS・論文・特許/);
  assert.match(prompt, /誰にとって恩恵があるのか/);
  assert.match(prompt, /通った後に直されたり/);
  for (const f of ['essence/whys-1.md', 'essence/whys-2.md', 'essence/opinion-1-r1.md', 'essence/index.md', 'combine/c01/judge-1-r1.md', 'combine/c02/judge-2-r1.md',
    'combine/c01/ideas-r0.md', 'combine/c02/passed-ideas.md',
    'combine/c01/prior-r1.md', 'combine/c02/prior-r1.md', 'research/plan.md', 'research/index.md', 'research/deep-1.md']) {
    assert.ok(prompt.includes(f), f);
  }
  assert.ok(prompt.indexOf('research/deep-2.md') < prompt.indexOf('research/deep-10.md'), '番号の順に並ぶ');
  assert.doesNotMatch(prompt, /explain\/|reading-|draft-|ranked\.md|passed\.md|selection\.md/);
  // 中身は入れない（ファイルは自分で読む）。作業フォルダからの場所で示し、絶対パスは入れない
  assert.ok(!prompt.includes('JUDGE-MARK'));
  assert.ok(!prompt.includes(runDir));
  assert.match(prompt, /```json/);
  assert.match(prompt, /"evidence"/);
  // ないものは「ありません」と示す
  fs.rmSync(path.join(runDir, 'research', 'plan.md'));
  assert.match(buildProcessPrompt(runDir), /調べる計画：（ありません）/);
});

test('REQ-077 アイデアの良さの頼みの文：説明の文と 7.2 の判定のしかた・不合格の条件が入り、作る過程の判定と回のフォルダは入らない', () => {
  const runDir = sampleRun();
  const sessions = planSessions(runDir);
  assert.deepEqual(sessions.map((s) => s.kind), ['process', 'idea', 'idea']);
  assert.deepEqual(sessions[0].tools, PROCESS_TOOLS);
  const ideas = sessions.slice(1);
  assert.deepEqual(ideas.map((s) => [s.file, s.title]), [['explain/1.md', '見守りの案'], ['explain/2.md', '記録の案']]);
  assert.ok(ideas[0].prompt.includes('説明の本文 EXPLAIN-ONE'));
  assert.ok(!ideas[0].prompt.includes('EXPLAIN-TWO'));
  for (const s of ideas) {
    assert.deepEqual(s.tools, IDEA_TOOLS);
    for (const c of IDEA_FAIL_CONDITIONS) assert.ok(s.prompt.includes(c), c);
    assert.match(s.prompt, /WebSearch と WebFetch/);
    assert.match(s.prompt, /製品、OSS、論文、特許/);
    assert.match(s.prompt, /少なくとも3つの違う言い方/);
    assert.match(s.prompt, /新しさ/);
    assert.match(s.prompt, /役立つか/);
    assert.match(s.prompt, /価値/);
    assert.match(s.prompt, /誰にどんなメリットか/);
    assert.match(s.prompt, /専門外の人が辞書や検索なしに一度読んで分からない/);
    assert.match(s.prompt, /"benefit"/);
    assert.match(s.prompt, /"readability"/);
    assert.match(s.prompt, /"verdict"/);
    assert.match(s.prompt, /"queries"/);
    for (const mark of INTERNAL_MARKS) assert.ok(!s.prompt.includes(mark), mark);
    assert.ok(!s.prompt.includes(runDir));
    assert.doesNotMatch(s.prompt, /restriction\.md|judge-|reading-|runs\//);
  }
  assert.equal(buildIdeaPrompt('# 題\n本文').includes('# 題\n本文'), true);
});

test('REQ-077 説明のファイルは explain/<n>.md だけを番号の順に見つける（版・読み手の記録・似たもの・ほかの名前は入れない）', () => {
  const runDir = sampleRun();
  write(path.join(runDir, 'explain', '10.md'), '# 十番目\n');
  write(path.join(runDir, 'explain', '3', 'draft-2.md'), '版');
  assert.deepEqual(explanationFiles(runDir), ['explain/1.md', 'explain/2.md', 'explain/10.md']);
  assert.deepEqual(explanationFiles(path.join(runDir, 'nothing')), []);
});

test('返事の読み取り：最後の ```json のかたまりを読み、前後の文を気にしない。読めないときは理由を返す', () => {
  assert.deepEqual(extractJson('判定しました。\n```json\n{"a": 1}\n```\n以上です。').value, { a: 1 });
  // かたまりが複数あれば最後のもの。後ろの json でないかたまりは使わない
  assert.deepEqual(extractJson('```json\n{"a": 1}\n```\n直します。\n```json\n{"a": 2}\n```\n```text\nメモ\n```').value, { a: 2 });
  // json の印がないときは、「{」で始まるかたまり
  assert.deepEqual(extractJson('```\n{"b": true}\n```').value, { b: true });
  assert.deepEqual(extractJson('```json\n{"c": 3}\n```\n```\n{"d": 4}\n```').value, { c: 3 });
  // 閉じていない最後のかたまり、1行のかたまり
  assert.deepEqual(extractJson('結果：\n```json\n{"e": 5}\n').value, { e: 5 });
  assert.deepEqual(extractJson('```json {"f": 6}```').value, { f: 6 });
  assert.match(extractJson('```json\n{a: 1}\n```').error, /JSON として読めません/);
  assert.match(extractJson('JSON はありません').error, /```json のかたまりがありません/);
  assert.match(extractJson('```text\nメモ\n```').error, /```json のかたまりがありません/);
  assert.match(extractJson(undefined).error, /かたまりがありません/);
});

test('返事の形：項目の欠け、ok が真偽でない、根拠がない、近いものがない、検索語が3つより少ないと読めなかったことにする', () => {
  const items = PROCESS_ITEMS.map((i) => ({ id: i.id, ok: true, evidence: 'x' }));
  assert.deepEqual(normalizeProcess({ process: { items } }).items.map((i) => [i.id, i.title, i.ok]), PROCESS_ITEMS.map((i) => [i.id, i.title, true]));
  assert.equal(normalizeProcess({ items }).items.length, PROCESS_ITEMS.length);
  assert.throws(() => normalizeProcess({ process: { items: items.slice(1) } }), /項目 P1 がありません/);
  assert.throws(() => normalizeProcess({ process: { items: items.map((i) => ({ ...i, ok: 'はい' })) } }), /ok が true か false ではありません/);
  assert.throws(() => normalizeProcess({ process: { items: items.map((i) => ({ ...i, evidence: '' })) } }), /根拠/);
  assert.throws(() => normalizeProcess({}), /process\.items がありません/);

  const good = IDEA('案').idea;
  assert.equal(normalizeIdea({ idea: good }).verdict, 'pass');
  assert.equal(normalizeIdea(good).name, '案');
  assert.throws(() => normalizeIdea({ ...good, verdict: '合格' }), /verdict/);
  assert.throws(() => normalizeIdea({ ...good, value: { reason: 'x' } }), /value\.ok/);
  assert.throws(() => normalizeIdea({ ...good, closest: [] }), /いちばん近い既存のもの/);
  assert.throws(() => normalizeIdea({ ...good, closest: [{ name: 'URL なし' }] }), /いちばん近い既存のもの/);
  assert.throws(() => normalizeIdea({ ...good, queries: ['1つ', '2つ'] }), /検索語/);
  assert.throws(() => normalizeIdea({ ...good, benefit: { reason: 'x' } }), /benefit\.ok/);
  assert.throws(() => normalizeIdea({ ...good, benefit: { ok: true, sentence: '' } }), /benefit\.sentence/);
  assert.throws(() => normalizeIdea({ ...good, readability: { ok: true } }), /readability\.unclear/);
  assert.deepEqual(normalizeIdea({ ...good, readability: { ok: false, unclear: ['I-PASS', ''], reason: '略語' } }).readability.unclear, ['I-PASS']);
});

test('合否のまとめ：プロセスの項目がすべて満たし、アイデアがすべて合格のときだけ ok。誤り・観点の欠け・アイデアなしは ok にしない', () => {
  const proc = { ok: true, items: PROCESS_ITEMS.map((i) => ({ id: i.id, ok: true })) };
  const pass = { ...normalizeIdea(IDEA('案')) };
  assert.equal(ideaPassed(pass), true);
  assert.equal(aggregateOk(proc, [pass, pass]), true);
  assert.equal(aggregateOk({ ...proc, items: proc.items.map((i, n) => ({ ...i, ok: n !== 2 })) }, [pass]), false);
  assert.equal(aggregateOk({ ok: false, items: [], error: '読めません' }, [pass]), false);
  assert.equal(aggregateOk(proc, [pass, normalizeIdea(IDEA('だめな案', 'fail'))]), false);
  // verdict が pass でも、観点のどれかが満たされていなければ合格にしない
  const odd = { ...pass, usefulness: { ok: false, reason: '根拠がない' } };
  assert.equal(ideaPassed(odd), false);
  // 誰にどんなメリットかが分からない、分からない言葉や文が挙がっているときも合格にしない
  assert.equal(ideaPassed({ ...pass, benefit: { ok: false, sentence: '', reason: '手法の説明だけ' } }), false);
  assert.equal(ideaPassed({ ...pass, readability: { ok: true, unclear: ['見立て'], reason: '' } }), false);
  assert.equal(aggregateOk(proc, [odd]), false);
  assert.equal(aggregateOk(proc, [{ file: 'explain/1.md', pass: false, error: '読めません' }]), false);
  assert.equal(aggregateOk(proc, []), false);
});

test('REQ-077 入口：判定ごとに別のセッションで、要るツールだけを持たせ、review.json と1行の要約を書く', async () => {
  const runDir = sampleRun();
  const work = tempDir('idea-review-main');
  const home = path.join(work, 'home');
  const out = path.join(work, 'result', 'review.json');
  const { query, calls } = fakeQuery(({ kind, key }) => (kind === 'process'
    ? { text: processReply(), tools: ['Glob', 'Read', 'Read'] }
    : { text: ideaReply(IDEA(key === 'EXPLAIN-ONE' ? '見守りの案' : '記録の案')), tools: ['WebSearch', 'WebSearch', 'WebSearch', 'WebFetch'] }));
  const { code, printed } = await runMain(['--run-dir', runDir, '--out', out, '--home', home], query);
  assert.equal(code, 0);
  assert.equal(calls.length, 3);

  const proc = calls.find((c) => c.kind === 'process');
  assert.deepEqual(proc.options.tools, ['Read', 'Grep', 'Glob']);
  assert.deepEqual(proc.options.allowedTools, ['Read', 'Grep', 'Glob']);
  assert.equal(proc.options.cwd, runDir);
  const ideaCalls = calls.filter((c) => c.kind === 'idea');
  assert.equal(ideaCalls.length, 2);
  for (const c of calls) {
    assert.equal(c.options.model, REVIEW_MODEL);
    assert.deepEqual(c.options.settingSources, []);
    assert.equal(c.options.persistSession, false);
    assert.equal(c.options.env.HOME, home);
    assert.equal(c.options.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION, '5000');
    assert.equal((await c.options.canUseTool('Bash', { command: 'ls' })).behavior, 'deny');
    assert.equal((await c.options.canUseTool('Write', { file_path: path.join(runDir, 'x.md') })).behavior, 'deny');
    assert.equal((await c.options.canUseTool('Agent', {})).behavior, 'deny');
  }
  assert.equal((await proc.options.canUseTool('Read', { file_path: 'essence/whys-1.md' })).behavior, 'allow');
  assert.equal((await proc.options.canUseTool('WebSearch', { query: 'x' })).behavior, 'deny');
  for (const c of ideaCalls) {
    assert.deepEqual(c.options.tools, ['WebSearch', 'WebFetch']);
    assert.deepEqual(c.options.allowedTools, ['WebSearch', 'WebFetch']);
    // 回のフォルダの外の、別々の作業フォルダ。ファイルを読むツールは断る
    assert.equal(isInsideDir(runDir, c.options.cwd), false);
    assert.equal((await c.options.canUseTool('Read', { file_path: path.join(runDir, 'combine', 'ranked.md') })).behavior, 'deny');
    assert.equal((await c.options.canUseTool('WebSearch', { query: 'x' })).behavior, 'allow');
    assert.equal((await c.options.canUseTool('WebFetch', { url: 'https://example.com' })).behavior, 'allow');
    for (const mark of INTERNAL_MARKS) assert.ok(!c.prompt.includes(mark), mark);
  }
  assert.notEqual(ideaCalls[0].options.cwd, ideaCalls[1].options.cwd);

  const review = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(review.ok, true);
  assert.equal(review.runDir, runDir);
  assert.equal(review.model, REVIEW_MODEL);
  assert.equal(review.costUsd, 1.5);
  assert.equal(review.process.ok, true);
  assert.deepEqual(review.process.items.map((i) => i.id), PROCESS_ITEMS.map((i) => i.id));
  assert.deepEqual(review.process.toolCalls, { Glob: 1, Read: 2 });
  assert.deepEqual(review.ideas.map((i) => [i.file, i.name, i.verdict, i.pass]), [['explain/1.md', '見守りの案', 'pass', true], ['explain/2.md', '記録の案', 'pass', true]]);
  assert.deepEqual(review.ideas[0].closest, [{ name: '近い製品', url: 'https://example.com/near', why_close: '同じ困りごと' }]);
  assert.deepEqual(review.ideas[0].queries, ['言い方1', '言い方2', '言い方3']);
  assert.deepEqual(review.ideas[0].toolCalls, { WebSearch: 3, WebFetch: 1 });
  assert.equal(review.ideas[0].novelty.ok, true);

  assert.equal(printed.trim().split('\n').length, 1);
  const summary = JSON.parse(printed);
  assert.equal(summary.ok, true);
  assert.equal(summary.out, out);
  assert.deepEqual(summary.process.failed, []);
  assert.deepEqual(summary.ideas.map((i) => i.pass), [true, true]);
  // --home を渡したときは消さない
  assert.ok(fs.existsSync(home));
});

test('REQ-077 入口：読めない返事は注意を足して1回だけ呼び直し、それでもだめなら誤りとして記録する。不合格でも終了コードは 0', async () => {
  const runDir = sampleRun();
  const work = tempDir('idea-review-retry');
  const out = path.join(work, 'review.json');
  const { query, calls } = fakeQuery(({ kind, key, attempt }) => {
    if (kind === 'process') return attempt === 1 ? { text: '調べましたが、形を忘れました。' } : { text: processReply(false), tools: ['Read'] };
    // 1つ目の案：1回目は Web を使わずに判定した → 呼び直して、不合格の判定
    if (key === 'EXPLAIN-ONE') return attempt === 1 ? { text: ideaReply(IDEA('見守りの案')) } : { text: ideaReply(IDEA('見守りの案', 'fail', { reasons: ['ほぼ同じ既存のものが見つかった。'] })), tools: ['WebSearch'] };
    // 2つ目の案：2回とも JSON が壊れている
    return { text: '```json\n{"idea": {"verdict": \n```', tools: ['WebSearch'] };
  });
  const { code, printed } = await runMain(['--run-dir', runDir, '--out', out, '--review-model', 'claude-sonnet-5-5'], query);
  assert.equal(code, 0);
  assert.equal(calls.length, 6);
  for (const c of calls) {
    assert.equal(c.options.model, 'claude-sonnet-5-5');
    if (c.attempt === 2) assert.ok(c.prompt.includes(RETRY_NOTE));
    else assert.ok(!c.prompt.includes(RETRY_NOTE));
  }
  assert.match(calls.find((c) => c.key === 'EXPLAIN-ONE' && c.attempt === 2).prompt, /WebSearch を使わずに判定しました/);
  assert.match(calls.find((c) => c.kind === 'process' && c.attempt === 2).prompt, /```json のかたまりがありません/);

  const review = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(review.ok, false);
  assert.equal(review.costUsd, 3);
  assert.equal(review.process.ok, false);
  assert.equal(review.process.attempts, 2);
  assert.ok(review.process.items.every((i) => i.ok === false));
  const [one, two] = review.ideas;
  assert.deepEqual([one.verdict, one.pass, one.attempts], ['fail', false, 2]);
  assert.deepEqual(one.reasons, ['ほぼ同じ既存のものが見つかった。']);
  assert.deepEqual([two.file, two.name, two.pass, two.attempts], ['explain/2.md', '記録の案', false, 2]);
  assert.match(two.error, /JSON として読めません/);
  const summary = JSON.parse(printed);
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.process.failed, PROCESS_ITEMS.map((i) => i.id));
  assert.match(summary.ideas[1].error, /JSON として読めません/);
});

test('REQ-077 入口：呼び出しが誤りで終わったときも1回だけ呼び直し、説明したアイデアがなければ ok にしない', async () => {
  const runDir = sampleRun();
  fs.rmSync(path.join(runDir, 'explain'), { recursive: true });
  const out = path.join(tempDir('idea-review-error'), 'review.json');
  let n = 0;
  const query = () => (async function* generate() {
    n += 1;
    if (n === 1) {
      yield { type: 'result', subtype: 'error_max_turns', is_error: true, result: '', total_cost_usd: 0.25 };
      return;
    }
    yield { type: 'result', subtype: 'success', is_error: false, result: processReply(), total_cost_usd: 0.25 };
  })();
  const { code } = await runMain(['--run-dir', runDir, '--out', out], query);
  assert.equal(code, 0);
  assert.equal(n, 2);
  const review = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(review.process.ok, true);
  assert.equal(review.process.attempts, 2);
  assert.deepEqual(review.ideas, []);
  assert.equal(review.ok, false);
});

test('入口：--dry-run はモデルを呼ばずに頼みの文を示す。始められないときは終了コード 1', async () => {
  const runDir = sampleRun();
  const never = () => {
    throw new Error('モデルを呼んではいけない');
  };
  const out = path.join(tempDir('idea-review-dry'), 'review.json');
  const dry = await runMain(['--run-dir', runDir, '--dry-run'], never);
  assert.equal(dry.code, 0);
  assert.ok(dry.printed.includes(PROCESS_ITEMS[0].text));
  assert.ok(dry.printed.includes('EXPLAIN-ONE'));
  assert.ok(dry.printed.includes('EXPLAIN-TWO'));
  assert.match(dry.printed, /ツール：WebSearch、WebFetch/);
  assert.match(dry.printed, /ツール：Read、Grep、Glob/);
  assert.equal(fs.existsSync(out), false);

  for (const [args, message] of [
    [['--out', out], /--run-dir が要ります/],
    [['--run-dir', runDir], /--out が要ります/],
    [['--run-dir', path.join(runDir, 'nothing'), '--out', out], /回のフォルダがありません/],
    [['--run-dir', runDir, '--out', out, '--verbose'], /知らない引数です/],
    [['--run-dir', runDir, '--out'], /--out の値がありません/],
    [['--run-dir', runDir, '--out', out, '--home', path.join(runDir, 'home')], /回のフォルダの外/],
  ]) {
    const r = await runMain(args, never);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(JSON.parse(r.printed).error, message);
  }
  assert.equal(fs.existsSync(out), false);
});

test('REQ-077 本物の Agent SDK でも、プロセスの判定は Read・Grep・Glob だけ、アイデアの判定は WebSearch・WebFetch だけを持ち、ほかのツールは使えない', { timeout: 90_000 }, async () => {
  const runDir = sampleRun();
  const home = tempDir('idea-review-sdk');
  const seen = { process: [], idea: [] };
  const results = { process: [], idea: [] };
  const api = await startFakeAnthropic(async ({ body }) => {
    const names = (body.tools ?? []).map((t) => t.name);
    const kind = names.includes('Read') ? 'process' : 'idea';
    seen[kind].push(names);
    const done = lastToolResultBlocks(body);
    if (!done.length) {
      // プロセスの判定は Bash と Read を、アイデアの判定は回のフォルダの Read と WebSearch を呼ぼうとする
      return {
        blocks: kind === 'process'
          ? [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }, { type: 'tool_use', name: 'Read', input: { file_path: path.join(runDir, 'essence', 'whys-1.md') } }]
          : [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(runDir, 'combine', 'ranked.md') } }, { type: 'tool_use', name: 'WebSearch', input: { query: 'x' } }],
      };
    }
    results[kind].push(...done);
    return { blocks: [{ type: 'text', text: kind === 'process' ? processReply() : ideaReply(IDEA('見守りの案')) }] };
  });
  try {
    const envExtra = { ANTHROPIC_API_KEY: 'fake-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ANTHROPIC_BASE_URL: api.url };
    // 守り：偽の API につながっていない query は断る
    const review = await reviewRun({ runDir, home, query: guardSdk(realSdk, api).query, envExtra, timeoutMs: 60_000 });
    assert.equal(review.ok, true, JSON.stringify(review).slice(0, 500));
    assert.ok(seen.process.length > 0 && seen.idea.length > 0);
    for (const names of seen.process) {
      for (const t of PROCESS_TOOLS) assert.ok(names.includes(t), t);
      for (const t of ['Bash', 'Write', 'Edit', 'Agent', 'WebSearch', 'WebFetch']) assert.ok(!names.includes(t), t);
    }
    for (const names of seen.idea) {
      for (const t of IDEA_TOOLS) assert.ok(names.includes(t), t);
      for (const t of ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'Agent']) assert.ok(!names.includes(t), t);
    }
    // 持たないツールの呼び出しは、誤りとしてモデルに返る
    assert.ok(results.process.some((r) => r.isError && /No such tool available: Bash/.test(r.text)));
    assert.ok(results.process.some((r) => !r.isError && r.text.includes('WHYS-MARK')));
    assert.ok(results.idea.length > 0);
    assert.ok(results.idea.some((r) => r.isError && /No such tool available: Read/.test(r.text)));
    assert.ok(results.idea.every((r) => !r.text.includes('RANKED-MARK')));
  } finally {
    await api.close();
  }
});
