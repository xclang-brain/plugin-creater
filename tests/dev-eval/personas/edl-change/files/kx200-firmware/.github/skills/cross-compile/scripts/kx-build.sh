#!/usr/bin/env bash
# KX-200 のボードで動く実行ファイル（ARM の ELF）を、ソースのフォルダの *.c からまとめて作る。
# 使い方は --help。標準出力には結果の JSON だけを出し、ほかの知らせは標準エラーに出す。
set -u

CC=arm-linux-gnueabihf-gcc

usage() {
  cat <<'EOF'
使い方: bash kx-build.sh --src DIR --name NAME --out DIR [--debug]

  --src DIR    ソースのフォルダ。直下の *.c をまとめて1つの実行ファイルにする。ヘッダーもここから探す
  --name NAME  できる実行ファイルの名前（英小文字・数字・ハイフンで 15 文字以内）
  --out DIR    出力のフォルダ（なければ作る）。NAME.elf と NAME.build.log を書く
  --debug      最適化をせず、デバッグ情報を付ける
  --help       この使い方を出す

成功すると、標準出力に1行の JSON を出す:
  {"elf": "/abs/path/NAME.elf", "debug": false, "log": "/abs/path/NAME.build.log"}

終了コード:
  0  成功
  2  引数の誤り
  3  arm-linux-gnueabihf-gcc が見つからない
  4  コンパイルかリンクの失敗（NAME.build.log の最初の error: の行を標準エラーに出す）
EOF
}

fail_usage() {
  echo "kx-build: $1（bash kx-build.sh --help を見る）" >&2
  exit 2
}

json() {
  local s=${1//\\/\\\\}
  s=${s//\"/\\\"}
  printf '"%s"' "$s"
}

src="" name="" out="" debug=false
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --src) [ $# -ge 2 ] || fail_usage "--src の後にフォルダがない"; src=$2; shift 2 ;;
    --name) [ $# -ge 2 ] || fail_usage "--name の後に名前がない"; name=$2; shift 2 ;;
    --out) [ $# -ge 2 ] || fail_usage "--out の後にフォルダがない"; out=$2; shift 2 ;;
    --debug) debug=true; shift ;;
    *) fail_usage "知らない引数 $1" ;;
  esac
done
[ -n "$src" ] || fail_usage "--src がない"
[ -n "$name" ] || fail_usage "--name がない"
[ -n "$out" ] || fail_usage "--out がない"
[[ "$name" =~ ^[a-z0-9-]{1,15}$ ]] || fail_usage "--name「$name」は、英小文字・数字・ハイフンで 15 文字以内にする"

[ -d "$src" ] || fail_usage "--src のフォルダ $src がない"
shopt -s nullglob
files=("$src"/*.c)
[ ${#files[@]} -gt 0 ] || fail_usage "$src に .c のファイルがない"

if ! command -v "$CC" >/dev/null 2>&1; then
  echo "kx-build: $CC が見つからない（入っているか、PATH を確かめる）" >&2
  exit 3
fi

mkdir -p "$out" || fail_usage "--out のフォルダ $out を作れない"
out_abs=$(cd "$out" && pwd) || fail_usage "--out のフォルダ $out に入れない"
elf="$out_abs/$name.elf"
log="$out_abs/$name.build.log"

opt="-O2"
if [ "$debug" = true ]; then
  opt="-O0 -g"
fi

if "$CC" $opt -Wall -static -I "$src" -o "$elf" "${files[@]}" >"$log" 2>&1; then
  printf '{"elf": %s, "debug": %s, "log": %s}\n' "$(json "$elf")" "$debug" "$(json "$log")"
  exit 0
fi

echo "kx-build: ビルドに失敗した（ログ：$log）" >&2
first=$(grep -m1 'error:' "$log" || true)
[ -n "$first" ] && echo "$first" >&2
exit 4
