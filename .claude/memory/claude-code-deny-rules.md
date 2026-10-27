# Claude Code の禁止のルールでフォルダを読めなくするときの注意

見ない模擬ユーザー h1（`tests/dev-eval/heldout/h1`。クリエイターを直す AI が見てはいけない模擬ユーザー）を、Claude Code から読めなくする設定を試して分かったこと（2026年10月、Claude Code のクラウドのセッション）。1〜3は、h1 の代わりに作ったダミーのフォルダで試した。

## 1. リポジトリを2つつないだクラウドのセッションでは、リポジトリの `.claude/settings.json` が効かない

- plugin-creator の `.claude/settings.json` に、ダミーのフォルダを Read ツールと Bash で読むのを禁止するルール（`permissions.deny`）を書いた。それでも、Read ツールでも、Bash の cat・python でも読めた。
- クラウドの環境の公式の説明には、リポジトリの `.claude/settings.json` は、リポジトリを1つだけつないだセッションだけが読むとある（「only a session with one repository reads it」）。このセッションは、plugin-creator と plugin-market-place の2つをつないでいた。

## 2. コンテナのユーザーの設定（`~/.claude/settings.json`）なら効く

- 同じルールを `~/.claude/settings.json` に書くと、Bash の cat・python と、Grep ツールが断られた。python は、コマンドにパスが入っていたので、Bash のルールで断られた。
- コンテナの設定なので、セッションが終わると消える。続くセッションでは、入れ直す。

## 3. Read のルールのパスは、作業フォルダ（cwd）から照らし合わされるとみられる

- `tests/dev-eval` の中に、ダミーのフォルダ zz-a と zz-b を作り、`Read(**/dev-eval/zz-a/**)` と `Read(**/zz-b/**)` を書いた。作業フォルダを3か所に変えて、Read ツールで読んだ。

| 作業フォルダ | `Read(**/dev-eval/zz-a/**)` | `Read(**/zz-b/**)` |
| --- | --- | --- |
| plugin-creator | 断られた | 断られた |
| `tests/dev-eval` | **読めた** | 断られた |
| `/home/user` | 断られた | 断られた |

- 公式の説明では、`//` で始まらない書き方は、今いるフォルダからのパスとされる。`tests/dev-eval` から見ると zz-a は `zz-a/…` なので、`dev-eval/zz-a` に当たらないとみられる（理由は試していない）。
- `//` で始まる絶対パス（`Read(//home/user/plugin-creator/tests/dev-eval/<フォルダ>/**)`）も、Read ツールを断った。`./…` と `/…` の書き方は、ユーザーの設定に書き、作業フォルダが `tests/dev-eval` のときに試すと、Read ツールを断らなかった。
- 読めなくしたいフォルダは、フォルダ名だけの `Read(**/<フォルダ名>/**)` と、絶対パスの形で書く。
- Read のルールは、Grep ツールと、Bash の cat・head などにも効いた。python など、ファイルを自分で開くプログラムには効かない（公式の説明。止めるには、コマンドにパスが入るのを Bash のルールで断るか、サンドボックスの `denyRead` を使う）。

## 4. 前後に `*` を付けた Bash のルールは、パスを書いただけのコマンドも断る

- `Bash(*dev-eval/heldout*)` を入れた後、コミットのメッセージに `tests/dev-eval/heldout/` と書いたら、`git commit` のコマンドごと断られた。メッセージからパスを外すと通った。
- コミットのメッセージなど、Bash のコマンドの中に、そのパスを書かない。
- サブエージェントで効くかは、自動モードの判定がその試しを断ったので、確かめていない（公式の説明では、Bash のルールはサブエージェントにも効く）。
