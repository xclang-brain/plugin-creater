# 調査：スキルの公式仕様、名前の重なり、単体で動くスキル、ダミーのスキルの設計（2026-10-26）

改善・設計変更（change-plugin、REQ-052〜061）と部品の独立性（出力の要件 REQ-062）のための調査メモである。憲章・仕様書・設計書・実装資産のどれでもない。

- 調べた日：2026-10-26。取得した原文の写しは `/tmp/claude-0/-home-user/64a230fb-e6a2-510f-9e7e-9e6600fd34a8/scratchpad/research-scratch/web/` にある（セッションが終わると消える）。
- 版：Copilot CLI は npm の最新が 1.0.103（更新履歴の 1.0.103 は 2026-10-22）。Claude Code のドキュメントは v2.1.309 までの記述を含む。Agent Plugins は 1.0.0（公開済み）、1.1.0 は草案。
- 実機での確かめ：Copilot CLI のバイナリを動かす試し（`copilot skill list --json` で名前の重なりを見る）は、この環境の許可の判定で断られたため、していない。名前の重なりの事実は、公式ドキュメントと更新履歴だけによる。arm のクロスコンパイルと qemu-arm の動きは、この容器で確かめた（4.9）。

## 出典

| 略 | URL |
| --- | --- |
| AS-spec | https://agentskills.io/specification （Markdown 版：https://agentskills.io/specification.md） |
| AS-scripts | https://agentskills.io/skill-creation/using-scripts |
| AS-best | https://agentskills.io/skill-creation/best-practices |
| AS-desc | https://agentskills.io/skill-creation/optimizing-descriptions |
| AS-client | https://agentskills.io/client-implementation/adding-skills-support |
| skills-ref | https://github.com/agentskills/agentskills/blob/main/skills-ref/src/skills_ref/validator.py 、parser.py |
| AP-1.0.0 | https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.0.0.md （7.1、11.3） |
| GH-about | https://docs.github.com/en/copilot/concepts/agents/about-agent-skills |
| GH-add | https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills |
| GH-cmd | https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference （Skills reference、Custom agents reference） |
| GH-plugin | https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference （Loading order and precedence） |
| CL | https://github.com/github/copilot-cli/blob/main/changelog.md |
| CC-skills | https://code.claude.com/docs/en/skills |
| CC-sub | https://code.claude.com/docs/en/sub-agents |

---

## 1. 仕様に沿った単体のスキルが満たす決まり

### 1.1 フォルダの形（AS-spec「Directory structure」「Optional directories」）

> A skill is a directory containing, at minimum, a `SKILL.md` file

```
skill-name/
├── SKILL.md          # Required: metadata + instructions
├── scripts/          # Optional: executable code
├── references/       # Optional: documentation
├── assets/           # Optional: templates, resources
└── ...               # Any additional files or directories
```

- `scripts/`：「Be self-contained or clearly document dependencies」「Include helpful error messages」「Handle edge cases gracefully」。
- `references/`：「Keep individual reference files focused. Agents load these on demand」。
- `assets/`：テンプレート、画像、データ（表、スキーマ）。
- ファイル名は `SKILL.md`（GH-add：「Skill files must be named `SKILL.md`.」）。skills-ref は小文字の `skill.md` も受け付ける（parser.py の `find_skill_md`）が、クライアントは `SKILL.md` を探す（AS-client：「subdirectories containing a file named exactly `SKILL.md`」）。`SKILL.md` にそろえる。

### 1.2 フロントマター（AS-spec「Frontmatter」）

| 項目 | 必須 | 決まり（原文） |
| --- | --- | --- |
| `name` | Yes | Max 64 characters. Lowercase letters, numbers, and hyphens only. Must not start or end with a hyphen. |
| `description` | Yes | Max 1024 characters. Non-empty. Describes what the skill does and when to use it. |
| `license` | No | License name or reference to a bundled license file. |
| `compatibility` | No | Max 500 characters. Indicates environment requirements (intended product, system packages, network access, etc.). |
| `metadata` | No | Arbitrary key-value mapping for additional metadata (a map from string keys to string values). |
| `allowed-tools` | No | Space-separated string of pre-approved tools the skill may use. (Experimental) |

- `SKILL.md` は「must contain YAML frontmatter followed by Markdown content」。
- `metadata` は文字から文字への表。版の数字は `"1.0"` のように引用符で囲む（AS-spec の例）。「We recommend making your key names reasonably unique to avoid accidental conflicts」。
- `compatibility`：「Should only be included if your skill has specific environment requirements」「Most skills do not need the `compatibility` field.」
- `allowed-tools`：「Experimental. Support for this field may vary between agent implementations」。クライアントで書き方が違う（Copilot は「Comma-separated list or YAML array」、`"*"` も可。Claude Code は「space- or comma-separated string, or a YAML list」で `Bash(...)` の形）。GH-add は `shell`・`bash` を前もって許可することに警告している（「can allow attacker-controlled skills or prompt injections to execute arbitrary commands」）。クリエイターの1段目の検査も、書くと警告を出す（`template/tests/stage1/check_structure.py:462-466`）。生成プラグインでは書かない。

#### 参照実装 skills-ref の検査（validator.py、parser.py を読んだ）

- 許す項目は6つだけ（validator.py の `ALLOWED_FIELDS = {"name", "description", "license", "allowed-tools", "metadata", "compatibility"}`）。ほかの項目があると「Unexpected fields in frontmatter」で不合格。
- `name`：空でない、NFKC で正規化して 64 文字以内、小文字、先頭・末尾にハイフンなし、`--` なし、文字は `isalnum()` かハイフン、フォルダの名前と一致。※ `isalnum()` は日本語などの文字も通す（「Skill names support i18n characters」とコメントにある）。仕様の本文は `a-z`、`0-9` と書くので、ASCII にそろえるのが安全。
- `description`：空でない、1024 文字以内。`compatibility`：文字で 500 文字以内。
- フロントマターの読み取りは `strictyaml`（parser.py）。`content.split("---", 2)` で切るので、フロントマターの中に `---` を書かない。`description: Use this skill when: …` のように値に「: 」を含むと YAML として壊れる（AS-client「Handling malformed YAML」）。値は二重引用符で囲む。

#### クライアントごとの違い（Agent Skills の6項目の外）

| クライアント | 6項目のほかに受け付ける項目 | 注意 |
| --- | --- | --- |
| Copilot CLI | `argument-hint`、`user-invocable`、`disable-model-invocation`（GH-cmd「Skill frontmatter fields」） | `name` は「letters, numbers, hyphens, underscores, dots, colons, and spaces」も可。`my-plugin:search` のように `:` で名前空間を付けられる。ただし GH-add の手引きは「This must be lowercase, using hyphens for spaces」と書き、ドキュメントの間で食い違う |
| Claude Code | `when_to_use`、`argument-hint`、`arguments`、`disable-model-invocation`、`user-invocable`、`disallowed-tools`、`model`、`effort`、`context`、`agent`、`background`、`hooks`、`paths`、`shell`（CC-skills「Frontmatter reference」） | 「Outside Claude Code, you can use only the fields in the Agent Skills spec」。claude.ai への登録や `package_skill.py` では、6項目以外は「Unexpected key(s) in SKILL.md frontmatter」で失敗する。Claude Code では `name` も任意 |

- Agent Plugins 1.0.0 は、プラグインのスキルが Agent Skills に従うことを求め、従わないスキルは飛ばすと定める（AP-1.0.0 7.1）：
  > Agent Skills MUST conform to the Agent Skills specification.
  > If a discovered skill does not conform to the Agent Skills specification, the client MUST skip that skill and continue loading other skills and component types.
- 一方、AS-client は、クライアントには「ゆるい検査」を勧める（「Name doesn't match the parent directory name → warn, load anyway」「Description is missing or empty → skip the skill」）。どのクライアントがどこまで厳しいかは決まっていない。生成プラグインは、いちばん厳しい形（6項目だけ、`name` は ASCII、フォルダの名前と一致）にそろえる。
- 既存のナレッジ `.claude/memory/skills.md:42-47` の内容と一致する（食い違いなし）。

### 1.3 `name` の決まり（AS-spec「name field」）

- 「Must be 1-64 characters」
- 「May only contain unicode lowercase alphanumeric characters (`a-z`, `0-9`) and hyphens (`-`)」
- 「Must not start or end with a hyphen (`-`)」
- 「Must not contain consecutive hyphens (`--`)」
- 「Must match the parent directory name」

クリエイターの1段目の検査は、正規表現 `^[a-z0-9]+(?:-[a-z0-9]+)*$`、64 文字以内、フォルダの名前と一致を確かめる（`template/tests/stage1/check_structure.py:426,439-444`）。仕様と同じ。

### 1.4 `description`（AS-spec「description field」、AS-desc）

- 「Should describe both what the skill does and when to use it」「Should include specific keywords that help agents identify relevant tasks」。
- AS-desc：「Use imperative phrasing」「Focus on user intent, not implementation」「Err on the side of being pushy」「Keep it concise」。「the description carries the entire burden of triggering」。
- AS-desc の注意：「agents typically only consult skills for tasks that require knowledge or capabilities beyond what they can handle alone」。単純な頼み（例：「この PDF を読んで」）では、説明が合っていてもスキルが呼ばれないことがある。→ クロスコンパイルのスキルは「KF-7 向け」のような、AI が知らない固有の言葉を入れると呼ばれやすい。
- Claude Code は一覧で `description` と `when_to_use` を合わせて 1,536 文字で切る（CC-skills の表）。

### 1.5 本文と段階的な読み込み（AS-spec「Body content」「Progressive disclosure」）

1. Metadata（約100トークン）：`name` と `description` は起動時にすべてのスキルについて読まれる。
2. Instructions（5000 トークン未満を推奨）：スキルが使われるときに本文全体が読まれる。
3. Resources：`scripts/`、`references/`、`assets/` のファイルは、要るときだけ読まれる。

- 「Keep your main `SKILL.md` under 500 lines. Move detailed reference material to separate files.」
- AS-best：「"Read `references/api-errors.md` if the API returns a non-200 status code" is more useful than a generic "see references/ for details."」。いつ読むかを書く。
- AS-best「Gotchas sections」：「The highest-value content in many skills is a list of gotchas — environment-specific facts that defy reasonable assumptions」「Keep gotchas in `SKILL.md`」。→ ダミーのスキルの「隠れた決まり」は、この形（気をつけること）で書くのが自然である（4章）。

### 1.6 ファイルの参照（AS-spec「File references」、AS-scripts）

- 「When referencing other files in your skill, use relative paths from the skill root」
- 「Keep file references one level deep from `SKILL.md`. Avoid deeply nested reference chains.」
- AS-scripts：「Use relative paths from the skill directory root to reference bundled files. The agent resolves these paths automatically」「script execution paths (in code blocks) are relative to the skill directory root, because the agent runs commands from there」。
- ただし実際のクライアントは、コマンドを作業フォルダで動かす。AS-client はクライアントに「When a skill references relative paths, resolve them against the skill's directory (the parent of SKILL.md) and use absolute paths in tool calls.」と指示させる例を示す。→ スキルの本文に「このフォルダの絶対パスを前に付けて動かす」と書いておくと、どのクライアントでも外れにくい。
- Copilot CLI は、スキルを読むと「Base directory for this skill: <絶対パス>」と、フォルダの全ファイルの一覧（Related files）を渡す（ナレッジ `.claude/memory/skills.md:53-54`、1.0.102 の実測）。GH-add：「When a skill is invoked, Copilot automatically discovers all of the files in the skill's directory and makes them available alongside the skill's instructions.」「run the `convert-svg-to-png.sh` script from this skill's base directory」。
- Claude Code は本文の `${CLAUDE_SKILL_DIR}` を、そのスキルのフォルダに置き換える（CC-skills「Available string substitutions」）。Copilot CLI には同じ置き換えの記述がない（GH-cmd、GH-add、更新履歴を検索して見つからず）。Copilot で使うスキルに `${CLAUDE_SKILL_DIR}` を書くと、そのままの文字が残る見込み（実機では確かめていない）。書かない。
- `${PLUGIN_ROOT}` は、Copilot CLI では stdio の MCP サーバーの `args`・`env`・`cwd` でだけ展開される（GH-plugin「For `stdio` servers, the CLI provides `PLUGIN_ROOT` and `PLUGIN_DATA` …」）。スキルの本文やエージェントの本文では展開されない。単体で使うスキルには書かない。

### 1.7 スクリプトの作り方（AS-scripts「Designing scripts for agentic use」）

- 対話の入力を求めない：「This is a hard requirement of the agent execution environment. Agents operate in non-interactive shells」。入力は引数、環境変数、標準入力で受け取る。
- `--help`：「`--help` output is the primary way an agent learns your script's interface」。
- エラーの文：何が悪く、何を期待し、何を試すか。
- 出力：「Prefer structured formats — JSON, CSV, TSV」「send structured data to stdout and progress messages, warnings, and other diagnostics to stderr」。
- そのほか：冪等、あいまいな入力は断る、`--dry-run`、意味のある終了コード（`--help` に書く）、安全な既定、出力の大きさを予測できるように（「harnesses automatically truncate tool output beyond a threshold (e.g., 10-30K characters)」）。
- 依存：標準ライブラリだけにするか、PEP 723 などで中に書く（「Be self-contained or clearly document dependencies」）。
- 例のコマンドは `bash scripts/validate.sh "$INPUT_FILE"`、`python3 scripts/process.py …` で、インタープリターを前に付ける形である。→ 実行の許可ビット（chmod +x）に頼らない。

### 1.8 単体のスキルの決まり（まとめ。番号は 3章・4章から指す）

| # | 決まり | 根拠 |
| --- | --- | --- |
| S1 | `skills/<名前>/SKILL.md`。`name` はフォルダの名前と同じで、ASCII の英小文字・数字・ハイフン、64 文字以内、先頭・末尾にハイフンなし、`--` なし | AS-spec、AP-1.0.0 7.1 |
| S2 | フロントマターは6項目だけ（`name`、`description` 必須。`license`、`compatibility`、`metadata` は要るときだけ。`allowed-tools` は書かない） | AS-spec、skills-ref、check_structure.py:428,462-470 |
| S3 | `description` は 1024 文字以内で、「何をするか」と「いつ使うか（頼みの言い方）」を、使う人の頼みの言葉で書く。値は二重引用符で囲む | AS-spec、AS-desc、AS-client |
| S4 | 本文は 500 行以内、5000 トークン未満。詳しいことは `references/` に分け、いつ読むかを書く | AS-spec、AS-best |
| S5 | 本文が指すファイルは、すべてそのスキルのフォルダの中にあり、スキルの根からの相対パスで、1段の深さで指す。`../`、ほかのスキルのフォルダ、`${PLUGIN_ROOT}`、`${CLAUDE_SKILL_DIR}` を使わない | AS-spec、1.6 |
| S6 | コマンドは「このフォルダの絶対パス＋相対パス」で動かすよう本文に書く。スクリプトは自分の場所を `$(dirname "$0")` や `Path(__file__).parent` で求め、今いるフォルダに頼らない | AS-client、1.6 |
| S7 | スクリプトは対話なし、`--help`、構造化した標準出力、診断は標準エラー、意味のある終了コード。標準ライブラリだけ。`bash`・`python3` を前に付けて動かす | AS-scripts、REQ-062 |
| S8 | 出力（ビルドの成果物、ログ）は、引数で受け取った場所に書き、スキルのフォルダの中に書かない。Copilot CLI はスキルを読むたびにフォルダの全ファイルを一覧で渡す（`.claude/memory/skills.md:54`）。インストールしたプラグインのフォルダは、更新で消える | `.claude/memory/skills.md:54`、GH-plugin「Plugin data」 |
| S9 | 「気をつけること」（gotchas）は本文に書く。別のファイルに書くと、AI がいつ読むべきか気づかないことがある | AS-best |

---

## 2. 名前の重なりと優先順位（REQ-055「名前が重ならないようにする」）

### 2.1 Copilot CLI

GH-plugin「Loading order and precedence」：

> **Agents and skills** use first-found-wins precedence.
>
> If you have a project-level custom agent or skill with the same name or ID as one in a plugin you install, the agent or skill in the plugin is silently ignored. The plugin cannot override project-level or personal configurations. … Skills are deduplicated by their name field inside the `SKILL.md` file.

同じページの図（AGENT SKILLS - FIRST LOADED IS USED (dedup by name)）：

```
1. <project>/.github/skills/        (project)
2. <project>/.agents/skills/        (project)
3. <project>/.claude/skills/        (project)
4. <parents>/.github/skills/ etc.   (inherited)
5. ~/.copilot/skills/               (personal-copilot)
6. ~/.agents/skills/                (personal-agents)
7. PLUGIN: skills/ dirs             (plugin)
8. COPILOT_SKILLS_DIRS env + config (custom)
--- then commands (.claude/commands/), skills override commands ---
```

GH-cmd「Skill locations」は、同じ順に加えて、`--add-dir`（Added root）、CLI に同梱のスキル（「Lowest priority—overridable by any other source」）、組織・エンタープライズのリモートのスキル（「follow the same name-based priority when a local skill has the same name」）を挙げる。`ignoredSkillsLocations` の設定で、場所ごと読まないようにもできる。

プラグインどうしの重なり（GH-cmd）：

> When two plugins provide skills with the same name, both coexist using plugin-qualified invocation names such as `/my-plugin/search` and `/other-plugin/search`. The bare name routes to the higher-priority plugin. This applies to skills only; commands keep the standard tier-based deduplication, where the higher-priority source wins.

更新履歴（CL）で関わるもの：

| 版 | 内容（原文） |
| --- | --- |
| 1.0.55（2026-05-28） | 「--plugin-dir skills now take precedence over personal-home (~/.copilot, ~/.agents) skills with the same name. Order is now project > plugin-dir > personal > custom.」 |
| 1.0.66（2026-06-30） | 「Allow skills with the same name from different plugins to coexist」 |
| 1.0.71（2026-07-16） | 「Display plugin root skills as /plugin instead of /plugin:plugin」 |
| 1.0.88（2026-09-22） | 「Support namespaced custom skills and ignored skill directories during skill discovery」 |
| 1.0.97（2026-10-13） | 「Skills and custom agents from --plugin-dir plugins now reach autocomplete and invocation instead of going missing.」 |

ここから分かること：

1. 名前の比べ方は、`SKILL.md` の `name` である（フォルダの名前ではない）。Agent Skills では両者が同じなので、どちらで比べても同じになる。
2. ユーザーのプロジェクトのスキル（`.github/skills`、`.agents/skills`、`.claude/skills`、親のフォルダのもの）と個人のスキル（`~/.copilot/skills`、`~/.agents/skills`）は、インストールしたプラグインのスキルより先に読まれる。同じ名前なら、プラグインのスキルは黙って無視される。エラーも警告も出ない（「silently ignored」）。
3. `--plugin-dir` で読ませたプラグインは、個人のスキルより先、プロジェクトのスキルより後になる（1.0.55）。→ 試験を `--plugin-dir` で動かすと、インストールして使うときと優先順位が変わる。個人のフォルダにある同じ名前のスキルによる重なりは、`--plugin-dir` の試験では見えない。重なりの試験は、ダミーのスキルをプロジェクトのフォルダ（`.github/skills`）に置いて行う（プロジェクトはどちらの場合もプラグインより先）。
4. プラグインどうしなら、両方が残り、`/<プラグイン>/<スキル>` で呼び分けられる。名前だけで呼ぶと、優先順位の高いプラグインのものになる。モデルが `skill` のツールで呼ぶときの引数は、スキルの名前だけである（`.claude/memory/skills.md:53`）。
5. コマンドの書き方は、ナレッジでは `/<プラグイン>:<スキル>`（1.0.102 の実測、`.claude/memory/skills.md:51`）、GH-cmd の重なりの説明では `/my-plugin/search` で、まだ食い違う。

既存のナレッジとの照合：`.claude/memory/custom-agents.md:28`「同じ名前のスキルやエージェントが、プロジェクトや個人のフォルダにあると、プラグインのほうは黙って無視される。先に読み込んだものが勝つ（プロジェクト、ユーザー、プラグインの順。公式の plugin reference。実機では確かめていない）」と一致する。新しく分かったのは、上の 3（`--plugin-dir` は個人より先）と 4（プラグインどうしは残る）である。カスタムエージェントの順は逆で、個人（`~/.copilot/agents/`）がプロジェクトより先である（GH-cmd「Custom agent locations」の表で User が 1）。スキルと混同しない。

### 2.2 Claude Code（CC-skills「Resolve skills that share a name」）

| 同じ名前の組 | どれが動くか（原文） |
| --- | --- |
| Two of enterprise, personal, and project | 「Enterprise over personal, and personal over project.」 |
| A skill and a file in `.claude/commands/` | 「The skill」 |
| A plugin skill and a skill at any of the locations above | 「Both load, because plugin skills are namespaced as `/plugin-name:skill-name`」 |

- プラグインのスキルのコマンドは `/<プラグイン>:<name>`。「The bare `/fancy` also invokes the skill unless another command already uses that name.」（CC-skills「How a skill gets its command name」）
- Copilot CLI と違い、プラグインのスキルは消えない。ただし、ユーザーのスキルとプラグインのスキルの両方の description がモデルに並ぶので、似た説明だと、モデルがどちらを使うかは決まらない。
- 個人とプロジェクトの順は、Copilot CLI（プロジェクトが先）と Claude Code（個人が先）で逆である。AS-client は「The universal convention across existing implementations: project-level skills override user-level skills.」と書くが、Claude Code の今のドキュメントはこれと違う。

### 2.3 Agent Skills のクライアントの手引き（AS-client「Handling name collisions」）

> When two skills share the same `name`, apply a deterministic precedence rule. … project-level skills override user-level skills. … Log a warning when a collision occurs so the user knows a skill was shadowed.

Copilot CLI のプラグインの場合は、警告なしで無視される（GH-plugin の「silently」）。

### 2.4 REQ-055 への意味と勧め

- REQ-055 の理由（「同じ名前だと、示されたスキルが読み込まれている作業フォルダで、プラグインのスキルが使われない」）は、Copilot CLI の公式の記述どおりである。Claude Code では両方が残るので、理由は Copilot CLI に限る。
- 影響を受けるのは、スキルを名前で読む道筋だけである。
  - チャットで単体で頼む（REQ-062 の受け入れ基準）、メインのエージェント・統括が `skill` で呼ぶ：重なると、ユーザーの元のスキルが使われ、プラグインのスキルは使われない。
  - 作業エージェントがルールのスキルをファイルとして読む（今の生成プラグインの設計。`docs/design/generated-plugin-structure.md:354-357`。作業・検証の `tools` に `skill` を入れない）：名前の重なりの影響を受けない。
- 比べる相手（勧め）：
  1. 示されたスキルの `name`（REQ-055 が決めている。スクリプトで確かめる案は `wip/change-plugin/research/scaffold.md:190`、`skillflow.md:278`）。
  2. できれば、ユーザーがプラグインを使う作業フォルダと個人のフォルダで見つかるスキルの `name`。ただし、作業フォルダは直す時点で決まらないことが多い（embedded-debug-loop では、ソースのフォルダは画面の設定）。確かめられるのは、示されたスキルと、Copilot CLI を起動したフォルダ・個人のフォルダ（`~/.copilot/skills`、`~/.agents/skills`）にあるスキルまでである。
- 名前の付け方（勧め）：示されたスキルの名前と比べるだけでなく、プラグインの名前を頭に付けた名前（例：`edl-cross-compile`、`embedded-debug-loop-cross-compile`。後者は 34 文字で 64 文字以内）にすると、ユーザーの手元のほかのスキルとも重なりにくい。ただし、すでにある `cross-compile-rules`・`deploy-rules` の名前を変えると、それを指すエージェントの本文などをすべて直すことになる。名前を変えるかは設計で決める（ユーザーに聞くことではなく、確認（REQ-057）で示す変更である）。
- 似た説明の問題：重ならない名前でも、ユーザーの元のスキルとプラグインのスキルが同じ作業フォルダで読まれると、チャットの頼みでどちらが使われるかは決まらない。取り込んだ決まりが正しければ、どちらでも結果は同じになるはずである。REQ-055 の受け入れ基準「書き直したスキルの仕事を、統括エージェントを始めずにチャットで頼むと、取り込んだ決まりどおりに行われる」を試すときは、ユーザーの元のスキルを読まない作業フォルダで試す（4.8）。

### 2.5 確かめていないこと

- Copilot CLI で、プロジェクトのスキルに隠されたプラグインのスキルを、`/<プラグイン>:<スキル>` や `/<プラグイン>/<スキル>` の形で呼べるか（GH-cmd の「both coexist using plugin-qualified invocation names」はプラグインどうしの話である）。
- 隠されたことが `/skills` や `copilot skill list --json` に出るか（`list --json` の行は `{ name, description, source, path, enabled }` で、隠されたものが出るかは書かれていない）。
- 1.0.83 の「Host-provided plugin customizations can be read without redundant path permission prompts」が、作業エージェントがプラグインのスキルのフォルダのファイルを `view` で読むときの確認を省くか（`skillflow.md:87` も同じ点を未確認としている）。

---

## 3. 単体で完結するスキルの書き方と、エージェントからの使い方

### 3.1 単体で完結する条件（REQ-062 の受け入れ基準に合わせたチェックリスト）

| # | 条件 | 確かめ方 |
| --- | --- | --- |
| U1 | フォルダを1つだけ取り出しても、1.8 の S1〜S5 を満たす | 1段目の検査（今の `check_skill_file` と、本文の参照の検査。参照の検査の案は `scaffold.md:298,337`） |
| U2 | 本文が、特定のエージェント・画面のツール・設定の key・統括の手順を前提にしない。例：`embedded-debug-loop_show`、`<名前>:worker`、`task.json` の `device_ip` を名指ししない | 1段目で、ツール名とエージェント名の文字を探す（`scaffold.md:337` の案） |
| U3 | `description` が、呼ぶ役（「ビルド・デプロイ担当がビルドするときに読む」）ではなく、ユーザーの頼みの言葉で書かれている。今の embedded-debug-loop の `cross-compile-rules` の description（`skills/cross-compile-rules/SKILL.md:3`「…embedded-debug-loop のビルド・デプロイ担当がビルドするときに読む。」）は、単体のチャットの頼みで呼ばれにくい | 機械では見られない（`scaffold.md:304`）。EVAL で単体の頼みを試す |
| U4 | 入力（ソースの場所、機器のアドレスなど）は「頼みに書かれたもの、なければ既定、それもなければ止めて足りないものを示す」の形で書く。チャットではユーザーの頼みから、エージェントでは統括の頼みから、同じ文で受け取れる | EVAL |
| U5 | 人に聞く手順を書かない。「止めて、足りないこと・起きたことを示す」と書く。サブエージェントは `ask_user` を持たない（`.claude/memory/custom-agents.md:70`）。メインのエージェントは、止まった結果を見てユーザーに聞ける | 読んで確かめる |
| U6 | 失敗したときは「そのまま進めず、コマンドと出力の要点を示して止まる」。これは単体でもエージェントでも同じ意味になる（embedded-debug-loop の K-15 と両立） | 読んで確かめる |
| U7 | スクリプトは引数・標準出力・終了コードで使え、コマンドラインから単体で動く（REQ-062） | 2段目の試験でスクリプトを直接動かす |
| U8 | 成果物の置き場所は引数で受け取る。プラグインの流れで決まる置き場所（例：`<作業フォルダ>/logs/device-latest.log`）は、エージェントの定義の側で引数として渡す | 読んで確かめる |

### 3.2 ルールのスキルを、単体でもエージェントからも使う形

役割の分け方（勧め）：

- スキル＝その仕事のやり方（機器の決まり、手順、気をつけること、スクリプト）。決まりの文は、ここにだけ書く（REQ-062「同じ決まりを、2つ以上の部品に書き写さない」）。
- エージェントの定義＝プラグインの流れの中での使い方（どのスキルを読むか、設定のどの値を引数に渡すか、結果をどこに置き、どのツールで画面に送るか、だれに返すか）。決まりの中身は書かず、スキルを指す。例：「ビルドは、`<ルールのスキルのフォルダ>/SKILL.md` を読み、その手順どおりに行う。ソースのフォルダには頼みの `source_dir` を渡す」。

エージェントがスキルを読む道筋の候補：

| 案 | 中身 | 良い点 | 悪い点 |
| --- | --- | --- | --- |
| A（勧め） | 作業エージェントは今のまま `skill` を持たず、ルールのスキルの `SKILL.md` を絶対パスでファイルとして読む。絶対パスは、エクステンション（`pluginRoot` を知っている。`template/com.github.copilot/extensions/_plugin_/adapter.mjs:349`、`scaffold.md:306`）が統括への最初の指示に入れ、統括が作業エージェントに渡す。スキルの本文の相対パスは、そのフォルダからたどる（S6） | 今の設計（`generated-plugin-structure.md:354-357`）を変えない。名前の重なりの影響を受けない（2.4） | 統括の指示にパスを入れる直しが土台に要る。プラグインのフォルダを読むときに、パスの許可の確認が出るかは確かめていない（2.5） |
| B | 作業エージェントの `tools` に `skill` を足し、ルールのスキルを名前で呼ばせる。Copilot CLI が「Base directory for this skill」とファイルの一覧を渡すので、パスの問題が消える | パスの問題がない | 入口のスキルなど、ほかのスキルも呼べてしまう（`generated-plugin-structure.md:355` が防ぎたいこと）。ユーザーの同じ名前のスキルがあると、そちらが呼ばれる |
| C | Claude Code のサブエージェントの `skills:`（起動時にスキルの中身を入れる。CC-sub「Preload skills into subagents」：「The full content of each listed skill is injected into the subagent's context at startup」） | 名前で決まったスキルだけを読ませられる | Copilot CLI のカスタムエージェントのフロントマターに同じ項目はない（GH-cmd「Custom agent frontmatter fields」の表：description、include-custom-instructions、infer、mcp-servers、model、models、modelPolicy、name、reasoningEffort、tools）。使えない |

- 今の embedded-debug-loop は、作業エージェントが `skills/cross-compile-rules/SKILL.md` を相対パスで読み（`com.github.copilot/agents/worker-b.agent.md:42-44`）、同じファイルの 65 行目で「スキルを使わない」としている。つまり案 A の形だが、絶対パスが渡っていない（`research-current-state.md` の D、`skillflow.md:269-272`）。
- 単体で使うときは、Copilot CLI が「Base directory」を渡すので、本文の「このフォルダの絶対パスを前に付ける」が働く。エージェントから使うときは、渡された `SKILL.md` の絶対パスのフォルダが「このフォルダ」になる。同じ本文で両方に効く。

### 3.3 ユーザーのスキルから、プラグインのルールのスキルに書き直すときの決まり（勧め）

| 元のスキルにあるもの | 書き直し方 |
| --- | --- |
| フロントマター | 6項目だけにする。`name` は 2.4 のとおり重ならない名前。`description` はユーザーの頼みの言葉で（3.1 U3）。Copilot 固有・Claude Code 固有の項目は落とし、落としたことを確認（REQ-057）で示す |
| 手順・気をつけること | 確かめて正しいと答えられた決まりだけを入れる（REQ-055）。決まりの番号（K-xx）を付ける（1段目の番号の検査に合わせる）。人に聞く手順は「止めて示す」に変える（U5） |
| スクリプト・参考の文書 | プラグインのスキルのフォルダ（`skills/<名前>/scripts/`、`references/`）に写す（REQ-018 の流用、REQ-062 の完結）。元のフォルダは変えない（REQ-055）。写した元（パスと元の `metadata` の版など）は、`metadata` に一意な key で残すか、README・確認の説明で示す（案。`metadata` の key の付け方は AS-spec「make your key names reasonably unique」） |
| ライセンス | 元に `license` があれば、写したスクリプトにもかかる。マーケットプレイスで公開するプラグインに、社外に出せないスクリプトが入るおそれがある。確認（REQ-057）の「流用する部品」で、元の `license` を示すのがよい（案） |
| 設定の値（IP、ポートなど） | 決め打ちしない。頼みの値 → 既定、の順に書く（U4）。画面の設定の key の名前は書かない（U2） |

### 3.4 試し方（REQ-062 の受け入れ基準に合わせて）

1. 構造：スキルのフォルダだけを別の場所に写し、`check_skill_file` と参照の検査を通す。
2. スクリプト：`--help` と、正しい引数・誤った引数で、終了コードと標準出力の JSON を確かめる（2段目）。
3. 単体の頼み（EVAL）：プラグインのスキルだけが読まれる作業フォルダで、統括を始めずに「このソースを KF-7 向けにクロスコンパイルして」と頼み、プログラムで成果物を採点する（4.7 の表の「見つけ方」）。

---

## 4. ダミーのスキルの設計（クロスコンパイルとデプロイ）

### 4.1 前提

- 架空のボード：Kitefin KF-7（ARM Cortex-A7、ARMv7-A、hard-float、BusyBox の静的な rootfs の組み込み Linux）。会社の名前・ボードの名前は架空で、実在の製品をまねない。
- ユーザーのチームのスキルとして書く。plugin-creator、embedded-debug-loop、プラグイン、エージェント、統括、画面、K 番号の言葉を一切書かない（ユーザーの指示4「plugin-creator とは無関係のもの」、`wip/change-plugin/RESUME.md:32`）。
- 名前は `cross-compile` と `deploy`。手元のプロジェクトのスキルとしてありがちな短い名前で、embedded-debug-loop の `cross-compile-rules`・`deploy-rules` とは違う。クリエイターが「ユーザーのスキルに合わせて名前を `cross-compile`・`deploy` にする」と、Copilot CLI ではプラグインのスキルが黙って無視される（2.1）。REQ-055 の名前の決まりを試すのに使える。
- 書く言葉は日本語（ユーザーのチームの文書として自然）。スクリプトの `--help` とエラーの文も日本語でよい。
- 仕様に沿う：両方とも、クリエイターの1段目の `check_skill_file`（`template/tests/stage1/check_structure.py:433-472`）に通ることを確かめた（4.9）。

### 4.2 cross-compile のスキル

```
cross-compile/
├── SKILL.md
├── scripts/
│   ├── kf7-env.sh        # source して使う。ツールチェーンと共通のフラグを入れる
│   ├── kf7-build.sh      # ソースのフォルダの *.c をビルドし、.elf と .kfi を作る
│   └── kf7-mkimage.py    # ELF を .kfi に包む（kf7-build.sh が中で呼ぶ）
└── references/
    └── kfi-format.md     # .kfi のヘッダーの形式（4.4）
```

SKILL.md の案（検査を通した写しは `/tmp/claude-0/-home-user/64a230fb-e6a2-510f-9e7e-9e6600fd34a8/scratchpad/research-scratch/dummy-draft/cross-compile/SKILL.md`）：

````markdown
---
name: cross-compile
description: "KF-7 ボード（Kitefin KF-7。ARM Cortex-A7 の組み込み Linux ボード）で動かす C のプログラムをクロスコンパイルし、ボードのローダーが受け付けるイメージ（.kfi）を作る。「KF-7 用にビルドして」「ボード向けにクロスコンパイルして」「.kfi を作って」と頼まれたときに使う。ボードへの転送や実行（デプロイ）には使わない。"
compatibility: "arm-linux-gnueabihf-gcc（GCC 12 以上）、bash、Python 3.8 以上が要る。Linux の開発機で使う。"
metadata:
  owner: kf7-firmware
  revision: "2.3"
---

# KF-7 向けのクロスコンパイル

KF-7 のボードで動く実行ファイルを作り、ローダーに送れる `.kfi` イメージに包む。

## 使うスクリプト

この節と手順のパスは、この SKILL.md があるフォルダからの相対パスである。コマンドでは、このフォルダの絶対パスを前に付けて動かす（今いるフォルダからの相対パスにしない）。

- `scripts/kf7-env.sh`：ツールチェーンと共通のフラグを環境変数に入れる。`source` して使う。
- `scripts/kf7-build.sh`：ソースのフォルダの `*.c` をビルドし、`.elf` と `.kfi` を作る。`--help` で使い方が出る。
- `scripts/kf7-mkimage.py`：ELF を `.kfi` に包む。`kf7-build.sh` が中で呼ぶので、ふだんは直接使わない。

## 手順

1. アプリの名前を決める。英小文字・数字・ハイフンで 15 文字以内。頼みに書かれていなければ、ソースのフォルダの名前を使う。
2. 環境の読み込みとビルドを、1つのコマンドで動かす。

   ```bash
   source <このフォルダ>/scripts/kf7-env.sh && bash <このフォルダ>/scripts/kf7-build.sh --src <ソースのフォルダ> --name <アプリの名前>
   ```

   デバッグ用（最適化なし、デバッグ情報つき）は `--debug` を足す。
3. 成功すると、標準出力に1行の JSON が出る。`image`（`.kfi` の絶対パス）と `crc32` を控える。デプロイで使う。

   ```json
   {"elf": "/path/src/build/kf7/sensor.elf", "image": "/path/src/build/kf7/sensor.kfi", "crc32": "0x1a2b3c4d", "size": 423620}
   ```

4. 失敗したら、そのまま進めない。終了コードと、`<ソースのフォルダ>/build/kf7/build.log` の最初の `error:` の行を示して止まる。

| 終了コード | 意味 | すること |
| --- | --- | --- |
| 0 | 成功 | なし |
| 2 | 引数の誤り | `--help` を見る |
| 3 | `kf7-env.sh` を読み込んでいない | 手順2のとおり、同じコマンドの中で `source` する |
| 4 | コンパイルの失敗 | build.log の最初の `error:` の行を見る |
| 5 | リンクの失敗 | build.log を見る |
| 6 | イメージを作れない | 標準エラーを見る（名前の誤りなど） |

## 気をつけること

- `kf7-env.sh` は、ビルドと同じコマンドの中で `source` する。別のコマンドで読み込んでも、次のコマンドに環境が残らないことがある。
- 開発機の `gcc` でビルドしない。できるのは x86 の実行ファイルで、ボードのローダーが `ERR ARCH` で断る。
- 必ず静的リンクにする。`kf7-env.sh` が入れる `-static` を消さない。KF-7 の rootfs には共有ライブラリのローダーがなく、動的リンクの実行ファイルは、ファイルがあるのに `not found` と出て動かない。
- ローダーは ELF をそのまま受け付けない（`ERR MAGIC`）。送るのは必ず `.kfi`。ヘッダーを手で作ったり直したりしない。形式は [references/kfi-format.md](references/kfi-format.md) にある（ヘッダーを調べるときだけ読む）。
- ソースのフォルダのファイルは変えない。出力は `<ソースのフォルダ>/build/kf7/` の下にだけ書く。
````

スクリプトの約束：

| スクリプト | 引数・入力 | 標準出力 | 終了コード・そのほか |
| --- | --- | --- | --- |
| `kf7-env.sh`（source する） | なし | なし | `KF7_ENV_LOADED=1`、`KF7_CC=arm-linux-gnueabihf-gcc`、`KF7_CFLAGS="-march=armv7-a -mfpu=neon-vfpv4 -mfloat-abi=hard -O2 -Wall -DKF7_BOARD=1"`、`KF7_LDFLAGS="-static"` を export する。`arm-linux-gnueabihf-gcc` がなければ標準エラーに直し方を出して `return 1` |
| `kf7-build.sh` | `--src DIR`（必須）、`--name NAME`（必須）、`--debug`（`-O2` の代わりに `-O0 -g`）、`--help` | 成功時に1行の JSON（`elf`、`image`、`crc32`、`size`） | 0 成功、2 引数の誤り、3 `KF7_ENV_LOADED` がない、4 コンパイルの失敗、5 リンクの失敗、6 `kf7-mkimage.py` の失敗。出力は `<src>/build/kf7/`（`<name>.elf`、`<name>.kfi`、`build.log`）。`*.c` を `$KF7_CC $KF7_CFLAGS … $KF7_LDFLAGS` でまとめてビルドする。Makefile は使わない（T-01 の `Makefile.target` は `CC = gcc` で、x86 になる） |
| `kf7-mkimage.py` | `ELF NAME OUT`、`--help` | 1行の JSON（`image`、`crc32`、`size`） | 0 成功、2 引数の誤り、6 名前の誤り（`^[a-z0-9-]{1,15}$` でない）・ELF でない・ARM でない。標準ライブラリだけ（`zlib.crc32`、`struct`） |

### 4.3 deploy のスキル

```
deploy/
├── SKILL.md
├── scripts/
│   ├── kf7-push.py       # .kfi をローダー（TCP 6123）へ送る
│   └── kf7-console.py    # コンソール（TCP 6124）でコマンド・再起動・実行とログ取り
└── references/
    └── loader-protocol.md  # ローダーとコンソールの応答の一覧（ERR の意味）
```

SKILL.md の案（検査を通した写しは `/tmp/claude-0/-home-user/64a230fb-e6a2-510f-9e7e-9e6600fd34a8/scratchpad/research-scratch/dummy-draft/deploy/SKILL.md`）：

````markdown
---
name: deploy
description: "KF-7 ボード（Kitefin KF-7）へ .kfi イメージを転送して有効にし、ボードのコンソールでアプリを動かしてログを取る。「ボードに入れて」「KF-7 にデプロイして」「ボードで動かしてログを取って」と頼まれたときに使う。.kfi を作るビルドには使わない。"
compatibility: "Python 3.8 以上と、ボードへのネットワーク（TCP の 6123 番と 6124 番）が要る。"
metadata:
  owner: kf7-firmware
  revision: "1.7"
---

# KF-7 へのデプロイとログの取り方

## ボードの場所

- ボードの IP アドレスは、頼みに書かれたものを使う。書かれていなければ、USB でつないだときの既定の `192.168.7.2` を使う。
- ローダーは TCP の 6123 番、コンソールは 6124 番。スクリプトの `--host`、または環境変数 `KF7_HOST`、`KF7_LOADER_PORT`、`KF7_CONSOLE_PORT` で変えられる。

## 使うスクリプト

この節と手順のパスは、この SKILL.md があるフォルダからの相対パスである。コマンドでは、このフォルダの絶対パスを前に付けて動かす。

- `scripts/kf7-push.py`：`.kfi` をローダーへ送る。
- `scripts/kf7-console.py`：コンソールにつなぎ、コマンドを送って出力を取る。

どちらも `--help` で使い方と終了コードが出る。

## 手順

1. 機体を確かめる。`python3 <このフォルダ>/scripts/kf7-console.py --host <IP> --cmd "kfctl info"`。`serial=` が `KF7-P` で始まる機体（量産機）なら、何も送らずに止め、そのことを示す。
2. 送る。`python3 <このフォルダ>/scripts/kf7-push.py --host <IP> <.kfi のパス>`。標準出力の JSON の `crc32` を控える。
3. 有効にする。`python3 <このフォルダ>/scripts/kf7-console.py --host <IP> --reboot`。`KF7 READY` が出るまで待つ（スクリプトが待つ。最大 60 秒）。
4. 入ったことを確かめる。`--cmd "kfctl info <アプリの名前>"` の `state=active` と `crc=` が、手順2の `crc32` と同じであること。
5. 動かしてログを取る。`python3 <このフォルダ>/scripts/kf7-console.py --host <IP> --run <アプリの名前> --timeout 20 --strip-ts --log <ログのファイル>`。終わりの目印 `[kfrun] exit=<コード>` まで取れると、標準出力の JSON の `marker` が `true` になる。
6. どこかで失敗したら（接続できない、`ERR` が返る、`KF7 READY` が出ない、目印が出ない）、そのまま進めない。コマンドと出力の要点を示して止まる。

## 気をつけること

- 送っただけでは有効にならない（`kfctl info` では `state=staged`）。`reboot` して `KF7 READY` が出てから動かす。出る前に送ったコマンドは捨てられる。再起動しないと、前に入れたイメージが動く。
- アプリは `--run`（ボードの `kfrun`）で動かし、目印 `[kfrun] exit=` まで取る。`--cmd` で `/app/bin/<名前>` を直接動かすと、5 秒で取るのをやめるうえ、目印も出ない。
- ボードの出力の行頭には、起動からの秒数 `[    12.345678] ` が付く。ログを比べるときは外す（`--strip-ts`）。
- `exit=127` と `not found` が出たら、動的リンクの実行ファイルを送っている。静的リンクでビルドし直す。
- ローダーの応答の一覧は [references/loader-protocol.md](references/loader-protocol.md) にある（`ERR` が返ったときに読む）。
````

スクリプトの約束：

| スクリプト | 引数 | 標準出力 | 終了コード |
| --- | --- | --- | --- |
| `kf7-push.py` | `IMAGE`、`--host`（既定 `$KF7_HOST` か `192.168.7.2`）、`--port`（既定 `$KF7_LOADER_PORT` か 6123）、`--timeout`（既定 10 秒）、`--help` | 1行の JSON（`result`、`name`、`crc32`、`state`） | 0 `OK`、2 引数の誤り・ファイルがない・`.kfi` の頭が `KF7I` でない（送る前に断る）、3 `ERR MAGIC`/`ERR VERSION`、4 `ERR CRC`、5 `ERR ARCH`、6 `ERR NAME`、7 接続できない・時間切れ |
| `kf7-console.py` | `--host`、`--port`（既定 `$KF7_CONSOLE_PORT` か 6124）、次のどれか1つ：`--cmd CMD`（プロンプト `kf7# ` まで、最大 5 秒）、`--reboot`（`KF7 READY` まで、最大 60 秒）、`--run NAME [--args ...]`（`[kfrun] exit=N` まで、`--timeout` 既定 20 秒）。`--strip-ts`、`--log FILE`、`--help` | `--cmd`：取れた出力（文字）。`--reboot`：JSON（`ready`、`seconds`）。`--run`：JSON（`marker`、`exit`、`lines`、`log`） | 0 成功、2 引数の誤り、3 接続できない、4 待つものが時間内に出ない（READY・目印・プロンプト）。`--run` は、アプリの終了コードが 0 でなくても、目印が取れれば 0（アプリの終了コードは JSON の `exit`） |

### 4.4 .kfi の形式（`references/kfi-format.md` に書く中身。エミュレーターも同じ形を検査する）

| オフセット | 大きさ | 中身 |
| --- | --- | --- |
| 0 | 4 | マジック `KF7I`（ASCII） |
| 4 | 2 | 形式の版（リトルエンディアン）= 1 |
| 6 | 2 | ヘッダーの大きさ = 32 |
| 8 | 4 | 本体（ELF）の大きさ（埋める前、リトルエンディアン） |
| 12 | 4 | CRC32（zlib と同じ IEEE 802.3。本体の後ろを 0x00 で 4 バイト境界まで埋めた列で計算） |
| 16 | 16 | アプリの名前（ASCII、`^[a-z0-9-]{1,15}$`、残りは 0x00） |
| 32 | — | 本体（4 バイト境界まで 0x00 で埋める） |

CRC を埋めた後の列で計算するのが「隠れた決まり」である。手で作ると外れやすい。スクリプトを流用すれば守られる。

### 4.5 機器（エミュレーター）が守る約束

エミュレーターの作りは別の調査の範囲（`RESUME.md` の段階2「エミュレーターとサンドボックス」）。デプロイのスキルが前提にする約束だけを書く。エミュレーターはこの約束どおりに作る。

ローダー（TCP、既定 6123）：

1. 客が `PUT <バイト数>\n` を送り、続けて `.kfi` の全バイトを送る。
2. 機器は1行で答える。`OK <名前> crc=0x%08x state=staged\n`、または `ERR <コード> <説明>\n`。
3. 検査の順とコード：マジック（`ERR MAGIC`）→ 版・ヘッダーの大きさ（`ERR VERSION`）→ 大きさ（`ERR SIZE`）→ CRC（`ERR CRC`）→ 名前（`ERR NAME`）→ 本体が 32 ビットの ARM の ELF か（e_ident の EI_CLASS=1、e_machine=40。`ERR ARCH`）。
4. 受け付けたイメージは「staged」で置かれ、まだ動かない。

コンソール（TCP、既定 6124、行の終わりは `\r\n`）：

- つなぐと、起動中でなければ `kf7# ` のプロンプトを出す。
- 機器が出す行（起動のログ、アプリの出力、目印）には、起動からの秒数 `[%12.6f] ` を前に付ける。プロンプトには付けない。
- コマンド：
  - `kfctl info`：`serial=<シリアル> fw=4.2.1 uptime=<秒>`。シリアルはエミュレーターの起動の引数で決める（既定 `KF7-D-0042`。量産機の試験では `KF7-P-…`）。
  - `kfctl info <名前>`：`name=<名前> state=staged|active crc=0x… size=…`、なければ `ERR NOENT`。
  - `reboot`：つながりを保ったまま、起動のログを数行出し、最後に `KF7 READY` を出してからプロンプト。起動中（READY の前）に来た入力は捨てる。staged のイメージは、再起動で active になる。
  - `kfrun <名前> [引数…]`：active のイメージを `qemu-arm -cpu cortex-a7 <ELF>`（`-L` を付けない）で動かし、出力の各行に秒数を付けて出し、最後に `[kfrun] exit=<コード>` を出す。動的リンクの ELF で qemu-arm が `Could not open '/lib/ld-linux-armhf.so.3'` を出したら、`/bin/sh: /app/bin/<名前>: not found` と `[kfrun] exit=127` にする。
  - `/app/bin/<名前>`（直接）：出力は出すが、目印は出さない。
  - ほかのコマンド：`sh: <コマンド>: not found`。
- エミュレーターは、受けた操作（PUT、reboot、kfrun、コマンド）を、エージェントから見えない場所に JSONL で記録する。EVAL のプログラムの採点に使う（4.7）。

### 4.6 クリエイターが取り出すべき決まり（隠れた決まり）と、置いた場所

| # | 決まり | 書いてある場所 | 必須か |
| --- | --- | --- | --- |
| C1 | 環境の読み込み（`source kf7-env.sh`）とビルドを、同じ1つのコマンドで動かす | SKILL.md 手順2・気をつけること、`kf7-build.sh` の終了コード 3 | 必須 |
| C2 | 開発機の gcc でなく、arm-linux-gnueabihf のツールチェーンでビルドする | 気をつけること、`kf7-env.sh` | 必須 |
| C3 | 静的リンクにする（rootfs に動的ローダーがない） | 気をつけること、`kf7-env.sh` の `KF7_LDFLAGS` | 必須 |
| C4 | ELF でなく `.kfi` に包んで送る（CRC は埋めた後の列で計算。スクリプトに任せる） | 気をつけること、`references/kfi-format.md`、`kf7-mkimage.py` | 必須 |
| C5 | アプリの名前は英小文字・数字・ハイフンで 15 文字以内 | 手順1、`kf7-mkimage.py`（終了コード 6） | 任意 |
| C6 | 成果物は `<src>/build/kf7/`。失敗は終了コードと build.log の最初の `error:` | 手順3・4 | 任意 |
| D1 | ボードの場所：頼みの IP、既定 `192.168.7.2`、ローダー 6123、コンソール 6124 | ボードの場所 | 必須 |
| D2 | 送っただけでは有効にならない。`reboot` して `KF7 READY` を待ってから動かす | 手順3、気をつけること | 必須 |
| D3 | アプリは `kfrun`（`--run`）で動かし、目印 `[kfrun] exit=` まで取る | 手順5、気をつけること | 必須 |
| D4 | デプロイの確かめ：`kfctl info <名前>` の `state=active` と `crc=` が送ったものと同じ | 手順4 | 任意 |
| D5 | ログの行頭の秒数を外して比べる | 気をつけること、`--strip-ts` | 任意 |
| D6 | 量産機（`serial=KF7-P…`）には送らずに止める | 手順1 | 任意 |
| D7 | `exit=127` と `not found` は動的リンクのしるし | 気をつけること | 任意 |

- 必須のものだけでも、ビルド4件、デプロイ3件になる。REQ-055 の「〜という決まりですか？」の確認が多くなりすぎるときは、任意のものを削る（憲章 第10条）。
- D6 は「人に聞く」でなく「止めて示す」で書いた。サブエージェントでも単体でも同じ意味になる（3.1 U5）。書き直しで「ユーザーに聞く」に変えられていないかも見られる。
- C5 の 15 文字の制限は、SKILL.md の手順1とスクリプトの両方にある。スクリプトにしかない決まりを1つ作ると、クリエイターがスクリプトまで読むかを試せる（案。例：`kf7-push.py` が送る前に `.kfi` の大きさが 8 MiB 以下かを確かめる、をスクリプトだけに書く）。

### 4.7 決まりを見逃したときにエミュレーターで起きること（EVAL の基準の種）

| 見逃した決まり | エミュレーターで起きること | プログラムでの見つけ方 |
| --- | --- | --- |
| C1・C2 | x86 の ELF ができ、PUT で `ERR ARCH`（`kf7-build.sh` を使えば終了コード 3 で先に止まる） | エミュレーターの記録に `ERR ARCH`、または `.kfi` がない |
| C3 | PUT は通るが、`kfrun` で `not found` と `exit=127` | 記録の kfrun の終了コードが 127 |
| C4 | `ERR MAGIC`、または手で作って `ERR CRC` | 記録に `ERR MAGIC`・`ERR CRC` |
| D2 | 前のイメージが動く（直したはずの出力にならない）、または `ERR NOENT` | 記録で、最後の PUT の後、kfrun の前に reboot がない |
| D3 | 目印のないログ、または 5 秒で切れたログ | 記録の実行の種類が `kfrun` でない、保存したログに `[kfrun] exit=` がない |
| D6 | 量産機に PUT した | 記録に、シリアルが `KF7-P` のときの PUT がある |

- 単体のクロスコンパイル（REQ-062 の例）は、`<src>/build/kf7/<名前>.kfi` があり、ヘッダーと CRC が正しく、中の ELF が ARM の静的リンク（PT_INTERP がない）かを、プログラムで見る。エミュレーターは要らない。
- 本物の機器には何も送らない（REQ-061）。エミュレーターのアドレスは 127.0.0.1 と、試験ごとのポート（環境変数 `KF7_LOADER_PORT`・`KF7_CONSOLE_PORT`）にする。

### 4.8 置き場所と試験での注意

- 改善・設計変更の試験（クリエイターのセッション。外側の EVAL）：ダミーのスキルは、ユーザーのファームウェアのリポジトリの形で、Copilot CLI を起動するフォルダの下の別のフォルダに置く（例：`<起動フォルダ>/kf7-firmware/.github/skills/cross-compile/`）。起動フォルダの直下の `.github/skills/` や、試験用の `COPILOT_HOME` の `skills/` に置くと、クリエイターのセッション自身にダミーのスキルが読み込まれ、クリエイターのモデルがそれを使ってしまうおそれがある（Copilot CLI はプロジェクトのスキルを、作業フォルダとその親から読む。GH-cmd「Skill locations」）。起動フォルダの中に置くので、読むときにフォルダの許可の確認も出ない（REQ-053 と同じ理由）。
- ダミーのスキルのフォルダは、試験の前後でハッシュを比べ、変わっていないことを確かめる（REQ-055 の受け入れ基準）。
- 直した後のプラグインの試験（内側の EVAL）：
  - 単体の頼みの課題は、ダミーのスキルを読まない作業フォルダで行う（2.4 の「似た説明の問題」）。
  - 名前の重なりは、スクリプトの検査で確かめるのが確実である（事実で決まることは問いにしない、`skillflow.md:294`）。実際に隠れることを EVAL で見たいときは、ダミーのスキルを作業フォルダの `.github/skills/` に置く。`--plugin-dir` で読ませると、個人のフォルダのスキルより先になる（2.1 の 3）ので、個人のフォルダに置いた試験では隠れない。
- サンドボックスの中から 127.0.0.1 の TCP につなげるかは、サンドボックスの調査で確かめる。つなげないときは、`KF7_HOST=unix:/path` のような Unix ドメインソケットに切り替えられるよう、スクリプトとエミュレーターの両方で受け付ける（案）。

### 4.9 この容器で確かめたこと

- `arm-linux-gnueabihf-gcc` 13.3.0、`qemu-arm` 8.2.2。
- `-static` の ARM の ELF は、`qemu-arm`（`-L` なし）で動いた（終了コードもそのまま返る）。動的リンクの ELF は `qemu-arm: Could not open '/lib/ld-linux-armhf.so.3': No such file or directory`（終了コード 255）で動かず、`-L /usr/arm-linux-gnueabihf` を付けると動いた。→ エミュレーターが `-L` を付けなければ、C3（静的リンク）を自然に試せる。
- binfmt_misc は登録されておらず、ARM の ELF を直接動かすと `cannot execute binary file: Exec format error` になる。x86 の ELF を `qemu-arm` に渡すと `Invalid ELF image for this architecture`。
- T-01 のソース（`main.c`、`sensor_avg.c`）を、KF-7 のフラグ（`-march=armv7-a -mfpu=neon-vfpv4 -mfloat-abi=hard -O2 -Wall -static`）でビルドし、`qemu-arm -cpu cortex-a7` で動かすと、`[DBG] sensor module start`、`[DBG] AVG=3` が出た（ソースは写しで動かし、元は変えていない）。
- 4.2・4.3 の SKILL.md の案は、クリエイターの `check_skill_file`（`template/tests/stage1/check_structure.py:433-472`）でエラーも警告も出なかった。description は 181 文字と 135 文字、本文は 48 行と 34 行。

---

## 5. 勧めのまとめ

1. 生成プラグインのスキルは、6項目だけのフロントマター、ASCII の名前、フォルダの名前と一致、description は頼みの言葉、本文 500 行以内、参照はフォルダの中の相対パスで1段、コマンドは「このフォルダの絶対パス＋相対パス」、スクリプトは対話なし・`--help`・JSON・終了コード（1.8 の S1〜S9）。
2. 名前の重なり：Copilot CLI では、プロジェクト・個人のスキルと同じ名前のプラグインのスキルは、黙って無視される（GH-plugin）。プラグインどうしは両方残る（1.0.66）。`--plugin-dir` は個人のスキルより先（1.0.55）。Claude Code では両方残る（名前空間付き）。REQ-055 の確かめは、示されたスキルの `name` に加え、起動フォルダと個人のフォルダのスキルの `name` とも比べ、スクリプトで行う。プラグインの名前を頭に付ける名前の付け方は、設計で決める。
3. ルールのスキルは、決まりの文をそこにだけ書き、エージェントの定義は「どのスキルを読み、何を引数に渡し、結果をどこに置くか」だけを書く。作業エージェントは今のまま `skill` を持たず、統括から渡された絶対パスで `SKILL.md` を読む（3.2 の案 A）。人に聞く手順は「止めて示す」に変える。
4. ダミーのスキルは、架空の KF-7 ボードの `cross-compile`（環境の読み込み、静的リンク、.kfi と CRC）と `deploy`（独自のローダーの手順、staged → reboot → `KF7 READY`、`kfrun` と終わりの目印、秒数の付いたログ、量産機を避ける）。必須の決まりは7件。エミュレーターは 4.5 の約束どおりに作り、操作の記録で採点する。

## 6. 確かめていないこと

- 2.5 の3点（隠されたプラグインのスキルを名前空間付きで呼べるか、一覧に出るか、プラグインのフォルダを読むときの確認）。
- Copilot CLI が `${CLAUDE_SKILL_DIR}` を置き換えないこと（ドキュメントに記述がないことだけを確かめた）。
- Copilot CLI が、Agent Skills に合わないプラグインのスキルを実際に飛ばすか（`.claude/memory/skills.md:47` と同じく未確認）。
- 日本語の description で、単体の頼みのときにスキルが呼ばれるか（`.claude/memory/skills.md:21` と同じく公式の情報なし）。
- ダミーのスキルのスクリプトとエミュレーターは、まだ作っていない（段階6）。
