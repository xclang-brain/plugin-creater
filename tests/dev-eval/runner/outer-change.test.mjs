// 改善の模擬ユーザー（kind が change）の作業フォルダと、直すプラグインのリポジトリの記録（outer-change.mjs）、外側の EVAL の流れへの組み込み
// （outer-run.mjs）の試験。実際のモデルは使わない（偽物の Agent SDK）。題材は、この試験が作る小さな tar.gz（本物の題材は使わない）。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ITEMS } from '../../../com.github.copilot/extensions/plugin-creator/names.mjs';
import {
  CHANGE_BASELINE_FILE, changeEnded, changeRecordOf, collectChangeRepo, git, manifestOf, parseAddedLines, placeWorkspace, readBaseline, REPO_USER, takeBaseline, takeSnapshot,
} from './outer-change.mjs';
import { createFakeSdk } from './outer-fake-sdk.mjs';
import { gradeChange } from './outer-grade-change.mjs';
import { personaFileHashes } from './outer-grade.mjs';
import { placePersonaFiles, runOuterOnce } from './outer-run.mjs';
import { tempDir } from './temp-dirs.mjs';

const tmp = (prefix) => fs.realpathSync(tempDir(`outer-change-${prefix}`));
const write = (root, rel, text) => {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const T = (name) => `mcp__plugin-creator__${name}`;
const KNOWLEDGE = [
  { id: 'K-01', kind: 'other', item: '進め方', text: '手順どおりに進める。' },
  { id: 'K-02', kind: 'other', item: 'いつもと違うとき', text: '失敗したら、そのまま進めずに人に伝える。' },
];

/**
 * 小さな題材（直すプラグイン demo の入ったリポジトリの tar.gz）と、改善の模擬ユーザーを作る。
 * manifestAt は demo のマニフェストの場所（直下のほか、.plugin/・.github/plugin/・.claude-plugin/ でもよい。BLUEPRINT D29）
 */
function makeFixture({ manifestAt = 'plugin.json' } = {}) {
  const root = tmp('fixture');
  const src = path.join(root, 'src');
  write(src, 'README.md', '# 一覧\n');
  write(src, '.github/plugin/marketplace.json', '{ "plugins": [] }\n');
  write(src, `plugins/demo/${manifestAt}`, `${JSON.stringify({ name: 'demo', version: '0.1.0' })}\n`);
  write(src, 'plugins/demo/tests/knowledge.json', `${JSON.stringify(KNOWLEDGE, null, 2)}\n`);
  write(src, 'plugins/demo/tests/eval/T-01/eval.json', `${JSON.stringify({ id: 'T-01', prompt: '元の課題', criteria: [] })}\n`);
  write(src, 'plugins/demo/skills/rules/SKILL.md', '---\nname: rules\n---\n- ログは printf で出す（K-01）\n');
  const fixturesDir = path.join(root, 'fixtures');
  fs.mkdirSync(fixturesDir);
  const r = spawnSync('tar', ['-czf', path.join(fixturesDir, 'mini.tar.gz'), '-C', src, '.'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const personaDir = path.join(root, 'persona');
  write(personaDir, 'files/tools/skills/build/SKILL.md', '---\nname: build\ndescription: ビルドする\n---\n1. `git pull` する\n2. arm-gcc でビルドする\n');
  write(personaDir, 'files/tools/skills/build/scripts/build.sh', '#!/bin/sh\necho build\n');
  write(personaDir, 'files/market/plugins/demo/skills/rules/SKILL.md', '---\nname: rules\n---\n- ログは printf で出す（K-01）\n- KX では DBG_LOG で出す\n');
  const persona = {
    id: 'mini-change',
    title: '小さな改善',
    kind: 'change',
    experience: 'done',
    request: 'market/plugins/demo を直してください。',
    profile: 'あなたは開発者です。',
    workspace: { repo: { place: 'market', fixture: 'mini.tar.gz', commitDate: '2026-10-01T00:00:00+09:00', staged: [{ path: 'README.md', append: '\n作業中のメモ\n' }], origin: true } },
    target: 'market/plugins/demo',
    expect: { carriedMax: 2, replaced: 'K-02', deviceTool: 'kxtool', userSkills: 'tools/skills', explained: ['revert'] },
    files: [
      { src: 'files/tools/skills/build/SKILL.md', place: 'tools/skills/build/SKILL.md', role: 'skill', describe: 'ビルドのスキル', reveal: 'スキルを聞かれたとき' },
      { src: 'files/tools/skills/build/scripts/build.sh', place: 'tools/skills/build/scripts/build.sh', role: 'skill', describe: 'ビルドのスクリプト', reveal: 'スキルを聞かれたとき' },
      { src: 'files/market/plugins/demo/skills/rules/SKILL.md', place: 'market/plugins/demo/skills/rules/SKILL.md', role: 'repo' },
    ],
    knowledge: [{ id: 'k15-now', fact: 'K-02 は古い。今は reboot してやり直す。', reveal: '決まりの一覧を見せられたとき', volunteer: true, from: 'talk', markers: { asked: 'K-02', answered: 'reboot' } }],
    styles: { normal: { label: 'ふつう', instruction: '' } },
  };
  const loaded = { persona, dir: personaDir, files: persona.files.map((f) => ({ src: path.join(personaDir, ...f.src.split('/')), place: f.place, role: f.role, describe: f.describe })) };
  return { root, fixturesDir, persona, loaded };
}

/** 作業フォルダを作って題材を置く（outer-run.mjs と同じ順：示すファイル → 題材） */
function prepare(fx, name = 'run') {
  const runDir = path.join(tmp(name), 'r');
  const workDir = path.join(runDir, 'work');
  fs.mkdirSync(workDir, { recursive: true });
  placePersonaFiles(workDir, fx.loaded.files.filter((f) => f.role !== 'repo'));
  const placed = placeWorkspace(workDir, fx.persona, fx.loaded.dir, { fixturesDir: fx.fixturesDir });
  return { runDir, workDir, ...placed };
}

const gitOut = (cwd, args) => git(cwd, args).stdout.trim();

test('REQ-059 作業フォルダ：題材を展開し、repo のファイルを置いて、書き手と日時を固定した初めのコミットを作る。git add だけの変更と origin も作る', () => {
  const fx = makeFixture();
  const a = prepare(fx, 'place-a');
  const repo = path.join(a.workDir, 'market');
  assert.equal(a.repoDir, repo);
  assert.equal(a.targetDir, path.join(repo, 'plugins', 'demo'));
  assert.ok(fs.existsSync(path.join(repo, '.github', 'plugin', 'marketplace.json')));
  // role が repo のファイルは、初めのコミットの前に置く（作った後にユーザーが書き足した決まり）
  assert.match(fs.readFileSync(path.join(a.targetDir, 'skills', 'rules', 'SKILL.md'), 'utf8'), /DBG_LOG/);
  assert.equal(gitOut(repo, ['show', 'HEAD:plugins/demo/skills/rules/SKILL.md']).includes('DBG_LOG'), true);
  // ユーザーのスキルは、示すファイルとして置かれ、リポジトリの外にある
  assert.ok(fs.existsSync(path.join(a.workDir, 'tools', 'skills', 'build', 'scripts', 'build.sh')));
  // 初めのコミットは1つ。書き手はリポジトリの設定にある
  assert.deepEqual(gitOut(repo, ['log', '--format=%s']).split('\n'), ['初めの状態']);
  assert.equal(gitOut(repo, ['config', 'user.name']), REPO_USER.name);
  assert.equal(gitOut(repo, ['config', 'user.email']), REPO_USER.email);
  assert.equal(gitOut(repo, ['log', '-1', '--format=%aI']), '2026-10-01T00:00:00+09:00');
  // 直すフォルダの外に、git add だけの変更がある。直すフォルダには、コミットしていない変更がない
  assert.deepEqual(gitOut(repo, ['diff', '--cached', '--name-only']).split('\n'), ['README.md']);
  assert.match(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), /作業中のメモ\n$/);
  assert.equal(gitOut(a.targetDir, ['status', '--porcelain', '--', '.']), '');
  // origin は実行のフォルダの下（作業フォルダの外）のベアリポジトリで、初めのコミットがある
  assert.equal(a.originDir, path.join(path.dirname(a.workDir), 'origin.git'));
  assert.equal(gitOut(a.originDir, ['rev-parse', 'refs/heads/main']), a.baseCommit);
  // 同じ題材なら、毎回同じコミットの番号になる
  const b = prepare(fx, 'place-b');
  assert.equal(b.baseCommit, a.baseCommit);
});

test('REQ-059 作業フォルダ：題材がない・git add だけの変更が直すフォルダの中・場所が作業フォルダの外のときは、置かずに断る', () => {
  const fx = makeFixture();
  const work = path.join(tmp('bad'), 'work');
  fs.mkdirSync(work, { recursive: true });
  const withRepo = (repo) => ({ ...fx.persona, workspace: { repo: { ...fx.persona.workspace.repo, ...repo } } });
  assert.throws(() => placeWorkspace(work, withRepo({ fixture: 'none.tar.gz' }), fx.loaded.dir, { fixturesDir: fx.fixturesDir }), /題材がありません/);
  assert.throws(() => placeWorkspace(path.join(tmp('bad2'), 'work'), withRepo({ staged: [{ path: 'plugins/demo/plugin.json', append: 'x' }] }), fx.loaded.dir, { fixturesDir: fx.fixturesDir }), /直すプラグインのフォルダの外/);
  assert.throws(() => placeWorkspace(work, { ...fx.persona, target: '../outside' }, fx.loaded.dir, { fixturesDir: fx.fixturesDir }), /作業フォルダの外/);
  // 断る文は、どのフォルダの外かを示す（題材のフォルダ、模擬ユーザーのフォルダ、題材のリポジトリ）
  assert.throws(() => placeWorkspace(path.join(tmp('bad3'), 'work'), withRepo({ fixture: '../mini.tar.gz' }), fx.loaded.dir, { fixturesDir: fx.fixturesDir }), /題材の tar\.gz の場所が題材のフォルダ（.+）の外です/);
  const badSrc = { ...fx.persona, files: fx.persona.files.map((f) => (f.role === 'repo' ? { ...f, src: '../x.md' } : f)) };
  assert.throws(() => placeWorkspace(path.join(tmp('bad4'), 'work'), badSrc, fx.loaded.dir, { fixturesDir: fx.fixturesDir }), /role が repo のファイルの元が模擬ユーザーのフォルダ（.+）の外です/);
  assert.throws(() => placeWorkspace(path.join(tmp('bad5'), 'work'), withRepo({ staged: [{ path: '../../x.md', append: 'x' }] }), fx.loaded.dir, { fixturesDir: fx.fixturesDir }), /staged の場所が題材のリポジトリ（market）の外です/);
});

test('REQ-052 REQ-057 マニフェストの場所：直下のほか .plugin/・.github/plugin/・.claude-plugin/ にあっても、元の版と名前、直した後の版を読む（エクステンションと同じ順）', () => {
  for (const manifestAt of ['.plugin/plugin.json', '.github/plugin/plugin.json', '.claude-plugin/plugin.json']) {
    const fx = makeFixture({ manifestAt });
    const p = prepare(fx, 'manifest');
    assert.equal(manifestOf(p.targetDir), path.join(p.targetDir, ...manifestAt.split('/')));
    const baseline = takeBaseline(p.runDir, { workDir: p.workDir, persona: fx.persona, originDir: p.originDir });
    assert.deepEqual([baseline.pluginName, baseline.versionBefore], ['demo', '0.1.0'], manifestAt);
    write(p.targetDir, manifestAt, `${JSON.stringify({ name: 'demo', version: '0.3.0' })}\n`);
    git(p.targetDir, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-am', '直した']);
    const repo = collectChangeRepo({ workDir: p.workDir, persona: fx.persona, baseline });
    assert.deepEqual([repo.pluginNameAfter, repo.versionAfter], ['demo', '0.3.0'], manifestAt);
  }
  // 直下と .claude-plugin/ の両方にあれば、直下を読む
  const fx = makeFixture({ manifestAt: '.claude-plugin/plugin.json' });
  const p = prepare(fx, 'manifest-both');
  write(p.targetDir, 'plugin.json', `${JSON.stringify({ name: 'demo', version: '0.5.0' })}\n`);
  assert.equal(manifestOf(p.targetDir), path.join(p.targetDir, 'plugin.json'));
  assert.equal(manifestOf(path.join(p.workDir, 'none')), null);
});

test('REQ-057 REQ-059 始める前の記録：初めのコミット、git add だけのファイル、元の版・決まり・課題、ファイルごとの sha256、origin の refs を実行のフォルダに残す', () => {
  const fx = makeFixture();
  const p = prepare(fx, 'baseline');
  const baseline = takeBaseline(p.runDir, { workDir: p.workDir, persona: fx.persona, originDir: p.originDir, now: () => Date.parse('2026-10-26T00:00:00Z') });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.runDir, CHANGE_BASELINE_FILE), 'utf8')), baseline);
  assert.deepEqual(readBaseline(p.runDir), baseline);
  assert.equal(baseline.baseCommit, p.baseCommit);
  assert.equal(baseline.targetInRepo, 'plugins/demo');
  assert.deepEqual(baseline.stagedBefore, ['README.md']);
  assert.equal(baseline.versionBefore, '0.1.0');
  assert.equal(baseline.pluginName, 'demo');
  assert.deepEqual(baseline.knowledgeBefore.map((k) => k.id), ['K-01', 'K-02']);
  assert.equal(baseline.removedBefore, null);
  assert.deepEqual(baseline.evalBefore, [{ dir: 'T-01', prompt: '元の課題' }]);
  assert.deepEqual(baseline.userSkillNames, ['build']);
  assert.deepEqual(Object.keys(baseline.userSkillFiles).sort(), ['tools/skills/build/SKILL.md', 'tools/skills/build/scripts/build.sh']);
  assert.ok(Object.keys(baseline.targetFiles).includes('skills/rules/SKILL.md'));
  // 直すフォルダの外のファイル：直すフォルダと .git は入らない。ユーザーのスキルとリポジトリのほかのファイルは入る
  const outside = Object.keys(baseline.outsideFiles);
  assert.ok(outside.includes('market/README.md') && outside.includes('tools/skills/build/SKILL.md'));
  assert.ok(outside.every((rel) => !rel.startsWith('market/plugins/demo/') && !rel.split('/').includes('.git')), outside.join(','));
  assert.deepEqual(baseline.originRefs, { 'refs/heads/main': p.baseCommit });
  assert.throws(() => readBaseline(tmp('nobaseline')), /始める前の記録/);
});

test('REQ-057 スナップショットと終わりの見分け：直すフォルダの変更だけを見る（作業用の一時フォルダとほかのフォルダは見ない）', () => {
  const fx = makeFixture();
  const p = prepare(fx, 'snapshot');
  const baseline = takeBaseline(p.runDir, { workDir: p.workDir, persona: fx.persona, originDir: p.originDir });
  const snap = (reason) => takeSnapshot({ workDir: p.workDir, persona: fx.persona, reason, now: () => 0 });
  const clean = snap('question');
  assert.deepEqual(clean, { at: '1970-01-01T00:00:00.000Z', reason: 'question', head: p.baseCommit, status: [] });
  write(p.targetDir, '.plugin-creator-work/preview/x.md', 'K-02');
  write(p.workDir, '.plugin-creator-work/parts/a.md', 'x');
  fs.appendFileSync(path.join(p.repoDir, 'README.md'), 'もう1行\n');
  assert.deepEqual(snap('tool:record').status, [], '作業用の一時フォルダと、直すフォルダの外の変更は見ない');
  fs.appendFileSync(path.join(p.targetDir, 'plugin.json'), '\n');
  write(p.targetDir, 'skills/new/SKILL.md', 'x');
  const dirty = snap('turn-end');
  assert.equal(dirty.status.length, 2, JSON.stringify(dirty.status));

  assert.equal(changeEnded({ baseline, snapshot: clean, approved: false }), null, '変わっていなければ続ける');
  assert.equal(changeEnded({ baseline, snapshot: dirty, approved: false }), 'changed_without_approval');
  assert.equal(changeEnded({ baseline, snapshot: dirty, approved: true }), null, '承認の後で直している途中なら続ける');
  assert.equal(changeEnded({ baseline, snapshot: clean, approved: true }), null, '承認の後でも、まだコミットしていなければ続ける');
  assert.equal(changeEnded({ baseline, snapshot: clean, approved: true, newPlugins: ['out/demo'] }), 'generated_new_folder');
  assert.equal(changeEnded({ baseline, snapshot: { head: null, status: null }, approved: true }), null);
  git(p.targetDir, ['add', '-A', '--', '.']);
  git(p.targetDir, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', '直した', '--', '.']);
  const committed = snap('turn-end');
  assert.notEqual(committed.head, p.baseCommit);
  assert.deepEqual(committed.status, []);
  assert.equal(changeEnded({ baseline, snapshot: committed, approved: true }), 'changed');
  assert.equal(changeEnded({ baseline, snapshot: committed, approved: false }), 'changed_without_approval');
  // README.md は git add したまま（コミットに入らない）
  assert.deepEqual(gitOut(p.repoDir, ['diff', '--cached', '--name-only']).split('\n'), ['README.md']);
  // 直すフォルダがなくなったら、見られなかったことを残す
  fs.rmSync(p.repoDir, { recursive: true, force: true });
  const lost = snap('turn-end');
  assert.equal(lost.head, null);
  assert.ok(lost.error);
});

test('REQ-055 REQ-058 足した行：git diff -U0 の出力から、ファイルごとの足した行を取り出す（見出しの行と消した行は入れない）', () => {
  const diff = [
    'diff --git a/skills/a/SKILL.md b/skills/a/SKILL.md',
    'index 1..2 100644',
    '--- a/skills/a/SKILL.md',
    '+++ b/skills/a/SKILL.md',
    '@@ -1 +1,2 @@',
    '-古い行',
    '+新しい行',
    '++++ で始まる行',
    'diff --git a/old.md b/old.md',
    'deleted file mode 100644',
    '--- a/old.md',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-消した',
    'diff --git a/bin.dat b/bin.dat',
    'Binary files a/bin.dat and b/bin.dat differ',
  ].join('\n');
  assert.deepEqual(parseAddedLines(diff), { 'skills/a/SKILL.md': '新しい行\n+++ で始まる行' });
  assert.deepEqual(parseAddedLines(''), {});
});

/** クリエイターの代わりに直す：K-02 を K-04 に付け直し、K-03 を足し、版を上げ、ルールのスキルと課題を足して、直すフォルダだけをコミットしてタグを付ける */
function simulateChange(p, fx) {
  const t = p.targetDir;
  write(t, 'tests/knowledge.json', `${JSON.stringify([KNOWLEDGE[0], { id: 'K-03', kind: 'other', item: '決まった書き方やルール', text: 'KX では DBG_LOG で出す。' }, { id: 'K-04', kind: 'other', item: 'いつもと違うとき', text: '1回 reboot してやり直し、だめなら人に伝える。' }], null, 2)}\n`);
  write(t, 'tests/knowledge-removed.json', `${JSON.stringify([{ ...KNOWLEDGE[1], replacedBy: 'K-04' }], null, 2)}\n`);
  write(t, 'plugin.json', `${JSON.stringify({ name: 'demo', version: '0.2.0' })}\n`);
  write(t, 'skills/build-rules/SKILL.md', '---\nname: build-rules\n---\n- arm-gcc でビルドする（K-05）\n');
  fs.copyFileSync(path.join(fx.loaded.dir, 'files', 'tools', 'skills', 'build', 'scripts', 'build.sh'), path.join(t, 'skills', 'build-rules', 'build.sh.tmp'));
  fs.mkdirSync(path.join(t, 'skills', 'build-rules', 'scripts'));
  fs.renameSync(path.join(t, 'skills', 'build-rules', 'build.sh.tmp'), path.join(t, 'skills', 'build-rules', 'scripts', 'build.sh'));
  write(t, 'tests/eval/T-02/eval.json', `${JSON.stringify({ id: 'T-02', prompt: '新しい課題', bin: 'inputs/bin', inputs: ['inputs/bin/kxtool'], criteria: [{ id: 'C-02', text: '機器に送った', grading: 'program', check: { type: 'contains', file: 'device-history.log', text: 'send' } }] })}\n`);
  write(t, 'tests/eval/T-02/inputs/bin/kxtool', '#!/bin/sh\necho "$@" >> "$(dirname "$0")/../../device-history.log"\n');
  git(t, ['add', '-A', '--', '.']);
  git(t, ['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', 'plugin-creator: demo を直した（0.1.0 → 0.2.0）', '--', '.']);
  git(t, ['tag', '-f', 'plugin-creator-generated-demo']);
}

test('REQ-059 REQ-058 終わった後の記録：コミット、差分の場所、足した行、git add だけのファイル、タグ、決まりの一覧、外のファイル、残った一時フォルダを集める', () => {
  const fx = makeFixture();
  const p = prepare(fx, 'collect');
  const baseline = takeBaseline(p.runDir, { workDir: p.workDir, persona: fx.persona, originDir: p.originDir });
  simulateChange(p, fx);
  write(p.workDir, '.claude/.cc-writes/x', ''); // サンドボックスが残すもの
  write(p.workDir, '.plugin-creator-work/parts/a.md', 'x'); // 消し忘れた作業用の一時フォルダ
  const repo = collectChangeRepo({ workDir: p.workDir, persona: fx.persona, baseline });
  assert.equal(repo.commits.length, 1);
  assert.deepEqual(repo.commits[0].parents, [p.baseCommit]);
  assert.match(repo.commits[0].subject, /demo を直した/);
  assert.ok(repo.diffFiles.length > 0 && repo.diffFiles.every((f) => f.startsWith('plugins/demo/')), repo.diffFiles.join(','));
  assert.deepEqual(repo.stagedAfter, ['README.md']);
  assert.deepEqual(repo.statusAfter, []);
  assert.deepEqual(repo.tagsAtHead, ['plugin-creator-generated-demo']);
  assert.equal(repo.versionAfter, '0.2.0');
  assert.deepEqual(repo.knowledgeAfter.map((k) => k.id), ['K-01', 'K-03', 'K-04']);
  assert.deepEqual(repo.removedAfter.map((r) => [r.id, r.replacedBy]), [['K-02', 'K-04']]);
  const added = Object.fromEntries(repo.added.map((f) => [f.rel, f.text]));
  assert.match(added['skills/build-rules/SKILL.md'], /arm-gcc でビルドする/);
  assert.equal(added['skills/rules/SKILL.md'], undefined, '変えていないファイルは足した行がない');
  assert.ok(repo.added.every((f) => typeof f.sha256 === 'string'));
  assert.deepEqual(repo.targetSkillNames.map((s) => s.name), ['build-rules', 'rules']);
  assert.deepEqual(repo.evalAfter.map((e) => [e.dir, e.files.includes('inputs/bin/kxtool')]), [['T-01', false], ['T-02', true]]);
  assert.deepEqual(repo.userSkillFilesAfter, baseline.userSkillFiles);
  assert.ok(Object.keys(repo.outsideFilesAfter).includes('.claude/.cc-writes/x'));
  assert.deepEqual(repo.leftoverWork, ['.plugin-creator-work']);
  assert.deepEqual(repo.originRefsAfter, baseline.originRefs);
  assert.ok(repo.targetFiles.some((f) => f.rel === 'skills/build-rules/scripts/build.sh'));
  // 記録に残す要約
  const items = [{ seq: 3, at: 1, kind: 'repo.snapshot', reason: 'question', head: p.baseCommit, status: [] }, { seq: 4, kind: 'creator.text', text: 'x' }];
  const summary = changeRecordOf(repo, items);
  assert.deepEqual(Object.keys(summary).sort(), ['baseCommit', 'commits', 'diffFiles', 'headCommit', 'knowledgeAfter', 'knowledgeBefore', 'leftoverWork', 'removedAfter', 'snapshots', 'stagedAfter', 'stagedBefore', 'statusAfter', 'tagsAtHead', 'versionAfter', 'versionBefore']);
  assert.deepEqual(summary.snapshots, [{ seq: 3, at: 1, reason: 'question', head: p.baseCommit, status: [] }]);
  // 本物の git の記録で採点できる：コミットの範囲は合格、作業用の一時フォルダが残ったので「外を変えない」は不合格
  const grading = gradeChange({ persona: fx.persona, record: {}, state: null, items: [], toolEvents: [], stages: null, repo, personaFiles: personaFileHashes(fx.loaded.files) });
  const by = Object.fromEntries(grading.grades.map((g) => [g.id, g]));
  assert.equal(by['commit-scoped'].ok, true, by['commit-scoped'].detail);
  assert.equal(by['rule-replaced'].ok, true, by['rule-replaced'].detail);
  assert.equal(by['ids-kept'].ok, true, by['ids-kept'].detail);
  assert.equal(by['tests-added'].ok, true, by['tests-added'].detail);
  assert.equal(by['assets-reused'].ok, true, by['assets-reused'].detail);
  assert.equal(by['user-skills-unchanged'].ok, true);
  assert.equal(by['not-pushed'].ok, true);
  assert.equal(by['nothing-outside'].ok, false);
  assert.match(by['nothing-outside'].detail, /作業用の一時フォルダが残っている/);
  assert.doesNotMatch(by['nothing-outside'].detail, /cc-writes/);
});

// ---- 外側の EVAL の流れ（outer-run.mjs） -------------------------------------------------------------------

/** 変換の代わり（outer-run.test.mjs と同じ）。置き換えた版の入れ物と変換レポートだけを作る */
function fakeConvert(src, out) {
  fs.mkdirSync(path.join(out, '.eval'), { recursive: true });
  const report = {
    plugin: path.basename(src),
    model_map: { 'claude-haiku-5.5': 'claude-haiku-5-5', 'claude-opus-5.5': 'claude-opus-5-5' },
    extension_tools: ['open', 'state', 'progress', 'record', 'confirm'].map((tool) => ({ from: `plugin-creator_${tool}`, to: T(tool), server: 'plugin-creator', tool, where: 'skills/change-plugin/SKILL.md' })),
    warnings: [],
  };
  fs.writeFileSync(path.join(out, '.eval', 'conversion-report.json'), JSON.stringify(report));
  fs.mkdirSync(path.join(out, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(out, 'agents', 'worker.md'), '---\nname: worker\ndescription: 作業\nmodel: claude-haiku-5-5\n---\n本文\n');
  return { root: out, report, summary: { ok: true } };
}

test('REQ-059 改善の模擬ユーザーの流れ：題材を置き、直すフォルダがコミットされたら changed で終え、直したフォルダの1・2段目を動かして gradeChange で採点する', async () => {
  const fx = makeFixture();
  const runRoot = tmp('flow');
  const systems = [];
  const staged = [];
  const sdk = createFakeSdk({
    userRole: ({ system }) => {
      systems.push(String(system));
      return 'デプロイのスキルを足してください';
    },
    agent: async (ctx) => {
      if (ctx.turn === 1) return 'どこを直しますか？';
      const work = ctx.options.cwd;
      await ctx.tool('Bash', { command: 'python3 skills/make-plugin/scripts/scaffold.py commit --plugin market/plugins/demo' }, {
        run: () => {
          simulateChange({ targetDir: path.join(work, 'market', 'plugins', 'demo') }, fx);
          return 'ok';
        },
      });
      return '直しました。戻すときは git revert です。';
    },
  });
  const record = await runOuterOnce({
    loaded: fx.loaded, arm: 'without', runRoot, sandbox: false, query: sdk.query, maxExchanges: 4, fixturesDir: fx.fixturesDir,
    runStages: async (dir) => {
      staged.push(dir);
      return { skipped: false, ok: true, stage1: { ok: true }, stage2: { ok: true } };
    },
  });
  assert.equal(record.stopped.reason, 'changed', JSON.stringify(record.stopped));
  assert.equal(record.exchanges, 1);
  assert.equal(record.persona.kind, 'change');
  // 直したフォルダの1・2段目を動かした（新しいフォルダを探さない）
  assert.deepEqual(staged, [path.join(record.dirs.work, 'market', 'plugins', 'demo')]);
  assert.deepEqual(record.generated.plugins, []);
  // 記録：初めのコミットと直したコミット、スナップショット（手番の終わりごと）
  assert.equal(record.change.commits.length, 1);
  assert.equal(record.change.versionAfter, '0.2.0');
  assert.deepEqual(record.change.snapshots.map((s) => s.reason), ['turn-end', 'turn-end']);
  assert.equal(record.change.snapshots[1].head, record.change.headCommit);
  assert.ok(fs.existsSync(path.join(record.dirs.run, CHANGE_BASELINE_FILE)));
  // 改善の採点で採点した
  assert.equal(record.grading.kind, 'change');
  const by = Object.fromEntries(record.grading.grades.map((g) => [g.id, g.ok]));
  assert.equal(by['commit-scoped'], true);
  assert.equal(by.stage1, true);
  assert.equal(by['no-new-folder'], true);
  assert.equal(by.explained, true);
  assert.equal(by['change-skill-used'], false, 'プラグインなしでは change-plugin を呼んでいない');
  // ユーザー役には、ユーザーのスキルを示し、題材に初めから置いたファイル（role が repo）は示さない
  assert.ok(systems.length > 0);
  assert.ok(systems.every((s) => s.includes('tools/skills/build/SKILL.md') && !s.includes('market/plugins/demo/skills/rules/SKILL.md')));
});

test('REQ-057 改善の模擬ユーザーの流れ：承認の前に直すフォルダを変えたら changed_without_approval で終え、記録のツールの直前のスナップショットを残す', async () => {
  const fx = makeFixture();
  const runRoot = tmp('noapproval');
  const sdk = createFakeSdk({
    userRole: () => 'はい',
    agent: async (ctx) => {
      const r = await ctx.tool(T('state'), {});
      assert.equal(r.isError, false, r.text);
      await ctx.tool('Bash', { command: 'echo x >> market/plugins/demo/plugin.json' }, { run: () => { fs.appendFileSync(path.join(ctx.options.cwd, 'market', 'plugins', 'demo', 'plugin.json'), 'x\n'); } });
      return '少し直しました。';
    },
  });
  const record = await runOuterOnce({
    loaded: fx.loaded, arm: 'with', runRoot, sandbox: false, query: sdk.query, convert: fakeConvert, maxExchanges: 3, fixturesDir: fx.fixturesDir,
    runStages: async () => ({ skipped: true, reason: '試験では動かさない' }),
  });
  assert.equal(record.stopped.reason, 'changed_without_approval');
  const snaps = record.items.filter((i) => i.kind === 'repo.snapshot');
  assert.deepEqual(snaps.map((s) => s.reason), ['tool:state', 'turn-end']);
  const call = record.toolEvents.find((e) => e.type === 'tool.call' && e.tool === 'state');
  assert.ok(snaps[0].seq < call.seq, '記録のツールの呼び出しより前の順番');
  assert.deepEqual(snaps[0].status, []);
  assert.equal(snaps[1].status.length, 1);
  const by = Object.fromEntries(record.grading.grades.map((g) => [g.id, g]));
  assert.equal(by['unchanged-before-approval'].ok, false);
  assert.match(by['unchanged-before-approval'].detail, /直すフォルダが変わった/);
  assert.equal(by['commit-scoped'].ok, false);
});

test('REQ-059 改善の模擬ユーザーの流れ：直すフォルダのマニフェストが .claude-plugin/ にあっても、1・2段目を動かし、元の版と直した後の版を読む。直下に移しても新しいフォルダに数えない', async () => {
  for (const moved of [false, true]) {
    const fx = makeFixture({ manifestAt: '.claude-plugin/plugin.json' });
    const staged = [];
    const sdk = createFakeSdk({
      userRole: () => 'はい',
      agent: async (ctx) => {
        const target = path.join(ctx.options.cwd, 'market', 'plugins', 'demo');
        await ctx.tool('Bash', { command: 'python3 skills/make-plugin/scripts/scaffold.py commit --plugin market/plugins/demo' }, {
          run: () => {
            if (moved) {
              // 生成プラグインの形にするとき：マニフェストを直下に移す
              git(target, ['mv', '.claude-plugin/plugin.json', 'plugin.json']);
              write(target, 'plugin.json', `${JSON.stringify({ name: 'demo', version: '0.2.0' })}\n`);
            } else {
              write(target, '.claude-plugin/plugin.json', `${JSON.stringify({ name: 'demo', version: '0.2.0' })}\n`);
            }
            git(target, ['add', '-A', '--', '.']);
            git(target, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'plugin-creator: demo を直した（0.1.0 → 0.2.0）', '--', '.']);
            return 'ok';
          },
        });
        return '直しました。';
      },
    });
    const record = await runOuterOnce({
      loaded: fx.loaded, arm: 'without', runRoot: tmp('claude-plugin'), sandbox: false, query: sdk.query, maxExchanges: 2, fixturesDir: fx.fixturesDir,
      runStages: async (dir) => {
        staged.push(dir);
        return { skipped: false, ok: true, stage1: { ok: true }, stage2: { ok: true } };
      },
    });
    assert.equal(record.stopped.reason, 'changed', `${moved}：${JSON.stringify(record.stopped)}`);
    assert.deepEqual(record.generated.plugins, []);
    assert.deepEqual(staged, [path.join(record.dirs.work, 'market', 'plugins', 'demo')], '直下に plugin.json がなくても、1・2段目を飛ばさない');
    assert.deepEqual([record.change.versionBefore, record.change.versionAfter], ['0.1.0', '0.2.0']);
    const by = Object.fromEntries(record.grading.grades.map((g) => [g.id, g]));
    assert.equal(by['no-new-folder'].ok, true, by['no-new-folder'].detail);
    assert.equal(by.stage1.ok, true, by.stage1.detail);
  }
});

/** 組み立ての見本の作業の定義の案と課題（outer-run.test.mjs の生成までたどる試験と同じもの） */
const SAMPLE_PARTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'creator', 'scaffold', 'sample', 'parts');
const SETTABLE = ITEMS.filter((i) => !i.computed && !i.rebuildOnly).map((i) => i.name);

test('REQ-057 REQ-059 改善の模擬ユーザーの流れ（腕 with）：本物の記録のツールで直す記録・確認・承認まで進め、承認の後にコミットすると changed で終わる', async () => {
  const fx = makeFixture();
  const sampleEval = JSON.parse(fs.readFileSync(path.join(SAMPLE_PARTS, 'files', 'tests', 'eval', 'T-01', 'eval.json'), 'utf8'));
  const approvalQuestion = 'よいと答えると、元のプラグインのフォルダのファイルを直し始めます。この内容で直してよいですか？';
  const sdk = createFakeSdk({
    userRole: ({ prompt }) => (prompt.includes('この内容で直してよいですか') ? 'この内容で直してよい' : 'デプロイのスキルを足してください'),
    agent: async (ctx) => {
      const work = ctx.options.cwd;
      await ctx.tool('Skill', { skill: 'plugin-creator:change-plugin' });
      const started = await ctx.tool(T('change'), { folder: 'market/plugins/demo', wants: ['ビルドのスキルを組み込みたい'] });
      assert.equal(started.isError, false, started.text);
      await ctx.ask([{ question: '組み込みたいスキルと、変えたいことを教えてください', header: '実物', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }]);
      const heard = await ctx.tool(T('progress'), { items: SETTABLE.map((item) => ({ item, status: '聞いた', quote: 'デプロイのスキルを足してください' })) });
      assert.equal(heard.isError, false, heard.text);
      const rec = await ctx.tool(T('record'), {
        knowledge: [{ kind: '合否の決め方', item: '合否の決め方', text: '週報に見出し「今週やったこと」があれば合格とする。', source: 'ヒアリングの答え', quote: 'デプロイのスキルを足してください', status: '決まった' }],
      });
      assert.equal(rec.isError, false, rec.text);
      const id = /K-\d+/.exec(rec.text)[0];
      const draft = path.join(work, '.plugin-creator-work', 'draft', 'task.json');
      fs.mkdirSync(path.dirname(draft), { recursive: true });
      fs.copyFileSync(path.join(SAMPLE_PARTS, 'task.json'), draft);
      const conf = await ctx.tool(T('confirm'), {
        knowledgeIds: [id],
        behavior: '週報を作る。',
        taskPath: '.plugin-creator-work/draft/task.json',
        evalTasks: [{ prompt: sampleEval.prompt, inputs: [{ path: 'tests/eval/T-01/inputs/memo.txt', provisional: true }], criteria: [id], settings: sampleEval.settings }],
        rebuild: { keep: ['できていたこと'], change: ['ビルドのルールのスキルを足す', '共通の土台を今の版に上げる'] },
        version: '0.2.0',
      });
      assert.equal(conf.isError, false, conf.text);
      await ctx.say('直す前の確認です。新しい版は 0.2.0、共通の土台を上げ、擬似の機器で試す課題を足します。');
      await ctx.ask([{ question: approvalQuestion, header: '承認', options: [{ label: 'まだ直したいところがある', description: '' }, { label: 'この内容で直してよい', description: '' }] }]);
      const gen = await ctx.tool(T('progress'), { stage: '生成', approvalQuote: 'この内容で直してよい' });
      assert.equal(gen.isError, false, gen.text);
      await ctx.tool('Bash', { command: 'python3 skills/make-plugin/scripts/scaffold.py commit --plugin market/plugins/demo' }, {
        run: () => {
          simulateChange({ targetDir: path.join(work, 'market', 'plugins', 'demo') }, fx);
          return 'ok';
        },
      });
      return '直しました。戻すときは git revert です。';
    },
  });
  const record = await runOuterOnce({
    loaded: fx.loaded, arm: 'with', runRoot: tmp('with-flow'), sandbox: false, query: sdk.query, convert: fakeConvert, maxExchanges: 2, fixturesDir: fx.fixturesDir,
    runStages: async () => ({ skipped: false, ok: true, stage1: { ok: true }, stage2: { ok: true } }),
  });
  assert.equal(record.stopped.reason, 'changed', JSON.stringify(record.stopped));
  assert.equal(record.exchanges, 0, '1 回の手番で直してコミットしたので、文章の返事は返さない');
  assert.equal(record.state.stage, 'generate');
  assert.equal(record.state.change.folder, fs.realpathSync(path.join(record.dirs.work, 'market', 'plugins', 'demo')));
  // スナップショット：記録のツールの呼び出しの直前と、問いに答える直前。承認の progress の直前は、まだ初めのまま
  const snaps = record.items.filter((i) => i.kind === 'repo.snapshot');
  const approvalCall = record.toolEvents.find((e) => e.type === 'tool.call' && e.tool === 'progress' && e.args?.stage === '生成');
  const beforeApproval = snaps.filter((s) => s.seq < approvalCall.seq);
  assert.ok(beforeApproval.some((s) => s.reason === 'tool:change') && beforeApproval.some((s) => s.reason === 'question'), JSON.stringify(beforeApproval.map((s) => s.reason)));
  assert.ok(beforeApproval.every((s) => s.head === record.change.baseCommit && s.status.length === 0));
  assert.equal(snaps.at(-1).reason, 'turn-end');
  assert.equal(snaps.at(-1).head, record.change.headCommit);
  const by = Object.fromEntries(record.grading.grades.map((g) => [g.id, g]));
  for (const id of ['change-skill-used', 'unchanged-before-approval', 'confirm-contents', 'version-approved', 'commit-scoped', 'not-pushed', 'explained']) {
    assert.equal(by[id].ok, true, `${id}：${by[id].detail}`);
  }
});

// ---- 本物の改善の模擬ユーザー（tests/dev-eval/personas/edl-change と fixtures/market.tar.gz）で、作業フォルダを置けること ----------------

const EDL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'personas', 'edl-change');
const MARKET = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'market.tar.gz');

test('REQ-059 本物の題材：edl-change の作業フォルダを置くと、直すフォルダは始める前からあるプラグインに入り、決まりの一覧・課題・ユーザーのスキルが読める', { skip: !fs.existsSync(MARKET) || !fs.existsSync(path.join(EDL, 'persona.json')) ? '題材か模擬ユーザーがない' : false }, async () => {
  const { loadPersona } = await import('../personas/validate.mjs');
  const { preexistingPlugins } = await import('./outer-run.mjs');
  const { buildSystemPrompt } = await import('./user-role.mjs');
  const loaded = await loadPersona(EDL);
  const runDir = tmp('edl');
  const workDir = path.join(runDir, 'work');
  fs.mkdirSync(workDir);
  placePersonaFiles(workDir, loaded.files.filter((f) => f.role !== 'repo'));
  const placed = placeWorkspace(workDir, loaded.persona, loaded.dir, { originDir: path.join(runDir, 'origin.git') });
  const baseline = takeBaseline(runDir, { workDir, persona: loaded.persona, originDir: placed.originDir });
  assert.deepEqual(preexistingPlugins(runDir, workDir), [loaded.persona.target]);
  assert.equal(baseline.knowledgeBefore.length, loaded.persona.expect.carriedMax);
  assert.deepEqual(baseline.stagedBefore, loaded.persona.workspace.repo.staged.map((s) => s.path));
  assert.ok(baseline.evalBefore.length >= 1);
  assert.ok(baseline.userSkillNames.length >= 2);
  assert.deepEqual(takeSnapshot({ workDir, persona: loaded.persona, reason: 'start' }).status, []);
  // ユーザー役の「持っているファイル」には、題材に初めから置いたファイルを示さない（ナレッジの説明で場所に触れるのはよい）
  const system = buildSystemPrompt(loaded.persona);
  const held = system.slice(system.indexOf('あなたが持っているファイル'), system.indexOf('あなたが知っていること'));
  for (const f of loaded.persona.files) assert.equal(held.includes(f.place), f.role !== 'repo', f.place);
});
