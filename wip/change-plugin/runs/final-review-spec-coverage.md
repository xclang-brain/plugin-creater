# 改善・設計変更：仕様の受け入れ基準と試験の対応（最終の点検）

作業の途中のメモである（憲章・仕様書・設計書・実装資産のどれでもない）。

- 対象の仕様：`docs/specs/improvement-requirements.md` の REQ-052〜061、`docs/specs/output-requirements.md` の REQ-062、今回の機能で文を足した REQ-021・032・043・044・049（`docs/specs/creation-requirements.md`）。
- 出発点：`wip/change-plugin/BLUEPRINT.md` の 1.2（わざと入れないもの）と 2章（要件 → 試験）。そのうえで、今の試験の名前を要件の番号で探し（`grep REQ-05x / REQ_05x`）、試験の中身と実行の記録を読んで確かめた。
- `<scratchpad>` は `/tmp/claude-0/-home-user/64a230fb-e6a2-510f-9e7e-9e6600fd34a8/scratchpad`、`<run5>` は `<scratchpad>/runs/outer-change-5/runs/outer-edl-change-with-vYhysZ`、`<P5>` は `<run5>/work/market/plugins/embedded-debug-loop`（5回目に直したプラグイン）。`[数]` は `<run5>/record.json` の `items` の seq。

## 0. 結論

- 受け入れ基準は REQ-052〜062 で 53 個。自動の試験か採点で、基準の文どおりに確かめたもの（◎）が 25、一部だけ確かめたもの（○：仕組みだけ、一部の場合だけ、記録を目で読んだだけ）が 22、確かめていないもの（×）が 6。
- 確かめていない6つ：
  1. `/plugin-creator:change-plugin` と打って始められること（REQ-052）
  2. 検証エージェントをなくす頼みと、画面の共通部分の配色を変える頼みを断り、理由を示すこと（REQ-052）
  3. 「作り直したい」とだけ頼むと、元のフォルダを直すか新しいフォルダに作るかを聞かれること（REQ-052。REQ-032 の足した文も同じ）
  4. クリエイターが作っていないプラグインで、読み取った決まりを1件ずつ確かめ、違うと答えたものを入れないこと（REQ-054）
  5. 課題のなかった元のプラグインに、作業全体を試す課題も入ること（REQ-061）
  6. 変えたところを壊したプラグインで EVAL をすると、足した課題の基準が落ちること（REQ-061）
- 外側・内側の EVAL と呼ばれ方の試験は、すべて Claude Code（Agent SDK）で、クリエイターと生成プラグインを Claude Code の形に変換して動かしたものである。Copilot CLI の実物での振る舞い（スラッシュコマンド、description での呼ばれ方、フォルダの許可の確認、インストールの写しの場所、同じ名前のスキルの扱い、test-plugin の EVAL）は、どれも確かめていない（4章）。
- 点検で見つけた不具合が1つある（5.1）：直した後に示す「直す前に戻すコマンド」（`git -C <P> revert --no-edit <コミット>`）は、同じリポジトリのほかのフォルダに git add しただけの変更があると、失敗する。REQ-053 はこの状態で始めることを認めており、5回目の模擬ユーザーもこの状態だった。2段目の試験は、ほかに変更のない状態でしか戻していない。
- 外側の EVAL の観点がすべて合格したのは5回目の1回だけである（腕 with、1回）。1〜4回目は、毎回ちがう必須の観点が落ちている（5.6）。

## 1. 前提（試験と実行の状態）

| もの | 状態 | 根拠 |
| --- | --- | --- |
| クリエイターの1・2段目 | 1段目 9件（8合格、1対象外）、2段目 1794件すべて合格（2026-10-27 05:26〜05:30） | `tests/results/latest.json`。この後に変わったファイルはない（`wip` と結果のファイルを除いて `find -newermt '2026-10-27 05:26:27'` で0件）。開発の試験（`tests/dev-eval/**`）も同じ入口で動いている（`tests/creator/run.py` の `SEARCH_ROOTS`） |
| 外側の EVAL 5回目 | 点数 1.00、38 観点すべて合格、faults なし。腕 with、1回、クリエイター claude-opus-5-5、ユーザー役 claude-sonnet-5-5 | `<run5>/record.json` の `grading`、`wip/change-plugin/runs/outer-change-5-report.json` |
| 内側の確かめ A・B（inner-5） | 5回目に直したプラグインの写し（`<scratchpad>/runs/edl-after-5`。`diff -rq` で `<P5>` と違いなし）で実行。A（T-01）：あり 1.00（6/6）、なし 0.17（1/6）。B（T-02、単体の腕）：1.00（5/5）、画面を開くツールを呼ばず、統括を始めず、入口のスキルを使わず、使ったスキルは cross-compile-rules と deploy-rules | `wip/change-plugin/runs/inner-5-result.json`。腕のモデルは claude-sonnet-5-5、擬似の機器は bwrap で隔離、外への通信の求めは0件 |
| 呼ばれ方の試験（trigger-1） | 8件すべて期待どおり（2026-10-26 20:38） | `<scratchpad>/runs/trigger-1.log`。この後、3つのスキルの `description` は変わっていない（`git log -p` で確かめた） |

記号：

- 試験の列：「2段」＝クリエイターの2段目の試験（ファイル：試験の名前の要点）、「1段」＝構造の検査の試験（`tests/creator/stage1/test_check_structure.py`）、「外」＝外側の EVAL 5回目の採点の観点（`tests/dev-eval/runner/outer-grade-change.mjs`。すべて必須）、「内A」「内B」＝内側の確かめ A・B、「呼」＝呼ばれ方の試験（`tests/dev-eval/trigger/cases.json` の頼みの id）、「目」＝実行の記録を読んで確かめた（自動の採点はない）。
- 判定：◎＝受け入れ基準の文どおりに、自動の試験か採点で確かめた。○＝一部だけ確かめた。×＝確かめていない。◎でも、外・内・呼は Claude Code での見込みである（4章）。

## 2. 受け入れ基準ごとの対応

### REQ-052 改善・設計変更を頼む

| 受け入れ基準 | 判定 | どう確かめたか |
| --- | --- | --- |
| フォルダを示して「〇〇のスキルを足したい」と頼むと、改善の対話が始まる。作る対話・作り直しの対話は始まらない | ◎ | 呼 `add-skill`（最初に呼んだスキルが change-plugin）。外 `change-skill-used`（呼んだのは change-plugin だけで make-plugin を始めていない）・`no-new-folder`。2段 `record-tools.test.mjs`「フォルダと変えたいことを渡すと、直す記録ができる」。5回目の頼みは「スキルを組み込んでください」で、「足したい」そのものの言い方は呼ばれ方の試験だけ |
| `/plugin-creator:change-plugin` と打っても始められる | × | 試験なし。`skills/change-plugin/SKILL.md` は name が change-plugin で、呼び出しを止める項目はない（読んで確かめただけ）。Copilot CLI の実物が要る |
| クリエイターが作っていないプラグインでも、改善の対話が始まる | ○ | 呼：頼みの題材の sales-report は決まりの一覧も作業の定義もない（作っていないプラグイン）。そのうえで add-skill・add-setting・split-workers・remove-feature の4件で change-plugin が最初に呼ばれた。2段 `test_change.py` の `test_REQ_052_a_plugin_the_creator_did_not_make_is_changed_into_a_generated_plugin`・`…the_kind_from_the_record_must_be_the_same…`、`record-tools.test.mjs`「生成プラグインかは…両方があるかで見分ける。片方だけなら作っていないプラグインとして扱い」、`state.test.mjs`「plugin-creator が作っていないプラグインでは、引き継いだ決まりが0件…」。対話が進むことは外側の EVAL で試していない（BLUEPRINT 1.2） |
| 作業エージェントを足す頼みを受け付ける | ○ | 呼 `split-workers`。2段 `test_change.py` の `test_REQ_052_a_worker_agent_can_be_added`（組み立てだけ）、`grade.test.mjs` の `agent_ran`。断らずに対話を進めることは試していない |
| 検証エージェントをなくす頼みと、画面の共通部分の配色を変える頼みは受け付けられず、理由が示される | × | 試験なし。`skills/change-plugin/references/change-start.md` の4の手順だけで守る（BLUEPRINT 1.2） |
| フォルダを示して「作り直したい」とだけ頼むと、直すか新しいフォルダに作るかを聞かれる | × | 呼 `rebuild-only` は make-plugin か change-plugin が呼ばれることだけを見る（実際は make-plugin）。問いは見られない（最初のスキルの呼び出しを断って止めるため） |
| README に頼み方が書かれている | ○ | 目：`README.md` の改善・設計変更の節（85〜110行。頼み方の例、`/plugin-creator:change-plugin`、「作り直したい」の問い、受け付けない頼み、読ませ方）。自動の試験はない |

### REQ-053 始める前の確かめ

`test_change.py` の止まる試験は、どれも `refused_check` で、断ったときにフォルダの中身が前と同じことも確かめている（193〜199行）。スクリプトが断り、直し方の文を返すことまでは2段目で確かめた。スキルがそれを受けて止まることは、外側の EVAL で試していない（BLUEPRINT 1.2）。

| 受け入れ基準 | 判定 | どう確かめたか |
| --- | --- | --- |
| 起動したフォルダの外のプラグインを示すと、起動し直すやり方が示されて止まる | ○ | 2段 `test_REQ_053_a_plugin_outside_the_work_folder_is_refused_with_how_to_restart`（`cd <P>` と `copilot` を示す）。外で許可の確認が何度も出るという理由そのものは、Copilot CLI の実物で確かめていない |
| インストールされた写しを示すと、元のリポジトリを示すよう示されて止まる | ○ | 2段 `test_REQ_053_installed_copies_are_refused`・`…marketplace_caches_are_refused`・`…the_default_cache_folder_is_refused…`・`…the_copilot_home_is_also_found_from_the_place_of_the_hearing_record`。写しの場所（`installed-plugins/`、`COPILOT_CACHE_HOME` とその下の `copilot`）は文書から決めたもので（D39）、実物では確かめていない |
| git の外と、.gitignore で外したフォルダは、直し方が示されて止まる | ○ | 2段 `test_REQ_053_a_folder_outside_git_is_refused`・`…a_plugin_folder_ignored_by_gitignore_is_refused`・`…a_plugin_folder_that_was_never_committed_is_refused` |
| フォルダの中に未コミットの変更か git に入れていないファイルがあると、直し方が示されて止まる | ○ | 2段 `test_REQ_053_files_that_are_not_committed_are_refused_with_their_names`（変えた・git add だけ・git に入れていない、の3つ）、`…a_change_inside_the_plugin_folder_stops…`、直す直前の確かめ直し `…the_checks_are_done_again_right_before_changing`、マージなどの途中 `…a_merge_in_the_middle_is_refused` ほか |
| ほかのフォルダにだけ未コミットの変更があるときは、止まらずに始まる | ◎ | 2段 `test_REQ_053_changes_only_in_other_folders_of_the_repository_do_not_stop`。外：模擬ユーザーはリポジトリの直下の README.md を git add した状態で始め（`persona.json` の `workspace.repo.staged`）、最後まで進んだ（`commit-scoped` で README.md が git add のまま残ったことも確かめた） |
| 止まったとき、フォルダの中身は変わっていない | ◎ | 2段 上の止まる試験のすべて（`refused_check` が前後の中身を比べる）。入れ替えの途中で失敗したときも `test_REQ_053_a_failure_while_swapping_puts_everything_back` |

### REQ-054 読み取ったことを確かめる

| 受け入れ基準 | 判定 | どう確かめたか |
| --- | --- | --- |
| できていたことの一覧が示される。機能ごとに要るかは聞かれない | ○ | 2段 `record-tools.test.mjs`「直すときは、段階と聞くこと『できていたことの確認』を断る」（機能ごとに聞く記録ができない）。目：[154] の問いに、できること6つと「ほかは今のまま引き継ぎ」があり、機能ごとの問いはない。外側の EVAL の観点はない |
| 消したいと頼んだ機能はない。それ以外は直した後もできる | ○ | 消すほう：2段 `test_REQ_054_a_file_removed_from_the_parts_is_removed_from_the_plugin`（組み立てだけ。消す頼みの外側の EVAL はない。BLUEPRINT 1.2）。できるほう：内A（直したプラグインで T-01 が 6/6）、`<P5>` の2段目 492件合格、外 `ids-kept` |
| 生成プラグインでは、決まりの一覧が1回の問いで示される。違うと答えた決まりは、答えたとおりに直されるか、外される | ◎ | 外 `rules-list-once`（[169] の1つの問いに K-01〜K-17 がすべて出た）、`rule-replaced`（K-15 を外して K-33）、`embedded:k15-now`。2段 `record-tools.test.mjs` の REQ-054・REQ-058 の試験（付け直し、抜き書きの確かめ）、`quote.test.mjs` の REQ-054。外すだけ（直さない）のほうは2段目だけ |
| 書き足した決まりが1件ずつ確認の質問として示される。正しい→入る、違う→入らない | ○ | 外 `added-rule-confirmed`（DBG_LOG の決まりを「という決まりですか」の問いで確かめ、決まりの一覧に入った）、`embedded:log-dbg`。模擬ユーザーは「正しい」と答えるので、「違う」と答えたときに入らないことは試していない |
| 作っていないプラグインでは、読み取った決まりが1件ずつ確認の質問として示され、違うと答えた決まりは組み込まれない | × | 外側の EVAL は生成プラグイン1つだけ（D25）。2段目は、返り値に「読み取った決まりを1件ずつ確かめる」と出ること（`state.test.mjs`）と、決まりを取り込まないこと（`record-tools.test.mjs` D29）だけで、問いと組み込みは見ていない |

### REQ-055 既存のスキルを取り込む

| 受け入れ基準 | 判定 | どう確かめたか |
| --- | --- | --- |
| 示したスキルから読み取った決まりが、確認の質問として示される | ○ | 外の参考の記録（`trace`。合否には入らない）で、ユーザーのスキルの決まり11件すべてが asked:true。目：[215]〜[336] に「という決まりですか」の問いが14問。合否の観点はない |
| 正しい→ルールのスキルに入っている。違う→入っていない | ◎ | 外 `embedded:cc-toolchain`・`cc-static`・`cc-debug`・`dp-image`・`dp-steps`・`dp-console`・`dp-marker`・`dp-ip`（入口を除くルールのスキルの SKILL.md と references の足した行で見る）、`not-embedded:cc-git-pull`・`dp-ip`・`dp-uname`（足した行のすべて。試験のコードを除く） |
| 直した後で作業すると、取り込んだ決まりに沿って作業される | ◎ | 内A：T-01 であり 6/6（イメージの見出し、静的リンク、インストール→再起動→実行の順、アドレス 192.168.7.2）、なし 1/6。擬似の機器 KX-200 を相手にした Claude Code での実行 |
| プラグインのスキルの名前が、示したスキルの名前と違う | ◎ | 外 `skill-names-differ`（ユーザーは cross-compile・deploy、直した後は cross-compile-rules・deploy-rules）。2段 `test_REQ_055_a_shown_skill_with_the_same_name_as_a_plugin_skill_is_reported`・`…a_plugin_skill_with_the_name_of_a_shown_skill_is_refused` ほか。同じ名前だと黙って使われないという理由そのものは、Copilot CLI で確かめていない |
| 書き直したスキルの仕事を、統括を始めずにチャットで頼むと、取り込んだ決まりどおりに行われる | ◎ | 内B：T-02 で 5/5、統括を始めず、画面を開かず、使ったスキルは cross-compile-rules と deploy-rules。頼みにアドレスを書かず、ルールのスキルにある 192.168.7.2 に送ったかを基準で見る |
| 示したスキルのフォルダの中身が、前と後で同じ | ◎ | 外 `user-skills-unchanged`（4ファイル）。2段 `test_REQ_055_a_rule_skill_with_another_name_is_accepted_and_the_shown_skill_is_unchanged`、プラグインの中のスキルは断る `…a_shown_skill_inside_the_plugin_is_refused` |

要件の文（基準ではない）の「スクリプトはユーザーの資産として流用する」は、外 `assets-reused`（kx-build.sh と mkkximg.py が同じ中身で `skills/*/scripts/` にある）で確かめた。

### REQ-056 変えるところだけ聞く

| 受け入れ基準 | 判定 | どう確かめたか |
| --- | --- | --- |
| 変えないところについて、もう一度質問しない | ○ | 外 `unchanged-items`（7項目が最後まで「変えないので聞かない」）、`no-screen-questions`。2段 `record-tools.test.mjs` の REQ-056（未着手からだけ、抜き書きの確かめ）。画面の項目のほかの問いが、変えない項目を聞き直していないかは採点していない |
| 変えるところについて、実際の1回をたどる質問がある | ◎ | 外 `last-time-asked`（[187]）。2段「『前回の1回』には使えない」 |
| 画面を変えない改善では、画面の質問がない | ◎ | 外 `no-screen-questions`、`unchanged-items`（画面の3項目が「変えないので聞かない」） |
| 作っていないプラグインでは、最初から最後までの1回と、画面の質問がある | ○ | 2段「plugin-creator が作っていないプラグインを直すときは、どの聞くことも『変えないので聞かない』にできない」（画面の項目も聞いて記録しないと確認に進めない仕組み）。問いそのものは外側の EVAL で試していない |
| クリエイターの画面で、変えないので聞かない項目が、まだ聞いていない項目と分けて示される | ◎ | 2段 `screen.test.mjs`「『変えないので聞かない』項目は…分けて持つ」、`screen.browser.test.mjs`「今のプラグインを直すとき、『変えないので聞かないこと』の欄が…別に出る」「作っていないプラグインでは…欄を出さない」。外側の EVAL では画面を開いていない |

### REQ-057 直す前の確認

| 受け入れ基準 | 判定 | どう確かめたか |
| --- | --- | --- |
| 直す前に、上のものがすべて示され、画面でも見られる | ○ | 外 `confirm-contents`：確認から承認の問いまでに「新しい版」「土台」「擬似」「課題」の言葉があり、記録の `rebuild.keep` と `rebuild.change` が空でない。目：[435]・[439] に、版、引き継ぐこと、直す・足す・入れない決まり、変わること、土台を上げること、振る舞いの案、課題と合格の条件、本物のボードへの転送は試せないこと、がそろっていた。画面：2段 `screen.test.mjs`・`screen.browser.test.mjs`「直す前の確認で、直すフォルダ、版、引き継ぐことと変わること、決まりの足す・直す・外すが見られる」（作り例の記録で）。採点していないもの：決まりの一覧・振る舞いの案・合否の基準が示されたか、作っていないプラグインのときの項目、画面を変えるときの見本 |
| よいと答えるまで、git が管理するファイルは変わらない | ◎ | 外 `unchanged-before-approval`（承認の前の 68 回のスナップショットで HEAD も status も初めのまま、承認の抜き書きが直前の答えにある）。2段 `test_REQ_059_extracting_into_the_plugin_folder_itself_leaves_the_tracked_files_alone`、`test_REQ_020_change_needs_the_approval_and_the_same_folder`、`record-tools.test.mjs`「確認の後に決まりが変われば、示し直すまで『生成』に進めない」 |
| 引き継ぐと示した部品は、確認で示した変更のほかは変わっていない | ○ | 2段 `change-guard` の試験（`test_REQ_057_other_changes_are_shown_and_put_back`・`…a_staged_new_file_is_removed_too`・`…files_changed_by_the_redraw_may_be_fixed`）、描き直しで変わらないこと（`…redrawing_without_changes_gives_the_same_plugin`・`…without_changes_only_the_version_changes`）。外側の EVAL には、部品ごとに比べる観点がない（`ids-kept` は決まりだけ） |
| 直した後の version が、よいと答えた版 | ◎ | 外 `version-approved`（0.1.0 → 確認 0.2.0 → 直した後 0.2.0）。2段 `record-tools.test.mjs`「新しい版の案が要る。版は形が合い、今の版より大きいこと」、`test_REQ_057_the_version_must_be_greater_than_the_current_one`、`change.test.mjs`「数ごとに比べる」 |

### REQ-058 決まりの番号

| 受け入れ基準 | 判定 | どう確かめたか |
| --- | --- | --- |
| 引き継いだ決まりの番号が、直す前と同じ | ◎ | 外 `ids-kept`（16件の中身が同じ）。2段 `test_REQ_058_carried_numbers_stay_new_ones_follow_and_replaced_ones_are_kept_as_removed`・`…a_carried_number_with_other_content_is_refused`・`…a_knowledge_list_changed_since_it_was_carried_is_refused`、`record-tools.test.mjs` の REQ-058（9件） |
| 足した・中身を直した決まりの番号が、直す前の番号とも、前の改善で外した番号とも重ならない | ◎ | 外 `ids-kept`（新しい番号はすべて K-17 より後、外した番号を使っていない）、`rule-replaced`。「前の改善で外した番号」は2段 `test_REQ_058_a_second_change_never_reuses_a_removed_number`、`record-tools.test.mjs`「新しい決まりの番号は、決まりの一覧と外した決まりの一覧の番号の最大の次から付く」、1段 `test_REQ_058_a_removed_number_may_not_be_used_again_in_the_list`。外側の EVAL は1回目の改善だけ |
| 外した番号や中身を直す前の番号を指したままの箇所があると、構造の検査が不合格 | ◎ | 1段 `test_REQ_058_a_removed_number_left_in_an_agent_fails_with_the_place_and_the_new_number`・`…a_number_removed_without_a_new_one_asks_to_delete_the_reference`・`…removed_numbers_are_searched_in_eval_tasks_and_task_tests_too`・`…a_criterion_may_not_cite_a_removed_number`。外：`<P5>` の1段目の knowledge の検査が合格、`rule-replaced`（K-15 はほかのファイルにない） |

### REQ-059 直す場所とコミット

| 受け入れ基準 | 判定 | どう確かめたか |
| --- | --- | --- |
| 新しいフォルダは作られず、元のフォルダが直されている | ◎ | 外 `no-new-folder`、`commit-scoped` |
| 直した後のプラグインが、出力の要件の受け入れ基準を満たす | ○ | 外 `stage1`（15件。13合格、mcp と references は対象外）・`stage2`（492件すべて合格）。内A。出力の要件のうち Copilot CLI の実物で動くもの（エクステンションの画面、gh での起票など）は、偽物を使った2段目の範囲だけ |
| 仕様書の要件から、設計書・実装資産・テストをたどれる | ◎ | 外 `stage1` のうち検査 trace（REQ-003 要件の追跡の表）が合格。構造の検査で見られる範囲 |
| 直した内容がコミットされている。戻すと直す前と同じ中身になる | ○ | 外 `commit-scoped`（初めのコミットの次にコミットが1つ、印のタグが HEAD）。2段 `test_REQ_059_reverting_the_commit_gives_back_the_plugin_before_the_change`。ただし戻すのは、ほかに変更のない状態でだけ。ほかのフォルダに git add した変更があると、示したコマンドは失敗する（5.1） |
| コミットに、元のフォルダの外のファイルが入っていない。ほかで git add した変更も入っていない | ◎ | 外 `commit-scoped`（差分はすべて直すフォルダの中、README.md は git add のまま）。2段 `test_REQ_059_only_the_plugin_folder_is_committed_and_staged_changes_elsewhere_stay_staged` |
| 外で、ヒアリングの記録と試験の道具のほかに作られたり変わったりしたファイルがない。一時フォルダは残っていない | ◎ | 外 `nothing-outside`（作業フォルダのうち直すフォルダの外のファイルを前後で比べる。一時フォルダの残りも見る）。2段 `state.test.mjs`「直すときも、記録は COPILOT_HOME の下にだけでき…」、`test_REQ_059_the_temporary_folder_is_removed_and_nothing_is_pushed`・`…the_temporary_folder_inside_the_plugin_is_never_committed`。外側の EVAL は作業フォルダの外（ホームや COPILOT_HOME）を比べていない |
| リモートに push されていない | ◎ | 外 `not-pushed`（origin の refs が同じ、git push を呼んでいない）。2段 同上 |

### REQ-060 直したことの説明

| 受け入れ基準 | 判定 | どう確かめたか |
| --- | --- | --- |
| 直した後に、上のものが示される（「〜ときは」のものは、そのときだけ） | ○ | 外 `explained` は 10 点のうち4つだけを見る（戻すやり方 `revert`、読ませるやり方「起動し直」、マーケットプレイスの一覧、版）。2段 `state.test.mjs`「直すときの状態の返り値に…足した・直した・外した決まりの4行が出る」。目：[602] に、変わったこと、決まりの足す・直す・外す、流用したもの、試験の結果、コミットと戻し方、試験のしかた、読ませ方（入れ方ごと）、一覧を手で直すこと、Issue を起票できるようにする手順、がすべてあった（元からあったテストと公開のプラグインは、当てはまらない）。示した戻すコマンドは、この回の状態では動かない（5.1） |

### REQ-061 変えたところの試験

| 受け入れ基準 | 判定 | どう確かめたか |
| --- | --- | --- |
| 直した後に、構造の検査と部品の試験の合否が示される | ○ | 目：[602] の「4. 試験の結果」。外 `stage1`・`stage2` は合否そのものを見るだけで、示したかは見ない。`explained` にも入っていない |
| リポジトリに、変えたところを試す課題と合否の基準が入っている | ◎ | 外 `tests-added`（T-02 に `bin: inputs/bin`、その下の kxtool、device-history.log を見る program の基準）。2段 `record-tools.test.mjs`「変えたところを試す課題が1つ以上ないと断る」（D17）。1段 `test_REQ_061_a_task_with_the_fake_device_folder_bin_passes`・`…bin_may_only_be_inputs_bin…`・`…agent_ran_needs_an_agent_of_this_plugin`。test-plugin の `tasks.test.mjs`・`run.test.mjs`・`grade.test.mjs` の REQ-061 |
| 課題のなかった元のプラグインでは、作業全体を試す課題と基準も入っている | × | 外側の EVAL の題材は課題を持つ（D25）。2段 `record-tools.test.mjs`（D32）は、作っていないプラグインで課題2つの確認を受け付けることだけを見る。確認の関門は、作業全体を試す課題があることを求めない（スクリプトで見分けられないため、`change-confirm.md` の手順で守る。BLUEPRINT 1.2） |
| 変えたところを壊したプラグインで EVAL を行うと、足した課題の基準が不合格になる | × | この容器に Copilot CLI がなく、test-plugin の EVAL を動かせない（BLUEPRINT 1.2・D34）。足した課題 T-02 の基準（13個。C-02〜C-14）は、正しいプラグインで合格するかも一度も動かしていない |
| 本物の機器に頼る変更では、EVAL で本物の機器に何も送られない。確認で示されている | ○ | 送らない仕組み：2段 `run.test.mjs`「課題に bin があれば、あり・なしの両方で…PATH の先頭に足す」、`tasks.test.mjs`「Windows では bin のある課題を…課題の誤りにする」、1段の bin の検査、外 `tests-added`。`<P5>` の2段目に擬似の機器のスクリプトの試験（`test_req112_pseudo_kx200_tools.py` の14件）がある（D34）。確認で示すこと：外 `confirm-contents`（「擬似」）、目 [439]「本物のボードへの転送・書き込みそのものは試せません」。test-plugin で T-02 を実際に動かして、何も送られないことは確かめていない |

### REQ-062 部品の独立性（出力の要件）

| 受け入れ基準 | 判定 | どう確かめたか |
| --- | --- | --- |
| 入口のほかのスキルのフォルダを1つだけ取り出しても、Agent Skills の検査に通り、本文が指すファイルがすべてフォルダの中にある | ◎ | 1段 `test_REQ_062_a_rule_skill_folder_taken_out_alone_passes_the_skill_check` ほか、外へのパス・足りない参照・ルートに置いたスクリプトを落とす試験（23件）。外 `stage1`（`<P5>` の検査 standalone が合格） |
| 入口のほかのスキルの仕事を、統括を始めずにチャットで頼むと、そのスキルの決まりどおりに行われる | ○ | 内B（直したプラグインの cross-compile-rules・deploy-rules で 5/5）。作る流れで作った生成プラグインでは試していない（BLUEPRINT 2章の「作る流れの外側の EVAL（取り直し）」は、ひな形を変えた後に行われていない。`<scratchpad>/runs/` に作る流れの実行がない） |
| スキルに書いた決まりの文が、エージェントの定義やほかのスキルに書き写されていない | ◎ | 1段 `test_REQ_062_a_rule_text_copied_into_an_agent_fails`・`…one_copied_sentence_of_a_longer_rule_fails`・`…a_rule_text_copied_into_another_skill_fails`。外 `stage1`（standalone が合格）。短い文は比べない（`…short_rule_texts_are_not_compared`）ので、その範囲での確かめ |
| 生成プラグインのスクリプトを、コマンドラインから単体で動かせる | ○ | 流用した kx-build.sh・mkkximg.py：`tests/dev-eval/personas/test_dummy_skills.py`（`--help`、誤った引数で 2、ELF でないと 3、書けないと 4 など）。`<P5>` には同じ中身で入っている（外 `assets-reused` が sha256 で確かめた）。擬似の機器のスクリプトは `<P5>` の `test_req112_pseudo_kx200_tools.py`、元からのスクリプトは `test_req101`〜`105`。すべてのスクリプトが単体で動くかを見る構造の検査はなく、作業エージェントの決まり（D10）で守る |

### 今回文を足した要件（REQ-021・032・043・044・049）

| 要件の足した部分 | 判定 | どう確かめたか |
| --- | --- | --- |
| REQ-021：直すときは元のフォルダを直し（REQ-059 による）、記録は COPILOT_HOME の中だけ | ◎ | 2段 `state.test.mjs`「直すときも、記録は COPILOT_HOME の下にだけでき、直すプラグインのフォルダの中身は変わらない」。外 `nothing-outside`、`no-new-folder`。5回目の記録は `<run5>/copilot-home/…/state.json` にある |
| REQ-032：「作り直したい」だけの頼みでは、どちらにするかを聞く | × | REQ-052 の6つ目と同じ。呼 `rebuild-only` はスキルの選び方だけ |
| REQ-043：改善の対話でも URL が示される。まだ聞いていない項目と分けて、変えないので聞かない項目が示される | ◎ | 外 `screen-url-shown`（[13]）。2段 `screen.test.mjs`・`screen.browser.test.mjs` の REQ-056・REQ-043 |
| REQ-044：改善の直す前の確認で示すものが画面で見られる | ○ | 2段 `screen.test.mjs`・`screen.browser.test.mjs`「REQ-057 REQ-044 …」（作り例の記録で）。外側の EVAL では画面を開いていない。記録の `confirmation.rebuild` が埋まったことは `confirm-contents` で見た |
| REQ-049：改善でも、変えるところを聞いた後に自分から話したナレッジか、確認で足したナレッジがあると、Issue の案が示される | ○ | 2段 `record-tools.test.mjs`「『変えないので聞かない』の聞くことは未着手に数えず…その聞くことに自分から話した決まりは、質問の改善案の対象にならない」（聞いた後に話した決まりは対象になる、も同じ試験で見る）。目：5回目は「分からない」と答えた問いの案を1件示し、承認で起票した（偽の gh。[602]〜[612]）。5回目の決まりは `itemTouchedAtRecord` がすべて false で、この受け入れ基準の場面は起きていない |

## 3. 確かめていない受け入れ基準と、その理由

| 受け入れ基準 | 理由 | 確かめるのに要るもの |
| --- | --- | --- |
| REQ-052：`/plugin-creator:change-plugin` で始められる | 呼ばれ方の試験は、モデルが最初に呼ぶスキルを見るだけで、ユーザーが打つスラッシュコマンドを試さない。Claude Code と Copilot CLI でスラッシュコマンドの名前の付き方が同じかも確かめていない | Copilot CLI の実物（プラグインを入れて `/plugin-creator:change-plugin` と打つ） |
| REQ-052：検証エージェントをなくす頼み・共通部分の配色を変える頼みを断り、理由を示す | 外側の EVAL の頼みに入れていない（D25。費用と時間）。呼ばれ方の試験は最初のスキルの呼び出しで止めるので、断る文が見えない | 頼みを変えた外側の EVAL か、ユーザー役なしの短い実行（頼み1つで最初の返事を見る） |
| REQ-052・REQ-032：「作り直したい」だけの頼みで、どちらにするかを聞く | 同上（最初の問いが見えない） | 同上 |
| REQ-054：作っていないプラグインの決まりを1件ずつ確かめ、違うものを入れない | 改善の模擬ユーザーは、クリエイターが作った embedded-debug-loop の1人だけ（D25） | 作っていないプラグインを題材にした改善の模擬ユーザー |
| REQ-061：課題のなかった元のプラグインに、作業全体を試す課題も入る | 同上。確認の関門は課題の中身を見分けられない | 同上 |
| REQ-061：壊したプラグインの EVAL で、足した課題の基準が落ちる | この容器に Copilot CLI がない（`which copilot` なし）。生成プラグインの EVAL（test-plugin）は Copilot CLI と Copilot のモデルで動く（D34） | Copilot CLI の実物と、壊した写しのプラグイン |

## 4. Claude Code での見込みにとどまること（Copilot CLI の実物が要る）

◎・○にしたもののうち、次は Claude Code（Agent SDK）での実行か、文書から決めた値での確かめであり、Copilot CLI の実物では確かめていない（BLUEPRINT 1.2 の最後から2つ目の行と同じ）。

- 日本語の description で change-plugin が呼ばれること（REQ-052。呼ばれ方の試験は Claude Code のモデルで動かした）。
- 起動したフォルダの外のファイルで許可の確認が出ること、インストールの写しとマーケットプレイスのキャッシュの場所（REQ-053。D39）。
- 同じ名前のスキルがあると、プラグインのスキルが黙って使われないこと（REQ-055 の名前の決まりの理由）。
- 隣のスキルのファイルや、インストールした写しのファイルを、作業エージェントが読めること（REQ-062。内A・内B は Claude Code に変換したプラグインで動かした）。
- `agent_ran` の基準が見るエージェントの名前の形（REQ-061 の4つ目の要件。2段目は記録の作り例で見ただけ）。
- 直したプラグインの EVAL を test-plugin で動かすこと全体（REQ-061）。
- 作業の画面とクリエイターの画面が、Copilot CLI のエクステンションとして動くこと（REQ-043・044・059 の出力の要件）。

## 5. 点検で気づいたこと

### 5.1 示す「直す前に戻すコマンド」が、ほかのフォルダに git add した変更があると失敗する

- `skills/make-plugin/scripts/scaffold.py` 2611行が `git -C <P> revert --no-edit <コミット>` を返し、change-apply.md の7でそのまま示す。5回目も [602] に `git -C market/plugins/embedded-debug-loop revert --no-edit b41f4ce…` と示した。
- git の revert は、インデックス（git add した中身）が HEAD と違うと、場所に関係なく断る。試した結果（`<scratchpad>/revert-probe/`、git 2.43.0）：ほかのフォルダの README.md を git add した状態では `error: your local changes would be overwritten by revert.` で終了コード 128。git add せずに変えただけなら成功する。
- 5回目の作業フォルダは、終わった後も `M  README.md`（git add したまま）である（`git -C <run5>/work/market status --porcelain`）。この状態は REQ-053 の5つ目（ほかのフォルダだけの変更では止まらない）が認め、REQ-059 の5つ目がそのまま残すことを求める。
- 2段目の `test_REQ_059_reverting_the_commit_gives_back_the_plugin_before_the_change` は、ほかに変更のない状態でだけ戻している。外側の EVAL は、戻すコマンドを動かしていない（`explained` は「revert」の文字を見るだけ）。
- 直す案：フォルダに絞って戻すコマンドにする（例：`git -C <P> restore --source=<コミット>^ --staged --worktree -- . && git -C <P> commit -m "…を戻す" -- .`。同じ状態で成功することを上の場所で確かめた）か、ほかに git add した変更があるときは先に退避するよう添える。どちらの場合も、ほかのフォルダに git add した変更がある状態で、示したコマンドを動かす2段目の試験を足す。

### 5.2 自動の採点が、示すものの一部しか見ていない

- REQ-060：`explained` は10点のうち4点だけ。REQ-061 の1つ目（試験の合否を示す）も採点していない。5回目は目で見てすべてあったが、次に崩れても落ちない。
- REQ-057 の1つ目：`confirm-contents` は「新しい版」「土台」「擬似」「課題」の言葉と、記録の引き継ぐこと・変わることが空でないことだけを見る。決まりの一覧、振る舞いの案、合否の基準は見ていない。
- REQ-055 の1つ目：確認の質問が出たかは参考の記録（trace）にだけあり、合否に入らない。
- REQ-056 の1つ目：変えない項目を聞き直していないかは、画面の問いの正規表現でだけ見る。

### 5.3 作っていないプラグインの流れは、外側の EVAL で一度も通していない

REQ-052 の3つ目、REQ-054 の5つ目、REQ-056 の4つ目、REQ-057 の作っていないプラグインのときの項目、REQ-061 の3つ目、REQ-060 の「元からあったテスト」が、2段目の仕組みの試験だけである。作っていないプラグインの流れは、作業エージェント A・B がすべての差し込み口を書くなど、生成プラグインの流れと手順が大きく違う（D31）。

### 5.4 作る流れの外側の EVAL を取り直していない

ひな形（統括への最初の指示にプラグインのフォルダの絶対パス、エージェントの決まった文、構造の検査 standalone・knowledge・bin・agent_ran、`.gitignore`）を変えたが、作る流れの外側の EVAL は、この作業の中で動かしていない。BLUEPRINT 2章の REQ-062 の行は「作る流れの外側の EVAL（取り直し）」を試験に挙げている。作る流れで作った生成プラグインが REQ-062 の2つ目（統括なしでルールのスキルが使える）を満たすかは、確かめていない。

### 5.5 作る流れの要件から引き継ぐ基準（REQ-052 の前置き「ここに書いていないことは作る流れの要件と同じ」）

- REQ-024（説明のない専門用語がない、同じことを繰り返さない）：改善の採点では数えるだけで、合否に入らない。5回目は英語の一言が7件で、`<W>`・`<P>`・tag・diff などの内部の言葉を含む。同じことを2〜3回答えさせた所が6か所ある（`final-review-flow-and-conversation.md` 2章・3章）。
- REQ-023 の答えが来ないとき・質問のツールがない起動での振る舞い：改善の流れでの試験はない（change-plugin は make-plugin の SKILL.md の節を読んで使う。D23）。
- これからの流れを最初の問いより前に示すこと（設計 `docs/design/hearing.md` 168行・250行。受け入れ基準ではない）：1〜5回目のすべてで示されていない（flowShown false）。

### 5.6 外側の EVAL の合格は1回だけ

すべての観点が合格したのは5回目（腕 with、1回）だけである。保存した報告の点数と落ちた観点は、1回目 0.94（`rules-list-once`・`unchanged-items`）、2回目 0.97（`last-time-asked`）、3回目 0.92（`screen-url-shown`・`not-embedded:dp-ip`・`stage2`〔ディスクがいっぱい〕）、4回目 0.95（`confirm-contents`・`added-rule-confirmed`）で、毎回ちがう観点が落ちている（どれもその後に直した）。同じ直しで、もう一度合格するかは確かめていない。

## 付録：確かめに使ったもの

- 試験の名前の検索：`grep -rnoE "REQ[-_]0(5[2-9]|6[0-2])"`（`tests/`、`template/tests/`）。
- 5回目の採点：`<run5>/record.json` の `grading.grades`、会話は `items`（[154]・[169]・[187]・[435]・[439]・[446]・[602]・[604]〜[612]）。
- 直したプラグインの試験の結果：`<P5>/tests/results/latest.json`。
- 内側の確かめ：`wip/change-plugin/runs/inner-5-result.json`、`<scratchpad>/runs/edl-after-5`。
- 呼ばれ方の試験：`<scratchpad>/runs/trigger-1.log`、`tests/dev-eval/trigger/cases.json`。
- 戻すコマンドの試し：`<scratchpad>/revert-probe/`（この点検のために作った小さなリポジトリ。plugin-creator と実行の記録は変えていない）。
