// アイデア創出スキルの流れの試験の採点（idea-grade.mjs）と入口の部品（idea.mjs）の試験（アイデア創出の設計 7章）。モデルは使わない。
// 小さなパラメーターで「最後まで進んだ回」のデータと呼び出しの一覧を作り、合格することと、壊したところで落ちることを確かめる。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { candidatesOf, comboLines, comboReasons, essenceEntries, essenceIds, firstSection, gradeIdeaRun, ideaEntries, indexItems, judgeRounds, knowledgeItems, latestRun, maxParallel, passedIdeas, sizeSequenceProblems, uniqueUrls, workSections } from './idea-grade.mjs';
import { buildIdeaUserSystem, currentPillar, IDEA_USER_RULES, isFinished, prepareData, recordedInput, SMALL_PARAMS } from './idea.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const R = 'plugin-creator:idea-researcher';
const T = 'plugin-creator:idea-thinker';
const D = 'plugin-creator:idea-reader';

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const ITEM = (n) => `## K3-${n} 目的と仕組みで書くと、組み合わせやすい。\n- 例：本質 E1 と E2\n- 出典：runs/20261027-1000/essence/index.md\n- 制限：分野を問わない\n- 得た日：2026-10-27\n- 確かさ：ユーザーが確かめた\n`;

const RUN = '20261027-1000';
const JUDGE = '- 1 通す\n  - 新しさ：先行例との違いが中心\n  - 役立つか：根拠のある困りごとに効く\n  - 価値：大きさに根拠がある\n通す：1\n';
/** 掘り下げの作品の節（小さな値では、1件に読む情報源は2つ。「、」で並べた URL も分けて数える） */
const DEEP = (n) => `## ${n} 作品${n}\n- URL：https://example.com/w${n}\n- なぜ評価されているかの材料：「…」（https://review.example.org/w${n}）\n- 読んだ情報源：https://example.com/w${n}、https://review.example.org/w${n}\n`;
const WHYS = (n) => `## ${n} 作品${n}\n- なぜ評価されているのか → 「…」（${n}）→ なぜか → 困りごと\n- 誰にとって恩恵があるのか → 組み込みの開発者（${n}）\n- その人の生活や仕事の何が、どう良くなったのか → 調べる手間が減った（${n}）\n- なぜこの形なのか → …\n- たどり着いた本質：S1\n`;
const ESSENCE = (n, why = `${n} なぜ評価されているのか → 答え → 困りごと`) => `## E${n} 本質${n}\n- 誰に：…\n- どんなメリットが：…\n- なぜそうなるか：…\n- なぜ：${why}\n- 裏づけ：${n}\n- 支持：2\n- 印：なし\n`;
// 小さな値：順 2 → 3、同じ数で試す組は1。c02 がだめで数が3に変わる
const LOG_LINES = [['c01', '数 2｜E1、E2', '1（r1）'], ['c02', '数 2｜E3、E4', 'なし'], ['c03', '数 3｜E1、E5、E6', '2（r2）']];
/** 案の型（設計書 3.6）の案 */
const IDEA = (n) => `## ${n} 案${n}\n- 誰に：…\n- どんなメリットが：…\n- 困りごと：…\n- 場面：…\n- すること：…\n- 本質の効き方：…\n- 根拠：E1\n`;
/** combine/log.md の組の行と、その下の「恩恵を受ける人」「選んだ理由」の行 */
const LOG = (c, mid, passed) => `- ${c}｜${mid}｜作った案 2｜通った案：${passed}\n  - 恩恵を受ける人：…\n  - 選んだ理由：…\n`;

/** 小さなパラメーターで最後まで進んだ回（データと呼び出し）を作る */
function finishedRun() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-grade-'));
  prepareData(dataDir, { params: 'small' });
  const run = path.join(dataDir, 'runs', RUN);
  write(path.join(run, 'state.md'), '# 状態\n- 状態：終わり\n- 今の柱：6 知識・経験の蓄積\n- 柱2の始め：2026-10-27T10:05:00+09:00\n- 柱2の終わり：2026-10-27T11:20:00+09:00\n- 読んだページ：64\n');
  write(path.join(run, 'restriction.md'), '# 制限\n- 短い名前：組み込みのデバッグ\n## 目的\nデバッグの手間を減らす\n## 範囲\n組み込みの開発\n');
  write(path.join(run, 'research', 'plan.md'), '# 計画\n## 問い\n…\n');
  for (const n of [1, 2, 3]) write(path.join(run, 'research', `collect-${n}-r0.md`), '- 作品 | https://example.com/x | OSS | 「…」 | スター 100\n');
  write(path.join(run, 'research', 'gaps-r1.md'), '# 足りないところ\n');
  write(path.join(run, 'research', 'collect-1-r1.md'), '- 作品 | https://example.com/y | OSS | 「…」 | スター 100\n');
  // 一覧は index.md と index-2.md に分かれている。評価が「あり」は 1〜6
  const line = (i) => `- ${i} | 作品${i} | https://example.com/w${i} | OSS | 評価：${i <= 6 ? 'あり' : 'なし'} | スター 100（GitHub）`;
  write(path.join(run, 'research', 'index.md'), Array.from({ length: 8 }, (_, i) => line(i + 1)).join('\n'));
  write(path.join(run, 'research', 'index-2.md'), Array.from({ length: 4 }, (_, i) => line(i + 9)).join('\n'));
  write(path.join(run, 'research', 'deep-1.md'), [1, 2, 3].map(DEEP).join('\n'));
  write(path.join(run, 'research', 'deep-2.md'), [4, 5, 6].map(DEEP).join('\n'));
  write(path.join(run, 'research', 'overview.md'), '# まとめ\n');
  write(path.join(run, 'essence', 'index.md'), [1, 2, 3, 4].map((n) => ESSENCE(n)).join('\n'));
  write(path.join(run, 'essence', 'index-2.md'), [5, 6].map((n) => ESSENCE(n)).join('\n'));
  for (const a of [1, 2]) {
    write(path.join(run, 'essence', `whys-${a}.md`), `# なぜなぜ分析\n${[1, 2, 3].map(WHYS).join('\n')}\n## 本質\n### S1 …\n`);
    write(path.join(run, 'essence', `opinion-${a}-r1.md`), '意見');
    write(path.join(run, 'essence', `final-${a}.md`), '出し直し');
    write(path.join(run, 'reflect', `reflection-${a}.md`), '振り返り');
  }
  write(path.join(run, 'essence', 'whys-2-2.md'), [4, 5, 6].map(WHYS).join('\n'));
  for (const [c] of LOG_LINES) {
    write(path.join(run, 'combine', c, 'ideas-r0.md'), [1, 2].map(IDEA).join('\n'));
    write(path.join(run, 'combine', c, 'ideas.md'), [1, 2].map(IDEA).join('\n'));
    write(path.join(run, 'combine', c, 'prior-r1.md'), '## 1 案\n- 検索語：…、…、…\n- 特許：検索語「…」→ 見つからなかった\n');
    write(path.join(run, 'combine', c, 'prior-r2.md'), '## 1 案\n- 検索語：…\n');
    for (const j of ['judge-1-r1.md', 'judge-2-r1.md', 'judge-1-r2.md', 'judge-2-r2.md']) write(path.join(run, 'combine', c, j), JUDGE);
  }
  // c01 は案1が1回目で通り、案2だけを直した。c03 は案2が2回目で通った
  write(path.join(run, 'combine', 'c01', 'ideas-r1.md'), IDEA(2));
  write(path.join(run, 'combine', 'c01', 'passed-ideas.md'), `## 1 案1（通った回：r1）\n${IDEA(1)}`);
  write(path.join(run, 'combine', 'c03', 'ideas-r1.md'), [1, 2].map(IDEA).join('\n'));
  write(path.join(run, 'combine', 'c03', 'passed-ideas.md'), `## 2 案2（通った回：r2）\n${IDEA(2)}`);
  write(path.join(run, 'combine', 'log.md'), LOG_LINES.map(([c, mid, passed]) => LOG(c, mid, passed)).join(''));
  write(path.join(run, 'reflect', 'candidates.md'), '# 候補\n## 候補1 足す 柱3\n### K3-2 外された本質の1文。\n- 例：…\n## 候補2 足す 柱3\n### K3-1 目的と仕組みで書くと、組み合わせやすい。\n- 例：…\n\n外した番号：1\n');
  write(path.join(run, 'combine', 'passed.md'), '1. 案の名前');
  write(path.join(run, 'combine', 'ranked.md'), '1. 案の名前\n- 新しさ：…\n');
  write(path.join(run, 'selection.md'), '1 を選ぶ。新しく、デバッグする人にとても役立つから');
  write(path.join(run, 'explain', '1.md'), '# 説明\n## 誰に、どんなメリットがあるか\n組み込みの開発者が、…\n## 誰が、どの場面で、何に困っているか\n…\n');
  for (const r of [1, 2]) write(path.join(run, 'explain', '1', `reading-${r}-1.md`), '## 1. 言い直し\n…\n## 2. 誰にどんなメリットがあるか\n組み込みの開発者が、…\n');
  write(path.join(run, 'knowledge-used.md'), `# 使った知識・経験\n${[1, 2, 3, 4, 5, 6].map((n) => `## 柱${n}\nなし\n`).join('')}`);
  write(path.join(dataDir, 'knowledge', '3-essence.md'), `# 本質の見極めの知識・経験\n${ITEM(1)}`);

  let g = 0;
  let id = 0;
  let x = 0;
  const calls = [];
  const agent = (type, prompt, group) => {
    id += 1;
    const call = { owner: 'main', id: `a${id}`, name: 'Agent', input: { subagent_type: type, prompt }, group };
    calls.push(call);
    return call;
  };
  /** サブエージェント（owner）か メインのエージェント（'main'）のツールの呼び出し */
  const tool = (owner, name, input) => {
    x += 1;
    const call = { owner, id: `t${x}`, name, input, group: owner === 'main' ? (g += 1) : null };
    calls.push(call);
    return call;
  };
  g += 1;
  calls.push({ owner: 'main', id: 'w1', name: 'Write', input: { file_path: `${run}/state.md` }, group: g });
  // 柱2：計画の役は制限を読む（柱2では読んでよい）
  const plan = agent(T, `役：調べる計画を立てる\n読むファイル：${run}/restriction.md`, (g += 1));
  tool(plan.id, 'Read', { file_path: `${run}/restriction.md` });
  g += 1;
  for (let i = 0; i < 3; i += 1) agent(R, '役：集める', g);
  agent(T, '役：足りないところを見つける', (g += 1));
  g += 1;
  for (let i = 0; i < 3; i += 1) agent(R, '役：集める', g);
  agent(T, '役：一覧を作る', (g += 1));
  agent(R, '役：掘り下げる', (g += 1));
  agent(T, '役：調査のまとめ', (g += 1));
  // 柱3：なぜなぜ分析の役が、自分で whys-*.md を書く（書いた後に読み返すのはよい）
  g += 1;
  const analysts = [agent(T, '役：なぜなぜ分析\n観点：使う人の困りごと', g), agent(T, '役：なぜなぜ分析\n観点：仕組みの原理', g)];
  tool(analysts[0].id, 'Write', { file_path: `${run}/essence/whys-1.md`, content: '…' });
  tool(analysts[0].id, 'Read', { file_path: `${run}/essence/whys-1.md` });
  tool(analysts[1].id, 'Write', { file_path: `${run}/essence/whys-2.md`, content: '…' });
  tool(analysts[1].id, 'Write', { file_path: `${run}/essence/whys-2-2.md`, content: '…' });
  g += 1;
  agent(T, '役：ほかの分析への意見', g);
  agent(T, '役：ほかの分析への意見', g);
  g += 1;
  agent(T, '役：本質の出し直し', g);
  agent(T, '役：本質の出し直し', g);
  agent(T, '役：本質の集約', (g += 1));
  // 柱4：組ごとに、案を作る前に、組の行と選んだ理由を「（判定の前）」で書く
  LOG_LINES.forEach(([c, mid], i) => {
    const before = LOG_LINES.slice(0, i).map(([cc, mm, pp]) => LOG(cc, mm, pp)).join('');
    tool('main', 'Write', { file_path: `${run}/combine/log.md`, content: `${before}${LOG(c, mid, '（判定の前）')}` });
    agent(T, '役：案を作る', (g += 1));
    agent(R, '役：先行例を探す', (g += 1));
    g += 1;
    agent(T, '役：壁打ちの相手（1番の相手は「だめな理由をいちばん強く示す相手」）', g);
    agent(T, '役：壁打ちの相手', g);
    agent(T, '役：案を直す', (g += 1));
    agent(R, '役：先行例を探す', (g += 1));
    g += 1;
    agent(T, '役：壁打ちの相手（1番の相手は「だめな理由をいちばん強く示す相手」）', g);
    agent(T, '役：壁打ちの相手', g);
  });
  agent(T, '役：通った案を比べる', (g += 1));
  g += 1;
  const readers = [agent(D, 'あなたの立場：同じ業務の開発者\n説明の全文：…', g), agent(D, 'あなたの立場：上司\n説明の全文：…', g)];
  calls.push({ owner: readers[0].id, id: 'x1', name: 'TodoWrite', input: {}, group: null });
  // 柱6：振り返りの役は、知識・経験の 1-restriction.md を読んでよい（回の制限のファイルではない）
  g += 1;
  const reflectors = [agent(T, `役：振り返り\n読むファイル：${dataDir}/knowledge/1-restriction.md`, g), agent(T, '役：振り返り', g)];
  tool(reflectors[0].id, 'Read', { file_path: `${dataDir}/knowledge/1-restriction.md` });
  agent(T, '役：知識・経験の候補を作る\n制限の短い名前：組み込みのデバッグ', (g += 1));
  return { dataDir, calls, readers, run, tool };
}

const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => c.id);
/** combine/log.md の組の行のそれぞれに、恩恵を受ける人と選んだ理由の行を足す */
const withReasons = (log) => log.replace(/^(- c\d+｜.*)$/gm, '$1\n  - 恩恵を受ける人：…\n  - 選んだ理由：…');

test('最後まで進んだ回は、すべての採点に合格する', () => {
  const { dataDir, calls } = finishedRun();
  const r = gradeIdeaRun({ dataDir, calls });
  assert.deepEqual(failed(r), []);
  assert.equal(r.ok, true);
});

test('REQ-067 作品の節に「誰にとって恩恵があるのか」がないと落ち、本質に「誰に」「どんなメリットが」がないと落ちる', () => {
  const { dataDir, calls, run } = finishedRun();
  fs.writeFileSync(path.join(run, 'essence', 'whys-2-2.md'), [4, 5, 6].map(WHYS).join('\n').replace(/^- 誰にとって恩恵があるのか.*\n/gm, ''));
  fs.writeFileSync(path.join(run, 'essence', 'index-2.md'), [5, 6].map((n) => ESSENCE(n)).join('\n').replace(/^- どんなメリットが.*\n/gm, ''));
  const r = gradeIdeaRun({ dataDir, calls });
  assert.deepEqual(failed(r), ['essence-whys-benefit', 'essence-benefit']);
  assert.match(r.checks.find((c) => c.id === 'essence-benefit').detail, /E5、E6/);
});

test('REQ-068 案に「誰に」がないと落ち、組に「恩恵を受ける人」がないと落ちる', () => {
  const { dataDir, calls, run } = finishedRun();
  fs.writeFileSync(path.join(run, 'combine', 'c02', 'ideas-r0.md'), IDEA(1) + IDEA(2).replace(/^- 誰に.*\n/m, ''));
  fs.writeFileSync(path.join(run, 'combine', 'log.md'), LOG_LINES.map(([c, mid, passed]) => LOG(c, mid, passed)).join('').replace('  - 恩恵を受ける人：…\n', ''));
  const r = gradeIdeaRun({ dataDir, calls });
  assert.deepEqual(failed(r), ['combine-idea-benefit', 'combine-reason']);
  assert.match(r.checks.find((c) => c.id === 'combine-idea-benefit').detail, /c02：2/);
});

test('REQ-068 通った案を後で直すと落ち、通った組に passed-ideas.md がないと落ちる', () => {
  const { dataDir, calls, run } = finishedRun();
  fs.writeFileSync(path.join(run, 'combine', 'c01', 'ideas-r1.md'), [1, 2].map(IDEA).join('\n'));
  let r = gradeIdeaRun({ dataDir, calls });
  assert.deepEqual(failed(r), ['combine-fixed']);
  assert.match(r.checks.find((c) => c.id === 'combine-fixed').detail, /c01：案 1（r1 で通った）が ideas-r1\.md/);
  fs.writeFileSync(path.join(run, 'combine', 'c01', 'ideas-r1.md'), IDEA(2));
  fs.rmSync(path.join(run, 'combine', 'c03', 'passed-ideas.md'));
  r = gradeIdeaRun({ dataDir, calls });
  assert.deepEqual(failed(r), ['combine-fixed']);
  assert.match(r.checks.find((c) => c.id === 'combine-fixed').detail, /c03：passed-ideas\.md がない/);
});

test('REQ-070 説明の最初の節がメリットでないと落ち、読み手の返事にメリットの1文がないと落ちる', () => {
  const { dataDir, calls, run } = finishedRun();
  fs.writeFileSync(path.join(run, 'explain', '1.md'), '# 説明\n## ひとことで言うと\n3つの形を比べる方法です。\n');
  fs.writeFileSync(path.join(run, 'explain', '1', 'reading-2-1.md'), '## 1. 言い直し\n…\n');
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['explain-benefit-first', 'explain-reader-benefit']);
});

test('REQ-070 読み手がファイルを読むと落ちる', () => {
  const { dataDir, calls, readers } = finishedRun();
  calls.push({ owner: readers[1].id, id: 'x2', name: 'Read', input: { file_path: '/tmp/x' }, group: null });
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['explain-reader-blind']);
});

test('REQ-070 読み手の頼みに回のフォルダの場所があると落ちる', () => {
  const { dataDir, calls, readers } = finishedRun();
  readers[0].input.prompt += `\n${dataDir}/runs/20261027-1000/explain/1/draft-1.md`;
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['explain-reader-prompt']);
});

test('REQ-067 なぜなぜ分析の役がほかの分析を読むと落ちる（自分の分析の読み返しはよい）', () => {
  const { dataDir, calls, run } = finishedRun();
  const analyst = calls.find((c) => c.input?.prompt?.startsWith('役：なぜなぜ分析'));
  calls.push({ owner: analyst.id, id: 'x3', name: 'Read', input: { file_path: `${run}/essence/whys-2.md` }, group: null });
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['essence-independent']);
});

test('REQ-076 クリエイターのツールを呼ぶと落ち、ヒアリングの記録があると落ちる', () => {
  const { dataDir, calls } = finishedRun();
  calls.push({ owner: 'main', id: 'x4', name: 'mcp__plugin-creator__state', input: {}, group: 99 });
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls, hearingState: { stage: 'start' } })), ['separation-tools', 'separation-hearing']);
});

test('REQ-066 集める調査役を同時に起動しないと落ちる', () => {
  const { dataDir, calls } = finishedRun();
  calls.filter((c) => c.input?.prompt === '役：集める').forEach((c, i) => { c.group = 100 + i; });
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['research-parallel']);
});

test('REQ-067 本質が足りないと落ち、REQ-068 組の判定が足りないと落ちる', () => {
  const { dataDir, calls } = finishedRun();
  const run = latestRun(dataDir);
  fs.writeFileSync(path.join(run, 'essence', 'index.md'), `${ESSENCE(1)}${ESSENCE(2)}`);
  fs.rmSync(path.join(run, 'essence', 'index-2.md'));
  fs.rmSync(path.join(run, 'combine', 'c02', 'judge-2-r2.md'));
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['essence-count', 'combine-judges']);
});

test('REQ-071 知識・経験の項目に欠けがあると落ちる', () => {
  const { dataDir, calls } = finishedRun();
  fs.writeFileSync(path.join(dataDir, 'knowledge', '3-essence.md'), `# 本質\n## K3-1 ある本質\n- 例：…\n`);
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['knowledge-items']);
});

test('REQ-072 2回目は、前の回の項目を使った記録がないと落ちる', () => {
  const { dataDir, calls } = finishedRun();
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls, expectKnowledgeUse: true })), ['knowledge-applied']);
  fs.appendFileSync(path.join(latestRun(dataDir), 'knowledge-used.md'), '\n- K3-1 を使い、目的と仕組みで書かせた\n');
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls, expectKnowledgeUse: true })), []);
});

test('make-idea のエージェントのほかを起動すると落ちる', () => {
  const { dataDir, calls } = finishedRun();
  calls.push({ owner: 'main', id: 'x5', name: 'Agent', input: { subagent_type: 'plugin-creator:worker', prompt: '…' }, group: 200 });
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['separation-agents']);
});

test('REQ-067 意見の出し合いのファイルがないと落ちる', () => {
  const { dataDir, calls } = finishedRun();
  for (const a of [1, 2]) fs.rmSync(path.join(latestRun(dataDir), 'essence', `opinion-${a}-r1.md`));
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['essence-opinions']);
});

test('REQ-068 通ったのに数を変える、だめなのに数を変えないと落ちる', () => {
  const { dataDir, calls } = finishedRun();
  const log = path.join(latestRun(dataDir), 'combine', 'log.md');
  fs.writeFileSync(log, withReasons('- c01｜数 2｜E1、E2｜作った案 2｜通った案：1\n- c02｜数 3｜E3、E4、E5｜作った案 2｜通った案：なし\n- c03｜数 3｜E1、E5、E6｜作った案 2｜通った案：2\n'));
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['combine-size']);
});

test('REQ-068 通った案が1つもないと落ちる', () => {
  const { dataDir, calls } = finishedRun();
  const log = path.join(latestRun(dataDir), 'combine', 'log.md');
  fs.writeFileSync(log, withReasons('- c01｜数 2｜E1、E2｜作った案 2｜通った案：なし\n- c02｜数 3｜E3、E4、E5｜作った案 2｜通った案：なし\n- c03｜数 2｜E1、E6｜作った案 2｜通った案：なし\n'));
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['combine-some-passed']);
});

test('REQ-071 外した候補が保存されると落ち、外した番号の答えがないと落ちる', () => {
  const { dataDir, calls } = finishedRun();
  fs.appendFileSync(path.join(dataDir, 'knowledge', '3-essence.md'), `\n${ITEM(2).replace('目的と仕組みで書くと、組み合わせやすい。', '外された本質の1文。')}`);
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['knowledge-excluded']);
  fs.writeFileSync(path.join(latestRun(dataDir), 'reflect', 'candidates.md'), '## 候補1 足す 柱3\n### K3-2 外された本質の1文。\n');
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['knowledge-excluded']);
});

test('REQ-074 データの置き場所の外に書くと落ちる', () => {
  const { dataDir, calls } = finishedRun();
  calls.push({ owner: 'main', id: 'w2', name: 'Write', input: { file_path: '/tmp/work/idea.md' }, group: 300 });
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['data-only']);
});

test('REQ-075 続き：新しい回のフォルダを作ると落ち、続けるかを聞かないと落ちる', () => {
  const { dataDir, calls } = finishedRun();
  const runsBefore = ['20261027-1000'];
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls, resume: { runsBefore, questions: ['20261027-1000 を続けますか？'] } })), []);
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls, resume: { runsBefore, questions: ['制限は？'] } })), ['resume']);
  fs.mkdirSync(path.join(dataDir, 'runs', '20261027-1100'));
  fs.cpSync(path.join(dataDir, 'runs', '20261027-1000'), path.join(dataDir, 'runs', '20261027-1100'), { recursive: true });
  assert.ok(failed(gradeIdeaRun({ dataDir, calls, resume: { runsBefore, questions: ['続けますか？'] } })).includes('resume'));
});

test('REQ-075 続きの試験では、止まった柱より前の呼び出しを採点しない', () => {
  const { dataDir } = finishedRun();
  const r = gradeIdeaRun({ dataDir, calls: [], resume: { runsBefore: ['20261027-1000'], questions: ['続けますか？'], fromPillar: 5 } });
  assert.deepEqual(failed(r), ['explain-readers']);
});

test('REQ-065 制限に前の版の項目があると落ち、目的か範囲の見出しがないと落ちる', () => {
  const { dataDir, calls, run } = finishedRun();
  // 範囲の下の小見出しは、範囲の中身として見る
  fs.appendFileSync(path.join(run, 'restriction.md'), '### 対象の仕事\n組み込みの開発\n### 環境\nWindows\n');
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), []);
  fs.appendFileSync(path.join(run, 'restriction.md'), '## 必ず満たす条件\n- Windows で動く\n');
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['restriction-items']);
  fs.writeFileSync(path.join(run, 'restriction.md'), '# 制限\n## 目的\nデバッグの手間を減らす\n');
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['restriction-items']);
});

test('REQ-065 柱3から後の役の頼みに restriction.md があると落ち、その役が読むと落ちる（柱2の役はよい）', () => {
  const told = finishedRun();
  told.calls.find((c) => c.input?.prompt === '役：先行例を探す').input.prompt += `\n読むファイル：${told.run}/restriction.md`;
  assert.deepEqual(failed(gradeIdeaRun({ dataDir: told.dataDir, calls: told.calls })), ['restriction-later']);
  for (const [prompt, name, input] of [['役：壁打ちの相手', 'Read', { file_path: 'restriction.md' }], ['役：振り返り', 'Bash', { command: 'cat restriction.md' }]]) {
    const { dataDir, calls, run, tool } = finishedRun();
    tool(calls.find((c) => c.input?.prompt?.startsWith(prompt)).id, name, Object.fromEntries(Object.entries(input).map(([k, v]) => [k, v.replace('restriction.md', `${run}/restriction.md`)])));
    assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['restriction-later'], prompt);
  }
  // 「役「〇〇」として」と書いた頼みも、柱3から後の役として見る
  const fix = finishedRun();
  fix.calls.find((c) => c.input?.prompt === '役：案を直す').input.prompt = `役「案を直す」として、案を直す。\n読むファイル：${fix.run}/restriction.md`;
  assert.deepEqual(failed(gradeIdeaRun({ dataDir: fix.dataDir, calls: fix.calls })), ['restriction-later']);
  const reader = finishedRun();
  reader.tool(reader.readers[1].id, 'Read', { file_path: `${reader.run}/restriction.md` });
  assert.deepEqual(failed(gradeIdeaRun({ dataDir: reader.dataDir, calls: reader.calls })), ['restriction-later', 'explain-reader-blind']);
});

test('REQ-066 計画、調べ直し、まとめのファイルがないと落ちる', () => {
  const { dataDir, calls, run } = finishedRun();
  for (const f of ['plan.md', 'gaps-r1.md', 'overview.md']) fs.rmSync(path.join(run, 'research', f));
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['research-plan', 'research-rounds', 'research-overview']);
  const other = finishedRun();
  fs.renameSync(path.join(other.run, 'research', 'gaps-r1.md'), path.join(other.run, 'research', 'gaps-r1-2.md'));
  fs.rmSync(path.join(other.run, 'research', 'collect-1-r1.md'));
  const r = gradeIdeaRun({ dataDir: other.dataDir, calls: other.calls });
  assert.deepEqual(failed(r), ['research-rounds']);
  assert.match(r.checks.find((c) => c.id === 'research-rounds').detail, /collect-\*-r1\.md/);
});

test('REQ-066 評価が「あり」の作品を掘り下げていないと落ち、情報源の URL が足りないと落ちる', () => {
  const { dataDir, calls, run } = finishedRun();
  fs.writeFileSync(path.join(run, 'research', 'deep-2.md'), `${DEEP(4)}\n## 5 作品5\n- URL：https://example.com/w5\n- 読んだ情報源：https://example.com/w5\n`);
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['research-deep', 'research-sources']);
  // 分けたファイル（deep-2-2.md）の節も、同じ番号の節の続きも数える
  fs.writeFileSync(path.join(run, 'research', 'deep-2-2.md'), `${DEEP(6)}\n## 5 作品5（続き）\n- 読んだ情報源：https://review.example.org/w5\n`);
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), []);
});

test('REQ-066 state.md に柱2の時刻と読んだページの数がないと落ち、書いた記録にあればよい', () => {
  const { dataDir, calls, run, tool } = finishedRun();
  fs.writeFileSync(path.join(run, 'state.md'), '# 状態\n- 状態：終わり\n- 今の柱：6 知識・経験の蓄積\n');
  const r = gradeIdeaRun({ dataDir, calls });
  assert.deepEqual(failed(r), ['research-time']);
  assert.match(r.checks.find((c) => c.id === 'research-time').detail, /柱2の始め.*柱2の終わり.*読んだページ/);
  tool('main', 'Edit', { file_path: `${run}/state.md`, old_string: '- 今の柱：2', new_string: '- 柱2の始め：10:05\n- 柱2の終わり：11:20\n- 読んだページ：64\n- 今の柱：3' });
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), []);
});

test('REQ-067 メインのエージェントが whys・final を書くと落ち、分析役が書いていない whys があると落ちる', () => {
  const main = finishedRun();
  main.tool('main', 'Write', { file_path: `${main.run}/essence/final-1.md`, content: '…' });
  assert.deepEqual(failed(gradeIdeaRun({ dataDir: main.dataDir, calls: main.calls })), ['essence-writer']);
  const { dataDir, calls } = finishedRun();
  const rest = calls.filter((c) => !String(c.input?.file_path ?? '').endsWith('whys-2-2.md'));
  const r = gradeIdeaRun({ dataDir, calls: rest });
  assert.deepEqual(failed(r), ['essence-writer']);
  assert.match(r.checks.find((c) => c.id === 'essence-writer').detail, /whys-2-2\.md/);
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls: rest, resume: { runsBefore: [RUN], questions: ['続けますか？'], fromPillar: 4 } })), []);
});

test('REQ-067 作品の節に「なぜ評価されているのか」がないと落ち、本質の「なぜ」の連なりが短いと落ちる', () => {
  const { dataDir, calls, run } = finishedRun();
  fs.appendFileSync(path.join(run, 'essence', 'whys-2-2.md'), '\n## 7 作品7\n- なぜこの形なのか → 答え → 原理\n');
  fs.writeFileSync(path.join(run, 'essence', 'index-2.md'), `${ESSENCE(5, '5 なぜ評価されているのか → 答え')}${ESSENCE(6).replace(/^- なぜ：.*\n/m, '')}`);
  const r = gradeIdeaRun({ dataDir, calls });
  assert.deepEqual(failed(r), ['essence-why-chain', 'essence-whys-first', 'essence-whys-benefit']);
  assert.equal(r.checks.find((c) => c.id === 'essence-why-chain').detail, '足りない本質：E5、E6');
  assert.equal(r.checks.find((c) => c.id === 'essence-whys-first').detail, 'ない節：whys-2-2.md 7');
  // 「なぜ評価されているか」「誰にとって恩恵があるか」と書いた節もよい
  fs.appendFileSync(path.join(run, 'essence', 'whys-2-2.md'), '- なぜ評価されているか → 「…」（7）→ 困りごと\n- 誰にとって恩恵があるか → 開発者（7）\n');
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['essence-why-chain']);
});

test('REQ-067 まとまりに分けた分析（whys-c01-a1.md）は、まとまりごとの観点の数で数える', () => {
  const { dataDir, run } = finishedRun();
  const dir = path.join(run, 'essence');
  for (const n of fs.readdirSync(dir).filter((x) => /^(whys|opinion|final)-/.test(x))) fs.rmSync(path.join(dir, n));
  for (const c of ['c01', 'c02']) {
    for (const a of ['a1', 'a2']) {
      write(path.join(dir, `whys-${c}-${a}.md`), `# なぜなぜ分析\n${[1, 2].map(WHYS).join('\n')}`);
      write(path.join(dir, `opinion-${c}-${a}-r1.md`), '意見');
      write(path.join(dir, `final-${c}-${a}.md`), '出し直し');
    }
  }
  write(path.join(dir, 'whys-c01-a1-2.md'), WHYS(3));
  const ok = (id) => gradeIdeaRun({ dataDir, calls: [] }).checks.find((c) => c.id === id);
  assert.equal(ok('essence-agents').ok, true);
  assert.equal(ok('essence-agents').detail, '分析 2、出し直し 2');
  assert.equal(ok('essence-whys-first').ok, true);
  fs.rmSync(path.join(dir, 'whys-c02-a2.md'));
  assert.equal(ok('essence-agents').ok, false);
});

test('REQ-068 選んだ理由の行がないと落ち、判定の前に書いた記録がないと落ちる', () => {
  const { dataDir, calls, run } = finishedRun();
  const log = path.join(run, 'combine', 'log.md');
  fs.writeFileSync(log, fs.readFileSync(log, 'utf8').replace(/(c02.*\n  - 恩恵を受ける人：…\n)  - 選んだ理由：…\n/, '$1'));
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['combine-reason']);
  const other = finishedRun();
  const rest = other.calls.filter((c) => !(c.name === 'Write' && /c02｜[^\n]*（判定の前）/.test(c.input?.content ?? '')));
  assert.deepEqual(failed(gradeIdeaRun({ dataDir: other.dataDir, calls: rest })), ['combine-reason-first']);
  // シェルで log.md に書いた記録でもよい
  const bash = { owner: 'main', id: 'b1', name: 'Bash', input: { command: "cat >> combine/log.md <<'EOF'\n- c02｜数 3｜E1、E2、E3｜作った案 10｜通った案：（判定の前）\nEOF" }, group: 'gb' };
  assert.deepEqual(failed(gradeIdeaRun({ dataDir: other.dataDir, calls: [...rest, bash] })), []);
  // combine に cd してから log.md に書いた記録でもよい（3回目の試行の書き方）
  const cdBash = { owner: 'main', id: 'b2', name: 'Bash', input: { command: "R=$HOME/.plugin-creator/make-idea/runs/x; cd $R/combine; cat >> log.md <<'EOF'\n- c02｜波 1｜数 3｜E1、E2、E3｜作った案 10｜通った案：（判定の前）\nEOF" }, group: 'gc' };
  assert.deepEqual(failed(gradeIdeaRun({ dataDir: other.dataDir, calls: [...rest, cdBash] })), []);
  // combine と関係のない log.md（ほかのフォルダ）は数えない
  const otherLog = { owner: 'main', id: 'b3', name: 'Bash', input: { command: "cat >> /tmp/x/build.log.md <<'EOF'\n- c02｜（判定の前）\nEOF" }, group: 'gd' };
  assert.deepEqual(failed(gradeIdeaRun({ dataDir: other.dataDir, calls: [...rest, otherLog] })), ['combine-reason-first']);
  // Edit で書き直したときも、書いた文に「（判定の前）」があればよい
  rest.push({ owner: 'main', id: 'e1', name: 'Edit', input: { file_path: `${other.run}/combine/log.md`, old_string: 'x', new_string: '- c02｜数 2｜E3、E4｜作った案 2｜通った案：（判定の前）\n  - 選んだ理由：…' }, group: 400 });
  assert.deepEqual(failed(gradeIdeaRun({ dataDir: other.dataDir, calls: rest })), []);
});

test('REQ-068 先行例の検索語がないと落ち、判定に3つの観点がないと落ちる', () => {
  const { dataDir, calls, run } = finishedRun();
  fs.rmSync(path.join(run, 'combine', 'c02', 'prior-r1.md'));
  fs.writeFileSync(path.join(run, 'combine', 'c03', 'judge-2-r2.md'), '- 1 通す\n  - 新しさ：…\n  - 役立つか：…\n通す：1\n');
  const r = gradeIdeaRun({ dataDir, calls });
  assert.deepEqual(failed(r), ['combine-judge-views', 'combine-prior', 'combine-prior-patent']);
  assert.equal(r.checks.find((c) => c.id === 'combine-judge-views').detail, 'ない判定：c03/judge-2-r2');
  // 分けたファイル（-2）の続きに観点があればよい
  fs.writeFileSync(path.join(run, 'combine', 'c03', 'judge-2-r2-2.md'), '  - 価値：…\n');
  fs.writeFileSync(path.join(run, 'combine', 'c02', 'prior-r1.md'), '## 1 案\n見つからなかった\n');
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['combine-prior', 'combine-prior-patent']);
  // 検索語はあるが特許を探していないと、特許の採点だけ落ちる
  fs.writeFileSync(path.join(run, 'combine', 'c02', 'prior-r1.md'), '## 1 案\n- 検索語：…\n- 論文：見つからなかった\n');
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['combine-prior-patent']);
});

test('REQ-068 判定の回が往復の上限を超えると落ち、途中の回の相手が足りないと落ちる', () => {
  const { dataDir, calls, run } = finishedRun();
  for (const j of ['judge-1-r3.md', 'judge-2-r3.md']) fs.writeFileSync(path.join(run, 'combine', 'c01', j), JUDGE);
  const r = gradeIdeaRun({ dataDir, calls });
  assert.deepEqual(failed(r), ['combine-judges']);
  assert.match(r.checks.find((c) => c.id === 'combine-judges').detail, /c01：r3 は上限を超える/);
  const other = finishedRun();
  fs.rmSync(path.join(other.run, 'combine', 'c03', 'judge-1-r1.md'));
  fs.writeFileSync(path.join(other.run, 'combine', 'c03', 'judge-2-r1-2.md'), JUDGE);
  assert.deepEqual(failed(gradeIdeaRun({ dataDir: other.dataDir, calls: other.calls })), ['combine-judges']);
});

test('REQ-068 先行例を探す役がないと落ち、案を作る役が壁打ちの相手を兼ねると落ちる', () => {
  const { dataDir, calls } = finishedRun();
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls: calls.filter((c) => c.input?.prompt !== '役：先行例を探す') })), ['combine-separate']);
  calls.find((c) => c.input?.prompt === '役：壁打ちの相手').input.prompt = '役：案を作る\n役：壁打ちの相手';
  const r = gradeIdeaRun({ dataDir, calls });
  assert.deepEqual(failed(r), ['combine-separate']);
  assert.match(r.checks.find((c) => c.id === 'combine-separate').detail, /兼ねた起動 1/);
});

test('REQ-069 通った案を比べた ranked.md がないと落ちる', () => {
  const { dataDir, calls, run } = finishedRun();
  fs.rmSync(path.join(run, 'combine', 'ranked.md'));
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['combine-ranked']);
});

test('部品：一覧の行、作品の節、本質の項目、判定の回、選んだ理由、記録する入力', () => {
  assert.deepEqual(indexItems('# 一覧\n- 1 | A | https://a | OSS | 評価：あり | スター\n- 2 | B | https://b | 論文 | 評価: 未確認 | 引用\n12 | C | https://c | 製品 | 評価：なし | -\n'), [{ n: 1, rating: 'あり' }, { n: 2, rating: '未確認' }, { n: 12, rating: 'なし' }]);
  assert.deepEqual(workSections('# 掘り下げ\n## 3 A\n- x\n### 小見出し\n## 本質\n## 10 B\n').map((s) => s.n), [3, 10]);
  assert.deepEqual(essenceEntries('## E1 A\n- なぜ：1 → 2 → 3\n## E2 B\n- 目的：…\n### E3 C\n- **なぜ**：4 → 5 → 6\n').map((e) => [e.id, e.why]), [['E1', '1 → 2 → 3'], ['E2', null], ['E3', '4 → 5 → 6']]);
  assert.deepEqual(indexItems('- 3 | C | https://c | OSS | 評価：**あり** | スター\n- 4 | D | https://d | OSS | **評価**：未確認 | -\n').map((i) => i.rating), ['あり', '未確認']);
  const rounds = judgeRounds(['judge-1-r1.md', 'judge-2-r1.md', 'judge-2-r1-2.md', 'judge-1-r2.md', 'ideas.md']);
  assert.deepEqual([...rounds].map(([k, s]) => [k, [...s]]), [[1, ['1', '2']], [2, ['1']]]);
  assert.deepEqual([...comboReasons('- c01｜数 2｜E1、E2｜作った案 2｜通った案：1\n  - 選んだ理由：…\n- c02｜数 2｜E3、E4｜作った案 2｜通った案：なし\n')], ['c01']);
  const long = 'あ'.repeat(400);
  assert.equal(recordedInput({ file_path: '/h/runs/1/combine/log.md', content: long }).content, long);
  assert.equal(recordedInput({ file_path: '/h/runs/1/combine/passed.md', content: long }).content.length, 301);
  assert.equal(recordedInput({ file_path: 'C:\\h\\runs\\1\\combine\\log.md', content: long }).content, long);
  assert.equal(recordedInput({ file_path: '/h/runs/1/state.md', content: long }).content, long);
  assert.equal(recordedInput({ file_path: '/h/runs/1/selection.md', content: long }).content.length, 301);
});

test('部品：組の行、数の移り方、候補と外した番号、今の柱', () => {
  const lines = comboLines('- c01｜数 3｜E1、E2、E3｜作った案 10｜通った案：1、4\n- c02｜数 3｜E4、E5、E6｜作った案 10｜通った案：なし\n');
  assert.deepEqual(lines.map((l) => [l.combo, l.size, l.essences, l.made, l.passed]), [['c01', 3, 3, 10, true], ['c02', 3, 3, 10, false]]);
  const seq = (sizes, passed) => sizes.map((size, i) => ({ combo: `c${i}`, size, essences: size, passed: passed[i] }));
  assert.deepEqual(sizeSequenceProblems(seq([3, 3, 3, 3, 4, 4, 4, 2], [false, false, false, false, false, false, false, true]), [3, 4, 2], 3), ['c3：数 3（決まりでは 4）', 'c4：数 4（決まりでは 3）']); // 食い違いの後は、実際の数から数え直す
  assert.deepEqual(sizeSequenceProblems(seq([3, 3, 3, 4, 4, 4, 2, 2, 2, 3], [false, false, false, false, false, false, false, false, false, true]), [3, 4, 2], 3), []);
  assert.deepEqual(sizeSequenceProblems(seq([3, 3, 3], [true, false, true]), [3, 4, 2], 3), []);
  // 波：同じ波の組は同じ数。次の波の数は、前の波の結果を順にたどって決める
  const waved = (sizes, passed, waves) => seq(sizes, passed).map((l, i) => ({ ...l, wave: waves[i] }));
  assert.deepEqual(sizeSequenceProblems(waved([3, 3, 3, 4, 4], [false, false, false, true, false], [1, 1, 1, 2, 2]), [3, 4, 2], 3), []);
  // 波の中で数が違う組と、3つだめだった次の波で数を変えない組は落ちる
  assert.deepEqual(sizeSequenceProblems(waved([3, 3, 4, 3], [false, false, false, true], [1, 1, 1, 2]), [3, 4, 2], 3), ['c2：数 4（決まりでは 3）', 'c3：数 3（決まりでは 4）']);
  assert.deepEqual(comboLines('- c01｜波 2｜数 3｜E1、E2、E3｜作った案 10｜通った案：1')[0].wave, 2);
  assert.equal(comboLines('- c01｜数 3｜E1、E2、E3｜作った案 10｜通った案：1')[0].wave, null);
  const c = candidatesOf('## 候補1 足す 柱2\n### K2-3 文A。\n## 候補2 消す 柱4\nK4-1 を消す\n外した番号：1、3\n');
  assert.deepEqual(c.candidates.map((x) => [x.n, x.op, x.sentence]), [[1, '足す', '文A。'], [2, '消す', null]]);
  assert.deepEqual(c.excluded, [1, 3]);
  assert.deepEqual(candidatesOf('外した番号：なし').excluded, []);
  const { dataDir } = finishedRun();
  assert.equal(currentPillar(dataDir), 6);
  assert.equal(isFinished(dataDir, { runsBefore: ['20261027-1000'] }), false);
  assert.equal(isFinished(dataDir, { runsBefore: ['20261027-1000'], resume: true }), true);
});

test('部品：URL、本質の番号、知識・経験の項目、同時の数、終わりの見分け', () => {
  assert.equal(uniqueUrls('a https://x.com/a, b https://x.com/a。 c https://y.org/b|').size, 2);
  assert.deepEqual([...uniqueUrls('https://x.com/a、https://y.org/b，https://z.net/c（https://w.io/d）')], ['https://x.com/a', 'https://y.org/b', 'https://z.net/c', 'https://w.io/d']);
  assert.deepEqual([...essenceIds('E1 と E12、E1')], ['E1', 'E12']);
  assert.deepEqual(knowledgeItems(ITEM(1)).map((i) => i.missing), [[]]);
  assert.deepEqual(knowledgeItems('## K1-2 文\n- 例：a\n').map((i) => i.missing), [['出典', '制限', '得た日', '確かさ']]);
  const calls = [{ owner: 'main', name: 'Agent', input: { subagent_type: R, prompt: '役：集める' }, group: 1 }, { owner: 'main', name: 'Agent', input: { subagent_type: R, prompt: '役：集める' }, group: 1 }];
  assert.equal(maxParallel(calls, R, /集める/), 2);
  const { dataDir } = finishedRun();
  assert.equal(isFinished(dataDir), true);
});

test('小さなパラメーターは、既定のパラメーターと同じ項目で、値の扱いの決まりに合う（REQ-073）', () => {
  const defaults = JSON.parse(fs.readFileSync(path.join(REPO, 'skills', 'make-idea', 'assets', 'params.json'), 'utf8'));
  const keys = (p) => Object.entries(p).filter(([, v]) => typeof v === 'object').flatMap(([g, v]) => Object.keys(v).map((k) => `${g}/${k}`)).sort();
  assert.deepEqual(keys(SMALL_PARAMS), keys(defaults));
  const size = SMALL_PARAMS.本質の掛け合わせ.一度に掛け合わせる本質の数;
  assert.ok(size.最小 >= 2 && size.最小 <= size.最大);
  assert.ok(SMALL_PARAMS.本質の見極め.本質の数 >= size.最大);
  for (const n of SMALL_PARAMS.本質の掛け合わせ.掛け合わせる数を変える順) assert.ok(n >= size.最小 && n <= size.最大);
  for (const v of [SMALL_PARAMS.本質の見極め.なぜなぜ分析をするエージェントの数, SMALL_PARAMS.本質の掛け合わせ.壁打ちの相手のエージェントの数, SMALL_PARAMS.アイデアの説明.説明を読む第三者のエージェントの数, SMALL_PARAMS.知識・経験の蓄積.振り返りのエージェントの数]) assert.ok(v >= 2);
  assert.ok(SMALL_PARAMS.徹底的な事前調査['1体が掘り下げる作品の数'] <= 20);
  assert.ok(SMALL_PARAMS.アイデアの説明.選ぶ一覧で詳しく示す案の数 >= SMALL_PARAMS.アイデアの説明.説明するアイデアの数の上限);
  assert.ok(SMALL_PARAMS.知識・経験の蓄積['まとめ始める大きさの割合（%）'] <= 100);
  const numbers = Object.values(SMALL_PARAMS).filter((v) => typeof v === 'object').flatMap((v) => Object.values(v)).flatMap((v) => (typeof v === 'object' ? Object.values(v) : [v]));
  for (const n of numbers) assert.ok(Number.isInteger(n) && n >= 1, String(n));
});

test('ユーザー役への指示に、制限と答え方の決まりが入る', () => {
  const system = buildIdeaUserSystem('対象は組み込みの開発');
  assert.match(system, /対象は組み込みの開発/);
  assert.match(system, /続けて/);
  assert.match(system, /特に決まっていません/);
  assert.doesNotMatch(system, /1番を外す/);
  assert.match(buildIdeaUserSystem('x', { excludeFirst: true }), /1番を外す/);
});

test('REQ-069 ユーザー役は、制限ではなく、新しさ・役立つか・価値で説明するアイデアを選ぶ', () => {
  const rule = IDEA_USER_RULES.find((r) => /説明してほしいアイデアを選ぶ/.test(r));
  assert.match(rule, /新しさ/);
  assert.match(rule, /役立つ/);
  assert.match(rule, /価値/);
  assert.match(rule, /番号/);
  assert.doesNotMatch(rule, /制限/);
});

test('部品：本質の誰に・メリット、案の型、通った案、説明の最初の節', () => {
  assert.deepEqual(essenceEntries('## E1 A\n- **誰に**：開発者\n- どんなメリットが：手間が減る\n- なぜ：1 → 2 → 3\n').map((e) => [e.who, e.benefit]), [['開発者', '手間が減る']]);
  assert.deepEqual(ideaEntries('## 1 案\n- 誰に：a\n- どんなメリット：b\n## 2 案\n- 誰に：c\n'), [{ n: 1, who: 'a', benefit: 'b' }, { n: 2, who: 'c', benefit: null }]);
  assert.deepEqual(passedIdeas('## 6 名前（通った回：r3）\n本文\n## 2 x（通った回: r1）\n## 3 通っていない\n'), [{ n: 6, round: 3 }, { n: 2, round: 1 }]);
  assert.equal(firstSection('# 題\n本文\n### 小見出し\n## 誰に、どんなメリットがあるか\n…\n## 次\n'), '誰に、どんなメリットがあるか');
  assert.equal(firstSection('# 題だけ'), '');
});
