// EVAL の課題の読み込みと、作業フォルダの用意（skills/test-plugin/scripts/tasks.mjs）の試験。
// 確かめる要件：REQ-038（課題と基準の置き場所と形）、REQ-041（実行のたびにまっさらな作業フォルダ）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { cleanupTemp, loadScript, makeTemp, sampleTask, tempWith } from './helpers.mjs';

const tasks = await loadScript('tasks.mjs');
const grade = await loadScript('grade.mjs');
after(cleanupTemp);

const plugin = (files) => tempWith(files, 'c3-plugin-');
const evalJson = (task) => JSON.stringify(task, null, 2);

describe('課題の読み込み', () => {
  test('REQ-038 tests/eval/<課題>/eval.json を、フォルダの名前の順に読む', () => {
    const dir = plugin({
      'tests/eval/T-02/eval.json': evalJson(sampleTask({ id: 'T-02' })),
      'tests/eval/T-01/eval.json': evalJson(sampleTask({ id: 'T-01' })),
      'tests/eval/README.md': '課題ではないファイル',
    });
    const out = tasks.loadTasks(dir);
    assert.deepEqual(out.problems, []);
    assert.deepEqual(out.tasks.map((t) => t.id), ['T-01', 'T-02']);
    assert.equal(out.tasks[0].dir, path.join(dir, 'tests', 'eval', 'T-01'));
    assert.equal(out.tasks[0].json.criteria.length, 2);
  });

  test('REQ-038 課題がないとき、eval.json がないとき、JSON が壊れているときは、そう伝える', () => {
    assert.match(tasks.loadTasks(plugin({})).problems.join('\n'), /課題のフォルダがない/);
    assert.match(tasks.loadTasks(plugin({ 'tests/eval/.keep': '' })).problems.join('\n'), /課題が1つもない/);
    const noJson = tasks.loadTasks(plugin({ 'tests/eval/T-01/inputs/a.txt': 'x' }));
    assert.match(noJson.problems.join('\n'), /tests\/eval\/T-01\/eval\.json がない/);
    const broken = tasks.loadTasks(plugin({ 'tests/eval/T-01/eval.json': '{' }));
    assert.match(broken.problems.join('\n'), /tests\/eval\/T-01\/eval\.json を JSON として読めない/);
  });

  test('REQ-038 誤りのある課題は読まず、誤りの文を返す。ほかの課題は読む', () => {
    const bad = sampleTask({ id: 'T-02', criteria: [{ id: 'C-01', text: 'x', grading: 'program', check: { type: 'nothing' } }] });
    const out = tasks.loadTasks(plugin({ 'tests/eval/T-01/eval.json': evalJson(sampleTask()), 'tests/eval/T-02/eval.json': evalJson(bad) }));
    assert.deepEqual(out.tasks.map((t) => t.id), ['T-01']);
    assert.match(out.problems.join('\n'), /tests\/eval\/T-02\/eval\.json.*type「nothing」は使えない/);
  });

  test('REQ-038 課題の id が重なっていると誤りにする', () => {
    const out = tasks.loadTasks(plugin({ 'tests/eval/A/eval.json': evalJson(sampleTask()), 'tests/eval/B/eval.json': evalJson(sampleTask()) }));
    assert.deepEqual(out.tasks.map((t) => t.dir.split(path.sep).at(-1)), ['A']);
    assert.match(out.problems.join('\n'), /id「T-01」が、tests\/eval\/A\/eval\.json と重なっている/);
  });

  test('REQ-038 入力のファイルがないとき、シンボリックリンクのときは誤りにする', () => {
    const dir = plugin({
      'tests/eval/T-01/eval.json': evalJson(sampleTask({ inputs: ['inputs/前回.docx'] })),
      'tests/eval/T-02/eval.json': evalJson(sampleTask({ id: 'T-02', inputs: ['inputs/link.txt'] })),
      'tests/eval/T-03/eval.json': evalJson(sampleTask({ id: 'T-03', inputs: ['inputs'] })),
      'tests/eval/T-03/inputs/real.txt': 'x',
    });
    const outside = tempWith({ 'secret.txt': 'S' });
    fs.mkdirSync(path.join(dir, 'tests/eval/T-02/inputs'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'tests/eval/T-02/inputs/link.txt'));
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'tests/eval/T-03/inputs/link2.txt'));
    const out = tasks.loadTasks(dir);
    const text = out.problems.join('\n');
    assert.match(text, /T-01.*入力「inputs\/前回\.docx」が見つからない/);
    assert.match(text, /T-02.*入力「inputs\/link\.txt」はシンボリックリンク/);
    assert.match(text, /T-03.*入力「inputs」の中に、シンボリックリンクがある（inputs\/link2\.txt）/);
    assert.equal(out.tasks.length, 0);
  });

  test('REQ-038 入力のままで当てはまってしまう採点と、入力に当てはまらない unchanged は誤りにする', () => {
    const criterion = (check) => [{ id: 'C-01', text: 'ヘッダーを変えない', grading: 'program', check }];
    const line = '#define DBG_LOG(fmt, ...) printf(fmt, ##__VA_ARGS__)';
    const dir = plugin({
      'tests/eval/T-01/eval.json': evalJson(sampleTask({ inputs: ['inputs'], criteria: criterion({ type: 'contains', file: 'inputs/src/dbg_log.h', text: line }) })),
      'tests/eval/T-02/eval.json': evalJson(sampleTask({ id: 'T-02', inputs: ['inputs'], criteria: criterion({ type: 'unchanged', file: 'src/dbg_log.h' }) })),
      'tests/eval/T-03/eval.json': evalJson(sampleTask({ id: 'T-03', inputs: ['inputs'], criteria: criterion({ type: 'unchanged', file: 'inputs/src/dbg_log.h' }) })),
      'tests/eval/T-01/inputs/src/dbg_log.h': `${line}\n`,
      'tests/eval/T-02/inputs/src/dbg_log.h': `${line}\n`,
      'tests/eval/T-03/inputs/src/dbg_log.h': `${line}\n`,
    });
    const out = tasks.loadTasks(dir);
    const text = out.problems.join('\n');
    assert.match(text, /tests\/eval\/T-01\/eval\.json\.criteria\[0\]\.check は、課題の入力のファイルがもとのままでも合格してしまう.*unchanged（file）で確かめる/);
    assert.match(text, /tests\/eval\/T-02\/eval\.json\.criteria\[0\]\.check\.file「src\/dbg_log\.h」が、課題の入力のファイルのどれにも当てはまらない/);
    assert.deepEqual(out.tasks.map((t) => t.id), ['T-03']);
  });

  test('REQ-041 入力のファイルの一覧（listInputFiles）は、作業フォルダに写すファイルと同じ', () => {
    const dir = plugin({
      'tests/eval/T-01/eval.json': evalJson(sampleTask({ inputs: ['./inputs/a.txt', 'refs/', 'refs/sub/b.md'] })),
      'tests/eval/T-01/inputs/a.txt': 'A',
      'tests/eval/T-01/refs/r.md': 'R',
      'tests/eval/T-01/refs/sub/b.md': 'B',
    });
    const [task] = tasks.loadTasks(dir).tasks;
    const listed = tasks.listInputFiles(task.dir, task.json.inputs);
    const { inputs } = tasks.prepareWorkDir({ task, dir: path.join(makeTemp(), 'w') });
    assert.deepEqual(listed.map((f) => f.path), [...inputs.keys()].sort());
    assert.deepEqual(listed.map((f) => f.size), [1, 1, 1]);
  });

  test('REQ-040 基準の数を、プログラムで採点するものとモデルが判定するものに分けて数える', () => {
    const task = sampleTask();
    task.criteria.push({ id: 'C-03', text: '読みやすい', grading: 'model' });
    assert.deepEqual(tasks.countCriteria({ json: task }), { total: 3, program: 2, model: 1 });
  });
});

describe('作業フォルダ', () => {
  test('REQ-041 実行のたびに、課題の入力のファイルだけを写した、まっさらな作業フォルダを作る', () => {
    const dir = plugin({
      'tests/eval/T-01/eval.json': evalJson(sampleTask({ inputs: ['inputs/前回の週報.docx', 'refs'] })),
      'tests/eval/T-01/inputs/前回の週報.docx': 'docx の中身',
      'tests/eval/T-01/inputs/使わないファイル.txt': '写さない',
      'tests/eval/T-01/refs/a.md': 'A',
      'tests/eval/T-01/refs/sub/b.md': 'B',
    });
    const [task] = tasks.loadTasks(dir).tasks;
    const target = path.join(makeTemp(), 'T-01-with-1');
    const { workDir, inputs } = tasks.prepareWorkDir({ task, dir: target });
    assert.equal(workDir, fs.realpathSync(target));
    const listed = grade.listFiles(workDir).map((f) => f.path);
    assert.deepEqual(listed, ['inputs/前回の週報.docx', 'refs/a.md', 'refs/sub/b.md']);
    assert.deepEqual([...inputs.keys()].sort(), listed);
    assert.equal(inputs.get('refs/sub/b.md'), grade.sha256OfFile(path.join(workDir, 'refs/sub/b.md')));
    // 2回目は別のフォルダで、前の実行の成果物は入らない
    fs.writeFileSync(path.join(workDir, 'out.md'), '前の実行の成果物');
    const second = tasks.prepareWorkDir({ task, dir: path.join(makeTemp(), 'T-01-with-2') });
    assert.equal(grade.listFiles(second.workDir).some((f) => f.path === 'out.md'), false);
  });

  test('REQ-041 入力がない課題は、空の作業フォルダになる。空でないフォルダは使わない', () => {
    const dir = plugin({ 'tests/eval/T-01/eval.json': evalJson(sampleTask({ inputs: [] })) });
    const [task] = tasks.loadTasks(dir).tasks;
    const target = path.join(makeTemp(), 'w');
    const { workDir, inputs } = tasks.prepareWorkDir({ task, dir: target });
    assert.deepEqual(fs.readdirSync(workDir), []);
    assert.equal(inputs.size, 0);
    fs.writeFileSync(path.join(workDir, 'x'), '1');
    assert.throws(() => tasks.prepareWorkDir({ task, dir: workDir }), /作業フォルダが空ではない/);
  });
});

describe('擬似の機器の道具（bin）と、エージェントが動いたかの基準（agent_ran）', () => {
  const binTask = (overrides = {}) => sampleTask({ inputs: ['inputs/src', 'inputs/bin'], bin: 'inputs/bin', ...overrides });
  const binFiles = (task = binTask()) => ({
    'tests/eval/T-01/eval.json': evalJson(task),
    'tests/eval/T-01/inputs/src/main.c': 'int main(void) { return 0; }\n',
    'tests/eval/T-01/inputs/bin/kxtool': '#!/bin/sh\necho "$@" >> "$(dirname "$0")/../../device-history.log"\n',
  });
  const withPlatform = (platform, fn) => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...original, value: platform });
    try {
      return fn();
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  };

  test('REQ-061 bin の課題を読み、作業フォルダに写した bin の下のファイルに実行の権限を付ける', () => {
    const dir = plugin(binFiles());
    fs.chmodSync(path.join(dir, 'tests/eval/T-01/inputs/bin/kxtool'), 0o644);
    const out = tasks.loadTasks(dir);
    assert.deepEqual(out.problems, []);
    const [task] = out.tasks;
    const { workDir, inputs, binDir } = tasks.prepareWorkDir({ task, dir: path.join(makeTemp(), 'w') });
    assert.equal(binDir, path.join(workDir, 'inputs', 'bin'));
    assert.equal(tasks.binDirOf(task, workDir), binDir);
    if (process.platform !== 'win32') assert.notEqual(fs.statSync(path.join(binDir, 'kxtool')).mode & 0o111, 0, '実行の権限がある');
    assert.equal(inputs.get('inputs/bin/kxtool'), grade.sha256OfFile(path.join(binDir, 'kxtool')), '権限を付けても中身は変わらない');
    assert.deepEqual(fs.readdirSync(workDir).sort(), ['inputs']);
  });

  test('REQ-061 bin のない課題では、binDir は null で、権限も変えない', () => {
    const dir = plugin({ 'tests/eval/T-01/eval.json': evalJson(sampleTask({ inputs: ['inputs/a.sh'] })), 'tests/eval/T-01/inputs/a.sh': 'echo' });
    fs.chmodSync(path.join(dir, 'tests/eval/T-01/inputs/a.sh'), 0o644);
    const [task] = tasks.loadTasks(dir).tasks;
    const { workDir, binDir } = tasks.prepareWorkDir({ task, dir: path.join(makeTemp(), 'w') });
    assert.equal(binDir, null);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(workDir, 'inputs/a.sh')).mode & 0o111, 0);
  });

  test('REQ-061 bin が inputs/bin でない課題、bin のフォルダを入力にしない課題は、課題の誤りにする', () => {
    const wrong = tasks.loadTasks(plugin(binFiles(binTask({ bin: 'inputs/tools' }))));
    assert.match(wrong.problems.join('\n'), /tests\/eval\/T-01\/eval\.json\.bin は "inputs\/bin" だけを書ける/);
    const notCopied = tasks.loadTasks(plugin(binFiles(binTask({ inputs: ['inputs/src'] }))));
    assert.match(notCopied.problems.join('\n'), /inputs に、inputs\/bin か、その下のファイルがない/);
  });

  test('REQ-061 Windows では、bin のある課題を、理由を示して課題の誤りにする（bin のない課題は読む）', () => {
    const out = withPlatform('win32', () =>
      tasks.loadTasks(plugin({ ...binFiles(), 'tests/eval/T-02/eval.json': evalJson(sampleTask({ id: 'T-02' })) })),
    );
    assert.deepEqual(out.tasks.map((t) => t.id), ['T-02']);
    assert.match(out.problems.join('\n'), /T-01\/eval\.json は擬似の機器の道具（bin）を使う課題なので、Windows では動かさない/);
    assert.match(out.problems.join('\n'), /本物の機器に送ってしまうため/);
    assert.deepEqual(withPlatform('linux', () => tasks.loadTasks(plugin(binFiles()))).problems, []);
  });

  test('REQ-061 agent_ran の基準のエージェントの定義が生成プラグインにないと、課題の誤りにする', () => {
    const task = sampleTask({ criteria: [{ id: 'C-01', text: 'デプロイ役が動いた', grading: 'program', check: { type: 'agent_ran', agent: 'worker-deploy' } }] });
    const missing = tasks.loadTasks(plugin({ 'tests/eval/T-01/eval.json': evalJson(task) }));
    assert.match(missing.problems.join('\n'), /check\.agent「worker-deploy」のエージェントの定義（com\.github\.copilot\/agents\/worker-deploy\.agent\.md）がない/);
    const found = tasks.loadTasks(plugin({ 'tests/eval/T-01/eval.json': evalJson(task), 'com.github.copilot/agents/worker-deploy.agent.md': '---\n---\n' }));
    assert.deepEqual(found.problems, []);
  });
});

describe('unchanged の採点と、入力の名前の正規化', () => {
  test('REQ-041 入力のフォルダの中のファイルの名前が NFD でも、unchanged は写した入力を見つける', async () => {
    const nfd = 'がいど.md'.normalize('NFD');
    const dir = plugin({
      'tests/eval/T-01/eval.json': evalJson(
        sampleTask({ inputs: ['inputs'], criteria: [{ id: 'C-01', text: '手引きを変えない', grading: 'program', check: { type: 'unchanged', file: 'inputs/*.md' } }] }),
      ),
      [`tests/eval/T-01/inputs/${nfd}`]: '手引き\n',
    });
    const out = tasks.loadTasks(dir);
    assert.deepEqual(out.problems, []);
    const [task] = out.tasks;
    const { workDir, inputs } = tasks.prepareWorkDir({ task, dir: path.join(makeTemp(), 'w') });
    const first = await grade.gradeRun({ task: task.json, workDir, inputs });
    assert.deepEqual(first.results.map((r) => [r.pass, r.reason]), [[true, '課題の入力のファイルは、もとのまま（inputs/がいど.md）']]);
    fs.appendFileSync(path.join(workDir, 'inputs', nfd), '足した\n');
    const second = await grade.gradeRun({ task: task.json, workDir, inputs });
    assert.equal(second.results[0].pass, false);
    assert.match(second.results[0].reason, /中身が変わっている：inputs\/がいど\.md/);
  });
});
