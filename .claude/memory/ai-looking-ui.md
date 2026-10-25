# AI が作ったと分かる画面の特徴

開発者が、生成プラグインの Web管理画面を「いかにも Claude が作成したっぽい見た目」と言った。Claude で作ったと分からない見た目にしたいため、AI が作った画面の癖を調べた（2026年10月）。

## Anthropic 自身が挙げている癖

- 出典は、Anthropic の公式の文書である。
  - frontend-design スキル：https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md
  - Claude のプロンプトの手引き（Opus 4.8）：https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-4-8
  - ブログ「Improving frontend design through Skills」（2025-11-12）：https://claude.com/blog/improving-frontend-design-through-skills
- AI 全般の癖：
  - フォント：Inter、Roboto、Arial、Open Sans、Lato、OS の標準フォント（`system-ui`）。
  - 色：白地に紫のグラデーション。真っ黒の代わりに少し色の付いた黒（#0B0B0B など）。
  - 形：全部の枠が同じ大きさの角丸。どの箱にも同じ薄いグレーの影。
  - 並べ方：同じ形のカードに切り分けて並べる。中央寄せの大見出しの下に、カードを3つ。細い罫線で角丸なしの新聞風も、定番の1つ。
  - 飾り：リンクやボタンの文字の後ろの「→」。小さな札に等幅のフォント。全部大文字で字間を広げた小見出し。
- Claude だけの癖：クリーム色の背景（#F4F1EA 付近）、明朝風（セリフ体）の見出し、赤茶の差し色（#D97757 付近。Anthropic 自身の色）。

## 気をつけること

- フォントを `system-ui` で指定すると、OS の標準フォントになる。それ自体が、AI の癖の1つに当たる。
- スクリーンショットは、撮る環境のフォントで描かれる。このクラウド環境では、`system-ui` が、英数字は Inter、日本語は中国語向けの WenQuanYi Zen Hei になった。開発者の PC での見え方とは違う。見本の画像を見せるときは、使うフォントを同梱して撮る。
- ピル型の札が AI の癖だと書いた資料は、見つけていない（確かめていない）。
