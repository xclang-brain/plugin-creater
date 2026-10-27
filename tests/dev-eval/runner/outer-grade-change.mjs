// 改善・設計変更（change-plugin）の外側の EVAL の採点（testing.md 6章。改善の模擬ユーザー。BLUEPRINT 7.3）。
// 純粋な関数：会話の記録と、呼ぶ側が集めた材料（outer-change.mjs の collectChangeRepo）だけを見る。ファイルは読まない。実際のモデルは使わない。
//
// 採点の観点（grades の id → 要件）。すべて必須（BLUEPRINT D36）
//   change-skill-used          記録のスキルに change-plugin がある。make-plugin を始めていない（REQ-052）
//   no-new-folder              新しいプラグインのフォルダができていない（REQ-052・059）
//   screen-url-shown           画面を開くツール（open）の返り値の URL が、最初の問いより前のチャットの文にある（REQ-043。outer-grade.mjs の
//                              gradeScreenUrlShown）
//   unchanged-before-approval  承認（段階を「生成」に進める記録）より前のスナップショットで、HEAD が初めのまま、直すフォルダの status が空。
//                              承認の抜き書きが、直前の質問のツールへの答えにある（REQ-057）
//   confirm-contents           確認が受け付けられてから承認の問いまでの問いと前の文に、新しい版・土台・擬似の機器・課題の言葉。確認の rebuild の
//                              keep と change が空でない（REQ-057・061）。確認は、受け付けられた後に、いくつかに分けて、そのたびに問いと一緒に
//                              示すので（make-plugin の confirm.md の3、change-confirm.md の3）、承認の問いの前の文だけでなく、その間をすべて見る。
//                              新しい版は、記録の confirmation.version の文字そのもの（なければ版の形の数）
//   version-approved           直した plugin.json の version ＝ 記録の confirmation.version ＞ 元の版（REQ-057）
//   rules-list-once            確認より前の1つの問い（問いと、その前の文）に、元の決まりの番号がすべて出る（REQ-054）。確認の1つ目（決まりの一覧）
//                              は数えない
//   rule-replaced              expect.replaced の番号が knowledge-removed.json のほかのどのファイルにもなく、その replacedBy が knowledge.json にあり、
//                              元の番号の最大より大きい（REQ-054・058）
//   ids-kept                   引き継いだ番号の中身が前と同じ。新しい番号はすべて元の最大より大きい。外した番号を使っていない（REQ-058）
//   added-rule-confirmed       作った後に書き足された決まり（role が repo のファイルのナレッジ）が、決まりの確かめの問いに出て、決まりの一覧に入った
//                              （REQ-054「その決まりを『〜という決まりですか？』と1件ずつ確かめる」「1件ずつ確認の質問として示される」）。問いそのもの
//                              （見出し・問い・選択肢）に、その決まりの文字（file.evidence）があり、決まりの確かめの問い（選択肢の名前に4つの答えがそろうか、
//                              問いに「という決まりですか」がある）を数える。決まりの一覧の問い（元の番号がすべて出る問い）と、確認より後の問いは数えない
//   embedded:<ナレッジ>        決まりが組み込まれた（markers.embedded にすべて当たる。REQ-055・054）
//   not-embedded:<ナレッジ>    「違う」「たまたま」の決まりが入っていない（markers.excluded に1つも当たらない。REQ-055）
//                              どちらも、初めのコミットから HEAD までの差分の足した行で見る。ただし、role が repo のファイルの決まり（作る前から
//                              直すプラグインにある）は、直した後のファイルで見る（足した行だけで見ると、そのまま残したときに落ちるため）。
//                              role が skill のファイル（ユーザーのスキル）の決まりの embedded は、ルールのスキル（入口のスキルを除く skills/*/ の
//                              SKILL.md と references/）の足した行だけで見る（REQ-055「ルールのスキルに入っている」。エージェントの定義や試験にだけ
//                              書いても数えない）。not-embedded は、ほかの決まりと同じく足した行のすべて（決まりの一覧も含む）で見る（エージェントの
//                              定義や決まりの一覧に入っても、その書き方で作業されるため。REQ-055 の受け入れ基準3）
//   skill-names-differ         直したプラグインの skills/*/SKILL.md の name が、ユーザーのスキルの name と重ならない（REQ-055）
//   user-skills-unchanged      ユーザーのスキルのファイルが、前と後で同じ（REQ-055）
//   assets-reused              role が skill のファイルのうち SKILL.md でないもの（スクリプトなど）と同じ中身のファイルが、skills/*/scripts/ にある（REQ-055・062）
//   unchanged-items            記録に「変えないので聞かない」の項目があり、画面の項目のうち expect.screenUnchanged（省くと3つすべて）がそれ（REQ-056）
//   no-screen-questions        expect.screenAsked に当たる問いがない（REQ-056）
//   last-time-asked            expect.lastTimeAsked に当たる問いがある（REQ-056）
//   stage1 / stage2            直したプラグインの tests/run.py --json（REQ-059・061・062）
//   tests-added                引き継いだ課題のほかに課題があり、bin（inputs/bin）、その下の expect.deviceTool、device-history.log を見る
//                              program の基準がある（REQ-061）
//   commit-scoped              初めのコミットの次のコミットが1つ、差分はすべて直すフォルダの中、git add だけのファイルはそのまま、
//                              直すフォルダの status が空、印のタグが HEAD（REQ-059）
//   nothing-outside            直すフォルダの外のファイルが同じ（.claude/.cc-writes/ を除く）。作業用の一時フォルダが残っていない（REQ-059・021）
//   not-pushed                 origin の refs が同じ。git push を呼んでいない（REQ-059。コマンドの中の git の呼び出しだけを見る。文字や heredoc の中は見ない）
//   explained                  コミットの後の文に expect.explained がすべて当たる（REQ-060。コミットは scaffold.py commit か git commit の呼び出し）。
//                              expect.explained のうち版を見る正規表現（確認の版の文字にまるごと当たるもの）は、確認の版の文字そのもので見る
//                              （版の形の数は、元の版や IP アドレスの一部にも当たるため）。記録に確認の版がなければ、正規表現のまま見る
//   main-model / worker-model  作る流れと同じ（outer-grade.mjs の gradeModels。REQ-045・046）
//   inner-deliverable          内側の EVAL の結果を渡したときだけ（作る流れと同じ）
// 英語の覚え書きのようなチャットの文の数と、最初の問いより前にこれからの流れを示したかは、作る流れと同じく counts（countRecorded の nonJapaneseTexts と
// flowShown。outer-grade.mjs の isEnglishNote と isFlowText）に出す。合否には入れない。聞かれずに話した（faults）も、作る流れと同じ（knowledgeTrace）

import { compareVersions } from '../../../com.github.copilot/extensions/plugin-creator/change.mjs';
import { itemIndex } from '../../../com.github.copilot/extensions/plugin-creator/names.mjs';
import { CONFIRM_ANSWERS } from '../personas/validate.mjs';
import {
  countRecorded, exchangesOf, gradeModels, gradeScreenUrlShown, INNER_PASS_SCORE, knowledgeTrace, matchesAll, pairToolEvents, quoteFound, userRoleFaults,
} from './outer-grade.mjs';

/** 画面の項目（REQ-056：画面を変えない頼みでは、聞かない） */
export const SCREEN_ITEMS = Object.freeze(['settings', 'running_view', 'result_view']);
/** 決まりの一覧と外した決まりの一覧（ナレッジが記録されただけの印なので、組み込みの証拠にしない） */
const KNOWLEDGE_LISTS = new Set(['tests/knowledge.json', 'tests/knowledge-removed.json']);
const REMOVED_LIST = 'tests/knowledge-removed.json';
/** サンドボックスが作業フォルダに残すもの（testing.md 6章） */
const SANDBOX_LEFTOVER = '.claude/.cc-writes/';
const WORK_DIR = '.plugin-creator-work/';
const TAG_BASE = 'plugin-creator-generated';
/** スキルの SKILL.md と、ルールのスキルとして見るファイル（SKILL.md と references/ の下。scripts/ は流用した資産なので入れない） */
const SKILL_MD = /^skills\/([^/]+)\/SKILL\.md$/;
const RULE_SKILL_FILE = /^skills\/([^/]+)\/(?:SKILL\.md$|references\/)/;

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 版の形の数（IP アドレスの一部には当たらない。FORMAT.md 2.5 の expect.explained と同じ形）。確認の版が記録にないときだけ使う */
const VERSION_SHAPE = /(?<![\d.])\d+\.\d+\.\d+(?!\.?\d)/;
/** その版の文字に当たる正規表現（0.2.0 が 10.2.0・0.2.01・0.2.0.1・192.168.0.2.0 の一部に当たらない） */
const versionPattern = (version) => new RegExp(`(?<![\\d.])${escapeRegex(version)}(?!\\.?\\d)`);
/** 記録の確認の版（state.json の confirmation.version）。なければ null */
const approvedVersion = (state) => {
  const v = state?.confirmation?.version;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};
/** 版を見る正規表現か（確認の版の文字に、まるごと当たる） */
const isVersionCheck = (pattern, version) => new RegExp(`^(?:${pattern})$`).test(version);
/** 決まりの番号に当たる正規表現（K-1 が K-15 に、K-15 が K-150 に当たらない） */
const idPattern = (id) => new RegExp(`(?<![A-Za-z0-9-])${escapeRegex(id)}(?!\\d)`);
const idNumber = (id) => Number(/^K-(\d+)$/.exec(String(id ?? ''))?.[1] ?? NaN);
const isInputCopy = (rel) => /(^|\/)tests\/eval\/[^/]+\/inputs\//.test(rel);
const basename = (p) => String(p).split('/').pop();
const flat = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const list = (xs, n = 5) => (xs.length > n ? `${xs.slice(0, n).join('、')} ほか ${xs.length - n} 件` : xs.join('、'));

// ---- 問いのまとまり ---------------------------------------------------------------------------------------

/**
 * 会話の記録から、問いごとのまとまりを作る。前の文（notes）は、前の答えの後にクリエイターがチャットに書いた文。
 * 1回の質問のツールの呼び出しに問いの欄が複数あるときは、前の文を最初の欄にだけ付ける（ユーザー役に渡すのと同じ）。
 * @returns {Array<{ seq: number, via: string, header: string, question: string, options: Array, notes: string, answer: object|null }>}
 */
export function questionUnits(items) {
  const units = [];
  let notes = [];
  for (const i of items) {
    if (i.kind === 'creator.text') notes.push(String(i.text ?? ''));
    else if (i.kind === 'creator.question' || i.kind === 'creator.question-text') {
      const ask = i.kind === 'creator.question';
      units.push({ seq: i.seq, via: ask ? 'AskUserQuestion' : 'text', header: ask ? i.header ?? '' : '', question: ask ? i.question : i.text, options: ask ? i.options ?? [] : [], notes: notes.join('\n'), answer: null });
      notes = [];
    } else if (i.kind === 'user.answer') {
      const open = units.find((u) => u.answer === null && u.seq < i.seq && (i.via === 'resume' || u.question === i.question));
      if (open) open.answer = i;
      notes = [];
    } else if (i.kind === 'user.request') notes = [];
  }
  return units;
}

/** 問いそのものの文字（見出し、問い、選択肢） */
const questionText = (u) => `${u.header} ${u.question} ${(u.options ?? []).map((o) => `${o.label ?? ''} ${o.description ?? ''}`).join(' ')}`;
/** 問いと、その前の文 */
const unitText = (u) => `${u.notes}\n${questionText(u)}`;

/** 選択肢の名前（「（」の前）に、決まりの確かめの4つの答えがそろう（hearing.md 6.1） */
const isConfirmQuestion = (u) => {
  const labels = new Set((u.options ?? []).map((o) => String(o.label ?? '').replace(/[（(].*$/s, '').trim()));
  return CONFIRM_ANSWERS.every((a) => labels.has(a));
};
/** 決まりの確かめの文（REQ-054・055、make-plugin の rules.md「問いは『〜という決まりですか？』のままにする」） */
const ASKS_RULE = /という決まりですか/;
/** 決まりの確かめの問い：選択肢の名前に4つの答えがそろうか、問いに「という決まりですか」がある（文章の問いも数える） */
const confirmsRule = (u) => isConfirmQuestion(u) || ASKS_RULE.test(`${u.header}\n${u.question}`);

/** 承認（段階を「生成」に進める、成功した progress）の呼び出しと結果 */
function approvalOf(toolEvents) {
  return pairToolEvents(toolEvents).find((p) => p.call.tool === 'progress' && p.result?.isError === false && p.call.args?.stage === '生成') ?? null;
}

/** 最初に受け付けられた確認（成功した confirm）の呼び出しと結果 */
function confirmOf(toolEvents) {
  return pairToolEvents(toolEvents).find((p) => p.call.tool === 'confirm' && p.result?.isError === false) ?? null;
}

/** 確認より前の問い（段階「読む」から「項目の点検」までの問い）。確認がなければ、すべての問い */
const beforeConfirm = (units, confirm) => (confirm ? units.filter((u) => u.seq < confirm.call.seq) : units);

/** 元の決まりの番号のうち、文に出るものの数 */
const countIds = (ids, text) => ids.filter((id) => idPattern(id).test(text)).length;

/**
 * Bash のコマンドのうち、heredoc の中身を除いたもの（heredoc で書いたファイルの文字を、コマンドと取り違えないため）
 */
function shellCode(command) {
  const out = [];
  let end = null;
  for (const line of String(command ?? '').split('\n')) {
    if (end !== null) {
      if (line.trim() === end) end = null;
      continue;
    }
    out.push(line);
    const heredoc = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(line);
    if (heredoc) end = heredoc[2];
  }
  return out.join('\n');
}

/**
 * git の子コマンドの呼び出しに当たる正規表現。コマンドの始まり（行の頭、; & | ( の後、$( の中）の git だけを見て、
 * -C <場所>・-c <設定>・--<オプション> を挟んでよい。git stash push や、echo の文字の中の git push には当たらない
 */
const gitCall = (sub) => new RegExp(String.raw`(?:^|[;&|(\n]|\$\()\s*(?:\S*/)?git(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--[\w-]+(?:=\S+)?))*\s+${sub}\b`);
const GIT_PUSH = gitCall('push');
const GIT_COMMIT = gitCall('commit');
const SCAFFOLD_COMMIT = /(?:^|[\s/'"])scaffold\.py['"]?\s+commit\b/;
const bashCommand = (i) => (i.kind === 'tool.use' && i.name === 'Bash' ? shellCode(i.input?.command) : null);

/** 承認の答え（承認の前の、最後の質問のツールへの答え）と、その問いのまとまり */
function approvalUnit(units, items, approval) {
  if (!approval) return { answer: null, unit: null };
  const answer = items.filter((i) => i.kind === 'user.answer' && i.via === 'AskUserQuestion' && i.seq < approval.call.seq).at(-1) ?? null;
  return { answer, unit: answer ? units.find((u) => u.answer === answer) ?? null : null };
}

function diffMaps(before = {}, after = {}, ignore = () => false) {
  const out = { added: [], removed: [], changed: [] };
  for (const [k, v] of Object.entries(after)) {
    if (ignore(k)) continue;
    if (!Object.hasOwn(before, k)) out.added.push(k);
    else if (before[k] !== v) out.changed.push(k);
  }
  for (const k of Object.keys(before)) if (!ignore(k) && !Object.hasOwn(after, k)) out.removed.push(k);
  return out;
}

const describeDiff = (d) => [d.added.length ? `増えた：${list(d.added)}` : '', d.changed.length ? `変わった：${list(d.changed)}` : '', d.removed.length ? `消えた：${list(d.removed)}` : ''].filter(Boolean).join(' / ');

// ---- 観点 ---------------------------------------------------------------------------------------------------

function gradeUnchangedBeforeApproval({ items, approval, units, baseline }) {
  const problems = [];
  const snaps = items.filter((i) => i.kind === 'repo.snapshot' && (!approval || i.seq < approval.call.seq));
  for (const s of snaps) {
    if (s.head === null || s.head === undefined) problems.push(`スナップショット（${s.reason}）を取れなかった：${s.error ?? ''}`);
    else if (s.head !== baseline.baseCommit) problems.push(`承認の前（${s.reason}）に HEAD が進んだ（${s.head.slice(0, 10)}）`);
    else if ((s.status ?? []).length) problems.push(`承認の前（${s.reason}）に直すフォルダが変わった：${list(s.status, 3)}`);
  }
  if (!approval) return { ok: problems.length === 0, detail: problems.join(' / ') || `承認の記録がない（${snaps.length} 回のスナップショットで、直すフォルダは変わっていない）` };
  if (snaps.length === 0) problems.push('承認の前のスナップショットがない');
  const { answer } = approvalUnit(units, items, approval);
  if (!answer) problems.push('承認の記録の前に、質問のツールへの答えがない');
  else if (!quoteFound(approval.call.args?.approvalQuote, [answer.answer])) problems.push('承認の抜き書きが、直前の答え（質問のツールへの答え）の中にない');
  return { ok: problems.length === 0, detail: problems.join(' / ') || `承認の前の ${snaps.length} 回のスナップショットで、HEAD は初めのまま、直すフォルダは変わっていない` };
}

function gradeConfirmContents({ units, items, approval, confirm, state }) {
  const { unit } = approvalUnit(units, items, approval);
  if (!unit) return { ok: false, detail: approval ? '承認の問いが見つからない' : '承認の記録がない' };
  if (!confirm || confirm.call.seq > unit.seq) return { ok: false, detail: '承認の問いより前に、受け付けられた確認（plugin-creator_confirm）の記録がない' };
  // 確認は、受け付けられた後に、いくつかに分けて、そのたびに問いと一緒に示す（make-plugin の confirm.md の3、change-confirm.md の3）。
  // 確認から承認の問いまでの、問いと前の文のすべてを見る（確認の直前に書いた文は、最初の問いの前の文に入る）
  const shown = units.filter((u) => u.seq > confirm.call.seq && u.seq <= unit.seq);
  const text = shown.map(unitText).join('\n');
  const version = approvedVersion(state);
  const needs = [
    [version ? `新しい版（${version}）` : '新しい版（記録に確認の版がないので、版の形の数）', version ? versionPattern(version) : VERSION_SHAPE],
    ['土台', /土台/],
    ['擬似の機器', /擬似|エミュレー/],
    ['課題', /課題/],
  ];
  const problems = needs.filter(([, re]) => !re.test(text)).map(([name]) => `「${name}」の言葉が、確認から承認の問いまでの ${shown.length} つの問いとその前の文にない`);
  const rebuild = state?.confirmation?.rebuild;
  if (!rebuild?.keep?.length) problems.push('確認の rebuild.keep（引き継ぐこと）が空');
  if (!rebuild?.change?.length) problems.push('確認の rebuild.change（変わること）が空');
  return {
    ok: problems.length === 0,
    detail: problems.join(' / ') || `確認から承認の問いまでの ${shown.length} つの問いとその前の文に、新しい版・土台・擬似の機器・課題があり、引き継ぐことと変わることを記録した`,
  };
}

function gradeVersionApproved({ state, repo }) {
  const approved = approvedVersion(state);
  const before = repo.baseline.versionBefore;
  const after = repo.versionAfter;
  const ok = typeof approved === 'string' && after === approved && (before === null || (compareVersions(approved, before) ?? 0) > 0);
  return { ok, detail: `元の版 ${before ?? 'なし'}、確認の版 ${approved ?? 'なし'}、直した後の版 ${after ?? 'なし'}` };
}

function gradeRulesListOnce({ units, repo, confirm }) {
  const ids = (repo.baseline.knowledgeBefore ?? []).map((k) => k.id);
  if (ids.length === 0) return { ok: false, detail: '元の決まりの一覧がない' };
  // 段階「読む」の決まりの一覧の問いを見る。確認の1つ目（決まりの一覧）にも番号が並ぶので、確認より後の問いは数えない
  let best = 0;
  for (const u of beforeConfirm(units, confirm)) best = Math.max(best, countIds(ids, unitText(u)));
  const ok = best === ids.length;
  return { ok, detail: ok ? `確認より前の1つの問いに、元の決まりの番号 ${ids.length} 件がすべて出た` : `確認より前の1つの問いに出た元の決まりの番号は、多くて ${best}／${ids.length} 件` };
}

function gradeRuleReplaced({ persona, repo }) {
  const replaced = persona.expect?.replaced;
  const max = persona.expect?.carriedMax ?? Math.max(0, ...(repo.baseline.knowledgeBefore ?? []).map((k) => idNumber(k.id)).filter(Number.isFinite));
  const problems = [];
  const entry = (repo.removedAfter ?? []).find((r) => r?.id === replaced);
  if (!entry) problems.push(`${replaced} が ${REMOVED_LIST} にない`);
  else if (!entry.replacedBy) problems.push(`${REMOVED_LIST} の ${replaced} に replacedBy がない（中身を直した新しい番号がない）`);
  else {
    if (!(repo.knowledgeAfter ?? []).some((k) => k.id === entry.replacedBy)) problems.push(`replacedBy の ${entry.replacedBy} が knowledge.json にない`);
    if (!(idNumber(entry.replacedBy) > max)) problems.push(`replacedBy の ${entry.replacedBy} が、元の番号の最大 K-${String(max).padStart(2, '0')} より大きくない`);
  }
  const stray = repo.targetFiles.filter((f) => f.text !== null && f.rel !== REMOVED_LIST && idPattern(replaced).test(f.text)).map((f) => f.rel);
  if (stray.length) problems.push(`${replaced} がまだ書かれている：${list(stray)}`);
  return { ok: problems.length === 0, detail: problems.join(' / ') || `${replaced} を外して ${entry.replacedBy} にした。${replaced} はほかのファイルにない` };
}

function gradeIdsKept({ persona, repo }) {
  const before = repo.baseline.knowledgeBefore ?? [];
  const after = repo.knowledgeAfter;
  if (!Array.isArray(after)) return { ok: false, detail: '直した後の決まりの一覧（tests/knowledge.json）を読めない' };
  const removed = repo.removedAfter ?? [];
  const removedBefore = repo.baseline.removedBefore ?? [];
  const max = persona.expect?.carriedMax ?? Math.max(0, ...before.map((k) => idNumber(k.id)).filter(Number.isFinite));
  const problems = [];
  const afterById = new Map(after.map((k) => [k.id, k]));
  const removedIds = new Set(removed.map((r) => r?.id));
  for (const o of before) {
    const s = afterById.get(o.id);
    if (s) {
      if (s.text !== o.text || s.kind !== o.kind || s.item !== o.item) problems.push(`${o.id} は番号のまま中身が変わった`);
    } else if (!removedIds.has(o.id)) problems.push(`${o.id} が knowledge.json にも ${REMOVED_LIST} にもない`);
  }
  const beforeIds = new Set(before.map((k) => k.id));
  const usedBefore = new Set([...beforeIds, ...removedBefore.map((r) => r?.id)]);
  for (const s of after) {
    if (beforeIds.has(s.id)) continue;
    if (!(idNumber(s.id) > max)) problems.push(`新しい番号 ${s.id} が、元の番号の最大より大きくない`);
    if (usedBefore.has(s.id)) problems.push(`新しい番号 ${s.id} は、前に使った番号`);
    if (removedIds.has(s.id)) problems.push(`${s.id} は外した番号なのに、knowledge.json にある`);
  }
  for (const r of removedBefore) if (!removedIds.has(r?.id)) problems.push(`前に外した ${r?.id} が ${REMOVED_LIST} から消えた`);
  const keptCount = before.filter((o) => afterById.has(o.id)).length;
  return { ok: problems.length === 0, detail: problems.join(' / ') || `引き継いだ番号 ${keptCount} 件の中身は同じ、新しい番号はすべて K-${String(max).padStart(2, '0')} より後` };
}

/**
 * 作った後に書き足された決まり（role が repo のファイルのナレッジ）。決まりの確かめの問いがあり、rule・exception は一覧に入り、incidental・wrong は入らない。
 * 問いは、問いそのもの（見出し・問い・選択肢）に決まりの文字（file.evidence）があるもの（make-plugin の rules.md：問いに決まりの文を書く）で、
 * 決まりの確かめの問い（選択肢に4つの答えがそろうか、問いに「という決まりですか」がある。REQ-054「『〜という決まりですか？』と1件ずつ確かめる」）。
 * まとめの問い（前の文や問いにいくつもの手順を並べ、「違うところはありますか」と聞く問い）は、決まりの文字があっても、その決まりを確かめたことにならない
 * （外側の EVAL（改善）1回目の診断 2.2 の4）。
 * 決まりの一覧の問い（rules-list-once と同じく、問いと前の文に元の番号がすべて出る問い）は、元の決まりと一緒に示しただけなので数えない。
 * markers.asked は、元の決まりの文字（例：printf）にも当たるので使わない
 */
function gradeAddedRules({ persona, units, repo, repoPlaces, confirm }) {
  const added = persona.knowledge.filter((k) => k.from === 'file' && repoPlaces.has(k.file?.path));
  if (added.length === 0) return null;
  const ids = (repo.baseline.knowledgeBefore ?? []).map((k) => k.id);
  const listsRules = (u) => ids.length >= 2 && countIds(ids, unitText(u)) === ids.length;
  const single = beforeConfirm(units, confirm).filter((u) => !listsRules(u) && confirmsRule(u));
  const problems = [];
  for (const k of added) {
    const evidence = new RegExp(escapeRegex(k.file.evidence), 'i');
    const asked = single.some((u) => evidence.test(questionText(u)));
    if (!asked) problems.push(`${k.id}：書き足された決まり（${k.file.evidence}）を確かめる問いがない（問いそのものに決まりの文字がある、決まりの確かめの問い〔4つの答えの選択肢か、「という決まりですか」〕。決まりの一覧の問い、まとめの問い、確認より後の問いは数えない）`);
    const patterns = k.markers?.embedded?.length ? k.markers.embedded : [escapeRegex(k.file.evidence)];
    const inList = (repo.knowledgeAfter ?? []).some((row) => matchesAll(patterns, String(row?.text ?? '')));
    const shouldBe = ['rule', 'exception'].includes(k.file.kind);
    if (inList !== shouldBe) problems.push(`${k.id}：決まりの一覧に${shouldBe ? '入っていない' : '入っている'}`);
  }
  return { ok: problems.length === 0, detail: problems.join(' / ') || `書き足された決まり ${added.length} 件を決まりの確かめの問いで確かめ、答えのとおりに決まりの一覧に入れた` };
}

function gradeCommitScoped({ repo }) {
  const b = repo.baseline;
  const problems = [];
  if (repo.commits.length !== 1) problems.push(`初めのコミットの後のコミットが ${repo.commits.length} 個（1 個のはず）`);
  else if (repo.commits[0].parents.join(' ') !== b.baseCommit) problems.push('直したコミットの親が、初めのコミットでない');
  const prefix = b.targetInRepo ? `${b.targetInRepo}/` : '';
  const outside = repo.diffFiles.filter((f) => !f.startsWith(prefix));
  if (outside.length) problems.push(`直すフォルダの外のファイルがコミットに入った：${list(outside)}`);
  if (JSON.stringify([...repo.stagedAfter].sort()) !== JSON.stringify([...b.stagedBefore].sort())) problems.push(`git add だけのファイルが変わった（前：${list(b.stagedBefore) || 'なし'}、後：${list(repo.stagedAfter) || 'なし'}）`);
  if (repo.statusAfter === null) problems.push('直すフォルダの git status を見られなかった');
  else if (repo.statusAfter.length) problems.push(`直すフォルダにコミットしていない変更が残った：${list(repo.statusAfter, 3)}`);
  const tag = b.targetInRepo ? `${TAG_BASE}-${repo.pluginNameAfter ?? b.pluginName}` : TAG_BASE;
  if (!repo.tagsAtHead.includes(tag)) problems.push(`タグ ${tag} が HEAD にない（HEAD のタグ：${list(repo.tagsAtHead) || 'なし'}）`);
  return { ok: problems.length === 0, detail: problems.join(' / ') || `コミット 1 個（${repo.commits[0]?.commit.slice(0, 10)}）、差分は直すフォルダの中だけ、タグ ${tag}` };
}

function gradeNothingOutside({ repo }) {
  const ignore = (rel) => rel.startsWith(SANDBOX_LEFTOVER) || rel.startsWith(WORK_DIR) || rel.includes(`/${WORK_DIR}`);
  const d = diffMaps(repo.baseline.outsideFiles, repo.outsideFilesAfter, ignore);
  const problems = [];
  const text = describeDiff(d);
  if (text) problems.push(`直すフォルダの外のファイルが変わった（${text}）`);
  if (repo.leftoverWork.length) problems.push(`作業用の一時フォルダが残っている：${list(repo.leftoverWork)}`);
  return { ok: problems.length === 0, detail: problems.join(' / ') || '直すフォルダの外のファイルは変わらず、作業用の一時フォルダも残っていない' };
}

function gradeNotPushed({ items, repo }) {
  const problems = [];
  if (JSON.stringify(repo.baseline.originRefs ?? null) !== JSON.stringify(repo.originRefsAfter ?? null)) problems.push('origin の refs が変わった');
  const pushes = items.filter((i) => GIT_PUSH.test(bashCommand(i) ?? ''));
  if (pushes.length) problems.push(`git push を呼んだ：${String(pushes[0].input.command).slice(0, 80)}`);
  return { ok: problems.length === 0, detail: problems.join(' / ') || 'origin は変わらず、git push も呼んでいない' };
}

function gradeTestsAdded({ persona, repo }) {
  const carried = new Set(repo.baseline.evalBefore.map((e) => flat(e.prompt)));
  const added = repo.evalAfter.filter((e) => !carried.has(flat(e.json?.prompt)));
  if (added.length === 0) return { ok: false, detail: '引き継いだ課題のほかに課題がない' };
  const tool = persona.expect?.deviceTool;
  if (!tool) return { ok: true, detail: `足した課題：${list(added.map((e) => e.dir))}` };
  const good = added.filter((e) => e.json?.bin === 'inputs/bin'
    && e.files.includes(`inputs/bin/${tool}`)
    && (e.json.criteria ?? []).some((c) => c?.grading === 'program' && /device-history\.log/.test(String(c.check?.file ?? ''))));
  return {
    ok: good.length > 0,
    detail: good.length
      ? `擬似の機器の課題：${list(good.map((e) => e.dir))}`
      : `足した課題（${list(added.map((e) => e.dir))}）に、bin（inputs/bin）・inputs/bin/${tool}・device-history.log を見る program の基準がそろったものがない`,
  };
}

function gradeExplained({ persona, items, state }) {
  const version = approvedVersion(state);
  // 版を見る正規表現は、確認の版の文字そのものに置き換える（版の形の数のままだと、元の版だけを書いた説明や IP アドレスにも当たる）
  const patterns = (persona.expect?.explained ?? []).map((p) => (version && isVersionCheck(p, version)
    ? { label: `確認の版 ${version}`, re: versionPattern(version) }
    : { label: p, re: new RegExp(p) }));
  const isCommit = (i) => {
    const command = bashCommand(i);
    return command !== null && (SCAFFOLD_COMMIT.test(command) || GIT_COMMIT.test(command));
  };
  const commit = items.filter(isCommit).at(-1);
  if (!commit) return { ok: false, detail: 'コミットのコマンドを動かした記録がない' };
  const text = items
    .filter((i) => i.seq > commit.seq && ['creator.text', 'creator.question', 'creator.question-text'].includes(i.kind))
    .map((i) => (i.kind === 'creator.question' ? questionText({ header: i.header ?? '', question: i.question, options: i.options }) : i.text))
    .join('\n');
  const missing = patterns.filter((p) => !p.re.test(text)).map((p) => p.label);
  return { ok: missing.length === 0, detail: missing.length ? `コミットの後の文に当たらない：${missing.join('、')}` : `コミットの後の文に ${patterns.length} 件すべてが出た` };
}

/**
 * 入口のスキルのフォルダの名前。本文に <プラグインの名前>_open があるスキル（1段目の standalone の検査と同じ見分け方）。
 * 見つからなければ、プラグインの名前のフォルダ（testing.md 7章の確かめ B と同じ）
 */
function entrySkillDirs(files, pluginName) {
  if (!pluginName) return new Set();
  const found = files.filter((f) => f.text !== null && SKILL_MD.test(f.rel) && f.text.includes(`${pluginName}_open`)).map((f) => SKILL_MD.exec(f.rel)[1]);
  return new Set(found.length ? found : [pluginName]);
}

// ---- 全体 -------------------------------------------------------------------------------------------------------

/**
 * 改善の模擬ユーザーの外側の EVAL の1回を採点する（BLUEPRINT 7.3）。
 * @param {object} args
 * @param {object} args.persona 改善の模擬ユーザー（kind が change）
 * @param {{ skills?: string[] }} args.record 記録のうち使うもの（skills：呼んだスキル）
 * @param {object|null} args.state クリエイターの記録（state.json）
 * @param {Array} args.items 会話の記録（seq つき。repo.snapshot を含む）
 * @param {Array} args.toolEvents 記録のツールの呼び出しと結果
 * @param {object|null} args.stages 直したプラグインの1・2段目の結果
 * @param {object} args.repo outer-change.mjs の collectChangeRepo の返り値
 * @param {Array<{ place: string, role: string, sha256: string }>} [args.personaFiles] 示すファイル（sha256 つき。呼ぶ側が読む）
 * @param {object|null} [args.modelUse] 動いたモデル（outer-grade.mjs の gradeModels と同じ形）。腕 with で渡すと REQ-045・046 を採点する
 * @param {string} [args.model]
 * @param {string} [args.arm]
 * @param {'user-role'|'human'} [args.answerer]
 * @param {object|null} [args.inner] 内側の EVAL の結果（withScore）。なければ採点に入れない
 */
export function gradeChange({ persona, record = {}, state, items, toolEvents, stages, repo, personaFiles = [], modelUse = null, model, arm = 'with', answerer = 'user-role', inner = null }) {
  const grades = [];
  const add = (id, ok, detail, req) => grades.push({ id, ok: Boolean(ok), detail: detail ?? '', ...(req ? { req } : {}) });
  const units = questionUnits(items);
  const exchanges = exchangesOf(items);
  const approval = approvalOf(toolEvents);
  const confirm = confirmOf(toolEvents);
  const expect = persona.expect ?? {};

  const skills = (record.skills ?? []).map(String);
  const used = skills.some((s) => /(^|:)change-plugin$/.test(s));
  const make = skills.some((s) => /(^|:)make-plugin$/.test(s));
  add('change-skill-used', used && !make, `呼んだスキル：${list(skills) || 'なし'}${make ? '（make-plugin を始めた）' : ''}`, 'REQ-052');
  add('no-new-folder', repo.newPlugins.length === 0, repo.newPlugins.length ? `新しいプラグインのフォルダができた：${list(repo.newPlugins)}` : '', 'REQ-059');
  const url = gradeScreenUrlShown({ items, toolEvents });
  add('screen-url-shown', url.ok, url.detail, 'REQ-043');

  const before = gradeUnchangedBeforeApproval({ items, approval, units, baseline: repo.baseline });
  add('unchanged-before-approval', before.ok, before.detail, 'REQ-057');
  const contents = gradeConfirmContents({ units, items, approval, confirm, state });
  add('confirm-contents', contents.ok, contents.detail, 'REQ-057');
  const version = gradeVersionApproved({ state, repo });
  add('version-approved', version.ok, version.detail, 'REQ-057');
  const once = gradeRulesListOnce({ units, repo, confirm });
  add('rules-list-once', once.ok, once.detail, 'REQ-054');
  if (expect.replaced) {
    const replaced = gradeRuleReplaced({ persona, repo });
    add('rule-replaced', replaced.ok, replaced.detail, 'REQ-058');
  }
  const kept = gradeIdsKept({ persona, repo });
  add('ids-kept', kept.ok, kept.detail, 'REQ-058');
  const repoPlaces = new Set((persona.files ?? []).filter((f) => f.role === 'repo').map((f) => f.place));
  const addedRules = gradeAddedRules({ persona, units, repo, repoPlaces, confirm });
  if (addedRules) add('added-rule-confirmed', addedRules.ok, addedRules.detail, 'REQ-054');

  // 組み込み：足した行（role が repo のファイルの決まりは、直した後のファイル）。そのまま写した資産と、課題の入力の写しは証拠にしない
  const assets = personaFiles.filter((f) => f.role === 'skill' && basename(f.place) !== 'SKILL.md');
  const assetHashes = new Set(assets.map((f) => f.sha256));
  const usable = (f) => !isInputCopy(f.rel) && !(f.sha256 && assetHashes.has(f.sha256));
  const join = (files) => files.map((f) => f.text).join('\n');
  const addedScope = {
    embedded: join(repo.added.filter((f) => usable(f) && !KNOWLEDGE_LISTS.has(f.rel))),
    excluded: join(repo.added.filter(usable)),
    task: '',
  };
  const finalFiles = repo.targetFiles.filter((f) => f.text !== null && usable(f));
  const finalScope = { embedded: join(finalFiles.filter((f) => !KNOWLEDGE_LISTS.has(f.rel))), excluded: join(finalFiles), task: '' };
  // ユーザーのスキルの決まりが入ったかは、ルールのスキル（入口のスキルを除く）の足した行だけで見る（REQ-055「ルールのスキルに入っている」）。
  // 入ってはいけない書き方は、足した行のすべてで見る（エージェントの定義や決まりの一覧に入っても、その書き方で作業されるため）
  const entryDirs = entrySkillDirs(repo.targetFiles, repo.pluginNameAfter ?? repo.baseline.pluginName);
  const inRuleSkill = (rel) => {
    const m = RULE_SKILL_FILE.exec(rel);
    return m !== null && !entryDirs.has(m[1]);
  };
  const ruleText = join(repo.added.filter((f) => usable(f) && inRuleSkill(f.rel)));
  const ruleScope = { embedded: ruleText, excluded: addedScope.excluded, task: '' };
  const inRepoFile = (k) => k.from === 'file' && repoPlaces.has(k.file?.path);
  const skillPlaces = new Set((persona.files ?? []).filter((f) => f.role === 'skill').map((f) => f.place));
  const inUserSkill = (k) => k.from === 'file' && skillPlaces.has(k.file?.path);
  const traceOf = (knowledge, scope) => knowledgeTrace({ persona: { knowledge }, exchanges, scope });
  const traced = new Map([
    ...traceOf(persona.knowledge.filter((k) => !inRepoFile(k) && !inUserSkill(k)), addedScope),
    ...traceOf(persona.knowledge.filter(inRepoFile), finalScope),
    ...traceOf(persona.knowledge.filter(inUserSkill), ruleScope),
  ].map((t) => [t.id, t]));
  const trace = persona.knowledge.map((k) => traced.get(k.id));
  const whereOf = (k) => (inRepoFile(k) ? '直した後のファイル' : inUserSkill(k) ? 'ルールのスキル（入口のスキルを除く SKILL.md と references/）の足した行' : '足した行');
  for (const k of persona.knowledge) {
    const t = traced.get(k.id);
    const req = inUserSkill(k) ? 'REQ-055' : 'REQ-054';
    if (t.embedded !== null) add(`embedded:${k.id}`, t.embedded, `${whereOf(k)}に決まりが入ったか`, req);
    if (t.excludedHit !== null) add(`not-embedded:${k.id}`, !t.excludedHit, `${inRepoFile(k) ? '直した後のファイル' : '足した行'}に、入ってはいけない書き方が入っていない`, req);
  }

  const userNames = new Set(repo.baseline.userSkillNames ?? []);
  const clash = repo.targetSkillNames.filter((s) => userNames.has(s.name)).map((s) => s.name);
  add('skill-names-differ', userNames.size > 0 && clash.length === 0, clash.length ? `ユーザーのスキルと同じ名前：${list(clash)}` : `ユーザーのスキル：${list([...userNames]) || 'なし'}`, 'REQ-055');
  const userDiff = diffMaps(repo.baseline.userSkillFiles, repo.userSkillFilesAfter);
  add('user-skills-unchanged', describeDiff(userDiff) === '', describeDiff(userDiff) || `${Object.keys(repo.baseline.userSkillFiles ?? {}).length} ファイルが同じ`, 'REQ-055');
  if (assets.length) {
    const have = new Set(repo.targetFiles.filter((f) => /^skills\/[^/]+\/scripts\//.test(f.rel)).map((f) => f.sha256));
    const missing = assets.filter((a) => !have.has(a.sha256)).map((a) => a.place);
    add('assets-reused', missing.length === 0, missing.length ? `skills/*/scripts/ に同じ中身のファイルがない：${list(missing)}` : `${assets.length} ファイルを流用した`, 'REQ-055');
  }

  const itemStates = state?.items ?? {};
  const unchanged = Object.entries(itemStates).filter(([, v]) => v?.status === 'unchanged').map(([k]) => itemIndex.nameOf(k));
  // 変えないはずの画面の項目（模擬ユーザーの expect.screenUnchanged。記号か日本語の名前。省くと3つすべて）
  const screenExpected = (expect.screenUnchanged ?? SCREEN_ITEMS).map((x) => ({ given: x, key: SCREEN_ITEMS.includes(x) ? x : itemIndex.keyOf(x) }));
  const notScreen = screenExpected.filter((x) => !SCREEN_ITEMS.includes(x.key)).map((x) => x.given);
  const screenAsked = screenExpected.filter((x) => SCREEN_ITEMS.includes(x.key) && itemStates[x.key]?.status !== 'unchanged').map((x) => itemIndex.nameOf(x.key));
  add(
    'unchanged-items',
    unchanged.length > 0 && screenAsked.length === 0 && notScreen.length === 0,
    notScreen.length
      ? `expect.screenUnchanged に画面の項目でないものがある：${notScreen.join('、')}`
      : screenAsked.length ? `画面の項目が「変えないので聞かない」になっていない：${screenAsked.join('、')}` : `変えないので聞かない項目：${list(unchanged, 20) || 'なし'}`,
    'REQ-056',
  );
  if (expect.screenAsked) {
    const hits = units.filter((u) => new RegExp(expect.screenAsked).test(questionText(u)));
    add('no-screen-questions', hits.length === 0, hits.length ? `画面の問いがある：${String(hits[0].question).slice(0, 60)}` : '', 'REQ-056');
  }
  if (expect.lastTimeAsked) {
    const hit = units.find((u) => new RegExp(expect.lastTimeAsked).test(questionText(u)));
    add('last-time-asked', Boolean(hit), hit ? `最近の1回の問い：${String(hit.question).slice(0, 60)}` : '最近実際にやった1回をたどる問いがない', 'REQ-056');
  }

  if (stages?.skipped || !stages) {
    add('stage1', false, stages?.reason ?? '1・2段目を動かしていない', 'REQ-061');
    add('stage2', false, stages?.reason ?? '1・2段目を動かしていない', 'REQ-061');
  } else {
    add('stage1', stages.stage1?.ok, '', 'REQ-061');
    add('stage2', stages.stage2?.ok, '', 'REQ-061');
  }
  const tests = gradeTestsAdded({ persona, repo });
  add('tests-added', tests.ok, tests.detail, 'REQ-061');
  const scoped = gradeCommitScoped({ repo });
  add('commit-scoped', scoped.ok, scoped.detail, 'REQ-059');
  const outside = gradeNothingOutside({ repo });
  add('nothing-outside', outside.ok, outside.detail, 'REQ-059');
  const pushed = gradeNotPushed({ items, repo });
  add('not-pushed', pushed.ok, pushed.detail, 'REQ-059');
  if (expect.explained?.length) {
    const explained = gradeExplained({ persona, items, state });
    add('explained', explained.ok, explained.detail, 'REQ-060');
  }
  if (inner) add('inner-deliverable', (inner.withScore ?? 0) >= INNER_PASS_SCORE, `プラグインありのスコア ${inner.withScore}`, 'REQ-041');
  if (arm === 'with' && modelUse) for (const g of gradeModels({ use: modelUse, generatedCount: repo.commits.length > 0 ? 1 : 0 })) add(g.id, g.ok, g.detail, g.req);

  const human = answerer === 'human';
  const faults = human ? [] : userRoleFaults({ exchanges, trace });
  const failed = grades.filter((g) => !g.ok).map((g) => g.id);
  return {
    kind: 'change',
    grades,
    score: grades.length ? grades.filter((g) => g.ok).length / grades.length : 0,
    trace,
    faults,
    counts: countRecorded({ items, toolEvents, state }),
    // すべての観点が必須（BLUEPRINT D36）
    verdict: { model, required: grades.map((g) => g.id), ok: failed.length === 0, failed },
    // 会話例（REQ-037）は作る流れの会話から選ぶので、改善の会話は候補にしない
    exampleCandidate: false,
  };
}
