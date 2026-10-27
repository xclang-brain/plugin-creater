# 調査：開発の試験（tests/dev-eval）で、改善・設計変更（change-plugin）を試すには（2026-10-26）

調べた範囲：`tests/dev-eval/**`（runner の外側・内側・隔離・つなぎ・ユーザー役・中継・変換、personas/FORMAT.md と weekly-report、control-creator、heldout は置き場所の形だけ）、`tests/creator/run.py`、`docs/design/testing.md` 4〜8・10・11章、ナレッジ `agent-sdk-eval.md`・`user-simulation.md`・`cloud-long-runs.md`。
あわせて、偽の Anthropic API（`runner/fake-anthropic.mjs`）につないだ本物の Claude Code（Agent SDK 0.3.310 同梱の 2.1.310）で、サンドボックスの振る舞いを実測した（実際のモデルは呼んでいない。3.1）。リポジトリのファイルは変えていない。

---

## 0. 要点

1. 今の外側の EVAL は「新しいフォルダに生成プラグインができる」ことを前提にしている。改善・設計変更（元のフォルダを直す）では、そのままでは終わりを見分けられず、採点もできない。
   - 始める前からあったプラグインは、生成プラグインから除かれる（`outer-run.mjs:116-122`、`266`）。直した元のプラグインは「できた」と数えられない。
   - 終わりは「生成プラグインが見つかって手番が終わった」で決まる（`outer-run.mjs:422-425`）。改善では見つからないので、`max_exchanges`（150）まで続く。
   - 示すファイルはファイル1つずつの写しだけで（`outer-run.mjs:75-82`）、フォルダ・git のリポジトリを置けない。
2. 足すもの：作業フォルダに git のリポジトリ（embedded-debug-loop の写しをコミット）と、ユーザーの既存のスキルのフォルダを置く仕組み、直す対象のフォルダの指定、始める前の記録（コミットの番号、フォルダのハッシュ、knowledge.json）、改善用の終わりの見分け（HEAD が進んだ）、REQ-052〜062 の採点。模擬ユーザーの形（FORMAT.md と validate.mjs）にも足すものがある（2.3）。
3. 擬似の機器（実測で確かめた）：サンドボックスの中のコマンドから、ホストの `127.0.0.1` の TCP には届かない。Unix ソケットは既定で seccomp に断られる（`EPERM`）。届く道は次の2つ。
   - サンドボックスのプロキシを通した HTTP で `localhost:<ポート>` に送る。`sandbox.network.allowedDomains: ['localhost']` を足すと、許可の求めなしで届く。
   - `sandbox.network.allowAllUnixSockets: true` を足すと、Unix ソケットに届く。
   推奨は前者。試験の仕組みが擬似の機器のプロセス（HTTP、`127.0.0.1`）を外で動かし、`PATH` の先頭に置いた `scp`・`ssh` の差し替えが、プロキシ経由でそこへ送る。機器の中身は作業フォルダの外に置き、`qemu-arm` で動かす。偽の API でこの流れを通しで動かし、`AVG=25` が返ること、サンドボックスの中から機器の中身を書き換えられないことを確かめた（3.1）。
4. 費用と時間（testing.md 8.1 と過去の実測）：作る流れの外側の EVAL は、1回 26〜31分・約7ドル（クリエイター Opus 約6.05、ユーザー役 Sonnet 約0.92）。改善の流れは、まだ測っていない（推定は4章）。`outer.mjs` の見込みの表（`COST_GUIDE_USD`、`outer.mjs:80`）は試作の値のままで、`--dry-run` の見込みは約17倍も低く出る。
5. この容器：`ANTHROPIC_BASE_URL=https://api.anthropic.com`。`tests/dev-eval/node_modules` は無く、`npm install --ignore-scripts` が要る（package-lock は無い。スクラッチで同じ4つを入れて約19秒、340MB）。bubblewrap と socat は無かったので、この調査で apt で入れた。tiktoken が無い。Playwright 1.56.1 用の Chromium（1194）も無い（1243 だけ）。隔離した環境変数だけで、Agent SDK 同梱の Claude Code は `loggedIn: true`（oauth_token）だった。モデルの呼び出しが本当に通るかは、モデルを呼ばないと分からないので確かめていない。

---

## 1. 外側の EVAL の流れ（今の作り）

### 1.1 入口と引数（`runner/outer.mjs`）

- 使い方（`outer.mjs:4-17`）：
  `node tests/dev-eval/runner/outer.mjs --persona <模擬ユーザーのフォルダ>… [--heldout] [--style 名前]… [--all-styles] [--arms with,control,without] [--models claude-opus-5-5,claude-haiku-5-5] [--runs 1] [--creator …] [--control …] [--converted <置き換えた版>] [--inner] [--inner-runs n] [--out <結果のフォルダ>] [--no-sandbox] [--dry-run] [--max-exchanges 150] [--user-model <ID>] [--timeout-minutes 60]`
- 開発者が答える形：`--human --request-file <最初の依頼の文> [--relay …] [--file <元>[=<置き場所>]]…`。続きから始める形：`--human --resume <前の実行のフォルダ> --resume-prompt-file <ファイル> --out <前の結果のフォルダ>`（`outer.mjs:19-56`）。**`--resume` は `--human` のときだけ使える**（`outer.mjs:133-135`、`outer-run.mjs:236-237`）。ユーザー役の AI で回すときは、止まったら始めからやり直しになる。
- 引数の決まり（`outer.mjs:92-144`）：`--models` は `claude-[a-z]+-\d+-\d+` の ID だけ（`140`）。`--arms` は with・control・without。
- 終了コード：0 最後まで動いた、1 途中で止まった（利用枠・中断）、2 始められなかった（`outer.mjs:15`）。
- 計画は「模擬ユーザー × 話し方 × 腕 × モデル × 回数」（`planRuns`、`outer.mjs:338-354`）。control と without は、最初のモデルだけで回す（`346`）。
- サンドボックスの道具（bwrap、socat）が無いと始めない（`outer.mjs:591-594`、`isolation.mjs:49-54`）。
- クリエイターは毎回 `convert.py` で置き換える（`outer.mjs:604`）。`--converted` を渡すと、前の置き換えた版を使う。

### 1.2 1回の流れ（`runner/outer-run.mjs` の `runOuterOnce`、`209-654`）

1. 実行のフォルダ：`<out>/runs/outer-<id>-<腕>-XXXXXX/` の下に `work`（作業フォルダ＝クリエイターの cwd）、`agent-home`（Claude Code の HOME）、`copilot-home`（クリエイターの記録）、`user-home`（ユーザー役）、`converted` を作る（`outer-run.mjs:256-263`、`outer-resume.mjs:37-43`）。置き場所の既定は `$DEV_EVAL_RUNS` か `os.tmpdir()/plugin-creator-dev-eval`（`outer-run.mjs:681-683`）。この容器の `os.tmpdir()` は `/tmp` である。
2. 模擬ユーザーの示すファイルを、`work/<place>` に**ファイル単位で写す**（`placePersonaFiles`、`outer-run.mjs:75-82`。`fs.copyFileSync`）。
3. 始める前からあるプラグイン（直下に `plugin.json` があるフォルダ。深さ3まで。`node_modules`・`.git`・`.plugin-creator-work` は見ない）を `preexisting-plugins.json` に記録する（`outer-run.mjs:85-122`、`265`）。作り直しで示した元のプラグインを、生成プラグインと取り違えないためである（ナレッジ rebuild-weaknesses）。
4. 置き換え（4章）：`convert.py`（`python3 -I convert.py SRC OUT`。毎回 `claude plugin validate` も動く。`convert.py:581-586`）。トップの `.git .github .claude .venv node_modules wip docs tests examples .plugin-creator-work .eval com.github.copilot` と、どこにあっても `heldout` を写さない（`convert.py:116-119`）。見ない模擬ユーザーと会話例は、これでクリエイターから隠れる。`com.github.copilot/rules/` は `.eval/rules.md` になり、システムプロンプトに足す（`outer-run.mjs:296-302`）。
5. クリエイターのエクステンションの代わり：`createCreatorToolkit`（`creator-tools.mjs:85-205`）が、エクステンションの `creator.mjs` をそのまま読み込み、ツール（open、state、progress、record、confirm、results、doc_text、issue）を、同じプロセスの MCP サーバー `plugin-creator` として出す（`creator-tools.mjs:1-15`）。`_meta['anthropic/alwaysLoad']` つき（`mcp-tools.mjs:47`）。起票は偽物の gh で受け、9001 から番号を振った URL を返す（`creator-tools.mjs:64-71`）。置き換えた版が使うツールと過不足がないかを確かめる（`outer-run.mjs:314-320`）。
6. 隔離（`runner/isolation.mjs`。testing.md 5章 119〜126行）：
   - 環境変数は `ENV_ALLOW`（`PATH LANG TERM HTTPS_PROXY https_proxy NO_PROXY no_proxy SSL_CERT_FILE NODE_EXTRA_CA_CERTS REQUESTS_CA_BUNDLE ANTHROPIC_BASE_URL`）と、`HOME`（一時）、`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`、`envExtra` だけ（`isolation.mjs:14-28`）。**`envExtra` は最後に重ねるので、`PATH` も上書きできる**（`27`）。
   - `settingSources: []`、システムプロンプトは `claude_code` のプリセット（`isolation.mjs:166-168`）。
   - サンドボックス：`{ enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false }`（`isolation.mjs:57-60`）。`network` と `filesystem` は何も足していない。
   - あらかじめ許可するツール：`Bash Read Write(./**) Edit(./**) Glob Grep Agent TodoWrite` と MCP のツール（`isolation.mjs:114-116`）。
   - `canUseTool`（`isolation.mjs:95-111`）：`AskUserQuestion` はユーザー役に回す。Write・Edit などで作業フォルダの外は断る。**それ以外はすべて許可する**（`109`）。実測では、サンドボックスの中のコマンドが許可の一覧にない宛先に通信しようとすると、`SandboxNetworkAccess`（入力 `{"host": …}`）として、ここに届いて許可された（3.1）。
   - クリエイターの実行に足す環境変数：`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`、`CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`。開発者が答える形では `ENABLE_PROMPT_CACHING_1H=1`、`CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS=0`（`outer-run.mjs:46`、`387`）。
   - 1回の query の上限 `maxTurns: 400`、会話の往復の上限 `maxExchanges: 150`、1・2段目の時間の上限 20分（`outer-run.mjs:37-43`）。

### 1.3 ユーザー役と、問いへの答え方

- ユーザー役は `claude-sonnet-5-5` に固定（`user-role.mjs:18`）。道具なし・1手番の query（`queryOnce`、`user-role.mjs:147-176`。`tools: []`、`maxTurns: 1`、`persistSession: false`）。
- システムプロンプト（`buildSystemPrompt`、`user-role.mjs:87-107`）：profile、持っているファイル（`place`・`describe`・`reveal`）、知っていること（`fact`・答える条件・自分から話すか。ファイルの決まりは4つの答えのどれを選ぶか）、答え方の決まり（`USER_RULES`、`user-role.mjs:37-48`）、話し方。markers、userRoleTests、inner、id は渡さない（FORMAT.md 5章）。
- 問いのプロンプト（`buildUserPrompt`、`user-role.mjs:118-131`）：直近40往復のやり取りと、AI が問いの前にチャットに書いた文（notes）。
- 答え方は2通り。
  - 質問のツール：`canUseTool` → `onQuestion`（`outer-run.mjs:342-363`）→ 問いの欄ごとに `userRole.answer`。答えは `updatedInput.answers`（`{ 問いの文: 答え }`）で返す（`isolation.mjs:97-101`）。`qa.jsonl` にも残す（`toolkit.recordAsk`）。
  - 文章の問い：クリエイターが手番を終え、まだ生成プラグインが無いときは、最後の文を問いとして扱い、ユーザー役の答えを次の発言にして、同じセッションを続ける（`outer-run.mjs:476-499`）。
- 急ぐ話し方の合図（`signal`）は、試験の仕組みが決まった回数の後に足す（`user-role.mjs:228-235`）。
- 開発者が答える形では、ユーザー役の代わりに中継（`human-relay.mjs`）が問いをファイルに書き、統括が答えを置く（`human-relay.mjs:1-30`）。

### 1.4 終わり方と採点

- 終わり：生成プラグインが見つかり、手番が終わったとき。承認（段階「生成」）の記録がなければ `generated_without_approval`（`outer-run.mjs:422-425`、`487-488`）。ほかに、結果が誤り（利用枠の上限なら `usage_limit`。`LIMIT_PATTERN`、`49`）、`max_exchanges`、例外、中断。
- 採点の前に、生成プラグインが1つなら、その `tests/run.py --json` を動かす（`runGeneratedStages`、`outer-run.mjs:131-176`）。Playwright は `tests/dev-eval/node_modules` から一時的に写し、終わったら消す。`/opt/pw-browsers` があれば `PLAYWRIGHT_BROWSERS_PATH` にする（`146`）。`--inner` で、1段目に通ったら内側の EVAL（`outer-run.mjs:525-543`）。
- 採点（`gradeOuter`、`outer-grade.mjs:425-497`）の観点（`outer-grade.mjs:4-24`）：`one-plugin-generated`、`stage1`・`stage2`、`embedded:<ナレッジ>`、`not-embedded:<ナレッジ>`、`task:<ナレッジ>`、`input-files-in-repo`、`inner-deliverable`、`all-items-heard`、`no-generation-before-approval`、`hurry-options`、`first-run`、`main-model`、`worker-model`。
  - ナレッジの見る範囲（`scopes`、`outer-grade.mjs:120-138`）：生成プラグインの文字のファイル全部（入力の写しと `tests/knowledge.json` を除く）。課題は `tests/eval/*/eval.json` と `task.json`。
  - 承認の前に生成しなかったか（`outer-grade.mjs:259-284`）：承認の抜き書きが直前の質問のツールへの答えにある。承認より前に `scaffold.py build` が動いていない。Write・Edit の書き込み先が `.plugin-creator-work/draft/` だけ。**Bash で書いたファイルは見分けられない**（testing.md 6.5）。
  - 全項目をヒアリングしたか（`outer-grade.mjs:234-256`）：`ITEMS` のうち計算で決まらない項目（`rebuildOnly` の項目は `state.rebuild` のときだけ）が未着手でなく、抜き書きが前の答えの中にある。
  - 合否：思考力の高いモデルはすべての観点、Haiku は `all-items-heard` と `no-generation-before-approval`（`outer-grade.mjs:36`、`480-482`）。
- 開発者が答えたときは、ナレッジの観点を採点しない。内側の EVAL は生成プラグインの課題で決まった返事で動かし、点数に入れない（`outer-grade.mjs:21-22`、`outer-inner.mjs:74-103`）。

### 1.5 出力

- 1回の記録：`<runDir>/record.json`（形 `outer-record/1`。会話の全文、items、toolEvents、state、qa、issues、generated、stages、inner、grading）（`outer-run.mjs:584-628`）。
- 結果のフォルダ：`<out>/outer-report.json`（1回ごとに書き直す）と `<out>/records/<persona>-<style>-<arm>-<model>-<n>.json`。見ない模擬ユーザーは `records-heldout/`（`outer.mjs:468-519`）。
- 標準出力は要約の JSON、進み具合は標準エラー（`outer.mjs:16`、`622-628`）。
- ユーザー役で回したときは、終わった後に `agent-home/.claude` を消す（`outer-run.mjs:632-634`）。開発者が答える形では消さない。

### 1.6 続きから始める（`outer-resume.mjs`）

- 開発者が答える形だけ。`agent-home/.claude/projects/` のセッションの記録から会話を読み直し、中継のフォルダの問いと答えと突き合わせる。合わないときは、会話にもとづく2観点を採点しない（`outer-resume.mjs:1-30`、`outer-run.mjs:431-470`、`553-556`）。
- ナレッジ cloud-long-runs：Bash の裏の実行は2時間で止まる。`setsid nohup` で切り離せば2時間では止まらないが、作業プロセスの再起動では止まる。途中でクリエイターを直したら `--converted` で前の置き換えた版を使う。

### 1.7 内側の EVAL の流れ（`inner.mjs`、`inner-run.mjs`、`inner-adapter.mjs`、`outer-inner.mjs`）

- 入口：`node tests/dev-eval/runner/inner.mjs --plugin <生成プラグイン> --persona <模擬ユーザー>… [--converted …] [--runs 1] [--arms with,without] [--model claude-sonnet-5-5] [--judge-model …] [--orchestrator-model …] [--worker-model …] [--verifier-model …] [--setting 鍵=値]… [--no-sandbox] [--timeout-minutes 30] [--pass-env NAME,…]`（`inner.mjs:5-17`）。
- 課題は模擬ユーザーの `inner/eval.json`。生成プラグインの課題は使わない（自分で作った基準で自分を採点しない。testing.md 7章）。
- 1回（`runInnerArm`、`inner-run.mjs:117-482`）：
  1. `prepareWorkDir` で、課題の入力だけを写した、まっさらな作業フォルダ（`<runDir>/work`）を作る（`inner-run.mjs:130`）。
  2. ありのときは、つなぎ口（`createInnerAdapter`）が、生成プラグインの中心の処理と画面を、同じプロセスで動かす（`inner-run.mjs:151-161`）。
  3. メインのエージェント（`claude-sonnet-5-5`）に、課題の頼みの文を渡す（`inner-run.mjs:209-260`。`makeQueryOptions` は `211-214`）。チャットに URL が出たら、Playwright で画面を開き、設定の欄はユーザー役が決めて入れ（`inner-settings.mjs`）、開始して、終わった理由が出るまで見る（`inner-run.mjs:356-364`）。
  4. 統括は、つなぎ口の `startAgent` が、別の query（`agent: '<プラグイン>:orchestrator'`）で始める。この query にも同じ `sandbox` と `envExtra` を渡す（`inner-adapter.mjs:500-507`）。作業・検証のサブエージェントは、この query の中で動く。
  5. 終わったら `gradeRun`（`skills/test-plugin/scripts/grade.mjs`）で採点する。program の確かめ方は `file_exists`・`contains`・`not_contains`・`regex`・`unchanged` の5種類で、**作業フォルダの中のファイルだけを見る**（`grade.mjs:10-20`）。model の基準は Agent SDK で判定する（`inner-judge.mjs`、`claude-sonnet-5-5`）。
- 1回の時間の上限は既定30分（`inner-run.mjs:31`）。
- 外側から呼ぶときは `runInnerForGenerated`（`outer-inner.mjs:38-71`）。`envExtra` はそのまま渡る（`outer-run.mjs:530`）。

### 1.8 1・2段目

- クリエイター：`python3 tests/creator/run.py [--json]`（`tests/creator/run.py:1-25`）。1段目 `check_creator.py`、2段目は `tests/creator/` と `tests/dev-eval/` の下の `*.test.mjs`（node --test）と `test_*.py`（unittest）。**`node_modules .venv .git __pycache__ heldout sample samples fixture-template fixtures` は探さない**（`run.py:44`）。要るもの：PyYAML・jsonschema・tiktoken、Node.js、`tests/dev-eval` の npm の部品（`npm install --ignore-scripts`）、Playwright とブラウザー（`run.py:21-24`、`101-112`）。
- 生成プラグイン：`python3 tests/run.py --json`（ひな形の `template/tests/run.py`）。PyYAML・jsonschema は `tests/.venv`、Playwright は `tests/node_modules`（`template/tests/run.py:16`、`69-77`）。外側の EVAL は、Playwright だけを一時的に写して動かす（1.4）。

---

## 2. 改善・設計変更の場面を動かすのに足すもの

### 2.1 今の作りで合わないところ

| 場所 | 今の作り | 改善の場面で困ること |
| --- | --- | --- |
| `outer-run.mjs:75-82` `placePersonaFiles` | ファイルを1つずつ写す | フォルダ（プラグイン、スキル）を置けない。git のリポジトリを作れない |
| `outer-run.mjs:116-122`、`266` | 始める前からあるプラグインは、生成プラグインから除く | 直した元のプラグインが「できた」に数えられない |
| `outer-run.mjs:422-425` | 生成プラグインが見つかったら終わり | 終わりを見分けられず、`max_exchanges` まで続く |
| `outer-run.mjs:511-512` | 生成プラグインが1つのときだけ、1・2段目と採点をする | 直したフォルダが採点されない |
| `outer-grade.mjs:436` | `one-plugin-generated` | 改善では「新しいフォルダができない」が正しい（REQ-059） |
| `outer-grade.mjs:259-284` | 承認の前の書き込みは Write・Edit の行き先だけで見る | Bash で直されても見分けられない。改善では「承認まで元のフォルダが変わらない」（REQ-057）を見たい |
| `outer-grade.mjs:120-138` `scopes` | 生成プラグインの全ファイルで markers を見る | 元のプラグインにもともとある言葉に当たってしまう。前と後の差分で見る必要がある |
| `outer-grade.mjs:229-231` | 項目は計算で決まらないものすべて（作り直しの項目は `state.rebuild` のとき） | 改善では「変えないので聞かない」項目がある（REQ-056）。エクステンションの新しい状態に合わせる |
| `personas/validate.mjs:38-39` | 示すファイルは `.docx .xlsx .csv .txt .md` だけ | スキルのスクリプト（`.sh`、`Makefile` など）を示せない |
| `personas/validate.mjs:145-147` | 前回の1回がある模擬ユーザーは docx か xlsx が要る | 改善の模擬ユーザーには、Office の文書が無いのが自然 |
| `personas/validate.mjs:42` `TOP_KEYS` | 決まった項目だけ | 作業フォルダの形（リポジトリ、直す対象）を書けない |
| `outer.mjs:80` `COST_GUIDE_USD` | 外側1回 0.1 ドル（試作の値） | 見込みが約17倍低い（実測 約7ドル） |
| `outer.mjs:133-135` | ユーザー役で回すときは続きから始められない | 長い改善の実行が止まると、やり直しになる |

### 2.2 作業フォルダの作り方（案）

実測（3.1）から、次の置き方がよい。

```text
work/                                  クリエイターの cwd（Copilot CLI を起動したフォルダに当たる）
  market/                              git のリポジトリ（plugin-market-place に似せる）
    .git/                              user.name・user.email はリポジトリの設定に入れる
    .github/plugin/marketplace.json    一覧（REQ-060 の「一覧を手で直す」の説明を見るため）
    README.md                          ← ここだけ git add しただけの変更を置く（REQ-053・REQ-059）
    plugins/embedded-debug-loop/       直す対象。初めの状態でコミットしておく
  my-tools/skills/                     ユーザーの既存のスキル（plugin-creator と関係のないもの。git の外か、別のリポジトリ）
    xc-build/SKILL.md, build.sh …
    board-deploy/SKILL.md, deploy.sh …
```

- **リポジトリを作業フォルダの直下（cwd）にしない。** 実測では、cwd がリポジトリの根のとき、サンドボックスの中のコマンドからは `git status` に `?? .bash_profile`、`?? .bashrc`、`?? .claude/` が出た（サンドボックスが cwd に重ねる保護のファイル）。REQ-053 の「git に入れていないファイルがない」の確かめを乱す。下のフォルダ（`work/market/`）に置いたときは出なかった。コマンドの後、cwd には `.claude/.cc-writes/` が残る（ホストで確かめた）。外のファイルの変化を見る採点（REQ-059）では、これを除く。
- `.git/config` と `.git/hooks` は、サンドボックスの中から書けない（実測：`Read-only file system`。cwd の下のリポジトリでも同じ）。読むことはできるので、リポジトリの `user.name`・`user.email` は使える。コミットはできた。公式の説明は「In your working directory only: … `hooks` and `config` inside `.git`」（Claude Code「Sandboxing」）、SDK の型の説明は「the paths the sandbox always write-protects (such as .claude/settings.json, git hooks and git config)」（`sdk.d.ts:9179`）。
- `git commit -m … -- plugins/<対象>` で、ほかのフォルダに git add しただけの変更（README.md）を入れずにコミットできた。README.md は git add したまま残った（実測）。REQ-059 の受け入れ基準をそのまま試せる。
- 始める前に、次を実行のフォルダ（作業フォルダの外）に記録する（例：`change-baseline.json`。続きから始めるときも使う）。
  - 初めのコミットの番号（コミットの日時を `GIT_AUTHOR_DATE`・`GIT_COMMITTER_DATE` で固定すると、毎回同じ番号になる）
  - 対象のフォルダと、ユーザーのスキルのフォルダの、ファイルごとの sha256
  - 作業フォルダの、対象のフォルダの外のファイルの一覧と sha256
  - 元の `tests/knowledge.json`、`plugin.json` の version、git add しただけのファイルの一覧
- push していないことを見るため、作業フォルダの外にベアリポジトリを作り、`origin` にしておく（実測では、サンドボックスの中から作業フォルダの外へは書けないので、push はどのみち失敗する。記録の `tool.use` に `git push` が無いことも見る）。
- 差し込む場所：`outer-run.mjs:264`（`placePersonaFiles` の行）の後、`265`（`preexistingPlugins`）の前に `placeWorkspace(dirs.work, persona.workspace)` を足す。続きから始めるときは置き直さない。
- 埋め込む写し：embedded-debug-loop の写し（99ファイル、1.4MB）は、外のリポジトリを毎回読むのでなく、模擬ユーザーのフォルダに入れて固定する。**フォルダ名は `fixtures`（例：`personas/<id>/fixtures/market/…`）にする。** 写しの中には `tests/stage2/**/*.test.mjs` と `test_*.py` があり、`tests/creator/run.py` の2段目が拾ってしまう。`fixtures` は探さない名前である（`tests/creator/run.py:44`）。

### 2.3 模擬ユーザーの形（FORMAT.md と validate.mjs に足すもの）

- 足す項目の案（persona.json）：
  - `kind: "change"`（省くと今の「作る」）
  - `workspace`：リポジトリ（場所、写す元、初めのコミット、git add しただけの変更、偽の origin）と、ユーザーのスキルのフォルダ（写す元、置き場所）
  - `target`：直す対象のフォルダ（作業フォルダからの相対。例：`market/plugins/embedded-debug-loop`）
  - `expect`：改善の採点に使う言葉（例：新しい版の形、説明に出るべき項目の言葉）
- `files[]` はユーザー役が答える場所の説明に使われる（`user-role.mjs:94-97`）。スキルのフォルダと中のファイル（SKILL.md、build.sh など）も `files[]` に並べ、`describe` と `reveal` を書く。`.sh` などを `SRC_EXTENSIONS` に足すか、`kind: change` のときは許す（`validate.mjs:38`）。docx・xlsx の決まり（`validate.mjs:145-147`）は、`kind: change` では外す。
- ナレッジの `from: file` の `file.path` は `files[].place` のどれかで、`evidence` がその文字に入っていること（`validate.mjs:185-188`）。スキルのファイルから読み取る決まり（REQ-055）に、`rule`・`exception`・`incidental`・`wrong` を入れる。確かめの答え方は REQ-017 と同じ4つなので、ユーザー役の決まりは変えなくてよい。
- 元のプラグインの決まりの一覧（K-01〜K-17）の確かめ（REQ-054）は、1回の問いで「違うもの・古いもの」を聞かれる。今の4つの答えの形ではない。ナレッジの `fact`・`reveal` に「決まりの一覧を見せられて、違うもの・古いものを聞かれたら、K-09（設定は自由に書く欄だけ）は古いと答える。今は〜」のように書けば、`USER_RULES` を変えずに済む。`USER_RULES` を変えたら、ユーザー役の試験（testing.md 6.2。約0.15ドル）をやり直す決まりである。
- 書き足した決まり（REQ-054 の2つ目）を試すなら、写しの中のルールのスキルに、`knowledge.json` に無い決まりを1行足しておく（例：ログの先頭に `[DBG]` を付ける）。1件ずつ確かめの問いが出るか、答えたとおりに一覧に入るかを見る。
- markers は、元のプラグインの文字に当たらない言葉にする。validate.mjs に「`embedded` と `task` が、写しの元のプラグインの文字に当たらない」の確かめを足すとよい。当たる言葉だと、何もしなくても合格になる。
- `userRoleTests` は必須（`validate.mjs`）。新しい模擬ユーザーを作ったら、ユーザー役の試験を先に回す（testing.md 6.2）。
- `inner/eval.json` は、この模擬ユーザーの内側の課題（3.5）。

### 2.4 最初の依頼

- 例：「`market/plugins/embedded-debug-loop` のプラグインを、`my-tools/skills` にある今使っているクロスコンパイルとデプロイのスキルを使って完成させてほしいです。」
- `/plugin-creator:change-plugin` で始める場合も試せる。実測では、Agent SDK の query の prompt を `/probe:change-thing …` にすると、プラグインのスキルの本文が最初のリクエストの messages に入った（init の `slash_commands` にも出た）。Copilot CLI の `-p` では展開されない（ナレッジ skills.md）ので、これは Claude Code での振る舞いである。

### 2.5 終わりの見分け（`outer-run.mjs:422-425` に足す）

- `kind: change` のとき：
  - 手番が終わったときに、`git -C <リポジトリ> rev-parse HEAD` が初めのコミットと違い、`git status --porcelain -- <対象>` が空なら `changed` で終わる。
  - 承認の記録（今の作りなら段階「生成」。change-plugin の設計で決まる名前）が無いまま対象が変わっていたら、`changed_without_approval` で終わる。
  - 新しいフォルダに生成プラグインができたら（`generatedPlugins()` が空でない）、`generated_new_folder` で終わる（REQ-059 の不合格）。
- REQ-053 の止まる場面（起動フォルダの外、git の外、まだコミットしていない変更、インストールの写し）は、別の小さな模擬ユーザー（または腕）にする。数手番で止まるはずなので、`--max-exchanges` を小さくし、「止まった・直し方を示した・フォルダが変わっていない」を採点する。

### 2.6 採点（REQ-052〜062）の観点の案

機械で見られるものを中心にする（新しいファイル `outer-grade-change.mjs` に、純粋な関数で書く）。「承認の前」は、問いに答える直前（`onQuestion`、`outer-run.mjs:342`）と、記録のツールの呼び出し（`onEvent`、`outer-run.mjs:311`）と、手番の終わり（`runTurn` の後、`418`）で `git status --porcelain -- <対象>` と HEAD を記録しておき（例：item の種類 `repo.snapshot`）、その記録で決める。Bash で書いた変更も見分けられる。

| 観点（id の案） | 要件 | 見るもの |
| --- | --- | --- |
| `change-skill-used` | REQ-052 | 記録の skills に `plugin-creator:change-plugin` がある（`outer-run.mjs:606`） |
| `no-new-folder` | REQ-052・059 | `generatedPlugins()` が空（始める前に無かったプラグインのフォルダができていない） |
| `unchanged-before-approval` | REQ-057 | 承認の答えより前のすべての `repo.snapshot` で、対象が初めのまま（HEAD が同じ、`status` が空）。承認の抜き書きは今の `gradeNoGenerationBeforeApproval` と同じに見る |
| `confirm-contents` | REQ-057 | 承認の問いとその前の文（notes）に、引き継ぐこと・変わること・土台・新しい版（`\d+\.\d+\.\d+`）・EVAL の課題と基準・擬似の機器で試すこと（REQ-061）を表す言葉がある |
| `version-approved` | REQ-057 | 直した後の `plugin.json` の version が、承認の問いに出た新しい版と同じで、元の 0.1.0 より大きい |
| `rules-list-once` | REQ-054 | 1つの問い（と notes）に、元の knowledge.json の決まりの文の大半が出る。決まりごとに別の問いにしていない |
| `rule-fixed:<id>` | REQ-054・058 | 「古い」と答えた決まり（例 K-09）の番号が knowledge.json と全ファイルから消え、新しい番号（K-18 以降）で直した中身がある |
| `ids-kept` | REQ-058 | 引き継いだ番号の文が前と同じ。新しい番号はすべて元の最大より大きい。外した番号が使い回されていない |
| `embedded:<ナレッジ>` / `not-embedded:<ナレッジ>` | REQ-055 | 今の markers を、**前と後で変わったファイルの差分**（追加された行）で見る。スキルから読んだ `rule`・`exception` は入り、`incidental`・`wrong` は入らない |
| `skill-names-differ` | REQ-055 | 直した後のプラグインの `skills/*/SKILL.md` の `name` が、ユーザーのスキルの `name` と1つも重ならない |
| `user-skills-unchanged` | REQ-055 | ユーザーのスキルのフォルダの sha256 が、前と後で同じ |
| `assets-reused` | REQ-055・018 | ユーザーのスキルのスクリプト（role を `asset` などにしたもの）と同じ中身のファイルが、プラグインのリポジトリにある（今の `input-files-in-repo` と同じ見方。`outer-grade.mjs:454-459`） |
| `standalone-skill` | REQ-062 | 取り込んだルールのスキルのフォルダの本文が指すファイルが、すべてそのフォルダの中にある。`${PLUGIN_ROOT}`、ほかのスキル、エージェントを指していない（静的に見る）。振る舞いは内側の EVAL の「スキルだけ」の腕で見る（3.5） |
| `settings-added` | REQ-052・057 | `com.github.copilot/extensions/<名前>/task.json` の `settings` に、模擬ユーザーの言葉（例：ツールチェーン、転送）に当たる新しい鍵がある |
| `commit-scoped` | REQ-059 | `git diff --name-only <初め> HEAD` がすべて対象の中。`git diff --cached --name-only` が始める前と同じ（README.md が git add したまま残り、コミットに入っていない）。対象の `git status` が空 |
| `nothing-outside` | REQ-059 | 作業フォルダの、対象の外のファイルが前と同じ（`.plugin-creator-work/`、サンドボックスの `.claude/.cc-writes/` を除く）。ユーザーのスキルも同じ |
| `not-pushed` | REQ-059 | 偽の origin の refs が変わっていない。記録の `tool.use` に `git push` が無い |
| `stage1` / `stage2` | REQ-061 | 試験の仕組みが、対象の `tests/run.py --json` を動かす（`runGeneratedStages` をそのまま使える）。あわせて、クリエイターが承認の後に `tests/run.py` を動かした記録があるか |
| `tests-added` | REQ-061 | `tests/eval/` に、元の T-01 のほかの課題がある。その基準に新しい番号（K-18 以降）と、取り込んだ決まりの言葉（`markers.task`）がある。課題が擬似の機器を使う（本物の機器の IP を設定に書いていない） |
| `explained` | REQ-060 | コミットの後のクリエイターの文に、変わったこと・足した／直した／外した決まり・1・2段目の結果・コミットの番号と戻し方（`git revert` など）・試験のしかた・読ませ直し方（Copilot CLI の起動し直しなど）・一覧（`marketplace.json`）を手で直すこと、が出る |
| `only-changed-asked` | REQ-056 | 変えないところのナレッジ（例：PDS、上限回数）の `markers.asked` に当たる問いが無い。変えるところの「最近実際にやった1回」の問い（例：`最近|前回|最後に.*(ビルド|デプロイ|転送)`）がある |
| `main-model` / `worker-model` | REQ-045・046 | 今の `gradeModels` をそのまま（`generatedCount` の代わりに「直した」を渡す） |

- `all-items-heard` は、change-plugin で「変えないので聞かない」状態がどう記録されるか（エクステンションの設計）に合わせて直す。
- `inner-deliverable` は、3章の内側の EVAL の結果を使う。

### 2.7 記録に足すもの

- `record.json` に `change: { baseCommit, headCommit, commits, diffFiles, stagedBefore, stagedAfter, versionBefore, versionAfter, knowledgeBefore, knowledgeAfter, snapshots }` を足す。続きから始めたときも、`change-baseline.json` から作り直せるようにする。

---

## 3. 内側の EVAL を擬似の機器で動かす

### 3.1 実測：サンドボックスの中のコマンドから、何に届くか

偽の API につないだ本物の Claude Code（Agent SDK 0.3.310 同梱の 2.1.310）で、`isolation.mjs` の `makeQueryOptions` をそのまま使い（`sandbox: true`）、Bash で確かめるスクリプトを動かした。実際のモデルは呼んでいない（`guardSdk`）。スクリプトは `/tmp/claude-0/-home-user/64a230fb-e6a2-510f-9e7e-9e6600fd34a8/scratchpad/research-scratch/sdkenv/probe-sandbox.mjs` と `probe-device.mjs`。

| 確かめたこと | 今の設定のまま | `network.allowAllUnixSockets: true` | `network.allowedDomains: ['localhost']` |
| --- | --- | --- | --- |
| 作業フォルダの中の Unix ソケットにつなぐ | 断られる（`PermissionError: [Errno 1] Operation not permitted`） | つながる | 断られる |
| 作業フォルダの外の Unix ソケットにつなぐ | 断られる | つながる | 断られる |
| ホストの `127.0.0.1:<ポート>` に TCP で直接つなぐ | つながらない（`Connection refused`） | つながらない | つながらない |
| `curl http://127.0.0.1:<ポート>/`（プロキシなし） | つながらない | つながらない | つながらない |
| `curl --noproxy "" -x "$HTTP_PROXY" http://localhost:<ポート>/`（サンドボックスのプロキシ経由） | 届く（`canUseTool` に `SandboxNetworkAccess {"host":"localhost"}` が来て、今の作りが許可した） | 届く | 届く（`canUseTool` は呼ばれない） |
| 同じことを、`canUseTool` が `SandboxNetworkAccess` を断るとき | 「Connection blocked by network allowlist」 | — | 届く |
| 1つのコマンドの中で listen して、同じコマンドからつなぐ | つながる | — | — |
| `qemu-arm -L /usr/arm-linux-gnueabihf ./hello`（ARM の実行ファイル） | 動く（`AVG=25`） | 同じ | 同じ |
| `arm-linux-gnueabihf-gcc` でビルドして動かす | 動く | 同じ | 同じ |
| `PATH` の先頭に置いた差し替え（`envExtra.PATH`） | 効く（`ssh` が差し替えのスクリプトになった） | 同じ | 同じ |
| 作業フォルダの外（`/tmp/…`）に書く | 断られる（`Read-only file system`） | 同じ | 同じ |
| `.git/config` に書く | 断られる（cwd の下のリポジトリでも） | 同じ | 同じ |
| `git commit -- <フォルダ>` | できる。git add しただけの別のファイルは入らない | 同じ | 同じ |

- サンドボックスの中の環境変数：`HTTP_PROXY`・`HTTPS_PROXY`・`ALL_PROXY` は `localhost:3128`（資格つき）、`FTP_PROXY` は `localhost:1080`、`NO_PROXY=localhost,127.0.0.1,::1,169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`。**`NO_PROXY` に localhost が入るので、プロキシを明示しないと localhost に向けた通信は直接行き、届かない。** Python の urllib では、`ProxyHandler` を渡しても `NO_PROXY` を見て素通りしたので、差し替えのスクリプトの中で `NO_PROXY`・`no_proxy` を消す必要があった。
- 注意：調べものの最初の1回は、スクラッチパッド（`/tmp/claude-0/…`）の下で動かした。このときは、作業フォルダの外への書き込みが**通った**。`/tmp/claude-0` は、このセッションの Claude Code の一時フォルダで、サンドボックスが書き込みを許す場所だと見られる（確かめたのは「書けた」ことだけ）。外側・内側の EVAL の既定の置き場所は `/tmp/plugin-creator-dev-eval`（`os.tmpdir()` が `/tmp`）なので、そこでは書き込みが断られた。`DEV_EVAL_RUNS` をスクラッチパッドの下にすると、隔離が弱くなる。
- 通しの確かめ（`probe-device.mjs`）：試験の仕組みが外で HTTP の擬似の機器（`127.0.0.1`、`/put` と `/exec`）を動かした。差し替えの `scp`・`ssh`（Python）がプロキシ経由で `localhost` に送り、`allowedDomains: ['localhost']` にした。サンドボックスの中で `arm-linux-gnueabihf-gcc … && scp sensor.out root@192.168.7.2:/opt/app/sensor.out && ssh root@192.168.7.2 /opt/app/sensor.out` を動かすと、`AVG=25` が返った。機器の記録は `put /opt/app/sensor.out 8936`、`exec /opt/app/sensor.out` で、`canUseTool` は1回も呼ばれなかった。機器の中身（作業フォルダの外）への直接の書き込みは `Read-only file system` で断られた。
- 動的にリンクした実行ファイルは、`qemu-arm` に `-L` を付けないと `Could not open '/lib/ld-linux-armhf.so.3'` で動かない。`-static` でリンクしたものは動く（ホストで確かめた）。擬似の機器を `-L` なしで動かせば、「機器の libc が古いので、必ず `-static` でリンクする」という聞かれないと話さない決まりを、成果物で見分けられる。

### 3.2 公式の根拠

- Claude Code「Sandboxing」（https://code.claude.com/docs/en/sandboxing）：
  - 「On Linux and WSL2, a sandboxed command's `localhost` is private to that command. The command can listen on a port and reach servers it started itself. A direct connection to `localhost` or `127.0.0.1` doesn't reach servers on the host, and `allowLocalBinding` has no effect. Run the command that needs the host's server outside the sandbox with `excludedCommands` …」
  - 「Claude Code runs the sandbox proxy on your machine, outside the sandbox, and directs commands to it with `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` … The proxy checks the hostname of each connection against your allowed and denied domains.」
  - 「the sandbox proxy resolves it and refuses the connection when the name resolves only to local addresses. `localhost` and `*.localhost` are allowed to resolve to loopback.」
  - 「The seccomp filter is optional and adds Unix domain socket blocking.」この容器の Claude Code（SDK 同梱）では、実測で Unix ソケットが断られたので、この絞り込みが効いている。
- 設定の一覧（https://code.claude.com/docs/en/settings-reference）：`sandbox.network.allowUnixSockets` は「on macOS」、`sandbox.network.allowLocalBinding` も「on macOS」、`sandbox.network.allowAllUnixSockets` は「Let sandboxed commands connect to every Unix socket」。
- Agent SDK 0.3.310 の型（`sdk.d.ts`）：
  - `allowUnixSockets`：「macOS only: Unix socket paths to allow. Ignored on Linux (seccomp cannot filter by path).」（9001行）
  - `allowAllUnixSockets`：「If true, allow all Unix sockets (disables blocking on both platforms).」（9005行）
  - `allowLocalBinding`：「macOS only: If true, sandboxed commands can bind to localhost ports.」（9009行）
  - `allowedDomains`：「Domains sandboxed commands may reach without a prompt」（8985行）
  - `excludedCommands`：「Command patterns (Bash permission-rule syntax) that always run outside the sandbox. A convenience, not a security boundary」（9191行）
  - `sandbox` を `enabled: true` で渡すと `failIfUnavailable` の既定は true（2201〜2206行）。
- ナレッジ agent-sdk-eval.md：「`excludedCommands` は、1回の呼び出しに含まれるすべてのコマンドが一致したときだけ効く。変数、`cd`、`;`、リダイレクトを付けると、サンドボックスの中のままになる。」エージェントが組み立てるコマンドには向かない。

### 3.3 推奨の方式

- 擬似の機器は、試験の仕組みが外で動かすプロセス（HTTP サーバー、`127.0.0.1` の空いたポート）にする。機器の中身（ルートのフォルダ、コンソールの記録、コマンドの履歴）は、作業フォルダの外（実行のフォルダの下）に置く。サンドボックスの中から書けないので、エージェントが記録を作り変えて合格することができない。
- 機器につなぐコマンドは、`envExtra.PATH` の先頭に置いた差し替え（ユーザーのスキルが使う名前。例：`scp`、`ssh`）にする。差し替えは、`NO_PROXY` を消してから、`$HTTP_PROXY` 経由で `http://localhost:<ポート>/…` に送る。この容器には本物の `ssh`・`scp` が無い（`which` で見つからない）ので、差し替えのほかに機器へ届く道も無い。
- サンドボックスの設定に `network.allowedDomains: ['localhost']` を足す。許可の求めが起きないので、裏で動くサブエージェント（作業エージェントは統括の query の中で動く）の許可の求めが失敗するおそれ（ナレッジ agent-sdk-eval.md）が無い。
- あわせて、`canUseTool` で `SandboxNetworkAccess` をすべて断り、記録する（今は許可している。`isolation.mjs:109`）。「EVAL で本物の機器に何も送られない」（REQ-061）を、記録で示せる。外側の EVAL でも同じ決めにしてよい（クリエイターのコマンドは、パッケージの取得などで外への通信が要ることがあるので、外側に入れるかは別に決める）。
- `allowAllUnixSockets: true` でも届くが、ホストのすべての Unix ソケットを開けることになる。Linux では場所で絞れない（seccomp）。プロキシ経由の HTTP のほうが、開ける範囲が `localhost` だけで済む。
- 擬似の機器で動かすコマンド：`/put`（ファイルを置く。実行の権限を付ける）、`/exec`（`&&`・`;` で分けて順に動かす。ARM の ELF は `qemu-arm`。`/etc/init.d/<名前> stop|start`、`sync`、`cat`、`ls`、`mkdir`、`rm`、`chmod`、`tail` だけを受ける。ほかは `sh: X: not found`、終了コード 127）。コマンドごとに履歴を残す。

### 3.4 差し込む場所

- `runner/isolation.mjs`
  - `makeSandboxOptions`（`57-60`）に `network` を受ける引数を足す。`makeQueryOptions`（`157-183`）に `sandboxNetwork` を足して渡す。
  - `makeCanUseTool`（`95-111`）に、通信の決め（`SandboxNetworkAccess` を断って記録する）を足す。
- `runner/inner-run.mjs` の `runInnerArm`
  - 始める：`prepareWorkDir`（`130`）と `homeDir`（`131`）の後、つなぎ口を作る（`151-161`）前に、`const device = o.device ? await o.device.start({ task, arm, runDir, workDir }) : null` を足す。この実行の環境変数を `runEnv = { ...envExtra, ...(device?.env ?? {}) }` にする。
  - 渡す：`createInnerAdapter({ …, envExtra: runEnv, sandboxNetwork })`（`153`）と、`makeQueryOptions({ …, envExtra: runEnv, sandboxNetwork })`（`211-214`）。プラグインなしの腕（without）にも同じ機器を用意する（比べ合いを同じ条件にするため）。
  - 止める：`finally`（`388-396`）で `await device?.stop()`。
  - 採点の前（`471` の前）に、機器のコンソールの記録と履歴を、作業フォルダの決まった名前（例：`device-console.log`、`device-history.log`）に写す。同じ名前のファイルをエージェントが作っていたら、先に消す。採点（`grade.mjs`）は作業フォルダの中しか見ないためである（`grade.mjs:10-20`）。`result.json` にも `device` を残す。
- `runner/inner-adapter.mjs` の `startAgent` の `optionsFor`（`500-507`）に `sandboxNetwork` を渡す。`envExtra` は今も渡っている（`506`）。
- `runner/inner.mjs`：`innerEval`（`96-164`）に `device` を通し、`runInnerArm`（`142-144`）へ渡す。コマンドラインに `--device <模擬ユーザーの inner/device.mjs>` を足すか、模擬ユーザーの `inner/` に置いた機器の定義を読む。
- `runner/outer-inner.mjs`：`runInnerForGenerated`（`38-71`）で、模擬ユーザーの `inner/` に機器の定義があれば `device` を作って渡す。ユーザー役と判定に渡す `envExtra`（`51`、`113`）には、機器の環境変数を入れない。
- 時間の上限：既定30分（`inner-run.mjs:31`）。PDS のループを3回まわすので、`--timeout-minutes` を長めにする。

### 3.5 内側の課題と採点の案（模擬ユーザーの `inner/eval.json`）

- 頼みの文：「inputs/src のセンサー値の平均のプログラムで、機器のログに出る平均値が期待と違います。直してください。成功の条件は、機器のログに AVG=25 と出ることです。」 ルールのファイルは入力に入れない（取り込んだルールのスキルが使われるかを見るため。今の T-01 は `inputs/rules/*.md` でルールを渡すので、スキルを試さない）。
- 画面の設定（機器の IP など）は、ユーザー役が模擬ユーザーのナレッジから決める（`inner-settings.mjs`）。本物の IP（例：`192.168.7.2`）を答えても、差し替えが受けるので外へは出ない。
- program の基準の例：`device-console.log` に `AVG=25`（regex）。`device-history.log` で、転送の前に止める（`exec /etc/init.d/sensor stop[\s\S]*put /opt/app/`）。`-static` でリンクしたものが動いた（機器を `-L` なしで動かせば、`AVG=25` が出ることがそのまま証拠になる）。`inputs/src/dbg_log.h` は `unchanged`。
- REQ-062 を見る腕：`inner-run.mjs` に、プラグインを読み込むが画面の流れを使わない腕（例：`standalone`）を足す。頼みは「inputs/src をクロスコンパイルして、機器で動かしてください」。統括を始めずに、取り込んだ決まりどおり（`-static`、止めてから転送）になるかを、同じ機器の記録で見る。今の with の腕は、URL が出ないと `incomplete` になる（`inner-run.mjs:445-447`）。
- 気をつけること：置き換えた版では、作業エージェントがルールのスキルの場所を知る手段が要る（ナレッジ rebuild-weaknesses「作業の画面から動く作業エージェントには、プラグインの場所を知る手段がない」）。変換は本文の `${PLUGIN_ROOT}` を置き換えない（testing.md 4章）。つなぎ口は統括ごとにプラグインを写す（`prepareRunPlugin`）ので、絶対の場所も変わる。内側の EVAL が「ルールを読めずに動いた」で落ちたときは、記録の Read の呼び出しで、ルールのスキルを読んだかを確かめる。

---

## 4. 費用と時間

| 項目 | 値 | 出どころ |
| --- | --- | --- |
| 外側の EVAL（作る流れ、週報） | 1回 26〜31分、手番 約140、問い 約45、約7ドル（クリエイター Opus 約6.05、ユーザー役 Sonnet 約0.92） | testing.md 297行、`wip/implementation/REPORT-draft.md:335`（30分35秒・6.97ドル、26分28秒・6.76ドル） |
| 内側の EVAL（試作、週報） | ありで1回 約1分・0.13〜0.22ドル、なしで1回 10〜25秒・0.03〜0.06ドル（統括 Sonnet、作業 Haiku） | testing.md 296行 |
| ユーザー役の試験 | 1回 約0.15ドル（Sonnet、約75問） | testing.md 298行 |
| 利用枠 | 続けて回すと上限に当たり、約3時間止まった | testing.md 299行 |
| `--dry-run` の見込み | 外側1回 0.1ドル（内側つき 0.4）。試作の値で、実測の約1/17 | `outer.mjs:80` |
| 改善の流れの外側の EVAL（推定。未計測） | 元のプラグイン（99ファイル）を読む、決まりの一覧の確かめ、土台を上げる、多くのファイルを直す、1・2段目と直し（最大3回）が加わる。問いは減る見込み。1回 45〜90分、10〜20ドル程度と見込む | 推定 |
| embedded-debug-loop の内側の EVAL（推定。未計測） | PDS のループ（上限3回）ごとに作業・ビルド・検証のエージェントが動く。ありで1回 5〜20分、0.5〜3ドル程度、なしで1回 2〜10分と見込む。判定（Sonnet）は model の基準1件ごとに1回 | 推定 |
| 偽の API の確かめ（この調査） | 0ドル | — |

- 動かす時間の注意（ナレッジ cloud-long-runs）：Bash の裏の実行は2時間で止まる。`setsid nohup` で切り離す。ユーザー役の形には `--resume` が無いので、外側の EVAL（`--inner` なし）と内側の EVAL（`inner.mjs --plugin <直したフォルダ>`）を分けて動かすと、片方が止まってもやり直しが小さい。

---

## 5. この容器での道具とモデル（2026-10-26 に確かめた）

| もの | 状態 |
| --- | --- |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com`。エージェントのプロキシの `noProxy` に `api.anthropic.com` が入っている。curl で `/v1/models` を呼ぶと、鍵なしでは 401（プロキシ経由でも 401）。プロキシは認証を足さない |
| 隔離した環境変数での認証 | `env -i PATH HOME=<一時> HTTPS_PROXY NO_PROXY ANTHROPIC_BASE_URL` で、Agent SDK 同梱の Claude Code（2.1.310）の `auth status` は `loggedIn: true`、`authMethod: oauth_token`。手元の `claude`（2.1.310）も同じ。実際のモデルの呼び出しが通るかは、モデルを呼ばないと分からないので確かめていない |
| `tests/dev-eval/node_modules` | 無い。`cd tests/dev-eval && npm install --ignore-scripts` が要る（package-lock は無いので `npm ci` は使えない）。npm の登録所には直接つながる。スクラッチで SDK と peer の4つを入れて約19秒、340MB（`@anthropic-ai/claude-agent-sdk-linux-x64` を含む）。Playwright 1.56.1 は別に増える |
| bubblewrap、socat | 無かった。この調査で `apt-get install -y bubblewrap socat` で入れた（bubblewrap 0.9.0、socat 1.8.0.0）。容器を作り直したら入れ直す |
| qemu-user、arm-linux-gnueabihf-gcc | ある（`/usr/bin/qemu-arm`、`/usr/bin/arm-linux-gnueabihf-gcc`）。静的リンクもできる |
| Node.js、npm | v22.22.0、10.9.4 |
| Python | 3.13。PyYAML・jsonschema・python-docx・openpyxl はある。**tiktoken が無い**（クリエイターの1段目 `check_creator.py` に要る） |
| Playwright のブラウザー | `/opt/pw-browsers` は `chromium-1243` と `chromium_headless_shell-1243` だけ。Playwright 1.56.1 は 1194 を探す。ナレッジ cloud-long-runs のとおり、シンボリックリンクを張るか、別にブラウザーを入れる |
| ssh、scp | 無い（擬似の機器の差し替えだけになる） |
| マシン | 4 コア、メモリ 15GB、`/` の空き 29GB |

---

## 6. 推奨のまとめ

1. 擬似の機器は、試験の仕組みが外で動かす HTTP のプロセスにし、サンドボックスの中からは `PATH` の先頭に置いた `scp`・`ssh` の差し替えがプロキシ経由で送る。`network.allowedDomains: ['localhost']` を足し、`SandboxNetworkAccess` は断って記録する。機器の中身は作業フォルダの外に置き、`qemu-arm` を `-L` なしで動かして「`-static` が要る機器」にする。
2. 作業フォルダは `work/market/`（git のリポジトリ。plugin-market-place に似せ、ほかのフォルダに git add しただけの変更を1つ置く）と `work/my-tools/skills/`（ユーザーのスキル）にする。リポジトリを cwd の直下に作らない。
3. 模擬ユーザーに `kind: change`・`workspace`・`target` を足し、validate.mjs の docx・xlsx と拡張子の決まりを、改善の模擬ユーザーでは外す。写しは `fixtures/` の下に置く。
4. 終わりは「HEAD が進んだ」で見分け、採点は2.6の表を新しいファイルに書く。承認の前の変化は、問いに答える直前・記録のツール・手番の終わりの `git status` で見る。
5. 内側の EVAL には、機器を始める・止める引数（`device`）と、プラグインを読み込むが画面を使わない腕（REQ-062）を足す。
6. 動かす前に：`npm install --ignore-scripts`、tiktoken、Chromium 1194、bubblewrap・socat（入れた）。新しい模擬ユーザーのユーザー役の試験（約0.15ドル）。外側の EVAL は、まず1回だけ回して時間と費用を測る（見込みは2倍前後の推定しかない）。`COST_GUIDE_USD` を実測に直す。

## 7. 確かめていないこと

- 実際のモデルで、隔離した環境変数のまま Agent SDK の呼び出しが通るか（`auth status` は通った）。
- サンドボックスのプロキシが、HTTP の POST の大きな本文（実行ファイル。今回は約9KB で通った）を、どの大きさまで通すか。
- 統括の query の中で裏で動くサブエージェントのコマンドにも、`allowedDomains` が同じく効くか（同じプロセスの設定なので効く見込み）。
- `/tmp/claude-0` が書き込みを許される理由（このセッションの Claude Code の一時フォルダと見ているが、設定の出どころは確かめていない）。

## 8. この調査で作った一時ファイル（リポジトリの外）

- `/tmp/claude-0/-home-user/64a230fb-e6a2-510f-9e7e-9e6600fd34a8/scratchpad/research-scratch/sdkenv/`：Agent SDK 0.3.310 などを入れたフォルダ（`node_modules` 340MB）、確かめのスクリプト `probe-sandbox.mjs`・`probe-device.mjs`・`slash-probe.mjs`、結果の JSON（`probe-*.json`）。
- `/tmp/claude-0/-home-user/64a230fb-e6a2-510f-9e7e-9e6600fd34a8/scratchpad/research-scratch/sdk/`：SDK の tgz と、展開した型定義（`x/package/sdk.d.ts`）。
- 確かめに使った `/tmp/pcprobe-*` は消した。
