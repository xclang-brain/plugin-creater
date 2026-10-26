# 外側の EVAL（改善）1回目の直し：クリエイターの組（C1〜C11）

作業の途中のメモである。憲章・仕様書・設計書・実装資産のどれでもない。`wip/change-plugin/runs/outer-change-1-diagnosis.md` の 3.1 の直す案を、クリエイターの組として入れた記録。

## 変えたファイル

| ファイル | 直し |
| --- | --- |
| `skills/change-plugin/SKILL.md` | 先頭の決まり7（チャットにはユーザーに向けた文だけ。自分のための覚え書きを書かない。C5）、9（決まりは番号と文で示す。C3）。始まりの手番3（URL を返り値から写して、すぐチャットに書く。C4）。各段階での違いの「決まりの確かめ」（4つのどれでもない答えは、どれに当たるかを1回だけ聞き直す。C6）。赤信号の表に2行（一覧の問いを省く、スクリプトの使い方を決まりとして確かめる。C1・C6） |
| `skills/change-plugin/references/change-start.md` | 7：これからの流れを、段階を進める前にチャットに書く。URL をまだ書いていなければ一緒に書く（C4） |
| `skills/change-plugin/references/change-read.md` | 1：ひな形と作業ごとの指示の型の文を候補にさせない（C7）。示されたスキルのスクリプトの使い方を、決まりの候補でなく使い方として返させる（C6）。2：表に「スクリプトの使い方」の行、元のプラグインの候補の行に「ひな形の文は記録しない」（C6・C7）。3：変えるかもしれないことを例として書き足さない。答えに書かれた決まりはこの答えで決まったにしない（C1）。4：番号と文を問いの文の中に入れる。範囲の答えで番号や「ほかはそのとおり」と言われても省かない。記録のツールも断る。聞き直しの例に番号を入れ、範囲の答えに今のやり方があれば聞き直さない（C1・C2） |
| `skills/change-plugin/references/change-confirm.md` | 2：土台は何のためのものかで、1段目の直しは words.md の言葉で示す（C11）。ルールのスキルの description の案を、書き直すときも示す（C9）。基準の文が示されたスキルを指すときは、ルールのスキルの名前で直して記録する（C10）。擬似の機器が記録できる決まりは、すべて基準の案にし、採点はプログラム（C10）。3：1つ目で決まりを1件ずつ番号と文で示す（C3） |
| `skills/change-plugin/references/change-apply.md` | 2：ルールのスキルに、決まりの値、スクリプトの使い方（`--help`）、画面の設定から来る値の両方で使える書き方、よいと答えたものにない振る舞いを足さない、を書かせる。基準にした決まりも、やり方を決めるものは入れる。description は確認で決めたものを渡す（C8・C9）。7の1・2：ファイルの名前やパスを出さない、決まりは番号と文で（C3・C11） |
| `com.github.copilot/extensions/plugin-creator/quote.mjs` | `quoteInAnswerShowing(quote, id, qa)` を足した（C2） |
| `com.github.copilot/extensions/plugin-creator/hearing.mjs` | `applyKnowledge` の守り（C2。下） |
| `com.github.copilot/extensions/plugin-creator/descriptions.mjs` | 記録のツールの `knowledge.quote` の説明に、直すときの引き継いだ決まりの抜き書きを1文足した（C2） |
| `tests/creator/extension/quote.test.mjs` | +1 件（番号の見分け方、取り消し・打った発言を数えない、選択肢の文、ask_user がないときは通す） |
| `tests/creator/extension/record-tools.test.mjs` | +1 件（範囲の答えでは断って何も変えない。中身の直し・外す・足した決まりは確かめない。一覧を示した問いの答えなら受け付ける） |
| `docs/design/hearing.md` | 3.4（始まり：URL と流れをチャットに、覚え書きを書かない。読む：読み取り役への頼み、範囲の問い、一覧の問いを省かない。決まりの確かめ：聞き直し）、6.3（番号と文、土台と1段目の示し方、擬似の機器の基準、基準の文の直し、description）、7.2（C2 の守り）、10.5（先頭の決まりと赤信号の表）、12章（試験）、13章（REQ-024・REQ-043 の行） |
| `docs/design/creator-structure.md` | 3.4 に「ルールのスキルへの書き直し」（C8） |

## C2（エクステンションの守り）

- 入れた理由：問答の記録（`qa.jsonl`）の ask_user の行は、問いの引数（`question`。Copilot CLI の `toolArgs`、外側の EVAL では `creator-tools.mjs` の `recordAsk` が `{ message, choices, header }`）をそのまま持っている。抜き書きの確かめ（`quoteInUserWords`）と同じ所で読めるので、小さく入れられた。
- 決め方：生成プラグインを直すとき（`state.change.generated`）、引き継いだ行（`carried`）を、中身を変えずに状態「決まった」にする記録（`fields.status === 'decided'`）は、抜き書きが、その番号を示した ask_user の問い（引数の中のすべての文字。問いの文と選択肢の文）への答え（答えが来たもの）の中になければ断る。番号は前後が英数字でない形（`K-01` は `K-010`・`AK-01` に当たらない）。ask_user が1件もないときは通す（`quoteInUserWords` と同じ理由）。
- 確かめないもの：中身の直し（付け直し。ユーザーが今の中身を答えたときなので）、「外した」、この会話で足した決まり、作っていないプラグイン（引き継いだ行がない）。
- 断る文：「仕事のやり方や決まり K-01 は引き継いだ決まりです。中身を変えずに「決まった」にできるのは、その番号と文を示した問いへの答えの中に、抜き書き（quote）があるときだけです。引き継いだ決まりのすべての番号と文を1つの問いの文に入れて聞き、その答えの言葉を、そのまま写してください。」（内部の記号なし）
- 1回目の記録に当てると：[169] の記録は、[161] の問いに K の番号がないので断られる。
- 見るのは番号だけで、決まりの文は見ない（モデルが長い文を縮めて示したときに、止まり続けないため）。番号だけを並べた問いは通る。文があるかは、スキルの文（change-read.md の4）に頼る。

## 設計図からのずれ・決めたこと

1. C5・C6 の make-plugin の側（`skills/make-plugin/SKILL.md` の6、`references/rules.md`）は、統括の指示どおり変えていない。4つのどれでもない答えの聞き直しは、change-plugin の SKILL.md の「各段階での違い」の「決まりの確かめ」に置いた（段階「決まりの確かめ」は make-plugin の rules.md を読むので、change-plugin の本文に置かないと効かない）。設計書は hearing.md 3.4（直すとき）にだけ書いた。
2. C4：URL は「始まりの手番」の3で、`plugin-creator_open` のすぐ後に書かせる（change-start.md の7まで待つと、1〜3の問いの方が先になりうるため）。流れは change-start.md の7で、段階を進める（9）前に書く。
3. C6 の使い方の置き場所：読み取り役が返した使い方は、示されたスキルの資産の候補の説明（`note`）に書かせ、change-apply.md の2で作業エージェントに渡す。記録のツールに新しい欄は足していない。
4. C1 に足したこと：違う・古いと答えた決まりの聞き直しの例に番号を入れた（C2 の守りで、聞き直しの答えでも番号の示された問いの答えになるように）。範囲の答えに今のやり方がもう書かれていれば、聞き直さない（同じことを2回聞かないため）。
5. C8 の例の値は、模擬ユーザーの値（192.168.7.2、KX-200、mkkximg.py）を避け、`10.0.0.5`・「ボードの型番」・「〇〇のスキルのスクリプト」にした。採点が見る値をクリエイターの手順に書かないため。
6. C11：土台の上書きは、REQ-057 の「それで変わること」を満たすため、ファイルの一覧をなくさず、何のためのものか（README、AI への指示、作業の画面、仕様書・設計書、試験の道具）で示す形にした。
7. change-apply.md は 20,000 バイトの上限に近いので、2の「決まりの文はルールのスキルにだけ」の例文（K-18 の例）を、場所の形の説明に縮め、`stage1` の行の重なり（上と同じ書き方の説明）と、3の2の括弧書き1つを削った。今 19,928 バイト。

## ほかの組に知らせること

- `docs/design/generated-plugin-structure.md` 4.9（467行あたり）の「今あるルールのスキルを直すときは、今の description を変えない。」は、C9 と食い違う。C9 では、今あるルールのスキルを示されたスキルの決まりで書き直すときも、メインのエージェントが description の案を示し、作業エージェントに渡す（作業エージェントは渡されたものをそのまま書く。`worker.agent.md` の「頼みに description がなければ、今の description を変えない」とは合う）。この組の持ち物でないので変えていない。
- 外側の EVAL の採点（H 系）：C1 で、範囲の問いから画面とログ追加のルールの括弧書きを消した。C10 で、擬似の機器が記録できる決まりはすべてプログラムの基準の案になる。

## 試験

- `python3 tests/creator/check_creator.py`：合格（change-plugin の SKILL.md 本文 3,951 トークン。references は change-apply 19,928、change-confirm 19,585、change-read 10,553、change-start 7,509 バイト）
- `python3 -m unittest tests/creator/test_check_creator.py`：30 件 OK
- エクステンションの試験（`tests/creator/extension/*.test.mjs`、ブラウザーのものを除く）：すべて合格（record-tools 82、quote 6 ほか）。`tests/dev-eval/runner/creator-tools.test.mjs`（エクステンションを使う道具）も 11 件合格。

## レビューの指摘への対応（1〜13）

| # | 指摘 | 判定 | したこと |
| --- | --- | --- | --- |
| 1 | 新しい例の並びが、模擬ユーザーの隠すナレッジとほぼ1対1（合わせ込み） | 直した | 確かめた：change-read.md の決まりの候補の種類（使う道具、リンクのしかた、送る形、送り先、手順の順、終わりの目印、癖）が cc-toolchain・cc-static・dp-image・dp-ip・dp-steps・dp-marker・cc-git-pull/dp-uname と重なり、使い方の並び（断る値の形、既定の値）は kx-build.sh の形だった。決まりの候補の種類の並びは消した（読み取り役は定義のとおり、ファイルに表れた決まりをすべて返す）。使い方は「`--help` に出ること（引数、終了コード、出力の形など）」とだけ書く。change-confirm.md の擬似の機器の基準は「擬似の機器の記録（呼ばれたときの引数と順）で守ったかが分かる決まり」、擬似の機器の振る舞いの例は「決まりに合わない渡し方を断るなど」にした。同じ考えで、change-apply.md の値の例（送り先のアドレス、10.0.0.5）を「頼みに書かれた〇〇。なければ（確かめた値）」の形に、change-confirm.md のスキル名・description の例（cross-compile、「このソースをクロスコンパイルして」、ボードの型番）と SKILL.md の前回の1回の例（デプロイ）を週報の例に変えた。hearing.md 3.4・6.3、creator-structure.md 3.4 も合わせた。2人目の模擬ユーザーでの確かめ（testing.md 6.3）は、外側の EVAL を回す段のことで、この組では回していない（改善の模擬ユーザーは今 edl-change だけ） |
| 2 | C9 が、1回目と同じ場合に古い description を通す | 直した | 確かめた：「仕事と使う場面が変わらないときだけ今のまま」は、1回目の cross-compile-rules（仕事も場面も同じと読める）で今のままを許す。change-confirm.md：書き直すときは必ず案を示し、今の description を案にしてよいのは、書き方をすべて満たす（誰が読むかを書いていない、機器や道具の名前があれば入っている、など）ときだけ。hearing.md 6.3 も同じにし、「仕事と使う場面が変わらないことは、今のままにする理由にならない」と書いた |
| 3 | 設計書どうしが C9 で食い違う（generated-plugin-structure.md 4.9） | この組では直さない（持ち主でない） | 確かめた：generated-plugin-structure.md 467行の「今あるルールのスキルを直すときは、今の description を変えない。」が残っている。持ち主の組が、回し直しの前に「直す前の確認で決めた description を渡し、作業エージェントはそれを書く（渡されないときだけ今のまま）」に直す必要がある。前回のメモの「ほかの組に知らせること」と同じ |
| 4 | 使い方の枠が、スクリプトが守らせる本物の決まりと古い既定の値を吸い込む | 直した | 確かめた：kx-build.sh は `-O2`（`--debug` で `-O0 -g`）・`-static`・`arm-linux-gnueabihf-gcc` を固定で持ち、deploy の SKILL.md の「既定の 192.168.7.20」も「既定の値」に当たる。使い方は `--help` に出ることだけにし、スキルの文が守ることや既定として求めていることは、`--help` に出ていても、スクリプトがそうしていても、決まりの候補にする（change-read.md の1と2の表、SKILL.md の赤信号に1行、hearing.md 3.4） |
| 5 | C11 で、change-apply の取り出し直しの比べ方が壊れる | 直した | 確かめた：`extract` は `extract.json` を消して書き直し（`parts`・`draft`・`preview`・`stage`・`changed.json` も消す。ほかのファイルは残す）、`rebuild.change` は C11 の後はファイルの名前を持たない。change-apply.md の1の1で、`<W>/confirmed-extract.json` がなければ `<W>/extract.json` を写す（承認の後で、取り出し直しの前なので、確認で示した結果になる。続きから入っても上書きしない）。3の2の3は、`base`・`stage1`・`delete`・`name_conflicts`・`slots` を `python3 -c` の1行で比べ、終了コードが 0 なら続ける（写しがないときも 0 でないので止まる）。比べるコマンドは、同じ・違う・ファイルがないの3つで動かして確かめた。creator-structure.md 3.4 の「取り出した後の変更」に書いた |
| 6 | 聞き直しの決まりが deepen.md と食い違い、2回目の行き先がない | 直した | 確かめた：deepen.md 47行（hearing.md 5.4）の「決まっていない → 聞き直さない」は、前回の1回から確認まで有効で、決まりの確かめにも当たる。SKILL.md の決まりの確かめに、deepen.md の行より聞き直しを先にすると書いた。聞き直しても4つのどれでもなければ、正しいと答えていないので入れず（状態「外した」、抜き書きはその答え）、直す前の確認の1つ目で「確かめても決まらなかったので入れない決まり」として文を示し、入れたいと答えたらその番号を「決まった」にする。指摘の案の「候補のまま残して確認で聞く」は取らなかった：候補が残ると項目「候補の確かめ」が未着手になり、確認のツールが受け付けないため（hearing.mjs の `candidate_check`）。change-confirm.md の3、hearing.md 3.4・5.4・6.3 も合わせた |
| 7 | 読み取り役の返す形に、スクリプトの使い方の置き場所がない | 直した（この組の持ち物の側で） | 確かめた：reader.agent.md の「返す形」に使い方の欄がない。reader.agent.md はこの組の持ち物でないので、指摘の2つ目の案をとり、change-read.md の1で、使い方を資産の候補のそのスクリプトの行の「何に使えそうか」に書かせる |
| 8 | C2 の守りが番号しか見ない | 設計書を直した（コードは変えない） | 確かめた：番号だけを並べた問いは通る。文の初めを確かめる案は取らなかった：モデルが文を縮めたり言い換えたりすると断り続け、一覧の問いを何度もさせるため。hearing.md 7.2 に、文は見ないことと、その理由、文を示すことはスキル（change-read.md の4）に任せることをはっきり書いた（quote.mjs の注にも） |
| 9 | 守りが正しい答えを断り、一覧を2回聞かせうる | 直した | 確かめた：答えが来なかった `ask_user` の後にチャットに打った答え（hearing.md 5.5 で、答えをチャットに書くよう示して止まる流れ）は数えず、もう「決まった」の引き継いだ決まりの記録し直しも断っていた。`quoteInAnswerShowing` は、番号を示した `ask_user` が答えられなかった（取り消し・答えられない）とき、そのすぐ次の記録が打った発言なら、それを答えに数える。hearing.mjs は、もう「決まった」の行には確かめない。チャットの文だけで聞いた問い（外側の EVAL では `user_prompt` になる）は、問いの文が記録に残らないので、今までどおり断る（SKILL.md の先頭の決まり1で、問いは `ask_user`） |
| 10 | C7 で、ひな形を渡さずにひな形の文を外させている | 直した | 確かめた：読み取り役はひな形の場所を知らない。また、1回目で聞いた「ソースコードは変えない」は、ひな形の文ではなく、役割の分け方の決まり（K-04）から作ったときに書いた文だった（fixture の cross-compile-rules と worker-b）。change-read.md の1で、ひな形のフォルダ（`<スキルのフォルダ>/../../template/`）を渡し、すべては読ませず検索させる。外す文は「ひな形にある文」と「一覧の決まりを言い換えた文・一覧の決まりから出てくる文（例：役割を分ける決まりから来る、ある役がしないこと）」にした。作業に固有の例（「ビルド・デプロイ担当は…」）は消した。読み取り役は git を使えないので、作った後に書き足された文かは履歴では見分けない。見分けきれずに聞いた文は、6の聞き直しと確認での提示で扱う（hearing.md 3.4） |
| 11 | 直したことの説明で、消したファイルを言えない | 直した | change-apply.md の7の1：消したファイルだけは、確認と同じく名前で示す。change-confirm.md の土台の例の「README」は「プラグインの説明書」にした。hearing.md 6.3、creator-structure.md 3.4（直したことの説明）も合わせた |
| 12 | 番号の見分け方が、文書とコードで少し違う | 直した | 後ろの見分けを `(?![0-9A-Za-z])` にして、文書（前後が英数字でない）に合わせた。見出し（`header`）も数えることを、quote.mjs の注と hearing.md 7.2 に書いた |
| 13 | 回帰はないが、作る流れには問題が残る | 情報（この組では直さない） | make-plugin（SKILL.md の6、rules.md）は、統括の指示どおり変えていない。change-apply.md は今回の足し分を、SKILL.md の先頭の決まり5と重なる1行、示されたスキルのフォルダを変えない（同じ）、決まりの一覧が変わったときの新しいセッションの説明、要件のたどり方の理由の文を削って収めた（19,867 バイト）。change-confirm.md は 19,678 バイト |

### 変えたファイル（この回）

- `skills/change-plugin/SKILL.md`（決まりの確かめ、赤信号、前回の1回の例）、`references/change-read.md`（1、2の表）、`references/change-confirm.md`（2の土台・名前・description・擬似の機器、3の1つ目）、`references/change-apply.md`（1の1、2のルールのスキル、3の2の3、7の1、削った文）
- `com.github.copilot/extensions/plugin-creator/quote.mjs`（`quoteInAnswerShowing`）、`hearing.mjs`（もう「決まった」の行は確かめない）
- `tests/creator/extension/quote.test.mjs`（+1件）、`record-tools.test.mjs`（C2 の試験に記録し直しを足し、+1件：取り消した一覧の問いのすぐ次に打った答え）
- `docs/design/hearing.md`（3.4、5.4、6.3、7.2、12章）、`docs/design/creator-structure.md`（3.4 のルールのスキルへの書き直し、取り出した後の変更、直したことの説明）

### 試験（この回）

- `python3 tests/creator/check_creator.py`：合格（change-plugin の SKILL.md 本文 4,127 トークン。references は change-apply 19,867、change-confirm 19,678、change-read 11,112、change-start 7,509 バイト）
- `python3 -m unittest tests/creator/test_check_creator.py`：30 件 OK
- エクステンションの試験（`tests/creator/extension/*.test.mjs`、ブラウザーのものを除く）：248 件すべて合格。`tests/dev-eval/runner/creator-tools.test.mjs` 11 件、`outer-change.test.mjs` 12 件も合格
- 写しで、hearing.mjs の「もう決まった」の条件を外し、番号の後ろの見分けを数字だけに戻すと、足した試験が落ちる（quote 1件、record-tools 1件）ことを確かめた

### ほかの組に知らせること（この回）

- generated-plugin-structure.md 4.9 の「今あるルールのスキルを直すときは、今の description を変えない。」（指摘3）。
- reader.agent.md の「返す形」に、スクリプトの使い方の欄を足すかは持ち主が決める。この組は、資産の候補の行に書かせる形にした（指摘7）。
- 外側の EVAL を回す前に、改善の模擬ユーザーを2人目でも確かめる（testing.md 6.3。指摘1）。
