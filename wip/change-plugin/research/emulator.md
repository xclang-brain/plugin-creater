# 調査：擬似の機器（エミュレーター）の設計と試作（2026-10-26）

改善・設計変更（change-plugin）の試験で、embedded-debug-loop のデプロイを試すための、架空の ARM ボードの擬似の機器を設計し、試作した。リポジトリのファイルは変えていない。試作はスクラッチパッドの `research-scratch/emulator/` にある（8章）。

調べた範囲：仕様 `docs/specs/improvement-requirements.md`（REQ-055、REQ-061）と `docs/specs/output-requirements.md`（REQ-062）、`tests/dev-eval/runner/isolation.mjs`・`inner.mjs`・`inner-run.mjs`、`skills/test-plugin/scripts/permissions.mjs`・`grade.mjs`、embedded-debug-loop のルールのスキルと EVAL T-01、Claude Code の公式の説明（Sandboxing）、Agent SDK 0.3.310 の型（`sdk.d.ts`）、並行の調査 `research/dev-eval.md` 3章。

---

## 0. 要点

1. **サンドボックスの中のコマンドから、外で動く機器に届く道は「サンドボックスのプロキシを通る TCP」だけ**（公式の説明と実測が一致）。
   - UDP（TFTP）は届かない。`curl -T … tftp://127.0.0.1:<ポート>/` は時間切れ（curl の終了コード 28）。プロキシを明示しても「TFTP cannot be done over CONNECT」。
   - `127.0.0.1` への直接の TCP は届かない（`nc` も `curl` も Connection refused）。
   - プロキシを明示した HTTP と、プロキシの CONNECT で張った生の TCP（シリアルコンソール）は届く。ただし `sandbox.network.allowedDomains` に `localhost`（または `localhost:<ポート>`）が要る。
   - **`allowedDomains: ['localhost:<ポート>']` と `strictAllowlist: true` にすると、その1つのポートだけに届き、ほかの localhost のポートは「host is not on the allow list」で断られる。許可の求め（`canUseTool` の `SandboxNetworkAccess`）も起きない**（実測）。並行の調査（dev-eval.md 3.3）の `allowedDomains: ['localhost']` より狭く開けられる。
   - `filesystem.denyRead`・`denyWrite` に機器の中身のフォルダを入れると、サンドボックスの中から見えず、書けない（実測）。
2. **推奨の形**：擬似の機器 `kxemu`（Python の標準ライブラリだけ、1ファイル）を試験の仕組みが外で動かし、機器への操作は「メーカーの道具」役の `kxtool`（PATH の先頭に置く）で行う。
   - `kxtool` は、試験のときは機器の HTTP の口（1ポート）へ、サンドボックスのプロキシを明示して送る。本物の形（TFTP と TCP のコンソール）も持つので、サンドボックスの外では `curl -T tftp://` と `nc` でも同じ機器を操作できる。
   - ダミーのデプロイのスキル（ユーザーの既存のスキル）は、`kxtool` を使う手順と、イメージの見出しを付けるスクリプト（ユーザーの資産）を持つ形にする。エージェントは擬似の機器を意識しない。
3. **機器の癖**（ルールを読まないと通らないもの。どれも機器の記録で機械的に採点できる）：
   - イメージの見出し（magic `KX2I`、版、長さ、CRC32、名前）。ないと `bad magic`、CRC が違うと `CRC mismatch`。
   - 動的リンクの実行ファイルは動かない（機器にローダーがない）。`-sh: /opt/app/sensor: not found`。静的リンク（`-static`）が要る。
   - インストールは再起動するまで有効にならない（`kxapp: sensor: not installed (pending: reboot to activate)`）。
   - アプリの出力の後に、取り終わりの目印 `[kxapp] sensor exited (status=0)` が出る。
4. **試作は動いた**：
   - サンドボックスの外の通し試験 `test_native.sh` は 16 項目すべて合格、4.4 秒（クロスコンパイル → イメージ → `curl -T tftp://` → `nc` でインストール・再起動・実行 → `AVG=25` と目印、`kxtool` の TFTP・TCP・HTTP、記録、同じ手順を2回やると記録が同じ）。
   - 本物の Claude Code（Agent SDK 0.3.310 同梱）のサンドボックスの中で、ビルドからログまで通しで動き、`AVG=25` が出た（偽の API を使い、実際のモデルは呼んでいない）。
   - アプリは機器の側でも bubblewrap の中で動かす。エージェントが作った ARM のプログラムが、ホストのファイル（`/etc/passwd`）を読めず、機器の `/tmp` のほかに書けないことを確かめた。
5. **決まった動き**：時刻・乱数を使わない（稼働時間は出来事ごとに決まった量だけ進む疑似の時計）。同じ手順を2回やると、コンソールの記録と出来事の記録のハッシュが一致した。
6. **気をつけること**：エージェントは機器を使わずに、その場で `qemu-arm ./sensor.elf` を動かせる（実測で `AVG=25`）。採点は、作業フォルダの成果物ではなく、機器の側の記録（試験の仕組みが作業フォルダに写す）で行う。

---

## 1. 前提

### 1.1 仕様が求めること

- REQ-061（`docs/specs/improvement-requirements.md:178`）：「変えたところが本物の機器や外部のシステムに頼るとき（例：本物のツールチェーンでのビルド、機器への転送）は、手元のパソコンの中の擬似の機器で試す課題にする。」受け入れ基準（`:186`）：「本物の機器に頼る変更では、EVAL で本物の機器に何も送られない。」
- REQ-055（`:69` 以降）：ユーザーの既存のスキル（例：クロスコンパイルやデプロイ）を読み、ルールのスキルに書き直して取り込む。「スキルに付いたスクリプトなどのファイルは、ユーザーの資産（REQ-018）として流用する。」
- REQ-062（`docs/specs/output-requirements.md:261-271`）：「スキルは、そのスキルのフォルダの中のファイル（手順、スクリプト、参考の文書）だけで仕事を終えられる。」「スクリプトは、引数と標準出力と終了コードで使え、コマンドラインから単体で動かせる。」
  - → イメージの見出しを付けるスクリプトは、デプロイのルールのスキルのフォルダに入る。`kxtool` はツールチェーンと同じく「PC に入っている道具」で、スキルの外にあってよい（ほかのスキルに頼るわけではない）。

### 1.2 題材の今の状態

- `skills/deploy-rules/SKILL.md:12-17`（転送の方法・転送先・転送後の操作・確かめ方）と `:21-26`（接続とログイン、実行コマンド、取り終わりの目印、確かめ方）は空欄。`skills/cross-compile-rules/SKILL.md:10-15` も空欄。
- 今の EVAL T-01 の「擬似の実機」は、フォルダへのコピーと、ホストの gcc で作った x86 の実行ファイルを動かすだけ（`tests/eval/T-01/inputs/device.md`、`inputs/rules/build.md`、`inputs/src/Makefile.target` の `CC = gcc`）。ルールは `inputs/rules/*.md` で頼みの文から渡し（`eval.json:3`）、ルールのスキルを通らない。
- ビルド・デプロイ担当は `device_ip` などの設定を読み（`worker-b.agent.md:41`）、ログを `<作業フォルダ>/logs/device-latest.log` に保存する（`:44`）。

### 1.3 試験の仕組みのサンドボックス

- 内側の EVAL はサンドボックスが既定で有効（`tests/dev-eval/runner/inner.mjs:99` の `sandbox = true`、`:103-106` で道具がなければ断る）。
- サンドボックスの設定は `{ enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false }` だけで、`network` も `filesystem` もない（`isolation.mjs:57-60`）。
- `canUseTool` は、質問と作業フォルダの外への書き込みのほかは許可する（`isolation.mjs:95-111`、`:109`）。サンドボックスの外への通信の求め（`SandboxNetworkAccess`）もここで許可される（dev-eval.md 3.1）。
- 環境変数は `ENV_ALLOW` と `envExtra` だけ。`envExtra` は最後に重ねるので `PATH` を上書きできる（`isolation.mjs:14-28`）。
- 生成プラグインの EVAL（ユーザーの環境。test-plugin）は Copilot SDK のセッションで動き、OS のサンドボックスは使わない。シェルのコマンドは許可する（`skills/test-plugin/scripts/permissions.mjs:1-12`）。この場合は、localhost の TCP・UDP にそのまま届く。

---

## 2. サンドボックスの中から、何に届くか

### 2.1 公式の説明

Claude Code「Sandboxing」（https://code.claude.com/docs/en/sandboxing）：

- 「**Linux and WSL2**: a sandboxed command's `localhost` is private to that command. The command can listen on a port and reach servers it started itself. A direct connection to `localhost` or `127.0.0.1` doesn't reach servers on the host, and `allowLocalBinding` has no effect. Run the command that needs the host's server outside the sandbox with `excludedCommands` … For connections that go through the sandbox proxy, see Hostnames that resolve to local addresses」
- 「Claude Code runs the sandbox proxy on your machine, outside the sandbox, and directs commands to it with `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and related environment variables.」
- 「Anything that isn't TCP: UDP, HTTP/3 over QUIC, and ICMP tools such as `ping` can't leave the sandbox.」
- 「After a hostname passes the allowlist, the sandbox proxy resolves it and refuses the connection when the name resolves only to local addresses. … The names `localhost` and `*.localhost` are allowed to resolve to loopback.」「To let a name resolve to a refused address, add that IP address to `allowedDomains`, such as `"127.0.0.1:8080"`.」（ホスト名にポートを付けた書き方ができる）
- 「An `allowedDomains` entry for `localhost` applies to connections that go through the proxy … Claude Code sets `NO_PROXY` for sandboxed commands so that they connect to `localhost` directly instead of through the proxy. The entry also exposes every port on your machine's localhost to a command that does use the proxy.」

Agent SDK 0.3.310 の型（`sdk.d.ts`）：

- `allowedDomains`（8987 行）：「Domains sandboxed commands may reach without a prompt (wildcards such as *.example.com supported).」
- `strictAllowlist`（8995 行）：「When true, the sandbox runtime deterministically denies hosts not in allowedDomains instead of prompting. Enforced for sandboxed commands only」
- `denyWrite`（9040 行）・`denyRead`（9044 行）。`excludedCommands`（9193 行）は「A convenience, not a security boundary」（dev-eval.md 3.2）。ナレッジ agent-sdk-eval.md によれば、1回の呼び出しのすべてのコマンドが一致したときだけ効くので、エージェントが組み立てるコマンドには向かない。

### 2.2 実測のやり方

- 偽の Anthropic API（`tests/dev-eval/runner/fake-anthropic.mjs`、`guardSdk`）につないだ本物の Claude Code（Agent SDK 0.3.310 同梱の 2.1.310）で、`isolation.mjs` の `makeQueryOptions({ sandbox: true })` をそのまま使い、偽の API が返す Bash の呼び出しで `probe.sh` を動かした。実際のモデルは呼んでいない。
- 擬似の機器 `kxemu` は試験の仕組み（Node）が外で起動した（`kxdevice.mjs`）。機器の中身は作業フォルダの外。
- `canUseTool` は、届いた求めをすべて断って記録するものに差し替えた（推奨の決め。dev-eval.md 3.3）。
- `CLAUDE_CODE_TMPDIR` を実行のフォルダの下に変えた。スクラッチパッド（`/tmp/claude-0/…`）は、このセッションの Claude Code の一時フォルダで、サンドボックスの中から書けてしまうため（dev-eval.md 3.1 の注意と同じ）。ただし、これでも `/tmp/claude-0/…` の下は書けたので（下の表の10番、設定 A・B）、作業フォルダの外への書き込みの結果は、dev-eval.md 3.1 の実測（`/tmp/plugin-creator-dev-eval` の下では `Read-only file system`）を正とする。
- 動かしたもの：`node probe-sandbox-emu.mjs default|localhost|port`（8章）。

設定：

| 記号 | `sandbox.network` | `sandbox.filesystem` |
| --- | --- | --- |
| A | なし（今の `isolation.mjs` のまま） | なし |
| B | `allowedDomains: ['localhost']` | なし |
| C | `allowedDomains: ['localhost:<機器の HTTP のポート>']`、`strictAllowlist: true` | `denyRead`・`denyWrite` に機器の中身のフォルダ |

### 2.3 結果

| # | サンドボックスの中のコマンド | A | B | C |
| --- | --- | --- | --- | --- |
| 1 | `curl -sS -m 5 -T sensor.kximg tftp://127.0.0.1:<TFTP>/a.kximg`（UDP、直接） | 届かない（curl 28、時間切れ） | 同じ | 同じ |
| 2 | `curl --noproxy "" -x "$HTTP_PROXY" -T … tftp://localhost:<TFTP>/`（UDP にプロキシ） | `curl: (1) TFTP cannot be done over CONNECT` | 同じ | 同じ |
| 3 | `printf … \| nc -N -w 3 127.0.0.1 <コンソール>`（TCP、直接） | 届かない（nc 1） | 同じ | 同じ |
| 4 | プロキシに `CONNECT localhost:<コンソール>` して生の TCP（`connect.py`） | `403 user denied`（`canUseTool` に `SandboxNetworkAccess {"host":"localhost"}` が来て断った） | `200 Connection Established`、コンソールが動いた（`via-connect`、`logout`） | `403 host is not on the allow list`（`canUseTool` は呼ばれない） |
| 5 | プロキシに `CONNECT localhost:<HTTP>` | 403 user denied | 200、`GET /` の応答が返った | 200、同じ |
| 6 | `kxtool send` → `kxtool console -c "kxinstall …" -c reboot -c "kxapp run sensor"`（`KXEMU_GATEWAY`、プロキシを明示） | `kxtool: send failed: Connection blocked by network allowlist` | `AVG=25`、`[kxapp] sensor exited (status=0)` | 同じ（C ではビルドとイメージ作りもサンドボックスの中でした） |
| 7 | `curl -sS http://localhost:<HTTP>/`（プロキシを明示しない） | `curl: (7) … Couldn't connect to server`（`NO_PROXY` で直接に行く） | 同じ | 同じ |
| 8 | `echo fifo-ok > ../outside/console.in`（作業フォルダの外の FIFO） | 外の読み手に `fifo-ok` が届いた | 同じ | 同じ |
| 9 | 機器の中身（`history.jsonl`）を読む | 読める | 読める | `No such file or directory`（見えない） |
| 10 | 機器の中身（`console.log`）に書き足す | 書けた（※2.2 の注意。`/tmp/claude-0` の下のため） | 書けた（同じ） | 書けない（中身は変わらなかった） |
| 11 | `qemu-arm ./sensor.elf`（機器を使わず、その場で動かす） | `AVG=25` | 同じ | 同じ |
| 12 | 環境 | `HTTP_PROXY=http://***@localhost:3128`、`NO_PROXY=localhost,127.0.0.1,::1,169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16` | 同じ | 同じ |

- `canUseTool` に来た求め：A は `SandboxNetworkAccess {"host":"localhost"}` が3回。B と C は0回。
- C の機器の記録（`history.jsonl` の要約）：`boot` → `recv/http@192.168.7.2:app.kximg:true` → `cmd/console-http@192.168.7.2:kxinstall /tmp/app.kximg` → `install:sensor:true` → `cmd/console-http@192.168.7.2:reboot` → `boot` → `cmd/console-http@192.168.7.2:kxapp run sensor` → `run:sensor:true`。

### 2.4 分かったこと

- 本物の組み込みの道具の形（TFTP、telnet・nc でのシリアル）は、サンドボックスの中からはそのままでは使えない。プロキシを明示し、HTTP か CONNECT を話す道具が要る。
- `NO_PROXY` に `localhost`・`127.0.0.1`・`192.168.0.0/16` などが入る（12番）。`*.localhost` も curl と Python の `NO_PROXY` の判定では後ろ一致で外れる。よって、普通の道具はプロキシを使わずに直接つなぎに行き、届かない。**機器への道具がプロキシを明示する必要がある**。これを試験の仕組み側の `kxtool` に閉じ込めれば、エージェントもスキルも意識しなくてよい。
- 開ける範囲は、C（ポートを付けて1つだけ、`strictAllowlist`）が最も狭い。許可の求めも起きないので、裏で動くサブエージェントの許可の求めが失敗するおそれもない。外への通信がほかに無いことを、設定で保証できる（REQ-061「本物の機器に何も送られない」）。
- FIFO（名前付きパイプ）は、読み取り専用で重ねたフォルダの中でも書ける（Linux の仕様。読み取り専用の確かめは通常のファイル・フォルダ・リンクだけに効く）。ネットワークの設定を変えられないときの代わりの道になるが、片方向で扱いにくく、採らない（3.6）。

---

## 3. 推奨の形

### 3.1 全体

```
試験の仕組み（Node、サンドボックスの外）
  ├─ kxdevice.mjs：startDevice / stop / reset / records
  │     └─ python3 -I kxemu.py serve --state <実行のフォルダ>/device   （127.0.0.1、空いたポート）
  │           ├─ HTTP の口（試験の形）：PUT /files/<名前>、POST /console、GET /console.log?from=N、GET /
  │           ├─ シリアルコンソール（TCP、行単位、プロンプト "kx200# "）
  │           ├─ TFTP（UDP、書き込みだけ）
  │           └─ アプリの実行：bwrap（機器の rootfs だけを見せる）＋ qemu-arm（-L なし）
  └─ 試されるエージェント（Claude Code、サンドボックスの中）
        PATH=<kxtool のフォルダ>:…、KXEMU_GATEWAY=http://localhost:<HTTP>、KXEMU_ADDRS=192.168.7.2
        sandbox.network = { allowedDomains: ['localhost:<HTTP>'], strictAllowlist: true }
        sandbox.filesystem = { denyRead: [<機器の中身>], denyWrite: [<機器の中身>] }
        作業：arm-linux-gnueabihf-gcc -static … → python3 <デプロイのスキル>/scripts/mkkximg.py …
              → kxtool -d <device_ip> send app.kximg → kxtool -d <device_ip> console -c "kxinstall /tmp/app.kximg" -c reboot -c "kxapp run sensor"
```

### 3.2 機器 `kxemu.py`

**起動**

```
python3 -I kxemu.py init  --state DIR                      # 工場出荷の状態にする（前の中身は消す）
python3 -I kxemu.py serve --state DIR [--bind 127.0.0.1] [--console-port 0] [--tftp-port 0] [--http-port 0]
                          [--ready-file FILE] [--isolate auto|bwrap|none] [--app-timeout 10]
```

- 起動できたら、`--ready-file` に `{"pid","state","bind","console_port","tftp_port","http_port","isolate"}` を書き（書いてから名前を替えるので、半端に読まれない）、標準出力にも同じ JSON を出す。
- SIGTERM・SIGINT で止まる（記録に `poweroff`）。
- 標準ライブラリだけ。Python 3.13.17 で確かめた。

**機器の中身（状態のフォルダ）**

| 場所 | 中身 |
| --- | --- |
| `rootfs/etc/kx-release` | `KX-200 Linux 1.4.2 (kx200-bsp 2019.07)` |
| `rootfs/opt/app/` | 有効なアプリ |
| `rootfs/opt/pending/` | インストールしたが、まだ再起動していないアプリ |
| `rootfs/var/log/messages` | 機器のログ（`logread` で見る。起動ごとに空になる） |
| `rootfs/tmp/` | 受け取ったファイル（起動ごとに空になる） |
| `console.log` | コンソールに出た文字のすべて（打った行のエコー、起動の表示を含む）。採点の元 |
| `history.jsonl` | 出来事の記録（`seq`、疑似の稼働時間 `up`、`ev`＝`boot`・`recv`・`cmd`・`install`・`run`・`poweroff`、経路 `via`、使ったアドレス `addr`、結果） |

**コンソールのコマンド**（busybox の見え方に寄せた）

| コマンド | 動き |
| --- | --- |
| `help`、`uname -a`、`echo`、`ls`、`cat`、`rm /tmp/…` | 機器の `/etc`・`/opt/app`・`/var/log`・`/tmp` だけを見せる。`/tmp` の外の `rm` は `Read-only file system` |
| `kxinstall /tmp/<イメージ>` | 見出しを確かめ、`opt/pending/<名前>` に置く。`kxinstall: staged sensor; it becomes active after reboot` |
| `kxapp list` | `sensor  active`／`sensor  pending (reboot to activate)` |
| `kxapp run <名前>` | 有効なアプリを動かし、出力の後に `[kxapp] <名前> exited (status=N)` を出す（取り終わりの目印）。時間切れは `[kxapp] <名前> killed (timeout 10s)` |
| `logread` | `/var/log/messages` を出す（アプリの出力も `sensor: AVG=25` の形で入る） |
| `reboot` | 起動の表示を出し直す。`/tmp` と `messages` を空にし、`opt/pending` を `opt/app` に移す（`kxapp: activated sensor`） |
| `exit`、`logout` | TCP なら切る |
| そのほか | `-sh: <コマンド>: not found` |

**イメージの形（`.kximg`）**：見出し 32 バイト（リトルエンディアン、`struct '<4sIII16s'`）＝ magic `KX2I`、版 `1`、本体の長さ、本体の CRC32（`zlib.crc32`）、名前（15 バイトまで、NUL 埋め）。続けて本体（ARM の ELF）。

| 状況 | コンソールの表示 |
| --- | --- |
| 見出しがない | `kxinstall: /tmp/sensor.elf: bad magic (not a KX2I image)` |
| 本体が壊れた | `kxinstall: /tmp/broken.kximg: CRC mismatch (header 0x86787a7a, actual 0x9226e13b)` |
| 長さが違う・版が違う・名前が不正 | `size mismatch …`、`unsupported header version …`、`bad app name …` |
| 正しい | `kxinstall: verified /tmp/sensor.kximg (KX2I v1, 423788 bytes, crc32=0x86787a7a)` |

**ARM の実行**

- ELF の見出しを読んで分ける：32 ビット・リトルエンディアン・`e_machine == 40`（ARM）で、`PT_INTERP` がなければ静的リンク。
  - 動的リンク：動かさず `-sh: /opt/app/sensor: not found`（本物の機器でローダーがないときと同じ見え方）、`[kxapp] sensor exited (status=127)`。
  - ARM でない・ELF でない：`cannot execute binary file: Exec format error`。
- 静的リンクは `qemu-arm` で動かす。`-L` は付けない。
- **隔離（`--isolate auto` で bwrap があれば使う）**：`bwrap --unshare-all --die-with-parent --new-session --clearenv --ro-bind /usr /usr --symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/bin /bin --proc /proc --dev /dev --ro-bind <rootfs>/etc /etc --ro-bind <rootfs>/opt/app /opt/app --bind <rootfs>/var/log /var/log --bind <rootfs>/tmp /tmp --chdir /tmp qemu-arm /opt/app/<名前>`。
  - 機器はエージェントのサンドボックスの外で動くので、エージェントが作った ARM のプログラムを、そのままホストで動かすと、サンドボックスを抜けられてしまう。そのため機器の側でも隔離する。
  - 確かめたこと（4.3）：ホストの `/etc/passwd` は見えない、機器の `/tmp` には書ける、`/usr` には書けない、ネットワークはない。
  - `/lib` などを `usr/…` へのリンクにしているのは、この容器が /usr を統合した配置（`/lib -> usr/lib`）のため。統合していない配置では、この束ね方を直す必要がある（確かめていない）。
- 環境変数は `PATH=/bin:/usr/bin HOME=/root TZ=UTC LANG=C` だけ。出力は 64KiB まで。時間の上限は既定 10 秒。
- qemu-user は、機器のプログラムがシグナルで落ちると `qemu: uncaught target signal 11 (Segmentation fault) - core dumped` を出して自分も同じシグナルで終わる。機器のシェルの見え方（`Segmentation fault`、終了コード `128+11=139`）に直した。
- **qemu-arm は、実行の権限がないファイルだと、何も出さずに終了コード 1 で終わる**（実測）。インストールのときに 0755 にしている。

**決まった動き**

- 時刻と乱数を使わない。稼働時間は疑似の時計で、起動で 0 に戻り、出来事ごとに決まった量だけ進む（コマンド 0.02 秒、受け取り 0.05 秒、インストール 0.2 秒、実行 0.3 秒など）。
- 機器の操作は1つの錠で順に行う（同時に来ても順序が混ざらない）。コンソールは TCP と HTTP で1つを分け合い、使用中なら TCP は `kxemu: console busy …`、HTTP は 30 秒待ってから 409。
- 同じ手順を2回やると、`console.log` と `history.jsonl` のハッシュが一致した（4.2 の16番）。記録には、受け取ったファイルとアプリの出力の SHA-256 が入るので、エージェントのビルドが違えば記録も変わる。

### 3.3 利用側 `kxtool`（メーカーの道具の役）

```
kxtool [-d HOST] send FILE [NAME]      # 機器の /tmp/NAME に送る
kxtool [-d HOST] console [-c CMD]...   # コンソールで打ち、出た文字を出す（-c がなければ標準入力の各行）。プロンプトが戻るまで待つ
kxtool [-d HOST] log [--from N]        # コンソールの記録（試験の形だけ）
```

- `HOST` は `-d` か `KX_DEVICE`（既定 `192.168.7.2`）。
- **本物の形**（`KXEMU_GATEWAY` がないとき）：TFTP（`HOST:$KX_TFTP_PORT`、既定 69）と、コンソールの TCP（`HOST:$KX_CONSOLE_PORT`、既定 2323）。
- **試験の形**（`KXEMU_GATEWAY=http://localhost:<ポート>` があるとき）：機器の HTTP の口に送る。`HTTP_PROXY` があれば、`NO_PROXY` を見ずにそのプロキシに絶対形式の URL で送り、資格は `Proxy-Authorization: Basic` にする（`http.client` で直接書いた。dev-eval.md 3.1 によれば、urllib の `ProxyHandler` は `NO_PROXY` を見て素通りする）。
  - 使ったアドレスを `X-KX-Device` の見出しで送り、機器が記録の `addr` に残す。設定の `device_ip` を使ったかを採点できる。
  - `KXEMU_ADDRS`（カンマ区切り）があれば、そこにないアドレスは `kxtool: 10.0.0.9: No route to host` で失敗する（終了コード 2）。
- 試験の形と本物の形で、コンソールに出る文字は同じ（どちらも機器の `run_line` を通る）。

### 3.4 試験の仕組みとのつなぎ（`kxdevice.mjs`）

```js
const dev = await startDevice({ stateDir, addresses: ['192.168.7.2'], isolate: 'auto' });
dev.env            // { KXEMU_GATEWAY: 'http://localhost:<HTTP>', KXEMU_ADDRS: '192.168.7.2' }
dev.binDir         // PATH の先頭に足すフォルダ（kxtool）
dev.sandboxNetwork // { allowedDomains: ['localhost:<HTTP>'] }
await dev.reset(); // 止める → init → 同じポートで起動し直す（実測でポートが同じだった）
dev.records();     // { consoleLog, history }
await dev.stop();  // SIGTERM して終わりを待つ
```

- 実行ごとに新しい状態のフォルダで起動するのが一番単純（ポートは 0 で空きを取るので、並べて動かしても重ならない）。`reset` は同じ実行の中で工場出荷に戻したいときに使う。起動は約 0.2 秒。
- 外への道を開けるのは HTTP の1ポートだけにする。TCP のコンソールと TFTP は、サンドボックスの外での手作業や `--no-sandbox` のときに使える。
- 機器を操作する API（起動・停止・初期化）は、HTTP の口に載せず、プロセスの起動と終了で行う。エージェントから届くのは HTTP の口だけなので、エージェントが機器を工場出荷に戻したり、記録を消したりできない。

### 3.5 ダミーのスキルとの分担（案）

ダミーのスキルは段階6で作る。擬似の機器に合わせるなら、次の分け方になる。名前はプラグインのルールのスキル（`cross-compile-rules`・`deploy-rules`）と重ならないようにする（REQ-055）。

| もの | 置き場所 | 中身 |
| --- | --- | --- |
| クロスコンパイルのスキル（例 `kx200-build`） | ユーザーのスキルのフォルダ | ツールチェーン `arm-linux-gnueabihf-gcc`、必ず `-static`（機器にローダーがない）、成果物の場所、失敗したときに見る出力 |
| デプロイのスキル（例 `kx200-deploy`） | ユーザーのスキルのフォルダ | `scripts/mkkximg.py` で見出しを付ける → `kxtool -d <IP> send` → `kxinstall` → `reboot`（再起動しないと有効にならない）→ `kxapp run` → 目印 `[kxapp] <名前> exited (status=N)` まで取る → ログを決まった場所に保存 |
| `mkkximg.py`（見出しと CRC32） | デプロイのスキルの `scripts/`（ユーザーの資産。REQ-055 で流用、REQ-062 でスキルのフォルダの中） | 試作の `sample/mkkximg.py`（12 行） |
| `kxtool` | PC に入っている道具（試験では試験の仕組みが PATH の先頭に置く） | 試作の `kxemu/kxtool` |
| 機器のアドレス `192.168.7.2` | 生成プラグインの設定 `device_ip`（K-09） | 試験では `KXEMU_ADDRS` と合わせる |

- REQ-062 の「統括エージェントを始めずにチャットで頼む」腕でも、同じ機器と同じ記録で採点できる。
- ルールを読まずに進めたときの失敗が、機器の表示ではっきり分かれる（見出しなし→`bad magic`、`-static` なし→`not found`、再起動なし→`pending: reboot to activate`）。統括・検証の PDS のループが「失敗の出力を見て直す」流れも試せる。

### 3.6 採らなかった案

| 案 | 採らない理由 |
| --- | --- |
| スキルが `curl -T … tftp://` と `nc`／`telnet` を直接使う（本物の道具の形） | サンドボックスの中から UDP は出られない（2.3 の1・2番、公式）。TCP も直接は届かない（3番）。PATH で `curl`・`nc` を差し替えると、ほかの用途の `curl` まで変わる |
| 生の TCP のコンソールを、プロキシの CONNECT で使う | 届く（2.3 の4番、B）が、CONNECT と資格を扱える道具が要る（`nc` の `-X connect` は資格を対話で聞く）。HTTP の口と比べて得がない。開けるポートも増える |
| `allowedDomains: ['localhost']` | 届くが、ホストの localhost のすべてのポート（試験の仕組みの偽の API、生成プラグインの画面など）を開ける（公式「The entry also exposes every port on your machine's localhost」）。ポートを付ければ1つだけで足りる |
| Unix ソケット（`allowAllUnixSockets: true`） | Linux では場所で絞れず、ホストのすべての Unix ソケットを開ける（dev-eval.md 3.2・3.3） |
| FIFO（名前付きパイプ） | 届く（2.3 の8番）が、片方向で、読み手と書き手のつなぎ方が難しい。エージェントに向かない |
| `excludedCommands` で `kxtool` だけ外で動かす | 1回の呼び出しのすべてのコマンドが一致したときだけ効く（ナレッジ agent-sdk-eval.md）。`cd … && kxtool …` では効かない |
| サンドボックスを外す（`--no-sandbox`） | 作業フォルダの外に書けるようになる（`inner.mjs:119` の警告）。機器の記録も書き換えられる |
| 自前のプロキシ（`httpProxyPort`）で機器の名前を振り分ける | `NO_PROXY` の範囲（`192.168.0.0/16` など）の宛先は、結局プロキシを通らない。仕組みが複雑になる |

---

## 4. 試作と結果

### 4.1 ファイル（`/tmp/claude-0/-home-user/64a230fb-e6a2-510f-9e7e-9e6600fd34a8/scratchpad/research-scratch/emulator/`）

| ファイル | 行 | 中身 |
| --- | --- | --- |
| `kxemu/kxemu.py` | 668 | 擬似の機器（init・serve、コンソール、TFTP、HTTP の口、イメージの確かめ、ARM の実行と隔離、記録） |
| `kxemu/kxtool` | 191 | 利用側（本物の形と試験の形） |
| `kxemu/kxdevice.mjs` | 80 | 試験の仕組みから起動・停止・初期化・記録を読む |
| `sample/sensor.c` | 12 | 試験用のプログラム（センサー値の平均、`AVG=25`） |
| `sample/mkkximg.py` | 12 | 見出しを付けるスクリプト（ダミーのデプロイのスキルが持つ資産の見本） |
| `test_native.sh` | 79 | サンドボックスの外の通し試験（16 項目） |
| `probe-sandbox-emu.mjs` | 118 | サンドボックスの中の実測（2章） |

### 4.2 サンドボックスの外の通し試験

```
cd /tmp/claude-0/-home-user/64a230fb-e6a2-510f-9e7e-9e6600fd34a8/scratchpad/research-scratch/emulator
bash test_native.sh
```

中で動かしている主なコマンド（`R` は実行のフォルダ、`TP`・`CP`・`HP` は ready の JSON のポート）：

```
python3 -I kxemu/kxemu.py serve --state $R/dev --ready-file $R/ready.json &
arm-linux-gnueabihf-gcc -O2 -static -o sensor.elf sample/sensor.c
arm-linux-gnueabihf-gcc -O2 -o sensor.dyn sample/sensor.c
python3 sample/mkkximg.py sensor.elf sensor sensor.kximg      # mkkximg: sensor.kximg (423788 bytes, crc32=0x86787a7a)
curl -sS -T sensor.kximg tftp://127.0.0.1:$TP/sensor.kximg      # 終了コード 0
printf 'kxinstall /tmp/sensor.elf\nkxinstall /tmp/broken.kximg\nkxinstall /tmp/sensor.kximg\nkxapp run sensor\nreboot\nkxapp run sensor\nexit\n' \
  | timeout 30 nc -N 127.0.0.1 $CP
KX_TFTP_PORT=$TP KX_CONSOLE_PORT=$CP kxemu/kxtool -d 127.0.0.1 send sensor.kximg
KXEMU_GATEWAY=http://localhost:$HP KXEMU_ADDRS=192.168.7.2 kxemu/kxtool send sensor.kximg
```

`nc` のコンソールに出たもの（`\r` を除いた。抜粋）：

```
kx200# kxinstall /tmp/sensor.kximg
kxinstall: verified /tmp/sensor.kximg (KX2I v1, 423788 bytes, crc32=0x86787a7a)
kxinstall: staged sensor; it becomes active after reboot
kx200# kxapp run sensor
kxapp: sensor: not installed (pending: reboot to activate)
kx200# reboot
The system is going down NOW!
Requesting system reboot

U-Boot 2019.07-kx200 (Jan 01 2019 - 00:00:00 +0000)
DRAM:  256 MiB
Starting kernel ...

[    0.000000] Booting Linux on physical CPU 0x0
[    0.001000] Linux version 4.14.98-kx200 (builder@kx200) #1 PREEMPT
[    1.201000] kx200: rootfs mounted (ro), /opt/app (rw), /tmp (tmpfs, cleared)
[    1.501000] kx200: eth0 192.168.7.2/24 up, tftpd on udp/69, console on ttyS0 115200 8N1
[    1.511000] kxapp: activated sensor

KX-200 Linux 1.4.2 kx200 ttyS0

kx200 login: root (auto login)
kx200# kxapp run sensor
sensor module start
AVG=25
[kxapp] sensor exited (status=0)
kx200# logread
[    1.511000] kxapp: activated sensor
[    1.511000] kernel: boot (reboot)
[    1.831000] sensor: sensor module start
[    1.831000] sensor: AVG=25
[    1.831000] [kxapp] sensor exited (status=0)
```

結果（`pass=16 fail=0`、4.4 秒）：

```
ok   curl -T tftp で送れる
ok   見出しのないものは断る
ok   CRC が合わないものは断る
ok   インストールは再起動まで有効にならない
ok   再起動の後に動き、取り終わりの目印が出る
ok   動的リンクは not found
ok   kxtool send（TFTP）
ok   kxtool console（TCP）
ok   決めたアドレスのほかには届かない
ok   kxtool send（HTTP）
ok   kxtool console（HTTP、標準入力）
ok   kxtool log でコンソールの記録が見える
ok   記録：転送の経路と使ったアドレスが残る
ok   記録：実行の結果が残る
ok   記録：隔離のしかた
ok   2回の実行で、コンソールの記録と出来事の記録が同じ
```

`history.jsonl` の例（決まった動きの確かめの1回分）：

```
{"seq": 1, "up": "1.501000", "ev": "boot", "reason": "power-on", "activated": []}
{"seq": 2, "up": "1.551000", "ev": "recv", "via": "http", "name": "sensor.kximg", "size": 423820, "sha256": "94d8…17ae", "ok": true}
{"seq": 4, "up": "1.771000", "ev": "install", "file": "/tmp/sensor.kximg", "ok": true, "name": "sensor", "size": 423788, "crc32": "0x86787a7a"}
{"seq": 6, "up": "1.511000", "ev": "boot", "reason": "reboot", "activated": ["sensor"]}
{"seq": 8, "up": "1.831000", "ev": "run", "name": "sensor", "ok": true, "kind": "arm-static", "status": 0, "timeout": false, "isolate": "bwrap", "output_sha256": "9a58…8242"}
```

### 4.3 異常のとき（`runs/edge`、`--app-timeout 3`）

```
kx200# kxapp run crash
before crash
Segmentation fault
[kxapp] crash exited (status=139)
kx200# kxapp run loop
looping
[kxapp] loop killed (timeout 3s)
kx200# kxapp run escape
host passwd hidden
tmp write ok
usr write denied
[kxapp] escape exited (status=3)
```

- `escape` は `/etc/passwd` を開き、`/tmp/written-by-app` と `/usr/x` に書こうとするプログラム。ホストの `/etc/passwd` は見えず、機器の `/tmp` だけに書けた。
- 時間切れの後に `qemu-arm` のプロセスは残らなかった（`--die-with-parent`）。

### 4.4 サンドボックスの中（本物の Claude Code）

```
node probe-sandbox-emu.mjs port     # default、localhost も同じ形
```

設定 C で、偽の API が動かした Bash の6番の結果：

```
== 6 通し：中でビルド→イメージ→kxtool send→install→reboot→run→log
mkkximg: app.kximg (423788 bytes, crc32=0x86787a7a)
sent app.kximg -> 192.168.7.2:/tmp/app.kximg (423820 bytes)
AVG=25
[kxapp] sensor exited (status=0)
kx200#
exit=0
```

- 6番で動かしたコマンド：`arm-linux-gnueabihf-gcc -O2 -static -o app.elf sensor.c && python3 mkkximg.py app.elf sensor app.kximg && kxtool send app.kximg && kxtool console -c "kxinstall /tmp/app.kximg" -c reboot -c "kxapp run sensor" > device.log && tail -3 device.log`
- `canUseTool` は1回も呼ばれなかった。サンドボックスの違反の記録は `deny network-outbound localhost:<コンソールのポート> (host is not on the allow list)` だけ（4番で、わざと試したもの）。

### 4.5 初期化

`node runs/reset-check.mjs` の結果：`{"before":[39147,50967,41575,11925],"after":[39147,50967,41575,11930],"sameGateway":true,"network":{"allowedDomains":["localhost:41575"]},"history":["boot"]}`。ポートは同じで、プロセスと記録は新しくなった。

---

## 5. 試験の仕組みに入れるときの差し込み場所（案）

dev-eval.md 3.4 の差し込み場所と同じ。違いは、開ける範囲をポート1つにすることと、機器の中身を隠すこと。

- `isolation.mjs`
  - `makeSandboxOptions`（`:57-60`）に `network` と `filesystem` を受ける引数を足す。擬似の機器を使う実行では `{ allowedDomains: ['localhost:<HTTP>'], strictAllowlist: true }` と `{ denyRead: [<機器>], denyWrite: [<機器>] }` を渡す。
  - `makeCanUseTool`（`:95-111`）で `SandboxNetworkAccess` を断って記録する（`strictAllowlist` なら来ないが、念のため）。
  - `envExtra` に `PATH: <kxtool だけのフォルダ>:<元の PATH>` と `dev.env` を足す。
- `inner-run.mjs`：実行ごと・腕ごと（with・without・REQ-062 の単体の腕）に `startDevice`。終わったら `records()` を作業フォルダの決まった名前（例：`.device/console.log`、`.device/history.jsonl`）に写してから採点する（内側の EVAL は `skills/test-plugin/scripts/grade.mjs` の `gradeRun` で採点し〔`tests/dev-eval/runner/inner-run.mjs:21`、`:472`〕、基準のファイルは作業フォルダの根からの相対のグロブである〔`grade.mjs:11`〕）。同じ名前のファイルをエージェントが作っていたら、先に消す。
- 機器の置き場所：実行のフォルダの下（作業フォルダの外。例 `<runDir>/device`）。`kxtool` は、`kxemu.py` や `kxdevice.mjs` と別の、`kxtool` だけのフォルダに置く（試作の `binDir` は `kxemu/` そのもので、`kxemu.py` も PATH に入ってしまう）。
- 道具：`qemu-user`（`qemu-arm`）、`gcc-arm-linux-gnueabihf`、`libc6-dev-armhf-cross`（RESUME.md の段階0）。機器の側の隔離に `bwrap`（サンドボックスで既に要る）。

---

## 6. 採点の案（`grade.mjs` の今の5種類で書ける）

`skills/test-plugin/scripts/grade.mjs:11-17` の program の種類（`file_exists`・`contains`・`not_contains`・`regex`・`unchanged`）で、写した機器の記録を採点できる。

| 見ること | check |
| --- | --- |
| 機器のログに `AVG=25` と目印 | `regex`、`.device/console.log`、`AVG=25\r?\n\[kxapp\] sensor exited \(status=0\)` |
| 見出しと CRC を付けてインストールした | `regex`、`.device/history.jsonl`、`"ev": "install", "file": "[^"]+", "ok": true` |
| 静的リンクで動いた | `regex`、`.device/history.jsonl`、`"kind": "arm-static", "status": 0` |
| 再起動してから動かした | `regex`（flags `s`）、`.device/history.jsonl`、`"activated": \["sensor"\].*"ev": "run", "name": "sensor", "ok": true` |
| 設定の IP を使った | `contains`、`.device/history.jsonl`、`"addr": "192.168.7.2"` |
| 機器以外に送っていない（REQ-061） | 設定（`strictAllowlist`）で保証し、`canUseTool` の記録に `SandboxNetworkAccess` が0件であることを結果に残す |

- 作業フォルダのログ（`logs/device-latest.log`）だけで採点すると、エージェントがその場で `qemu-arm` を動かした結果（2.3 の11番）や、書いた文字でも合格してしまう。機器の側の記録を正とする。

---

## 7. 注意・限界・確かめていないこと

- 本物の機器の手順そのもの（本物の TFTP サーバーの癖、本物のシリアルの速さ、U-Boot の操作）は試せない。REQ-061 のとおり、直す前の確認で示す。
- `kxtool` の試験の形は、サンドボックスのプロキシを明示して使う。Claude Code のサンドボックスのプロキシの形（`HTTP_PROXY=http://<資格>@localhost:3128`）を前提にしている。版が変わったら確かめ直す。
- エージェントが `kxtool` の中身や `KXEMU_GATEWAY` を見て、擬似の機器だと気づくことはありうる。採点は機器の記録で行うので、気づいても合否は変わらない見込みだが、振る舞いへの影響は確かめていない。
- 機器の側の隔離の bwrap の束ね方は、/usr を統合した配置（この容器、Ubuntu）でだけ確かめた。統合していない配置や、ユーザーの名前空間を作れない環境（`--isolate auto` は bwrap がなければ隔離なしで動き、記録に `"isolate": "none"` を残す）では、エージェントが作ったプログラムがホストで動く。
- 生成プラグインの EVAL（ユーザーの環境、test-plugin）は OS のサンドボックスを使わないので、localhost の TCP・UDP にそのまま届く（1.3）。ただし、change-plugin が生成プラグインの EVAL の課題に擬似の機器をどう持たせるか（REQ-061。プラグインのリポジトリに入る課題が、クリエイターの試験用の `kxemu` に頼ってよいか）は、この調査では決めていない。設計で決める。
- 試したのは Linux（この容器）だけ。macOS のサンドボックスは `allowLocalBinding` で localhost に届く（公式）ので、`kxtool` の試験の形もそのまま動く見込みだが、確かめていない。
- Copilot CLI のサンドボックス（既定でローカルネットワークを許す。`docs/design/generated-plugin-structure.md:504`）の中から機器に届くかは確かめていない。

---

## 8. この調査で作った一時ファイル（リポジトリの外）

`/tmp/claude-0/-home-user/64a230fb-e6a2-510f-9e7e-9e6600fd34a8/scratchpad/research-scratch/emulator/` の下：

- `kxemu/kxemu.py`、`kxemu/kxtool`、`kxemu/kxdevice.mjs`
- `sample/sensor.c`、`sample/mkkximg.py`
- `test_native.sh`、`probe-sandbox-emu.mjs`
- `runs/`：`test-native/`（4.2）、`edge/`（4.3）、`sandbox-default/`・`sandbox-localhost/`・`sandbox-port/`（2章）、`probe-default.json`・`probe-localhost.json`・`probe-port.json`・`probe-port2.json`（2章と4.4 の生の結果）、`reset-check.mjs`（4.5）

Agent SDK は、並行の調査が入れた `research-scratch/sdkenv/node_modules`（0.3.310）を読み込んで使った。
