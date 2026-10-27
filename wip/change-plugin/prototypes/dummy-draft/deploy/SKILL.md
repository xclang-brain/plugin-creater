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
