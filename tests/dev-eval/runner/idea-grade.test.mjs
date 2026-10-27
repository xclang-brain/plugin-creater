// アイデア創出スキルの流れの試験の採点（idea-grade.mjs）と入口の部品（idea.mjs）の試験（アイデア創出の設計 7章）。モデルは使わない。
// 小さなパラメーターで「最後まで進んだ回」のデータと呼び出しの一覧を作り、合格することと、壊したところで落ちることを確かめる。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { essenceIds, gradeIdeaRun, knowledgeItems, latestRun, maxParallel, uniqueUrls } from './idea-grade.mjs';
import { buildIdeaUserSystem, isFinished, prepareData, SMALL_PARAMS } from './idea.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const R = 'plugin-creator:idea-researcher';
const T = 'plugin-creator:idea-thinker';
const D = 'plugin-creator:idea-reader';

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const ITEM = (n) => `## K3-${n} 目的と仕組みで書くと、組み合わせやすい。\n- 例：本質 E1 と E2\n- 出典：runs/20261027-1000/essence/index.md\n- 制限：分野を問わない\n- 得た日：2026-10-27\n- 確かさ：ユーザーが確かめた\n`;

/** 小さなパラメーターで最後まで進んだ回（データと呼び出し）を作る */
function finishedRun() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-grade-'));
  prepareData(dataDir, { params: 'small' });
  const run = path.join(dataDir, 'runs', '20261027-1000');
  write(path.join(run, 'state.md'), '# 状態\n- 状態：終わり\n- 今の柱：6 知識・経験の蓄積\n');
  write(path.join(run, 'restriction.md'), '# 制限\n- 短い名前：組み込みのデバッグ\n');
  write(path.join(run, 'research', 'index.md'), Array.from({ length: 12 }, (_, i) => `${i + 1}. 作品${i} | https://example.com/w${i} | 説明`).join('\n'));
  write(path.join(run, 'research', 'deep-1.md'), Array.from({ length: 6 }, (_, i) => `## ${i + 1} 作品${i}\n- URL：https://example.com/w${i}\n`).join('\n'));
  write(path.join(run, 'essence', 'index.md'), Array.from({ length: 6 }, (_, i) => `- E${i + 1} 目的：… 仕組み：…`).join('\n'));
  for (const a of [1, 2]) {
    write(path.join(run, 'essence', `analysis-${a}.md`), '分析');
    write(path.join(run, 'essence', `final-${a}.md`), '出し直し');
    write(path.join(run, 'reflect', `reflection-${a}.md`), '振り返り');
  }
  for (const c of ['c01', 'c02']) {
    write(path.join(run, 'combine', c, 'ideas-r0.md'), '案');
    for (const j of ['judge-1-r1.md', 'judge-2-r1.md', 'judge-1-r2.md', 'judge-2-r2.md']) write(path.join(run, 'combine', c, j), '判定');
  }
  write(path.join(run, 'combine', 'log.md'), '- c01：E1、E2（数 2）通った案：1\n- c02：E3、E4、E5（数 3）通った案：なし\n');
  write(path.join(run, 'combine', 'passed.md'), '1. 案の名前');
  write(path.join(run, 'selection.md'), '1 を選ぶ。デバッグに効くから');
  write(path.join(run, 'explain', '1.md'), '# 説明');
  write(path.join(run, 'knowledge-used.md'), `# 使った知識・経験\n${[1, 2, 3, 4, 5, 6].map((n) => `## 柱${n}\nなし\n`).join('')}`);
  write(path.join(dataDir, 'knowledge', '3-essence.md'), `# 本質の見極めの知識・経験\n${ITEM(1)}`);

  let g = 0;
  let id = 0;
  const calls = [];
  const agent = (type, prompt, group) => {
    id += 1;
    const call = { owner: 'main', id: `a${id}`, name: 'Agent', input: { subagent_type: type, prompt }, group };
    calls.push(call);
    return call;
  };
  g += 1;
  for (let i = 0; i < 3; i += 1) agent(R, '役：集める', g);
  agent(T, '役：一覧を作る', (g += 1));
  agent(R, '役：掘り下げる', (g += 1));
  g += 1;
  agent(T, '役：なぜなぜ分析', g);
  agent(T, '役：なぜなぜ分析', g);
  g += 1;
  agent(T, '役：ほかの分析への意見', g);
  agent(T, '役：ほかの分析への意見', g);
  for (let c = 0; c < 2; c += 1) {
    agent(T, '役：案を作る', (g += 1));
    g += 1;
    agent(T, '役：壁打ちの相手', g);
    agent(T, '役：壁打ちの相手', g);
    agent(T, '役：案を直す', (g += 1));
    g += 1;
    agent(T, '役：壁打ちの相手', g);
    agent(T, '役：壁打ちの相手', g);
  }
  g += 1;
  const readers = [agent(D, 'あなたの立場：同じ業務の開発者\n説明の全文：…', g), agent(D, 'あなたの立場：上司\n説明の全文：…', g)];
  calls.push({ owner: readers[0].id, id: 'x1', name: 'TodoWrite', input: {}, group: null });
  return { dataDir, calls, readers };
}

const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => c.id);

test('最後まで進んだ回は、すべての採点に合格する', () => {
  const { dataDir, calls } = finishedRun();
  const r = gradeIdeaRun({ dataDir, calls });
  assert.deepEqual(failed(r), []);
  assert.equal(r.ok, true);
});

test('REQ-059 読み手がファイルを読むと落ちる', () => {
  const { dataDir, calls, readers } = finishedRun();
  calls.push({ owner: readers[1].id, id: 'x2', name: 'Read', input: { file_path: '/tmp/x' }, group: null });
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['explain-reader-blind']);
});

test('REQ-059 読み手の頼みに回のフォルダの場所があると落ちる', () => {
  const { dataDir, calls, readers } = finishedRun();
  readers[0].input.prompt += `\n${dataDir}/runs/20261027-1000/explain/1/draft-1.md`;
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['explain-reader-prompt']);
});

test('REQ-056 なぜなぜ分析の役がほかの分析を読むと落ちる', () => {
  const { dataDir, calls } = finishedRun();
  const analyst = calls.find((c) => c.input?.prompt === '役：なぜなぜ分析');
  calls.push({ owner: analyst.id, id: 'x3', name: 'Read', input: { file_path: `${dataDir}/runs/20261027-1000/essence/analysis-2.md` }, group: null });
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['essence-independent']);
});

test('REQ-065 クリエイターのツールを呼ぶと落ち、ヒアリングの記録があると落ちる', () => {
  const { dataDir, calls } = finishedRun();
  calls.push({ owner: 'main', id: 'x4', name: 'mcp__plugin-creator__state', input: {}, group: 99 });
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls, hearingState: { stage: 'start' } })), ['separation-tools', 'separation-hearing']);
});

test('REQ-055 集める調査役を同時に起動しないと落ちる', () => {
  const { dataDir, calls } = finishedRun();
  calls.filter((c) => c.input?.prompt === '役：集める').forEach((c, i) => { c.group = 100 + i; });
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['research-parallel']);
});

test('REQ-056 本質が足りないと落ち、REQ-057 組の判定が足りないと落ちる', () => {
  const { dataDir, calls } = finishedRun();
  const run = latestRun(dataDir);
  fs.writeFileSync(path.join(run, 'essence', 'index.md'), '- E1\n- E2\n');
  fs.rmSync(path.join(run, 'combine', 'c02', 'judge-2-r2.md'));
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['essence-count', 'combine-judges']);
});

test('REQ-060 知識・経験の項目に欠けがあると落ちる', () => {
  const { dataDir, calls } = finishedRun();
  fs.writeFileSync(path.join(dataDir, 'knowledge', '3-essence.md'), `# 本質\n## K3-1 ある本質\n- 例：…\n`);
  assert.deepEqual(failed(gradeIdeaRun({ dataDir, calls })), ['knowledge-items']);
});

test('REQ-061 2回目は、前の回の項目を使った記録がないと落ちる', () => {
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

test('部品：URL、本質の番号、知識・経験の項目、同時の数、終わりの見分け', () => {
  assert.equal(uniqueUrls('a https://x.com/a, b https://x.com/a。 c https://y.org/b|').size, 2);
  assert.deepEqual([...essenceIds('E1 と E12、E1')], ['E1', 'E12']);
  assert.deepEqual(knowledgeItems(ITEM(1)).map((i) => i.missing), [[]]);
  assert.deepEqual(knowledgeItems('## K1-2 文\n- 例：a\n').map((i) => i.missing), [['出典', '制限', '得た日', '確かさ']]);
  const calls = [{ owner: 'main', name: 'Agent', input: { subagent_type: R, prompt: '役：集める' }, group: 1 }, { owner: 'main', name: 'Agent', input: { subagent_type: R, prompt: '役：集める' }, group: 1 }];
  assert.equal(maxParallel(calls, R, /集める/), 2);
  const { dataDir } = finishedRun();
  assert.equal(isFinished(dataDir), true);
});

test('小さなパラメーターは、既定のパラメーターと同じ項目で、値の扱いの決まりに合う（REQ-062）', () => {
  const defaults = JSON.parse(fs.readFileSync(path.join(REPO, 'skills', 'make-idea', 'assets', 'params.json'), 'utf8'));
  const keys = (p) => Object.entries(p).filter(([, v]) => typeof v === 'object').flatMap(([g, v]) => Object.keys(v).map((k) => `${g}/${k}`)).sort();
  assert.deepEqual(keys(SMALL_PARAMS), keys(defaults));
  const size = SMALL_PARAMS.本質の掛け合わせ.一度に掛け合わせる本質の数;
  assert.ok(size.最小 >= 2 && size.最小 <= size.最大);
  assert.ok(SMALL_PARAMS.本質の見極め.本質の数 >= size.最大);
  for (const n of SMALL_PARAMS.本質の掛け合わせ.掛け合わせる数を変える順) assert.ok(n >= size.最小 && n <= size.最大);
  for (const v of [SMALL_PARAMS.本質の見極め.なぜなぜ分析をするエージェントの数, SMALL_PARAMS.本質の掛け合わせ.壁打ちの相手のエージェントの数, SMALL_PARAMS.アイデアの説明.説明を読む第三者のエージェントの数, SMALL_PARAMS.知識・経験の蓄積.振り返りのエージェントの数]) assert.ok(v >= 2);
});

test('ユーザー役への指示に、制限と答え方の決まりが入る', () => {
  const system = buildIdeaUserSystem('対象は組み込みの開発');
  assert.match(system, /対象は組み込みの開発/);
  assert.match(system, /続けて/);
  assert.match(system, /特に決まっていません/);
});
