# C6d 試験の仕組み（runner）：実装のメモ

作業の途中のメモである。憲章・仕様書・設計書・実装資産のどれでもない。BLUEPRINT 5 C6d の実装の結果を、統括に知らせるために書く。

## 1. 変えたファイル（すべて `tests/dev-eval/runner/`）

| ファイル | 変えたこと |
| --- | --- |
| `isolation.mjs` | `makeSandboxOptions({ enabled, network, filesystem })`（渡したときだけ足す）。`makeQueryOptions` に `sandboxNetwork`・`sandboxFilesystem`・`denyNetwork`。`makeCanUseTool` に `denyNetwork`（`SandboxNetworkAccess` を断り、`refused` に `{ toolName, host }` で残す）。`SANDBOX_NETWORK_TOOL` を export |
| `outer-change.mjs`（新） | `placeWorkspace(workDir, persona, personaDir, { fixturesDir, originDir })`、`takeBaseline(runDir, { workDir, persona, originDir })` → `change-baseline.json`、`readBaseline`、`takeSnapshot({ workDir, persona, reason })` → `{ at, reason, head, status }`、`changeEnded({ baseline, snapshot, approved, newPlugins })`、`collectChangeRepo`（採点の材料）、`changeRecordOf`（記録の `change`）、`parseAddedLines`、`changePaths`、`hashTree`、`skillNames`、`refsOf`、`git` |
| `outer-grade-change.mjs`（新） | `gradeChange({ persona, record, state, items, toolEvents, stages, repo, personaFiles, modelUse, model, arm, answerer, inner })`：BLUEPRINT 7.3 の観点すべて（純粋な関数）。`questionUnits(items)`、`SCREEN_ITEMS` |
| `outer-run.mjs` | `persona.kind === 'change'` のとき：`placePersonaFiles`（role が repo のものを除く）→ `placeWorkspace` → `takeBaseline`（続きからは `readBaseline`）。スナップショット（記録の item `repo.snapshot`）を、問いに答える直前（質問のツールの呼び出しごと）・クリエイターのツールの呼び出しごと（呼び出しより前の順番）・手番の終わりに取る。手番の終わりに `changeEnded`。終わったら `collectChangeRepo`（1・2段目の前）→ 直したフォルダで `runGeneratedStages`（と `--inner`）→ `gradeChange`。`record.change`、`record.persona.kind`。`FINISHED_REASONS` |
| `outer.mjs` | `COST_GUIDE_USD = { create: 7, change: 15, inner: 2, control: 0.05, without: 0.05 }`、計画の行に `kind`（create／change）、`estimateUsd` を種類ごとに。使い方の説明に改善の模擬ユーザー |
| `inner-run.mjs` | 腕 `standalone`（プラグインを読み込み、インストラクションも足すが、つなぎ口と画面を使わない。手番が終わったら採点。`result.standalone = { openCalled, orchestratorStarted }` と確かめ `open-not-called`・`orchestrator-not-started`）。`startDevice` を渡すと `<runDir>/device` に機器を起動し、`PATH` の先頭に `binDir`、`env` を足し、メイン（と統括）の query に `sandboxNetwork`・`sandboxFilesystem`・`denyNetwork:true`。採点の前に `copyRecordsTo(workDir)`、どの終わり方でも止める。`result.json` に `device` と `networkRefused`。`gradeRun` に `subagents`・`pluginName`（C3 の `agent_ran` のため）。`ARMS`、`deviceEnv`、`standaloneChecks` を export |
| `inner-adapter.mjs` | 統括の query に `sandboxNetwork`・`sandboxFilesystem`・`denyNetwork`・`refused`（メインと同じ配列）を渡す |
| `inner.mjs` | `--arms with,without,standalone`。課題に `device`（persona.device）と `standalone`（inner/standalone.json）を付ける `personaTaskOf`。腕 standalone は単体の課題で動かす（ないときは skipped）。腕ごとの実行のたびに `DEVICE_STARTERS[task.device]`（`kx200` → `../device/kxdevice.mjs` の `startDevice`）か、引数の `startDevice`。知らない機器は始める前に断る。`scoresOf` に `standalone`（回したときだけ）。要点に `device`・`networkRefused`・`standalone` |
| `outer-inner.mjs` | 外側から呼ぶ内側の EVAL の課題に `device` を付ける |
| `user-role.mjs` | ユーザー役の「持っているファイル」から role が repo のファイルを除く（personas/FORMAT.md 2.1「ユーザー役を動かす側が除く」） |
| `creator-tools.mjs`・`creator-tools.test.mjs` | ツールが9つ（`change`）になったことに合わせた（C1 の依頼） |

試験（実際のモデルは呼ばない）

| ファイル | 中身 |
| --- | --- |
| `isolation.test.mjs` | +2：sandbox の network・filesystem（渡したときだけ）、`denyNetwork` |
| `outer-change.test.mjs`（新） | 9件：作業フォルダの形（展開・repo のファイル・書き手と日時・同じ番号の初めのコミット・staged・origin）、断る場合、始める前の記録、スナップショットと終わりの見分け、足した行の取り出し、終わった後の記録（本物の git で `gradeChange` の一部も）、`runOuterOnce` の改善の流れ（偽の SDK：`changed` で終わり、直したフォルダの1・2段目、`gradeChange`、ユーザー役に repo のファイルを示さない）、承認の前に直したら `changed_without_approval`（記録のツールの直前のスナップショット）、本物の題材（`personas/edl-change` と `fixtures/market.tar.gz`。ないときは飛ばす） |
| `outer-grade-change.test.mjs`（新） | 19件：すべて合格する作り例と、観点ごとに1か所だけ壊して、その観点だけが落ちる例 |
| `inner-run.test.mjs` | +7：`deviceEnv`、機器の起動・道具と口・通信の求めを断る・記録の写し・止める、機器なしは今までどおり、起動できないとき・途中で投げたときも止める、`standaloneChecks`、単体の腕（偽の SDK）、本物の `kxdevice.mjs`（I10。偽の SDK が渡された PATH と環境変数のまま `kxtool console -c "uname -a"` を動かし、機器の記録で採点） |
| `inner.test.mjs` | +3 と追記2：`--arms` の standalone、`scoresOf` の standalone、`personaTaskOf`、単体の腕だけを回す（機器の起動と止め、単体の課題がないときは skipped、知らない機器は断る）、外側から呼ぶ内側の EVAL に device が渡る |
| `inner-e2e.test.mjs` | 「あり」の通しの試験に、統括の最初の指示に `## プラグインのフォルダ` と生成プラグインの絶対パスがあること（D3、I6） |
| `outer.test.mjs` | 費用の目安の値（7、9、15＋17） |

## 2. 設計図からのずれ（理由つき）

1. **gradeChange に回す場所**：`outer.mjs` でなく `outer-run.mjs`（採点の関数を呼ぶ場所。`outer.mjs` の `runPlan` は `runOuterOnce` を呼ぶだけ）。`outer.mjs` は費用の目安と計画の `kind` だけを変えた。
2. **`embedded:*`・`not-embedded:*` の見る範囲**：BLUEPRINT は「初めのコミットから HEAD の差分の足した行」。そのとおりにしたが、**role が repo のファイルの決まり（作った後に書き足された決まり。edl-change の `log-dbg`）だけは、直した後のファイルで見る**。この決まりは初めのコミットにすでにあるので、クリエイターがその行を正しく残したままだと足した行に出ず、必ず落ちるため（REQ-054 の受け入れ基準「正しいと答えた決まりは、直した後のプラグインと決まりの一覧に入っている」）。どちらも、決まりの一覧（`tests/knowledge.json`・`knowledge-removed.json`）、課題の入力の写し（`tests/eval/*/inputs/`）、そのまま写した資産（role が skill で SKILL.md でないファイルと同じ中身）は証拠にしない（作る流れの `scopes` と同じ考え）。ユーザーのスキルの SKILL.md をそのまま写したものは証拠にする（たまたま・違う決まりが入るので落ちるべき）。
3. **`assets-reused`**：BLUEPRINT の例は `mkkximg.py` だけだが、role が skill のファイルのうち SKILL.md でないものすべて（edl-change では `kx-build.sh` と `mkkximg.py`）が `skills/*/scripts/` にあることを見る。REQ-055「スキルに付いたスクリプトなどのファイルは…流用する」と、C6c が書いた FORMAT.md 2.1（「SKILL.md のほかのファイルと同じ中身のファイルが、直したプラグインにあるかを見る」）に合わせた。
4. **`unchanged-before-approval`**：スナップショットに加え、作る流れの `no-generation-before-approval` と同じく、承認の抜き書きが直前の質問のツールへの答えにあることも見る（「ユーザーがよいと答えるまで」の「答えた」を確かめるため）。承認の記録がないときは、スナップショットが変わっていなければ合格（ほかの観点が落ちる）。
5. **`confirm-contents` の言葉**：版は `confirmation.version` の文字（なければ `\d+\.\d+\.\d+`）、土台 `/土台/`、擬似の機器 `/擬似|エミュレー/`、課題 `/課題/`。設計図に具体の言葉がないので、仕様と words の言い方から最小にした。
6. **`rule-replaced`**：直したフォルダの中の作業用の一時フォルダは見ない（残ったことは `nothing-outside` が、作業フォルダのどこに残っても落とす）。
7. **`explained`**：「コミットの後」を、最後のコミットのコマンド（Bash の `scaffold.py commit` か `git … commit`）の後のクリエイターの文と問いにした。コマンドがなければ落とす。
8. **スナップショットの時点**：「記録のツールのたび」を、クリエイターのツール（plugin-creator の9つ）の呼び出しのたびにした。呼び出しより前の順番で記録するので、承認の progress の直前の状態が「承認の前」に入る。git は `GIT_OPTIONAL_LOCKS=0` で動かし、クリエイターの git と同時に動いても索引の錠で邪魔しない。
9. **終わりの見分け（`changeEnded`）**：新しいフォルダ → `generated_new_folder`。承認の記録がなく、HEAD が進んだか直すフォルダが変わった → `changed_without_approval`。承認の後に HEAD が進み、直すフォルダに変更がない → `changed`。ほかは続ける。腕 with 以外は、作る流れと同じく承認を見ない。
10. **題材の置き方の決め**：初めのコミットの書き手は `dev-user <dev-user@example.com>`（リポジトリの設定）、説明は「初めの状態」、枝は `main`。origin には初めのコミットを送っておく（`not-pushed` が refs の変化を見られるように）。staged は origin に送った後に足す。全体とシステムの git の設定を読まないので、同じ題材なら毎回同じコミットの番号になる（本物の題材で `0b17e2d…` を2回確かめた）。
11. **記録の `change`** に、BLUEPRINT の欄のほか `statusAfter`・`tagsAtHead`・`leftoverWork` を足した（採点の理由を記録だけで追えるように）。ファイルの中身は残さない。
12. **内側の EVAL**：`denyNetwork` は機器を使う実行だけにした（BLUEPRINT は機器の文脈で書いている。機器のない実行は今までどおり許可する）。断った通信の求めは、メインと統括で同じ配列に残す。単体の腕の確かめは `result.checks`（点数に入れない「動きの確かめ」。あり の `buildChecks` と同じ扱い）。単体の腕の実行のフォルダは、単体の課題の id（`inner-runs/<standalone の id>/standalone-<n>`）。
13. **会話例**：改善の会話は会話例（作る流れ）の候補にしない（`exampleCandidate: false`）。
14. **`COST_GUIDE_USD` の鍵**を `create`・`change`・`inner`・`control`・`without` に変えた。対照とプラグインなしは測っていないので、試作の値のまま（コメントに書いた）。

## 3. 取り決め（I9・I10）とほかの組

- **I9（persona.json）**：C6c の `edl-change/persona.json` と FORMAT.md 2.5 のとおりに読んだ。`files[].place` は作業フォルダからの相対（role が repo のものも）、`workspace.repo.staged[].path` はリポジトリの根からの相対、`workspace.repo.fixture` は `tests/dev-eval/fixtures/` からの相対。`expect` は `carriedMax`・`replaced`・`deviceTool`・`userSkills`・`screenAsked`・`lastTimeAsked`・`explained` を使う。本物の模擬ユーザーと題材で、置く・始める前の記録・スナップショット・集める までを動かして確かめた（`outer-change.test.mjs` の9件目）。
- **I10（startDevice）**：`env`・`binDir`・`sandboxNetwork`・`sandboxFilesystem`・`copyRecordsTo`・`stop` を使う。`ready.isolate`（C6a が足した読み取り専用の欄）があれば記録に残す。本物の `kxdevice.mjs` でも試験した（`isolate: 'none'`）。
- **C1**：`creator-tools.test.mjs` のツール9つは直した。
- **C3**：`gradeRun` に `subagents`（その実行で始まったエージェントの種類を `agentName` に）と `pluginName` を渡した。模擬ユーザーの課題が `agent_ran` を使っても採点できる。
- **C5（testing.md）に書くとよいこと**：腕 standalone と確かめの2つ、`--arms with,without,standalone`、機器を使う実行の `denyNetwork`、記録の `repo.snapshot` と `change`、終わりの理由3つ、`assets-reused` と repo のファイルの決まりの見る範囲（2の2・3）、費用の目安の値。

## 4. 試験の結果

- `node --test tests/dev-eval/runner/*.test.mjs tests/dev-eval/personas/*.test.mjs`（`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`）：360件すべて合格（runner は前の 266件〔1件不合格：creator-tools のツールの数〕から 306件に）。約1分。
- `tests/dev-eval/trigger/*.test.mjs` と `tests/creator/extension/quote.test.mjs`（runner のモジュールを読むもの）も合格。
- 全体の `python3 tests/creator/run.py` は、ほかの組が並べて変えているので動かしていない。

## 5. 残る点

- 実際のモデルでは動かしていない（7.3 の EVAL は統括が承認を取ってから）。最初の外側の EVAL（改善）で、次を確かめる。
  - サンドボックスが作業フォルダに残すものが `.claude/.cc-writes/` だけか（ほかに残れば `nothing-outside` が落ちる。除く場所を足す）。
  - クリエイターが決まりの一覧の問いで番号を書くか（`rules-list-once` は番号で見る）。`confirm-contents` の言葉（土台・擬似・課題）が実際の確認の文に出るか。
  - コミットを `scaffold.py commit` で行うか（`explained` の起点）。
- 外側の EVAL（改善）のクリエイターの実行には、通信の制限を足していない（設計図に書いていない。クリエイターが外への通信を要るか分からないため）。
- 内側の確かめ B（腕 standalone）は、偽の SDK と本物の機器（偽の SDK が kxtool を動かす）でしか確かめていない。本物の Claude Code のサンドボックスの中から機器に届くことは、C6a の試作の実測（emulator.md 4.4）による。

## 6. 点検と直し

点検の10件を、コード・スキル（`skills/make-plugin/references/confirm.md`・`rules.md`、`skills/change-plugin/references/change-confirm.md`・`change-read.md`）・設計図・設計書で確かめた。10件とも本当だったので直した（8 は文書の側の直しを統括に頼む）。

| # | 結果 | 直したこと・理由 |
| --- | --- | --- |
| 1 `confirm-contents` がスキルどおりの確認を落とす | 直した | 見る範囲を「最初に受け付けられた確認（成功した `confirm`）から、承認の問いまでの、すべての問いとその前の文」にした（確認の直前に書いた文は、最初の問いの前の文に入る）。受け付けられた確認がなければ落とす。スキルは確認を1つ目（版・土台）と2つ目（課題・擬似の機器）に分け、そのたびに問いと一緒に示し、承認の問いの例には4つの言葉がないため。試験の作り例を「確認 → 1つ目の問い → 2つ目の問い → 承認の問い（言葉なし）」に作り直し、確認より前の文の言葉は数えないこと、断られた確認の後に受け付けられたときはそこから見ることを足した。設計図 7.3 の「承認の問いとその前の文」からのずれ（下の 7） |
| 2 `added-rule-confirmed` が一覧の問いで合格する | 直した | 問いそのもの（見出し・問い・選択肢）に、その決まりの文字（`file.evidence`。edl-change では `DBG_LOG`、大文字小文字を問わない）がある問いを数える。前の文は数えない（`rules.md`：問いに決まりの文を書く）。決まりの一覧の問い（問いと前の文に元の番号がすべて出る問い。`rules-list-once` と同じ見分け方）と、確認より後の問いは数えない。`markers.asked` は元の決まりの文字（`printf`）にも当たるので使わない。点検の「半分より多くの番号」でなく「すべての番号」にしたのは、1件の問いの前に番号のまとめを書いただけで落ちないようにするため。点検の再現（`rev/edl.mjs`）で「問いがない」と出ることを確かめた。試験：一覧の問いだけ、前の文にだけ、確認の後にだけ → 落ちる。元の番号に1つ触れた1件の問い → 合格 |
| 3 単体の腕の `open-not-called` が落ちない | 直した（点検の案の2つ目） | 入口のスキルを使ったかを `result.standalone.entrySkillUsed` に残し、確かめ `entry-skill-not-used` を足した。入口のスキルは、変換レポートで画面を開くツール（open）を使う `skills/<名前>/SKILL.md` のフォルダ（`entrySkillsOf`。1段目の `standalone` の検査と同じ見分け方。見つからなければプラグインの名前）。呼んだスキルが `<名前>` か `<プラグイン>:<名前>` なら使ったとする。案の1つ目（つなぎ口のツールを出す）は、設計図 C6d の「つなぎ口と画面を使わない」に反するので選ばなかった。`open-not-called` は設計図のとおり残した |
| 4 確認の1つ目で `rules-list-once` が合格する | 直した | 最初に受け付けられた確認より前の問いだけを見る |
| 5 試験が足りない | 直した | (a) `inner-adapter.test.mjs` に、統括の query の `env.PATH`（機器の道具が先頭）・機器の環境変数・`sandbox.network`・`sandbox.filesystem`・通信の求めを断ってメインと同じ配列に残すこと、機器なしは今までどおりを足した。`inner-run.test.mjs` に、腕 with で、本物のつなぎ口の画面を開くツール（MCP）と画面の開始の窓口（HTTP）で統括を始め、メインと統括の両方に機器の道具と口が渡ることを足した。(b) `outer-change.test.mjs` に、腕 with で、本物の記録のツール（`change`・`progress`・`record`・`confirm`）で承認まで進め、承認の後にコミットすると `changed` で終わり、承認の progress の直前のスナップショットが初めのままであることを足した |
| 6 `--no-sandbox` で機器の隔離が効かない | 直した（警告） | 断らずに警告にした（サンドボックスの道具がない環境で `--no-sandbox` を使えなくしないため）。機器を使う実行で、サンドボックスなしなら `result.json` の `warnings` と `device.fenced: false`、`inner-result.json` の `warnings` と実行の要点に「擬似の機器の通信と中身の制限が効いていない」（`DEVICE_UNFENCED_WARNING`）を残す |
| 7 git のコマンドの見分けがもろい | 直した | heredoc の中身を除き（`shellCode`）、コマンドの始まり（行の頭、`; & | (` の後、`$(` の中）の git の呼び出しだけを見る（`-C <場所>`・`-c <設定>`・`--<オプション>` を挟んでよい）。`not-pushed` と `explained`（`git … commit`）の両方。試験：`echo "git push"`、heredoc の中の `git push`、`git stash push`、`.git/` と commit の文字では落ちない・ずれない。`cd market && git push`、`git -c … -C "…" push`、`$(git push)` は落ちる |
| 8 ずれ2・4が文書と合わない | 統括に頼む | `docs/design/testing.md` 6.8 は、すでにずれ2（repo のファイルの決まりは直した後のファイル）と4（承認の抜き書き）を書いている。`tests/dev-eval/personas/FORMAT.md` 2.5（192行目「足した行で見る」）は、ずれ2の例外をまだ書いていない（担当のファイルの外なので直していない） |
| 9 マニフェストを直下だけで探す | 直した | `manifestOf(dir)`（`outer-change.mjs`）が、エクステンションの `MANIFEST_PLACES`（`change.mjs` から読み込む）の順に探す。`pluginFacts`（元の版・名前、直した後の版）と、`outer-run.mjs` の1・2段目を動かすかの見分けで使う。あわせて、直すフォルダのマニフェストが直下にない題材を、直してマニフェストが直下に移ったときに「新しいフォルダに作った」（`generated_new_folder`）と取り違える誤りを見つけたので、直すフォルダを新しいフォルダの見分けから外した（直さないと落ちることを試験で確かめた） |
| 10 小さな食い違い | 直した | `stopped.run` を単体の腕の課題の id（`inner-runs/<単体の課題>/standalone-<回>` と同じ）にした。`inside()` の断る文に、外に出たフォルダの呼び名（題材のフォルダ、模擬ユーザーのフォルダ、題材のリポジトリ）を入れた |

### 6.1 直した後の、設計図からのずれ（2 のずれの表に足す）

15. **`confirm-contents` の見る範囲**：設計図 7.3 は「承認の問いとその前の文」。スキルが確認を分けて示すので、「受け付けられた確認から承認の問いまでの、問いとその前の文」にした（点検 1）。
16. **`rules-list-once`・`added-rule-confirmed`**：確認より前の問いだけを見る。`added-rule-confirmed` は「それだけを確かめる問い」（問いそのものに決まりの文字があり、一覧の問いでない）を求める（REQ-054「1件ずつ確認の質問として示される」。点検 2・4）。
17. **単体の腕の確かめ**：`entry-skill-not-used` を足した（点検 3）。
18. **`--no-sandbox` と擬似の機器**：断らず、警告を残す（点検 6）。

### 6.2 統括に頼むこと（ほかの組）

- C5（`docs/design/testing.md` 6.8 の表と 7章）：`confirm-contents`（確認から承認の問いまで）、`rules-list-once`（確認より前の問い）、`added-rule-confirmed`（問いそのものに決まりの文字がある、一覧の問いでない、確認より前の問い）、`not-pushed`・`explained`（git の呼び出しだけを見る）の見るもの。7章の確かめ B に「入口のスキルを使ったか」、擬似の機器の節に「サンドボックスなしでは制限が効かず、警告を残す」。
- C6c（`tests/dev-eval/personas/FORMAT.md` 2.5）：「外側の EVAL は…足した行で見る」に、role が repo のファイルの決まりは直した後のファイルで見る例外を足す（testing.md 6.8 と同じ）。
- 点検の再現 `rev/confirm.mjs` は confirm の記録を持たないので、直した後の採点では「受け付けられた確認の記録がない」で落ちる（クリエイターは承認の前に必ず confirm を呼ぶので、本物の実行では起きない）。

### 6.3 試験の結果（直した後）

- `node --test tests/dev-eval/runner/*.test.mjs tests/dev-eval/personas/*.test.mjs`（`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`）：379件すべて合格（前は 360件）。
- `tests/dev-eval/trigger/*.test.mjs`、`tests/creator/extension/quote.test.mjs`、`tests/dev-eval/device/*.test.mjs`：44件すべて合格。
- 全体の `python3 tests/creator/run.py` は、ほかの組が並べて変えているので動かしていない。
