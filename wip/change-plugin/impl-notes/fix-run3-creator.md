# 3回目の直し：クリエイター（creator グループ）の作業メモ

作業の途中のメモである。診断：`wip/change-plugin/runs/outer-change-3-diagnosis.md`。点検済みの指摘（verifier の better_fix を優先）：screen-url-shown、english-notes、quality-rule-skills、quality-k23-exception。決め：D44（make-plugin の SKILL.md 本文は変えない）。

## 担当ファイル

skills/change-plugin/**、skills/make-plugin/references/rules.md、com.github.copilot/agents/reader.agent.md、com.github.copilot/agents/worker.agent.md、com.github.copilot/extensions/plugin-creator/**、tests/creator/extension/**、docs/design/hearing.md、docs/design/creator-structure.md

## 進み具合

| 直し | 状態 | メモ |
| --- | --- | --- |
| (1) screen-url-shown | 済み：SKILL.md 始まりの手番3（open だけ、URL の1行を次のツールの前に）・4（state と記録の分かれ）、赤信号の行、change-start.md の2（流れの文を消す）・7（条件のない確かめと流れの例）・9（関門を消す）、creator.mjs の open の返り値（1行目 URL、2行目モデル向け）、descriptions.mjs の open、hearing.mjs の change の返り値（2行目に流れの促し）、state.test.mjs・record-tools.test.mjs、hearing.md 3.1・3.4・7.5・10.5、creator-structure.md 4.3 | 流れは change-start.md の7の1か所（統括の指示）。better_fix の「流れの例は SKILL.md」は採らず（outer-grade.mjs の注記も change-start.md の7を指す）。open の返り値に「見えません」は書かない（better_fix）。画面に1行で出る（hearing.md 2.5）ので1行目を URL の行にした |
| (2) english-notes | 済み：SKILL.md 決まり7（英語の例を消し、すべきことの形。別の言語の例外は残す）、change-apply.md の初め（1行）と2（作業エージェントへの頼みの前の一言の例）、change-read.md の1（読み取り役への頼みの前の一言）、hearing.md 3.4・10.5 | 記録のツールの返り値には足さない（ユーザーが別の言語のとき合わない）。make-plugin の SKILL.md は変えない（D44）。change-confirm.md は 20KB の余りがなく足していない |
| (3) quality-rule-skills | 済み：reader.agent.md（同じファイルの2か所の決まりを1つの候補に。返す形に2か所目の引用）、worker.agent.md のルールのスキル（番号の文は1回、合否の決め方の包みの言葉は書かない、人に聞く文も止めて示す形）、hearing.md 9章、creator-structure.md 3.4 | 「1つの決まりは1つのスキルだけ」は足さない（better_fix）。stage1 の見張り（better_fix の4）は template の持ち物なので、統括へ |
| (4) quality-k23-exception | 済み：make-plugin/references/rules.md の「そうしないときもある」の行、worker.agent.md の verifier-task の行、hearing.md 6.1、creator-structure.md 3.5 | scaffold.py は変えない（better_fix） |
| 試験 | 済み：`python3 tests/creator/check_creator.py` 合格、`python3 -m unittest tests/creator/test_check_creator.py` 30 件 OK、`node --test tests/creator/extension/*.test.mjs` 265 件合格 | SKILL.md 本文 4,603 トークン。references：change-apply 19,929、change-confirm 19,949（変えていない）、change-read 13,029、change-start 7,427 バイト。rules.md 3,125 バイト |

## change-apply.md を 20,000 バイト未満に収めるために削ったこと

- 2：「決まりの文はルールのスキルにだけ書き、作業・検証のエージェントの作業ごとの指示には、スキルの場所と番号だけを書く」（worker.agent.md の書き方の決まりと orchestrator-task の行に同じことがある）。これを指していた stage1 の行の「上の書き方」は、「スキルの場所を `<プラグインのフォルダ>/skills/<名前>/SKILL.md` の形に」に書き換えた。
- 2：流用する資産の「書き換えない。合わないときは…」と「ファイルを消さないこと」（どちらも worker.agent.md の B・D にある）。

## 診断・better_fix からのずれ・決めたこと

1. 流れの例は SKILL.md に残さず、change-start.md の7に置いた（統括の指示「1か所だけ」）。better_fix は hearing.md:858 の理由で SKILL.md に残すとしたが、その理由（URL を書いた後に読み飛ばされる）は URL と流れを結び付けていたときのもので、今は結び付けない。7は記録を作った直後で、`change` の返り値の促しのすぐ後に来る。試験の仕組みの outer-grade.mjs の注記も change-start.md の7を指している。
2. change-start.md の9の関門（流れを書いていなければ進めない）は、7と同じことの2か所目なので消した。2の「直すと答えたら7の流れを書く」も消した（7が条件なしで拾う）。
3. open の返り値は、1行目を「plugin-creator の画面：<URL>」、2行目をモデルへの頼みにした。hearing.md 2.5 に「エクステンションのツールの返り値は、ユーザーの画面に1行で出る」とあるので、ユーザーに見える1行目を、ユーザーが読んでも分かる行にした。「見えません」とは書かない（better_fix）。outer-grade.mjs の URL_IN_TEXT は改行で切れるので、そのまま URL を取れる。
4. `change` の返り値（新しく記録を作ったときだけ）の2行目に、流れをまだ書いていなければ次のツールの前に書くよう促す。作っていないプラグインでは「（作っていないプラグインのときの流れ）」を添える。
5. 英語の一言：記録のツールの返り値には足さない（better_fix の (b) は「足すなら言語で分ける」）。言語を見分ける仕組みを足さないため（KISS）。
6. quality-rule-skills の better_fix の3（画面や人に聞く文をルールのスキルに入れる前に書き直す）は、人に聞くことだけを worker.agent.md に足した。作業の画面の値は、change-confirm.md の C17 で「頼みや画面に〇〇がなければ」の形に記録し、change-apply.md の2で書き方を渡す今の設計（creator-structure.md 3.4）があるので、変えていない。
7. quality-rule-skills の better_fix の4（stage1 の見張り。template/tests/stage1/check_structure.py）は、この組のファイルではないので行っていない。
8. quality-k23-exception の例は、模擬ユーザーの値（gdb、-O2）を避け、「〇〇は△△にする。ただし□□のときは◇◇でよい」にした。

## ほかの組・統括に知らせること

- 試験の仕組み：open の返り値の文が変わった（1行目「plugin-creator の画面：<URL>」、2行目「この1行を、ほかのツールを呼ぶ前に、そのままチャットの文に書いて、ユーザーに示してください。」）。outer-grade.test.mjs・outer-grade-change.test.mjs の作りものの返り値は前の文のままでも試験は通るが、合わせるなら直す。`change` の返り値（新しい記録）に2行目（流れの促し）が付いた。流れの例は change-start.md の7にある（`isFlowText` の注記と同じ）。
- 統括：stage1 の見張り（ルールのスキルの「作業の画面」「人に聞く」、多くの決まりに共通の文を rule_sentences から外す）は template の持ち物。RESUME.md の D43 に「ルールのスキルには『<場合> のときは』『ほかの場合は当てはまらないので合格とする』を書かず、当てはまる場合はスキルの初めに1回書く（worker.agent.md）」を足すとよい。
- make-plugin の SKILL.md は変えていない（D44）。open の返り値の変更は make-plugin と test-plugin にも効く。

## 点検（2回目）の指摘 1〜8 の直し

統括から、3回目の直しへの点検の指摘 1〜8 を受けた。1つずつ確かめ、直したもの・断ったものと理由を書く。

| 指摘 | 状態 | メモ |
| --- | --- | --- |
| 1 K-23 の例外（種類を後で変える流れ） | 済み：hearing.mjs の record の返り値（種類か例外を渡して例外のある合否の決め方になった行に、同じ行で促す）、record-tools.test.mjs 2件、change-confirm.md の「<場合> のときは」の行（例外があれば〜に書く。「書類の種類」を削って 19,979 バイト）、hearing.md 6.1・6.3・7.5、creator-structure.md 3.5。confirm.md:14 は統括へ | 確かめた：[147] それ以外、[255] 例外だけ、[376] 種類を変えて文から例外が落ちた（confirm.md と change-confirm.md を [363][365] で読んだ直後） |
| 2 ルールのスキルの「<場合> のときは」 | 済み：worker.agent.md のルールのスキル（「ほかの場合は…合格とする」は書かない。「<場合> のときは」は、その場合だけのスキルなら初めに1回、ほかの場合も受け持つスキルでは残す）、creator-structure.md 3.4 | 確かめた：3回目の log-insertion-rules/SKILL.md は機器を問わず、K-08（printf）と KX-200 だけの K-18 が同じスキルにある |
| 3 verifier-task の例外と「場所と番号だけ」 | 済み：worker.agent.md の verifier-task の行（ルールのスキルで確かめる決まりは場所と番号に「例外も含めて見る」と添え、例外の文は写さない。例外もそのスキルにだけ書く。ルールのスキルにない合否の決め方だけ、例外のときの合格を書く）、creator-structure.md 3.5 | 確かめた：check_structure.py の check_standalone は、knowledge.json の文を1文ずつ、ルールのスキルとほかの場所の両方にあれば落とす |
| 4 英語の一言の測り方 | 済み（測り方だけ）：測り方を hearing.md 3.4 に書いた（3回以上の回し直しで、ツールの前の一言のうち英語の割合を見る）。思い出させる文は足さない | 確かめた：思い出させる文が書く直前にあるのは change-read.md の1と change-apply.md の2だけ。[152][162] は日本語の返り値のすぐ後でも英語だったので、返り値に足しても効くとは言えない（better_fix (b) の言語で分ける1文は、言語を見分ける仕組みが要り KISS に反する）。change-apply.md は 71 バイトしか余りがない。割合の数え方は試験の仕組みの持ち物なので統括へ |
| 5 make-plugin の「流れは URL と一緒に」 | 済み（この組の分）：hearing.md 3.1 を「URL を示した後、最初の問いより前に」にした。make-plugin/references/start.md の3は統括へ | 確かめた：make-plugin の SKILL.md の始まりの手番2で URL を示し、start.md の3が「URL と一緒に」。open の返り値が URL を先に書かせるので、一緒には書けない |
| 6 open の返り値・説明の言い方 | 済み：creator.mjs の open の2行目を「上の1行（plugin-creator の画面：…）だけを、…」、descriptions.mjs の open を「始めに呼ぶ。ほかのツールと同じ応答では呼ばず、…」、state.test.mjs の正規表現、hearing.md 3.1・creator-structure.md 4.3 | |
| 7 返り値がユーザーに見えるか | 済み：change-plugin/SKILL.md の始まりの手番3を「URL はチャットの文で示さないとユーザーに届かないので」、hearing.md 3.4 を「返り値は画面に1行で出るだけで（2.5）、チャットの文で示さないとユーザーに届かなかった（3.1）」、state.test.mjs の注記 | hearing.md 2.5（実測：画面に1行で出る）に合わせた。2.5・3.1 の「1行目は見ても分かる行にする」はそのまま |
| 8 試験の仕組みの試験（ほかの組） | この組では直さない（ほかの組の持ち物）。統括へ | open の返り値の2行目がまた変わった（「上の1行（plugin-creator の画面：…）だけを、…」） |

### 試験（2回目の直しの後）

- `python3 tests/creator/check_creator.py` 合格。`python3 -m unittest tests/creator/test_check_creator.py` 30 件 OK。`node --test tests/creator/extension/*.test.mjs` 267 件合格（record-tools.test.mjs に2件足した）。
- 大きさ：change-plugin の SKILL.md は 17,419 バイト（本文は check_creator.py の 5,000 トークン以内で合格）。change-confirm.md 19,979、change-apply.md 19,929（変えていない）。

### 決めたこと（2回目）

1. 指摘1の直しは、統括の案のうち「返り値で促す」を主にした。種類を「合否の決め方」に変える手順は make-plugin の confirm.md:14 と change-confirm.md の2か所にあり、どちらで変えても同じ `record` を通るので、1か所で両方に効く。促すのは、その記録で種類か例外を渡し、結果が例外のある合否の決め方（外したものを除く）になった行だけ。文だけの直しでは促さないので、直した後に繰り返さない。返り値は1行のまま（REQ-024 の試験の「1行」の形を保つ）。文に例外が入っているかは機械では分からないので、「書かれていなければ」と条件にした。
2. change-confirm.md は「（例外があれば、それも〜に書く）」だけを足し、余りを作るため例の「書類の種類」を削った（hearing.md 6.3 には残す）。
3. 指摘3で、ルールのスキルにない合否の決め方（作業の定義の基準だけにあるもの）には、今までどおり例外のときの合格を検証の指示に書かせる。構造の検査はルールのスキルの文の写しだけを見るので、こちらは落ちない。
4. 指摘4は、思い出させる文を足さない。足す場所の候補（返り値、change-apply.md の4）は、3回目の記録で効くと言えず、change-apply.md の余りもない。測り方だけを決めた。
5. 指摘7は、実測（hearing.md 2.5「画面に1行で出る」）に合わせ、「見えない」を「チャットの文で示さないと届かない」にした。

### ほかの組・統括に知らせること（2回目）

- 統括：`skills/make-plugin/references/confirm.md` の2の「合格の条件」（基準の案の種類を「合否の決め方」に変える文）に、「種類を変えるナレッジに例外があれば、文を、例外のときに何なら合格かを書いた形に直す（rules.md と同じ）」を足すとよい。record の返り値でも促すようにした（この組で済み）。
- 統括：`skills/make-plugin/references/start.md` の3「画面の URL と一緒に、最初の問いより前に」を「画面の URL を示した後、最初の問いより前に」に（hearing.md 3.1 は直した）。references なので D44 には当たらない。
- 統括：RESUME.md の D43 の言い方を合わせる。「ルールのスキルには『ほかの場合は当てはまらないので合格とする』を書かない。『<場合> のときは』は、その場合だけのスキルなら初めに1回、ほかの場合も受け持つスキルでは残す（worker.agent.md）」。
- 試験の仕組み：open の返り値の2行目が「上の1行（plugin-creator の画面：…）だけを、ほかのツールを呼ぶ前に、そのままチャットの文に書いて、ユーザーに示してください。」に変わった。指摘8のとおり、outer-grade.test.mjs・outer-grade-change.test.mjs の作りものの返り値をこの2行に替え、改行の後ろが URL に入らないことを試すとよい。record の返り値は、例外のある合否の決め方になった行があるときだけ、同じ行の終わりに促す文が付く。
- 試験の仕組み：英語の一言は、回ごとの件数でなく、ツールの前の一言（creator.text）のうち英語の割合で出し、3回以上の回し直しで見る（hearing.md 3.4）。
