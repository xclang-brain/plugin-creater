// 模擬ユーザーの形を確かめるスクリプト（validate.mjs）と、模擬ユーザーそのものの試験。
// 動かし方：node --test "tests/dev-eval/personas/*.test.mjs"
// make_files.py の試験は、python-docx と openpyxl が入った Python があるときだけ動く（環境変数 PERSONA_PYTHON で場所を渡す。なければ python3）。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { documentText } from '../../../com.github.copilot/extensions/plugin-creator/doc-text.mjs';
import { itemIndex } from '../../../com.github.copilot/extensions/plugin-creator/names.mjs';
import { gradeProgram, listFiles } from '../../../skills/test-plugin/scripts/grade.mjs';
import { prepareWorkDir } from '../../../skills/test-plugin/scripts/tasks.mjs';
import { knowledgeTrace } from '../runner/outer-grade.mjs';
import { CONFIRM_ANSWERS, CONFIRM_CHOICES, FIXTURES_DIR, KIND_ANSWER, STYLE_KEYS, loadPersona, readTarGz, validatePersona } from './validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERSONAS = ['weekly-report', 'meeting-minutes', 'training-survey', 'edl-change'];
/** 話し方の 6 つをそろえている模擬ユーザー */
const ALL_STYLES = ['weekly-report', 'meeting-minutes'];
const dirOf = (id) => path.join(HERE, id);
const readPersona = (id) => JSON.parse(fs.readFileSync(path.join(dirOf(id), 'persona.json'), 'utf8'));

/** 模擬ユーザーを一時のフォルダに写し、persona.json（と任意のファイル）を書き換えて確かめる */
async function mutate(id, change, { allStyles = false, files = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-test-'));
  try {
    const dir = path.join(root, id);
    fs.cpSync(dirOf(id), dir, { recursive: true });
    const persona = readPersona(id);
    change(persona, dir);
    fs.writeFileSync(path.join(dir, 'persona.json'), JSON.stringify(persona, null, 2));
    if (files) files(dir);
    return await validatePersona(dir, { allStyles });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const hasError = (result, part) => result.errors.some((e) => e.includes(part));
const knowledgeOf = (persona, id) => persona.knowledge.find((k) => k.id === id);

// ---- 模擬ユーザーそのもの ------------------------------------------------------------------------------------

for (const id of PERSONAS) {
  test(`REQ-017 模擬ユーザー ${id} が形の決まりに合う`, async () => {
    const result = await validatePersona(dirOf(id), { allStyles: ALL_STYLES.includes(id) });
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
  });
}

test('REQ-017 示すファイルのある 2 人の模擬ユーザーに、docx か xlsx が入っていて、3 種類の決まりがある', () => {
  for (const id of ['weekly-report', 'meeting-minutes']) {
    const persona = readPersona(id);
    assert.ok(persona.files.some((f) => /\.(docx|xlsx)$/.test(f.src)), `${id}: docx か xlsx がない`);
    const kinds = new Set(persona.knowledge.filter((k) => k.from === 'file').map((k) => k.file.kind));
    for (const kind of ['rule', 'exception', 'incidental']) assert.ok(kinds.has(kind), `${id}: ${kind} がない`);
  }
});

test('REQ-017 決まりの確かめの 4 つの答えが、少なくとも 1 人の模擬ユーザーで使われている', () => {
  const used = new Set();
  for (const id of PERSONAS) for (const k of readPersona(id).knowledge) if (k.file) used.add(k.file.answer);
  assert.deepEqual([...used].sort(), [...CONFIRM_ANSWERS].sort());
  assert.deepEqual(Object.values(KIND_ANSWER).sort(), [...CONFIRM_ANSWERS].sort());
  assert.equal(CONFIRM_CHOICES.at(-1), 'このとおり');
});

for (const id of ['weekly-report', 'meeting-minutes']) {
  test(`REQ-015 ${id} の模擬ユーザーは、話し方の 6 つがそろい、急いでいるは合図を持つ`, () => {
    const styles = readPersona(id).styles;
    assert.deepEqual(Object.keys(styles).sort(), [...STYLE_KEYS].sort());
    assert.equal(styles.hurry.signal.afterAnswers >= 1, true);
    for (const key of ['vague', 'dont-know', 'nothing-special']) assert.equal(styles[key].reask, true);
    for (const key of STYLE_KEYS.filter((k) => k !== 'normal')) assert.ok(styles[key].instruction.length > 0, key);
  });
}

test('REQ-015 話し方の指示にナレッジの言葉が入っていると不合格になる（議事録の話し方で）', async () => {
  const r = await mutate('meeting-minutes', (p) => {
    p.styles.terse.instruction += '決まったことには【決定】を付ける。';
    p.styles.hurry.signal.text += '宿題の期限はいつですか？';
  });
  assert.ok(hasError(r, 'styles.terse の指示に、ナレッジ「decision-mark」'));
  assert.ok(hasError(r, 'styles.hurry の指示に、ナレッジ「todo-owner」'));
});

test('REQ-016 まだやったことのない模擬ユーザーは、ファイルがなく、想定の 1 回のナレッジを持つ', () => {
  const persona = readPersona('training-survey');
  assert.equal(persona.experience, 'never');
  assert.deepEqual(persona.files, []);
  const firstRun = knowledgeOf(persona, 'first-run');
  assert.ok(firstRun);
  assert.match('初めてやるとしたら、最初に何をしますか？', new RegExp(firstRun.markers.asked));
  assert.equal(fs.existsSync(path.join(dirOf('training-survey'), 'files')), false);
});

test('REQ-015 聞かれないと話さないナレッジが、どの模擬ユーザーにもある', () => {
  for (const id of PERSONAS) assert.ok(readPersona(id).knowledge.some((k) => k.volunteer === false), id);
});

test('REQ-038 内側の EVAL の見本の成果物が、program の基準にすべて合格する（validate.mjs が確かめている）', async () => {
  for (const id of PERSONAS) {
    const task = JSON.parse(fs.readFileSync(path.join(dirOf(id), 'inner', 'eval.json'), 'utf8'));
    assert.ok(task.criteria.some((c) => c.grading === 'program'), id);
    assert.ok(fs.readdirSync(path.join(dirOf(id), 'inner', 'golden')).length > 0, id);
  }
});

test('REQ-017 loadPersona が、示すファイルの元の絶対の場所と置き場所を返す', async () => {
  const { persona, files, dir } = await loadPersona(dirOf('weekly-report'), { allStyles: true });
  assert.equal(persona.id, 'weekly-report');
  assert.equal(dir, dirOf('weekly-report'));
  assert.equal(files.length, 3);
  for (const f of files) {
    assert.ok(path.isAbsolute(f.src));
    assert.ok(fs.existsSync(f.src));
    assert.ok(!f.place.startsWith('/') && !f.place.includes('..'));
  }
  assert.deepEqual(files.map((f) => f.role).sort(), ['input', 'output', 'template']);
});

test('REQ-017 loadPersona は、形に合わない模擬ユーザーでは Error を投げる', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-test-'));
  try {
    const dir = path.join(root, 'broken');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'persona.json'), '{}');
    await assert.rejects(() => loadPersona(dir), /形が決まりに合わない/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- 確かめるスクリプトが、誤りを見つけること --------------------------------------------------------------------------

test('REQ-017 示すファイルの evidence が文書の文字にないと不合格になる', async () => {
  const r = await mutate('weekly-report', (p) => {
    knowledgeOf(p, 'ijou').file.evidence = 'ファイルにない文字';
  });
  assert.equal(r.ok, false);
  assert.ok(hasError(r, 'evidence'));
});

test('REQ-017 xlsx の数式の evidence も、文書をテキストにした結果で確かめる', async () => {
  const r = await mutate('weekly-report', (p) => {
    knowledgeOf(p, 'man-yen').file.evidence = 'SUMPRODUCT';
  });
  assert.ok(hasError(r, 'evidence'));
});

test('REQ-017 たまたまの書き方がないと不合格になる', async () => {
  const r = await mutate('weekly-report', (p) => {
    p.knowledge = p.knowledge.filter((k) => k.id !== 'title-date');
    p.userRoleTests.recall = p.userRoleTests.recall.filter((x) => x.knowledge !== 'title-date');
    p.userRoleTests.confirm = p.userRoleTests.confirm.filter((x) => x.knowledge !== 'title-date');
  });
  assert.ok(hasError(r, 'incidental'));
});

test('REQ-017 例外のある決まりがないと不合格になる', async () => {
  const r = await mutate('meeting-minutes', (p) => {
    knowledgeOf(p, 'todo-owner').file.kind = 'rule';
    knowledgeOf(p, 'todo-owner').file.answer = 'このとおり';
  });
  assert.ok(hasError(r, 'exception'));
});

test('REQ-017 kind と answer が食い違うと不合格になる', async () => {
  const r = await mutate('weekly-report', (p) => {
    knowledgeOf(p, 'ijou').file.answer = '違う';
  });
  assert.ok(hasError(r, 'file.answer'));
});

test('REQ-017 例外と「違う」に detail がないと不合格になる', async () => {
  const r1 = await mutate('weekly-report', (p) => {
    delete knowledgeOf(p, 'man-yen').file.detail;
  });
  assert.ok(hasError(r1, 'file.detail'));
  const r2 = await mutate('meeting-minutes', (p) => {
    delete knowledgeOf(p, 'style').file.detail;
  });
  assert.ok(hasError(r2, 'file.detail'));
});

test('REQ-017 たまたまの書き方を自分から話す設定にすると不合格になる', async () => {
  const r = await mutate('weekly-report', (p) => {
    knowledgeOf(p, 'title-date').volunteer = true;
    delete knowledgeOf(p, 'title-date').markers.leak;
  });
  assert.ok(hasError(r, 'incidental'));
});

test('REQ-017 たまたまの書き方に excluded がないと不合格になる', async () => {
  const r = await mutate('weekly-report', (p) => {
    delete knowledgeOf(p, 'title-date').markers.excluded;
  });
  assert.ok(hasError(r, 'excluded'));
});

test('REQ-017 ファイルの決まりの確かめ（confirm）がないと不合格になる', async () => {
  const r = await mutate('weekly-report', (p) => {
    p.userRoleTests.confirm = p.userRoleTests.confirm.filter((x) => x.knowledge !== 'ijou');
  });
  assert.ok(hasError(r, '決まりの確かめ'));
});

test('REQ-015 聞かれないと話さないナレッジに leak がないと不合格になる', async () => {
  const r = await mutate('meeting-minutes', (p) => {
    delete knowledgeOf(p, 'decision-mark').markers.leak;
  });
  assert.ok(hasError(r, 'markers.leak'));
});

test('REQ-015 leak と answered が、ナレッジの文にない言葉だと不合格になる', async () => {
  const r = await mutate('meeting-minutes', (p) => {
    knowledgeOf(p, 'decision-mark').markers.leak = '存在しない言葉';
    knowledgeOf(p, 'output').markers.answered = '存在しない言葉';
  });
  assert.ok(hasError(r, 'markers.leak が'));
  assert.ok(hasError(r, 'markers.answered が'));
});

test('REQ-015 読めない正規表現があると不合格になる', async () => {
  const r = await mutate('weekly-report', (p) => {
    knowledgeOf(p, 'output').markers.asked = '(';
    p.userRoleTests.abstain = '[';
  });
  assert.ok(hasError(r, 'markers.asked'));
  assert.ok(hasError(r, 'abstain'));
});

test('REQ-017 知らない項目（書き間違い）があると不合格になる', async () => {
  const r = await mutate('weekly-report', (p) => {
    knowledgeOf(p, 'output').volunteerr = true;
    p.stlyes = {};
  });
  assert.ok(hasError(r, '知らない項目「volunteerr」'));
  assert.ok(hasError(r, '知らない項目「stlyes」'));
});

test('REQ-017 id がフォルダの名前と違う、knowledge の id が重なると不合格になる', async () => {
  const r = await mutate('weekly-report', (p) => {
    p.id = 'other-name';
    p.knowledge[1].id = 'output';
  });
  assert.ok(hasError(r, 'フォルダの名前'));
  assert.ok(hasError(r, '重なっている'));
});

test('REQ-017 docx も xlsx もない、置き場所が危ない、元のファイルがないと不合格になる', async () => {
  const r1 = await mutate('weekly-report', (p) => {
    p.files = p.files.filter((f) => f.src.endsWith('.csv'));
    p.knowledge = p.knowledge.filter((k) => k.from !== 'file');
    p.userRoleTests.recall = p.userRoleTests.recall.filter((x) => x.knowledge === 'output');
    p.userRoleTests.compound = [];
    p.userRoleTests.confirm = [];
  });
  assert.ok(hasError(r1, 'docx か xlsx'));
  const r2 = await mutate('weekly-report', (p) => {
    p.files[0].place = '../外/先週の週報.docx';
    p.files[1].src = 'files/ない.xlsx';
  });
  assert.ok(hasError(r2, '.. は使えない'));
  assert.ok(hasError(r2, 'のファイルがない'));
});

test('REQ-016 まだやったことのない作業は、ファイルがあると不合格になり、first-run がないと不合格になる', async () => {
  const r1 = await mutate('training-survey', (p) => {
    p.files = [{ src: 'inner/inputs/survey.csv', place: '資料/survey.csv', role: 'input', describe: 'x', reveal: 'y' }];
  });
  assert.ok(hasError(r1, 'files は [] にする'));
  const r2 = await mutate('training-survey', (p) => {
    p.knowledge = p.knowledge.filter((k) => k.id !== 'first-run');
    p.userRoleTests.recall = p.userRoleTests.recall.filter((x) => x.knowledge !== 'first-run');
  });
  assert.ok(hasError(r2, 'first-run'));
});

test('REQ-015 話し方：normal がない、キーが違う、hurry に合図がない、vague に reask がないと不合格になる', async () => {
  const r1 = await mutate('weekly-report', (p) => {
    delete p.styles.normal;
    p.styles.angry = { label: 'x', instruction: 'y' };
    delete p.styles.hurry.signal;
    p.styles.vague.reask = false;
  });
  assert.ok(hasError(r1, 'styles.normal がない'));
  assert.ok(hasError(r1, '使えないキー「angry」'));
  assert.ok(hasError(r1, 'styles.hurry.signal'));
  assert.ok(hasError(r1, 'styles.vague.reask'));
  const r2 = await mutate('weekly-report', (p) => {
    delete p.styles['dont-know'];
  }, { allStyles: true });
  assert.ok(hasError(r2, 'styles.dont-know がない'));
});

test('REQ-015 ユーザー役の試験の質問が足りない（compound の対象が 1 つ、context が空など）と不合格になる', async () => {
  const r = await mutate('weekly-report', (p) => {
    p.userRoleTests.generic = ['1つだけ'];
    p.userRoleTests.compound[0].expect = ['ijou'];
    p.userRoleTests.context = [];
    p.userRoleTests.options[0].choices = ['Markdown'];
    p.userRoleTests.unknown = ['1つだけ'];
  });
  assert.ok(hasError(r, 'userRoleTests.generic'));
  assert.ok(hasError(r, 'userRoleTests.compound[0].expect'));
  assert.ok(hasError(r, 'userRoleTests.context'));
  assert.ok(hasError(r, 'userRoleTests.options[0].choices'));
  assert.ok(hasError(r, 'userRoleTests.unknown'));
});

test('REQ-015 recall と confirm と compound の質問が、そのナレッジの asked に当たらないと不合格になる', async () => {
  const r = await mutate('weekly-report', (p) => {
    p.userRoleTests.recall[2].questions[0] = 'あのことは、どうですか？';
    p.userRoleTests.confirm[0].question = 'あのことは、決まりですか？';
    p.userRoleTests.compound[0].question = 'ルールはありますか？';
  });
  assert.ok(hasError(r, 'ナレッジ「ijou」の markers.asked'));
  assert.ok(hasError(r, 'ナレッジ「headings」の markers.asked'));
  assert.ok(hasError(r, 'ナレッジ「man-yen」の markers.asked'));
});

test('REQ-015 ナレッジごとの具体的な質問（recall か confirm）がないと不合格になる', async () => {
  const r = await mutate('meeting-minutes', (p) => {
    p.userRoleTests.recall = p.userRoleTests.recall.filter((x) => x.knowledge !== 'output');
  });
  assert.ok(hasError(r, 'ナレッジ「output」の具体的な質問'));
});

// ---- 内側の EVAL ---------------------------------------------------------------------------------------------

test('REQ-038 見本の成果物が基準に合格しないと不合格になる（見出しを消した見本）', async () => {
  const r = await mutate('weekly-report', () => {}, {
    files: (dir) => {
      const file = path.join(dir, 'inner', 'golden', 'weekly_report.md');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('■来週の予定', '来週の予定'));
    },
  });
  assert.ok(hasError(r, '基準「C-03」'));
  assert.equal(r.errors.length, 1);
});

test('REQ-038 氏名を出した見本は、氏名を出さない基準に合格しない', async () => {
  const r = await mutate('training-survey', () => {}, {
    files: (dir) => {
      const file = path.join(dir, 'inner', 'golden', 'survey_summary.md');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('受講者B', '佐々木'));
    },
  });
  assert.ok(hasError(r, '基準「C-03」'));
});

test('REQ-038 最後の行が「以上」でない見本は、最後の行の基準に合格しない', async () => {
  const r = await mutate('weekly-report', () => {}, {
    files: (dir) => {
      const file = path.join(dir, 'inner', 'golden', 'weekly_report.md');
      fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8').trimEnd()}\n以上です\n`);
    },
  });
  assert.ok(hasError(r, '基準「C-07」'));
});

test('REQ-038 見本のフォルダがない、eval.json がない、入力がないと不合格になる', async () => {
  const r1 = await mutate('weekly-report', () => {}, { files: (dir) => fs.rmSync(path.join(dir, 'inner', 'golden'), { recursive: true }) });
  assert.ok(hasError(r1, 'inner/golden/'));
  const r2 = await mutate('weekly-report', () => {}, { files: (dir) => fs.rmSync(path.join(dir, 'inner', 'eval.json')) });
  assert.ok(hasError(r2, 'inner/eval.json がない'));
  const r3 = await mutate('weekly-report', () => {}, { files: (dir) => fs.rmSync(path.join(dir, 'inner', 'inputs', 'sales.csv')) });
  assert.ok(hasError(r3, '入力「inputs/sales.csv」が見つからない'));
});

test('REQ-038 基準の knowledge が模擬ユーザーにない、markers.task のあるナレッジに基準がないと不合格になる', async () => {
  const r = await mutate('meeting-minutes', () => {}, {
    files: (dir) => {
      const file = path.join(dir, 'inner', 'eval.json');
      const task = JSON.parse(fs.readFileSync(file, 'utf8'));
      task.criteria[0].knowledge = 'ない-id';
      task.criteria = task.criteria.filter((c) => c.knowledge !== 'decision-mark');
      fs.writeFileSync(file, JSON.stringify(task, null, 2));
    },
  });
  assert.ok(hasError(r, 'knowledge「ない-id」'));
  assert.ok(hasError(r, 'ナレッジ「decision-mark」は markers.task を持つが'));
});

test('REQ-038 eval.json が grade.mjs の決まりに合わない（grading が違う）と不合格になる', async () => {
  const r = await mutate('weekly-report', () => {}, {
    files: (dir) => {
      const file = path.join(dir, 'inner', 'eval.json');
      const task = JSON.parse(fs.readFileSync(file, 'utf8'));
      task.criteria[0].grading = 'human';
      fs.writeFileSync(file, JSON.stringify(task, null, 2));
    },
  });
  assert.ok(hasError(r, 'grading'));
});

// ---- 改善・設計変更の模擬ユーザー（kind が change） -------------------------------------------------------------

const EDL = 'edl-change';
const fixtureFiles = () => readTarGz(path.join(FIXTURES_DIR, 'market.tar.gz'));

test('REQ-055 改善の模擬ユーザー edl-change は、題材のリポジトリ・直す対象・ユーザーのスキル・擬似の機器を持つ', async () => {
  const p = readPersona(EDL);
  assert.equal(p.kind, 'change');
  assert.equal(p.target, 'market/plugins/embedded-debug-loop');
  assert.equal(p.device, 'kx200');
  assert.equal(p.workspace.repo.fixture, 'market.tar.gz');
  const skills = p.files.filter((f) => f.role === 'skill').map((f) => f.place);
  assert.ok(skills.length >= 4 && skills.every((place) => place.startsWith(`${p.expect.userSkills}/`)));
  for (const name of ['cross-compile', 'deploy']) assert.ok(skills.includes(`${p.expect.userSkills}/${name}/SKILL.md`), name);
  assert.ok(skills.some((place) => place.endsWith('/scripts/mkkximg.py')));
  assert.deepEqual(p.files.filter((f) => f.role === 'repo').map((f) => f.place), ['market/plugins/embedded-debug-loop/skills/log-insertion-rules/SKILL.md']);
  const { fixture, files } = await loadPersona(dirOf(EDL));
  assert.equal(fixture, path.join(FIXTURES_DIR, 'market.tar.gz'));
  assert.equal(files.find((f) => f.role === 'repo').describe, undefined);
  // 4 つの答え（rule・exception・incidental・wrong）が、ユーザーのスキルから読み取る決まりにそろっている
  const kinds = new Set(p.knowledge.filter((k) => k.from === 'file' && k.file.path.startsWith(`${p.expect.userSkills}/`)).map((k) => k.file.kind));
  assert.deepEqual([...kinds].sort(), ['exception', 'incidental', 'rule', 'wrong']);
});

test('REQ-054 書き足した決まりのファイル（role が repo）は、題材の元のファイルに 1 行足したものである', () => {
  const p = readPersona(EDL);
  const place = p.files.find((f) => f.role === 'repo').place;
  const original = fixtureFiles().get(place.replace(/^market\//, '')).toString('utf8').split('\n');
  const changed = fs.readFileSync(path.join(dirOf(EDL), 'files', place), 'utf8').split('\n');
  const at = changed.findIndex((line, i) => line !== original[i]);
  assert.equal(changed[at], '- KX-200 では `dbg_log.h` の `DBG_LOG` でログを出し、printf を直接使わない。');
  assert.deepEqual([...changed.slice(0, at), ...changed.slice(at + 1)], original);
  const k = knowledgeOf(p, 'log-dbg');
  assert.equal(k.file.path, place);
  assert.equal(k.file.kind, 'rule');
});

test('REQ-058 K-15 の今を答えるナレッジがあり、expect の番号が題材の決まりの一覧と合う', () => {
  const p = readPersona(EDL);
  const knowledge = JSON.parse(fixtureFiles().get('plugins/embedded-debug-loop/tests/knowledge.json').toString('utf8'));
  assert.equal(p.expect.carriedMax, knowledge.length);
  assert.ok(knowledge.some((k) => k.id === p.expect.replaced));
  const k15 = knowledgeOf(p, 'k15-now');
  // 一覧を見せられる前のユーザーは、決まりの番号を知らない。番号でなく中身で書く（外側の EVAL（改善）1回目の診断 1.1）
  assert.doesNotMatch(k15.fact, /K-\d/);
  assert.match(k15.fact, /reboot/);
  assert.match(k15.markers.asked, /K-15/);
  // 元の K-15 の場合（ビルドの失敗・デプロイできない・実機が応答しない・ログが取れない）に、それぞれ今どうするかを答えられる
  const original = knowledge.find((k) => k.id === p.expect.replaced).text;
  for (const words of ['ビルドが失敗', 'デプロイできない', '実機が応答しない', 'ログが取れない']) {
    assert.ok(original.includes(words), `元の K-15 に「${words}」がない`);
    assert.ok(k15.fact.includes(words), `k15-now の fact に「${words}」のときがない`);
  }
  const listQuestion = p.userRoleTests.options[0].question;
  for (const k of knowledge) assert.ok(listQuestion.includes(k.id), `${k.id} が決まりの一覧の問いにない`);
});

// クリエイターの問いの例（make-plugin の references）の「…」を、入れ子の「」ごと取り出す
const REFERENCES = path.join(HERE, '..', '..', '..', 'skills', 'make-plugin', 'references');
function exampleQuestions(name) {
  const text = fs.readFileSync(path.join(REFERENCES, name), 'utf8');
  const out = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '「') {
      if (depth === 0) start = i + 1;
      depth += 1;
    } else if (text[i] === '」' && depth > 0) {
      depth -= 1;
      if (depth === 0) out.push(text.slice(start, i));
    }
  }
  return out.filter((q) => q.length >= 20);
}

// 外側の EVAL（改善）2回目の問い（会話の記録の seq）。見出しと問いは記録のとおり。決まりの一覧の問い 167 は、題材の決まりの一覧から作る
// （記録の問いと同じ文になることを確かめてある）
const RUN2 = {
  43: { header: 'ファイル', question: '実際のファイルがあると、AI が KX-200 での書き方や決まりを取り違えにくくなり、直した後のプラグインを試しに動かすときの入力にも使えます。cross-compile と deploy のスキルのほかに、最近 KX-200 でビルドやデプロイ、デバッグをしたときに受け取ったファイルと作ったファイル（ログ、設定ファイル、手順書、スクリプトなど）は、どこにありますか？ファイルの場所（パス）か @ で書いてください。ない場合は「ない」と書いてください。' },
  152: { header: '範囲', question: '直した後のプラグインは、今できていることをすべて引き継ぎます。引き継ぐことと変えるところが違っていると、要らないところまで直したり、直すべきところが抜けたりします。\n\n今のプラグインは、次のことができます。\n1. 調査プロンプトを書いて頼むと、作業の画面を開いて URL を渡す\n2. 画面で開始を押すと、まとめ役の AI が1回の試しごとに Plan・Do・See を回し、ソースコード担当→ビルド・デプロイ担当の順に頼む\n3. 成功条件や材料が足りないと、調査を始めずに人に質問する\n4. ソースコード担当が C/C++ のソースを調べ、修正とログ追加をして、差分を画面に出す\n5. ビルド・デプロイ担当が、クロスコンパイルとデプロイのルールに従ってビルド・デプロイ・ログ取得をし、実機のログと結果を画面に出す。工程の図も描く\n6. ビルド失敗・デプロイ失敗・実機が応答しない・ログが取れないときは止めて、人に判断を求める\n7. 確認役の AI が、成功条件・ルールどおりの作業・制約を判定する\n8. 終わると、結論→全体の結果→PDS の表→改善用のログ→振り返りを出し、Issue の案を出す\n9. 作業の始めに、画面で選んだエフォートレベルを各 AI に書き込む\n\n今は、クロスコンパイルとデプロイのルールが空のひな形のままです。今回は、KX-200 のボードで使えるように、kx200-firmware/.github/skills の cross-compile と deploy のスキル（中の kx-build.sh、mkkximg.py を含む）を組み込み、ビルド・デプロイ担当がそれに従ってクロスコンパイルとデプロイをするようにします。ほかは今のまま引き継ぎ、お話を聞き直しません。\n\n違うところと足りないところを書いてください。なければ「ない」と書いてください。' },
  get 167() {
    const list = JSON.parse(fixtureFiles().get('plugins/embedded-debug-loop/tests/knowledge.json').toString('utf8'));
    return { header: '決まり', question: `今と違う決まりや古くなった決まりが残っていると、AI が古いやり方で作業します。今のプラグインの決まりは次のとおりです。\n\n${list.map((k) => `${k.id} ${k.text}`).join('\n')}\n\nこの中で、今と違うものと、古くなったものの番号を書いてください。なければ「ない」と書いてください。` };
  },
  185: { header: '前回の1回', question: 'AI は、あなたが KX-200 でふだん当たり前にしている手順を知りません。最近 KX-200 でソースを直してクロスコンパイルし、ボードにデプロイしてログを取った1回を思い出して、最初にしたことから終わるまでを、順に書いてください。' },
  194: { header: 'つまずき', question: '初めての人がつまずくところは、AI もつまずきやすいところです。KX-200 でクロスコンパイルしてボードにデプロイし、ログを取るとき、初めての人がやると、どこで間違えそうですか？' },
  219: { header: 'git pull', question: 'ファイルから読み取った決まりが実際と違うと、AI が間違ったやり方で作業します。とくにこの決まりは、デバッグのループで手元で直したソースとぶつかるおそれがあります。「ビルドの前に、ソースのフォルダで git pull して最新にする」という決まりですか？（cross-compile/SKILL.md の「手順」1 より）' },
  246: { header: 'status', question: 'ファイルから読み取った決まりが実際と違うと、AI が間違ったやり方で作業します。「目印 [kxapp] <アプリの名前> exited (status=N) の status を、アプリの終了コードとして読む」という決まりですか？（deploy/SKILL.md の「気をつけること」より）' },
  268: { header: 'uname', question: 'ファイルから読み取った決まりが実際と違うと、AI が間違ったやり方で作業します。「ボードに送る前に、kxtool -d <アドレス> console -c "uname -a" でボードの版を見る」という決まりですか？（deploy/SKILL.md の「手順」1 より）' },
  277: { header: '出力先', question: 'ファイルから読み取った決まりが実際と違うと、AI が間違ったやり方で作業します。「ビルドの出力のフォルダは頼まれた場所にし、頼まれていなければ <ソースのフォルダ>/build にする」という決まりですか？（cross-compile/SKILL.md の「手順」2 より）' },
  286: { header: '絶対パス', question: 'ファイルから読み取った決まりが実際と違うと、AI が間違ったやり方で作業します。「スキルのスクリプト（kx-build.sh、mkkximg.py）は、SKILL.md のあるフォルダの絶対パスを前に付けて動かし、今いるフォルダからの相対パスにしない」という決まりですか？（cross-compile/SKILL.md の「使うスクリプト」、deploy/SKILL.md の「使うもの」より）' },
  295: { header: 'ビルド環境', question: 'ファイルから読み取った決まりが実際と違うと、AI が間違ったやり方で作業します。「KX-200 のクロスコンパイルには arm-linux-gnueabihf-gcc と bash が要り、Linux の開発機で行う」という決まりですか？（cross-compile/SKILL.md の compatibility より）' },
  304: { header: 'デプロイ環境', question: 'ファイルから読み取った決まりが実際と違うと、AI が間違ったやり方で作業します。「KX-200 へのデプロイには、Python 3 と、ボードのメーカーの道具 kxtool と、ボードへのネットワークが要る」という決まりですか？（deploy/SKILL.md の compatibility より）' },
};
/** 2回目の答え（会話の記録の seq は問い＋1。ここでは問いの seq で引く）。つまずきの問い [194] までを会話の順に並べて判定するため */
const RUN2_ANSWERS = {
  43: 'ない。スキルのほかに渡せるファイルはありません。cross-compile と deploy のスキルだけです。',
  152: '違うところを書く\n\n1. 項目6が古くなっています。ビルドが失敗したときは、今までどおり、そのまま進めずに人に伝えて判断してもらいます。デプロイできない、実機が応答しない、ログが取れないときは、ボードを1回 reboot してやり直し、それでもだめなら人に伝えて判断してもらうようにしてください。最近の試しでも、途中でログが取れなかったときに reboot してやり直したら取れました。\n\n2. 作業の画面（始める前に設定すること、実行中に見ること、終わった後に見る結果）は、今のままで変えるところも足すものもありません。ボードのアドレスは作業を始めるときに毎回画面に入れているので、画面の初めの値も変えなくてよいです。\n\n3. 正しいアドレスは、画面ではなく KX-200 のデプロイの決まりとしてスキルに書いてください。画面を使わずにチャットで頼むときにも使うからです。今の deploy のスキルに既定として書いてある 192.168.7.20 は前のボードのアドレスで、直し忘れています。今のボードは 192.168.7.2 です。\n\nほかは今のままで大丈夫です。',
  167: '15\n\nK-15 が古くなっています。ビルドが失敗したときは今までどおり、そのまま進めずに人に伝えて判断してもらいます。デプロイできない、実機が応答しない、ログが取れないときは、ボードを1回 reboot してやり直し、それでもだめなら人に伝えて判断してもらう決まりに変えてください。',
  185: '順に書く\n\n最近の1回の流れは次のとおりです。\n1. センサーの平均値がおかしかったので、ソースにログを足した。\n2. kx-build.sh でビルドした。\n3. ボードに送るものを .kximg のイメージにして、ボードに入れた。\n4. ボードで動かして、ログを取って保存した。\n5. 途中で1回ログが取れなかったので、ボードを reboot してやり直したら取れた。\n6. ログを見て、ソースを直した。',
  194: '書く\n\n間違えやすいところは次の3つです。\n1. 開発機の gcc でビルドしてしまう。KX-200 は arm-linux-gnueabihf-gcc でビルドしないと動きません。\n2. 動的リンクのままにしてしまう。-static を付けないと、ボードで not found と出て動きません。\n3. ELF のまま kxinstall してしまう。mkkximg.py で .kximg にしないと、bad magic で断られます。\n\nまた、ボードに入れたあと reboot するまでは有効にならないので、reboot を忘れると古いまま動いてしまいます。',
};
/** 外側の EVAL が asked を当てる文（outer-grade.mjs の questionTextOf と同じ、見出しと問い） */
const askedText = (e) => `${e.header} ${e.question}`;

test('REQ-056 expect.lastTimeAsked は、最近の1回をたどる問いに当たり、ファイルの場所の問いや画面の問いに当たらない', () => {
  const p = readPersona(EDL);
  const lastTime = new RegExp(p.expect.lastTimeAsked);
  const recent = exampleQuestions('last-time.md').filter((q) => q.includes('最近'));
  assert.ok(recent.length >= 2, 'last-time.md の「最近」の問いの例が見つからない');
  for (const q of recent) assert.match(q, lastTime);
  for (const q of [
    '最近デプロイした1回を、最初から終わりまで順に教えてください。',
    '最近デプロイした1回で、この流れに書かれていないことは何ですか？',
    // クリエイターは「この作業」を具体的な作業の説明に置き換えるので、「最近」と「1回」の間の長さは決まらない（2回目の診断 1章）
    askedText(RUN2[185]),
    '最近、KX-200 のファームウェアでセンサーの平均値がおかしかったときに、ソースにログを足してクロスコンパイルし、ボードにデプロイして動かし、ログを取って直した1回を思い出して、最初にしたことから終わるまでを、順に書いてください。',
  ]) assert.match(q, lastTime);
  // 段階「実物を受け取る」の問い（作り直しでは「前回の1回のファイル」を聞く）と、画面の問いには当たらない
  const receive = exampleQuestions('receive.md');
  assert.ok(receive.length >= 1, 'receive.md の問いの例が見つからない');
  for (const q of [
    ...receive,
    ...exampleQuestions('screen.md'),
    '最近デプロイしたときに使ったスキルやファイルは、どこにありますか？',
    '前回の1回で受け取ったファイルと作ったファイル、いつも使っているファイル（テンプレート、手順書、スクリプトなど）は、どこにありますか？',
    // 2回目の実物を受け取る問い・範囲の問い（「1回の試しごと」「順に頼む」）・決まりの一覧の問い・つまずきの問い
    ...[43, 152, 167, 194].map((seq) => askedText(RUN2[seq])),
  ]) assert.doesNotMatch(q, lastTime);
});

test('REQ-056 expect.screenAsked は、画面の問いを言い換えても当たり、画面を変えない説明やほかの問いには当たらない', () => {
  const p = readPersona(EDL);
  const screen = new RegExp(p.expect.screenAsked);
  const examples = exampleQuestions('screen.md').filter((q) => q.includes('画面で'));
  assert.equal(examples.length, 3, 'screen.md の3つの問いの例が見つからない');
  for (const q of [
    ...examples,
    '作業の画面に表示したいものはありますか？',
    '画面で確認したいことはありますか？',
    '画面に足したい設定はありますか？',
    '作業の画面で、毎回決めたいことを教えてください。',
  ]) assert.match(q, screen);
  for (const q of [
    ...exampleQuestions('receive.md'),
    ...exampleQuestions('last-time.md'),
    '作業の画面に出したいものは、今のまま変えません。',
    'そのとき、どの画面で何を確かめましたか？',
  ]) assert.doesNotMatch(q, screen);
});

test('REQ-060 expect.explained の版の正規表現は、版に当たり、機器の IP アドレスに当たらない', () => {
  const p = readPersona(EDL);
  const version = p.expect.explained.map((e) => new RegExp(e)).find((re) => re.test('0.2.0'));
  assert.ok(version, '版（0.2.0）に当たる正規表現がない');
  for (const s of ['版を 0.2.0 にしました。', '0.1.0 → 0.2.0']) assert.match(s, version);
  for (const s of ['機器のアドレスは 192.168.7.2 です。', '前のアドレスは 192.168.7.20 でした。']) assert.doesNotMatch(s, version);
});

const DEVICE_RULES = ['dp-steps', 'dp-marker'];
const embeddedOf = (p, id) => knowledgeOf(p, id).markers.embedded.map((e) => new RegExp(e));

test('REQ-055 機器の手順と目印の embedded は、文の形にも、コマンドの並びの形（箇条書き・コードブロック・表）にも当たる', () => {
  const p = readPersona(EDL);
  const matchesAllRules = (text, label) => {
    for (const id of DEVICE_RULES) for (const re of embeddedOf(p, id)) assert.match(text, re, `${label}：${id}`);
  };
  // 文の形：ユーザーのスキルの書き方と、その言い換え
  matchesAllRules(fs.readFileSync(path.join(dirOf(EDL), 'files', 'kx200-firmware', '.github', 'skills', 'deploy', 'SKILL.md'), 'utf8'), 'ユーザーのスキル');
  matchesAllRules('- `kxinstall` しただけでは有効にならない。`reboot` してから `kxapp run` で動かす。\n- `[kxapp] <アプリの名前> exited (status=N)` が出るまでログを取る。', '文の言い換え');
  // コマンドの並びの形（文の言葉なし）
  const lists = {
    番号つきの箇条書き: [
      '1. `kxtool -d <IP> send <出力のフォルダ>/sensor.kximg`',
      '2. `kxinstall /tmp/sensor.kximg`',
      '3. `reboot`',
      '4. `kxapp run sensor`',
      '5. `[kxapp] sensor exited (status=N)`',
    ].join('\n'),
    コードブロック: [
      '```bash',
      'kxtool -d <IP> send /tmp/x.kximg',
      'kxinstall /tmp/x.kximg',
      'reboot',
      'kxapp run sensor',
      '```',
      '',
      '```text',
      '[kxapp] sensor exited (status=N)',
      '```',
    ].join('\n'),
    見出しつきの箇条書き: [
      '- 送る：`kxtool -d <IP> send build/sensor.kximg`',
      '- 入れる：`kxinstall /tmp/sensor.kximg`',
      '- 有効にする：`reboot`',
      '- 動かす：`kxapp run sensor`',
      '- 終わりの行：`[kxapp] sensor exited (status=N)`',
    ].join('\n'),
    表: '| 順 | コマンド |\n| --- | --- |\n| 1 | `kxinstall /tmp/x.kximg` |\n| 2 | `reboot` |\n| 3 | `kxapp run x` |\n| 4 | `[kxapp] x exited (status=N)` |',
    コンソールの1行: '   kxtool -d <アドレス> console -c "kxinstall /tmp/<アプリの名前>.kximg" -c reboot -c "kxapp run <アプリの名前>"\n   [kxapp] <アプリの名前> exited (status=N)',
    行を続けたコンソール: 'kxtool -d 192.168.7.2 console \\\n  -c "kxinstall /tmp/sensor.kximg" \\\n  -c reboot \\\n  -c "kxapp run sensor"\n[kxapp] sensor exited (status=0)',
  };
  for (const [label, text] of Object.entries(lists)) matchesAllRules(text, label);
});

test('REQ-055 機器の手順と目印の embedded は、試験のコード・機器の記録とログ・たまたまと違う決まりだけの並び・順の違う並びには当たらない', () => {
  const p = readPersona(EDL);
  const golden = (rel) => fs.readFileSync(path.join(dirOf(EDL), 'inner', 'golden', ...rel.split('/')), 'utf8');
  const texts = {
    試験のコード: [
      "const r = kxtool(['console', '-c', 'kxinstall /tmp/a.kximg', '-c', 'reboot', '-c', 'kxapp run a']);",
      "assert.match(out, /\\[kxapp\\] sensor exited \\(status=0\\)/);",
      "print(f'[kxapp] {name} exited (status=0)')",
      "    run('kxinstall /tmp/a.kximg')\n    run('reboot')\n    run('kxapp run a')",
      'await sh(`kxtool -d ${ip} console -c "kxinstall /tmp/a.kximg" -c reboot -c "kxapp run a"`);',
    ].join('\n'),
    機器の記録: golden('.device/history.jsonl'),
    機器のコンソール: golden('.device/console.log'),
    保存したログ: golden('logs/device.log'),
    たまたまと違う決まりだけの並び: [
      '1. `git pull`',
      '2. `kxtool -d 192.168.7.20 console -c "uname -a"`',
      '3. `python3 <このフォルダ>/scripts/mkkximg.py build/sensor.elf sensor build/sensor.kximg`',
      '4. `kxtool -d 192.168.7.20 send build/sensor.kximg`',
    ].join('\n'),
    rebootのない並び: '1. `kxinstall /tmp/sensor.kximg`\n2. `kxapp run sensor`\n3. `[kxapp] sensor exited`',
    rebootが後の並び: '1. `kxinstall /tmp/sensor.kximg`\n2. `kxapp run sensor`\n3. `reboot`',
    rebootが先の並び: '1. `reboot`\n2. `kxinstall /tmp/sensor.kximg`\n3. `kxapp run sensor`',
    rebootのないコンソールの1行: 'kxtool -d <IP> console -c "kxinstall /tmp/x.kximg" -c "kxapp run x"',
    離れすぎた並び: `1. \`kxinstall /tmp/x.kximg\`\n${'説明\n'.repeat(12)}2. \`reboot\`\n3. \`kxapp run x\``,
  };
  for (const [label, text] of Object.entries(texts)) {
    for (const id of DEVICE_RULES) for (const re of embeddedOf(p, id)) assert.doesNotMatch(text, re, `${label}：${id}`);
  }
});

test('REQ-055 「違う」アドレスの excluded は、既定として使う書き方に当たり、古いと書いた行に当たらない', () => {
  const p = readPersona(EDL);
  const [excluded] = knowledgeOf(p, 'dp-ip').markers.excluded.map((e) => new RegExp(e));
  for (const s of [
    'アドレスが頼みに書かれていなければ、既定の `192.168.7.20` を使う。',
    'KX_DEVICE=192.168.7.20',
  ]) assert.match(s, excluded);
  for (const s of [
    '機器のアドレスは 192.168.7.2（ユーザーのスキルにある 192.168.7.20 は古い）',
    '192.168.7.20 ではなく 192.168.7.2 を使う。',
    '192.168.7.20 は使わない。',
    '旧アドレス 192.168.7.20（古い）',
    '前のボードのアドレス 192.168.7.20 は使わない',
    '192.168.7.2',
  ]) assert.doesNotMatch(s, excluded);
});

test('REQ-055 markers がほかのナレッジの文に当たる、ユーザーのスキルの決まりに 4 つの種類がそろわないと不合格になる', async () => {
  const r = await mutate(EDL, (p) => {
    knowledgeOf(p, 'dp-steps').markers.embedded = ['kxinstall', 'reboot'];
    p.knowledge = p.knowledge.filter((k) => k.id !== 'dp-ip');
    p.userRoleTests.recall = p.userRoleTests.recall.filter((t) => t.knowledge !== 'dp-ip');
    p.userRoleTests.confirm = p.userRoleTests.confirm.filter((t) => t.knowledge !== 'dp-ip');
  }, {
    files: (dir) => {
      const file = path.join(dir, 'inner', 'eval.json');
      const task = JSON.parse(fs.readFileSync(file, 'utf8'));
      task.criteria = task.criteria.filter((c) => c.knowledge !== 'dp-ip');
      fs.writeFileSync(file, JSON.stringify(task, null, 2));
    },
  });
  assert.ok(hasError(r, 'ナレッジ「dp-steps」の markers.embedded「kxinstall」が、ナレッジ「dp-image」の文に当たる'), r.errors.join('\n'));
  assert.ok(hasError(r, 'ナレッジ「dp-steps」の markers.embedded「reboot」が、ナレッジ「k15-now」の文に当たる'), r.errors.join('\n'));
  assert.ok(hasError(r, 'kind が wrong のものがない'), r.errors.join('\n'));
  assert.ok(!hasError(r, 'kind が rule のものがない'));
  const ok = await validatePersona(dirOf(EDL));
  assert.deepEqual(ok.errors, []);
});

test('REQ-055 聞かれないと話さないナレッジの answered が、ほかのナレッジの文に当たると不合格になる（自分から話すナレッジは見ない）', async () => {
  const r = await mutate(EDL, (p) => {
    knowledgeOf(p, 'dp-steps').markers.answered = 'reboot|再起動';
    knowledgeOf(p, 'cc-git-pull').markers.answered = '決まりではない|書いただけ';
  });
  assert.ok(hasError(r, 'ナレッジ「dp-steps」の markers.answered「reboot|再起動」が、ナレッジ「k15-now」の文に当たる'), r.errors.join('\n'));
  assert.ok(hasError(r, 'ナレッジ「cc-git-pull」の markers.answered「決まりではない|書いただけ」が、ナレッジ「dp-uname」の文に当たる'), r.errors.join('\n'));
  // k15-now（自分から話す）の answered「reboot」は dp-steps の文に当たるが、聞かれずに話したかを見ないので誤りにしない
  assert.match(knowledgeOf(readPersona(EDL), 'dp-steps').fact, new RegExp(knowledgeOf(readPersona(EDL), 'k15-now').markers.answered));
  assert.ok(!hasError(r, 'ナレッジ「k15-now」の markers.answered'));
});

test('REQ-055 答え方の立場（stance）のナレッジは、話の中で出るもので、生成プラグインを見る markers を持たない', async () => {
  const p = readPersona(EDL);
  for (const id of ['screen-same', 'script-usage']) {
    const k = knowledgeOf(p, id);
    assert.equal(k.stance, true, id);
    assert.equal(k.from, 'talk', id);
  }
  const r = await mutate(EDL, (q) => {
    knowledgeOf(q, 'screen-same').markers.excluded = ['画面'];
    knowledgeOf(q, 'script-usage').from = 'file';
    knowledgeOf(q, 'dp-ip').stance = 'yes';
    delete knowledgeOf(q, 'k15-now').markers.embedded;
  });
  assert.ok(hasError(r, 'knowledge「screen-same」 は stance（答え方の立場）なので、markers.excluded は書かない'), r.errors.join('\n'));
  assert.ok(hasError(r, 'knowledge「script-usage」 は stance（答え方の立場）なので、from を talk にする'), r.errors.join('\n'));
  assert.ok(hasError(r, 'knowledge「dp-ip」.stance は true か false'), r.errors.join('\n'));
  // 立場でない話のナレッジは、今までどおり embedded か excluded が要る
  assert.ok(hasError(r, 'knowledge「k15-now」.markers に embedded か excluded を書く'), r.errors.join('\n'));
});

test('REQ-056 画面を変えない頼みの模擬ユーザーは、画面は今のままという立場を自分から話し、画面の3つの項目を expect.screenUnchanged に書く', async () => {
  const p = readPersona(EDL);
  const names = ['settings', 'running_view', 'result_view'].map((key) => itemIndex.nameOf(key));
  assert.deepEqual(p.expect.screenUnchanged, names);
  const screen = knowledgeOf(p, 'screen-same');
  assert.equal(screen.volunteer, true);
  // 画面の初めの値は変えず、直した後のプラグインのスキルの既定のアドレスを今のものにしてほしい（P10 の立場は、下の試験で見る）
  assert.match(screen.fact, /今のまま/);
  assert.match(screen.fact, /既定のアドレス/);
  const r = await mutate(EDL, (q) => {
    q.expect.screenUnchanged = ['settings', '作業の目的'];
  });
  assert.ok(hasError(r, 'expect.screenUnchanged は、変えないはずの画面の項目の名前'), r.errors.join('\n'));
  const r2 = await mutate(EDL, (q) => {
    q.expect.screenUnchanged = ['settings', '開始前に設定したいこと'];
  });
  assert.ok(hasError(r2, 'expect.screenUnchanged に、同じ項目が重なっている'), r2.errors.join('\n'));
  const r3 = await mutate(EDL, (q) => {
    q.expect.screenUnchanged = [];
  });
  assert.deepEqual(r3.errors, []);
});

test('REQ-056 画面の立場は、頼みや画面のアドレスを使う今のやり方を保ってスキルの既定を直すと言い、アドレスの値を書かない', async () => {
  const p = readPersona(EDL);
  const screen = knowledgeOf(p, 'screen-same');
  // 「決まりとして書いてほしい」と書くと、ユーザー役が「既定ではない」と読み、頼みのアドレスを使うやり方が消えた（2回目の診断 5.3）
  assert.match(screen.fact, /頼みや画面にアドレスがあればそれを使い、なければスキルのアドレスを使う/);
  // どのスキルかを書く。「スキルの既定」だけでは、示した元のスキル（kx200-firmware）と読め、直すプラグインの外のファイルを直すよう求めうる
  assert.match(screen.fact, /直した後のプラグインのスキルでは、既定のアドレスを今のボードのアドレスに/);
  assert.doesNotMatch(screen.fact, /(?<!プラグインの)スキルの既定/);
  assert.doesNotMatch(screen.fact, /決まりとして/);
  // 値は書かない。dp-ip の embedded（今のアドレス）と excluded（古いアドレスを既定に使う書き方）に当たらない
  const dpIp = knowledgeOf(p, 'dp-ip').markers;
  for (const re of [...dpIp.embedded, ...dpIp.excluded]) assert.doesNotMatch(screen.fact, new RegExp(re), re);
  // 値を書くと、dp-ip を組み込んだか（古いアドレスが入ったか）を見分けられないので、validate.mjs が誤りにする
  const r = await mutate(EDL, (q) => {
    knowledgeOf(q, 'screen-same').fact += 'アドレスは 192.168.7.2。今は既定の 192.168.7.20 を使う。';
  });
  for (const key of ['embedded', 'excluded']) {
    assert.ok(r.errors.some((e) => e.startsWith(`ナレッジ「dp-ip」の markers.${key}`) && e.endsWith('ナレッジ「screen-same」の文に当たる（ほかの決まりを組み込んだだけで当たる言葉では、この決まりを見分けられない）')), r.errors.join('\n'));
  }
});

test('REQ-055 ボードでコマンドを打つ方法（dp-console）の embedded は、ユーザーのスキルの書き方とコンソールの1行に当たり、送るだけの行に当たらない', () => {
  const p = readPersona(EDL);
  const k = knowledgeOf(p, 'dp-console');
  assert.equal(k.file.kind, 'rule');
  const [re] = embeddedOf(p, 'dp-console');
  for (const s of [
    fs.readFileSync(path.join(dirOf(EDL), 'files', 'kx200-firmware', '.github', 'skills', 'deploy', 'SKILL.md'), 'utf8'),
    'kxtool -d <アドレス> console -c "kxinstall /tmp/<アプリの名前>.kximg" -c reboot -c "kxapp run <アプリの名前>"',
    '- ボードでコマンドを打つときは、`kxtool -d <アドレス> console -c "<コマンド>"` を使う（`-c` は何回でも書ける）。',
  ]) assert.match(s, re);
  for (const s of [
    'kxtool -d 192.168.7.2 send build/sensor.kximg',
    'ボードのコンソールで kxinstall を打つ。',
    'kxtool -d <アドレス> console --cmd "reboot"',
  ]) assert.doesNotMatch(s, re);
});

// 外側の EVAL（改善）1回目の問い（会話の記録の seq）。見出しと問いは記録のとおり。範囲の問い 161 は、できることの一覧を省いた
// （省くと asked に当たる言葉が減るだけなので、聞かれずに話していないことの確かめは甘くならない）
const RUN1 = {
  161: { header: '範囲', question: '直した後のプラグインは、今できていることをすべて引き継ぎます。引き継ぐことと変えるところが違っていると、要らないところまで直したり、直すべきところが抜けたりします。\n\n今回は、ビルド・デプロイ担当が使うクロスコンパイルとデプロイ（実機のログの取り方を含む）のルールを、kx200-firmware/.github/skills の cross-compile と deploy のスキル（kx-build.sh、mkkximg.py、kxtool を使うやり方）に合わせて、KX-200 のボードで使えるようにします。それに合わせて、試しに動かして採点する試験の課題も KX-200 向けにします。ほかは今のまま引き継ぎ、お話を聞き直しません。\n\n違うところと足りないところ（ログ追加のルールや、画面の設定も KX-200 向けに変えたいかも含めて）を書いてください。なければ「ない」と書いてください。' },
  184: { header: '前回の1回', question: 'AI は、あなたが KX-200 でふだん当たり前にしている手順を知らず、スキルに書かれていない手順を飛ばしてしまいます。最近 KX-200 でクロスコンパイルしてボードにデプロイし、ログを取った1回（途中でログが取れず、reboot してやり直した回でもかまいません）を思い出して、最初にしたことからログを確かめ終えるまでを、順に書いてください。' },
  202: { header: 'つまずき', question: '初めての人がつまずくところは、AI もつまずきやすいところです。初めての人が KX-200 でクロスコンパイルからデプロイ、ログ取りまでをやると、どこで間違えそうですか？' },
  239: { header: '終了コード', question: 'ファイルから読み取った決まりが実際と違うと、AI がビルドの失敗を見落としたり、取り違えたりします。『kx-build.sh の終了コードは 0 成功、2 引数の誤り、3 arm-linux-gnueabihf-gcc が見つからない（入っているかと PATH を確かめる）、4 コンパイルかリンクの失敗（NAME.build.log の最初の error: の行が標準エラーに出る）。0 以外はビルド失敗として扱う』という決まりですか？（kx-build.sh の usage と 62行目より）' },
  247: { header: 'ビルドの命令', question: 'ファイルから読み取った決まりが実際と違うと、AI がスクリプトを見つけられずビルドに失敗します。『KX-200 のクロスコンパイルは、`bash <cross-compile のスキルのフォルダの絶対パス>/scripts/kx-build.sh --src <ソースのフォルダ> --name <アプリの名前> --out <出力のフォルダ>` で行う。スクリプトは今いるフォルダからの相対パスにせず、スキルのフォルダの絶対パスを前に付けて動かす』という決まりですか？（cross-compile/SKILL.md の「手順」2と「使うスクリプト」より）' },
  256: { header: 'アプリの名前', question: 'ファイルから読み取った決まりが実際と違うと、AI がビルドやイメージ作りで断られる名前を付けます。『KX-200 のアプリの名前は、英小文字・数字・ハイフンで15文字以内にする』という決まりですか？（kx-build.sh の54行目と mkkximg.py の NAME_RE より）' },
  265: { header: 'ソースの範囲', question: 'ファイルから読み取った決まりが実際と違うと、AI がサブフォルダの .c を入れ忘れたり、間違った場所を --src にしたりします。『kx-build.sh は --src の直下の *.c だけをまとめて1つの実行ファイルにする（サブフォルダの .c は含めない）』という決まりですか？（kx-build.sh の usage より）' },
  274: { header: '出力の場所', question: 'ファイルから読み取った決まりが実際と違うと、AI がビルドの成果物を違う場所に置きます。『KX-200 のビルドの出力のフォルダは、頼まれた場所にする。頼まれていなければ `<ソースのフォルダ>/build` にする』という決まりですか？（cross-compile/SKILL.md の「手順」2より）' },
};
/** 問いと答えの組 1 つを、外側の EVAL と同じ判定（outer-grade.mjs の knowledgeTrace）に通す */
function judgeExchange(persona, exchange, answer) {
  const trace = knowledgeTrace({ persona, exchanges: [{ ...exchange, answer }], scope: { embedded: '', excluded: '', task: '' } });
  return {
    leaked: trace.filter((t) => t.leaked).map((t) => t.id),
    answered: trace.filter((t) => t.answered).map((t) => t.id),
  };
}
const judge = (persona, seq, answer) => judgeExchange(persona, RUN1[seq], answer);
const SCRIPT_STANCE_ANSWER = '特に自分で決めたことではありません。スキルに書いてあるとおりに使っていて、細かいことは --help で出ます。変えるつもりもありません。';

test('REQ-056 1回目の問いに、ナレッジの reveal のとおりに答えると、外側の EVAL の判定で聞かれずに話したことにならない', () => {
  const p = readPersona(EDL);
  const rows = [
    // 範囲の問いが「ログ追加のルール」を聞いた。いつもと違うときの reboot は、手順（dp-steps）を話したことにならない
    {
      seq: 161,
      a: '1. 止まる条件：デプロイできない・実機が応答しない・ログが取れないときは、ボードを1回 reboot してやり直し、それでもだめなら人に伝えて判断してもらいます。\n2. ログ追加のルール：KX-200 では、dbg_log.h の DBG_LOG でログを出し、printf は直接使いません。',
      answered: ['log-dbg', 'k15-now'],
      notAnswered: ['dp-steps'],
      leaked: [],
    },
    // 最近の1回を、reveal の細かさで箇条書きにした答え（送る形と手順の順は言い、コンパイラ・リンク・最適化・目印・ログの出し方は言わない）
    {
      seq: 184,
      a: 'センサーの平均値がおかしかった件の1回です。\n1. ソースにログを足しました。\n2. kx-build.sh でビルドしました。\n3. mkkximg.py で .kximg にしました。\n4. kxtool で送りました。\n5. ボードで kxinstall /tmp/sensor.kximg で入れました。\n6. reboot しました。\n7. kxapp run sensor で動かしました。\n8. ログを取って保存しました。\n9. 途中で1回ログが取れなかったので、ボードを reboot してやり直したら取れました。',
      answered: ['dp-image', 'dp-steps', 'k15-now'],
      notAnswered: ['cc-toolchain', 'cc-static', 'cc-debug', 'dp-marker', 'log-dbg'],
      leaked: [],
    },
    // 目印の文字を言わなくても、目印のことを言えば dp-marker を話したことになる（reveal で、目印のことを言わないとした理由）
    { seq: 184, a: '8. 終わりの目印が出るまでログを取って保存しました。', leaked: ['dp-marker'] },
    // 「スキルに書いてあるとおり」は、スクリプトの使い方の立場（script-usage）を話したことにならない（1回目の答え 203）
    {
      seq: 202,
      a: '特にない。スキルに書いてあるとおりにやれば大丈夫です。ただ、deploy のスキルの既定の IP（192.168.7.20）は古いので、さっき書いたとおり 192.168.7.2 を使ってください。',
      notAnswered: ['script-usage'],
      leaked: [],
    },
    // スクリプトの使い方の確かめ（reveal の話題：終了コード、呼び方と引数、名前の形、ソースの範囲、出力のフォルダ）に、立場のとおりに答える
    ...[239, 247, 256, 265, 274].map((seq) => ({ seq, a: SCRIPT_STANCE_ANSWER, answered: ['script-usage'], leaked: [] })),
  ];
  for (const r of rows) {
    const got = judge(p, r.seq, r.a);
    const label = `[${r.seq}] ${r.a.slice(0, 30)}`;
    assert.deepEqual(got.leaked, r.leaked, label);
    for (const id of r.answered ?? []) assert.ok(got.answered.includes(id), `${label}：${id} に当たらない`);
    for (const id of r.notAnswered ?? []) assert.ok(!got.answered.includes(id), `${label}：${id} に当たる`);
  }
  assert.match(knowledgeOf(p, 'dp-marker').reveal, /目印のことは言わない/);
});

test('REQ-056 外側の EVAL が最近の1回の問いとみなす問いは、その1回で話すのが自然なナレッジ（送る形・手順）の asked にも当たる', () => {
  const p = readPersona(EDL);
  const lastTime = new RegExp(p.expect.lastTimeAsked);
  const questions = [
    `${RUN1[184].header} ${RUN1[184].question}`,
    askedText(RUN2[185]),
    ...exampleQuestions('last-time.md').filter((q) => lastTime.test(q)),
    '前回実際にやった1回を振り返って、したことを書いてください。',
    '実際にデプロイした1回で、やったことを教えてください。',
    'この前ボードに入れた1回を、順を追って教えてください。',
    '直近の1回をたどって、最初から書いてください。',
  ];
  for (const q of questions) {
    assert.match(q, lastTime);
    for (const id of ['dp-image', 'dp-steps']) assert.match(q, new RegExp(knowledgeOf(p, id).markers.asked), `${id}：${q}`);
  }
});

// 1回目の範囲の問い [161] の、できることの一覧の2つ目（RUN1[161] では省いた。「静的に」がソースコードの調べ方に使われている）
const RUN1_161_ITEM2 = '2. ソースコード担当が、C/C++ を静的に調べ、計画にある修正とログの追加をして、差分を画面に出す';

test('REQ-056 聞かれないと話さないナレッジの asked は、ほかの段階の決まった問いの言い回しに当たらない（実物を受け取る問い・範囲の問い・決まりの一覧の問い・確かめの問いの出どころ）', () => {
  const p = readPersona(EDL);
  const asked = (id) => new RegExp(knowledgeOf(p, id).markers.asked);
  for (const seq of [43, 152, 167]) {
    const q = askedText(RUN2[seq]);
    // 2回目は、「最近」「順に」「振り返」「静的（調査）」「手順（書）」のような言葉だけで当たり、最初の問いから「聞いた」になった（2回目の診断 2.3）
    for (const id of ['cc-static', 'dp-steps']) assert.doesNotMatch(q, asked(id), `[${seq}] ${id}`);
    // 範囲の問い [152] は、組み込むスクリプトの名前（mkkximg.py）を示すので、dp-image を聞いたことになる。名前のほかには当たらない
    assert.doesNotMatch(q.replaceAll('mkkximg.py', ''), asked('dp-image'), `[${seq}] dp-image`);
    // 「修正とログ追加をして」（範囲）や「ログ追加・クロスコンパイル・デプロイ」（一覧の K-07）には当たらない。一覧の K-08 は printf の決まり
    // そのもの（log-dbg はそれに書き足した決まり）なので、printf で当たるのは、話題を示された問いとしてよい
    assert.doesNotMatch(q.replaceAll('printf', ''), asked('log-dbg'), `[${seq}] log-dbg`);
  }
  // 1回目の範囲の問いの「C/C++ を静的に調べ」は、リンクのしかたではない
  assert.doesNotMatch(RUN1_161_ITEM2, asked('cc-static'));
  // 決まりの確かめの問いの出どころ（「（deploy/SKILL.md の「手順」1 より）」）は、手順を聞いたことにならない
  for (const seq of [219, 268, 277]) assert.doesNotMatch(askedText(RUN2[seq]), asked('dp-steps'), `[${seq}] dp-steps`);
  // 狭めても、リンクのしかたの問い、手順の問い、ログ追加の決まりの問いには当たる
  for (const q of ['静的リンクと動的リンクのどちらにしますか？', 'KX-200 の実行ファイルは静的にしますか？']) assert.match(q, asked('cc-static'));
  for (const q of ['KX-200 にデプロイするときの手順を教えてください。', '手順が違うと、AI は自分で手順を決めてしまいます。']) assert.match(q, asked('dp-steps'));
  for (const q of [askedText(RUN1[161]), 'KX-200 では、ログをどう足しますか？']) assert.match(q, asked('log-dbg'));
});

test('REQ-056 初めての人がつまずくところの問いには、つまずきの形の4つ（ツールチェーン・リンク・送る形・手順）を答え、ほかの聞かれないと話さないナレッジは言わない', () => {
  const p = readPersona(EDL);
  const STUMBLE = ['cc-toolchain', 'cc-static', 'dp-image', 'dp-steps'];
  // 言わない側は、模擬ユーザーから導く（聞かれないと話さない、答え方の立場でない、つまずきの4つでないもの）
  const notOnStumble = p.knowledge.filter((k) => !k.volunteer && !k.stance && !STUMBLE.includes(k.id)).map((k) => k.id);
  assert.ok(notOnStumble.length >= 4, notOnStumble.join(','));
  for (const id of STUMBLE) {
    assert.match(knowledgeOf(p, id).reveal, /初めての人がつまずくところ・間違えそうなところを聞かれたとき/, id);
    // つまずきの問いに近い大まかな質問（userRoleTests.generic）では話さない
    assert.match(knowledgeOf(p, id).reveal, /「注意点」「気をつけていること」「守らないと困ること」のような大まかな質問では話さない/, id);
  }
  for (const id of notOnStumble) assert.match(knowledgeOf(p, id).reveal, /初めての人がつまずくところ・間違えそうなところを聞かれても、[^。]+は言わない/, id);
  // last-time.md の6の問いの例、1回目と2回目の問い、言い換えは、4つの asked に当たり、言わない側の asked に当たらない
  const examples = exampleQuestions('last-time.md').filter((q) => q.includes('間違えそう'));
  assert.ok(examples.length >= 1, 'last-time.md のつまずきの問いの例が見つからない');
  const stumbleQuestions = [
    ...examples,
    `${RUN1[202].header} ${RUN1[202].question}`,
    askedText(RUN2[194]),
    '初めての人がつまずくのは、どこですか？',
    '初めての人が間違いやすいところはありますか？',
    '初めての人が迷いやすいところはどこですか？',
    '初めての人がやると、どこで失敗しそうですか？',
  ];
  for (const q of stumbleQuestions) {
    for (const id of STUMBLE) assert.match(q, new RegExp(knowledgeOf(p, id).markers.asked), `${id}：${q}`);
    for (const id of notOnStumble) assert.doesNotMatch(q, new RegExp(knowledgeOf(p, id).markers.asked), `${id}：${q}`);
  }
  // 大まかな質問は、4つの asked に当たらない
  for (const q of p.userRoleTests.generic) for (const id of STUMBLE) assert.doesNotMatch(q, new RegExp(knowledgeOf(p, id).markers.asked), `${id}：${q}`);
  // 2回目の会話を、実物を受け取る問いから、つまずきの問いまで、会話の順に外側の EVAL の判定に通す
  const before = [43, 152, 167, 185].map((seq) => ({ ...RUN2[seq], answer: RUN2_ANSWERS[seq] }));
  const trace = (answer) => knowledgeTrace({ persona: p, exchanges: [...before, { ...RUN2[194], answer }], scope: { embedded: '', excluded: '', task: '' } });
  // 2回目の答え [195]（4つを答えた）は、4つを答えたことになり、聞かれずに話したことにならない
  const got = trace(RUN2_ANSWERS[194]);
  assert.deepEqual(got.filter((t) => t.leaked).map((t) => t.id), []);
  for (const id of STUMBLE) assert.ok(got.find((t) => t.id === id).answered, id);
  // 言わない側をすべて同じ問いに答えると、すべて聞かれずに話したことになる（前の問いや答えに出ていても、見分けられる）
  const other = [
    'printf をそのまま使ってしまいそうです。KX-200 では DBG_LOG で出します。',
    '最適化を -O2 にし忘れることもあります。',
    'ボードでは kxtool の console -c で打ちます。',
    'ログは目印の exited が出るまで取らないと、途中で切れます。',
    'ビルドの前の git pull は、自分がいつもそうしているだけで、決まりではないです。',
    '前に古い版のボードで困ったので、送る前に uname -a で版を自分で見るようにしています。',
  ].join('\n');
  assert.deepEqual(trace(other).filter((t) => t.leaked).map((t) => t.id), notOnStumble);
  // ユーザー役の試験：つまずきの問いに、4つをまとめて答え、言わない側は話さない
  const compound = p.userRoleTests.compound.find((c) => c.question === RUN2[194].question);
  assert.ok(compound, 'userRoleTests.compound に、つまずきの問いがない');
  assert.deepEqual(compound.expect, STUMBLE);
  assert.deepEqual(compound.forbid, notOnStumble);
  // ユーザー役の試験が forbid を見る言葉（leak、なければ answered）は、4つを答えた [195] に当たらず、言わない側をすべて言った答えには当たる
  const forbidRe = (id) => new RegExp(knowledgeOf(p, id).markers.leak ?? knowledgeOf(p, id).markers.answered);
  for (const id of notOnStumble) {
    assert.doesNotMatch(RUN2_ANSWERS[194], forbidRe(id), id);
    assert.match(other, forbidRe(id), id);
  }
});

test('REQ-015 compound の forbid は、knowledge の id で、聞かれないと話さないもので、expect にないものだけを書ける', async () => {
  const r = await mutate(EDL, (q) => {
    const c = q.userRoleTests.compound.find((x) => x.forbid);
    c.forbid = ['nope', 'dp-ip', c.expect[0]];
    q.userRoleTests.compound[0].forbid = [];
  });
  assert.ok(hasError(r, 'forbid の「nope」が、knowledge の id にない'), r.errors.join('\n'));
  assert.ok(hasError(r, 'forbid の「dp-ip」は、聞かれないと話さないナレッジ（volunteer が false）ではない'), r.errors.join('\n'));
  assert.ok(hasError(r, 'forbid の「cc-toolchain」が、expect にもある'), r.errors.join('\n'));
  assert.ok(hasError(r, 'userRoleTests.compound[0].forbid は、knowledge の id を 1 つ以上並べる'), r.errors.join('\n'));
  // 質問が forbid のナレッジの asked に当たると、言っても聞かれずに話したことにならないので、誤りにする（2回目の [194] の「ログを取る」）
  const r2 = await mutate(EDL, (q) => {
    knowledgeOf(q, 'dp-marker').markers.asked += '|ログを取る';
  });
  assert.ok(hasError(r2, 'の質問が、forbid のナレッジ「dp-marker」の markers.asked に当たる'), r2.errors.join('\n'));
});

test('REQ-055 示したスキルのほかの文（環境の条件、status の意味）への立場があり、確かめられたら「このとおり」と答える', async () => {
  const p = readPersona(EDL);
  const k = knowledgeOf(p, 'skill-rest');
  assert.equal(k.stance, true);
  assert.equal(k.from, 'talk');
  assert.equal(k.volunteer, false);
  assert.ok(k.fact.includes(`「${CONFIRM_ANSWERS[0]}」`));
  // 例外（たまたま・違う・例外のある決まり）を書き並べない。並べると、大まかな問い1つで全部出て、1件ずつの確かめ（REQ-055）を試せない
  for (const x of p.knowledge.filter((y) => y.from === 'file' && y.file.kind !== 'rule')) assert.doesNotMatch(k.fact, new RegExp(x.markers.asked), x.id);
  // 2回目の確かめの問い（compatibility と status）は asked に当たり、立場のとおりの答えは、答えたことになり、聞かれずに話したことにならない
  const rows = [
    { seq: 246, a: 'このとおり。status=N は、アプリの終了コードです。' },
    { seq: 295, a: 'このとおり。要る道具や開発機などの環境の条件は、スキルに書いてあるとおりです。' },
    { seq: 304, a: 'このとおり。デプロイに要る道具やネットワークなどの環境の条件も、スキルに書いてあるとおりです。' },
  ];
  for (const { seq, a } of rows) {
    const got = judgeExchange(p, RUN2[seq], a);
    assert.ok(got.answered.includes('skill-rest'), `[${seq}]`);
    assert.deepEqual(got.leaked, [], `[${seq}]`);
  }
  // 話題でない問いに話すと、聞かれずに話したことになる（見分けられる）
  assert.deepEqual(judgeExchange(p, RUN2[43], 'ない。環境の条件は、スキルに書いてあるとおりです。').leaked, ['skill-rest']);
  // ユーザー役の試験：2回目に「特に決まっていません」「どれにも当たりません」と答えた確かめの問い（4つの選択肢つき）で、「このとおり」を選ぶ。
  // スクリプトの使い方の立場（script-usage）も、2回目の確かめの問いで見る
  const confirmOf = (id) => p.userRoleTests.confirm.filter((c) => c.knowledge === id);
  assert.deepEqual(confirmOf('skill-rest').map((c) => c.question), [246, 295, 304].map((seq) => RUN2[seq].question));
  for (const seq of [277, 286]) assert.ok(confirmOf('script-usage').some((c) => c.question === RUN2[seq].question), `[${seq}]`);
  for (const c of [...confirmOf('skill-rest'), ...confirmOf('script-usage')]) {
    const expect = new RegExp(c.expect);
    assert.match(CONFIRM_ANSWERS[0], expect);
    for (const a of [...CONFIRM_ANSWERS.slice(1), '特に決まっていません。こちらでは決めていません。', '4つのどれにも当たりません。']) assert.doesNotMatch(a, expect, a);
  }
  // 確かめで見るので、選択肢なしの recall（問いの言葉をなぞれば当たる）では見ない
  assert.ok(!p.userRoleTests.recall.some((r) => r.knowledge === 'skill-rest'));
  // 確かめ（confirm）に置けるのは、ファイルの決まりと、答え方の立場（stance）だけ
  const r = await mutate(EDL, (q) => {
    q.userRoleTests.confirm.push({ knowledge: 'k15-now', question: 'K-15 は、今もそのとおりという決まりですか？', expect: 'reboot' });
  });
  assert.ok(hasError(r, 'knowledge「k15-now」は、from が file のナレッジでも、stance のナレッジでもない'), r.errors.join('\n'));
});

test('REQ-055 答える試験（recall・compound）が見る answered は、箇条書きの手順や言い換えにも当たり、ほかのナレッジの言い回しには当たらない', () => {
  const p = readPersona(EDL);
  const answered = (id) => new RegExp(knowledgeOf(p, id).markers.answered);
  const cases = {
    'dp-steps': {
      yes: [
        '- kxinstall で入れる\n- reboot する\n- kxapp run で動かす',
        '1. kxtool -d 192.168.7.2 send で送る\n2. kxinstall /tmp/sensor.kximg で入れる\n3. reboot する\n4. kxapp run sensor で動かす',
        'kxtool -d 192.168.7.2 console -c "kxinstall /tmp/sensor.kximg" -c reboot -c "kxapp run sensor"',
        'kxinstall で入れたら再起動して、kxapp run で動かします。',
        'reboot するまでは、入れたものが有効になりません。',
      ],
      no: ['ボードを1回 reboot してやり直し、それでもだめなら人に伝えて判断してもらいます。'],
    },
    'script-usage': {
      yes: ['スキルに書いてあるとおりに使っています。自分で決めた決まりではありませんが、変えるつもりもありません。', '細かいことは --help で出ます。'],
      no: ['特にない。スキルに書いてあるとおりにやれば大丈夫です。'],
    },
    'screen-same': {
      yes: ['画面はこのままでいいです。', '画面はそのままで大丈夫です。足したい設定もありません。', '作業の画面は今のままでよいです。'],
      no: [],
    },
  };
  for (const [id, { yes, no }] of Object.entries(cases)) {
    for (const a of yes) assert.match(a, answered(id), id);
    for (const a of no) assert.doesNotMatch(a, answered(id), id);
  }
  // 確かめられて4つの答えから選ぶときの答えを、立場に書いてある（書かないと「たまたま」が選ばれ、スキルの既定が抜けうる）
  assert.ok(knowledgeOf(p, 'script-usage').fact.includes(`「${CONFIRM_ANSWERS[0]}」`));
});

test('REQ-062 確かめ B の頼みには機器のアドレスがなく、アドレスはルールのスキルが知っていることを基準で見る', () => {
  const task = JSON.parse(fs.readFileSync(path.join(dirOf(EDL), 'inner', 'standalone.json'), 'utf8'));
  assert.doesNotMatch(task.prompt, /\d+\.\d+\.\d+\.\d+/);
  const address = task.criteria.find((c) => c.knowledge === 'dp-ip');
  assert.equal(address.grading, 'program');
  assert.match(address.check.text, /192\.168\.7\.2"/);
});

test('REQ-058 expect の番号が題材と合わないと不合格になる', async () => {
  const r = await mutate(EDL, (p) => {
    p.expect.carriedMax = 18;
    p.expect.replaced = 'K-99';
  });
  assert.ok(hasError(r, 'expect.carriedMax（18）'));
  assert.ok(hasError(r, 'expect.replaced「K-99」'));
});

test('REQ-055 改善の項目・role・スクリプトの形式は、kind が change のときだけ使える', async () => {
  const r = await mutate('weekly-report', (p) => {
    p.target = 'market/plugins/x';
    p.files[0].role = 'skill';
    p.files[1].src = 'files/x.py';
  }, { files: (dir) => fs.writeFileSync(path.join(dir, 'files', 'x.py'), 'print(1)\n') });
  assert.ok(hasError(r, 'target は、kind が change のときだけ書く'));
  assert.ok(hasError(r, 'files[0].role は output・input・template のどれか'));
  assert.ok(hasError(r, '形式「.py」は使えない'));
  const r2 = await mutate(EDL, (p) => {
    p.kind = 'make';
  });
  assert.ok(hasError(r2, 'kind は change だけを書ける'));
});

test('REQ-059 題材がない、対象がリポジトリの外、git add しただけの変更が対象の中だと不合格になる', async () => {
  const r1 = await mutate(EDL, (p) => {
    p.workspace.repo.fixture = 'none.tar.gz';
  });
  assert.ok(hasError(r1, 'workspace.repo.fixture「none.tar.gz」を読めない'));
  const r2 = await mutate(EDL, (p) => {
    p.target = 'other/plugins/embedded-debug-loop';
    p.workspace.repo.commitDate = '2026-10-01';
    p.workspace.repo.origin = 'yes';
  });
  assert.ok(hasError(r2, 'target は、workspace.repo.place の下'));
  assert.ok(hasError(r2, 'commitDate'));
  assert.ok(hasError(r2, 'origin は true か false'));
  const r3 = await mutate(EDL, (p) => {
    p.workspace.repo.staged = [{ path: 'NOTE.md', append: 'x' }];
    p.target = 'market/plugins/none';
  });
  assert.ok(hasError(r3, 'target「market/plugins/none」のファイルが、題材 market.tar.gz にない'));
  assert.ok(hasError(r3, 'staged[0].path「NOTE.md」が、題材 market.tar.gz にない'));
  const r4 = await mutate(EDL, (p) => {
    p.workspace.repo.staged = [{ path: 'plugins/embedded-debug-loop/README.md', append: 'x' }];
  });
  assert.ok(hasError(r4, 'staged[0].path「plugins/embedded-debug-loop/README.md」は、target の外に置く'));
});

test('REQ-055 ユーザーのスキルが対象の中・userSkills の外、repo のファイルがリポジトリの外だと不合格になる', async () => {
  const r = await mutate(EDL, (p) => {
    p.files[0].place = 'market/plugins/embedded-debug-loop/skills/x/SKILL.md';
    p.files[4].place = 'elsewhere/SKILL.md';
    for (const k of p.knowledge) if (k.file?.path === 'kx200-firmware/.github/skills/cross-compile/SKILL.md') k.file.path = p.files[0].place;
    for (const k of p.knowledge) if (k.file?.path?.startsWith('market/')) k.file.path = p.files[4].place;
  });
  assert.ok(hasError(r, 'files[0] は role が skill なので、place を target の外にする'));
  assert.ok(hasError(r, 'expect.userSkills「kx200-firmware/.github/skills」の下にない'));
  assert.ok(hasError(r, 'files[4] は role が repo なので'));
});

test('REQ-055 生成プラグインを見る markers が、題材の元の文字や、写すだけで入る資産の文字に当たると不合格になる', async () => {
  const r = await mutate(EDL, (p) => {
    knowledgeOf(p, 'cc-static').markers.embedded = ['printf'];
    knowledgeOf(p, 'dp-image').markers.embedded = ['KX2I'];
    knowledgeOf(p, 'cc-git-pull').markers.excluded = ['arm-linux-gnueabihf-gcc'];
  });
  assert.ok(hasError(r, 'ナレッジ「cc-static」の markers.embedded「printf」が、題材の plugins/embedded-debug-loop/'));
  assert.ok(hasError(r, 'ナレッジ「dp-image」の markers.embedded「KX2I」が、流用される資産 kx200-firmware/.github/skills/deploy/scripts/mkkximg.py'));
  assert.ok(hasError(r, 'ナレッジ「cc-git-pull」の markers.excluded「arm-linux-gnueabihf-gcc」が、流用される資産'));
});

test('REQ-062 単体の課題（inner/standalone.json）も、見本で基準を確かめる', async () => {
  const r = await mutate(EDL, () => {}, {
    files: (dir) => {
      const file = path.join(dir, 'inner', 'standalone.json');
      const task = JSON.parse(fs.readFileSync(file, 'utf8'));
      task.criteria[3].check.pattern = '\\[kxapp\\] other exited';
      task.criteria[0].knowledge = 'no-such';
      fs.writeFileSync(file, JSON.stringify(task, null, 2));
    },
  });
  assert.ok(hasError(r, 'inner/standalone.json の基準「C-04」'));
  assert.ok(hasError(r, 'inner/standalone.json の基準「C-01」の knowledge「no-such」'));
});

test('REQ-062 確かめ B の目印の基準は、機器のコンソールでなく、頼まれた場所に保存したログ（logs/device.log）を見る', async () => {
  const task = JSON.parse(fs.readFileSync(path.join(dirOf(EDL), 'inner', 'standalone.json'), 'utf8'));
  assert.match(task.prompt, /logs\/device\.log に保存/);
  const marker = task.criteria.find((c) => c.knowledge === 'dp-marker');
  assert.equal(marker.check.file, 'logs/device.log');
  // ログを保存しなかった見本（機器のコンソールには目印が出ている）は、B の目印の基準に合格しない。A は保存を頼まないので合格する
  const r = await mutate(EDL, () => {}, { files: (dir) => fs.rmSync(path.join(dir, 'inner', 'golden', 'logs'), { recursive: true, force: true }) });
  assert.ok(hasError(r, `inner/standalone.json の基準「${marker.id}」`), r.errors.join('\n'));
  assert.ok(!r.errors.some((e) => e.includes('inner/eval.json')), r.errors.join('\n'));
});

test('REQ-055 readTarGz は、pax の見出しで書いた長い名前も読む', { skip: spawnSync('tar', ['--version']).status !== 0 && 'tar がない' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-tar-'));
  try {
    const long = `${'d'.repeat(60)}/${'f'.repeat(80)}.txt`;
    fs.mkdirSync(path.join(root, 'src', path.dirname(long)), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', long), 'long name\n');
    fs.writeFileSync(path.join(root, 'src', 'short.md'), 'short\n');
    const made = spawnSync('tar', ['--format=pax', '-czf', path.join(root, 'x.tar.gz'), '-C', path.join(root, 'src'), '.'], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const files = readTarGz(path.join(root, 'x.tar.gz'));
    assert.equal(files.get(long).toString(), 'long name\n');
    assert.equal(files.get('short.md').toString(), 'short\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const hasCmd = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
const ARM_MISSING = ['qemu-arm', 'arm-linux-gnueabihf-gcc', 'python3'].filter((c) => !hasCmd(c));

test('REQ-061 擬似の機器を正しい手順で動かすと、edl-change の内側の課題（A と B）の基準にすべて合格する', { skip: ARM_MISSING.length > 0 && `${ARM_MISSING.join('・')} がない` }, async () => {
  const { makeGolden } = await import('./edl-change/inner/make_golden.mjs');
  const innerDir = path.join(dirOf(EDL), 'inner');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-edl-'));
  try {
    const records = await makeGolden(path.join(root, 'records'));
    for (const name of ['eval.json', 'standalone.json']) {
      const task = JSON.parse(fs.readFileSync(path.join(innerDir, name), 'utf8'));
      const { workDir, inputs } = prepareWorkDir({ task: { dir: innerDir, json: task }, dir: path.join(root, name) });
      fs.cpSync(path.join(innerDir, 'golden', 'inputs'), path.join(workDir, 'inputs'), { recursive: true });
      // 機器の記録（.device）と、確かめ B で頼まれた場所に保存したログ（logs/device.log）
      fs.cpSync(records, workDir, { recursive: true });
      const files = listFiles(workDir, { inputs });
      for (const c of task.criteria) {
        const result = await gradeProgram(c.check, files, { inputs, workDir });
        assert.ok(result.pass, `${name} ${c.id}：${result.reason}`);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- コマンド ---------------------------------------------------------------------------------------------------

test('REQ-017 コマンドは、合格なら終了コード 0、不合格なら 1 を返す', () => {
  const ok = spawnSync(process.execPath, [path.join(HERE, 'validate.mjs'), dirOf('meeting-minutes'), dirOf('training-survey')], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /合格 {2}meeting-minutes/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-test-'));
  try {
    const dir = path.join(root, 'weekly-report');
    fs.cpSync(dirOf('weekly-report'), dir, { recursive: true });
    const persona = readPersona('weekly-report');
    delete persona.styles.hurry;
    fs.writeFileSync(path.join(dir, 'persona.json'), JSON.stringify(persona));
    const ng = spawnSync(process.execPath, [path.join(HERE, 'validate.mjs'), dir, '--all-styles'], { encoding: 'utf8' });
    assert.equal(ng.status, 1);
    assert.match(ng.stdout, /不合格/);
    assert.match(ng.stdout, /styles\.hurry がない/);
    const none = spawnSync(process.execPath, [path.join(HERE, 'validate.mjs')], { encoding: 'utf8' });
    assert.equal(none.status, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- docx・xlsx を作るスクリプト -------------------------------------------------------------------------------------

const PYTHON = process.env.PERSONA_PYTHON || 'python3';
const pythonHasParts = spawnSync(PYTHON, ['-I', '-c', 'import docx, openpyxl'], { encoding: 'utf8' }).status === 0;

for (const id of ['weekly-report', 'meeting-minutes']) {
  test(`REQ-017 ${id} の make_files.py が作る docx・xlsx の中の文字が、置いてあるファイルと同じ`, { skip: !pythonHasParts && 'python-docx と openpyxl が入った Python がない（PERSONA_PYTHON）' }, () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-make-'));
    try {
      const run = spawnSync(PYTHON, [path.join(dirOf(id), 'make_files.py'), '--out', out], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      const made = fs.readdirSync(out).filter((n) => /\.(docx|xlsx)$/.test(n));
      assert.ok(made.length > 0);
      for (const name of made) {
        const have = path.join(dirOf(id), 'files', name);
        assert.ok(fs.existsSync(have), `${name} が置いてない`);
        assert.equal(documentText(path.join(out, name)).text, documentText(have).text, name);
      }
      const placed = fs.readdirSync(path.join(dirOf(id), 'files')).filter((n) => /\.(docx|xlsx)$/.test(n));
      assert.deepEqual(placed.sort(), made.sort());
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
}
