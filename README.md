# plugin-creator

Copilot CLI のプラグインを生成するプラグインです。あなたに作業の手順やルールを質問し、その答えを組み込んだプラグインを生成します。プラグインにするアイデアを作ることもできます（[アイデアを作る](#アイデアを作る)）。

## 始め方

1. インストールします。

   ```text
   /plugin marketplace add xclang-brain/plugin-creator
   /plugin install plugin-creator@plugin-creator
   ```

2. 実験的機能を有効にします。

   ```text
   /settings experimental on
   ```

3. チャットに「〇〇の作業を自動化するプラグインを作って」と入力します。

## 生成までの流れ

1. plugin-creator が、plugin-creator の画面の URL をチャットに示します。ブラウザーで開くと、質問で決まったことの一覧を見られます。
2. plugin-creator の質問に、チャットで答えます。
3. plugin-creator が、生成の前に、決まったことのまとめを示します。直したいところを伝え、よいと答えます。
4. plugin-creator が、Copilot CLI を起動したフォルダの中に、新しいフォルダを作り、そこにプラグインを生成します。

生成したプラグインのインストールのしかたは、そのフォルダの `README.md` にあります。

## 今あるプラグインを直す

手元のプラグインに、機能を足したり、設計を変えたり、要らない機能を消したりできます。plugin-creator が生成していないプラグインも直せます。新しいフォルダは作らず、そのプラグインのフォルダを直します。

始める前に、次の2つを済ませます。

- プラグインのフォルダを git のリポジトリに入れ、フォルダの中のファイルをすべてコミットします。
- プラグインのフォルダか、それを含むフォルダで、Copilot CLI を起動します。

インストールしたプラグインの写しは直せません。元のリポジトリを手元に clone し、そのフォルダを直します。

1. チャットに「〇〇のフォルダのプラグインに、〇〇を足して」と入力します。`/plugin-creator:change-plugin` と入力しても始められます。
2. plugin-creator が、plugin-creator の画面の URL をチャットに示します。
3. plugin-creator の質問に、チャットで答えます。
4. plugin-creator が、直す前に、引き継ぐこと、変わること、新しいバージョン番号の案を示します。直したいところを伝え、よいと答えます。
5. plugin-creator が、フォルダを直し、直した内容をコミットします。push はしません。
6. plugin-creator が、直す前に戻すコマンドと、直したプラグインを Copilot CLI に読ませ直すやり方を示します。

## モデルの選び方

- 質問と、生成の中の判断は、あなたが `/model` で選んだモデルで行います。思考力の高いモデルが向いています。
- 生成したプラグインのファイルを書く仕事は、費用の低いモデル（GPT-6 Luna か Claude Haiku 5.5）で行います。ただし、モデルが Auto のときは、Auto が選んだモデルで行います。

## 生成したプラグインを試験する

| 試験 | 確かめること | 動かし方 |
| --- | --- | --- |
| 構造の検査 | ファイルの置き場所と書き方が、公式仕様に沿っているか | 生成したプラグインのフォルダで `python3 tests/run.py` |
| 部品の試験 | スクリプトや画面が動くか | 上と同じ |
| EVAL | 実際のモデルで課題を実行し、採点する | チャットに「作ったプラグインを試験して」と入力 |

- 構造の検査と部品の試験は、生成の直後に plugin-creator も行います。AI クレジットを使いません。
- EVAL は AI クレジットを使います。plugin-creator は、始める前に使う量の見込みを示し、あなたがよいと答えてから始めます。

## アイデアを作る

プラグインにするアイデアがまだないときは、チャットに「〇〇で使えるプラグインのアイデアを考えて」と入力します。`/plugin-creator:make-idea` でも始められます。

1. plugin-creator が、アイデアを考える範囲（目的、対象、必ず満たす条件など）を質問します。チャットで答えます。
2. plugin-creator が、始める前に、起動するエージェントの数の見込みを示します。チャットに「続けて」と入力すると、世の中の作品を Web で調べ、評価されている理由を分析し、それらを掛け合わせて案を作ります。
3. plugin-creator が、壁打ちを通った案の一覧を示します。説明してほしい案の番号を答えると、良さが伝わる説明を書きます。
4. plugin-creator が、この回で学んだことの候補を示します。残したくない候補の番号を答えると、残りを次の回のために残します。

作ったアイデアでプラグインを作るときは、`/clear` してから、作りたいものを自分の言葉で頼みます。

アイデアを作るときのデータは、次のフォルダに置きます。

```text
~/.plugin-creator/make-idea/
  params.json   調べる数やエージェントの数（書き換えると、次の回から使われます）
  knowledge/    たまった知識・経験（次の回のすべての手順で使います）
  runs/         回ごとの記録と、アイデアの説明
```

- このフォルダは作業フォルダの外にあるので、初めて読み書きするときに、Copilot CLI がフォルダの使用の確認を出します。前もって `/add-dir <このフォルダの絶対パス>` と入力すると、フォルダの使用の確認は出ません。
- Web のサイトから取得するたびに、Copilot CLI が確認を出します。
- 数を大きくするほど、AI クレジットを使います。
- 記録には、あなたの業務の中身が入ることがあります。外には送りません。自動では消えないので、要らなくなったらフォルダを削除します。削除すると、たまった知識・経験と、書き換えたパラメーターも消えます。

## 読み込むときの確認

plugin-creator を読み込むとき、Copilot CLI がチャットに次の確認を出します。

```text
Extension "plugin:plugin-creator:plugin-creator" wants elevated permissions
This extension wants to: skip tool permission prompts, register hooks.
```

許可すると、plugin-creator は次のことをします。

- `skip tool permission prompts`：画面を開くツール、決まったことを記録するツール、Word・Excel・PowerPoint の文書を読むツールを、確認なしで使います。
- `register hooks`：質問と答えを、手元のファイルに記録します。会話が自動で要約された後に、AI に手順を読み直させます。

| 選択肢 | 選ぶと起きること |
| --- | --- |
| Yes | 今回だけ許可します。次に起動したときと `/clear` の後に、また確認が出ます |
| Yes, and always allow ... in this directory | このフォルダでは、次から確認が出ません。Git のリポジトリでは `in this repo` と出ます |
| No (Esc) | plugin-creator は動きません |

## 質問と答えの記録

plugin-creator は、質問と答えを、次のフォルダに記録します。記録には、あなたの作業の中身が入ります。外には送りません。自動では消えないので、要らなくなったらフォルダを削除します。

```text
~/.copilot/plugin-data/plugin-creator/hearings/
```

## うまく始まらないとき

チャットで頼んでも plugin-creator の画面の URL が出ないときは、次のどれかです。

- 実験的機能が有効でない：`/settings experimental on` と入力します。
- 読み込むときの確認で No を選んだ：`/clear` と入力し、もう一度出た確認で許可します。
- `/extensions mode` が Disabled になっている：`/extensions mode` で Load & Augment に戻します。

## 会話例

plugin-creator と、AI が演じたユーザーとの会話の例は、[examples/weekly-report.md](examples/weekly-report.md) にあります。
