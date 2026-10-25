import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIMITS } from './constants.mjs';

// gh（GitHub の公式のコマンド）を呼ぶ部品と、起票できるかの確かめ（4.11）。

// マニフェストの repository（URL）から OWNER/REPO を取り出す。GitHub の URL でなければ null。
export function parseGithubRepo(value) {
  const raw = typeof value === 'string' ? value : value && typeof value === 'object' ? value.url : null;
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/^git\+/, '');
  let m = /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?\/?(?:[?#].*)?$/i.exec(s);
  if (!m) m = /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(s);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

// 短い子プロセスを、シェルを通さずに動かす。引数は配列、入力は標準入力で渡す。
// 時間の上限（時計は clock）を超えたら止める。返り値は決して例外にならない。
// { code, signal, stdout, stderr, timedOut, spawnError }
export function runCommand({ command, args, input = null, timeoutMs, clock, env = process.env, cwd }) {
  return new Promise((resolve) => {
    let child;
    let done = false;
    let timer = null;
    let stdout = '';
    let stderr = '';
    const finish = (result) => {
      if (done) return;
      done = true;
      if (timer !== null) clock.clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr, timedOut: false, spawnError: null, ...result });
    };
    try {
      child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env, cwd });
    } catch (e) {
      finish({ spawnError: e.code ?? String(e.message ?? e) });
      return;
    }
    timer = clock.setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // すでに終わっている
      }
      finish({ timedOut: true });
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      if (stdout.length < 5_000_000) stdout += d;
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < 1_000_000) stderr += d;
    });
    child.on('error', (e) => finish({ spawnError: e.code ?? String(e.message ?? e) }));
    child.on('close', (code, signal) => finish({ code, signal }));
    child.stdin.on('error', () => {
      // 相手が先に終わったときの書き込みの失敗は、終わりの結果で見る
    });
    if (input !== null) child.stdin.write(input);
    child.stdin.end();
  });
}

const STEP_PUBLISH = 'GitHub にこのプラグインを公開する。';
// 入れ方によって、書き換えが反映される時期が違う。手元のフォルダから入れたものは、コピーされず、Copilot CLI を起動し直すか
// /clear で新しい会話を始めると反映される（エクステンションは起動のたびに plugin.json を読み直す。V1 の確かめ）。
// GitHub などから入れたものは、直した plugin.json を GitHub に送り、アンインストールしてから、もう一度インストールすると読まれる（コピーの動きは V1 では確かめていない）。
// 画面に出る文なので、「セッション」のような説明のない言葉や、「入れ直す」のような比喩は使わない（REQ-025）。
const STEP_REPOSITORY =
  'プラグインの設定ファイル（plugin.json）の repository に、公開したリポジトリの GitHub の URL を書く。そのあと、手元のフォルダからインストールしたときは、Copilot CLI を終了して起動し直すか、/clear で新しい会話を始める。GitHub などからインストールしたときは、直した plugin.json を GitHub に送り、このプラグインをアンインストールしてから、もう一度インストールする。';
const STEP_GH = 'gh（GitHub の公式のコマンド）を入れて、gh auth login でログインする。';
const STEP_LOGIN = 'gh auth login でログインする。';

const REASON_TEXT = {
  no_repository: 'このプラグインの設定ファイル（plugin.json）に repository が書かれていません。',
  not_github: 'plugin.json の repository が GitHub の URL ではありません。',
  no_gh: 'gh（GitHub の公式のコマンド）が見つかりません。',
  not_logged_in: 'gh でログインしていません。',
};

// 起票できるかを確かめる。
// 返り値：{ ok, reason, code, steps, repo }
//   reason：画面にそのまま出せる平易な日本語の文（起票できるなら null）
//   code：no_repository | not_github | no_gh | not_logged_in | null
//   steps：起票できるようにするための手順（平易な日本語の文の配列）
export async function checkCanFile({ pluginRoot, ghCommand, clock }) {
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(join(pluginRoot, 'plugin.json'), 'utf8'));
  } catch {
    manifest = null;
  }
  const rawRepo = manifest ? manifest.repository : undefined;
  const hasRepo = typeof rawRepo === 'string' ? rawRepo.trim() !== '' : Boolean(rawRepo && rawRepo.url);
  const repo = hasRepo ? parseGithubRepo(rawRepo) : null;

  let ghMissing = false;
  let notLoggedIn = false;
  const v = await runCommand({ command: ghCommand, args: ['--version'], timeoutMs: LIMITS.CALL_TIMEOUT_MS, clock });
  if (v.spawnError || v.timedOut || v.code !== 0) {
    ghMissing = true;
  } else {
    const a = await runCommand({ command: ghCommand, args: ['auth', 'status'], timeoutMs: LIMITS.CALL_TIMEOUT_MS, clock });
    if (a.spawnError || a.timedOut || a.code !== 0) notLoggedIn = true;
  }

  const steps = [];
  let code = null;
  if (!hasRepo) {
    code = 'no_repository';
    steps.push(STEP_PUBLISH, STEP_REPOSITORY);
  } else if (!repo) {
    code = 'not_github';
    steps.push(STEP_PUBLISH, STEP_REPOSITORY);
  }
  if (ghMissing) {
    code ??= 'no_gh';
    steps.push(STEP_GH);
  } else if (notLoggedIn) {
    code ??= 'not_logged_in';
    steps.push(STEP_LOGIN);
  }
  return { ok: code === null, reason: code ? REASON_TEXT[code] : null, code, steps, repo };
}
