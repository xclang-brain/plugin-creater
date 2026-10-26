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
import { gradeProgram, listFiles } from '../../../skills/test-plugin/scripts/grade.mjs';
import { prepareWorkDir } from '../../../skills/test-plugin/scripts/tasks.mjs';
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
  assert.match(k15.fact, /K-15/);
  assert.match(k15.fact, /reboot/);
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

test('REQ-056 expect.lastTimeAsked は、最近の1回をたどる問いに当たり、ファイルの場所の問いや画面の問いに当たらない', () => {
  const p = readPersona(EDL);
  const lastTime = new RegExp(p.expect.lastTimeAsked);
  const recent = exampleQuestions('last-time.md').filter((q) => q.includes('最近'));
  assert.ok(recent.length >= 2, 'last-time.md の「最近」の問いの例が見つからない');
  for (const q of recent) assert.match(q, lastTime);
  for (const q of [
    '最近デプロイした1回を、最初から終わりまで順に教えてください。',
    '最近デプロイした1回で、この流れに書かれていないことは何ですか？',
  ]) assert.match(q, lastTime);
  // 段階「実物を受け取る」の問い（作り直しでは「前回の1回のファイル」を聞く）と、画面の問いには当たらない
  const receive = exampleQuestions('receive.md');
  assert.ok(receive.length >= 1, 'receive.md の問いの例が見つからない');
  for (const q of [
    ...receive,
    ...exampleQuestions('screen.md'),
    '最近デプロイしたときに使ったスキルやファイルは、どこにありますか？',
    '前回の1回で受け取ったファイルと作ったファイル、いつも使っているファイル（テンプレート、手順書、スクリプトなど）は、どこにありますか？',
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
