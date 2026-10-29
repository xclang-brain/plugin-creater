// アイデア創出スキル（make-idea）の流れの試験の採点（アイデア創出の設計 7.1）。モデルを使わない。
// 入力は、データの置き場所（<ホーム>/.plugin-creator/make-idea）と、試験の入口（idea.mjs）が記録した呼び出しの一覧。
//
// 呼び出し（calls）の形：{ owner: 'main' か Agent の呼び出しの番号, id, name, input, group }
//   group は、メインのエージェントの1つの応答（assistant のメッセージ）の番号。同じ group の Agent は、同時に起動されたもの。
//   input の content は、入口が縮めて記録する。combine/log.md を書いたものだけは縮めない（判定の前に理由を書いたかを見るため）。

import fs from 'node:fs';
import path from 'node:path';

export const AGENT = Object.freeze({
  researcher: 'plugin-creator:idea-researcher',
  thinker: 'plugin-creator:idea-thinker',
  reader: 'plugin-creator:idea-reader',
});
/** 読み手がしてはいけないこと（ファイルを読む・探す・コマンド・Web） */
const READING_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch', 'NotebookRead']);
const WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const KNOWLEDGE_FIELDS = ['例', '出典', '制限', '得た日', '確かさ'];
/** 制限の決定で決める項目（REQ-065）と、前の版にあって今はない項目 */
const RESTRICTION_ITEMS = ['目的', '範囲'];
const OLD_RESTRICTION_ITEMS = /必ず満たす条件|あれば望ましい条件|良さを決める観点/;
/** 柱3から後の役（設計書 7.1）。頼みの文の「役：」で見分ける。読み手は役の行がないので、エージェントの種類で見分ける */
const LATER_ROLES = 'なぜなぜ分析|ほかの分析への意見|本質の出し直し|本質の集約|案を作る|案を直す|先行例を探す|壁打ちの相手|通った案を比べる|説明を書く|説明を直す|似たものを探す|振り返り|知識・経験の候補';
/** 回の制限のファイル。知識・経験の 1-restriction.md は含めない */
const RESTRICTION_FILE = /(?<![\w-])restriction\.md/;
/** 壁打ちの3つの観点（REQ-068） */
const JUDGE_VIEWS = ['新しさ', '役立つ', '価値'];

const exists = (p) => fs.existsSync(p);
const readText = (p) => (exists(p) ? fs.readFileSync(p, 'utf8') : '');
const listDir = (p) => (exists(p) ? fs.readdirSync(p).sort() : []);
const pathOf = (c) => String(c.input?.file_path ?? c.input?.notebook_path ?? '');
/** 書き込みの呼び出しが書いた文（Write の content、Edit の new_string、MultiEdit の edits） */
const writtenText = (c) => [c.input?.content, c.input?.new_string, ...(c.input?.edits ?? []).map((e) => e?.new_string)].filter((t) => typeof t === 'string').join('\n');
/** 大きさの上限で分けて書かれたファイル（<名前>-2.md、-3.md…）も含めて、名前の頭が同じファイルの中身をつなぐ */
const joinFiles = (dir, re) => listDir(dir).filter((n) => re.test(n)).map((n) => readText(path.join(dir, n))).join('\n');

/** いちばん新しい回のフォルダ（runs/ の中の名前の順で最後） */
export function latestRun(dataDir) {
  const runs = listDir(path.join(dataDir, 'runs')).filter((n) => fs.statSync(path.join(dataDir, 'runs', n)).isDirectory());
  return runs.length ? path.join(dataDir, 'runs', runs.at(-1)) : null;
}

export function readParams(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'params.json'), 'utf8'));
}

/** 文の中の URL（重なりを除く）。「、」「，」で並べたもの、全角の括弧で囲んだものも分ける */
export function uniqueUrls(text) {
  return new Set((String(text).match(/https?:\/\/[^\s|)>「」（）『』、，]+/g) ?? []).map((u) => u.replace(/[.,、。]+$/, '')));
}

/** 本質の一覧の番号（E1、E2…。重なりを除く） */
export function essenceIds(text) {
  return new Set(String(text).match(/\bE\d+\b/g) ?? []);
}

/** research/index.md の作品の行（設計書 3.4 の形 `- <番号> | <名前> | <URL> | <種類> | 評価：<あり・未確認・なし> | <手がかり>`）：{ n, rating }。太字の評価（評価：**あり**）も読む */
export function indexItems(text) {
  return String(text).split('\n').flatMap((line) => {
    const m = line.match(/^\s*(?:[-*]\s*)?(\d+)\s*[|｜]/);
    return m ? [{ n: Number(m[1]), rating: line.match(/評価\**\s*[：:]\s*\**\s*(あり|未確認|なし)/)?.[1] ?? null }] : [];
  });
}

/** 番号の見出し（## <番号> …）ごとの作品の節：{ n, text }。掘り下げ（deep-*.md）となぜなぜ分析（whys-*.md）の形 */
export function workSections(text) {
  return String(text).split(/^(?=## )/m).flatMap((p) => {
    const m = p.match(/^##\s*(?:作品\s*)?(\d+)/);
    return m ? [{ n: Number(m[1]), text: p }] : [];
  });
}

/** essence/index.md の本質（## E<番号> …）：{ id, why }。why は「- なぜ：」の行の中身（太字の「**なぜ**：」も読む。なければ null） */
export function essenceEntries(text) {
  return String(text).split(/^(?=#{2,3}\s)/m).flatMap((p) => {
    const m = p.match(/^#{2,3}\s*(E\d+)\b/);
    return m ? [{ id: m[1], why: p.match(/^\s*[-*]\s*\**なぜ\**\s*[：:]\**(.*)$/m)?.[1] ?? null }] : [];
  });
}

/** 判定のファイルの名前（judge-<p>-r<k>.md。分けたものは -2…）から、判定の回 k ごとの相手の番号 */
export function judgeRounds(names) {
  const rounds = new Map();
  for (const n of names) {
    const m = n.match(/^judge-(\d+)-r(\d+)(?:-\d+)?\.md$/);
    if (m) rounds.set(Number(m[2]), (rounds.get(Number(m[2])) ?? new Set()).add(m[1]));
  }
  return rounds;
}

/** combine/log.md で、組の行の下に「選んだ理由」の行がある組の番号 */
export function comboReasons(text) {
  return new Set(String(text).split(/^(?=- c\d+｜)/m).flatMap((b) => {
    const m = b.match(/^- (c\d+)｜/);
    return m && /選んだ理由/.test(b) ? [m[1]] : [];
  }));
}

/** combine/log.md の組の行（設計書 3.6 の形）：{ combo, size, essences, made, passed } */
export function comboLines(text) {
  const re = /^- (c\d+)｜(?:波\s*(\d+)｜)?数\s*(\d+)｜([^｜\n]*)｜作った案\s*(\d+)｜通った案[：:]\s*(.+)$/gm;
  return [...String(text).matchAll(re)].map((m) => ({
    combo: m[1], wave: m[2] ? Number(m[2]) : null, size: Number(m[3]), essences: essenceIds(m[4]).size, made: Number(m[5]), passed: !/^なし/.test(m[6].trim()),
  }));
}

/**
 * 掛け合わせる数の移り方が決まりに合うか（REQ-068、設計書 3.6）。合わない組の番号の並びを返す。
 * 通れば同じ数のまま。同じ数で perSize 組続けてだめなら順の次の数。順の最後でもだめなら（ユーザーに聞いて）順の最初からやり直してよい。
 */
export function sizeSequenceProblems(lines, order, perSize) {
  const problems = [];
  let idx = 0;
  let fails = 0;
  // 波（同じ波の番号が続く行）ごとに見る。波の番号がない行は、1行で1つの波とする
  const waves = [];
  for (const line of lines) {
    const last = waves[waves.length - 1];
    if (last && line.wave != null && last[0].wave === line.wave) last.push(line);
    else waves.push([line]);
  }
  for (const wave of waves) {
    const expected = order[idx];
    for (const line of wave) {
      if (line.size !== expected) problems.push(`${line.combo}：数 ${line.size}（決まりでは ${expected}）`);
      if (line.essences !== line.size) problems.push(`${line.combo}：本質が ${line.essences} 個（数 ${line.size}）`);
    }
    if (wave.some((l) => l.size !== expected)) {
      const at = order.indexOf(wave[0].size);
      if (at >= 0) { idx = at; fails = 0; }
    }
    for (const line of wave) {
      if (line.passed) { fails = 0; continue; }
      fails += 1;
      if (fails >= perSize) { idx = idx < order.length - 1 ? idx + 1 : 0; fails = 0; }
    }
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
/** 頼みの文の役（「役：〇〇」「役は「〇〇」」「役「〇〇」」など）。make-idea の手順は、頼みの初めに役を書く */
export const role = (name) => new RegExp(`役\\s*(?:[：:は]\\s*[「『]?|[「『])(?:${name})`);
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
  const CALL_CHECK_PILLAR = { 'research-parallel': 2, 'essence-writer': 3, 'essence-opinions': 3, 'essence-parallel': 3, 'essence-independent': 3, 'combine-reason-first': 4, 'combine-separate': 4, 'explain-readers': 5, 'explain-reader-blind': 5, 'explain-reader-prompt': 5 };
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
    retries: params['徹底的な事前調査']['調べ直しの回数'],
    sources: params['徹底的な事前調査']['掘り下げで1件に読む情報源の数'],
    essences: params['本質の見極め']['本質の数'],
    analysts: params['本質の見極め']['なぜなぜ分析をするエージェントの数'],
    size: params['本質の掛け合わせ']['一度に掛け合わせる本質の数'],
    partners: params['本質の掛け合わせ']['壁打ちの相手のエージェントの数'],
    perCombo: params['本質の掛け合わせ']['1つの組から作る案の数'],
    total: params['本質の掛け合わせ']['壁打ちする案の総数'],
    rounds: params['本質の掛け合わせ']['壁打ちの往復の上限'],
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
  const restrictionText = readText(r('restriction.md'));
  // 項目は2段目の見出し。範囲の下の小見出し（### 環境 など）は、範囲の中身として見る
  const headings = [...restrictionText.matchAll(/^##(?!#)\s*(.+?)\s*$/gm)].map((m) => m[1]);
  const extraHeadings = headings.filter((h) => !RESTRICTION_ITEMS.some((i) => h.startsWith(i)));
  const missingItems = RESTRICTION_ITEMS.filter((i) => !headings.some((h) => h.startsWith(i)));
  add('restriction-items', '柱1：restriction.md の見出しが「目的」と「範囲」だけで、条件や良さの観点がない（REQ-065）', exists(r('restriction.md')) && !missingItems.length && !extraHeadings.length && !OLD_RESTRICTION_ITEMS.test(restrictionText), `見出し ${headings.join('、') || 'なし'}${missingItems.length ? `、ない：${missingItems.join('、')}` : ''}${OLD_RESTRICTION_ITEMS.test(restrictionText) ? `、前の版の項目：${restrictionText.match(OLD_RESTRICTION_ITEMS)[0]}` : ''}`);

  // 柱2
  const researchDir = r('research');
  const researchFiles = listDir(researchDir);
  add('research-plan', '柱2：調べる計画（research/plan.md）がある（REQ-066）', exists(r('research/plan.md')), r('research/plan.md'));
  const missingRounds = Array.from({ length: p.retries }, (_, i) => i + 1).flatMap((k) => [
    ...(researchFiles.some((n) => new RegExp(`^gaps-r${k}(?:-\\d+)?\\.md$`).test(n)) ? [] : [`gaps-r${k}.md`]),
    ...(researchFiles.some((n) => new RegExp(`^collect-.+-r${k}(?:-\\d+)?\\.md$`).test(n)) ? [] : [`collect-*-r${k}.md`]),
  ]);
  add('research-rounds', `柱2：調べ直しの記録（gaps-r<k>.md と collect-*-r<k>.md）が ${p.retries} 回分ある（REQ-066）`, missingRounds.length === 0, missingRounds.length ? `ない：${missingRounds.join(', ')}` : `${p.retries} 回分`);
  // 一覧は、大きさの上限で index.md・index-2.md… に分けて書かれることがある（エージェントの決まり）
  const indexText = joinFiles(researchDir, /^index.*\.md$/);
  const urls = uniqueUrls(indexText);
  add('research-count', `柱2：作品の一覧の URL が ${p.collect} 以上（REQ-066）`, urls.size >= p.collect, `${urls.size} 件`);
  const collectParallel = maxParallel(calls, AGENT.researcher, role('集める'));
  addCall('research-parallel', `柱2：集める調査役を1つの応答で ${p.parallel} 体同時に起動（REQ-066）`, collectParallel >= p.parallel, `最大 ${collectParallel} 体`);
  // 掘り下げは作品の番号の節ごと。同じ番号の節が分けたファイルにまたがっても、1件として見る
  const deepTexts = new Map();
  for (const f of researchFiles.filter((n) => /^deep-.*\.md$/.test(n))) {
    for (const s of workSections(readText(r(`research/${f}`)))) deepTexts.set(s.n, `${deepTexts.get(s.n) ?? ''}\n${s.text}`);
  }
  const rated = [...new Set(indexItems(indexText).filter((i) => i.rating === 'あり').map((i) => i.n))];
  const notDeep = rated.filter((n) => !deepTexts.has(n));
  add('research-deep', '柱2：一覧で評価が「あり」の作品が、すべて deep-*.md にある（REQ-066）', rated.length > 0 && notDeep.length === 0, `評価あり ${rated.length}、掘り下げ ${deepTexts.size}${notDeep.length ? `、ない番号：${notDeep.join('、')}` : ''}`);
  const thin = [...deepTexts].filter(([, t]) => uniqueUrls(t).size < p.sources).map(([n, t]) => `${n}（${uniqueUrls(t).size}）`);
  add('research-sources', `柱2：掘り下げた作品ごとに、違う URL が ${p.sources} 以上（REQ-066）`, deepTexts.size > 0 && thin.length === 0, thin.length ? `足りない作品：${thin.join(', ')}` : `${deepTexts.size} 件`);
  add('research-overview', '柱2：調査のまとめ（research/overview.md）がある（REQ-066）', exists(r('research/overview.md')), r('research/overview.md'));
  // state.md は手順ごとに書き直されるので、書いた記録の中身も見る
  const stateRel = `runs/${path.basename(runDir)}/state.md`;
  const stateText = [readText(r('state.md')), ...calls.filter((c) => WRITES.has(c.name) && pathOf(c).replace(/\\/g, '/').endsWith(stateRel)).map(writtenText)].join('\n');
  const noMarks = ['柱2の始め', '柱2の終わり'].filter((k) => !new RegExp(`${k}[：:]\\s*\\S`).test(stateText));
  const pages = /読んだページ[^\n]*\d/.test(stateText);
  add('research-time', '柱2：state.md に柱2の始めと終わりの時刻と、読んだページの数がある（REQ-066）', noMarks.length === 0 && pages, [...noMarks.map((k) => `「${k}」なし`), ...(pages ? [] : ['読んだページの数なし'])].join('、') || 'あり');

  // 柱3
  const essenceDir = r('essence');
  const entries = essenceEntries(joinFiles(essenceDir, /^index.*\.md$/));
  const ids = new Set(entries.map((e) => e.id));
  add('essence-count', `柱3：本質の一覧に ${p.essences} 以上（REQ-067）`, ids.size >= p.essences, `${ids.size} 個`);
  const shallow = entries.filter((e) => (String(e.why ?? '').match(/→/g) ?? []).length < 2).map((e) => e.id);
  add('essence-why-chain', '柱3：本質の一覧のすべての本質に、「→」を2つ以上含む「なぜ」の行がある（REQ-067）', entries.length > 0 && shallow.length === 0, shallow.length ? `足りない本質：${shallow.join('、')}` : `${entries.length} 個`);
  // エージェントの数は、分けたファイル（whys-1-2.md、whys-c01-a1-2.md…）を同じエージェントとして数える。
  // まとまりに分けたとき（whys-c01-a1.md）は、まとまりごとの観点の数のうち、いちばん少ないものを数える
  const agentsOf = (kind) => {
    const byChunk = new Map();
    for (const n of listDir(essenceDir)) {
      const m = n.match(new RegExp(`^${kind}-(?:(c\\d+)-)?(a?\\d+)(?:-\\d+)?\\.md$`));
      if (!m) continue;
      const chunk = m[1] ?? '';
      if (!byChunk.has(chunk)) byChunk.set(chunk, new Set());
      byChunk.get(chunk).add(m[2]);
    }
    return byChunk.size ? Math.min(...[...byChunk.values()].map((v) => v.size)) : 0;
  };
  const analyses = agentsOf('whys');
  const finals = agentsOf('final');
  add('essence-agents', `柱3：なぜなぜ分析と出し直しが ${p.analysts} 者以上（まとまりに分けたときは、まとまりごと）（REQ-067）`, analyses >= p.analysts && finals >= p.analysts, `分析 ${analyses}、出し直し ${finals}`);
  const whysFiles = listDir(essenceDir).filter((n) => /^whys-(?:c\d+-)?a?\d+(?:-\d+)?\.md$/.test(n));
  const whysSections = whysFiles.flatMap((f) => workSections(readText(path.join(essenceDir, f))).map((s) => ({ ...s, file: f })));
  const noFirstWhy = whysSections.filter((s) => !/なぜ評価されている(?:の)?か/.test(s.text)).map((s) => `${s.file} ${s.n}`);
  add('essence-whys-first', '柱3：whys-*.md の作品の節のすべてに「なぜ評価されているのか」がある（REQ-067）', whysSections.length > 0 && noFirstWhy.length === 0, noFirstWhy.length ? `ない節：${noFirstWhy.join(', ')}` : `${whysSections.length} 節`);
  const analystIds = new Set(ofType(AGENT.thinker, role('なぜなぜ分析')).map((c) => c.id));
  const writtenByAnalysts = new Set(calls.filter((c) => analystIds.has(c.owner) && WRITES.has(c.name)).map((c) => path.basename(pathOf(c))));
  const notByAnalysts = whysFiles.filter((f) => !writtenByAnalysts.has(f));
  const mainEssence = calls.filter((c) => c.owner === 'main' && WRITES.has(c.name) && /essence[\\/](whys|final)-[^\\/]*$/.test(pathOf(c))).map((c) => path.basename(pathOf(c)));
  addCall('essence-writer', '柱3：whys-*.md をなぜなぜ分析のエージェントが書き、メインのエージェントが whys・final を書いていない（REQ-067）', whysFiles.length > 0 && notByAnalysts.length === 0 && mainEssence.length === 0, [...(notByAnalysts.length ? [`分析役が書いていない：${notByAnalysts.join(', ')}`] : []), ...(mainEssence.length ? [`メインが書いた：${mainEssence.join(', ')}`] : [])].join(' / ') || `${whysFiles.length} ファイル`);
  // 意見のファイルは、まとまりごとの観点と回で数え、まとまりのうちいちばん少ないものにする
  const opinionKeys = new Map();
  for (const n of listDir(essenceDir)) {
    const m = n.match(/^opinion-(?:(c\d+)-)?(a?\d+-r\d+)(?:-\d+)?\.md$/);
    if (!m) continue;
    const chunk = m[1] ?? '';
    if (!opinionKeys.has(chunk)) opinionKeys.set(chunk, new Set());
    opinionKeys.get(chunk).add(m[2]);
  }
  const opinions = opinionKeys.size ? Math.min(...[...opinionKeys.values()].map((v) => v.size)) : 0;
  const debateRounds = params['本質の見極め']['意見を出し合う往復の数'];
  addCall('essence-opinions', `柱3：意見の出し合いが ${p.analysts} 者 × ${debateRounds} 往復以上（REQ-067）`, opinions >= p.analysts * debateRounds && maxParallel(calls, AGENT.thinker, role('ほかの分析への意見')) >= p.analysts, `意見のファイル ${opinions}、同時に最大 ${maxParallel(calls, AGENT.thinker, role('ほかの分析への意見'))} 体`);
  const analysisParallel = maxParallel(calls, AGENT.thinker, role('なぜなぜ分析'));
  addCall('essence-parallel', `柱3：なぜなぜ分析の検討役を ${p.analysts} 体同時に起動`, analysisParallel >= p.analysts, `最大 ${analysisParallel} 体`);
  // 独立の分析：なぜなぜ分析の役が、ほかの分析・意見・出し直しのファイルを読んでいない（自分が書いたファイルを読み返すのはよい）
  const ownFiles = new Set(calls.filter((c) => analystIds.has(c.owner) && WRITES.has(c.name)).map((c) => `${c.owner}\n${pathOf(c)}`));
  const peeks = calls.filter((c) => analystIds.has(c.owner) && c.name === 'Read' && /essence[\\/](whys|opinion|final)-/.test(pathOf(c)) && !ownFiles.has(`${c.owner}\n${pathOf(c)}`));
  addCall('essence-independent', '柱3：独立の分析で、ほかの分析を読んでいない', peeks.length === 0, peeks.map((c) => c.input?.file_path).join(', ') || 'なし');

  // 柱3から後で制限を使っていない（REQ-065）
  const laterCalls = agents.filter((c) => typeOf(c) === AGENT.reader || role(LATER_ROLES).test(promptOf(c)));
  const laterIds = new Set(laterCalls.map((c) => c.id));
  const told = laterCalls.filter((c) => RESTRICTION_FILE.test(promptOf(c)));
  const readLater = calls.filter((c) => laterIds.has(c.owner) && READING_TOOLS.has(c.name) && RESTRICTION_FILE.test(JSON.stringify(c.input ?? {})));
  add('restriction-later', '柱3から後：役の頼みの文に restriction.md がなく、その役が restriction.md を読んでいない（REQ-065）', told.length === 0 && readLater.length === 0, `頼みの文 ${told.length} 件、読んだ ${readLater.length} 件（柱3から後の起動 ${laterCalls.length} 回）`);

  // 柱4
  const combos = listDir(r('combine')).filter((n) => /^c\d+$/.test(n));
  const needCombos = Math.ceil(p.total / p.perCombo);
  add('combine-count', `柱4：組が ${needCombos} 以上（壁打ちする案の総数 ${p.total} ÷ 1組 ${p.perCombo}）（REQ-068）`, combos.length >= needCombos, `${combos.length} 組`);
  // 判定の回 k（1から、いちばん後の回まで）のそれぞれに相手の数だけの判定があり、いちばん後の回が往復の上限以下
  const judgeProblems = combos.flatMap((c) => {
    const rounds = judgeRounds(listDir(r(`combine/${c}`)));
    const last = Math.max(0, ...rounds.keys());
    if (!last) return [`${c}：判定なし`];
    const short = Array.from({ length: last }, (_, i) => i + 1).filter((k) => (rounds.get(k)?.size ?? 0) < p.partners).map((k) => `${c}：r${k} は相手 ${rounds.get(k)?.size ?? 0} 者`);
    return last > p.rounds ? [...short, `${c}：r${last} は上限を超える`] : short;
  });
  add('combine-judges', `柱4：どの組も、判定の回ごとに壁打ちの相手 ${p.partners} 者の判定があり、回が往復の上限 ${p.rounds} 以下（REQ-068）`, combos.length > 0 && judgeProblems.length === 0, judgeProblems.join(' / ') || `${combos.length} 組すべて`);
  const judgeTexts = new Map();
  for (const c of combos) {
    for (const n of listDir(r(`combine/${c}`))) {
      const key = n.match(/^(judge-\d+-r\d+)(?:-\d+)?\.md$/)?.[1];
      if (key) judgeTexts.set(`${c}/${key}`, `${judgeTexts.get(`${c}/${key}`) ?? ''}\n${readText(r(`combine/${c}/${n}`))}`);
    }
  }
  const noViews = [...judgeTexts].filter(([, t]) => !JUDGE_VIEWS.every((v) => t.includes(v))).map(([k]) => k);
  add('combine-judge-views', '柱4：判定のファイルのすべてに「新しさ」「役立つ」「価値」がある（REQ-068）', judgeTexts.size > 0 && noViews.length === 0, noViews.length ? `ない判定：${noViews.join(', ')}` : `${judgeTexts.size} ファイル`);
  const noPrior = combos.filter((c) => !/検索語/.test(joinFiles(r(`combine/${c}`), /^prior-r1(?:-\d+)?\.md$/)));
  add('combine-prior', '柱4：組ごとに prior-r1.md があり、検索語の記録がある（REQ-068）', combos.length > 0 && noPrior.length === 0, noPrior.length ? `ない組：${noPrior.join(', ')}` : `${combos.length} 組すべて`);
  const partnerCalls = ofType(AGENT.thinker, role('壁打ちの相手'));
  const makerCalls = ofType(AGENT.thinker, role('案を作る|案を直す'));
  const priorCalls = ofType(AGENT.researcher, role('先行例を探す'));
  const shared = [...makerCalls, ...priorCalls].filter((c) => partnerCalls.includes(c)).length + makerCalls.filter((c) => priorCalls.includes(c)).length;
  addCall('combine-separate', '柱4：案を作る役、先行例を探す役、壁打ちの相手が別の起動（REQ-068）', partnerCalls.length >= combos.length * p.partners && makerCalls.length >= combos.length && priorCalls.length >= combos.length && shared === 0, `作る・直す ${makerCalls.length} 回、先行例 ${priorCalls.length} 回、相手 ${partnerCalls.length} 回、兼ねた起動 ${shared}`);
  add('combine-passed', '柱4：combine/passed.md がある', exists(r('combine/passed.md')), r('combine/passed.md'));
  add('combine-ranked', '柱4：通った案を比べた combine/ranked.md がある（REQ-069）', exists(r('combine/ranked.md')), r('combine/ranked.md'));
  const logText = readText(r('combine/log.md'));
  const lines = comboLines(logText);
  add('combine-log', `柱4：log.md に、組ごとの決まった形の行がある（設計書 3.6）`, lines.length >= combos.length && lines.length > 0, `行 ${lines.length}、組のフォルダ ${combos.length}`);
  const reasons = comboReasons(logText);
  const noReason = combos.filter((c) => !reasons.has(c));
  add('combine-reason', '柱4：log.md に、組ごとに「選んだ理由」の行がある（REQ-068）', combos.length > 0 && noReason.length === 0, noReason.length ? `ない組：${noReason.join(', ')}` : `${combos.length} 組すべて`);
  // 判定の前に書いたか：log.md を書いた記録（入口は中身を縮めずに残す）に、その組の行と「（判定の前）」がある
  // シェルで書いたもの（cat >> combine/log.md など）も、コマンドの文から読む
  const logWrites = [
    ...calls.filter((c) => WRITES.has(c.name) && /combine[\\/]log\.md$/.test(pathOf(c))).map(writtenText),
    ...calls.filter((c) => c.name === 'Bash' && /combine[\\/]log\.md/.test(String(c.input?.command ?? ''))).map((c) => String(c.input.command)),
  ].join('\n');
  const beforeJudging = new Set(logWrites.split('\n').filter((l) => /[（(]判定の前[）)]/.test(l)).map((l) => l.match(/\bc\d+\b/)?.[0]).filter(Boolean));
  const late = combos.filter((c) => !beforeJudging.has(c));
  addCall('combine-reason-first', '柱4：組を選んだ理由を、判定の前に log.md に書いた（書いた記録に「（判定の前）」がある）（REQ-068）', combos.length > 0 && late.length === 0, late.length ? `記録がない組：${late.join(', ')}` : `${combos.length} 組すべて`);
  const outOfRange = lines.filter((l) => l.size < p.size['最小'] || l.size > p.size['最大']).map((l) => l.combo);
  const sequence = sizeSequenceProblems(lines, params['本質の掛け合わせ']['掛け合わせる数を変える順'], params['本質の掛け合わせ']['同じ数で試す組の数']);
  add('combine-size', `柱4：組の本質の数が ${p.size['最小']}〜${p.size['最大']} で、数の移り方が決まりどおり（REQ-068）`, lines.length > 0 && outOfRange.length === 0 && sequence.length === 0, [...outOfRange.map((c) => `${c}：範囲の外`), ...sequence].join(' / ') || `${lines.length} 組`);
  add('combine-some-passed', '柱4：通った案が1つ以上ある（REQ-068）', lines.some((l) => l.passed), `${lines.filter((l) => l.passed).length} 組で通った`);

  // 柱5
  const explained = listDir(r('explain')).filter((n) => /^\d+\.md$/.test(n));
  add('explain-count', `柱5：説明が1〜${p.maxIdeas} 件（REQ-070）`, explained.length >= 1 && explained.length <= p.maxIdeas, `${explained.length} 件`);
  const readerCalls = ofType(AGENT.reader);
  addCall('explain-readers', `柱5：読み手を説明ごとに ${p.readers} 者以上（REQ-070）`, readerCalls.length >= explained.length * p.readers && maxParallel(calls, AGENT.reader) >= p.readers, `${readerCalls.length} 回、同時に最大 ${maxParallel(calls, AGENT.reader)} 体`);
  const readerIds = new Set(readerCalls.map((c) => c.id));
  const readerTools = calls.filter((c) => readerIds.has(c.owner) && READING_TOOLS.has(c.name));
  addCall('explain-reader-blind', '柱5：読み手がファイルを読む・探すツールを使っていない', readerTools.length === 0, readerTools.map((c) => c.name).join(', ') || 'なし');
  const leaky = readerCalls.filter((c) => promptOf(c).includes(dataDir) || /runs[\\/]/.test(promptOf(c)));
  addCall('explain-reader-prompt', '柱5：読み手の頼みに、作る過程のファイルの場所がない', leaky.length === 0, `${leaky.length} 件`);
  add('selection', '柱5：ユーザーの選択が selection.md にある（REQ-069）', exists(r('selection.md')), r('selection.md'));

  // 柱6
  const reflections = listDir(r('reflect')).filter((n) => /^reflection-.*\.md$/.test(n)).length;
  add('accumulate-agents', `柱6：振り返りが ${p.reflectors} 者以上（REQ-071）`, reflections >= p.reflectors, `${reflections}`);
  const kdir = path.join(dataDir, 'knowledge');
  const kfiles = listDir(kdir).filter((n) => n.endsWith('.md'));
  const items = kfiles.flatMap((f) => knowledgeItems(readText(path.join(kdir, f))).map((i) => ({ ...i, file: f })));
  const badItems = items.filter((i) => i.missing.length);
  add('knowledge-items', '柱6：知識・経験の項目が決まった形（REQ-071）', items.length > 0 && badItems.length === 0, `${items.length} 項目、欠け ${badItems.map((i) => `${i.file} ${i.head}：${i.missing.join('・')}`).join(' / ') || 'なし'}`);
  const big = kfiles.filter((f) => fs.statSync(path.join(kdir, f)).size >= p.fileMax);
  add('knowledge-size', `柱6：知識・経験のファイルが ${p.fileMax} バイトより小さい`, big.length === 0, big.join(', ') || 'すべて小さい');
  const candText = readText(r('reflect/candidates.md'));
  // 外した番号は candidates.md の終わりに書く決まり。state.md にだけ書いたときも、答えの記録として読む
  const exclusionLine = /外した番号/.test(candText) ? '' : (readText(r('state.md')).match(/^.*外した番号.*$/m)?.[0] ?? '').replace(/^.*?外した番号[：:]?\s*/, '外した番号：');
  const cands = candidatesOf(`${candText}\n${exclusionLine}`);
  const allKnowledge = kfiles.map((f) => readText(path.join(kdir, f))).join('\n');
  const leakedExcluded = cands.candidates.filter((c) => cands.excluded.includes(c.n) && ['足す', '直す'].includes(c.op) && c.sentence && allKnowledge.includes(c.sentence));
  add('knowledge-excluded', '柱6：ユーザーが外した候補が保存されていない（REQ-071）', cands.answered && leakedExcluded.length === 0, cands.answered ? `外した番号 ${cands.excluded.join('、') || 'なし'}、保存されたもの ${leakedExcluded.map((c) => c.n).join('、') || 'なし'}` : 'candidates.md に「外した番号：」がない');
  const used = readText(r('knowledge-used.md'));
  const usedSections = (used.match(/^## 柱\d/gm) ?? []).length;
  add('knowledge-used', '各柱：knowledge-used.md に柱ごとの記録がある（REQ-072）', usedSections >= 6, `${usedSections} 柱`);
  if (expectKnowledgeUse) {
    const usedIds = used.match(/\bK\d+-\d+\b/g) ?? [];
    add('knowledge-applied', '2回目：前の回の知識・経験の項目を使った（REQ-072）', usedIds.length > 0, `${new Set(usedIds).size} 項目`);
  }

  // 分離（REQ-076）
  const extensionCalls = calls.filter((c) => /^mcp__plugin-creator__/.test(c.name));
  add('separation-tools', 'plugin-creator_ のツールを呼んでいない（REQ-076）', extensionCalls.length === 0, extensionCalls.map((c) => c.name).join(', ') || 'なし');
  add('separation-hearing', 'ヒアリングの記録ができていない（REQ-076）', !hearingState, hearingState ? JSON.stringify(hearingState).slice(0, 200) : 'なし');
  const otherAgents = agents.filter((c) => !Object.values(AGENT).includes(typeOf(c)));
  add('separation-agents', 'make-idea のエージェントだけを起動（REQ-076）', otherAgents.length === 0, otherAgents.map(typeOf).join(', ') || 'なし');
  const outside = calls.filter((c) => WRITES.has(c.name) && !pathOf(c).startsWith(dataDir));
  add('data-only', 'ファイルの書き込みが、すべてデータの置き場所の中（REQ-074）', outside.length === 0, outside.map((c) => c.input?.file_path).join(', ') || 'すべて中');

  if (resume) {
    const runsNow = listDir(path.join(dataDir, 'runs'));
    const added = runsNow.filter((n) => !resume.runsBefore.includes(n));
    const asked = (resume.questions ?? []).some((q) => /続け/.test(q));
    add('resume', '続き：続けるかを聞き、新しい回のフォルダを作らずに、止まった回を終えた（REQ-075）', added.length === 0 && asked && /状態[：:]\s*終わり/.test(readText(r('state.md'))), `新しい回 ${added.join(', ') || 'なし'}、続けるかの問い ${asked ? 'あり' : 'なし'}`);
  }
  return { ok: checks.every((c) => c.ok), runDir, checks };
}
