// 呼ばれ方の試験（trigger.mjs）の、頼みの一覧の形と採点の関数の試験。実際のモデルは呼ばない（偽の query だけを使う）。
// 動かし方（リポジトリの根で）: node --test tests/dev-eval/trigger/trigger.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CASES_FILE, CREATOR_SKILLS, creatorLoaded, gradeCase, loadCases, main, makeSkillCatcher, parseArgs, runCase, skillOf, summarize, validateCases,
} from './trigger.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

const good = () => ({ workspace: { 'p/plugin.json': '{}' }, cases: [{ id: 'a', request: '頼み', expect: ['change-plugin'] }] });

describe('REQ-052 REQ-032 呼ばれ方の試験：頼みの一覧（cases.json）', () => {
  const data = loadCases();

  test('形が正しい', () => {
    assert.deepEqual(validateCases(data), []);
  });

  test('設計図の9件の頼みと期待がそろっている', () => {
    const expectOf = Object.fromEntries(data.cases.map((c) => [c.id, [...c.expect].sort()]));
    assert.equal(data.cases.length, 9);
    for (const id of ['add-skill', 'add-setting', 'split-workers', 'remove-feature']) assert.deepEqual(expectOf[id], ['change-plugin'], id);
    assert.deepEqual(expectOf['rebuild-only'], ['change-plugin', 'make-plugin']);
    assert.deepEqual(expectOf['make-new'], ['make-plugin']);
    assert.deepEqual(expectOf.retest, ['test-plugin']);
    assert.deepEqual(expectOf['do-the-work'], []);
    assert.deepEqual(expectOf.idea, ['make-idea']);
  });

  test('クリエイターのスキルの一覧が、skills/ のフォルダと同じ', () => {
    const folders = fs.readdirSync(path.join(REPO, 'skills')).filter((d) => fs.existsSync(path.join(REPO, 'skills', d, 'SKILL.md')));
    assert.deepEqual([...CREATOR_SKILLS].sort(), folders.sort());
  });

  test('頼みの一覧の誤りを見つける', () => {
    const cases = (c) => ({ cases: [c] });
    assert.match(validateCases({ cases: [] }).join(), /1つ以上/);
    assert.match(validateCases(cases({ id: 'a', request: '', expect: [] })).join(), /request/);
    assert.match(validateCases(cases({ id: 'a', request: '頼み', expect: ['other'] })).join(), /クリエイターにないスキル/);
    assert.match(validateCases(cases({ id: 'a', request: '頼み', expect: 'change-plugin' })).join(), /一覧/);
    assert.match(validateCases(cases({ id: 'A b', request: '頼み', expect: [] })).join(), /id/);
    assert.match(validateCases({ cases: [good().cases[0], good().cases[0]] }).join(), /重なって/);
    assert.match(validateCases({ ...good(), workspace: { '../x': 'y' } }).join(), /作業フォルダの中/);
    assert.match(validateCases({ ...good(), workspace: { '/abs': 'y' } }).join(), /作業フォルダの中/);
    assert.match(validateCases({ ...good(), workspace: { a: 1 } }).join(), /文字/);
    assert.deepEqual(validateCases(good()), []);
  });
});

describe('REQ-052 REQ-032 呼ばれ方の試験：採点', () => {
  test('呼んだスキルの名前を、クリエイターのスキルとほかのスキルに分ける', () => {
    assert.equal(skillOf({ skill: 'plugin-creator:change-plugin' }), 'change-plugin');
    assert.equal(skillOf({ skill: 'make-plugin' }), 'make-plugin');
    assert.equal(skillOf({ skill: '/plugin-creator:test-plugin' }), 'test-plugin');
    assert.equal(skillOf({ skill: 'init' }), 'other:init');
    assert.equal(skillOf({ skill: 'other-plugin:change-plugin' }), 'other:other-plugin:change-plugin');
    assert.equal(skillOf(undefined), 'other:');
  });

  test('期待のどれかを最初に呼べば合格', () => {
    const c = { id: 'r', request: '作り直したい', expect: ['make-plugin', 'change-plugin'] };
    assert.equal(gradeCase(c, 'change-plugin').pass, true);
    assert.equal(gradeCase(c, 'make-plugin').pass, true);
    assert.equal(gradeCase(c, 'test-plugin').pass, false);
    assert.equal(gradeCase(c, null).pass, false);
    assert.equal(gradeCase(c, 'other:init').pass, false);
  });

  test('どれも呼ばない頼みは、クリエイターのスキルを呼ばなければ合格', () => {
    const c = { id: 'n', request: '今週の週報を書いて', expect: [] };
    assert.equal(gradeCase(c, null).pass, true);
    assert.equal(gradeCase(c, undefined).got, null);
    assert.equal(gradeCase(c, 'other:init').pass, true);
    assert.equal(gradeCase(c, 'make-plugin').pass, false);
  });

  test('まとめ：期待と違うものと、止まったものを数える', () => {
    const s = summarize([{ id: 'a', pass: true }, { id: 'b', pass: false }, { id: 'c', pass: false, error: '止まった' }]);
    assert.deepEqual(s, { total: 3, passed: 1, failed: ['b', 'c'], stopped: ['c'], ok: false });
    assert.equal(summarize([{ id: 'a', pass: true }]).ok, true);
  });

  test('最初の Skill の呼び出しだけを記録し、どれも断る', async () => {
    const caught = [];
    const catcher = makeSkillCatcher({ onCaught: (s) => caught.push(s) });
    assert.equal(catcher.hooks.PreToolUse[0].matcher, 'Skill');
    const hook = catcher.hooks.PreToolUse[0].hooks[0];
    const first = await hook({ tool_name: 'Skill', tool_input: { skill: 'plugin-creator:change-plugin' } });
    assert.equal(first.hookSpecificOutput.permissionDecision, 'deny');
    const second = await hook({ tool_name: 'Skill', tool_input: { skill: 'plugin-creator:make-plugin' } });
    assert.equal(second.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(catcher.first(), 'change-plugin');
    assert.deepEqual(caught, ['change-plugin']);
  });
});

describe('REQ-052 REQ-032 呼ばれ方の試験：動かし方（偽の query。モデルを呼ばない）', () => {
  const tmp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-test-'));
    made.push(dir);
    return dir;
  };
  const init = (skills) => ({ type: 'system', subtype: 'init', skills });
  const loadedSkills = CREATOR_SKILLS.map((s) => `plugin-creator:${s}`);

  test('最初のスキルの呼び出しで止め、作業フォルダに頼みの一覧のファイルを置く', async () => {
    const runDir = tmp();
    let seen = null;
    let afterSkill = false;
    const query = ({ prompt, options }) => (async function* fake() {
      seen = { prompt, cwd: options.cwd, plugins: options.plugins, model: options.model };
      yield init(loadedSkills);
      await options.hooks.PreToolUse[0].hooks[0]({ tool_name: 'Skill', tool_input: { skill: 'plugin-creator:change-plugin' } });
      yield { type: 'assistant', message: { content: [] } };
      afterSkill = true;
      yield { type: 'result', total_cost_usd: 0.01 };
    })();
    const testCase = { id: 'add-skill', request: 'p に足したい', expect: ['change-plugin'] };
    const r = await runCase({ testCase, workspace: { 'p/plugin.json': '{}' }, query, converted: '/converted', model: 'm', runDir, sandbox: false });
    assert.equal(r.pass, true);
    assert.equal(r.got, 'change-plugin');
    assert.equal(r.loaded, true);
    assert.equal(afterSkill, false, 'スキルを呼んだところで止める');
    assert.equal(seen.prompt, 'p に足したい');
    assert.deepEqual(seen.plugins, [{ type: 'local', path: '/converted' }]);
    assert.ok(fs.existsSync(path.join(seen.cwd, 'p', 'plugin.json')));
  });

  test('クリエイターのスキルは、「plugin-creator:」が付いていてもいなくても、読み込まれたと見る', async () => {
    assert.equal(creatorLoaded(loadedSkills), true);
    assert.equal(creatorLoaded([...CREATOR_SKILLS]), true);
    assert.equal(creatorLoaded(['init', ...CREATOR_SKILLS.slice(1)]), false);
    assert.equal(creatorLoaded(['other-plugin:make-plugin', 'change-plugin', 'test-plugin']), false);
    assert.equal(creatorLoaded(undefined), false);
    const runDir = tmp();
    const plain = () => (async function* fake() {
      yield init([...CREATOR_SKILLS, 'init']);
      yield { type: 'result' };
    })();
    const r = await runCase({ testCase: { id: 'n', request: '週報を書いて', expect: [] }, workspace: {}, query: plain, converted: '/c', model: 'm', runDir, sandbox: false });
    assert.equal(r.loaded, true);
    assert.equal(r.error, null);
    assert.equal(r.pass, true);
  });

  test('スキルを呼ばずに終えたら、呼ばなかったとして採点する。クリエイターが読み込まれなければ止まったとする', async () => {
    const runDir = tmp();
    const none = () => (async function* fake() {
      yield init(loadedSkills);
      yield { type: 'result', total_cost_usd: 0.02 };
    })();
    const r = await runCase({ testCase: { id: 'n', request: '週報を書いて', expect: [] }, workspace: {}, query: none, converted: '/c', model: 'm', runDir, sandbox: false });
    assert.equal(r.pass, true);
    assert.equal(r.got, null);
    assert.equal(r.costUsd, 0.02);
    const missing = () => (async function* fake() {
      yield init([]);
      yield { type: 'result' };
    })();
    const m = await runCase({ testCase: { id: 'n', request: '週報を書いて', expect: [] }, workspace: {}, query: missing, converted: '/c', model: 'm', runDir, sandbox: false });
    assert.equal(m.pass, false);
    assert.match(m.error, /読み込まれませんでした/);
  });

  test('--dry-run は置き換えもモデルの呼び出しもしない。知らない引数は使い方の誤り', async () => {
    const forbid = () => {
      throw new Error('呼んではいけない');
    };
    const log = console.log;
    const lines = [];
    console.log = (s) => lines.push(s);
    try {
      assert.equal(await main(['--dry-run', '--only', 'retest'], { convert: forbid, query: forbid }), 0);
      assert.equal(JSON.parse(lines[0]).cases[0].id, 'retest');
      assert.equal(await main(['--what'], { convert: forbid, query: forbid }), 2);
      assert.equal(await main(['--dry-run', '--only', 'nothing'], { convert: forbid, query: forbid }), 2);
    } finally {
      console.log = log;
    }
    assert.equal(parseArgs([]).model, 'claude-opus-5-5');
    assert.equal(parseArgs(['--no-sandbox']).sandbox, false);
    assert.equal(CASES_FILE.endsWith(path.join('trigger', 'cases.json')), true);
  });
});
