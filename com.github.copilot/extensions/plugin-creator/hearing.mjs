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
// - 今のプラグインを直すとき（記録の change がある。REQ-052〜061、BLUEPRINT 4.1・4.2）：
//   - 記録は plugin-creator_change だけが作る（applyChange）。作る記録があるセッションでは断る。
//   - 項目の状態「変えないので聞かない」は、直すときだけ、未着手からだけ使える。「前回の1回」と、作っていないプラグインでは使えない。
//   - 引き継いだ決まり（carried）の中身を直す記録が来たら、元の行を「外した」にし、新しい番号の行（replaces＝元の番号）を「決まった」で足す（REQ-058）。
//     中身の直しは、ユーザーが今の中身を答えたときだけなので、状態「決まった」のほかは断る。
//   - 生成プラグインを直すとき、引き継いだ決まりを中身を変えずに「決まった」にする記録は、抜き書きが、その番号を示した ask_user の問いへの答えの中に
//     あるときだけ受け付ける（決まりの一覧の問いを飛ばさないため。REQ-054、hearing.md 7.2）。問答の記録に ask_user がなければ、確かめずに通す。
//   - 段階と項目「できていたことの確認」は使わない（できていたことは、すべて引き継ぐ。REQ-054）。

import crypto from 'node:crypto';
import fs from 'node:fs';

import { isOnlyChosenOption, quoteFound, quoteInAnswerShowing, userWords } from './quote.mjs';

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
  confirmWordFor,
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
    change: null, // 今のプラグインを直すとき（BLUEPRINT 4.1）。plugin-creator_change が作る
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

/** ユーザーに見せる確認の呼び名。直すときは「直す前の確認」、作るときは「作る前の確認」 */
export const confirmWord = (s) => confirmWordFor(Boolean(s?.change));

/** 直すプラグインの見出し（名前と今の版） */
export const pluginLabel = (change) => `${change.name}、今の版 ${change.version ?? 'なし'}`;

const MAKE_RECORD_MESSAGE = 'このセッションでは、新しく作るか作り直すお話を聞いています。今のプラグインを直すときは、/clear してから頼み直してください。';
const REBUILD_IN_CHANGE_MESSAGE = '今のプラグインを直すときは、できていたことは聞かずに、すべて引き継ぎます。段階と聞くこと「できていたことの確認」は使いません。';

/** 直すときの、これからの流れ（hearing.md 3.4。直す流れの記録を新しく作ったときに、返り値で示す）。段階を words.md の言葉で並べる */
const FLOW_GENERATED =
  'これから、次の順に進めます。今使っているファイルを教えてもらう → プラグインを読み、引き継ぐことと変えるところを確かめる → 今の決まりの一覧を確かめる → 変えるところに関わる作業の、最近やった1回の流れを聞く → 読み取った決まりを確かめる → 聞き漏らしがないかを見る → 使っている道具（作業の画面を変えるときは、画面で見たいことも） → 直す前に、まとめを確かめてもらう。そのあと、プラグインのフォルダを直して試験し、コミットします。push はしません。';
/** plugin-creator が作っていないプラグインのとき：決まりの一覧の確かめはなく、最近の1回は作業の最初から最後まで聞き、画面で見たいことも聞く */
const FLOW_NOT_GENERATED =
  'これから、次の順に進めます。今使っているファイルを教えてもらう → プラグインを読み、引き継ぐことと変えるところを確かめる → 作業の最初から最後まで、最近やった1回の流れを聞く → 読み取った決まりを確かめる → 聞き漏らしがないかを見る → 使っている道具 → 作業の画面で見たいこと → 直す前に、まとめを確かめてもらう。そのあと、プラグインのフォルダを直して試験し、コミットします。push はしません。';

/** 項目の状態が、聞いていないもの（未着手か、変えないので聞かない）か */
const notAsked = (status) => status === 'todo' || status === 'unchanged';

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

  /** 項目の状態「変えないので聞かない」にしてよいか（REQ-056、BLUEPRINT 4.1）。だめなら断る */
  function checkUnchanged(next, item) {
    if (!next.change) throw new Refusal(`「変えないので聞かない」は、今のプラグインを直すときだけ使えます。「${item.name}」は、聞いてから記録してください。`);
    if (!next.change.generated) {
      throw new Refusal('plugin-creator が作っていないプラグインを直すときは、プラグインの形を変えること自体が変えるところなので、「変えないので聞かない」は使えません。聞くことは、すべて聞いてください。');
    }
    if (item.key === 'last_case') throw new Refusal('「前回の1回」は、変えるところに関わる最近の1回をいつも聞くので、「変えないので聞かない」にはできません。');
    const current = statusOf(next, item.key);
    if (!notAsked(current)) {
      throw new Refusal(`「${item.name}」は、もう聞いているので（今の状態：${itemStatusIndex.nameOf(current)}）、「変えないので聞かない」にはできません。「変えないので聞かない」にできるのは、状態が「未着手」のものだけです。`);
    }
  }

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
        if (item.key === 'rebuild_check' && next.change) throw new Refusal(REBUILD_IN_CHANGE_MESSAGE);
        if (status.key === 'unchanged') checkUnchanged(next, item);
        if (!has(e.quote)) {
          throw new Refusal(`「${item.name}」の状態を変えるには、ユーザーの言葉の抜き書き（quote）を添えてください。`);
        }
        // 未着手（か、変えないので聞かない）から変えるときの抜き書きは、それより前のユーザーの言葉のどれか1つの中にある（採点と同じ決め方。要約や言い換えは断る）
        if (notAsked(statusOf(next, item.key)) && !quoteInUserWords(e.quote)) {
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
      if (stageKey === 'rebuild_check' && next.change) throw new Refusal(REBUILD_IN_CHANGE_MESSAGE);
      if (stageKey === 'generate') {
        if (!state?.confirmation) {
          throw new Refusal(`段階を「生成」に進める前に、${confirmWord(state)}で示すものを plugin-creator_confirm で知らせて、ユーザーによいと答えてもらってください。`);
        }
        const changed = changesSinceConfirmation();
        if (changed) {
          throw new Refusal(`${confirmWord(state)}で示した仕事のやり方や決まりの一覧と、今の「決まった」ものが違います（${changed}）。plugin-creator_confirm で示し直して、ユーザーによいと答えてもらってください。`);
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

  /** 引き継いだ決まりの中身（種類・項目・文・例・例外）を変える記録か（REQ-058。例と例外の直しも中身の直し） */
  function contentChanged(existing, fields) {
    return ['kind', 'item', 'text', 'example', 'exception'].some((f) => f in fields && fields[f] !== (existing[f] ?? null));
  }

  /**
   * 引き継いだ決まりの中身を直す記録：元の行を「外した」にし、新しい番号の行（replaces＝元の番号）を足す（REQ-058、決定17、BLUEPRINT 4.2）。
   * 渡されていない欄は元の値。新しい行の状態は「決まった」（ほかの状態は applyKnowledge が断る）。出どころは渡されなければ「ヒアリングの答え」。
   */
  function renumber(next, existing, fields, quote) {
    existing.status = 'dropped';
    existing.quote = quote;
    existing.updatedAt = iso();
    next.knowledgeCounter += 1;
    const id = knowledgeNumber(next.knowledgeCounter);
    const item = fields.item ?? existing.item;
    next.knowledge.push({
      id,
      kind: fields.kind ?? existing.kind,
      item,
      itemName: itemIndex.nameOf(item),
      text: fields.text ?? existing.text,
      source: fields.source ?? 'answer',
      quote,
      example: 'example' in fields ? fields.example : existing.example ?? null,
      exception: 'exception' in fields ? fields.exception : existing.exception ?? null,
      status: 'decided',
      replaces: existing.id,
      recordedAt: iso(),
      updatedAt: iso(),
      itemTouchedAtRecord: !notAsked(statusOf(next, item)),
    });
    return id;
  }

  function applyKnowledge(next, e, added, updated, replaced) {
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
      // 中身を直して付け直した元の行は、変えない（同じ決まりが2つの番号で残らないように。付け直した行を外せば、元の行をまた扱える）
      const replacer = next.knowledge.find((k) => k.replaces === existing.id && k.status !== 'dropped');
      if (replacer) {
        throw new Refusal(`仕事のやり方や決まり ${existing.id} は、中身を直して ${replacer.id} にしました。直すときは ${replacer.id} を渡してください。`);
      }
      if (existing.carried && contentChanged(existing, fields)) {
        // 付け直すのは、ユーザーが今の中身を答えたときだけ。付け直した行は「決まった」か「外した」だけにする
        // （「候補」の付け直しがあると、決まりの変わり方で、元の番号が付け直しでなく外したものに見えるため）
        if (fields.status !== undefined && fields.status !== 'decided') {
          throw new Refusal(
            `仕事のやり方や決まり ${existing.id} は引き継いだ決まりなので、中身（種類・聞くこと・文・例・例外）を直すのは、ユーザーが今の中身を答えたときだけです。状態は「決まった」で渡してください。決まりでなくなったときは、中身を変えずに、状態を「外した」にしてください。`,
          );
        }
        const id = renumber(next, existing, fields, text(e.quote));
        replaced.push([existing.id, id]);
        return { id, fields };
      }
      // もう「決まった」の行（この確かめを通ったもの）を記録し直すときは確かめない。断ると、決めた一覧の問いをもう一度させてしまうため
      if (
        existing.carried &&
        next.change?.generated &&
        fields.status === 'decided' &&
        existing.status !== 'decided' &&
        !quoteInAnswerShowing(e.quote, existing.id, store.readQa())
      ) {
        throw new Refusal(
          `仕事のやり方や決まり ${existing.id} は引き継いだ決まりです。中身を変えずに「決まった」にできるのは、その番号と文を示した問いへの答えの中に、抜き書き（quote）があるときだけです。引き継いだ決まりのすべての番号と文を1つの問いの文に入れて聞き、その答えの言葉を、そのまま写してください。`,
        );
      }
      Object.assign(existing, fields, { quote: text(e.quote), updatedAt: iso() });
      if (fields.item !== undefined) existing.itemName = itemIndex.nameOf(existing.item); // 項目を直したときも、日本語の名前をそろえる
      updated.push(existing.id);
      return { id: existing.id, fields };
    }
    const missing = ['kind', 'item', 'text', 'source', 'status'].filter((f) => e[f] === undefined || (typeof e[f] === 'string' && !has(e[f])));
    if (missing.length) {
      throw new Refusal(`新しい仕事のやり方や決まりに足りない欄：${missing.map((f) => KNOWLEDGE_FIELDS_JA[f]).join('、')}`);
    }
    const fields = checkKnowledgeFields(e, '新しい仕事のやり方や決まりの');
    if (fields.source === 'added_at_confirmation' && isOnlyChosenOption(text(e.quote), store.readQa())) {
      throw new Refusal(
        `${confirmWord(next)}で足すのは、ユーザーが答えの中で自分の言葉で述べた決まりだけです。抜き書き（quote）に、その決まりを述べたユーザーの言葉を入れてください。示したものに「違うところはない」と答えただけなら、記録しないでください。`,
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
      itemTouchedAtRecord: !notAsked(statusOf(next, fields.item)),
    });
    added.push(id);
    return { id, fields };
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
    const replaced = [];
    const exceptionCriteria = [];
    for (const e of knowledge ?? []) {
      const { id, fields } = applyKnowledge(next, e, added, updated, replaced);
      const row = next.knowledge.find((k) => k.id === id);
      // 種類か例外を渡して、例外のある合否の決め方になった行。合格の条件には文だけが渡るので、文に例外のときの合格を書くよう促す（hearing.md 6.1、7.5）
      const exceptionCriterion = row.kind === 'criterion' && row.exception && row.status !== 'dropped';
      if ((fields.kind !== undefined || fields.exception !== undefined) && exceptionCriterion && !exceptionCriteria.includes(id)) {
        exceptionCriteria.push(id);
      }
    }

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
    for (const [from, to] of replaced) parts.push(`仕事のやり方や決まり ${from} の中身を直したので、${from} を外して ${to} にしました`);
    if (assetCount) parts.push(`資産${assetCount}件`);
    if (ossCount) parts.push(`標準機能と公開のプラグイン${ossCount}件`);
    const open = candidatesOf(next).length;
    const done = `記録しました（${parts.join('、')}）。${open ? `確かめたいこと：${open}件` : '確かめたいことはありません。'}`;
    // 種類を後で「合否の決め方」に変えるとき（生成前の確認の基準の案など）は、決まりの確かめの手順（rules.md）を読んでいないので、返り値で促す。
    // 外側の EVAL（改善）の3回目では、例外のある決まりを確認の前に合否の決め方にしたとき、文から例外が落ちた
    const nudge = exceptionCriteria.length
      ? `${exceptionCriteria.join('、')} は、例外のある合否の決め方です。合格の条件には文だけが渡るので、文に、例外のときに何なら合格かが書かれていなければ、文を直して記録し直してください。`
      : '';
    return nudge ? `${done}${done.endsWith('。') ? '' : '。'}${nudge}` : done;
  }

  // ---- confirm ----------------------------------------------------------------

  /** 生成前の確認を受け付けてよいか。未着手の項目が残っていれば、残りを返して断る（5.7、6.3） */
  function checkConfirmable() {
    assertWritable();
    const names = remainingNames(state);
    if (names.length) {
      throw new Refusal(`まだ聞いていないことがあるので、${confirmWord(state)}はできません：${names.join('、')}。聞いてから、もう一度知らせてください。`);
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
    return `${confirmWord(state)}で示した画面と合格の条件の設定の案が、${what}。作業の画面の見本を直したときは、plugin-creator_confirm で示し直して、ユーザーによいと答えてもらってください。`;
  }

  // ---- 今のプラグインを直す（plugin-creator_change） ------------------------------------------------

  /**
   * 直すプラグインの記録を作る（REQ-052・054・058、BLUEPRINT 4.1）。新しい記録を段階「始まり」で作り、
   * 決まりの一覧（tests/knowledge.json）の決まりを、元の番号・種類・項目・文のまま、確かめたいこととして取り込む。
   * 同じフォルダの記録がすでにあれば、変えたいことだけを置き換える（再開とコンパクションの後のため。取り込み直さない）。
   * 作る記録があるセッションと、違うフォルダは断る（取り込む番号と、作る流れで付けた番号が重なるため）。
   * @param {{ folder: string, wants: string[], readPlugin: () => object }} input readPlugin は change.mjs の readPluginForChange（新しく作るときだけ呼ぶ）
   */
  function applyChange({ folder, wants, readPlugin }) {
    assertWritable();
    if (state && !state.change) throw new Refusal(MAKE_RECORD_MESSAGE);
    if (state?.change) {
      if (state.change.folder !== folder) {
        throw new Refusal(`このセッションでは、別のプラグイン（${state.change.folder}）を直すお話を聞いています。ほかのプラグインを直すときは、/clear してから頼み直してください。`);
      }
      const next = clone(state);
      next.change.wants = wants;
      commit(next);
      return `直すプラグインの記録は、もうあります（${pluginLabel(next.change)}）。変えたいことを置き換えました。決まりは取り込み直していません。`;
    }

    const plugin = readPlugin();
    const at = iso();
    const next = freshState({ sessionId, now: at });
    next.change = {
      folder,
      manifest: plugin.manifest,
      name: plugin.name,
      version: plugin.version,
      generated: plugin.generated,
      carried: plugin.knowledge.map((k) => k.id),
      removed: plugin.removed,
      maxId: plugin.maxId,
      criteriaIds: plugin.criteriaIds,
      evalPrompts: plugin.evalPrompts,
      wants,
      startedAt: at,
    };
    next.knowledge = plugin.knowledge.map((k) => ({
      id: k.id,
      kind: k.kind,
      item: k.item,
      itemName: k.itemName,
      text: k.text,
      source: 'existing_plugin',
      quote: `tests/knowledge.json の ${k.id}`,
      example: null,
      exception: null,
      status: 'candidate',
      carried: true,
      recordedAt: at,
      updatedAt: at,
      itemTouchedAtRecord: false,
    }));
    next.knowledgeCounter = plugin.maxId; // 新しい番号は、これまでに使った番号の最大の次から（D15）
    commit(next);

    const head = `直すプラグインとして記録しました（${pluginLabel(next.change)}）。`;
    // これからの流れの文そのものを返し、そのまま書かせる（hearing.md 3.4。流れの文はここにだけ置く）。
    // 外側の EVAL（改善）の1〜4回目は、手順で（4回目は返り値でも）「流れを書いて」と言うだけでは、次が流れを書く手順だけになっても書かずに進んだ。
    // 画面の URL は、書く1行そのものを返したら書けた。ユーザーの言い方（スキルかファイルか）は分からないので、
    // 「今使っているファイル」と書く（words.md は「スキル」を話さない）
    const flow = `\n次の行を、ほかのツールを呼ぶ前に、そのままチャットの文に書いて、ユーザーに示してください。\n${plugin.generated ? FLOW_GENERATED : FLOW_NOT_GENERATED}`;
    const nextId = `新しい決まりは ${knowledgeNumber(next.knowledgeCounter + 1)} から付きます。`;
    if (!plugin.generated) {
      return `${head}決まりの一覧（tests/knowledge.json）と ${plugin.taskRel} がそろっていないので、plugin-creator が作っていないプラグインとして扱います。読み取った決まりは、1件ずつ確かめてください。${nextId}${flow}`;
    }
    const ids = next.change.carried;
    if (ids.length === 0) return `${head}決まりの一覧（tests/knowledge.json）に決まりがないので、取り込んだものはありません。${nextId}${flow}`;
    const range = ids.length === 1 ? ids[0] : `${ids[0]}〜${ids[ids.length - 1]}`;
    return `${head}仕事のやり方や決まり ${range} の${ids.length}件を、確かめたいこととして取り込みました。${nextId}${flow}`;
  }

  /**
   * 決まりの変わり方（直すとき。REQ-057・060）。ids を渡すと、その番号（確認で示したもの）を今の決まりとして数える。省くと「決まった」もの。
   * 足した：引き継いでいない今の決まり（付け直したものを除く）。直した：付け直したもの { from, to }。外した：引き継いだ決まりのうち、外して付け直していないもの。
   */
  function knowledgeChanges(ids = null) {
    const rows = state?.knowledge ?? [];
    const shown = ids ? new Set(ids) : null;
    const kept = rows.filter((k) => (shown ? shown.has(k.id) : k.status === 'decided'));
    const replaced = kept.filter((k) => k.replaces).map((k) => ({ from: k.replaces, to: k.id }));
    const replacedFrom = new Set(replaced.map((r) => r.from));
    return {
      added: kept.filter((k) => !k.carried && !k.replaces).map((k) => k.id),
      replaced,
      removed: rows.filter((k) => k.carried && k.status === 'dropped' && !replacedFrom.has(k.id)).map((k) => k.id),
    };
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
        out.push({ id: k.id, itemName: itemIndex.nameOf(k.item), reason: `${confirmWord(state)}で足した` });
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
    /** 今のプラグインを直す記録か */
    get isChange() {
      return Boolean(state?.change);
    },
    applicableItems: () => applicableItems(state),
    itemStatus: (key) => itemStatus(state, key),
    remainingNames: () => remainingNames(state),
    remainingLine: () => remainingLine(state),
    candidates: () => candidatesOf(state),
    applyProgress,
    applyRecord,
    applyChange,
    knowledgeChanges,
    checkConfirmable,
    knowledgeByIds,
    commitConfirmation,
    setUrl,
    retrospectiveTargets,
  };
}

