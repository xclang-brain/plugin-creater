# 外側の EVAL（改善）1回目の直し：試験の仕組み（H1〜H6）

作業の途中のメモである。憲章・仕様書・設計書・実装資産のどれでもない。診断（`wip/change-plugin/runs/outer-change-1-diagnosis.md` の 3.2）の H1〜H6 を直した記録を、統括に知らせるために書く。H7・H8 は模擬ユーザーの組の受け持ちなので、ここでは直していない。

## 1. 変えたファイル

| ファイル | 変えたこと |
| --- | --- |
| `tests/dev-eval/runner/user-role.mjs` | H1。`USER_RULES` に「ファイルを開いて見る道具はない。ファイルの中身は、知っていることの範囲で答える。」を足した。`TOOL_CALL_MARKUP`（invoke・function_calls・parameter の印と `antml:`）、`MARKUP_RETRIES`（2）、`MARKUP_RETRY_NOTE`（「答えの文だけを書いてください。道具は使えません。」）と `answerOnce` を足した。答えがこの形なら、質問の後に MARKUP_RETRY_NOTE を足して2回まで呼び直す。それでもだめなら `code: 'tool_markup'` の Error を投げる（呼び出しの失敗は `code: 'call_failed'`）。`askUserRole`（ユーザー役の試験）と `createUserRole`（外側の EVAL）の両方が使う。呼び直しの費用も数え、答えの記録に `markupRetries` を残す |
| `tests/dev-eval/runner/outer-run.mjs` | H1。ユーザー役の答えが失敗したら（呼び出しの失敗も含む）、その手番を中断し、終わりの理由 `user_role_failed`（`USER_ROLE_FAILED`）で会話を止める。質問のツールの答えで投げると、Agent SDK は誤りの返事をクリエイターに渡す（`sdk.mjs` の handleControlRequest が `subtype: "error"` を返す）ので、手番の AbortController も止める。開発者が答えるとき（中継）は、中断なら今までどおり `interrupted` になる |
| `tests/dev-eval/runner/outer-grade.mjs` | H4・H6。`gradeScreenUrlShown`（最初の問いより前に成功した `open` の返り値の URL が、その後から最初の問いまでの `creator.text` にあるか）を足した。作る流れの採点（`gradeOuter`）には入れていない（下の 2）。`countRecorded` に `nonJapaneseTexts`（日本語の字を含まない `creator.text` の数と、例 5 件・80 字まで）を足した |
| `tests/dev-eval/runner/outer-grade-change.mjs` | H2：`unchanged-items` は `expect.screenUnchanged`（項目の記号か日本語の名前の配列。省くと3つすべて）を見る。画面の項目でないものがあれば落とす。H3：role が skill のファイルのナレッジの `embedded:*`・`not-embedded:*` は、ルールのスキル（入口のスキルを除く `skills/*/SKILL.md` と `skills/*/references/`）の足した行だけで見る。入口のスキルは、本文に `<プラグインの名前>_open` があるスキル（1段目の standalone と同じ）、見つからなければプラグインの名前のフォルダ。H4：観点 `screen-url-shown`（REQ-043）を `no-new-folder` の次に足した。H5：`added-rule-confirmed` で数える問いを、決まりの確かめの問い（選択肢の名前に4つの答えがそろう。`validate.mjs` の `CONFIRM_ANSWERS`）か、手順や決まりを並べていない問い（見出しと問いに、番号か箇条書きの行が2つ未満）に絞った |
| `tests/dev-eval/runner/outer.mjs` | H6。`aggregateCounts` に `nonJapaneseTexts`（合計）を足した。見ない模擬ユーザーの要約では、例の文を伏せる |
| 試験 | `user-role.test.mjs`（4件）、`outer-run.test.mjs`（2件）、`outer-e2e.test.mjs`（1件。本物の SDK で、手番を中断して止まり、クリエイターに渡らないこと）、`outer-grade.test.mjs`（3件）、`outer-grade-change.test.mjs`（4件と作り例の直し）、`outer.test.mjs`（数の集計と伏せ方） |
| `docs/design/testing.md` | 6.1：ユーザー役への指示に H1 の文。道具の呼び出しの形の答えの扱い（2回まで呼び直し、だめなら `user_role_failed` で止める）。6.5：記録する数に、日本語の字を含まないチャットの文の数。6.8：表に `screen-url-shown` を足し、`added-rule-confirmed`・`embedded:*`（要件を REQ-054、REQ-055 に）・`unchanged-items` を直した。`screen-url-shown` を作る流れに入れない理由 |

## 2. 決めたこと

- （点検で改めた。5 の 2）**H4 は改善の採点だけに入れた**。作る流れの記録は、会話例 `examples/weekly-report.md`（2026-10-24 08:48 のコミット 0307c6b。外側の EVAL の2回目の記録から）しかなく、最初の問いの前に URL を示していない。make-plugin の SKILL.md が「最初の問いより前に文章でチャットに示す」と決めたのはその後（c7284da、09:05）で、その後の作る流れの記録はない。作る流れの採点に必須で入れると、作る流れの合否が変わるおそれがあるので、入れていない。関数は `outer-grade.mjs` に置いたので、作る流れに入れるときは `gradeOuter` で1行呼べばよい。
- **H5 で、決まりの一覧の問いは数えないまま**にした。課題の文は「（例：それだけの問いか、決まりの一覧の問い）」としていたが、REQ-054 の受け入れ基準は「書き足した決まりが1件ずつ確認の質問として示される」で、change-read.md も「一覧にない決まりは段階『決まりの確かめ』で1件ずつ確かめる」としている。書き足した決まりは元の一覧（knowledge.json）にないので、一覧の問いに入るのは一覧にない文を足したときだけで、それは1件ずつの確かめではない。既存の試験（一覧の問いだけでは数えない）もそのままにした。
- （点検で改めた。5 の 5）**H5 の「その決まりだけの問い」**は、番号か箇条書き（「1.」「2)」「・」「- 」など）の行が2つ以上ある問いを除く形で見る。行の頭の「-O2」のような文字は箇条書きにしない。1行に並べて書いたまとめは見分けられない。
- （点検で改めた。5 の 1）**H3 は embedded と not-embedded の両方**をルールのスキルで見る（REQ-055 の受け入れ基準が「ルールのスキルに入っている。違うと答えた決まりは入っていない」）。エージェントの定義や試験の基準に「git pull はしない」と書いても落とさない。足した行で見るのは今までどおり（模擬ユーザーの形の確かめで、決めた言葉が元のプラグインに当たらないことを見ているため）。話の中のナレッジ（`from: talk`）と、role が repo のファイルのナレッジは、今までどおり。
- （点検で改めた。5 の 6）**H6 は「日本語の字を含まない」**で数える。診断が数えた8件のうち、日本語の言葉を含む英語の覚え書き2件（[345]「Next: いつもと違うとき, …」、[427]「Ask "ほかにありますか" first.」）は数えない。合否にも faults にも入れていない（faults は会話例の候補を選ぶのに使うユーザー役の誤りなので）。
- （点検で足した。5 の 3・4）**H1 の失敗は会話（1回）を止める**。比べる EVAL 全体（`outer.mjs` の runPlan）は止めず、次の回に進む（`exception` と同じ扱い）。記録は採点するので、その回は不合格になる。終わりの理由が `user_role_failed` なので、クリエイターの誤りと見分けられる。
- H1 で `USER_RULES` を変えたので、testing.md 6.2 のとおり、外側の EVAL に使う前にユーザー役の試験（`user-role-test.mjs`）を回し直す必要がある。

## 3. ほかの組に知らせること

- **模擬ユーザーの組**：`expect.screenUnchanged` を `edl-change` に書くときは、`tests/dev-eval/personas/validate.mjs` の `EXPECT_KEYS` に `screenUnchanged` を足す必要がある（今は知らないキーとして断る）。中身は項目の記号（`settings`、`running_view`、`result_view`）か日本語の名前の配列。採点は、画面の項目でないものがあれば `unchanged-items` を落とす。
- 採点は `validate.mjs` の `CONFIRM_ANSWERS`（4つの答え）を読む。名前を変えるときは、採点も合わせて変わる。

## 4. 確かめたこと

- 外側の EVAL（改善）1回目の記録を、直した採点で採点し直した（`<scratchpad>/harness-fix/regrade.mjs`。modelUse は渡していない）。変わったのは次の3つで、診断の見込みと同じ。
  - `screen-url-shown`（新）：不合格（URL は [466] まで出ていない）
  - `added-rule-confirmed`：合格 → 不合格（DBG_LOG が出る問いは、まとめの [207]・[323]・[366] だけ）
  - `embedded:dp-ip`：合格 → 不合格（192.168.7.2 はルールのスキルにない）
  - `unchanged-items` は、模擬ユーザーに `screenUnchanged` がまだないので、今までどおり不合格。
  - `nonJapaneseTexts` は 6 件（[58]、[205]、[432]、[480]、[612]、[649]）。
- `node --test "tests/dev-eval/runner/*.test.mjs"`：337 件すべて合格（本物の SDK を使う outer-e2e を含む）。

## 5. 点検の指摘と直し（1〜7）

点検の指摘7件を確かめ、すべて本当の問題として直した。断ったものはない。

| # | 指摘 | 結果 | 直したこと |
| --- | --- | --- | --- |
| 1 | H3 で `not-embedded:*` の範囲まで狭めた | 直した | 診断の H3 が狭めるよう求めたのは `embedded:*` だけで、前の判断（2 の H3）は診断より踏み込んでいた。`outer-grade-change.mjs` の `ruleScope.excluded` を `addedScope.excluded`（足した行のすべて。決まりの一覧を含む）に戻した。エージェントの定義や決まりの一覧に「たまたま」「違う」の書き方が入ると、その書き方で作業される（REQ-055 の受け入れ基準3）。試験の「elsewhere」の例は、エージェントの定義と knowledge.json に「ビルドの前に git pull する」を足すと落ちる形に変えた。否定の文（「git pull はしない」）を落とさないことは、模擬ユーザーの excluded の書き方（dp-ip と同じ否定よけ）で受け持つ。testing.md 6.8 の行を、embedded と not-embedded で分けて書き直した |
| 2 | H4 を作る流れの `gradeOuter` に入れていない。その判断を testing.md に書いた | 直した | 診断の H4 は作る流れにも足すとしており、make-plugin の SKILL.md の始まりの手番の2も最初の問いより前に URL を示すと決めている。`gradeOuter` で `gradeScreenUrlShown` を呼ぶ（腕 with だけ。画面を開くツールは腕 with にだけ出すので、対照とプラグインなしの腕では見ない。開発者が答えるときも見る）。testing.md 6.5 の観点に足し、6.7 の採点の一覧に足し、6.8 の「作る流れにはまだ入れない」の行を消した。Haiku に求める観点は変えていない。作る流れの試験（outer-grade.test.mjs の作り例、outer-run.test.mjs の生成までたどる試験）は、画面を開いて URL を示す形にした |
| 3 | `user_role_failed` の回が平均点などに入る | 直した | `outer.mjs` の `summarizeAll` で、`stopped` が `user_role_failed` の回を、腕・モデルごとの平均点・合格の数・記録する数の合計・あり・なしの差から外し、`scores[腕:モデル].userRoleFailed` に数える。費用は数える。各回の要約（summaries）と記録はそのまま残す。testing.md 6.1 に書いた |
| 4 | 呼び出しの失敗を呼び直さない。利用枠の上限を見分けない | 直した | `user-role.mjs` の `answerOnce` で、呼び出しの失敗（誤りの結果、空の答え、query の例外）を `CALL_RETRIES`（2）回まで呼び直す。失敗の文が `LIMIT_PATTERN` に当たるときは呼び直さず `code: 'usage_limit'` で投げる。`LIMIT_PATTERN` は user-role.mjs に移し、outer-run.mjs から同じ名前で出し直す（循環の import を避けるため）。`outer-run.mjs` は、ユーザー役の誤りの code が `usage_limit` なら終わりの理由を `usage_limit` にする（runPlan が一括を止める）。code のない誤りは、文を `LIMIT_PATTERN` で見る。答えの記録に `callRetries` を残す。testing.md 6.1 に書いた |
| 5 | H5 の抜け道（まとめを前の文に書く、1行のまとめ、はい・いいえの問い） | 直した | `added-rule-confirmed` で数える問いを、決まりの確かめの問い（選択肢の名前に4つの答えがそろうか、問いに「という決まりですか」がある）だけにした。REQ-054 の要件が「その決まりを『〜という決まりですか？』と1件ずつ確かめる」ためである。箇条書きの行を数える見分け（listsSeveral）は要らなくなったので消した。文章の問いでも「という決まりですか」があれば数える。testing.md 6.8 の行を直した |
| 6 | H6 が混ざった英語の覚え書きを数えず、URL だけ・コードだけの文を数える | 直した | `outer-grade.mjs` に `isEnglishNote` を足した。コードの区切り（``` と `…`）の中と URL を除いて、(1) かぎ括弧と引用符の中も除くと日本語の字がなく英字がある文か、(2) 英単語（字だけ。数字・点・下線・スラッシュ・ハイフンでつながったファイル名や番号は単語にしない）が空白だけを挟んで3つ以上続く文を数える。指摘の案（3語以上の続きだけ）では [432]「Now extract.」[649]「Passed. Commit.」[427]「Ask "ほかにありますか" first.」が抜けるので、(1) と合わせた。1回目の記録では診断の8件（[58]・[205]・[345]・[427]・[432]・[480]・[612]・[649]）がちょうど当たり、[471] のファイル名の並び（main.c, sensor_avg.c, …）は当たらない。会話例 examples/weekly-report.md の地の文にも、3語以上の続きはない。数（`nonJapaneseTexts` の名前）は変えていない。testing.md 6.5 を直した |
| 7 | 試験の確かめが足りない | 直した | `outer-run.test.mjs` に、ふつうの呼び出しの失敗が続くと `user_role_failed` で止まりクリエイターに渡らないこと、1回の失敗は呼び直して続くこと、利用枠の上限なら呼び直さず `usage_limit` で止まることの試験を足した。`askUserRole` は `answerOnce` の返り値（`retries`・`callRetries`）をそのまま返す。`user-role-test.mjs` に観点 `toolMarkup`（道具の呼び出しの形で答えない。呼び直して直った答えも数え、1件以上で不合格。`THRESHOLDS.maxToolMarkup` は 0）を足した。呼び直しても直らない質問（`tool_markup`）は、その質問の答えを空にして続ける（ほかの誤りは今までどおり止める）。testing.md 6.2 の表と合格の条件に足した |

### ほかの組に知らせること

- **模擬ユーザーの組**：edl-change の `userRoleTests` に、ナレッジにない、持っているファイルの中身を聞く問い（例：「kx-build.sh の終了コードは何ですか？」。1回目の [239] のような問い）を足してほしい。新しい USER_RULES（「ファイルを開いて見る道具はない…」）が本物のモデルで効くかを、ユーザー役の試験の `toolMarkup` で見るためである。答えの期待は、知っていること（`script-usage` のナレッジ）の範囲か「特に決まっていません」になる。どの観点（`unknown` か `recall`）に入れるかは、模擬ユーザーの組が決める。
- **模擬ユーザーの組**：1 で `not-embedded:*` を足した行のすべてで見るようにした。エージェントの定義や試験の基準に「〜しない」と否定で書いたときに落とさないよう、`excluded` は dp-ip と同じく否定よけを付けておくとよい（今の `cc-git-pull` の `git pull`、`dp-uname` の `uname -a` には否定よけがない。1回目の記録では、どちらも当たっていない）。
- **統括**：2 で、作る流れの外側の EVAL の思考力の高いモデルの合格に、`screen-url-shown` が入った。今の会話例（examples/weekly-report.md のもと）の会話では、最初の問いの前に URL を示していないので、この観点では落ちる。次に作る流れの外側の EVAL を回すときから効く。
- USER_RULES は今回変えていないが、H1 で変えたので、外側の EVAL に使う前にユーザー役の試験（6.2）を回し直す必要があるのは変わらない。今回足した `toolMarkup` もそこで見る。

### 確かめたこと

- 外側の EVAL（改善）1回目の記録を、直した採点と今の模擬ユーザーで採点し直した（`<scratchpad>/harness-fix2/regrade.mjs`）。落ちたのは `screen-url-shown`、`rules-list-once`、`added-rule-confirmed`、`embedded:dp-console`、`embedded:dp-ip`、`unchanged-items` で、点検の要約と同じ。`not-embedded:*`（cc-git-pull、dp-ip、dp-uname）は、足した行のすべてで見ても合格のまま。`nonJapaneseTexts` は 8 件。
- `node --test "tests/dev-eval/runner/*.test.mjs"`：342 件すべて合格（本物の SDK を使う outer-e2e を含む。飛ばしたものなし）。
