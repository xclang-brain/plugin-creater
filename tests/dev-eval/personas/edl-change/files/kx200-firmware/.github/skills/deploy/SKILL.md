---
name: deploy
description: "クロスコンパイルした実行ファイルを KX-200 ボードに入れて動かし、ボードのコンソールに出たログを取る。「KX-200 に入れて動かして」「ボードにデプロイしてログを取って」と頼まれたときに使う。ビルドには使わない。"
compatibility: "Python 3 と、ボードのメーカーの道具 kxtool と、ボードへのネットワークが要る。"
metadata:
  owner: kx200-firmware
  revision: "2.1"
---

# KX-200 へのデプロイとログの取り方

## ボードのアドレス

- 頼みに書かれたアドレスを使う。書かれていなければ、既定の `192.168.7.20` を使う。

## 使うもの

- `kxtool`：ボードのメーカーの道具（開発機に入っている）。`kxtool -d <アドレス> send <ファイル>` でボードの `/tmp` に送り、`kxtool -d <アドレス> console -c "<コマンド>"` でボードのコンソールでコマンドを打つ（`-c` は何回でも書ける）。
- `scripts/mkkximg.py`：ELF を、ボードに入れられるイメージ（`.kximg`）にする。パスは、この SKILL.md があるフォルダからの相対パスである。コマンドでは、このフォルダの絶対パスを前に付けて動かす。引数と終了コードは `python3 <このフォルダ>/scripts/mkkximg.py --help` で出る。

## 手順

1. 送る前に、ボードの版を見る。

   ```bash
   kxtool -d <アドレス> console -c "uname -a"
   ```

2. イメージにする。

   ```bash
   python3 <このフォルダ>/scripts/mkkximg.py <ELF> <アプリの名前> <出力のフォルダ>/<アプリの名前>.kximg
   ```

3. 送って入れ、再起動してから動かす。

   ```bash
   kxtool -d <アドレス> send <出力のフォルダ>/<アプリの名前>.kximg
   kxtool -d <アドレス> console -c "kxinstall /tmp/<アプリの名前>.kximg" -c reboot -c "kxapp run <アプリの名前>"
   ```

4. コンソールに `[kxapp] <アプリの名前> exited (status=N)` が出るまでを取る。出た文字を、頼まれた場所にログとして保存する。

## 気をつけること

- 送るのは、必ず `mkkximg.py` で作った `.kximg`。ELF のまま送って `kxinstall` すると、`bad magic (not a KX2I image)` で断られる。
- `kxinstall` しただけでは有効にならない。`reboot` するまでは、`kxapp run` が `not installed (pending: reboot to activate)` になる。
- `kxapp run` の出力の終わりに、目印 `[kxapp] <アプリの名前> exited (status=N)` が出る。目印が出るまで取る。`status` はアプリの終了コード。
