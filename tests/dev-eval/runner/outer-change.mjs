// 改善・設計変更（change-plugin）の外側の EVAL の作業フォルダと、直すプラグインのリポジトリの記録（testing.md 6章。改善の模擬ユーザー）。
//   placeWorkspace     模擬ユーザー（kind が change）の題材のリポジトリを作業フォルダに置き、初めのコミット・git add だけの変更・origin を作る
//   takeBaseline       始める前の記録（実行のフォルダの change-baseline.json。続きから始めるときは readBaseline で読む）
//   takeSnapshot       その時点の HEAD と、直すプラグインのフォルダの git status（承認の前に変わっていないかを見る材料）
//   changeEnded        手番の終わりに、会話を終えるか（直した・承認なしに直した・新しいフォルダに作った）
//   collectChangeRepo  採点の材料（終わった後のリポジトリと、直したプラグインのファイル）。採点（outer-grade-change.mjs）はファイルを読まない
// git は、試験の仕組みの外の設定に左右されないよう、GIT_* の環境変数を外し、全体とシステムの設定を読まない。
// ファイルの場所は、断りのないかぎり作業フォルダからの相対の POSIX パス（区切りは /）。

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MANIFEST_PLACES } from '../../../com.github.copilot/extensions/plugin-creator/change.mjs';
import { collectGeneratedFiles } from './outer-grade.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 題材（tar.gz）の置き場所。persona.json の workspace.repo.fixture は、ここからの場所 */
export const FIXTURES_DIR = path.resolve(HERE, '..', 'fixtures');
/** 始める前の記録の名前（実行のフォルダに置く。作業フォルダの外） */
export const CHANGE_BASELINE_FILE = 'change-baseline.json';
/** 作業用の一時フォルダの名前（クリエイターが作り、終わったら消す。BLUEPRINT D8） */
export const WORK_DIR_NAME = '.plugin-creator-work';
/** 題材のリポジトリの初めのコミットの書き手（リポジトリの設定に入れる。サンドボックスの中からは .git/config を書けないが、読める） */
export const REPO_USER = Object.freeze({ name: 'dev-user', email: 'dev-user@example.com' });
const INITIAL_MESSAGE = '初めの状態';
const BRANCH = 'main';

const toPosix = (p) => p.split(path.sep).join('/');
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

// ---- git ------------------------------------------------------------------------------------------------

/**
 * git の環境変数。GIT_OPTIONAL_LOCKS=0：status などが索引を書き直さない（クリエイターのコマンドと同時に動いても、
 * index.lock でクリエイターの git を邪魔しないため）
 */
function gitEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...extra };
}

/** git を動かす。失敗したら、allowFail でなければ投げる。日本語のファイル名を引用符で囲ませない（core.quotepath=off） */
export function git(cwd, args, { env = {}, allowFail = false } = {}) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', '-C', cwd, ...args], { encoding: 'utf8', env: gitEnv(env), timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} が失敗しました（${cwd}）：${(r.stderr || r.error?.message || '').trim()}`);
  return r;
}

const lines = (text) => String(text ?? '').split('\n').filter((l) => l !== '');

/** ベアリポジトリの refs（{ 名前: コミット }）。ないときは null */
export function refsOf(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const r = git(dir, ['for-each-ref', '--format=%(refname) %(objectname)'], { allowFail: true });
  if (r.status !== 0) return null;
  return Object.fromEntries(lines(r.stdout).map((l) => l.split(' ')));
}

/** git add しただけのファイル（リポジトリの根からの場所）。allowFail なら、見られないときは空 */
function stagedFiles(repoDir, { allowFail = false } = {}) {
  const r = git(repoDir, ['diff', '--cached', '--name-only'], { allowFail });
  return r.status === 0 ? lines(r.stdout).sort() : [];
}

// ---- 場所 ---------------------------------------------------------------------------------------------------

/** base の中の相対の場所を絶対の場所にする。外に出るものは断る（where は base の呼び名。断る文に入れる） */
function inside(base, rel, label, where = '作業フォルダ') {
  const target = path.resolve(base, ...String(rel).split('/'));
  const relative = path.relative(base, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${label}が${where}の外です：${rel}`);
  return target;
}

/** 改善の模擬ユーザーの場所。repoDir・targetDir・userSkillsDir は絶対、targetInRepo はリポジトリの根からの相対（直下なら空） */
export function changePaths(workDir, persona) {
  const repoPlace = persona.workspace?.repo?.place;
  if (!repoPlace || !persona.target) throw new Error('改善の模擬ユーザーに workspace.repo.place と target が要ります。');
  const repoDir = inside(workDir, repoPlace, '題材のリポジトリの場所');
  const targetDir = inside(workDir, persona.target, '直すプラグインのフォルダ');
  const targetInRepo = toPosix(path.relative(repoDir, targetDir));
  if (targetInRepo.startsWith('..')) throw new Error(`直すプラグインのフォルダ（${persona.target}）が、題材のリポジトリ（${repoPlace}）の外です。`);
  const userSkills = persona.expect?.userSkills;
  return { repoDir, targetDir, targetInRepo, userSkillsDir: userSkills ? inside(workDir, userSkills, 'ユーザーのスキルの場所') : null };
}

// ---- 作業フォルダを置く --------------------------------------------------------------------------------------

/**
 * 題材のリポジトリを作業フォルダに置く（模擬ユーザーの kind が change のとき。placePersonaFiles の後に呼ぶ）。
 *   1. 題材（tests/dev-eval/fixtures/<fixture> の tar.gz）を workspace.repo.place に展開する
 *   2. role が repo のファイル（作った後にユーザーが書き足したもの）を置く
 *   3. git init。書き手はリポジトリの設定に入れ、日時を commitDate に固定して全体をコミットする（毎回同じコミットの番号になる）
 *   4. staged の変更（ファイルの終わりに文字を足す）を git add だけしておく
 *   5. origin が真なら、実行のフォルダの下にベアリポジトリを作り、origin にして初めのコミットを送っておく（push していないかを見るため）
 * @param {string} workDir 作業フォルダ
 * @param {object} persona persona.json の中身
 * @param {string} personaDir 模擬ユーザーのフォルダ（files[].src の元）
 * @param {{ fixturesDir?: string, originDir?: string }} [options] originDir の既定は、作業フォルダの隣の origin.git（実行のフォルダの下）
 * @returns {{ repoDir: string, targetDir: string, baseCommit: string, originDir: string|null }}
 */
export function placeWorkspace(workDir, persona, personaDir, { fixturesDir = FIXTURES_DIR, originDir } = {}) {
  const spec = persona.workspace?.repo;
  if (!spec?.fixture) throw new Error('改善の模擬ユーザーに workspace.repo.fixture がありません。');
  const { repoDir, targetDir } = changePaths(workDir, persona);
  const fixture = inside(fixturesDir, spec.fixture, '題材の tar.gz の場所', `題材のフォルダ（${fixturesDir}）`);
  if (!fs.existsSync(fixture)) throw new Error(`題材がありません：${fixture}（tests/dev-eval/fixtures/make_market.sh で作ります）。`);
  fs.mkdirSync(repoDir, { recursive: true });
  const untar = spawnSync('tar', ['-xzf', fixture, '-C', repoDir, '--no-same-owner'], { encoding: 'utf8' });
  if (untar.status !== 0) throw new Error(`題材を展開できませんでした（${fixture}）：${(untar.stderr || untar.error?.message || '').trim()}`);
  for (const f of persona.files ?? []) {
    if (f.role !== 'repo') continue;
    const target = inside(workDir, f.place, 'role が repo のファイルの置き場所');
    if (toPosix(path.relative(repoDir, target)).startsWith('..')) throw new Error(`role が repo のファイルは、題材のリポジトリの中に置きます：${f.place}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(inside(personaDir, f.src, 'role が repo のファイルの元', `模擬ユーザーのフォルダ（${personaDir}）`), target);
  }
  git(repoDir, ['init', '-q', '--template=', '-b', BRANCH]);
  git(repoDir, ['config', 'user.name', REPO_USER.name]);
  git(repoDir, ['config', 'user.email', REPO_USER.email]);
  git(repoDir, ['add', '-A']);
  const date = spec.commitDate ?? '2026-10-01T00:00:00+09:00';
  git(repoDir, ['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', INITIAL_MESSAGE], { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  const baseCommit = git(repoDir, ['rev-parse', 'HEAD']).stdout.trim();
  let origin = null;
  if (spec.origin) {
    origin = path.resolve(originDir ?? path.join(path.dirname(workDir), 'origin.git'));
    fs.rmSync(origin, { recursive: true, force: true });
    fs.mkdirSync(origin, { recursive: true });
    git(origin, ['init', '-q', '--bare', '--template=']);
    git(repoDir, ['remote', 'add', 'origin', origin]);
    git(repoDir, ['push', '-q', '-u', 'origin', BRANCH]);
  }
  for (const s of spec.staged ?? []) {
    const file = inside(repoDir, s.path, 'staged の場所', `題材のリポジトリ（${spec.place}）`);
    if (!toPosix(path.relative(targetDir, file)).startsWith('..')) throw new Error(`staged は直すプラグインのフォルダの外に置きます：${s.path}`);
    fs.appendFileSync(file, String(s.append ?? ''));
    git(repoDir, ['add', '--', toPosix(path.relative(repoDir, file))]);
  }
  return { repoDir, targetDir, baseCommit, originDir: origin };
}

// ---- 読み取りの道具 -----------------------------------------------------------------------------------------

/**
 * フォルダの中のファイルの sha256（{ 場所: sha256 }。場所は rel の基準からの相対）。.git は見ない。
 * シンボリックリンクは「link:<指す先>」として記録する（たどらない）。skip(相対の場所) が真のフォルダ・ファイルは見ない
 */
export function hashTree(dir, { base = dir, skip = () => false } = {}) {
  const out = {};
  if (!dir || !fs.existsSync(dir)) return out;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = toPosix(path.relative(base, full));
      if (entry.name === '.git' || skip(rel, entry)) continue;
      if (entry.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(full)}`;
      else if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out[rel] = sha256(fs.readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** SKILL.md のフロントマターの name（なければフォルダの名前） */
function skillNameOf(skillFile) {
  try {
    const text = fs.readFileSync(skillFile, 'utf8');
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
    const value = /^name:\s*(.+?)\s*$/m.exec(front)?.[1]?.replace(/^["']|["']$/g, '');
    return value || path.basename(path.dirname(skillFile));
  } catch {
    return path.basename(path.dirname(skillFile));
  }
}

/** <dir>/*\/SKILL.md のスキルの名前（{ dir: フォルダの名前, name }） */
export function skillNames(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
    .map((e) => ({ dir: e.name, name: skillNameOf(path.join(dir, e.name, 'SKILL.md')) }))
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

/** 直すプラグインの EVAL の課題（tests/eval/<課題>/eval.json）。files は課題のフォルダからの相対の場所 */
function evalTasksOf(targetDir) {
  const root = path.join(targetDir, 'tests', 'eval');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'eval.json')))
    .map((e) => {
      const dir = path.join(root, e.name);
      const json = readJson(path.join(dir, 'eval.json'));
      return { dir: e.name, json, prompt: json?.prompt ?? null, files: Object.keys(hashTree(dir)).sort() };
    })
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * 直すプラグインのマニフェスト（plugin.json）の絶対パス。エクステンションの readPluginForChange と同じ順（直下 → .plugin/ →
 * .github/plugin/ → .claude-plugin/）に探す（BLUEPRINT D29・I11）。なければ null
 */
export function manifestOf(dir) {
  for (const rel of MANIFEST_PLACES) {
    const file = path.join(dir, ...rel.split('/'));
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // ない
    }
  }
  return null;
}

/** 直すプラグインの、決まりの一覧・外した決まり・マニフェスト（plugin.json） */
function pluginFacts(targetDir) {
  const found = manifestOf(targetDir);
  const manifest = found ? readJson(found) : null;
  return {
    version: typeof manifest?.version === 'string' ? manifest.version : null,
    name: typeof manifest?.name === 'string' ? manifest.name : null,
    knowledge: readJson(path.join(targetDir, 'tests', 'knowledge.json')),
    removed: readJson(path.join(targetDir, 'tests', 'knowledge-removed.json')),
  };
}

/** 作業フォルダの、直すプラグインのフォルダの外のファイル（.git は見ない） */
function outsideFiles(workDir, targetDir) {
  const target = toPosix(path.relative(workDir, targetDir));
  return hashTree(workDir, { skip: (rel) => rel === target });
}

// ---- 始める前の記録 ------------------------------------------------------------------------------------------

/**
 * 始める前の記録を、実行のフォルダの change-baseline.json に書いて返す（placeWorkspace の後、会話を始める前に呼ぶ）。
 * 中身：初めのコミット、git add だけのファイル、元の版と名前、元の決まりの一覧と外した決まり、元の課題、直すプラグインのフォルダと
 * ユーザーのスキルのファイルごとの sha256、直すプラグインのフォルダの外のファイルの sha256、ユーザーのスキルの名前、origin の refs。
 */
export function takeBaseline(runDir, { workDir, persona, originDir = null, now = () => Date.now() }) {
  const { repoDir, targetDir, targetInRepo, userSkillsDir } = changePaths(workDir, persona);
  const facts = pluginFacts(targetDir);
  const baseline = {
    schema: 'change-baseline/1',
    at: new Date(now()).toISOString(),
    repo: persona.workspace.repo.place,
    target: persona.target,
    targetInRepo,
    baseCommit: git(repoDir, ['rev-parse', 'HEAD']).stdout.trim(),
    stagedBefore: stagedFiles(repoDir),
    pluginName: facts.name,
    versionBefore: facts.version,
    knowledgeBefore: facts.knowledge,
    removedBefore: facts.removed,
    evalBefore: evalTasksOf(targetDir).map((t) => ({ dir: t.dir, prompt: t.prompt })),
    targetFiles: hashTree(targetDir, { skip: (rel) => rel === WORK_DIR_NAME }),
    userSkillFiles: userSkillsDir ? hashTree(userSkillsDir, { base: workDir }) : {},
    userSkillNames: skillNames(userSkillsDir).map((s) => s.name),
    outsideFiles: outsideFiles(workDir, targetDir),
    originDir,
    originRefs: refsOf(originDir),
  };
  fs.writeFileSync(path.join(runDir, CHANGE_BASELINE_FILE), `${JSON.stringify(baseline, null, 2)}\n`);
  return baseline;
}

/** 前に書いた始める前の記録を読む（続きから始めるとき）。なければ断る */
export function readBaseline(runDir) {
  const baseline = readJson(path.join(runDir, CHANGE_BASELINE_FILE));
  if (!baseline) throw new Error(`始める前の記録（${CHANGE_BASELINE_FILE}）が実行のフォルダにありません（${runDir}）。`);
  return baseline;
}

// ---- 途中の記録と終わりの見分け --------------------------------------------------------------------------

/**
 * その時点の HEAD と、直すプラグインのフォルダの git status（作業用の一時フォルダを除く。まだ git に入れていないファイルも出す）。
 * @returns {{ at: string, reason: string, head: string|null, status: string[]|null, error?: string }}
 */
export function takeSnapshot({ workDir, persona, reason, now = () => Date.now() }) {
  const at = new Date(now()).toISOString();
  try {
    const { targetDir } = changePaths(workDir, persona);
    const head = git(targetDir, ['rev-parse', 'HEAD']).stdout.trim();
    const status = lines(git(targetDir, ['status', '--porcelain=v1', '--untracked-files=all', '--', '.', `:(exclude)${WORK_DIR_NAME}`]).stdout);
    return { at, reason, head, status };
  } catch (error) {
    return { at, reason, head: null, status: null, error: String(error?.message ?? error).slice(0, 300) };
  }
}

/**
 * 手番の終わりに、会話を終えるか。
 *   generated_new_folder      新しいフォルダにプラグインができた（REQ-059 の不合格）
 *   changed_without_approval  承認（段階「生成」）の記録がないのに、HEAD が進んだか、直すプラグインのフォルダが変わった
 *   changed                   承認の後に HEAD が進み、直すプラグインのフォルダに、コミットしていない変更がない
 *   null                      続ける
 * @param {{ baseline: object, snapshot: object, approved: boolean, newPlugins?: string[] }} args
 */
export function changeEnded({ baseline, snapshot, approved, newPlugins = [] }) {
  if (newPlugins.length > 0) return 'generated_new_folder';
  if (!snapshot || snapshot.head === null || snapshot.head === undefined) return null;
  const moved = snapshot.head !== baseline.baseCommit;
  const dirty = (snapshot.status ?? []).length > 0;
  if (!approved) return moved || dirty ? 'changed_without_approval' : null;
  return moved && !dirty ? 'changed' : null;
}

// ---- 終わった後の記録 ---------------------------------------------------------------------------------------

/** git diff -U0 の出力から、ファイルごとの足した行を取り出す（{ 場所: 足した行をつないだ文字 }） */
export function parseAddedLines(diffText) {
  const out = new Map();
  let file = null;
  let inHunk = false;
  for (const line of String(diffText ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = null;
      inHunk = false;
    } else if (!inHunk && line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? null : line.slice(4).replace(/^b\//, '');
    } else if (line.startsWith('@@')) {
      inHunk = true;
    } else if (inHunk && file !== null && line.startsWith('+')) {
      out.set(file, [...(out.get(file) ?? []), line.slice(1)]);
    }
  }
  return Object.fromEntries([...out].map(([f, added]) => [f, added.join('\n')]));
}

/** 作業フォルダの中に残った作業用の一時フォルダ（.git と node_modules の中は見ない） */
function leftoverWorkDirs(workDir) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth < 0) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink() || e.name === '.git' || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.name === WORK_DIR_NAME) found.push(toPosix(path.relative(workDir, full)));
      else walk(full, depth - 1);
    }
  };
  walk(workDir, 6);
  return found.sort();
}

/**
 * 採点の材料を集める（会話が終わった後、1・2段目を動かす前に呼ぶ。試験の結果のファイルが混ざらないように）。
 * @param {{ workDir: string, persona: object, baseline: object, newPlugins?: string[] }} args newPlugins は新しくできたプラグインのフォルダ（作業フォルダからの相対）
 */
export function collectChangeRepo({ workDir, persona, baseline, newPlugins = [] }) {
  const { repoDir, targetDir, userSkillsDir } = changePaths(workDir, persona);
  const head = git(repoDir, ['rev-parse', 'HEAD'], { allowFail: true }).stdout.trim() || null;
  const base = baseline.baseCommit;
  const commits = head && head !== base
    ? lines(git(repoDir, ['log', '--reverse', '--format=%H%x09%P%x09%s', `${base}..HEAD`], { allowFail: true }).stdout).map((l) => {
        const [commit, parents, ...subject] = l.split('\t');
        return { commit, parents: parents ? parents.split(' ') : [], subject: subject.join('\t') };
      })
    : [];
  const diffFiles = head ? lines(git(repoDir, ['diff', '--name-only', '--no-renames', base, 'HEAD'], { allowFail: true }).stdout).sort() : [];
  const exists = fs.existsSync(targetDir);
  const diffText = head && exists ? git(targetDir, ['diff', '--relative', '--no-color', '--no-ext-diff', '--no-renames', '-U0', base, 'HEAD', '--', '.'], { allowFail: true }).stdout : '';
  const addedByFile = parseAddedLines(diffText);
  const added = Object.entries(addedByFile).map(([rel, text]) => {
    const full = path.join(targetDir, ...rel.split('/'));
    let hash = null;
    try {
      hash = fs.statSync(full).isFile() ? sha256(fs.readFileSync(full)) : null;
    } catch {
      hash = null;
    }
    return { rel, text, sha256: hash };
  });
  const after = exists ? pluginFacts(targetDir) : { version: null, name: null, knowledge: null, removed: null };
  const snapshot = takeSnapshot({ workDir, persona, reason: 'end' });
  return {
    baseline,
    headCommit: head,
    commits,
    diffFiles,
    stagedAfter: stagedFiles(repoDir, { allowFail: true }),
    statusAfter: snapshot.status,
    tagsAtHead: head ? lines(git(repoDir, ['tag', '--points-at', 'HEAD'], { allowFail: true }).stdout).sort() : [],
    pluginNameAfter: after.name,
    versionAfter: after.version,
    knowledgeAfter: after.knowledge,
    removedAfter: after.removed,
    added,
    targetFiles: exists ? collectGeneratedFiles(targetDir).filter((f) => f.rel !== WORK_DIR_NAME && !f.rel.startsWith(`${WORK_DIR_NAME}/`)) : [],
    targetSkillNames: exists ? skillNames(path.join(targetDir, 'skills')) : [],
    evalAfter: exists ? evalTasksOf(targetDir) : [],
    userSkillFilesAfter: userSkillsDir ? hashTree(userSkillsDir, { base: workDir }) : {},
    outsideFilesAfter: outsideFiles(workDir, targetDir),
    leftoverWork: leftoverWorkDirs(workDir),
    originRefsAfter: refsOf(baseline.originDir),
    newPlugins,
  };
}

/** 記録（record.json）の change に残す要約（BLUEPRINT C6d）。ファイルの中身は残さない */
export function changeRecordOf(repo, items = []) {
  const b = repo.baseline;
  return {
    baseCommit: b.baseCommit,
    headCommit: repo.headCommit,
    commits: repo.commits,
    diffFiles: repo.diffFiles,
    stagedBefore: b.stagedBefore,
    stagedAfter: repo.stagedAfter,
    statusAfter: repo.statusAfter,
    tagsAtHead: repo.tagsAtHead,
    versionBefore: b.versionBefore,
    versionAfter: repo.versionAfter,
    knowledgeBefore: b.knowledgeBefore,
    knowledgeAfter: repo.knowledgeAfter,
    removedAfter: repo.removedAfter,
    leftoverWork: repo.leftoverWork,
    snapshots: items.filter((i) => i.kind === 'repo.snapshot').map(({ seq, at, reason, head, status, error }) => ({ seq, at, reason, head, status, ...(error ? { error } : {}) })),
  };
}
