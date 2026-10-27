// クリエイターのエクステンションの置き換え（creator-tools.mjs）の試験。実際のモデルは使わない。
// 動かし方（リポジトリの根で）：node --test "tests/dev-eval/runner/*.test.mjs"

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ITEMS } from '../../../com.github.copilot/extensions/plugin-creator/names.mjs';
import { loadPersona } from '../personas/validate.mjs';
import { CREATOR_SERVER_NAME, createCreatorToolkit, createFakeGh, toMcpResult } from './creator-tools.mjs';
import { createFakeSdk } from './outer-fake-sdk.mjs';
import { placePersonaFiles } from './outer-run.mjs';
import { tempDir } from './temp-dirs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = (prefix) => tempDir(`creator-tools-${prefix}`);
const SETTABLE = ITEMS.filter((i) => !i.computed && !i.rebuildOnly).map((i) => i.name);

async function withToolkit(fn) {
  const workDir = tmp('work');
  const copilotHome = tmp('home');
  const events = [];
  const toolkit = await createCreatorToolkit({ workDir, copilotHome, sessionId: 'sess-1', onEvent: (e) => events.push(e) });
  try {
    await fn({ toolkit, workDir, copilotHome, events });
  } finally {
    await toolkit.shutdown();
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(copilotHome, { recursive: true, force: true });
  }
}

test('REQ-015 REQ-052 エクステンションのツール 9 つ（直すときの change を含む）を、サーバー名 plugin-creator の MCP のツールとして出す', async () => {
  await withToolkit(async ({ toolkit }) => {
    assert.equal(CREATOR_SERVER_NAME, 'plugin-creator');
    assert.deepEqual(toolkit.tools.map((t) => t.name), ['open', 'state', 'progress', 'record', 'confirm', 'results', 'doc_text', 'issue', 'change']);
    assert.deepEqual(toolkit.mcpTools, toolkit.tools.map((t) => `mcp__plugin-creator__${t.name}`));
    for (const t of toolkit.tools) {
      assert.equal(typeof t.description, 'string');
      assert.ok(t.description.length > 20, t.name);
      assert.equal(t.inputSchema.type, 'object');
    }
    // 説明の文に、仮の印が残っていない（モデルの振る舞いを決める文なので）
    assert.ok(toolkit.tools.every((t) => !t.description.includes('【仮】')));
  });
});

test('REQ-015 引数の決まり（JSON Schema）は、Copilot 版のエクステンションの定義と同じものを、そのまま出す', async () => {
  const { TOOL_DEFS } = await import('../../../com.github.copilot/extensions/plugin-creator/tool-defs.mjs');
  await withToolkit(async ({ toolkit }) => {
    for (const def of TOOL_DEFS) {
      const tool = toolkit.tools.find((t) => t.name === def.name);
      assert.deepEqual(tool.inputSchema, def.parameters, def.name);
      assert.equal(tool.description, def.description, def.name);
    }
  });
});

test('REQ-021 記録のツールは、COPILOT_HOME の下に state.json を作り、作業フォルダには何も作らない', async () => {
  await withToolkit(async ({ toolkit, workDir, copilotHome, events }) => {
    const out = await toolkit.callTool('progress', { stage: '始まり' });
    assert.match(out, /記録しました/);
    const statePath = path.join(copilotHome, 'plugin-data', 'plugin-creator', 'hearings', 'sess-1', 'state.json');
    assert.ok(fs.existsSync(statePath));
    assert.equal(toolkit.readState().stage, 'start');
    assert.deepEqual(fs.readdirSync(workDir), []);
    // 呼び出しと結果が、組にして残る
    assert.deepEqual(events.map((e) => [e.type, e.tool, e.callId]), [['tool.call', 'progress', 1], ['tool.result', 'progress', 1]]);
    assert.equal(events[1].isError, false);
  });
});

test('REQ-015 断られた呼び出し（抜き書きなし）は、エクステンションが返す failure の結果を、isError の結果として残し、理由の文を取る。記録は変わらない', async () => {
  await withToolkit(async ({ toolkit, events }) => {
    const out = await toolkit.callTool('progress', { items: [{ item: '成果物', status: '聞いた', quote: '' }] });
    // MCP の公式の形（isError と content の文）。理由の文がそのまま入り、{ textResultForLlm, resultType } の JSON にならない
    assert.equal(out.isError, true);
    assert.equal(out.content.length, 1);
    assert.equal(out.content[0].type, 'text');
    assert.match(out.content[0].text, /抜き書き/);
    assert.doesNotMatch(out.content[0].text, /textResultForLlm|resultType/);
    const result = events.find((e) => e.type === 'tool.result');
    assert.equal(result.isError, true);
    assert.equal(result.result, out.content[0].text);
    assert.equal(toolkit.readState(), null);
  });
});

test('REQ-015 画面の文書をテキストにできない失敗も、理由の文のまま isError の結果になる（例外は投げない）', async () => {
  await withToolkit(async ({ toolkit, events }) => {
    const out = await toolkit.callTool('doc_text', { path: '資料/ない文書.docx' });
    assert.equal(out.isError, true);
    assert.ok(out.content[0].text.length > 0);
    assert.doesNotMatch(out.content[0].text, /textResultForLlm|resultType/);
    assert.equal(events.find((e) => e.type === 'tool.result').isError, true);
  });
});

test('REQ-015 toMcpResult：成功の文字はそのまま、failure・rejected・denied は isError の結果、ToolResultObject でないものは触らない', () => {
  assert.equal(toMcpResult('記録しました'), '記録しました');
  assert.equal(toMcpResult({ textResultForLlm: '記録しました', resultType: 'success' }), '記録しました');
  assert.equal(toMcpResult({ textResultForLlm: '記録しました' }), '記録しました');
  for (const resultType of ['failure', 'rejected', 'denied']) {
    assert.deepEqual(toMcpResult({ textResultForLlm: '理由の文', resultType }), { content: [{ type: 'text', text: '理由の文' }], isError: true }, resultType);
  }
  const mcp = { content: [{ type: 'text', text: 'x' }], isError: true };
  assert.equal(toMcpResult(mcp), mcp);
  assert.equal(toMcpResult(undefined), undefined);
  assert.equal(toMcpResult(null), null);
  const other = { a: 1 };
  assert.equal(toMcpResult(other), other);
});

test('REQ-049 問答の記録（qa.jsonl）：ヒアリングの最中だけ、問いと答えと打った発言を同じ形で残す', async () => {
  await withToolkit(async ({ toolkit }) => {
    // 記録ができる前は、残さない（本物のフックと同じ条件）
    toolkit.recordAsk({ question: '最初の問い', answer: '最初の答え' });
    assert.deepEqual(toolkit.readQa(), []);
    await toolkit.callTool('progress', { stage: '始まり' });
    toolkit.recordAsk({ question: '成果物は？', choices: [{ label: 'Markdown', description: '' }, 'Word'], header: '成果物', answer: 'weekly_report.md です' });
    toolkit.recordPrompt('文章での返事');
    const qa = toolkit.readQa();
    assert.deepEqual(qa.map((e) => e.type), ['ask_user', 'user_prompt']);
    assert.equal(qa[0].question.message, '成果物は？');
    assert.deepEqual(qa[0].question.choices, ['Markdown', 'Word']);
    assert.equal(qa[0].answer, 'User responded: weekly_report.md です');
    assert.equal(qa[0].outcome, 'answered');
    assert.equal(qa[1].text, '文章での返事');
    // 状態取得ツールが、最後の問答として読める
    const state = await toolkit.callTool('state', { include: '最後の問答' });
    assert.match(state, /成果物は？/);
    assert.match(state, /weekly_report\.md です/);
  });
});

test('REQ-017 文書をテキストにするツールは、作業フォルダに置いた docx の文字を返す', async () => {
  const loaded = await loadPersona(path.join(here, '..', 'personas', 'weekly-report'));
  await withToolkit(async ({ toolkit, workDir }) => {
    placePersonaFiles(workDir, loaded.files);
    const text = await toolkit.callTool('doc_text', { path: '資料/先週の週報.docx' });
    assert.match(text, /■今週の売上/);
    assert.match(text, /以上/);
  });
});

test('REQ-049 起票は偽物の gh で受け、題と本文を残すだけ（本物の gh は動かさない）', async () => {
  await withToolkit(async ({ toolkit }) => {
    const out = await toolkit.callTool('issue', { title: '質問の改善案：進め方', body: '段階と項目の名前だけで書いた本文' });
    assert.match(out, /起票しました：https:\/\/github\.com\/xclang-brain\/plugin-creator\/issues\/9001/);
    assert.equal(toolkit.issues.length, 1);
    assert.equal(toolkit.issues[0].title, '質問の改善案：進め方');
    assert.equal(toolkit.issues[0].body, '段階と項目の名前だけで書いた本文');
    assert.ok(toolkit.issues[0].args.includes('--repo'));
  });
  const issues = [];
  const r = await createFakeGh(issues)(['issue', 'create', '--title=題'], '本文');
  assert.equal(r.code, 0);
  assert.equal(issues[0].title, '題');
});

test('REQ-049 偽物の gh は、起票ごとに違う Issue の URL を返し、返した URL も残す', async () => {
  await withToolkit(async ({ toolkit }) => {
    const first = await toolkit.callTool('issue', { title: '質問の改善案：一つ目', body: '本文一' });
    const second = await toolkit.callTool('issue', { title: '質問の改善案：二つ目', body: '本文二' });
    assert.match(first, /issues\/9001(\s|$)/);
    assert.match(second, /issues\/9002(\s|$)/);
    assert.equal(toolkit.issues.length, 2);
    assert.deepEqual(toolkit.issues.map((i) => i.title), ['質問の改善案：一つ目', '質問の改善案：二つ目']);
    assert.deepEqual(toolkit.issues.map((i) => i.url), [
      'https://github.com/xclang-brain/plugin-creator/issues/9001',
      'https://github.com/xclang-brain/plugin-creator/issues/9002',
    ]);
  });
});

test('REQ-015 MCP サーバーを通しても動く：同じプロセスのサーバーに、MCP のクライアントでつなぐと、ツールの結果と断りが返る', async () => {
  await withToolkit(async ({ toolkit, events }) => {
    const seen = [];
    const sdk = createFakeSdk({
      agent: async (ctx) => {
        seen.push(await ctx.tool('mcp__plugin-creator__progress', { items: SETTABLE.map((item) => ({ item, status: '聞いた', quote: `${item}の答え` })) }));
        seen.push(await ctx.tool('mcp__plugin-creator__progress', { items: [{ item: '成果物', status: '聞いた', quote: '' }] }));
        seen.push(await ctx.tool('mcp__plugin-creator__state'));
        return '終わり';
      },
    });
    const options = { mcpServers: { [toolkit.serverName]: toolkit.newServer() }, plugins: [] };
    const messages = [];
    for await (const m of sdk.query({ prompt: 'p', options })) messages.push(m);
    assert.equal(seen[0].isError, false);
    assert.match(seen[0].text, /記録しました/);
    assert.equal(seen[1].isError, true);
    assert.match(seen[1].text, /抜き書き/);
    assert.doesNotMatch(seen[1].text, /textResultForLlm|resultType/); // 理由の文だけがモデルに届く
    // 記録の側も、同じ理由の文を失敗として残す
    const refused = events.filter((e) => e.type === 'tool.result' && e.isError);
    assert.equal(refused.length, 1);
    assert.match(refused[0].result, /抜き書き/);
    assert.equal(seen[2].isError, false);
    assert.match(seen[2].text, /聞く/);
    assert.equal(messages.at(-1).result, '終わり');
    // 呼び出しに、claudecode/toolUseId が結び付く
    const calls = events.filter((e) => e.type === 'tool.call');
    assert.ok(calls.every((c) => typeof c.toolUseId === 'string' && c.toolUseId.startsWith('toolu_')));
    // 1 つのサーバーは 1 回の query で使い切り。次の query には新しいインスタンスを渡す
    assert.notEqual(toolkit.newServer().instance, toolkit.newServer().instance);
  });
});
