# カスタムエージェント（GitHub Copilot CLI）

## 役割

- 主にマルチエージェント構成を作るために使う。
- マルチエージェント構成の中の1つのエージェントを定義する。
- 定義したエージェントを組み合わせて、マルチエージェント構成を作る。

## フロントマター

- ヘッダー部にフロントマターを書く。本文（エージェントへの指示）は 30,000 文字まで。
- 必須の項目は `description` だけ。`name` は任意で、省くとファイル名から作った ID になる。
- 主な任意の項目：
  - `model`：使うモデル（特に有効）。優先する順のリストでも書ける。
  - `tools`：使えるツール。省くと、すべてのツールを使える。
  - `mcp-servers`：そのエージェントだけが使う MCP サーバー。
  - `disable-model-invocation`、`user-invocable`：自動で呼ばれるか、人が選べるか。`infer` は退役扱い。
  - `include-custom-instructions`：サブエージェントとして動くときに、リポジトリの指示ファイルを受け取るか（下の節）。
- 項目の一覧は、Copilot CLI のコマンドリファレンスと、カスタムエージェントの設定リファレンスとで一部違う。
- 書き込みや読み取りの権限を決める専用の項目はない。`tools` で使えるツールを絞って決める。例：検証エージェントは `read` と `search` だけにして、成果物を直せないようにする。
- 呼び出せるサブエージェントを決める専用の項目は見当たらない。`tools` に `agent` を入れるかどうかで、ほかのカスタムエージェントを呼べるかが決まる。

## プラグインのエージェント（Copilot CLI 1.0.102 で実測）

- `com.github.copilot/agents/` のエージェントは、`<プラグイン>:<エージェント>` の名前になる（`task` ツールの `agent_type`、イベントの `agentType`。`--agent` にも使える：更新履歴 1.0.81）。定義の `description` つきで、メインのエージェントの `task` の選択肢に並ぶ。
- `description` に「チャットの頼みでは呼ばない」と書いても、選択肢には載る。呼べないようにする `disable-model-invocation: true` は、`task` での起動を断られる（実装の文字列と更新履歴 0.0.411。起動は試していない）。`task` で使うエージェントには書かない。
- サブエージェントとして動くカスタムエージェントは、`include-custom-instructions: true` でない限り、リポジトリの指示ファイル（`AGENTS.md`、`copilot-instructions.md`、`CLAUDE.md`）を受け取らない（更新履歴 1.0.86 と公式のコマンドリファレンス。指示ファイルのある作業フォルダでは動かしておらず、確かめていない）。
- 同じ名前のスキルやエージェントが、プロジェクトや個人のフォルダにあると、プラグインのほうは黙って無視される。先に読み込んだものが勝つ（プロジェクト、ユーザー、プラグインの順。公式の plugin reference。実機では確かめていない）。
- Copilot CLI は、サブエージェントのシステムプロンプトの、定義の本文の後ろに、ツールの使い方、「出力のリダイレクトやヒアドキュメントでファイルを作るな」、「まず自分でやり、カスタムエージェントは控えめに使え」、環境の情報を足す。ファイルを作るエージェントに編集のツールを渡さないと、この指示と衝突する。

## tools の書き方

- 別名で書く。大文字と小文字は区別しない。

  | 別名 | 意味 |
  | --- | --- |
  | `execute` | コマンドを実行する |
  | `read` | ファイルを読む |
  | `edit` | ファイルを書く・直す |
  | `search` | ファイルや文字を探す |
  | `agent` | ほかのカスタムエージェントを呼ぶ |
  | `web` | Web を検索する・取得する |
  | `todo` | タスクの一覧を作る |

- Claude Code のツール名（`Read`、`Edit`、`Write`、`Bash`、`Grep`、`Glob` など）も、互換の別名として受け付ける。
- MCP のツールは `サーバー名/ツール名`、サーバーのツールすべては `サーバー名/*` と書く。
- 別名は、サブエージェントのモデルの族で、渡るツールの名前が変わる（1.0.102 の実測）。
  - Claude の族：`read` → `view`、`search` → `grep`・`glob`、`edit` → `create`・`edit`
  - GPT の族（`gpt-6-luna`、`gpt-6.1-sol`）：`read` → `view`、`search` → `rg`・`glob`、`edit` → `apply_patch`（`type: "custom"` のツール）
  - どちらも：`execute` → `bash`・`read_bash`・`stop_bash`・`list_bash`、`agent` → `task`・`read_agent`・`list_agents`・`write_agent`
  - `web` は確かめられなかった。自前のモデルの窓口では、メインのエージェントにも Web のツールが載らなかった。
- 別名 `search`・`web` を書いたカスタムエージェントにツールが渡るよう直ったのは、更新履歴では 1.0.100 からである。

### サブエージェントのツールは、親の tools に絞られる（1.0.102 の実測）

- 更新履歴の 1.0.67（サブエージェントは親のツールの制限を引き継ぐ）と 1.0.68（入れ子でもカスタムエージェントのツールの絞り込みが続く）のとおり、サブエージェントが受け取るツールは、親の `tools` の範囲に絞られる。
  - 例：統括の `tools` に、検証エージェントが使うエクステンションのツールや、作業エージェントが使う `edit`・`execute` がないと、検証や作業の `tools` に書いてあっても渡らない（呼ぶと「Tool '…' does not exist. Available tools that can be called are view, grep, glob.」）。
- 親が `tools` を書かない（全ツールを持つ）と、子は自分の `tools` どおりに受け取った。親と子のモデルの族が違っても（統括が Claude、作業が GPT）、作業は `apply_patch` を受け取った。親に `tools` を書いて、子が必要な `edit` を足すだけでは、族が違うと子が `apply_patch` を受け取れなかった。親がメインのエージェント（全ツール）のときは、絞り込みは起きない。
- 親のツールを絞りたいときは、`tools` ではなく、フックの `preToolUse`（エクステンションの `onPreToolUse`）で拒む。拒んだ理由は、モデルに届く（[画面と Copilot CLI のつなぎ方](dashboard-integration.md)）。
- Claude Code は逆で、子のツールは親の `tools` に絞られない（Agent SDK 0.3.310、Claude Code 2.1.310 で実測）。

### ツールのないエージェントは、Claude Code で起動を断られる（2026年10月）

- make-idea の読み手（説明の文だけを読むエージェント）を `tools: [todo]` にしたら、Claude Code に置き換えた版（`todo` → `TodoWrite`）が、Agent SDK 0.3.310 の同梱の Claude Code で「Agent ... would be spawned with zero tools — refusing. ... unrecognized [TodoWrite]」と断られた。`TodoWrite` が、今の Claude Code のツールにないためである。メインのエージェントは、汎用のエージェントに定義の本文を写して代わりに動かした（決まりから外れた）。
- `tools` を空にすると、変換スクリプトが「すべてのツール」にする。道具の要らないエージェントにも、害の小さいツールを1つ渡す（make-idea の読み手は `read` だけにし、ファイルの場所を渡さない）。

## モデルの指定（2026年10月時点の公式ドキュメント）

- `model` に1つ、または優先する順のリスト（例：`model: [gpt-6-luna, claude-haiku-5.5]`）を書く。ユーザーのプランで使える最初の候補が使われ、どれも使えなければセッションのモデルになる。`model-policy` が `preferred`（既定）なら `/subagents` で上書きでき、`required` なら上書きできない。
  - 公式ドキュメントと実装が食い違う。今のコマンドリファレンスのフロントマターの表（Custom agent frontmatter fields）は、`model` を1つのモデル、優先する順のリストを `models`、方針を `modelPolicy` としている。一方、Copilot CLI の実装（1.0.98、1.0.102）と組み込みのエージェントの定義は、`model` にリストを書き、方針を `model-policy` と書く。
  - 1.0.102 の実測：`model` にリストを書いた作業エージェントは、リストの先頭のモデルで動いた（自前のモデルの窓口。先頭の名前がそのまま使われ、「プランで使えるか」の判断は働かない）。`models` の書き方は試していない。リストの2番目への切り替わり（先頭が使えないとき）は、確かめられていない。
- モデルが決まる順は、呼び出しごとの指定 → ユーザーの設定 → エージェントの定義 → 親のセッション。呼び出しごとの指定がリストより優先されることは、エクステンションから `tasks.startAgent` の `model` と `tools.updateSubagentSettings` で確かめた（1.0.102）。
- ユーザーがモデルを Auto にしていると、サブエージェントも `model` に関係なく Auto が選んだモデルになる。
- プラグインからは、ユーザーと話すメインのエージェントのモデルを決められない。マニフェストにモデルの項目がない。決めるのは、ユーザーの `/model`、`--model`、設定である。
- サブエージェントは、ユーザーに質問できない。Copilot CLI 1.0.98 と 1.0.102 で実測すると、組み込みのサブエージェントにも、カスタムエージェント（`tools` に `ask_user` を書いても）にも、`ask_user` は渡らなかった。`--agent` でメインのエージェントに選んだカスタムエージェントは使える。Claude Code でも、質問のツールはすべてのサブエージェントから取り除かれる。ユーザーとの対話は、メインのエージェントに残す。
- サブエージェントが受け取るのは、自分のシステムプロンプトと、渡した prompt だけで、返るのは最後の文だけである（実測）。

## モデルとシステムプロンプト（2026年10月）

- Copilot CLI のシステムプロンプトは、モデルの ID ごとに族に分かれる。今の GPT の族（GPT-6 系など）には「Bias to action」「Make reasonable assumptions for missing details」、Claude 5 の族には「limit your response to 100 words or less」「Prioritize brevity」が入る。聞き取りの手順とぶつかるので、スキルの側で優先を書く（[ヒアリングの設計](../../docs/design/hearing.md) 2.7、10.2）。
- 退役したモデル：GPT-4.1（2026-06-01）、GPT-5 mini・GPT-5.5・GPT-5.4 mini など（2026-10-19）。既定のモデルは Claude Sonnet 5.5。古いモデルの事実に頼らない（憲章 第5条3項）。
- 費用（100万トークンあたり、入力・出力）：GPT-6 Luna と Claude Haiku 5.5 は 0.10・0.50 ドル、GPT-6.1 Sol と Claude Sonnet 5.5 は 2.00・10.00 ドルで、20倍違う。GPT-6.1 Sol は Pro プランでは使えない。年額の旧プランは、プロンプトの数とセッションのモデルで数えるので、作業エージェントを安いモデルにしても費用は変わらない。

## サブエージェントとスキル

- サブエージェントにも、プラグインのスキルが見える。スキルの description に合う仕事を頼むと、サブエージェントがそのスキルを呼び、統括エージェント向けの手順を最初から自分で始めてしまうことがあった（Claude Code で確認）。
- 作業や検証のエージェントは `tools` を絞って、スキルを呼べないようにする。
  - Claude Code では、これで防げた。
  - Copilot CLI 1.0.102 でも、`tools` を書き、`skill` を書かなかったエージェント（作業・検証・読み取り役）には、`skill` のツールが載らなかった（実測）。`tools` を書かないエージェントには載った。

## 出典

- [GitHub Copilot CLI command reference（Custom agents reference）](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
- [Custom agents configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration)
- [GitHub Copilot CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference)
- [Models and pricing for GitHub Copilot](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)
- [Supported AI models in GitHub Copilot](https://docs.github.com/en/copilot/reference/ai-models/supported-models)
- [Copilot requests（年額の旧プラン）](https://docs.github.com/en/copilot/concepts/billing/copilot-requests)
- [Copilot CLI changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)（1.0.67、1.0.68、1.0.81、1.0.86、1.0.100）
- [Claude Code: Create custom subagents](https://code.claude.com/docs/en/sub-agents)
- Copilot CLI 1.0.102 の実機での実測（偽物のモデルにつないだ。Linux x64。ログインした本物のアカウントでは試していない）

## Claude Code は、サブエージェントが「報告のファイル」を書くのを断る

- Claude Code の Write は、サブエージェントが、名前の頭が ANALYSIS・REPORT・SUMMARY・FINDINGS（大文字小文字を問わない）の `.md` を書こうとすると、「Subagents should return findings as text, not write report files. Include this content in your final response instead.」で断る（Agent SDK 0.3.310 が同梱する版の Write の確かめで見つけた）。
- make-idea の1回目の試行では、なぜなぜ分析の役に `analysis-1.md` を書かせたため断られた。メインのエージェントが返事を縮めて書き写し、「なぜ」の段が約3分の1に減った。
- サブエージェントに書かせるファイルの名前は、この4つの言葉で始めない（例：`whys-1.md`、`overview.md`）。

