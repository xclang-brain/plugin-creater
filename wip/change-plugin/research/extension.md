# 調査：クリエイターのエクステンション（change-plugin に向けて）

段階2の調査メモ。憲章・仕様書・設計書・実装資産のどれでもない。根は `/home/user/plugin-creator`。エクステンションのファイルは `com.github.copilot/extensions/plugin-creator/`（以下 `ext/`）。リポジトリのファイルは何も変えていない。

前提として読んだもの：仕様 `docs/specs/improvement-requirements.md`（REQ-052〜061）、`wip/change-plugin/decisions.md`、憲章 0.26.0、`wip/change-plugin/RESUME.md`、`wip/change-plugin/research-current-state.md`（extension-code の節）、設計書 `docs/design/hearing.md`（3章・5.7・6.3・7章・8章・12章）、`docs/design/creator-structure.md`、`docs/design/generated-plugin-structure.md` 9章。

試験の今の結果：`node --test tests/creator/extension/*.test.mjs` は 217件すべて合格（32 suites。ブラウザーの試験も動いた）。

---

## 0. 結論

1. 記録の形は「作る・作り直す」だけを前提にしている。改善・設計変更（以下「直す」）を表す欄・段階・項目・引数はない。作り直しの印 `rebuild`（真偽値）があるだけで、直すフォルダの欄もない。
2. KISS の案：作り直し（`rebuild`）は流用せず、記録に `change`（直すフォルダなど）を足し、それを作るツール `plugin-creator_change` を1つ足す。段階の名前は今のまま使う。足すのは次だけにする。
   - 項目の状態「変えないので聞かない」（記号 `unchanged`）
   - ナレッジの行の欄 `carried`（引き継いだ決まり）と `replaces`（中身を直して付け直した元の番号）
   - 確認の引数 `version`（新しい版の案）。引き継ぐこと・変わることは、今の `rebuild{keep,change}` をそのまま使う
3. 番号（REQ-058）はエクステンションで守れる。
   - 始めるときに `tests/knowledge.json` を元の番号のまま取り込む。
   - 番号を付けた数は、フォルダの文字のファイルに出てくる `K-数字` の最大から続ける。
   - 引き継いだ決まりの文・種類・項目を直す記録が来たら、エクステンションが元の番号を「外した」にして新しい番号を付ける。
4. git の確かめ（REQ-053）はエクステンションに入れない。エクステンションで子プロセスを使うのは起票の gh だけという決まりがあり、試験もある（`tests/creator/extension/tools.test.mjs:189-195`）。git の確かめは、スクリプトに置く（エクステンションの外）。
5. 気づいた危険（エクステンションの外。設計で決める必要がある）
   - (a) 作業フォルダが直すフォルダと同じとき、`.plugin-creator-work/` が直すフォルダの中にできる。そのため、「直し始める直前」の未コミットの確かめ（REQ-053）に引っかかる。
   - (b) 引き継いだ合否の決め方の番号を付け直すと、C-01 からの基準の番号がずれる。既存の EVAL の課題の C 番号は、作り直す必要がある。
   - (c) 今の構造の検査は、knowledge.json にない番号を指す箇所を不合格にしない。REQ-058 の受け入れ基準を満たさない。
   - (d) 外した番号を、生成プラグインの中に残す置き場所がない。

---

## 1. ヒアリングの記録（state.json）の形

### 1.1 置き場所とファイル

- `<COPILOT_HOME か ~/.copilot>/plugin-data/plugin-creator/hearings/<セッションの番号>/`（`ext/store.mjs:3-6, 18-30`）。セッションの番号は `env.SESSION_ID`（`ext/creator.mjs:432`）。
  - `state.json`：「ヒアリングの状態のただ1つの元。エクステンションだけが書く。一時ファイルに書いてから名前を変えて置く」（`ext/store.mjs:4`、`writeJsonAtomic` は 41-55）。
  - `qa.jsonl`：問答の記録。追記だけ（`ext/store.mjs:95-118`）。行の種類は `ask_user`（question、answer、outcome）、`user_prompt`（text）、`request`（text。記録ができる前の頼みの文）。各行に `at` が付く（`ext/hooks.mjs:67-73, 80, 91, 134`）。
  - `results.json`：`{ paths: [...] }`。`_results` で知らされた結果のファイルの場所（`ext/store.mjs:121-129`。上限20件は `ext/creator.mjs:25, 348`）。
- 「自動では消さない」「作業フォルダには何も作らない（REQ-021）」（`ext/store.mjs:8`）。
- 記録を作るのは、状態を変えるツール（progress、record、confirm）の最初の成功だけ（`ext/hearing.mjs:124-130` の `commit`。hearing.md 7.1）。作った直後に `onCreated` で頼みの文を追記する（`ext/creator.mjs:61`、`ext/hooks.mjs:129-139`）。

### 1.2 state.json の欄（`ext/hearing.mjs:65-83` の `freshState`）

| 欄 | 初めの値 | 中身 |
| --- | --- | --- |
| `schemaVersion` | 1 | 形の版 |
| `sessionId`、`createdAt`、`updatedAt` | | `updatedAt` は commit のたびに更新（:126） |
| `stage` | `'start'` | 段階の記号（1.3） |
| `rebuild` | `false` | 「作り直しのとき true（段階「できていたことの確認」に入るか、その項目を記録すると true になる）」（:72）。true にするのは :218（項目）と :241（段階）。false に戻す処理はない |
| `items` | `{}` | `{ <項目の記号>: { status, quote, holder, updatedAt } }`。「ないものは未着手」（:73、書くのは :212-217） |
| `knowledge` | `[]` | ナレッジの行（1.5） |
| `knowledgeCounter` | 0 | 「番号 K-01 の付け方。使い回さない」（:75）。新しい行のたびに +1（:324-325） |
| `assets` | `[]` | `{ name, location, note, status }`。名前が同じなら上書き（:363-373） |
| `ossChoices` | `[]` | `{ name, kind, choice, note }`。名前が同じなら上書き（:375-387） |
| `confirmation` | `null` | 生成前の確認で示したもの（1.7） |
| `approvedAt`、`approvalQuote` | `null` | 段階を「生成」に進めた時刻と、承認の抜き書き（:237-238） |
| `url` | `null` | 画面の URL（`setUrl` :473-478） |

- 凍結の欄はない。凍結は「段階が `generate`」から決まる。`assertWritable`（:119-122）は、読めない記録（`loadError`）と段階「生成」のときに断る。断る文は `FROZEN_MESSAGE`「お話を聞くことは終わっています（段階は「生成」）。やり直すときは、/clear してから頼み直してください。」（:62）。
- `active`（ヒアリングの最中）は「記録があり、読めて、段階が生成でない」（:499-501）。フックはこれを見る。

### 1.3 段階（`ext/names.mjs:12-24`。並びが流れの順。日本語の名前がツールの引数の値）

| 記号 | 名前 |
| --- | --- |
| start | 始まり |
| receive | 実物を受け取る |
| read | 読む |
| rebuild_check | できていたことの確認 |
| last_case | 前回の1回 |
| rule_check | 決まりの確かめ |
| item_check | 項目の点検 |
| assets | 資産と公開のプラグイン |
| screen | 画面 |
| confirm | 生成前の確認 |
| generate | 生成 |

- 順番は確かめていない。「生成」以外は、どの段階からでも設定できる（`ext/hearing.mjs:223-242`）。`stageOrder`（`ext/names.mjs:147`）はどこからも使われていない。

### 1.4 項目（`ext/names.mjs:28-49`）と状態（:52-57）

- 主な10項目（`group: 'main10'`。ナレッジの項目になれる。`MAIN_ITEMS` :141）
  - purpose 作業の目的
  - trigger 頼む場面と言い方
  - input 受け取るもの
  - procedure 進め方
  - output 成果物
  - criteria 合否の決め方
  - rules 決まった書き方やルール
  - must_not_break 守らないと困ること
  - tools 使う道具と環境
  - exceptions いつもと違うとき
- そのほか（`group: 'other'`）
  - last_case 前回の1回
  - candidate_check 候補の確かめ（`computed: true`。確かめていない候補があれば未着手、なければ聞いた。`ext/hearing.mjs:143-146`）
  - assets 資産
  - oss 標準機能と公開のプラグイン
  - 画面の3つ：settings 開始前に設定したいこと、running_view 実行中に見たいこと、result_view 終わった後に見たい結果と見せ方
- 作り直しのときだけ：rebuild_check できていたことの確認（`rebuildOnly: true`）。`applicableItems` は `!i.rebuildOnly || s?.rebuild`（`ext/hearing.mjs:140`）。
- 状態：todo 未着手、asked 聞いた、none 決まりなし、pending 保留。
  - ツールの enum に「未着手」は出さない（`ext/tool-defs.mjs:61`）。
  - 未着手には戻せない（`ext/hearing.mjs:200-202`）。
- holder は保留のときだけ残す（:215）。

### 1.5 ナレッジの行（`ext/hearing.mjs:326-341`）

| 欄 | 中身 |
| --- | --- |
| `id` | `K-` と2桁以上（`knowledgeNumber` :85 は padStart(2)。K-100 も作れる） |
| `kind` | criterion 合否の決め方、other それ以外（`ext/names.mjs:60-63`） |
| `item` | 主な10項目の記号だけ（`checkKnowledgeFields` :260-264） |
| `itemName` | 項目の日本語の名前（組み立ての knowledge.json の `item` になる。`skills/make-plugin/scripts/scaffold.py:226-229`） |
| `text` | 文 |
| `source` | answer、volunteered、added_at_confirmation、file、existing_plugin（「既存のプラグインから読んで確かめた」）、ai_decision（`ext/names.mjs:73-80`） |
| `quote` | 必須（:296-298）。ファイルから読んだものは、ファイル名と箇所 |
| `example`、`exception` | あれば |
| `status` | candidate 候補、decided 決まった、dropped 外した（:66-70）。候補には戻せない（:306-308） |
| `recordedAt`、`updatedAt` | 自動 |
| `itemTouchedAtRecord` | 記録したときに、その項目が未着手でなかったか（自動。11章の振り返りに使う。:340、:481-492） |

- 番号を渡すと更新になる（:299-313）。更新では文・種類・項目・出どころ・状態・例・例外を、そのまま書き換える。番号は変わらない。
- 新しい行には5つの欄（kind、item、text、source、status）がすべて要る（:314-317）。
- 出どころが「生成前の確認で足した」で、抜き書きが選んだ選択肢の文だけなら断る（:319-323、`ext/quote.mjs:78-90`）。

### 1.6 資産と、標準機能・公開のプラグイン

- 資産の状態：candidate 候補、reuse 流用する、skip 流用しない（`ext/names.mjs:83-87`）。
- OSS：kind は builtin 標準機能か public_plugin 公開のプラグイン。choice は use 使うか skip 使わない（:89-97）。

### 1.7 生成前の確認（`confirmation`）

- 書くのは `commitConfirmation`（`ext/hearing.mjs:436-441`）で、`creator.mjs:267` から呼ぶ。中身：
  - `knowledgeIds`：重なりを除き、番号の小さい順（`ext/creator.mjs:236`）
  - `behavior`、`taskPath`（絶対パス）
  - `evalTasks`：`[{ prompt, inputs:[{path, provisional}], criteria:[K-..], settings:{maxIterations?, task?} }]`（`ext/creator.mjs:218-229`）
  - `rebuild`：null か `{keep[], change[]}`
  - `taskHash`（draft の sha256）、`settingLabels`（設定の key → 見出し）
  - `knowledge`：示した行の写し `shownRow`＝{id, kind, item, text, example, exception}（:430）
  - `at`
- EVAL の課題が記録に残るのは、`confirmation.evalTasks` の中だけ。組み立ては、これと eval.json を突き合わせる（`scaffold.py:643-700`）。

### 1.8 組み立て（scaffold.py）が読む欄

- `load_state`（`scaffold.py:180-197`）：`stage == generate`、`approvedAt`、`confirmation` があること。
- `decided_knowledge`（:200-236）：status が decided の行の id・kind・itemName（なければ item）・text。knowledge.json はこの4欄（:1182-1183）。
- `confirmation.evalTasks`（:643-700）。
- `rebuild` と `knowledgeCounter` は読まない。

---

## 2. ツールの引数・振る舞い・関門

- 一覧と確認を省くかは `ext/tool-defs.mjs:216-225`（DEFS）。
  - 「確認を省く」は、Copilot CLI の許可の確認を出さない設定（`skipPermission`）。
  - 引数の形は :43-212、説明の文は `ext/descriptions.mjs`、処理は `ext/creator.mjs:293-366`。
- どれも `defer: 'never'` で登録する（`ext/creator.mjs:391`）。
- 断りは例外にせず、`{textResultForLlm, resultType:'failure'}` で返す（`guard` :373-384）。
- 状態を変える3つ（progress、record、confirm）は、1つずつ順に動かす（`serialize` :286-291）。

| ツール | 引数 | 振る舞いと関門 |
| --- | --- | --- |
| `plugin-creator_open` | なし | 画面のサーバーを起動して URL を返し、記録にも残す（:294-307） |
| `plugin-creator_state` | `include?`：「最後の問答」か「振り返りの材料」 | `stateText`（`ext/report.mjs:64-142`）を返す。返すもの：段階、項目ごとの状態、まだ聞いていないこと、確かめたいこと（出どころつき、最大20）、保留と知っている人、AI の判断、件数、確認と承認の状態、画面の URL、セッションの番号、記録の場所。最後に「SKILL.md の本文がコンテキストになければ、skill ツールで make-plugin を読み直してください。」（`ext/report.mjs:120`）。止まっている画面と見本は起動し直す（`ext/creator.mjs:309-334`） |
| `plugin-creator_progress` | `stage?`、`items?[{item, status, quote, holder?}]`、`approvalQuote?` | 下の (P1)〜(P6) |
| `plugin-creator_record` | `knowledge?[{id?, kind, item, text, source, quote, example?, exception?, status}]`、`assets?[{name, location?, note?, status}]`、`oss?[{name, kind, choice, note?}]` | 下の (R1)〜(R4) |
| `plugin-creator_confirm` | `knowledgeIds`、`behavior`、`taskPath`、`evalTasks`、`rebuild?{keep,change}` | 下の (C1)〜(C10) |
| `plugin-creator_results` | `paths[1..20]` | ファイルがあり、JSON で、5MB 以下かを確かめて、`results.json` に入れる（:342-351、`ext/results.mjs:26-38`） |
| `plugin-creator_doc_text` | `path` | docx・xlsx・pptx の文字を返す。読み取り役が使う（:353-361） |
| `plugin-creator_issue` | `title`、`body` | `gh issue create` で起票する。確認を省かない（`ext/issue.mjs`） |

**progress**（`ext/hearing.mjs:162-247`）

- (P1) 段階と項目のどちらもないときは断る。
- (P2) 項目の名前、状態の名前、「未着手」への変更は断る。「候補の確かめ」は手で変えられない（:191-195）。
- (P3) 抜き書きは必須。未着手から変えるときは、抜き書きが、ユーザーの答えか打った発言のどれか1つの中にあること（:206-211、`quoteInUserWords` :289-292）。
  - 問答の記録にユーザーの言葉がないときは、確かめずに通す。
  - 頼みの文（request）は、ユーザーの言葉に数えない（`ext/quote.mjs:35-42`）。
- (P4) 項目「できていたことの確認」を記録するか、段階「できていたことの確認」に進むと、`rebuild=true` になる（:218, 241）。
- (P5) 段階「生成」に進む条件（:224-239）は次のすべて。
  - 確認があること。
  - 確認の後に、決まったナレッジが変わっていないこと（`changesSinceConfirmation` :444-455）。
  - 確認の後に、draft の中身が変わっていないこと（:462-469）。
  - `approvalQuote` があること。

  進めると `approvedAt` を残す。
- (P6) 1つでも誤りがあれば、何も記録しない。返り値は「記録しました（段階：…）。まだ聞いていないこと：…」。

**record**（`ext/hearing.mjs:345-397`）

- (R1) 3つの引数のどれかが要る。それぞれ空でない一覧にする。
- (R2) knowledge の id ありは更新、なしは追加。番号は `knowledgeCounter` から付ける。
- (R3) 候補には戻せない。抜き書きは必須。
- (R4) 返り値は「記録しました（仕事のやり方や決まり K-01、K-02 を追加…）。確かめたいこと：N件」。

**confirm**（`ext/creator.mjs:240-269`）

確かめる順（hearing.md 7.5 の表と同じ）：

- (C1) `checkConfirmable`：未着手の項目が残っていれば、その一覧を返して断る（`ext/hearing.mjs:402-408`）。
- (C2) 引数の形を確かめる（`validateConfirmArgs` :211-238）。実物の入力は、あるファイルの絶対パスにする（:199-209）。
- (C3) draft は `<作業フォルダ>/.plugin-creator-work/draft/task.json` にあること（:243-246、`ext/constants.mjs:19`）。
- (C4) 「作り直しのときは、引き継ぐことと変わること（rebuild）も知らせてください。」（:247-249）
- (C5) 番号が見つからない、外したもの、決まっていないものは断る（`knowledgeByIds` :411-427）。
- (C6) 課題の基準が示す一覧にないか、種類が合否の決め方でないものは断る（:252-258）。
- (C7) 決まったナレッジのすべてを示すこと（:260-263）。
- (C8) draft を読み、合否の決め方が1件以上あり、`task.schema.json` に合うこと（`prepareSample` :125-155）。
- (C9) 課題の設定の値が draft の設定に合うこと（:156-163、`ext/eval-settings.mjs`）。
- (C10) 見本を作り直し、`taskHash` と `settingLabels` を足して記録する。返り値は「作る前の確認で示すものを受け付けました。…作業の画面の見本：URL」。

**フック**（`ext/hooks.mjs`。ヒアリングの最中だけ動く）

- `onPostToolUse`（ask_user）：問答を記録する（:76-86）。
- `onUserPromptSubmitted`：打った発言を記録する。記録の前の発言は覚えておく（:88-97）。
- `onPreToolUse`：コンパクションの後に、1回だけ `COMPACTION_NOTICE` を差し込む（:99-110）。差し込む文は「…skill ツールで make-plugin を読み直し、plugin-creator_state を呼んで…」（:18-19）。1KB 未満であることを読み込みのときに確かめる（:21-23）。

**画面の状態**（`GET /api/state`。`ext/screen.mjs:94-97` → `ext/creator.mjs:103-115`）

- `hearing`（`hearingView`、`ext/report.mjs:163-214`）の中身：
  - exists、stage
  - items[{name, status, done, main, holder}]
  - notAskedItems（主な10項目のうち未着手）
  - knowledge（決まった）、candidates、dropped
  - assets（流用する）、assetCandidates、oss、approvedAt
- `confirmation`（`confirmationView` :80-101）の中身：
  - at、behavior、knowledge、criteria（C-01 から。確認の knowledgeIds の順のうち合否の決め方）
  - evalTasks、rebuild、sampleUrl
- 描くのは `ui/static/creator.js`。
  - 項目の3つの区分：まだ聞いていないこと、聞いたこと、そのほか（`renderItems` :105-133）。
  - 作り直しの「引き継ぐこと・変わること」は `#confirm-rebuild`（:229-239）。
  - 状態の札の色は `STATUS_TONE`（:29）。

---

## 3. REQ-052〜061 に向けたエクステンションの変更（KISS の案）

### 3.0 方針：`rebuild` を流用せず、`change` を足す

`rebuild` の意味（新しいフォルダに作る）は、直す流れと3つの点で違う。

- `rebuild` は「できていたことの確認」の段階と項目を必須にする（`ext/hearing.mjs:140, 218, 241`）。REQ-054 は「機能ごとに要るかどうかは聞かない」。
- 番号は K-01 から振り直す（:75）。
- 直すフォルダを持たない。

そのため、`rebuild` は作り直し専用のまま残し、直す流れの印は `change` にする。

段階の名前（11個）は変えない。直す流れも「始まり → … → 生成前の確認 → 生成」を使う。段階を足すと関門（:224）と試験の表（`tests/creator/extension/tools.test.mjs:23`）が増えるためである。

ユーザーに見せる文の「作る前の確認」だけ、直すときは「直す前の確認」にする（3.11）。

### 3.1 記録に足すもの

| 欄 | 中身 |
| --- | --- |
| `change` | `null`（作る・作り直す）か、次のまとまり：`{ folder, manifest, name, version, generated, wants[], startedAt }` |
| 項目の状態 `unchanged` | 名前「変えないので聞かない」。直すときだけ使える |
| ナレッジの行 `carried: true` | 元のプラグインの `tests/knowledge.json` から取り込んだ行（引き継いだ決まり） |
| ナレッジの行 `replaces: 'K-07'` | 引き継いだ決まりの中身を直して、付け直した行が、元の番号を持つ |
| `confirmation.version` | 新しい版の案（直すときだけ） |

`change` の欄の中身：

- `folder`：直すフォルダの実パス。
- `manifest`：見つけた plugin.json の、フォルダからの場所。
- `name`、`version`：plugin.json の name と version（今の版）。
- `generated`：`tests/knowledge.json` を取り込めたか。クリエイターが作った生成プラグインかの印。
- `wants[]`：変えたいこと（ユーザーの頼みの要約）。

- `schemaVersion` は 1 のままにする。足すだけで、ない欄は null として読む。hearing.md 7.1 の表に行を足す。
- 直すフォルダを記録に持つので、組み立ての代わりのスクリプトは `state.change.folder` を読めばよい。モデルにパスを渡させない。

### 3.2 新しいツール `plugin-creator_change`（REQ-052、REQ-054、REQ-058）

- 引数：`folder`（必須。作業フォルダからの相対パスか絶対パス）、`wants`（必須。1件以上の文字の一覧。変えたいこと）。
- DEFS に `{ name: 'change', caller: 'main', skipPermission: true }` を足す。
- 振る舞い：
  1. `assertWritable`。
  2. 記録があり、`change` が null なら断る。断る文の例：「このセッションでは、新しく作るか作り直すお話を聞いています。今のプラグインを直すときは、/clear してから頼み直してください。」
     - 記録の前の頼みの文（request）は、取り込む番号と重ならない。それでも、作る流れで先に候補（K-01〜）が付いていると、取り込む番号と重なる。そのため、作る記録からの切り替えは認めない。
     - 「作り直したい」とだけ頼まれたときの問い（REQ-052）は、記録を作る前に聞くよう、スキルで決める。
  3. 記録が `change` で、同じフォルダなら、`wants` を置き換えて要約を返す（再開とコンパクションの後のため。取り込み直さない）。違うフォルダなら断る。
  4. フォルダを解決する（`path.resolve(workDir, folder)` から `fs.realpathSync`）。フォルダがないときは断る。
  5. plugin.json を次の順に探す：直下、`.plugin/`、`.github/plugin/`、`.claude-plugin/`（`skills/make-plugin/references/start.md:8` と同じ）。なければ断る。name と version を読む。
  6. `tests/knowledge.json` があれば取り込む。各行を次の形にする。
     - `id`、`kind`、`text` は元のまま。
     - `item` は knowledge.json の `item`（日本語の名前）を `itemIndex.keyOf` で記号にする。見つからなければ、記号として引く。
     - `source:'existing_plugin'`、`status:'candidate'`、`carried:true`。
     - `quote:'tests/knowledge.json の K-07'`（ファイル名と箇所）。
     - `itemTouchedAtRecord:false`。

     形が壊れていれば、取り込まずに断る（理由を返す）。`generated` は、取り込めたときに true にする。
  7. `knowledgeCounter` に、フォルダの文字のファイル（.git と node_modules を除き、0 のバイトのあるファイルと 5MB を超える部分は読まない。`template/tests/stage1/check_structure.py:1234-1252` と同じ見方）に出てくる `K-数字` の最大を入れる。
     - knowledge.json の番号、外した番号の記録（3.9）、本文に残る番号をまとめて数える。
     - embedded-debug-loop では K-17 になる（ひな形の試験のファイルにある K-01、K-03、K-04 の例も拾うが、最大には効かない）。
  8. `stage:'start'` の新しい記録として commit する（頼みの文の追記が走る）。
- 返り値の例：「直すプラグインとして記録しました（embedded-debug-loop、今の版 0.1.0）。仕事のやり方や決まり K-01〜K-17 の17件を、確かめたいこととして取り込みました。新しい決まりは K-18 から付きます。」
- REQ-053 の4つの確かめ（起動フォルダの中、インストールの写しでない、git で管理されている、未コミットの変更がない）は、このツールに入れない。
  - git を使う確かめは子プロセスが要る。試験 `tools.test.mjs:189-195` は「子プロセスを使うのは起票の gh だけ」と決めている。
  - 「直し始める直前」にも同じ確かめが要るので、スクリプト1つ（例：`skills/change-plugin/scripts/` の確かめのサブコマンド）にまとめるほうが単純である。
  - スキルは、確かめが通ってから `plugin-creator_change` を呼ぶ。止まったときは記録も作らない。

### 3.3 REQ-052 頼む

- エクステンションでは、`plugin-creator_change` と、文の中のスキル名（3.11）だけ。
- 断る頼みの見分けはスキル側。断る頼みは、検証エージェントをなくすことと、共通の部分を変えることである。
- 作り直しか直すかを聞く問いもスキル側。
- `descriptions.mjs` の open の説明「make-plugin と test-plugin の始めに呼び」（:7）に change-plugin を足す。

### 3.4 REQ-053 始める前の確かめ

- エクステンションの変更はない（3.2 の最後）。
- 危険 (a)：作業の定義の案の置き場所は、作業フォルダの `.plugin-creator-work/draft/task.json` に決まっている（`ext/constants.mjs:19`、`ext/creator.mjs:243-246`）。
  - REQ-053 は、元のプラグインのフォルダで起動することを許す。そのため、作業フォルダが直すフォルダと同じときは、`.plugin-creator-work/` が直すフォルダの中にできる。直し始める直前の確かめで、git に入れていないファイルとして止まる。
  - 案1：確かめのスクリプトで `<作業フォルダ>/.plugin-creator-work/` だけを除く。直した後のコミットにも入れず、最後に消す。
  - 案2：置き場所を記録のフォルダ（COPILOT_HOME の下）にする。作業エージェントが起動フォルダの外に書くことになり、許可の確認が出る（REQ-053 の理由に反する）ので勧めない。
  - 案1 を勧める。
  - REQ-059 の受け入れ基準（フォルダの外に作られたファイルがない）も、最後に消せば満たす。

### 3.5 REQ-054 読み取ったことを確かめる

- クリエイターが作った生成プラグイン：3.2 で取り込んだ17件が「確かめたいこと」になる。そのため、項目「候補の確かめ」が未着手になり、確認が断られる（今の関門のまま）。
  - 1回の問いで違う・古いものを聞き、record で一括して「決まった」にする。抜き書きは、その答えの文である。
  - 違う・古いものは、「外した」か、文の直し（3.10）にする。
- 書き足された決まりと、クリエイターが作っていないプラグインの決まり：読み取り役が返したものを、今の record で候補として足す（出どころ「既存のプラグインから読んで確かめた」、新しい番号）。今の「決まりの確かめ」で、1件ずつ確かめる。変更は要らない。
- 「できていたこと」は聞かない。直すときは、段階「できていたことの確認」と項目「できていたことの確認」を断る。
  - 今は、それを記録すると `rebuild=true` になり、項目が増える（:218, 241）。
  - 断る文の例：「直すときは、できていたことは聞かずに、すべて引き継ぎます。段階と聞くこと「できていたことの確認」は使いません。」
  - できていたことは、知識として記録せず、確認の `rebuild.keep` に書く。

### 3.6 REQ-055 既存のスキルを取り込む

- 今のツールで足りる。
  - 読み取った決まりは、出どころ「ファイルから読んで確かめた」の候補として record で足し、1件ずつ確かめる。
  - スキルとスクリプトは、資産（場所つき）として記録する。
- 名前の重なりの確かめと、示したスキルのフォルダを変えないことの確かめは、直す側のスクリプトで行う。対象は、資産の場所にある SKILL.md の name と、プラグインのスキル名である。

### 3.7 REQ-056 変えるところだけ聞く（項目の状態「変えないので聞かない」）

- `ITEM_STATUSES`（`ext/names.mjs:52-57`）に `['unchanged', '変えないので聞かない']` を足す。
- progress（`ext/hearing.mjs:185-220`）の決まりを足す。
  1. 直すとき（`next.change` がある）だけ使える。直すときでなければ断る。
  2. 未着手からだけ変えられる。聞いた・決まりなし・保留からは変えられない。
  3. 「前回の1回」は変えないので聞かない、にできない。変えるところの実際の1回は、いつも聞くためである。
  4. クリエイターが作っていないプラグイン（`change.generated` が false）では、画面の3項目も変えないので聞かない、にできない（REQ-056 の段落2）。
  5. 抜き書きの確かめは、「未着手」と「変えないので聞かない」のどちらから変えるときにも行う。今は未着手からのときだけ（:207）なので、「変えないので聞かない」を経由すると確かめをすり抜けられる。
     - 抜き書きは、変える範囲を確かめた答えから取る想定である。スキルの最初の問い（例：「変えるのは〇〇です。ほかは今のまま聞き直しません。違うところはありますか？」）への答えになる。
     - 頼みの文は、ユーザーの言葉に数えない（`ext/quote.mjs:35-42`）ので、使えない。
- 未着手の数え方（`remainingNames` :149-153）は今のまま。「変えないので聞かない」は未着手でないので、確認を受け付ける。これが「関門のゆるめ」になる。
- `itemTouchedAtRecord`（:340）は、`todo` と `unchanged` のどちらでもないとき true にする。聞かなかった項目に自分から話したものを、振り返りの対象に入れないため（hearing.md 11章と同じ考え）。
- 画面
  - `hearingView` の items に `skipped`（状態が変えないので聞かない）を足し、`skippedItems` の一覧も足す。
  - creator.js の `renderItems` に、3つ目の欄「変えないので聞かないこと（N）」を足す。今の「聞いたこと」は `done` で数えるので、`done && !skipped` にする。
  - `STATUS_TONE` に `'変えないので聞かない': 'neutral'` を足す。
  - REQ-056 の受け入れ基準「まだ聞いていない項目と分けて示される」を満たす。
- 状態取得の返り値は、項目ごとの状態の行にそのまま出るので変えなくてよい。
- どの項目を「変えないので聞かない」にするかは、モデル（スキル）が決める。エクステンションが守るのは、上の 3 と 4 だけである。
  - 資産と標準機能・公開のプラグインも、変えないので聞かない、にできる。
  - 憲章 第12条2項から聞くべきか（必須にするか）は、スキルの設計で決める。

### 3.8 REQ-057 直す前の確認

- confirm（`ext/creator.mjs:240-269`）を、直すときは次のようにする。
  - `rebuild{keep, change}` を必須にする。今の (C4) の条件を `state.rebuild || state.change` にする。`change` は1件以上にする。
    - 中に書くもの：引き継ぐこと（できていたこと、確かめた決まり、流用する部品）と変わること（スキル、設定項目、エージェントの役割、消す機能）。
    - REQ-057 の3つ目〜4つ目の点（条項を満たすための変更、消すファイル、土台を上げることと、それで変わること）も、`change` の文に書く。欄を分けない（KISS）。
    - 本物の機器を試せないこと（REQ-061）も、ここか `behavior` に書く。
  - 引数 `version`（文字、`^\d+\.\d+\.\d+$`）を足し、直すときは必須にする。今の版（`change.version`）より大きくないときは断る。今の版がないときは形だけ見る。
  - 引数の名前 `rebuild` はそのまま使う。説明の文（`ext/descriptions.mjs:71-73`）を「作り直しと、今のプラグインを直すとき。引き継ぐことと変わること」に直す。
  - 名前を変えると、記録の `confirmation.rebuild` と画面と試験が変わる。名前を変えないほうが小さい。
- 決まりの足す・直す・外すは、モデルに書かせず、エクステンションが記録から計算して画面に出す。
  - 足す：引き継いでいない決まったもの（`replaces` なし）
  - 直す：`replaces` のあるもの（`K-07 → K-20`）
  - 外す：引き継いだもので外したもの（付け直していない）
- 画面
  - `confirmationView` に `change: { folder, version: {from, to}, added, fixed, removed }` を足す。
  - 見出しは、直すときは「直す前の確認で示すもの」「直すときに、引き継ぐことと変わること」にする。
  - 今の `#confirm-rebuild` はそのまま使う。版と決まりの変わり方の欄を足す。
- 見本（REQ-027）：taskPath は今のまま必須にする。
  - 画面を変えないときも、今の task.json を写した案を渡す。合否の基準の差し込み（`ext/sample.mjs:17-22`）と、組み立ての作業の定義は、この案から作るためである。
  - 見本を示すかは、スキルで決める（画面を変えるときだけ示す）。
- `changesSinceConfirmation` と `taskChangedSinceConfirmation` は、そのまま使える。

### 3.9 REQ-058 決まりの番号

- 引き継いだ番号：取り込みで元の番号のまま入る（3.2-6）。
- 足した番号：`knowledgeCounter` が、フォルダに出てくる最大の番号から続くので、これまでの番号と重ならない（3.2-7）。数は戻さないので、外した番号は使い回さない（今のまま）。
- 中身を直した番号：record の更新（`ext/hearing.mjs:299-313`）で、`carried` の行の文・種類・項目が変わるときは、その行を書き換えない。次のようにする。
  1. 元の行を「外した」にする（抜き書きは更新する）。
  2. 新しい番号の行を足す。欄は次のとおり。
     - 種類・項目・文：渡された値。渡されていないものは元の値。
     - 状態：渡された値。なければ「決まった」。
     - 出どころ：渡された値。なければ「ヒアリングの答え」。
     - `replaces`：元の番号。
  3. 返り値に「K-07 の中身を直したので、K-07 を外して K-20 にしました」と書く。

  この会話で足した行（`carried` でない行）は、今のまま書き換えてよい。まだプラグインに入っていないためである。例と例外は knowledge.json に入らないので、引き継いだ行でも書き換えてよい。
- 付け直した元の行（ほかの行の `replaces` が指す行）を「決まった」に戻すのは断る。同じ決まりが2つの番号で残らないようにするためである。
- 外した番号を生成プラグインに残す場所（危険 (d)）：今の knowledge.json は今の決まりの一覧だけで、外した番号は残らない。
  - 直す側のスクリプトで、`tests/` の下に外した番号の一覧のファイル（例：`tests/knowledge-retired.json`）を書く案を勧める。
  - `tests/` の下なら、構造の検査の「指したままの箇所」の見張り（`knowledge_tokens_outside_tests` は `tests/` を除く）に引っかからない。
  - エクステンションは中身の形を知らなくてよい（3.2-7 の見方で番号を拾う）。
- 危険 (c)：構造の検査 `check_knowledge`（`template/tests/stage1/check_structure.py:1255-1297`）は、次の2つを確かめるだけである。
  - knowledge.json の番号が、決まった置き場所にあるか。
  - 基準の knowledge の番号が一覧にあるか。

  `tests/` の外に、一覧にない番号（外した番号や、直す前の番号）を指す箇所があっても、不合格にしない。REQ-058 の受け入れ基準を満たすには、ひな形の構造の検査に1つ確かめを足す必要がある（エクステンションの外）。
- 危険 (b)：合否の基準の番号は、確認の knowledgeIds のうち合否の決め方の並びで、C-01 から付く（`ext/creator.mjs:86`、`ext/sample.mjs:17-22`）。
  - embedded-debug-loop は C-01=K-07、C-02=K-13、C-03=K-14 である。K-18（合否の決め方）を足すと C-04 になり、今の C 番号は変わらない。
  - 引き継いだ合否の決め方を付け直すと（例：K-07 を K-20 に）、C 番号がずれる。この場合、既存の eval.json の C 番号も作り直す必要がある（組み立て側）。

### 3.10 REQ-059 直す場所とコミット

- エクステンションは、COPILOT_HOME の下の記録のほかに何も書かない（今のまま。`tests/creator/extension/state.test.mjs:368` の試験がある）。
- 段階「生成」に進める関門（P5）は今のまま。直すときは、それに加えて `confirmation.version` があること（confirm で必ず入る）。
- 直すフォルダは `state.change.folder` から読む。コミットと土台を上げることは、スクリプトとスキル側で行う。

### 3.11 REQ-060 直したことの説明と、モードで変わる文

- 説明の材料は記録から取れる。
  - 足した・直した・外した決まり：`carried`、`replaces`、`status` から取れる。
  - 版：`change.version` と `confirmation.version` から取れる。
  - 流用した資産：`assets` から取れる。
- 状態取得の返り値に、直すときは次の4行を足すと、コンパクションの後も説明が崩れない。
  - 直すフォルダと今の版
  - 変えたいこと
  - 引き継いだ決まり N件
  - 足した・直した・外した決まり
- モードで変える文（直すときだけ差し替える）
  - `ext/report.mjs:120`「…skill ツールで make-plugin を読み直してください。」を change-plugin にする。
  - `ext/hooks.mjs:18-19` の `COMPACTION_NOTICE` も change-plugin にする。差し込みはヒアリングの最中に返すので、記録の `change` を見て決める。1KB 未満の確かめは、2つの文の両方に行う。
  - 「作る前の確認」を含む文は「直す前の確認」にする。
    - `ext/hearing.mjs:226, 230, 406`
    - `ext/creator.mjs:268`
    - 画面の見出し `ui/static/creator.js:189`
  - 小さな関数1つ（記録から「作る前の確認」と「直す前の確認」のどちらかを返す）にまとめる。
  - 段階の名前「生成前の確認」「生成」は引数の値なので変えない。

### 3.12 REQ-061 変えたところの試験

- confirm に、直すときの確かめを1つ足す。課題のうち1つ以上が、引き継いでいない（`carried` でない）合否の決め方の決まりを基準に持つこと。持たなければ断る。
  - 断る文の例：「直すときは、変えたところを試す課題を1つ以上入れてください。合格の条件に、今回足した決まりの番号を入れます。」
  - 決定 11「変えたところを試す課題を作る前の確認で必ず足す」を、モデルの判断に任せずに守るためである。
  - 機能を消すときも、エージェントの組み方を変えるときも、「〇〇がない」「足した作業役が動いた」を合否の決め方として足せば通る。
- 引き継ぐ課題（embedded-debug-loop の T-01）は、入力を直すフォルダの中の絶対パス（`tests/eval/T-01/inputs/...`）で渡せば、今の確かめ（`realInputProblem` :199-209）を通る。
  - 課題に「引き継いだ課題」の印は付けない。
  - eval.json の作り直し方（今の T-01 を残すか、確認のとおりに作り直すか）は、組み立て側で決める。
- 本物の機器に送らない課題にすることと、試せないことを示すことは、スキル側と課題の中身で行う。

### 3.13 新しい要件（部品の疎結合・単体で動くこと）との関係

- エクステンションの記録とツールに変更は要らない。どの部品をどう分けるかは、メインのエージェントの部品の分け方と、出力の要件（段階1）の範囲である。
- 番号との関係：単体で動くルールのスキルにも、ナレッジの番号（例：「（K-18）」）を書く。構造の検査は、`tests/` の外のファイルに番号があるかを見るので、スキルのファイルに番号があってよい。
- 番号を付け直すと（3.9）、スキルの中の古い番号も直す必要がある。危険 (c) の検査で見つける。

### 3.14 変えるファイルのまとめ（エクステンション）

| ファイル | 変えること |
| --- | --- |
| `ext/names.mjs` | 項目の状態に `unchanged` を足す |
| `ext/hearing.mjs` | `freshState` に `change:null` を足す。直すときの関門（3.7）、`carried` の付け直し（3.9）、付け直した元の行を戻すのを断る、「できていたことの確認」を断る（3.5）、`itemTouchedAtRecord`、モードで変わる文。`applyChange`（3.2）を足す。返す関数に `isChange` と計算した決まりの変わり方を足す |
| `ext/creator.mjs` | handlers に `change` を足す。confirm に、`rebuild` の条件、`version`、変えたところの課題の確かめを足す。`confirmationView` に `change` を足す |
| `ext/tool-defs.mjs` | `change` の引数と DEFS。confirm の `version` |
| `ext/descriptions.mjs` | `change` の説明と引数の説明。open・confirm・rebuild の説明に直すときのことを足す |
| `ext/report.mjs` | stateText の4行とスキル名。`hearingView` の `change`・`skipped`・`skippedItems` |
| `ext/hooks.mjs` | 差し込みの文をモードで選ぶ |
| `ext/ui/static/creator.js`（と css） | 「変えないので聞かないこと」の欄、直す前の確認の見出し、版、決まりの変わり方 |
| `ext/store.mjs`、`ext/screen.mjs` ほか | 変えない |

そのほか、クリエイターの外の側で合わせて直すもの：

- 設計書 `docs/design/hearing.md`（7.1 の表、7.2 の状態、7.5 の確認の断りの順、12章）。
- `generated-plugin-structure.md` 9章のツールの表。
- `tests/dev-eval/runner/creator-tools.mjs:8` の注釈（ツールの一覧。登録は `creator.tools` から自動）。
- 外側の EVAL の採点 `tests/dev-eval/runner/outer-grade.mjs:229-258`。`unchanged` は未着手に数えないので、今のままでも動く。「変えないところを聞き直さない」は採点していない。

---

## 4. 2段目の試験（`tests/creator/extension/`）

### 4.1 今ある試験（ファイル：数）

| ファイル | 数 | 主な中身 |
| --- | --- | --- |
| record-tools.test.mjs | 57 | progress・record・confirm の確かめ、関門、作り直し（:151-168 REQ-033、:597-608 REQ-035）、番号（:269-281）、抜き書き、設定の値、draft の印 |
| state.test.mjs | 17 | 状態取得の返り値、再開、記録の置き場所（:368 REQ-021） |
| tools.test.mjs | 14 | 8つのツールの登録（:12-21 の表、:40）、引数の表（:23-27 段階と項目の名前、:83 状態の enum）、説明、フック、子プロセス（:189-195）、外部パッケージなし |
| screen.test.mjs | 17 | 画面の状態（:158-210 項目の分け方と `items` の deepEqual）、確認、作り直し（:317-324）、結果、会話例 |
| screen.browser.test.mjs | 14 | 画面の DOM（Playwright）。作り直し（:278-292）、言葉（:390-456） |
| hooks.test.mjs | 18 | 問答の記録、頼みの文、差し込み |
| failure.test.mjs | 10 | 断りの形。どの引数でも例外を投げない（:191-211。ツールの一覧を書き写していて、`8 * weird.length`） |
| words.test.mjs | 9 | 返り値・断る文・差し込み・画面の文に、表の左の言葉（`words.mjs:22-46`）が出ない |
| sample.test.mjs | 14 | 見本 |
| eval-settings.test.mjs | 7 | 設定の値の確かめ（1段目との食い違いの見張り） |
| doc-text.test.mjs | 9 | 文書のテキスト |
| issue.test.mjs | 10 | 起票 |
| quote.test.mjs | 5 | 抜き書きの比べ方 |
| sdk-connection.test.mjs | 4 | 本物の SDK でつなぐ。ツールの定義は `TOOL_DEFS` と自動で突き合わせる |

- 道具：`helpers.mjs` の各部品。
  - `startForTest`、`withRun`、`answerEverything`
  - `SETTABLE_ITEMS`（:112-129。「できていたことの確認」を除く16項目）
  - `confirmArgs`、`readyToConfirm`、`writeDraft`
  - `INTERNAL_SYMBOLS`（:235-256）
- 偽物のセッションは `fake-session.mjs`。

### 4.2 変える必要がある試験

| 試験 | 変える理由 |
| --- | --- |
| tools.test.mjs :12-21、:40 | ツールが9つになる（`change: { skip: true }`）。必須の引数に `required('change')` を足す |
| tools.test.mjs :83 | 状態の enum が `['聞いた', '決まりなし', '保留', '変えないので聞かない']` になる |
| failure.test.mjs :196, :208 | ツールの一覧に `change` を足し、`9 * weird.length` にする。:28-41 に `change` の断りの例を足す |
| screen.test.mjs :197 | 「候補の確かめ」の items の deepEqual に `skipped:false` が増える |
| helpers.mjs :235-256 | `INTERNAL_SYMBOLS` に `unchanged`、`carried`、`replaces` を足す（返り値に記号が出ないことの見張り） |
| words.test.mjs :31- | `change` の返り値と断る文、新しい断る文、直すときの差し込みの文を足す |
| record-tools.test.mjs :597-608 | 作り直しの断る文を変えるなら、合わせる（変えない案なら、そのまま） |

### 4.3 足す試験（案。名前の頭に要件の番号を付ける）

- 試験の道具（helpers.mjs）
  - `writePluginFolder(cwd, { knowledge, version, manifestAt, extraFiles })`：作業フォルダの下に、plugin.json と tests/knowledge.json と、K 番号を含む本文のファイルを置く。knowledge.json の形は embedded-debug-loop と同じにする（item は日本語の名前）。
  - `startChange(run, overrides)`：`plugin-creator_change` を呼ぶ。

**record-tools.test.mjs に `describe('今のプラグインを直す（plugin-creator_change）')`**

1. REQ-052 フォルダと変えたいことを渡すと、記録が直すものになり、直すフォルダ・名前・今の版・変えたいことが残る。返り値に内部の記号が出ない。
2. REQ-052 plugin.json が4つの場所のどれにもないフォルダ、ないフォルダ、folder か wants のないときは、理由を返して断る（記録を作らない）。
3. REQ-052 作る記録がすでにあるセッションでは断る（/clear の案内）。同じフォルダで呼び直すと、変えたいことだけが変わり、取り込み直さない。違うフォルダは断る。
4. REQ-054 REQ-058 knowledge.json の決まりが、元の番号・種類・項目・文のまま、確かめたいこと（出どころ「既存のプラグインから読んで確かめた」）として入る。項目「候補の確かめ」が未着手になる。
5. REQ-058 新しい決まりの番号は、フォルダに出てくる最大の番号の次から付く。外した番号の一覧（tests の下のファイル）や本文にだけある大きい番号も数える。
6. REQ-058 引き継いだ決まりの文を直すと、元の番号が外れ、新しい番号に `replaces` が付く。返り値に付け直しが書かれる。例と例外だけの直しと、この会話で足した決まりの直しでは、番号が変わらない。
7. REQ-058 付け直した元の番号を「決まった」に戻すのは断る。
8. REQ-054 knowledge.json が壊れているとき（一覧でない、番号の形が違う、種類が違う）は、理由を返して断る。
9. REQ-054 直すときは、段階と項目「できていたことの確認」を断る。
10. REQ-056 「変えないので聞かない」は、直すときだけ、未着手からだけ使える。抜き書きの確かめがある。「変えないので聞かない」から聞いたに変えるときも確かめる。
11. REQ-056 「前回の1回」は「変えないので聞かない」にできない。クリエイターが作っていないプラグイン（knowledge.json なし）では、画面の3項目もできない。
12. REQ-056 「変えないので聞かない」の項目は未着手に数えず、確認を受け付ける（関門のゆるめ）。
13. REQ-049 「変えないので聞かない」の項目に自分から話した決まりは、振り返りの対象にならない。
14. REQ-057 直すときの確認：rebuild（変わることが1件以上）と version がないと断る。version の形が違う、今の版より大きくないときも断る。受け付けると、記録に version が残る。
15. REQ-061 直すときの確認：今回足した合否の決め方を基準に持つ課題が1つもないと断る。引き継いだ課題（直すフォルダの中の入力の絶対パス）は受け付ける。
16. REQ-020 REQ-059 直すときも、確認の後に決まりが変われば、示し直すまで「生成」に進めない（今の関門がそのまま効く）。

**state.test.mjs**

17. REQ-060 直すときの状態の返り値に、直すフォルダと今の版、変えたいこと、引き継いだ決まりの数、足した・直した・外した決まりが出る。最後の行が change-plugin の読み直しになる。
18. REQ-052 同じセッションの番号で起動し直すと、直す記録が読まれて続きから進む。
19. REQ-059 直すときも、記録は COPILOT_HOME の下にだけでき、直すフォルダの中身は変わらない（ファイルの一覧と中身を前後で比べる）。

**hooks.test.mjs**

20. REQ-052 直すときのコンパクションの後の差し込みは change-plugin を読み直す文で、1KB 未満である。

**screen.test.mjs**

21. REQ-056 画面の状態で、「変えないので聞かない」項目が、まだ聞いていない項目と聞いた項目と分かれる（`skippedItems`、`notAskedItems`）。
22. REQ-057 確認の状態に、直すフォルダ、版（今と新しい案）、引き継ぐことと変わること、足す・直す・外す決まり（計算したもの）がある。

**screen.browser.test.mjs**

23. REQ-056 「変えないので聞かないこと」の欄が、まだ聞いていないことの欄と別に出る。
24. REQ-057 直す前の確認の見出し、版、引き継ぐこと・変わること、決まりの変わり方が見られる。言葉の試験（:390-456）の状態に、直すときの状態も入れる。

---

## 5. RESUME.md の「決めたこと」に移す候補

- 直す流れは `rebuild` を流用せず、記録の `change` とツール `plugin-creator_change` で表す。段階の名前は変えない。
- 項目の状態「変えないので聞かない」を足す。「前回の1回」と、作っていないプラグインの画面の3項目には使えない。
- 引き継いだ決まりは、knowledge.json から元の番号のまま「確かめたいこと」で取り込む。番号はフォルダの最大の番号から続ける。引き継いだ決まりの中身を直すと、エクステンションが付け直す（`replaces`）。
- 確認の引数は `rebuild{keep,change}` を流用し、`version` を足す。決まりの足す・直す・外すは、エクステンションが計算する。
- 直すときは、変えたところを試す課題（今回足した合否の決め方を基準に持つもの）を、確認で必須にする。
- REQ-053 の確かめは、エクステンションに入れず、スクリプトにまとめる。

## 6. 確かめていないこと

- Copilot CLI がインストールやマーケットプレイスのために持つ写しの置き場所（REQ-053 の2つ目）。npm の `@github/copilot@1.0.102` は、取ってきても本体のない小さなパッケージ（5KB）だったので、中を確かめられなかった。マーケットプレイスを通した手元のフォルダは、写されずに直接読まれる（`.claude/memory/plugins.md:56`）。この場合は直すフォルダそのものなので、止めてはいけない。
- 大きなプラグインで、フォルダの全ファイルから番号を拾う時間（embedded-debug-loop の規模では問題にならない見込み）。
