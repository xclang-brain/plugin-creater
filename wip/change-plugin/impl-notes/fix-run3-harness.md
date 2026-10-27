# 外側の EVAL（改善）3回目の直し：試験の仕組み（H12・H13）

作業の途中のメモである。憲章・仕様書・設計書・実装資産のどれでもない。診断（`wip/change-plugin/runs/outer-change-3-diagnosis.md` の 2章・3章）と、確かめ役の better_fix に沿って直す。

## 進み具合

- [x] H12 isTestCode（outer-grade.mjs。scopes().excluded と gradeChange の addedScope・finalScope の excluded に当てた）
- [x] H12 試験（outer-grade.test.mjs、outer-grade-change.test.mjs）。isTestCode を常に偽にする書き換えで、2件とも落ちることを確かめた
- [x] H13-1 tests/dev-eval/runner の mkdtemp の後始末（temp-dirs.mjs の tempDir。inner-test-support.mjs もこれを使う。relay-images.test.mjs は TMPDIR も変える。inner.mjs のユーザー役のホームは結果のフォルダへ）
- [x] H13-2 outer.mjs（main と runPlan の1回ごと）・inner.mjs（innerEval）の空きの確かめ（disk.mjs の checkFreeSpace。2GB 未満なら disk_low）
- [x] H13-3 agent-home/.cache を消す（outer-run.mjs：会話が終わって1・2段目の前。inner-run.mjs：runInnerArm の終わりに home-* すべて）
- [x] H13-4 runGeneratedStages が2段目に diskErrorsOnly を付け、gradeOuter・gradeChange が environmentNotGraded で stage2 を採点しない（notGraded に environment: true、verdict.partial）。outer.mjs の要約に environmentStopped
- [x] H13 試験（disk.test.mjs、outer-grade・outer-grade-change・outer.test・outer-run・inner・inner-run）
- [x] testing.md（5章：ディスクの空きの守り。6.5：試験のコードを excluded から外す、2段目の環境の扱い。6.8：表の2行）
- [x] 試験・/tmp の数の比べ

## 分かったこと

- 直す前の runner の試験（348件すべて合格、69秒）を、TMPDIR を空のフォルダにして回すと、69 個が残った（outer-change-* 30、isolation-test 6、model-map-test 5、playwright-* 12 など）。
- playwright-artifacts-* と playwright_chromiumdev_profile-* は、relay-images.test.mjs が launchBrowser で chrome・msedge の channel を試して見つからないときに、Playwright が作って消さない（確かめた：channel 'chrome' の launch が失敗すると2つ残る）。skills/test-plugin/scripts/screen.mjs の launchBrowser と、生成プラグインの画面の試験も同じ形なので、生成プラグインの2段目でも残る（創る側の組に知らせる）。

- 3回目の記録の当て直し（`<scratchpad>/fix-run3-harness/regrade.mjs`。modelUse を渡さないので main-model・worker-model は出ない）：直す前の採点では 36 観点のうち `screen-url-shown`・`not-embedded:dp-ip`・`stage2` が不合格。直した後は `not-embedded:dp-ip` が合格になり、2段目に diskErrorsOnly を付けると `stage2` は採点しない観点になり、35 観点のうち `screen-url-shown` だけが不合格（0.971、partial）。

## 1. 変えたファイル

| ファイル | 変えたこと |
| --- | --- |
| `tests/dev-eval/runner/outer-grade.mjs` | H12：`isTestCode`（`^tests/stage[12]/`）を足し、`scopes().excluded` から外した。H13：`environmentNotGraded(stages)`（stage2 に diskErrorsOnly があれば stage2 → 理由）。gradeOuter は、その観点を notGraded に `environment: true` で入れる |
| `tests/dev-eval/runner/outer-grade-change.mjs` | H12：`addedScope.excluded` と `finalScope.excluded` から isTestCode を外した（ruleScope の excluded は addedScope と同じ）。H13：notGraded・verdict.partial の仕組みを足し、environmentNotGraded を使う |
| `tests/dev-eval/runner/disk.mjs`（新） | `checkFreeSpace`（statfs の bavail。既定は / と os.tmpdir()、2GB）、`removeAgentCache`（.cache を消す。投げない）、`diskErrorsOnly`、`DISK_ERROR` |
| `tests/dev-eval/runner/outer-run.mjs` | runGeneratedStages：stage2 の全件の不合格がディスクの誤りなら `diskErrorsOnly: true`。runOuterOnce：会話が終わったら（1・2段目の前に）agent-home/.cache を消す（keepHomes なら残す） |
| `tests/dev-eval/runner/inner-run.mjs` | runInnerArm の終わりに、実行のフォルダの `home-*` の .cache をすべて消す（home-main と inner-adapter の home-<id>） |
| `tests/dev-eval/runner/outer.mjs` | main：サンドボックスの確かめの後に空きの確かめ（disk_low で終了コード 2）。runPlan：1回ごとに確かめ、足りなければ stopped（disk_low）で残りを飛ばす。要約に `environmentStopped`、進み具合の行に採点しなかった観点 |
| `tests/dev-eval/runner/inner.mjs` | innerEval の始めに空きの確かめ（disk_low）。main のユーザー役のホームを結果のフォルダに（OS の一時フォルダに残さない） |
| `tests/dev-eval/runner/temp-dirs.mjs`（新） | 試験用の `tempDir(prefix)`・`removeAtExit(dir)`（プロセスの終わりに消す） |
| runner の試験 18 ファイル | mkdtemp を tempDir に。inner-test-support.mjs の tmpDir も tempDir を使う。relay-images.test.mjs は TMPDIR を tempDir にする（Playwright の残り） |
| 試験の追加 | disk.test.mjs（4件）、outer-grade.test.mjs（2件）、outer-grade-change.test.mjs（2件）、outer-run.test.mjs（2件）、outer.test.mjs（3件）、inner.test.mjs（1件）、inner-run.test.mjs（1件） |
| `docs/design/testing.md` | 5章：ディスクの空きの守り（空きの確かめ、.cache、試験の一時フォルダ）。6.5：試験のコードを excluded に含めない、2段目の環境の扱い。6.8：表の2行 |

## 2. 確かめたこと

- `node --test tests/dev-eval/runner/*.test.mjs`：363件すべて合格（直す前は 348件）。
- TMPDIR を空のフォルダにして回すと、残ったのは Claude Code の Bash ツールが作る `claude-0`（このセッションのもの。試験のものではない）だけ（直す前は 69 個）。
- 本当の /tmp で回す前と後：5890 個 → 5890 個。増えたもの・減ったものなし。
- `node --test tests/dev-eval/trigger/*.test.mjs`：13件合格（outer-run.mjs を読み込むため）。

## 3. ほかの組と統括に知らせること

- 模擬ユーザーの組：確かめ役の better_fix 2 は、`tests/dev-eval/personas/FORMAT.md` の 123 行あたりにも「`tests/stage1/`・`tests/stage2/` の試験のコードは excluded の証拠にしない（スキル、スクリプト、エージェント、task.json、knowledge.json、eval.json は見る）」を書くことを勧めている（模擬ユーザーの組のファイル）。正規表現は変えない。
- 作る側の組：Playwright は、見つからない channel（chrome、msedge）で launch に失敗したとき、作った `playwright-artifacts-*` と `playwright_chromiumdev_profile-*` を消さない。`skills/test-plugin/scripts/screen.mjs` の launchBrowser と、生成プラグインの画面の試験（chrome → msedge → chromium の順に試す）は、Chrome と Edge のない環境で1回ごとに2組（4個）を /tmp に残す（中身は空）。3回目の playwright-* 176 組の出どころの見込み。
- 統括：/tmp の残り（5890 個、約 5GB。outer-change-fixture 469、dev-eval-adapter-run/work 各 694 など）を消すかは統括が決める。試験はもう残さない。
- しなかったこと：better_fix 4 の「クリエイターのセッションのツールの結果に ENOSPC が出たら、回全体を環境の影響ありとする」と、better_fix 3 の「残りの回の数 × 1GB を足した空き」。前者は指示の一覧になく、後者は回の後に .cache を消すので、1回ごとに 2GB を確かめる形にした。

## 4. 見直しの指摘（8件）の直し（2巡目）

進み具合（容器が再起動したら、ここから続ける）：

- [x] 1〜8 のコードの直し（disk.mjs、outer-grade.mjs、outer-grade-change.mjs、outer-run.mjs、outer.mjs、inner.mjs、temp-dirs.mjs の diskOk）
- [x] 2 の試験への diskOk の注入（inner・outer・outer-human・outer-resume）
- [x] 新しい試験（disk、outer-grade、outer-grade-change、outer、outer-run、outer-human、inner）
- [x] testing.md（5章、6.5、6.8）
- [x] 試験を回す（低い空きの preload でも）、この節の結果を書く

### 4.1 指摘ごとの確かめと直し

| # | 判定 | 確かめたこと | 直したこと |
| --- | --- | --- | --- |
| 1 | 一部だけ本当 | 「inner-deliverable が落ちる」は誤り。outer-run.mjs は withScore が null の内側の結果を採点に渡さない（`inner: … withScore !== null ? innerResult : null`）ので、disk_low で inner-deliverable は不合格にならず、黙って採点から消えていた（partial も付かず、ほかの理由の誤りと見分けられない）。開発者が答える形は点数に入れないので、影響なし | 内側の誤りの code を innerResult に残す。code が disk_low なら採点に渡し、environmentNotGraded が inner-deliverable を環境で止まった観点にする（notGraded に environment: true、verdict.partial）。ほかの誤りは、これまでどおり点数に入れない。試験：outer-grade・outer-grade-change・outer-human |
| 2 | 本当 | lowdisk.cjs の preload で、指摘のとおり 9 件が落ちた | temp-dirs.mjs に diskOk（いつも足りる）を足し、innerEval・runPlan・main を動かす試験に渡した。inner.mjs の main は deps.diskCheck を受ける。preload で runner の試験 372 件すべて合格 |
| 3 | 本当 | 3回目の記録の tool.result [539]（Chromium を入れるコマンド）と [610]（試験の結果）に ENOSPC・EIO。[607]・[609] は ENOSPC を探すコマンド（tool.use）、[632] は報告の文 | disk.mjs に diskErrorResults（tool.result だけを見る）。outer-grade.mjs の environmentOf が、環境で止まった観点か、ツールの結果のディスクの誤りがあれば grading.environment を付け、verdict に partial と environment を付ける（会話例の候補にしない。改善の採点も同じ）。summarizeRecord が environmentAffected を出し、summarizeAll は平均点・合格の数・記録する数・差に入れず、腕・モデルごとに environmentAffected を数える（user_role_failed の回は、そちらだけに数える）。進み具合の行と finishInfo にも出す。3回目の記録の当て直し：environment は toolResults [539, 610]。1回目・2回目の記録は当たらない |
| 4 | 本当 | `.claude` は `!keepHomes && !human` で残すが、`.cache` は human でも消していた。--resume はどの終わりの状態からでも続けられる（prepareResume は TERMINAL_STATES を許す）ので、FINISHED_REASONS で分けるのではなく、.claude と同じ守りにした | `if (!keepHomes && !human) removeAgentCache(...)`。試験：outer-run の .cache の試験に human を足した |
| 5 | 本当 | checkFreeSpace は / と os.tmpdir() だけ。outer.mjs main は outDir を決める前（--out なしは mkdtemp の前）に確かめ、inner.mjs main は outDir を作って置き換えた後に innerEval が確かめていた。innerEval は空き → サンドボックス、outer は サンドボックス → 空き | checkFreeSpace に dirs（足して見る場所）を足し、まだない場所は、あるうちで一番近い上のフォルダで見る。outer.mjs main は `dirs: [outDir ?? --out ?? 結果の置き場所の既定]` を、フォルダを作る前に確かめる。runPlan の1回ごとも outDir を見る。inner.mjs に preflight（サンドボックス → 空き。outer と同じ順）を足し、main は結果のフォルダを作って置き換える前に、innerEval も始めに呼ぶ（外側から呼ぶときのため。main からは2回確かめるが、置き換えの後の空きも見るので残した） |
| 6 | 本当 | environmentNotGraded は skipped で {} を返し、stage1 は見ていなかった | runGeneratedStages が stage1 にも diskErrorsOnly を付け、run.py の結果を読めないときは標準エラー出力と標準出力の全体に DISK_ERROR が当たれば diskError を付ける（道具が足りないときは付けない）。runOuterOnce が runStages の例外（Playwright の写しの ENOSPC など）にも diskError を付ける。environmentNotGraded は skipped かつ diskError なら stage1・stage2 の両方を、そうでなければ diskErrorsOnly の段階を返す。template/tests/run.py は変えていない（試験の仕組みの側で見分けられるため） |
| 7 | 本当 | runGeneratedStages は run.py に OS の一時フォルダの TMPDIR を渡していた | 1回ごとに `tmpRoot`（既定 os.tmpdir()）の下に dev-eval-stages-* を作って TMPDIR で渡し、finally で消す（消せなくても投げない）。あわせて、Playwright の写しを try の中に移し、写す途中で落ちても写しかけを消すようにした。試験：outer-run（TMPDIR の中に作ったものが消え、tmpRoot が空） |
| 8 | 本当 | 注釈が古かった | 「足した行のすべて（1・2段目の試験のコードを除く）で見る」にした |

### 4.2 変えたファイル（2巡目）

- `tests/dev-eval/runner/disk.mjs`：checkFreeSpace の dirs とまだない場所の見方、diskErrorResults
- `tests/dev-eval/runner/outer-grade.mjs`：environmentNotGraded（stage1、diskError、inner の disk_low）、environmentOf、partialOf、gradeOuter の environment
- `tests/dev-eval/runner/outer-grade-change.mjs`：同じ仕組み、注釈（8）
- `tests/dev-eval/runner/outer-run.mjs`：runGeneratedStages（TMPDIR、stage1 の印、diskError、写しを try の中に）、runStages の例外の diskError、内側の誤りの code、innerForGrading、human の .cache、finishInfo の environment
- `tests/dev-eval/runner/outer.mjs`：summarizeRecord の environmentAffected、summarizeAll、runPlan と main の dirs、進み具合の行、頭の注釈
- `tests/dev-eval/runner/inner.mjs`：preflight、innerEval の順、main の deps.diskCheck と置き換えの前の確かめ
- `tests/dev-eval/runner/temp-dirs.mjs`：diskOk
- 試験：disk、outer-grade、outer-grade-change、outer、outer-run、outer-human、outer-resume、inner
- `docs/design/testing.md`：5章（結果のフォルダ、確かめの順、human の .cache、run.py の TMPDIR、試験の diskOk）、6.5（環境で止まる3つの場合、環境の影響を受けた回と要約の扱い）、6.8 の stage1・stage2 の行

### 4.3 確かめたこと（2巡目）

- `node --test tests/dev-eval/runner/*.test.mjs`：372 件すべて合格。TMPDIR を空のフォルダにして回し、残ったのは Bash ツールの `claude-0` だけ。
- lowdisk.cjs の preload（statfs が約 4MB を返す）で、指摘の4ファイル 45 件、runner 全体 372 件すべて合格（直す前は9件が落ちた）。
- `tests/dev-eval/trigger/*.test.mjs` 13 件、`tests/dev-eval/personas/validate.test.mjs` 77 件合格（outer-run.mjs・outer-grade.mjs を読み込むため）。
- 3回目の記録の当て直し（`<scratchpad>/fix-run3-harness/regrade.mjs`）：stage2 の印なしでも environment（toolResults [539, 610]）と partial が付く。印ありは 35 観点のうち screen-url-shown だけが不合格（0.971）、notGraded は stage2。

### 4.4 しなかったこと・統括に知らせること

- runPlan が飛ばした回（利用枠の上限・中断・disk_low で skipped / interrupted）は、要約で点数 0 として平均点に入る。これは前からの扱いで（利用枠の上限でも同じ）、指摘の範囲の外なので変えていない。直すかは統括が決める。
- 内側の EVAL が始まった後に空きがなくなり、実行が誤りで終わったとき：多くは score が null になり、withScore が null なら採点に渡らない（これまでどおり、黙って点数に入れない）。実行の理由の文から ENOSPC を見分けることはしていない（推測の要る作りになるため）。
