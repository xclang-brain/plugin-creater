# 最後の点検の直し：組み立てのスクリプト（scaffold グループ）の作業メモ

作業の途中のメモである。点検：`wip/change-plugin/runs/final-review-spec-coverage.md`（F1）、`final-review-outcome.md`（F3）。verifier の better_fix を優先した。

## 担当ファイル

skills/make-plugin/scripts/scaffold.py、tests/creator/scaffold/**、docs/design/creator-structure.md（戻し方とコミットの行だけ）

## 進み具合

| 直し | 状態 | メモ |
| --- | --- | --- |
| 戻すコマンド（F1・F3） | 済み：scaffold.py に `undo_command()` を足し、`commit` が返す `revert` を `git -C <P> revert --no-commit <直したコミット> && git -C <P> commit -m "plugin-creator: <名前> の変更を戻した" -- .` にした（2回目の点検で restore の形から変えた。下の「2回目の点検」）。モジュールの説明の commit の項にも1文 | JSON の項目の名前は `revert` のまま（change-apply.md の4・7が読む）。最初のコミット（親がない）のときは null（打ち消すとプラグインのフォルダがなくなり、`git -C <P>` が動かない） |
| 設計書 | 済み：creator-structure.md 3.4 の `commit` の行（戻すコマンドも返す）、4.1 の説明の項の「コミットと戻し方」（2回目の点検で revert --no-commit の形に直した） | |
| 試験 | 済み：`python3 -m unittest discover -s tests/creator/scaffold -p "test_*.py"` 272 件 OK（2回目の点検の後）。`python3 tests/creator/check_creator.py` 合格 | test_change.py の Commit：前の revert の試験を、示したコマンドを sh で動かす試験に置き換え、ほかのフォルダに git add した変更があるとき（README.md と plugins/other/x.txt）に動き、足したファイル（T-02 など）が消え、ほかの変更は git add したまま残り、戻すコミットにはプラグインのフォルダのファイルだけが入る試験を足した。名前を書けないときとフォルダの引用の試験も足した。前の形（git revert）を返すようにすると、足した試験が落ちることを確かめた |

## better_fix からのずれ・決めたこと

1. （2回目の点検で置き換えた）初めは restore の形で、直す前のコミットを番号で書いていた（`<コミット>^` の `^` は cmd.exe と zsh で別の意味になるため）。今の形は直したコミットの番号をそのまま書くので、この心配はない。
2. コミットの説明の名前は、マニフェストの name が生成プラグインの名前の形（a-z0-9 とハイフン）のときだけ入れ、ほかは「直した変更を戻した」にした。作っていないプラグインの name に `"` や `$` があると、二重引用符の中で壊れるためである。
3. 走り5のリポジトリの写し（README.md を git add したまま）で確かめた：前のコマンド（`git revert --no-edit b41f4ce`）は「your local changes would be overwritten by revert」で終了コード 128。新しい形は終了コード 0 で、リポジトリ全体が b41f4ce^ と同じになり（足した16件のファイルも消えた）、README.md は git add したまま残った。写しは消した。

## 残り・ほかの組と統括に知らせること

1. スキルの文（change-apply.md の4・7）は変えなくてよい。「返った `revert`（直す前に戻すコマンド）」「返った `revert` のコマンド」のままで正しい。
2. （2回目の点検で解消）返すコマンドに `revert` の語が戻ったので、edl-change の persona.json の `expect.explained` の `revert` と、testing.md 6.8 の `explained` の行は直さなくてよい。
3. （2回目の点検で解消）restore の形は、フォルダの中のコミットしていない変更と後からのコミットを黙って上書きしていた。今の形は、後からのコミットを残し、直したファイルにあるコミットしていない変更は断る。
4. wip/change-plugin/BLUEPRINT.md 266 行の `commit` の返す値（`revert:"git -C <P> revert --no-edit <commit>"`）が古い。今の形に直すとよい（scaffold の組の担当外）。

## 2回目の点検（最後の点検の再点検、4件）

| 指摘 | 判定 | したこと |
| --- | --- | --- |
| 1（中）restore の形は、フォルダの中の後からのコミットとコミットしていない変更を黙って消す | 本当（確かめた） | better_fix のとおり `git -C <P> revert --no-commit <直したコミット> && git -C <P> commit -m "plugin-creator: <名前> の変更を戻した" -- .` にした。docstring と creator-structure.md 4.1 も直した。試験：初めの試験の期待の文を直し、後からのコミット（NOTES.md）が残る試験と、コミットしていない書き足しがあると断って HEAD と書き足しが残る試験を足した |
| 2（中）outer EVAL の `explained` が `revert` を求めるのに、コマンドに `revert` がない | 本当 | 1 の直しで解消（コマンドに `revert` が入る）。ほかの組のファイルは変えていない |
| 3（低）`&&` は Windows PowerShell 5.1 で使えない | 本当（公式の about_Pipeline_Chain_Operators：PowerShell 7 から）。直さず受け入れる | 5.1 では構文の誤りになり、何も動かない（壊さない）。PowerShell 7、cmd.exe、sh では動く。Copilot CLI の Windows の前提は PowerShell v6 以上（github/copilot-cli の README）。docstring と creator-structure.md 4.1 に書いた。1行に1つずつ示すかは、スキルの文（change-apply.md の7）の担当の判断 |
| 4（細）`NAME_RE.match` は最後の改行を通す | 本当 | undo_command を `NAME_RE.fullmatch` にし、`"abc\n"` の試験を足した。マニフェストの検査（scaffold.py 403、421 行）も `match` だが、指摘の外なので変えていない |

走り5のリポジトリの写し（README.md を git add したまま）で確かめた（git 2.43、写しは消した）：

- 今の形：終了コード 0。HEAD は 0b17e2d と同じ中身、README.md は git add したまま、REVERT_HEAD は残らない。
- 後から NOTES.md をコミットしたとき：終了コード 0 で、NOTES.md は残る。
- 直したファイル（プラグインの README.md）にコミットしていない書き足しがあるとき：終了コード 128 で断り、何も変わらない。
- 直していないファイルにコミットしていない変更があるとき：終了コード 0 で、その変更は戻すコミットに入る（消えはしない）。
- 後からのコミットが直したファイルを変えていたとき：衝突して終了コード 1 で止まる（git のふつうの revert と同じ）。このとき `git revert --abort` をすると、ほかのフォルダで git add してあった README.md の変更も消えた（git の --abort が索引を HEAD に戻すため）。説明に添えるかは統括の判断に任せる。
- 形を restore に戻すと、足した2件と直した2件の試験が落ちることを確かめた。
