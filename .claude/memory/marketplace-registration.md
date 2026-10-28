# 生成プラグインを plugin-market-place に登録するとき

plugin-market-place の README の「プラグインを足すとき」（フォルダを `plugins/<名前>/` に置く、`.github/plugin/marketplace.json` に足す、一覧に1行足す）に加えて、次のようにした（2026年10月、ng-repro-pick）。

- 生成プラグインのうち、Git で管理しているファイルだけを写す：`git -C <生成プラグイン> archive HEAD | tar -x -C plugins/<名前>`。.git、tests/.venv、tests/node_modules、tests/results、`__pycache__` を持ち込まない。登録済みのプラグインと同じく、生成プラグインの `.github/plugin/marketplace.json` と `.gitignore` は残す。
- 写したファイルで `python3 tests/run.py` を通す。マーケットプレイスのリポジトリに試験の生成物を残さないよう、写しのフォルダで動かした（.venv と node_modules は、元のフォルダのものをシンボリックリンクで流用できた）。
- `git grep` で、/tmp、/home/user、scratchpad など、作業した環境のフォルダの場所が残っていないかを見る（ng-repro-pick では、テストの中の架空のパスだけだった）。
- README の説明には、AI が演じたユーザーと会話して作ったことと、名前や数が架空であることを書く。PR の本文には、試験の結果（1・2段目、内側の EVAL のあり・なし、外側の EVAL）と、分かっている課題を書く。
