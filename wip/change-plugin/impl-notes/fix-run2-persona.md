# 外側の EVAL（改善）2回目の直し：模擬ユーザーの組（P7〜P11）

作業の途中のメモである。憲章・仕様書・設計書・実装資産のどれでもない。`wip/change-plugin/runs/outer-change-2-diagnosis.md` の 6.1 の P7〜P11 を、模擬ユーザーの組として入れた記録。

## 進み具合

- [x] 読む（診断、persona.json、FORMAT.md、validate.mjs、validate.test.mjs、run-2 の記録の問い [43]・[152]・[167]・[185]・[194]・[195]・[246]・[295]・[304]）。変える前の写し：scratchpad の persona-run2-before.json、validate.test-run2-before.mjs、FORMAT-run2-before.md
- [x] P7 lastTimeAsked（persona.json。scratchpad の persona-run2-edit.mjs で入れた）
- [x] P8 つまずきの問い（案A。persona.json）
- [x] P9 asked を狭める（persona.json）
- [x] P10 アドレスの立場（persona.json）
- [x] P11 skill-rest（persona.json）
- [x] validate.test.mjs（74件すべて合格。直す前の persona.json に戻すと、足した・直した7件が落ちる：scratchpad の run2-persona-neg で確かめた）
- [x] FORMAT.md
- [x] 試験

## 2回目の記録への当て直し（persona.json を直した後）

scratchpad の `persona-run2-check.mjs`（今の outer-grade.mjs の knowledgeTrace・userRoleFaults で当てる）：

- `expect.lastTimeAsked` に当たる問い：[185] だけ（38問のうち）
- 聞かれないと話さないナレッジの asked に当たる問い：[43] script-usage（「スクリプト」）、[152] dp-image（問いに mkkximg.py の名前がある）・log-dbg（「ログ追加」）・script-usage、[167] log-dbg（K-08 の printf、「ログ追加」）、[185] dp-image・dp-steps、[194] cc-toolchain・cc-static・dp-image・dp-steps・dp-marker（dp-marker は「ログを取る」に当たる。下の「残り」）
- faults（聞かれずに話した）：0件
- 前の判定（答えを1つずつ見る。diag2/leaks.mjs）では、[421] dp-steps、[412] dp-console・log-dbg の3件が残る（どれも前に出たもののくり返しで、H9 が数えなくする）

## 変えたファイル

| ファイル | 直し |
| --- | --- |
| `tests/dev-eval/personas/edl-change/persona.json` | P7〜P11（下）。ユーザー役の試験：`compound` につまずきの問い（2回目の [194] の文）、`recall` に skill-rest の2問 |
| `tests/dev-eval/personas/validate.test.mjs` | 2回目の問い（RUN2：[43]・[152]・[167]・[185]・[194]・[246]・[295]・[304]）を足した。[167] は題材の決まりの一覧から作る（記録の問いと同じ文になることを確かめた）。lastTimeAsked の試験に正の例2つ（[185]、作業の説明が長い問い）と負の例4つ（[43]・[152]・[167]・[194]）。最近の1回の asked の試験に [185]。新しい試験4件（P9 の asked、P8 のつまずき、P11 の skill-rest、P10 の画面の立場）。画面の試験の「スキルに書いて」を「スキルの既定のアドレス」にした。`judge` を `judgeExchange`（問いを渡す）と、それを使う `judge`（1回目の seq）に分けた |
| `tests/dev-eval/personas/FORMAT.md` | 2.2：asked はほかの段階の決まった問いの言葉に当たらないよう狭める（例 `静的`・`手順`）。最近の1回の asked は、言葉でなく `expect.lastTimeAsked` と同じ正規表現を足す。つまずきの問いへの答え方をナレッジごとに決める（と compound）。2.5：`expect.lastTimeAsked` の行（同じ文の中で見る、間の文字数で縛らない）、画面の立場の例とアドレスの使い方（値は書かない）、示すスキルの残りの文への立場（stance） |
| `tests/dev-eval/personas/validate.mjs` | 変えていない（今の確かめ（ほかのナレッジの文に markers・answered が当たらない）で、P10 の値の有無と P11 の言葉の重なりを見られる） |

## 直しごとの中身

- P7：`expect.lastTimeAsked` を診断 1章の案のとおり（同じ文の中に「最近など」「1回」「たどる言葉」があるか）にした。
- P8（案A）：cc-toolchain・cc-static・dp-image・dp-steps の reveal に「初めての人がつまずくところ・間違えそうなところを聞かれたとき。」を足し、asked に `つまずき|間違えそう|間違えやすい` を足した。cc-debug・dp-marker・dp-console・log-dbg の reveal の終わりに「初めての人がつまずくところ・間違えそうなところを聞かれても、（最適化のこと／目印のこと／打ち方／ログの出し方）は言わない」を足した（言わないことは answered の言葉をすべて含む：-O2、目印・exited、console、DBG_LOG）。
- P9：cc-static の `静的` を `静的リンク|静的に` にした。dp-image・dp-steps の `順に|最近|前回|この前|直近|実際に|振り返|たど|思い出` を消し、`expect.lastTimeAsked` と同じ正規表現を選択肢として足した。
- P10：screen-same の fact の「正しいアドレスは、画面ではなく、KX-200 のデプロイの決まりとしてスキルに書いておいてほしい。」を「頼みや画面にアドレスがあればそれを使い、なければスキルのアドレスを使う、という今のやり方のままでよい。スキルの既定のアドレス（前のボードのもの）を、今のボードのアドレスに直してほしい。」にした（続く「画面を使わずにチャットで頼むときにも使うので。」は残した）。値は書いていない。dp-ip の embedded・excluded に当たらないことを試験で見て、値を書くと validate.mjs が誤りにすることも試験にした。
- P11：`skill-rest`（`from: talk`、`stance: true`、`volunteer: false`）を script-usage の後に足した。fact：「示したスキル（cross-compile と deploy）に書いてあることは、ビルドの前に最新にすること、送る前にボードの版を見ること、既定のアドレス、最適化のこと（例外がある）のほかは、今もそのとおり。要る道具や開発機などの環境の条件や、kxapp run の出力の終わりの status=N がアプリの終了コードであることも、そのとおり。決まりかと聞かれて4つの答えから選ぶなら「このとおり」。」 asked：`compatibility|環境の条件|要る道具|開発機|Python|ネットワーク|status|終了コード`。answered・leak：`環境の条件|要る道具|アプリの終了コード`。

## 診断や指示からのずれ・決めたこと

1. P9：dp-steps の asked の `手順` も `手順(?!書|通り|どおり)` に狭めた。診断にはないが、`手順` が [43]（「手順書」）と [167]（K-16「手順書」「手順通り」）に当たり、診断の求める「[43]・[152]・[167] の形に当たらない」試験が通らないため。手順の問い（「デプロイするときの手順」「手順が違うと…」）には今までどおり当たる。
2. P9：範囲の問い [152] は、組み込むスクリプトの名前（mkkximg.py）を示すので、dp-image の asked（`mkkximg`）に当たる。クリエイターがその名前を示した問いなので「聞いた」は正しいとみて、asked から `mkkximg` は外さなかった（決まりの確かめの問いに要る）。試験は「mkkximg.py の名前を除けば当たらない」で見る。
3. P11：診断の例の文には「git pull、uname -a」「目印」を書いていたが、そのまま書くと、cc-git-pull・dp-uname の excluded（`git pull(?!…)`、`uname -a(?!…)`）と dp-marker の answered（`exited|目印`）が skill-rest の文に当たり、validate.mjs が誤りにする（ほかのナレッジを組み込んだ・話しただけで当たる）。中身の言葉（「ビルドの前に最新にすること」「送る前にボードの版を見ること」「kxapp run の出力の終わりの status=N」）で書いた。cc-debug の例外（-O2 でないとき）と食い違わないよう「最適化のこと（例外がある）」も除くものに入れた。
4. P11：`volunteer` は false にした（script-usage と同じく、聞かれたときだけの立場。自分から話すと、関係のない問いにもスキルの文の話が混ざる）。そのため leak を書き、answered はほかのナレッジの文に当たらない言葉（「そのとおり」「終了コード」は k15-now・script-usage の文にあるので使えない）にした。
5. P8 の compound の問いは、2回目の [194] の文そのものにした（last-time.md の6の例に、作業の説明を足した形）。

## 残り・ほかの組に知らせること

- dp-marker の asked の `ログを取る` が、つまずきの問い（[194]「ログを取るとき」）に当たる。そのため、つまずきの問いの答えで目印のことを話しても「聞かれずに話した」にならない（見落とし。誤検出ではない）。診断にないので変えていない。
- 試験の仕組みの組（H9）：validate.test.mjs の新しい試験は、問いと答えの組1つで knowledgeTrace を呼ぶので、H9 の「前に出たら数えない」の有無に依らない。2回目の記録の当て直しは、今の outer-grade.mjs（H9 が入った形）で faults 0件。
- ユーザー役の試験（実際のモデル。この組では動かしていない）で見るとよいもの：compound のつまずきの問い（4つが出るか。ほかの4つ（-O2、目印、console、DBG_LOG）が出ないか）、generic の「気をつけていること」「注意点」で、つまずきの形の4つが漏れないか（reveal につまずきの問いを足したので、近い大まかな問いで話しやすくなるおそれ）、recall の skill-rest、screen-same（アドレスの答え方が「頼みや画面のアドレス、なければスキル」になるか）、unknown（skill-rest の「今もそのとおり」で、知らないことをスキルのとおりと答えないか）。
- 外側の EVAL のランナーの試験で本物の模擬ユーザーを読むもの（outer-change.test.mjs の「本物の題材」、outer-grade-change.test.mjs の explained）は、変えた項目（knowledge、expect.lastTimeAsked、userRoleTests）を見ていない（grep で確かめた。動かしていない）。

## 試験

- `node --test tests/dev-eval/personas/validate.test.mjs`：74件すべて合格（70件 → 74件）
- 直す前の persona.json（scratchpad の persona-run2-before.json）に戻した写し（scratchpad の run2-persona-neg）では、足した・直した7件が落ちる（lastTimeAsked、画面の立場2件、最近の1回の asked、P9、P8、P11）
- `node tests/dev-eval/personas/validate.mjs`：edl-change、training-survey、weekly-report、meeting-minutes（weekly-report と meeting-minutes は `--all-styles` でも）、heldout の h1 がすべて合格
- `python3 tests/dev-eval/personas/test_dummy_skills.py`：16件 OK
- ユーザー役の試験（お金のかかるもの）は動かしていない

## 点検の指摘（1〜9）への直し

点検の指摘9件を確かめて直した記録。変える前の写し：scratchpad の `rev-p-fix/before/`（persona.json、validate.mjs、validate.test.mjs、FORMAT.md）。

### 進み具合

- [x] persona.json（1〜9。scratchpad の `rev-p-fix/edit-persona.mjs` で入れた）
- [x] validate.mjs（3 confirm に stance、4 compound の forbid）。5人すべて合格
- [x] 2回目・1回目の問いへの当て直し（新しい asked。scratchpad の `rev-p-fix/scan.mjs`・`rev-p-fix/regrade.mjs`）
- [x] validate.test.mjs（75件合格。直しを1つずつ戻すと、どれも落ちる：`rev-p-fix/mutate.mjs`）
- [x] FORMAT.md（2.2・2.3・2.5・5章。試験の仕組みの組の 5.3 の頼みも）
- [x] user-role-test.mjs の forbid の直し案（試験の仕組みの組のファイル。scratchpad の `rev-p-fix/user-role-test-forbid.diff`）
- [x] 試験

### 指摘ごとの扱い

H9 は、点検の後に試験の仕組みの組が直した形（`outer-grade.mjs` の `firstUnprompted`：前の問いが asked に当たっただけでは「出た」にしない。出たのは、前の答えが answered に当たったか、クリエイターが answered の言葉を示したときだけ）で確かめた。そのため、指摘1・2の「範囲の問いで聞いたになると、そこから後の漏れを数えない」は今の判定では起きない（効くのは、その問いへの答えだけ）。指摘2の再現の「会話の順では2つ」も、今の判定では 3つ（cc-debug、dp-console、log-dbg）で、1組だけでも同じだった。どちらも、asked が決まった問いに当たること自体は本当なので、直した。

| 指摘 | 扱い | 確かめたことと直し |
| --- | --- | --- |
| 1 cc-static の `静的に` | 直した | 1回目の [161] の一覧の2つ目「C/C++ を静的に調べ」に当たることを確かめた。asked を `静的に(?:リンク|する|します|して|した)` にした。試験：負の例に1回目の [161] の文（`RUN1_161_ITEM2`）、正の例「静的にしますか？」は残す |
| 2 log-dbg・dp-marker の asked | 直した | dp-marker：`ログを取る` が [194] に当たり、つまずきの問いで目印を話しても漏れにならないことを確かめた。`ログを取る` を `どこまで取|ログを取り終` にした（`いつまで` は元からある）。log-dbg：`ログ追加` を `ログ追加の(?:ルール|決まり)` にし、`ログをどう出` を `ログをどう(?:足|出)` にした。点検の案（`ログ追加` を外す）では、1回目の [161]（「ログ追加のルールや…も KX-200 向けに変えたいか」）で DBG_LOG を答えると漏れになる（今の試験の161の行が落ちる）ので、ログ追加の決まりを聞く形は残した。一覧の問い [167] は、K-08（printf の決まり。log-dbg はそれに書き足した決まり）の `printf` で今も当たる。話題を示された問いなので、当たってよいとした（FORMAT.md 2.2 に書いた）。試験：会話の順（2回目の [43]・[152]・[167]・[185]・[194]、答えは記録のとおり）で knowledgeTrace に通し、[195] の本当の答えは漏れ0件、言わない側をすべて言う答え（目印も含む）は言わない側がすべて漏れ。validate.mjs に「compound の質問が forbid のナレッジの asked に当たると誤り」を足した（dp-marker の形の見落としを、ほかの模擬ユーザーでも見つけられる） |
| 3 P11 を確かめる試験がない | 直した | validate.mjs が confirm を from が file に限っていることを確かめた。confirm に `stance: true` のナレッジも置けるようにした（それ以外の talk は誤り）。confirm に skill-rest の3問（2回目の [246]・[295]・[304] の文そのもの）と script-usage の2問（[277]・[286]）を足した（expect `このとおり|そのとおり|その通り`）。skill-rest の recall はやめた（選択肢なしで answered の言葉を見るので、問いをなぞれば当たり、「このとおり。arm-linux-gnueabihf-gcc と bash が要り…」のような自然な答えは当たらない。confirm で足りる）。FORMAT.md 2.3 の confirm の行と、2.5 の立場の項に書いた |
| 4 P8 はユーザー役の振る舞いでしか確かめられない | 直した（模擬ユーザーの組の分） | 4つの reveal に「「注意点」「気をつけていること」「守らないと困ること」のような大まかな質問では話さない」を足した。compound に `forbid`（言わないナレッジ）を足し、validate.mjs で確かめる（knowledge の id、volunteer が false、expect にない、質問が asked に当たらない）。FORMAT.md 2.3 の compound の行に合格の条件（forbid の leak、なければ answered に当たらない）を書いた。**user-role-test.mjs は試験の仕組みの組のファイルなので変えていない**。直し案の差分を scratchpad の `rev-p-fix/user-role-test-forbid.diff` に置いた。ユーザー役の試験（お金のかかるもの）は動かしていない |
| 5 cc-git-pull・dp-uname に決めがない | 直した | 2つの reveal に「初めての人がつまずくところ・間違えそうなところを聞かれても、〜は言わない」を足した（answered・leak の言葉：git pull／uname -a で版を見ること、古い版のボードで困ったこと）。試験の言わない側は、模擬ユーザーから「volunteer が false、stance でない、つまずきの4つでない」で導く（6つ）。FORMAT.md 2.2 の決まりは「改善の模擬ユーザー（2.5）では」と範囲を書いた（ほかの模擬ユーザーを直すにはユーザー役の試験が要るため。下の「残り」） |
| 6 つまずきの asked が reveal より狭い | 直した | 点検の4つの言い換えが当たらないことを確かめた。4つの asked を `つまず|間違え(?:そう|やす)|間違いやす|迷いそう|迷いやす|失敗しそう|失敗しやす` にした。1回目・2回目の38＋30問に当て直し、新しく当たる問いはない（`rev-p-fix/scan.mjs`。「AI が間違ったやり方で」には当たらない）。試験：4つの言い換え、1回目の [202]、2回目の [194]、last-time.md の例が、4つの asked に当たり、言わない側の asked に当たらない。generic の質問は4つの asked に当たらない |
| 7 skill-rest の fact が例外を並べる | 直した | fact を「示したスキル（cross-compile と deploy）に書いてあることは、知っていることの別の項目に書いたことのほかは、今もそのとおり。」にした（ユーザー役への指示は、ナレッジを「あなたが知っていること」の一覧で渡す：user-role.mjs の buildSystemPrompt）。試験：kind が rule でないファイルのナレッジ（cc-debug・cc-git-pull・dp-ip・dp-uname）の asked に、fact が当たらない。FORMAT.md 2.5 に「例外を書き並べない」と理由を書いた |
| 8 「スキル」がどれか曖昧 | 直した | screen-same の文を「直した後のプラグインのスキルでは、既定のアドレスを今のボードのアドレスにしてほしい。」にした。試験をこの文に合わせ、「（プラグインの）スキルの既定」でない書き方がないことを見る。FORMAT.md 2.5 の例と理由を直した |
| 9 dp-steps の `手順` が出どころに当たる | 直した | 2回目の [219]・[268]・[277]（と [237]）に当たることを確かめた。`手順(?!書|通り|どおり|」)` にした。試験：[219]・[268]・[277] に当たらない（[237] は目印の確かめで dp-marker の話題） |

### あわせて直したこと（試験の仕組みの組の 3章・5.3 の頼み）

- FORMAT.md 2.2：「当たると、その問いから「聞いた」になり、後の答えが…」を「その問いで「聞いた」になり、その問いへの答えが…」にした（今の H9）。
- FORMAT.md 2.5 の answered の項と 5章の表の「聞かれずに話した」に、「そのナレッジがまだ会話に出ていない（前の答えが answered に当たったか、クリエイターが問いやチャットの文で answered の言葉を示したら、出た）」を足した。

### 確かめたこと

- `node --test tests/dev-eval/personas/validate.test.mjs`：75件すべて合格（74件 → 75件。P8・P9・P11 の試験を書き直し、forbid の試験を1件足した）
- 写し（scratchpad の `rev-p-fix/neg`）で、直す前の persona.json と validate.mjs に戻すと5件が落ちる。直しを1つずつ戻すと（`rev-p-fix/mutate.mjs`。11とおり）、どれも少なくとも1件が落ちる
- 試験に入れた2回目の問いと答え（RUN2 の 219・268・277・286、RUN2_ANSWERS）は、記録と同じ文（`rev-p-fix/verify-run2.mjs`）
- 当て直し（今の outer-grade.mjs。`rev-p-fix/regrade.mjs`）：2回目の faults 0件（変わらず）。1回目は cc-toolchain・cc-static・cc-debug・dp-marker の [185]（1回目のときの答え。変わらず）
- 点検の `rev-p-sim.mjs`（[195] を言わない側4つの答えに差し替え）：会話の順でも1組でも、cc-debug・dp-console・dp-marker・log-dbg の4つが漏れ（直す前は dp-marker が漏れにならなかった）
- `node tests/dev-eval/personas/validate.mjs`：edl-change、training-survey、weekly-report、meeting-minutes（`--all-styles` でも）、heldout の h1 が合格
- `python3 tests/dev-eval/personas/test_dummy_skills.py`：16件 OK
- runner の試験は動かしていない（outer-grade.test.mjs の RUN2_KNOWLEDGE は2回目のときの写しで、今の persona.json を読まない。outer-change.test.mjs と outer-grade-change.test.mjs は loadPersona と expect.explained だけを使う：grep で確かめた）

### 残り・ほかの組に知らせること（点検の後）

- **試験の仕組みの組**：user-role-test.mjs の compound に forbid を入れる（差分：scratchpad の `rev-p-fix/user-role-test-forbid.diff`。forbid のナレッジの leak、なければ answered に当たったら不合格。結果に forbidden を残す）。入れないと、persona.json の forbid は使われない。また、compound は 3問×3回＝9回で合格は 90% 以上なので、1回の抜けか漏れで落ちる（点検の指摘4。forbid を足すと落ちる見込みが上がる）。回数か合格の割合を見直すかを決めてほしい。
- **統括**：ユーザー役の試験（お金のかかるもの）を、外側の EVAL の前に回す（診断 6.4 の1）。見るもの：compound のつまずきの問い（4つが出て、forbid の6つが出ない）、generic で4つが漏れない、confirm の skill-rest・script-usage で「このとおり」を選ぶ、screen-same（直した後のプラグインのスキルの既定を今のアドレスにと答えるか）。
- つまずきの問いへの答え方は、改善の模擬ユーザーだけで決めた。make-plugin の会話でも同じ問い（last-time.md の6）が出るが、training-survey・weekly-report・meeting-minutes・heldout の h1 には決めがない。直すなら、ユーザー役の試験で確かめる。
- 気づいたこと（直していない）：cc-git-pull・dp-uname の answered は「決まりではない」に当たり、「決まりではありません」だけの答えには当たらない（2回目の答え [220]・[269] は「書いただけ」「自分で見る」で当たっている）。
