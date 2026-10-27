// モデルの名前の対応（testing.md 4章）。表は変換スクリプトのものを、変換レポートから読む。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { copilotModelList, modelMapOf, readConversionReport, toClaudeModelId, toCopilotName } from './model-map.mjs';
import { tempDir } from './temp-dirs.mjs';

const MAP = {
  'claude-haiku-5.5': 'claude-haiku-5-5',
  'gpt-6-luna': 'claude-haiku-5-5',
  'claude-sonnet-5.5': 'claude-sonnet-5-5',
  'gpt-6.1-sol': 'claude-sonnet-5-5',
  'claude-opus-5.5': 'claude-opus-5-5',
};

function makeConverted(report) {
  const dir = tempDir('model-map-test');
  if (report) {
    fs.mkdirSync(path.join(dir, '.eval'));
    fs.writeFileSync(path.join(dir, '.eval', 'conversion-report.json'), JSON.stringify(report));
  }
  return dir;
}

test('REQ-007 画面で選ぶ Copilot の名前を、Claude Code の ID にする', () => {
  assert.equal(toClaudeModelId(MAP, 'gpt-6-luna'), 'claude-haiku-5-5');
  assert.equal(toClaudeModelId(MAP, 'gpt-6.1-sol'), 'claude-sonnet-5-5');
  assert.equal(toClaudeModelId(MAP, 'claude-opus-5.5'), 'claude-opus-5-5');
  // ID がそのまま渡されたら、そのまま返す
  assert.equal(toClaudeModelId(MAP, 'claude-sonnet-5-5'), 'claude-sonnet-5-5');
});

test('REQ-007 表にない名前は黙って別のモデルにせず、選べる名前を示して断る', () => {
  assert.throws(() => toClaudeModelId(MAP, 'gpt-9'), /gpt-9.*対応の表にありません.*gpt-6-luna/);
  assert.throws(() => toClaudeModelId(MAP, ''), /空です/);
  assert.throws(() => toClaudeModelId(MAP, undefined), /空です/);
});

test('REQ-007 Claude Code の ID から Copilot の名前に戻す（claude- で始まる名前を先にする）', () => {
  assert.equal(toCopilotName(MAP, 'claude-haiku-5-5'), 'claude-haiku-5.5');
  assert.equal(toCopilotName(MAP, 'claude-sonnet-5-5'), 'claude-sonnet-5.5');
  assert.equal(toCopilotName(MAP, 'claude-unknown-1'), null);
});

test('REQ-007 画面の選択肢は、表の Copilot の名前を ID と名前にする', () => {
  assert.deepEqual(copilotModelList(MAP), Object.keys(MAP).map((id) => ({ id, name: id })));
});

test('REQ-007 変換レポートから表を読む。レポートがない・表がないときは理由を示す', () => {
  const ok = makeConverted({ plugin: 'p', model_map: MAP });
  assert.deepEqual(modelMapOf(readConversionReport(ok)), MAP);
  assert.throws(() => readConversionReport(makeConverted(null)), /変換レポートがありません.*convert\.py/);
  assert.throws(() => modelMapOf(readConversionReport(makeConverted({ plugin: 'p' }))), /model_map/);
  assert.throws(() => modelMapOf(readConversionReport(makeConverted({ plugin: 'p', model_map: {} }))), /model_map/);
  const broken = makeConverted(null);
  fs.mkdirSync(path.join(broken, '.eval'));
  fs.writeFileSync(path.join(broken, '.eval', 'conversion-report.json'), '{ not json');
  assert.throws(() => readConversionReport(broken), /読めません/);
});
