// アイデア創出スキル（make-idea）の中身と良さの判定（アイデア創出の設計 7.2、REQ-077）。本物のモデルを使う。
// 流れの試験（idea.mjs）の回のフォルダを、アイデアを作ったのとは別のセッションの AI が読んで判定する。
// 作る過程の判定（壁打ちの判定、読み手の評価）は、アイデアの良さの判定には使わない。
//
//   1. プロセスの中身：1つのセッションが、回のフォルダのなぜなぜ分析・意見・本質の一覧・壁打ちの判定・先行例・調査の記録を読み、
//      項目（PROCESS_ITEMS）ごとに「満たす・満たさない」と根拠を返す。ツールは Read・Grep・Glob だけで、作業フォルダは回のフォルダ。
//   2. アイデアの良さ：説明したアイデア（explain/<n>.md）ごとに、別々のセッションが、頼みの文に入れた説明の文だけを読み、
//      いちばん近い既存のものを自分で探して、新しさ・役立つか・価値を判定する。ツールは WebSearch・WebFetch だけで、回のフォルダは見せない。
//   3. 返事の最後の ```json のかたまりを読む。読めないときは、短い注意を足して1回だけ呼び直し、それでもだめなら誤りとして記録する。
//   4. 結果を --out（review.json）に書く。ok は、プロセスの項目をすべて満たし、アイデアがすべて合格のとき真。最後の判断は開発者が行う。
//
// 各判定は別々の query() のセッションにし、そのセッションに要るツールだけを持たせる（ほかのツールは断る）。
// 設定は読み込まず（settingSources: []）、セッションを残さない（persistSession: false）。環境変数は隔離の部品（agentEnv）で作る。
//
// 使い方（リポジトリの根から。事前に cd tests/dev-eval && npm install --ignore-scripts）:
//   node tests/dev-eval/runner/idea-review.mjs --run-dir <データの置き場所>/runs/<回> --out <review.json>
//        [--review-model claude-opus-5-5] [--home <一時的なホーム>] [--dry-run]
//   --review-model  判定のモデル（Claude Code の ID）。既定は流れの試験のメインと同じ
//   --home          判定のセッションの一時的なホーム。なければ作り、終わったら消す。回のフォルダの外にする
//   --dry-run       モデルを呼ばずに、送る頼みの文を示す（--out は要らない）
//   終了コード：0 判定まで動いた（合否にかかわらない）、1 始められなかった（引数、回のフォルダがない、Agent SDK を読めない）。
//   結果の1行の要約（JSON）を標準出力に、進み具合を標準エラー出力に書く。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentEnv, isInsideDir } from './isolation.mjs';
import { loadQuery } from './user-role.mjs';

/** 判定のモデル。既定は流れの試験のメインと同じ（アイデア創出の設計 7.2） */
export const REVIEW_MODEL = 'claude-opus-5-5';
/** プロセスの中身の判定が持つツール（回のフォルダを読むだけ） */
export const PROCESS_TOOLS = Object.freeze(['Read', 'Grep', 'Glob']);
/** アイデアの良さの判定が持つツール（Web で既存のものを探すだけ。ファイルは読めない） */
export const IDEA_TOOLS = Object.freeze(['WebSearch', 'WebFetch']);
/** 判定のセッションに足す環境変数。WebSearch の上限（1つのセッションで200回）を上げる（アイデア創出の設計 3.4、7章） */
export const REVIEW_ENV = Object.freeze({ CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: '5000' });
/** 1つのセッションの手番の上限と、時間の上限（ミリ秒） */
export const REVIEW_MAX_TURNS = 300;
export const REVIEW_TIMEOUT_MS = 3_600_000;
/** 既存のものを探すときの言い方の数の下限（アイデア創出の設計 7.2） */
export const MIN_QUERIES = 3;

/** プロセスの中身の項目（アイデア創出の設計 7.2 の 1） */
export const PROCESS_ITEMS = Object.freeze([
  { id: 'P1', title: 'なぜなぜ分析', text: 'なぜの各段が前の段の問いの答えになっていて、根拠がある。機能の言い換えで止まっていない。人の困りごとか仕組みの原理に届いている。' },
  { id: 'P2', title: '掘り下げ', text: '掘り下げに、なぜ評価されているかの材料（利用者の声、レビュー、第三者の評価）が引用で集まっている。' },
  { id: 'P3', title: '壁打ちの判定', text: '壁打ちの判定が、3つの観点（新しさ、役立つか、価値）で根拠つきで書かれ、制限を判定に使っていない。だめな理由を示す役が働いている。' },
  { id: 'P4', title: '先行例の調べ', text: '先行例の調べが、複数の言い方で、製品・OSS・論文・特許を当たっている。' },
]);

/** アイデアの不合格の条件（アイデア創出の設計 7.2 の 2） */
export const IDEA_FAIL_CONDITIONS = Object.freeze(['ほぼ同じ既存のものが見つかった。', '困りごとに根拠がない。', '価値の大きさに根拠がない。']);

/** 返事が読めなかったときに、呼び直しの頼みの文に足す注意 */
export const RETRY_NOTE = '注意：前の回の返事は、決まった形で読めませんでした。手順どおりに判定し、返事の最後に、決まった形の JSON を ```json のかたまりで1つだけ書いてください。';

const PROCESS_EXAMPLE = {
  process: {
    items: [{ id: 'P1', title: 'なぜなぜ分析', ok: true, evidence: 'essence/whys-1.md「…」（根拠にしたファイルの場所と引用）' }],
  },
};

const IDEA_EXAMPLE = {
  idea: {
    name: 'アイデアの名前',
    verdict: 'pass',
    closest: [{ name: 'いちばん近い既存のものの名前', url: 'https://…', why_close: '近いと考えた理由' }],
    novelty: { ok: true, reason: '新しさの判定の根拠' },
    usefulness: { ok: true, reason: '役立つかの判定の根拠' },
    value: { ok: true, reason: '価値の判定の根拠' },
    queries: ['使った検索語1', '使った検索語2', '使った検索語3'],
    reasons: ['合否の理由（不合格なら、当たった条件）'],
  },
};

const listDir = (p) => (fs.existsSync(p) ? fs.readdirSync(p) : []);
const isFile = (p) => fs.existsSync(p) && fs.statSync(p).isFile();
const isDir = (p) => fs.existsSync(p) && fs.statSync(p).isDirectory();
/** 名前の中の数を数として並べる（whys-2 が whys-10 より先） */
const byNumber = (a, b) => a.localeCompare(b, 'en', { numeric: true });

// ---- 回のフォルダのファイル ------------------------------------------------------------------------

/** rel（回のフォルダからの場所）の中で、名前が pattern に合うファイル（回のフォルダからの場所） */
function filesIn(runDir, rel, pattern) {
  return listDir(path.join(runDir, rel))
    .filter((n) => pattern.test(n) && isFile(path.join(runDir, rel, n)))
    .sort(byNumber)
    .map((n) => `${rel}/${n}`);
}

/** 組のフォルダ（combine/c<nn>） */
function comboDirs(runDir) {
  return listDir(path.join(runDir, 'combine')).filter((n) => /^c\d+$/.test(n) && isDir(path.join(runDir, 'combine', n))).sort(byNumber).map((n) => `combine/${n}`);
}

/**
 * プロセスの中身の判定で読むファイル（アイデア創出の設計 7.2 の 1）。大きくて分けて書かれた一覧（index-2.md など）も入れる。
 * 制限（restriction.md）は、壁打ちの判定が制限を使っていないかを確かめるためだけに示す。
 * @returns {Array<{ label: string, files: string[] }>}
 */
export function processFiles(runDir) {
  const combos = comboDirs(runDir);
  return [
    { label: 'なぜなぜ分析', files: filesIn(runDir, 'essence', /^whys-.*\.md$/) },
    { label: 'ほかの分析への意見', files: filesIn(runDir, 'essence', /^opinion-.*\.md$/) },
    { label: '本質の一覧', files: filesIn(runDir, 'essence', /^index.*\.md$/) },
    { label: '壁打ちの判定（組ごと）', files: combos.flatMap((c) => filesIn(runDir, c, /^judge-.*\.md$/)) },
    { label: '先行例（組ごと）', files: combos.flatMap((c) => filesIn(runDir, c, /^prior-.*\.md$/)) },
    { label: '調べる計画', files: filesIn(runDir, 'research', /^plan\.md$/) },
    { label: '作品の一覧', files: filesIn(runDir, 'research', /^index.*\.md$/) },
    { label: '掘り下げ（一部を読めばよい）', files: filesIn(runDir, 'research', /^deep-.*\.md$/) },
    { label: '制限（3の「制限を判定に使っていない」を確かめるときだけ読む）', files: isFile(path.join(runDir, 'restriction.md')) ? ['restriction.md'] : [] },
  ];
}

/** 説明したアイデアのファイル（explain/<n>.md だけ。explain/<n>/ の中の版や読み手の記録は入れない） */
export function explanationFiles(runDir) {
  return filesIn(runDir, 'explain', /^\d+\.md$/);
}

/** 説明の題（最初の「# 」の行）。なければ空 */
export function titleOf(text) {
  return (String(text).match(/^#\s+(.+)$/m)?.[1] ?? '').trim();
}

// ---- 頼みの文 ------------------------------------------------------------------------------------

const jsonBlock = (value) => `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;

/** プロセスの中身の判定の頼みの文。ファイルの場所は、作業フォルダ（回のフォルダ）からの場所で示す */
export function buildProcessPrompt(runDir) {
  const list = processFiles(runDir).map((g) => `- ${g.label}：${g.files.length ? g.files.join('、') : '（ありません）'}`).join('\n');
  const items = PROCESS_ITEMS.map((i) => `${i.id}（${i.title}）：${i.text}`).join('\n');
  return [
    'あなたは、アイデアを作った手順の記録を調べる審査員です。作業フォルダは、アイデア創出の1回の実行の記録（回のフォルダ）です。',
    'Read・Grep・Glob で下のファイルを読み、下の項目を、項目ごとに「満たす・満たさない」と根拠（ファイルの場所と引用）で判定してください。ファイルは書き換えません。',
    `読むファイル（作業フォルダからの場所）:\n${list}`,
    `項目:\n${items}`,
    [
      `返し方：調べ終えたら、返事の最後に、次の形の JSON を \`\`\`json のかたまりで1つだけ書いてください。items には ${PROCESS_ITEMS.map((i) => i.id).join('・')} のすべてを書きます。`,
      'ok は、満たすなら true、満たさないなら false にします。evidence には、判断の根拠にしたファイルの場所と引用を書きます。',
      jsonBlock(PROCESS_EXAMPLE),
    ].join('\n'),
  ].join('\n\n');
}

/** アイデアの良さの判定の頼みの文。説明の文だけを入れる（回のフォルダの場所も、作る過程の判定も入れない） */
export function buildIdeaPrompt(explanation) {
  const steps = [
    '1. 説明から、誰のどんな困りごとに、何をするアイデアかを読み取る。',
    `2. WebSearch と WebFetch で、いちばん近い既存のもの（製品、OSS、論文、特許）を探す。少なくとも${MIN_QUERIES}つの違う言い方（アイデアの仕組みを一般的な言葉にした言い方、困りごとの言い方など）で検索する。説明に書かれた「似たものとの違い」をうのみにせず、自分で探す。見つけたものは、元のページを開いて確かめる。`,
    '3. 新しさ・役立つか・価値の3つの観点で判定する。困りごとと価値の大きさの根拠は、説明の文と、自分で探した情報源で確かめる。',
    '   - 新しさ：これまでにないか。いちばん近い既存のものとの違いが、価値の中心になっているか。',
    '   - 役立つか：誰かにとても役立つか。根拠のある困りごとに効くか。',
    '   - 価値：その人や世の中にとっての価値の大きさに、根拠があるか。',
    '4. 次のどれかに当たれば、不合格（fail）にする。どれにも当たらず、3つの観点をすべて満たすときだけ、合格（pass）にする。',
    ...IDEA_FAIL_CONDITIONS.map((c) => `   - ${c}`),
  ];
  return [
    'あなたは、アイデアの良さを判定する審査員です。下の「アイデアの説明」の文だけを読んで判定してください。このアイデアを作った人たちの判定や記録は渡しません。',
    `判定のしかた:\n${steps.join('\n')}`,
    `アイデアの説明:\n----- 説明ここから -----\n${String(explanation).trim()}\n----- 説明ここまで -----`,
    [
      '返し方：判定し終えたら、返事の最後に、次の形の JSON を ```json のかたまりで1つだけ書いてください。',
      'verdict は、合格なら "pass"、不合格なら "fail" にします。closest には、いちばん近い既存のものを、近い順に名前と URL で書きます。',
      `novelty・usefulness・value の ok は、その観点を満たすなら true にします。queries には、実際に使った検索語を${MIN_QUERIES}つ以上書きます。`,
      jsonBlock(IDEA_EXAMPLE),
    ].join('\n'),
  ].join('\n\n');
}

/**
 * 回のフォルダから、送るセッションの一覧を作る（1つ目がプロセスの中身、2つ目から説明したアイデアごと）。
 * @returns {Array<{ kind: 'process'|'idea', file?: string, title?: string, tools: readonly string[], prompt: string }>}
 */
export function planSessions(runDir) {
  const ideas = explanationFiles(runDir).map((file) => {
    const text = fs.readFileSync(path.join(runDir, file), 'utf8');
    return { kind: 'idea', file, title: titleOf(text), tools: IDEA_TOOLS, prompt: buildIdeaPrompt(text) };
  });
  return [{ kind: 'process', tools: PROCESS_TOOLS, prompt: buildProcessPrompt(runDir) }, ...ideas];
}

// ---- 返事の読み取り ------------------------------------------------------------------------------

/**
 * 返事の最後の ```json のかたまりを読む。json の印のないかたまりは、中身が「{」で始まるものだけを、json の印のものがないときに使う。
 * 閉じていない最後のかたまりも読む。前後の文は気にしない。
 * @returns {{ value?: any, error?: string }}
 */
export function extractJson(text) {
  const parts = String(text ?? '').split('```');
  const blocks = [];
  for (let i = 1; i < parts.length; i += 2) {
    const m = parts[i].match(/^([A-Za-z]*)\s*([\s\S]*)$/);
    blocks.push({ lang: m[1].toLowerCase(), body: m[2].trim() });
  }
  const block = blocks.filter((b) => b.lang === 'json').at(-1) ?? blocks.filter((b) => b.lang === '' && b.body.startsWith('{')).at(-1);
  if (!block) return { error: '```json のかたまりがありません' };
  try {
    return { value: JSON.parse(block.body) };
  } catch (error) {
    return { error: `JSON として読めません（${error.message}）` };
  }
}

const hasText = (v) => (typeof v === 'string' ? v.trim() !== '' : Array.isArray(v) && v.length > 0);

/** プロセスの中身の返事を、決まった形にそろえる。足りなければ、平易な日本語の Error を投げる */
export function normalizeProcess(value) {
  const obj = value?.process ?? value;
  if (!Array.isArray(obj?.items)) throw new Error('process.items がありません');
  const items = PROCESS_ITEMS.map((spec) => {
    const got = obj.items.find((x) => String(x?.id ?? '').trim() === spec.id);
    if (!got) throw new Error(`項目 ${spec.id} がありません`);
    if (typeof got.ok !== 'boolean') throw new Error(`項目 ${spec.id} の ok が true か false ではありません`);
    if (!hasText(got.evidence)) throw new Error(`項目 ${spec.id} の根拠（evidence）がありません`);
    return { id: spec.id, title: spec.title, ok: got.ok, evidence: got.evidence };
  });
  return { items };
}

/** アイデアの良さの返事を、決まった形にそろえる。足りなければ、平易な日本語の Error を投げる */
export function normalizeIdea(value) {
  const obj = value?.idea ?? value;
  if (!['pass', 'fail'].includes(obj?.verdict)) throw new Error('verdict が "pass" か "fail" ではありません');
  const views = {};
  for (const key of ['novelty', 'usefulness', 'value']) {
    if (typeof obj[key]?.ok !== 'boolean') throw new Error(`${key}.ok が true か false ではありません`);
    views[key] = { ok: obj[key].ok, reason: String(obj[key].reason ?? '') };
  }
  const closest = Array.isArray(obj.closest) ? obj.closest.filter((c) => hasText(c?.name) && hasText(c?.url)) : [];
  if (!closest.length) throw new Error('いちばん近い既存のもの（closest の名前と URL）がありません');
  const queries = Array.isArray(obj.queries) ? obj.queries.filter(hasText).map(String) : [];
  if (queries.length < MIN_QUERIES) throw new Error(`使った検索語（queries）が ${MIN_QUERIES} つより少ない`);
  const reasons = Array.isArray(obj.reasons) ? obj.reasons.map(String) : hasText(obj.reasons) ? [String(obj.reasons)] : [];
  return {
    name: String(obj.name ?? ''),
    verdict: obj.verdict,
    closest: closest.map((c) => ({ name: String(c.name), url: String(c.url), why_close: String(c.why_close ?? '') })),
    ...views,
    queries,
    reasons,
  };
}

// ---- 合否 ----------------------------------------------------------------------------------------

/** アイデアが合格か。verdict が pass でも、3つの観点のどれかが満たされていなければ合格にしない。誤りの記録は合格にしない */
export function ideaPassed(idea) {
  return !idea?.error && idea?.verdict === 'pass' && ['novelty', 'usefulness', 'value'].every((k) => idea?.[k]?.ok === true);
}

/** プロセスの項目がすべて満たされているか。誤りの記録は満たしたことにしない */
export function processPassed(process) {
  return !process?.error && Array.isArray(process?.items) && process.items.length === PROCESS_ITEMS.length && process.items.every((i) => i.ok === true);
}

/** 全体の ok。説明したアイデアが1つもないときは、判定できていないので偽にする */
export function aggregateOk(process, ideas) {
  return processPassed(process) && ideas.length > 0 && ideas.every(ideaPassed);
}

// ---- セッション ----------------------------------------------------------------------------------

/**
 * 1つの判定のセッションを動かす。tools のほかのツールは、持たせず（tools）、求められても断る（canUseTool）。
 * @returns {Promise<{ text: string, costUsd: number, isError: boolean, detail: string, toolCalls: object }>}
 *   toolCalls はメインのスレッドでモデルが呼んだツールの数（{ ツールの名前: 数 }。断られた呼び出しも数える）
 */
export async function runSession({ query, prompt, tools, cwd, home, model, timeoutMs = REVIEW_TIMEOUT_MS, envExtra = {}, base }) {
  const allowed = new Set(tools);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const options = {
    model,
    cwd,
    tools: [...tools],
    allowedTools: [...tools],
    canUseTool: async (toolName, input) => (allowed.has(toolName)
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: `この判定では ${toolName} は使えません。` }),
    settingSources: [],
    persistSession: false,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    env: agentEnv({ home, extra: { ...REVIEW_ENV, ...envExtra }, ...(base ? { base } : {}) }),
    maxTurns: REVIEW_MAX_TURNS,
    abortController: abort,
  };
  let text = '';
  let lastText = '';
  let costUsd = 0;
  let isError = false;
  let detail = '';
  let gotResult = false;
  const toolCalls = {};
  try {
    for await (const m of query({ prompt, options })) {
      if (m.type === 'assistant' && !m.parent_tool_use_id) {
        for (const c of m.message?.content ?? []) {
          if (c.type === 'text' && c.text?.trim()) lastText = c.text;
          else if (c.type === 'tool_use') toolCalls[c.name] = (toolCalls[c.name] ?? 0) + 1;
        }
      } else if (m.type === 'result') {
        gotResult = true;
        costUsd += m.total_cost_usd ?? 0;
        isError = m.is_error === true || (m.subtype ?? 'success') !== 'success';
        text = typeof m.result === 'string' ? m.result : '';
        detail = isError ? (text || (m.errors ?? []).join('、') || String(m.subtype)) : '';
      }
    }
    if (!gotResult) {
      isError = true;
      detail = '結果が返りませんでした';
    }
  } catch (error) {
    isError = true;
    detail = abort.signal.aborted ? '時間内に終わりませんでした' : `呼び出しが失敗しました（${error?.message ?? error}）`;
  } finally {
    clearTimeout(timer);
  }
  return { text: text || lastText, costUsd, isError, detail: String(detail).slice(0, 300), toolCalls };
}

/**
 * 判定のセッションを動かし、返事を読む。読めなければ（誤りの終わり、JSON がない・形が違う、使うべきツールを使っていない）、
 * RETRY_NOTE を足して1回だけ呼び直す。それでもだめなら { error } を返す。
 * @param {{ normalize: Function, mustUse?: string }} args mustUse は、使っていなければ読めなかったことにするツールの名前
 * @returns {Promise<{ value?: object, error?: string, costUsd: number, attempts: number, toolCalls: object }>}
 */
export async function judgeWithRetry({ normalize, mustUse, prompt, ...session }) {
  let costUsd = 0;
  let problem = '';
  let toolCalls = {};
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const r = await runSession({ ...session, prompt: attempt === 1 ? prompt : `${prompt}\n\n${RETRY_NOTE}（前の回の問題：${problem}）` });
    costUsd += r.costUsd;
    toolCalls = r.toolCalls;
    if (r.isError) problem = `呼び出しが誤りで終わりました（${r.detail}）`;
    else if (mustUse && !(r.toolCalls[mustUse] > 0)) problem = `${mustUse} を使わずに判定しました`;
    else {
      const parsed = extractJson(r.text);
      if (parsed.error) problem = parsed.error;
      else {
        try {
          return { value: normalize(parsed.value), costUsd, attempts: attempt, toolCalls };
        } catch (error) {
          problem = error.message;
        }
      }
    }
  }
  return { error: problem, costUsd, attempts: 2, toolCalls };
}

/**
 * 回のフォルダを判定し、review.json の中身を返す（書くのは呼ぶ側）。セッションは同時に動かす。
 * @param {{ runDir: string, model?: string, home: string, query: Function, log?: Function, timeoutMs?: number, envExtra?: object, base?: object }} args
 *   envExtra は環境変数に足すもの（偽の API の URL など。試験用）、base は環境変数のもと（試験用）
 */
export async function reviewRun({ runDir, model = REVIEW_MODEL, home, query, log = () => {}, timeoutMs, envExtra, base }) {
  const common = { query, home, model, timeoutMs, envExtra, base };
  const jobs = planSessions(runDir).map(async (s) => {
    log({ phase: 'start', kind: s.kind, file: s.file });
    // アイデアの良さの判定の作業フォルダは、回のフォルダの外の空のフォルダにする（説明の文のほかを見せない）
    const cwd = s.kind === 'process' ? runDir : fs.mkdtempSync(path.join(home, 'idea-'));
    const r = await judgeWithRetry({
      ...common, prompt: s.prompt, tools: s.tools, cwd,
      normalize: s.kind === 'process' ? normalizeProcess : normalizeIdea,
      mustUse: s.kind === 'idea' ? 'WebSearch' : undefined,
    });
    log({ phase: 'done', kind: s.kind, file: s.file, error: r.error, costUsd: r.costUsd });
    return { session: s, ...r };
  });
  const [proc, ...ideaResults] = await Promise.all(jobs);
  const processEntry = proc.error
    ? { ok: false, items: [], error: proc.error, attempts: proc.attempts, toolCalls: proc.toolCalls }
    : { ok: processPassed(proc.value), items: proc.value.items, attempts: proc.attempts, toolCalls: proc.toolCalls };
  const ideas = ideaResults.map((r) => {
    const entry = { file: r.session.file, attempts: r.attempts, toolCalls: r.toolCalls };
    if (r.error) return { ...entry, name: r.session.title, pass: false, error: r.error };
    const idea = { ...entry, ...r.value, name: r.value.name || r.session.title };
    return { ...idea, pass: ideaPassed(idea) };
  });
  const costUsd = [proc, ...ideaResults].reduce((sum, r) => sum + r.costUsd, 0);
  return { runDir, model, costUsd, process: processEntry, ideas, ok: aggregateOk(processEntry, ideas) };
}

/** 標準出力の1行の要約 */
export function summaryOf(review, out) {
  return {
    ok: review.ok,
    out,
    runDir: review.runDir,
    model: review.model,
    costUsd: review.costUsd,
    process: { ok: review.process.ok, failed: review.process.items.filter((i) => !i.ok).map((i) => i.id), ...(review.process.error ? { error: review.process.error } : {}) },
    ideas: review.ideas.map((i) => ({ file: i.file, name: i.name, pass: i.pass, ...(i.error ? { error: i.error } : {}) })),
  };
}

/** --dry-run で示す文（送る頼みの文と、持たせるツール） */
export function dryRunText(runDir, model) {
  const head = `判定のモデル：${model}\n回のフォルダ：${runDir}\n`;
  const body = planSessions(runDir).map((s) => {
    const where = s.kind === 'process' ? 'プロセスの中身（作業フォルダ：回のフォルダ）' : `アイデアの良さ：${s.file}（作業フォルダ：回のフォルダの外の空のフォルダ）`;
    return `===== ${where}。ツール：${s.tools.join('、')} =====\n${s.prompt}\n`;
  });
  return [head, ...body].join('\n');
}

// ---- 入口 ----------------------------------------------------------------------------------------

export function parseArgs(argv) {
  const o = { model: REVIEW_MODEL, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} の値がありません。`);
      i += 1;
      return argv[i];
    };
    if (a === '--run-dir') o.runDir = next();
    else if (a === '--out') o.out = next();
    else if (a === '--review-model') o.model = next();
    else if (a === '--home') o.home = next();
    else if (a === '--dry-run') o.dryRun = true;
    else throw new Error(`知らない引数です：${a}`);
  }
  if (!o.runDir) throw new Error('--run-dir が要ります。');
  if (!o.out && !o.dryRun) throw new Error('--out が要ります。');
  return o;
}

/**
 * 入口。query を渡すと、本物の Agent SDK の代わりに使う（試験用）。
 * @returns {Promise<number>} 終了コード（0 判定まで動いた、1 始められなかった）
 */
export async function main(argv = process.argv.slice(2), {
  query: injected,
  print = (s) => process.stdout.write(s),
  log = (x) => process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), ...x })}\n`),
  base,
} = {}) {
  const fail = (message) => {
    print(`${JSON.stringify({ ok: false, error: message })}\n`);
    return 1;
  };
  let o;
  try {
    o = parseArgs(argv);
  } catch (error) {
    return fail(error.message);
  }
  const runDir = path.resolve(o.runDir);
  if (!isDir(runDir)) return fail(`回のフォルダがありません：${runDir}`);
  if (o.home && isInsideDir(runDir, path.resolve(o.home))) return fail('--home は、回のフォルダの外にしてください。');
  if (o.dryRun) {
    print(dryRunText(runDir, o.model));
    return 0;
  }
  let query = injected;
  if (!query) {
    try {
      query = await loadQuery();
    } catch (error) {
      return fail(`Agent SDK を読み込めません（${error?.message ?? error}）。tests/dev-eval で npm install --ignore-scripts をしてください。`);
    }
  }
  const out = path.resolve(o.out);
  const home = o.home ? path.resolve(o.home) : fs.mkdtempSync(path.join(os.tmpdir(), 'idea-review-home-'));
  fs.mkdirSync(home, { recursive: true });
  try {
    const review = await reviewRun({ runDir, model: o.model, home, query, log, base });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(review, null, 2)}\n`);
    print(`${JSON.stringify(summaryOf(review, out))}\n`);
    return 0;
  } finally {
    if (!o.home) fs.rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => {
    process.stderr.write(`${e?.stack ?? e}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(e?.message ?? e) })}\n`);
    process.exit(1);
  });
}
