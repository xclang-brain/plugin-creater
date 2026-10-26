// 外側の EVAL の流れ（outer-run.mjs）の試験。実際のモデルは使わない（偽物の Agent SDK）。
// 動かし方（リポジトリの根で）：node --test "tests/dev-eval/runner/*.test.mjs"
// 本物のクリエイターのエクステンションの記録のツールと、本物の組み立てのスクリプト（scaffold.py）は動かす。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ITEMS } from '../../../com.github.copilot/extensions/plugin-creator/names.mjs';
import { loadPersona } from '../personas/validate.mjs';
import { createFakeSdk } from './outer-fake-sdk.mjs';
import { conversationOf, createRecorder, findGeneratedPlugins, placePersonaFiles, preexistingPlugins, PREEXISTING_PLUGINS_FILE, readConvertedAgentModel, runOuterOnce, USER_ROLE_FAILED } from './outer-run.mjs';
import { CALL_RETRIES, MARKUP_RETRIES } from './user-role.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..', '..');
const PERSONAS = path.join(here, '..', 'personas');
const SAMPLE_PARTS = path.join(REPO, 'tests', 'creator', 'scaffold', 'sample', 'parts');
const SCAFFOLD = path.join(REPO, 'skills', 'make-plugin', 'scripts', 'scaffold.py');
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), `outer-run-${prefix}-`));
const SETTABLE = ITEMS.filter((i) => !i.computed && !i.rebuildOnly).map((i) => i.name);
const T = (name) => `mcp__plugin-creator__${name}`;

/** 組み立ての見本の parts が持つ EVAL の課題。confirm で示す課題は、これと同じにする */
const SAMPLE_EVAL = JSON.parse(fs.readFileSync(path.join(SAMPLE_PARTS, 'files', 'tests', 'eval', 'T-01', 'eval.json'), 'utf8'));

const loadedWeekly = await loadPersona(path.join(PERSONAS, 'weekly-report'), { allStyles: true });

/** 変換の代わり。置き換えた版の入れ物と変換レポートだけを作る（変換そのものは D1a の試験） */
function fakeConvert(src, out) {
  fs.mkdirSync(path.join(out, '.eval'), { recursive: true });
  const report = {
    plugin: path.basename(src),
    model_map: { 'claude-haiku-5.5': 'claude-haiku-5-5', 'gpt-6-luna': 'claude-haiku-5-5', 'claude-sonnet-5.5': 'claude-sonnet-5-5', 'gpt-6.1-sol': 'claude-sonnet-5-5', 'claude-opus-5.5': 'claude-opus-5-5' },
    extension_tools: ['open', 'state', 'progress', 'record', 'confirm', 'results', 'doc_text', 'issue'].map((tool) => ({ from: `plugin-creator_${tool}`, to: T(tool), server: 'plugin-creator', tool, where: 'skills/make-plugin/SKILL.md' })),
    warnings: [],
  };
  fs.writeFileSync(path.join(out, '.eval', 'conversion-report.json'), JSON.stringify(report));
  // 置き換えた版のエージェントの定義：作業は費用の低いモデル、読み取り役は model なし（inherit）
  fs.mkdirSync(path.join(out, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(out, 'agents', 'worker.md'), '---\nname: worker\ndescription: 作業\nmodel: claude-haiku-5-5\n---\n本文\n');
  fs.writeFileSync(path.join(out, 'agents', 'reader.md'), '---\nname: reader\ndescription: 読む\nmodel: inherit\n---\n本文\n');
  return { root: out, report, summary: { ok: true } };
}

const baseOptions = (runRoot) => ({ runRoot, sandbox: false, convert: fakeConvert, runStages: async () => ({ skipped: false, ok: true, stage1: { ok: true }, stage2: { ok: true } }) });

test('REQ-037 作業フォルダに、模擬ユーザーの示すファイルが置かれ、生成プラグインは直下に plugin.json があるフォルダとして見つかる', () => {
  const work = tmp('place');
  placePersonaFiles(work, loadedWeekly.files);
  for (const f of loadedWeekly.files) {
    assert.ok(fs.existsSync(path.join(work, f.place)), f.place);
    assert.deepEqual(fs.readFileSync(path.join(work, f.place)), fs.readFileSync(f.src));
  }
  assert.throws(() => placePersonaFiles(work, [{ src: loadedWeekly.files[0].src, place: '../外.docx', role: 'output' }]), /作業フォルダの外/);
  assert.deepEqual(findGeneratedPlugins(work), []);
  fs.mkdirSync(path.join(work, 'out', 'weekly'), { recursive: true });
  fs.writeFileSync(path.join(work, 'out', 'weekly', 'plugin.json'), '{}');
  fs.mkdirSync(path.join(work, '.plugin-creator-work', 'x'), { recursive: true });
  fs.writeFileSync(path.join(work, '.plugin-creator-work', 'x', 'plugin.json'), '{}');
  assert.deepEqual(findGeneratedPlugins(work), [path.join(work, 'out', 'weekly')]);
  fs.rmSync(work, { recursive: true, force: true });
});

test('REQ-032 作り直しで示した元のプラグインは、始める前からあったものとして記録し、続きから始めるときも同じ記録を読む', () => {
  const runDir = tmp('preexisting');
  const work = path.join(runDir, 'work');
  fs.mkdirSync(path.join(work, 'repo', 'plugins', 'old'), { recursive: true });
  fs.writeFileSync(path.join(work, 'repo', 'plugins', 'old', 'plugin.json'), '{}');
  assert.deepEqual(preexistingPlugins(runDir, work), ['repo/plugins/old']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, PREEXISTING_PLUGINS_FILE), 'utf8')), ['repo/plugins/old']);
  fs.mkdirSync(path.join(work, 'new-plugin'), { recursive: true });
  fs.writeFileSync(path.join(work, 'new-plugin', 'plugin.json'), '{}');
  // 続きから始めるときは、作業フォルダを探し直さず、記録を読む（生成プラグインを元のプラグインに数えない）
  assert.deepEqual(preexistingPlugins(runDir, work, { resume: true }), ['repo/plugins/old']);
  // 記録のない古い実行のフォルダでは、空とする
  fs.rmSync(path.join(runDir, PREEXISTING_PLUGINS_FILE));
  assert.deepEqual(preexistingPlugins(runDir, work, { resume: true }), []);
  fs.rmSync(runDir, { recursive: true, force: true });
});

test('REQ-037 会話の全文の組み立て：クリエイターの発言（質問を含む）とユーザー役の答えが、順に全文で残る', () => {
  const r = createRecorder();
  r.add('user.request', { text: '作ってください' });
  r.add('creator.text', { text: 'はじめに説明します。'.repeat(100), turn: 1 });
  r.add('creator.question', { header: '成果物', question: '成果物は？', options: [{ label: 'A', description: 'a' }], multiSelect: false });
  r.add('user.answer', { index: 0, via: 'AskUserQuestion', question: '成果物は？', answer: 'weekly_report.md', signal: false });
  r.add('creator.question-text', { text: '重複させない', turn: 1 });
  r.add('tool.use', { name: 'Bash', input: {} });
  const c = conversationOf(r.items);
  assert.deepEqual(c.map((x) => [x.role, x.via]), [['user', 'request'], ['creator', 'text'], ['creator', 'AskUserQuestion'], ['user', 'AskUserQuestion']]);
  assert.equal(c[1].text.length, 'はじめに説明します。'.length * 100, '文章の発言は切らない（試作は最後の 300 文字だけだった）');
  assert.deepEqual(c[2].options, [{ label: 'A', description: 'a' }]);
});

test('REQ-015 流れ：質問のツールにも、文章の問いにも、ユーザー役が答える。続きの会話に答えが渡り、問答が qa.jsonl に残る', async () => {
  const runRoot = tmp('flow');
  const prompts = [];
  const sdk = createFakeSdk({
    userRole: ({ prompt }) => (/AI からの質問：[^\n]*成果物/.test(prompt) ? '成果物は weekly_report.md です' : '特に決まっていません'),
    agent: async (ctx) => {
      prompts.push(ctx.prompt);
      if (ctx.turn === 1) {
        await ctx.say('お話を聞かせてください。');
        const answers = await ctx.ask([{ question: '成果物は何ですか？', header: '成果物', options: [{ label: 'Markdown', description: 'md' }, { label: 'Word', description: 'docx' }], multiSelect: false }]);
        assert.equal(answers['成果物は何ですか？'], '成果物は weekly_report.md です');
        const r = await ctx.tool(T('progress'), { items: SETTABLE.map((item) => ({ item, status: '聞いた', quote: '成果物は weekly_report.md です' })) });
        assert.equal(r.isError, false, r.text);
        return 'ほかに伝えたいことはありますか？';
      }
      await ctx.say('分かりました。');
      return '終わりました。';
    },
  });
  const record = await runOuterOnce({ ...baseOptions(runRoot), loaded: loadedWeekly, query: sdk.query, maxExchanges: 2, model: 'claude-opus-5-5' });

  assert.equal(record.stopped.reason, 'max_exchanges');
  assert.equal(record.exchanges, 2);
  // 2 回目の query は、同じセッションの続きで、ユーザー役の答えを渡す
  const agentCalls = sdk.calls.filter((c) => c.kind === 'agent');
  assert.equal(agentCalls.length, 2);
  assert.equal(agentCalls[0].options.resume, undefined);
  assert.equal(agentCalls[1].options.resume, agentCalls[0].sessionId);
  assert.equal(prompts[0], loadedWeekly.persona.request);
  assert.equal(prompts[1], '特に決まっていません');
  // 隔離：クリエイターのモデルは ID、ユーザー設定は読まない、置き換えた版だけを読み込む、MCP サーバーを渡す
  const o = agentCalls[0].options;
  assert.equal(o.model, 'claude-opus-5-5');
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.plugins.length, 1);
  assert.ok(o.plugins[0].path.endsWith('/plugin-creator') || o.plugins[0].path.includes('converted'));
  assert.ok(Object.keys(o.mcpServers).includes('plugin-creator'));
  assert.ok(o.allowedTools.includes('mcp__plugin-creator__progress'));
  assert.equal(o.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
  assert.equal(o.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR, '1', 'コマンドは毎回、作業フォルダから始める（サンドボックスの保護のファイルが生成プラグインの中に重ならないように）');
  assert.equal(o.sandbox, undefined, 'sandbox: false のときは付けない');
  assert.equal(o.env.HOME.includes('agent-home'), true);
  // 会話の全文
  assert.deepEqual(record.conversation.map((c) => `${c.role}:${c.via}`), ['user:request', 'creator:text', 'creator:AskUserQuestion', 'user:AskUserQuestion', 'creator:text', 'user:text', 'creator:text', 'creator:text', 'user:text']);
  assert.equal(record.conversation[2].question, '成果物は何ですか？');
  assert.equal(record.conversation[4].text, 'ほかに伝えたいことはありますか？');
  assert.equal(record.conversation[5].text, '特に決まっていません');
  // 問答の記録（qa.jsonl）：質問のツールの問答と、文章の問いへの返事。記録ができた後の分だけ（本物のフックと同じ）
  assert.deepEqual(record.qa.map((e) => e.type), ['user_prompt', 'user_prompt']);
  assert.equal(record.qa[0].text, '特に決まっていません');
  // 全項目の記録は、答えの中の抜き書きで通る
  const heard = record.grading.grades.find((g) => g.id === 'all-items-heard');
  assert.equal(heard.ok, true, heard.detail);
  assert.equal(record.grading.grades.find((g) => g.id === 'one-plugin-generated').ok, false);
  assert.ok(fs.existsSync(record.recordFile));
  assert.equal(JSON.parse(fs.readFileSync(record.recordFile, 'utf8')).schema, 'outer-record/1');
  assert.ok(fs.existsSync(path.join(record.dirs.work, '資料', '先週の週報.docx')));
  assert.ok(record.costUsd.userRole > 0);
  fs.rmSync(runRoot, { recursive: true, force: true });
});


test('REQ-015 クリエイターが質問の前にチャットに書いた文は、次の質問と一緒にユーザー役に渡る（「上のまとめ」に答えるため。testing.md 6.1）', async () => {
  const runRoot = tmp('notes');
  const prompts = [];
  const sdk = createFakeSdk({
    userRole: ({ prompt }) => { prompts.push(prompt); return '答え'; },
    agent: async (ctx) => {
      if (ctx.turn === 1) {
        await ctx.say('まとめです。\n・成果物は weekly_report.md');
        await ctx.say('足りなければ教えてください。');
        // 1 回の呼び出しに問いの欄が 2 つ：前の文は最初の欄にだけ付く
        await ctx.ask([
          { question: '上のまとめで、違うところは？', header: 'まとめ', options: [{ label: '違いも不足もない', description: 'このままでよい' }], multiSelect: false },
          { question: '2つ目の欄', header: '2つ目', options: [], multiSelect: false },
        ]);
        // 文を書かずに、続けて質問する
        await ctx.ask([{ question: '3つ目の質問', header: '3つ目', options: [], multiSelect: false }]);
        await ctx.say('メモ：ここまでで以上です。');
        return 'ほかにありますか？';
      }
      return '終わりです。';
    },
  });
  const record = await runOuterOnce({ ...baseOptions(runRoot), loaded: loadedWeekly, query: sdk.query, maxExchanges: 2, model: 'claude-opus-5-5' });
  const NOTE_HEAD = 'AI が質問の前にチャットに書いた文：\n';

  const q = (text) => prompts.filter((p) => p.includes(`AI からの質問：${text}`));
  assert.equal(q('上のまとめで、違うところは？').length, 1);
  const first = q('上のまとめで、違うところは？')[0];
  assert.ok(first.includes(`${NOTE_HEAD}まとめです。\n・成果物は weekly_report.md\n\n足りなければ教えてください。`), first);
  // 同じ呼び出しの 2 つ目の欄：今回の前の文はない。履歴には、1 つ目の欄に付いた前の文が入る
  const second = q('2つ目の欄')[0];
  assert.ok(!second.includes(NOTE_HEAD));
  assert.ok(second.includes('AI がチャットに書いた文：まとめです。'));
  // 続けての質問にも前の文はなく、同じ文を二度渡さない
  assert.ok(!q('3つ目の質問')[0].includes(NOTE_HEAD));
  // 文章の問い（手番の最後の文）：問いそのものは前の文に入れず、それより前に書いた文だけを前の文にする
  const textQ = q('ほかにありますか？')[0];
  assert.ok(textQ.includes(`${NOTE_HEAD}メモ：ここまでで以上です。\n\nAI からの質問：ほかにありますか？`), textQ);
  assert.ok(!textQ.slice(textQ.indexOf(NOTE_HEAD)).split('AI からの質問：')[0].includes('ほかにありますか？'));
  // 2 回目の手番：前の文を書かずに終わる。問いだけ
  const last = q('終わりです。')[0];
  assert.ok(!last.includes(NOTE_HEAD));
  // 何を見せたかを、記録に残す
  assert.equal(record.userRole.answers[0].notes, 'まとめです。\n・成果物は weekly_report.md\n\n足りなければ教えてください。');
  assert.equal(record.userRole.answers[1].notes, undefined);
  assert.equal(record.userRole.answers[3].notes, 'メモ：ここまでで以上です。');
  assert.equal(record.userRole.answers[3].via, 'text');
});

test('REQ-015 文を流した直後に質問のコールバックが呼ばれても、前の文は落ちない（本物の SDK は、文の次の制御要求をすぐ処理する）', async () => {
  const runRoot = tmp('race');
  const prompts = [];
  const userSdk = createFakeSdk({ userRole: ({ prompt }) => { prompts.push(prompt); return '答え'; } });
  // 文のメッセージを渡した同じ瞬間に、質問のコールバックを呼ぶ偽の query（消費する側が文を処理するより先に、コールバックが始まる）
  const racing = ({ options }) => {
    const queue = [];
    let waiting = null;
    let closed = false;
    const push = (m) => { if (waiting) { const w = waiting; waiting = null; w({ value: m, done: false }); } else queue.push(m); };
    (async () => {
      push({ type: 'system', subtype: 'init', session_id: 'race-1', model: 'claude-opus-5-5', plugins: [], mcp_servers: [] });
      await new Promise((resolve) => setImmediate(resolve));
      push({ type: 'assistant', session_id: 'race-1', parent_tool_use_id: null, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: '上のまとめです。' }] } });
      await options.canUseTool('AskUserQuestion', { questions: [{ question: '上のまとめで、違うところは？', header: 'まとめ', options: [], multiSelect: false }] }, { signal: new AbortController().signal, toolUseID: 't1', requestId: 'r1' });
      push({ type: 'result', session_id: 'race-1', subtype: 'success', is_error: false, result: '終わり', total_cost_usd: 0, num_turns: 1, duration_ms: 1 });
      closed = true;
      if (waiting) { const w = waiting; waiting = null; w({ value: undefined, done: true }); }
    })();
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () => (queue.length ? Promise.resolve({ value: queue.shift(), done: false }) : closed ? Promise.resolve({ value: undefined, done: true }) : new Promise((resolve) => { waiting = resolve; })),
          return: () => Promise.resolve({ value: undefined, done: true }),
        };
      },
    };
  };
  const record = await runOuterOnce({ ...baseOptions(runRoot), arm: 'without', loaded: loadedWeekly, query: racing, userRoleQuery: userSdk.query, maxExchanges: 1, model: 'claude-opus-5-5' });
  assert.equal(record.stopped.reason, 'max_exchanges', JSON.stringify(record.stopped));
  const first = prompts.find((p) => p.includes('AI からの質問：上のまとめで、違うところは？'));
  assert.ok(first, prompts.join('\n---\n'));
  assert.ok(first.includes('AI が質問の前にチャットに書いた文：\n上のまとめです。'), first);
});

test('REQ-015 流れ：質問のツールの問答は、ヒアリングの記録ができた後に qa.jsonl に残る', async () => {
  const runRoot = tmp('qa');
  const sdk = createFakeSdk({
    userRole: () => '月曜に集計します',
    agent: async (ctx) => {
      await ctx.tool(T('progress'), { stage: '始まり' });
      await ctx.ask([{ question: '進め方は？', header: '進め方', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }]);
      return '以上です';
    },
  });
  const record = await runOuterOnce({ ...baseOptions(runRoot), loaded: loadedWeekly, query: sdk.query, maxExchanges: 1 });
  assert.deepEqual(record.qa.map((e) => e.type), ['ask_user', 'user_prompt']);
  assert.equal(record.qa[0].question.message, '進め方は？');
  assert.equal(record.qa[0].answer, 'User responded: 月曜に集計します');
  fs.rmSync(runRoot, { recursive: true, force: true });
});

test('REQ-015 話し方 hurry：合図が足され、位置が記録に残る', async () => {
  const runRoot = tmp('hurry');
  const sdk = createFakeSdk({
    userRole: () => '短い答え',
    agent: async (ctx) => {
      await ctx.tool(T('progress'), { stage: '始まり' });
      for (let i = 0; i < 8; i += 1) await ctx.ask([{ question: `問い${i}`, header: 'h', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }]);
      return 'おわり';
    },
  });
  const record = await runOuterOnce({ ...baseOptions(runRoot), loaded: loadedWeekly, query: sdk.query, styleName: 'hurry', maxExchanges: 1 });
  const n = loadedWeekly.persona.styles.hurry.signal.afterAnswers;
  assert.equal(record.userRole.signals.length, 1);
  assert.equal(record.userRole.signals[0].answerIndex, n);
  assert.equal(record.style, 'hurry');
  const answerItem = record.items.find((i) => i.kind === 'user.answer' && i.index === n);
  assert.equal(answerItem.signal, true);
  assert.ok(answerItem.answer.endsWith(loadedWeekly.persona.styles.hurry.signal.text));
  // 合図の後に進め方の問いがないので、この観点は不合格
  assert.equal(record.grading.grades.find((g) => g.id === 'hurry-options').ok, false);
  fs.rmSync(runRoot, { recursive: true, force: true });
});

test('REQ-015 流れ：利用枠の上限のエラーで止まったら、理由 usage_limit で終わる。ほかの失敗は、その種類で終わる', async () => {
  const runRoot = tmp('limit');
  const limited = createFakeSdk({ agent: async () => { throw new Error("You've hit your session limit. Resets at 3pm"); }, userRole: () => 'x' });
  const r1 = await runOuterOnce({ ...baseOptions(runRoot), loaded: loadedWeekly, query: limited.query });
  assert.equal(r1.stopped.reason, 'usage_limit');
  const failing = createFakeSdk({ agent: async () => { throw new Error('boom'); }, userRole: () => 'x' });
  const r2 = await runOuterOnce({ ...baseOptions(runRoot), loaded: loadedWeekly, query: failing.query });
  assert.equal(r2.stopped.reason, 'error_during_execution');
  fs.rmSync(runRoot, { recursive: true, force: true });
});

test('REQ-015 ユーザー役の答えが道具の呼び出しの形のまま直らなければ、クリエイターに渡さず、試験の仕組みの失敗（user_role_failed）で会話を止める', async () => {
  const runRoot = tmp('markup');
  const markup = `${'<'}invoke name="Read">\n${'<'}parameter name="file_path">資料/先週の週報.docx${'<'}/parameter>\n${'<'}/invoke>`;
  let userCalls = 0;
  const seen = [];
  const sdk = createFakeSdk({
    userRole: () => { userCalls += 1; return markup; },
    agent: async (ctx) => {
      seen.push(ctx.turn);
      const answers = await ctx.ask([{ question: '先週の週報には、何が書いてありますか？', header: '週報', options: [{ label: '答えを書く', description: '' }], multiSelect: false }]);
      seen.push(`answered:${JSON.stringify(answers)}`);
      return '分かりました。';
    },
  });
  const record = await runOuterOnce({ ...baseOptions(runRoot), loaded: loadedWeekly, query: sdk.query, maxExchanges: 3 });
  assert.equal(record.stopped.reason, USER_ROLE_FAILED);
  assert.match(record.stopped.message, /道具の呼び出しの形でした/);
  assert.equal(userCalls, MARKUP_RETRIES + 1);
  // クリエイターは答えを受け取らず、次の手番も始まらない。答えの記録も残らない
  assert.deepEqual(seen, [1]);
  assert.equal(sdk.calls.filter((c) => c.kind === 'agent').length, 1);
  assert.equal(record.items.filter((i) => i.kind === 'user.answer').length, 0);
  fs.rmSync(runRoot, { recursive: true, force: true });
});

test('REQ-015 文章の問いへのユーザー役の答えが道具の呼び出しの形のまま直らなくても、同じく user_role_failed で止める', async () => {
  const runRoot = tmp('markup-text');
  const sdk = createFakeSdk({
    userRole: () => `${'<'}function_calls>`,
    agent: async () => 'ファイルはどこにありますか？',
  });
  const record = await runOuterOnce({ ...baseOptions(runRoot), loaded: loadedWeekly, query: sdk.query, maxExchanges: 3 });
  assert.equal(record.stopped.reason, USER_ROLE_FAILED);
  assert.equal(sdk.calls.filter((c) => c.kind === 'agent').length, 1);
  assert.equal(record.items.filter((i) => i.kind === 'user.answer').length, 0);
  fs.rmSync(runRoot, { recursive: true, force: true });
});

test('REQ-015 ユーザー役の呼び出しの失敗は呼び直す。呼び直しても失敗したら user_role_failed、利用枠の上限なら呼び直さずに usage_limit で止める', async () => {
  const runRoot = tmp('call-failed');
  const ask = async (ctx) => {
    await ctx.ask([{ question: '成果物は何ですか？', header: '成果物', options: [{ label: '答えを書く', description: '' }], multiSelect: false }]);
    return '分かりました。';
  };
  // 1回だけ失敗する（空の答え）：呼び直した答えで続く
  let n1 = 0;
  const once = createFakeSdk({ userRole: () => ((n1 += 1) === 1 ? '' : '成果物は weekly_report.md です'), agent: ask });
  const r1 = await runOuterOnce({ ...baseOptions(runRoot), loaded: loadedWeekly, query: once.query, maxExchanges: 1 });
  assert.notEqual(r1.stopped.reason, USER_ROLE_FAILED);
  assert.equal(r1.items.filter((i) => i.kind === 'user.answer')[0].answer, '成果物は weekly_report.md です');
  assert.equal(r1.userRole.answers[0].callRetries, 1);
  // ふつうの失敗が続く：CALL_RETRIES 回呼び直した後、user_role_failed で止め、クリエイターに渡さない
  let n2 = 0;
  const failing = createFakeSdk({ userRole: () => { n2 += 1; return new Error('API Error: 500 Internal server error'); }, agent: ask });
  const r2 = await runOuterOnce({ ...baseOptions(runRoot), loaded: loadedWeekly, query: failing.query, maxExchanges: 3 });
  assert.equal(r2.stopped.reason, USER_ROLE_FAILED);
  assert.match(r2.stopped.message, /ユーザー役の呼び出しに失敗しました/);
  assert.equal(n2, CALL_RETRIES + 1);
  assert.equal(failing.calls.filter((c) => c.kind === 'agent').length, 1);
  assert.equal(r2.items.filter((i) => i.kind === 'user.answer').length, 0);
  // 利用枠の上限：呼び直さずに usage_limit で止める（比べる EVAL の全体が止まる）
  let n3 = 0;
  const limited = createFakeSdk({ userRole: () => { n3 += 1; return new Error("You've hit your usage limit · resets at 3am"); }, agent: ask });
  const r3 = await runOuterOnce({ ...baseOptions(runRoot), loaded: loadedWeekly, query: limited.query, maxExchanges: 3 });
  assert.equal(r3.stopped.reason, 'usage_limit');
  assert.equal(n3, 1);
  fs.rmSync(runRoot, { recursive: true, force: true });
});

test('REQ-015 サンドボックスの道具がなければ、始めずに断る（黙って外で動かさない）', async () => {
  const runRoot = tmp('sandbox');
  await assert.rejects(
    () => runOuterOnce({ ...baseOptions(runRoot), sandbox: true, sandboxCheck: () => ({ available: false, missing: ['bwrap', 'socat'] }), loaded: loadedWeekly, query: createFakeSdk({ agent: async () => 'x', userRole: () => 'x' }).query }),
    /bwrap、socat/,
  );
  fs.rmSync(runRoot, { recursive: true, force: true });
});

test('REQ-015 置き換えた版が使うエクステンションのツールを、EVAL の仕組みが出していなければ、始めずに断る', async () => {
  const runRoot = tmp('mismatch');
  const convert = (src, out) => {
    const r = fakeConvert(src, out);
    r.report.extension_tools.push({ server: 'plugin-creator', tool: 'unknown_tool' });
    fs.writeFileSync(path.join(out, '.eval', 'conversion-report.json'), JSON.stringify(r.report));
    return r;
  };
  await assert.rejects(() => runOuterOnce({ ...baseOptions(runRoot), convert, loaded: loadedWeekly, query: createFakeSdk({ agent: async () => 'x', userRole: () => 'x' }).query }), /plugin-creator\/unknown_tool/);
  fs.rmSync(runRoot, { recursive: true, force: true });
});

// ---- 本物の記録のツールと本物の組み立てのスクリプトで、生成までたどる -----------------------------------------------

/** 見本の parts を、この会話で記録した 4 つのナレッジ（K-01〜K-04）に合わせて写す */
function copySampleParts(workDir) {
  const to = path.join(workDir, '.plugin-creator-work', 'parts');
  fs.cpSync(SAMPLE_PARTS, to, { recursive: true });
  const worker = path.join(to, 'slots', 'worker-task.worker.md');
  fs.writeFileSync(worker, `${fs.readFileSync(worker, 'utf8').replace('K-06', 'K-04')}\n- 成果物は weekly_report.md（K-02）。\n`);
}

test('REQ-020 生成までたどる：本物の記録のツールで承認まで進め、承認の後に本物の組み立てのスクリプトで作ると、生成で止まり、採点が通る', async () => {
  const runRoot = tmp('e2e');
  const persona = JSON.parse(JSON.stringify(loadedWeekly.persona));
  persona.files = [];
  persona.knowledge = persona.knowledge.filter((k) => k.id === 'output');
  const loaded = { ...loadedWeekly, persona, files: [] };
  const answers = [];
  let statePath;
  const sdk = createFakeSdk({
    userRole: ({ prompt }) => {
      const a = /AI からの質問：[^\n]*作ってよいですか/.test(prompt) ? '作ってください' : '成果物は weekly_report.md です';
      answers.push(a);
      return a;
    },
    agent: async (ctx) => {
      const work = ctx.options.cwd;
      // 画面を開き、返った URL を最初の問いより前にチャットに示す（REQ-043。make-plugin の始まりの手番の2）
      const opened = await ctx.tool(T('open'), {});
      assert.equal(opened.isError, false, opened.text);
      const url = /https?:\/\/\S+/.exec(opened.text)?.[0];
      assert.ok(url, opened.text);
      await ctx.say(`お話を聞きます。決まったことは plugin-creator の画面で見られます：${url}`);
      await ctx.ask([{ question: '成果物と、週報に書くことを教えてください', header: '成果物', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }]);
      await ctx.tool(T('progress'), { stage: '始まり' });
      await ctx.tool(T('progress'), { items: SETTABLE.map((item) => ({ item, status: '聞いた', quote: '成果物は weekly_report.md です' })) });
      const k = (kind, item, text) => ({ kind, item, text, source: 'ヒアリングの答え', quote: '成果物は weekly_report.md です', status: '決まった' });
      const rec = await ctx.tool(T('record'), {
        knowledge: [
          k('合否の決め方', '合否の決め方', '成果物は weekly_report.md で、見出し「今週やったこと」があれば合格とする。'),
          k('それ以外', '決まった書き方やルール', '宛先は部長。です・ます調の敬語で書く。'),
          k('合否の決め方', '決まった書き方やルール', '数字は半角で書く（例：3件）。'),
          k('それ以外', '守らないと困ること', '社外の人の名前は書かない。'),
        ],
      });
      assert.equal(rec.isError, false, rec.text);
      // 作業の定義の案（承認の前に書いてよい唯一のファイル）
      const draft = path.join(work, '.plugin-creator-work', 'draft', 'task.json');
      await ctx.tool('Write', { file_path: draft, content: '{}' }, {
        run: () => {
          fs.mkdirSync(path.dirname(draft), { recursive: true });
          fs.copyFileSync(path.join(SAMPLE_PARTS, 'task.json'), draft);
          return 'ok';
        },
      });
      const conf = await ctx.tool(T('confirm'), {
        knowledgeIds: ['K-01', 'K-02', 'K-03', 'K-04'],
        behavior: '週報を作る。',
        taskPath: '.plugin-creator-work/draft/task.json',
        // 組み立てのスクリプトは、作業エージェントが書く eval.json（見本の parts）を、ここで確かめた課題と突き合わせる（X2-03）。
        // 課題は頼むときの言葉で結びつく。仮の入力のファイルの path は、生成プラグインの中の置き場所
        evalTasks: [{
          prompt: SAMPLE_EVAL.prompt,
          inputs: [{ path: 'tests/eval/T-01/inputs/memo.txt', provisional: true }],
          criteria: ['K-01', 'K-03'],
          settings: SAMPLE_EVAL.settings,
        }],
      });
      assert.equal(conf.isError, false, conf.text);
      await ctx.ask([{ question: 'この内容で作ってよいですか？', header: '承認', options: [{ label: '作る', description: '' }, { label: '直す', description: '' }] }]);
      const gen = await ctx.tool(T('progress'), { stage: '生成', approvalQuote: '作ってください' });
      assert.equal(gen.isError, false, gen.text);
      statePath = path.join(ctx.options.env.HOME, '..', 'copilot-home');
      // 読み取り役は選んだモデルのまま、作業エージェントは費用の低いモデルで動く（REQ-045・REQ-046）
      await ctx.subagent({ type: 'plugin-creator:reader', description: '読む' }, async (sub) => { await sub.say('読みました'); });
      await ctx.subagent({ type: 'plugin-creator:worker', description: '書く', model: 'claude-haiku-5-5' }, async (sub) => { await sub.say('書きました'); });
      const build = await ctx.tool('Bash', { command: `python3 -I ${SCAFFOLD} build --hearing STATE --work ${work}/.plugin-creator-work --out ${work}/weekly-report` }, {
        run: () => {
          copySampleParts(work);
          const state = findState(path.join(ctx.options.env.HOME, '..', 'copilot-home'));
          const r = spawnSync('python3', ['-I', SCAFFOLD, 'build', '--hearing', state, '--work', path.join(work, '.plugin-creator-work'), '--out', path.join(work, 'weekly-report')], { encoding: 'utf8', cwd: work });
          if (r.status !== 0) throw new Error(`組み立てに失敗しました：${r.stdout}${r.stderr}`);
          return r.stdout.slice(0, 200);
        },
      });
      assert.equal(build.isError, false, build.text);
      return '作りました。';
    },
  });
  const record = await runOuterOnce({ ...baseOptions(runRoot), loaded, query: sdk.query, model: 'claude-opus-5-5' });
  assert.equal(record.stopped.reason, 'generated', JSON.stringify(record.stopped));
  assert.equal(record.exchanges, 0, '1 回の手番で生成まで進んだので、文章の返事は返さない');
  assert.deepEqual(record.generated.plugins, ['weekly-report']);
  assert.equal(record.state.stage, 'generate');
  assert.ok(record.state.approvedAt);
  const byId = Object.fromEntries(record.grading.grades.map((g) => [g.id, g]));
  assert.equal(byId['all-items-heard'].ok, true, byId['all-items-heard'].detail);
  assert.equal(byId['no-generation-before-approval'].ok, true, byId['no-generation-before-approval'].detail);
  assert.equal(byId['one-plugin-generated'].ok, true);
  assert.equal(byId['screen-url-shown'].ok, true, byId['screen-url-shown'].detail);
  assert.equal(byId['embedded:output'].ok, true, byId['embedded:output'].detail);
  assert.equal(byId['task:output'].ok, true, byId['task:output'].detail);
  assert.equal(byId['main-model'].ok, true, byId['main-model'].detail);
  assert.equal(byId['worker-model'].ok, true, byId['worker-model'].detail);
  assert.equal(record.mainModel, 'claude-opus-5-5');
  assert.deepEqual(record.subagents.map((a) => [a.type, a.model]), [['plugin-creator:reader', 'claude-opus-5-5'], ['plugin-creator:worker', 'claude-haiku-5-5']]);
  assert.equal(record.grading.verdict.ok, true, JSON.stringify(record.grading.verdict));
  assert.equal(record.grading.exampleCandidate, true);
  // 記録する数が、記録と採点の結果に出る（合否には入らない）
  const counts = record.grading.counts;
  assert.equal(counts.questions.askTool, 2);
  assert.equal(counts.askToolCalls.callsWithMultiple, 0);
  assert.equal(counts.recordRefusals.total, 0);
  // 記録のツールの呼び出しは、順番つきで残る。承認の記録は、組み立ての前
  const approval = record.toolEvents.find((e) => e.type === 'tool.call' && e.args?.stage === '生成');
  const build = record.items.find((i) => i.kind === 'tool.use' && i.name === 'Bash');
  assert.ok(approval.seq < build.seq);
  assert.ok(statePath);
  fs.rmSync(runRoot, { recursive: true, force: true });
});

function findState(copilotHome) {
  const base = path.join(copilotHome, 'plugin-data', 'plugin-creator', 'hearings');
  const dir = fs.readdirSync(base)[0];
  return path.join(base, dir, 'state.json');
}

test('REQ-020 承認の前に組み立てのスクリプトが動いた会話は、採点で不合格になる', async () => {
  const runRoot = tmp('early');
  const sdk = createFakeSdk({
    userRole: () => 'はい',
    agent: async (ctx) => {
      await ctx.tool('Bash', { command: 'python3 -I /x/scaffold.py build --out o' }, { run: () => 'ok' });
      return '作りました';
    },
  });
  const record = await runOuterOnce({ ...baseOptions(runRoot), loaded: loadedWeekly, query: sdk.query, maxExchanges: 1 });
  assert.equal(record.grading.grades.find((g) => g.id === 'no-generation-before-approval').ok, false);
  assert.equal(record.stopped.reason, 'max_exchanges', 'scaffold を呼んだだけでは、生成プラグインはできない（この台本は、何も作らない）');
  fs.rmSync(runRoot, { recursive: true, force: true });
});

test('REQ-015 プラグインなしの腕：何も読み込まず、エクステンションのツールも渡さない', async () => {
  const runRoot = tmp('without');
  const sdk = createFakeSdk({ userRole: () => 'x', agent: async () => '作れません' });
  const record = await runOuterOnce({ ...baseOptions(runRoot), loaded: loadedWeekly, query: sdk.query, arm: 'without', maxExchanges: 1 });
  const o = sdk.calls.find((c) => c.kind === 'agent').options;
  assert.deepEqual(o.plugins, []);
  assert.equal(o.mcpServers, undefined);
  assert.equal(record.creator.converted, null);
  assert.ok(!record.grading.grades.some((g) => g.id === 'all-items-heard'));
  fs.rmSync(runRoot, { recursive: true, force: true });
});

test('REQ-015 インストラクション（rules）は、Claude Code では読み込まれないので、変換スクリプトが写した .eval/rules.md を、システムプロンプトに足す', async () => {
  const runRoot = tmp('rules');
  const convert = (src, out) => {
    const r = fakeConvert(src, out);
    fs.writeFileSync(path.join(out, '.eval', 'rules.md'), '日本語で答える。\n');
    return r;
  };
  const sdk = createFakeSdk({ userRole: () => 'x', agent: async () => '終わり' });
  await runOuterOnce({ ...baseOptions(runRoot), convert, loaded: loadedWeekly, query: sdk.query, maxExchanges: 1 });
  const o = sdk.calls.find((c) => c.kind === 'agent').options;
  assert.equal(o.systemPrompt.append, '日本語で答える。');
  // rules がなければ、足さない
  const sdk2 = createFakeSdk({ userRole: () => 'x', agent: async () => '終わり' });
  await runOuterOnce({ ...baseOptions(runRoot), loaded: loadedWeekly, query: sdk2.query, maxExchanges: 1 });
  assert.equal(sdk2.calls.find((c) => c.kind === 'agent').options.systemPrompt.append, undefined);
  fs.rmSync(runRoot, { recursive: true, force: true });
});

test('REQ-015 記録する数：1 回の質問のツールの問いの欄の数、問いの数、記録のツールの断りとその後の直しが、記録の採点の結果に出る。合否には入らない', async () => {
  const runRoot = tmp('counts');
  const opts = (n) => [{ label: 'A', description: '' }, { label: 'B', description: '' }].map((o) => ({ ...o, label: `${o.label}${n}` }));
  const sdk = createFakeSdk({
    userRole: () => '月曜に集計します',
    agent: async (ctx) => {
      await ctx.tool(T('progress'), { stage: '始まり' });
      // 1 回に問いを 1 つ
      await ctx.ask([{ question: '進め方は？', header: '進め方', options: opts(1) }]);
      // 1 回に問いを 2 つ（hearing.md 4.1 の「1 回に 1 つ」に反する）
      await ctx.ask([{ question: '成果物は？', header: '成果物', options: opts(2) }, { question: '入力は？', header: '入力', options: opts(3) }]);
      // 記録のツールが断る（抜き書きなし）→ 直して成功
      const refused = await ctx.tool(T('progress'), { items: [{ item: '成果物', status: '聞いた', quote: '' }] });
      assert.equal(refused.isError, true);
      const fixed = await ctx.tool(T('progress'), { items: [{ item: '成果物', status: '聞いた', quote: '月曜に集計します' }] });
      assert.equal(fixed.isError, false, fixed.text);
      // 種類の名前の誤りで断られる（この後に、同じツールの成功がある）
      const refused2 = await ctx.tool(T('record'), { knowledge: [{ kind: '種類違い', item: '進め方', text: 'x', source: 'ヒアリングの答え', quote: 'x', status: '決まった' }] });
      assert.equal(refused2.isError, true);
      // 保留と AI の判断
      await ctx.tool(T('progress'), { items: [{ item: '資産', status: '保留', quote: '月曜に集計します', holder: '田中さん' }] });
      await ctx.tool(T('record'), { knowledge: [{ kind: 'それ以外', item: '進め方', text: '月曜に集計する', source: 'AI の判断（ユーザーが任せた）', quote: '月曜に集計します', status: '決まった' }] });
      return '以上です';
    },
  });
  const record = await runOuterOnce({ ...baseOptions(runRoot), loaded: loadedWeekly, query: sdk.query, maxExchanges: 1 });
  const c = record.grading.counts;
  assert.deepEqual(c.questions, { total: 4, askTool: 3, text: 1 });
  assert.deepEqual(c.askToolCalls, { calls: 2, maxQuestionsPerCall: 2, callsWithMultiple: 1 });
  assert.equal(c.recordRefusals.total, 2);
  assert.equal(c.recordRefusals.fixed, 2);
  assert.equal(c.recordRefusals.unfixed, 0);
  assert.deepEqual(c.recordRefusals.byTool.progress, { calls: 4, refused: 1, fixed: 1, unfixed: 0 });
  assert.deepEqual(c.recordRefusals.byTool.record, { calls: 2, refused: 1, fixed: 1, unfixed: 0 });
  assert.match(c.recordRefusals.samples[0].reason, /抜き書き/);
  assert.deepEqual(c.pending, { count: 1, items: ['資産'] });
  assert.equal(c.aiDecisions.count, 1);
  // 問いの欄の数は、記録の問いに残る
  const asks = record.items.filter((i) => i.kind === 'creator.question');
  assert.deepEqual(asks.map((q) => [q.group, q.groupSize]), [[1, 1], [2, 2], [2, 2]]);
  assert.equal(JSON.parse(fs.readFileSync(record.recordFile, 'utf8')).grading.counts.askToolCalls.callsWithMultiple, 1);
  fs.rmSync(runRoot, { recursive: true, force: true });
});

/** 生成プラグインができた会話（承認の記録はない）で、メインと作業エージェントのモデルだけを変える */
async function modelRun({ workerModel, readerModel = null, requested = 'claude-opus-5-5', skipWorker = false, runRoot }) {
  const sdk = createFakeSdk({
    userRole: () => 'x',
    agent: async (ctx) => {
      await ctx.subagent({ type: 'plugin-creator:reader', description: '読む', model: readerModel }, async (sub) => { await sub.say('読みました'); });
      if (!skipWorker) await ctx.subagent({ type: 'plugin-creator:worker', description: '書く', model: workerModel }, async (sub) => { await sub.say('書きました'); });
      const dir = path.join(ctx.options.cwd, 'p');
      await ctx.tool('Bash', { command: 'mkdir p' }, { run: () => { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'plugin.json'), '{}'); return 'ok'; } });
      return '作りました';
    },
  });
  return runOuterOnce({ ...baseOptions(runRoot), loaded: loadedWeekly, query: sdk.query, model: requested, maxExchanges: 1 });
}

test('REQ-045 REQ-046 モデル：メインは指定のモデル、作業エージェントは費用の低いモデルで動いたことを、実行の記録から採点する', async () => {
  const runRoot = tmp('models');
  const record = await modelRun({ workerModel: 'claude-haiku-5-5', runRoot });
  const g = Object.fromEntries(record.grading.grades.map((x) => [x.id, x]));
  assert.equal(g['main-model'].ok, true, g['main-model'].detail);
  assert.equal(g['worker-model'].ok, true, g['worker-model'].detail);
  assert.deepEqual(record.mainModels, ['claude-opus-5-5']);
  assert.deepEqual(record.subagents.map((a) => [a.type, a.models]), [['plugin-creator:reader', ['claude-opus-5-5']], ['plugin-creator:worker', ['claude-haiku-5-5']]]);
  assert.equal(readConvertedAgentModel(record.creator.converted, 'worker'), 'claude-haiku-5-5');
  assert.equal(readConvertedAgentModel(record.creator.converted, 'reader'), null, 'inherit は null');
  assert.equal(readConvertedAgentModel(record.creator.converted, 'ない'), null);

  // 選ぶモデルを変えて始めると、そのモデルで対話が行われる。作業エージェントは変わらず費用の低いモデル
  const haiku = await modelRun({ workerModel: 'claude-haiku-5-5', requested: 'claude-sonnet-5-5', runRoot });
  assert.equal(haiku.grading.grades.find((x) => x.id === 'main-model').ok, true);
  assert.deepEqual(haiku.mainModels, ['claude-sonnet-5-5']);
  assert.equal(haiku.grading.grades.find((x) => x.id === 'worker-model').ok, true);
  fs.rmSync(runRoot, { recursive: true, force: true });
});

test('REQ-046 作業エージェントが高いモデルで動いた・動かなかったときは、不合格になる（思考力の高いモデルの合格が落ちる）', async () => {
  const runRoot = tmp('models-bad');
  const wrong = await modelRun({ workerModel: 'claude-opus-5-5', runRoot });
  const w = wrong.grading.grades.find((x) => x.id === 'worker-model');
  assert.equal(w.ok, false);
  assert.match(w.detail, /費用の低いモデルは claude-haiku-5-5 だが、claude-opus-5-5 でも動いた/);
  assert.ok(wrong.grading.verdict.failed.includes('worker-model'));
  assert.equal(wrong.grading.verdict.ok, false);
  const none = await modelRun({ skipWorker: true, runRoot });
  assert.match(none.grading.grades.find((x) => x.id === 'worker-model').detail, /作業エージェントが動かなかった/);
  fs.rmSync(runRoot, { recursive: true, force: true });
});

test('REQ-045 メインのメッセージのモデルが指定と違えば不合格（SDK が別のモデルに切り替えたとき）', async () => {
  const runRoot = tmp('models-switch');
  const sdk = createFakeSdk({
    userRole: () => 'x',
    agent: async (ctx) => {
      await ctx.say('一つ目');
      await ctx.say('切り替わった後', null, 'claude-sonnet-5-5');
      return '作れません';
    },
  });
  const record = await runOuterOnce({ ...baseOptions(runRoot), loaded: loadedWeekly, query: sdk.query, model: 'claude-opus-5-5', maxExchanges: 1 });
  const g = record.grading.grades.find((x) => x.id === 'main-model');
  assert.equal(g.ok, false);
  assert.deepEqual(record.mainModels, ['claude-opus-5-5', 'claude-sonnet-5-5']);
  // 生成プラグインができていなければ、作業エージェントの観点はない
  assert.ok(!record.grading.grades.some((x) => x.id === 'worker-model'));
  fs.rmSync(runRoot, { recursive: true, force: true });
});
