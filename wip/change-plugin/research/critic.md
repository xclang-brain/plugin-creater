# 調査の点検：change-plugin の設計の前に（completeness critic、2026-10-26）

段階2の調査メモ6本（`research/extension.md`、`scaffold.md`、`skillflow.md`、`dev-eval.md`、`skill-spec.md`、`emulator.md`）を突き合わせ、設計（段階3）に入る前に片付けるべきことをまとめた。憲章・仕様書・設計書・実装資産のどれでもない。リポジトリのファイルは、このメモのほかは変えていない。

前提として読んだもの：仕様 `docs/specs/improvement-requirements.md`（REQ-052〜061）、`docs/specs/output-requirements.md:261-271`（REQ-062）、`wip/change-plugin/decisions.md`、`RESUME.md`、憲章 0.26.0。`research-current-state.md` は、各メモが引いている箇所だけを頼りにし、通読していない。

裏付けのために、このメモで新たに確かめたこと（読むだけ）：

- embedded-debug-loop の `tests/knowledge.json`（K-01〜K-17）、`tests/eval/T-01/`、エージェントの定義、`.github/plugin/marketplace.json`。
- エクステンションの基準の番号の付け方（`ext/creator.mjs:86`、`:235`、`ext/sample.mjs:20`）と、`scaffold.py:239-248`。
- ひな形の `.gitignore`（`.plugin-creator-work/` が入っていない）。
- test-plugin の EVAL の実行に、課題ごとの前準備や環境変数の口がないこと（`skills/test-plugin/scripts/` を検索。`permissions.mjs:8, 121-122` は環境変数の求めを拒む）。
- 試作の差分 `research-scratch/proto-out/*.diff`（統括の差分は土台の文だけだった）。
- embedded-debug-loop の土台のファイルと、クリエイターの git の履歴のひな形の照合（3章の M2）。

---

## 0. 結論（先に）

1. **擬似の機器の形が3通りに割れている**（skill-spec の KF-7・生の TCP、emulator の KX-200・`kxtool`、dev-eval の `scp`・`ssh` の差し替え）。サンドボックスの中から通しで動くと実測したのは emulator の形だけである。skill-spec のダミーのデプロイのスキル（生の TCP 6123/6124 に直接つなぐスクリプト）は、サンドボックスの中から届かない。**emulator の形に決め、ダミーのスキルを KX-200 に書き直す**のがよい（1章 C1）。
2. ほかにも、メモの間で食い違う決めが8つある（外した番号の置き場所、記録の形、REQ-053 の確かめの置き場所、合否の基準の番号、引き継ぐ課題の入力の渡し方、変えたところの課題の関門、git の見張りの戻し先、ダミーのスキルの名前と置き場所）。どれも設計で1つに決めないと、エクステンションと組み立てが別のことをする（1章）。
3. 設計の前に足りない調査は、重い順に次の4つである（3章）。
   - **生成プラグイン自身の EVAL（test-plugin）で、擬似の機器をどう用意するか**。今の test-plugin には、課題ごとに機器を起動する口も、PATH を差し替える口もない。REQ-061 の受け入れ基準（本物の機器に何も送られない、壊すと不合格）を満たす道がまだない（M1）。
   - **土台を上げるときに、差し込み口の外にユーザーが書いた直しを失わないか**。描き直しは差し込み口の外を黙って上書きする。生成プラグインは、どの版のひな形で作ったかを記録していない。ただし、クリエイターの git の履歴と照合すれば、ファイルごとに「どの版のひな形のままか」を見分けられることを確かめた（M2）。
   - **作業・検証・統括のエージェントが、ルールのスキルとスクリプトの場所を知る手段**。REQ-055「その作業をするエージェントがそのスキルに従う」の前提で、今はない。土台（すべての生成プラグイン）を変えることになる（M5）。
   - **土台を上げると、embedded-debug-loop の K-17（`scripts/apply_agent_settings.py` と設定 `effort_*`）が、新しい土台の「思考の深さ」と重なる**。消すのは頼まれたときだけ（決定15）なので、どう扱うかの決めが仕様にない（M3）。
4. いちばん大きな設計の危険は、変更の範囲が広がりすぎること（エクステンション、組み立て、構造の検査、ひな形の土台、make-plugin、test-plugin、開発の試験、模擬ユーザー、ダミーのスキル、擬似の機器）である。憲章 第10条（KISS）に照らして、REQ-062 と M1・M5 のどこまでを今回に入れるかを先に決める（4章 R4）。

---

## 1. メモの間の食い違い

| # | 点 | A の言い分 | B の言い分 | 勧める決め |
| --- | --- | --- | --- | --- |
| C1 | 擬似の機器の形 | skill-spec 4.2〜4.5：架空の KF-7。ローダー TCP 6123・コンソール TCP 6124 に、ダミーのスキルのスクリプト（`kf7-push.py`、`kf7-console.py`）が直接つなぐ。イメージ `.kfi`（magic `KF7I`、版2バイト・見出しの大きさ2バイト、CRC は埋めた後の列で計算）、`kfctl`、`kfrun`、`[kfrun] exit=N`、`KF7 READY`、量産機の印 `KF7-P` | emulator.md 0章・3章：架空の KX-200。機器への道具は PATH の先頭の `kxtool`（試験ではサンドボックスのプロキシを明示した HTTP）。`.kximg`（magic `KX2I`、`<4sIII16s>`）、`kxinstall`、`kxapp run`、`[kxapp] <名前> exited (status=N)`、再起動で有効。dev-eval.md 3.3：`scp`・`ssh` の差し替え、`/put`・`/exec`、`/etc/init.d/<名前> stop\|start` | **emulator の形**。理由：サンドボックスの中から直接の TCP は届かない（dev-eval.md 3.1 の表、emulator.md 2.3 の3番）。skill-spec 4.8 の最後の「つなげないときは Unix ソケットに切り替える」案も、seccomp で断られる（dev-eval.md 3.1 の表の1行目）。emulator の形だけが、ビルドからログまでサンドボックスの中で通しで動いた（emulator.md 4.4）。skill-spec の S1〜S9（1.8）と U1〜U8（3.1）と「隠れた決まり」の作り方（4.6・4.7）は残し、中身を KX-200 に置き換える。KF-7 にしかない決まり（D6 量産機、D4 の `crc=` の照合）を残すなら、kxemu に足す必要がある |
| C2 | ダミーのスキルの名前と置き場所 | skill-spec 4.1・4.8：`cross-compile`・`deploy`、`<起動フォルダ>/kf7-firmware/.github/skills/` | dev-eval.md 2.2：`xc-build`・`board-deploy`、`work/my-tools/skills/`。emulator.md 3.5：`kx200-build`・`kx200-deploy` | 名前は1組に決める。REQ-055 の名前の決まりを試したいなら、skill-spec の「ありがちな短い名前」の考えがよい。置き場所は、開発の試験（Claude Code、`settingSources: []`、`isolation.mjs:166-168`）ではどちらでも自動で読まれないので差がない。本物の Copilot CLI でも、起動フォルダの下のフォルダの `.github/skills/` は読まれない（読まれるのは起動フォルダとその親。skill-spec 2.1）。dev-eval の `work/<名前>/` に、ユーザーのファームウェアのリポジトリらしい形で置けば両方を満たす |
| C3 | サンドボックスの通信の開け方 | dev-eval.md 3.3：`allowedDomains: ['localhost']` と、`canUseTool` で `SandboxNetworkAccess` を断る | emulator.md 2.3・2.4：`allowedDomains: ['localhost:<HTTP>']` と `strictAllowlist: true`、`filesystem.denyRead`・`denyWrite` に機器の中身 | **emulator の形**。`localhost` だけだと、偽の API や生成プラグインの画面を含むホストのすべてのポートが開く（emulator.md 3.6 の表、公式の引用は 2.1）。ただし、外側の EVAL（クリエイター）にも `strictAllowlist` を入れるかは別に決める（試験の道具の取得などで外への通信が要りうる。dev-eval.md 3.3 の最後） |
| C4 | 外した番号の置き場所（REQ-058） | extension.md 3.9：`tests/knowledge-retired.json` などの別のファイル | scaffold.md 4.5・7.1：案A（勧め）`tests/knowledge.json` の中に `"removed": true`（`"replacedBy"`）。案B は別のファイル | どちらかに決める。案A なら、knowledge.json を読む側をすべて直す。読む側は `names.mjs`、`skills/make-plugin/references/improve.md`、`scaffold.py`、`tests/dev-eval/runner/outer-grade.mjs`（と試験）、`control-creator.test.mjs`、`tests/creator/scaffold/test_scaffold.py`、`tests/creator/stage1/test_check_structure.py`、`template/tests/stage1/check_structure.py`、`template/docs/design/design.md`、`docs/design/testing.md`（grep で確かめた）。エクステンションの取り込み（extension.md 3.2-6）は、`removed` の行を候補にしないこと。既に配った生成プラグインの1段目は `removed` を知らないので、取り込みで落ちる。案B は読む側を変えずに済む（KISS） |
| C5 | 記録に持つ「直す」の情報 | extension.md 3.1：`state.change{folder, manifest, name, version, generated, wants[], startedAt}`、`confirmation.version`、引き継ぐこと・変わることは `rebuild{keep, change}` を流用。取り込むスキルは資産（場所つき）として記録（3.6） | scaffold.md 4.4：`confirmation.change{plugin, version, importedSkills[], deleteFiles[]}` を組み立てが読む | 1つの形に決める。組み立ては、名前の重なり（REQ-055）と、示したスキルが変わっていないことの確かめに、取り込んだスキルのフォルダの一覧が要る。資産の `location` から拾うなら、資産のうち「スキル」を見分ける印が要る。消すファイル（`deleteFiles`）は、作っていないプラグインのときだけ要る |
| C6 | REQ-053 の確かめの置き場所 | extension.md 3.2 の最後・3.4：`skills/change-plugin/scripts/` のスクリプト | scaffold.md 4.1：`scaffold.py change-check`（make-plugin のスクリプト） | どちらでも中身は同じ。「直し始める直前」にも同じ確かめを `change` の中で行う（scaffold.md 4.4-2）なら、`scaffold.py` に置くほうが2か所に書かずに済む。change-plugin は隣のスキルのスクリプトを動かすことになるが、前例がある（make-plugin が `../test-plugin/scripts/check_tools.py` を動かす。skillflow.md 1.3） |
| C7 | 合否の基準の番号（C-xx） | extension.md 3.9 の危険 (b)：引き継いだ合否の決め方を付け直すと C 番号がずれるので、既存の eval.json を作り直す | scaffold.md 4.5-6：引き継いだ基準は元の task.json の C 番号をそのまま使い、足したものは続きから振る。`make_criteria`（`scaffold.py:239-248`）は change では使わない | scaffold の案にするなら、**エクステンションも同じ付け方にしないと、確認の画面と見本の C 番号が、できあがる task.json と食い違う**。今のエクステンションは、確認で示す決まりの番号の小さい順に C-01 から振る（`ext/creator.mjs:86`、`:235` の注釈「見本の基準の番号（C-01 から）と、生成のときに組み立てのスクリプトが付ける番号を、同じ並びにするため」、`ext/sample.mjs:20`）。embedded-debug-loop の T-01 の基準は C-02、C-01、C-03 の順で、C-01=K-07、C-02=K-13、C-03=K-14 |
| C8 | 引き継ぐ EVAL の課題の入力 | extension.md 3.12：直すフォルダの中の絶対パス（`tests/eval/T-01/inputs/...`）で渡せば、`realInputProblem`（`ext/creator.mjs:198-208`）を通る | scaffold.md 4.6：`provisional: true`（生成プラグインの中の場所）で渡す | **scaffold の案**。絶対パスで渡すと、組み立ては eval_inputs として写そうとするが、同じファイルを extract が parts/files にも入れるので、「eval_inputs と parts/files の同じ場所を断る」（scaffold.md 1章の 10、`scaffold.py:1127-1132`）に当たる |
| C9 | 「変えたところを試す課題」の関門（REQ-061、決定11） | extension.md 3.12：確認で、引き継いでいない合否の決め方の決まりを基準に持つ課題が1つ以上ないと断る | scaffold.md 4.6：確認の課題のうち、元の eval.json と頼むときの言葉が違うものが1つ以上ないと断る | 2つの関門は別のものを見ている。extension の案は、機能を消すだけ・エージェントの組み方を変えるだけの変更でも、新しい合否の決め方の決まりを足させる。ユーザーが言っていない決まりをモデルが作るおそれがある（ナレッジ `rebuild-weaknesses.md:18`、`knowledge-elicitation.md:26-30`）。関門は1つにし、「新しい課題が1つ以上」にするのがよい。基準は、引き継いだ合否の決め方を使ってもよいことにする |
| C10 | 差し込み口の文を取り出せるか | skillflow.md 0章の7・5.4：統括の差し込み口は、前の文（60字）が見つからず取れない。見出しで区切るべき | scaffold.md 0章の3・4.3：前後の空でない1行を目印にすると、10個すべて取れ、描き直しの差分は土台の変更だけ | **scaffold の方法**。試作の統括の差分（`research-scratch/proto-out/com.github.copilot__agents__orchestrator.agent.md.diff`、73行）を読むと、変わったのは「人の判断を求めるとき」など土台の文だけで、差し込み口の文は失われていない。skillflow の失敗は、照合の文の取り方（60字）による |
| C11 | タグの名前 | skillflow.md 6章：`plugin-creator-generated/<名前>` を検討 | scaffold.md 4.8：同じリポジトリに `plugin-creator-generated` があると `<名前>` 付きは作れない（実測：`cannot lock ref`）。`plugin-creator-generated-<名前>` を勧める | **scaffold の案**。improve.md:10 の差分の見方も、タグの名前とフォルダで絞ることに合わせて直す |
| C12 | 作業エージェントが変えてはいけないファイルを変えたときの戻し方 | skillflow.md 4章の1：`git status --porcelain` で見て、確認で示した一覧の外が変わっていれば `git checkout -- <ファイル>` で戻す | scaffold.md 4.2・4.7：描き直しから試験の直しの後まで、コミットは1つ（直す前に戻せるようにするため） | そのまま組み合わせると壊れる。描き直しの後も HEAD は直す前のままなので、`git checkout -- <ファイル>` は、土台を上げたことや承認した変更まで元に戻す。戻し先は、描き直した直後の状態にする必要がある（例：描き直した直後に `git stash create` か `git write-tree` で作った木、または `.plugin-creator-work/` に置いたファイルごとのハッシュの一覧。どれもサンドボックスの中で動くかは確かめていない） |
| C13 | 作業用の一時フォルダと「承認まで元のフォルダは変わらない」 | extension.md 3.4 案1・scaffold.md 4.1-6・7.4：作業フォルダが直すフォルダと同じときは、`.plugin-creator-work/` を確かめとコミットから除き、最後に消す | 仕様 REQ-057 の受け入れ基準「ユーザーがよいと答えるまで、元のプラグインのフォルダは変わらない」（`improvement-requirements.md:120`）。dev-eval.md 2.6 の `unchanged-before-approval` は対象の `git status` が空であることを見る | 作業フォルダが直すフォルダと同じとき、承認の前（直す前の確認）に `draft/task.json` を書いた時点で、直すフォルダの中に git に入れていないフォルダができる。ひな形の `.gitignore` にも embedded-debug-loop の `.gitignore` にも `.plugin-creator-work/` はない（確かめた）。仕様の言い方（「フォルダの中身」に作業用の一時フォルダを含めない）を直すか、置き場所を変えるかを決める。REQ-059 の「フォルダの外に作らない」の除くもの（ヒアリングの記録、試験の道具）にも、作業用の一時フォルダが入っていない |
| C14 | 題材の写しの置き方 | dev-eval.md 2.2：embedded-debug-loop の写し（99ファイル、1.4MB）を `personas/<id>/fixtures/` に入れて固定する | 憲章 第10条2項「リポジトリを肥大化させない」 | 写しを入れるなら、量と理由を設計書に書く。代わりに、試験の仕組みが plugin-market-place の決まったコミット（`484584c`）から `git archive` で作る案もある（外のリポジトリが手元に要る） |
| C15 | クリエイター自身の部品の結合 | skillflow.md 1.5 の A1（勧め）：change-plugin の本文が `<make-plugin>/SKILL.md` の4節と references を読む | ユーザーの指示5（疎結合・単体で動く）と REQ-062 | REQ-062 は生成プラグインの要件なので、仕様には反しない。ただし、ユーザーの考え方とは逆向きで、本物の Copilot CLI で確認なしに読めるかも確かめていない（2章 U2）。報告で、そう選んだ理由を示す |
| C16 | 画面の変更を試すか | dev-eval.md 2.6：採点 `settings-added`（task.json に新しい設定の鍵がある） | 同じ表の `only-changed-asked`、仕様 REQ-056「Web管理画面を変えない改善・設計変更では、画面の質問がない」 | 模擬ユーザーの頼みに画面の変更を入れるかを先に決め、採点の観点をそれに合わせる。入れないなら `settings-added` は使わず、「画面の質問がない」を採点する |

---

## 2. 設計が頼るのに、確かめていない主張

| # | 主張 | 出どころ | 外れたときの影響 | 確かめ方 |
| --- | --- | --- | --- | --- |
| U1 | この容器から、実際のモデルの呼び出しが通る | dev-eval.md 0章の5・5章（`auth status` が `loggedIn: true` までで、呼んでいない） | 外側・内側の EVAL（段階7）がすべて動かない | 最初に Haiku で1手番だけ呼ぶ（数セント） |
| U2 | change-plugin が隣のスキル（make-plugin）の SKILL.md と references を、本物の Copilot CLI で確認なしに読める | skillflow.md 1.3・7章、skill-spec.md 2.5 | A1（共有）が使えず、本文に写す A2 に変える必要がある。make-plugin の本文の余りは 26 トークンしかない（skillflow.md 1.4） | 開発の試験（Claude Code）は `Read` を前もって許している（`isolation.mjs:115`）ので、確かめられない。最終確認の16に足して、ユーザーの環境で確かめる |
| U3 | 作業・検証のエージェントが、渡された絶対パスでルールのスキルとスクリプトを読み、動かせる。統括への最初の指示にプラグインの場所を入れれば足りる | scaffold.md 5.2 の最後、skill-spec.md 3.2 の案A | REQ-055「その作業をするエージェントがそのスキルに従う」を満たせない | 本物の Copilot CLI：インストールした写しのフォルダを読むときに確認が出るか（1.0.83 の更新履歴の範囲が不明）。開発の試験：つなぎ口は中心の処理に Copilot 向けの元の場所を渡し（`inner-adapter.mjs:564`）、統括ごとに写しを作る（`prepareRunPlugin` `:415`、`:494`）。指示に入る場所がどちらになるか、読めるかを、偽の API で確かめる |
| U4 | `${PLUGIN_ROOT}` はエージェントの本文では展開されない | skill-spec.md 1.6、`convert.py:259` | embedded-debug-loop の作業エージェントは `python3 ${PLUGIN_ROOT}/scripts/...` を使う（`worker.agent.md:45-46`、`worker-b.agent.md:47, 49`）。今も本物では動かない見込みで、土台を上げても直らない。直すと「確認で示した変更のほか」になる（REQ-057） | 公式の記述は stdio の MCP サーバーだけ。本物で確かめていない。直すかどうかを確認で示す変更に入れる |
| U5 | 統括・検証もルールのスキルを相対パスで読んでいる | このメモで確かめた：`orchestrator.agent.md:104`、`verifier.agent.md:41` | 場所の問題は作業エージェントだけでなく、統括と検証にもある。検証は「ルールどおりか」を判定する（K-07）ので、読めないと判定できない | U3 と同じ |
| U6 | 差し込み口の取り出しは、ほかの生成プラグインでも効く | scaffold.md 4.3（embedded-debug-loop の1つだけで試した） | 承認の後に初めて取り出しに失敗する（`rebuild-weaknesses.md:7-10`） | 手元の weekly-sales-report・coverity-warning-triage（同じリポジトリにある）でも試す。`change-preview` で承認の前に失敗を示す（scaffold.md 4.2） |
| U7 | 土台を上げた後も、1・2段目に通る | scaffold.md 2章（`--restore` と `tests/` の土台を入れ直して、1段目と adapter・core・task は合格） | 画面の試験（ui）は Playwright がなく動かしていない。新しく足す1段目の検査（REQ-058 の外した番号、REQ-062 の部品の独立性。scaffold.md 5章）には、embedded-debug-loop は今のままでは落ちる（上の U4・U5、`cross-compile-rules` の description が呼ぶ役の言い方） | 新しい検査を作ったら、描き直した embedded-debug-loop に当てて、落ちるものの一覧を確認で示す変更に入れる |
| U8 | 開発の試験の結果が、本物の Copilot CLI の振る舞いを表す | dev-eval.md 1.2（クリエイターを Claude Code に置き換えて動かす） | 名前の重なり（Copilot はプラグインのスキルを黙って無視、Claude Code は両方残す。skill-spec.md 2.1・2.2）、隣のフォルダを読む許可、`${PLUGIN_ROOT}`、スキルの呼ばれ方（日本語の description。skillflow.md 7章、H11）は、外側の EVAL が通っても確かめたことにならない | 報告で、試せなかったことに分けて書く。名前の重なりは、スクリプトの検査（事実で決まること）で守る |
| U9 | サンドボックスの設定（`allowedDomains`、`strictAllowlist`、`denyRead`）が、統括の query の中で動くサブエージェントのコマンドにも効く | dev-eval.md 7章（見込み） | 内側の EVAL で、作業エージェントが機器に届かないか、逆に機器の中身を書き換えられる | emulator の試作（`probe-sandbox-emu.mjs`）を、サブエージェントの Bash でも動かす |
| U10 | 改善の流れの外側の EVAL は 1回 45〜90分、10〜20ドル | dev-eval.md 4章（推定） | Bash の裏の実行は2時間で止まる（ナレッジ cloud-long-runs）。ユーザー役の形には `--resume` がない（`outer.mjs:133-135`）ので、止まると始めからやり直し | 外側の EVAL（`--inner` なし）と内側の EVAL を分けて、まず1回だけ測る（dev-eval.md 4章の最後） |
| U11 | インストールの写しの場所 | scaffold.md 4.1-3（公式の文書だけ）。`COPILOT_CACHE_HOME` が `copilot` のフォルダ自体を指すかは要確認 | REQ-053 の2つ目の確かめが漏れるか、誤って止まる | 実機の Copilot CLI で `copilot plugin install` して場所を見る（この容器では動かせなかった。skill-spec.md の冒頭） |
| U12 | make-plugin の本文は 4,974/5,000 トークン | skillflow.md 1.4（スクラッチの tiktoken で測った。`check_creator.py` は動かしていない） | make-plugin の本文に1行足すと1段目に落ちる | tiktoken を入れて `check_creator.py` を動かす（dev-eval.md 5章：この容器に tiktoken がない） |
| U13 | サンドボックスの中で、作る流れと同じく git の操作ができる | dev-eval.md 3.1（`git commit -- <フォルダ>` はできた。`.git/config` と `.git/hooks` には書けない） | `git tag -f`、`git stash create`・`write-tree`（C12）、`git checkout`・`git clean`（失敗したときの戻し。scaffold.md 4.4-8）は試していない | 偽の API の試しに足す |

---

## 3. 設計の前に足りない調査（具体的に）

### M1 生成プラグイン自身の EVAL で、擬似の機器をどう用意するか（REQ-061）

- 2種類の「擬似の機器」を分けて考える必要がある。メモはこの2つを混ぜている（dev-eval.md 2.6 の `tests-added`、emulator.md 7章の4つ目）。
  - (a) 開発の試験の内側の EVAL で、試験の仕組みが外で動かす kxemu。クリエイターの出来を測る道具で、ユーザーには渡らない。
  - (b) change-plugin が、直したプラグインのリポジトリに入れる EVAL の課題が使う擬似の機器。REQ-061 の要件そのもので、ユーザーの環境の test-plugin（Copilot SDK、OS のサンドボックスなし。`emulator.md` 1.3 の最後）で動く。
- (b) の今の状態：
  - test-plugin の EVAL には、課題ごとに前準備（機器の起動）をする口も、PATH を差し替える口もない（`skills/test-plugin/scripts/` を検索した。`permissions.mjs:121-122` は環境変数の求めを拒む）。課題の形は prompt・inputs・settings・criteria だけ（`template/tests/stage1/check_structure.py:874-928`）。
  - 入力のファイルは `shutil.copyfile` で写すので、スクリプトの実行の印が消える（scaffold.md 1章の注意、`scaffold.py:1203`）。
  - 取り込んだデプロイのルールが `kxtool -d <IP>` を使うと、ユーザーの PC では本物の `kxtool` が本物の機器に送る。「本物の機器に何も送られない」（REQ-061 の受け入れ基準）を、課題の書き方だけで守る道がない。
- 調べること：
  1. test-plugin の課題の実行（`tasks.mjs`、`eval.mjs`、`run.mjs`）に、課題ごとの「擬似の機器」（起動するコマンド、PATH の先頭に足すフォルダ、終わったら止める）を足すのに要る変更と、eval.json の形・1段目の検査の変更。
  2. 一般のユーザーの機器について、change-plugin がどの程度の擬似の機器を作るのか（KISS）。embedded-debug-loop の今の T-01 は「フォルダへのコピーと x86 の gcc」（`tests/eval/T-01/inputs/device.md`、`inputs/src/Makefile.target`）で、取り込む決まり（静的リンク、イメージの見出し、再起動で有効）を何も試せない。
  3. 「変えたところを壊したプラグインで EVAL を行うと、足した課題の基準が不合格になる」（REQ-061 の受け入れ基準）を、誰がどう確かめるか。開発の試験に、ルールのスキルを壊した写し（例：`-static` を消す、見出しの手順を消す）で生成プラグインの EVAL を回す段を足すか。費用も見積もる。

### M2 土台を上げるときに、差し込み口の外のユーザーの直しを失わないか

- 描き直しは、ひな形から作るファイル（エージェントの定義、入口のスキル、README、憲章・仕様書・設計書、土台、`tests/` の土台）の、差し込み口の外を黙って上書きする（scaffold.md 4.3・4.4-8）。REQ-057 の受け入れ基準「引き継ぐと示した部品は、確認で示した変更のほかは変わっていない」と、REQ-054 の「書き足された決まりを1件ずつ確かめる」に反するおそれがある。`change-preview` の差分では、土台を上げた差分とユーザーの直しが失われた差分が見分けられない。
- 生成プラグインは、どの版のひな形で作ったかを持っていない（憲章の由来の「plugin-creator 憲章 0.25.0」だけ。`template/docs/constitution.md:4, 106`）。
- このメモで確かめたこと：embedded-debug-loop の土台の26ファイルは、どれもクリエイターの履歴のどこかのひな形とバイトが同じだった。ただし1つのコミットにはそろわない（57ee4c2 で25ファイルが同じ、`core/github.mjs` だけは 33df334 と同じ。a194be1 では2ファイルが違う）。作っている途中の作業ツリーから組み立てたためと見られる。
- 調べること：
  1. ファイルごとに「履歴のどれかの版のひな形と同じか」を見る照合（土台と `tests/` の土台）。同じなら上書きしてよく、違えばユーザーの直しとして確認で示す。
  2. 差し込み口のあるファイルは、取り出した差し込み口で昔の版のひな形を描き、元のファイルと比べる（3者の照合）。昔の版をどう決めるか（ファイルの日付、憲章の 1.0.0 の行の日付、照合で最も近い版）。
  3. クリエイターの履歴がない環境（マーケットプレイスから入れたクリエイター。インストールの写しには .git が残らない：skillflow.md 1.3 の表）でも動くか。動かないなら、今後の生成プラグインに「作ったひな形の版」を記録する（今の build に足す）。

### M3 土台を上げたときに、元の機能と土台の機能が重なる

- 新しい土台は、エージェントごとの思考の深さを画面で選べる（`template/com.github.copilot/extensions/_plugin_/core/lifecycle.mjs:35-42, 110-119`、`core/index.mjs:72-73`）。embedded-debug-loop は、同じことを設定 `effort_orchestrator` などと `scripts/apply_agent_settings.py`（K-17、REQ-101）で行い、作業を始めるときにエージェントの定義のフロントマターを書き換える。
- 上げると、画面に思考の深さの欄が2つ出て、2つの仕組みが同じ値を書く。さらに `apply_agent_settings.py` を動かすと、プラグインのフォルダにコミットしていない変更が残り、次の改善・設計変更が REQ-053 で止まる（scaffold.md 4.9 の最後）。
- 機能を消すのは頼まれたときだけ（決定15、REQ-054）。土台を上げたせいで要らなくなった機能をどう扱うか（確認で示して消してよいかを聞くか、残すか）が、仕様 REQ-057 にない。決めて、要れば仕様を直す。
- 人の判断待ち（土台の「人の判断を求めるとき」）も、上げると入る。K-15「人間に伝えて判断を仰ぐ」とつなぐかどうか（差し込み口の文を変えるか）も同じ問題である。

### M4 引き継ぐ課題 T-01 と、取り込む決まりの食い違い

- T-01 は、ルールを `inputs/rules/*.md` で頼みの文から渡し（`eval.json` の prompt）、`Makefile.target` は `CC = gcc`（x86）、機器は「フォルダへのコピー」（`inputs/device.md`）、設定は `device_ip: 127.0.0.1`。ルールのスキルを通らない。
- 取り込む決まり（ARM の静的リンク、イメージの見出し、再起動で有効）と、T-01 の入力のルールは食い違う。REQ-061「元のプラグインの課題と合否の基準は、確かめた決まりに合わせて引き継ぐ」では、T-01 の入力と頼みの文を直すことになる。どう直すか（ルールのファイルを入力から外してスキルに任せる、擬似の機器を M1 の形にする）と、その変更を確認で示す形を決める。
- C-01 の文には「TFTP、CRC やサム値の調整は具体例であり固定仕様ではない」とある（K-07）。取り込んだ決まりが具体的なものになっても、K-07 の文は変えなくてよいか（変えると番号が付け直しになる。REQ-058）を、模擬ユーザーの答えとして決めておく。

### M5 ルールのスキルとスクリプトの場所を、エージェントに渡す手段

- 候補は3つ（skillflow.md 4章の2、skill-spec.md 3.2）：(a) `skill` のツールを渡す、(b) エクステンションが統括の最初の指示にプラグインの場所を入れる、(c) MCP のツールで場所を返す。メモは (b) を勧めている。
- 調べること：
  1. 統括の最初の指示を組み立てる場所（中心の処理か adapter か）と、`pluginRoot`（`adapter.mjs:349`）を入れる直し。中心の処理には `pluginRoot` が既に渡っている（`core/index.mjs:173`）。
  2. 統括が作業・検証に渡す文の決まり（ひな形のエージェントの定義の決まった文）の直し。今のひな形の作業・検証・統括は「スキルを使わない」（`template/com.github.copilot/agents/worker.agent.md:54` ほか）。
  3. 開発の試験のつなぎ口（`inner-adapter.mjs`）で、同じ場所が正しく渡るか（U3）。
  4. ルート直下の `scripts/` をエージェントが `${PLUGIN_ROOT}` で呼ぶ今の形（U4）も、同じ手段で直すか。
- これは土台の変更なので、すべての生成プラグインと make-plugin の流れに効く。土台の2段目の試験、check-base、make-plugin の外側の EVAL の取り直し（1回 約7ドル。dev-eval.md 4章）が要る。

### M6 REQ-062 を、作る流れ（make-plugin）にどこまで入れるか

- REQ-062 は出力の要件なので、change-plugin だけでなく make-plugin が作るプラグインにも効く。ぶつかる今の決まり：
  - クリエイターの作業エージェントの決まり「スクリプトは `files/scripts/` に置く」（`com.github.copilot/agents/worker.agent.md:81`）。REQ-062 の受け入れ基準「スキルのフォルダを1つだけ取り出しても…本文が指すファイルがすべてそのフォルダの中にある」と合わない。
  - 同じファイルの :72（番号を指示の文に入れる）。番号はよいが、決まりの文を写すと REQ-062「書き写さない」に当たる。
- 仕様の穴：入口のスキル（`<名前>_open` を呼ぶもの）は、統括を始めるのが仕事なので、「統括エージェントを始めずにチャットで頼むと、そのスキルの決まりどおりに行われる」（REQ-062 の受け入れ基準2つ目）を満たせない。scaffold.md 5.2 は入口のスキルを検査から外す案だが、仕様にその除外がない。
- 調べること：make-plugin 側で直すファイルの一覧と、作る流れの試験（クリエイターの1・2段目、外側の EVAL）をやり直す範囲。

### M7 知識の一覧（knowledge.json）の形を変えるときの影響

- C4 の決めによっては、読む側10か所（C4 の行）を直す。既に配った3つの生成プラグイン（plugin-market-place）の1段目の `check_structure.py` は古いので、次に直すときに土台と一緒に上がる（M2）。その順で問題がないかを確かめる。

### M8 模擬ユーザーの形とユーザー役

- dev-eval.md 2.3 の足すもの（`kind: change`、`workspace`、`target`、`.sh`・`.py` を示すファイルに許す、docx・xlsx の決まりを外す）。
- 決まりの一覧を「違うもの・古いものを1回で聞く」問いに、ユーザー役が答えられるか。dev-eval.md は `fact`・`reveal` で書けば `USER_RULES` を変えずに済むとするが、確かめていない。新しい模擬ユーザーのユーザー役の試験（約0.15ドル）を先に回す。
- ダミーのスキルの決まりごとに、`from: file` の `evidence`（ファイルの中の文字）と、4つの答え（rule・exception・incidental・wrong）の割り当てを決める。スクリプトにだけ書いた決まり（skill-spec.md 4.6 の最後の案）を入れるなら、`evidence` が `.py` の中を指せるようにする。

### M9 要件と試験の対応表

- REQ-052〜062 の受け入れ基準のそれぞれを、どこで試すか（2段目の試験、外側の EVAL、内側の EVAL、試さない）を表にする。外側の EVAL は1つの模擬ユーザー（生成プラグインの改善）だけでは、次を試せない。
  - REQ-053 の止まる場面（起動フォルダの外、インストールの写し、git の外、コミットしていない変更）
  - REQ-052 の「作り直したい」だけの頼みの問い、受け付けない頼み（検証エージェントをなくす、共通部分の配色）
  - REQ-054・056 の「クリエイターが作っていないプラグイン」の流れ
- 2段目（偽のセッション）で済むものと、数手番で止まる小さな模擬ユーザー（dev-eval.md 2.5 の最後）で試すものに分け、費用の見込みを付ける。

### M10 動かす前の道具

- `tests/dev-eval` の `npm install --ignore-scripts`、tiktoken、Playwright 1.56.1 用の Chromium 1194（`/opt/pw-browsers` は 1243 だけ）、bubblewrap・socat（この調査で apt で入れた。容器を作り直すと消える）、qemu-user と ARM のツールチェーン（RESUME.md の段階0）。RESUME.md の段階0の入れ直しのコマンドに、bubblewrap・socat も足す必要がある。

---

## 4. 設計の大きな危険（重い順）

| # | 危険 | なぜ重いか | 減らし方 |
| --- | --- | --- | --- |
| R1 | エージェントがルールのスキルを読めない（M5、U3〜U5） | REQ-055 の中心「その作業をするエージェントがそのスキルに従う」が、本物でも開発の試験でも成り立たない。統括・作業・検証のすべてが相対パスで読んでいる | 設計の最初に手段を決め、偽の API で通しで確かめてから、ほかを設計する |
| R2 | 土台を上げることで、ユーザーの直しが黙って消え、振る舞いが変わる（M2、M3） | 決定8（毎回、今の土台に上げる）で、毎回起きる。確認の差分が大きく、ユーザーには見分けられない | ファイルごとの照合で「ユーザーが直したもの」を分けて示す。重なる機能は確認で示す |
| R3 | 生成プラグインの EVAL で擬似の機器が作れない（M1） | REQ-061 の受け入れ基準を満たす道がない。本物の機器に送る課題ができるおそれがある | test-plugin と課題の形に、擬似の機器の口を足すかを先に決める。足さないなら、REQ-061 を満たせない範囲を報告に書く |
| R4 | 変更の範囲が広がりすぎる | エクステンション（ツール1つと関門）、組み立て（change-check・extract・change-preview・change・commit）、構造の検査（2つ）、ひな形の土台（場所の受け渡し）、make-plugin（description、start.md、worker の決まり）、test-plugin（擬似の機器）、開発の試験（作業フォルダ、採点、機器、単体の腕）、模擬ユーザー、ダミーのスキル、擬似の機器。憲章 第10条に反し、自律で進める間に止めどころを失う | 今回の範囲を先に決め、BLUEPRINT.md に「入れないもの」を書く。例：作っていないプラグインの流れと REQ-053 の止まる場面は2段目までにする |
| R5 | 確認で示した番号と、できあがる番号が違う（C7、C8、C4） | ユーザーが承認したものと違うものができる。承認の後に初めて組み立てが断る（`rebuild-weaknesses.md:7-10`） | 番号を付ける関数を、エクステンションと組み立てで同じ決まりにし、2段目で突き合わせる試験を置く |
| R6 | 開発の試験が通っても、本物の Copilot CLI で動く保証にならない（U8） | 名前の重なり、隣のフォルダを読む許可、`${PLUGIN_ROOT}`、スキルの呼ばれ方は、Claude Code に置き換えた試験では見えない | 機械で決まることはスクリプトの検査にする。残りは「試せなかったこと」として報告に分けて書く |
| R7 | make-plugin（作る流れ）を壊す | make-plugin の本文は残り 26 トークン（U12）。start.md に「作り直したい」の問いを足す、description を直す、作業エージェントの決まり（M6）と土台（M5）を変える | make-plugin の本文は変えない（skillflow.md 3章）。作る流れの1・2段目と、外側の EVAL を1回取り直す予算を取る |
| R8 | 承認の前に直すフォルダが変わる（C13） | 作業フォルダが直すフォルダと同じとき、仕様の受け入れ基準と採点が不合格になる | 仕様の言い方を直すか、置き場所を決める |
| R9 | 新しい合否の決め方の決まりを、確認の関門が作らせる（C9） | ユーザーが言っていない決まりが入る | 関門は「新しい課題が1つ以上」にする |
| R10 | EVAL の時間・費用・止まり（U10） | 改善の流れは未計測。止まると始めからやり直し | 外側と内側を分けて回す。まず1回測ってから回数を決める。`COST_GUIDE_USD`（`outer.mjs:80`）を実測に直す |

---

## 5. 設計（段階3）に入る前に決める順番（勧め）

1. 道具をそろえ、実際のモデルの呼び出しが通るかを確かめる（U1、M10）。
2. 擬似の機器を emulator の KX-200 の形に決め、ダミーのスキル（名前・置き場所・隠れた決まり）を KX-200 で決め直す（C1、C2、C3）。
3. ルールのスキルの場所をエージェントに渡す手段を決め、偽の API で確かめる（M5、R1）。
4. 土台を上げるときの照合のしかた（M2）と、重なる機能の扱い（M3）を決める。要れば仕様を直す。
5. 生成プラグインの EVAL の擬似の機器（M1）を、今回入れるかを決める。入れないなら、REQ-061 のどこを満たせないかを決めて報告に回す。
6. 記録の形・番号・課題の関門を1つにそろえる（C4〜C9、C12、C13）。
7. 今回の範囲と、要件と試験の対応表（M9）を BLUEPRINT.md に書く（R4）。
