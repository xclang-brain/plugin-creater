// ユーザーの言葉の抜き書き（quote）の確かめ（外側の EVAL の1回目で落ちた2観点への守り）。
//
// - 項目を未着手から変えるときの quote は、それより前の問答の記録（ユーザーの答えと打った発言）のどれか1つの中にある（hearing.md 7.2、testing.md 6.5）。
//   見つかるかどうかの決め方は、外側の EVAL の採点（tests/dev-eval/runner/outer-grade.mjs の normalizeQuote・quoteFound）と同じ。
//   重ねて持つので、ずれは tests/creator/extension/quote.test.mjs が見張る（同じ場合分けを両方に通す）。
//   今のプラグインを直すときは、頼みの文も数える（項目「前回の1回」を除く。どちらを数えるかは hearing.mjs が決める。REQ-056）。
// - 生成前の確認で足したナレッジの quote が、ユーザーが選んだ選択肢の文だけなら、足したことにならない
//   （「違うところはない」を選んだだけで、AI の案を「ユーザーが足した決まり」として記録した事故。意味の確かめはできないが、この形は見分けられる）。
// - 直すときに、引き継いだ決まりを中身を変えずに「決まった」にする quote は、その番号を示した ask_user の問いへの答えの中にある
//   （外側の EVAL（改善）の1回目で、決まりの一覧の問いを飛ばし、一覧を見ていないユーザーの「ほかはそのとおり」で決まったにした事故。hearing.md 7.2）。
//   もう「決まった」の行を記録し直すときは、hearing.mjs が確かめない（一度この確かめを通っているため）。

/** 抜き書きと答えを比べるための正規化（空白と、句読点・かぎ括弧の違いを無視する） */
export function normalizeQuote(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .replace(/[「」『』"'“”‘’、。,.，．・]/gu, '');
}

/** 抜き書きが、答えのどれかの中にあるか。「…」「...」で区切った断片は、すべてが同じ答えの中にあればよい */
export function quoteFound(quote, answers) {
  const parts = String(quote ?? '')
    .split(/…|\.\.\.|⋯/u)
    .map(normalizeQuote)
    .filter((p) => p.length > 0);
  if (parts.length === 0) return false;
  return answers.some((answer) => {
    const text = normalizeQuote(answer);
    return parts.every((p) => text.includes(p));
  });
}

/**
 * 問答の記録から、ユーザーの言葉を取り出す：答えが来た ask_user の答え（取り消しと断りは除く）と、ユーザーが打った発言。
 * 頼みの文（request）は、既定では数えない（作る流れ。hearing.md 7.4。外側の EVAL の採点が、最初の依頼の文を抜き書きの出どころに含めないため）。
 * request を true にすると、頼みの文も数える（今のプラグインを直すとき。頼みの文をユーザーの答えと同じに扱う。REQ-056、hearing.md 7.2）。
 * @param {Array<object>} qa store.readQa() の返り値
 * @param {{ request?: boolean }} [options]
 */
export function userWords(qa, { request = false } = {}) {
  const words = [];
  for (const entry of Array.isArray(qa) ? qa : []) {
    if (entry?.type === 'ask_user' && (entry.outcome ?? 'answered') === 'answered' && typeof entry.answer === 'string') words.push(entry.answer);
    else if (entry?.type === 'user_prompt' && typeof entry.text === 'string') words.push(entry.text);
    else if (request && entry?.type === 'request' && typeof entry.text === 'string') words.push(entry.text);
  }
  return words;
}

/** ask_user の問いの選択肢の文。引数の形が違っても（choices、options、requestedSchema の enum・oneOf）、あるものを集める */
export function choicesOf(question) {
  const found = [];
  const add = (...texts) => {
    for (const t of texts) if (typeof t === 'string' && t.trim() !== '') found.push(t);
  };
  const fromChoice = (choice) => {
    if (typeof choice === 'string') return add(choice);
    if (choice === null || typeof choice !== 'object') return undefined;
    const names = [choice.label, choice.title, choice.const, choice.value].filter((v) => typeof v === 'string' && v.trim() !== '');
    add(...names);
    // 選択肢の文とその説明をつなげたものも、選択肢の文として数える
    if (names.length > 0 && typeof choice.description === 'string' && choice.description.trim() !== '') add(`${names[0]}${choice.description}`);
    return undefined;
  };
  const fromField = (field) => {
    if (field === null || typeof field !== 'object') return;
    for (const list of [field.enum, field.enumNames, field.oneOf, field.anyOf, field.items?.enum, field.items?.oneOf, field.items?.anyOf]) {
      if (Array.isArray(list)) list.forEach(fromChoice);
    }
  };
  if (question !== null && typeof question === 'object') {
    for (const list of [question.choices, question.options]) {
      if (Array.isArray(list)) list.forEach(fromChoice);
    }
    for (const field of Object.values(question.requestedSchema?.properties ?? {})) fromField(field);
  }
  return found;
}

/**
 * quote が、ユーザーが選んだ選択肢の文だけと同じか。
 * 答えが来た ask_user のうち、問いの選択肢の文に当たり、その文が答えの中にある（選ばれた）ものと比べる。
 */
export function isOnlyChosenOption(quote, qa) {
  const wanted = normalizeQuote(quote);
  if (wanted === '') return false;
  for (const entry of Array.isArray(qa) ? qa : []) {
    if (entry?.type !== 'ask_user' || (entry.outcome ?? 'answered') !== 'answered' || typeof entry.answer !== 'string') continue;
    const answer = normalizeQuote(entry.answer);
    for (const choice of choicesOf(entry.question)) {
      const normalized = normalizeQuote(choice);
      if (normalized !== '' && normalized === wanted && answer.includes(normalized)) return true;
    }
  }
  return false;
}

/** 値の中の文字をすべて集める（ask_user の引数の形に依らず、問いの文と選択肢の文を拾う） */
function stringsIn(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}

/**
 * quote が、決まりの番号 id（K-01 など）を示した ask_user の問いへの答えの中にあるか。
 * - 問いは、引数の中のすべての文字（見出し・問いの文・選択肢の文）で見る。番号は、前後が英数字でない形で出ていればよい
 *   （K-01 は K-010・K-01a・AK-01 に当たらない）。決まりの文は見ない（長い文を縮めて示したときに止まり続けないため。文を示すことはスキルの文に任せる。hearing.md 7.2）。
 * - 答えは、答えが来た ask_user の答えと、答えが来なかった（取り消した・答えられなかった）ask_user のすぐ次に打った発言である
 *   （答えが来ないときは、チャットに答えを書くよう示して止まるので、その発言がその問いへの答えになる。hearing.md 5.5）。
 * - 問答の記録に ask_user が1件もないときは、確かめずに通す（hearing.mjs の quoteInUserWords と同じ理由）。
 */
export function quoteInAnswerShowing(quote, id, qa) {
  const entries = Array.isArray(qa) ? qa : [];
  if (!entries.some((entry) => entry?.type === 'ask_user')) return true;
  const escaped = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const shows = new RegExp(`(?<![0-9A-Za-z])${escaped}(?![0-9A-Za-z])`, 'u');
  const answers = [];
  entries.forEach((entry, i) => {
    if (entry?.type !== 'ask_user' || !shows.test(stringsIn(entry.question).join('\n'))) return;
    if ((entry.outcome ?? 'answered') === 'answered') {
      if (typeof entry.answer === 'string') answers.push(entry.answer);
      return;
    }
    const next = entries[i + 1];
    if (next?.type === 'user_prompt' && typeof next.text === 'string') answers.push(next.text);
  });
  return quoteFound(quote, answers);
}
