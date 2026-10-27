// 対照のクリエイター（tests/dev-eval/control-creator/）の試験。大まかな質問しかしないクリエイターで外側の EVAL を行うと、
// 聞かれないと話さないナレッジが組み込まれず、試験が落ちるべきときに落ちることを確かめる（testing.md 6.3）。実際のモデルは使わない。
// 動かし方（リポジトリの根で）：node --test "tests/dev-eval/runner/*.test.mjs"

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadPersona } from '../personas/validate.mjs';
import { CONTROL_DIR, evaluateControl } from './outer.mjs';
import { createFakeSdk } from './outer-fake-sdk.mjs';
import { convertPlugin, runOuterOnce } from './outer-run.mjs';
import { tempDir } from './temp-dirs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..', '..');
const PERSONAS = path.join(here, '..', 'personas');
const BUILD = path.join(CONTROL_DIR, 'skills', 'make-plugin', 'scripts', 'control_build.py');
const tmp = (prefix) => tempDir(`control-${prefix}`);
const loadedWeekly = await loadPersona(path.join(PERSONAS, 'weekly-report'), { allStyles: true });

test('REQ-015 対照のクリエイターは、本物の組み立てのスクリプトで、本物と同じ形の生成プラグインを作る（1段目に通る）', () => {
  const cwd = tmp('build');
  fs.writeFileSync(path.join(cwd, 'knowledge.md'), '- weekly_report.md という Markdown のファイル\n- 売上の数字を間違えないこと\n');
  const r = spawnSync('python3', ['-I', BUILD, '--name', 'weekly-report', '--title', '週報の作成', '--description', '週報を作ってと頼まれたときに使う', '--knowledge-file', 'knowledge.md'], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.deepEqual(out.knowledge, { criterion: 1, other: 1 });
  const plugin = path.join(cwd, 'weekly-report');
  const knowledge = JSON.parse(fs.readFileSync(path.join(plugin, 'tests', 'knowledge.json'), 'utf8'));
  assert.deepEqual(knowledge.map((k) => [k.id, k.kind]), [['K-01', 'criterion'], ['K-02', 'other']]);
  assert.match(fs.readFileSync(path.join(plugin, 'com.github.copilot', 'agents', 'worker.agent.md'), 'utf8'), /売上の数字を間違えないこと（K-02）/);
  assert.ok(!fs.existsSync(path.join(cwd, '.plugin-creator-work')), '作業用の一時フォルダは消える');
  assert.ok(!fs.existsSync(path.join(cwd, '.control-hearing.json')));
  const check = spawnSync('python3', ['-I', path.join(plugin, 'tests', 'stage1', 'check_structure.py'), plugin, '--json'], { encoding: 'utf8' });
  assert.equal(JSON.parse(check.stdout).ok, true, check.stdout.slice(0, 500));
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('REQ-015 対照のクリエイターの組み立ては、答えがなければ断り、名前の誤りも断る', () => {
  const cwd = tmp('refuse');
  fs.writeFileSync(path.join(cwd, 'knowledge.md'), '\n');
  const empty = spawnSync('python3', ['-I', BUILD, '--name', 'x', '--title', 't', '--description', 'd', '--knowledge-file', 'knowledge.md'], { cwd, encoding: 'utf8' });
  assert.equal(empty.status, 1);
  assert.match(JSON.parse(empty.stdout).problems[0], /答えがありません/);
  fs.writeFileSync(path.join(cwd, 'knowledge.md'), '- a\n');
  const bad = spawnSync('python3', ['-I', BUILD, '--name', 'Bad Name', '--title', 't', '--description', 'd', '--knowledge-file', 'knowledge.md'], { cwd, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).ok, false);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('REQ-015 対照のクリエイターは、変換スクリプトで Claude Code に読み込める形になる（claude plugin validate に通る）', () => {
  const out = tmp('convert');
  const r = convertPlugin(CONTROL_DIR, path.join(out, 'control'));
  assert.equal(r.summary.validate.ok, true);
  assert.deepEqual(r.report.extension_tools ?? [], [], '対照のクリエイターはエクステンションを使わない');
  const skill = fs.readFileSync(path.join(r.root, 'skills', 'make-plugin', 'SKILL.md'), 'utf8');
  assert.match(skill, /大まかな質問を3つだけ/);
  assert.ok(fs.existsSync(path.join(r.root, 'skills', 'make-plugin', 'scripts', 'control_build.py')));
  fs.rmSync(out, { recursive: true, force: true });
});

/** 模擬ユーザーの定義どおりに答えるユーザー役（話題が asked に当たれば、そのナレッジを答える） */
function oracleUser(persona) {
  return ({ prompt }) => {
    const q = /AI からの質問：([^\n]*)/.exec(prompt)?.[1] ?? '';
    const hit = persona.knowledge.filter((k) => new RegExp(k.markers.asked).test(q));
    return hit.length ? hit.map((k) => k.fact).join(' ') : '特に決まっていません';
  };
}

function fakeConvert(src, out) {
  fs.mkdirSync(path.join(out, '.eval'), { recursive: true });
  const report = { plugin: path.basename(src), model_map: {}, extension_tools: [], warnings: [] };
  fs.writeFileSync(path.join(out, '.eval', 'conversion-report.json'), JSON.stringify(report));
  return { root: out, report };
}

test('REQ-015 対照の腕：大まかな質問 3 つだけで生成すると、聞かれないと話さないナレッジが組み込まれず、全項目のヒアリングで落ちる（試験が落ちるべきときに落ちる）', async () => {
  const runRoot = tmp('arm');
  const questions = ['作業の成果物は、どんなファイルですか？（名前と種類）', '守らないと困ることはありますか？', 'ほかに、伝えておきたいことはありますか？'];
  const asked = [];
  const sdk = createFakeSdk({
    userRole: oracleUser(loadedWeekly.persona),
    agent: async (ctx) => {
      if (ctx.turn <= 3) {
        asked.push(ctx.prompt);
        return questions[ctx.turn - 1];
      }
      const work = ctx.options.cwd;
      const answers = asked.slice(1).concat(ctx.prompt);
      await ctx.tool('Write', { file_path: path.join(work, 'knowledge.md'), content: '…' }, { run: () => fs.writeFileSync(path.join(work, 'knowledge.md'), `${answers.map((a) => `- ${a}`).join('\n')}\n`) });
      await ctx.tool('Bash', { command: 'python3 control_build.py ...' }, {
        run: () => {
          // 環境変数 CONTROL_SCAFFOLD は、腕が渡す（置き換えた版の中のスクリプトは、リポジトリの外にあるため）
          const r = spawnSync('python3', ['-I', BUILD, '--name', 'weekly-report', '--title', '週報の作成', '--description', '週報を作ってと頼まれたときに使う', '--knowledge-file', 'knowledge.md', '--scaffold', ctx.options.env.CONTROL_SCAFFOLD], { cwd: work, encoding: 'utf8' });
          if (r.status !== 0) throw new Error(r.stdout + r.stderr);
          return 'ok';
        },
      });
      return '作りました。';
    },
  });
  const record = await runOuterOnce({
    runRoot, sandbox: false, loaded: loadedWeekly, query: sdk.query, arm: 'control', creatorRoot: CONTROL_DIR, convert: fakeConvert,
    runStages: async () => ({ skipped: false, ok: true, stage1: { ok: true }, stage2: { ok: true } }),
  });
  assert.equal(record.stopped.reason, 'generated');
  assert.equal(record.exchanges, 3, '質問は 3 つ（文章の問い）だけ');
  assert.equal(record.items.filter((i) => i.kind === 'creator.question').length, 0, '質問のツールは使わない');
  assert.equal(sdk.calls.find((c) => c.kind === 'agent').options.env.CONTROL_SCAFFOLD, path.join(REPO, 'skills', 'make-plugin', 'scripts', 'scaffold.py'));
  assert.equal(sdk.calls.find((c) => c.kind === 'agent').options.mcpServers, undefined, '対照は、クリエイターのエクステンションの代わりを使わない');
  const g = Object.fromEntries(record.grading.grades.map((x) => [x.id, x]));
  assert.equal(g['one-plugin-generated'].ok, true);
  assert.equal(g['embedded:output'].ok, true, '自分から話すナレッジ（成果物）は、聞かれてもいるので組み込まれる');
  // 聞かれないと話さないナレッジは、組み込まれない
  for (const id of ['headings', 'ijou']) {
    assert.equal(g[`embedded:${id}`].ok, false, id);
    assert.equal(record.grading.trace.find((t) => t.id === id).asked, false, `${id} は聞かれていない`);
    assert.equal(record.grading.trace.find((t) => t.id === id).leaked, false, `${id} はユーザー役からも漏れていない`);
  }
  assert.equal(g['all-items-heard'].ok, false, '対照は項目を聞き尽くさない');
  assert.equal(record.grading.verdict.ok, false);
  assert.equal(record.grading.exampleCandidate, false);
  assert.deepEqual(evaluateControl([record]), { ok: true, runs: 1, problems: [] });
  fs.rmSync(runRoot, { recursive: true, force: true });
});
