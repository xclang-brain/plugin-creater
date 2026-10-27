// アイデア創出スキル（make-idea）の流れの試験の採点（アイデア創出の設計 7.1）。モデルを使わない。
// 入力は、データの置き場所（<ホーム>/.plugin-creator/make-idea）と、試験の入口（idea.mjs）が記録した呼び出しの一覧。
//
// 呼び出し（calls）の形：{ owner: 'main' か Agent の呼び出しの番号, id, name, input, group }
//   group は、メインのエージェントの1つの応答（assistant のメッセージ）の番号。同じ group の Agent は、同時に起動されたもの。

import fs from 'node:fs';
import path from 'node:path';

export const AGENT = Object.freeze({
  researcher: 'plugin-creator:idea-researcher',
  thinker: 'plugin-creator:idea-thinker',
  reader: 'plugin-creator:idea-reader',
});
/** 読み手がしてはいけないこと（ファイルを読む・探す・コマンド・Web） */
const READING_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch', 'NotebookRead']);
const KNOWLEDGE_FIELDS = ['例', '出典', '制限', '得た日', '確かさ'];

const exists = (p) => fs.existsSync(p);
const readText = (p) => (exists(p) ? fs.readFileSync(p, 'utf8') : '');
const listDir = (p) => (exists(p) ? fs.readdirSync(p).sort() : []);

/** いちばん新しい回のフォルダ（runs/ の中の名前の順で最後） */
export function latestRun(dataDir) {
  const runs = listDir(path.join(dataDir, 'runs')).filter((n) => fs.statSync(path.join(dataDir, 'runs', n)).isDirectory());
  return runs.length ? path.join(dataDir, 'runs', runs.at(-1)) : null;
}

export function readParams(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'params.json'), 'utf8'));
}

/** 文の中の URL（重なりを除く） */
export function uniqueUrls(text) {
  return new Set((String(text).match(/https?:\/\/[^\s|)>」）]+/g) ?? []).map((u) => u.replace(/[.,、。]+$/, '')));
}

/** 本質の一覧の番号（E1、E2…。重なりを除く） */
export function essenceIds(text) {
  return new Set(String(text).match(/\bE\d+\b/g) ?? []);
}

/** combine/log.md の組の行（設計書 3.6 の形）：{ combo, size, essences, made, passed } */
export function comboLines(text) {
  const re = /^- (c\d+)｜数\s*(\d+)｜([^｜\n]*)｜作った案\s*(\d+)｜通った案[：:]\s*(.+)$/gm;
  return [...String(text).matchAll(re)].map((m) => ({
    combo: m[1], size: Number(m[2]), essences: essenceIds(m[3]).size, made: Number(m[4]), passed: !/^なし/.test(m[5].trim()),
  }));
}

/**
 * 掛け合わせる数の移り方が決まりに合うか（REQ-057、設計書 3.6）。合わない組の番号の並びを返す。
 * 通れば同じ数のまま。同じ数で perSize 組続けてだめなら順の次の数。順の最後でもだめなら（ユーザーに聞いて）順の最初からやり直してよい。
 */
export function sizeSequenceProblems(lines, order, perSize) {
  const problems = [];
  let idx = 0;
  let fails = 0;
  for (const line of lines) {
    if (line.size !== order[idx]) {
      problems.push(`${line.combo}：数 ${line.size}（決まりでは ${order[idx]}）`);
      const at = order.indexOf(line.size);
      if (at >= 0) { idx = at; fails = 0; }
    }
    if (line.essences !== line.size) problems.push(`${line.combo}：本質が ${line.essences} 個（数 ${line.size}）`);
    if (line.passed) { fails = 0; continue; }
    fails += 1;
    if (fails >= perSize) { idx = idx < order.length - 1 ? idx + 1 : 0; fails = 0; }
  }
  return problems;
}

/** reflect/candidates.md の候補（## 候補<n> <操作> 柱<m>）と、外した番号 */
export function candidatesOf(text) {
  const parts = String(text).split(/^(?=## 候補\d+)/m).filter((p) => /^## 候補\d+/.test(p));
  const candidates = parts.map((p) => {
    const head = p.match(/^## 候補(\d+)\s*(\S*)/);
    const k = p.match(/^#{2,3} K\d+-\d+\s+(.+)$/m);
    return { n: Number(head[1]), op: head[2], sentence: k ? k[1].trim() : null };
  });
  const ex = String(text).match(/外した番号[：:]\s*(.+)$/m);
  const excluded = ex && !/なし/.test(ex[1]) ? (ex[1].match(/\d+/g) ?? []).map(Number) : [];
  return { candidates, excluded, answered: Boolean(ex) };
}

/** 知識・経験のファイルの項目（## K<柱>-<番号> …） */
export function knowledgeItems(text) {
  const parts = String(text).split(/^(?=## K\d+-\d+)/m).filter((p) => /^## K\d+-\d+/.test(p));
  return parts.map((p) => {
    const head = p.split('\n')[0];
    const missing = KNOWLEDGE_FIELDS.filter((f) => !new RegExp(`^- ${f}[：:]`, 'm').test(p));
    return { head, missing };
  });
}

/** Agent の呼び出し（メインのエージェントが起動したサブエージェント） */
export function agentCalls(calls) {
  return calls.filter((c) => (c.name === 'Agent' || c.name === 'Task') && c.owner === 'main');
}

const typeOf = (c) => c.input?.subagent_type ?? '';
/** 頼みの文の役（「役：〇〇」「役は「〇〇」」など）。make-idea の手順は、頼みの初めに役を書く */
export const role = (name) => new RegExp(`役\\s*[：:は]\\s*[「『]?(?:${name})`);
const promptOf = (c) => String(c.input?.prompt ?? '');

/** 種類ごとに、1つの応答で同時に起動した数の最大 */
export function maxParallel(calls, type, promptPattern) {
  const groups = new Map();
  for (const c of agentCalls(calls)) {
    if (typeOf(c) !== type) continue;
    if (promptPattern && !promptPattern.test(promptOf(c))) continue;
    groups.set(c.group, (groups.get(c.group) ?? 0) + 1);
  }
  return Math.max(0, ...groups.values());
}

/**
 * 採点する。
 * @param {{ dataDir: string, calls: object[], hearingState?: object|null, expectKnowledgeUse?: boolean, resume?: { runsBefore: string[], questions: string[], fromPillar?: number } }} args
 * @returns {{ ok: boolean, runDir: string|null, checks: Array<{ id: string, title: string, ok: boolean, detail: string }> }}
 */
export function gradeIdeaRun({ dataDir, calls, hearingState = null, expectKnowledgeUse = false, resume = null }) {
  const checks = [];
  const add = (id, title, ok, detail) => checks.push({ id, title, ok: Boolean(ok), detail: String(detail) });
  // 続きの試験では、止まった柱より前の柱の呼び出しは前の実行の記録にあるので、呼び出しで見る採点をしない
  const CALL_CHECK_PILLAR = { 'research-parallel': 2, 'essence-opinions': 3, 'essence-parallel': 3, 'essence-independent': 3, 'combine-separate': 4, 'explain-readers': 5, 'explain-reader-blind': 5, 'explain-reader-prompt': 5 };
  const addCall = (id, title, ok, detail) => (resume && (resume.fromPillar ?? 0) > CALL_CHECK_PILLAR[id]
    ? add(id, title, true, `続きの試験では見ない（柱${resume.fromPillar}から続けた）`)
    : add(id, title, ok, detail));
  const runDir = latestRun(dataDir);
  if (!runDir) {
    add('run', '回のフォルダがある', false, `${dataDir}/runs/ に回のフォルダがない`);
    return { ok: false, runDir: null, checks };
  }
  let params;
  try {
    params = readParams(dataDir);
  } catch (e) {
    add('params', 'params.json が読める', false, e.message);
    return { ok: false, runDir, checks };
  }
  const p = {
    collect: params['徹底的な事前調査']['集める作品の数'],
    parallel: params['徹底的な事前調査']['同時に調べるエージェントの数'],
    deep: params['徹底的な事前調査']['掘り下げる作品の数'],
    essences: params['本質の見極め']['本質の数'],
    analysts: params['本質の見極め']['なぜなぜ分析をするエージェントの数'],
    size: params['本質の掛け合わせ']['一度に掛け合わせる本質の数'],
    partners: params['本質の掛け合わせ']['壁打ちの相手のエージェントの数'],
    perCombo: params['本質の掛け合わせ']['1つの組から作る案の数'],
    total: params['本質の掛け合わせ']['壁打ちする案の総数'],
    rounds: params['本質の掛け合わせ']['壁打ちの往復の数'],
    readers: params['アイデアの説明']['説明を読む第三者のエージェントの数'],
    maxIdeas: params['アイデアの説明']['説明するアイデアの数の上限'],
    reflectors: params['知識・経験の蓄積']['振り返りのエージェントの数'],
    fileMax: params['知識・経験の蓄積']['知識・経験のファイル1つの大きさの上限（バイト）'],
  };
  const r = (rel) => path.join(runDir, rel);
  const agents = agentCalls(calls);
  const ofType = (type, pattern) => agents.filter((c) => typeOf(c) === type && (!pattern || pattern.test(promptOf(c))));

  // 終わった
  add('finished', 'state.md が「終わり」', /状態[：:]\s*終わり/.test(readText(r('state.md'))), readText(r('state.md')).split('\n').slice(0, 4).join(' / '));

  // 柱1
  add('restriction', '柱1：restriction.md がある', exists(r('restriction.md')), r('restriction.md'));

  // 柱2
  const indexText = listDir(r('research')).filter((n) => /^index.*\.md$/.test(n)).map((n) => readText(r(`research/${n}`))).join('\n');
  const urls = uniqueUrls(indexText);
  add('research-count', `柱2：作品の一覧の URL が ${p.collect} 以上（REQ-055）`, urls.size >= p.collect, `${urls.size} 件`);
  const collectParallel = maxParallel(calls, AGENT.researcher, role('集める'));
  addCall('research-parallel', `柱2：集める調査役を1つの応答で ${p.parallel} 体同時に起動（REQ-055）`, collectParallel >= p.parallel, `最大 ${collectParallel} 体`);
  const deepFiles = listDir(r('research')).filter((n) => /^deep-.*\.md$/.test(n));
  const deepCount = deepFiles.reduce((n, f) => n + (readText(r(`research/${f}`)).match(/^## /gm) ?? []).length, 0);
  add('research-deep', `柱2：掘り下げた作品が ${p.deep} 以上`, deepCount >= p.deep, `${deepFiles.length} ファイル、${deepCount} 件`);

  // 柱3
  // 一覧は、大きさの上限で index.md・index-2.md… に分けて書かれることがある（エージェントの決まり）
  const ids = essenceIds(listDir(r('essence')).filter((n) => /^index.*\.md$/.test(n)).map((n) => readText(r(`essence/${n}`))).join('\n'));
  add('essence-count', `柱3：本質の一覧に ${p.essences} 以上（REQ-056）`, ids.size >= p.essences, `${ids.size} 個`);
  const analyses = listDir(r('essence')).filter((n) => /^analysis-.*\.md$/.test(n)).length;
  const finals = listDir(r('essence')).filter((n) => /^final-.*\.md$/.test(n)).length;
  add('essence-agents', `柱3：なぜなぜ分析と出し直しが ${p.analysts} 者以上（REQ-056）`, analyses >= p.analysts && finals >= p.analysts, `分析 ${analyses}、出し直し ${finals}`);
  const opinions = listDir(r('essence')).filter((n) => /^opinion-.*\.md$/.test(n)).length;
  const debateRounds = params['本質の見極め']['意見を出し合う往復の数'];
  addCall('essence-opinions', `柱3：意見の出し合いが ${p.analysts} 者 × ${debateRounds} 往復以上（REQ-056）`, opinions >= p.analysts * debateRounds && maxParallel(calls, AGENT.thinker, role('ほかの分析への意見')) >= p.analysts, `意見のファイル ${opinions}、同時に最大 ${maxParallel(calls, AGENT.thinker, role('ほかの分析への意見'))} 体`);
  const analysisParallel = maxParallel(calls, AGENT.thinker, role('なぜなぜ分析'));
  addCall('essence-parallel', `柱3：なぜなぜ分析の検討役を ${p.analysts} 体同時に起動`, analysisParallel >= p.analysts, `最大 ${analysisParallel} 体`);
  // 独立の分析：なぜなぜ分析の役が、ほかの分析・意見・出し直しのファイルを読んでいない
  const analystIds = new Set(ofType(AGENT.thinker, role('なぜなぜ分析')).map((c) => c.id));
  const peeks = calls.filter((c) => analystIds.has(c.owner) && c.name === 'Read' && /essence[\\/](analysis|opinion|final)-/.test(String(c.input?.file_path ?? '')));
  addCall('essence-independent', '柱3：独立の分析で、ほかの分析を読んでいない', peeks.length === 0, peeks.map((c) => c.input?.file_path).join(', ') || 'なし');

  // 柱4
  const combos = listDir(r('combine')).filter((n) => /^c\d+$/.test(n));
  const needCombos = Math.ceil(p.total / p.perCombo);
  add('combine-count', `柱4：組が ${needCombos} 以上（壁打ちする案の総数 ${p.total} ÷ 1組 ${p.perCombo}）（REQ-057）`, combos.length >= needCombos, `${combos.length} 組`);
  const shortJudges = combos.filter((c) => listDir(r(`combine/${c}`)).filter((n) => /^judge-.*\.md$/.test(n)).length < p.partners * p.rounds);
  add('combine-judges', `柱4：どの組も、壁打ちの相手 ${p.partners} 者 × 往復 ${p.rounds} の判定がある（REQ-057）`, combos.length > 0 && shortJudges.length === 0, shortJudges.length ? `足りない組：${shortJudges.join(', ')}` : `${combos.length} 組すべて`);
  const partnerCalls = ofType(AGENT.thinker, role('壁打ちの相手'));
  const makerCalls = ofType(AGENT.thinker, role('案を作る|案を直す'));
  addCall('combine-separate', '柱4：案を作る役と壁打ちの相手が別の起動', partnerCalls.length >= combos.length * p.partners && makerCalls.length >= combos.length && !partnerCalls.some((c) => makerCalls.includes(c)), `相手 ${partnerCalls.length} 回、作る・直す ${makerCalls.length} 回`);
  add('combine-passed', '柱4：combine/passed.md がある', exists(r('combine/passed.md')), r('combine/passed.md'));
  const lines = comboLines(readText(r('combine/log.md')));
  add('combine-log', `柱4：log.md に、組ごとの決まった形の行がある（設計書 3.6）`, lines.length >= combos.length && lines.length > 0, `行 ${lines.length}、組のフォルダ ${combos.length}`);
  const outOfRange = lines.filter((l) => l.size < p.size['最小'] || l.size > p.size['最大']).map((l) => l.combo);
  const sequence = sizeSequenceProblems(lines, params['本質の掛け合わせ']['掛け合わせる数を変える順'], params['本質の掛け合わせ']['同じ数で試す組の数']);
  add('combine-size', `柱4：組の本質の数が ${p.size['最小']}〜${p.size['最大']} で、数の移り方が決まりどおり（REQ-057）`, lines.length > 0 && outOfRange.length === 0 && sequence.length === 0, [...outOfRange.map((c) => `${c}：範囲の外`), ...sequence].join(' / ') || `${lines.length} 組`);
  add('combine-some-passed', '柱4：通った案が1つ以上ある（REQ-057）', lines.some((l) => l.passed), `${lines.filter((l) => l.passed).length} 組で通った`);

  // 柱5
  const explained = listDir(r('explain')).filter((n) => /^\d+\.md$/.test(n));
  add('explain-count', `柱5：説明が1〜${p.maxIdeas} 件（REQ-059）`, explained.length >= 1 && explained.length <= p.maxIdeas, `${explained.length} 件`);
  const readerCalls = ofType(AGENT.reader);
  addCall('explain-readers', `柱5：読み手を説明ごとに ${p.readers} 者以上（REQ-059）`, readerCalls.length >= explained.length * p.readers && maxParallel(calls, AGENT.reader) >= p.readers, `${readerCalls.length} 回、同時に最大 ${maxParallel(calls, AGENT.reader)} 体`);
  const readerIds = new Set(readerCalls.map((c) => c.id));
  const readerTools = calls.filter((c) => readerIds.has(c.owner) && READING_TOOLS.has(c.name));
  addCall('explain-reader-blind', '柱5：読み手がファイルを読む・探すツールを使っていない', readerTools.length === 0, readerTools.map((c) => c.name).join(', ') || 'なし');
  const leaky = readerCalls.filter((c) => promptOf(c).includes(dataDir) || /runs[\\/]/.test(promptOf(c)));
  addCall('explain-reader-prompt', '柱5：読み手の頼みに、作る過程のファイルの場所がない', leaky.length === 0, `${leaky.length} 件`);
  add('selection', '柱5：ユーザーの選択が selection.md にある（REQ-058）', exists(r('selection.md')), r('selection.md'));

  // 柱6
  const reflections = listDir(r('reflect')).filter((n) => /^reflection-.*\.md$/.test(n)).length;
  add('accumulate-agents', `柱6：振り返りが ${p.reflectors} 者以上（REQ-060）`, reflections >= p.reflectors, `${reflections}`);
  const kdir = path.join(dataDir, 'knowledge');
  const kfiles = listDir(kdir).filter((n) => n.endsWith('.md'));
  const items = kfiles.flatMap((f) => knowledgeItems(readText(path.join(kdir, f))).map((i) => ({ ...i, file: f })));
  const badItems = items.filter((i) => i.missing.length);
  add('knowledge-items', '柱6：知識・経験の項目が決まった形（REQ-060）', items.length > 0 && badItems.length === 0, `${items.length} 項目、欠け ${badItems.map((i) => `${i.file} ${i.head}：${i.missing.join('・')}`).join(' / ') || 'なし'}`);
  const big = kfiles.filter((f) => fs.statSync(path.join(kdir, f)).size >= p.fileMax);
  add('knowledge-size', `柱6：知識・経験のファイルが ${p.fileMax} バイトより小さい`, big.length === 0, big.join(', ') || 'すべて小さい');
  const candText = readText(r('reflect/candidates.md'));
  // 外した番号は candidates.md の終わりに書く決まり。state.md にだけ書いたときも、答えの記録として読む
  const exclusionLine = /外した番号/.test(candText) ? '' : (readText(r('state.md')).match(/^.*外した番号.*$/m)?.[0] ?? '').replace(/^.*?外した番号[：:]?\s*/, '外した番号：');
  const cands = candidatesOf(`${candText}\n${exclusionLine}`);
  const allKnowledge = kfiles.map((f) => readText(path.join(kdir, f))).join('\n');
  const leakedExcluded = cands.candidates.filter((c) => cands.excluded.includes(c.n) && ['足す', '直す'].includes(c.op) && c.sentence && allKnowledge.includes(c.sentence));
  add('knowledge-excluded', '柱6：ユーザーが外した候補が保存されていない（REQ-060）', cands.answered && leakedExcluded.length === 0, cands.answered ? `外した番号 ${cands.excluded.join('、') || 'なし'}、保存されたもの ${leakedExcluded.map((c) => c.n).join('、') || 'なし'}` : 'candidates.md に「外した番号：」がない');
  const used = readText(r('knowledge-used.md'));
  const usedSections = (used.match(/^## 柱\d/gm) ?? []).length;
  add('knowledge-used', '各柱：knowledge-used.md に柱ごとの記録がある（REQ-061）', usedSections >= 6, `${usedSections} 柱`);
  if (expectKnowledgeUse) {
    const usedIds = used.match(/\bK\d+-\d+\b/g) ?? [];
    add('knowledge-applied', '2回目：前の回の知識・経験の項目を使った（REQ-061）', usedIds.length > 0, `${new Set(usedIds).size} 項目`);
  }

  // 分離（REQ-065）
  const extensionCalls = calls.filter((c) => /^mcp__plugin-creator__/.test(c.name));
  add('separation-tools', 'plugin-creator_ のツールを呼んでいない（REQ-065）', extensionCalls.length === 0, extensionCalls.map((c) => c.name).join(', ') || 'なし');
  add('separation-hearing', 'ヒアリングの記録ができていない（REQ-065）', !hearingState, hearingState ? JSON.stringify(hearingState).slice(0, 200) : 'なし');
  const otherAgents = agents.filter((c) => !Object.values(AGENT).includes(typeOf(c)));
  add('separation-agents', 'make-idea のエージェントだけを起動（REQ-065）', otherAgents.length === 0, otherAgents.map(typeOf).join(', ') || 'なし');
  const WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
  const outside = calls.filter((c) => WRITES.has(c.name) && !String(c.input?.file_path ?? c.input?.notebook_path ?? '').startsWith(dataDir));
  add('data-only', 'ファイルの書き込みが、すべてデータの置き場所の中（REQ-063）', outside.length === 0, outside.map((c) => c.input?.file_path).join(', ') || 'すべて中');

  if (resume) {
    const runsNow = listDir(path.join(dataDir, 'runs'));
    const added = runsNow.filter((n) => !resume.runsBefore.includes(n));
    const asked = (resume.questions ?? []).some((q) => /続け/.test(q));
    add('resume', '続き：続けるかを聞き、新しい回のフォルダを作らずに、止まった回を終えた（REQ-064）', added.length === 0 && asked && /状態[：:]\s*終わり/.test(readText(r('state.md'))), `新しい回 ${added.join(', ') || 'なし'}、続けるかの問い ${asked ? 'あり' : 'なし'}`);
  }
  return { ok: checks.every((c) => c.ok), runDir, checks };
}
