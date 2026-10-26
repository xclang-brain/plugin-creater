// 外側の EVAL の入口（testing.md 3章の手順2〜3、6章）。クリエイターを置き換えて、模擬ユーザー（ユーザー役）と話させ、できた生成プラグインを採点する。
// 実際のモデルを使う。統括がユーザーの承認をとってから動かすこと（RESUME.md、common.md）。回数と費用の見込みは --dry-run で出す。
//
// 使い方（リポジトリの根から。事前に cd tests/dev-eval && npm install）:
//   node tests/dev-eval/runner/outer.mjs --persona <模擬ユーザーのフォルダ>… [--heldout] [--style 名前]… [--all-styles]
//        [--arms with,control,without] [--models claude-opus-5-5,claude-haiku-5-5] [--runs 1]
//        [--creator <クリエイター（Copilot CLI 向け）のフォルダ。既定はこのリポジトリの直下>] [--control <対照のクリエイターのフォルダ>]
//        [--converted <置き換えた版>] [--inner] [--out <結果のフォルダ>] [--no-sandbox] [--dry-run]
//        [--max-exchanges 150] [--user-model <ID>] [--timeout-minutes 60]
//   --heldout            tests/dev-eval/heldout/ の中の見ない模擬ユーザーを、実行のときに読み込んで足す（中身は人が読まない決まり。結果の要約は伏せ字にする）
//   --arms               with＝クリエイター、control＝対照のクリエイター（大まかな質問しかしない）、without＝何も読み込まない（比べるため）。既定は with
//   --models             クリエイターのモデル。既定は claude-opus-5-5（思考力の高いモデル）。Claude Haiku 5.5 でも回すなら、コンマで足す
//   --inner              できた生成プラグインに内側の EVAL（inner.mjs）も動かす（プラグインあり・なしの比べ合い。時間と費用が増える）
//   サンドボックス（bubblewrap、socat）が既定で要る。ないときは始めずに断る。--no-sandbox で外せる（結果に警告が残る）。
//   終了コード：0 最後まで動いた（点数が低くても 0）、1 途中で止まった（利用枠の上限、中断）、2 始められなかった。
//   標準出力は結果の要約の JSON、進み具合は標準エラー出力。結果は <out>/outer-report.json に、実行が 1 つ終わるたびに書き直す。
//   --inner-runs <n>     内側の EVAL の、あり・なしそれぞれの回数（既定 1）
//   改善の模擬ユーザー（persona.json の kind が change。testing.md 6章）は、題材のリポジトリの直すフォルダを直させ、outer-grade-change.mjs で採点する
//   （outer-run.mjs が模擬ユーザーの種類で選ぶ）。
//
// 開発者が答える形（testing.md 6.7）。ユーザー役の AI の代わりに、開発者がクリエイターの問いに答える:
//   node tests/dev-eval/runner/outer.mjs --human --request-file <最初の依頼の文のファイル> [--relay <中継のフォルダ。既定は <out>/relay>]
//        [--file <開発者のファイル>[=<作業フォルダでの置き場所>]]… [--models <1 つ>] [--inner] [--inner-runs 1] [--out …] [--no-sandbox] [--dry-run]
//   --request-file       開発者が書いた最初の依頼の文（UTF-8 の空でない文字）
//   --file               開発者のファイルを、作業フォルダに写す（置き場所の既定はファイルの名前。絶対の場所と「..」は使えない）
//   --persona・--heldout・--style・--all-styles・--user-model は使えない。--arms は with だけ、--runs は 1 だけ、--models は 1 つだけ。
//   内側の EVAL（--inner）は、生成プラグインに入った課題で動かし、エージェントの問いには決まった返事を返す（開発者には聞かない）。結果は点数に入れず、別に示す。
//   統括（開発者と話す Claude Code のセッション）の手順:
//     1. このコマンドを、統括のコマンドの時間の上限に縛られない形（裏で動かす）で始める。始まると、標準エラー出力に
//        {"phase":"human-ready","relayDir":…,"out":…,"pid":…} の 1 行が出て、中継のフォルダの status.json が starting になる。
//        この 1 行が出たか、コマンドが終わった（始められなかった。標準出力に {"ok":false,…}）かを見てから、2 に進む。
//        この 1 行の後に始められなかったときは、status.json が stopped（result.reason が failed）になる。
//     2. node tests/dev-eval/runner/human-relay.mjs wait --relay <中継のフォルダ> --timeout-seconds <統括のコマンドの時間の上限より短く>
//        で、問いを待つ（終了コード 0 で問いの JSON が出る。5 は時間切れなので、もう一度 wait する）。
//     3. 問いと、問いの前の文（notes）を言い換えずに開発者に示し、答えを変えずに
//        node tests/dev-eval/runner/human-relay.mjs answer --relay <中継のフォルダ> --id <id> --text <答え> で返す。2 に戻る。
//        答えのファイルは、じかに書かない（answer のコマンドだけで書く）。
//        問いの JSON に images があれば、その画像（path）を問いといっしょに開発者に送る。開発者は、試験の容器の中にしかない
//        画面の URL（http://127.0.0.1:…）やファイルを開けないためである。imageErrors があれば、写せなかったものと理由も示す。
//     4. wait が終了コード 3（終わった）で返ったら、<out>/outer-report.json と status.json の result を見る。終わりの状態は、
//        記録と outer-report.json を書き終えてから書く。中断の後も、採点が終わるまでは終わりにならない（phase が stopping）。
//        4（プロセスがない）で返ったら、結果は書かれていない。heartbeatAt が古くなった（既定 10 分）ときにも 4 になる。
//     コンパクションの後は、このコマンドを始め直さず、status.json と wait から続ける。
//     このコマンドと wait・answer・status は、Claude Code のサンドボックスの中でも外でも動く（プロセスの番号の空間が違うときは、
//     番号ではなく heartbeatAt でプロセスの有無を見る）。
//
// 止まった実行を続きから始める（開発者が答える形だけ）。wait が 4（プロセスがない）で返り、実行のフォルダが残っているとき:
//   node tests/dev-eval/runner/outer.mjs --human --resume <前の実行のフォルダ（<out>/runs/outer-human-with-…）> --resume-prompt-file <ファイル>
//        --out <前の実行の結果のフォルダ> [--relay <前の中継のフォルダ>] [--models <前と同じ 1 つ>] [--inner] [--inner-runs 1] [--converted …] [--no-sandbox] [--dry-run]
//   --resume             前の実行のフォルダ。作業フォルダ・クリエイターの記録（copilot-home）・セッションの記録（agent-home）をそのまま使い、
//                        クリエイターの同じセッションを続ける（セッションの番号は agent-home/.claude/projects/ の記録から探す）
//   --resume-prompt-file 続けるときに、クリエイターへ最初に送る発言（UTF-8 の空でない文字）。止まったときに答えを待っていた問いがあれば、
//                        統括は、その問いと開発者の答えをこの発言に書く（Claude Code は、答えのないまま止まった質問のツールの呼び出しを捨てることがある）
//   --request-file と --file は使えない（最初の依頼の文と開発者のファイルは、前の実行のもの）。--out は要る。
//   中継のフォルダの問いと答えは消さない。答えのないまま残った問いには、待たない印（abandoned/<id>.json）を置き、id は続きの番号にする。
//   status.json は starting（新しい pid）から始まり、resume の欄に、続きから始めた時刻・セッションの番号・最後の問いの id・印を置いた問いを書く。
//   前の実行のプロセスがまだ動いている見込み（終わりの状態でなく、heartbeatAt が新しい）ときは、始めずに断る。
//   前の会話の記録と採点は、セッションの記録から読み直す（outer-resume.mjs）。続きから始めた実行も、また止まったら、同じように続けられる。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadPersona } from '../personas/validate.mjs';
import {
  abandonedIds, abandonUnanswered, createHumanRelay, deadBy, finalizeRelayStatus, listQuestionIds, nextQuestionNumber, readRelayAnswer, readStatus, startHeartbeat, TERMINAL_STATES, writeRelayStatus,
} from './human-relay.mjs';
import { findSessionTranscript, runDirsOf } from './outer-resume.mjs';
import { sandboxStatus } from './isolation.mjs';
import { REPO_ROOT } from './creator-tools.mjs';
import { DEFAULTS, convertPlugin, defaultRunRoot, runOuterOnce } from './outer-run.mjs';
import { USER_ROLE_MODEL, loadQuery } from './user-role.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEV_EVAL = path.resolve(HERE, '..');
export const PERSONAS_DIR = path.join(DEV_EVAL, 'personas');
/** 見ない模擬ユーザーの置き場所。中身は、実行のときにだけ読み込む（人は読まない） */
export const HELDOUT_DIR = path.join(DEV_EVAL, 'heldout');
export const CONTROL_DIR = path.join(DEV_EVAL, 'control-creator');

/**
 * 費用の目安（ドル。testing.md 8.1。Claude の定価での見積もり）。実行のたびに変わるので、目安にとどめる。
 *   create：作る流れの外側の EVAL 1回（実測 約7）。change：改善の模擬ユーザーの外側の EVAL 1回（推定 約15）。inner：内側の EVAL を足すとき（約2）。
 *   control・without：対照とプラグインなし（まだ測っていない。試作の値のまま）
 */
export const COST_GUIDE_USD = Object.freeze({ create: 7, change: 15, inner: 2, control: 0.05, without: 0.05 });

export class OuterEvalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OuterEvalError';
    this.code = code;
  }
}

// ---- 引数 ----------------------------------------------------------------------------------------------------

export function parseArgs(argv) {
  const out = { personas: [], heldout: false, styles: [], allStyles: false, arms: ['with'], models: [DEFAULTS.model], runs: 1, inner: false, sandbox: true, dryRun: false, human: false, files: [] };
  const need = (i, flag) => {
    if (i + 1 >= argv.length) throw new OuterEvalError('usage', `${flag} には値が要ります。`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case '--persona': out.personas.push(need(i, flag)); i += 1; break;
      case '--heldout': out.heldout = true; break;
      case '--style': out.styles.push(need(i, flag)); i += 1; break;
      case '--all-styles': out.allStyles = true; break;
      case '--arms': out.arms = need(i, flag).split(',').map((s) => s.trim()).filter(Boolean); i += 1; break;
      case '--models': out.models = need(i, flag).split(',').map((s) => s.trim()).filter(Boolean); i += 1; break;
      case '--runs': out.runs = Number(need(i, flag)); i += 1; break;
      case '--creator': out.creator = need(i, flag); i += 1; break;
      case '--control': out.control = need(i, flag); i += 1; break;
      case '--converted': out.converted = need(i, flag); i += 1; break;
      case '--inner': out.inner = true; break;
      case '--out': out.out = need(i, flag); i += 1; break;
      case '--user-model': out.userModel = need(i, flag); i += 1; break;
      case '--max-exchanges': out.maxExchanges = Number(need(i, flag)); i += 1; break;
      case '--timeout-minutes': out.timeoutMs = Number(need(i, flag)) * 60_000; i += 1; break;
      case '--no-sandbox': out.sandbox = false; break;
      case '--sandbox': out.sandbox = true; break;
      case '--dry-run': out.dryRun = true; break;
      case '--human': out.human = true; break;
      case '--request-file': out.requestFile = need(i, flag); i += 1; break;
      case '--relay': out.relay = need(i, flag); i += 1; break;
      case '--file': out.files.push(parseFileArg(need(i, flag))); i += 1; break;
      case '--inner-runs': out.innerRuns = Number(need(i, flag)); i += 1; break;
      case '--resume': out.resume = need(i, flag); i += 1; break;
      case '--resume-prompt-file': out.resumePromptFile = need(i, flag); i += 1; break;
      default: throw new OuterEvalError('usage', `知らない引数です：${flag}`);
    }
  }
  if (out.innerRuns !== undefined && !(Number.isInteger(out.innerRuns) && out.innerRuns > 0)) throw new OuterEvalError('usage', '--inner-runs は 1 以上の整数にしてください。');
  // 開発者が答える形（--human）は、模擬ユーザーを使わない。使えない引数を先に断る
  if (out.human) checkHumanArgs(out, argv);
  else {
    for (const flag of ['--request-file', '--relay', '--file', '--resume', '--resume-prompt-file']) {
      if (argv.includes(flag)) throw new OuterEvalError('usage', `${flag} は、開発者が答える形（--human）のときだけ使えます。`);
    }
  }
  if (!out.human && out.personas.length === 0 && !out.heldout) throw new OuterEvalError('usage', '--persona（模擬ユーザーのフォルダ）か --heldout が要ります。');
  if (!Number.isInteger(out.runs) || out.runs < 1) throw new OuterEvalError('usage', '--runs は 1 以上の整数にしてください。');
  if (out.arms.length === 0 || !out.arms.every((a) => ['with', 'control', 'without'].includes(a))) throw new OuterEvalError('usage', '--arms は with・control・without（コンマ区切り）にしてください。');
  if (out.models.length === 0 || !out.models.every((m) => /^claude-[a-z]+-\d+-\d+$/.test(m))) throw new OuterEvalError('usage', '--models は Claude Code のモデルの ID（例：claude-opus-5-5）で書いてください。別名は使えません。');
  if (out.maxExchanges !== undefined && !(Number.isInteger(out.maxExchanges) && out.maxExchanges > 0)) throw new OuterEvalError('usage', '--max-exchanges は 1 以上の整数にしてください。');
  if (out.timeoutMs !== undefined && !(out.timeoutMs > 0)) throw new OuterEvalError('usage', '--timeout-minutes は正の数にしてください。');
  return out;
}

/** --file の値（<元のファイル>[=<置き場所>]）。置き場所は作業フォルダの中の相対の場所。最初の「=」で分ける */
export function parseFileArg(value) {
  const at = value.indexOf('=');
  const src = at === -1 ? value : value.slice(0, at);
  const place = (at === -1 ? path.basename(src) : value.slice(at + 1)).split('\\').join('/');
  if (src === '') throw new OuterEvalError('usage', `--file に元のファイルがありません：${value}`);
  if (path.posix.isAbsolute(place) || path.win32.isAbsolute(place)) throw new OuterEvalError('usage', `--file の置き場所は、作業フォルダの中の相対の場所で書いてください（絶対の場所は使えません）：${place}`);
  if (place.split('/').some((part) => part === '..')) throw new OuterEvalError('usage', `--file の置き場所に「..」は使えません：${place}`);
  // 「.」と空の区切りを除いてから、空かどうかを見る（「=.」「=./.」が作業フォルダそのものを指さないように）
  const normalized = place.split('/').filter((part) => part !== '' && part !== '.').join('/');
  if (normalized === '' || place.endsWith('/')) throw new OuterEvalError('usage', `--file の置き場所が空です（ファイルの名前まで書いてください）：${value}`);
  return { src, place: normalized };
}

/** 開発者が答える形（--human）で、使えない引数を断る（testing.md 6.7） */
function checkHumanArgs(out, argv) {
  const has = (flag) => argv.includes(flag);
  for (const flag of ['--persona', '--heldout', '--style', '--all-styles', '--user-model']) {
    if (has(flag)) throw new OuterEvalError('usage', `--human では ${flag} は使えません（模擬ユーザーとユーザー役の AI を使わないため）。`);
  }
  if (out.arms.length !== 1 || out.arms[0] !== 'with') throw new OuterEvalError('usage', '--human では、--arms は with だけです（開発者が答えるのは、クリエイターとの会話だけ）。');
  if (out.runs !== 1) throw new OuterEvalError('usage', '--human では、--runs は 1 だけです。');
  if (out.models.length !== 1) throw new OuterEvalError('usage', '--human では、--models は 1 つだけです。');
  if (out.resume !== undefined) {
    // 続きから始める：最初の依頼の文と開発者のファイルは、前の実行のもの（もう送らない・置き直さない）
    for (const flag of ['--request-file', '--file']) {
      if (has(flag)) throw new OuterEvalError('usage', `--resume では ${flag} は使えません（最初の依頼の文と開発者のファイルは、前の実行のものを使います）。`);
    }
    if (!out.resumePromptFile) throw new OuterEvalError('usage', '--resume には --resume-prompt-file（続けるときに、クリエイターへ最初に送る発言のファイル）が要ります。');
    if (!out.out) throw new OuterEvalError('usage', '--resume には --out（前の実行の結果のフォルダ）が要ります。');
    return;
  }
  if (out.resumePromptFile !== undefined) throw new OuterEvalError('usage', '--resume-prompt-file は、--resume（続きから始める）のときだけ使えます。');
  if (!out.requestFile) throw new OuterEvalError('usage', '--human には --request-file（最初の依頼の文のファイル）が要ります。');
  const places = out.files.map((f) => f.place);
  const dup = places.find((p, i) => places.indexOf(p) !== i);
  if (dup) throw new OuterEvalError('usage', `--file の置き場所が重なっています：${dup}`);
}

// ---- 開発者が答える形の読み込み ------------------------------------------------------------------------------

/** 開発者（統括）が書いた文のファイルを読む。UTF-8 の空でない文字だけを受ける。終わりの改行は除く */
function readDeveloperText(file, { label, missing, bad }) {
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch (error) {
    throw new OuterEvalError(missing, `${label}のファイルを読めません（${file}）：${error.message}`);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new OuterEvalError(bad, `${label}のファイルが UTF-8 ではありません（${file}）。`);
  }
  text = text.replace(/^\uFEFF/, '').replace(/(\r?\n)+$/, '');
  if (text.trim() === '') throw new OuterEvalError(bad, `${label}のファイルが空です（${file}）。`);
  return text;
}

/** 最初の依頼の文を読む。UTF-8 の空でない文字だけを受ける。終わりの改行は除く */
export function readRequestFile(file) {
  return readDeveloperText(file, { label: '最初の依頼の文', missing: 'no_request', bad: 'bad_request' });
}

/** 続きから始めるときの、クリエイターへの最初の発言を読む（readRequestFile と同じ決まり） */
export function readResumePromptFile(file) {
  return readDeveloperText(file, { label: '続けるときの最初の発言', missing: 'no_resume_prompt', bad: 'bad_resume_prompt' });
}

/**
 * 開発者が答える形の、模擬ユーザーの代わり（loadPersona の返り値と同じ形）。ナレッジの一覧はない（testing.md 6.7）。
 * loadPersona は、ナレッジが空の模擬ユーザーを断るので使わない。
 */
export function buildHumanLoaded({ requestFile, files = [] }) {
  const request = readRequestFile(requestFile);
  const placed = files.map((f) => {
    const src = path.resolve(f.src);
    let stat;
    try {
      stat = fs.statSync(src);
    } catch {
      throw new OuterEvalError('no_file', `--file のファイルが見つかりません：${f.src}`);
    }
    if (!stat.isFile()) throw new OuterEvalError('no_file', `--file はファイルにしてください（フォルダは写せません）：${f.src}`);
    return { src, place: f.place, role: 'developer', describe: '開発者が示したファイル' };
  });
  return {
    persona: {
      id: 'human',
      title: '開発者が答える',
      experience: 'done',
      request,
      profile: '',
      files: placed.map((f) => ({ place: f.place, role: f.role, describe: f.describe })),
      knowledge: [],
      styles: { normal: { label: '開発者', instruction: '' } },
    },
    dir: null,
    files: placed,
  };
}

/** 続きから始めるときの最初の依頼の文の仮の値。本当の文は、runOuterOnce がセッションの記録から読み直す（もう送らない） */
export const RESUME_REQUEST_PLACEHOLDER = '（続きから始めた実行。最初の依頼の文は、クリエイターのセッションの記録から読み直す）';

/** 続きから始めるときの、模擬ユーザーの代わり（buildHumanLoaded と同じ形。開発者のファイルは、前の実行で置いたので、置き直さない） */
export function buildResumeLoaded() {
  return {
    persona: {
      id: 'human',
      title: '開発者が答える',
      experience: 'done',
      request: RESUME_REQUEST_PLACEHOLDER,
      profile: '',
      files: [],
      knowledge: [],
      styles: { normal: { label: '開発者', instruction: '' } },
    },
    dir: null,
    files: [],
  };
}

/**
 * 続きから始められるかを確かめる（何も書かない）。前の実行のフォルダ・セッションの記録・中継のフォルダが揃い、
 * 前の実行のプロセスが動いていない（終わりの状態か、wait が「プロセスがない」とみなす）こと。
 * @returns {{ runDir: string, prompt: string, sessionId: string, transcript: string, status: object, lastId: string|null, unanswered: string[], nextId: string }}
 */
export function prepareResume({ outDir, relayDir, runDir, promptFile, deadOptions = {} }) {
  const prompt = readResumePromptFile(promptFile);
  const dir = path.resolve(runDir);
  const dirs = runDirsOf(dir);
  for (const [name, d] of [['work', dirs.work], ['agent-home', dirs.agentHome], ['copilot-home', dirs.copilotHome]]) {
    if (!fs.existsSync(d)) throw new OuterEvalError('bad_resume', `続きから始める実行のフォルダに ${name} がありません（${d}）。--resume には、前の実行のフォルダ（<out>/runs/outer-human-with-…）を渡してください。`);
  }
  let found;
  try {
    found = findSessionTranscript(dirs.agentHome);
  } catch (error) {
    throw new OuterEvalError('no_session', error.message);
  }
  const status = readStatus(relayDir);
  if (!status) throw new OuterEvalError('no_relay', `中継のフォルダに status.json がありません（${relayDir}）。--out と --relay は、前の実行のものにしてください。`);
  if (status.runDir && path.resolve(status.runDir) !== dir) throw new OuterEvalError('resume_mismatch', `中継のフォルダの実行のフォルダ（${status.runDir}）と、--resume（${dir}）が違います。`);
  if (status.out && path.resolve(status.out) !== path.resolve(outDir)) throw new OuterEvalError('resume_mismatch', `中継のフォルダの結果のフォルダ（${status.out}）と、--out（${outDir}）が違います。`);
  if (!TERMINAL_STATES.includes(status.state) && !deadBy(status, deadOptions)) {
    throw new OuterEvalError('relay_alive', `前の実行のプロセスが、まだ動いている見込みです（状態 ${status.state}、heartbeatAt ${status.heartbeatAt ?? 'なし'}）。human-relay.mjs の wait で続けてください。wait が 4（プロセスがない）で返ってから、続きから始めてください。`);
  }
  const ids = listQuestionIds(relayDir);
  const abandoned = new Set(abandonedIds(relayDir));
  const unanswered = ids.filter((id) => !abandoned.has(id) && readRelayAnswer(relayDir, id) === null);
  const next = nextQuestionNumber(relayDir);
  return { runDir: dir, prompt, sessionId: found.sessionId, transcript: found.file, status, lastId: ids.length ? String(next - 1).padStart(4, '0') : null, unanswered, nextId: String(next).padStart(4, '0') };
}

// ---- 模擬ユーザーの読み込み --------------------------------------------------------------------------------------

/** フォルダの中の、persona.json のある子フォルダ（見ない模擬ユーザーの探し方）。ないフォルダは空 */
export function discoverPersonaDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'persona.json')))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * 模擬ユーザーを読み込む。見ない模擬ユーザー（heldout）は、実行のときにここで読み込む。形が決まりに合わなければ断る。
 * @returns {Promise<Array<{ loaded: object, heldout: boolean }>>}
 */
export async function loadPersonas({ dirs, heldout, heldoutDir = HELDOUT_DIR }) {
  const out = [];
  for (const dir of dirs) out.push({ loaded: await loadPersona(path.resolve(dir)), heldout: false });
  if (heldout) {
    const found = discoverPersonaDirs(heldoutDir);
    if (found.length === 0) throw new OuterEvalError('no_heldout', `見ない模擬ユーザーが見つかりません（${heldoutDir}）。`);
    for (const dir of found) out.push({ loaded: await loadPersona(dir), heldout: true });
  }
  const ids = out.map((p) => p.loaded.persona.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new OuterEvalError('duplicate_persona', `模擬ユーザーの id が重なっています：${dup}`);
  return out;
}

// ---- 計画 --------------------------------------------------------------------------------------------------------

/** 動かす実行の一覧。模擬ユーザー × 話し方 × 腕 × モデル × 回数 */
export function planRuns({ personas, styles = [], allStyles = false, arms, models, runs, inner = false }) {
  const plan = [];
  for (const { loaded, heldout } of personas) {
    const styleNames = allStyles ? Object.keys(loaded.persona.styles) : styles.length ? styles : ['normal'];
    for (const style of styleNames) {
      if (!loaded.persona.styles[style]) throw new OuterEvalError('usage', `話し方「${style}」は、模擬ユーザー ${loaded.persona.id} にありません。`);
      for (const arm of arms) {
        // 対照とプラグインなしは、クリエイターのモデルを替えても意味が薄いので、最初のモデルだけで動かす
        const armModels = arm === 'with' ? models : models.slice(0, 1);
        for (const model of armModels) {
          for (let n = 1; n <= runs; n += 1) plan.push({ persona: loaded.persona.id, kind: loaded.persona.kind === 'change' ? 'change' : 'create', heldout, style, arm, model, n, inner: inner && arm === 'with' });
        }
      }
    }
  }
  return plan;
}

export function estimateUsd(plan) {
  const one = (p) => {
    if (p.arm === 'control') return COST_GUIDE_USD.control;
    if (p.arm === 'without') return COST_GUIDE_USD.without;
    return (p.kind === 'change' ? COST_GUIDE_USD.change : COST_GUIDE_USD.create) + (p.inner ? COST_GUIDE_USD.inner : 0);
  };
  return Number(plan.reduce((sum, p) => sum + one(p), 0).toFixed(2));
}

// ---- 結果の要約 --------------------------------------------------------------------------------------------------

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** 見ない模擬ユーザーの要約では、ナレッジの id を伏せる（人が中身を推測できないように） */
const redactGrade = (g, redact, order) => (redact ? { ...g, id: g.id.replace(/:(.+)$/, (_, k) => `:#${order.indexOf(k) + 1}`), detail: '' } : g);

function redactCounts(counts, heldout) {
  if (!counts) return null;
  if (!heldout) return counts;
  return { ...counts, recordRefusals: { ...counts.recordRefusals, samples: [] } };
}

/** 実行の要約の数（counts）を、まとめる。合計と、問いの欄の数の最大 */
export function aggregateCounts(summaries) {
  const list = summaries.map((s) => s.counts).filter(Boolean);
  const sum = (pick) => list.reduce((n, c) => n + (pick(c) ?? 0), 0);
  return {
    runs: list.length,
    questions: { total: sum((c) => c.questions.total), askTool: sum((c) => c.questions.askTool), text: sum((c) => c.questions.text) },
    askToolCalls: {
      calls: sum((c) => c.askToolCalls.calls),
      maxQuestionsPerCall: list.reduce((m, c) => Math.max(m, c.askToolCalls.maxQuestionsPerCall ?? 0), 0),
      callsWithMultiple: sum((c) => c.askToolCalls.callsWithMultiple),
    },
    pending: sum((c) => c.pending.count),
    aiDecisions: sum((c) => c.aiDecisions.count),
    recordRefusals: { total: sum((c) => c.recordRefusals.total), fixed: sum((c) => c.recordRefusals.fixed), unfixed: sum((c) => c.recordRefusals.unfixed) },
  };
}

/** 1 回の記録の要約 */
export function summarizeRecord(record, { heldout = false } = {}) {
  const order = record.grading.trace.map((t) => t.id);
  return {
    persona: heldout ? '(見ない模擬ユーザー)' : record.persona.id,
    heldout,
    style: record.style,
    arm: record.arm,
    model: record.models.creator,
    stopped: record.stopped?.reason ?? null,
    score: record.grading.score,
    verdictOk: record.grading.verdict.ok,
    failed: record.grading.grades.filter((g) => !g.ok).map((g) => redactGrade(g, heldout, order).id),
    // 採点しなかった観点（verdictOk と score は、残りの観点だけで決めた）
    ...(record.grading.notGraded?.length ? { notGraded: record.grading.notGraded.map((g) => g.id) } : {}),
    exampleCandidate: heldout ? false : record.grading.exampleCandidate,
    faults: heldout ? record.grading.faults.length : record.grading.faults,
    costUsd: Number(((record.costUsd?.creator ?? 0) + (record.costUsd?.userRole ?? 0)).toFixed(4)),
    // 設計書（testing.md 6.5）が「記録する」とした数。合否には入れない。見ない模擬ユーザーでは、断りの理由の文は伏せる
    counts: redactCounts(record.grading.counts, heldout),
    ...(heldout
      ? {}
      : {
          trace: record.grading.trace.map((t) => ({ id: t.id, volunteer: t.volunteer, asked: t.asked, answered: t.answered, embedded: t.embedded, excludedHit: t.excludedHit, verdict: t.verdict })),
        }),
  };
}

/**
 * 対照のクリエイターの確かめ（testing.md 6.3）：聞かれないと話さないナレッジが組み込まれず、ユーザー役にも漏れがない。
 * 対照で、聞かれないと話さないナレッジが組み込まれたら、試験が落ちるべきときに落ちていない（試験を疑う）。
 */
export function evaluateControl(records) {
  const controls = records.filter((r) => r.arm === 'control');
  if (controls.length === 0) return null;
  const problems = [];
  for (const r of controls) {
    const who = r.heldout ? '(見ない模擬ユーザー)' : r.persona.id;
    const order = r.grading.trace.map((t) => t.id);
    const name = (id) => (r.heldout ? `#${order.indexOf(id) + 1}` : id);
    for (const t of r.grading.trace) {
      if (t.volunteer || t.id === 'first-run') continue;
      if (t.embedded === true) problems.push(`${who}：対照のクリエイターが、聞かれないと話さないナレッジ ${name(t.id)} を組み込んだ`);
      if (t.leaked) problems.push(`${who}：ユーザー役が、聞かれていないのにナレッジ ${name(t.id)} を話した`);
    }
  }
  return { ok: problems.length === 0, runs: controls.length, problems };
}

/** 全体の要約。腕・モデルごとの平均点と、あり・なしの差 */
export function summarizeAll(records, summaries) {
  const key = (s) => `${s.arm}:${s.model}`;
  const groups = {};
  for (const s of summaries) (groups[key(s)] ??= []).push(s);
  const scores = Object.fromEntries(Object.entries(groups).map(([k, xs]) => [k, { runs: xs.length, score: mean(xs.map((x) => x.score)), verdictOk: xs.filter((x) => x.verdictOk).length }]));
  const counts = Object.fromEntries(Object.entries(groups).map(([k, xs]) => [k, aggregateCounts(xs)]));
  const withScores = summaries.filter((s) => s.arm === 'with').map((s) => s.score);
  const withoutScores = summaries.filter((s) => s.arm === 'without').map((s) => s.score);
  return {
    scores,
    counts,
    delta: withScores.length && withoutScores.length ? mean(withScores) - mean(withoutScores) : null,
    control: evaluateControl(records),
    costUsd: Number(summaries.reduce((a, s) => a + s.costUsd, 0).toFixed(4)),
  };
}

// ---- 実行 ----------------------------------------------------------------------------------------------------------

/**
 * 計画どおりに動かす。実行が 1 つ終わるたびに、結果のファイルを書き直す。利用枠の上限で止まったら、残りは飛ばす。
 * @param {object} o
 * @param {Array} o.plan
 * @param {Map<string, { loaded: object, heldout: boolean }>} o.personaById
 * @param {string} o.outDir
 * @param {Function} [o.runOne] 1 回を動かす関数（既定は runOuterOnce。試験で差し替える）
 */
export async function runPlan({ plan, personaById, outDir, creatorRoot, controlRoot, convertedCreator, convertedControl, runOne = runOuterOnce, common = {}, signal, onProgress = () => {} }) {
  fs.mkdirSync(outDir, { recursive: true });
  const reportFile = path.join(outDir, 'outer-report.json');
  const records = [];
  const summaries = [];
  const report = { kind: 'dev-outer-eval', status: 'running', stopped: null, startedAt: new Date().toISOString(), finishedAt: null, plan, summaries, summary: null, warnings: [], reportFile, heldoutRecordsDir: null };
  if (common.sandbox === false) report.warnings.push('OS のサンドボックスなしで動かした（コマンドが作業フォルダの外に書ける）');
  const save = () => {
    report.summary = summarizeAll(records, summaries);
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  };
  save();
  let stopped = null;
  for (const [index, item] of plan.entries()) {
    const { loaded, heldout } = personaById.get(item.persona);
    if (stopped || signal?.aborted) {
      summaries.push({ persona: heldout ? 'heldout' : item.persona, heldout, style: item.style, arm: item.arm, model: item.model, stopped: stopped ? 'skipped' : 'interrupted', score: 0, verdictOk: false, failed: [], exampleCandidate: false, faults: [], costUsd: 0 });
      continue;
    }
    onProgress({ phase: 'start', index: index + 1, total: plan.length, ...item, persona: heldout ? '(見ない模擬ユーザー)' : item.persona });
    const recordsDir = path.join(outDir, heldout ? 'records-heldout' : 'records');
    if (heldout) report.heldoutRecordsDir = recordsDir;
    const record = await runOne({
      ...common,
      loaded,
      arm: item.arm,
      styleName: item.style,
      model: item.model,
      creatorRoot: item.arm === 'control' ? controlRoot : creatorRoot,
      convertedCreator: item.arm === 'control' ? convertedControl : item.arm === 'with' ? convertedCreator : undefined,
      runRoot: path.join(outDir, 'runs'),
      inner: item.inner,
      signal,
      onProgress: (p) => onProgress({ ...p, persona: heldout ? '(見ない模擬ユーザー)' : item.persona }),
    });
    record.heldout = heldout;
    fs.mkdirSync(recordsDir, { recursive: true });
    const recordName = `${item.persona}-${item.style}-${item.arm}-${item.model}-${item.n}.json`;
    fs.writeFileSync(path.join(recordsDir, recordName), `${JSON.stringify(record, null, 2)}\n`);
    records.push(record);
    summaries.push(summarizeRecord(record, { heldout }));
    save();
    onProgress({ phase: 'end', index: index + 1, total: plan.length, ...item, persona: heldout ? '(見ない模擬ユーザー)' : item.persona, score: record.grading.score, stopped: record.stopped?.reason });
    if (record.stopped?.reason === 'usage_limit') stopped = { reason: 'usage_limit', message: record.stopped.message ?? '', at: `${item.persona}/${item.arm}/${item.model}/${item.n}` };
    if (record.stopped?.reason === 'interrupted') stopped = { reason: 'interrupted', at: `${item.persona}/${item.arm}/${item.model}/${item.n}` };
  }
  report.stopped = stopped;
  report.status = stopped ? 'stopped' : 'completed';
  report.finishedAt = new Date().toISOString();
  save();
  return report;
}

/**
 * @param {string[]} argv
 * @param {{ query?: Function, runOptions?: object, deadOptions?: object }} [deps] 試験用：query（Agent SDK）と、runOuterOnce に足す引数（runStages、convert など）を差し替える。
 *   deadOptions は、続きから始めるときの、前のプロセスの有無の確かめ（human-relay.mjs の deadBy）に渡す
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.code ?? 'usage', message: error.message }));
    return 2;
  }
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  // 開発者が答える形では、統括がプロセスを止めたときも、中継の状態を stopped にしてから終わる
  const onTerm = () => abort.abort();
  if (args.human) process.once('SIGTERM', onTerm);
  const timer = args.timeoutMs ? setTimeout(() => abort.abort(), args.timeoutMs) : null;
  let relayDir = null;
  let stopHeartbeat = () => {};
  let failure = null;
  let reportFile = null;
  try {
    // 開発者が答える形は、ほかの確かめより先に中継のフォルダを決めて starting を書く。始められなかったときも、
    // 統括の wait が待ち続けずに、stopped（failed）で返るように（試しの実行では、何も作らない）
    let outDir = null;
    let resumeInfo = null;
    if (args.human && !args.dryRun) {
      outDir = path.resolve(args.out ?? fs.mkdtempSync(path.join(defaultRunRootEnsured(), 'outer-')));
      const dir = path.resolve(args.relay ?? path.join(outDir, 'relay'));
      // 前の実行の問いと答えが混ざらないように、空でない中継のフォルダは使わない（統括が始め直したときも、ここで気づく）。
      // このときは、前の実行の状態を書き換えない。続きから始める（--resume）ときは、前の中継のフォルダをそのまま続ける
      if (args.resume) resumeInfo = prepareResume({ outDir, relayDir: dir, runDir: args.resume, promptFile: args.resumePromptFile, ...(deps.deadOptions ? { deadOptions: deps.deadOptions } : {}) });
      else if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) throw new OuterEvalError('relay_in_use', `中継のフォルダが空ではありません（${dir}）。前の実行の続きなら、このコマンドを始め直さずに human-relay.mjs の wait で続けてください。新しく始めるなら、別の --relay か --out を指定してください。プロセスが止まったなら、--resume で続きから始めてください。`);
      fs.mkdirSync(outDir, { recursive: true });
      relayDir = dir;
      if (resumeInfo) {
        // 前のプロセスが待っていた問いは、もう待たない（答えは、統括が続きの最初の発言に入れる）
        resumeInfo.abandoned = abandonUnanswered(relayDir, { reason: 'resumed' });
        const resumeStatus = { at: new Date().toISOString(), sessionId: resumeInfo.sessionId, fromRelayId: resumeInfo.lastId, abandoned: resumeInfo.abandoned };
        // 前の終わりの状態と結果は消す（この実行の終わりに書き直す）。続きから始めた記録は、resumes に足していく
        writeRelayStatus(relayDir, {
          state: 'starting', pid: process.pid, out: outDir, runDir: resumeInfo.runDir, workDir: runDirsOf(resumeInfo.runDir).work, pending: null,
          phase: undefined, result: undefined, reportFile: undefined, resume: resumeStatus, resumes: [...(resumeInfo.status.resumes ?? []), resumeStatus],
        });
      } else {
        writeRelayStatus(relayDir, { state: 'starting', pid: process.pid, out: outDir, runDir: null, workDir: null, pending: null });
      }
      // クリエイターの置き換え（convertPlugin）は止まって動くので、その間は書き直せない。wait はその分を見込んで待つ（human-relay.mjs の STALE_MS）
      stopHeartbeat = startHeartbeat(relayDir);
      console.error(JSON.stringify({ phase: 'human-ready', relayDir, out: outDir, pid: process.pid }));
    }
    const personas = args.human
      ? [{ loaded: args.resume ? buildResumeLoaded() : buildHumanLoaded({ requestFile: args.requestFile, files: args.files }), heldout: false }]
      : await loadPersonas({ dirs: args.personas, heldout: args.heldout });
    const plan = planRuns({ personas, styles: args.styles, allStyles: args.allStyles, arms: args.arms, models: args.models, runs: args.runs, inner: args.inner });
    if (args.dryRun) {
      let resume = {};
      if (args.resume) {
        // 試しの実行でも、続きから始められるかを確かめて示す（何も書かない）
        const dryOut = path.resolve(args.out);
        const dryRelay = path.resolve(args.relay ?? path.join(dryOut, 'relay'));
        const r = prepareResume({ outDir: dryOut, relayDir: dryRelay, runDir: args.resume, promptFile: args.resumePromptFile, ...(deps.deadOptions ? { deadOptions: deps.deadOptions } : {}) });
        resume = { resume: { runDir: r.runDir, sessionId: r.sessionId, transcript: r.transcript, relayDir: dryRelay, state: r.status.state, lastId: r.lastId, willAbandon: r.unanswered, nextId: r.nextId, promptChars: [...r.prompt].length } };
      }
      const human = args.human ? { human: true, relayDir: args.relay ? path.resolve(args.relay) : '<out>/relay', files: args.files, ...resume } : {};
      console.log(JSON.stringify({ ok: true, dryRun: true, runs: plan.length, estimateUsd: estimateUsd(plan), note: '費用は試作（Claude の定価）の目安。実行のたびに変わる。利用枠も使う。', ...human, plan: plan.map((p) => ({ ...p, persona: p.heldout ? '(見ない模擬ユーザー)' : p.persona })) }, null, 2));
      return 0;
    }
    if (args.sandbox) {
      const status = sandboxStatus();
      if (!status.available) throw new OuterEvalError('sandbox_missing', `OS のサンドボックスの道具が足りません（${status.missing.join('、')}）。入れるか、--no-sandbox で外してください（外すと、コマンドが作業フォルダの外に書けます）。`);
    }
    if (!outDir) outDir = path.resolve(args.out ?? fs.mkdtempSync(path.join(defaultRunRootEnsured(), 'outer-')));
    fs.mkdirSync(outDir, { recursive: true });
    const creatorRoot = path.resolve(args.creator ?? REPO_ROOT);
    const controlRoot = path.resolve(args.control ?? CONTROL_DIR);
    let convertedCreator;
    let convertedControl;
    // 続きから始めるときは、前の実行で置き換えた版があれば、それを使う（前と同じクリエイターで続ける。置き換え直すと、前の版を消す）
    const keptConverted = path.join(outDir, 'converted', 'creator');
    const reuseConverted = resumeInfo && fs.existsSync(path.join(keptConverted, '.eval', 'conversion-report.json'));
    if (args.arms.includes('with')) convertedCreator = args.converted ? path.resolve(args.converted) : reuseConverted ? keptConverted : convertPlugin(creatorRoot, keptConverted).root;
    if (args.arms.includes('control')) convertedControl = convertPlugin(controlRoot, path.join(outDir, 'converted', 'control')).root;
    const query = deps.query ?? (await loadQuery());
    const personaById = new Map(personas.map((p) => [p.loaded.persona.id, p]));
    const humanOptions = args.human
      // 中継の heartbeatAt は、この入口が書く。終わりの状態も、記録と outer-report.json を書き終えてから、この入口が書く（下の finally）
      ? {
          answerer: 'human',
          createAnswerer: ({ runDir, workDir, signal }) => createHumanRelay({ relayDir, signal, runDir, workDir, heartbeatMs: 0, deferTerminal: true }),
          ...(resumeInfo ? { resume: { runDir: resumeInfo.runDir, prompt: resumeInfo.prompt, sessionId: resumeInfo.sessionId, relayDir, fromRelayId: resumeInfo.lastId, abandoned: resumeInfo.abandoned } } : {}),
        }
      : {};
    const report = await runPlan({
      plan, personaById, outDir, creatorRoot, controlRoot, convertedCreator, convertedControl, signal: abort.signal,
      common: {
        query, sandbox: args.sandbox, userRoleModel: args.userModel, maxExchanges: args.maxExchanges,
        ...(args.innerRuns !== undefined ? { innerRuns: args.innerRuns } : {}), ...humanOptions, ...(deps.runOptions ?? {}),
      },
      onProgress: (p) => {
        if (p.phase === 'start') console.error(`[外側の EVAL] ${p.index}/${p.total} ${p.persona} ${p.style} ${p.arm} ${p.model} ${p.n} 回目を始める`);
        else if (p.phase === 'end') console.error(`[外側の EVAL] ${p.index}/${p.total} 終わり：点数 ${p.score.toFixed(2)}${p.stopped ? `（${p.stopped}）` : ''}`);
      },
    });
    reportFile = report.reportFile;
    console.log(JSON.stringify({ ok: true, status: report.status, stopped: report.stopped, reportFile: report.reportFile, heldoutRecordsDir: report.heldoutRecordsDir, summary: report.summary, userRoleModel: args.human ? 'human' : args.userModel ?? USER_ROLE_MODEL, ...(relayDir ? { relayDir } : {}), ...(resumeInfo ? { resumed: { runDir: resumeInfo.runDir, sessionId: resumeInfo.sessionId, abandoned: resumeInfo.abandoned } } : {}) }, null, 2));
    return report.status === 'stopped' ? 1 : 0;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.code ?? 'failed', message: error.message }));
    failure = { reason: 'failed', message: error.message };
    return 2;
  } finally {
    if (timer) clearTimeout(timer);
    if (args.human) process.off('SIGTERM', onTerm);
    stopHeartbeat();
    // どの終わり方でも、記録と outer-report.json を書き終えた後に、中継の状態を終わりにする（統括の wait が待ち続けないように）
    if (relayDir) finalizeRelayStatus(relayDir, { fallback: { reason: abort.signal.aborted ? 'interrupted' : 'ended' }, failure, extra: reportFile ? { reportFile } : {} });
  }
}

function defaultRunRootEnsured() {
  const root = defaultRunRoot();
  fs.mkdirSync(root, { recursive: true });
  return root;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main();
}
