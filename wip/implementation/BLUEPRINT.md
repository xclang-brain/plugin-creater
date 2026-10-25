# 実装の設計図（途中経過）

設計書（docs/design/*.md）を実装に落とすときの、部品の間の取り決めである。設計書にあることは繰り返さず、設計書の節を指す。設計書と食い違うときは設計書が優先する（憲章 第6条2項）。実装が終わったら、残す価値のあることは設計書に移す提案をし、このファイルは消す。

## 0. 共通の決まり

- クリエイターの名前は `plugin-creator`。リポジトリの直下がクリエイターのプラグインの根である（CLAUDE.md 3章）。
- 版：Copilot CLI 1.0.102、Copilot SDK 1.0.25（2026-10-22 の最新）。Agent Plugins 1.0.0（`$schema` は `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` と完全一致。R3）。
- 言語：エクステンションと画面は JavaScript（ES モジュール、外部の npm パッケージなし。Node.js の標準の部品と `@github/copilot-sdk/extension` だけ）。1段目と組み立てと変換は Python 3（PyYAML、jsonschema、tiktoken）。2段目の画面の試験と EVAL は Node.js（Playwright、Copilot SDK、Agent SDK）。
- 開発の環境の Playwright は 1.56.1 に固定する（R4）。
- 文字の決まり：ユーザーに見える文字（画面、ツールの返り値、README）は平易な日本語（憲章 第9条、REQ-024、REQ-025）。コードの識別子は英語。
- 自然言語の部品（SKILL.md、*.agent.md）は、R1 の報告の決まりに従って書く（ユーザーの最重要の指示）。

## 1. クリエイターのフォルダ

```text
plugin.json                          Agent Plugins 1.0.0。name: plugin-creator
README.md                            REQ-023、REQ-037、REQ-047、ヒアリングの記録の置き場所と消し方
.github/plugin/marketplace.json      このリポジトリをマーケットプレイスとして入れるため（R3 1.8）
skills/
  make-plugin/
    SKILL.md                         hearing.md 10章
    references/                      段階ごとの問いの型（各 20KB 未満）と、言葉の置き換えの表（words.md）
    scripts/scaffold.py              組み立てと、土台がひな形と同じかの確かめ（creator-structure.md 2章、4.1）
  test-plugin/
    SKILL.md
    scripts/                         道具の確かめと用意、EVAL の実行、採点（testing.md 10章）
template/                            ひな形（2章）。スキルのフォルダの外に置く（Copilot CLI はスキルを読むたびに、そのフォルダの全ファイルの名前をモデルに足すため。ユーザーの答え25）
com.github.copilot/
  agents/reader.agent.md             読み取り役（hearing.md 9章）
  agents/worker.agent.md             作業エージェント（creator-structure.md 3.3）
  extensions/plugin-creator/         クリエイターのエクステンション（generated-plugin-structure.md 9章、hearing.md 7章・8章）
examples/                            会話例（REQ-037。スキルのフォルダの外）
tests/
  creator/                           クリエイター自身の1・2段目（ひな形の試験の仕組みを使い、クリエイターだけの確かめを足す）
  dev-eval/                          開発の試験の EVAL（変換、Agent SDK の実行、ユーザー役、模擬ユーザー、会話例の作成）
```

- ひな形の土台（`core/`、`ui/`、`extension.mjs`）は `template/com.github.copilot/extensions/_plugin_/` にだけ置く。クリエイターのエクステンションは、ここから `ui/` の画面のサーバーと描画の部品を相対パスで読み込む（generated-plugin-structure.md 9章）。
- 生成の途中のファイル（作業の定義の案、作業エージェントが書いた部分）は、作業フォルダの中の一時フォルダ `.plugin-creator-work/` に置き、生成のときに組み立てのスクリプトが消す（ユーザーの答え7）。

## 2. ひな形（生成プラグインのフォルダ）

```text
plugin.json                          name・version・description・repository（公開するまで空）
README.md                            generated-plugin-structure.md 3.4、4.1、4.14。インストールはマーケットプレイス経由
.github/plugin/marketplace.json      手元のフォルダのマーケットプレイスとして入れるため
skills/_entry_/SKILL.md              入口のスキル（4.7）
com.github.copilot/
  agents/orchestrator.agent.md       統括（4.7、4.8）
  agents/worker.agent.md             作業（1体以上。2体目からは worker-<名前>.agent.md）
  agents/verifier.agent.md           検証
  extensions/_plugin_/
    extension.mjs                    つなぎ口（Copilot SDK）
    core/                            中心の処理（Copilot CLI に依らない）
    core/task.schema.json            作業の定義の決まり（JSON Schema）
    ui/                              画面のサーバーと画面
    task.json                        作業の定義（作業エージェントが書き、基準はスクリプトが入れる）
docs/constitution.md                 クリエイター憲章の第2章と第4章を、生成プラグイン自身の決まりにしたもの（ユーザーの答え9）
docs/specs/requirements.md           共通の要件（ひな形）と作業ごとの要件（作業エージェント）
docs/design/design.md                共通の設計（ひな形）と作業ごとの設計、追跡の表（8章）
tests/run.py                         1つのコマンドの入口（testing.md 10.2）
tests/stage1/                        構造の検査（公式スキーマの写しを含む）
tests/stage2/                        部品の試験（中心の処理、サーバー、画面、作業ごとのスクリプト）と偽物のつなぎ口
tests/knowledge.json                 番号と種類つきのナレッジの一覧（組み立て）
tests/eval/<課題>/                    EVAL の課題（eval.json と入力のファイル）
```

- `_entry_`、`_plugin_` は組み立てのときに名前を変える。エクステンションのフォルダの名前は生成プラグインの名前にする。
- ひな形の文章の中の差し込み口は `{{slot:<名前>}}` と書く。組み立てのスクリプトが、作業エージェントが書いた部分（`.plugin-creator-work/parts/slots/<名前>.md`）で置き換える。埋まらない差し込み口が残れば組み立てを失敗にする。`{{plugin_name}}` などの決まった値も同じ形で置き換える。
- `extension.mjs` は、プラグインの名前を `plugin.json` から読む（`import.meta.url` から根を求める）。そのため土台のファイルは、どの生成プラグインでも中身が同じで、ひな形との比べ合い（creator-structure.md 4.1）が中身の一致で済む。

## 3. 生成プラグインのエクステンションの取り決め

### 3.1 中立のイベント（つなぎ口 → 中心の処理。`core.onEvent(e)`）

| `e.type` | 項目 | もとの Copilot CLI のイベント（R2 で確かめる） |
| --- | --- | --- |
| `agent.started` | `agentId`、`parentAgentId`、`agentType`、`model`、`executionMode`、`description` | `subagent.started` |
| `agent.configured` | `agentId`、`model` | `subagent.configured` |
| `agent.completed` | `agentId`、`cancelled`、`response` | `subagent.completed`、フック `onSubagentStop` の `response` |
| `agent.failed` | `agentId`、`error` | `subagent.failed` |
| `agent.idle` | `agentId` | `system.notification`（`agent_idle`） |
| `tool.started` | `agentId`、`toolCallId`、`toolName` | `tool.execution_start` |
| `tool.completed` | `agentId`、`toolCallId`、`toolName`、`success`、`error` | `tool.execution_complete` |
| `wait.started` | `requestId`、`agentId`（ないことがある）、`kind`（`permission`・`question`・`limit`）、`detail`、`resolvedByHook` | `permission.requested`、`user_input.requested`、`session_limits_exhausted.requested` |
| `wait.ended` | `requestId`、`kind`、`action`（利用の上限のときの `response.action`） | `*.completed` |

- `detail`：許可なら `toolKind`、`command`（全文）、`paths`、`urls`、`warning`、`sandboxBypass`、`permissionKind`。質問なら `question`。中心の処理が、画面に出すか（この実行の木か、エクステンション自身の権限の求めでないか）を決める（4.14）。
- 時刻はつなぎ口が `at`（ミリ秒）を付ける。

### 3.2 窓口（中心の処理 → つなぎ口。`port`）

```js
port = {
  startAgent({ agentType, name, model, prompt }) -> Promise<{ agentId }>,
  cancelAgent(agentId) -> Promise<void>,
  listTasks() -> Promise<[{ agentId, displayName, status, executionMode, agentType, parentAgentId }]>,
  setSubagentSettings(map | null) -> Promise<void>, // { "<plugin>:worker": { model: "gpt-6-luna", effort: "low" }, ... }。値の項目はどちらも省ける。null で外す
  getCurrentModel() -> Promise<{ model, isAuto }>,
  listModels() -> Promise<[{ id, name }]>,
  log(text) -> Promise<void>,
}
```

- どれも、待ち時間の上限（10秒）は中心の処理の側で付ける（6.1）。
- 試験では偽物の窓口（`tests/stage2/fake-port.mjs`）を使う。偽物は、呼ばれた順と引数を記録し、返す値と遅れと失敗を試験から決められる。

### 3.3 中心の処理（`core/index.mjs`）

```js
createCore({ port, pluginRoot, pluginName, dataRoot, sessionId, cwd, clock, ui }) -> core
core.open({ requestText }) -> Promise<{ url, notices }>      // <名前>_open
core.onEvent(e)                                               // 3.1
core.handleTool(shortName, args, { agentId }) -> Promise<string>  // plan, verdict, show, review, issue, finish。断るときは Error を投げ、message を平易な日本語にする
core.preToolUse({ agentId, toolName }) -> { deny, reason }   // 同期。例外を投げない（4.4）
core.onPermissionRequest(req)                                 // 列に入れるだけ（4.14）
core.getState() -> state                                      // 3.5
core.start(settings) / core.stop() / core.fileIssue(issueId) / core.getReply(agentId) / core.getFile(fileId)
core.shutdown()
```

- `clock` は `now()`・`setTimeout`・`setInterval` を持ち、試験で時を進められる。
- 記録のファイルは `dataRoot`（`<COPILOT_HOME>/plugin-data/<名前>/runs/`）に書く（6.5）。
- 統括への指示文の組み立て（4.3）、決まりの確かめ（4.8）、終わった理由（4.8、6.1）、課題の洗い出し（4.10）、起票（4.11）、拒む一覧（4.4、6.5）、途中で切れた実行（4.13、6.5）は中心の処理が持つ。

### 3.4 画面のサーバー（`ui/server.mjs`。クリエイターの画面と共通）

```js
startServer({ preferredPort, staticDir, routes, onListen }) -> Promise<{ url, port, token, close }>
// routes: { 'GET /api/state': (req) => json, 'POST /api/start': (req, body) => json, ... }
```

- 127.0.0.1 だけで待ち受け、ふさがっていれば OS に選ばせる。起動ごとに合言葉。合言葉と Host の確かめ、CSP、`nosniff` は server.mjs が全部の応答に付ける（4.2、6.3）。
- ファイルの窓口の確かめ（作業フォルダの中か、画像の種類、ダウンロードの形）は、server.mjs の部品として持ち、生成プラグインの routes から使う。
- 描画の部品（`ui/static/render.js`）：設定の部品（text、number、select、checkbox、path）と表示の部品（kv、table、progress、text、image、file）を、作業の定義から描く。クリエイターの画面も同じ部品で描く。

### 3.5 状態の全体（`GET /api/state`）

```js
{
  version,                       // 変わるたびに上がる
  plugin: { name, title },       // title は作業の定義の name
  setup: {                       // 準備中の画面
    models: [{ id, name }], defaults: { orchestrator, worker, verifier }, maxIterationsDefault,
    effortLevels: [...], effortAgents: [{ agent, label }],   // 思考の深さの選択肢と、選ぶエージェント（4.6）
    taskSettings: [...],         // 作業の定義の settings
    isAuto, autoNotice,          // Auto のときの注意（4.6）
    overrideNotice,              // 上書きを外すとほかのサブエージェントの上書きも消えること（4.6）
  },
  run: null | {
    id, status,                  // preparing|starting|running|summarizing|stopping|finished
    endReason: null | { kind, detail, unstoppable },   // kind: all_passed|max_iterations|user_stopped|aborted
    settings: { models: { orchestrator, worker, verifier }, efforts: { <エージェント>: 深さか '' }, maxIterations, task: { <key>: value } },
    isAuto, phase, iteration, maxIterations,           // phase: plan|do|study|null
    agents: [{ slot, role, label, status, task, selectedModel, actualModel, lastActiveAt, replySummary, agentId }],
      // role: orchestrator|worker|verifier。status: standby|running|waiting|completed|failed|stopped|unstopped
    iterations: [{ n, criteria: [{ id, text, fromUser }], plan, verdicts: [{ criterionId, pass, note }], agentIds }],
    displays: { <key>: value },
    summary,
    issues: [{ id, title, body, source, filing: { state, url, reason } }],  // source: mechanical|orchestrator。state: none|filing|filed|failed|unknown
    canFile: { ok, reason, steps },
    unstopped: [{ agentId, role, howTo }],
    waits: [{ requestId, slot, kind, detail }],          // slot が null なら実行全体の待ち
  },
  previous: null | { endReason, summary, issues, finishedAt },   // 準備中に開ける前の結果（4.2）
  notices: [ ... ],              // 「実行中は /clear しないでください」など
}
```

- 画面の文字（状態の名前、終わった理由の文）は、中心の処理ではなく画面が日本語にする。状態の全体は値（英語の記号）で持つ。

## 4. データの形

### 4.1 作業の定義（`task.json`。6.4）

```json
{
  "name": "週報の作成",
  "maxIterationsDefault": 3,
  "criteria": [{ "id": "C-01", "text": "（ナレッジの文のまま）", "knowledge": "K-03" }],
  "workers": [{ "agent": "worker", "label": "週報を書く係" }],
  "settings": [{ "key": "week", "label": "対象の週", "type": "text", "default": "", "required": true, "help": "…", "options": [] }],
  "displays": [{ "key": "draft", "label": "下書き", "type": "text", "when": "running" }]
}
```

- `criteria` は組み立てのスクリプトが、ナレッジの一覧の種類「合否の決め方」から書く（ユーザーの答え4）。作業エージェントは `criteria` を書かない。
- `settings.type`：text、number、select、checkbox、path。`displays.type`：kv、table、progress、text、image、file。`displays.when`：running、finished、both。

### 4.2 ナレッジの一覧（`tests/knowledge.json`）

```json
[{ "id": "K-01", "kind": "criterion", "item": "合否の決め方", "text": "…" }]
```

- `kind`：criterion（合否の決め方）か other。

### 4.3 EVAL の課題（`tests/eval/<課題>/eval.json`）

```json
{
  "id": "T-01",
  "prompt": "（頼むときの言葉）",
  "inputs": ["inputs/前回の週報.docx"],
  "settings": { "maxIterations": 3, "task": { "week": "2026-W42" } },
  "criteria": [{ "id": "C-01", "text": "（作業の定義の写し）", "grading": "program", "check": { "type": "contains", "file": "out/*.md", "text": "…" } }]
}
```

- `grading`：program（`check` で採点）か model（モデルが判定）。`check.type` の種類は採点のスクリプト（test-plugin）が決める。

### 4.4 ヒアリングの記録（`<COPILOT_HOME>/plugin-data/plugin-creator/hearings/<セッション>/`。hearing.md 7章）

- `state.json`：`{ sessionId, stage, items: { <itemKey>: { status, quote, holder } }, knowledge: [...], assets: [...], ossChoices: [...], confirmation: {...}, approvedAt, url }`
- `qa.jsonl`：問答（hearing.md 7.4）。
- 項目と段階の名前（画面とツールの返り値に出す日本語）と内部の記号の表は、クリエイターのエクステンションに1か所だけ持つ。
- 自動では消さない（ユーザーの答え6）。

## 5. 分担と順番

| 波 | 仕事 | 担当のモデル | 前に要るもの |
| --- | --- | --- | --- |
| A | A1 中心の処理と単体の試験 | Sonnet | この設計図 |
| A | A2 画面のサーバーと描画の部品と生成プラグインの画面、画面の試験 | Sonnet | この設計図 |
| A | A3 1段目の構造の検査、作業の定義のスキーマ、試験の入口 | Sonnet | この設計図、R3、R4 |
| A | A4 生成プラグインの憲章・仕様書・設計書のひな形 | Sonnet | この設計図 |
| B | B1 つなぎ口（extension.mjs）と、偽物のモデルでの読み込みの確かめ | Sonnet | R2、A1 |
| B | B2 生成プラグインの入口のスキルと、統括・作業・検証の定義 | Opus | R1、A1 |
| B | B3 クリエイターの make-plugin・test-plugin、読み取り役、作業エージェント、README | Opus | R1、R2 |
| C | C1 クリエイターのエクステンション | Sonnet | R2、A2 |
| C | C2 組み立てのスクリプトとマーケットプレイス | Sonnet | A3、A4、B2 |
| C | C3 試験の道具の用意、EVAL の実行、採点 | Sonnet | R2、A3 |
| D | D1 開発の試験の EVAL（変換、Agent SDK の実行、ユーザー役、模擬ユーザー、会話例の作成） | Sonnet | C1〜C3、R4 |
| 各波の後 | 点検：作った者とは別のエージェントが、仕様・設計・R1〜R4 と照らし、試験を動かす | Opus | その波 |
| E | EVAL を回す（ユーザーの承認の後）、会話例 | — | D1 |

- 作業のエージェントは、自分の仕事のメモを `wip/implementation/tasks/<番号>.md` に書きながら進める（中断に備える）。コミットと push は統括がする。
- 点検のエージェントは直さず、指摘を返す。直すのは作ったエージェントか、新しい作業のエージェントである（憲章 第19条2項にならう）。

## 6. 部品の間で合わせること

- 中心の処理は、画面を `startUi(core)`（`ui/app.mjs` の `startApp`）で遅れて起動する。`createCore` の引数に `startUi` を渡す（つなぎ口が配線する）。
- 記録のツールの定義（名前の後ろの部分、引数の JSON Schema、説明の文）は `core/tools.mjs` に1か所だけ置き、つなぎ口はそれを登録するだけにする。説明の文はモデルの振る舞いを決める自然言語の部品なので、A1 は仮の文を置き、B2（Opus）が R1 に沿って仕上げる。
- 生成プラグインの仕様書の要件の番号：共通の要件は、クリエイターの出力の要件の番号（REQ-001〜REQ-014、REQ-025、REQ-029〜REQ-031）をそのまま使う。作業ごとの要件は REQ-101 から作業エージェントが付ける。
- 試験の名前には、確かめる要件の番号を入れる（例：`test('REQ-009 止めると統括だけが取り消される', …)`）。追跡の表（8章）の突き合わせに使う。
- 試験のファイルの置き場所：中心の処理は `tests/stage2/core/*.test.mjs`、サーバーは `tests/stage2/ui/server.test.mjs`、画面は `tests/stage2/ui/screen.test.mjs`（node:test と playwright のライブラリ。@playwright/test の実行の仕組みは使わない）、構造の検査は `tests/stage1/`。作業ごとの部品の試験は `tests/stage2/task/`。
- 2段目は `node --test` でまとめて動かせるようにする（試験の入口が呼ぶ）。Python の部品の試験は `tests/stage2/task/test_*.py`（unittest）。

## 7. クリエイターのエクステンションのツール（C1 と B3 で合わせる）

generated-plugin-structure.md 9章の表に名前を付けたもの。説明の文はモデルの振る舞いを決めるので、C1 は仮の文を置き、B3（Opus）が R1 に沿って仕上げる。項目と段階の値は、画面に出る日本語の名前をそのまま使う（hearing.md 7.5。内部の記号を引数にも返り値にも出さない）。

| ツール | 呼ぶもの | 引数（要点） | 確認を省くか |
| --- | --- | --- | --- |
| `plugin-creator_open` | メイン | なし | 省く |
| `plugin-creator_state` | メイン | `include`：なし／「最後の問答」／「振り返りの材料」 | 省く |
| `plugin-creator_progress` | メイン | `stage`（段階の名前）、`items`（項目の名前、状態、ユーザーの言葉の抜き書き、保留ならだれが知っているか）。段階を「生成」に進めるときは、承認の答えの抜き書き | 省く |
| `plugin-creator_record` | メイン | `knowledge`（hearing.md 7.3 の欄。番号を渡すと更新）、`assets`、`oss`（標準機能と公開のプラグインの選んだ結果） | 省く |
| `plugin-creator_confirm` | メイン | 生成前の確認で示すもの（ナレッジの番号の一覧、振る舞いの案、作業の定義の案のパス〔`.plugin-creator-work/draft/task.json`〕、EVAL の課題と基準の案と入力のファイルの一覧、作り直しなら引き継ぐことと変わること） | 省く |
| `plugin-creator_results` | メイン | 試験の入口と EVAL が書いた結果のファイルのパス | 省く |
| `plugin-creator_doc_text` | 読み取り役 | `path` | 省く（ユーザーの答え15。作業フォルダの外の文書も確認なしで読める） |
| `plugin-creator_issue` | メイン | `title`、`body` | 省かない（creator-structure.md 4.5） |

- 段階の名前：始まり、実物を受け取る、読む、できていたことの確認（作り直しのときだけ）、前回の1回、決まりの確かめ、項目の点検、資産と公開のプラグイン、画面、生成前の確認、生成。
- 項目の名前：作業の目的、頼む場面と言い方、受け取るもの、進め方、成果物、合否の決め方、決まった書き方やルール、守らないと困ること、使う道具と環境、いつもと違うとき、前回の1回、候補の確かめ（エクステンションが計算）、資産、標準機能と公開のプラグイン、開始前に設定したいこと、実行中に見たいこと、終わった後に見たい結果と見せ方、できていたことの確認（作り直しのときだけ）。
- 状態の名前：未着手、聞いた、決まりなし、保留。ナレッジの状態：候補、決まった、外した。ナレッジの種類：合否の決め方、それ以外。

## 8. 作業エージェントが書く部分の置き場所（クリエイターの作業エージェント・組み立て・ひな形で合わせる）

```text
<作業フォルダ>/.plugin-creator-work/
  draft/task.json                   作業の定義の案（criteria なし）。生成前の確認の画面の見本に使う（ユーザーの答え7）
  parts/
    manifest.json                   組み立ての設定（下）。メインのエージェントが書く（部品の分け方と description は高い推論力が要るため。creator-structure.md 3.1）
    task.json                       よいと答えた作業の定義（draft と同じもの。criteria なし）
    slots/<差し込み口の名前>.md       差し込み口に入る文。作業エージェントが書く
    files/<生成プラグインの中のパス>   そのまま足すファイル（scripts/、mcp.json、tests/stage2/task/、tests/eval/<課題>/ など）。作業エージェントが書く
```

- `manifest.json`：`{ "plugin_name", "plugin_description", "entry_skill": { "name", "description" }, "workers": [{ "agent", "label", "extra_tools": [] }], "verifier": { "extra_tools": [] } }`。統括の項目は要らない（統括の定義に tools はない。答え24。あっても `extra_tools` が空のときだけ受ける）。`extra_tools` は作業ごとの MCP のツール（`サーバー名/ツール名`）など。
- 差し込み口の名前（ひな形が使う）：
  - 入口のスキル：`entry-task`（作業の説明。作業エージェント）。description は `manifest.json` の `entry_skill.description`（メインのエージェント）。
  - 統括：`orchestrator-task`。作業：`worker-task.<agent>`（作業エージェントごと）。検証：`verifier-task`。
  - 文書：`task-requirements`、`task-design`、`task-trace`（A4）。README には差し込み口を置かない（仕様 REQ-004・REQ-005 が README に求めるのは準備と、任せたいツールの許可のしかただけで、作業ごとの使い方は求めていないため。X1-17）。
- ナレッジ（`tests/knowledge.json`）と合否の基準（task.json の criteria）と EVAL の課題の基準の写しは、組み立てのスクリプトがヒアリングの記録から書く（ユーザーの答え4）。作業エージェントは、合否の決め方以外のナレッジを入れた箇所に、その番号（`K-01` など）を書く。

## 9. スクリプトの呼び方（スキルの手順と、スクリプトの担当で合わせる）

- スキルのフォルダのパスは、スキルを呼んだときに示される「Base directory for this skill」から作る（R1）。
- 組み立て：`python3 <make-plugin のフォルダ>/scripts/scaffold.py build --hearing <state.json のパス> --work <作業フォルダ>/.plugin-creator-work --out <作業フォルダ>/<生成プラグインの名前>`。終わると、作ったフォルダと結果を JSON で標準出力に出す。git のリポジトリにして最初のコミットをする。`.plugin-creator-work/` を消す。
- 土台の確かめ：`python3 <make-plugin のフォルダ>/scripts/scaffold.py check-base --out <生成プラグインのフォルダ>`。
- 1・2段目：`python3 <生成プラグインのフォルダ>/tests/run.py`（結果は `tests/results/latest.json`）。
- 道具の確かめと用意：`python3 <test-plugin のフォルダ>/scripts/check_tools.py --plugin <生成プラグインのフォルダ> [--install]`。
- EVAL：`node <test-plugin のフォルダ>/scripts/eval.mjs estimate --plugin <フォルダ> --runs <回数>`、`node <test-plugin のフォルダ>/scripts/eval.mjs run --plugin <フォルダ> --runs <回数>`（結果は `<生成プラグインのフォルダ>/tests/results/eval-<日時>/`）。
- 細かい引数と出力の形は、スクリプトの担当（C2、C3）が決め、作業のメモに書く。スキルの担当（B3）は、この形で手順を書き、点検で突き合わせる。
