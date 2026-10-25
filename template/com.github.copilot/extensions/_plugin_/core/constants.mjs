// 中心の処理の定数。数値は設計書（docs/design/generated-plugin-structure.md）の「例」の値をそのまま使う。

export const LIMITS = Object.freeze({
  // Copilot CLI の呼び出しを待つ時間の上限（6.1）
  CALL_TIMEOUT_MS: 10_000,
  // 止めるを押してから、止まっていないと決めるまでの時間（4.4）
  STOP_DEADLINE_MS: 8_000,
  // 止まったかを取り直す間隔（試験で時計を進めやすい値）
  STOP_POLL_MS: 250,
  // gh を待つ時間の上限（4.11）
  GH_TIMEOUT_MS: 60_000,
  // 起票中のまま、この時間が過ぎた印は「起票したか分からない」と読む（4.11）
  FILING_STALE_MS: 5 * 60_000,
  // 生きている印を書く間隔と、古いと見なす時間（6.5）
  ALIVE_INTERVAL_MS: 5_000,
  ALIVE_STALE_MS: 30_000,
  // 断られた記録のやり直しの上限（4.8）
  RETRY_LIMIT: 3,
  // イベントがないエージェントを課題にする時間（4.10）
  STALL_MS: 5 * 60_000,
  // 同じツールを同じ引数で続けて呼んだ回数がこれ以上なら課題にする（4.10）
  REPEAT_COUNT: 3,
  // 記録を残す実行の数（6.5）
  KEEP_RUNS: 20,
  // 画面に出す最後の返事の要約の長さ
  REPLY_SUMMARY_CHARS: 160,
  // 起票の前に探す Issue の数（4.11）
  GH_LIST_LIMIT: 100,
});

// 実行の状態（6.1）
export const ACTIVE_STATUSES = Object.freeze(['starting', 'running', 'summarizing', 'stopping']);

// 思考の深さの選択肢（4.6）。公式のコマンドリファレンスの --effort の値。選ばない（''）ときは上書きしない
export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

// 画面の文字になる決まった文（REQ-007 の文言）
export const AUTO_NOTICE = 'Auto のため、役割ごとのモデルが効かないことがあります';
export const OVERRIDE_NOTICE =
  '実行が終わると、このチャットでほかのエージェントに設定したモデルと思考の深さの指定も消えます。';
export const CLEAR_NOTICE = '実行中は /clear を使わないでください。実行が途中で切れます。';
export const CHAT_CONFIRM_NOTICE =
  '実行中にエージェントが確認（ツールの許可、AI クレジットの上限、質問）を求めたときは、このチャットで答えてください。画面には、確認を待っていることが出ます。';
// 実行中にまた作業を頼まれたとき、画面を開くツールの知らせに足す文。新しい頼みは受け付けない。
export const BUSY_NOTICE =
  'いまの実行が終わるまで、新しい作業は始められません。今の画面で実行の様子を見られます。変えた作業を頼むときは、画面で止めてから、もう一度チャットで頼んでください。';
// 統括への指示文の始めの 1 文。作ることは作業エージェントに、確かめることは検証エージェントに任せさせる。
export const INSTRUCTION_HEAD =
  'あなたの定義の手順で、この実行を進めてください。成果物は作業エージェントに、確かめは検証エージェントに、`task` で頼みます。';
export const UNSTOPPED_HOW_TO =
  'チャットで Esc を2回押すか、Copilot CLI を終えてください。';
export const DISCONNECTED_MESSAGE = '画面とのつながりが切れたので、作業を終えてください。';
export const STOPPED_MESSAGE = 'この実行は止められました。ツールは使えません。作業を終えてください。';

export const ROLE_LABELS = Object.freeze({
  orchestrator: '統括エージェント',
  worker: '作業エージェント',
  verifier: '検証エージェント',
});

export const PHASE_LABELS = Object.freeze({ plan: '計画', do: '実行', study: '評価' });

// 終わった理由のうち「途中で終わった」の理由（detail）の説明。画面は自分で日本語にするが、課題の文に使う。
export const ABORT_REASON_TEXT = Object.freeze({
  credit_limit: 'AI クレジットの上限',
  chat_interrupted: 'チャットから中断された',
  orchestrator_failed: '統括エージェントの失敗',
  orchestrator_ended: '繰り返しを終えないまま統括エージェントが終わった',
  retry_limit: '記録のやり直しが上限を超えた',
  cut_off: '途中で切れた',
  extension_restarted: 'エクステンションが再起動した',
});
