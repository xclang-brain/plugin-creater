# C6a（擬似の機器・ダミーのスキル・改善の模擬ユーザー）の実装メモ

BLUEPRINT 5章の C6a・C6b・C6c と、FORMAT.md・validate.mjs・validate.test.mjs の kind change の直し。

## 変えたファイル

| ファイル | 中身 |
| --- | --- |
| `tests/dev-eval/device/kxemu.py` | 試作のまま（先頭の説明の「試作」を「開発の試験用」にしただけ） |
| `tests/dev-eval/device/bin/kxtool` | 試作のまま（同上）。実行の権限つき。フォルダには kxtool だけ |
| `tests/dev-eval/device/kxdevice.mjs` | I10 の `startDevice`。起動の失敗を早く見つける、子プロセスを残さない（process の exit で SIGKILL）、stop は 5 秒で SIGKILL |
| `tests/dev-eval/device/sample/sensor.c` | 試作のまま |
| `tests/dev-eval/device/kxdevice.test.mjs` | 口の試験 9 件＋機器の振る舞い 16 項目（試作の test_native.sh。nc の代わりに Node の net、TFTP は記録を待つ） |
| `tests/dev-eval/personas/edl-change/files/kx200-firmware/.github/skills/cross-compile/{SKILL.md, scripts/kx-build.sh}` | ダミーのスキル（C6b） |
| `tests/dev-eval/personas/edl-change/files/kx200-firmware/.github/skills/deploy/{SKILL.md, scripts/mkkximg.py}` | ダミーのスキル（C6b） |
| `tests/dev-eval/personas/edl-change/files/market/plugins/embedded-debug-loop/skills/log-insertion-rules/SKILL.md` | 題材の元のファイルに「- KX-200 では `dbg_log.h` の `DBG_LOG` でログを出し、printf を直接使わない。」を 1 行足したもの（role repo） |
| `tests/dev-eval/personas/edl-change/persona.json` | I9 の形（kind・workspace・target・device・expect） |
| `tests/dev-eval/personas/edl-change/inner/{eval.json, standalone.json}` | 確かめ A（T-01）・B（T-02） |
| `tests/dev-eval/personas/edl-change/inner/inputs/src/*` | 題材の T-01 の main.c・sensor_avg.c・sensor_avg.h・dbg_log.h（そのまま） |
| `tests/dev-eval/personas/edl-change/inner/golden/{.device/console.log, .device/history.jsonl, inputs/src/sensor_avg.c}` | 見本（直したソースと、擬似の機器を 1 回動かした記録） |
| `tests/dev-eval/personas/edl-change/inner/make_golden.mjs` | 見本の記録を作り直すスクリプト |
| `tests/dev-eval/personas/test_dummy_skills.py` | ダミーのスキルの試験（unittest。15 件） |
| `tests/dev-eval/fixtures/{make_market.sh, market.tar.gz}` | 題材（plugin-market-place の 484584c。281KB。同じコミットから毎回同じバイト列） |
| `tests/dev-eval/personas/{FORMAT.md, validate.mjs, validate.test.mjs}` | kind change（2.5 節）、role skill・repo、py・sh・c・h、inner/standalone.json、markers の確かめ、tar.gz の読み取り |

## 設計図からの違いと理由

1. **`startDevice` の返り値に読み取り専用の `ready`（pid・ポート・実際の隔離のしかた）を足した**（I10 への追加。形は変えていない）。本物の形（TFTP・TCP）の試験にポートが要り、C6d が `result.json` の `device` に隔離のしかたを残すのにも使える。`copyRecordsTo` は写した先の絶対パスを返す。ready.json は状態のフォルダの中に置く（`denyRead` で見えない）。
2. **`copyRecordsTo` の console.log は改行を `\n` にそろえる**（`records().consoleLog` と同じ）。history.jsonl はそのまま写す。CRLF のファイルを見本に置かないため。`.device` がリンクやファイルのときは消してからフォルダを作る（作業フォルダの外に書かないため）。
3. **ダミーのスキルには、設計図の表の決まりのほかの決まりを書かなかった**（失敗したら止まる、ソースを変えない、名前の長さなど）。クリエイターが 1 件ずつ確かめたときに、ユーザー役のナレッジにない決まりだと「特に決まっていません」と答えてしまい、試験がぶれるため。スクリプトの引数・終了コードは `--help` にある。
4. **例外の決まり（`-O2`）の「どんなとき」を「gdb で1行ずつ追うようなデバッグの調査のときだけ」と書いた**。embedded-debug-loop はプリントデバッグのプラグインなので、「デバッグの調査のとき」だけだと、どの作業も当てはまって見えるため。
5. **K-15 の今・ほかの決まりはこのとおり・最近の 1 回を、1 件の talk のナレッジ `k15-now` にまとめた**。FORMAT の決まりで talk のナレッジにも embedded か excluded が要り、別々に分けると同じ印を重ねて持つため。中身に「ビルドが失敗したときは、今までどおり人に伝える」を足した（元の K-15 はビルドの失敗も含むので、言わないと直した決まりから黙って落ちるため。設計図の文の外）。
6. **基準とナレッジの対応**：A の C-06（`inputs/src/dbg_log.h` が unchanged）は、頼みの制約から来る基準だが、ナレッジの id が必須なので、いちばん近い `log-dbg`（dbg_log.h の DBG_LOG でログを出す）に付けた。
7. **見本に直したソース（`golden/inputs/src/sensor_avg.c`）も置き、`make_golden.mjs` を足した**。見本の記録がその手順で作れること、A と B の基準にすべて合格することを、試験（validate.test.mjs、道具がなければ飛ばす）で毎回確かめる。記録の sha256 はツールチェーンの版で変わるので、バイトの比べ合いはしない。
8. **validate.mjs の markers の確かめを、題材だけでなく「写される資産」にも広げた**。`embedded`・`excluded`・`task` の正規表現は、題材の `target` の元の文字にも、role skill の `SKILL.md` でないファイル（kx-build.sh・mkkximg.py）の文字にも当たってはいけない。外側の EVAL は差分の足した行で見るので、資産を写しただけで embedded が合格したり、excluded が不合格になったりしないため。そのため markers は「文で書いた決まり」の形（例：`-O2`?\s*(?:で|に|を)`、`静的(?:に)?リンク`）にした。repo のファイル（書き足した決まり）は題材の初めの中身なので、確かめの対象にしない。
9. role repo のファイルは `describe`・`reveal` を要らないことにした（ユーザー役に示さないため）。`kind` に書けるのは `change` だけ（省くと作る）。
10. `dp-ip`（wrong）は `volunteer: true`（人なら、スキルのアドレスが古いことを自分から言うため）。ほかのスキルの決まりは false。

## 統括に知らせること（取り決めの点）

- **I9（C6d へ）**：ユーザー役のシステムプロンプト（`user-role.mjs` の `buildSystemPrompt`）は今 `persona.files` をすべて並べる。role `repo` のファイルは除く必要がある（FORMAT.md 5章に書いた）。`loadPersona` の返り値に `fixture`（題材の tar.gz の絶対パス。kind change のときだけ、ほかは null）を足した（追加だけ）。`validate.mjs` は `readTarGz`・`FIXTURES_DIR`・`KINDS`・`DEVICES` も出す。C6d の `outer-change.mjs` は自分で `FIXTURES_DIR` を持ち、`tar` コマンドで展開している（どちらでも同じ場所）。
- **I10（C6d へ）**：上の 1・2。`binDir` は `tests/dev-eval/device/bin`（kxtool だけ）。`sandboxNetwork` は `{ allowedDomains: ['localhost:<HTTP>'], strictAllowlist: true }`。kxtool は `HTTP_PROXY` があればそれを通して送るので、サンドボックスの外で動かすとき（`--no-sandbox` など）は、試験の仕組みが `HTTP_PROXY` などを外す必要がある（容器の agent proxy に送ってしまう）。
- **`expect.explained` の `\d+\.\d+\.\d+`**（設計図の値のまま）は、IP アドレス（192.168.7.2）にも当たる。版の説明を見るなら、`gradeChange` で `confirmation.version` の値そのものを探すほうが確か。
- **ほかの組の試験の落ち**：`tests/dev-eval/runner/creator-tools.test.mjs` の「エクステンションのツール 8 つ」が落ちる（C1 が 9 つ目の `change` を足したため）。C6d か統括で直す。私の担当の外なので触っていない。
- この容器に pytest がない。`test_dummy_skills.py` は unittest で書いてあり、`python3 tests/dev-eval/personas/test_dummy_skills.py`（と `tests/creator/run.py` の unittest の探し方）で動く。

## 試験の結果

- `node --test tests/dev-eval/device/kxdevice.test.mjs tests/dev-eval/personas/validate.test.mjs`：79 件すべて合格（飛ばしなし。qemu-arm・arm-linux-gnueabihf-gcc・bwrap・curl の tftp がある）。kxdevice.test.mjs は 3 回続けて合格（TFTP の記録を待つ直しの後）。
- `python3 tests/dev-eval/personas/test_dummy_skills.py`：15 件すべて合格（unittest の discover でも 15 件）。
- `node tests/dev-eval/personas/validate.mjs tests/dev-eval/personas/edl-change`：合格。ほかの 3 人も今までどおり。
- `python3 tests/creator/check_creator.py --json`：ok（新しいファイルで 1 段目は落ちない）。
- validate.mjs を読み込む runner の試験：125 件中 124 件合格、落ちた 1 件は上の creator-tools.test.mjs（ツールの数）。
- 全体の `tests/creator/run.py` は、ほかの組が並べて直しているので動かしていない。

## 残る点

- 新しい模擬ユーザーのユーザー役の試験（`user-role-test.mjs`、約 0.15 ドル）はしていない（実際のモデルを呼ぶため）。決まりの一覧の問い（options）は 17 件の文をすべて並べた長い問いにした。
- markers が、実際のクリエイターの書き方に当たるかは、外側の EVAL を動かすまで分からない（例：`DBG_LOG`?\s*(?:で|を使|を用|マクロ)` は「DBG_LOG(fmt, ...) を使う」には当たらない）。
- 機器の隔離（bwrap）は /usr を統合した配置でだけ確かめている（試作の調査と同じ）。

## 点検と直し

点検の指摘 10 件を、コード・仕様・設計図で確かめた。10 件とも本当の誤りだったので直した（退けたものはない）。

| # | 指摘 | 結果 | 直したこと・理由 |
| --- | --- | --- | --- |
| 1 | 確かめ B の目印の基準が、保存したログを見ていない | 直した | `inner/standalone.json` の C-04 を `logs/device.log` の `\[kxapp\] sensor exited \(status=\d+\)` にした（文も「頼まれた場所に保存した」に）。`make_golden.mjs` が `kxtool console` の出力を `golden/logs/device.log` に保存する。見本を作り直すと `.device/` は前と同じバイト列で、`logs/device.log` が増えた。機器のコンソールを見る別の基準は足していない（C-03 の実行の記録と重なるため）。FORMAT.md 3章に「保存したかは成果物で見る」と書いた。試験：ログのない見本は B の C-04 だけが落ち、A は落ちない |
| 2 | `lastTimeAsked` が「実物を受け取る」の問いにも当たる | 直した | 「1回」と、たどる言葉（思い出・順に・順を追・順番・たど・振り返・したこと・やったこと・書かれていない）が同じ文にある形にした。点検の案（`最近…1回`）では、receive.md 11行目の「作り直しでは前回の1回のファイルを聞く」に従った言い換え「前回の1回で受け取ったファイル…」に当たるため、もう一歩狭めた。試験：last-time.md の「最近」の例（2件）と言い換えは当たり、receive.md の例・screen.md の例・点検の例・「前回の1回で受け取ったファイル…」は当たらない（例は references から読む） |
| 3 | `dp-steps` の embedded が単語 3 つで、ほかのナレッジの文に当たる | 直した | `dp-steps` を決まりの形 `reboot … するまで／してから／した後 … 有効／kxapp run`（と「有効にする … reboot」）にした。「再起動」は題材の SKILL.md（Copilot CLI の再起動）に当たるので入れていない。`dp-marker` も `[kxapp] … exited … まで／出たら／が出る` か「目印 … [kxapp] … exited」にした。validate.mjs に「markers（embedded・excluded・task）が、ほかのナレッジの fact・detail に当たると誤り」を足した（kind change のときだけ。作る模擬ユーザーの training-survey に、単語の marker がほかの fact に当たるものが元からあり、私の担当の外のため）。試験：コマンドだけの行（試験のコードの形）には当たらず、ユーザーのスキルの文には当たる。単語に戻すと誤りになる |
| 4 | `explained` の版の正規表現が IP アドレスに当たる | 直した | `(?<![\d.])\d+\.\d+\.\d+(?!\.?\d)` にした（設計図の値からの直し）。試験：`0.2.0` に当たり、`192.168.7.2`・`192.168.7.20` に当たらない |
| 5 | `screenAsked` が狭く、ないことを見る観点が誤って合格する | 直した | `画面(で|に) … (決め|設定し|見|出し|表示し|確かめ|確認し|足し|入れ)(たい|ますか) … (？|教えて|書いて|挙げて|選んで)` にした。点検の案は「画面で確認したいこと」に当たらなかったので「確認し」を足した。問いの形までを見るので、「画面に出したいものは、今のまま変えません。」のような説明には当たらない。試験：screen.md の3つの例と言い換え3つは当たり、receive.md・last-time.md の例と画面を変えない説明には当たらない |
| 6 | `dp-ip` の excluded が、正しい書き方を誤って拾う | 直した | 後ろの打ち消しに `使わ`・`旧`・`は間違`・`（古｜旧｜前`、前に `古い｜旧｜前の｜誤った｜間違った`（10文字まで）を足した。試験：「既定の 192.168.7.20 を使う」は拾い、「192.168.7.20 は使わない」「旧アドレス 192.168.7.20（古い）」などは拾わない |
| 7 | ダミーのスキルの `--help` のコマンドが相対パス | 直した | `bash <このフォルダ>/scripts/kx-build.sh --help`、`python3 <このフォルダ>/scripts/mkkximg.py --help` にした。test_dummy_skills.py に「スクリプトを動かすコマンドは、どれも `<このフォルダ>/scripts/` で始まる」を足した（元に戻すと落ちることを確かめた） |
| 8 | `k15-now` の fact が設計図の外で、しかも「実機が応答しない」がない | 直した（統括の承認待ち） | 元の K-15 の「実機が応答しない・ログが取れない」は1つにまとめて書かれているので、「実機が応答しない」を reboot してやり直す側に入れた（reveal・asked も）。「ビルドが失敗したときは今までどおり人に伝える」は残した。どちらも設計図の C6c の文の外なので、統括の承認が要る。試験：元の K-15 の4つの場合（ビルドの失敗・デプロイできない・実機が応答しない・ログが取れない）が、すべて fact にある |
| 9 | FORMAT.md の「4つの種類を1つ以上ずつ」を validate.mjs が見ていない | 直した | `validateChange` で、role skill のファイルから読み取るナレッジに rule・exception・incidental・wrong がそろうかを見る。試験：`dp-ip` を消すと「kind が wrong のものがない」で不合格 |
| 10 | `isolate: 'auto'` が、bwrap が動くかを見ていない | 直した | kxemu.py の `Device` で、auto のとき、アプリを動かすときと同じ置き方の bwrap で `qemu-arm --version`（なければ `/usr/bin/true`）を1回動かし、失敗したら none にする。理由は ready.json の `isolate_note`（`startDevice` の `ready` にも出る）。bwrap の置き方は `bwrap_prefix` にまとめ、実行と確かめで同じものを使う。点検の案（startDevice で確かめる）でなく kxemu.py に置いたのは、`kxemu.py serve --isolate auto` を直接使うときも同じにするため。/usr を統合していない配置で qemu-arm が動かないときも none になる。ARM の試験は飛ばさず、none で動かす。試験：失敗する偽の bwrap を PATH の先頭に置くと none と理由が残る。偽の bwrap を PATH に置いたまま全体（87件）を動かしても合格 |

### 変えたファイル（点検の直し）

- `tests/dev-eval/personas/edl-change/inner/standalone.json`、`inner/make_golden.mjs`、`inner/golden/logs/device.log`（新）
- `tests/dev-eval/personas/edl-change/persona.json`（screenAsked・lastTimeAsked・explained・dp-steps・dp-marker・dp-ip・k15-now）
- `tests/dev-eval/personas/edl-change/files/kx200-firmware/.github/skills/{cross-compile,deploy}/SKILL.md`（`--help` の行だけ）
- `tests/dev-eval/personas/validate.mjs`（ほかのナレッジの文に当たる markers、4つの種類）、`validate.test.mjs`（7件足した・2件直した）、`FORMAT.md`（2.5・3章・6章）
- `tests/dev-eval/personas/test_dummy_skills.py`（1件足した）
- `tests/dev-eval/device/kxemu.py`（auto の確かめ、`bwrap_prefix`、ready の `isolate_note`）、`kxdevice.mjs`（説明だけ）、`kxdevice.test.mjs`（1件足した・1件直した）

### 統括に知らせること（点検の直しから）

- **k15-now（8）**：「ビルドが失敗したときは今までどおり人に伝える」と「実機が応答しないときも reboot してやり直す」は、設計図の C6c の文の外。承認がなければ、どちらを外すかを指示してほしい。
- **explained（4）**：設計図の値 `\d+\.\d+\.\d+` を直した。C6d の `gradeChange` が `confirmation.version` の値そのものを探すようにすれば、さらに確か（私の担当の外）。
- **embedded の形（3）**：`dp-steps`・`dp-marker` は決まりの形の日本語でないと当たらない。生成プラグインが手順をコマンドの並びだけで書くと、外側の EVAL で `embedded:dp-steps`・`embedded:dp-marker` が落ちる（D36 で必須）。落ちたときは、7.4 の分け方で模擬ユーザーの誤りか、クリエイターの誤りかを見る。
- **I10 への追加**：`ready` に `isolate_note`（文字か null）が増えた。C6d が `result.json` の `device` に残すなら使える。形の変更ではない。
- 作る模擬ユーザー training-survey に、`embedded` の単語がほかのナレッジの fact に当たるもの（`anonymize` の「氏名」が `output` の fact に当たる）が元からある。新しい確かめは kind change だけにしたので、今は誤りにならない。

### 試験の結果（点検の直しの後）

- `node --test tests/dev-eval/device/kxdevice.test.mjs tests/dev-eval/personas/validate.test.mjs`：87 件すべて合格（飛ばしなし）。偽の（動かない）bwrap を PATH の先頭に置いても 87 件合格。
- `python3 tests/dev-eval/personas/test_dummy_skills.py`：16 件すべて合格。
- `node tests/dev-eval/personas/validate.mjs`：edl-change・weekly-report・meeting-minutes・training-survey すべて合格。
- `make_golden.mjs` で見本を作り直すと、`.device/` は置いてあるものと同じ、`logs/device.log` も同じ。
- validate.mjs・kxdevice.mjs・edl-change を使う runner の試験（12 ファイル）：165 件すべて合格。
- `python3 tests/creator/check_creator.py --json`：ok。

## 統合の直し

統括の指示 3 件（FORMAT.md の例外、k15-now、機器の手順と目印の markers）を、`tests/dev-eval/personas/` の中だけで直した。

| # | 指示 | 結果 | 直したこと・理由 |
| --- | --- | --- | --- |
| 1 | FORMAT.md 2.5 に、直すプラグインに元からある決まりは直した後のファイルで見る、という例外を書く | 直した | 「外側の EVAL は…足した行で見る」の後に、`role` が `repo` のファイルから読み取るナレッジは直した後のファイルで見る（足した行だけだと、そのまま残したときに落ちる）と書いた。`outer-grade-change.mjs` の `finalScope`（`inRepoFile`）と同じ。このナレッジの `markers` は `repo` のファイルの文字に当たってよく、`validate.mjs` は題材の tar.gz と比べるので `repo` のファイルで足した文字とは比べない、とも書いた |
| 2 | k15-now の fact の足し（ビルドの失敗は今までどおり人に伝える、実機が応答しないときも1回 reboot してやり直す） | そのまま残した | 統括が承認した。persona.json は変えていない |
| 3 | `dp-steps`・`dp-marker` の `embedded` が日本語の文の形にしか当たらない | 直した | 下に書く |

### 3. 機器の手順と目印の markers

`embedded` の並びはすべてに当たることを求める（`matchesAll`）ので、項目を分けず、1 つの正規表現に選択肢（`|`）を足した。前からの文の形の選択肢は、そのまま残した。

- 行の頭（コマンドの位置）：改行の後の、字下げ・`>`・`|`、箇条書きの印か番号（その後に 20 文字までの前置きとバッククォート）、または 20 文字までの見出しとコロン（`：`・`:`）か表の区切り（`|`）、`$ `、`-c "`、バッククォート。プロンプト（`kx200# `）、文字列や配列の中（`run('reboot')`、`'-c', 'reboot'`）、JSON の値は、行の頭にならない。
- `dp-steps`：(a) 行の頭の `kxinstall <場所>` → 8 行まで → 行の頭の `reboot` → 8 行まで → 行の頭の `kxapp run`（箇条書き・コードブロック・表・見出しつき・`-c` を行を続けて書いたもの）、(b) 行の頭の `kxtool … -c "kxinstall …" … -c reboot … -c "kxapp run`（ユーザーのスキルのコードブロックの 1 行）。順の決まり（reboot が kxinstall と kxapp run の間）が、この決まりの中身なので、順を見る。
- `dp-marker`：行の頭の `kxapp run`（`kxtool … -c "kxapp run` を含む）→ 8 行まで → 行の頭の `[kxapp] <名前> exited (status=`。
- 当たらないもの：題材の文字（kxinstall・kxapp・[kxapp] がない。「再起動して、有効になる」は Copilot CLI の話なので、日本語の「再起動」は前と同じく入れていない）、資産（kx-build.sh・mkkximg.py）、ほかのナレッジの fact と detail（`validate.mjs` で確かめた。dp-steps の fact は 1 行の文、dp-image の fact に reboot がなく、dp-marker・k15-now の fact に kxinstall がない）、たまたまと違う決まりだけの並び（git pull、uname -a、192.168.7.20 への send）、reboot のない並び、reboot が後・先の並び、離れすぎた並び、機器の記録とログ（`golden/.device/history.jsonl`・`console.log`・`logs/device.log`）、試験のコード。

前の点検の直し（#3）の試験で「コマンドだけの行」として当たらないことにしていた、行の頭の `kxtool -d … console -c "kxinstall …" -c reboot -c "kxapp run …"` の 1 行は、当たる側に移した。ユーザーのスキルのコードブロックにある書き方そのもので、生成プラグインのルールのスキルがこの 1 行だけを写すことがあるため。試験のコードに出る形（文字列・配列・テンプレートリテラルの中）は、前と同じく当たらない。

退けたこと：

- 行の頭でない、文の中のコマンド（「ボードを `reboot` する」のような前置きが 20 文字を超えるもの、プロンプトの後のもの）までは広げなかった。機器のログ（`kx200# reboot`）や試験のコードと見分けられなくなるため。
- 文字列や配列の中のコマンドの並び（例：`run('kxinstall …')` が 3 行続くもの）は、試験のコードの形なので当てない。逆に、行の頭にコマンドを並べたスクリプト（`.sh` など）を `tests/eval/<課題>/inputs/` の外に足したときは当たる。手順をその順で動かすスクリプトは、手順を組み込んだものとみなした。

### 変えたファイル（統合の直し）

- `tests/dev-eval/personas/FORMAT.md`（2.5 の 2 か所：repo のファイルの例外と、手順の決まりのコマンドの並びの形）
- `tests/dev-eval/personas/edl-change/persona.json`（`dp-steps`・`dp-marker` の `markers.embedded` だけ）
- `tests/dev-eval/personas/validate.test.mjs`（「コマンドだけの行には当たらない」の 1 件を、「文の形とコマンドの並びの形に当たる」「試験のコード・記録とログ・たまたまと違う決まりの並び・順の違う並びに当たらない」の 2 件にした）
- `validate.mjs` は変えていない

### 試験の結果（統合の直しの後）

- `node --test tests/dev-eval/personas/validate.test.mjs`：62 件すべて合格（飛ばしなし。ARM の見本の試験も動いた）。
- 新しい当たる側の試験は、前の markers（HEAD の persona.json）では落ちる（番号つきの箇条書きとコンソールの 1 行で、dp-steps・dp-marker とも当たらない）ことを確かめた。
- `node tests/dev-eval/personas/validate.mjs` を edl-change・weekly-report・meeting-minutes・training-survey に：すべて合格。weekly-report・meeting-minutes は `--all-styles` でも合格。
- `python3 tests/dev-eval/personas/test_dummy_skills.py`：16 件すべて合格。
- runner の試験は動かしていない（担当の外。`outer-grade-change.test.mjs`・`outer-change.test.mjs` は dp-steps・dp-marker を使っていないことを grep で確かめた）。
