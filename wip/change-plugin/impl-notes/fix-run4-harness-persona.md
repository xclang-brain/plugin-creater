# 外側の EVAL（改善）4回目の直し：試験の仕組みと模擬ユーザーの組（H14・P14）

作業の途中のメモである。憲章・仕様書・設計書・実装資産のどれでもない。`wip/change-plugin/runs/outer-change-4-diagnosis.md` の H14・P14 を、点検（verifier）の better_fix のとおりに入れた記録。

変える前の写し：scratchpad の `run4-hp/before/`。この回の道具：`run4-hp/`（edit-persona.mjs・asked-scan.mjs・mutate.mjs）。scratchpad は `/tmp/claude-0/-home-user/64a230fb-e6a2-510f-9e7e-9e6600fd34a8/scratchpad`。

## 進み具合

- [x] 読む（診断1〜3章・5章、点検の better_fix（confirm-contents、added-rule-confirmed、leak-cc-git-pull）、4回目の [151]・[152]・[196]・[197]・[409]・[411]）
- [x] H14：confirm-contents の土台の言葉、試験（正と負）、outer-grade-change.mjs の頭の注釈と detail、testing.md 6.8 の行
- [x] P14：log-dbg の asked・reveal・fact、要約の問いの答え方（4つの reveal）、options の forbid、forbid だけの compound、[151]・[196] の問い
- [x] validate.mjs・user-role-test.mjs・FORMAT.md・testing.md 6.2 と試験
- [x] 当て直し（1〜4回目）、直しを1つずつ戻す確かめ、試験
- [x] 点検の指摘（7件）の確かめと直し（下の「点検の指摘（7件）への直し（2回目）」）

## 変えたファイル

| ファイル | 直し |
| --- | --- |
| `tests/dev-eval/runner/outer-grade-change.mjs` | confirm-contents の土台を `/土台\|共通の形[^。\n]{0,40}今の版/` にした（点検のとおり `\|部分` は入れない）。頭の注釈と、合格のときの detail に「共通の形 … 今の版」を書いた |
| `tests/dev-eval/runner/outer-grade-change.test.mjs` | 正の例：4回目 [409] の文そのもの。負の例：文をまたぐ（「共通の形を使います。今の版に上げます。」）、「今の版」がない、「共通部分」だけ |
| `tests/dev-eval/personas/edl-change/persona.json` | （2回目で、asked・要約の答え方・一覧の expect・leak を改めた。下の2回目の表）log-dbg：asked の `printf` を `printf\s*を(?:そのまま\|直接\|使(?:うか\|いますか\|っていますか))\|printf について` に。reveal の「printf について聞かれたとき」を「printf を使うかを聞かれたとき」に。reveal に一覧の問いでの答え方（printf の決まりを違うとも古いとも言わず、ログの出し方も言わない）を足した。fact に「『ログ追加は基本的に printf を使い、ログ関数を使う場合もある』という決まりは、今もそのとおりで、KX-200 の DBG_LOG は、その『ログ関数を使う場合』の例である」を足した。cc-git-pull・dp-uname・cc-debug・log-dbg の reveal に「話を要約や流れにまとめて示され、違うところ・足りないところを聞かれても、示された中に〜がなければ、〜は言わない（示された中の誤りだけを直す）」を足した。userRoleTests：今の一覧の問い options[0] に forbid ["log-dbg"]、4回目の一覧の問い [151]（選択肢「ない」「番号を書く」、expect は options[0] と同じ、forbid ["log-dbg"]）を options に、4回目の要約の問い [196]（expect []、forbid cc-git-pull・dp-uname・cc-debug・log-dbg）を compound に足した |
| `tests/dev-eval/personas/validate.mjs` | forbid の確かめを `checkForbid` にまとめ、options にも当てた。compound の expect は2つ以上、forbid があるときだけ空でもよい（1つは誤り） |
| `tests/dev-eval/runner/user-role-test.mjs` | options も forbid を見る（leak、なければ answered）。compound は expect が空でもそのまま動く。頭の注釈 |
| `tests/dev-eval/personas/validate.test.mjs` | RUN4・RUN4_ANSWERS（[151] は2回目の [167] と同じ文。記録で確かめた）。新しい試験3件：一覧の問いと log-dbg、要約の問いと4つ、options の forbid と expect が空の compound の validate.mjs の誤り。範囲・一覧の問いの asked の試験の「printf で当たってよい」をやめ、一覧の問いにそのまま当たらないことを見る |
| `tests/dev-eval/runner/user-role-test.test.mjs` | 新しい試験1件：見本のユーザー役で options と compound が合格し、4回目の答え [152]・[197] で options（log-dbg）と compound（cc-git-pull）が落ちる |
| `tests/dev-eval/personas/FORMAT.md` | 2.2：asked の例外の例を「範囲の問いに出る、組み込むスクリプトの名前」にし、一覧の問いは書き足した決まりの話題を示したことにしないこと（printf の狭め方の例）。要約の問い（last-time.md の2と7）での答え方の項。2.3 の表：compound の expect は forbid があるときだけ空でよい、options の forbid。forbid の asked の注意を options にも。2.5：書き足した決まりの元の一覧の決まりが今もそのとおりなら、fact と reveal に書き、options の一覧の問いの forbid に入れる |
| `docs/design/testing.md` | 6.8 の confirm-contents の行（「共通の形」と「今の版」）。6.2 の表の「まとめて答える」「選択肢で済ませない」に、言わないはずのナレッジを話さないこと（forbid を足したので、設計書を実装に合わせた） |

## 決めたこと・点検の案からのずれ

1. **log-dbg の asked に `printf を使うか` の形も入れた**（点検は `printf\s*を(?:そのまま|直接)|printf について`）。点検の案の reveal「printf を使うかを聞かれたとき」に asked を合わせるため（「ログは printf を使いますか？」に答えると、asked に当たらず漏れになる）。一覧の「printfを使い、」には当たらない。1〜4回目のクリエイターの問いで、狭めて変わったのは一覧の問い3つ（2回目 [167]、3回目 [164]、4回目 [151]）だけ（`asked-scan.mjs`）。
2. **一覧の問いの forbid は、今の options[0] と4回目の [151] の両方に付けた**（点検は今ある問いに、指示は [151] を足す）。両方を入れた。[151] は2回目の [167] と同じ文だった。
3. **今もそのとおりの文は log-dbg の fact に書いた**（点検は log-dbg か k15-now）。k15-now は自分から話すナレッジなので、DBG_LOG を書くと大まかな質問で話すおそれがある。番号（K-08）は書かず中身で書いた（FORMAT.md 2.5：一覧を見せられる前のユーザーは番号を知らない）。
4. **（2回目の指摘2で改め、すべてに足した）要約の答え方を足したのは4つだけ**（点検のとおり、[196] の asked に当たらない聞かれないと話さないナレッジ。stance を除く）。ほかの聞かれないと話さないナレッジは [196] の asked に当たる。言わないことは、ほかの項と同じく leak の言葉で書いた（log-dbg は、最近の1回・つまずきの項と同じく「ログの出し方（使う関数）」）。
5. **compound の expect が1つのものは、forbid があっても誤りのまま**（指示は「forbid があるときは空でよい」。点検の別の案の「1つでよい」は取らなかった）。
6. USER_RULES（user-role.mjs）に要約の問いの例を足す案（点検の任意の案）は入れていない。make-plugin の模擬ユーザーにも効き、ユーザーの判断が要る。

## 確かめたこと

- `node --test tests/dev-eval/runner/*.test.mjs tests/dev-eval/personas/*.test.mjs`：454件すべて合格（76秒）
- `node tests/dev-eval/personas/validate.mjs`：edl-change、training-survey、weekly-report・meeting-minutes（`--all-styles`）が合格
- `python3 tests/dev-eval/personas/test_dummy_skills.py`：16件 OK
- 写し（scratchpad の `run4-hp/neg`。.git・node_modules・wip・heldout を除いて写した。終わった後に消した）で、直しを1つずつ戻すと（`mutate.mjs`、16とおり）、どれも少なくとも1件が落ちる：H14 を `/土台/` に戻す、同じ文に縛らない、log-dbg の asked に printf を戻す、一覧の文を消す、reveal を「printf について」に戻す、fact の文を消す、cc-debug・cc-git-pull の要約の文を消す、options[0] の forbid を消す、[151] を消す、[196] を消す、[196] の forbid から dp-uname を外す、validate.mjs で options の forbid を見ない・expect が空を許さない・forbid なしでも空を許す、user-role-test.mjs で options の forbid を見ない
- ユーザー役の試験（お金がかかる）は動かしていない

## 当て直し（今の採点と今の模擬ユーザー。`diag4/regrade.mjs`、結果は `run4-hp/regrade/regrade.json`）

| 回 | 点数 | 落ちた観点 | faults（聞かれずに話した） |
| --- | --- | --- | --- |
| 1 | 0.842（32/38） | screen-url-shown、rules-list-once、added-rule-confirmed、embedded:dp-console、embedded:dp-ip、unchanged-items | cc-toolchain・cc-static・cc-debug・dp-marker（答え2） |
| 2 | 1.000（38/38） | なし | なし |
| 3 | 0.973（36/37、stage2 は環境で採点しない） | screen-url-shown | dp-marker・log-dbg（答え3） |
| 4 | 0.974（37/38） | added-rule-confirmed | cc-git-pull（答え6）、**log-dbg（答え2、[152]）** |

- H14 で、4回目の confirm-contents が合格になった（0.947 → 0.974）。1〜3回目は変わらない。
- P14 で、4回目の一覧の答え [152] の DBG_LOG が、聞かれずに話したもの（log-dbg）として見えるようになった（診断2章の「主な原因は模擬ユーザー」を、記録の上でも示す）。1〜3回目の faults は変わらない（2・3回目は一覧の問いで DBG_LOG を言っていない）。
- 4回目の added-rule-confirmed は、会話が変わらないので落ちたまま。

## 点検の指摘（7件）への直し（2回目）

7件とも、今のファイルと1〜4回目の記録（scratchpad の `runs/outer-change-N`）で確かめ、どれも本当の問題と判断して直した。この回の道具：scratchpad の `run4-hp2/`（edit-persona.mjs・mutate.mjs。変える前の写しは `*.before`）。

| 指摘 | 確かめたこと | 直したこと |
| --- | --- | --- |
| 1【高】forbid の漏れが割合で薄まり、合否に出ない | 本当。`user-role-test.mjs` は forbid の当たりを compound・options の `ok` に入れるだけで、合否は `minRate: 0.9`。点検の `rev-hp/dilute.mjs` を動かすと、要約の問いの1回だけ漏らしても compound は 17/18（`--reps 3` で 53/54）で、まとめて答えるの不合格が出ない | `THRESHOLDS.maxForbidden: 0`。`observations.forbid`（`count`・`answers`・`byKnowledge`・`byQuestion`。質問は `compound[5]` のように userRoleTests の何番目かで書く）。failures に「言わないはずのナレッジを話さない：…N 回話した（compound[6] 1 回）」、samples に `forbid`。compound・options の `ok` にも forbid は残した（割合の観点の意味を変えない。2回以上なら両方で落ちる）。頭の注釈（観点と合格の条件。「testing.md 6.2 は割合を決めていない」は 6.2 と食い違っていたので「（testing.md 6.2）」にした）、testing.md 6.2 の合格の条件、FORMAT.md 2.3（表の2行と注意）。試験：要約の問いの答えの1回だけ git pull を話すと、compound は 20/21（95%）で合格の範囲でも、forbid で落ちる。漏れがなければ落ちない。前の試験に forbid の数を足した |
| 2【中】要約の答え方が4つだけで、ほかの回の要約に効かない | 本当。点検の `rev-hp-summary.mjs` で、要約・流れの問いに出ていないナレッジが回ごとに違うことを確かめた（3回目 [191]：cc-toolchain・cc-static、2回目 [203]：dp-console、3回目 [227]：dp-marker、3回目 [314]：dp-image・dp-steps・dp-console） | 要約の答え方を、聞かれないと話さないナレッジ（`stance` を除く）10個すべての reveal に入れた（言わないことは、最近の1回の項と同じく answered・leak の言葉を入れる）。compound に3回目の流れの問い [191]（expect は空、forbid は cc-toolchain・cc-static・cc-debug・cc-git-pull・dp-uname。どれも asked に当たらないことを validate.mjs と試験で確かめた）を、[196] の前に足した。FORMAT.md 2.2 の項を「すべて」にし、回の違う要約や流れの問いを2つ以上入れる、とした。validate.test は決め打ちをやめ、10個すべてを見て、[196] と [191] のそれぞれで、asked に当たらないものが forbid と同じかを見る（3回目の答え [192] は漏れなし、4回目の [197] は cc-git-pull） |
| 3【中】一覧の問いの forbid が DBG_LOG の文字しか見ず、「K-08 も今と違います」を見ていない | 本当。expect は K-15 と reboot だけ、log-dbg の leak は `DBG_LOG\|dbg_log` なので、「…K-08 も今と違います。KX-200 では printf を直接使わず、専用のログ関数で出します。」は options に合格し、外側の EVAL でも faults にならない（answered は DBG_LOG だけ） | 2つの一覧の問いの expect の頭に `^(?![\s\S]*K-?0?8(?!\d))[\s\S]*?` を付け、元の選択肢（K-15 と reboot）を `(?:…)` で囲んだ（囲まないと、`\|` の後ろの選択肢に縛りが効かない）。log-dbg の leak に `printf\s*を(?:直接\|そのまま)?使わ` を足した（leak はユーザー役の試験だけが使い、外側の EVAL の判定は answered を使うので、採点は変わらない）。試験：K-08 を挙げた答え4つ（4回目の [152]、点検の例、「K-08 も今と違います。」だけ、「K08 は古いです。」）が expect に当たらない。K-15 だけの答えに「KX-200」があっても当たる。点検の例は leak に当たる。FORMAT.md 2.5 に、一覧の問いの expect と leak の書き方を足した |
| 4【低〜中】FORMAT.md の要約の項が改善の模擬ユーザーに限られていない | 本当。make-plugin の3人（training-survey・weekly-report・meeting-minutes）は、この文を持っていない | 項を「改善の模擬ユーザー（2.5）では、」で始めた。make-plugin には広げていない（広げるならユーザーに聞く） |
| 5【低】log-dbg の asked が「printf を使うかを聞かれたとき」の自然な言い方に当たらない | 本当。「ログは printf で出していますか？」「ログを足すときは printf ですか？」「printf を使っていいですか？」「printf は使わないのですか？」に当たらなかった | asked の printf の部分を `printf[^。\n]{0,15}[？?]\|printf について` にした。上の4つと前の正の例に当たり、一覧の問い（「printfを使い、〜。」）に当たらない。1〜4回目のクリエイターの問いに当て直すと（`run4-hp/asked-scan.mjs`）、当たる問いは前の狭め方と同じ（変わるのは、元の `printf` と比べた一覧の問い3つだけ）。FORMAT.md 2.2 の例も合わせた |
| 6【低】要約の答え方が、前に話したことが抜けたときの直しまで止める | 本当。3回目 [227]→[228] では、答え3で話した目印が要約から抜け、ユーザー役が足りないと言った（正しい直し）。前の文（「示された中の誤りだけを直す」）では止まる | 文を「…示された中に〜がなく、これまでのやり取りで〜をまだ話していなければ、〜は言わない（示された中の誤りは直し、これまでに話した〜が抜けているときは、足りないところとして言ってよい）」にした。外側の EVAL は、聞かれずに話したかを初めて話した答えで見る（`firstUnprompted`）ので、前に聞かれて話したことを要約の問いで言っても漏れにならない。これを試験に入れた（前に最適化を聞かれて話していれば漏れでなく、話していなければ漏れ） |
| 7【低】「残り」が今の作業ツリーと合っていない | 本当。クリエイター組が change-read.md に1件ずつ確かめる文を足している（今は2の表の後の1項。SKILL.md にも1文）。RESUME.md に、ユーザーが承認した記録はない | 下の「残り」を書き直した |

### 2回目のずれ・決めたこと

1. compound・options の `ok` から forbid を外さなかった。外すと、expect が空の要約の問いが「まとめて答える」の割合にいつも合格として入り、ほかの問いの不合格を薄めるためである。forbid は `observations.forbid` で回数を見る。
2. 一覧の問いの expect の縛りは、K-08 を挙げた答えをすべて落とす（「K-08 は今もそのとおり」も落ちる）。log-dbg の reveal と k15-now の fact では、一覧の問いで K-08 を挙げる理由がないため、点検の形のままにした。
3. 要約の答え方の「言わないこと」は、ナレッジごとに answered・leak の言葉で書いた（cc-toolchain はコンパイラの名前と開発機の gcc、cc-static は静的リンクとローダー、dp-image は mkkximg.py・.kximg・bad magic、dp-steps は kxinstall・reboot・kxapp run と有効にならないこと、dp-console は打ち方〔kxtool の console -c〕、dp-marker は目印）。log-dbg は前と同じく中身で書いた。
4. [191] は compound の [196] の前に置いた（回の順）。

### 2回目の確かめ

- `node --test tests/dev-eval/runner/*.test.mjs tests/dev-eval/personas/*.test.mjs`：455件すべて合格（76秒。1件は指摘1の新しい試験）
- `node tests/dev-eval/personas/validate.mjs`：edl-change・training-survey、weekly-report・meeting-minutes（`--all-styles`）が合格
- 写し（scratchpad の `run4-hp2/neg`。.git・node_modules・wip・heldout を除いた。終わった後に消した）で、直しを1つずつ戻すと（`run4-hp2/mutate.mjs`、11とおり）、どれも少なくとも1件が落ちる：forbid を回数で見ない、forbid の回数に options を入れない、cc-toolchain・dp-marker の要約の文を消す、[191] を消す、[191] の forbid から cc-static を外す、一覧の expect の K-08 の縛りを外す（2つそれぞれ）、log-dbg の leak から printf を外す、log-dbg の asked を前の狭め方に戻す、log-dbg の要約の文を前の形に戻す
- 当て直し（`diag4/regrade.mjs`、結果は `run4-hp2/regrade/regrade.json`）：1〜4回目とも、1回目の当て直し（上の表）と同じ。採点と、外側の EVAL の判定が使う asked・answered の当たりは変わらない
- make-plugin が通るコード（user-role.mjs、make-plugin の模擬ユーザー）は変えていない。user-role-test.mjs の forbid の数え方は make-plugin の模擬ユーザーにも効くが、3人とも forbid を持たないので、結果は変わらない（`observations.forbid` は 0 件で、`answers` も 0）
- ユーザー役の試験（お金がかかる）は動かしていない

## 残り・ほかの組に知らせること

- **統括**：次の外側の EVAL の前に、ユーザー役の試験（`user-role-test.mjs tests/dev-eval/personas/edl-change`。お金がかかる）を回す。見ること：一覧の問い2つ（options）で、K-08 を挙げず、log-dbg を言わず、K-15 の reboot を答えること。要約・流れの問い2つ（compound の forbid だけのもの）と、つまずき・最近の1回の問いで、forbid のナレッジを言わないこと。forbid は回数で見るので、1回でも当たれば落ちる（`observations.forbid` と failures に、質問ごとの回数が出る）。要約の漏れはたまにしか起きない（4回目の [197] のような1回きり）ので、見つける見込みを上げるには `--reps` を上げる（例：`--reps 3`）。聞く数は、前の回より compound が3回増える（`--reps 1` のとき。[191] の分）。
- **統括（クリエイターの直しとの関係）**：クリエイター組が、change-read.md に「記録した決まりの候補は、ほかの問いの答え（範囲の確かめ・一覧の確かめ）に同じ中身が出ても、外したり『決まった』にしたりせず、段階『決まりの確かめ』で1件ずつ確かめる」を足した（今は2の表の後の1項。SKILL.md にも1文。fix-run4-creator.md の (2) と点検の指摘3）。RESUME.md には、これをユーザーが承認した記録がまだない（fix-run4-creator.md では、統括が自律で採ったとしている）。RESUME.md の決めたことに書くか、ユーザーに聞く必要がある。
- **重なり**：上のクリエイターの直しの後も、ユーザー役が一覧の答えで K-08 を違うと言うと、K-35（一覧で直した番号）と K-18（確かめて「このとおり」と答えた候補）が同じ中身で2つ残る（fix-run4-creator.md の残り1）。この組の指摘3の直しで、一覧の問いで K-08 を挙げる答えはユーザー役の試験で落ちるので、edl-change では起きにくくなる。本物のユーザーで起きたときの扱い（どちらかに寄せるか）は、REQ-054・REQ-058 の読み方の判断で、ユーザーに聞く。
- **外側の EVAL の判定の限り**：log-dbg の answered は `DBG_LOG` だけなので、DBG_LOG を書かずに「printf を直接使わない」と言った答えは、外側の EVAL では log-dbg を話したことにならない（ユーザー役の試験では leak と一覧の expect で落ちる）。answered を広げると、外側の採点と recall が変わるので、この回は変えていない。
- USER_RULES（user-role.mjs）に要約の問いの例を足す案（点検の任意の案）は、前の回と同じく入れていない。make-plugin の模擬ユーザーにも効き、ユーザーの判断が要る。
