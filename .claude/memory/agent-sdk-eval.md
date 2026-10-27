# Agent SDK で EVAL を動かすときの注意

Claude Code の Agent SDK（TypeScript 版 0.3.302、Claude Code 2.1.302）で、プラグインの EVAL の仕組みを試作して分かったこと（2026年10月）。実装では 0.3.310（Claude Code 2.1.310）に上げ、MCP のツールとカスタムエージェントの動きを、偽物の Anthropic API につないだ本物の Claude Code で確かめた（下の2つの節。本物のモデルでは確かめていない）。設計への反映は [試験の設計](../../docs/design/testing.md) にある。試作のコードは、ブランチ `claude/test-prototype` の `prototype/` にある（main には入れていない）。

## 試されるエージェントを隔離する

- 環境変数は、必要なものだけを渡す。SDK は `env` を指定しないと、すべての環境変数を引き継ぐ。
  - 引き継いだとき、試験する側のセッションの設定が混ざった。サブエージェントを裏で動かす設定（`CLAUDE_AUTO_BACKGROUND_TASKS`）、思考の深さ（`CLAUDE_EFFORT`）、追加のフォルダ、セッションの ID などである。
  - GitHub や AWS などの資格情報も、試されるプラグインのコードから見えてしまう。
  - このクラウド環境では、`PATH`、プロキシと証明書、`ANTHROPIC_BASE_URL`、一時的な `HOME` だけで認証できた。
- `settingSources: []` で、ユーザー設定とプロジェクト設定を読ませない。それでも Claude Code に組み込まれたプラグインは読み込まれるが、あり・なしの両方に入るので比較には影響しない。
- コマンドは、OS のサンドボックスで動かす。サンドボックスがないとき、エージェントが自分の判断で `/tmp/work` に作業を移した。サンドボックスでは書き込みが作業フォルダに限られ、外への書き込みは「読み取り専用」として止まった。Linux では bubblewrap と socat が要る。
- ファイルの書き込みのツール（Write、Edit）は、サンドボックスの対象外である。許可の規則で、作業フォルダの中（`Write(./**)`、`Edit(./**)`）だけを許す。

## 許可の求め方

- 普段のツールは `allowedTools` であらかじめ許可し、`canUseTool` に回すのは質問（AskUserQuestion）だけにする。
  - サブエージェントが裏で動いたとき、その許可の求めが受け付けられずに失敗した（「Stream closed」）。
  - `allowedTools` に書いたツールは `canUseTool` に回らないという警告が出るが、ねらいどおりなので問題ない。
- AskUserQuestion への答えは、`updatedInput` の `answers` に「質問の文 → 答え」の形で返す。選択肢にない自由な答えも返せる。

## Linux のサンドボックスとローカルのサーバー

- サンドボックスの中のコマンドは、コマンドごとに専用の localhost を持つ。中で起動した Web サーバーには、外のブラウザーからも、あとから実行する別のコマンドからもつながらない。`allowLocalBinding` は Linux では効かない。
- 外につなぐ必要があるコマンドだけを、`excludedCommands` でサンドボックスの外に出す。パスまで指定して範囲を絞る。
- `excludedCommands` は、1回の呼び出しに含まれるすべてのコマンドが一致したときだけ効く。変数、`cd`、`;`、リダイレクトを付けると、サンドボックスの中のままになる。
- サンドボックスは、コマンドの中だけ、保護するファイル（`.mcp.json`、`.gitconfig`、`.bashrc`、`.vscode`、`.idea`、`.claude/` の中など）を、中身のない装置のファイル（`/dev/null`）で重ねる。重ねるのは、コマンドを始めたフォルダだけで、コマンドが終わると消える。生成物のフォルダがコマンドの始まりのフォルダになると、そこに中身のない `.mcp.json` が重なり、生成物の検査が落ちた（外側の EVAL の記録で、`.mcp.json` が `crw-rw-rw- 1, 3` の装置のファイルだったことから分かった）。重ねるのをやめる設定は Agent SDK になく（`filesystem.disabled` は書き込みの隔離ごと外れる）、環境変数 `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` で、コマンドを毎回作業フォルダから始めると、生成物のフォルダには重ならない見込みである。`cd` のあとも次のコマンドが作業フォルダから始まることは、偽の API で確かめた。ただし、記録のとおりの流れを手元で再現できず、この直しが本物のモデルの実行で効くかは、確かめていない。これは Claude Code のサンドボックスの動きなので、Copilot CLI の実際の利用では起きない見込みである。

## MCP のツールを試されるエージェントに渡す（0.3.310 を偽の API につないで確かめた）

- 同じプロセスの MCP サーバーのツールは、既定でツール検索の裏に回され、モデルへのツールの一覧に載らない。ツールに `_meta: { "anthropic/alwaysLoad": true }` を付けると載る（Copilot CLI の `defer: 'never'` に当たる）。
- MCP のツールの呼び出しの `_meta` に、`claudecode/toolUseId` が入る。フックの `tool_use_id` と同じ値である。フック（`PreToolUse`）の入力には、サブエージェントの中なら `agent_id` が、メインのエージェントなら `agent_id` がなく `agent_type` だけが付く。これで「記録のツールを呼んだエージェント」を結び付けられる。`_meta` に `claudecode/agentId` は付かなかった。

## カスタムエージェントを統括として動かす（0.3.310 を偽の API につないで確かめた）

- `agent: '<プラグイン>:<エージェント>'` は、`systemPrompt: { type: 'preset', preset: 'claude_code' }` のときだけ、エージェントの本文が効く。既定の最小のシステムプロンプトでは、本文が入らない。`tools` の制限とモデルは、どちらでも効く。
- `Agent` ツールの呼び出しは、既定で裏で動く（すぐ「launched」が返り、終わりは後の通知で届く）。入力で `run_in_background: false` を指定すると前面で動き、サブエージェントの最後の返事が返る。本物のモデルが、この指定を守って呼ぶかは、確かめていない。
- Claude Code では、子のツールは親の `tools` に絞られない（Copilot CLI は絞る：[カスタムエージェント](custom-agents.md)）。
- fork サブエージェントは、Claude Code 2.1.302 から既定でオンである（更新履歴）。`subagent_type` を省くか `fork` にすると fork が動き、`agent_type` が `fork` で届く見込みで、環境変数 `CLAUDE_CODE_FORK_SUBAGENT=0` で切れる。作業エージェントとして数えられなくなるなどの影響は、本物のモデルでは確かめていない。

## そのほか

- 記録（トランスクリプト）は、`HOME` の下の `.claude/projects/` に残る。続きの会話（`resume`）には、同じ `HOME` を使う。
- 続きの会話で返る `total_cost_usd` は、それまでの分を含む合計である。
- サブエージェントの種類と、それが使ったモデルは、実行の記録（ツール呼び出しの ID とメッセージのモデル名）から分かる。0.3.310 では、サブエージェントの始まりのフック（`SubagentStart`）に `agent_id` と `agent_type`、`Agent` の呼び出しの `PreToolUse` に `description`・`subagent_type`・`run_in_background`、サブエージェントのメッセージに `agent_id` と `message.model` が付いた。
- 試されるエージェントも、モデルの利用枠を使う。EVAL を続けて回したところ、利用枠の上限に達したというエラー（「You've hit your session limit」）で止まり、示された時刻（約3時間後）まで再開できなかった。

## 同時に起動したサブエージェントの見分け方（0.3.310。2026年10月、make-idea の流れの試験）

- 1つの応答で並べた `Agent` の呼び出しは、別々の assistant のメッセージで届く。同じ応答のものは `message.id` が同じである（型定義の SDKAssistantMessage の説明にもある）。
- メッセージの数で数えると、同時に起動したものを別々に数えてしまう。`message.id` でまとめて数える。

## 出典

- [Claude Agent SDK: Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Claude Agent SDK: Use Claude Code features in the SDK](https://code.claude.com/docs/en/agent-sdk/claude-code-features)
- [Claude Code: Sandboxing](https://code.claude.com/docs/en/sandboxing)
- Claude Agent SDK 0.3.310（Claude Code 2.1.310）を、偽物の Anthropic API につないだ実測
