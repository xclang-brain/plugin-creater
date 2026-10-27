// アイデア創出スキル（make-idea）の流れの試験の入口（アイデア創出の設計 7章）。本物のモデルを使う。
// 外側の EVAL と同じ部品（置き換え、隔離、ユーザー役の呼び出し、記録、クリエイターのツール）を読み込んで使い、既存の部品は変えない。
//
//   1. クリエイターを Claude Code 向けに置き換える（convert.py）。
//   2. 一時的なホーム（agent-home）の下にデータの置き場所（.plugin-creator/make-idea）を作り、--params の値を置く。
//   3. 置き換えた版だけを読み込み、Agent SDK で、頼みの文から make-idea を動かす。質問のツールの問いと、文章で問うて手番を
//      終えたときの問いには、ユーザー役（制限を知っている人）が答える。回の state.md が「終わり」になったら止める。
//   4. 呼び出しの一覧とデータの置き場所から採点し（idea-grade.mjs）、結果を <out>/result.json に書く。
//
// 使い方（リポジトリの根から。事前に cd tests/dev-eval && npm install --ignore-scripts）:
//   node tests/dev-eval/runner/idea.mjs --request-file <頼みの文> --restriction-file <ユーザー役が知っている制限>
//        [--params small|default|<params.json>] [--data-from <前の実行の data フォルダ>] [--expect-knowledge]
//        [--model claude-opus-5-5] [--user-model claude-sonnet-5-5] [--out <結果のフォルダ>] [--converted <置き換えた版>]
//        [--max-exchanges 60] [--exclude-first-candidate] [--stop-at-pillar <番号>] [--expect-resume] [--dry-run]
//   --params        small は流れを短く通す小さな値、default は既定（スキルが assets/params.json を写す）、ほかはファイル
//   --data-from     前の実行のデータの置き場所（知識・経験、パラメーター、回）を写してから始める（2回目の実行、続きの試験）
//   --expect-knowledge  前の回の知識・経験を使ったかも採点する（REQ-061）
//   --exclude-first-candidate  ユーザー役が、知識・経験の候補の1番を外す（外した候補が保存されないかを採点するため。REQ-060）
//   --stop-at-pillar  回の今の柱がこの番号になったら、手番の終わりで会話を止める（続きの試験の前半。採点は「途中」で終わる）
//   --expect-resume   続きの試験の後半。--data-from の回を続け、新しい回のフォルダを作らずに終えたかを採点する（REQ-064）
//   終了コード：0 最後まで動いて採点がすべて合格、1 採点に不合格がある・途中で止まった、2 始められなかった。
//   進み具合は標準エラー出力と <out>/status.json に、結果は <out>/result.json と <out>/record.json に書く。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCreatorToolkit, REPO_ROOT } from './creator-tools.mjs';
import { isInsideDir, makeQueryOptions } from './isolation.mjs';
import { convertPlugin, LIMIT_PATTERN } from './outer-run.mjs';
import { buildUserPrompt, loadQuery, normalizeChoices, queryOnce, USER_ROLE_MODEL } from './user-role.mjs';
import { gradeIdeaRun, latestRun } from './idea-grade.mjs';

/** 流れを短く通すための小さな値（アイデア創出の設計 7章。数の決まり〔2者以上など〕は守る） */
export const SMALL_PARAMS = Object.freeze({
  説明: '流れの試験の小さな値',
  徹底的な事前調査: { 集める作品の数: 12, 同時に調べるエージェントの数: 3, 掘り下げる作品の数: 6, '1体が掘り下げる作品の数': 3, 集め直しの回数の上限: 1 },
  本質の見極め: { 本質の数: 6, なぜなぜ分析をするエージェントの数: 2, なぜを重ねる段の上限: 3, 意見を出し合う往復の数: 1 },
  本質の掛け合わせ: {
    一度に掛け合わせる本質の数: { 最小: 2, 最大: 3 },
    掛け合わせる数を変える順: [2, 3],
    同じ数で試す組の数: 1,
    壁打ちの相手のエージェントの数: 2,
    '1つの組から作る案の数': 2,
    壁打ちする案の総数: 6,
    壁打ちの往復の数: 2,
  },
  アイデアの説明: { 説明を読む第三者のエージェントの数: 2, 説明するアイデアの数の上限: 1, 説明を直す回数の上限: 1, '説明の長さの上限（文字）': 2500 },
  知識・経験の蓄積: { 振り返りのエージェントの数: 2, '知識・経験のファイル1つの大きさの上限（バイト）': 16000, 'まとめ始める大きさの割合（%）': 80 },
});

/** ユーザー役（制限を知っている人）への決まり。make-idea の問いの形（アイデア創出の設計 6章）に合わせる */
export const IDEA_USER_RULES = Object.freeze([
  '聞かれたことにだけ、短く答える。上の「あなたの立場と制限」に書いてあることは、聞かれたら具体的に答える。書いていないことは「特に決まっていません」と答える。推測で新しい条件を作らない。',
  '制限の一覧を確かめられたら、上の制限と合っていれば「このとおりです」と答える。違うところや足りないところがあれば、そこだけ短く直す。',
  '調べ始めてよいか、続けてよいかを文章で聞かれたら、「続けて」と答える。',
  '説明してほしいアイデアを選ぶように言われたら、一覧の中から、上の制限にいちばん合うものを、上限の数まで選び、番号と、選んだ理由を一言ずつ書く。',
  '残したくない候補の番号を聞かれたら、会社名・製品名・人の名前など、外に出せない具体を含むものだけを番号で答える。なければ「なし」と答える。',
  '選択肢がある質問には、選択肢の名前（「（」の前の言葉）だけを書く。進め方を選ぶ質問では、「（おすすめ）」の付いた選択肢を選ぶ。前の回を続けるか、新しく始めるかを聞かれたら、続けるほうを選ぶ。',
  'ふつうの人として、チャットの言葉で書く。この決まりのことは口に出さない。',
]);

/** 外した候補が保存されないかを採点するときだけ足す決まり（REQ-060） */
export const EXCLUDE_FIRST_RULE = '残したくない候補の番号を聞かれたら、上の決まりにかかわらず、1番を外すと答える（ほかに外すものがあれば足す）。理由は「1番は自分の業務には当てはまらない気がする」とする。';

export function buildIdeaUserSystem(restriction, { excludeFirst = false } = {}) {
  const rules = [...IDEA_USER_RULES, ...(excludeFirst ? [EXCLUDE_FIRST_RULE] : [])];
  return [
    'あなたは、AI のアシスタントに、アイデア出しを頼んだ人です。',
    `あなたの立場と制限:\n${restriction.trim()}`,
    `答え方の決まり:\n${rules.map((r) => `- ${r}`).join('\n')}`,
  ].join('\n\n');
}

function parseArgs(argv) {
  const o = { params: 'small', model: 'claude-opus-5-5', userModel: USER_ROLE_MODEL, maxExchanges: 60, expectKnowledge: false, excludeFirst: false, stopAtPillar: null, expectResume: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} の値がありません。`);
      i += 1;
      return argv[i];
    };
    if (a === '--request-file') o.requestFile = next();
    else if (a === '--restriction-file') o.restrictionFile = next();
    else if (a === '--params') o.params = next();
    else if (a === '--data-from') o.dataFrom = next();
    else if (a === '--expect-knowledge') o.expectKnowledge = true;
    else if (a === '--model') o.model = next();
    else if (a === '--user-model') o.userModel = next();
    else if (a === '--out') o.out = next();
    else if (a === '--converted') o.converted = next();
    else if (a === '--max-exchanges') o.maxExchanges = Number(next());
    else if (a === '--exclude-first-candidate') o.excludeFirst = true;
    else if (a === '--stop-at-pillar') o.stopAtPillar = Number(next());
    else if (a === '--expect-resume') o.expectResume = true;
    else if (a === '--dry-run') o.dryRun = true;
    else throw new Error(`知らない引数です：${a}`);
  }
  if (!o.requestFile || !o.restrictionFile) throw new Error('--request-file と --restriction-file が要ります。');
  return o;
}

/** データの置き場所の最初の中身を作る（--data-from を写し、--params を置く） */
export function prepareData(dataDir, { params, dataFrom }) {
  fs.mkdirSync(dataDir, { recursive: true });
  if (dataFrom) fs.cpSync(dataFrom, dataDir, { recursive: true });
  if (params === 'small') fs.writeFileSync(path.join(dataDir, 'params.json'), `${JSON.stringify(SMALL_PARAMS, null, 2)}\n`);
  else if (params && params !== 'default') fs.copyFileSync(params, path.join(dataDir, 'params.json'));
}

const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

/** いちばん新しい回の今の柱の番号（state.md の「今の柱：<番号>」）。なければ null */
export function currentPillar(dataDir) {
  const run = latestRun(dataDir);
  const m = run ? readIf(path.join(run, 'state.md')).match(/今の柱[：:]\s*(\d)/) : null;
  return m ? Number(m[1]) : null;
}

/**
 * この実行の回が「終わり」になったか。前の実行から写した回（runsBefore）は、続きの試験（resume）のときだけ見る。
 * 写した回が終わっていても、この実行の回ができていなければ終わりではない。
 */
export function isFinished(dataDir, { runsBefore = [], resume = false } = {}) {
  const run = latestRun(dataDir);
  if (!run) return false;
  if (!resume && runsBefore.includes(path.basename(run))) return false;
  return /状態[：:]\s*終わり/.test(readIf(path.join(run, 'state.md')));
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const request = fs.readFileSync(o.requestFile, 'utf8').trim();
  const restriction = fs.readFileSync(o.restrictionFile, 'utf8').trim();
  const outDir = path.resolve(o.out ?? fs.mkdtempSync(path.join(process.env.DEV_EVAL_RUNS || path.join(os.tmpdir(), 'plugin-creator-dev-eval'), 'idea-')));
  const dirs = {
    work: path.join(outDir, 'work'),
    agentHome: path.join(outDir, 'agent-home'),
    userHome: path.join(outDir, 'user-home'),
    copilotHome: path.join(outDir, 'copilot-home'),
    converted: path.join(outDir, 'converted', 'plugin-creator'),
  };
  for (const d of [dirs.work, dirs.agentHome, dirs.userHome, dirs.copilotHome]) fs.mkdirSync(d, { recursive: true });
  const dataDir = path.join(dirs.agentHome, '.plugin-creator', 'make-idea');
  prepareData(dataDir, { params: o.params, dataFrom: o.dataFrom });
  const runsBefore = fs.existsSync(path.join(dataDir, 'runs')) ? fs.readdirSync(path.join(dataDir, 'runs')) : [];
  const log = (x) => process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), ...x })}\n`);
  const status = (x) => fs.writeFileSync(path.join(outDir, 'status.json'), `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...x }, null, 2)}\n`);

  const converted = o.converted ? path.resolve(o.converted) : convertPlugin(REPO_ROOT, dirs.converted).root;
  log({ phase: 'converted', converted, dataDir, outDir });
  if (o.dryRun) {
    process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, outDir, dataDir, converted })}\n`);
    return 0;
  }

  const query = await loadQuery();
  const toolkit = await createCreatorToolkit({ workDir: dirs.work, copilotHome: dirs.copilotHome, sessionId: `idea-${path.basename(outDir)}` });
  const calls = [];
  const conversation = [];
  const history = [];
  let group = 0;
  let sessionId;
  let costUsd = 0;
  let stopped = null;
  const unreadNotes = [];
  const userSystem = buildIdeaUserSystem(restriction, { excludeFirst: o.excludeFirst });

  async function userAnswer(question, choices, notes) {
    const prompt = buildUserPrompt({ question, choices, history, notes });
    const r = await queryOnce({ query, system: userSystem, prompt, model: o.userModel, home: dirs.userHome, cwd: dirs.userHome });
    if (r.isError || !r.text) throw new Error(`ユーザー役の呼び出しに失敗しました（${r.subtype}）`);
    costUsd += r.cost;
    history.push({ notes: notes.join('\n\n'), question, answer: r.text });
    conversation.push({ kind: 'answer', question, choices: normalizeChoices(choices).map((c) => c.label), answer: r.text });
    log({ phase: 'answer', question: question.slice(0, 80), answer: r.text.slice(0, 80) });
    return r.text;
  }

  const onQuestion = async (questions) => {
    await new Promise((resolve) => setImmediate(resolve));
    let notes = unreadNotes.splice(0);
    const answers = {};
    for (const q of questions) {
      answers[q.question] = await userAnswer(q.question, q.options ?? [], notes);
      notes = [];
    }
    return answers;
  };

  // データの置き場所への書き込みも許す（make-idea は作業フォルダの外のデータの置き場所に書く。アイデア創出の設計 2章）
  const absPattern = (dir) => `/${dir.split(path.sep).join('/')}/**`;
  async function runTurn(prompt) {
    const options = makeQueryOptions({
      cwd: dirs.work,
      home: dirs.agentHome,
      model: o.model,
      plugins: [converted],
      mcpServers: { [toolkit.serverName]: toolkit.newServer() },
      mcpTools: toolkit.mcpTools,
      sandbox: false,
      onQuestion,
      envExtra: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1' },
      maxTurns: 600,
      resume: sessionId,
    });
    options.allowedTools = [...options.allowedTools, 'WebSearch', 'WebFetch', `Write(${absPattern(dataDir)})`, `Edit(${absPattern(dataDir)})`];
    const base = options.canUseTool;
    options.canUseTool = async (toolName, input, ...rest) => {
      const target = input?.file_path ?? input?.path;
      if (['Write', 'Edit', 'MultiEdit'].includes(toolName) && isInsideDir(dataDir, target)) return { behavior: 'allow', updatedInput: input };
      return base(toolName, input, ...rest);
    };
    let result = null;
    let lastText = '';
    for await (const m of query({ prompt, options })) {
      sessionId = m.session_id ?? sessionId;
      if (m.type === 'assistant') {
        const owner = m.parent_tool_use_id ?? 'main';
        if (owner === 'main') group += 1;
        for (const c of m.message?.content ?? []) {
          if (c.type === 'text' && owner === 'main' && c.text?.trim()) {
            unreadNotes.push(c.text.trim());
            lastText = c.text;
            conversation.push({ kind: 'text', text: c.text });
          } else if (c.type === 'tool_use') {
            const input = { ...c.input };
            if (typeof input.content === 'string') input.content = `${input.content.slice(0, 300)}…`;
            // 同じ応答の tool_use は、別々のメッセージで届くことがある。メッセージの番号（message.id）が同じものを、同時に起動したものとする
            calls.push({ owner, id: c.id, name: c.name, input, group: owner === 'main' ? (m.message?.id ?? `g${group}`) : null });
            if (c.name === 'Agent' || c.name === 'Task') log({ phase: 'agent', type: c.input?.subagent_type, description: c.input?.description });
          }
        }
      } else if (m.type === 'result') {
        result = m;
        costUsd += m.total_cost_usd ?? 0;
      }
    }
    return { result, lastText };
  }

  let prompt = request;
  conversation.push({ kind: 'request', text: request });
  try {
    for (let n = 0; n < o.maxExchanges; n += 1) {
      status({ phase: 'turn', n: n + 1, calls: calls.length, costUsd });
      const turn = await runTurn(prompt);
      if (!turn.result) { stopped = { reason: 'no_result' }; break; }
      if (turn.result.is_error || turn.result.subtype !== 'success') {
        stopped = { reason: LIMIT_PATTERN.test(String(turn.result.result ?? '')) ? 'usage_limit' : turn.result.subtype, message: String(turn.result.result ?? '').slice(0, 300) };
        break;
      }
      if (isFinished(dataDir, { runsBefore, resume: o.expectResume })) { stopped = { reason: 'finished' }; break; }
      if (o.stopAtPillar !== null && (currentPillar(dataDir) ?? 0) >= o.stopAtPillar) { stopped = { reason: 'stopped_at_pillar', pillar: currentPillar(dataDir) }; break; }
      const question = (turn.result.result ?? '').trim() || turn.lastText.trim() || '（発言がありませんでした）';
      const notes = unreadNotes.splice(0).filter((t) => t !== question);
      prompt = await userAnswer(question, [], notes);
    }
    if (!stopped) stopped = { reason: 'max_exchanges' };
  } catch (e) {
    stopped = { reason: 'exception', message: String(e?.stack ?? e).slice(0, 600) };
  }

  const questions = conversation.filter((x) => x.kind === 'answer').map((x) => x.question);
  const grade = gradeIdeaRun({ dataDir, calls, hearingState: toolkit.readState(), expectKnowledgeUse: o.expectKnowledge, resume: o.expectResume ? { runsBefore, questions } : null });
  const result = { ok: (stopped.reason === 'finished' || stopped.reason === 'stopped_at_pillar') && (stopped.reason === 'stopped_at_pillar' || grade.ok), stopped, outDir, dataDir, runDir: grade.runDir, costUsd, calls: calls.length, checks: grade.checks };
  fs.writeFileSync(path.join(outDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'record.json'), `${JSON.stringify({ conversation, calls }, null, 2)}\n`);
  status({ phase: 'done', stopped, ok: result.ok, costUsd });
  process.stdout.write(`${JSON.stringify({ ok: result.ok, stopped, outDir, runDir: grade.runDir, costUsd, failed: grade.checks.filter((c) => !c.ok).map((c) => c.id) })}\n`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => {
    process.stderr.write(`${e?.stack ?? e}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(e?.message ?? e) })}\n`);
    process.exit(2);
  });
}

