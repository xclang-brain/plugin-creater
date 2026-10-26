// 2段目 部品の試験（クリエイターのエクステンション）：今のプラグインを直すときの、番号と版の決まり（change.mjs）。
// 設計図：wip/change-plugin/BLUEPRINT.md 4.4（合否の基準の番号。取り決め I4）、4.5・D16（版の案）、D15・D29（決まりの番号、生成プラグインの見分け方）。
// ツールを通した振る舞いは record-tools.test.mjs の「今のプラグインを直す」で確かめる。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { EXTENSION_DIR, PLUGIN_EVALS, PLUGIN_KNOWLEDGE, tempDir, writePluginFolder } from './helpers.mjs';

const { MANIFEST_PLACES, VERSION_PATTERN, compareVersions, criteriaRows, readPluginForChange } = await import(pathToFileURL(path.join(EXTENSION_DIR, 'change.mjs')).href);

const row = (id, kind = 'criterion', text = `${id} の文`) => ({ id, kind, text });

describe('合格の条件の番号（criteriaRows。BLUEPRINT 4.4、D14）', () => {
  test('REQ-020 作るとき（元の番号の対応がない）は、合否の決め方の行に、並びの順に C-01 から付ける（今までと同じ）', () => {
    assert.deepEqual(criteriaRows([row('K-01', 'other'), row('K-02'), row('K-05')]), [
      { id: 'C-01', text: 'K-02 の文', knowledge: 'K-02' },
      { id: 'C-02', text: 'K-05 の文', knowledge: 'K-05' },
    ]);
    assert.deepEqual(criteriaRows([row('K-01', 'other')]), []);
  });

  test('REQ-058 直すとき：引き継いだ合否の決め方は元の番号のまま。ほかは、元の番号の最大の次から順に付ける（外した基準の番号の後ろ）', () => {
    const criteriaIds = { 'K-07': 'C-01', 'K-13': 'C-02', 'K-14': 'C-03' };
    // K-07 を直して K-20 に付け直し、K-21 を足した。K-14 は外した
    assert.deepEqual(criteriaRows([row('K-13'), row('K-20'), row('K-21'), row('K-15', 'other')], criteriaIds), [
      { id: 'C-02', text: 'K-13 の文', knowledge: 'K-13' },
      { id: 'C-04', text: 'K-20 の文', knowledge: 'K-20' },
      { id: 'C-05', text: 'K-21 の文', knowledge: 'K-21' },
    ]);
    // 番号は2桁以上
    assert.deepEqual(criteriaRows([row('K-30')], { 'K-01': 'C-99' }).map((c) => c.id), ['C-100']);
    // 形の違う値は数えない
    assert.deepEqual(criteriaRows([row('K-02')], null).map((c) => c.id), ['C-01']);
  });
});

describe('版の比べ方（compareVersions。D16）', () => {
  test('REQ-057 数ごとに比べる。比べられない形なら null', () => {
    assert.ok(compareVersions('0.2.0', '0.1.0') > 0);
    assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
    assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
    assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
    assert.ok(compareVersions('0.1.0', '0.1.1') < 0);
    assert.equal(compareVersions('0.1.0', '0.1'), 0, '足りない数は 0 として比べる');
    assert.equal(compareVersions('0.2.0', null), null);
    assert.equal(compareVersions('0.2.0', '1.0.0-beta'), null);
    assert.ok(VERSION_PATTERN.test('0.2.0'));
    for (const bad of ['0.2', 'v0.2.0', '0.2.0-beta', ' 0.2.0', '0.2.0.1']) assert.equal(VERSION_PATTERN.test(bad), false, bad);
  });
});

describe('直すフォルダの読み取り（readPluginForChange）', () => {
  test('REQ-052 REQ-058 D29 生成プラグインを読み、取り込む決まり・外した番号・番号の最大・合格の条件の番号の対応・課題の頼むときの言葉を返す。ファイルは書き換えない', () => {
    const cwd = tempDir('change-read');
    try {
      const folder = writePluginFolder(cwd, { removed: [{ id: 'K-11', kind: 'other', item: '進め方', text: '前の文', replacedBy: 'K-05' }] });
      const before = fs.readFileSync(path.join(folder, 'tests', 'knowledge.json'), 'utf8');
      const plugin = readPluginForChange(folder);
      assert.deepEqual(
        { ...plugin, knowledge: plugin.knowledge.map((k) => k.id) },
        {
          manifest: 'plugin.json',
          name: 'edl-sample',
          version: '0.1.0',
          generated: true,
          knowledge: PLUGIN_KNOWLEDGE.map((k) => k.id),
          removed: ['K-11'],
          maxId: 11,
          criteriaIds: { 'K-02': 'C-01', 'K-04': 'C-02' },
          evalPrompts: [PLUGIN_EVALS[0].prompt],
          taskRel: 'com.github.copilot/extensions/edl-sample/task.json',
        },
      );
      assert.deepEqual(plugin.knowledge[0], { id: 'K-01', kind: 'other', item: 'procedure', itemName: '進め方', text: PLUGIN_KNOWLEDGE[0].text });
      assert.equal(fs.readFileSync(path.join(folder, 'tests', 'knowledge.json'), 'utf8'), before);
      assert.deepEqual(MANIFEST_PLACES, ['plugin.json', '.plugin/plugin.json', '.github/plugin/plugin.json', '.claude-plugin/plugin.json']);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('REQ-058 決まりの一覧の聞くことは、日本語の名前のまま itemName に残す（組み立ては、元の item と記録の itemName を比べる。BLUEPRINT 4.2）', () => {
    const cwd = tempDir('change-item');
    try {
      const folder = writePluginFolder(cwd, { knowledge: [{ id: 'K-01', kind: 'other', item: '使う道具と環境', text: 'arm-linux-gnueabihf-gcc を使う' }] });
      assert.deepEqual(readPluginForChange(folder).knowledge, [{ id: 'K-01', kind: 'other', item: 'tools', itemName: '使う道具と環境', text: 'arm-linux-gnueabihf-gcc を使う' }]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
