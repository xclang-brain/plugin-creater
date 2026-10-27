---
name: cross-compile
description: "KX-200 ボード（ARM の組み込み Linux）で動かす C のプログラムをクロスコンパイルして、実行ファイル（ELF）を作る。「KX-200 用にビルドして」「ボード向けにクロスコンパイルして」と頼まれたときに使う。ボードへの転送や実行には使わない。"
compatibility: "arm-linux-gnueabihf-gcc と bash が要る。Linux の開発機で使う。"
metadata:
  owner: kx200-firmware
  revision: "1.4"
---

# KX-200 向けのクロスコンパイル

KX-200 のボードで動く実行ファイル（ARM の ELF）を作る。

## 使うスクリプト

パスは、この SKILL.md があるフォルダからの相対パスである。コマンドでは、このフォルダの絶対パスを前に付けて動かす（今いるフォルダからの相対パスにしない）。

- `scripts/kx-build.sh`：ソースのフォルダの `*.c` をまとめてビルドし、実行ファイルを1つ作る。引数と終了コードは `bash <このフォルダ>/scripts/kx-build.sh --help` で出る。

## 手順

1. ソースのフォルダで `git pull` して、最新にする。
2. ビルドする。

   ```bash
   bash <このフォルダ>/scripts/kx-build.sh --src <ソースのフォルダ> --name <アプリの名前> --out <出力のフォルダ>
   ```

   出力のフォルダは、頼まれた場所にする。頼まれていなければ `<ソースのフォルダ>/build` にする。
3. 成功すると、標準出力に1行の JSON が出る。`elf` が、できた実行ファイルの絶対パスである。

   ```json
   {"elf": "/home/dev/sensor/build/sensor.elf", "debug": false, "log": "/home/dev/sensor/build/sensor.build.log"}
   ```

## 気をつけること

- ビルドは `arm-linux-gnueabihf-gcc` で行う。開発機の `gcc` でビルドしたもの（x86 の実行ファイル）は、KX-200 では動かない。
- 必ず静的リンク（`-static`）にする。KX-200 には共有ライブラリのローダーがないので、動的リンクの実行ファイルは、ファイルがあるのに `not found` と出て動かない。
- 最適化は `-O2` にする。
