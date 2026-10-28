# CLI のディープリサーチと、スキルからの調べ方

アイデア創出スキル（make-idea）の事前調査を、開発者の求める「ディープリサーチ」の形にするときに調べたこと（2026-10-28。Copilot CLI 1.0.105、Claude Code 2.1.312 のころの公式のドキュメント）。

## CLI のディープリサーチは、スキルから呼べない

- Copilot CLI には `/research <話題>` がある（v0.0.417 から）。専用の research エージェントが、コード、GitHub、Web を調べ、引用つきの Markdown を `~/.copilot/session-state/<ID>/research/` に書く。専用のモデルで動き、`/model` では変わらない。v1.0.40 から、本体が調査のエージェントに作業を何度も振る形になった。
- Claude Code には `/deep-research <問い>` がある（同梱の workflow）。複数の観点で並列に Web を検索し、情報源を照らし合わせ、引用つきのまとめを返す。v2.1.218 から、ユーザーが手で呼んだときだけ起動する。
- どちらも、スキルやカスタムエージェントから呼ぶ方法は公式に書かれていない。Copilot CLI の `task` に `agent_type: "research"` を渡せることも、公式には書かれていない（古い版の同梱のコードでは有効な値だった）。Claude Code の Workflow ツールは、サブエージェントでは使えない。
- そこで make-idea は、同じ形（計画 → 並列に集める → 足りないところを見つけて調べ直す → 評価の確かめと掘り下げ → 引用つきのまとめ）を、自分の手順とサブエージェントで組んだ。

## 調べる回数の上限

- Claude Code の WebSearch は、対話のセッション1つにつき200回まで（サブエージェントの分も合わせる。`-p` ではターンごと）。環境変数 `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION` で上げられる。ディープリサーチと先行例の調べは200回を超えうるので、流れの試験は入口でこの値を上げる。
- Copilot CLI の web_search は、組み込みの GitHub MCP サーバーが出す。回数の上限は公式に書かれていない。カスタムエージェントの `tools: ["web"]` が何も割り当てない不具合が v1.0.100 で直った（それより前の版では `web_search` と `web_fetch` を個別に書く）。
- サブエージェントを同時に動かせる数は、Copilot CLI のプランで違う（Free 2、Pro 4、Max 8、Business 16、Enterprise 32）。

## 判定役に別のモデルを使うとき

- Copilot CLI のエージェントは `model`（1つ）か `models`（優先する順のリスト。v1.0.83 から）と `modelPolicy` を書ける。セッションのモデルが Auto のときは、`model` を書いても無視される。組み込みの `rubber-duck` は、セッションと別の系統のモデルを選ぶ批評役である。
- Claude Code のエージェントの `model` は、別名（sonnet、opus、haiku、fable）、完全な ID、`inherit` を書ける。他社のモデルは選べない。
- make-idea の壁打ちの相手には、別のモデルを指定していない。代わりに、先行例を別の役が探し、相手の1人をだめな理由を示す役にした。別のセッションでの判定は、流れの試験の後の判定（`idea-review.mjs`）で行う。

## 出典

- [Copilot CLI: research](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/research)
- [Copilot CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
- [Copilot CLI changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)
- [Getting a second opinion（rubber-duck）](https://docs.github.com/en/copilot/concepts/agent-capabilities/choosing-and-delegating-agent-work/getting-a-second-opinion)
- [Claude Code: workflows](https://code.claude.com/docs/en/workflows)、[sub-agents](https://code.claude.com/docs/en/sub-agents)、[tools reference](https://code.claude.com/docs/en/tools-reference)
