import path from 'node:path';
import * as realSdk from '@anthropic-ai/claude-agent-sdk';
const R = '/home/user/plugin-creator/tests/dev-eval/runner';
const { makeQueryOptions } = await import(path.join(R, 'isolation.mjs'));
const { startFakeAnthropic, guardSdk } = await import(path.join(R, 'fake-anthropic.mjs'));
const S = process.argv[2];
const seen = [];
const api = await startFakeAnthropic(async ({ body }) => { seen.push(JSON.stringify(body.messages ?? []).includes('MARKER-SKILL-BODY-42')); return { blocks: [{ type: 'text', text: 'done' }] }; });
const options = makeQueryOptions({ cwd: path.join(S, 'slash/work'), home: path.join(S, 'slash/home'), model: 'claude-haiku-5-5', plugins: [path.join(S, 'slash/plugin')], maxTurns: 3,
  envExtra: { ANTHROPIC_API_KEY: 'fake-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ANTHROPIC_BASE_URL: api.url } });
let init = null; let result = null;
for await (const m of guardSdk(realSdk, api).query({ prompt: '/probe:change-thing このフォルダを直したい', options })) {
  if (m.type === 'system' && m.subtype === 'init') init = { skills: m.skills, slash: (m.slash_commands ?? []).filter((s) => s.includes('probe')) };
  if (m.type === 'result') result = { subtype: m.subtype, result: m.result };
}
await api.close();
console.log(JSON.stringify({ init, result, requests: seen.length, skillBodyInMessages: seen }, null, 1));
