// モデルで判定する関数の Agent SDK 版。本物の Agent SDK と Claude Code の本体を、偽の API につないで確かめる（実際のモデルは使わない）。
import assert from 'node:assert/strict';
import test from 'node:test';

import * as realSdk from '@anthropic-ai/claude-agent-sdk';

import { gradeRun } from '../../../skills/test-plugin/scripts/grade.mjs';
import { firstUserText, guardSdk, startFakeAnthropic } from './fake-anthropic.mjs';
import { createAgentSdkJudge, JUDGE_MODEL } from './inner-judge.mjs';
import { tempDir } from './temp-dirs.mjs';

const ENV = { ANTHROPIC_API_KEY: 'fake-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
const criterion = { id: 'C-02', text: '数字は半角で書く（例：3件）。' };
const task = { id: 'T-01', prompt: '週報を書いてください。' };
const artifacts = [{ path: 'out/weekly.md', size: 40, kind: 'text', text: '# 週報\n3件対応した\n', truncated: false }];

async function withFake(handler, run) {
  const api = await startFakeAnthropic(handler);
  const judge = createAgentSdkJudge({ sdk: guardSdk(realSdk, api), envExtra: { ...ENV, ANTHROPIC_BASE_URL: api.url }, timeoutMs: 60_000 }); // 守り：偽の API につながっていない query は断る
  try {
    return await run(judge, api);
  } finally {
    judge.close();
    await api.close();
  }
}

test('REQ-041 モデルの判定：基準と成果物を渡し、道具なしの1回の呼び出しで { pass, reason } を受け取る', { timeout: 90_000 }, async () => {
  await withFake(
    async () => ({ blocks: [{ type: 'text', text: '{"pass": true, "reason": "数字が半角で書かれている"}' }] }),
    async (judge, api) => {
      const out = await judge({ criterion, task, artifacts });
      assert.deepEqual({ pass: out.pass, reason: out.reason, error: out.error }, { pass: true, reason: '数字が半角で書かれている', error: undefined });
      assert.equal(judge.calls, 1);
      assert.ok(judge.costUsd > 0);
      assert.equal(api.requests.length, 1);
      const body = api.requests[0].body;
      assert.equal(body.model, JUDGE_MODEL);
      // 道具を持たず、成果物と基準が指示文に入っている
      assert.deepEqual((body.tools ?? []).map((t) => t.name), []);
      const prompt = firstUserText(body);
      assert.match(prompt, /C-02: 数字は半角で書く/);
      assert.match(prompt, /<file path="out\/weekly\.md"/);
      assert.match(prompt, /3件対応した/);
      assert.match(prompt, /週報を書いてください/);
    },
  );
});

test('REQ-041 モデルの判定：不合格と理由、コードブロックで包まれた返事も読む', { timeout: 90_000 }, async () => {
  await withFake(
    async () => ({ blocks: [{ type: 'text', text: '判定は次のとおりです。\n```json\n{"pass": false, "reason": "全角の数字がある"}\n```' }] }),
    async (judge) => {
      const out = await judge({ criterion, task, artifacts });
      assert.equal(out.pass, false);
      assert.equal(out.reason, '全角の数字がある');
      assert.equal(out.error, undefined);
    },
  );
});

test('REQ-041 モデルの判定：読めない返事・API の誤りは、不合格にして error を真にする（基準を満たしたことにしない）', { timeout: 90_000 }, async () => {
  await withFake(
    async () => ({ blocks: [{ type: 'text', text: 'よく分かりません' }] }),
    async (judge) => {
      const out = await judge({ criterion, task, artifacts });
      assert.equal(out.pass, false);
      assert.equal(out.error, true);
      assert.match(out.reason, /判定の返事を読めなかった/);
    },
  );
  await withFake(
    async () => ({ status: 400, error: { type: 'error', error: { type: 'invalid_request_error', message: 'bad request' } } }),
    async (judge) => {
      const out = await judge({ criterion, task, artifacts });
      assert.equal(out.pass, false);
      assert.equal(out.error, true);
      assert.match(out.reason, /判定の呼び出しが誤りで終わりました/);
    },
  );
});

test('REQ-041 モデルの判定を grade.mjs に渡すと、model の基準だけがモデルで判定され、program の基準は呼ばない', { timeout: 90_000 }, async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const workDir = tempDir('judge-grade');
  fs.mkdirSync(path.join(workDir, 'out'));
  fs.writeFileSync(path.join(workDir, 'out', 'weekly.md'), '# 週報\n## 今週やったこと\n3件対応した\n');
  const criteria = [
    { id: 'C-01', text: '見出しがある', grading: 'program', check: { type: 'contains', file: 'out/*.md', text: '今週やったこと' } },
    { id: 'C-02', text: '数字は半角で書く（例：3件）。', grading: 'model' },
  ];
  await withFake(
    async () => ({ blocks: [{ type: 'text', text: '{"pass": true, "reason": "半角"}' }] }),
    async (judge, api) => {
      const graded = await gradeRun({ task: { id: 'T-01', prompt: '週報を書いて', criteria }, workDir, judge });
      assert.equal(graded.passed, 2);
      assert.equal(graded.judgments, 1);
      assert.equal(api.requests.length, 1);
      assert.equal(judge.calls, 1);
    },
  );
});

test('REQ-041 モデルの判定：誤りの印（is_error）が付いた結果は、読める JSON が入っていても判定として使わない', async () => {
  const fakeSdk = {
    query: () => (async function* generate() {
      yield { type: 'result', subtype: 'success', is_error: true, result: '{"pass": true, "reason": "API の誤りの文に紛れた"}', total_cost_usd: 0 };
    })(),
  };
  const judge = createAgentSdkJudge({ sdk: fakeSdk });
  const out = await judge({ criterion, task, artifacts });
  judge.close();
  assert.equal(out.pass, false);
  assert.equal(out.error, true);
  assert.match(out.reason, /判定の呼び出しが誤りで終わりました/);
});
