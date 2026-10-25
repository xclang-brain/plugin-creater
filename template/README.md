# {{plugin_name}}

{{plugin_description}}

## できること

{{slot:readme-what}}

{{plugin_name}} は、GitHub Copilot CLI のプラグインです。作業の設定・開始・監視・結果の確認は、ブラウザーの画面（Web管理画面）で行います。作業は、統括・作業・検証の3種類のエージェントが、計画 → 実行 → 評価 を繰り返して進めます。

## 使い方

初めて使う前に、下の「使うために要る準備」を1回行います。

{{slot:readme-how}}

頼んだ後は、ブラウザーの画面で進めます。

1. チャットに、Web管理画面の URL が示されます。URL には合言葉が入っています。ブラウザーで開きます。この URL は、{{plugin_name}} を動かしているマシンのブラウザーからだけ開けます。
2. 画面で、役割（統括・作業・検証）ごとに使うモデル、エージェントごとの思考の深さ、繰り返しの上限の回数、この作業だけの設定を決めて、開始ボタンを押します。Copilot CLI のモデルが Auto のときは、役割ごとのモデルが効かないことがあります。そのことと、実際に動いたモデルが画面に示されます。
3. 実行中は、画面で、各エージェントの状態と担当、今が計画・実行・評価のどれか、エージェント間のデータの受け渡しを見られます。止めるときは、止めるボタンを押します。
4. 終わったら、画面で、各エージェントの実行結果、検証結果、まとめ、終わった理由、課題の一覧を見られます。

## 使うために要る準備

次の3つを、最初に1回行います。

### 1. インストールする

このリポジトリのフォルダを、手元のマーケットプレイスとして登録してから、プラグインを入れます。

```shell
copilot plugin marketplace add <このリポジトリのフォルダの場所>
copilot plugin install {{plugin_name}}@{{marketplace_name}}
```

- `<このリポジトリのフォルダの場所>` には、このフォルダの絶対パスを書きます。
- Copilot CLI の中では、`/plugin marketplace add <フォルダの場所>` と `/plugin install {{plugin_name}}@{{marketplace_name}}` でも入れられます。
- フォルダを直接指定する入れ方（`copilot plugin install ./フォルダ`）は、Copilot CLI 1.0.102 が「廃止予定」と表示するので、マーケットプレイスを通す入れ方にしています。
- 手元のフォルダのマーケットプレイスから入れたプラグインは、フォルダの中身を直したあと、`/restart` か新しいセッション（Copilot CLI の1つの会話。`/clear` で新しいセッションになります）で反映されます。

### 2. 試験的機能を有効にする

画面を動かす仕組み（エクステンション。Copilot CLI が起動する別のプログラム）は、試験的な機能です（Copilot CLI 1.0.102 の時点）。有効にしないと、{{plugin_name}} は使えません。試験的な機能なので、Copilot CLI の更新で使い方が変わることがあります。

初めて使うときは、`--experimental` を付けて Copilot CLI を起動します。一度付けると設定に残るので、次からは付けなくても有効です。

```shell
copilot --experimental
```

すでに起動しているときは、チャットで次のように打ちます。Copilot CLI が自動で再起動して、有効になります。再起動すると、今の会話は終わります。再起動の後は、まだ信頼していないフォルダでは、フォルダを信頼するかの確認が出て、続けて次の「3. 読み込むときの確認を許可する」の確認が出ます（読み込みの確認は、続けて2回出ることがあります）。

```text
/settings experimental on
```

### 3. 読み込むときの確認を許可する

{{plugin_name}} を読み込むとき、Copilot CLI がチャットに確認を出します。題は `Extension "plugin:{{plugin_name}}:{{plugin_name}}" wants elevated permissions` で、本文は次のとおりです。

```text
This extension wants to: skip tool permission prompts, register hooks, handle permission requests.
Denying will prevent this extension from loading.
```

Copilot CLI 1.0.101 から、この確認は必ずあなたに出ます。許可を自動で判定する設定（Assisted の許可）を使っていても、自動では許可されません。

確認の意味は次のとおりです。

- `skip tool permission prompts`（ツールの許可の確認を省く）：{{plugin_name}} の記録のツールは、確認なしで動きます。画面に出す状態を書くだけで、ファイルやコマンドなど外を変えません。
- `register hooks`（フックを登録する）：止めた実行のエージェントのツールと、統括エージェントに許していないツール（ファイルの書き込みやコマンドなど。統括は、それらを作業エージェントに頼みます）を拒むために、Copilot CLI の「ツールを使ってよいか」の問い合わせを受けます。
- `handle permission requests`（許可の求めを扱う）：エージェントの許可の求めを見て、画面に「チャットで確認を待っています」と示します。{{plugin_name}} は許可の求めに答えません。許可も拒否も、あなたがチャットで行います。

許可する理由は、断ると読み込まれず、画面で開始も監視もできないからです。選び方は次のとおりです。

| 選択肢 | 意味 |
| --- | --- |
| Yes | 今回だけ許可します。Copilot CLI を起動するたびと、`/clear` のたびに、また確認が出ます |
| Yes, and always allow "plugin:{{plugin_name}}:{{plugin_name}}" in this directory（後ろにフォルダの場所が付きます。作業フォルダが Git のリポジトリのときは、`in this directory` の代わりに `in this repo` と出ます） | このフォルダでは常に許可します。このフォルダでは、次から確認が出ません（`/clear` の後も、起動し直しても）。ほかのフォルダでは、また出ます |
| Yes, and don't ask again for "plugin:{{plugin_name}}:{{plugin_name}}" this session | フォルダが分からないときに、上の選択肢の代わりに出ます。このセッション（Copilot CLI の1つの会話。`/clear` で新しいセッションになります）の間は、確認が出ません |
| No (Esc) | 断ります。{{plugin_name}} は読み込まれません |

初めて使うときと、`/settings experimental on` で再起動した後は、フォルダを信頼するかの確認の後に、この確認が続けて2回出ることがあります。

## 実行中に気をつけること

- 実行中は `/clear` を使わないでください。`/clear` をすると、画面の更新が止まり、前の画面の URL では開けなくなります。そのときは、チャットでもう一度作業を頼み、示された画面を開くと、前の実行が途中で切れたことが示されます。
- 実行中の確認には、チャットで答えます。ファイルの書き込みやコマンドの実行の許可、AI クレジットの上限の確認、エージェントからの質問が、チャットに出ます。画面には、チャットで確認を待っていることと、何の確認かが示されます。画面からは答えられません。
- 統括エージェントが、あなたの判断を求めることがあります（{{plugin_name}} を作るときに決めた場面だけです）。そのときは、画面に「人の判断待ち」と質問が出て、チャットにも同じ質問が出ます。チャットで答えると、答えがそのまま統括エージェントに渡り、同じ実行が続きます。待っているあいだも、実行は終わりません。止めるボタンで止められます。
- 止めた後、チャットに確認が残っていることがあります。その確認には、「Yes」と答えても「No」と答えても、ツールは動きません。
- 止めきれなかったエージェントがいるときは、画面にそのエージェントと止め方（チャットで Esc を2回押す、または Copilot CLI を終える）が示されます。

### 任せたいツールを前もって許可する

確認のたびにチャットに戻る手間を減らすには、Copilot CLI を起動するときに、任せたいツールを `--allow-tool` で指定します。指定は、その起動の間だけ有効です。

| 指定 | 許可するもの |
| --- | --- |
| `copilot --allow-tool=write` | ファイルの書き込み |
| `copilot --allow-tool='shell(git:*)'` | `git` のコマンド |
| `copilot --allow-tool='read, write'` | ファイルの読み取りと書き込み（複数は、引用符で囲んで、カンマで区切ります） |
| `copilot --allow-tool='shell(git:*)' --deny-tool='shell(git push)'` | `git push` 以外の `git` のコマンド |

すべてを任せる指定（`--allow-all-tools`、`--allow-all`、`--yolo`）もあります。公式のドキュメントは、隔離した環境でだけ使うよう強く勧めています。

## うまく始まらないとき

チャットで作業を頼んでも画面の URL が示されないときは、{{plugin_name}} のエクステンションが読み込まれていません。次のどれかです。

- 試験的機能を有効にしていない：`copilot --experimental` で起動し直します。すでに起動しているときは、チャットで `/settings experimental on` と打ちます（自動で再起動します）。
- 読み込むときの確認を断った：Copilot CLI を起動し直して、出た確認を許可します。選び方は「3. 読み込むときの確認を許可する」にあります。
- エクステンションを使わない設定（`/extensions mode` の Disabled）にしている：`/extensions mode` で Load & Augment か Load Only に戻します。Disabled は、次に Copilot CLI を起動したときにも残ります。

## 課題の一覧と Issue の起票

終わった後の画面に、課題の一覧と、{{plugin_name}} 自身を改善するための Issue の案が並びます。案ごとの承認ボタンを押すと、その案が {{plugin_name}} 自身の GitHub リポジトリに Issue として起票されます。承認していない案は起票されません。

起票できるようにするには、次の手順を行います。起票できないときも案は並び、この手順が画面に示されます。

1. {{plugin_name}} を GitHub に公開します。
2. `plugin.json` の `repository` に、そのリポジトリの URL（例：`https://github.com/OWNER/REPO`）を書きます。そのあと、手元のフォルダのマーケットプレイスからインストールしたときは、Copilot CLI を終了して起動し直すか、`/clear` で新しい会話を始めます。GitHub からインストールしたときは、直した `plugin.json` を GitHub に送り、次のコマンドで {{plugin_name}} をアンインストールしてから、もう一度インストールします。

   ```shell
   copilot plugin uninstall {{plugin_name}}
   copilot plugin install {{plugin_name}}@{{marketplace_name}}
   ```

3. `gh`（GitHub の公式のコマンド）を入れて、ログインします。

   ```shell
   gh auth login
   ```

## 試験

構造の検査と部品の試験は、リポジトリの1つのコマンドで動かせます。モデルを使わないので、AI クレジットを使いません。plugin-creator を入れていなくても動きます。

```shell
python3 tests/run.py
```

- 最初に、試験に要る道具がそろっているかを確かめ、足りなければ足りない道具を示して止まります。
- 段階ごとの合否と、不合格の試験とその理由が出ます。同じ内容がファイルにも書かれ、終了コードでも合否が分かります。
- {{plugin_name}} を直した後も、同じコマンドで試験をやり直せます。

EVAL（実際のモデルで課題を実行して採点する試験）は、plugin-creator を入れた Copilot CLI で、{{plugin_name}} の試験を頼むと行われます。`tests/eval/` の課題と合否の基準を使います。AI クレジットを使うので、始める前に、実行の回数と使う AI クレジットの見込みが示されます。よいと答えてから始まります。

## 同梱しているフォント

Web管理画面の文字は、同梱の IBM Plex Sans JP（標準と太字）で表示します。

- 場所：`com.github.copilot/extensions/{{plugin_name}}/ui/static/fonts/ibm-plex-sans-jp/`
- 著作権：Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"
- ライセンス：SIL Open Font License 1.1。全文は、同じ場所の `OFL.txt` にあります。
- フォントのファイルは、IBM が配っているもの（npm の `@ibm/plex-sans-jp` 3.0.0）を、変えずに入れています。
