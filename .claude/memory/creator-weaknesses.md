# 試験で見つかったクリエイターの弱いところ（まだ直していない）

クリエイターを直すときの材料にする。直したら、この一覧から外す。

## 会話の後半で聞き出した決まりが、EVAL の合否の基準に入らない

- 2026年10月、模擬ユーザー test-ng-pick の外側の EVAL（クリエイター 0.1.0 にアイデア創出スキルを足したブランチ、対話のモデル Claude Opus 5.5）で起きた。
- クリエイターは、いつもと違うときの問いで、会話の後半に「前提条件に恒温槽がある試験項目は、最初に台へ戻す候補にしない」という決まりを聞き出した。
- この決まりは、生成プラグイン ng-repro-pick の作業・検証のエージェント（worker.agent.md、verifier.agent.md）と tests/knowledge.json には入った。しかし EVAL の合否の基準（tests/eval/T-01/eval.json）には入らず、task:cold-chamber が不合格になった。
- 後半に出たことが原因かは確かめていない。0.2.0（main の改善・設計変更の後）でも起きるかは確かめていない。
- plugin-market-place に登録した PR（xclang-brain/plugin-market-place #6）にも、分かっている課題として書いた。
