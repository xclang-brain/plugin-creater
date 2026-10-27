# 改善・設計変更（change-plugin）の実装の設計図

作業の途中に使う設計図である。憲章・仕様書・設計書・実装資産のどれでもない。優先順位は 憲章 0.26.0 ＞ 仕様（`docs/specs/improvement-requirements.md` REQ-052〜061、`output-requirements.md` REQ-062）＞ この設計図。食い違いを見つけたら、実装者は仕様に従い、統括に知らせる。

- 前提として読むもの：`RESUME.md`（ユーザーの指示と D1〜D11）、`decisions.md`（ユーザーの決め 1〜20）。どちらも守る。
- この設計図で新しく決めたことは D12〜D41（1.3）。ほかは推測で足さない。足したいことが出たら、統括に知らせる。仕様の文と合わず、統括に仕様の直しを頼むことは 8.2 にまとめる。
- 実装の決まり：CLAUDE.md（日本語、平易な言葉、`SKILL.md` と `*.agent.md` は実装資産、KISS）。試験の名前には要件の番号を入れる（例：`test_REQ_053_…`、`describe('REQ-058 …')`）。

---

## 1. 範囲

### 1.1 入れるもの

| # | もの | 部品 |
| --- | --- | --- |
| 1 | 新しいスキル `change-plugin`（入口・段階・直す専用の references 4つ） | C4 |
| 2 | エクステンションのツール `plugin-creator_change`、記録の `change`、項目の状態「変えないので聞かない」、確認の版と C 番号、画面 | C1 |
| 3 | 組み立ての子コマンド `change-check`・`extract`・`change`・`change-guard`・`commit`。build の描く部分を共有の関数に分ける | C2 |
| 4 | ひな形：統括への最初の指示にプラグインのフォルダの絶対パス（D3）、エージェントの決まった文、`.gitignore`、構造の検査（REQ-058・REQ-062・`bin`）、要件 REQ-062 の写し | C3 |
| 5 | EVAL の課題の擬似の機器の口 `bin`（D12・D33。構造の検査と test-plugin）と、実行の記録を見る基準の種類 `agent_ran`（D30） | C3 |
| 6 | クリエイターの作業エージェント・読み取り役の決まり（D10、直すときの頼み） | C3 |
| 7 | make-plugin・test-plugin の description、make-plugin の start.md（作り直したいだけの問い）、improve.md（タグとフォルダ）、README、plugin.json、`check_creator.py`、呼ばれ方の試験 | C4 |
| 8 | 設計書4つの直し | C5 |
| 9 | 擬似の機器 KX-200、ダミーのスキル、改善の模擬ユーザーと題材、外側の EVAL の改善の場面、内側の確かめ A・B | C6 |

### 1.2 わざと入れないもの（KISS。報告に「試していないこと」として書く）

| もの | 理由・代わり |
| --- | --- |
| REQ-053 の止まる場面と、クリエイターが作っていないプラグインの流れ（D29・D31）を、外側の EVAL で試すこと | 2段目（`test_change.py`、`record-tools.test.mjs`）で試す（D25） |
| REQ-052 の受け付けない頼みと、「作り直したい」だけの頼みの問い | スキルの手順（`change-start.md`、make-plugin の `start.md`）だけで守り、試さない。呼ばれ方の試験（D27）は最初のスキルの呼び出しを断るので、問いを見られない（D25） |
| 画面（設定項目・表示）を変える頼みの外側の EVAL | 模擬ユーザーの頼みに入れない。「画面の質問がない」を観点 `no-screen-questions` で採点する（D25） |
| 機能を消す頼み（REQ-054 の2つ目の受け入れ基準のうち消すほう）の外側の EVAL | 2段目 `test_change.py` の入れ替え（`parts/files` から消したファイルが P から消える）で仕組みだけを試す（D25） |
| 作業エージェントを足す頼み（REQ-052）と、組み方の変更の基準（REQ-061 の4つ目）の外側の EVAL | 呼ばれ方の試験（「作業役を2つに分けたい」）、2段目 `test_change.py`（作業エージェントを足した部品で `change`）、`grade.test.mjs`（`agent_ran`。D30）で試す（D25） |
| 課題のない元のプラグイン（REQ-061 の3つ目）の外側の EVAL | 2段目 `record-tools.test.mjs`（D32 の例）で試す。作業全体を試す課題かはスクリプトで見分けられないので、`change-confirm.md` の手順で守る |
| REQ-061「変えたところを壊したプラグインで EVAL を行うと、足した課題の基準が不合格になる」と、足した課題を生成プラグインの EVAL として動かすこと | ユーザーの EVAL（test-plugin）は Copilot CLI と Copilot のモデルで動く。この容器には Copilot CLI がない（`which copilot` で確かめた）ので動かせない。代わりに、擬似の機器のスクリプトを生成プラグインの2段目で動かし（D34、外側の EVAL の `stage2`）、足した課題に `bin` と基準があることを静的に見る（`tests-added`）。正しい手順で基準が合格し、壊すと落ちることは試さない（D34 の理由） |
| 生成プラグインを作ったひな形の版の記録、ファイルごとの3者の照合（critic M2） | D4。上書きされるファイルは、直す前の確認で一覧にして示す |
| 決まりの文の重なりの全体の検査 | REQ-062 の受け入れ基準の範囲（スキルの決まりの文が、エージェントやほかのスキルに写っていない）だけを検査する |
| 本物の Copilot CLI での確かめ（隣のスキルを読む許可、インストールした写しのファイルを作業エージェントが読む許可、名前の重なりで黙って無視されること、日本語の description での呼ばれ方、`agent_ran` が見る `agentName` の形） | 開発の試験は Claude Code での見込みである。最終確認（hearing.md 14章）に足す |
| Windows で `bin` のある課題を動かすこと | D33 で断る（差し替えのスクリプトが PATH で選ばれないため）。Windows で断ることだけを2段目で試す |
| 憲章に部品の独立性を足すこと | 憲章の改訂はユーザーの承認が要る。報告で聞く（RESUME.md） |

### 1.3 この設計図で決めたこと（D12〜D41）

| # | 決めたこと | 理由 |
| --- | --- | --- |
| D12 | EVAL の課題の `eval.json` に `bin`（課題のフォルダの中の、入力のフォルダ。例 `inputs/bin`）を足せるようにする。test-plugin は、そのフォルダを作業フォルダに写したものを、その課題の実行の `PATH` の先頭に足す（あり・なしの両方）。変えたところを試す課題が機器に頼るときは、機器の道具と同じ名前の差し替えのスクリプト（擬似の機器）をそこに置く | REQ-061。ユーザーの PC では本物の道具が本物の機器に送るので、課題の書き方だけでは「何も送られない」を守れない（critic M1）。test-plugin に機器を動かす口を足すより小さい |
| D13 | 土台を上げると元の機能と重なるとき（例：embedded-debug-loop の K-17 と、土台のエージェントごとの思考の深さ）は、元の機能を消さずに残し、直す前の確認で重なることを示す | 決定15（消すのは頼まれたときだけ）。critic M3 |
| D14 | 合否の基準の番号（C 番号）：引き継いだ基準は元の `task.json` の番号のまま、新しい基準（中身を直した決まりを含む）は元の最大の続き。エクステンションが付けて `confirmation.criteria` に記録し、組み立ての `change` はそれを確かめて使う。作る流れ（build）は今のまま | 引き継いだ課題の eval.json は C 番号で基準を指す。確認の画面とできあがりを同じにする（critic C7、R5） |
| D15 | 新しい決まりの番号は、`tests/knowledge.json` と `tests/knowledge-removed.json` の番号の最大の次から付ける。フォルダの全文の番号は数えない | D5 で外した番号はファイルに残る。全文を数えると、ひな形の試験の例（K-03 など）も拾う |
| D16 | 版の案：スキル・設定・エージェントを足す・変える・消すときは2つ目の数を上げる（0.1.0 → 0.2.0）。決まりの文だけを直すときは3つ目を上げる。ユーザーがよいと答えた版にする。確認の版は、今の版より大きくないと断る（数ごとに比べる。今の版がないときは形だけ見る） | 決定12。決まった規則で案を作る。版を下げたり同じにしたりすると、入れたプラグインが新しい版と見分けられない |
| D17 | 変えたところを試す課題の関門：確認の課題のうち、引き継いだ課題と頼むときの言葉が違うものが1つ以上ないと、エクステンションの確認が断る | 決定11。新しい合否の決め方を作らせない（critic C9、R9） |
| D18 | 組み立てに子コマンド `change-check`・`extract`・`change`・`change-guard`・`commit` を足す。build の描く部分を `prepare_parts`・`render_parts` に分け、build と change で使う。`extract` は下見の描き直しと差分・1段目の結果・名前の重なり（D35）も返す（別の preview は作らない） | 同じことを2回書かない。承認の前に失敗を見つける（rebuild-weaknesses） |
| D19 | `change` は描き直しで変わったファイルの一覧を `.plugin-creator-work/changed.json` に残す。`change-guard` は、試験の直しの後に、その一覧の外のファイルが HEAD から変わっていれば示し、`--restore` で HEAD に戻す | 流用・引き継いだ部品の書き換えを、指示でなく仕組みで止める（critic C12、rebuild-weaknesses） |
| D20 | `check-base` の比べる範囲に、`tests/` の土台（`tests/run.py`、`tests/stage1/`、`tests/stage2/adapter/`・`core/`・`ui/`、`tests/stage2/fake-*.mjs`）を足す（違う・ないだけを見る。増えたファイルは見ない） | 描き直しで試験の土台も上がる。作業エージェントが試験を書き換えて通すのを止める（scaffold.md 2章） |
| D21 | `change-check` は、マージ・リベース・チェリーピック・リバートの途中も断る | 途中だと最後のコミットで初めて止まる。「git で戻せるようにする」（REQ-053）の中の確かめ |
| D22 | 構造の検査：`knowledge` の検査を広げて外した番号を探す（REQ-058）。新しい検査 `standalone`（REQ-062。入口のスキルを除く。仕様の直しを統括に頼む、8.2）は、生成プラグインのときだけ（`kind == "generated"`）動かす。`eval` の検査で `bin`（D33）と `agent_ran`（D30）を確かめる。プラグインのフォルダ全体を歩く検査は `.plugin-creator-work/` を飛ばす | REQ-058・062 の受け入れ基準、D12。クリエイター自身の1段目は同じスクリプトを種類 `plugin` で動かし、クリエイターの作業エージェントの定義には `${PLUGIN_ROOT}`（mcp.json の例）がある。作業フォルダがプラグインのフォルダと同じとき、`<W>/preview/` の古い文（外した番号）を拾わないため |
| D23 | change-plugin は、make-plugin の SKILL.md の4節（問いの形、記録のしかた、疲れ・急ぎ…、始められないとき…）と make-plugin の references を読んで使う（skillflow A1）。外側の EVAL で崩れたら、4節を本文に写す（A2）。make-plugin の本文は変えず、`check_creator.py` の長さの検査をすべてのスキルに広げて測る（critic U2・U12） | make-plugin の本文は残り 26 トークンで変えられない。同じ文を1か所にする |
| D24 | 改善の模擬ユーザーの題材は、plugin-market-place の 484584c から作った `market.tar.gz`（約280KB）にし、D2 のとおり `tests/dev-eval/fixtures/` に置く。ダミーのスキルは模擬ユーザーが示すファイルなので、D2 の `tests/dev-eval/personas/` の模擬ユーザーのフォルダ（`files/`）に置く（今の FORMAT.md の `src` の決まり） | 1.4MB の写しを置かない（憲章 第10条2項、critic C14） |
| D25 | 外側の EVAL の改善の場面は1つ（今のスキルの取り込み＋決まり1件の直し＋書き足した決まり1件）。画面は変えない | critic R4。費用と時間 |
| D26 | ダミーのスキルは KX-200 向けの `cross-compile`・`deploy`（ありがちな短い名前） | D1。REQ-055 の名前の重なりの関門を試せる（skill-spec 4.1） |
| D27 | 呼ばれ方の試験を開発の試験に足す（Claude Code で、頼み8件、最初に呼んだスキルを見る） | description を変えるのは振る舞いの変更である（ナレッジ「リファクタリング」） |
| D28 | 取り込んだスキル（REQ-055）は、記録の資産のうち、場所が `SKILL.md` のあるフォルダか `SKILL.md` そのものであるものとする。記録に欄を足さない。メインは、示されたスキルごとに、`SKILL.md` のあるフォルダの絶対パスを資産に記録する（`change-read.md`）。資産のファイルが `SKILL.md` のあるフォルダの下にあるのに、そのフォルダが資産にないときは、`extract`（`--hearing` のとき）と `change` が断る | critic C5。組み立てが名前の重なりを確かめるのに、これで足りる。スクリプトだけを記録すると、取り込んだスキルが0件になり、名前の重なりの確かめが黙って素通りするため |
| D29 | 生成プラグインかの見分け方：マニフェストの `name` で、`tests/knowledge.json` と `com.github.copilot/extensions/<name>/task.json` の両方があれば生成プラグイン（`generated:true`）、そうでなければ作っていないプラグイン。あるのに読めないときは、理由を示して断る。エクステンション（`readPluginForChange`）、`change-check`、`extract` は同じ決め方にする。`change` は、記録の `change.generated` と `extract.json` の `generated` が違えば断る | 3か所で別々に決めると、エクステンションは決まりの一覧を1回で聞き、`extract` は作っていないプラグインとしてファイルを消す一覧を出す、という食い違いが起きる |
| D30 | test-plugin の program の基準に、種類 `agent_ran`（`{ "type": "agent_ran", "agent": "<エージェントの名前>" }`）を足す。その実行で `subagent.started` が出たエージェント（test-plugin の記録 `subagents[].agentName`）に、`agent` か `<プラグインの name>:<agent>` があれば合格。作業フォルダのファイルは見ない。組み方の変更（作業エージェントを足す・役割を分け直す）では、変えたところを試す課題に、この基準を入れる | REQ-061 の4つ目、決定20「組み方の変更は実行の記録で判定」。今の基準は作業フォルダのファイルしか見られず、実行の記録（`<COPILOT_HOME>/plugin-data/...`）は作業フォルダの外にある。test-plugin はすでに `subagent.started` を記録している（`events.mjs`）ので、足すのは採点だけで済む |
| D31 | 作業の定義の案（`draft/task.json`）・`parts/manifest.json`・差し込み口を書く役：作業エージェント A が draft を書く・直すのは、画面を変えるとき、エージェントの組み方を変えるとき、`extract` の1段目の結果で作業の定義が今の決まり（task.schema.json）に合わないとき、作っていないプラグインのとき（make-plugin の `confirm.md` の「作業の定義の案」の頼みで、1から書く）。メインは生成の2で `parts/manifest.json` を書く・直す（作業エージェントを足すときは `workers` に足す。作っていないプラグインでは make-plugin の `generate.md` の1と同じく1から書く）。作業エージェント B は、作っていないプラグインでは、すべての差し込み口を書く（make-plugin の `generate.md` の2の「生成プラグインの部品」の頼みと同じ） | 決定2・REQ-052（作業エージェントの追加、作っていないプラグインも受け付ける）。作業役の一覧は draft と manifest.json にあり、作っていないプラグインでは `extract` が差し込み口・manifest.json・draft を作らないので、書く役が要る。make-plugin の手順を使い、同じ文を2か所に書かない（D23） |
| D32 | 元のプラグインに課題がないときは、作業全体を試す課題を1つ以上作る（make-plugin の `confirm.md` の課題の作り方。前回の1回と示したファイルから）。変えたところを試す課題（D17）とは別の課題にし、確認で「作業全体を試す課題」と分けて示す | REQ-061 の2つ目と受け入れ基準3（「作業全体を試す課題と合否の基準も入っている」）。同じ課題で兼ねてよいかは仕様に書かれていないので、両方の受け入れ基準を確かに満たす別の課題にする |
| D33 | `bin` の決まり（D12 に足す）：①`bin` に書けるのは `"inputs/bin"` だけ。差し替えのスクリプトは、記録を `<スクリプトのフォルダ>/../../device-history.log`（＝作業フォルダの `device-history.log`）に書く。②Windows では、test-plugin が `bin` のある課題を課題の誤りとして断る（理由を示す）。③確かめた決まりが機器の道具を絶対パスで呼ぶときは、差し替えが効かないので、機器に送る手順を課題に入れない（ビルドまでなど、機器に送らない範囲の課題にする）。機器の手順を試せないことを確認で示す | REQ-061「本物の機器に何も送られない」。エージェントが `cd` してから道具を呼ぶと、今いるフォルダに書く記録は別の場所にでき、基準が必ず落ちる。Windows は拡張子のないスクリプトを PATH で選ばず（PATHEXT）、後ろにある本物の道具が動く。絶対パスで呼ぶと PATH の差し替えが効かない（feasibility の点検） |
| D34 | 擬似の機器のスクリプトにも、作業エージェントがスクリプトの試験の決まり（`tests/stage2/task/`）で試験を書く：正しい形を受けて記録に1行足すこと、受け付けない形（例：見出しのない ELF）を断り、0 でない終了コードで終わること。外側の EVAL では、これを `stage2` の観点で動かす。足した課題の基準を、試験の仕組みが正しい手順・誤った手順で動かして確かめること（点検の案 `bin-works`）はしない | R3 の対策を一度は動かす。`bin-works` は、正しい手順のコマンド列に、課題ごとにクリエイターが決める値（アプリの名前、ファイルの名前）が要り、決まったスクリプトでは確かに流せない。誤った手順だけでは、成果物がないことで基準が落ち、確かめにならない（憲章 第10条） |
| D35 | 名前の重なり（REQ-055）を承認の前にも確かめる：`extract --hearing S` は、D28 の取り込んだスキルの `name`（なければフォルダの名前）と、P にあるスキルの名前の重なりを `name_conflicts` で返す。メインは、足すルールのスキルの名前を、示されたスキルの名前と違うものに決め、`rebuild.change` に書く（`change-confirm.md`）。`change` の確かめ（⑤）は最後の守りとして残す。示されたスキルのフォルダが P の中にあるときは、`extract` と `change` が断る | 承認の後に初めて名前の重なりで断られると、直したルールのスキルの名前が承認した確認と変わる（REQ-057）。`change` は P の管理するファイルを入れ替えるので、P の中のスキルは REQ-055「示されたスキルのフォルダの中身は変えない」を守れない |
| D36 | 外側の EVAL（改善）の観点はすべて必須にする（作る流れの今の採点 `outer-grade.mjs:481` と同じ）。`rules-list-once` は、引き継いだ番号のすべてが1つの問いに出ること。費用の上限は2回り（約70ドル） | REQ-054・056・057 の受け入れ基準を、決めずに参考に落とさない。費用は 7.3 の見込み（1回り 約25〜35ドル）の2回り分 |
| D37 | クリエイターの版は 0.1.0 のままにする（`plugin.json`、`marketplace.json`、会話例） | 今までも機能を足して版を上げていない。上げると REQ-037 で会話例の作り直しが要る。版を上げるかは報告でユーザーに聞く |
| D38 | エージェントの本文の `${PLUGIN_ROOT}`（critic U4）は、`standalone` の検査で不合格にする。直すときは、`extract` の1段目の結果に出るので、直す変更として確認で示す（`rebuild.change`） | 本文では展開されない見込みで、今も動かない。直すと「確認で示した変更のほか」になるので、示してから直す（REQ-057） |
| D39 | インストールの写しの場所の確かめ（REQ-053）：`COPILOT_CACHE_HOME` は、その場所と、その下の `copilot` の両方を断る。`<COPILOT_HOME>/plugin-data/` は断らない | critic U11（`COPILOT_CACHE_HOME` がどちらを指すか文書から分からない）。plugin-data は実行時のデータの場所で、プラグインの写しではない（REQ-053 の止まる場面にない） |
| D40 | サンドボックスなどで `git tag -f` に失敗したときは、`commit` はコミットを残し、結果の `tag` を null にして理由を `warnings` に出し、W を消す。スキルはタグなしで説明に進み、タグがないことを示す | critic U13。コミットまで済んだ直しを、タグのために失わない |
| D41 | 引き継ぐ課題が確かめた決まりと食い違うとき（critic M4。例：T-01 の入力のルールのファイルが取り込んだスキルと違う）は、直す案だけを確認で示す。外すのは、ユーザーが自分から頼んだときだけ。外側の EVAL では採点しない | REQ-061「確かめた決まりに合わせて引き継ぐ」、決定15（消すのは頼まれたときだけ） |

---

## 2. 要件 → 設計 → 実装 → 試験

設計の列は、C5 が直す設計書の節（5.5）。試験の列：「2段」＝2段目の試験（ファイル）、「1段」＝構造の検査の試験、「外」＝外側の EVAL の採点の観点（7.3）、「内」＝内側の確かめ、「呼」＝呼ばれ方の試験、「なし」＝試さない（1.2）。

| 要件 | 設計 | 実装 | 試験 |
| --- | --- | --- | --- |
| REQ-052 頼む | hearing 1章・3.4、creator-structure 1・2章 | C4 `change-plugin/SKILL.md`・`change-start.md`（受け付けない頼み、作り直したいだけの問い）、make-plugin・test-plugin の description、README／C1 `plugin-creator_change`／C2・C4 作業エージェントを足す・作っていないプラグイン（D29・D31） | 2段 `record-tools.test.mjs`（change）、`test_check_creator.py`（description）、`test_change.py`（作業エージェントを足す、作っていないプラグイン）／呼／外 `change-skill-used`・`no-new-folder`／なし：受け付けない頼み、「作り直したい」の問い（1.2） |
| REQ-053 始める前の確かめ | creator-structure 3.4 | C2 `change-check`、`change` の中の確かめ直し／C4 `change-start.md`・`change-apply.md` | 2段 `test_change.py`（止まる場面すべて、止まってもフォルダが変わらない、ほかのフォルダだけの変更は通す）／なし：外 |
| REQ-054 読み取ったことを確かめる | hearing 3.4・6.1・7.3 | C1 取り込み（候補）・付け直し・「できていたことの確認」を断る／C4 `change-read.md`／C3 `reader.agent.md`／C2 入れ替え（消す機能） | 2段 `record-tools.test.mjs`、`test_change.py`（消した機能のファイルが消える）／外 `rules-list-once`・`rule-replaced`・`added-rule-confirmed` |
| REQ-055 既存のスキルを取り込む | hearing 3.4、generated-plugin-structure 4.7・4.9 | C4 `change-read.md`（スキルのフォルダを資産に）・`change-apply.md`（スクリプトを写す、作業エージェントへの頼み）／C3 `worker.agent.md`（ルールのスキルの書き方）／C2 名前の重なり（承認の前の `extract` と `change`。D35）・示したスキルの場所 | 2段 `test_change.py`／外 `embedded:*`・`not-embedded:*`・`skill-names-differ`・`user-skills-unchanged`・`assets-reused`／内 A・B |
| REQ-056 変えるところだけ聞く | hearing 3.4・7.2 | C1 状態 `unchanged`（作っていないプラグインでは断る）・画面／C4 本文の「各段階での違い」 | 2段 `record-tools`・`screen`・`screen.browser`／外 `unchanged-items`・`no-screen-questions`・`last-time-asked` |
| REQ-057 直す前の確認 | hearing 6.3、creator-structure 4.1 | C1 確認（`rebuild` 必須、`version`、C 番号）・画面／C2 `extract`（土台の差分、1段目の結果、消すファイル、名前の重なり）／C4 `change-confirm.md`（`extract` の結果を `rebuild.change` に入れて画面にも出す） | 2段 `record-tools`・`screen`（`rebuild.change` の文が出る）・`test_change.py`（extract）／外 `confirm-contents`・`unchanged-before-approval`・`version-approved` |
| REQ-058 決まりの番号 | hearing 7.3、generated-plugin-structure 10章 | C1 番号と `replaces`／C2 合わせ方と `knowledge-removed.json`／C3 `knowledge` の検査 | 2段 `record-tools`・`test_change.py`／1段 `test_check_structure.py`／外 `ids-kept`・`rule-replaced` |
| REQ-059 直す場所とコミット | creator-structure 3.4・4.1 | C2 `change`（入れ替え）・`change-guard`・`commit`／C3 1段目が `.plugin-creator-work/` を飛ばす（D22）／C4 `change-apply.md` | 2段 `test_change.py`（作業フォルダが P と同じときも）／1段 `test_check_structure.py`／外 `commit-scoped`・`nothing-outside`・`not-pushed`・`stage1`・`stage2` |
| REQ-060 直したことの説明 | creator-structure 4.1 | C4 `change-apply.md`／C1 状態取得の4行 | 2段 `state.test.mjs`／外 `explained` |
| REQ-061 変えたところの試験 | testing 10.4、hearing 6.3 | C1 関門（D17）／C2 課題の引き継ぎ／C3 `bin`（D33）・`agent_ran`（D30）（検査・test-plugin・作業エージェントの決まり、擬似の機器の試験 D34）／C4 `change-confirm.md`（課題のないとき D32、食い違う課題 D41） | 2段 `record-tools`・`test_change.py`・`tasks.test.mjs`・`run.test.mjs`・`grade.test.mjs`／1段 `eval-parity`／外 `tests-added`・`stage2`／なし：壊したプラグイン（1.2） |
| REQ-062 部品の独立性 | generated-plugin-structure 4.7・4.9・7・10章 | C3 `standalone` の検査、最初の指示のプラグインのフォルダ（D3）、エージェントの決まった文、作業エージェントの決まり（D10、スクリプトは S7） | 1段 `test_check_structure.py`／2段 ひな形 `core/start.test.mjs`、生成プラグインのスクリプトの試験（`--help` と誤った引数の終了コード。作業エージェントの決まり）／外 `stage1`・`stage2`／内 B／作る流れの外側の EVAL（取り直し） |
| REQ-018・019 資産と、標準機能・公開のプラグイン | hearing 3.4 | C4 `change-plugin/SKILL.md` の段階「資産と公開のプラグイン」（示したスキルのスクリプトを資産に。足す機能について、標準機能と公開のプラグインで済まないかを調べて示す。make-plugin の同じ段階の手順） | 外 `assets-reused`／なし：標準機能・公開のプラグインを示すこと（模擬ユーザーの機器は架空で、公開のプラグインで済む部分がない） |
| REQ-026・027 画面の質問と見本 | hearing 3.4・6.3 | C4 本文の「各段階での違い」（画面を変えるとき・作っていないプラグインのときだけ聞く）、`change-confirm.md`（そのときだけ見本。make-plugin の `confirm.md` の手順） | 外 `no-screen-questions`／なし：画面を変える頼み（1.2） |
| REQ-038・041 課題の形と EVAL の実行 | testing 10.4 | C3 `bin`（`check_structure.py` の `eval`、`tasks.mjs`、`run.mjs`）、`agent_ran`（`grade.mjs`、`run.mjs`） | 2段 `tasks.test.mjs`・`run.test.mjs`・`grade.test.mjs`／1段 `eval-parity` |
| REQ-045・046 対話のモデルとファイルを書くモデル | hearing（今のまま） | 変えない（対話はメイン、ファイルを書くのは作業エージェント） | 外 `main-model`・`worker-model` |
| REQ-048 試験の道具の用意 | creator-structure 4.1 | C4 `change-apply.md`（道具が足りないときは make-plugin の `generate.md` の4の2をそのまま使う） | なし（make-plugin と同じ手順を名指しするだけで、道具が足りない場面を作る試験はない） |
| REQ-021 作る場所 | hearing 7.1 | C1 記録の置き場所は今のまま／C2 `commit` で一時フォルダを消す | 2段 `state.test.mjs`（直すときも記録は COPILOT_HOME の下だけ）／外 `nothing-outside` |
| REQ-032 作り直しを頼む | hearing 3.2 | C4 `make-plugin/references/start.md` の問い | 呼（make-plugin か change-plugin が呼ばれることだけ。問いは見られない） |
| REQ-043 決まったことの一覧 | hearing 7.2 | C1 `hearingView` の `skipped`、`creator.js` | 2段 `screen.test.mjs`・`screen.browser.test.mjs` |
| REQ-044 画面で見られるもの | hearing 6.3 | C1 `confirmationView.change`、`creator.js` | 2段 同上 |
| REQ-049 質問の改善案 | hearing 11章 | C4 `change-apply.md` → improve.md「生成の後」、improve.md のタグとフォルダ／C1 `itemTouchedAtRecord` | 2段 `record-tools`（変えないので聞かない項目は数えない） |

---

## 3. 全体の流れ

`<作業フォルダ>`＝Copilot CLI を起動したフォルダ。`<P>`＝元のプラグインのフォルダ。`<W>`＝`<作業フォルダ>/.plugin-creator-work/`（D8。`<P>` の中にできることもあり、`<P>` の外にできることもある。どちらも仕様の文に合わないので、統括に仕様の直しを頼む。8.2）。`<S>`＝`scaffold.py`（`<change-plugin>/../make-plugin/scripts/scaffold.py`）。記録＝`<COPILOT_HOME>/plugin-data/plugin-creator/hearings/<セッション>/state.json`。

| 段階（記録の名前） | すること | ツール・スクリプト | 読む | 書く |
| --- | --- | --- | --- | --- |
| 始まり | 1) `plugin-creator_open`、URL を示す。2) make-plugin の SKILL.md の4節と words.md を読む。3) `plugin-creator_state`。4) フォルダを決める。「作り直したい」だけなら、直すか新しいフォルダかを聞く（記録を作る前）。受け付けない頼みは理由を示す。5) `python3 <S> change-check --plugin <P> --cwd <作業フォルダ>`。断られたら直し方を示して止まる（記録は作らない）。6) `plugin-creator_change`（folder、wants）。7) 流れを示す | ext open/state/change、`change-check` | `<P>` の plugin.json・knowledge.json・knowledge-removed.json・task.json・eval.json（エクステンション） | 記録 |
| 実物を受け取る | 組み込みたい今のスキルと、変えるところの前回の1回のファイルの場所を、1問で聞く | ask_user、record（資産） | — | 記録 |
| 読む | 読み取り役2つ（元のプラグイン／示したスキル）を並べて頼む。終わりに①範囲の確かめ（引き継ぐこと・変えること）②決まりの一覧の確かめ（生成プラグインのとき1問）。違う・古いと答えた決まりは、今を聞いて直す（新しい番号）か外す | task `plugin-creator:reader`、record | `<P>`、示したスキル（読み取り役） | 記録 |
| 前回の1回 | 変えるところに関わる作業の、最近の1回（作っていないプラグインでは最初から最後まで） | ask_user、record | — | 記録 |
| 決まりの確かめ | 一覧にない決まり・示したスキルの決まり・作っていないプラグインの決まりを1件ずつ | 同上 | — | 記録 |
| 項目の点検 | 生成プラグインのときは、始めに、変えるところに関わらない項目を「変えないので聞かない」にする（抜き書きは範囲の確かめの答え）。関わる項目だけ聞く。作っていないプラグインのときは「変えないので聞かない」を使わず、読み取って分かった項目は、分かったことを示して、違うところと足りないところを聞く（REQ-015・056） | progress、record | — | 記録 |
| 資産と公開のプラグイン | 示したスキルのスクリプトなどを流用の資産に。足す機能について、標準機能と公開のプラグインで済まないかを調べて示す（make-plugin の同じ段階の手順。REQ-019、憲章 第12条3項） | record | — | 記録 |
| 画面 | 画面を変えるとき、作っていないプラグインのときだけ | — | — | 記録 |
| 生成前の確認（＝直す前の確認） | 1) `python3 <S> extract --plugin <P> --work <W> --hearing <state.json>`：`<W>/parts/`・`<W>/draft/task.json`・`<W>/preview/`・`<W>/extract.json` を作る（作っていないプラグインでは、parts は `files/` だけで、draft と manifest.json は書かない。D31）。2) 作業エージェント A が draft を書く・直す（画面を変えるとき、組み方を変えるとき、1段目の結果で作業の定義が決まりに合わないとき、作っていないプラグインのとき。D31）。3) 課題の案（引き継ぐ課題は入力を `provisional:true` で、食い違うものは直す案〔D41〕。足す課題は1つ以上。元に課題がなければ作業全体を試す課題も〔D32〕。機器に頼るときは擬似の機器〔D12・D33〕）。足すルールのスキルの名前は、示されたスキルの名前と違うものにする（D35）。4) `plugin-creator_confirm`（`rebuild{keep,change}`、`version`）。`extract` の結果（上書きされる土台のファイル、1段目で落ちるところとその直し、消すファイル、重なる機能〔D13〕、名前の重なり）と、本物の機器の手順は試せないことを、`rebuild.change` の文に必ず入れる（画面にも出すため。REQ-057・044）。5) 示す：confirm.md のもの＋change-confirm.md のもの（土台の差分、1段目で落ちるところ、消すファイル、重なる機能、擬似の機器で試すこと、版）。6) 承認 → progress で「生成」 | `extract`、confirm、progress | `<P>`（スクリプト） | `<W>` だけ。`<P>` は変えない |
| 生成（＝直す） | 1) コンパクションの後の続き（下）。2) シェル：`draft/task.json` → `parts/task.json`、示したスキルのスクリプト → `parts/files/skills/<ルールのスキル>/scripts/`、消す機能のファイルを `parts/files/` から消す。`parts/manifest.json` を書く・直す（作業エージェントを足すときは `workers` に足す。作っていないプラグインでは make-plugin の `generate.md` の1と同じく1から。D31）。3) 作業エージェント B「直すプラグインの部品」：変える差し込み口と `parts/files` だけ直す（作っていないプラグインでは、すべての差し込み口を書く。D31）。4) `python3 <S> change --hearing <state.json> --work <W> --plugin <P>`（直す直前の確かめ → 決まりの合わせ → `<W>/stage/` に描く → 入れ替え → `changed.json`）。断られたら直して再実行（直しの回数に数える）。5) `python3 <P>/tests/run.py`。道具が足りないと出たら、make-plugin の `generate.md` の4の2のとおりにする（`check_tools.py --plugin <P> --scope stage12` で示して入れてよいかを聞き、入れないと答えたら試験をせずに6へ）。不合格なら作業エージェント C が `<P>` で直す → `check-base --out <P>` と `change-guard --plugin <P> --work <W>`（違えば `--restore` して伝える）→ 戻る。3回まで。6) `python3 <S> commit --plugin <P> --work <W> --message "plugin-creator: <名前> を直した（<旧> → <新>）"`（合格・上限・試験なしのどれでも）。7) `plugin-creator_results`（`<P>/tests/results/latest.json`）。8) 説明（REQ-060 の10点）。9) improve.md「生成の後」 | `change`・`check-base`・`change-guard`・`commit`、results | 記録、`<W>` | `<P>`、`<W>`（最後に消える） |

- コンパクションの後の続き（change-apply.md に書く）：`<W>/changed.json` がなく `<W>/extract.json` があれば2から。`changed.json` があれば5から（直しの回数が分からなければ残り1回）。`<W>` がなく、HEAD に C2 のタグの名前（`tag_name`）のタグがあれば8から。`<W>` がなく、タグもないが、HEAD のコミットの説明が `plugin-creator: <名前> を直した` で始まれば、タグを付けられなかったとき（D40）として8から。
- `.plugin-creator-work/` は、`change-check` の未コミットの確かめ、`change` の入れ替え、`change-guard`、`commit`、1段目の検査（D22）のすべてで除く（D8）。ひな形の `.gitignore` にも足す。
- push はしない。起票（REQ-049）だけはユーザーの承認の後にする。

---

## 4. データの形

### 4.1 ヒアリングの記録（C1 が書き、C2・C4・C6 が読む）

`schemaVersion` は 1 のまま。ない欄は null として読む。

```jsonc
"change": null | {                     // 直す流れのときだけ。plugin-creator_change が作る
  "folder": "/abs/real/path",          // 直すフォルダの実パス
  "manifest": "plugin.json",           // 見つけた場所（直下 → .plugin/ → .github/plugin/ → .claude-plugin/ の順）
  "name": "embedded-debug-loop",
  "version": "0.1.0",                  // なければ null
  "generated": true,                   // D29 の見分け方（change-check・extract と同じ）
  "carried": ["K-01", "...", "K-17"],  // 取り込んだ番号
  "removed": [],                       // tests/knowledge-removed.json の番号
  "maxId": 17,                         // carried と removed の番号の最大（D15）。knowledgeCounter の初めの値
  "criteriaIds": { "K-07": "C-01", "K-13": "C-02", "K-14": "C-03" },  // 元の task.json の criteria
  "evalPrompts": ["…"],                // 元の tests/eval/*/eval.json の prompt
  "wants": ["…"],                      // 変えたいこと
  "startedAt": "…"
}
```

- 項目の状態を足す：`unchanged`「変えないので聞かない」（`ITEM_STATUSES`）。直すときだけ、未着手からだけ。「前回の1回」には使えない。`generated:false` のときは、どの項目にも使えない（生成プラグインの形にすること自体が変えるところになるため。REQ-056）。抜き書きの確かめは、未着手と `unchanged` のどちらから変えるときも行う。
- ナレッジの行に足す：`carried: true`（取り込んだ行。`source:'existing_plugin'`、`status:'candidate'`、`quote:'tests/knowledge.json の K-07'`、`item` は日本語の名前を記号に直したもの、`itemName` は knowledge.json の `item`（日本語の名前）のまま、`itemTouchedAtRecord:false`）、`replaces: "K-15"`（中身を直して付け直した新しい行が持つ）。組み立ての `decided_knowledge` は項目の名前を `itemName` から読む（`scaffold.py:232`）ので、`itemName` がないと 4.2 の①がすべて「中身が違う」になる。
- 確認に足す：`confirmation.version`（直すときだけ）、`confirmation.criteria: [{ "id": "C-04", "knowledge": "K-20" }]`（どちらの流れでも書く。build は読まない）。`confirmation.rebuild{keep,change}` は直すときも使う（直すときは必須、`change` は1件以上）。

### 4.2 決まりの番号（REQ-058）

| 場面 | 決まり | 守る場所 |
| --- | --- | --- |
| 取り込み | knowledge.json の番号・種類・項目・文のまま、候補で入れる | C1 `plugin-creator_change` |
| 足す | `knowledgeCounter` は `change.maxId` から続ける（外した番号を含む最大の次） | C1／C2 が確かめる |
| 中身を直す | `carried` の行の種類・項目・文・例・例外を変える記録が来たら、元の行を「外した」にし、新しい番号の行（`replaces`＝元の番号）を足す（REQ-058「中身を直した決まりは新しい番号」、決定17）。この会話で足した行の直しは番号を変えない（まだプラグインに入っていない）。付け直した元の行を「決まった」に戻すのは断る | C1 |
| 外す | `carried` の行を「外した」にする | C1 |
| 合わせ方 | O＝元の knowledge.json、R＝元の knowledge-removed.json、S＝記録の決まった行。①O の番号は、S に同じ番号・同じ種類・項目・文であるか（項目は O の `item` と S の `itemName` を比べる）、S にない（外す）か。同じ番号で中身が違えば断る。②S の新しい番号は max(O∪R) より大きく、R にない。③`replaces` は O の番号で、今回外すもの。④書く：knowledge.json＝S（番号の順）、knowledge-removed.json＝R＋今回外したもの | C2 `change` |

### 4.3 `tests/knowledge-removed.json`（C2 が書き、C1・C3 が読む）

```json
[
  { "id": "K-15", "kind": "other", "item": "いつもと違うとき", "text": "（外した時点の文）", "replacedBy": "K-19" }
]
```

- `replacedBy` は中身を直したときだけ。前の改善で外したものも消さずに残す。1件もなければファイルを作らない。
- `id` は knowledge.json と重ならない。`replacedBy` は knowledge.json か、このファイルの番号（付け直しが続いたとき）。

### 4.4 合否の基準の番号（C 番号。D14）

- 関数 `criteriaRows(rows, criteriaIds)`（C1 `change.mjs`）：`rows` は確認で示すナレッジ（番号の小さい順）。合否の決め方の行ごとに、`criteriaIds[行の番号]` があればその番号、なければ `criteriaIds` の値の最大の次から順に `C-NN`（2桁以上）。作る流れは `criteriaIds={}` なので今と同じ（C-01 から）。
- `confirmationView` の基準と、見本の差し込み（`injectCriteria`）はこの関数の結果を使う。`confirm` は結果を `confirmation.criteria` に書く。
- C2 `change` は `confirmation.criteria` を使う（`make_criteria` は使わない）。確かめ：番号の形、重なりなし、ナレッジの組＝決まった合否の決め方の組、元の task.json の対応のうち引き継いだものは同じ番号、新しい番号は元の番号と重ならない。違えば断る。
- 外した基準の番号は覚えない。引き継いだ課題の eval.json が、外した・直した基準を `id` で指したままなら、`prepare_eval` が断る（作業エージェントが `knowledge` に書き直す）。

### 4.5 版の案（D16）

- 確認の `version`：`^\d+\.\d+\.\d+$`。`change.version` があるときは、それより大きい（数ごとに比べる）。違えば断る。
- C2 `change` は、描いた `plugin.json` の `version` を `confirmation.version` にする（ひな形は 0.1.0 の決め打ち）。

### 4.6 EVAL の課題

- 引き継ぎ：元の `tests/eval/*/` は `extract` が `parts/files/` に入れる（eval.json は `id`・`text` のまま）。確認では、引き継ぐ課題を、元の prompt・設定・基準のナレッジの番号（`criteriaIds` の逆引き）で並べ、入力は `{"path": "tests/eval/T-01/inputs/…", "provisional": true}`（プラグインの中の場所）で渡す。確かめた決まりと食い違う課題（例：入力のルールのファイルが取り込んだスキルと違う）は、直す案を示す。外すのは、ユーザーが自分から頼んだときだけ（D41）。
- 元に課題がないとき：作業全体を試す課題を1つ以上作る（D32。make-plugin の `confirm.md` の課題の作り方）。変えたところを試す課題とは別の課題にする。
- 足す課題：1つ以上（D17）。基準には、取り込んだ決まりに沿って作業したかを判定できる合否の決め方の決まり（引き継いだ K-07 のようなものでもよい）を入れる。組み方の変更では、実行の記録で決めたエージェントが動いたかを見る基準 `agent_ran`（D30）を入れる（REQ-061）。
- 擬似の機器（D12・D33）：機器に頼る課題は `eval.json` に `"bin": "inputs/bin"` を書き、`inputs` に `inputs/bin/<道具の名前>`（差し替えのスクリプト）を入れる。差し替えは、取り込んだ決まりにある機器の振る舞い（受け付けない形を断る、終わりの目印を出す）をまね、呼ばれるたびに `<スクリプトのフォルダ>/../../device-history.log`（＝作業フォルダの `device-history.log`）に1行足す。program の基準はこのファイルを見る。差し替えのスクリプトにも2段目の試験を書く（D34）。本物の手順そのものは試せないことを、直す前の確認で示す。決まりが機器の道具を絶対パスで呼ぶときは、機器に送る手順を課題に入れない（D33）。
- `bin` の決まり（C3 が検査と test-plugin で守る）：文字で、`"inputs/bin"` だけ（D33）。`inputs` の1つ以上がその下にある。test-plugin は、写した後にその下のファイルに実行の権限を付け、`<作業フォルダ>/inputs/bin` を `PATH` の先頭に足す。Windows では `bin` のある課題を課題の誤りとして断る（D33）。
- `agent_ran` の決まり（C3 が検査と test-plugin で守る。D30）：`{ "type": "agent_ran", "agent": "<名前>" }`。`agent` は `com.github.copilot/agents/<名前>.agent.md` があるエージェント。採点は、その実行の `subagents[].agentName` が `agent` か `<プラグインの name>:<agent>` のものがあれば合格。

### 4.7 `.plugin-creator-work/` の中（C2 が書く）

| 場所 | 中身 | いつ |
| --- | --- | --- |
| `parts/{manifest.json, task.json, slots/*.md, files/**}` | build と同じ形。生成プラグインなら元から取り出したもの（メインと作業エージェントが直す）。作っていないプラグインでは `files/**` だけを `extract` が作り、manifest.json はメイン、差し込み口は作業エージェント B が書く（D31） | `extract`、生成の2・3 |
| `draft/task.json` | 生成プラグインなら元の task.json から `criteria` を除いたもの。作っていないプラグインでは作業エージェント A が書く（D31） | `extract`、確認の2 |
| `preview/<名前>/` | 今のひな形で描き直した下見（版は元のまま） | `extract` |
| `extract.json` | `extract` の結果（標準出力と同じ） | `extract` |
| `stage/<名前>/` | 直す内容で描いたもの（入れ替えの後に消す） | `change` |
| `changed.json` | `{ "plugin", "head", "files": [描き直しで変わった・足した・消したファイル。P からの相対の POSIX パス] }` | `change` |

---

## 5. 部品ごとの変更

共通の方針：

- 断る文・失敗の文は、ユーザーにそのまま見せられる平易な日本語にし、何がよくないかと、どうすればよいか（実際のコマンド）を書く。内部の記号（`unchanged`、`carried` など）を出さない（`tests/creator/extension/words.test.mjs` の決まり）。
- 足した試験は、今の試験の置き場所と道具を使う。実行は `python3 tests/creator/run.py`。

### C1 エクステンション（`com.github.copilot/extensions/plugin-creator/*`、`tests/creator/extension/*`）

| ファイル | 変えること |
| --- | --- |
| `change.mjs`（新） | `readPluginForChange(folder)` → `{ manifest, name, version, generated, knowledge[], removed[], maxId, criteriaIds, evalPrompts }`（plugin.json を4つの場所の順に探す。knowledge.json・knowledge-removed.json・`com.github.copilot/extensions/<name>/task.json`・`tests/eval/*/eval.json` を読む。壊れていれば理由つきで断る。`generated` は D29 の見分け方。取り込む行に `itemName`〔4.1〕）。`criteriaRows(rows, criteriaIds)`（4.4）。`compareVersions(a, b)` |
| `names.mjs` | `ITEM_STATUSES` に `['unchanged', '変えないので聞かない']` |
| `hearing.mjs` | `freshState` に `change:null`。`applyChange({folder, wants, plugin})`（新しい記録を段階「始まり」で作る。同じフォルダなら `wants` だけ置き換え、取り込み直さない。違うフォルダ、作る記録があるときは断る）。progress の `unchanged` の決まり（4.1）。直すときは段階・項目「できていたことの確認」を断る。record の付け直し（4.2）。`itemTouchedAtRecord` は `todo`・`unchanged` のとき false。`isChange`、決まりの変わり方（足した・直した `{from,to}`・外した）を返す関数 |
| `creator.mjs` | handlers に `change`。`confirm`：直すときは `rebuild` 必須（`change` 1件以上）、`version` 必須・形・今の版より大きい、D17 の関門、`criteriaRows` で C 番号、`confirmation.version`・`confirmation.criteria` を記録。`confirmationView` に `change: { folder, version:{from,to}, keep, change, added, replaced:[{from,to}], removed }`、基準は `criteriaRows` の結果。「作る前の確認」と「直す前の確認」を記録で選ぶ関数 `confirmWord(state)` を、返り値・断る文で使う |
| `tool-defs.mjs` | DEFS に `{ name: 'change', caller: 'main', skipPermission: true }`。引数 `folder`（文字、必須。作業フォルダからの相対か絶対）、`wants`（文字の一覧、1件以上、必須）。confirm に `version`（文字） |
| `descriptions.mjs` | change の説明。open の説明に change-plugin を足す。confirm の `rebuild`・`version` の説明に直すときのこと |
| `sample.mjs` | `injectCriteria(draft, criteria)` は番号つきの基準を受ける（番号を付けない） |
| `report.mjs` | `stateText`：直すときは「直すプラグイン：<folder>（<name>、今の版 <version>）」「変えたいこと：…」「引き継いだ決まり：N件」「足した決まり：…／直した決まり：K-15→K-19／外した決まり：…」の4行。最後の行のスキル名を change-plugin にする。`hearingView`：`items[].skipped`、`skippedItems`、`notAskedItems` から `unchanged` を除く、`change` の要約 |
| `hooks.mjs` | `COMPACTION_NOTICE_CHANGE`（「…skill ツールで change-plugin を読み直し、plugin-creator_state を呼んで…」）。記録の `change` で選ぶ。どちらも 1KB 未満を読み込みのときに確かめる |
| `ui/static/creator.js`・`creator.css` | 項目の欄「変えないので聞かないこと（N）」（「聞いたこと」は `done && !skipped`）。`STATUS_TONE` に `'変えないので聞かない': 'neutral'`。直す前の確認の見出し、直すフォルダ、版（今 → 案）、引き継ぐこと・変わること、決まりの足す・直す・外す |
| `store.mjs`、`screen.mjs` ほか | 変えない。子プロセスを使わない（git の確かめは C2。D7） |

`plugin-creator_change` の返り値（C4 が頼る）：「直すプラグインとして記録しました（<name>、今の版 <version>）。仕事のやり方や決まり K-01〜K-17 の17件を、確かめたいこととして取り込みました。新しい決まりは K-18 から付きます。」（取り込めないときは「決まりの一覧（tests/knowledge.json）がないので、クリエイターが作っていないプラグインとして扱います。」）

足す・直す試験（名前に要件の番号）：

- `helpers.mjs`：`writePluginFolder(cwd, { knowledge, removed, version, manifestAt, task, evals })`、`startChange(run, overrides)`。`INTERNAL_SYMBOLS` に `unchanged`・`carried`・`replaces`。
- `record-tools.test.mjs` に `describe('今のプラグインを直す')`：extension.md 4.3 の1〜16（REQ-052・054・056・057・058・061・049・020）。加えて、C 番号（引き継いだ基準は元の番号、直した基準は続き）、knowledge-removed.json の番号を数える（D15）、作っていないプラグインでは `unchanged` をどの項目でも断る（REQ-056）、引き継いだ行の例・例外だけを直しても新しい番号になる（REQ-058）、取り込んだ行に `itemName` がある、D29 の見分け方（knowledge.json だけ・task.json だけのときは作っていないプラグイン）、課題のない作っていないプラグインで、作業全体を試す課題と変えたところを試す課題の2つで確認が受け付けられる（D32・REQ-061）。
- `state.test.mjs`：4行、最後の行、再開、記録の置き場所（REQ-060・052・059・021）。
- `hooks.test.mjs`：直すときの差し込みの文（1KB 未満）。
- `screen.test.mjs`・`screen.browser.test.mjs`：`skippedItems` と欄、直す前の確認の欄（REQ-043・044・056・057）。`rebuild.change` に入れた `extract` の結果の文（上書きされる土台のファイル、消すファイル、重なる機能、試せない本物の手順）が、直す前の確認の欄に出る。
- 直すもの：`tools.test.mjs`（ツール9つ、状態の enum）、`failure.test.mjs`（`9 * weird.length`、change の断り）、`screen.test.mjs:197`（`skipped:false`）、`words.test.mjs`（新しい文）。

### C2 組み立て（`skills/make-plugin/scripts/scaffold.py`、`tests/creator/scaffold/*`）

関数の分け方（build の振る舞いは変えない）：

- `prepare_parts(work, template, knowledge, criteria, confirmation, problems, warnings) -> Parts`：今の build の manifest・task・slots・files・eval の読み取りと突き合わせ（scaffold.py:1119-1135）。
- `render_parts(parts, out, template, values) -> None`：今の build の写す・名前を変える・作業エージェント・差し込み口・task.json・knowledge.json・files・eval_inputs・土台の確かめ（scaffold.py:1152-1208。git はしない）。`knowledge_removed` があれば `tests/knowledge-removed.json` も書く。
- `build` は今と同じ順で、この2つと `first_commit` を呼ぶ。

子コマンド（標準出力に JSON 1つ。終了コード 0 成功、1 断った・失敗、2 使い方の誤り）：

| 子コマンド | 引数 | すること | 返す（成功） |
| --- | --- | --- | --- |
| `change-check` | `--plugin P --cwd C [--hearing S]` | 読むだけ。①マニフェストがある（4つの場所）②P が C の中か C そのもの③インストール・キャッシュの写しでない（D39）：`<COPILOT_HOME>/installed-plugins/`（COPILOT_HOME は環境変数、なければ `~/.copilot`、`--hearing` があれば state.json の5つ上も）、キャッシュ（`COPILOT_CACHE_HOME` とその下の `copilot`、なければ Linux `$XDG_CACHE_HOME/copilot` か `~/.cache/copilot`、macOS `~/Library/Caches/copilot`、Windows `%LOCALAPPDATA%/copilot`）④git のリポジトリの中（`git -C P rev-parse --show-toplevel --show-prefix`）⑤管理されている：マニフェストが `ls-files` にあり、P が .gitignore で外されていない。さらに、外されたファイル（`git -C P ls-files -z --others --ignored --exclude-standard -- .`）のそれぞれが、ひな形の `.gitignore` の行（末尾の `/` を除いて `/` を含む行は P からの前方一致、含まない行はどの深さのフォルダの名前とも一致）か `.plugin-creator-work/` に当たる。当たらないものがあれば、最大10件と直し方を示して断る⑥`git -C P status --porcelain=v1 -z --untracked-files=all -- . ':(exclude).plugin-creator-work'` が空⑦マージなどの途中でない（D21） | `{ok, plugin, repo_root, prefix, manifest, name, version, generated, tag}`（`generated` は D29） |
| `extract` | `--plugin P --work W [--hearing S]` | P の git が管理するファイルから parts を作る（scaffold.md 4.3 の目印による取り出し。`task-trace` は REQ-101 以上の行。入口のスキルは `<name>_open` を書くスキル。作業エージェントの一覧は task.json、extra_tools は元の tools からひな形の tools を引いたもの。決まった値は plugin.json・入口のスキル・marketplace.json・憲章の 1.0.0 の行の日付）。ひな形と組み立てが作る場所のファイルは parts/files に入れない。`draft/task.json` を書く。`preview/` に描き、P と比べる。preview に1段目を当てる（PyYAML と jsonschema がなければ注意に書いて飛ばす）。作っていないプラグイン（D29）：差し込み口は取らず、ひな形と重なるファイルと以前の形式のマニフェストを `delete` に並べ、manifest.json と draft は書かない（D31）。`--hearing` があれば、D35 の名前の重なりを返し、D28 の記録の漏れと、示されたスキルのフォルダが P の中にあるときは断る | `{ok, generated, slots:{名前:"found" または "missing"}, files:N, delete:[], base:{added:[],removed:[],changed:[{file,plus,minus}]}, stage1:[文], name_conflicts:[{name, user_skill, plugin_skill}], warnings:[]}`（`extract.json` にも書く） |
| `change` | `--hearing S --work W --plugin P` | ①関門：段階「生成」、`approvedAt`、`confirmation.version`・`confirmation.criteria`、`change.folder == real(P)`、記録の `change.generated` と `extract.json` の `generated` が同じ（D29）②`change-check` をやり直す（C は W の親）③決まりの合わせ（4.2）と C 番号の確かめ（4.4）④`prepare_parts`⑤名前の重なり（D28・D35。最後の守り）：資産の `SKILL.md` の `name`（なければフォルダの名前）が、描いた `skills/` の名前と同じなら断る。資産のスキルのフォルダが P の中なら断る。資産のファイルが `SKILL.md` のあるフォルダの下にあるのに、そのフォルダが資産にないなら断る⑥`W/stage/<名前>/` に `render_parts`、version を置き換え、土台の確かめ⑦入れ替え：P の管理するファイルのうち描いたものにないものを消し、描いたものを `copy2` で写す（外されたファイルと `.plugin-creator-work/` に触れない）。失敗したら `git checkout HEAD -- .` と `git clean -fdq -- . ':(exclude).plugin-creator-work'` で戻して断る⑧`changed.json`、`stage/` を消す。コミットしない | `{ok, plugin, version:{from,to}, added:[], removed:[], changed:[], knowledge:{kept:[], added:[], replaced:[{from,to}], removed:[]}, criteria:[{id,knowledge}], warnings:[]}` |
| `change-guard` | `--plugin P --work W [--restore]` | `git status` の変わったファイル（`.plugin-creator-work` を除く）のうち、`changed.json` の `files` にないものを示す。`git status` はリポジトリの根からの場所を出すので、`rev-parse --show-prefix` を外して P からの相対にしてから比べる。`--restore`：管理されているものは `git checkout HEAD --`、管理されていないものは消す | `{ok, unexpected:[], restored:[]}` |
| `commit` | `--plugin P --message M [--work W]` | ①`git add -A -- . ':(exclude).plugin-creator-work'`②`git diff --cached --quiet -- .` で何もなければコミットしない③`git -c commit.gpgsign=false [-c user.name=plugin-creator -c user.email=plugin-creator@localhost] commit -q --no-verify -m M -- . ':(exclude).plugin-creator-work'`④`git tag -f <tag>`（失敗したら D40：コミットは残し、`tag` を null、理由を `warnings` に）⑤W を消す。push しない | `{ok, commit, tag, revert:"git -C <P> revert --no-commit <commit> && git -C <P> commit -m … -- ."（最後の点検で直した）, work_folder_removed, warnings:[]}` |

- ファイルの場所（`changed.json` の `files`、`extract` の `delete`・`base.*.file`、`change` の `added`・`removed`・`changed`、`change-guard` の `unexpected`・`restored`）は、すべて P からの相対の POSIX パス（区切りは `/`）にする。

- タグの名前 `tag_name(prefix, name)`：プラグインのフォルダがリポジトリの直下なら `plugin-creator-generated`、そうでなければ `plugin-creator-generated-<plugin.json の name>`（D9）。improve.md も同じ決まり。
- `check-base`：D20 の範囲を足す。
- git は今の `git()`（`GIT_*` を外し、`GIT_TERMINAL_PROMPT=0`、120秒）で、`-C P`、pathspec は `.`。
- 断る文の例（REQ-053。C4 がそのまま示す）：「このプラグインのフォルダ（P）は、Copilot CLI を起動したフォルダ（C）の外にあります。`cd P` で移ってから `copilot` で起動し直し、もう一度頼んでください。」「P に、まだコミットしていない変更があります（a.md、b.py）。`git -C P add -A -- . ':(exclude).plugin-creator-work' && git -C P commit -m "直す前の状態"` でコミットするか、要らない変更を消してから、もう一度頼んでください。」（`.plugin-creator-work` を除くのは、前の実行で残った作業用の一時フォルダをコミットしないため）

試験 `tests/creator/scaffold/test_change.py`（新。scaffold.md 6章の表すべて）に加えて：

- `extract` の往復（build したものを extract して変えずに描くと、版のほかは同じ）、古い土台の fixture で差し込み口が変わらず土台だけが変わる、`stage1` に落ちるところが出る、作っていないプラグイン（`delete` に以前の形式のマニフェスト）、`--hearing` での名前の重なり・記録の漏れ・P の中のスキル（D28・D35）。
- D29 の見分け方（knowledge.json だけ、task.json だけ、両方、読めない）を `change-check`・`extract` で同じ結果に。`change` は記録と `extract.json` の `generated` が違えば断る。
- 作っていないプラグインで、メインと作業エージェントの代わりに試験が manifest.json・draft・すべての差し込み口を書き、`change` を最後まで通す（D31）。生成プラグインで、`manifest.json` の `workers` と draft に作業エージェントを足して `change` を通すと、新しいエージェントの定義ができる（REQ-052）。`parts/files` から消したファイルが P から消える（REQ-054）。
- `change-check` の⑤：ひな形の `.gitignore` に当たる外されたファイル（`tests/results/x`、`a/__pycache__/y`）は通し、当たらないもの（`node_modules/x`）は断る。
- `change-guard`（一覧の外の変更を見つけ、戻す。P がリポジトリのサブフォルダのときも、描き直したファイルを一覧の外と見なさない）、`check-base` の tests の土台（D20）。
- C 番号（引き継いだ番号、直した基準は続き、`confirmation.criteria` と元の対応が違えば断る）、knowledge-removed.json（2回目の改善でも前の外した番号を使わない）。
- 本物の題材（統合の試験。`tests/dev-eval/fixtures/market.tar.gz` があるときだけ。ないときは飛ばす）：展開 → git → `change-check` → `extract`（10の差し込み口が found、`stage1` を返す）→ 手で作った記録（K-15 を直し、決まりを1つ足し、課題を1つ足す）と、手で直した parts（parts の中の K-15 の5か所〔`orchestrator.agent.md` の差し込み口2か所、`worker-b.agent.md`、`skills/cross-compile-rules/SKILL.md`、`skills/deploy-rules/SKILL.md`〕を新しい番号に、足した決まりの番号をルールのスキルの本文に書く、parts の中の `${PLUGIN_ROOT}` をプラグインのフォルダの書き方に直す）で `change` → `tests/stage1/check_structure.py` が合格 → `commit` でタグ `plugin-creator-generated-embedded-debug-loop`。作業フォルダを P と同じにして（`--work <P>/.plugin-creator-work`）同じことを行い、`change` の後に `python3 <P>/tests/run.py` の1段目が合格し、`.plugin-creator-work/` がコミットに入らない。
- `test_scaffold.py` の名前の決まりの試験が新しいファイルも見るようにする。

### C3 ひな形・構造の検査・test-plugin・クリエイターのエージェント

ファイル：`template/**`、`tests/creator/stage1/**`、`skills/test-plugin/scripts/**`、`tests/creator/test-plugin/**`、`com.github.copilot/agents/worker.agent.md`、`com.github.copilot/agents/reader.agent.md`。

| ファイル | 変えること |
| --- | --- |
| `template/com.github.copilot/extensions/_plugin_/core/lifecycle.mjs` | `buildInstruction` に、`ctx.pluginRoot` があれば `## プラグインのフォルダ` と絶対パスの行を足す（D3） |
| `template/com.github.copilot/agents/orchestrator.agent.md` | 「受け取るもの」に最初の指示のプラグインのフォルダ。手順2・3の `prompt` に「プラグインのフォルダ（絶対パス）」を書く |
| `template/.../worker.agent.md`、`verifier.agent.md` | 決まった文：「`<プラグインのフォルダ>` は、頼みの「プラグインのフォルダ」の絶対パスである。作業ごとの指示が `<プラグインのフォルダ>/skills/<名前>/SKILL.md` に従うよう書いているときは、そのファイルを読み、その手順に従う。スキルのスクリプトは、そのスキルのフォルダの絶対パスを前に付けて動かす。skill のツールは使わない」（「スキルを使わない」の行をこれに替える） |
| `template/.gitignore` | `.plugin-creator-work/` |
| `template/docs/specs/requirements.md`、`template/docs/design/design.md` | REQ-062 の写しと、追跡の表の行・設計の短い節（ルールのスキルを絶対パスで読む） |
| `template/tests/stage1/check_structure.py` | ①`knowledge`：4.3 の形、knowledge.json との重なり、`replacedBy`、外した番号が「今の `knowledge_tokens_outside_tests` の範囲＋`tests/eval/*/eval.json`＋`tests/stage2/task/**`」にあれば「<ファイル>:<行> が外した決まり K-15 を指しています（今の番号は K-19）」で不合格、task.json の基準が外した番号なら不合格。②新しい `standalone`（`["REQ-062"]`）：入口でない（本文に `<name>_open` がない）スキルごとに、SKILL.md と references の Markdown のリンクとバッククォートのパス（`scripts/`・`references/`・`assets/` で始まるもの）がそのフォルダにある。`../`、`${PLUGIN_ROOT}`、`${CLAUDE_SKILL_DIR}`、`skills/<ほか>/`、`com.github.copilot/`、`<name>_<ツール>`、`<name>:<エージェント>`、`task.json`、`knowledge.json` を書かない。入口でないスキルにある決まりの文（knowledge.json の text、15字以上）が、エージェントの定義やほかのスキルにそのまま書かれていない。エージェントの定義に `${PLUGIN_ROOT}` を書かない、定義が指す `skills/<名前>/` がある。`standalone` は `run_checks` の `if kind == "generated":` の下に置く（D22）。③`eval`：`bin`（4.6、D33）と `agent_ran`（4.6、D30）。④プラグインのフォルダ全体を歩く検査（`SKIP_DIRS` を使う `knowledge_tokens_outside_tests`・外した番号の検査・`standalone`、`check_symlinks`）は `.plugin-creator-work` を飛ばす（D22） |
| `skills/test-plugin/scripts/grade.mjs` | `CHECK_TYPES` に `agent_ran: { required: ['agent'] }`（`file` を持たない種類。`inputCheckProblems` の対象外）。`gradeRun` に `subagents`（省くと空）を足し、`agent_ran` は 4.6 の決まりで採点する（D30） |
| `skills/test-plugin/scripts/tasks.mjs` | `bin` の形の確かめ（1段目と同じ）、写した後に実行の権限。Windows では `bin` のある課題を課題の誤りにする（D33。理由の文つき） |
| `skills/test-plugin/scripts/run.mjs` | 課題に `bin` があれば、その実行（あり・なし）の環境の `PATH` の先頭に `<作業フォルダ>/inputs/bin`。`gradeRun` に、その実行の `record.subagents` を渡す（D30） |
| `com.github.copilot/agents/worker.agent.md` | ファイルの決まり：スキルが使うスクリプトは `files/skills/<スキル>/scripts/`、ほかの部品だけが使うものは `files/scripts/`（D10）。スクリプトは、どちらの場所でも、対話なし・`--help`・引数と標準出力・意味のある終了コードで、コマンドラインから単体で動かせるようにする（skill-spec 1.8 の S7。REQ-062）。スクリプトの試験は、コマンドとして動かし、`--help` と誤った引数の終了コードも試す。ルールのスキルの書き方（skill-spec 1.8 の S1〜S9 と 3.1 の U2〜U6 を短く）。決まりの文はルールのスキルにだけ書き、エージェントの指示はスキルの場所と番号だけ（例：「`<プラグインのフォルダ>/skills/cross-compile-rules/SKILL.md` を読み、その手順でビルドする（K-18）」）。エージェントの指示のスクリプトは `<プラグインのフォルダ>/scripts/…`（`${PLUGIN_ROOT}` を書かない）。擬似の機器（4.6、D33）と、その2段目の試験（D34）。組み方の変更の課題の基準 `agent_ran`（D30）。新しい節「D 直すプラグインの部品」：頼みに書かれた差し込み口と `parts/files` だけを直す（作っていないプラグインでは、すべての差し込み口を書く。D31）、付け直した番号はすべて新しい番号に、頼みにないファイルは変えない、ファイルは消さない（消すのはメイン） |
| `com.github.copilot/agents/reader.agent.md` | 「作り直しでは」を「作り直しと、今のプラグインを直すときは」に。直すときに返すもの：構成（スキル・エージェント・スクリプト・MCP・画面の設定・試験の課題）、渡された決まりの一覧にない決まりの候補、人に聞く場面。示されたスキルでは `name`・`description`、決まりの候補（ファイルと節つき）、資産の候補（絶対パス） |

試験：

- `tests/creator/stage1/test_check_structure.py`：scaffold.md 6章の最後の2項目（外した番号、部品の独立性）、`bin`、`agent_ran`、入口のスキルは対象外、成果物の場所の書き方（どこにもないパス）は合格、決まりの文の写し。`.plugin-creator-work/preview/` に外した番号や `${PLUGIN_ROOT}` があっても合格し、そこにだけ書かれた「それ以外」の番号は本文にあると数えない。種類 `plugin` では `standalone` を動かさない。
- `tests/creator/stage1/eval-cases.json`・`eval-parity.test.mjs`：`bin`（`inputs/bin` のほかは誤り）と `agent_ran`（ないエージェントは誤り）の合う・合わない例。
- `tests/creator/stage1/samples/good/`：新しい検査に合格するまま（要れば直す）。
- `template/tests/stage2/core/start.test.mjs`（か `wording.test.mjs`）：最初の指示にプラグインのフォルダがある。
- `tests/creator/test-plugin/tasks.test.mjs`・`run.test.mjs`：`bin` の確かめ、`PATH` の先頭、実行の権限、あり・なしの両方、Windows では断る（`process.platform` を差し替えて試す）、`subagents` が採点に渡る。
- `tests/creator/test-plugin/grade.test.mjs`：`agent_ran`（`agent` と `<name>:<agent>` は合格、ほかのエージェントだけ・記録なしは不合格）。

### C4 スキル・README・クリエイターの1段目・呼ばれ方

| ファイル | 中身 |
| --- | --- |
| `skills/change-plugin/SKILL.md` | 下書き（`prototypes/draft-change-plugin-SKILL.md`）を元にする。description は skillflow 2.1 の案。本文：先頭の決まり（承認の前に `<P>` を書かない、`<P>` の外を書かない（記録・試験の道具・`<W>` を除く）、示したスキルを変えない、push しない、読み直すのは change-plugin、言葉は words.md、`ask_user` で1問1欄）、始まりの手番、段階の表（3章）、各段階での違い、赤信号。`<make-plugin>` の決め方と「`change-` で始まるファイルだけがこのスキルのもの」の1行。make-plugin の4節を読む（D23） |
| `skills/change-plugin/references/change-start.md` | skillflow 2.2 の1〜8。`change-check` の呼び方と、断られたときに返った文をそのまま示して止まること |
| `.../change-read.md` | 読み取り役への2つの頼み（skillflow 5.2）、返ったものの記録（示されたスキルごとに、`SKILL.md` のあるフォルダの絶対パスを資産に記録する。D28）、範囲の確かめの問い、決まりの一覧の問い（1回）と、違う・古いと答えた決まりの扱い（「決まっていない」なら外し、案を作らない） |
| `.../change-confirm.md` | confirm.md に足すもの（REQ-057 の5点）、`extract`（`--hearing` つき）の結果の示し方（土台の差分のファイルの一覧と「上書きされます」、1段目で落ちるところとその直し〔D38〕、消すファイル、重なる機能〔D13〕、名前の重なり〔D35〕）。これらと試せない本物の手順は、`rebuild.change` の文に必ず入れる（画面にも出すため）。作業エージェント A に draft を書かせる・直させる場面（D31。作っていないプラグインでは make-plugin の `confirm.md` の「作業の定義の案」の頼み）。版の案（D16）、課題（4.6。引き継ぐ課題の直す案〔D41〕、足す課題、元に課題がないときの作業全体の課題〔D32〕、擬似の機器と試せないこと、絶対パスで呼ぶ道具〔D33〕）、足すルールのスキルの名前（D35）、画面を変えるとき・作っていないプラグインのときだけ見本、承認の問い「この内容で直してよいですか？」 |
| `.../change-apply.md` | 3章の「生成」の1〜9、続きの決め方（タグを付けられなかったとき〔D40〕を含む）、`parts/manifest.json` の書き方（D31）、道具が足りないとき（make-plugin の `generate.md` の4の2をそのまま使う。REQ-048）、作業エージェント B・C への頼み（渡すもの：`<W>/parts/` の絶対パス、変える差し込み口とファイル〔作っていないプラグインでは make-plugin の `generate.md` の2の頼みと同じく、すべて〕、変えないファイルの一覧、決まりの番号の付け直し、プラグインのフォルダの絶対パスの書き方）、説明（REQ-060 の10点。読ませ直し方は入れ方ごとに実際のコマンド、マーケットプレイスの一覧を手で直すこと、元のテストを残したこと、タグを付けられなかったこと） |
| `skills/make-plugin/SKILL.md` | description の「使わない」に「手元のプラグインのフォルダのまま機能を足したり設計を変えたりする頼み（例：「このプラグインにデプロイのスキルを足したい」）」を足す。本文は変えない |
| `skills/make-plugin/references/start.md` | 手順1の初め（記録の前）：フォルダを示して「作り直したい」とだけ頼まれたら、元のフォルダを直すか新しいフォルダに作るかを聞く。直すなら skill ツールで change-plugin を読む（REQ-032・052） |
| `skills/make-plugin/references/improve.md` | 「生成の後」は改善・設計変更の後も使う。「頼まれた試験の後」の差分は `git -C <フォルダ> diff <タグ> -- .`。タグは D9 の決まり。なければ `git -C <フォルダ> log --diff-filter=A --format=%H -- plugin.json` の最後のコミットから |
| `skills/test-plugin/SKILL.md` | description の「使わない」に「今あるプラグインに機能を足したり設計を変えたりする頼み」 |
| `README.md` | 「使い方」に「今あるプラグインを直す」の節（頼み方の例、`/plugin-creator:change-plugin`、直す前に要ること〔git でコミット済み、起動したフォルダの中〕、直した後の読ませ直し方） |
| `plugin.json`、`.github/plugin/marketplace.json` | 説明に「直す」を足す。版は 0.1.0 のまま（D37） |
| `tests/creator/check_creator.py`・`test_check_creator.py` | `check_skill_size` を `skills/*/SKILL.md` のすべてに（500行・5,000トークン） |
| `tests/dev-eval/trigger/{trigger.mjs, cases.json, trigger.test.mjs}`（新） | 置き換えたクリエイター（`convertPlugin`）を読み込んだ Claude Code（`makeQueryOptions`、モデル `claude-opus-5-5`）に頼みを1つずつ渡し、最初の Skill の呼び出しを断って記録する（スキル名）。cases：「〜にデプロイのスキルを足したい」「〜の画面に設定を足したい」「〜の作業役を2つに分けたい」「〜の機能を消したい」→ change-plugin、「〜を作り直したい」→ make-plugin か change-plugin、「週報をプラグインにしたい」→ make-plugin、「直したので試験し直して」→ test-plugin、「今週の週報を書いて」→ どれも呼ばない。`trigger.test.mjs` は cases の形と採点の関数だけを試す |

- 本文は5,000トークン以内（下書きは約2,450）。references はそれぞれ 20KB 未満で、本文で名指しする。

### C5 設計書（`docs/design/*.md`）

| 設計書 | 直す節 |
| --- | --- |
| creator-structure.md | 1章の図と2章の部品の表（change-plugin、子コマンド）、3.4（子コマンドと D18〜D21、生成プラグインの見分け方 D29、名前の重なり D35、ファイルの場所の書き方）、4.1（直すときの試験と直し、道具が足りないとき、change-guard、commit、タグを付けられないとき D40）、4.3（`plugin-creator_change`）、4.5（タグとフォルダ） |
| hearing.md | 1章（範囲に change-plugin）、3.4「直すとき」を新設（段階の表、範囲の確かめ、決まりの一覧の問い）、6.3（直す前の確認）、7.1〜7.3・7.5（`change`、`unchanged`、`carried`・`replaces`、確認の引数、断りの順）、8章（差し込みの文）、10章（change-plugin の SKILL.md、make-plugin の4節の共有、本文の長さ）、11章（直した後の振り返り）、12章（試験）、14章（最終確認：隣のスキルを読めるか、インストールした写しのスキルを作業エージェントが読めるか、名前の重なり、日本語の description） |
| generated-plugin-structure.md | 4.7（ルールのスキルを絶対パスで読む。最初の指示のプラグインのフォルダ）、4.9（作業ごとの部分：ルールのスキルとスクリプトをスキルのフォルダに）、7章（フォルダの構成、`tests/knowledge-removed.json`）、10章（`knowledge`・`standalone`・`bin`・`agent_ran` の検査、`.plugin-creator-work/` を飛ばすこと） |
| testing.md | 6章（改善の模擬ユーザー、作業フォルダの作り方、終わりの見分け、採点の観点）、7章（擬似の機器、確かめ A・B、`standalone` の腕）、8章（費用と時間）、10.4（`bin` と擬似の機器の決まり〔D33・D34〕、`agent_ran`〔D30〕）、11章（qemu-user、arm のツールチェーン、bubblewrap、socat、Playwright の Chromium 1194） |

- 設計書の決定の行には D 番号でなく中身を書く。要件の番号から節をたどれるようにする（憲章 第6条3項）。

### C6 開発の試験（`tests/dev-eval/**`）

#### C6a 擬似の機器（`tests/dev-eval/device/`）

| ファイル | 中身 |
| --- | --- |
| `kxemu.py` | 試作をそのまま（init・serve、コンソール、TFTP、HTTP の口、`KX2I` の確かめ、ARM の実行と bwrap の隔離、`console.log`・`history.jsonl`、決まった動き） |
| `bin/kxtool` | 試作の kxtool（実行の権限つき）。このフォルダには kxtool だけを置く |
| `kxdevice.mjs` | 試作を元に。`startDevice({ stateDir, addresses=['192.168.7.2'], isolate='auto' })` → `{ env:{KXEMU_GATEWAY, KXEMU_ADDRS}, binDir:<device/bin>, sandboxNetwork:{allowedDomains:['localhost:<HTTP>'], strictAllowlist:true}, sandboxFilesystem:{denyRead:[stateDir], denyWrite:[stateDir]}, reset(), records()→{consoleLog, history}, copyRecordsTo(workDir)（`<work>/.device/console.log`・`history.jsonl`。先に同じ名前を消す）, stop() }` |
| `sample/sensor.c` | 試作の `sample/sensor.c`（`AVG=25` を出す）。`kxdevice.test.mjs` が使う |
| `kxdevice.test.mjs` | `test_native.sh` の16項目を node:test に（`HTTP_PROXY` などは外して動かす）。`sample/sensor.c` と、C6b の `deploy/scripts/mkkximg.py`（同じものを2か所に置かない）を使う。qemu-arm か arm-linux-gnueabihf-gcc がなければ理由を出して飛ばす |

#### C6b ダミーのスキル（ユーザーの既存のスキル。D26）

置き場所：`tests/dev-eval/personas/edl-change/files/kx200-firmware/.github/skills/{cross-compile,deploy}/`（模擬ユーザーの `files[]` で `work/kx200-firmware/.github/skills/…` に置く）。plugin-creator・embedded-debug-loop・プラグイン・エージェント・K 番号の言葉を書かない。skill-spec 1.8 の S1〜S9 に従う（6項目のフロントマター、ASCII の名前、日本語の description、コマンドはスキルのフォルダの絶対パスで、スクリプトは対話なし・`--help`・JSON・終了コード、標準ライブラリだけ、「気をつけること」を本文に）。

| スキル | ファイル | 決まり（模擬ユーザーの答えの種類） |
| --- | --- | --- |
| cross-compile | `SKILL.md`、`scripts/kx-build.sh`（`--src DIR --name NAME --out DIR [--debug]`、`arm-linux-gnueabihf-gcc … -static`、成功で `{"elf": …}`、終了コード 0/2/3/4） | arm-linux-gnueabihf-gcc でビルドし、開発機の gcc を使わない（rule）／必ず `-static`（機器にローダーがない）（rule）／ふだんは `-O2`、デバッグの調査のときだけ `--debug`（`-O0 -g`）（exception）／ビルドの前にソースのフォルダで `git pull` する（incidental） |
| deploy | `SKILL.md`、`scripts/mkkximg.py`（試作の見出しと CRC32。`ELF NAME OUT`、名前は `^[a-z0-9-]{1,15}$`） | 送るものは `scripts/mkkximg.py` で `.kximg` に包む（ELF のままは `bad magic`）（rule）／`kxtool -d <IP> send` → `kxinstall /tmp/<イメージ>` → `reboot`（再起動まで有効にならない）→ `kxapp run <名前>`（rule）／`[kxapp] <名前> exited (status=N)` が出るまで取り、ログを頼まれた場所に保存（rule）／機器のアドレスの既定は `192.168.7.20`（wrong。今は `192.168.7.2`）／送る前に `kxtool console -c "uname -a"` で版を見る（incidental） |

- 試験 `tests/dev-eval/personas/test_dummy_skills.py`：ひな形の `check_skill_file` に合格、本文が指すファイルがフォルダの中にある、スクリプトの `--help` と誤った引数の終了コード、`mkkximg.py` の見出しを kxemu が受け付ける（道具がなければ飛ばす）。

#### C6c 改善の模擬ユーザー `tests/dev-eval/personas/edl-change/` と題材 `tests/dev-eval/fixtures/`

| ファイル | 中身 |
| --- | --- |
| `tests/dev-eval/fixtures/market.tar.gz` | `git -C <plugin-market-place> archive --format=tar.gz -o … 484584c README.md .github plugins/embedded-debug-loop`（D2・D24） |
| `tests/dev-eval/fixtures/make_market.sh` | 上のコマンド（作り直すとき用） |
| `files/…` | ダミーのスキル（C6b）と、`market/plugins/embedded-debug-loop/skills/log-insertion-rules/SKILL.md`（元の文の「ログ関数を使う場合」に「- KX-200 では `dbg_log.h` の `DBG_LOG` でログを出し、printf を直接使わない。」を1行足したもの。書き足した決まり。REQ-054） |
| `persona.json` | 下 |
| `inner/eval.json`、`inner/standalone.json`、`inner/inputs/src/{main.c, sensor_avg.c, sensor_avg.h, dbg_log.h}`、`inner/golden/.device/{console.log, history.jsonl}` | 確かめ A・B（下） |

`persona.json` に足す項目（FORMAT.md と validate.mjs を直す。`kind` を省くと今の「作る」）：

```jsonc
{
  "kind": "change",
  "workspace": {
    "repo": { "place": "market", "fixture": "market.tar.gz", "commitDate": "2026-10-01T00:00:00+09:00",   // fixture は tests/dev-eval/fixtures/ からの場所
              "staged": [{ "path": "README.md", "append": "\n作業中のメモ\n" }], "origin": true }
  },
  "target": "market/plugins/embedded-debug-loop",
  "device": "kx200",
  "expect": {
    "carriedMax": 17, "replaced": "K-15", "deviceTool": "kxtool",
    "userSkills": "kx200-firmware/.github/skills",
    "screenAsked": "<画面の問いに当たる正規表現>", "lastTimeAsked": "<最近の1回の問いに当たる正規表現>",
    "explained": ["revert", "起動し直", "marketplace\\.json|一覧", "\\d+\\.\\d+\\.\\d+"]
  }
}
```

- `files[]` の `role` に `skill`（ユーザーの既存のスキルのファイル。`assets-reused` の元）と `repo`（初めのコミットの前にリポジトリの中に置く。ユーザー役は示さない）を足す。`kind:change` では `.py`・`.sh`・`.c`・`.h` を示せ、docx・xlsx の決まりを外す。
- 頼み（`request`）：「market/plugins/embedded-debug-loop のプラグインを、うちの KX-200 のボードで使えるようにしたいです。今使っている KX-200 のクロスコンパイルとデプロイのスキルが kx200-firmware/.github/skills にあるので、それを組み込んでください。」
- ナレッジ：C6b の決まり（`from: file`）、書き足した決まり（`from: file`、rule）、K-15 の今（`fact`：決まりの一覧を見せられたら「K-15 は古い。今は、デプロイできない・ログが取れないときは、機器を1回 `reboot` してやり直し、それでもだめなら人に伝える」と答える。前回の1回でも話す）、ほかの決まり（K-01〜K-17 のうち K-15 のほか）は「このとおり」。markers は元のプラグインの文字に当たらない言葉にする（validate.mjs で、題材の文字に当たらないことを確かめる）。
- `userRoleTests`：決まりの一覧の問い（K-15 が古いと答える）、決まりの確かめの4つの答え。
- 確かめ A（`inner/eval.json`）：prompt「inputs/src のセンサー値の平均のプログラムで、KX-200 の機器のログに出る平均値が期待と違います。直してください。アプリの名前は sensor です。成功の条件：機器のログに AVG=25 と出ること。制約：inputs/src/dbg_log.h は変えないこと。」。基準（program）：`.device/console.log` に `AVG=25` の行と `[kxapp] sensor exited (status=0)`、`history.jsonl` にインストールの成功、`"kind": "arm-static", "status": 0`、再起動の後の実行、`"addr": "192.168.7.2"`、`inputs/src/dbg_log.h` が `unchanged`。
- 確かめ B（`inner/standalone.json`）：prompt「inputs/src のプログラムを KX-200 用にクロスコンパイルして、機器（192.168.7.2）に入れて動かし、機器のログを logs/device.log に保存してください。アプリの名前は sensor です。」。基準：インストールの成功、静的リンクの実行、再起動の後の実行、目印（`status` は問わない）。
- golden は kxemu を1回動かして作る（決まった動きなので毎回同じ）。

#### C6d 試験の仕組み（`tests/dev-eval/runner/`）

| ファイル | 変えること |
| --- | --- |
| `isolation.mjs` | `makeSandboxOptions({ enabled, network, filesystem })`。`makeQueryOptions` に `sandboxNetwork`・`sandboxFilesystem`。`makeCanUseTool` に `denyNetwork`（`SandboxNetworkAccess` を断り、`refused` に残す） |
| `outer-change.mjs`（新） | `placeWorkspace(workDir, persona, personaDir)`：tar.gz（`tests/dev-eval/fixtures/<fixture>`）を展開 → `role:'repo'` のファイルを置く → `git init`、`user.name`・`user.email` をリポジトリの設定に、日時を `commitDate` に固定して全体をコミット → `staged` を追記して `git add` → `origin`（実行のフォルダの下のベアリポジトリ）。`takeBaseline(runDir, …)` → `change-baseline.json`（初めのコミット、対象とユーザーのスキルのファイルごとの sha256、対象の外のファイルの sha256、staged の一覧、元の knowledge.json・plugin.json の版、origin の refs）。`takeSnapshot(…)` → `{at, reason, head, status}`（`git status --porcelain -- <target> ':(exclude).plugin-creator-work'`）。`changeEnded({baseline, snapshot, approved, newPlugins})` → `'changed' \| 'changed_without_approval' \| 'generated_new_folder' \| null` |
| `outer-run.mjs` | `persona.kind === 'change'` のとき：`placePersonaFiles` の後に `placeWorkspace`、`takeBaseline`（続きから始めるときは置き直さない）。対象は今のまま「始める前からあるプラグイン」に入る（新しいフォルダの見分けに使い、生成プラグインの探し方は変えない）。スナップショットを問いに答える直前・記録のツールのたび・手番の終わりに取る（記録の item `repo.snapshot`）。手番の終わりに `changeEnded`。終わったら対象で `runGeneratedStages`。`record.change = { baseCommit, headCommit, commits, diffFiles, stagedBefore, stagedAfter, versionBefore, versionAfter, knowledgeBefore, knowledgeAfter, removedAfter, snapshots }` |
| `outer-grade-change.mjs`（新） | `gradeChange({ persona, record, state, items, toolEvents, stages, repo })`：7.3 の観点。純粋な関数（ファイルの読み取りは呼ぶ側） |
| `outer.mjs` | 改善の模擬ユーザーの採点を `gradeChange` に回す。`COST_GUIDE_USD` を実測（作る流れ 外側 約7、改善 約15〔推定〕、内側 約2）に直す |
| `inner-run.mjs`・`inner-adapter.mjs`・`inner.mjs`・`outer-inner.mjs` | `device`（`persona.device === 'kx200'` で `startDevice`）を腕ごとに起動し、`envExtra` に `PATH=<binDir>:<PATH>` と `dev.env`、query（統括の query も）に `sandboxNetwork`・`sandboxFilesystem`、`denyNetwork:true`。採点の前に `copyRecordsTo(workDir)`、`finally` で止める。`result.json` に `device` と `networkRefused`。腕 `standalone`：プラグインを読み込むが、つなぎ口と画面を使わない。課題は `inner/standalone.json`。メインの手番が終わったら採点。`<name>_open` を呼んだか・統括が始まったかを `result.json` に残す。`--arms with,without,standalone` |
| `personas/FORMAT.md`・`validate.mjs`・`validate.test.mjs` | C6c の項目 |

試験（2段目。実際のモデルを呼ばない）：`outer-change.test.mjs`（作業フォルダの形、同じ番号の初めのコミット、staged、origin、スナップショット、終わりの見分け）、`outer-grade-change.test.mjs`（観点ごとに合格・不合格の作り例）、`isolation.test.mjs`（sandbox の network・filesystem、`denyNetwork`）、`inner-run.test.mjs`（device の起動・止め・記録の写し、standalone の腕。偽の SDK）、`inner-e2e.test.mjs`（偽の API で、統括の最初の指示にプラグインのフォルダがある。D3）。

---

## 6. 実行の順番と並列の分け方

### 6.1 固定する取り決め（実装者は変えない。変えたいときは統括に知らせる）

| # | 取り決め | 書く側 → 読む側 |
| --- | --- | --- |
| I1 | 記録の形（4.1） | C1 → C2・C4・C6 |
| I2 | 子コマンドの引数・返す形・終了コード（5章 C2）。ファイルの場所はすべて P からの相対の POSIX パス | C2 → C4 |
| I3 | `tests/knowledge-removed.json`（4.3） | C2 → C1・C3 |
| I4 | C 番号の決まり（4.4） | C1 → C2 |
| I5 | `bin`・`agent_ran`（4.6、D30・D33） | C3 → C4（作業エージェントへの頼み）・C6（採点 `tests-added`） |
| I11 | 生成プラグインの見分け方（D29） | C1・C2 が同じ決め方を書く |
| I6 | 最初の指示の `## プラグインのフォルダ`、エージェントの `<プラグインのフォルダ>`（C3） | C3 → C4・C6 |
| I7 | `plugin-creator_change` の引数と返り値、状態取得の4行、差し込みの文（C1） | C1 → C4・C6（採点） |
| I8 | タグの名前（D9、`tag_name`） | C2 → C4（improve.md）・C6 |
| I9 | 模擬ユーザーの `persona.json` の項目（C6c） | C6c → C6d |
| I10 | `startDevice` の返す形（C6a） | C6a → C6d |

### 6.2 並列の組（ファイルが重ならない）

| 組 | 担当のファイル | 先に要るもの |
| --- | --- | --- |
| C1 | `com.github.copilot/extensions/plugin-creator/**`、`tests/creator/extension/**` | なし |
| C2 | `skills/make-plugin/scripts/scaffold.py`、`tests/creator/scaffold/**` | なし（本物の題材の試験は統合で） |
| C3 | `template/**`、`tests/creator/stage1/**`、`skills/test-plugin/scripts/**`、`tests/creator/test-plugin/**`、`com.github.copilot/agents/**` | なし |
| C4 | `skills/change-plugin/**`、`skills/make-plugin/SKILL.md`、`skills/make-plugin/references/{start,improve}.md`、`skills/test-plugin/SKILL.md`、`README.md`、`plugin.json`、`.github/plugin/marketplace.json`、`tests/creator/check_creator.py`、`tests/creator/test_check_creator.py`、`tests/dev-eval/trigger/**` | なし（I2・I6・I7 を文で使う） |
| C5 | `docs/design/*.md` | この設計図 |
| C6 | `tests/dev-eval/**`（`trigger/` を除く） | なし |

- `docs/specs/`、`docs/constitution/`、`.claude/memory/`、`wip/` は、どの組も変えない（統括が扱う）。

### 6.3 統合の順

1. C3 → C1 → C2 → C4 → C6 → C5 の順にまとめ、まとめるたびに `python3 tests/creator/run.py` を合格させる（C2 の本物のひな形の試験は C3 の後に通る）。
2. 統合の試験：C2 の本物の題材の試験（`market.tar.gz` が入った後）。
3. 7.2 の1段目・2段目がすべて合格してから、7.3 の EVAL に進む。

---

## 7. 試験の計画

### 7.1 動かす前の道具（容器を作り直したら入れ直す）

`apt-get install -y qemu-user gcc-arm-linux-gnueabihf libc6-dev-armhf-cross bubblewrap socat`、`pip install tiktoken`（と o200k_base の取得）、`cd tests/dev-eval && npm install --ignore-scripts`。

Playwright 1.56.1 の Chromium 1194：試験の仕組みは生成プラグインの1・2段目を `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` で動かす（`outer-run.mjs:146`）が、この容器の `/opt/pw-browsers` には 1243 番しかない（確かめた）。このままだと外側の EVAL の `stage2` が環境のせいで落ちるので、次で入れる。

```
cd tests/dev-eval && PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npx playwright install chromium chromium-headless-shell
```

入れた後に、同じ `PLAYWRIGHT_BROWSERS_PATH` で Chromium を1回起動して確かめてから、7.3 に進む。取れないときは、ナレッジ cloud-long-runs の対処（シンボリックリンク）を試し、それでも動かなければ、`stage2` の画面の試験の不合格を環境の不足として報告に分けて書く。

最初に Haiku で1手番だけ呼び、実際のモデルの呼び出しが通るかを確かめる（critic U1）。

### 7.2 1段目・2段目

| 何 | コマンド | 合格 |
| --- | --- | --- |
| クリエイターのすべて | `python3 tests/creator/run.py` | すべて合格（qemu などがない試験は「飛ばした」と出る） |
| ひな形の2段目 | `node --test template/tests/stage2/core/*.test.mjs template/tests/stage2/adapter/*.test.mjs` | すべて合格 |
| 擬似の機器 | `node --test tests/dev-eval/device/kxdevice.test.mjs` | 16項目 |

### 7.3 EVAL（実際のモデル。長い実行は `setsid nohup` で切り離す）

| 順 | 何 | コマンド（例） | 見込み | 合格 |
| --- | --- | --- | --- | --- |
| 1 | 新しい模擬ユーザーのユーザー役の試験 | `node tests/dev-eval/runner/user-role-test.mjs tests/dev-eval/personas/edl-change` | 約0.15ドル | すべて合格 |
| 2 | 呼ばれ方 | `node tests/dev-eval/trigger/trigger.mjs` | 約2ドル・10分 | 8件すべてが期待どおり（「作り直したい」は make-plugin か change-plugin のどちらでもよい） |
| 3 | 外側の EVAL（改善） | `node tests/dev-eval/runner/outer.mjs --persona tests/dev-eval/personas/edl-change --arms with --models claude-opus-5-5 --runs 1 --out <結果>` | 45〜90分・10〜20ドル（推定） | 下の観点がすべて合格 |
| 4 | 確かめ A | `node tests/dev-eval/runner/inner.mjs --plugin <3の作業フォルダ>/market/plugins/embedded-debug-loop --persona tests/dev-eval/personas/edl-change --arms with,without --runs 1` | 20〜40分・1〜4ドル | with の点数が 1（基準すべて合格） |
| 5 | 確かめ B | 同じに `--arms standalone` | 5〜10分・0.3〜1ドル | 基準すべて合格、`<name>_open` を呼ばず統括が始まらない |
| 6 | 作る流れの取り直し（ひな形と作業エージェントの決まりを変えたため） | `node tests/dev-eval/runner/outer.mjs --persona tests/dev-eval/personas/weekly-report --arms with --models claude-opus-5-5 --runs 1` | 30分・約7ドル | 今の合格の決まり（testing.md 6.5）のまま |

外側の EVAL（改善）の観点（`gradeChange`）。すべて必須（D36）：

| 観点 | 要件 | 見るもの |
| --- | --- | --- |
| `change-skill-used` | 052 | 記録の skills に change-plugin。make-plugin を始めていない |
| `no-new-folder` | 052・059 | 新しいプラグインのフォルダがない |
| `unchanged-before-approval` | 057 | 承認（progress で「生成」）より前のスナップショットで、HEAD が初めのまま、対象の status が空 |
| `confirm-contents` | 057・061 | 承認の問いとその前の文に、新しい版、土台、擬似の機器、課題の言葉。`confirmation.rebuild` の keep と change が空でない |
| `version-approved` | 057 | 対象の `plugin.json` の version ＝ `confirmation.version` ＞ 0.1.0 |
| `rules-list-once` | 054 | 1つの問い（問いと、その前の文）に、`carried` の番号がすべて出る |
| `rule-replaced` | 054・058 | `expect.replaced`（K-15）が knowledge-removed.json のほかのどのファイルにもない。knowledge-removed.json の K-15 の `replacedBy` が knowledge.json にあり、`carriedMax` より大きい |
| `ids-kept` | 058 | 引き継いだ番号の文が前と同じ。新しい番号はすべて `carriedMax` より大きい。外した番号を使っていない |
| `added-rule-confirmed` | 054 | 書き足した決まりが確認の問いに出て、knowledge.json に入った |
| `embedded:*`・`not-embedded:*` | 055 | 初めのコミットから HEAD の差分の足した行で、rule・exception は入り、incidental・wrong は入らない |
| `skill-names-differ` | 055 | 対象の `skills/*/SKILL.md` の name が `cross-compile`・`deploy` と重ならない |
| `user-skills-unchanged` | 055 | ユーザーのスキルの sha256 が同じ |
| `assets-reused` | 055・062 | `mkkximg.py` と同じ中身のファイルが、対象の `skills/*/scripts/` にある |
| `unchanged-items` | 056 | 記録に「変えないので聞かない」の項目がある。画面の3項目がそれ |
| `no-screen-questions` | 056 | `expect.screenAsked` に当たる問いがない |
| `last-time-asked` | 056 | `expect.lastTimeAsked` に当たる問いがある |
| `stage1`・`stage2` | 059・061・062 | 対象の `tests/run.py --json`（`standalone` の検査、擬似の機器のスクリプトの試験〔D34〕を含む） |
| `tests-added` | 061 | 引き継いだ課題のほかに課題があり、`bin`（`inputs/bin`）があり、その下に `expect.deviceTool`（kxtool）、`device-history.log` を見る program の基準がある。設定に本物の IP（`192.168.7.2`）を書いていてもよい（差し替えが受ける） |
| `commit-scoped` | 059 | 初めのコミットの次のコミットが1つ（試験の直しを含めて1つ）、差分はすべて対象の中、README.md は staged のまま、対象の status が空、タグ `plugin-creator-generated-embedded-debug-loop` が HEAD |
| `nothing-outside` | 059・021 | 対象の外のファイルが同じ（`.claude/.cc-writes/` を除く。`.plugin-creator-work/` は残っていない） |
| `not-pushed` | 059 | origin の refs が同じ。`git push` を呼んでいない |
| `explained` | 060 | コミットの後の文に `expect.explained` がすべて当たる |
| `main-model`・`worker-model` | 045・046 | 今と同じ（作る流れの観点の関数を使う） |

- 費用の目安：1回りで約25〜35ドル、時間は約3〜4時間。上限は2回り（約70ドル。D36）。
- 外側の EVAL と内側の確かめは分けて動かす（ユーザー役の形には続きからがないため）。

### 7.4 落ちたとき

1. 記録（`record.json`、`result.json`、会話）で、原因を3つに分ける：クリエイター（スキル・エクステンション・組み立て・ひな形）、試験の仕組み（採点・作業フォルダ・機器）、模擬ユーザー（ナレッジの書き方・ユーザー役）。
2. 試験の仕組みと模擬ユーザーの誤りは直して、その段だけ回し直す。クリエイターの誤りは直して、1段目・2段目を通してから回し直す。
3. 同じ観点で2回落ちたら止め、残った不合格と理由を報告に書く。
4. D23 の共有（make-plugin の4節を読む）が崩れたとき（4節を読まない、make-plugin の流れを始める）は、A2（本文に写す）に切り替える。

---

## 8. 危険と対策、残る点

### 8.1 危険と対策

| # | 危険 | 対策 |
| --- | --- | --- |
| R1 | エージェントがルールのスキルを読めない（critic M5・U3〜U5） | D3：最初の指示にプラグインのフォルダ、決まった文で絶対パスを読む。2段目（ひな形の core の試験、偽の API の inner-e2e）と確かめ A・B で確かめる。本物の Copilot CLI でインストールした写しを読むときの確認は最終確認に残す |
| R2 | 土台を上げてユーザーの直しが黙って消える（M2・M3） | D4・D13：`extract` の差分を確認で示す。重なる機能は残して示す。`change-guard` で試験の直しを止める（D19） |
| R3 | 生成プラグインの EVAL で本物の機器に送る（M1） | D12・D33：`bin` の差し替え（場所は `inputs/bin` だけ、記録はスクリプトの場所から、Windows と絶対パスの道具では機器に送る課題を作らない・動かさない）。確認で試せないことを示す。差し替えのスクリプトは生成プラグインの2段目で動かす（D34） |
| R4 | 範囲が広がりすぎる | 1.2 の入れないもの。D25。外側の EVAL は1つの頼み |
| R5 | 確認の番号とできあがりの番号が違う（C4・C7・C8） | D14・D15：C 番号はエクステンションが付けて記録し、組み立ては確かめるだけ。K 番号は2つのファイルの最大。引き継ぐ課題の入力は provisional |
| R6 | 開発の試験が本物の Copilot CLI を表さない（U8） | 名前の重なり（承認の前と後。D35）・番号・フォルダの確かめはスクリプトで守る。記録の漏れで名前の重なりが素通りしないよう、スキルのフォルダを資産に記録させ、漏れを断る（D28）。試せなかったことを報告に分けて書き、最終確認に足す |
| R7 | make-plugin（作る流れ）を壊す | make-plugin の本文は変えない。作る流れの外側の EVAL を1回取り直す（7.3 の6） |
| R8 | 承認の前に直すフォルダが変わる（C13） | D8：`.plugin-creator-work/` を確かめ・コミット・1段目の検査（D22）・採点から除き、ひな形の `.gitignore` に足す。`extract` は `<W>` にだけ書く。仕様の文（REQ-057・059）は統括に直しを頼む（8.2） |
| R9 | 確認の関門が、言っていない合否の決め方を作らせる（C9） | D17：関門は「新しい課題が1つ以上」。基準は引き継いだ決まりでもよい |
| R10 | EVAL の時間・費用・止まり（U10） | 外側と内側を分ける。切り離して動かす。2回りで止める |
| R11 | 新しい検査が、すでに配った生成プラグインを落とす（U7） | 直すときは `extract` が下見に1段目を当て、落ちるところを確認で示して直す。作る流れでは作業エージェントの決まりで守る |

### 8.2 統括に頼む仕様の直し（この設計図では仕様を変えない。6.2）

| 仕様 | 合わないところ | 頼む直し |
| --- | --- | --- |
| REQ-057 の受け入れ基準「ユーザーがよいと答えるまで、元のプラグインのフォルダは変わらない」、REQ-059 の要件と受け入れ基準「元のプラグインのフォルダの外のファイルは、作ったり変えたりしない（ヒアリングの記録と試験の道具を除く）」 | D8 の作業用の一時フォルダ `<作業フォルダ>/.plugin-creator-work/` は、起動したフォルダが P と同じときは P の中に、承認の前（`extract`）にできる。外側のときは P の外にできる（critic C13） | REQ-057 と REQ-059 の除くものに「作業用の一時フォルダ（終わったら消す）」を足す |
| REQ-062 の要件「スキルは…統括エージェントやWeb管理画面がなくても動く」と受け入れ基準2つ目 | 入口のスキル（`<name>_open` を呼ぶもの）は統括を始めるのが仕事なので満たせない。D10・D22 で外したが、仕様に除外がない（critic M6） | 要件と受け入れ基準に「入口のスキル（統括エージェントを始めるスキル）を除く」を足す |

### 8.3 残る点（決めは 1.3 に移した）

| 点 | どうするか |
| --- | --- |
| U2 隣のスキル（make-plugin）を確認なしで読めるか | D23。最終確認に足す |
| U4 `${PLUGIN_ROOT}` がエージェントの本文で展開されない | D38 |
| U11 `COPILOT_CACHE_HOME` がどこを指すか | D39 |
| U12 make-plugin の本文の余り | D23 |
| U13 サンドボックスの中の `git tag -f` などの git の操作 | D40。外側の EVAL（改善）で確かめる |
| M4 引き継ぐ課題 T-01 が取り込んだ決まりと食い違う | D41 |
| C15 クリエイターの部品の結合（隣を読む）は、ユーザーの考え（疎結合）と逆向き | 決めではない。報告で理由（REQ-062 は生成プラグインの要件で仕様には反しない、同じ文を1か所に、make-plugin の本文の余り）を示す |
| 憲章 | 部品の独立性を第4章に足すかは、ユーザーに聞く（報告）。今回は仕様 REQ-062 だけ |
| クリエイターの版 | D37。版を上げるかは報告でユーザーに聞く |

---

## 9. 点検で直したこと

点検（忠実さ18項目、実現性14項目）を、仕様・決めたこと・ソースで確かめて直した。

### 9.1 直したこと

| 点検 | 直したこと |
| --- | --- |
| 忠実さ1 | 作業用の一時フォルダと REQ-057・059 の文の食い違いを、統括に頼む仕様の直しにした（8.2）。断る文のコマンドに `':(exclude).plugin-creator-work'` を付けた（C2） |
| 忠実さ2 | REQ-062 から入口のスキルを除く仕様の直しを、統括に頼む（8.2） |
| 忠実さ3 | 実行の記録を見る基準の種類 `agent_ran` を足した（D30。grade.mjs・run.mjs・1段目・eval-parity・作業エージェントの決まり・試験） |
| 忠実さ4・実現性2 | 作業の定義の案・manifest.json・差し込み口を書く役を決めた（D31。3章・4.7・C3・C4、作っていないプラグインと作業エージェントを足す `change` の試験） |
| 忠実さ5 | 元に課題がないときの作業全体の課題を足した（D32。4.6・C4・record-tools の例） |
| 忠実さ6 | 試験の道具が足りないときは make-plugin の `generate.md` の4の2を使う（3章・C4）。2章に REQ-048 の行 |
| 忠実さ7 | 「例と例外だけの直しは番号を変えない」をやめ、例・例外の直しも新しい番号にした（4.2。REQ-058・決定17） |
| 忠実さ8 | 引き継ぐ課題は直す案だけにし、外すのはユーザーが自分から頼んだときだけにした（4.6、D41） |
| 忠実さ9 | 作っていないプラグインでは「変えないので聞かない」をどの項目でも断る（4.1・3章） |
| 忠実さ10 | `extract` の結果と試せない本物の手順を `rebuild.change` に必ず入れ、画面に出ることを `screen.test.mjs` で試す（3章・C1・C4） |
| 忠実さ11 | 作業エージェントの決まりで、すべてのスクリプトを S7 にし、`--help` と誤った引数の終了コードを試す（C3） |
| 忠実さ12 | 外側の EVAL の観点をすべて必須にし、`rules-list-once` を「すべての番号」にした（D36、7.3） |
| 忠実さ13 | 1.2 に、機能を消す頼み・作業エージェントを足す頼み・組み方の基準・課題のない元のプラグインを足した。「2段目で守る」は REQ-053 と作っていないプラグインだけに直し、受け付けない頼みと「作り直したい」は試さないと書いた。REQ-061 の壊す試験の理由を「この容器に Copilot CLI がない」に直した |
| 忠実さ14 | 名前の重なりを承認の前の `extract --hearing` でも確かめ、P の中のスキルを断ることを決めにした（D35） |
| 忠実さ15 | 2章に REQ-018・019、026・027、038・041、045・046、048 の行を足した。段階「資産と公開のプラグイン」に標準機能と公開のプラグインを調べることを足した |
| 忠実さ16 | クリエイターの版は 0.1.0 のままと決めた（D37） |
| 忠実さ17 | 題材 `market.tar.gz` を D2 のとおり `tests/dev-eval/fixtures/` に移した。ダミーのスキルは D2 の `personas/` のまま（D24 に理由） |
| 忠実さ18 | D 番号のない決めを 1.3 に移した（版の比べ方は D16、必須の観点と費用は D36、U4・U11・U12・U13・M4 は D38・D39・D23・D40・D41）。`plugin-data` の中を断ることはやめた（D39）。8章の「ここで決めたこと」をなくした |
| 実現性1 | 1段目の、フォルダ全体を歩く検査で `.plugin-creator-work` を飛ばす（D22、C3）。作業フォルダが P と同じときの統合の試験を足した（C2） |
| 実現性3 | 生成プラグインの見分け方を1つにした（D29、I11）。`change` で記録と `extract.json` の食い違いを断る |
| 実現性4 | `bin` は `inputs/bin` だけ、記録はスクリプトの場所から、Windows は断る、絶対パスの道具は機器に送る課題にしない（D33） |
| 実現性5（一部） | 擬似の機器のスクリプトに生成プラグインの2段目の試験を書かせ、外側の EVAL の `stage2` で動かす（D34） |
| 実現性6 | 7.1 に Chromium 1194 を `/opt/pw-browsers` に入れるコマンドと、起動して確かめる手順を書いた |
| 実現性7 | 本物の題材の試験の準備に、K-15 の5か所の付け替えと、足した決まりの番号をルールのスキルに書くことを足した（C2） |
| 実現性8 | ファイルの場所はすべて P からの相対の POSIX パスと決め（I2・C2）、`change-guard` は `--show-prefix` を外して比べる |
| 実現性9 | 取り込んだ行に `itemName` を足し、4.2 の①で O の `item` と S の `itemName` を比べる |
| 実現性10 | `standalone` は `kind == "generated"` のときだけと書いた（D22・C3） |
| 実現性11 | 示されたスキルのフォルダを資産に記録させ、記録の漏れを `extract`・`change` が断る（D28、C4 `change-read.md`） |
| 実現性12（一部） | `change-check` の⑤の、ひな形の `.gitignore` との比べ方を決めた（C2）。試験を足した |
| 実現性13 | 続きの決め方の「4.8」を「C2 のタグの名前」に直し、タグのないときの続け方を足した（3章、D40） |
| 実現性14 | `sample/sensor.c` を C6a に足し、`mkkximg.py` は C6b のものを使うと書いた |

### 9.2 退けたこと

| 点検 | 退けた理由 |
| --- | --- |
| 実現性5 の `bin-works`（試験の仕組みが、足した課題の擬似の機器と基準を正しい手順・誤った手順で動かす観点） | 正しい手順にはアプリの名前など課題ごとの値が要り、決まったスクリプトでは確かに流せない。誤った手順だけでは、成果物がないことで基準が落ちるので確かめにならない（D34、憲章 第10条） |
| 実現性12 の直し方（外されたファイルは注意に出すだけにし、P とマニフェストのときだけ断る） | 描き直しで P の `.gitignore` がひな形のものに替わるので、外されていたファイル（例：`dist/`）がコミットに入ったり、`change-guard --restore` で消えたりする。REQ-053「フォルダのファイルが git で管理されている」の文にも合う今の断り方を残した |
