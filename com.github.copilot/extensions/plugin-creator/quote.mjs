// ユーザーの言葉の抜き書き（quote）の確かめ（外側の EVAL の1回目で落ちた2観点への守り）。
//
// - 項目を未着手から変えるときの quote は、それより前の問答の記録（ユーザーの答えと打った発言）のどれか1つの中にある（hearing.md 7.2、testing.md 6.5）。
//   見つかるかどうかの決め方は、外側の EVAL の採点（tests/dev-eval/runner/outer-grade.mjs の normalizeQuote・quoteFound）と同じ。
//   重ねて持つので、ずれは tests/creator/extension/quote.test.mjs が見張る（同じ場合分けを両方に通す）。
// - 生成前の確認で足したナレッジの quote が、ユーザーが選んだ選択肢の文だけなら、足したことにならない
//   （「違うところはない」を選んだだけで、AI の案を「ユーザーが足した決まり」として記録した事故。意味の確かめはできないが、この形は見分けられる）。

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
 * 頼みの文（request）は数えない（hearing.md 7.4。外側の EVAL の採点が、最初の依頼の文を抜き書きの出どころに含めないため）。
 * @param {Array<object>} qa store.readQa() の返り値
 */
export function userWords(qa) {
  const words = [];
  for (const entry of Array.isArray(qa) ? qa : []) {
    if (entry?.type === 'ask_user' && (entry.outcome ?? 'answered') === 'answered' && typeof entry.answer === 'string') words.push(entry.answer);
    else if (entry?.type === 'user_prompt' && typeof entry.text === 'string') words.push(entry.text);
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
