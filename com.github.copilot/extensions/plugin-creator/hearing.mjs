// ヒアリングの状態と、記録のツールの確かめ（hearing.md 5.7、6.3、7.1〜7.5、11章）。
// Copilot CLI に依らない。記録は store.mjs が持つ。
//
// 決まり
// - 状態を変える関数は、まず全部を確かめ、1つでも誤りがあれば何も変えずに Refusal を投げる（理由の文は、creator.mjs の guard が failure の結果にして返す）。
// - Refusal の message は、ユーザーの画面に1行で出る。平易な日本語で、使える値を示す。内部の記号は出さない。
// - 項目の状態を変えるときは、ユーザーの言葉の抜き書きを添える。添えないと断る（モデルが自分の判断で項目を済ませないため）。
// - 状態の移り方：未着手 → 聞いた・決まりなし・保留。聞いた・決まりなし・保留どうしは行き来できる。未着手には戻せない。
// - ナレッジの状態の移り方：候補 → 決まった・外した。決まった・外したどうしは行き来できる。候補には戻せない。
// - 段階を「生成」に進めるには、生成前の確認（confirm）を受け付けていることと、承認の答えの抜き書きが要る。
//   進めると承認の時刻を残し、その後は記録を変えない（問答も記録しない。差し込みも返さない）。

import crypto from 'node:crypto';
import fs from 'node:fs';

import { isOnlyChosenOption, quoteFound, userWords } from './quote.mjs';

import {
  ASSET_STATUSES,
  ITEMS,
  ITEM_STATUSES,
  KNOWLEDGE_KINDS,
  KNOWLEDGE_SOURCES,
  KNOWLEDGE_STATUSES,
  MAIN_ITEMS,
  OSS_CHOICES,
  OSS_KINDS,
  STAGES,
  assetStatusIndex,
  itemIndex,
  itemStatusIndex,
  kindIndex,
  knowledgeStatusIndex,
  listNames,
  ossChoiceIndex,
  ossKindIndex,
  sourceIndex,
  stageIndex,
} from './names.mjs';

/** 作業の定義の案（draft/task.json）の中身の印（sha256）。読めなければ null。確認で示した案が、生成に進めるときまで変わっていないかを見る */
export function taskFileHash(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

export class Refusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'Refusal';
  }
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const has = (value) => text(value) !== '';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const FROZEN_MESSAGE = 'お話を聞くことは終わっています（段階は「生成」）。やり直すときは、/clear してから頼み直してください。';

/** 新しい記録 */
function freshState({ sessionId, now }) {
  return {
    schemaVersion: 1,
    sessionId,
    createdAt: now,
    updatedAt: now,
    stage: 'start',
    rebuild: false, // 作り直しのとき true（段階「できていたことの確認」に入るか、その項目を記録すると true になる）
    items: {}, // { <項目の記号>: { status, quote, holder, updatedAt } }。ないものは未着手
    knowledge: [], // 7.3 の欄
    knowledgeCounter: 0, // 番号 K-01 の付け方。使い回さない
    assets: [], // { name, location, note, status }
    ossChoices: [], // { name, kind, choice, note }
    confirmation: null, // { at, knowledgeIds, behavior, taskPath, evalTasks, rebuild }
    approvedAt: null,
    approvalQuote: null,
    url: null,
  };
}

const knowledgeNumber = (n) => `K-${String(n).padStart(2, '0')}`;

/** 長い文を、画面と返り値のために切る */
export function clip(value, max) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

const SHOWN_REMAINING = 6;

/** 名前の並びを、長ければ「ほか N 件」でまとめる */
function nameList(names, shown = SHOWN_REMAINING) {
  if (names.length <= shown) return names.join('、');
  return `${names.slice(0, shown).join('、')}、ほか${names.length - shown}件`;
}

/**
 * @param {object} options
 * @param {object} options.store store.mjs の createStore の返り値
 * @param {string} options.sessionId
 * @param {{ now: () => number }} options.clock
 * @param {() => void} [options.onCreated] 記録を作った直後に呼ぶ（頼みの文の追記。7.4）
 */
export function createHearing({ store, sessionId, clock, onCreated = () => {} }) {
  const iso = () => new Date(clock.now()).toISOString();

  let state = null;
  let loadError = null;
  try {
    state = store.readState();
  } catch (error) {
    loadError = error;
  }

  function assertWritable() {
    if (loadError) throw new Refusal(loadError.message);
    if (state?.stage === 'generate') throw new Refusal(FROZEN_MESSAGE);
  }

  function commit(next) {
    const created = state === null;
    next.updatedAt = iso();
    store.writeState(next);
    state = next;
    if (created) onCreated();
  }

  const working = () => (state ? clone(state) : freshState({ sessionId, now: iso() }));

  // ---- 項目の状態 ---------------------------------------------------------------

  const statusOf = (s, key) => s?.items?.[key]?.status ?? 'todo';
  const candidatesOf = (s) => (s?.knowledge ?? []).filter((k) => k.status === 'candidate');

  /** 今の状態で聞く項目（作り直しのときだけの項目は、作り直しのときだけ） */
  const applicableItems = (s) => ITEMS.filter((i) => !i.rebuildOnly || s?.rebuild);

  /** 項目の状態。候補の確かめは、確かめていない候補があれば未着手、なければ聞いた（7.2） */
  function itemStatus(s, key) {
    if (key === 'candidate_check') return candidatesOf(s).length > 0 ? 'todo' : 'asked';
    return statusOf(s, key);
  }

  /** 未着手の項目（日本語の名前） */
  function remainingNames(s) {
    return applicableItems(s)
      .filter((i) => itemStatus(s, i.key) === 'todo')
      .map((i) => i.name);
  }

  const remainingLine = (s) => {
    const names = remainingNames(s);
    return names.length ? `まだ聞いていないこと：${nameList(names)}` : 'まだ聞いていないことはありません。';
  };

  // ---- progress ---------------------------------------------------------------

  function applyProgress(args) {
    assertWritable();
    const input = isObject(args) ? args : {};
    const stageName = input.stage;
    const itemsInput = input.items;
    if (stageName === undefined && itemsInput === undefined) {
      throw new Refusal('段階（stage）か聞くこと（items）のどちらかを渡してください。');
    }

    const next = working();
    let stageKey = null;
    if (stageName !== undefined) {
      stageKey = stageIndex.keyOf(stageName);
      if (!stageKey) {
        throw new Refusal(`段階の名前が違います：「${String(stageName)}」。使える名前：${listNames(STAGES)}`);
      }
    }

    const touched = [];
    if (itemsInput !== undefined) {
      if (!Array.isArray(itemsInput) || itemsInput.length === 0) {
        throw new Refusal('聞くこと（items）は、聞くことの名前・状態・ユーザーの言葉の抜き書きを持つものの一覧で渡してください。');
      }
      for (const entry of itemsInput) {
        const e = isObject(entry) ? entry : {};
        const item = itemIndex.byName.get(e.item);
        if (!item) {
          throw new Refusal(`聞くことの名前が違います：「${String(e.item ?? '')}」。使える名前：${listNames(ITEMS.filter((i) => !i.computed))}`);
        }
        if (item.computed) {
          throw new Refusal(
            `「${item.name}」の状態は、確かめたいこと（仕事のやり方や決まりのうち、状態が「候補」のもの）があるかどうかで自動で決まります。それを plugin-creator_record で「決まった」か「外した」にしてください。`,
          );
        }
        const status = itemStatusIndex.byName.get(e.status);
        if (!status) {
          throw new Refusal(`状態の名前が違います：「${String(e.status ?? '')}」。使える名前：${listNames(ITEM_STATUSES.filter((s) => s.key !== 'todo'))}`);
        }
        if (status.key === 'todo') {
          throw new Refusal(`「${item.name}」を「未着手」には戻せません。使える状態：${listNames(ITEM_STATUSES.filter((s) => s.key !== 'todo'))}`);
        }
        if (!has(e.quote)) {
          throw new Refusal(`「${item.name}」の状態を変えるには、ユーザーの言葉の抜き書き（quote）を添えてください。`);
        }
        // 未着手から変えるときの抜き書きは、それより前のユーザーの言葉のどれか1つの中にある（採点と同じ決め方。要約や言い換えは断る）
        if (statusOf(next, item.key) === 'todo' && !quoteInUserWords(e.quote)) {
          throw new Refusal(
            `「${item.name}」の抜き書き（quote）が、ユーザーの答えの中に見つかりません。1つの答えの言葉を、そのまま写してください（要約しない。間を省くときは「…」でつなぐ）。`,
          );
        }
        next.items[item.key] = {
          status: status.key,
          quote: text(e.quote),
          holder: status.key === 'pending' && has(e.holder) ? text(e.holder) : null,
          updatedAt: iso(),
        };
        if (item.key === 'rebuild_check') next.rebuild = true;
        touched.push(item.name);
      }
    }

    if (stageKey) {
      if (stageKey === 'generate') {
        if (!state?.confirmation) {
          throw new Refusal('段階を「生成」に進める前に、作る前の確認で示すものを plugin-creator_confirm で知らせて、ユーザーによいと答えてもらってください。');
        }
        const changed = changesSinceConfirmation();
        if (changed) {
          throw new Refusal(`作る前の確認で示した仕事のやり方や決まりの一覧と、今の「決まった」ものが違います（${changed}）。plugin-creator_confirm で示し直して、ユーザーによいと答えてもらってください。`);
        }
        const taskChanged = taskChangedSinceConfirmation();
        if (taskChanged) throw new Refusal(taskChanged);
        if (!has(input.approvalQuote)) {
          throw new Refusal('段階を「生成」に進めるには、よいと答えたユーザーの言葉の抜き書き（approvalQuote）を添えてください。');
        }
        next.approvedAt = iso();
        next.approvalQuote = text(input.approvalQuote);
      }
      next.stage = stageKey;
      if (stageKey === 'rebuild_check') next.rebuild = true;
    }

    commit(next);
    const head = stageKey ? `記録しました（段階：${stageIndex.nameOf(stageKey)}）。` : '記録しました。';
    return `${head}${remainingLine(next)}`;
  }

  // ---- record -----------------------------------------------------------------

  const KNOWLEDGE_FIELDS_JA = { kind: '種類', item: '聞くこと', text: '文', source: '出どころ', quote: 'ユーザーの言葉', status: '状態' };

  function checkKnowledgeFields(e, label) {
    const out = {};
    if (e.kind !== undefined) {
      const kind = kindIndex.byName.get(e.kind);
      if (!kind) throw new Refusal(`${label}の種類が違います：「${String(e.kind)}」。使える名前：${listNames(KNOWLEDGE_KINDS)}`);
      out.kind = kind.key;
    }
    if (e.item !== undefined) {
      const item = MAIN_ITEMS.find((i) => i.name === e.item);
      if (!item) throw new Refusal(`${label}の聞くことが違います：「${String(e.item)}」。使える名前：${listNames(MAIN_ITEMS)}`);
      out.item = item.key;
    }
    if (e.text !== undefined) {
      if (!has(e.text)) throw new Refusal(`${label}の文が空です。`);
      out.text = text(e.text);
    }
    if (e.source !== undefined) {
      const source = sourceIndex.byName.get(e.source);
      if (!source) throw new Refusal(`${label}の出どころが違います：「${String(e.source)}」。使える名前：${listNames(KNOWLEDGE_SOURCES)}`);
      out.source = source.key;
    }
    if (e.status !== undefined) {
      const status = knowledgeStatusIndex.byName.get(e.status);
      if (!status) throw new Refusal(`${label}の状態が違います：「${String(e.status)}」。使える名前：${listNames(KNOWLEDGE_STATUSES)}`);
      out.status = status.key;
    }
    if (e.example !== undefined) out.example = has(e.example) ? text(e.example) : null;
    if (e.exception !== undefined) out.exception = has(e.exception) ? text(e.exception) : null;
    return out;
  }

  /**
   * 抜き書きが、問答の記録のユーザーの言葉のどれか1つの中にあるか。
   * 問答の記録にユーザーの言葉が1件もないときは、確かめずに通す：問答の記録のフックの形は、本物の Copilot CLI でまだ確かめていない
   * （tasks/C1.md の実機の要確認 2）ので、記録が取れていないだけのときに、すべての記録を断って止めないため。
   */
  function quoteInUserWords(quote) {
    const words = userWords(store.readQa());
    return words.length === 0 || quoteFound(quote, words);
  }

  function applyKnowledge(next, e, added, updated) {
    if (!isObject(e)) throw new Refusal('仕事のやり方や決まり（knowledge）は、欄を持つものの一覧で渡してください。');
    if (!has(e.quote)) {
      throw new Refusal('仕事のやり方や決まりには、ユーザーの言葉の抜き書き（quote）を添えてください。ファイルから読んだものは、ファイル名と箇所を書いてください。');
    }
    if (e.id !== undefined && e.id !== null && e.id !== '') {
      const existing = next.knowledge.find((k) => k.id === e.id);
      if (!existing) {
        const ids = next.knowledge.map((k) => k.id);
        throw new Refusal(`仕事のやり方や決まり ${String(e.id)} は見つかりません。${ids.length ? `今ある番号：${ids.join('、')}` : 'まだありません。番号を付けずに渡すと、新しく追加されます。'}`);
      }
      const fields = checkKnowledgeFields(e, `仕事のやり方や決まり ${existing.id} の`);
      if (fields.status === 'candidate' && existing.status !== 'candidate') {
        throw new Refusal(`仕事のやり方や決まり ${existing.id} を「候補」には戻せません。使える状態：${listNames(KNOWLEDGE_STATUSES.filter((s) => s.key !== 'candidate'))}`);
      }
      Object.assign(existing, fields, { quote: text(e.quote), updatedAt: iso() });
      existing.itemName = itemIndex.nameOf(existing.item); // 項目を直したときも、日本語の名前をそろえる
      updated.push(existing.id);
      return;
    }
    const missing = ['kind', 'item', 'text', 'source', 'status'].filter((f) => e[f] === undefined || (typeof e[f] === 'string' && !has(e[f])));
    if (missing.length) {
      throw new Refusal(`新しい仕事のやり方や決まりに足りない欄：${missing.map((f) => KNOWLEDGE_FIELDS_JA[f]).join('、')}`);
    }
    const fields = checkKnowledgeFields(e, '新しい仕事のやり方や決まりの');
    if (fields.source === 'added_at_confirmation' && isOnlyChosenOption(text(e.quote), store.readQa())) {
      throw new Refusal(
        '作る前の確認で足すのは、ユーザーが答えの中で自分の言葉で述べた決まりだけです。抜き書き（quote）に、その決まりを述べたユーザーの言葉を入れてください。示したものに「違うところはない」と答えただけなら、記録しないでください。',
      );
    }
    next.knowledgeCounter += 1;
    const id = knowledgeNumber(next.knowledgeCounter);
    next.knowledge.push({
      id,
      kind: fields.kind,
      item: fields.item,
      itemName: itemIndex.nameOf(fields.item),
      text: fields.text,
      source: fields.source,
      quote: text(e.quote),
      example: fields.example ?? null,
      exception: fields.exception ?? null,
      status: fields.status,
      // 自動で付ける欄（11章）：記録の時刻と、記録したときにその項目が未着手でなかったか
      recordedAt: iso(),
      updatedAt: iso(),
      itemTouchedAtRecord: statusOf(next, fields.item) !== 'todo',
    });
    added.push(id);
  }

  function applyRecord(args) {
    assertWritable();
    const input = isObject(args) ? args : {};
    const { knowledge, assets, oss } = input;
    if (knowledge === undefined && assets === undefined && oss === undefined) {
      throw new Refusal('仕事のやり方や決まり（knowledge）、資産（assets）、標準機能と公開のプラグイン（oss）のどれかを渡してください。');
    }
    for (const [name, value] of [['仕事のやり方や決まり（knowledge）', knowledge], ['資産（assets）', assets], ['標準機能と公開のプラグイン（oss）', oss]]) {
      if (value !== undefined && (!Array.isArray(value) || value.length === 0)) {
        throw new Refusal(`${name}は、1件以上の一覧で渡してください。`);
      }
    }

    const next = working();
    const added = [];
    const updated = [];
    for (const e of knowledge ?? []) applyKnowledge(next, e, added, updated);

    let assetCount = 0;
    for (const e of assets ?? []) {
      if (!isObject(e) || !has(e.name)) throw new Refusal('資産には、名前（name）が要ります。');
      const status = assetStatusIndex.byName.get(e.status);
      if (!status) throw new Refusal(`資産の状態が違います：「${String(e.status ?? '')}」。使える名前：${listNames(ASSET_STATUSES)}`);
      const row = { name: text(e.name), location: has(e.location) ? text(e.location) : null, note: has(e.note) ? text(e.note) : null, status: status.key };
      const at = next.assets.findIndex((a) => a.name === row.name);
      if (at >= 0) next.assets[at] = row;
      else next.assets.push(row);
      assetCount += 1;
    }

    let ossCount = 0;
    for (const e of oss ?? []) {
      if (!isObject(e) || !has(e.name)) throw new Refusal('標準機能と公開のプラグインには、名前（name）が要ります。');
      const kind = ossKindIndex.byName.get(e.kind);
      if (!kind) throw new Refusal(`標準機能か公開のプラグインかの指定が違います：「${String(e.kind ?? '')}」。使える名前：${listNames(OSS_KINDS)}`);
      const choice = ossChoiceIndex.byName.get(e.choice);
      if (!choice) throw new Refusal(`選んだ結果が違います：「${String(e.choice ?? '')}」。使える名前：${listNames(OSS_CHOICES)}`);
      const row = { name: text(e.name), kind: kind.key, choice: choice.key, note: has(e.note) ? text(e.note) : null };
      const at = next.ossChoices.findIndex((o) => o.name === row.name);
      if (at >= 0) next.ossChoices[at] = row;
      else next.ossChoices.push(row);
      ossCount += 1;
    }

    commit(next);
    const parts = [];
    if (added.length) parts.push(`仕事のやり方や決まり ${added.join('、')} を追加`);
    if (updated.length) parts.push(`仕事のやり方や決まり ${updated.join('、')} を更新`);
    if (assetCount) parts.push(`資産${assetCount}件`);
    if (ossCount) parts.push(`標準機能と公開のプラグイン${ossCount}件`);
    const open = candidatesOf(next).length;
    return `記録しました（${parts.join('、')}）。${open ? `確かめたいこと：${open}件` : '確かめたいことはありません。'}`;
  }

  // ---- confirm ----------------------------------------------------------------

  /** 生成前の確認を受け付けてよいか。未着手の項目が残っていれば、残りを返して断る（5.7、6.3） */
  function checkConfirmable() {
    assertWritable();
    const names = remainingNames(state);
    if (names.length) {
      throw new Refusal(`まだ聞いていないことがあるので、作る前の確認はできません：${names.join('、')}。聞いてから、もう一度知らせてください。`);
    }
  }

  /** 知らせられたナレッジの番号を確かめて、ナレッジの行を返す */
  function knowledgeByIds(ids) {
    const rows = [];
    const unknown = [];
    const dropped = [];
    const notDecided = [];
    for (const id of ids) {
      const row = (state?.knowledge ?? []).find((k) => k.id === id);
      if (!row) unknown.push(id);
      else if (row.status === 'dropped') dropped.push(id);
      else if (row.status !== 'decided') notDecided.push(id);
      else rows.push(row);
    }
    if (unknown.length) throw new Refusal(`仕事のやり方や決まりの番号が見つかりません：${unknown.join('、')}`);
    if (dropped.length) throw new Refusal(`外した仕事のやり方や決まりは示せません：${dropped.join('、')}`);
    if (notDecided.length) throw new Refusal(`決まっていない仕事のやり方や決まりは示せません：${notDecided.join('、')}`);
    return rows;
  }

  /** 確認で示すナレッジの1行（画面に出す欄のうち、生成に使う中身。ユーザーが確かめるのは、これ） */
  const shownRow = (k) => ({ id: k.id, kind: k.kind, item: k.item, text: k.text, example: k.example ?? null, exception: k.exception ?? null });

  /**
   * 生成前の確認を受け付ける。示したナレッジの中身の写し（knowledge）も残す。
   * ユーザーがよいと答えたナレッジと、生成に使うナレッジが、食い違わないようにするため（REQ-020）。
   */
  function commitConfirmation(confirmation) {
    assertWritable();
    const next = working();
    next.confirmation = { ...confirmation, knowledge: knowledgeByIds(confirmation.knowledgeIds).map(shownRow), at: iso() };
    commit(next);
  }

  /** 確認で示したあとに、「決まった」ナレッジが、足された・外れた・直された、のどれかがあれば、その文。なければ null */
  function changesSinceConfirmation() {
    const shown = new Map((state?.confirmation?.knowledge ?? []).map((r) => [r.id, JSON.stringify(r)]));
    const now = new Map((state?.knowledge ?? []).filter((k) => k.status === 'decided').map((k) => [k.id, JSON.stringify(shownRow(k))]));
    const added = [...now.keys()].filter((id) => !shown.has(id));
    const gone = [...shown.keys()].filter((id) => !now.has(id));
    const edited = [...now.keys()].filter((id) => shown.has(id) && shown.get(id) !== now.get(id));
    const parts = [];
    if (added.length) parts.push(`示していない：${added.join('、')}`);
    if (gone.length) parts.push(`決まったものでなくなった：${gone.join('、')}`);
    if (edited.length) parts.push(`直した：${edited.join('、')}`);
    return parts.length ? parts.join('。') : null;
  }

  /**
   * 確認で示した作業の定義の案（draft/task.json）が、示したあとに変わっていたら、その文。変わっていなければ null。
   * 変わったまま生成すると、ユーザーが見た見本と違う画面と合格の条件の設定で作られる（REQ-020、REQ-027）。
   * 印（taskHash）のない古い記録は、比べない。
   */
  function taskChangedSinceConfirmation() {
    const c = state?.confirmation;
    if (!c?.taskHash) return null;
    const now = taskFileHash(c.taskPath);
    if (now === c.taskHash) return null;
    const what = now === null ? `見つからなくなりました（${c.taskPath}）` : `示したあとに変わっています（${c.taskPath}）`;
    return `作る前の確認で示した画面と合格の条件の設定の案が、${what}。作業の画面の見本を直したときは、plugin-creator_confirm で示し直して、ユーザーによいと答えてもらってください。`;
  }

  // ---- そのほか -----------------------------------------------------------------

  function setUrl(url) {
    if (!state || loadError || state.stage === 'generate' || state.url === url) return;
    const next = clone(state);
    next.url = url;
    commit(next);
  }

  /** 質問の改善案の対象のナレッジ（11章の1つ目の観点）。決まったナレッジのうち、次のどちらか */
  function retrospectiveTargets() {
    const out = [];
    for (const k of state?.knowledge ?? []) {
      if (k.status !== 'decided') continue;
      if (k.source === 'volunteered' && k.itemTouchedAtRecord) {
        out.push({ id: k.id, itemName: itemIndex.nameOf(k.item), reason: 'そのことを聞いた後に、ユーザーが自分から話した' });
      } else if (k.source === 'added_at_confirmation') {
        out.push({ id: k.id, itemName: itemIndex.nameOf(k.item), reason: '作る前の確認で足した' });
      }
    }
    return out;
  }

  return {
    get exists() {
      return state !== null;
    },
    /** ヒアリングの最中か：このセッションの記録があり、段階が「生成」に進む前（7.4） */
    get active() {
      return state !== null && !loadError && state.stage !== 'generate';
    },
    get loadError() {
      return loadError;
    },
    get state() {
      return state;
    },
    applicableItems: () => applicableItems(state),
    itemStatus: (key) => itemStatus(state, key),
    remainingNames: () => remainingNames(state),
    remainingLine: () => remainingLine(state),
    candidates: () => candidatesOf(state),
    applyProgress,
    applyRecord,
    checkConfirmable,
    knowledgeByIds,
    commitConfirmation,
    setUrl,
    retrospectiveTargets,
  };
}

