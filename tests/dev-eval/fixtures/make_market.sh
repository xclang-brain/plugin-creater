#!/usr/bin/env bash
# 改善の模擬ユーザー edl-change の題材 market.tar.gz を作り直す（開発の試験。testing.md 6章）。
# plugin-market-place のコミット 484584c（embedded-debug-loop を登録したところ）から、一覧と README と
# embedded-debug-loop のフォルダだけを取り出す。git archive は同じコミットから毎回同じファイルを作る。
#
#   bash tests/dev-eval/fixtures/make_market.sh <plugin-market-place のリポジトリのフォルダ>
set -eu
repo=${1:?使い方: bash make_market.sh <plugin-market-place のリポジトリのフォルダ>}
here=$(cd "$(dirname "$0")" && pwd)
git -C "$repo" archive --format=tar.gz -o "$here/market.tar.gz" 484584c README.md .github plugins/embedded-debug-loop
