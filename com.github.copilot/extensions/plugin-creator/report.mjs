// 状態取得ツールの返り値（hearing.md 7.5）と、クリエイターの画面に出す状態（REQ-043）を、ヒアリングの記録から作る。
// どちらも、ただ1つの元である state.json の中身から作る（7.1）。内部の記号は出さず、日本語の名前に直す。

import { clip, confirmWord, pluginLabel } from './hearing.mjs';
import {
  KNOWLEDGE_STATUSES,
  assetStatusIndex,
  itemIndex,
  itemStatusIndex,
  kindIndex,
  knowledgeStatusDisplay,
  ossChoiceIndex,
  ossKindIndex,
  sourceDisplay,
  stageIndex,
} from './names.mjs';
import { LAST_QA_COUNT } from './constants.mjs';

/** 問答の記録の「問い」を、読める文にする。ask_user の引数は message を持つ（hearing.md 7.4） */
export function questionText(question) {
  if (question == null) return '';
  if (typeof question === 'string') return question;
  if (typeof question.message === 'string') return question.message;
  try {
    return JSON.stringify(question);
  } catch {
    return String(question);
  }
}

const OUTCOME_JA = { answered: '答えた', cancelled: '取り消した（Esc）', unavailable: '断った（答えられない）' };

function timeOf(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 問答の1件を、1つか2つの短い行にする */
export function qaLines(entry, { questionMax = 300, answerMax = 500 } = {}) {
  const time = timeOf(entry.at);
  const head = time ? `[${time}] ` : '';
  if (entry.type === 'user_prompt') return [`${head}ユーザーの発言：${clip(entry.text, answerMax)}`];
  if (entry.type === 'request') return [`${head}頼みの文：${clip(entry.text, answerMax)}`];
  const outcome = OUTCOME_JA[entry.outcome] ?? '';
  return [
    `${head}問い：${clip(questionText(entry.question), questionMax)}`,
    `  答え${outcome && entry.outcome !== 'answered' ? `（${outcome}）` : ''}：${clip(entry.answer, answerMax)}`,
  ];
}

const STATE_LINE_CLIP = 80;
const WANTS_CLIP = 300;

/**
 * 直すときの4行（REQ-060、BLUEPRINT 5 C1）：直すプラグイン、変えたいこと、引き継いだ決まりの数、決まりの変わり方。
 * コンパクションの後も、直したことの説明が崩れないように、状態取得ツールが毎回返す。
 */
function changeLines(hearing, change) {
  const list = (ids) => (ids.length ? ids.join('、') : 'なし');
  const { added, replaced, removed } = hearing.knowledgeChanges();
  const carried = change.carried?.length ?? 0;
  return [
    `直すプラグイン：${change.folder}（${pluginLabel(change)}）`,
    `変えたいこと：${clip((change.wants ?? []).join('／'), WANTS_CLIP)}`,
    `引き継いだ決まり：${carried}件${change.generated ? '' : '（plugin-creator が作っていないプラグインなので、読み取った決まりは、頼みの文や答えで決まりとして述べられていないものを1件ずつ確かめる）'}`,
    `足した決まり：${list(added)}／直した決まり：${list(replaced.map((r) => `${r.from}→${r.to}`))}／外した決まり：${list(removed)}`,
  ];
}
const LIST_LIMIT = 20;
/** 振り返りの材料に載せる問答の記録の上限（文字数）。超えるときは新しい側を残し、記録のファイルの場所を示す */
const RETROSPECTIVE_MAX_CHARS = 40_000;

/**
 * 状態取得ツールの返り値。
 * @param {object} hearing createHearing の返り値
 * @param {object} context { url, sessionId, statePath, qaPath, readQa }
 * @param {string|undefined} include '最後の問答' | '振り返りの材料' | undefined
 */
export function stateText(hearing, context, include) {
  const state = hearing.state;
  const lines = [];

  if (hearing.loadError) {
    lines.push(hearing.loadError.message);
  }
  lines.push(`段階：${state ? stageIndex.nameOf(state.stage) : '（お話を聞くことの記録はまだありません）'}`);
  if (state?.change) lines.push(...changeLines(hearing, state.change));

  if (state) {
    lines.push('聞くことの状態：');
    for (const item of hearing.applicableItems()) {
      const status = itemStatusIndex.nameOf(hearing.itemStatus(item.key));
      const extra = item.computed ? `（確かめたいこと ${hearing.candidates().length}件）` : '';
      lines.push(`  ${item.name}：${status}${extra}`);
    }
    lines.push(hearing.remainingLine());

    const candidates = hearing.candidates();
    if (candidates.length) {
      lines.push('確かめたいこと（仕事のやり方や決まりのうち、状態が「候補」のもの）：');
      // 出どころも示す。段階「決まりの確かめ」は、ファイルから読んだ候補だけを確かめる。コンパクションの後に見分けるため
      for (const k of candidates.slice(0, LIST_LIMIT)) lines.push(`  ${k.id}（聞くこと：${itemIndex.nameOf(k.item)}、出どころ：${sourceDisplay(k.source, Boolean(state.change))}）：${clip(k.text, STATE_LINE_CLIP)}`);
      if (candidates.length > LIST_LIMIT) lines.push(`  ほか${candidates.length - LIST_LIMIT}件`);
    }

    const pending = hearing.applicableItems().filter((i) => !i.computed && state.items[i.key]?.status === 'pending');
    if (pending.length) {
      lines.push('保留：');
      for (const i of pending) {
        const holder = state.items[i.key].holder;
        lines.push(`  ${i.name}${holder ? `（知っている人：${holder}）` : ''}`);
      }
    }

    const ai = state.knowledge.filter((k) => k.source === 'ai_decision' && k.status !== 'dropped');
    if (ai.length) {
      lines.push('AI の判断（ユーザーが任せたこと）：');
      for (const k of ai.slice(0, LIST_LIMIT)) lines.push(`  ${k.id}（${itemIndex.nameOf(k.item)}）：${clip(k.text, STATE_LINE_CLIP)}`);
    }

    const count = (key) => state.knowledge.filter((k) => k.status === key).length;
    lines.push(`仕事のやり方や決まり：${KNOWLEDGE_STATUSES.map((s) => `${knowledgeStatusDisplay(s.key)}${count(s.key)}件`).join('、')}`);
    lines.push(`資産：${state.assets.length}件、標準機能と公開のプラグイン：${state.ossChoices.length}件`);
    const word = confirmWord(state);
    lines.push(
      state.approvedAt
        ? `${word}：受け付け済み。生成の承認：${state.approvedAt}`
        : state.confirmation
          ? `${word}：受け付け済み（${state.confirmation.at}）。ユーザーの承認はまだです。`
          : `${word}：まだです。`,
    );
  }

  lines.push(`画面：${context.url ?? '（起動できていません）'}`);
  lines.push(`セッションの番号：${context.sessionId}`);
  lines.push(`お話を聞くことの記録（state.json）：${context.statePath}`);
  lines.push(`SKILL.md の本文がコンテキストになければ、skill ツールで ${state?.change ? 'change-plugin' : 'make-plugin'} を読み直してください。`);

  if (include === '最後の問答' || include === '振り返りの材料') {
    const qa = context.readQa();
    if (include === '最後の問答') {
      lines.push(`最後の問答（${Math.min(qa.length, LAST_QA_COUNT)}件）：`);
      for (const entry of qa.slice(-LAST_QA_COUNT)) for (const l of qaLines(entry)) lines.push(`  ${l}`);
      if (qa.length === 0) lines.push('  まだ記録がありません。');
    } else {
      const targets = hearing.retrospectiveTargets();
      lines.push('質問の改善案の対象の仕事のやり方や決まり（お話を聞くことで引き出せなかったもの）：');
      if (targets.length === 0) lines.push('  ありません。');
      for (const t of targets) lines.push(`  ${t.id}（聞くこと：${t.itemName}）：${t.reason}`);
      lines.push(`問答の記録のすべて（${qa.length}件。1行が1件の JSON）：`);
      let body = qa.map((e) => JSON.stringify(e)).join('\n');
      if (body.length > RETROSPECTIVE_MAX_CHARS) {
        body = `（古い記録を省きました。全体は ${context.qaPath} にあります）\n${body.slice(body.length - RETROSPECTIVE_MAX_CHARS)}`;
      }
      lines.push(body === '' ? '  まだ記録がありません。' : body);
    }
  }
  return lines.join('\n');
}

// ---- クリエイターの画面に出す状態 ------------------------------------------------------------

/**
 * 画面に出すナレッジの1行。決まったこと（REQ-043）と生成前の確認（REQ-020）で、同じ形・同じ中身にする。
 * isChange は今のプラグインを直すときか（出どころの確認の呼び名を変える）。配列の map に、そのまま渡さない（2つ目に添字が入る）
 */
export const knowledgeRow = (k, isChange) => ({
  id: k.id,
  kind: kindIndex.nameOf(k.kind),
  item: itemIndex.nameOf(k.item),
  text: k.text,
  source: sourceDisplay(k.source, isChange),
  quote: k.quote,
  example: k.example ?? null,
  exception: k.exception ?? null,
  status: knowledgeStatusDisplay(k.status),
});

/**
 * 画面に出す状態の、ヒアリングの部分（REQ-043）。文字は日本語の名前に直してある。
 * 画面は見るだけなので、答えや直しを受け取る欄はない。
 */
export function hearingView(hearing) {
  const state = hearing.state;
  if (!state) {
    return {
      exists: false,
      stage: null,
      change: null,
      items: [],
      notAskedItems: [],
      skippedItems: [],
      knowledge: [],
      candidates: [],
      dropped: [],
      assets: [],
      assetCandidates: [],
      oss: [],
      approvedAt: null,
    };
  }
  const items = hearing.applicableItems().map((item) => {
    const status = hearing.itemStatus(item.key);
    const record = state.items[item.key];
    return {
      name: item.name,
      status: itemStatusIndex.nameOf(status),
      // 聞かずに案で示す項目（今のプラグインを直すとき）は、済んだものに数える（案は直す前の確認で示す。REQ-056、REQ-057）
      done: status !== 'todo',
      main: item.group === 'main10',
      // 変えないので聞かない項目（今のプラグインを直すとき。REQ-056）。画面では、まだ聞いていない項目とも、聞いた項目とも分けて示す
      skipped: status === 'unchanged',
      holder: record?.holder ?? null,
    };
  });
  const rowsOf = (status) => state.knowledge.filter((k) => k.status === status).map((k) => knowledgeRow(k, Boolean(state.change)));
  const change = state.change
    ? {
        folder: state.change.folder,
        name: state.change.name,
        version: state.change.version ?? null,
        generated: Boolean(state.change.generated),
        wants: state.change.wants ?? [],
        carried: state.change.carried?.length ?? 0,
      }
    : null;
  return {
    exists: true,
    stage: stageIndex.nameOf(state.stage),
    change,
    items,
    // まだ聞いていない項目（REQ-043）は、仕様 REQ-015 の10項目のうち、未着手のもの
    notAskedItems: items.filter((i) => i.main && !i.done).map((i) => i.name),
    skippedItems: items.filter((i) => i.skipped).map((i) => i.name),
    knowledge: rowsOf('decided'),
    candidates: rowsOf('candidate'),
    dropped: rowsOf('dropped'),
    assets: state.assets
      .filter((a) => a.status === 'reuse')
      .map((a) => ({ name: a.name, location: a.location, note: a.note, status: assetStatusIndex.nameOf(a.status) })),
    assetCandidates: state.assets
      .filter((a) => a.status === 'candidate')
      .map((a) => ({ name: a.name, location: a.location, note: a.note, status: assetStatusIndex.nameOf(a.status) })),
    oss: state.ossChoices.map((o) => ({
      name: o.name,
      kind: ossKindIndex.nameOf(o.kind),
      choice: ossChoiceIndex.nameOf(o.choice),
      note: o.note ?? null,
    })),
    approvedAt: state.approvedAt,
  };
}
