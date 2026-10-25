// フック（hearing.md 7.4、8章）。ヒアリングの最中だけ動く。ヒアリングの最中とは、このセッションの記録があり、
// 段階が「生成」に進む前の間（7.4）。
//
//   onPostToolUse（ask_user のとき）  問い（toolArgs）と答え（結果の文。取り消しと断りを含む）を qa.jsonl に追記する
//   onUserPromptSubmitted             ユーザーが打った発言を qa.jsonl に追記する。記録がまだないあいだは、メモリーに覚えておき、
//                                     記録を作ったときに、頼みの文として qa.jsonl の初めに追記する（flushRequests）
//   onPreToolUse                      コンパクションの後に、次のメインのエージェントの呼び出しへ、1回だけ差し込む
//
// どのフックの関数も、例外を投げない。問答の記録のフックは、差し込みを返さない（onPostToolUse の差し込みは画面に出るため。2.5）。
// 差し込みは onPreToolUse だけ（ask_user の後でも画面に出ないため）。サブエージェントのツールの呼び出しには差し込まない。

import { INJECTION_MAX_BYTES } from './constants.mjs';

/**
 * コンパクションの後の差し込み（hearing.md 8章）。1KB 未満。
 * 繰り返しの指示は不要な確認を増やすので、1回だけにする。
 */
export const COMPACTION_NOTICE =
  '会話が自動で要約されました。いまの手順が消えているかもしれません。skill ツールで make-plugin を読み直し、plugin-creator_state を呼んで、段階と、まだ聞いていないことを確かめてから続けてください。';

if (Buffer.byteLength(COMPACTION_NOTICE, 'utf8') >= INJECTION_MAX_BYTES) {
  throw new Error('会話の自動の要約の後の差し込みが 1KB を超えています');
}

/** ask_user の結果の文から、答えの種類を見分ける（hearing.md 2.1） */
export function outcomeOf(answer) {
  const a = String(answer ?? '');
  if (a.startsWith('User cancelled the request')) return 'cancelled';
  if (a.includes('The user is not available to respond')) return 'unavailable';
  return 'answered';
}

/** フックの結果（ToolResultObject か文字）から、モデルに渡った文を取り出す */
export function resultText(toolResult) {
  if (toolResult == null) return '';
  if (typeof toolResult === 'string') return toolResult;
  if (typeof toolResult.textResultForLlm === 'string') return toolResult.textResultForLlm;
  try {
    return JSON.stringify(toolResult);
  } catch {
    return String(toolResult);
  }
}

/** toolArgs は、オブジェクトでも JSON の文字でも来うる。オブジェクトに直せれば直す */
function argsValue(toolArgs) {
  if (typeof toolArgs !== 'string') return toolArgs ?? null;
  try {
    return JSON.parse(toolArgs);
  } catch {
    return toolArgs;
  }
}

/**
 * @param {object} options
 * @param {{ active: boolean, exists: boolean, loadError: unknown }} options.hearing
 * @param {{ appendQa: (entry: object) => void }} options.store
 * @param {{ now: () => number }} options.clock
 * @param {(text: string) => void} [options.warn] 失敗を知らせる（標準エラー。標準出力は JSON-RPC なので使わない）
 */
export function createHooks({ hearing, store, clock, warn = () => {} }) {
  let compactionPending = false;
  let requests = []; // 記録がまだないあいだに打たれた発言（頼みの文。hearing.md 7.4）
  const at = () => new Date(clock.now()).toISOString();

  function append(entry) {
    try {
      store.appendQa({ at: at(), ...entry });
    } catch (error) {
      warn(`問答の記録に失敗しました：${error?.message ?? error}`);
    }
  }

  const hooks = {
    onPostToolUse(input) {
      try {
        if (input?.toolName === 'ask_user' && hearing.active) {
          const answer = resultText(input.toolResult);
          append({ type: 'ask_user', question: argsValue(input.toolArgs), answer, outcome: outcomeOf(answer) });
        }
      } catch (error) {
        warn(`onPostToolUse：${error?.message ?? error}`);
      }
      return undefined; // 差し込みは返さない
    },

    onUserPromptSubmitted(input) {
      try {
        if (typeof input?.prompt !== 'string') return undefined;
        if (hearing.active) append({ type: 'user_prompt', text: input.prompt });
        else if (!hearing.exists && !hearing.loadError) requests.push({ at: at(), text: input.prompt });
      } catch (error) {
        warn(`onUserPromptSubmitted：${error?.message ?? error}`);
      }
      return undefined; // 差し込みは返さない
    },

    onPreToolUse(input) {
      try {
        if (!compactionPending) return undefined;
        if (input?.agentId) return undefined; // サブエージェントのツールの呼び出しには差し込まない。次のメインのエージェントの呼び出しまで待つ
        compactionPending = false; // 1回だけ
        if (!hearing.active) return undefined;
        return { additionalContext: COMPACTION_NOTICE };
      } catch (error) {
        warn(`onPreToolUse：${error?.message ?? error}`);
        return undefined;
      }
    },
  };

  /**
   * session.compaction_complete を受けたときに呼ぶ。ヒアリングの最中のメインのエージェントのコンパクションだけ数える。
   * イベントの agentId は、サブエージェントのコンパクションのときにだけ付く（R2 3.6）。
   */
  function onSessionEvent(event) {
    try {
      if (event?.type !== 'session.compaction_complete') return;
      if (event.agentId) return;
      if (event.data?.success === false) return; // 失敗したコンパクションでは、何も消えていない
      if (hearing.active) compactionPending = true;
    } catch (error) {
      warn(`session.compaction_complete：${error?.message ?? error}`);
    }
  }

  /** 記録を作った直後に呼ぶ。覚えておいた発言を、頼みの文として qa.jsonl の初めに追記する。記録ができた後は、覚えない */
  function flushRequests() {
    const pending = requests;
    requests = [];
    for (const r of pending) {
      try {
        store.appendQa({ at: r.at, type: 'request', text: r.text });
      } catch (error) {
        warn(`頼みの文の記録に失敗しました：${error?.message ?? error}`);
      }
    }
  }

  return { hooks, onSessionEvent, flushRequests, get compactionPending() { return compactionPending; } };
}
