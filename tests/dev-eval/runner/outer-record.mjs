// 外側の EVAL の会話と呼び出しの記録（testing.md 6.6）。outer-run.mjs（動いている会話）と outer-resume.mjs（続きから始めるときの、
// セッションの記録からの読み直し）で共通に使う。どちらも、Agent SDK のメッセージを同じ関数（createMessageRecorder）で記録に直す。

const CLIP = { toolInput: 1500, toolResult: 1500 };

export const clip = (text, max) => {
  const chars = [...String(text ?? '')];
  return chars.length <= max ? String(text ?? '') : `${chars.slice(0, max).join('')}…（以下${chars.length - max}文字を省略）`;
};

export const textOfContent = (content) => (Array.isArray(content) ? content.map((c) => c?.text ?? '').join('\n') : String(content ?? ''));

/** 記録に残す tool_use の入力。書き込みの中身などの長い文字は切る（場所は残す） */
export function shrinkInput(input) {
  if (input === null || typeof input !== 'object') return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) out[k] = typeof v === 'string' ? clip(v, CLIP.toolInput) : v;
  return out;
}

/**
 * 会話と呼び出しの記録。順番の印（seq）は 1 つの連番で、記録のツールの呼び出しとも共通。
 * add の data に at を入れると、その時刻で記録する（セッションの記録から読み直すとき）
 */
export function createRecorder(now = Date.now) {
  let seq = 0;
  const items = [];
  return {
    items,
    next: () => (seq += 1),
    add(kind, data = {}) {
      const item = { seq: (seq += 1), at: now(), kind, ...data };
      items.push(item);
      return item;
    },
  };
}

/** 会話の全文（6.6）。クリエイターの発言（質問、生成前の確認、できたことの説明）とユーザー役の答え */
export function conversationOf(items) {
  const out = [];
  for (const i of items) {
    if (i.kind === 'user.request') out.push({ seq: i.seq, role: 'user', via: 'request', text: i.text });
    else if (i.kind === 'creator.text') out.push({ seq: i.seq, role: 'creator', via: 'text', text: i.text, turn: i.turn });
    else if (i.kind === 'creator.question') out.push({ seq: i.seq, role: 'creator', via: 'AskUserQuestion', header: i.header, question: i.question, options: i.options, multiSelect: i.multiSelect });
    else if (i.kind === 'user.answer') out.push({ seq: i.seq, role: 'user', via: i.via, text: i.answer, index: i.index, signal: i.signal });
  }
  return out;
}

/** 質問のツールの 1 つの問いの欄の記録（creator.question）の中身 */
export function questionItemData(q, group, groupSize) {
  const options = (q.options ?? []).map((opt) => ({ label: String(opt.label ?? ''), description: String(opt.description ?? '') }));
  return { header: q.header ?? '', question: q.question, options, multiSelect: Boolean(q.multiSelect), group, groupSize };
}

/**
 * Agent SDK のメッセージ（assistant と user）を、会話の記録（items）と、動いたモデル・サブエージェント・スキルの記録に直す。
 * 質問のツール（AskUserQuestion）の呼び出しは記録しない（問いと答えは、答えを受けた側が記録する）。
 * @param {object} args
 * @param {ReturnType<typeof createRecorder>} args.recorder
 * @param {object} args.models 'main' か Agent の呼び出しの番号 → そのエージェントのメッセージに出たモデル（出た順、重ならない）
 * @param {object} args.subagents Agent の呼び出しの番号 → { type, description }
 * @param {string[]} args.skills
 */
export function createMessageRecorder({ recorder, models, subagents, skills }) {
  return {
    /**
     * メッセージを 1 つ記録する。
     * @param {object} m Agent SDK のメッセージ（type が assistant・user のものだけを見る）
     * @param {{ turn?: number, at?: number, onText?: (text: string) => void }} [opts] turn はクリエイターの何回目の手番か、
     *   at は記録の時刻（省くと今）、onText はメインのエージェントの文を受ける
     */
    handle(m, { turn, at, onText } = {}) {
      const stamp = at === undefined ? {} : { at };
      if (m.type === 'assistant') {
        const owner = m.parent_tool_use_id ?? 'main';
        if (m.message?.model && !(models[owner] ??= []).includes(m.message.model)) models[owner].push(m.message.model);
        for (const c of m.message?.content ?? []) {
          if (c.type === 'text' && owner === 'main' && c.text?.trim()) {
            recorder.add('creator.text', { text: c.text, turn, ...stamp });
            onText?.(c.text);
          } else if (c.type === 'tool_use') {
            if (c.name === 'AskUserQuestion') continue; // 問いと答えは、答えを受けた側が記録する
            if (c.name === 'Agent' || c.name === 'Task') subagents[c.id] = { type: c.input?.subagent_type ?? '(general)', description: c.input?.description ?? '' };
            if (c.name === 'Skill') skills.push(c.input?.skill);
            recorder.add('tool.use', { owner, id: c.id, name: c.name, input: shrinkInput(c.input), ...stamp });
          }
        }
      } else if (m.type === 'user') {
        const owner = m.parent_tool_use_id ?? 'main';
        for (const c of Array.isArray(m.message?.content) ? m.message.content : []) {
          if (c.type === 'tool_result') recorder.add('tool.result', { owner, id: c.tool_use_id, isError: c.is_error === true, text: clip(textOfContent(c.content), CLIP.toolResult), ...stamp });
        }
      }
    },
  };
}
