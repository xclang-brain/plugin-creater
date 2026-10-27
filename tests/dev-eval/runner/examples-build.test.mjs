// 会話例の作成（examples-build.mjs）の試験。記録は、試験の中で組み立てる。実際のモデルは使わない。
// 動かし方（リポジトリの根で）：node --test "tests/dev-eval/runner/*.test.mjs"

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadPersona } from '../personas/validate.mjs';
import { GENERATED_MARK, ExamplesError, buildExamples, describeGrade, excerptOfQuestion, findLeaks, hasVersionInHead, markedAnswers, markedQuestions, parseArgs, prepareQuoteBody, readRecords, redact, renderExample, selectRecords } from './examples-build.mjs';
import { tempDir } from './temp-dirs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..', '..');
const PERSONAS = path.join(here, '..', 'personas');
const tmp = (prefix) => tempDir(`examples-${prefix}`);
const weekly = (await loadPersona(path.join(PERSONAS, 'weekly-report'), { allStyles: true })).persona;

/** 外側の EVAL の記録（outer-record/1）の見本 */
function record(overrides = {}) {
  const items = [
    { seq: 1, kind: 'user.request', text: '週報を作るプラグインを作ってください' },
    { seq: 2, kind: 'creator.text', text: 'お話を聞かせてください。\n\n- まず成果物から' },
    { seq: 3, kind: 'creator.question', header: '成果物', question: '成果物はどんなファイルですか？', options: [{ label: 'Markdown', description: 'md' }], multiSelect: false },
    { seq: 4, kind: 'user.answer', index: 0, via: 'AskUserQuestion', question: '成果物はどんなファイルですか？', header: '成果物', answer: '成果物は weekly_report.md です' },
    { seq: 5, kind: 'creator.question', header: '見出し', question: '先週の週報の見出しは決まりですか？', options: [], multiSelect: false },
    { seq: 6, kind: 'user.answer', index: 1, via: 'AskUserQuestion', question: '先週の週報の見出しは決まりですか？', header: '見出し', answer: 'このとおり。「■今週の売上」と「■来週の予定」の2つです' },
    { seq: 7, kind: 'creator.text', text: '作りました。', turn: 2 },
  ];
  return {
    schema: 'outer-record/1',
    persona: { id: 'weekly-report', title: '週報（営業チームのリーダー）', experience: 'done' },
    style: 'normal',
    arm: 'with',
    models: { creator: 'claude-opus-5-5', userRole: 'claude-sonnet-5-5' },
    creator: { version: '0.1.0' },
    startedAt: '2026-10-25T01:00:00.000Z',
    finishedAt: '2026-10-25T01:05:00.000Z',
    stopped: { reason: 'generated' },
    heldout: false,
    items,
    conversation: [
      { role: 'user', via: 'request', text: items[0].text },
      { role: 'creator', via: 'text', text: items[1].text },
      { role: 'creator', via: 'AskUserQuestion', header: '成果物', question: items[2].question, options: items[2].options },
      { role: 'user', via: 'AskUserQuestion', text: items[3].answer, index: 0 },
      { role: 'creator', via: 'AskUserQuestion', header: '見出し', question: items[4].question, options: [] },
      { role: 'user', via: 'AskUserQuestion', text: items[5].answer, index: 1 },
      { role: 'creator', via: 'text', text: items[6].text },
    ],
    grading: {
      score: 0.9,
      exampleCandidate: true,
      faults: [],
      verdict: { ok: true, failed: [] },
      grades: [
        { id: 'one-plugin-generated', ok: true, detail: '' },
        { id: 'stage1', ok: true, detail: '', req: 'REQ-039' },
        { id: 'embedded:headings', ok: true, detail: '聞かれないと話さないナレッジが組み込まれたか', req: 'REQ-015' },
        { id: 'task:ijou', ok: false, detail: 'EVAL の課題と合否の基準にナレッジの言葉があるか', req: 'REQ-038' },
        { id: 'main-model', ok: true, detail: '指定の claude-opus-5-5 で動いた', req: 'REQ-045' },
      ],
    },
    ...overrides,
  };
}

function writeRecords(dir, list) {
  fs.mkdirSync(dir, { recursive: true });
  list.forEach((r, i) => fs.writeFileSync(path.join(dir, `r${i}.json`), JSON.stringify(r)));
}

test('REQ-037 記録の読み込み：外側の EVAL の記録（schema が outer-record/1）だけを読む。ほかの JSON は飛ばす', () => {
  const dir = tmp('read');
  writeRecords(dir, [record()]);
  fs.writeFileSync(path.join(dir, 'outer-report.json'), JSON.stringify({ kind: 'dev-outer-eval' }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{');
  assert.equal(readRecords([dir]).length, 1);
  assert.throws(() => readRecords([path.join(dir, 'ない')]), ExamplesError);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('REQ-037 会話の選び方：すべての観点に合格し、ユーザー役の誤りがなく、今の版の、生成まで進んだ、normal の、クリエイターの、ユーザー役が答えた会話だけを選ぶ', () => {
  const item = (overrides, file = 'a.json') => ({ file, record: record(overrides) });
  const items = [
    item({}, 'good.json'),
    item({ heldout: true }, 'heldout.json'),
    item({}, path.join('x', 'records-heldout', 'h.json')),
    item({ arm: 'control' }, 'control.json'),
    item({ style: 'hurry' }, 'hurry.json'),
    item({ stopped: { reason: 'max_exchanges' } }, 'unfinished.json'),
    item({ grading: { score: 1, exampleCandidate: false, faults: [{ kind: 'leaked' }], verdict: { failed: [] } } }, 'leak.json'),
    item({ grading: { score: 1, exampleCandidate: false, faults: [], verdict: { failed: ['stage1'] } } }, 'failed.json'),
    item({ creator: { version: '0.0.9' } }, 'old.json'),
    item({ answerer: 'human', persona: { id: 'human', title: '開発者が答える', experience: 'done' } }, 'human.json'),
  ];
  const { selected, skipped } = selectRecords(items, { pluginVersion: '0.1.0' });
  assert.deepEqual([...selected.keys()], ['weekly-report']);
  assert.equal(selected.get('weekly-report').file, 'good.json');
  const reasons = Object.fromEntries(skipped.map((s) => [path.basename(s.file), s.reason]));
  assert.match(reasons['heldout.json'], /見ない模擬ユーザー/);
  assert.match(reasons['h.json'], /見ない模擬ユーザー/);
  assert.match(reasons['control.json'], /クリエイターの会話ではない/);
  assert.match(reasons['hurry.json'], /話し方が normal ではない/);
  assert.match(reasons['unfinished.json'], /生成まで進んでいない/);
  assert.match(reasons['leak.json'], /ユーザー役の誤り/);
  assert.match(reasons['failed.json'], /不合格がある（stage1）/);
  assert.match(reasons['old.json'], /クリエイターの版が違う/);
  // 開発者が答えた会話（testing.md 6.7）は、ほかの条件を満たしても載せない
  assert.match(reasons['human.json'], /開発者が答えた会話は載せない/);
  assert.equal(selectRecords([item({ answerer: 'human' }, 'h1.json')], { pluginVersion: '0.1.0' }).selected.size, 0);
  assert.equal(selectRecords([item({ answerer: 'user-role' }, 'u1.json')], { pluginVersion: '0.1.0' }).selected.size, 1);
});

test('REQ-037 点数の高さだけでは選ばない：条件を満たさない高得点より、条件を満たす低得点を選ぶ。条件を満たす中では点数が高い方', () => {
  const high = { file: 'high.json', record: record({ grading: { score: 1, exampleCandidate: false, faults: [{ kind: 'leaked' }], verdict: { failed: [] } } }) };
  const low = { file: 'low.json', record: record({ grading: { score: 0.7, exampleCandidate: true, faults: [], verdict: { failed: [] } } }) };
  const mid = { file: 'mid.json', record: record({ grading: { score: 0.8, exampleCandidate: true, faults: [], verdict: { failed: [] } } }) };
  assert.equal(selectRecords([high, low], { pluginVersion: '0.1.0' }).selected.get('weekly-report').file, 'low.json');
  assert.equal(selectRecords([high, low, mid], { pluginVersion: '0.1.0' }).selected.get('weekly-report').file, 'mid.json');
});

test('REQ-037 聞かれないと話さないナレッジを引き出した質問に、印を付ける（6.3 の記録：質問が asked に、答えが answered に当たる）', () => {
  const r = record();
  assert.deepEqual([...markedAnswers(r, weekly)], [1], '見出しの質問と答えに印。成果物は自分から話すナレッジなので印なし');
  assert.deepEqual([...markedAnswers(r, null)], []);
});

test('REQ-037 会話例の Markdown：冒頭に、AI が演じた会話であること・plugin-creator の版・日付。会話は全文', () => {
  const r = record();
  const md = renderExample({ record: r, persona: weekly, pluginVersion: '0.1.0', date: '2026-10-25' });
  const head = md.split('\n').slice(0, 30).join('\n');
  assert.match(head, /^# 会話例：週報（営業チームのリーダー）/);
  assert.match(head, /plugin-creator の版：0\.1\.0/);
  assert.ok(!md.includes('クリエイターの版'), 'エンドユーザーが読む言葉は、画面と同じ plugin-creator にそろえる');
  assert.match(head, /会話を行った日：2026-10-25/);
  assert.match(head, /AI が演じたユーザー/);
  assert.match(head, /人と話すと、質問の数や順番が変わります/);
  assert.ok(md.includes(GENERATED_MARK));
  // 作ったことを示す HTML のコメントは入れない（クリエイターの画面は text/plain で見せるので丸見えになる）。開発の言葉も出さない
  assert.ok(!md.includes('<!--'));
  assert.ok(!/examples-build|EVAL|ナレッジ|エクステンション|記録のツール/.test(md), md.match(/examples-build|EVAL|ナレッジ|エクステンション|記録のツール/)?.[0]);
  assert.ok(md.split('\n')[2].startsWith('plugin-creator の版：'), '版は 3 行目（冒頭 30 行の中）');
  assert.ok(md.includes('> お話を聞かせてください。'));
  assert.ok(md.includes('> - まず成果物から'));
  assert.ok(md.includes('> 成果物はどんなファイルですか？'));
  assert.ok(md.includes('> - Markdown：md'));
  assert.ok(md.includes('> このとおり。「■今週の売上」と「■来週の予定」の2つです'));
  assert.ok(md.indexOf('★ この質問で') < md.indexOf('このとおり。「■今週の売上」'));
  assert.match(md, /★ この質問で、聞かれないと話さない決まり（上の一覧の \d 番）が出ました。/);
  assert.ok(md.endsWith('\n') && !md.endsWith('\n\n'));
  assert.ok(hasVersionInHead(md, '0.1.0'));
  assert.ok(!hasVersionInHead(md, '0.2.0'));
  // 「クリエイターの版」の古い書き方は受けない
  assert.ok(!hasVersionInHead('# 会話例\n\nクリエイターの版：0.1.0\n'));
  assert.ok(hasVersionInHead('# 会話例\n\nplugin-creator の版: v0.1.0\n', '0.1.0'));
  assert.ok(!hasVersionInHead(`${'行\n'.repeat(40)}plugin-creator の版：0.1.0\n`));
  assert.throws(() => renderExample({ record: { ...r, creator: {} }, persona: weekly }), /版が分かりません/);
});

test('REQ-037 作る：模擬ユーザーごとに 1 つのファイル。選ばれなかった記録は理由つきで返す。--clean は、印のあるファイルだけを消す', async () => {
  const records = tmp('records');
  const out = tmp('out');
  writeRecords(records, [record(), record({ arm: 'control' })]);
  fs.writeFileSync(path.join(out, 'human.md'), '# 人が書いた会話例\n');
  fs.writeFileSync(path.join(out, 'old-persona.md'), `# 古い\n${GENERATED_MARK}\nplugin-creator の版：0.0.1\n`);
  const dry = await buildExamples({ recordInputs: [records], outDir: out, pluginVersion: '0.1.0', dryRun: true, clean: true });
  assert.equal(dry.written.length, 1);
  assert.ok(!fs.existsSync(path.join(out, 'weekly-report.md')), '--dry-run は書かない');
  assert.ok(fs.existsSync(path.join(out, 'old-persona.md')));
  const result = await buildExamples({ recordInputs: [records], outDir: out, pluginVersion: '0.1.0', clean: true });
  assert.deepEqual(result.written.map((w) => path.basename(w.file)), ['weekly-report.md']);
  assert.equal(result.written[0].marked, 1);
  assert.equal(result.skipped.length, 1);
  assert.deepEqual(result.removed.map((f) => path.basename(f)), ['old-persona.md']);
  assert.ok(fs.existsSync(path.join(out, 'human.md')), '人が書いたファイルは消さない');
  assert.match(fs.readFileSync(path.join(out, 'weekly-report.md'), 'utf8'), /plugin-creator の版：0\.1\.0/);
  await assert.rejects(() => buildExamples({ recordInputs: [out], outDir: out, pluginVersion: '0.1.0' }), /記録（schema が outer-record\/1 の JSON）が見つかりません/);
  fs.rmSync(records, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

test('REQ-037 クリエイター自身の 1段目（A3）が、作った会話例の版を plugin.json の版と突き合わせて通す。版が違えば落ちる', async () => {
  const root = tmp('creator');
  const records = tmp('records2');
  writeRecords(records, [record()]);
  await buildExamples({ recordInputs: [records], outDir: path.join(root, 'examples'), pluginVersion: '0.1.0' });
  const check = (version) => {
    fs.writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({ name: 'plugin-creator', version }));
    const script = [
      'import importlib.util, json, sys',
      `spec = importlib.util.spec_from_file_location("cc", ${JSON.stringify(path.join(REPO, 'tests', 'creator', 'check_creator.py'))})`,
      'm = importlib.util.module_from_spec(spec); sys.modules["cc"] = m; spec.loader.exec_module(m)',
      'class C:',
      '    def __init__(self): self.errors = []',
      '    def error(self, message): self.errors.append(message)',
      'c = C()',
      `m.check_examples_version(None, ${JSON.stringify(root)}, c)`,
      'print(json.dumps(c.errors, ensure_ascii=False))',
    ].join('\n');
    const r = spawnSync('python3', ['-I', '-c', script], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.deepEqual(check('0.1.0'), []);
  assert.match(check('0.2.0')[0], /0\.1\.0 が plugin\.json の版 0\.2\.0 と違う/);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(records, { recursive: true, force: true });
});

test('REQ-037 コマンドの引数', () => {
  const a = parseArgs(['--records', 'a', '--records', 'b', '--out', 'x', '--style', 'normal', '--version', '1.2.3', '--clean', '--dry-run']);
  assert.deepEqual(a.records, ['a', 'b']);
  assert.equal(a.out, 'x');
  assert.equal(a.version, '1.2.3');
  assert.equal(a.clean && a.dryRun, true);
  assert.throws(() => parseArgs([]), /--records/);
  assert.throws(() => parseArgs(['--records']), /値が要ります/);
  assert.throws(() => parseArgs(['--records', 'a', '--wat']), ExamplesError);
});

// ---- 会話例の下読みの直し（E1） --------------------------------------------------------------------------------

test('REQ-037 会話例の冒頭に、試験の条件と点数、聞かれないと話さないことにしていた決まりの一覧が載る。一覧の番号と、★ の印が対応する', () => {
  const md = renderExample({ record: record(), persona: weekly, pluginVersion: '0.1.0', date: '2026-10-25' });
  const at = (text) => md.indexOf(text);
  // 順番：版・日付・AI の会話であること → 試験の条件と点数 → 一覧 → 会話
  assert.ok(at('## 試験の条件と点数') > at('plugin-creator の版') && at('## 聞かれないと話さないことにしていた決まり') > at('## 試験の条件と点数') && at('## 会話') > at('## 聞かれないと話さないことにしていた決まり'));
  const conditions = md.slice(at('## 試験の条件と点数'), at('## 聞かれないと話さないことにしていた決まり'));
  assert.match(conditions, /演じたユーザー：週報（営業チームのリーダー）/);
  assert.match(conditions, /ユーザーの話し方：ふつう/);
  assert.match(conditions, /plugin-creator のモデル：claude-opus-5-5/);
  assert.match(conditions, /ユーザーを演じた AI のモデル：claude-sonnet-5-5/);
  assert.match(conditions, /点数：0\.90（5 個の観点のうち 4 個に合格）/);
  assert.match(conditions, /- 合格：プラグインが1つできた/);
  assert.match(conditions, /- 合格：ユーザーが話した「週報の見出しは「■今週の売上」と「■来週の予定」の2つだけで、この順に並べる」が、できたプラグインに入っている/);
  assert.match(conditions, /- 不合格：ユーザーが話した「[^」]*最後の行は必ず「以上」[^」]*」が、できたプラグインの試験の課題と合否の基準に入っている/);
  assert.match(conditions, /- 合格：plugin-creator が、指定の claude-opus-5-5 で動いた/);
  // 聞かれないと話さないことにしていた決まり：自分から話すもの（成果物、金額）は載せず、聞かれないと話すものだけ
  const list = md.slice(at('## 聞かれないと話さないことにしていた決まり'), at('## 会話'));
  const hidden = weekly.knowledge.filter((k) => !k.volunteer);
  hidden.forEach((k, i) => assert.ok(list.includes(`${i + 1}. ${k.fact}`), k.id));
  assert.ok(!list.includes(weekly.knowledge.find((k) => k.id === 'output').fact));
  assert.match(list, /具体的に聞かれたときだけ話すことにしてありました/);
  // 引き出した質問：この見本の会話では、見出しの質問（1 番）だけ
  const headings = hidden.findIndex((k) => k.id === 'headings') + 1;
  assert.match(list, new RegExp(`${headings}\\. [^\\n]*\\n   - 引き出した質問：「先週の週報の見出しは決まりですか？」（★）`));
  assert.ok(list.includes('この会話では、引き出した質問は見つかりませんでした。'), '引き出せなかったものは、そう書く');
  assert.match(md, new RegExp(`★ この質問で、聞かれないと話さない決まり（上の一覧の ${headings} 番）が出ました。`));
  assert.deepEqual([...markedQuestions(record(), weekly)], [[1, ['headings']]]);
  // 観点がない記録（古い記録）でも、点数だけ書いて作れる
  const old = record({ grading: { score: 0.5, exampleCandidate: true, faults: [] } });
  assert.match(renderExample({ record: old, persona: weekly, pluginVersion: '0.1.0' }), /点数：0\.50/);
  // 聞かれないと話さないことがない模擬ユーザー
  const volunteerOnly = { ...weekly, knowledge: weekly.knowledge.filter((k) => k.volunteer) };
  assert.match(renderExample({ record: record(), persona: volunteerOnly, pluginVersion: '0.1.0' }), /聞かれないと話さないことにしていたことはありません。/);
  assert.equal(describeGrade({ id: 'zzz', ok: true, detail: 'そのまま' }, weekly), 'そのまま');
});

test('REQ-037 外に出してはいけないものを伏せる：画面の URL のポート番号と合言葉、作業フォルダなどのパス、会話の番号、鍵のような文字', () => {
  const rec = {
    dirs: { work: '/tmp/x/runs/outer-weekly-report-with-AbC123/work', run: '/tmp/x/runs/outer-weekly-report-with-AbC123' },
    creator: { converted: '/tmp/x/converted/creator', root: '/home/dev/plugin-creater' },
    sessionId: '5aa7bf34-3e10-497b-9635-f7e81e3887a9',
  };
  const stats = {};
  const red = (t) => redact(t, rec, stats);
  assert.equal(red('作業の画面の見本：http://127.0.0.1:38885/?k=bUlBb-egClldg7rjKorUOgLYpq1DL06Z'), '作業の画面の見本：http://127.0.0.1:（ポート番号）/?k=（合言葉）');
  assert.equal(red('localhost:3000 と [::1]:8080'), 'localhost:（ポート番号） と [::1]:（ポート番号）');
  assert.equal(red('https://example.com/?page=2&token=abcdef123456&x=1'), 'https://example.com/?page=2&token=（合言葉）&x=1');
  // 作業フォルダの中は、作業フォルダからの相対の場所。外は名前に置き換える
  assert.equal(red('`/tmp/x/runs/outer-weekly-report-with-AbC123/work/weekly-sales-report/README.md` を読みます'), '`weekly-sales-report/README.md` を読みます');
  assert.equal(red('作業フォルダ /tmp/x/runs/outer-weekly-report-with-AbC123/work の中'), '作業フォルダ （作業フォルダ） の中');
  assert.equal(red('/tmp/x/converted/creator/skills/make-plugin/scripts/scaffold.py を動かす'), '（plugin-creator のフォルダ）/skills/make-plugin/scripts/scaffold.py を動かす');
  assert.equal(red('/home/dev/plugin-creater/SKILL.md'), '（plugin-creator のフォルダ）/SKILL.md');
  // 記録にない場所も、一般の形で伏せる。相対の ./tmp/ や tests/tmp/ は触らない
  assert.equal(red('見つかった：/var/folders/ab/cd/T/results.json と /Users/taro/Documents/週報.docx と C:\\Users\\taro\\a.txt'), '見つかった：（フォルダ）/results.json と （フォルダ）/週報.docx と （フォルダ）/a.txt');
  assert.equal(red('./tmp/a と tests/tmp/b と /tmp'), './tmp/a と tests/tmp/b と （一時フォルダ）');
  assert.equal(red('会話の番号 5aa7bf34-3e10-497b-9635-f7e81e3887a9 と 12345678-1234-1234-1234-123456789abc'), '会話の番号 （会話の番号） と （会話の番号）');
  assert.equal(red('実行 outer-weekly-report-with-AbC123 のフォルダ'), '実行 （実行の名前） のフォルダ');
  assert.equal(red('鍵 ghp_abcdefghijklmnopqrstuvwx と sk-abcdefghijklmnopqrstu'), '鍵 （伏せました） と （伏せました）');
  assert.equal(red('ふつうの文。2026-10-25 と 38885 と /api/v1 はそのまま'), 'ふつうの文。2026-10-25 と 38885 と /api/v1 はそのまま');
  assert.ok(stats.ports >= 3 && stats.keys >= 4 && stats.paths >= 8 && stats.ids >= 3, JSON.stringify(stats));
  // 伏せ残しの見張り（別の目）
  assert.deepEqual(findLeaks(red('http://127.0.0.1:38885/?k=bUlBb-egClldg7rjKorUOgLYpq1DL06Z /tmp/x/y.txt'), rec), []);
  const leaks = findLeaks('http://127.0.0.1:38885/?k=bUlBb-egClldg7rjKorUOgLYpq1DL06Z と /tmp/x/y.txt と 5aa7bf34-3e10-497b-9635-f7e81e3887a9 と /tmp/x/converted/creator', rec).map((l) => l.kind);
  for (const kind of ['ポート番号つきのアドレス', 'URL の合言葉', '作業フォルダなどのパス', '会話の番号', '実行の場所']) assert.ok(leaks.includes(kind), kind);
});

test('REQ-037 会話例に載せる文字が伏せられる：依頼・質問・選択肢・答え・クリエイターの発言のすべて。伏せ残しがあれば作らずに断る', async () => {
  const url = 'http://127.0.0.1:38885/?k=bUlBb-egClldg7rjKorUOgLYpq1DL06Z';
  const r = record({ dirs: { work: '/tmp/zz/work', run: '/tmp/zz' }, sessionId: '5aa7bf34-3e10-497b-9635-f7e81e3887a9' });
  r.conversation[1].text = `画面はこちらです：${url}`;
  r.conversation[2].question = '/tmp/zz/work/資料/先週の週報.docx を読みます。よいですか？';
  r.conversation[2].options = [{ label: 'はい', description: '/tmp/zz/work/out に作る' }];
  r.conversation[3].text = `${url} を開きました`;
  r.conversation[0].text = 'セッション 5aa7bf34-3e10-497b-9635-f7e81e3887a9 から';
  const stats = {};
  const md = renderExample({ record: r, persona: weekly, pluginVersion: '0.1.0', stats });
  assert.ok(md.includes('http://127.0.0.1:（ポート番号）/?k=（合言葉）'));
  assert.ok(md.includes('> 資料/先週の週報.docx を読みます。よいですか？'));
  assert.ok(md.includes('> - はい：out に作る'));
  assert.ok(md.includes('セッション （会話の番号） から'));
  assert.deepEqual(findLeaks(md, r), []);
  assert.ok(stats.ports === 2 && stats.keys === 2 && stats.paths >= 2 && stats.ids === 1, JSON.stringify(stats));
  // 作る側：記録の数が結果に出る。ナレッジの文字（伏せる処理を通らない）にパスがあれば、断る
  const records = tmp('records3');
  const out = tmp('out3');
  writeRecords(records, [r]);
  const built = await buildExamples({ recordInputs: [records], outDir: out, pluginVersion: '0.1.0' });
  assert.ok(built.written[0].redacted.ports >= 1);
  const leaky = { ...weekly, knowledge: weekly.knowledge.map((k, i) => (i === 1 ? { ...k, fact: `${k.fact} /tmp/secret/folder/x.txt` } : k)) };
  await assert.rejects(() => buildExamples({ recordInputs: [records], outDir: out, pluginVersion: '0.1.0', loadPersonaById: async () => leaky }), (e) => e.code === 'leak' && /作業フォルダなどのパス/.test(e.message));
  await assert.rejects(() => buildExamples({ recordInputs: [records], outDir: out, pluginVersion: '0.1.0', loadPersonaById: async () => null }), (e) => e.code === 'no_persona');
  fs.rmSync(records, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

test('REQ-037 引用の中の表示：行の終わりに空白 2 つ（GitHub で1段落につながらない）、「## 」は太字、文字の行の直後の「---」に空行', () => {
  // 改行だけで続く行は、行の終わりに空白 2 つ。最後の行と、空行の前の行にはない
  assert.equal(prepareQuoteBody('・A\n・B\n・C'), '・A  \n・B  \n・C');
  assert.equal(prepareQuoteBody('段落1\n\n段落2\n続き'), '段落1\n\n段落2  \n続き');
  assert.equal(prepareQuoteBody('一行だけ'), '一行だけ');
  // リストの行どうし、表の行には足さない。リストの前の文章の行には足す
  assert.equal(prepareQuoteBody('選択肢：\n- A：a\n- B：b'), '選択肢：  \n- A：a\n- B：b');
  assert.equal(prepareQuoteBody('|a|b|\n|---|---|\n|1|2|'), '|a|b|\n|---|---|\n|1|2|');
  // コードの囲みの中は、そのまま（「## 」も、行の終わりも）
  assert.equal(prepareQuoteBody('手順\n```\n## x\ncode1\ncode2\n```\n終わり'), '手順  \n```\n## x\ncode1\ncode2\n```\n終わり');
  assert.equal(prepareQuoteBody('~~~\n```\n## y\n~~~\n## z'), '~~~\n```\n## y\n~~~\n**z**');
  // 見出しは太字（見出しの記号の行が、引用の中で見出しにならない）
  assert.equal(prepareQuoteBody('## できたこと\n\n本文'), '**できたこと**\n\n本文');
  assert.equal(prepareQuoteBody('# 題 #\n本文'), '**題**  \n本文');
  assert.equal(prepareQuoteBody('#タグ と ## 途中'), '#タグ と ## 途中', '見出しの記号は行の頭だけ。記号の後に空白がなければ見出しではない');
  // 文字の行の直後の「---」「===」は、前の行を見出しにするので、空行を挟む。空行の後ろ（区切り線）はそのまま
  assert.equal(prepareQuoteBody('題\n---\n本文'), '題\n\n---\n本文');
  assert.equal(prepareQuoteBody('段落\n\n---\n本文'), '段落\n\n---\n本文');
  assert.equal(prepareQuoteBody('題\n===\n本文'), '題\n\n===\n本文');
  assert.equal(prepareQuoteBody('A\r\nB'), 'A  \nB');
});

test('REQ-037 会話例の引用：複数行の発言は、引用の中で行が続く。空行は引用の空行。見出しの記号は太字になる', () => {
  const r = record();
  r.conversation[1].text = '## まとめ\n・金額は万円\n・最後は「以上」\n\n以上です';
  const md = renderExample({ record: r, persona: weekly, pluginVersion: '0.1.0' });
  assert.ok(md.includes('> **まとめ**  \n> ・金額は万円  \n> ・最後は「以上」\n>\n> 以上です\n'), md);
  assert.ok(!/^> #/m.test(md), '引用の中に見出しがない');
  assert.ok(md.includes('> 成果物はどんなファイルですか？\n>\n> - Markdown：md\n'));
});

test('REQ-037 引き出した質問の抜き出し：前置きの文ではなく、ナレッジを引き出した一文を選ぶ。長いときは、当たった所の前後を残す', () => {
  const q = 'ファイルから読み取った決まりが実際と違うと、AI が間違ったやり方で作業します。週報の最後の行は「以上」だけ、という決まりですか？（先週の週報.docx より）';
  assert.equal(excerptOfQuestion(q, ['最後の行|終わり方']), '週報の最後の行は「以上」だけ、という決まりですか？');
  assert.equal(excerptOfQuestion(q, ['当たらない']), '（先週の週報.docx より）', '当たる文がなければ、最後の一文');
  const long = `前置き。${'あ'.repeat(60)}最後の行${'い'.repeat(60)}という決まりですか？`;
  const cut = excerptOfQuestion(long, ['最後の行'], 40);
  assert.ok(cut.startsWith('…') && cut.endsWith('…') && cut.includes('最後の行'), cut);
  assert.ok([...cut].length <= 42);
  assert.equal(excerptOfQuestion('', ['x']), '');
});
