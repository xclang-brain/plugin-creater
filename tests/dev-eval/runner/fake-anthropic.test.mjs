// 守りの試験：偽の API につながっていない query() の呼び出しは、始める前に断る（実際のモデルを呼ばないため）。
// 偽の API の最低限の動き（応答の読み取り）も確かめる。
import assert from 'node:assert/strict';
import test from 'node:test';

import * as realSdk from '@anthropic-ai/claude-agent-sdk';

import { agentEnv, makeQueryOptions } from './isolation.mjs';
import { firstUserText, guardSdk, lastToolResults, startFakeAnthropic, systemText } from './fake-anthropic.mjs';
import { tempDir } from './temp-dirs.mjs';

test('守り：偽の API の URL と違う接続先の query は、中身を読む前に断る。実際の SDK の query は呼ばれない', async (t) => {
  const api = await startFakeAnthropic(async () => ({ blocks: [{ type: 'text', text: 'ok' }] }));
  t.after(() => api.close());
  const called = [];
  const spy = { query: (params) => { called.push(params); return (async function* generate() {})(); } };
  const guarded = guardSdk(spy, api);
  for (const env of [undefined, {}, { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, { ANTHROPIC_BASE_URL: `${api.url}/` }, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' }]) {
    assert.throws(() => guarded.query({ prompt: 'x', options: { env } }), /模擬の API につながっていない query の呼び出しです/);
  }
  assert.throws(() => guarded.query({ prompt: 'x' }), /模擬の API につながっていない/);
  assert.throws(() => guarded.query(), /模擬の API につながっていない/);
  assert.equal(called.length, 0);
  guarded.query({ prompt: 'x', options: { env: { ANTHROPIC_BASE_URL: api.url } } });
  assert.equal(called.length, 1);
  // sdk のほかの項目（利用枠の上限の一覧など）は、そのまま使える
  assert.equal(guardSdk(realSdk, api).USAGE_LIMIT_ERROR_PREFIXES, realSdk.USAGE_LIMIT_ERROR_PREFIXES);
});

test('守り：試験の仕組みが作る options は、envExtra に偽の API の URL を渡さなければ守りで断られる（既定の接続先は本物）', async (t) => {
  const api = await startFakeAnthropic(async () => ({ blocks: [{ type: 'text', text: 'ok' }] }));
  t.after(() => api.close());
  const guarded = guardSdk({ query: () => (async function* generate() {})() }, api);
  const base = { PATH: '/bin', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' };
  const withoutFake = makeQueryOptions({ cwd: '/tmp', home: '/tmp/h', model: 'claude-sonnet-5-5', base });
  assert.equal(withoutFake.env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
  assert.throws(() => guarded.query({ prompt: 'x', options: withoutFake }), /実際のモデルを呼ぶところでした/);
  const withFake = makeQueryOptions({ cwd: '/tmp', home: '/tmp/h', model: 'claude-sonnet-5-5', base, envExtra: { ANTHROPIC_BASE_URL: api.url } });
  assert.doesNotThrow(() => guarded.query({ prompt: 'x', options: withFake }));
  assert.equal(agentEnv({ home: '/tmp/h', base, extra: { ANTHROPIC_BASE_URL: api.url } }).ANTHROPIC_BASE_URL, api.url);
});

test('守り：本物の Agent SDK でも、守りを通すと、偽のサーバーの応答だけが返り、本物の接続先には出ない', { timeout: 60_000 }, async (t) => {
  const api = await startFakeAnthropic(async () => ({ blocks: [{ type: 'text', text: '偽の応答' }] }));
  t.after(() => api.close());
  const sdk = guardSdk(realSdk, api);
  const home = tempDir('guard-home');
  const options = { cwd: home, model: 'claude-sonnet-5-5', maxTurns: 1, tools: [], settingSources: [], persistSession: false, env: agentEnv({ home, extra: { ANTHROPIC_API_KEY: 'fake-key', ANTHROPIC_BASE_URL: api.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } }) };
  let text = '';
  for await (const m of sdk.query({ prompt: 'こんにちは', options })) if (m.type === 'result') text = m.result;
  assert.equal(text, '偽の応答');
  assert.equal(api.requests.length, 1);
  assert.equal(firstUserText(api.requests[0].body), 'こんにちは');
});

test('偽の API：システムプロンプトと、ツールの返り値を取り出す補助', () => {
  assert.equal(systemText({ system: 'A' }), 'A');
  assert.equal(systemText({ system: [{ text: 'A' }, { text: 'B' }] }), 'A\nB');
  assert.equal(systemText({}), '');
  const body = { messages: [{ role: 'user', content: 'はじめ' }, { role: 'assistant', content: [] }, { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: '結果1' }] }, { type: 'tool_result', content: '結果2' }] }, { role: 'system', content: 'x' }] };
  assert.deepEqual(lastToolResults(body), ['結果1', '結果2']);
  assert.equal(firstUserText(body), 'はじめ');
});
