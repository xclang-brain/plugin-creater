# 外側の EVAL（改善）1回目の直し：模擬ユーザーの組（P1〜P6、H7、H8）

作業の途中のメモである。憲章・仕様書・設計書・実装資産のどれでもない。`wip/change-plugin/runs/outer-change-1-diagnosis.md` の 3.2 の H7・H8 と、3.3 の P1〜P6 を、模擬ユーザーの組として入れた記録。

## 変えたファイル

| ファイル | 直し |
| --- | --- |
| `tests/dev-eval/personas/edl-change/persona.json` | P1〜P6（下）。H7 で見つかった answered の重なり2件。`expect.screenUnchanged`。ユーザー役の試験の質問（recall 3件、confirm 1件を足し、k15-now の recall の1問を直した） |
| `tests/dev-eval/personas/edl-change/inner/standalone.json` | H8：頼みの文から機器のアドレスを外した。基準 C-05（dp-ip、機器の記録に `"addr": "192.168.7.2"`、program）を足した |
| `tests/dev-eval/personas/validate.mjs` | H7（改善の模擬ユーザーで、聞かれないと話さないナレッジの answered が、ほかのナレッジの文に当たれば誤り）。ナレッジの `stance`。`expect.screenUnchanged` |
| `tests/dev-eval/personas/validate.test.mjs` | +5 件（H7、stance、screenUnchanged と画面の立場、dp-console の embedded、確かめ B の頼みにアドレスがない）。REQ-058 の試験を P1 に合わせた（fact に番号がない） |
| `tests/dev-eval/personas/FORMAT.md` | 2.2（`stance` の行、最近の1回で話す細かさ）、2.5（`expect.screenUnchanged`、一覧の答えは番号でなく中身、画面の立場、スクリプトの使い方は決まりにしない、answered の重なり）、3（単体の課題の頼みにスキルが知るべき値を書かない）、5（`stance` は渡さない）、6（確かめること） |

## 直しごとの中身

- P1：`k15-now` の fact から番号（K-01〜K-17、K-15）を外し、古くなった決まりを中身（「ビルドが失敗した・デプロイできない・実機が応答しない・ログが取れないときは、そのまま進めずに人に伝えて判断してもらう」）で書いた。`asked` の `K-15` は残した（一覧を示した問いには番号が出るため）。recall の「K-15 は今もそのとおりですか？」は、決まりの文を含む問いにした（番号だけの問いは、一覧を見ていない人には答えられない）。
- P2：`dp-steps` の `answered` を `有効にな|kxinstall[^。\n]{0,40}(?:reboot|再起動)|(?:reboot|再起動)[^。\n]{0,40}kxapp run` にした（下の「ずれ」の1）。1回目の [162]「ボードを1回 reboot してやり直し」には当たらない。
- P3：`log-dbg` の `asked` に `ログ追加` を足した。
- P4：`cc-toolchain`・`cc-static`・`cc-debug`・`dp-marker` の reveal に「最近の1回を順に話すときは、kx-build.sh でビルドした（ログを取って保存した）とだけ言い、コンパイラの名前（リンクのしかた、最適化のオプション、目印の文字）までは言わない」を足した。`log-dbg` と新しい `dp-console` にも同じ形で足した（ずれの3）。`dp-image`・`dp-steps` は、reveal に「最近の1回の流れを順に聞かれたとき」を足し、`asked` に `順に|最近` を足した。
- P5：`screen-same`（`from: talk`、`volunteer: true`、`stance: true`）。「作業の画面（始める前に設定すること、実行中に見ること、終わった後に見る結果）は今のままでよく、変えたいところも足したいものもない。ボードのアドレスは毎回画面に入れているので、画面の初めの値も変えなくてよい。正しいアドレスは、画面ではなく、KX-200 のデプロイの決まりとしてスキルに書いておいてほしい。画面を使わずにチャットで頼むときにも使うので。」fact にアドレスの値は書いていない（dp-ip の embedded がこの文に当たらないように）。`expect.screenUnchanged` は、names.mjs の名前のとおり `開始前に設定したいこと`・`実行中に見たいこと`・`終わった後に見たい結果と見せ方`。
- P6：`dp-console`（`from: file`、deploy/SKILL.md、evidence `console -c`、kind `rule`、`volunteer: false`）。ユーザーのスキルの「使うもの」に、ボードのコンソールでコマンドを打つやり方として書いてあり、たまたまの書き方ではないので rule にした。embedded は `kxtool[^\n]*console[^\n]*-c(?![\w-])`（kxtool・console・-c が同じ行。H3 でルールのスキルの足した行だけで見る）。題材と流用される資産（kx-build.sh、mkkximg.py）の文字には当たらない。あわせて `script-usage`（`from: talk`、`volunteer: false`、`stance: true`）：「kx-build.sh や、イメージを作るスクリプトの引数、出力のフォルダ、終了コードなどのスクリプトの使い方は、スキルに書いてあるとおりで、細かいことは --help で出る。自分で決めた決まりではないが、そのとおりに使っていて、変えるつもりもない。」
- H7：`validateChange` で、`volunteer` が false のナレッジの `answered` が、ほかのナレッジの `fact` と `file.detail` に当たれば誤りにした。誤りの文：「ナレッジ「dp-steps」の markers.answered「…」が、ナレッジ「k15-now」の文に当たる（ほかのナレッジを話しただけで、聞かれずに話したことになる）」。
- H8：`inner/standalone.json` の頼みを「inputs/src のプログラムを KX-200 用にクロスコンパイルして、KX-200 に入れて動かし、機器のログを logs/device.log に保存してください。アプリの名前は sensor です。」にした。アドレスがルールのスキルにないと、擬似の機器は 192.168.7.2 しか受けないので C-01〜C-05 が落ちる。見本（golden）はそのままで、C-05 にも合格する（REQ-061 の試験で確かめた）。

## 診断や指示からのずれ・決めたこと

1. P2：診断の案 `kxinstall|kxapp run|有効にならない` は、`kxinstall` が dp-image の文（「ELF のまま送って kxinstall すると…」）に、`kxapp run` が dp-marker の文（「kxapp run の出力の終わりに…」）にあり、H7 に落ちる。dp-steps だけにあるのは「有効にならない」と、kxinstall→reboot・reboot→kxapp run の並びなので、その3つにした。「有効にならない」は「有効になりません」とも言うので `有効にな` にした。
2. H7 の範囲：診断のとおり、聞かれないと話さないナレッジ（`volunteer` が false）の `answered` だけを見る（外側の EVAL の「聞かれずに話した」は、このナレッジだけを見るため）。`k15-now`（自分から話す）の `answered`「reboot」は dp-steps の文に当たるが、誤りにしない。置き場所は、embedded の重なりと同じ `validateChange`（改善の模擬ユーザーだけ）にした。作る模擬ユーザーにも同じ重なりがある（下の「ほかの組に知らせること」）が、この組の指示のファイルでないので変えていない。
3. H7 で見つかった重なり：`cc-git-pull` と `dp-uname`（どちらも incidental）の `answered` の「決まりではない」が、互いの文に当たった。話題と結んだ形（`書いただけ|git pull[^。\n]{0,40}決まりではな|決まりではな[^。\n]{0,40}git pull`、`自分で見る|uname[^。\n]{0,40}決まりではな|決まりではな[^。\n]{0,40}uname`）にした。
4. P4：診断の対象（cc-toolchain・cc-static・cc-debug・dp-marker）に加えて、`log-dbg` にも reveal の制限を足した。1回目の [185] で DBG_LOG も漏れに数えられ、P3（`ログ追加`）だけでは「最近の1回」の問いに当たらないため。新しい `dp-console` にも足した。
5. `stance`（答え方の立場）を足した：FORMAT は、`first-run` のほかのナレッジに `embedded` か `excluded` を求めるが、P5・P6 の立場は生成プラグインに入る決まりではなく、書ける言葉がない。採点の観点を新しく作らないため（`--help` の文や画面の初めの値の形を見る観点は、診断にない）、`stance: true` のナレッジは `from: talk` にし、`embedded`・`excluded`・`task` を書かないことにした。外側の EVAL では、`embedded`・`excludedHit` が null になるので、組み込みの観点は出ない（記録の verdict は not-written などになるが、採点には使われない）。ユーザー役には渡さない（user-role.mjs は fact・reveal・volunteer・file だけを渡す）。
6. `expect.screenUnchanged`：模擬ユーザーには日本語の名前を書いた。validate.mjs は、採点（outer-grade-change.mjs）と testing.md 6.8 に合わせて、名前と記号のどちらも読む。空の並びも通す（画面の3つを変える頼み）。
7. H8：基準 C-05（dp-ip）を足した。足さなくても C-01〜C-04 が落ちて見つかるが、何が足りないか（アドレス）を基準で示すため。文は eval.json の C-05 と同じ。

## ほかの組に知らせること

- 作る模擬ユーザーの answered の重なり（H7 を全員に当てると落ちるもの。直していない）：meeting-minutes の `attendees.answered`（「決まりではない」）が `style` の文に、training-survey の `first-run.answered` が `output`・`average`・`anonymize`・`low-first` の文に当たる。`first-run` は `outer-grade.mjs` の「聞かれずに話した」の判定から外れていないので、training-survey では「最近の1回」に当たる答えで漏れが出うる。
- `wip/change-plugin/BLUEPRINT.md` の 399 行あたりは、k15-now の fact を「K-15 は古い。…」と番号で書いている（P1 と食い違う。この組の持ち物でない）。
- testing.md（試験の仕組みの組）：模擬ユーザーの形は FORMAT.md に書いた。testing.md で `stance` や H7 に触れるなら、FORMAT.md 2.2・2.5 を指す。
- ユーザー役の試験（edl-change）はこの組では動かしていない。見るとよいもの：`options`（一覧を見せたときに K-15 の番号で答える。fact に番号がなくなった）、新しい recall（dp-console、screen-same、script-usage）、confirm（dp-console が「このとおり」）、generic の漏れ（dp-console の `console`、script-usage の `--help`）。

## 試験

- `node --test tests/dev-eval/personas/validate.test.mjs`：67 件すべて合格（REQ-061 の擬似の機器の試験も、飛ばさずに合格）
- `node tests/dev-eval/personas/validate.mjs`：edl-change、weekly-report、meeting-minutes、training-survey（weekly-report と meeting-minutes は `--all-styles` でも）、heldout の h1 がすべて合格
- `python3 tests/dev-eval/personas/test_dummy_skills.py`：16 件 OK
- 本物の模擬ユーザーを読むランナーの試験（`outer-grade-change.test.mjs` と `outer-change.test.mjs` の「本物」の4件）：合格
- 1回目の記録に、新しい markers で漏れの判定を当て直した（scratchpad の `leaks.mjs`）：[162] の dp-steps（reboot）と log-dbg は出なくなった。[185] の cc-toolchain・cc-static・cc-debug・dp-marker・log-dbg と [248] は、答えの文が同じなので残る（reveal の制限と H1 で、次の回の答えが変わるかを見る）。[474] で dp-console が出るが、1回目のユーザー役は console を「決めているものではない」と答えていた（今のナレッジでは決まりとして答える）

## レビューの指摘の確かめと直し

レビューの指摘 1〜10 を、node で確かめてから直した。直した後の模擬ユーザーで、1回目の記録に漏れの判定を当て直した（scratchpad の `leaks.mjs`）。結果は直す前と同じ 8 件で、増えも減りもしない（残りは reveal の制限で次の回の答えが変わるかを見るもの、[248] はユーザー役の本当の漏れ、[474] は前の節のとおり）。

| # | 結果 | 中身 |
| --- | --- | --- |
| 1 | 直した | `dp-steps.answered` を `有効にな\|kxinstall[\s\S]{0,80}?(?:reboot\|再起動)[\s\S]{0,80}?kxapp run` にした（指摘の案のとおり）。箇条書き・番号付きで1行に1手順の答えに当たり、k15-now の「ボードを1回 reboot してやり直し」には当たらない。3つの順がそろわない答え（kxinstall → reboot だけ）は「有効にな」がないと当たらなくなるが、答える試験の質問は送った後の手順を聞くので、fact のとおり3つとも話されるとみた |
| 2 | 直した | `dp-marker` の reveal を「ログを取って保存したとだけ言い、目印のことは言わない」にした。answered（`exited\|目印`）はそのまま |
| 3 | 直した | `script-usage.asked` に `スクリプト\|kx-build\.sh\|mkkximg\|文字以内\|英小文字` を足した。1回目の [256]（アプリの名前の形）に当たる |
| 4 | 直した（案から1語足した） | `dp-image`・`dp-steps` の asked に `前回\|この前\|直近\|実際に\|振り返\|たど\|思い出` を足した。指摘の案に `実際に` を足した。`expect.lastTimeAsked` の頭の言葉（最近・前回・この前・直近・実際に）をすべて入れないと、「実際にデプロイした1回で、やったことを教えてください。」のように lastTimeAsked に当たって asked に当たらない問いが残るため |
| 5 | この組の持ち物でない | BLUEPRINT の 399 行（k15-now を「K-15 は古い」と番号で書く。P1 と食い違う）と 402 行（確かめ B の頼みに「機器（192.168.7.2）」があり、アドレスの基準がない。H8 と standalone.json の C-05 と食い違う）を確かめた。下の「ほかの組に知らせること」に足した |
| 6 | 直した | validate.test.mjs に 3 件を足した（1回目の問い [161]・[184]・[202]・[239]・[247]・[256]・[265]・[274] と、reveal のとおりの答え・箇条書きの答えを、外側の EVAL と同じ `knowledgeTrace` に通す表／lastTimeAsked に当たる問いが dp-image・dp-steps の asked に当たる／答える試験の answered が箇条書きと言い換えに当たり、ほかのナレッジの言い回しに当たらない）。直す前の persona.json に戻すと 3 件とも落ちることを確かめた |
| 7 | 一部を直した | `screen-same.answered` に `このまま\|そのまま` を足した（自分から話すナレッジなので、漏れの判定には使われない）。`script-usage.answered` には、案の `書いてあるとおり\|変えるつもり` を入れず、`(?:とおり\|通り)に使` を足した。「書いてあるとおり」は、1回目の [203]（つまずきの問いへの「特にない。スキルに書いてあるとおりにやれば大丈夫です。」）を新しい漏れにする（当て直して確かめた）。「変えるつもり」は、画面の立場（screen-same）を話すときの自然な言い方（「画面は変えるつもりはない」）で、スクリプトの話でない問いへの答えが漏れになる。`とおりに使` は、案の答えの例に当たり、fact に2回あり、[203] とほかのナレッジの文に当たらない |
| 8 | 直した（決めたこと） | `script-usage` の fact に「決まりかと聞かれて4つの答えから選ぶなら、そのとおりに使っているので「このとおり」。」を足した。根拠：診断 2.2 の5（ユーザー役の答えは「実際は「このとおり」に近い」）と 2.3（出力のフォルダの既定が抜けたことを問題とした）。C6 を入れても、change-read.md の1は「スキルの文が守ることや既定として求めていること」を、--help に出ていても決まりの候補にするので、出力のフォルダの既定などは4つの答えで確かめられうる。FORMAT 2.5 に、立場のナレッジには4つの答えのどれを選ぶかも書く、を足した。ユーザーの指示ではなく診断から決めたので、統括が必要ならユーザーに確かめる |
| 9 | 直していない（後でする） | 前からあるもので、指摘も「後で」としている。H7 をすべての模擬ユーザーに当てると、作る流れの meeting-minutes と training-survey を直す必要があり、この組に示されたファイルと、改善・設計変更の範囲の外になる。前の節の「ほかの組に知らせること」の1つ目のとおり |
| 10 | 直した | FORMAT 2.2 の引用を「（REQ-016、REQ-056）」にした。あわせて、言わないことには answered の言葉をすべて入れること（指摘2）と、asked は lastTimeAsked に当たる問いにすべて当たること（指摘4）を書いた |

変えたファイル：`tests/dev-eval/personas/edl-change/persona.json`、`tests/dev-eval/personas/validate.test.mjs`、`tests/dev-eval/personas/FORMAT.md`（2.2 と 2.5）。validate.mjs と standalone.json は変えていない。

ほかの組に知らせること（足し）：

- BLUEPRINT（`wip/change-plugin/BLUEPRINT.md`）の 402 行も、H8 と食い違う（確かめ B の頼みの文に「機器（192.168.7.2）」があり、基準にアドレス（C-05）がない）。399 行（前の節）とあわせて、持ち主が直す。
- validate.test.mjs が、外側の EVAL の判定（`tests/dev-eval/runner/outer-grade.mjs` の `knowledgeTrace`）を読み込むようになった。この関数の形（`{ persona, exchanges, scope }` を受け、`leaked`・`answered` を返す）を変えるときは、この試験も合わせる。

試験：

- `node --test tests/dev-eval/personas/validate.test.mjs`：70 件すべて合格
- `node tests/dev-eval/personas/validate.mjs`：edl-change、weekly-report、meeting-minutes、training-survey（weekly-report と meeting-minutes は `--all-styles` でも）、heldout の h1 がすべて合格
- `python3 tests/dev-eval/personas/test_dummy_skills.py`：16 件 OK
- 本物の模擬ユーザーを読むランナーの試験（`outer-grade-change.test.mjs` と `outer-change.test.mjs` の「本物」の4件）：合格
- ユーザー役の試験（実際のモデル）は動かしていない。次の外側の EVAL の前に、recall（dp-steps・script-usage・screen-same）と compound（dp-image＋dp-steps）を見る
