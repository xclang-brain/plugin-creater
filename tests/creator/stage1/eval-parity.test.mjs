// 1段目の EVAL の課題の検査（template/tests/stage1/check_structure.py の check_eval）と、
// 採点の課題の読み込み（skills/test-plugin/scripts/tasks.mjs の loadTasks。grade.mjs の validateTask と inputCheckProblems を使う）が、
// 同じ誤りを見つけることの確かめ（片方）。
// 同じ例（eval-cases.json）を Python 側（test_check_structure.py の EvalParity）にも通す。
// ずれる（片方が通し、片方が断る）と、どちらかの試験が落ちる。
// 動かし方：node --test "tests/creator/stage1/*.test.mjs"
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadTasks } from '../../../skills/test-plugin/scripts/tasks.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { base, baseFiles, pluginFiles, cases } = JSON.parse(fs.readFileSync(path.join(here, 'eval-cases.json'), 'utf8'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-parity-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

/** 例から課題を作る。値が "$remove" の項目は消す（Python 側 test_check_structure.py の build_task と同じ決まり） */
function buildTask(c) {
  const task = structuredClone(base);
  for (const [key, value] of Object.entries(c.top ?? {})) {
    if (value === '$remove') delete task[key];
    else task[key] = value;
  }
  if (c.criterion) {
    const first = { ...task.criteria[0] };
    for (const [key, value] of Object.entries(c.criterion)) {
      if (value === '$remove') delete first[key];
      else first[key] = value;
    }
    task.criteria[0] = first;
  }
  return task;
}

/** 例の課題を、生成プラグインの形（tests/eval/T-01/）のフォルダに置く。Python 側の write_case と同じ決まり */
function writePlugin(c, index) {
  const pluginDir = path.join(temp, String(index));
  const taskDir = path.join(pluginDir, 'tests', 'eval', 'T-01');
  fs.mkdirSync(taskDir, { recursive: true });
  for (const [rel, content] of Object.entries(pluginFiles ?? {})) {
    const file = path.join(pluginDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  fs.writeFileSync(path.join(taskDir, 'eval.json'), JSON.stringify(buildTask(c)));
  for (const [rel, content] of Object.entries({ ...baseFiles, ...(c.files ?? {}) })) {
    if (content === null) continue;
    const file = path.join(taskDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : Buffer.from(content.base64, 'base64'));
  }
  return pluginDir;
}

cases.forEach((c, index) => {
  test(`REQ-041 採点の決まり（grade.mjs）が、1段目と同じ判定をする：${c.name}`, () => {
    const { problems } = loadTasks(writePlugin(c, index));
    if (c.ok) assert.deepEqual(problems, [], '通るはずの課題が断られた');
    else assert.notEqual(problems.length, 0, '断られるはずの課題が通った');
  });
});
