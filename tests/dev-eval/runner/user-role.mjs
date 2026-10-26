// ユーザー役（testing.md 6.1、6.2、6.3）。外側の EVAL で、人の代わりにクリエイターの質問に答える AI。
//
// - 渡すもの（personas/FORMAT.md 5章）：profile、files の place・describe・reveal、knowledge の fact・reveal・volunteer、
//   file の answer・detail、話し方の instruction、それまでのやり取り（質問と答えに加え、クリエイターが質問の前にチャットに書いた文）。
//   渡さないもの：markers、userRoleTests、inner、id、ほかの模擬ユーザー（言葉の見分けを知らせると、答え方が変わるため）。
// - モデルは ID で固定する（claude-sonnet-5-5）。別名は、プロバイダーで解決先が変わるので使わない。ユーザー役の試験
//   （user-role-test.mjs）に通ったモデルと指示を、比べる EVAL のあいだで変えない（6.2）。
// - 話し方 hurry の signal：afterAnswers 回答えた後の次の答えに text を足し、足した位置を記録する（6.5 の REQ-015）。
// - 答えが道具の呼び出しの形（TOOL_CALL_MARKUP）なら、2回まで呼び直し、それでもだめなら試験の仕組みの失敗として投げる（6.1）。
//   呼び出しの失敗（誤りの結果、空の答え、例外）も、2回まで呼び直す。利用枠の上限（LIMIT_PATTERN）なら、呼び直さずに投げる。
//   呼ぶ側（outer-run.mjs）は、その会話を止める（利用枠の上限なら、比べる EVAL の全体も止める）。
// - 実際の Agent SDK の query() は、引数 query で差し替えられる（実際のモデルを使わない試験のため）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { agentEnv } from './isolation.mjs';

/** ユーザー役のモデル。ID で固定する */
export const USER_ROLE_MODEL = 'claude-sonnet-5-5';

/** 同じ質問を聞き直すときの言葉（ユーザー役の試験と、話し方の reask の確かめで使う） */
export const REASK_QUESTION = 'もう少し具体的に教えてください。';

/**
 * 「指示のことを話さない」の観点で見る言葉（testing.md 6.2）。ユーザー役への指示の中の言葉で、人は話さない。
 * この一覧は、ユーザー役への指示の文（下の USER_RULES など）に依るので、その文を書くここが持つ。
 * 当たっても確定ではない（最後は会話を読んで確かめる）。ナレッジの言葉として自然に出る語は入れない。
 */
export const INSTRUCTION_WORDS = /答える条件|自分から話す|答え方の決まり|聞かれているので答え|聞かれたので答え|答えてよいことに|話してよいことに|話さないことになっ|隠すように|ユーザー役|模擬ユーザー|プロンプト|システムの指示|指示されて|設定されて/;

/**
 * 1回の呼び出しに載せるやり取りの上限（古いものから落とす）と、1つの質問の文字数の上限（後ろを残す）。
 * noteChars は、クリエイターが質問の前にチャットに書いた文の上限（今の質問に付くもの。履歴に入ったものは questionChars）。
 */
export const HISTORY_LIMITS = Object.freeze({ exchanges: 40, questionChars: 1200, answerChars: 800, noteChars: 3000 });

// ユーザー役への、答え方の決まり。prototype の USER_RULES（版3）に、示すファイルと決まりの確かめを足した。
export const USER_RULES = Object.freeze([
  '聞かれたことにだけ、短く答える。聞かれていないことは言わない。',
  '「自分から話す：いいえ」のことは、答える条件にはっきり当てはまる質問のときだけ答える。「ほかに何か」「注意点」「大事なこと」「守らないと困ること」のような大まかな質問では話さない。',
  '知っていることにないことは、「特に決まっていません」と答える。推測しない。相手が例を挙げても、それに合わせて新しい決まりを作らない。最初に書いてある自分の立場と仕事（誰として、何のために、何をしているか）は、自分のこととして答えてよい。',
  '選択肢があっても、選択肢の言葉だけで済ませない。知っていることを具体的に答える（ファイル名や数字など）。選択肢のどれかに当てはまるときは、その名前（「（」や「：」の前の言葉）だけを書き、説明の部分は写さない。「名前（説明）」の形にしない。名前の後に、自分の言葉で中身を続ける。',
  'これまでのやり取りを踏まえて答える。「それ」「その2つ」などは、前の質問と答えを指す。AI が質問の前にチャットに書いた文も、読んだものとして踏まえる。',
  '質問の意味が分からないときは、短く聞き返す。質問が「上の〜」「先ほどの〜」と、あなたが読んでいないものを指していて、これまでのやり取りにも AI がチャットに書いた文にも、その中身がないときは、「上の〜とは、どれのことですか？」のように聞き返す。中身を読んでいないのに、「違いはない」「特にない」と答えない。「見えません」「表示されていません」のような、機械の言い方はしない。',
  '持っているファイルは、聞かれたときだけ、置いてある場所と中身の説明で答える。自分から示さない。持っていないファイルは、あるとは言わない。',
  'ファイルを開いて見る道具はない。ファイルの中身は、知っていることの範囲で答える。',
  '持っているファイルの決まりについて「〜という決まりですか？」と確かめられたら、4つの選択肢（そうしないときもある／違う／決まりではなく、たまたま／このとおり）のうち、そのファイルの決まりに書いてある答えを選ぶ。選んだ言葉の後に、決まりに書いてある具体的な中身を足す。選択肢の言葉だけで済ませない。',
  'この決まり、答える条件、「自分から話す」のことは口に出さない。なぜ答えるのか、なぜ答えないのかも説明しない。ふつうの人として話す。',
  'チャットで担当者に話す人の言葉で書く。同じ意味の言葉を「（　）」で重ねて書かない（「分からない（覚えていない）」のように）。説明書きのような、かしこまった型の言い方を続けない。',
]);

/**
 * 答えに混ざった、道具の呼び出しの形の文。ユーザー役は道具を使えない（tools: []）のに、持っているファイルの中身を聞かれると、
 * ファイルを読む呼び出しの形の文を答えにすることがある（外側の EVAL（改善）1回目の診断 1.4）。人はこう答えないので、クリエイターに渡さない
 */
export const TOOL_CALL_MARKUP = /<\/?(?:antml:)?(?:invoke|function_calls|parameter)\b|antml:/;
/** 答えが道具の呼び出しの形だったときに呼び直す回数の上限と、呼び直しで質問の後に足す文（testing.md 6.1） */
export const MARKUP_RETRIES = 2;
export const MARKUP_RETRY_NOTE = '答えの文だけを書いてください。道具は使えません。';
/** 呼び出しが失敗した（誤りの結果、空の答え、例外）ときに呼び直す回数の上限（testing.md 6.1） */
export const CALL_RETRIES = 2;
/** 利用枠の上限のエラーの文（agent-sdk-eval.md）。ユーザー役でもクリエイターでも、当たったら呼び直さずに止める（outer-run.mjs も使う） */
export const LIMIT_PATTERN = /hit your (session|usage|weekly)? ?limit|usage limit|rate limit|limit reached|resets at|quota/i;

/** 話し方 hurry のときだけ足す決まり。急ぐ合図の後の進め方の問いに、ユーザー役がどれを選ぶかを決めておく（以後の流れを測るため） */
export const HURRY_CHOICE_RULE = '「このまま続ける」「残りを手早く聞く」「ここでやめて後で続ける」のような、進め方を選ぶ質問が出たら、「残りを手早く聞く」を選ぶ。急いでいても、聞かれたことには答える。';

// ---- 指示の文 -----------------------------------------------------------------------------------------

const clipTail = (text, max) => {
  const chars = [...String(text ?? '')];
  return chars.length <= max ? String(text ?? '') : `…${chars.slice(chars.length - max).join('')}`;
};
const clipHead = (text, max) => {
  const chars = [...String(text ?? '')];
  return chars.length <= max ? String(text ?? '') : `${chars.slice(0, max).join('')}…`;
};

/** 選択肢（文字か { label, description }）を、{ label, description } にそろえる */
export function normalizeChoices(choices) {
  return (choices ?? [])
    .map((c) => (typeof c === 'string' ? { label: c, description: '' } : { label: String(c?.label ?? ''), description: String(c?.description ?? '') }))
    .filter((c) => c.label !== '');
}

/** ナレッジ 1 件の行 */
function knowledgeBlock(k) {
  const head = `- ${k.fact}（答える条件：${k.reveal}。自分から話す：${k.volunteer ? 'はい' : 'いいえ'}）`;
  if (k.from !== 'file' || !k.file) return head;
  const choice = k.file.answer;
  const detail = k.file.detail ? `選んだ後に足す具体的な中身：${k.file.detail}` : '選んだ後に足す具体的な中身：決まりの内容を、自分の言葉で一言足す';
  // 「そうしないときもある」「違う」の中身（例外・本当のやり方）そのものを確かめられたときは、足す話が残っていない（このとおり）
  const settled = k.file.detail ? `\n  ただし、相手が確かめてきた文の中に、すでにこの具体的な中身が書いてあるときは、足す話は残っていないので、「このとおり」を選ぶ。` : '';
  return `${head}\n  これはファイル「${k.file.path}」に書いてある決まり。相手がこの決まりを確かめてきたら、選択肢から「${choice}」を選ぶ（名前だけを書く）。${detail}${settled}`;
}

/**
 * ユーザー役のシステムプロンプト。
 * @param {object} persona persona.json の中身
 * @param {{ styleName?: string }} [options]
 */
export function buildSystemPrompt(persona, { styleName = 'normal' } = {}) {
  const parts = [persona.profile];
  // role が repo のファイル（改善の模擬ユーザーの題材のリポジトリに、初めから置いたもの）は、ユーザー役に示さない（personas/FORMAT.md 2.1）
  const files = (persona.files ?? []).filter((f) => f.role !== 'repo');
  if (persona.experience === 'never' || !files.length) {
    parts.push('この作業は、まだやったことがありません。持っているファイルはありません。ファイルを聞かれたら「ありません。まだやったことがないので」と答える。');
  } else {
    parts.push(
      `あなたが持っているファイル（作業フォルダの中にある）:\n${files
        .map((f) => `- ${f.place}：${f.describe}（答える条件：${f.reveal}）`)
        .join('\n')}`,
    );
  }
  parts.push(`あなたが知っていること:\n${persona.knowledge.map(knowledgeBlock).join('\n')}`);
  const rules = [...USER_RULES, ...(styleName === 'hurry' ? [HURRY_CHOICE_RULE] : [])];
  parts.push(`答え方の決まり:\n${rules.map((r) => `- ${r}`).join('\n')}`);
  const style = persona.styles?.[styleName];
  if (style?.instruction) {
    parts.push(`話し方：${style.instruction}\n答えの長さと言い方は、答え方の決まりより、この話し方を優先する。何を話してよいかは、答え方の決まりに従う。`);
  }
  return parts.join('\n\n');
}

/** AI がチャットに書いた文（質問の前の文）。配列は、空でないものを空行でつなぐ */
export function joinNotes(notes) {
  return (Array.isArray(notes) ? notes : [notes]).map((n) => String(n ?? '').trim()).filter(Boolean).join('\n\n');
}

/**
 * 1回の質問のプロンプト。
 * notes は、クリエイターがこの質問の前にチャットに書いた文（人は、質問と一緒にこれも読む。testing.md 6.1「それまでのやり取りも渡す」）。
 * @param {{ question: string, choices?: Array, history?: Array<{ notes?: string, question: string, answer: string }>, notes?: string|string[] }} args
 */
export function buildUserPrompt({ question, choices = [], history = [], notes = '' }) {
  const recent = history.slice(-HISTORY_LIMITS.exchanges);
  const past = recent.length
    ? `これまでのやり取り：\n${recent
        .map((h) => `${h.notes ? `AI がチャットに書いた文：${clipTail(h.notes, HISTORY_LIMITS.questionChars)}\n` : ''}AI：${clipTail(h.question, HISTORY_LIMITS.questionChars)}\nあなた：${clipHead(h.answer, HISTORY_LIMITS.answerChars)}`)
        .join('\n')}\n\n`
    : '';
  const noteText = joinNotes(notes);
  const noteLine = noteText ? `AI が質問の前にチャットに書いた文：\n${clipTail(noteText, HISTORY_LIMITS.noteChars)}\n\n` : '';
  const list = normalizeChoices(choices);
  const choiceLine = list.length
    ? `選択肢（「（」の後ろは説明。選ぶときは名前だけを使う）：\n${list.map((c) => `- ${c.label}${c.description ? `（${c.description}）` : ''}`).join('\n')}\n`
    : '';
  return `${past}${noteLine}AI からの質問：${question}\n${choiceLine}あなたの答えだけを書いてください。`;
}

// ---- Agent SDK の呼び出し --------------------------------------------------------------------------------

let sdkQuery = null;
/** 実際の Agent SDK の query()。試験では使わない（引数 query で差し替える） */
export async function loadQuery() {
  if (!sdkQuery) sdkQuery = (await import('@anthropic-ai/claude-agent-sdk')).query;
  return sdkQuery;
}

/**
 * Agent SDK で、道具なしの 1 回の呼び出しをする。
 * @returns {Promise<{ text: string, cost: number, subtype: string, isError: boolean }>}
 */
export async function queryOnce({ query, system, prompt, model = USER_ROLE_MODEL, home, cwd, envExtra = {}, base }) {
  const run = query ?? (await loadQuery());
  const options = {
    model,
    maxTurns: 1,
    tools: [],
    settingSources: [],
    systemPrompt: system,
    cwd,
    env: agentEnv({ home, extra: envExtra, ...(base ? { base } : {}) }),
    persistSession: false,
  };
  let text = '';
  let cost = 0;
  let subtype = 'none';
  let isError = false;
  for await (const m of run({ prompt, options })) {
    if (m.type === 'result') {
      subtype = m.subtype ?? 'success';
      isError = Boolean(m.is_error) || subtype !== 'success';
      text = typeof m.result === 'string' ? m.result.trim() : '';
      cost = m.total_cost_usd ?? 0;
    }
  }
  return { text, cost, subtype, isError };
}

/**
 * ユーザー役の答えを 1 つ得る。
 * - 呼び出しが失敗した（誤りの結果、空の答え、例外）ら、CALL_RETRIES 回まで呼び直す。それでも失敗したら投げる（code が call_failed）。
 *   失敗の文が利用枠の上限（LIMIT_PATTERN）に当たるときは、呼び直さずに投げる（code が usage_limit）。
 * - 答えが道具の呼び出しの形（TOOL_CALL_MARKUP）なら、質問の後に MARKUP_RETRY_NOTE を足して、MARKUP_RETRIES 回まで呼び直す。
 *   それでも直らなければ、試験の仕組みの失敗として投げる（code が tool_markup。クリエイターに渡さない）。
 * 投げる Error の cost は、それまでの呼び出しの費用。
 * @returns {Promise<{ text: string, cost: number, retries: number, callRetries: number }>} retries は道具の呼び出しの形での呼び直しの回数、
 *   callRetries は呼び出しの失敗での呼び直しの回数
 */
export async function answerOnce({ prompt, ...rest }) {
  let cost = 0;
  let retries = 0;
  let callRetries = 0;
  for (;;) {
    let r;
    try {
      r = await queryOnce({ ...rest, prompt: retries ? `${prompt}\n${MARKUP_RETRY_NOTE}` : prompt });
    } catch (error) {
      r = { text: '', cost: 0, subtype: 'exception', isError: true, message: error?.message ?? String(error) };
    }
    cost += r.cost;
    if (r.isError || r.text === '') {
      const detail = String(r.message ?? r.text ?? '');
      const limited = LIMIT_PATTERN.test(detail);
      if (!limited && callRetries < CALL_RETRIES) {
        callRetries += 1;
        continue;
      }
      throw Object.assign(
        new Error(`ユーザー役の呼び出しに失敗しました（${r.subtype}${callRetries ? `。${callRetries + 1} 回続けて` : ''}）${detail ? `：${detail.slice(0, 200)}` : ''}`),
        { code: limited ? 'usage_limit' : 'call_failed', cost },
      );
    }
    if (!TOOL_CALL_MARKUP.test(r.text)) return { text: r.text, cost, retries, callRetries };
    if (retries >= MARKUP_RETRIES) {
      throw Object.assign(
        new Error(`ユーザー役の答えが、${retries + 1} 回続けて道具の呼び出しの形でした（試験の仕組みの失敗。クリエイターには渡していません）：${r.text.slice(0, 200)}`),
        { code: 'tool_markup', cost },
      );
    }
    retries += 1;
  }
}

/**
 * ユーザー役に 1 つ質問する（履歴は呼ぶ側が渡す）。
 * @returns {Promise<{ text: string, cost: number, retries: number, callRetries: number }>} retries と callRetries は answerOnce と同じ
 */
export async function askUserRole(persona, question, choices, { history = [], notes = '', styleName = 'normal', query, model = USER_ROLE_MODEL, home, cwd, envExtra, base } = {}) {
  const system = buildSystemPrompt(persona, { styleName });
  const prompt = buildUserPrompt({ question, choices, history, notes });
  const ownHome = home === undefined;
  const useHome = home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'user-role-home-'));
  const useCwd = cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'user-role-cwd-'));
  try {
    return await answerOnce({ query, system, prompt, model, home: useHome, cwd: useCwd, envExtra, base });
  } finally {
    if (ownHome) fs.rmSync(useHome, { recursive: true, force: true });
    if (cwd === undefined) fs.rmSync(useCwd, { recursive: true, force: true });
  }
}

// ---- 1 回の会話を通してのユーザー役 ----------------------------------------------------------------------

/**
 * 1 回の会話（外側の EVAL の 1 回）のユーザー役。やり取りの履歴と、hurry の合図の位置を持つ。
 * @param {object} args
 * @param {object} args.persona
 * @param {string} [args.styleName]
 * @param {Function} [args.query] Agent SDK の query()（試験で差し替える）
 * @param {string} [args.model]
 * @param {string} args.home 一時的なホームフォルダ（会話の間、使い回す）
 * @param {string} [args.cwd]
 * @param {object} [args.envExtra]
 */
export function createUserRole({ persona, styleName = 'normal', query, model = USER_ROLE_MODEL, home, cwd, envExtra, base }) {
  if (!persona?.styles?.[styleName]) throw new Error(`話し方「${styleName}」は、この模擬ユーザーにありません。`);
  const style = persona.styles[styleName];
  const history = [];
  const answers = [];
  const signals = [];
  let cost = 0;
  const workCwd = cwd ?? home;
  // 1 つのユーザー役への質問は、順に 1 つずつ（履歴の並びが崩れないように）
  let chain = Promise.resolve();

  async function answerNow(question, choices, via, meta, notes) {
    const system = buildSystemPrompt(persona, { styleName });
    const noteText = joinNotes(notes);
    const prompt = buildUserPrompt({ question, choices, history, notes: noteText });
    let r;
    try {
      r = await answerOnce({ query, system, prompt, model, home, cwd: workCwd, envExtra, base });
    } catch (error) {
      cost += error.cost ?? 0;
      throw error;
    }
    cost += r.cost;
    const index = answers.length;
    let text = r.text;
    let signal = null;
    if (style.signal && index === style.signal.afterAnswers) {
      // 急ぐ合図：afterAnswers 回答えた後の次の答えに、text を足す
      text = `${text}\n${style.signal.text}`;
      signal = { answerIndex: index, text: style.signal.text };
      signals.push(signal);
    }
    history.push({ ...(noteText ? { notes: noteText } : {}), question, answer: text });
    const entry = { index, via, question, ...(noteText ? { notes: noteText } : {}), choices: normalizeChoices(choices), answer: text, rawAnswer: r.text, cost: r.cost, signal: signal !== null, ...(r.retries ? { markupRetries: r.retries } : {}), ...(r.callRetries ? { callRetries: r.callRetries } : {}), ...meta };
    answers.push(entry);
    return entry;
  }

  return {
    persona,
    styleName,
    /**
     * 質問に答える。via は 'AskUserQuestion' か 'text'。順に 1 つずつ動く。
     * notes は、クリエイターが質問の前にチャットに書いた文（前の答えの後から、この質問まで）。
     */
    answer(question, choices = [], via = 'AskUserQuestion', meta = {}, notes = '') {
      const run = chain.then(() => answerNow(question, choices, via, meta, notes));
      chain = run.catch(() => {});
      return run;
    },
    get history() {
      return history;
    },
    get answers() {
      return answers;
    },
    get signals() {
      return signals;
    },
    get cost() {
      return cost;
    },
    get answerCount() {
      return answers.length;
    },
  };
}
