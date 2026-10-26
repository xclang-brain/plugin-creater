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
export const ACTIVE_STATUSES = Object.freeze(['starting', 'running', 'waiting_human', 'summarizing', 'stopping']);

// まとめ中に入って終わる、終わった理由（4.8、4.15）。統括がまとめと Issue の案を作る
export const SUMMARY_END_KINDS = Object.freeze(['all_passed', 'max_iterations', 'human_ended']);

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

// 人の判断待ち（4.15）の決まった文
// 統括が質問を記録したときに返す文。決まった形の返事を書いて手番を終えさせる（入口のスキルが、この形で質問を見つける）
export const ASK_RECORDED_MESSAGE =
  '質問を記録しました。画面に「人の判断待ち」として出ています。ほかのツールを呼ばずに、返事の1行目に「人の判断待ち」と書き、2行目から同じ質問を書いて、手番を終えてください。この実行は終わりません。ユーザーがチャットで答えると、答えがメッセージで届くので、それに沿って続けてください。';
// 統括に送る文の始め。この後に、質問と答えを付ける
export const ANSWER_HEAD =
  '人の判断の答えが届きました。答えに沿って、この実行の手順を続けてください。試行の番号と記録は、待つ前の続きです。答えが、いまここで終えるよう言っているときは、あなたの定義の「人の判断を求めるとき」のとおりに、ほかの記録やエージェントの呼び出しより先に、endedByHuman を true にして、まとめに進んでください。後で終えるよう言っているときは、いまは続けて、その時が来たら、終えるかをもう一度聞いてください。';
export const ANSWER_DELIVERED_MESSAGE =
  '答えを統括エージェントに渡しました。統括エージェントが、同じ実行で、答えに沿って進めます。いまここで終えるよう答えたときは、まとめと Issue の案を作ってから終えます。後で終えるよう答えたとき（例：「あと1回だけ試して、だめなら終えて」）は、その時が来たら、終えるかをもう一度聞きます。ユーザーにそう伝えて、手番を終えてください。';
export const ANSWER_NOT_DELIVERED_MESSAGE =
  '答えを統括エージェントに渡せませんでした。この実行は「途中で終わった」で終わります。結果は画面で見られます。ユーザーにそう伝えて、手番を終えてください。作業を自分で続けないでください。';
export const ANSWER_UNKNOWN_MESSAGE =
  '答えを統括エージェントに渡せたか、分かりませんでした（時間切れ）。ユーザーに、画面の実行の状態がまだ「人の判断待ち」のままなら、もう一度チャットで答えるか、画面で止めるよう伝えてください。';
export const ANSWER_ALREADY_DELIVERED_MESSAGE =
  '前に渡した答えが、統括エージェントに届いていました。統括エージェントは続きを始めていて、同じ実行が続きます。今回の答えは渡していません。ユーザーにそう伝えて、手番を終えてください。'
export const NOT_WAITING_MESSAGE =
  'いまは、統括エージェントは人の判断を待っていません。答えは渡していません。実行が終わっていれば、結果は画面で見られます。ユーザーにそう伝えてください。';

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
  answer_not_delivered: '人の答えを統括エージェントに渡せなかった',
});
