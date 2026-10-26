// 記録のツールの定義（6.2）。つなぎ口は、これを登録するだけにする。
// name は名前の後ろの部分。登録する名前は toolFullName() で作る（例：weekly-report_plan）。
// description は、モデルの振る舞いを決める自然言語の部品である（BLUEPRINT 6章。R1 の決まりに沿って書いた）。
// 記録のツールは、画面の状態を書くだけで外を変えないので、許可の確認を省いて登録する（4.14）。

const integerSchema = { type: 'integer', minimum: 1 };

export const TOOL_DEFS = Object.freeze([
  {
    name: 'open',
    caller: 'main',
    skipPermission: true,
    description:
      '名前の頭（`_open` の前の部分）と同じ名前のプラグインの作業を、ユーザーから頼まれたときに呼ぶ。どんな作業かは、そのプラグインのスキルの説明にある。作業の Web管理画面（ブラウザーで開く画面）を用意し、その URL と、ユーザーに伝える注意を返す。作業はまだ始まらず、ユーザーが画面で設定して開始ボタンを押すと始まる。実行中に呼ぶと、新しくは始めず、今の画面の URL を返す。実行が終わった後に呼ぶと、画面が次の実行の準備に戻る（前の結果も画面で開ける）。',
    parameters: {
      type: 'object',
      properties: {
        requestText: { type: 'string', description: 'ユーザーが頼んだ作業の文。ユーザーの言葉のまま渡す。' },
      },
      required: ['requestText'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan',
    caller: 'orchestrator',
    skipPermission: true,
    description:
      '統括エージェントが、試行ごとに、作業エージェントに頼む前に呼ぶ。試行の番号、評価基準、計画を記録し、画面に出す。番号は 1 から順に、繰り返しの上限まで。評価基準には、ユーザーと確かめた合否の基準を、番号と文を受け取ったとおりに、すべて入れる（足す基準は、重ならない番号で入れてよい）。頼まれた作業の文が、ユーザーと確かめた基準と食い違うときは、基準を優先し、頼みの文の使わない部分を計画に書く。2回目からは、前の試行の指摘への対応を計画に書く。決まりに合わない記録は、理由を返して断る。返った理由に従い、直せるときは直して呼び直す。「作業を終えてください」と返ったら、呼び直さない。すべての評価基準を満たした後と、上限の回数の試行の合否が記録された後は、まとめに進むよう返して断る。',
    parameters: {
      type: 'object',
      properties: {
        iteration: { ...integerSchema, description: '試行の番号。1 から始め、前の試行の次の番号にする。' },
        criteria: {
          type: 'array',
          minItems: 1,
          description: '評価基準の一覧。ユーザーと確かめた基準は番号と文を変えずに入れる。足した基準は入れてよい。',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '基準の番号（例：C-01）' },
              text: { type: 'string', description: '基準の文' },
            },
            required: ['id', 'text'],
            additionalProperties: false,
          },
        },
        plan: { type: 'string', minLength: 1, description: 'この試行の計画。2回目からは、前の試行の指摘への対応を入れる。' },
      },
      required: ['iteration', 'criteria', 'plan'],
      additionalProperties: false,
    },
  },
  {
    name: 'verdict',
    caller: 'verifier',
    skipPermission: true,
    description:
      '検証エージェントが、試行の成果物を評価基準で確かめた後に呼ぶ。その試行の評価基準のすべてについて、合否と指摘を1回にまとめて記録し、画面に出す。番号は評価基準の番号をそのまま使い、その試行にない番号は入れない。不合格の指摘には、何をどう直せばよいかを書く。検証エージェント以外からの記録と、その試行の作業エージェントが終わる前の記録は断る。決まりに合わない記録は、理由を返して断る。返った理由に従い、直せるときは直して呼び直す。「作業を終えてください」と返ったら、呼び直さない。',
    parameters: {
      type: 'object',
      properties: {
        iteration: { ...integerSchema, description: '合否を記録する試行の番号。' },
        verdicts: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              criterionId: { type: 'string', description: '評価基準の番号' },
              pass: { type: 'boolean', description: '合格なら true' },
              note: { type: 'string', description: '指摘。不合格のときは、直す点を書く。' },
            },
            required: ['criterionId', 'pass'],
            additionalProperties: false,
          },
        },
      },
      required: ['iteration', 'verdicts'],
      additionalProperties: false,
    },
  },
  {
    name: 'show',
    caller: 'orchestrator,worker',
    skipPermission: true,
    description:
      '統括エージェントか作業エージェントが、作業ごとの指示に書かれた表示（key）に、値を送る。値の形は表示の種類で決まり、引数 `value` の説明のとおりにする（image で画像として出すのは png・jpeg・gif・webp）。同じ key にまた送ると、表示が新しい値に変わる。作業ごとの指示にない key と、形の合わない値は、理由を返して断る。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '表示の名前（作業ごとの指示に書かれた key）' },
        value: {
          description:
            '表示の種類に合う値。text は文字列、kv は { 見出し: 値 }、table は { columns: [見出し], rows: [[値, …]] }、progress は 0〜100 の数か { value, max, label }（label はなくてよい）、image と file は作業フォルダの中のファイルの場所の文字列。',
        },
      },
      required: ['key', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'review',
    caller: 'orchestrator',
    skipPermission: true,
    description:
      '統括エージェントが、繰り返しを終えた後（すべての評価基準を満たしたか、上限の回数まで試行した後）に、まとめの最初に呼ぶ。記録から機械的に洗い出した課題と、試行ごとの合否の要点を返す。返った課題は、何もしなくても課題の一覧に入る。繰り返しの途中では断る。ただし、人の判断待ちの答えが、ここで終えるよう言ったとき（例：「やめて」）は、endedByHuman を true にして呼ぶと、繰り返しの途中でもそこで繰り返しを終えて、まとめに進める。この印は、人の答えが届いた直後（答えの後に、計画などの記録をしたり、エージェントを呼んだりする前）だけ受け付け、それ以外と、答えを待っている質問があるときは断る。',
    parameters: {
      type: 'object',
      properties: {
        endedByHuman: {
          type: 'boolean',
          description: '人の判断待ちの答えが届いた直後に、その答えがいまここで終えるよう言っているときだけ true にする。それ以外は付けない。',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'issue',
    caller: 'orchestrator',
    skipPermission: true,
    description:
      '統括エージェントが、繰り返しの後の振り返りで、このプラグイン自身を直せば防げる課題を見つけたときに呼ぶ。Issue の案（題と本文）を1件足す。案は終わった後の画面の課題の一覧に並び、ユーザーが承認した案だけが、このプラグインの GitHub リポジトリに起票される。題と本文は、平易な日本語で簡潔に書き、説明のない専門用語を使わない。名前が `_review` で終わる記録のツールが返した課題と、同じものは足さない。繰り返しの途中では断る。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, description: 'Issue の題' },
        body: { type: 'string', minLength: 1, description: 'Issue の本文' },
      },
      required: ['title', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'finish',
    caller: 'orchestrator',
    skipPermission: true,
    description:
      '統括エージェントが、振り返りの最後に1回だけ呼ぶ。実行全体のまとめ（何回の試行で、どの評価基準を満たし、どれを満たせなかったか、成果物の場所。基準と食い違うので使わなかった頼みの文の部分があれば、それも）を記録し、画面に出す。記録できたら、作業を終える。繰り返しの途中と、2回目の記録は断る。',
    parameters: {
      type: 'object',
      properties: { summary: { type: 'string', minLength: 1, description: '実行全体のまとめ' } },
      required: ['summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'ask',
    caller: 'orchestrator',
    skipPermission: true,
    description:
      '統括エージェントが、作業ごとの指示が人に判断を求めている場面（例：ビルドが失敗したら、どうするかを人に聞く）でだけ呼ぶ。人への質問を記録し、画面に「人の判断待ち」として出す。呼んだら、ほかのツールを呼ばずに、返った文のとおりの形で返事を書いて手番を終える。手番を終えても、この実行は終わらない。ユーザーがチャットで答えると、答えがメッセージで届くので、それに沿って同じ試行の続きから進める。作業ごとの指示が人に判断を求めていないことは、このツールで聞かずに、作業ごとの指示と設定の値から判断して進める。繰り返しの途中（計画・実行・評価）でだけ使え、まとめの間と、答えを待っている質問があるときは断る。',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          minLength: 1,
          description: '人への質問。何が起きたか（例：試行 2 のビルドが失敗した）と、人に決めてほしいことを、平易な日本語で簡潔に書く。',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
  {
    name: 'answer',
    caller: 'main',
    skipPermission: true,
    description:
      '名前の頭（`_answer` の前の部分）と同じ名前のプラグインの統括エージェントが、人の判断を待っているときに、メインのエージェントが呼ぶ。ユーザーがチャットで答えた文を、要約も言い換えも足しもせずに、ユーザーの言葉のまま渡す。答えは待っている統括エージェントに届き、同じ実行が続く。返った文を、ユーザーに伝える。判断を待っていないときは、答えを渡さずに、そのことを返す。',
    parameters: {
      type: 'object',
      properties: {
        answer: { type: 'string', minLength: 1, description: 'ユーザーがチャットで答えた文。ユーザーの言葉のまま渡す。' },
      },
      required: ['answer'],
      additionalProperties: false,
    },
  },
]);

export const RECORD_TOOL_NAMES = Object.freeze(TOOL_DEFS.map((t) => t.name));

export function toolFullName(pluginName, shortName) {
  return `${pluginName}_${shortName}`;
}

// 登録する名前から、名前の後ろの部分を取り出す。合わなければ null。
export function toolShortName(pluginName, fullName) {
  const prefix = `${pluginName}_`;
  if (typeof fullName !== 'string' || !fullName.startsWith(prefix)) return null;
  const short = fullName.slice(prefix.length);
  return RECORD_TOOL_NAMES.includes(short) ? short : null;
}

// つなぎ口が登録する形（名前に生成プラグインの名前を付けたもの）
export function buildToolDefinitions(pluginName) {
  return TOOL_DEFS.map((t) => ({
    name: toolFullName(pluginName, t.name),
    shortName: t.name,
    description: t.description,
    parameters: t.parameters,
    skipPermission: t.skipPermission,
  }));
}
