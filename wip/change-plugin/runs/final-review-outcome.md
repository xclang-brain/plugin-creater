# 外側の EVAL（改善・設計変更）5回目の成果物の点検（final review）

作業の途中のメモである（憲章・仕様書・設計書・実装資産のどれでもない）。

- 対象：5回目の実行（点数 1.00、落ちた観点なし、faults なし、英語の一言 7件、流れの表示なし）で直された生成プラグイン embedded-debug-loop
- 場所：`<scratchpad>/runs/outer-change-5/runs/outer-edl-change-with-vYhysZ/work/market/plugins/embedded-debug-loop`
- 差分：初めのコミット `0b17e2d`（change-baseline.json の baseCommit）から `b41f4ce`（HEAD、タグ `plugin-creator-generated-embedded-debug-loop`）まで。62ファイル、+3655 / -399
- `<scratchpad>` は `/tmp/claude-0/-home-user/64a230fb-e6a2-510f-9e7e-9e6600fd34a8/scratchpad` である。

## 0. 結論

取り込んだ決まり、アドレス、K-15 の置き換えと番号、書き足された DBG_LOG の決まり、版、コミットの範囲は正しい。写しのフォルダで試験を動かすと、1段目 13合格・2対象外、2段目 492件すべて合格だった。

一方で、点数に出ない次の問題が残っている（重い順）。

| # | 重さ | 一言で |
| --- | --- | --- |
| F1 | 中 | 仕様書の古い要件（いつもと違うときは全部すぐ人に聞く REQ-107、3つのルールのスキルに「ここを機器に合わせて書く」の欄がある REQ-108）が、直した中身と食い違ったまま残っている |
| F2 | 中 | 手順書 `docs/customize-rules.md`（K-16 の手順書）が直されていない。もうない「ここを機器に合わせて書く」の欄に書くよう案内している |
| F3 | 中 | 説明の「直す前に戻すやり方」のコマンドが、このリポジトリの今の状態（ユーザーの README.md が git add 済み）では失敗する |
| F4 | 中 | T-02 の K-33 の基準（ログが取れないときは1回 reboot してやり直す）は、K-33 を壊して K-15 の振る舞いに戻したプラグインでも合格する |
| F5 | 中〜小 | KX-200 で動かすのに要る2つのこと（「その他の情報」に KX-200 と書くこと、頼みにアプリの名前を書くこと）が、README にも画面にもない。アプリの名前がないと、ルールのスキルは止まる |
| F6 | 小 | T-02 の「入れて、再起動してから動かす順」の基準は、順を間違えても K-33 のやり直しで合格してしまう |
| F7 | 小 | 決まりの文の写し（REQ-062）：ビルド・デプロイ担当の定義に K-33 の中身、2つのルールのスキルに K-24（アプリの名前の形）が写っている。構造の検査は言い換えた写しを見つけられない |
| F8 | 小 | log-insertion-rules が REQ-062 の形になっていない（description が「ソースコード担当が読む」という呼ぶ役の言い方、本文が統括の計画を前提にしている） |
| F9 | 小 | 写したスクリプト kx-build.sh と mkkximg.py を、コマンドとして動かす2段目の試験がない |
| F10 | 小 | ビルドの出力の既定（ソースのフォルダの build）が、ソースの差分（code-diff.patch）に入り込む |
| F11 | 小 | 設計書の1文が「ビルドが失敗したときも reboot してやり直す」と読める |
| F12 | 情報 | 擬似の道具2つが git で実行の権限なし（EVAL は権限を付けるので動く）。英語の一言 7件と流れの表示なしは、クリエイターの会話の問題 |

## 1. 確かめて、問題がなかったこと

### 1.1 ルールのスキル（取り込んだ決まり）

- cross-compile-rules：arm-linux-gnueabihf-gcc を使い開発機の gcc を使わない（K-21）、必ず静的リンク（K-22）、最適化は -O2 で gdb で1行ずつ追う調査のときだけ --debug で -O0 -g（K-23。ユーザーが答えた例外が入った）、出力のフォルダは頼まれた場所でなければソースのフォルダの build（K-20）、アプリの名前の形（K-24）、ビルドが失敗したら止めて示す（K-33 のビルドの半分）。kx-build.sh の使い方（引数、JSON の出力、終了コード 0/2/3/4）も書かれている。
- deploy-rules：送るのは mkkximg.py で作った .kximg（K-28）、kxtool の send と console -c（K-26）、send → kxinstall → reboot → kxapp run の順（K-29）、目印 `[kxapp] <名前> exited (status=N)` まで取る（K-30）、頼まれた場所に保存（K-31）、アドレス（K-32）、デプロイ・応答・ログの失敗は1回 reboot してやり直し、だめなら止める（K-33 の残りの半分）。
- 入れなかったもの：ビルドの前の git pull（ユーザーは「決まりではなく、たまたま」）、送る前の uname -a（同じ）、古いアドレス 192.168.7.20（「違う」）。どれもルールのスキルにない。
- スキルの名前（cross-compile-rules、deploy-rules）は、ユーザーのスキルの名前（cross-compile、deploy）と違う。description は、直す前の確認で示してよいと答えられた文と同じで、何をするかとチャットでの頼み方（「KX-200 用にビルドして」など）が入り、`<` `>` がない。
- 単体で使えるか：スクリプトはスキルのフォルダの scripts/ にあり、本文は `<このスキルのフォルダ>/scripts/...` で指す。ほかのスキル、記録のツール、エージェント、task.json を指していない。cross-compile-rules には「チャットで頼まれたとき」の節がある。
- 写したスクリプト2つは、ユーザーのものとバイト単位で同じ。ユーザーのスキルのフォルダの4ファイルのハッシュは、change-baseline.json の値と同じ（変わっていない）。

### 1.2 アドレス

- deploy-rules の既定は 192.168.7.2。プラグインの中で 192.168.7.20 が出てくるのは、「使わない」と書いた K-32 の文（knowledge.json、task.json、T-02 の eval.json）と、擬似の道具の試験（応答しないことを試す）だけ。
- ビルド・デプロイ担当は「device_ip にあればそれ、なければ deploy-rules の既定」。画面の設定（device_ip は任意で初めの値なし）は変わっていない。ユーザーの答え（画面はそのまま、スキルの既定を今のボードにする）のとおり。

### 1.3 K-15 の置き換えと番号（REQ-058）

- 引き継いだ K-01〜K-14、K-16、K-17 の番号と文は、直す前と同じ。
- K-15 は knowledge.json から外れ、`tests/knowledge-removed.json` に `replacedBy: K-33` で入った。K-33 は、使ったどの番号（最大 K-32）よりも後。
- プラグインの中で K-15 を指すのは knowledge-removed.json だけ（統括の「いつもと違うとき」の見出し、ルールのスキル、仕様書、設計書、README に K-15 が残っていない）。
- 足した決まりは K-18、K-20〜K-24、K-26、K-28〜K-32。欠けている K-19・K-25・K-27 は、確かめて入れなかった候補（git pull、古いアドレス、uname -a）の番号で、ほかの決まりに使っていない。次の改善・設計変更の番号は K-34 からになるので、重ならない。

### 1.4 書き足された DBG_LOG の決まり（REQ-054）

- 「KX-200 では dbg_log.h の DBG_LOG でログを出し、printf を直接使わない」の1行を、「という決まりですか」の問いで1件だけ確かめ、ユーザーが「このとおり」と答えた。
- K-18（17 より後）として knowledge.json と task.json の基準 C-04 に入り、log-insertion-rules の行には（K-18）が付いた。行は1つだけ（4回目の2行の重なりは直った）。
- 基本は printf の K-08 は、文も番号もそのまま残った（4回目の K-08 の置き換えは直った）。

### 1.5 版、コミット、タグ、外のファイル

- plugin.json の version は、確認でよいと答えた 0.2.0。description は変わっていない。
- コミットは1つで、中身はプラグインのフォルダの中だけ。ユーザーが git add していたリポジトリの直下の README.md は、git add されたまま残り、コミットに入っていない。push されていない（origin は main が 0b17e2d のまま）。
- 作業用の一時フォルダ（.plugin-creator-work）は残っていない。.gitignore に足された。
- marketplace.json と market/README.md は 0.1.0 のまま（フォルダの外なので直さない。説明で手で直すよう示した）。

### 1.6 T-02 と擬似の機器

- 頼みにアプリの名前 sensor、device_ip は空（既定の 192.168.7.2 を試す）、その他の情報「KX-200 ボード」、クロスコンパイルの情報は空。
- 擬似の kxtool：192.168.7.2 だけ応答する。.kximg でなければ bad magic。reboot 前の kxapp run は not installed（pending）。最初の kxapp run だけログが取れない（log-lost）。呼ばれるたびに device-history.log に1行足す。擬似のコンパイラは、-static がないと印を付け、ボードで not found になる。
- 写しで、正しい流れ（kx-build.sh → mkkximg.py → send → kxinstall・reboot・kxapp run → log-lost → reboot → kxapp run）を手で動かし、`[dbg] AVG=25` と `[kxapp] sensor exited (status=0)` が出て、プログラムの基準（C-05〜C-14）が合格することを確かめた。
- EVAL は、課題の bin を作業フォルダに写して実行の権限を付け、PATH の先頭に足す（`skills/test-plugin/scripts/tasks.mjs` の makeExecutable、`run.mjs` の runtimeEnv）。本物の機器には送られない。直す前の確認で、本物の転送は試せないと示した。

### 1.7 説明（REQ-060）

変わったこと、直した決まり（K-15 → K-33）・足した決まり・外した決まり（なし）、流用したもの、構造の検査と部品の試験の結果、コミットと戻し方、試験のしかた、読み込ませ方（手元のマーケットプレイスと GitHub の両方）、marketplace.json と market/README.md の版を手で直すこと、Issue を起票できるようにする手順、が示された。ユーザーの deploy スキルに古いアドレスが残ることと、同じ頼みで両方のスキルが呼ばれうることも示した（よい点）。ただし戻し方のコマンドは F3 のとおり失敗する。

### 1.8 試験（写しで動かした）

- `cp -a` で market リポジトリ全体を `<scratchpad>/final-review/market-copy` に写し、`tests/results` を消してから、プラグインのフォルダで `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers python3 tests/run.py --json` を動かした。
- 結果：終了コード 0。1段目 15件（13合格、2対象外：mcp.json と references）、2段目 492件すべて合格（node 444、unittest 48）。クリエイターが実行中に出した結果（同じ件数）と一致する。

## 2. 指摘

### F1（中）仕様書の古い要件が、直した中身と食い違う

- REQ-107「いつもと違うときは、そのまま進めず人に伝える」：要件は今も「ビルドの失敗、デプロイの失敗、実機が応答しない、ログが取れない、といったことが起きたら、そのまま進めず、起きたことを人に伝えて判断を仰ぐ」（`docs/specs/requirements.md` 330〜335行）。足した REQ-113（デプロイ・応答・ログの失敗は1回 reboot してやり直す）と食い違う。設計書の追跡の表も REQ-107 を統括とビルド・デプロイ担当の定義に結んだまま。
- REQ-108「機器ごとのルールを、利用者が書き換えるスキルにする」：要件は「初めは汎用のひな形が入っている」、受け入れ基準は「3つのスキルがあり、それぞれに『ここを機器に合わせて書く』の欄がある」「Makefile…は例であり、固定の仕様ではないと書かれている」（337〜343行）。直した cross-compile-rules と deploy-rules には、その欄も例の文もない（例の文は log-insertion-rules にだけ残る）。
- REQ-059 は「プラグインの憲章・仕様書・設計書は、変えた内容に合わせて直す」を求める。設計書の 8.1 は「log-insertion-rules は汎用のひな形、2つは KX-200 向け」と直してあるので、仕様書だけが古い。
- 直す案：REQ-107 を外して REQ-113 にまとめる（または REQ-107 をビルドの失敗だけに直す）。REQ-108 の要件と受け入れ基準を、今の3つのスキルの形に合わせる。クリエイターの change-apply.md で、変えた決まりを根拠にしている作業ごとの要件（REQ-101 から）を見直すよう、作業役への頼みに入れる。

### F2（中）手順書 `docs/customize-rules.md` が古い

- 2節「SKILL.md を直接書き換える」の2が「『ここを機器に合わせて書く』の欄に、対象の機器の情報を書きます」、例が `skills/cross-compile-rules/SKILL.md`。直した cross-compile-rules には、その欄がない。
- 1節は「このフォルダのプラグインを作り直したい」と頼むよう案内している。REQ-052 では、フォルダを示して「作り直したい」とだけ頼むと、新しいフォルダに作るか元のフォルダを直すかを聞かれる。改善・設計変更（`/plugin-creator:change-plugin`）の頼み方にしたほうが迷わない（この文は直す前からある）。
- KX-200 のほかの機器を足すやり方（今の2つのスキルは KX-200 用で、ほかの機器は「頼みや作業の画面で渡されたルールに従う」）が書かれていない。
- K-16（手順書を含める、利用者がその手順どおりにカスタマイズできる）と REQ-110 に関わる。README は今もこの手順書を案内している。

### F3（中）「直す前に戻すやり方」のコマンドが失敗する

- 説明で示したコマンド：`git -C market/plugins/embedded-debug-loop revert --no-edit b41f4ce…`（生成元は `skills/make-plugin/scripts/scaffold.py` 2611行）。
- このリポジトリでは、ユーザーが直す前から README.md を git add している（REQ-059 が想定している状態で、コミットには正しく入れなかった）。写しで動かすと `error: your local changes would be overwritten by revert.` で止まった。git revert は、ほかのファイルでも、インデックスに変更があると断る。
- 写しで確かめた代わりのやり方：`git -C <リポジトリ> restore --source=b41f4ce~1 --staged --worktree -- plugins/embedded-debug-loop` の後に `git -C <リポジトリ> commit -m "…" -- plugins/embedded-debug-loop`。これなら、git add 済みの README.md はそのまま残り、プラグインのフォルダは直す前と同じになった。stash してから revert しても戻るが、stash pop で README.md の git add が外れる。
- 直す案：scaffold.py が返す `revert` を、インデックスに変更があるときは上のやり方にする（または、そのときは「先にほかの変更をコミットか stash する」を添える）。外側の EVAL の採点に「戻すコマンドを写しで動かす」観点があると、今後も見つけられる。

### F4（中）T-02 の K-33 の基準が、壊した K-33 を見分けられない

- 基準 C-14：device-history.log に `log-lost[\s\S]*reboot[\s\S]*exited \(status=` が合うこと。
- 写しで、K-15 の振る舞い（ログが取れなかったら reboot せずに止める）をまねた。1回目は log-lost で止め、人の判断待ち → EVAL の決まった返事「課題に書いたこと以外は決まっていません。判断して進めてください」（`skills/test-plugin/scripts/permissions.mjs` の FIXED_ANSWER）で続き、2回目にふつうに送り直す（kxinstall → reboot → kxapp run）。この記録でも C-14 は合格した。送り直しの手順の中の reboot に合うためである。
- REQ-061 の受け入れ基準「変えたところを壊したプラグインで EVAL を行うと、足した課題の基準が不合格になる」に合わない。
- 直す案：log-lost の次の行が reboot であることを見る（例：`log-lost\n[^\n]*-c "reboot" -> ok`）。写しで、正しい流れでは合い、K-15 の流れでは合わないことを確かめた。reboot の後にどこからやり直すかは AI が決めてよいが、どれでも次の行は reboot になる。
- 補足：C-14 の文は「ビルドが失敗したときは人に伝える」も含むが、T-02 にビルドの失敗の場面はない（1つ以上足すという REQ-061 の求めは満たしている）。

### F5（中〜小）KX-200 で動かすのに要ることが、使う人に伝わらない

- ビルド・デプロイ担当は「機器が KX-200 ボードのとき（頼みの device_info などで分かるとき）」だけルールのスキルに従う。README の「用意するもの」には、その他の情報に KX-200 と書くことがない。IP アドレスだけ入れて始めると、KX-200 と分からず、「頼みや作業の画面で渡されたルール」もないまま進むおそれがある。
- アプリの名前：cross-compile-rules と deploy-rules は、頼みにアプリの名前がなければ止める。画面にアプリの名前の項目はなく（画面は変えない約束）、README にも「頼みにアプリの名前を書く」がない。T-02 は頼みに「アプリの名前は sensor です」と書いているので、この場面を試していない。
- 確かめの経緯：AI が推し量ったことの確認の問いで「アプリの名前は、書かれていなければ AI がソースのフォルダの名前などから決める」を示し、ユーザーは「私からは決まりを伝えていません。AI が名前を決めるかどうかは特に決まっていません」と答えた。クリエイターは、その後、確認の問いで示さないまま「なければ止める」にした。止めるのは設計（generated-plugin-structure.md 4.9「なければ止めて足りないものを示す」）どおりだが、流れの中で止まったとき、統括がそれを「ビルドの失敗」として人に聞くかは定義からはっきりしない。
- 直す案：README の「用意するもの」と「チャットで頼む」に、KX-200 のときは「その他の情報」に KX-200 と書き、頼みにアプリの名前を書くことを足す（T-02 の頼む言葉を例にできる）。または、直す前の確認で、アプリの名前がないときの振る舞いを示してユーザーに決めてもらう。

### F6（小）T-02 の「順を守る」の基準が、順の誤りを見分けにくい

- 基準 C-11：`kxinstall /tmp/sensor\.kximg[\s\S]*reboot[\s\S]*kxapp run sensor`。K-29（入れて、再起動してから動かす）を壊して、reboot の前に kxapp run しても、not installed（pending）をデプロイの失敗として K-33 で reboot してやり直すと、この並びが後でそろって合格する。
- 直す案：`not_contains` で device-history.log に `pending: reboot to activate` がないことを見る（grade.mjs は not_contains を受け付ける）。同じ形で、C-10（.kximg を送る）に bad magic がないことを足すこともできる。

### F7（小）決まりの文の写し（REQ-062）

- ビルド・デプロイ担当の定義（worker-b.agent.md）の手順7が、K-33 の中身（1回 reboot してから、デプロイかログ取得からやり直す。どこからやり直すかはその場で決め、理由を残す。それでもだめなら止める）を書いている。deploy-rules の同じ決まりの写しである。手順1も K-32（device_ip がなければスキルの既定）を言い換えて書いている。設計（4.9）は「作業ごとの指示には、どのスキルを読むかとナレッジの番号だけを書く」。
- K-24（アプリの名前の形）が、cross-compile-rules の「決まり」と deploy-rules の「入力」の両方にある。
- どれも言い換えなので、構造の検査（knowledge.json の文と同じ文を探す）では見つからない。統括の「いつもと違うとき（K-33）」の文は、統括がスキルを読まず、人に聞くのは統括の仕事なので、設計どおりと見る。
- deploy-rules の K-24 は、mkkximg.py の `--help` に任せれば写さずに済む。単体で使えることとの釣り合いは、設計の判断が要る。

### F8（小）log-insertion-rules が REQ-062 の形でない

- description：「…ログを追加するときの決まり。embedded-debug-loop のソースコード担当がログを追加するときに読む。」設計（4.9）が避けるよう書いている「呼ぶ役」の言い方で、チャットで「このソースにログを足して」と頼んでも選ばれにくい。
- 本文：「embedded-debug-loop のソースコード担当が…従う」「変える範囲は、計画に書かれたものだけにする」と、統括の計画を前提にしている。REQ-062 の受け入れ基準「統括エージェントを始めずにチャットで頼むと、そのスキルの決まりどおりに行われる」に合わない。
- 今回は（K-18）を付けただけで、設計どおり description は変えていない（description を渡さないときは今のまま）。REQ-059（直した後も出力の要件を満たす）とのすき間で、直す前の確認で description の案を示すかの判断が要る。

### F9（小）写したスクリプトの2段目の試験がない

- 2段目の `tests/stage2/task/test_req112_pseudo_kx200_tools.py` は、擬似の道具（EVAL の入力）を試す。mkkximg.py は、イメージを作る下ごしらえに使われるだけで、kx-build.sh は2段目で一度も動かない。
- クリエイターの作業役の定義（worker.agent.md 102行）は、スクリプトをコマンドとして動かし、`--help` が 0、誤った引数で 0 でない終了コードになることを試すよう求めている。REQ-111 の追跡の表は EVAL だけを結んでいる。
- ユーザーの資産を写したもので中身は正しいが、写し間違いや後の書き換えを見つけるために、2つのスクリプトの `--help` と誤った引数（例：名前の形の誤りで 2）の試験があるとよい。

### F10（小）ビルドの出力がソースの差分に入る

- K-20 の既定でビルドの出力はソースのフォルダの build になる。snapshot_and_diff.py は、ソースのフォルダ全体（.git だけ除く）を比べる。2回目の試行からは、ソースコード担当が作る差分（code-diff.patch）に、build の下の sensor.build.log や、ELF・.kximg の「Binary files … differ」が入る。画面の「変えたソースコードの差分」と、検証が K-18（DBG_LOG）を見るときの材料に余計なものが混じる。
- 直す案：snapshot_and_diff.py で build を外す、または、ビルド・デプロイ担当が `--out` に作業フォルダの中を渡す（K-20 は「頼まれた場所」を認める。ただし T-02 の C-05 はソースのフォルダの build を見ている）。

### F11（小）設計書の1文の読み違い

- `docs/design/design.md` 379行：「ビルドが失敗したとき、デプロイできない・実機が応答しない・ログが取れないときは、REQ-113 のとおり、1回 reboot してやり直し、だめなら統括が人に判断を求める（K-33）。」ビルドの失敗も reboot するように読める。K-33 では、ビルドの失敗は reboot せずにすぐ人に聞く。

### F12（情報）

- 擬似の道具 `tests/eval/T-02/inputs/bin/arm-linux-gnueabihf-gcc` と `kxtool` は、git でモード 100644（実行の権限なし）。EVAL は写した後に権限を付けるので動く。手で動かすときは python3 を前に付ける要がある。
- 共通の土台を上げたことで、IBM Plex Sans JP の woff2 2つ（約4.6MB）と OFL.txt がユーザーのリポジトリに入った。直す前の確認で「画面の文字の形が足される」と示し、ユーザーはよいと答えている。README に出どころとライセンスが書かれている。
- クリエイターの会話：英語の一言 7件（例：「No leftover `<W>`.」「Now verify `<P>` unchanged before asking approval.」）は、内部の置き場所の記号までユーザーに見せている。これからの流れの表示は5回とも出ていない。どちらもプラグインの成果物ではないので、ここでは数えない。
- ルールのスキルの compatibility と「status はアプリの終了コード」は、ユーザーに確かめていないが、change-read.md の決まり（使い方と説明は決まりの候補にしない）どおりである。

## 3. 証拠の場所

- 直したプラグイン：`<scratchpad>/runs/outer-change-5/runs/outer-edl-change-with-vYhysZ/work/market/plugins/embedded-debug-loop`
- 初めの状態：同 `change-baseline.json`（baseCommit 0b17e2d）
- クリエイターの記録：同 `copilot-home/plugin-data/plugin-creator/hearings/outer-outer-edl-change-with-vYhysZ/`（state.json、qa.jsonl）
- 会話と説明：同 `record.json` の conversation（説明は seq 602）
- 試験の写しと結果：`<scratchpad>/final-review/market-copy`、`<scratchpad>/final-review/run-out.json`
- 擬似の流れの手での確かめ：`<scratchpad>/final-review/sim-good`（正しい流れ）、`<scratchpad>/final-review/sim-broken`（K-15 の振る舞いをまねた流れ。C-14 も C-11 も合格する）
- 戻し方の確かめ：`<scratchpad>/final-review/rv`（restore と、パスを限ったコミットで戻した写し）
