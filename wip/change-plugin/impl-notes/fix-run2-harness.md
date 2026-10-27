# 外側の EVAL（改善）2回目の直し：試験の仕組み（H9〜H11）

作業の途中のメモである。憲章・仕様書・設計書・実装資産のどれでもない。診断（`wip/change-plugin/runs/outer-change-2-diagnosis.md` の 6.2）の H9〜H11 を直した記録。

## 進み具合

- [x] H9 knowledgeTrace（前に出たナレッジのくり返しを漏れにしない）
- [x] H10 isEnglishNote（(2) も unquoted で見る）
- [x] H11 countRecorded の flowShown
- [x] testing.md
- [x] 試験
- [x] 2回目の記録の当て直し
- [x] 全体の試験

## 1. 変えたファイル

| ファイル | 変えたこと |
| --- | --- |
| `tests/dev-eval/runner/outer-grade.mjs` | H9：`unpromptedAnswers` を足し、`knowledgeTrace` の `unprompted`・`leaked` をこれで決める。答えを会話の順に見て、answered に当たり、その問い（見出し・問い）が asked に当たらず、まだ出ていないナレッジだけを数える。出たとは、前のやり取りの問い（見出し・問い・選択肢）が asked に当たった、前の答えが answered に当たった、この問いか前の問い（選択肢を含む）が answered に当たった（クリエイターが示した）こと。trace に `leakedAt`（漏れた答えの index の配列）を足し、`userRoleFaults` の leaked に `answerIndex`（最初の1つ）を足した。H10：`isEnglishNote` の (2) の `ENGLISH_RUN` を、かぎ括弧と引用符の中を除いた文で見る。H11：`isFlowText`（「これから」があり、矢印 →・⇒・-> が2つ以上か、番号付きの行が3つ以上）と、`countRecorded` の `flowShown: { shown, seq }`（最初の問いより前の creator.text）。`gradeScreenUrlShown` の最初の問いの見つけ方を `firstQuestionOf` にまとめた |
| `tests/dev-eval/runner/outer.mjs` | H11：`aggregateCounts` に `flowShown`（流れを示した回の数。数のない古い記録は 0） |
| `tests/dev-eval/runner/outer-grade-change.mjs` | 先頭の説明に、flowShown と faults が作る流れと同じであることを足した（動きは変えていない） |
| `tests/dev-eval/runner/outer-grade.test.mjs` | H9 の試験2件（2回目の [194]・[228]・[397]・[411] の抜き書きで、[412] のくり返しを漏れにせず、[195] の arm-linux-gnueabihf だけを漏れにする。前のやり取りがなければ [412] は漏れ。問いに示した言葉のくり返しは漏れにしない。選択肢に示した・選択肢が asked に当たった）。H10：数えない例に [524] の形と、引用符の中の英語を足した。H11 の試験1件 |
| `tests/dev-eval/runner/outer.test.mjs`、`outer-grade-change.test.mjs` | flowShown の集計と、作り例での値 |
| `docs/design/testing.md` | 6.3：聞かれずに話したの判定（出たナレッジのくり返しは数えない）とその理由。6.5：英語の覚え書きの数え方（かぎ括弧と引用符の中を除いてから両方を見る）と理由。記録する数に、流れを示したか |

## 2. 決めたこと

- **H9 の「この問い」**：診断の文は「前のやり取りで」だが、答えの問い（選択肢を含む）にクリエイターが answered の言葉を示したときも、出たものとした。問いは答えより前にユーザーに見えており、診断が当て直しに使った `<scratchpad>/diag2/leaks2.mjs` も、答えの前の creator.question（今の問いを含む）を数えていたためである。
- **H9 の問いの範囲**：この答えの問いが asked に当たるかは、今までどおり見出しと問いだけで見る（`trace.asked` と同じ）。選択肢は、前に出たかを見るときと、クリエイターが示したかを見るときだけに使う（診断の H9 のとおり）。
- **H9 で creator.text は見ない**：leaks2.mjs は、クリエイターのチャットの文に answered の言葉があるときも「出た」にしていたが、診断の H9 は問いだけを挙げている。2回目の記録では、入れても入れなくても結果が同じ（cc-toolchain の [195] だけ）なので、`knowledgeTrace` の引数を変えずに済む形にした。
- **H11 の「など」**：矢印2つ以上に加え、番号付きの行3つ以上も流れとした。クリエイターが流れを番号付きの箇条書きで書くことがあり、数えるだけで合否に入れないので、見落としを減らす側にした。
- `knowledgeTrace` の引数と返り値の既存の欄は変えていない（`leakedAt` を足しただけ）。validate.test.mjs の `judge` のように index のない exchanges でも動く（leakedAt に undefined が入り、faults には answerIndex を付けない）。

## 3. ほかの組に知らせること

- **模擬ユーザーの組**：`knowledgeTrace` の引数・返り値は後方互換（`leakedAt` を足しただけ）。ただし、聞かれずに話したの判定が「前に出たナレッジのくり返しは数えない」に変わった。`tests/dev-eval/personas/FORMAT.md` の 247行（「聞かれずに話した｜…直前の質問が asked に当たらない」）と 199行（「外側の EVAL は、answered に当たり asked に当たらない答えを…」）に、「そのナレッジがまだ会話に出ていないとき」を足す必要がある（模擬ユーザーの組のファイル）。validate.test.mjs の当て直しの試験で、2回目の会話を順に渡すときは、exchanges を会話の順に並べること（`exchangesOf` の形。`index` があれば faults に answerIndex が付く）。今の validate.test.mjs（70件）は、変えた採点のまま全部通る。
- **統括**：`node --test "tests/dev-eval/runner/*.test.mjs"` の1回目で、outer-e2e.test.mjs の「本物の SDK…user_role_failed」の後始末（一時フォルダの rmSync）が ENOTEMPTY で落ちた。そのファイルだけで回すと 3件すべて通る。本物の SDK の子プロセスが、止めた後も書いていたときの競合とみられ、今回の変更とは関係がない。

## 4. 確かめたこと

2回目の記録を、作業ツリーの採点で当て直した（`<scratchpad>/harness-fix3/regrade.mjs`。モデルは呼ばない。modelUse を渡さないので main-model・worker-model の2観点は出ない）。模擬ユーザーは、2回目に使ったもの（HEAD。ec00412 から変わっていない）を `<scratchpad>/harness-fix3/persona-head` に取り出して使った。

| 見たもの | 前 | 後（H9〜H11） |
| --- | --- | --- |
| 観点 | `last-time-asked` だけ不合格（35/36） | 同じ（35/36。P7 は模擬ユーザーの組） |
| faults（leaked） | 6件：cc-toolchain、cc-static、dp-image、dp-steps、dp-console、log-dbg | 1件：cc-toolchain（[195]、answerIndex 4） |
| nonJapaneseTexts | 4件：[57]、[165]、[524]、[544] | 3件：[57]、[165]、[544] |
| flowShown | （なし） | `{ shown: false, seq: null }`（最初の問い [43] の前の文は [11] の URL だけ） |

- cc-static の [195] が消えたのは、2.3 のとおり `asked` の「静的」が [167] の「静的調査」に当たり、前に「聞いた」になるためである。dp-image・dp-steps の [195] は、`asked` の「最近」などが [43] に当たり、前に出たことになるためである。どちらも P9 の受け持ち。
- 模擬ユーザーの P7・P9 を写しで試した（`<scratchpad>/harness-fix3/sim1`。cc-static の asked を「静的リンク|静的に」に、dp-image・dp-steps の「最近」などを 1章の正規表現に、lastTimeAsked を 1章の正規表現に）：観点 36/36（last-time-asked が合格に）、faults は cc-toolchain と cc-static の [195] の2件。さらに P8 の asked（つまずき|間違えそう|間違えやすい を4つに）も足すと（`sim2`）、faults は 0件。診断 6.4 の1の見込み（0〜1件。P8 の案Aなら 0件）と合う。ただし写しは模擬ユーザーの組の直しそのものではない。
- `node --test` で outer-grade.test.mjs（38件）、outer-grade-change.test.mjs（32件）、outer.test.mjs（10件）、personas/validate.test.mjs（70件）が通る。runner の全体（345件）は、上の後始末の1件のほか、すべて通る。

## 5. 点検（review-h）の直し

点検の指摘1〜5を確かめて直す。作業中（容器が作り直されたら、ここから続ける）。

- [x] 1 surfaced から asked の経路を外す（outer-grade.mjs の firstUnprompted）
- [x] 2 試験（答えの経路・示した経路・[411] の確かめ）。写しで8つの書き換えを試し、すべて落ちることを確かめた（`<scratchpad>/harness-fix4/mutate.py`）
- [x] 3 creator.text と同じ呼び出しのほかの問いを「示した」に入れる（exchangesOf の shown）
- [x] 4 isFlowText の言葉の条件を外す。試験の名前を REQ-015 に
- [x] 5 leakedAt を index か null の1つに
- [x] testing.md 6.3・6.5
- [x] 試験と当て直し

### 5.1 指摘ごとの扱い

| 指摘 | 扱い | 理由と変えたこと |
| --- | --- | --- |
| 1 H9 の判定が広すぎる（前の問いが asked に当たると、その後の漏れをすべて消す） | 直した | 確かめた：`<scratchpad>/review-h/variants.mjs` で、2回目の記録（2回目のときの模擬ユーザー）は、asked の経路を外すと cc-static・dp-steps の [195]（診断 2.1 の本物の漏れ）が残り、診断 2.2 の4件は消える。1回目の記録は cc-toolchain・cc-static・cc-debug・dp-marker の [185]（reveal 違反）が残る。training-survey の low-first は、合成の2問（最近の1回の「順に」→ 無関係な問いに「低い順」）で、前の実装は漏れなし、直した後は漏れ（答え1）。H9 の理由（話した・示したもののくり返しは自然）に、聞いただけの経路は入らない。`outer-grade.mjs` の `unpromptedAnswers` を `firstUnprompted` にし、出たを「前の答えが answered に当たった」「クリエイターが示した」だけにした。今の問いが聞いたかは、今までどおり見出しと問いで見る。試験の askedInChoice の期待を逆にした（答え1で漏れ）。testing.md 6.3 の「問い（見出し・問い・選択肢）がそのナレッジを聞いたか」を削り、聞いただけでは出たにしない理由（1回目の [161]「C/C++ を静的に調べ」と [185] の -static）を足した |
| 2 H9 の主な経路を試験が確かめていない | 直した | 足した試験：(a) 聞かれて答えた（問いは answered を示していない）ナレッジを後でくり返しても漏れにしない／聞かれずに話したナレッジは最初の答えだけが漏れ。(b) 前の問いの文・選択肢に answered の言葉があり asked に当たらないナレッジ（試験用の `cc-name`。asked はコンパイラ・ツールチェーン）を、後の無関係な問いで話しても漏れにしない（示していなければ漏れ）。(c) [411] の確かめを `cc-name` で書き直した（問いが示していなければ漏れ）。写しで8つの書き換え（e.shown を見ない、問いの示したを見ない、答えた経路をなくす、asked の経路を戻す、示したを答えた問いだけで見る、同じ呼び出しを入れない、チャットの文を入れない、今の問いの asked を見ない）を1つずつ試し、すべて試験が落ちることを確かめた（`<scratchpad>/harness-fix4/mutate.py`） |
| 3 「示した」にチャットの文と同じ呼び出しのほかの問いが入らない | 直した | `exchangesOf` の組に `shown`（前の答えの後の creator.text と、同じ質問のツールの呼び出しのほかの問いの見出し・問い・選択肢）を足し、`firstUnprompted` が問いと同じく「示した」に使う。同じ呼び出しは、続けて記録された group が同じ creator.question とし、チャットの文・文章の問い・依頼を挟んだら別にする（続きから始めた後に group の番号が重なっても混ざらないため）。ユーザー役（user-role.mjs）は同じ呼び出しの後の問いを答える前に見ないが、会話としてはユーザーに同時に見え、クリエイターがもう示した決まりなので点数を上げない（6.6 の除く理由）ため、入れた。2回目の記録では結果は変わらない（下の 5.2） |
| 4 H11 が言い回しに寄りすぎ | 直した | `isFlowText` の「これから」の条件を外し、矢印2つ以上か番号付きの行3つ以上だけで見る（点検の2つ目の案。最初の問いより前の文はほぼ URL と流れだけなので、言い方の条件は誤りをほとんど減らさない）。試験の「次の順に進めます。A → B → C」を流れに数える期待に変え、番号付きの行（1) 2) 3)）の例と、番号付きの行が2つの例（数えない）を足した。試験の名前を REQ-043 から REQ-015（ほかの記録する数と同じ）にした。testing.md 6.5 も直した。2回目の記録の flowShown は変わらない（示していない） |
| 5 leakedAt の説明が実装と合わない | 直した | `leakedAt` を、聞かれずに話した最初の答えの index か null の1つの値にした（最初に話した答えで出たことになるので、要素は1つより多くならない）。index のない exchanges（validate.test.mjs の judge）では null。`userRoleFaults` は index が整数のときだけ answerIndex を付ける。testing.md 6.3 の「答えごとに記録する」を「ナレッジごとに、最初に話した答えで記録する」にした |

- 2章の決めごとのうち、「H9 の問いの範囲」（選択肢を前に出たかに使う）と「H9 で creator.text は見ない」は、上の1・3で変わった。「H9 の「この問い」」（今の問いに示したものも出た）は今のまま。
- `knowledgeTrace` の引数は変えていない。exchanges の `shown` はなくてもよい（validate.test.mjs の1問の判定は今までどおり動く）。返り値の `leakedAt` だけ形が変わった（配列 → 値）。ほかに読むところはない（grep で確かめた）。

### 5.2 確かめたこと（点検の後）

作業ツリーの採点で当て直した（`<scratchpad>/harness-fix3/regrade.mjs`。モデルは呼ばない）。

| 記録 | 模擬ユーザー | 観点 | faults（leaked） | 英語の覚え書き | flowShown |
| --- | --- | --- | --- | --- | --- |
| 2回目 | 2回目のとき（`<scratchpad>/harness-fix3/persona-head`） | 35/36（last-time-asked） | cc-toolchain・cc-static・dp-steps（どれも [195]、answerIndex 4） | [57]・[165]・[544] | 示していない |
| 2回目 | 今の作業ツリー（模擬ユーザーの組の直しの途中） | 36/36 | 0件 | [57]・[165]・[544] | 示していない |
| 1回目 | どちらでも同じ | 30/36（1回目のクリエイターの不合格。採点の変更とは関係ない） | cc-toolchain・cc-static・cc-debug・dp-marker（どれも [185]） | — | — |

- 2回目の faults は、点検の variants.mjs の「asked で出たにしない」と同じ（チャットの文と同じ呼び出しを入れても変わらない）。cc-static と dp-steps の [195] は、診断 2.1 の本物の漏れ（模擬ユーザーの受け持ち）。
- `node --test` で outer-grade.test.mjs・outer-grade-change.test.mjs・outer.test.mjs（82件）が通る。personas/validate.test.mjs（74件。模擬ユーザーの組のファイルで、作業ツリーのまま）も通る。runner の全体（347件）は、outer-e2e.test.mjs の「本物の SDK…user_role_failed」の1件のほか、すべて通る。この1件は、後始末の rmSync（outer-run.mjs の runOuterOnce の `.claude` と、試験の after）の ENOTEMPTY で、そのファイルだけで10回回すと2回落ちた（止めた後も Agent SDK の子プロセスが書いているとみられる）。rmSync に maxRetries（10回・200ms）を足しても落ちたので、戻した（今回の指摘の外。採点の変更とは関係がない）。

### 5.3 ほかの組に知らせること（点検の後）

- **模擬ユーザーの組**：
  - `tests/dev-eval/personas/FORMAT.md` 120行の「当たると、その問いから「聞いた」になり、後の答えが聞かれずに話したものかを見られない。」を、「当たると、その問いで「聞いた」になり、その問いへの答えが聞かれずに話したものかを見られない。」のように合わせ直す（前の問いが asked に当たっても、後の答えの判定には効かなくなった）。249行・201行に「そのナレッジがまだ会話に出ていないとき（前の答えで話したか、クリエイターが示したら出た）」を足すのは、3章のとおり。
  - cc-static の `asked`「静的に」は、1回目の範囲の問いの「C/C++ を静的に調べ」（ソースコードの調べ方）にまだ当たる（点検の注意）。今は、その問いへの答えだけに効く。
  - `knowledgeTrace` の返り値の `leakedAt` が、配列から値（index か null）に変わった。validate.test.mjs は使っていない。
- **統括**：outer-e2e.test.mjs の後始末の ENOTEMPTY は、そのファイルだけでも時々落ちる（5.2）。止めた後の Agent SDK の子プロセスの終わりを待つ直しが要るとみられる。
