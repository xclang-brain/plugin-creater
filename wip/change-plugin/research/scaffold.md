# 調査：組み立て（scaffold.py）・ひな形・構造の検査と、改善・設計変更（change-plugin）の適用の設計案

- 日付：2026-10-26
- 範囲：`skills/make-plugin/scripts/scaffold.py`（全サブコマンド）、`template/`、`template/tests/stage1/check_structure.py`（ナレッジの番号と EVAL の課題の検査）、`tests/creator/scaffold/*`、`skills/make-plugin/references/generate.md`。
- この調査では、リポジトリのファイルを変えていない。試しの作業はすべてスクラッチパッドの写しで行った（`/tmp/claude-0/-home-user/64a230fb-e6a2-510f-9e7e-9e6600fd34a8/scratchpad/research-scratch/`）。
- 行番号は 2026-10-26 時点（コミット 2bc67f6）のもの。

## 0. 結論（先に）

1. 今の build は「まだないフォルダに、ひな形から全部を描いて、git init して最初のコミット」しかできない（scaffold.py:753-770、1147-1150、1096-1105）。既存のフォルダを直す道はない。
2. 土台の比べ合い（check-base）は、エクステンションのフォルダ（`com.github.copilot/extensions/<名前>/`）しか見ない（scaffold.py:969-1022）。embedded-debug-loop で `check-base --restore` だけを行うと、古い 2段目の試験（`tests/stage2/adapter`・`core`）が 257 件中 142 件落ちた。土台を上げるときは、`tests/` の土台のファイルも一緒に入れ直す必要がある（同じ写しでテストの土台も入れ直すと、1段目は合格、2段目の adapter・core は 295 件すべて合格、tests/stage2/task の 34 件も合格）。
3. 差し込み口の文は、既存の生成プラグインから機械的に取り出せる。今のひな形で描き直しても、差し込み口の中身は失われず、差分は土台の変更だけになった（embedded-debug-loop で試作して確かめた。4.3）。土台を上げる方法は「取り出して、今のひな形で描き直す」がよい。この差分が、そのまま REQ-057 の「土台を今の版に上げることと、それで変わること」になる。
4. 決まりの番号（REQ-058）は、`tests/knowledge.json` に外した番号を `"removed": true`（中身を直したときは `"replacedBy"` も）で残す形を勧める。2回目の改善・設計変更でも、ファイル1つで「これまでに使った番号」が分かる。
5. git は、プラグインのフォルダで `add -A -- .` と `commit --only -- .`（同じ pathspec）を使えば、ほかのフォルダで git add 済みの変更をコミットに入れない。スクラッチで確かめた（4.7）。
6. タグ `plugin-creator-generated` は、リポジトリの直下のプラグインならそのまま使えるが、大きなリポジトリの中のフォルダでは、フォルダごとに別の名前が要る。`plugin-creator-generated/<パス>` は、同じリポジトリに `plugin-creator-generated` があると作れない（git の参照の制約。4.8 で確かめた）。
7. Copilot CLI がインストールで持つ写しの場所は、公式ドキュメントで分かった：`~/.copilot/installed-plugins/<マーケットプレイス>/<プラグイン>`、`~/.copilot/installed-plugins/_direct/<ソースの ID>/`、キャッシュ `~/.cache/copilot/marketplaces/`（Linux）など（4.1）。

## 1. 組み立ての流れ（build）

入口：`python3 scaffold.py build --hearing <state.json> --work <作業フォルダ>/.plugin-creator-work --out <作業フォルダ>/<名前>`（scaffold.py:4-6、1250-1253、1259-1260）。標準出力に JSON を1つだけ出す。終了コード 0 成功、1 断った・失敗、2 使い方の誤り（scaffold.py:38）。

| 順 | すること | 場所 |
| --- | --- | --- |
| 1 | パスを絶対にし、ひな形は `DEFAULT_TEMPLATE`（`skills/make-plugin/scripts/` から見て `../../../template`）、日付は今日 | scaffold.py:1112-1114、58 |
| 2 | 関門：記録を読み、段階が「生成」（`stage == "generate"`）、`approvedAt` があり、`confirmation` が辞書であること。違えば断る | `load_state` scaffold.py:181-198 |
| 3 | 状態が「決まった」（`status == "decided"`）のナレッジだけを記録の順に取り出す。番号は `^K-[0-9]+$`、種類は criterion か other、文は空でない、番号は重ならない。項目は `itemName`、なければ `item` | `decided_knowledge` scaffold.py:201-236 |
| 4 | 合否の基準を作る。criterion のナレッジを順に `C-01` から番号を振り、文はナレッジのまま、`knowledge` にナレッジの番号。1件もなければ断る | `make_criteria` scaffold.py:239-248 |
| 5 | `parts/manifest.json` を確かめる（知らない項目、名前の形、`plugin-creator` の名前の禁止、入口のスキル、作業エージェント、検証・統括の extra_tools、eval_inputs） | `load_manifest` scaffold.py:318-411、`MANIFEST_KEYS` 93 |
| 6 | `parts/task.json` に criteria があれば断る。`name`・`maxIterationsDefault`・`criteria`（4で作ったもの）を先に並べ、残りを足す。jsonschema と PyYAML があれば `core/task.schema.json` で確かめる。manifest と task の作業エージェントの名前・呼び名の一致 | `load_task` scaffold.py:438-487 |
| 7 | `parts/slots/<名前>.md` を読む。空・名前の誤りは断る。`entry-task` などひな形の `##` の節に入る文は `#`・`##` の見出しを断る | `load_slots` scaffold.py:503-533、`HEADING_SLOTS` 81 |
| 8 | `parts/files/` の下を列挙（`.git`・`.plugin-creator-work`・シンボリックリンクは断る。キャッシュは飛ばす） | `list_parts_files` scaffold.py:536-563 |
| 9 | EVAL の課題（`tests/eval/*/eval.json`）の criteria に、作業の定義の基準の番号と文を写す。作業エージェントは `knowledge`（か `id`）と採点のしかただけを書く | `prepare_eval` scaffold.py:587-640、`resolve_criterion` 566-584 |
| 10 | eval_inputs と parts/files の同じ場所を断る。誤りがなければ、確かめた課題（`confirmation.evalTasks`）と eval.json を突き合わせる：課題の数、頼むときの言葉、基準のナレッジの組、入力、設定の値。確かめていない課題や入力は断る | scaffold.py:1127-1132、`check_confirmed_evals` 690-745、`eval_differences` 668-687、`confirmed_eval_tasks` 643-665 |
| 11 | 出力先：`--work` の名前が `.plugin-creator-work`、出力先がまだない、作業フォルダ（`--work` の親）の中、作業用の一時フォルダの中でない、親がある | `check_output_path` scaffold.py:753-770 |
| 12 | ここまでの問題があれば、まとめて断る | scaffold.py:1134-1135 |
| 13 | 決まった値：`plugin_name`、`plugin_description`、`marketplace_name`（＝プラグインの名前）、`generated_date`、`entry_skill_name`、`entry_skill_description` | scaffold.py:1138-1145 |
| 14 | `os.mkdir(out)`（すでにあれば失敗させ、今あるフォルダを消さない） | scaffold.py:1147-1150 |
| 15 | ひな形をそのまま写す（キャッシュと `tests/results` は飛ばす） | scaffold.py:1152、`make_ignore` 166-178 |
| 16 | `_plugin_` → プラグインの名前、`_entry_` → 入口のスキルの名前 | scaffold.py:1155-1160 |
| 17 | 作業エージェントごとに `worker.agent.md` から `<agent>.agent.md` を作る（`{{slot:worker-task}}` → `{{slot:worker-task.<agent>}}`、フロントマターの name）。`worker` が一覧になければ元を消す | scaffold.py:1162-1172、`worker_copy` 792-799 |
| 18 | 差し込み口を埋める：文（`apply_slots`）→ 行ごとの差し込み口（tools の作業ごとの分、統括の作業エージェントの一覧）→ 決まった値（JSON・YAML のフロントマターに合わせて書き方を変える）。土台（エクステンションのフォルダ）は書き換えない。残った差し込み口は断る | `fill_template` scaffold.py:882-939、`apply_slots` 802-825、`apply_line_tokens` 828-846、`apply_values` 864-879、`yaml_value` 849-861、`line_token_map` 942-959 |
| 19 | `task.json` をエクステンションのフォルダに、`tests/knowledge.json` を書く（`{id, kind, item, text}` だけ） | scaffold.py:1179-1183 |
| 20 | parts/files と eval_inputs の行き先が、ひな形・組み立てのファイルと重なれば断る。parts/files は `copy2`（実行の印を残す）、eval.json は9で埋めた文、eval_inputs は `copyfile` | scaffold.py:1185-1203 |
| 21 | 土台がひな形と同じかを確かめる（違えば、ひな形かスクリプトの誤りとして断る） | scaffold.py:1205-1208 |
| 22 | `git init -q` → `git add -A` → `git -c commit.gpgsign=false [-c user.name=plugin-creator -c user.email=plugin-creator@localhost] commit -q --no-verify -m "生成プラグイン <名前> を plugin-creator で組み立てた"` → `rev-parse HEAD` | `first_commit` scaffold.py:1096-1105、`git` 1077-1086（`GIT_DIR` などの環境変数を外し、`GIT_TERMINAL_PROMPT=0`、120秒） |
| 23 | 14〜22 のどこかで失敗したら、出力先を消して投げ直す（作業用の一時フォルダは残す） | scaffold.py:1211-1213 |
| 24 | 成功したら `.plugin-creator-work/` を消す。消せなければ注意に足す | scaffold.py:1215-1220 |
| 25 | 結果の JSON：`ok, out, plugin_name, marketplace_name, entry_skill, workers, criteria[{id,knowledge}], knowledge{criterion,other}, eval_inputs, commit, work_folder_removed, warnings` | scaffold.py:1222-1236 |

- タグは build では付けない。生成の段階の 4.7 で、メインのエージェントがシェルで付ける：直しがあれば `git -C <フォルダ> add -A` と `commit --no-verify -m "plugin-creator: 試験に合わせて直す"`、続けて `git -C <フォルダ> tag -f plugin-creator-generated`（generate.md:68-70）。
- コンパクションの後の続け方は、`.plugin-creator-work/` の有無と、最初のコミットの説明と、タグの有無で決める（generate.md:6-8）。
- 入力の置き場所：`.plugin-creator-work/draft/task.json`（生成前の確認で示す作業の定義の案。generate.md:25）、`.plugin-creator-work/parts/{manifest.json, task.json, slots/, files/}`（generate.md:24-30）。ヒアリングの記録は `<COPILOT_HOME か ~/.copilot>/plugin-data/plugin-creator/hearings/<セッション>/state.json`（`com.github.copilot/extensions/plugin-creator/store.mjs:3-6、18-29`）。

### 注意しておくこと

- eval_inputs の実物は `shutil.copyfile` で写すので、実行の印が消える（scaffold.py:1203）。擬似の機器（エミュレーター）を動かすシェルのスクリプトを課題の入力の実物として渡すと、実行できない形で入る。`copy2` にするか、`sh <スクリプト>` で呼ぶ形にする。
- `fill_template` はひな形を写したフォルダ全体を歩くが、parts/files はその後で写すので、parts/files の中の `{{…}}` は置き換えない（scaffold.py:1175 と 1193-1199 の順。試験 `test_BLUEPRINT_8_text_in_the_files_is_not_touched_even_if_it_looks_like_a_placeholder`）。
- ひな形の `plugin.json` は `"version": "0.1.0"` を決め打ちしている（template/plugin.json）。描き直すと版が 0.1.0 に戻るので、改善・設計変更では上書きが要る。
- ひな形の憲章の由来は「plugin-creator 憲章 0.25.0」のまま（template/docs/constitution.md:4、106）。クリエイター憲章は 0.26.0 だが、0.26.0 の改訂は第3章と第4条だけで、生成プラグインの憲章に写す第2章・第4章は変わっていない。

## 2. check-base と --restore

- 使い方：`python3 scaffold.py check-base --out <生成プラグイン> [--restore]`（scaffold.py:1254-1256、1262）。
- 比べるもの：ひな形の `com.github.copilot/extensions/_plugin_/` の下のすべてのファイル（キャッシュと `tests/results` を飛ばす）（`template_base` scaffold.py:969-983）。
- 生成プラグインの側は、`plugin.json` の `name` で `com.github.copilot/extensions/<name>/` を探す。読めなければ断る（scaffold.py:990-996）。
- 違いの種類（`compare_base` scaffold.py:986-1022）：
  - `missing`：ひな形にあるのにない
  - `changed`：バイトが違う
  - `extra`：ひな形のフォルダ（core/、ui/ など、ひな形のエクステンションの直下のフォルダ）の中にある、ひな形にないファイル。直下のファイル（`task.json` や作業ごとのファイル）は違いにしない（試験 `test_REQ_039_files_outside_the_base_folders_are_left_alone` test_scaffold.py:1252-1258）。
- `--restore`（`restore_base` scaffold.py:1025-1045）：changed・missing はひな形から `copy2`、extra は消して、空になったフォルダも片付ける。そのあと比べ直し、`ok` は残った違いがないこと（`check_base` 1048-1059）。結果 `{ok, plugin, differences, restored, remaining}`。終了コードは `ok` で 0／1（1272）。
- 使われ方：生成の後の直しのたびに比べ、違えば不合格として `--restore` し、土台を変えずに直すよう作業エージェントに伝える（generate.md:65。creator-structure.md:193）。生成プラグインの1段目では確かめない（generated-plugin-structure.md:919）。
- 見ないもの：`tests/run.py`、`tests/stage1/`、`tests/stage2/{adapter,core,ui}/`、`tests/stage2/fake-*.mjs`、`.gitignore`、エージェントの決まった手順、入口のスキル、README、憲章・仕様書・設計書のひな形の部分。

### embedded-debug-loop で確かめたこと（スクラッチの写し）

- `check-base`（読むだけ）：`ok: false`。違いは 18 件：changed が adapter.mjs、core の analysis・constants・events・index・lifecycle・records・run・task-def・tools、ui の app.mjs・server.mjs・static/app.js・static/style.css。missing が core/human.mjs と ui/static/fonts の3ファイル。`core/task.schema.json` は同じだった。
- `check-base --restore` だけをした写しで、プラグインの中の古い 2段目を動かした：`node --test tests/stage2/adapter/*.test.mjs tests/stage2/core/*.test.mjs` が 257 件中 **142 件不合格**。1段目は合格。
- `--restore` に加えて、ひな形の `tests/run.py`、`tests/stage1/`、`tests/stage2/adapter/`、`core/`、`ui/`、`fake-clock.mjs`、`fake-port.mjs`、`.gitignore` を写した写しでは、1段目は合格、adapter・core は 295 件すべて合格、`tests/stage2/task` の Python の試験 34 件も合格。ui は Playwright がないので動かしていない（`tests/run.py` は Playwright とブラウザーがないと止まる）。
- 比べ合いの結果：ひな形と食い違う `tests/` のファイルは、`tests/stage1/check_structure.py` と `tests/stage2/` の 17 ファイル（human.test.mjs はない）。`tests/run.py` は同じ。プラグインの側にだけある土台の試験のファイルはなかった。

→ 土台を上げるときに入れ直すものは、エクステンションの土台だけでなく、`tests/` の土台のファイルも要る。そうしないと、2段目が土台と試験の版の食い違いで落ち、作業エージェントが直そうとして土台や試験を書き換えるおそれがある。

## 3. knowledge.json、task.json、EVAL の課題の書き方と検査

### 書くとき（scaffold.py）

- `tests/knowledge.json`：決まったナレッジだけを、`[{"id","kind","item","text"}]` で書く（scaffold.py:1182-1183）。出どころ・例・例外・外したものは入らない。番号はヒアリングの記録の番号（`K-01` から。エクステンションの `knowledgeCounter`）。
- `task.json`：criteria は criterion のナレッジから `C-01` から順に振る（scaffold.py:239-248）。ナレッジの番号の順ではなく、記録の順で数える。例：sample では K-01 → C-01、K-03 → C-02（test_scaffold.py:1296）。
- eval.json：作業エージェントは criteria に `knowledge`（か `id`）と `grading`・`check` を書き、組み立てが `id` と `text` を作業の定義の写しで入れる（scaffold.py:587-640）。`id` を書いたときは、作業の定義の番号で引き、`knowledge` と合わなければ断る（566-584）。
- 確かめた課題との突き合わせ（scaffold.py:690-745）：
  - 課題は `prompt` で結ぶ（記録の課題に番号はない）。同じ言葉が2つあれば中身で選ぶ。
  - 入力：`provisional: true` の入力は、生成プラグインの中の場所（`tests/eval/<課題>/inputs/<名前>`）。そうでない入力は実物の絶対パスで、eval_inputs の from と結ぶ。
  - 確かめていない課題・入力のファイルは断る（738-745）。
  - 基準が、どの課題にも入っていなければ注意（639）。1段目で不合格になる。

### 検査するとき（check_structure.py）

- `check_task`（check_structure.py:693-737）：task.schema.json に合う。criteria の id、workers の agent、settings・displays の key の重なり。作業エージェントのファイルがある。選択肢の初めの値。
- `check_eval`（1150-1226）：
  - `tests/eval/<課題>/eval.json` が1つ以上ある。形（`eval_task_problems` 874-928：id、prompt、inputs は課題のフォルダの中の相対の場所、settings、criteria の id・text・grading・check）。
  - 課題の id の重なり。入力のファイルがある（`input_problems` 975-）。入力のままで合格してしまう採点がない（`input_check_problems` 1089-、node で正規表現を確かめる）。
  - settings.task が作業の定義の設定に合う（`settings_problems` 945-）。
  - criteria の id が作業の定義にあり、文が同じ（1200-1210）。作業の定義のすべての基準が、どれかの課題に写されている（1224-1226）。
- `check_knowledge`（1255-1297）：
  - `tests/knowledge.json` があり、リストで、各項目の id が `K-数字`、kind が criterion か other、text が空でない、id が重ならない（1268-1282）。
  - criterion のナレッジは、作業の定義の criteria の `knowledge` にある（1290-1291）。
  - other のナレッジは、作業の定義とテストのフォルダ（直下の `tests/`）を除く文字のファイルのどこかに番号がある（1292-1293、`knowledge_tokens_outside_tests` 1234-1252。番号の字は `(?<![A-Za-z0-9_-])K-[0-9]+(?![0-9])` 1230）。
  - 作業の定義の基準の `knowledge` が、一覧にある criterion の番号である（1294-1297）。
  - **見ていないもの**：一覧にない番号がファイルに書かれていること（例：外した番号、存在しない番号）。番号の意味の対応。

## 4. 改善・設計変更の適用の設計案（最小）

### 4.1 始める前の確かめ（REQ-053）

サブコマンド `change-check` を足す（読むだけ。対話を始めるときと、直し始める直前の両方で使う）。

```
python3 scaffold.py change-check --plugin <元のプラグイン> --cwd <作業フォルダ> [--hearing <state.json>]
→ {"ok": true, "plugin": ..., "repo_root": ..., "prefix": "plugins/embedded-debug-loop/", "tag": ..., "generated": true/false, ...}
→ {"ok": false, "problems": [直し方つきの平易な文, ...]}
```

確かめる順と、使うもの：

1. フォルダがあり、プラグインのマニフェストがある：`plugin.json`（Agent Plugins）か、以前の形式の `.plugin/plugin.json`・`.github/plugin/plugin.json`・`.claude-plugin/plugin.json`（公式の plugin reference の File locations：「Legacy plugins: `.plugin/plugin.json`, `plugin.json`, `.github/plugin/plugin.json`, or `.claude-plugin/plugin.json` (checked in this order).」）。
2. 作業フォルダの中か、作業フォルダそのもの：`real(plugin) == real(cwd)` か `is_inside(plugin, cwd)`。今の `is_inside` は同じフォルダを含まない（scaffold.py:125-131）ので、同じも許す別の関数が要る。`--cwd` は引数で受ける（シェルの今のフォルダとは限らないため。build は `--work` の親を作業フォルダにしている：scaffold.py:761）。
3. インストールやマーケットプレイスの写しではない。次のどれかの中なら断り、元のリポジトリを手元に取ってきて、そのフォルダを示すよう伝える：
   - `<COPILOT_HOME>/installed-plugins/`（既定 `~/.copilot/installed-plugins/`）。公式：「`~/.copilot/installed-plugins/MARKETPLACE/PLUGIN-NAME` (installed via a marketplace) and `~/.copilot/installed-plugins/_direct/SOURCE-ID/` (installed directly)」（[plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference) の File locations）。設定フォルダの公式の説明：既定は `~/.copilot`、`COPILOT_HOME` で丸ごと替わる、`--config-dir`（以前の項目）が優先（[config dir reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)）。
   - `<COPILOT_HOME>/plugin-data/`（プラグインの実行時のデータ。公式：「Contains persistent data for installed plugins, organized by marketplace and plugin name.」）。
   - Copilot CLI のキャッシュのフォルダ（マーケットプレイスの写し）。公式：「Platform cache directory: `~/.cache/copilot/marketplaces/` (Linux), `~/Library/Caches/copilot/marketplaces/` (macOS). Overridable with `COPILOT_CACHE_HOME`.」。config dir reference：「The cache directory (used for marketplace caches, auto-update packages, and other ephemeral data) follows platform conventions and is not affected by `COPILOT_HOME`.」既定は macOS `~/Library/Caches/copilot`、Linux `$XDG_CACHE_HOME/copilot` か `~/.cache/copilot`、Windows `%LOCALAPPDATA%/copilot`。`COPILOT_CACHE_HOME` が `copilot` のフォルダ自体を指すのか、その親を指すのかは文書から読み取れなかった（要確認）。キャッシュのフォルダの中はどれもユーザーの元ではないので、`marketplaces/` に限らず、キャッシュのフォルダ全体を断るのが安全。
   - COPILOT_HOME の求め方：環境変数 `COPILOT_HOME`、なければ `~/.copilot`。`--hearing` があれば、`state.json` の5つ上（`<COPILOT_HOME>/plugin-data/plugin-creator/hearings/<セッション>/state.json`。store.mjs:18-29）も使う（ユーザーが `--config-dir` で起動したときも分かる）。`~/.copilot` は COPILOT_HOME があっても併せて見る。
   - 注意：手元のフォルダのマーケットプレイスから入れたプラグインは写しではなく、そのフォルダを直接読む（公式：「Path-sourced plugins in a local (directory-source) marketplace load live from their real directory」。ナレッジ `plugins.md:56`）。この場合は元のフォルダなので、断らない。
   - キャッシュの写しは git のクローンのことがあり、4・5 の git の確かめを通ってしまう。場所で断る確かめは省けない。
4. git のリポジトリの中：プラグインのフォルダで `git rev-parse --show-toplevel --show-prefix`。失敗なら断る（git がないときは、build と同じ文で断る：scaffold.py:1083-1084）。
5. git で管理されている：`git ls-files --error-unmatch -- <マニフェスト>`。さらに `git ls-files --others --ignored --exclude-standard -- .` で、.gitignore で外されたファイルを探し、ひな形の .gitignore と同じもの（`tests/.venv/`、`tests/node_modules/`、`tests/results/`、`__pycache__/`）と `.plugin-creator-work/` を除いて残れば断る。外されたファイルは、直してもコミットに入らず、戻せないため。embedded-debug-loop では外されたファイルはなかった。
6. コミットしていない変更がない：プラグインのフォルダで `git status --porcelain=v1 -z --untracked-files=all -- . ':(exclude).plugin-creator-work'`。何か出れば断る（変えたファイル、git add しただけのファイル、git に入れていないファイルをすべて含む）。フォルダの外は見ない（pathspec を `.` にしているため）。作業フォルダがプラグインのフォルダと同じときは、作業用の一時フォルダがプラグインのフォルダの中にできるので、除く。
7. （勧め）マージ・リベース・チェリーピックの途中でない：`git rev-parse -q --verify MERGE_HEAD`、`CHERRY_PICK_HEAD`、`REVERT_HEAD`、`git rev-parse --git-path rebase-merge`／`rebase-apply` の有無。マージの途中は `git commit --only <paths>` が断る（git の決まり：マージの途中は部分のコミットができない）ので、最後のコミットで初めて止まらないよう、始める前に断る。仕様の4項目にはないので、REQ-053 の「直す前の状態に git で戻せるようにする」の中の確かめとして設計書に書くか、仕様に足すかを決める。
8. 断ったときは何も書かない（読むだけのコマンドしか使わない）。

- git のコマンドは、`-C <プラグインのフォルダ>` で動かし、pathspec は `.` にする。リポジトリの根を引数に書かないので、作業フォルダの外の場所がコマンドに出ない（Copilot CLI のフォルダの許可の確認を減らす）。

### 4.2 流れ全体

| 段階 | 誰が | すること | プラグインのフォルダ |
| --- | --- | --- | --- |
| 対話の始め | メイン | `change-check` | 変えない |
| 直す前の確認 | メイン | `change-preview`（4.3）で、土台を上げることで変わることを出し、確認で示す。取り出しに失敗したところ、新しい task.schema.json に合わないところも、ここで示す（承認の後に初めて断られないため。ナレッジ `rebuild-weaknesses.md:10`） | 変えない |
| 承認の後 | スクリプト | `extract`（4.3）で `.plugin-creator-work/parts/` を元のプラグインから作る | 変えない |
| 承認の後 | メイン・作業エージェント | 変えるところだけ parts を直す（スロットの文、parts/files のスキルやスクリプト、task.json、manifest.json に作業エージェントを足すなど） | 変えない |
| 直す | スクリプト | `change`（4.4〜4.6）：直し始める直前の確かめ → 決まりの一覧の合わせ → 描き直し → 入れ替え → 版。コミットはしない | 変わる |
| 試験と直し | メイン・作業エージェント | 作るときと同じ（generate.md の4。`tests/run.py`、直しは3回まで、直すたびに `check-base`） | 変わる |
| コミット | スクリプト | `commit`（4.7、4.8）：フォルダの中だけをコミットし、タグを付ける（合格しても、上限で止めても、試験をしなかったときも） | コミット |

- 1つのコミットにまとめる理由：REQ-059 の受け入れ基準「そのコミットを戻すと、直す前と同じ中身になる」。build のように描いた直後にコミットすると、試験の直しと2つに分かれる。
- コンパクションの後：`.plugin-creator-work/` があれば `change` の前（`parts/` があれば extract の後）。なければ `change` は終わっている。フォルダに変更があり、タグが HEAD にないならコミットの前。タグが HEAD にあれば終わっている。

### 4.3 土台を上げる：取り出して、今のひな形で描き直す

方式：元の生成プラグインから、作業ごとの部分（差し込み口の文、作業ごとのファイル、作業の定義、組み立ての設定）を `parts/` の形で取り出し、今のひな形で build と同じに描き直す。

- 差し込み口の文の取り出し方（試作で確かめた）：
  - ひな形のファイルに決まった値を入れた文 T で、差し込み口の行のすぐ前の空でない行（例：`## 作業ごとの指示`）と、すぐ後の空でない行（例：`## 返す形`）を目印にする。
  - 元のファイル G で、前の目印の行を探し、その後の後の目印の行（なければファイルの終わり）までを、差し込み口の文とする。後の目印が見つからないときは、次の `## ` の見出しまでにする。
  - `task-trace`（設計書の追跡の表の作業ごとの行）は、表の行のうち要件の番号が REQ-101 以上の行にする（ひな形の仕様書の7章：「REQ-101 から番号を付け」template/docs/specs/requirements.md:263）。前の目印が古いひな形の最後の行と違うことがあるためである。
  - 作業エージェントの一覧は task.json の workers から、作業・検証の extra_tools は、元の定義の tools からひな形の tools を引いたもので作る。決まった値は、plugin.json（name、description）、入口のスキルのフロントマター、`.github/plugin/marketplace.json` の name、憲章の変更履歴の 1.0.0 の行の日付から取る。
  - 入口のスキルは、`<名前>_open` を書いているスキルとして見分ける（ひな形の入口のスキルの最後の節「`{{plugin_name}}_open` がないとき」template/skills/_entry_/SKILL.md:54）。
- 試作の結果（embedded-debug-loop、今のひな形）：
  - 10 の差し込み口がすべて目印で取り出せた（readme-what 1行、readme-how 21行、worker-task.worker 13行、worker-task.worker-b 13行、orchestrator-task 57行、verifier-task 7行、entry-task 3行、task-design 45行、task-trace 13行、task-requirements 80行）。
  - 描き直しの問題・注意は0件。
  - 描き直したものと元の差分：作業・検証のエージェント（worker、worker-b、verifier）、憲章、plugin.json、marketplace.json は差分なし。統括 +29 −6、入口のスキル +17 −6、README +11 −1、設計書 +57 −22、仕様書 +37 −6。中身は、人の判断待ち（REQ-051、`_ask`・`_answer`、設計書 3.8）、エージェントごとの思考の深さ、同梱のフォント、追跡の表の土台の行など、土台の変更だけだった。差し込み口の中身はなくならなかった。
  - 試作のスクリプト：`/tmp/claude-0/-home-user/64a230fb-e6a2-510f-9e7e-9e6600fd34a8/scratchpad/research-scratch/extract_proto.py`、差分：同じフォルダの `proto-out/*.diff`。
- 作業ごとのファイル（parts/files）にするもの：プラグインのフォルダで `git ls-files -z -- .` に出るファイル（git で管理しているもの。結果やキャッシュは入らない）のうち、ひな形と組み立てが作るファイルでないもの。ひな形と組み立てが作るファイルは、描き直したときの場所の一覧（ひな形の全ファイル、作業エージェントの定義、`task.json`、`tests/knowledge.json`）で決める。embedded-debug-loop では、`skills/cross-compile-rules/` などのルールのスキル、`scripts/`、`docs/customize-rules.md`、`docs/diagram-mock/`、`tests/eval/`、`tests/stage2/task/` が入る。
  - 土台のフォルダ（エクステンションの core/、ui/）の中で、ひな形にないファイルは、check-base と同じく土台として扱い、写さない（消える）。`tests/stage1/`・`tests/stage2/{adapter,core,ui}/` の中でひな形にないファイルは、作業ごとの試験かもしれないので写し、確認で示す。
- サブコマンド案：
  - `extract --plugin <元> --work <作業フォルダ>/.plugin-creator-work`：parts/ を作る。結果に、差し込み口ごとの取り出し方、取り出せなかった差し込み口、生成プラグインの形か（`generated`）を返す。
  - `change-preview --plugin <元> --work ...`：extract と描き直しを、作業用の一時フォルダの中の別の場所で行い、元との差分（ファイルごとに 足した・消した・変わった と行の数、変わる節の見出し）と、task.schema.json などの検査の問題を返す。確認の「土台を今の版に上げることと、それで変わること」に使う。
  - 実装は、build の 3〜21（scaffold.py:1116-1208）を「描く」関数に分け、build と change の両方から使う（同じことを2回書かない）。
- クリエイターが作っていないプラグインでは、差し込み口が取り出せない。extract は、マニフェストなど、ひな形が作るファイルと同じ場所のファイルを parts/files に入れず、一覧で返す（確認で「形式を移したために読まれなくなり消すファイル」として示す。REQ-057）。差し込み口の文、manifest.json、task.json は、作るときと同じく作業エージェントとメインのエージェントが書く。元からあったテストは parts/files に入れて残す（REQ-060）。

### 4.4 直す（`change`）

```
python3 scaffold.py change --hearing <state.json> --work <作業フォルダ>/.plugin-creator-work --plugin <元のプラグイン>
```

1. 関門：build と同じ（段階が「生成」、承認の時刻、確認）。加えて、確認に改善・設計変更の情報（下の「記録に要るもの」）がある。
2. 直し始める直前の確かめ：4.1 の 2〜7 をやり直す（`--cwd` は `--work` の親）。ここで断れば、何も変えない。
3. 決まりの一覧を合わせる（4.5）。合否の基準の番号を決める（4.5）。
4. manifest、task、slots、parts/files、EVAL の課題を build と同じく確かめる（scaffold.py:1119-1132）。課題の突き合わせは 4.6。
5. 名前の重なり（REQ-055）：記録の「取り込んだスキル」のフォルダの SKILL.md の `name`（なければフォルダの名前）が、描き直した後の `skills/` の下のフォルダの名前と同じなら断る。取り込んだスキルのフォルダがプラグインのフォルダの中にあるときは断る（入れ替えで中身が変わるため）。
6. 作業用の一時フォルダの中（例：`.plugin-creator-work/stage/<名前>/`）に描く。build の 14〜21。plugin.json の version を、ユーザーがよいと答えた版にする（ひな形は 0.1.0 を決め打ち）。決まった値の `generated_date` は、元の憲章の日付を使う。
7. 土台がひな形と同じか（scaffold.py:1205-1208 と同じ）。
8. 入れ替え：
   - プラグインのフォルダで git が管理しているファイル（`git ls-files -z -- . ':(exclude).plugin-creator-work'`）のうち、描いたものにないファイルを消す。
   - 描いたもののファイルを、すべてプラグインのフォルダに写す（`copy2`。実行の印を残す）。
   - .gitignore で外されたファイル（`tests/results/` など）と `.plugin-creator-work/` には触れない。
   - 途中で失敗したら、`git checkout HEAD -- .` と `git clean -fdq -- . ':(exclude).plugin-creator-work'` で元に戻す（始める前にフォルダがきれいなことを2で確かめているので、元と同じになる。外されたファイルは消さない）。これで REQ-053 の「止まっても、フォルダの中身は変わらない」を守れる。
9. 作業用の一時フォルダを消す。結果の JSON：消したファイル、足したファイル、変わったファイル、版、決まりの一覧の足した・直した・外した番号、注意。

記録に要るもの（エクステンションの確認のツールが記録し、change が読む。案）：

```json
"confirmation": {
  "...": "今と同じ（knowledgeIds、behavior、taskPath、evalTasks）",
  "change": {
    "plugin": "<元のプラグインの絶対パス>",
    "version": "0.2.0",
    "importedSkills": ["<取り込んだスキルのフォルダの絶対パス>"],
    "deleteFiles": ["<形式を移したために消すファイル（クリエイターが作っていないプラグインのとき）>"]
  }
}
```

- ナレッジの行に `replaces`（中身を直した元の番号）を足す。外した番号は「元の一覧にあり、記録で決まっていない番号」として change が求める（記録に別の欄を持たない）。

### 4.5 決まりの一覧（knowledge.json）の合わせ方と、外した番号の置き場所

外した番号の置き場所の案（勧める順）：

- 案A（勧め）：`tests/knowledge.json` に残す。外した決まりは `{"id": "K-07", "kind": "...", "item": "...", "text": "...", "removed": true, "replacedBy": "K-19"}`（`replacedBy` は中身を直したときだけ）。これまでに使った番号は、このファイルの番号すべて（外したものを含む）。2回目の改善・設計変更でも、ファイル1つで分かる。読む側（1段目、`tests/dev-eval/runner/control-creator.test.mjs:34` など）は、`removed` のものを飛ばすよう直す。
- 案B：別のファイル `tests/knowledge-removed.json`。今の読む側を変えずに済むが、ファイルが増え、使った番号の元が2つになる。

合わせ方（change の 3。元の一覧を O、記録の決まったナレッジを S とする）：

1. O の外していない番号は、S に同じ番号で入っているか（引き継ぎ）、S にないか（外す）のどちらか。S に同じ番号があるのに文が O と違えば断る（「中身を直した決まりは、新しい番号にする」REQ-058）。
2. S の新しい番号（O にない番号）は、O のすべての番号（外したものを含む）の最大より大きい。そうでなければ断る（REQ-058：足した決まりは、これまでに使ったどの番号よりも後）。
3. S の行に `replaces` があれば、その元の番号に `removed: true` と `replacedBy` を付ける。元の番号が O にない、または O で外してあれば断る。
4. O で前に外した番号は、そのまま残す。
5. 書く：引き継いだもの・足したもの（番号の順）、続けて外したもの。
6. 合否の基準の番号：引き継いだ criterion のナレッジは、元の task.json の `C-xx` をそのまま使う（元の task.json の `knowledge` → `id` の対応）。足したものは、元の task.json の C の番号の最大の次から振る。EVAL の課題の基準は `id` で結ばれている（embedded-debug-loop の T-01 の eval.json は `id` と `text` だけを持つ）ので、番号を振り直すと、引き継いだ課題の基準が別の基準を指す。今の `make_criteria`（scaffold.py:239-248）は毎回 C-01 から振るので、change では使えない。
   - 外した基準の C の番号は覚えておかない。同じ C の番号が後で別の文に使われても、1段目が EVAL の課題の基準の文と作業の定義の文を比べる（check_structure.py:1206-1208）ので、古い課題が残っていれば見つかる。
- エクステンションの側：引き継ぐナレッジを元の番号のまま記録に入れ、`knowledgeCounter` を O のすべての番号の最大にする必要がある（今は K-01 から：調査 `research-current-state.md` の extension-code の節）。change の 2 は、その結果を確かめる。

### 4.6 EVAL の課題の引き継ぎ（REQ-061）

- 元の `tests/eval/*/` は extract で parts/files に入る（eval.json と inputs）。
- 確認の `evalTasks` に、引き継ぐ課題と足す課題の両方を並べる。引き継ぐ課題の入力は、生成プラグインの中の場所（`tests/eval/T-01/inputs/...`）を `provisional: true`（または相対のパス）で書けば、今の突き合わせ（scaffold.py:708-719）がそのまま使える。
- 引き継ぐ課題の基準は、確かめた決まりに合わせて直す（外した決まりの基準を除く、直した決まりの基準に替える）。eval.json の基準は `id` で書かれているので、外した基準の `id` は `resolve_criterion` が断る（scaffold.py:571-573）。
- 足した課題が1つ以上あることを確かめる：確認の課題のうち、元の eval.json のどれとも頼むときの言葉が違うものが1つ以上。なければ断る（REQ-061「変えたところを試す課題と合否の基準を、1つ以上足す」）。
- 元に課題がないとき（クリエイターが作っていないプラグイン）は、作業全体を試す課題が要る。スクリプトでは「全体を試す」かを見分けられないので、確認の手順（メイン）で守る。
- 擬似の機器を動かすスクリプトを課題の入力にするときは、1章の注意（`copyfile` で実行の印が消える）。

### 4.7 コミット（`commit`）

```
python3 scaffold.py commit --plugin <元のプラグイン> --message "plugin-creator: <名前> を改善・設計変更した（0.1.0 → 0.2.0）"
```

- プラグインのフォルダで：
  1. `git add -A -- . ':(exclude).plugin-creator-work'`
  2. `git diff --cached --quiet -- .` で、コミットするものがなければ、コミットせずにそれを返す（`git commit` は何もないと失敗するため）。
  3. `git -c commit.gpgsign=false [-c user.name=plugin-creator -c user.email=plugin-creator@localhost] commit -q --no-verify -m <説明> -- . ':(exclude).plugin-creator-work'`（pathspec を付けると `--only` になり、ほかのフォルダで git add 済みの変更は入らず、git add されたまま残る）。名前・メールと署名・フックの扱いは build と同じ（scaffold.py:1100-1104）。
  4. タグ（4.8）。
  5. 結果：コミットの番号、タグの名前、直す前に戻すやり方（`git -C <フォルダ> revert --no-edit <コミット>`）。
- スクラッチで確かめたこと（`research-scratch/gitexp/`）：
  - `plugins/a` で変えたファイル・消したファイル・新しいファイルがあり、`plugins/b/x.txt` を git add 済み、`top.txt` を変えただけ、`plugins/b/untracked.txt` が git に入っていない状態で、上の 1 と 3 を `plugins/a` の pathspec で行うと、コミットには `plugins/a` の3ファイルだけが入り、`plugins/b/x.txt` は git add されたまま残った。`.plugin-creator-work/` は入らなかった。
  - プラグインのフォルダがリポジトリの直下（pathspec `.`）でも同じに動いた。
  - `git -C plugins/a` で、相対の pathspec `.` でも同じに動いた。
- push はしない（REQ-059）。

### 4.8 タグの名前

- 今：`plugin-creator-generated`（軽いタグ、`-f`）。生成プラグインは自分のリポジトリを持つので、リポジトリに1つでよかった（generate.md:70、creator-structure.md:199）。
- 改善・設計変更でも付け直す（`-f` で動かす）。improve.md の「ユーザーの直し」は、このタグからの差分で見る（improve.md:10）ので、付け直さないとクリエイターの直しがユーザーの直しとして数えられる。
- プラグインのフォルダがリポジトリの直下でないとき（例：plugin-market-place の `plugins/embedded-debug-loop`）、リポジトリに1つのタグでは、どのプラグインの印か分からない。
  - `plugin-creator-generated/<パス>` は、同じリポジトリに `plugin-creator-generated` があると作れない（スクラッチで確かめた：「fatal: cannot lock ref 'refs/tags/plugin-creator-generated/plugins/a': 'refs/tags/plugin-creator-generated' exists」）。パスに参照に使えない字（空白、`~`、`^`、`:` など）が入ることもある。
  - 案（勧め）：直下なら `plugin-creator-generated`、直下でなければ `plugin-creator-generated-<plugin.json の name>`。名前は `^[a-z0-9]+(?:-[a-z0-9]+)*$`（scaffold.py:70）なので、参照の名前に必ず使える。同じリポジトリに同じ名前のプラグインが2つあると重なるが、マーケットプレイスの中では名前が重ならないので、まれである。
  - improve.md も、このきまりでタグを探し、差分を `git -C <フォルダ> diff <タグ> -- .` のようにフォルダに絞る。タグがないときの「最初のコミットからの差分」は、大きなリポジトリでは、そのフォルダの `plugin.json` を足したコミット（`git -C <フォルダ> log --diff-filter=A --format=%H -- plugin.json` の最後）からにする。embedded-debug-loop には自分の .git もタグもない（plugin-market-place のコミット 484584c で足された）。
  - hearing.md:601 の「生成の段階の終わる条件は、生成プラグインにタグ `plugin-creator-generated` が付き」も、改善・設計変更ではこのタグの名前に合わせる。

### 4.9 試験と直し

- 作るときと同じ（generate.md:57-71）。構造の検査と部品の試験、不合格なら作業エージェントに直させる、直すたびに `check-base`、3回まで。合格しても、上限で止めても、試験をしなかったときも `commit` する（REQ-059、decisions.md 16）。
- 土台の比べ合いに `tests/` の土台のファイル（2章）を入れるかを決める。入れないと、作業エージェントが 2段目の土台の試験を書き換えて通すのを見つけられない。入れるなら、`tests/stage2/{adapter,core,ui}/` の中の作業ごとの試験の置き場所を `tests/stage2/task/` だけにする決まりが要る（今は parts/files でひな形のフォルダに新しいファイルを足せる：試験 `test_BLUEPRINT_8_a_new_file_may_be_added_even_in_a_folder_of_the_template` test_scaffold.py:1150）。
- embedded-debug-loop の `scripts/apply_agent_settings.py`（REQ-101、K-17）は、作業を始めるときにエージェントの定義のフロントマターを書き換える仕組みである。動かしたことがあれば、プラグインのフォルダにコミットしていない変更が残り、4.1 の 6 で止まる。新しい土台には、エージェントごとの思考の深さが入っている（設計書 3.4 の差分）ので、この仕組みは土台と重なる。確認で示すことになる。

## 5. 構造の検査に足すこと

### 5.1 REQ-058（外した番号・直す前の番号を指したままの箇所）

`check_knowledge`（check_structure.py:1255-1297）に足す：

1. `removed: true` の項目を、外した番号として読む。外した項目も id・kind・text の形を確かめ、外していない項目と番号が重ならないこと（今の 1279-1281 の重なりの確かめを、外したものも含めて行う）。
2. `replacedBy` は、一覧にある番号であること。
3. 外した番号が、次のどこかに書かれていれば不合格にする。ファイルと行を示し、`replacedBy` があれば「今の番号は K-19」と添える：
   - 文字のファイルすべて。ただし `tests/knowledge.json`、`tests/eval/*/inputs/`（課題の入力。ユーザーのデータ）、`tests/results/`、`.git`、`node_modules`、`__pycache__`、0 のバイトがあるファイルは除く。今の `knowledge_tokens_outside_tests`（1234-1252）は `tests/` を丸ごと除くが、外した番号は `tests/stage2/task/` の試験や eval.json に残ることもあるので、ここでは `tests/` も見る。
   - 作業の定義の criteria の `knowledge`：今の 1294-1297 で「一覧にある合否の決め方の番号でない」として落ちる。外した番号のときは「外した番号」と分かる文にする。
4. 外した項目は、置き場所の確かめ（1289-1293）の対象にしない。
5. 一覧にない番号（例：K-99）が書かれているのは、今は見ていない。REQ-058 の求めではないが、同じ仕組みで見つけられる。ユーザーのファイル（例：部品の型番）に K-数字 が入ると誤って落ちるので、注意にとどめるのがよい。
- 試験の一覧（CATALOG check_structure.py:59-75）の `knowledge` の名前に、REQ-058 の印を入れるか決める（今は「設計書 7章」）。REQ-058 はクリエイターの要件で、生成プラグインの要件ではないので、今の書き方（要件の番号なし）に合わせるのがよい。

### 5.2 部品の独立性（新しい要求：疎結合・モジュール強度・単体で動く）

仕様（出力の要件）に足す要件に合わせて、1段目に新しい試験（例：`skill-independence`）を足す。入口のスキル（`<名前>_open` を書いているスキル）を除く、`skills/<名前>/` ごとに、SKILL.md と references/ の文を見る：

1. スキルのフォルダの外のファイルを指していない：
   - Markdown のリンク `[...](パス)` と、バッククォートで囲んだパスのうち、URL・絶対パス・`<...>` の置き場所の書き方でないもの。
   - `../` を含む、`${PLUGIN_ROOT}` で始まる、`skills/<ほかのスキル>/` や `com.github.copilot/` で始まる、またはスキルのフォルダからたどると無いのにプラグインの根からたどるとある（例：根の `scripts/build.py`）ときは不合格。スクリプトはスキルのフォルダ（`skills/<名前>/scripts/`）に入れるよう示す。
   - 作業の成果物の場所（例：`logs/device-latest.log`）は、どこにも無いので不合格にしない（誤って落とさないため）。
2. スキルのフォルダの中を指すパス（`scripts/x.sh` など）は、そのファイルがある。
3. プラグインの組み立ての部品を名指ししていない：記録のツール（`<プラグイン>_show` など。`RECORD_TOOL` check_structure.py:1339）、エージェント（`<プラグイン>:worker` など）、`task.json`、`tests/knowledge.json`。これらはプラグインの中でしか意味がなく、スキルを単体で使えなくするため。
4. 逆向き（エージェント → スキル）：エージェントの定義などに書かれた `skills/<名前>/...` のパスが、ある。名前を変えたときに、古い名前を指したままにならないため。
- ナレッジの番号（K-数字）は、ルールのスキルに書いてよい。other のナレッジの置き場所の印で（check_structure.py:1292-1293）、スキルを単体で使うときも害がないため。
- 機械で見られないもの（description が呼び出し元の役を前提にしていないか、例：embedded-debug-loop の `cross-compile-rules` の description「embedded-debug-loop のビルド・デプロイ担当がビルドするときに読む」）は、作業エージェントへの決まりと EVAL で守る。
- 単体で動くことの試験は、2段目で、スキルのフォルダだけを一時フォルダに写して、そのスクリプトを動かす形にできる（プラグインのほかのファイルに頼っていれば落ちる）。作業ごとの試験（`tests/stage2/task/`）として作業エージェントに書かせる決まりにする案。
- 関わる既知の問題：作業エージェントは skill のツールを持たない（creator-structure.md:168）ので、ルールのスキルをファイルとして読む。そのときプラグインの場所が分からない（ナレッジ `rebuild-weaknesses.md:15`。embedded-debug-loop の worker-b.agent.md:42-49 は `skills/cross-compile-rules/SKILL.md` と `${PLUGIN_ROOT}` を使っている）。土台（エクステンション）は `pluginRoot` を知っている（template/com.github.copilot/extensions/_plugin_/adapter.mjs:349）ので、統括への最初の指示文にプラグインの場所を入れる直しを土台に足すと、ルールのスキルとそのスクリプトを絶対パスで渡せる。改善・設計変更では土台を必ず上げるので、この直しは embedded-debug-loop にも入る。

## 6. 足す試験

`tests/creator/scaffold/test_change.py`（新しいファイル。今の `test_scaffold.py` は 1529 行）。名前の決まりの試験（test_scaffold.py:1500-1525 の Naming）は自分のファイルしか見ないので、新しいファイルにも同じ試験を置くか、フォルダの `test_*.py` を見るよう直す。`tests/creator/run.py` はフォルダを歩いて `test_*.py` を探す（run.py:58-69）ので、置けば動く。

| 組 | 試験 | 要件 |
| --- | --- | --- |
| 始める前 | 作業フォルダの外を断る。作業フォルダと同じフォルダは受け付ける | REQ-053 |
| 始める前 | 仮の COPILOT_HOME の `installed-plugins/<mkt>/<plugin>` と `_direct/` を断る。`--hearing` の場所から COPILOT_HOME を求める。仮の COPILOT_CACHE_HOME の中を断る | REQ-053 |
| 始める前 | git のリポジトリの外、.gitignore で外したフォルダ、変えたファイル、git add しただけのファイル、git に入れていないファイルを断る。ほかのフォルダだけの変更は受け付ける。`.plugin-creator-work/` は数えない | REQ-053 |
| 始める前 | 断ったとき、フォルダの中身（ファイルと git の状態）が変わらない | REQ-053 |
| 取り出し | build で作ったプラグインを取り出して、変えずに描き直すと、版のほかは同じになる（往復） | REQ-057、REQ-059 |
| 取り出し | 古いひな形（fixture-template の決まった文と土台を変えたもの）で作ったプラグインを今のひな形で描き直すと、差し込み口の文は変わらず、土台だけが変わる。差分が preview に出る | REQ-057 |
| 取り出し | 作業エージェントが2体、extra_tools あり、入口のスキルの名前がプラグインの名前と違う | REQ-057 |
| 取り出し | クリエイターが作っていないプラグインでは、差し込み口がないことと、ひな形と重なるファイルの一覧を返す | REQ-057 |
| 決まりの一覧 | 引き継いだ番号が変わらない。足した番号は外したものを含む最大より後。外した番号を使うと断る。同じ番号で文を変えると断る。`replaces` で外した番号に `removed`・`replacedBy` が付く。2回目の改善・設計変更でも前に外した番号を使わない。元の番号が記録にも外したものにもないと断る | REQ-058 |
| 合否の基準 | 引き継いだ基準の C の番号が変わらず、足した基準は続きから | REQ-058、REQ-061 |
| EVAL の課題 | 引き継いだ課題と入力が残る。足した課題がないと断る。外した基準を指す引き継いだ課題を断る | REQ-061 |
| 版 | plugin.json の version が、よいと答えた版になる | REQ-057 |
| 入れ替え | 描いたものにないファイルは消え、.gitignore で外したファイル（tests/results）は残る。実行の印が残る。フォルダの外のファイルが変わらない。途中で失敗すると元に戻る | REQ-059、REQ-053 |
| 名前 | 取り込んだスキルと同じ名前のスキルを断る。取り込んだスキルのフォルダの中身が変わらない | REQ-055 |
| コミット | フォルダの中だけが入る。ほかのフォルダで git add 済みの変更は入らず、git add されたまま残る。`.plugin-creator-work/` は入らない。名前とメールがなくても通る。何もないときはコミットしない。コミットを revert すると直す前と同じ中身になる。リモートへ何も送らない | REQ-059 |
| タグ | 直下なら `plugin-creator-generated` を動かす。直下でなければ `plugin-creator-generated-<名前>`。同じリポジトリに `plugin-creator-generated` があっても作れる | REQ-059 |
| 土台 | change の後、check-base が合格し、`tests/` の土台のファイルもひな形と同じ。`tests/stage2/task/` は残る | REQ-057、REQ-059 |
| 入口 | 新しいサブコマンドが JSON を1つだけ出し、終了コードが決まりどおり | creator_structure_2 |
| 本物のひな形 | 見本で build → 決まりを1つ足し、1つ直し、課題を1つ足して change → 1段目が合格 | REQ-058、REQ-061 |

`tests/creator/stage1/test_check_structure.py` に足す（今のナレッジの試験は 904-960 行）：

- 外した番号がエージェントの定義・スキル・`tests/stage2/task/` の試験・eval.json にあると不合格で、ファイルと今の番号が示される。knowledge.json の中だけなら合格。外した番号を置き場所に求めない。外したものと外していないものの番号の重なりは不合格。`replacedBy` が一覧にない番号なら不合格。基準の knowledge が外した番号なら不合格。課題の入力（`tests/eval/*/inputs/`）の中の K-数字 は見ない。
- 部品の独立性：入口でないスキルが `../scripts/x.py`、根の `scripts/x.py`、`${PLUGIN_ROOT}`、ほかのスキルのファイルを指すと不合格。自分のフォルダの `scripts/x.sh` は合格、無ければ不合格。`<名前>_show` や `<名前>:worker` を書くと不合格。入口のスキルは対象外。成果物の場所の書き方（どこにも無いパス）は合格。エージェントの定義が無いスキルのパスを指すと不合格。

## 7. 決めること（設計で）

1. 外した番号の置き場所：案A（knowledge.json に `removed`）か案B（別ファイル）。勧めは A。
2. 土台の範囲：check-base と change で入れ直すものに `tests/` の土台のファイルを入れる（勧め）。check-base の比べ合いにも入れるか。
3. タグの名前の決まり（4.8）と、improve.md・hearing.md の直し。
4. 作業用の一時フォルダ `.plugin-creator-work/` の置き場所：作るときと同じく作業フォルダに置き、終わったら消す（勧め。作業エージェントが確認なしで書ける場所のため）。REQ-059 の「元のプラグインのフォルダの外のファイルは、作ったり変えたりしない（ヒアリングの記録と試験の道具を除く）」の除くものに、作業用の一時フォルダ（終わると消える）を足すかを決める。作業フォルダとプラグインのフォルダが同じときは、プラグインのフォルダの中にできるので、確かめ・コミット・入れ替えで除く。
5. マージなどの途中を始める前に断るか（4.1 の 7）。
6. 部品の独立性の要件を出力の要件に足すときの番号と、1段目の試験の名前。
