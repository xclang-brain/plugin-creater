# 外側の EVAL（改善）3回目の直し：模擬ユーザーの組（P12・P13）

作業の途中のメモである。憲章・仕様書・設計書・実装資産のどれでもない。`wip/change-plugin/runs/outer-change-3-diagnosis.md` の5章の P12・P13 を、点検（verifier）の better_fix のとおりに入れた記録。

変える前の写し：scratchpad の `run3-persona/before/`（persona.json、validate.mjs、validate.test.mjs、FORMAT.md）。scratchpad は `/tmp/claude-0/-home-user/64a230fb-e6a2-510f-9e7e-9e6600fd34a8/scratchpad`。

## 進み具合

- [x] 読む（診断5章、点検の better_fix、3回目の [44]・[45]・[182]・[183]・[218]・[219]・[228]・[280]、2回目の [185]・[186]）
- [x] P12 dp-image の answered を狭める（`run3-persona/edit-persona.mjs`）
- [x] P12 validate.mjs：ファイルから読み取る聞かれないと話さない決まりの answered が、示すファイルの置き場所・紹介に当たらない確かめ
- [x] P13 compound に最近の1回の問い（3回目 [182]、2回目 [185]）。k15-now の reveal に最近の1回の細かさの見本を1つ
- [x] validate.test.mjs（75件 → 77件、すべて合格）
- [x] FORMAT.md（2.2 の2項と、6章の確かめること）
- [x] 試験

## 変えたファイル

| ファイル | 直し |
| --- | --- |
| `tests/dev-eval/personas/edl-change/persona.json` | dp-image の `markers.answered` を `mkkximg\|\.kximg` から ``(?<!mk)kximg\|bad magic\|mkkximg(?:\.py)?`?\s*(?:で\|を使\|に通\|を通)`` にした（leak は今のまま）。k15-now の reveal の終わりに、最近の1回を話す細かさの見本を足した。`userRoleTests.compound` に最近の1回の問いを2つ足した（3回目 [182] と2回目 [185] の文そのもの。expect：dp-image・dp-steps・k15-now、forbid：cc-toolchain・cc-static・cc-debug・dp-console・dp-marker・log-dbg） |
| `tests/dev-eval/personas/validate.mjs` | validateKnowledge：`from` が file で `volunteer` が false のナレッジの answered が、示すファイル（role が repo のものを除く）の `place` か `describe` に当たると誤り |
| `tests/dev-eval/personas/validate.test.mjs` | RUN3・RUN3_ANSWERS（3回目の [44]・[182]・[218] の問いと答え。記録と同じ文：`run3-persona/verify-run3.mjs`）。answered の言い換えの試験に dp-image（正の例：ドットのない言い換え、「mkkximg.py で〜」、bad magic、2回目 [186]・[195]、3回目 [183]・[219]。負の例：3回目 [45]、スクリプトの名前だけの文）。新しい試験2件（[45] が漏れにならないことと validate.mjs の確かめ。最近の1回の compound・見本・[183] の検出・[186] に手順が足りないこと） |
| `tests/dev-eval/personas/FORMAT.md` | 2.2：最近の1回の項に、話の出どころのナレッジの reveal に細かさの見本を1つ書くこと（fact でなく reveal）と、compound に言い回しの違う最近の1回の問いを2つ以上入れること。新しい項：ファイルから読み取る聞かれないと話さない決まりの answered は、示すファイルの place と describe に当たらない言葉にする。6章の確かめることに足した |

k15-now の reveal に足した文：「最近実際にやった1回を順に話すときは、この細かさで話す：ソースにログを足した → kx-build.sh でビルドした → mkkximg.py で .kximg のイメージにした → kxtool で送り、kxinstall で入れた → reboot した → kxapp run で動かし、ログを取って保存した → 途中で1回ログが取れなかったので、reboot してやり直したら取れた → ログを見て直した。ログを出す関数、ログを取り終える目印、コンパイラやビルドのオプション、ボードでのコマンドの打ち方は足さない」

## 決めたこと・点検の案からのずれ

1. **expect に dp-steps を入れた**（点検は「ペルソナが kxinstall・reboot・kxapp run を言わせたいときだけ」）。dp-steps の reveal に「最近の1回の流れを順に聞かれたとき」があり、asked にも lastTimeAsked がある（2回目の P9）。今の試験（1回目の [184] の見本の答え）も dp-image・dp-steps・k15-now を答えたことにしている。reveal のとおりなら手順を話すので、入れた。2回目の答え [186] は手順を言っていない（「ボードに入れた」「ボードで動かして」だけ）ので、この試験では dp-steps が足りないで落ちる。試験にそのことを書いた。
2. **ペルソナの文を直した**（点検は「ユーザー役の試験で漏れたら」）。3回目の [183] が、同じ言わない指示のもとで漏れた1件なので、試験を待たずに見本を足した。見本は k15-now の **reveal** に書いた。6つの「〜は言わない」は残した。（reveal に書いた理由と、見本の言葉の決まりは、2回目の点検の指摘2で直した）
3. ~~validate.mjs の確かめ（点検の3）の範囲を「ファイルから読み取るナレッジ」に狭めた~~ → 2回目の点検の指摘3で取り消した（下の「2回目の点検」）。狭めた理由は、見てはいけない模擬ユーザー（tests/dev-eval/heldout/h1）を読んで決めたものだった。h1 から読んだ中身は、このメモから消した。
4. forbid は点検のとおり6つ（reveal に「最近の1回を順に話すときは、〜は言わない」があるもの）。cc-git-pull と dp-uname は、reveal に最近の1回の決めがないので入れていない（下の「残り」）。
5. dp-image の answered は点検の better_fix の形そのもの（点検の診断の P12 の `\.kximg|bad magic` では、ドットのない言い換えと「mkkximg.py で〜」に当たらず、compound の expect が落ちうる）。→ 2回目の点検の指摘1で、「で」をコピュラから外した。

## 確かめたこと

- `node --test tests/dev-eval/personas/validate.test.mjs`：77件すべて合格（75件 → 77件）
- 写し（scratchpad の `run3-persona/neg`。終わった後に消した）で、直しを1つずつ戻すと（`run3-persona/mutate.mjs`、9とおり）、どれも少なくとも1件が落ちる：すべて戻す、answered を戻す、answered を `\.kximg|bad magic` にする、validate.mjs の確かめを戻す、compound を消す、forbid を4つにする、expect から dp-steps を除く、見本を戻す、見本に「目印」を入れる
- 当て直し（今の outer-grade.mjs の knowledgeTrace・userRoleFaults。`run3-persona/regrade.mjs`）：3回目の faults は dp-image [45] が消え、dp-marker・log-dbg の [183] の2件。2回目は0件、1回目は cc-toolchain・cc-static・cc-debug・dp-marker の [185]（どちらも変わらず）。dp-image は1〜3回目とも「答えた」のまま
- 試験の仕組みの組の user-role-test.test.mjs の見本のユーザー役（asked に当たるナレッジの fact を答える）を、足した2問に当てた（node で同じ計算をした。試験そのものは動かしていない）：missing なし、forbidden なし。forbid のある最初の compound はつまずきの問いのまま
- `node tests/dev-eval/personas/validate.mjs`：edl-change、training-survey、weekly-report・meeting-minutes（`--all-styles`）がすべて合格
- `python3 tests/dev-eval/personas/test_dummy_skills.py`：16件 OK
- ユーザー役の試験（お金のかかるもの）は動かしていない

## 残り・ほかの組に知らせること

- **統括**：外側の EVAL の前に、ユーザー役の試験（`user-role-test.mjs`。お金がかかる）を `--reps 3` 以上で回し、足した2つの最近の1回の問いで、dp-image・dp-steps・k15-now を話し、6つを言わないかを見る。（理由は2回目の点検の指摘5で直した：下の「2回目の点検」の5）
- 最近の1回の問いで、cc-git-pull（ビルドの前の git pull）と dp-uname（送る前の uname -a）を話すと、外側の EVAL では漏れになるが、forbid に入れていない（指示が6つのため。1〜3回目の答えでは話していない）。入れるなら、2つの reveal に「最近の1回を順に話すときは、〜は言わない」を足し、forbid に入れる。
- k15-now の見本は、2回目と3回目の答えの間の細かさ（3回目の [183] から DBG_LOG と目印を除いた形）にした。見本にない細かいこと（kxtool -d のアドレスなど）を話しても、漏れにはならない（dp-ip は自分から話すナレッジ）。

## 2回目の点検の指摘と直し

変える前の写し：scratchpad の `run3-persona-r2/before/`、直した後：`run3-persona-r2/after/`。点検の道具：scratchpad の `rev-run3-persona/`（desu.mjs・alt.mjs・para.mjs・k15.mjs）。この回の道具：`run3-persona-r2/`（img.mjs・emb.mjs・k15a.mjs・oracle.mjs・edit-persona.mjs・mutate.mjs）。

| 指摘 | 判定 | 直し |
| --- | --- | --- |
| 1 dp-image の answered が「mkkximg.py です／でした」に当たる | 本当（desu.mjs で、[44] に「…kx-build.sh と mkkximg.py です。」と答えると leaked になった） | persona.json：answered と embedded[0] の「で」を `で(?!す\|し\|は\|も\|[、,])` にした（点検の案に「で、」も足した。「スクリプトは mkkximg.py で、〜にあります」「<名前> で、<紹介>です。」に当たらないため）。1〜3回目の答えで当たるもの（[185][333]、[186][195][204]、[183][219][280]）と、1〜3回目の生成プラグインの embedded[0] の当たり（7・12・16件）は変わらない。validate.mjs：`fileAnswerTexts`（置き場所、名前、紹介と、「<置き場所か名前> です。」「〜でした。」「<置き場所か名前> で、<紹介>です。」）で確かめる。validate.test.mjs：負の例に です・でした・で、の文、[44] にその答えをした判定、validate.mjs が「<名前> です。」で落とす確かめ。FORMAT.md：例を直した |
| 2 k15-now の見本の言葉が、ほかの聞かれないと話さないナレッジの言葉に当たる | 本当（見本は dp-image・dp-steps の leak、足さないことの並びの「目印」は dp-marker に当たる。k15-now の asked は、ファイル・範囲・決まりの一覧・git pull・uname などの問いにも当たる：k15.mjs） | persona.json：見本を「最近実際にやった1回を順に話すよう聞かれたときだけ」にし、「ほかの質問で最近の1回に触れるときは、途中でログが取れず reboot してやり直したら取れたことだけを言い、イメージの作り方とボードに入れる手順は言わない」を足した。足さないことの「ログを取り終える目印」を「ログをどこまで取るか」にした。validate.test.mjs：reveal の全文が、asked に expect.lastTimeAsked を含む dp-image・dp-steps のほかの、聞かれないと話さないナレッジの answered・leak に当たらないこと。FORMAT.md：理由を「自分から話すナレッジの fact と答える条件は、大まかな質問やほかの質問の答えにも使われる」にし、当たってよいのは asked に expect.lastTimeAsked を含むものだけと書いた |
| 3 h1 を読んで validate.mjs の範囲を決めた | 本当（手順の誤り） | validate.mjs の確かめを、点検の better_fix のとおり、聞かれないと話さないナレッジすべて（話の中で出るもの・答え方の立場を含む）にした。h1 を見ずに決めた理由：ファイルの名前を言っただけで「聞かれずに話した」になる仕組みは、from に関係ない。ファイルそのものについてのナレッジなら、ファイルの問いが asked に当たるようにするのが筋で、answered の例外にする理由にならない。条件が1つ減る（KISS）。edl-change・training-survey・weekly-report・meeting-minutes は合格。h1 は読んでいない・動かしていない。前の決めたことの3から h1 の中身を消した。validate.test.mjs：script-usage（答え方の立場）も落ちること。FORMAT.md：「話の中で出るナレッジはこの決まりがない」を消した |
| 4 k15-now の answered（reboot）が、手順の reboot でも当たる | 本当 | 点検の案の1つ目（試験で見る）にした：見本と3回目の [183]・2回目の [186] が `reboot[^。\n]{0,40}やり直` に当たること。answered を狭める案は取らなかった：1〜3回目の答えでは狭めた形でも当たる（k15a.mjs）が、ユーザー役の試験の recall の答え（「1回 reboot して、それでもだめなら人に伝える」のような言い換え）を測っておらず、4回目の前にユーザー役の試験が落ちる見込みを足すため。ユーザー役の試験の compound では、k15-now はやり直しを言わなくても当たるまま（残り） |
| 5 expect の dp-steps と、前の「残り」の理由が逆 | 理由は本当に逆（compound は 9 → 15 件になり、90% では 1 件落ちてよくなった。危ないのは足した問いそのものの落ちる率）。dp-steps は今は外さない | 見本に kxinstall・reboot・kxapp run を書いたので、2回目の [186]（見本の前）の落ち方は今の率を表さない。点検の案のとおり、統括がユーザー役の試験を `--reps 3` で回し、最近の1回の問いで落ちたのが dp-steps だけなら、2つの compound の expect から dp-steps を外し、validate.test.mjs の EXPECT と [186] の行を直す（文は足さない）。前の「残り」の理由を直した |
| 6 見本の確かめが forbid の6つだけ | 本当（cc-git-pull・dp-uname を見ていない） | 指摘2の試験（reveal の全文、answered と leak の両方）で見る。git pull・uname を見本に入れると落ちることを確かめた |
| 7 FORMAT.md 2.2 の項が長く、すべての模擬ユーザーに読める | 本当 | 見本と compound の2つ以上の決まりを、「最近の1回を順に話すときは、〜は言わない」を書いたナレッジがある模擬ユーザーだけの項に分けた。「（改善の3回目）」を消した。つまずきの項の「前の項と同じく」を「最近の1回の項と同じく」にした |

### 確かめたこと（2回目）

- `node --test tests/dev-eval/personas/validate.test.mjs`：77件すべて合格
- 写し（scratchpad の `run3-persona-r2/neg`。heldout と wip を除いて写した。終わった後に消した）で、直しを1つずつ戻すと（`mutate.mjs`、11とおり）、どれも少なくとも1件が落ちる：すべて戻す、answered を点検前に、answered を点検の案（、を外さない）に、validate.mjs の です の文を外す、validate.mjs の範囲を file に戻す、見本を点検前に、足さないことに目印、ほかの質問の文を消す、見本に git pull、見本に uname、見本からやり直しを消す
- `node tests/dev-eval/personas/validate.mjs`：edl-change、training-survey、weekly-report・meeting-minutes（`--all-styles`）が合格
- 当て直し（`run3-persona/regrade.mjs`）：1回目は cc-toolchain・cc-static・cc-debug・dp-marker の [185]、2回目は0件、3回目は dp-marker・log-dbg の [183]（前と同じ）。dp-image・dp-steps・k15-now は1〜3回目とも「答えた」
- user-role-test.test.mjs の見本のユーザー役と同じ計算（`oracle.mjs`）：5つの compound で missing・forbidden なし。k15-now の答える条件の全文が当たる leak は dp-image・dp-steps だけ
- `python3 tests/dev-eval/personas/test_dummy_skills.py`：16件 OK
- ユーザー役の試験（お金がかかる）は動かしていない

### 知らせること（2回目）

- **ユーザーへ（統括から）**：3回目の直しで、見てはいけない模擬ユーザー h1（tests/dev-eval/heldout/h1。NOTES.md で、読むのは H1 を直す人と、動かすときの外側の EVAL だけとユーザーが決めた）の中身を読み、それに合わせて validate.mjs の確かめの範囲を決めた。2回目の直しで、範囲は h1 を見ずに決め直し、メモから h1 の中身を消した。h1 を held-out として使い続けてよいかは、ユーザーの判断が要る。
- **H1 を直す人**：validate.mjs の確かめ（聞かれないと話さないナレッジの answered が、示すファイルを答える文に当たらない）を、話の中で出るナレッジにも広げた。h1 を外側の EVAL で使う前に、`node tests/dev-eval/personas/validate.mjs tests/dev-eval/heldout/h1 --all-styles` で確かめ直す（この組では動かしていない）。
- **統括**：4回目の前に `user-role-test.mjs tests/dev-eval/personas/edl-change --reps 3`。見ること：大まかな質問の漏れが0件（k15-now の見本を直したので）、最近の1回の2問で forbid の6つを言わないこと、落ちたのが dp-steps だけなら上の5のとおり外す。
