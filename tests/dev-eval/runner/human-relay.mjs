// 開発者が答える外側の EVAL の中継（testing.md 6.7）。ユーザー役の AI（user-role.mjs）の代わりに、クリエイターの問いを
// 中継のフォルダに書き、統括（開発者と話す Claude Code のセッション）が置く答えを待つ。
//
// - 試験の仕組みからは、createUserRole と同じ形（answer、history、answers、signals、cost、answerCount）で使う。
//   答えの記録（entry）の形も同じにする（outer-run.mjs と outer-grade.mjs がそのまま使えるように）。
// - 中継のフォルダ（JSON、UTF-8。書き込みは一時ファイルを書いてから名前を変える）:
//     status.json          { state: starting|running|waiting|finished|stopped, pid, pidNs, runDir, workDir, pending, updatedAt, heartbeatAt, phase?, result? }
//     questions/<id>.json  { id, index, via, header, question, options, multiSelect, notes, group, groupSize, askedAt }
//     answers/<id>.json    { answer }（統括が書く。必ず下のコマンドの answer で書く。じかに書くと、形の誤りに気づけない）
//   id は 0001 からの連番。中継の状態はファイルに残すので、統括がコンパクションの後に試験の仕組みを動かし直さずに続けられる。
// - 終わりの状態（finished・stopped）は、結果（記録のファイルなど）を書き終えてから 1 回だけ書く。中断されても、採点が終わるまでは
//   state を変えずに phase を stopping にする（統括が、書きかけの結果を読まないように）。
// - 試験の仕組みは、動いている間、数秒ごとに heartbeatAt を書き直す。wait は、これが古くなったら（既定 10 分）プロセスがないとみなす。
//   Claude Code のサンドボックスは、コマンドごとにプロセスの番号の空間を分ける（bwrap --unshare-pid）ので、番号（pid）は
//   同じ空間（pidNs が同じ）のときだけ確かめる。10 分は、止まって動く最も長い手順（クリエイターの置き換え。上限 5 分）より長くした。
// - 開発者の答えは、変えずにクリエイターへ返す（言い換え・前後の空白の除去をしない）。誤りの確かめ（INSTRUCTION_WORDS）もしない。
//
// 統括が使うコマンド（リポジトリの根から）:
//   node tests/dev-eval/runner/human-relay.mjs wait --relay <中継のフォルダ> [--timeout-seconds N]
//       答えのない問いが出るまで待つ。終了コード：0 問いがある（標準出力に問いの JSON）、3 試験の仕組みが終わった（状態の JSON）、
//       4 試験の仕組みのプロセスがない（{"state":"dead",…}）、5 時間切れ（{"state":"timeout"}）、2 引数の誤り
//       答えのファイルの形が誤っている問いは、答えのない問いとして返す（invalidAnswer に理由。answer で置き直す）
//       --stale-seconds は、heartbeatAt がどれだけ古くなったらプロセスがないとみなすか（既定 600）
//   node tests/dev-eval/runner/human-relay.mjs answer --relay <中継のフォルダ> --id <id> (--text <答え> | --text-file <ファイル>)
//       答えを置く。問いがない・もう答えた・答えが空のときは断る（終了コード 2）。複数選べる問いは、選んだ名前を「, 」でつないで渡す
//   node tests/dev-eval/runner/human-relay.mjs status --relay <中継のフォルダ>
//       状態と、答えを待っている問い（あれば）を出す
//   --poll-ms は、待つ間に確かめる間隔（既定 1000。試験で短くする）。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { joinNotes, normalizeChoices } from './user-role.mjs';

/** 試験の仕組みが終わった状態（wait は終了コード 3 で返す） */
export const TERMINAL_STATES = Object.freeze(['finished', 'stopped']);
/** 終わった理由のうち、会話が最後まで進んだもの（状態 finished）。ほかの理由は stopped */
export const FINISHED_REASONS = Object.freeze(['generated', 'generated_without_approval', 'max_exchanges']);

/** heartbeatAt を書き直す間隔 */
export const HEARTBEAT_MS = 5000;
/** heartbeatAt がこれより古ければ、試験の仕組みのプロセスがないとみなす（止まって動く最も長い手順の 5 分より長く） */
export const STALE_MS = 10 * 60_000;

const ID_PATTERN = /^\d{4,}$/;
const QUESTION_FILE = /^(\d{4,})\.json$/;

export class RelayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
  }
}

// ---- ファイル ----------------------------------------------------------------------------------------

export const relayPaths = (relayDir) => ({
  status: path.join(relayDir, 'status.json'),
  questions: path.join(relayDir, 'questions'),
  answers: path.join(relayDir, 'answers'),
});

let tmpCounter = 0;
/** JSON を、同じフォルダの一時ファイルに書いてから名前を変える（読む側が書きかけを読まないように） */
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${(tmpCounter += 1)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** JSON を読む。ない・読めないときは null */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export const readStatus = (relayDir) => readJson(relayPaths(relayDir).status);

/** このプロセスの、プロセスの番号の空間（Linux の /proc/self/ns/pid）。分からないときは null */
export function currentPidNs() {
  try {
    return fs.readlinkSync('/proc/self/ns/pid');
  } catch {
    return null;
  }
}

/**
 * 状態に patch を重ねて書く（試験の仕組みの側だけが書く）。書いた状態を返す。値が undefined の欄は消える。
 * pid を書くときは、番号の空間（pidNs）も書く。書くたびに heartbeatAt も新しくする（書けることが、動いている印）
 */
export function writeRelayStatus(relayDir, patch) {
  const now = new Date().toISOString();
  const next = { ...(readStatus(relayDir) ?? {}), ...patch, ...('pid' in patch ? { pidNs: currentPidNs() } : {}), updatedAt: now, heartbeatAt: now };
  writeJsonAtomic(relayPaths(relayDir).status, next);
  return next;
}

/** heartbeatAt だけを新しくする（updatedAt は、状態が変わった時のまま）。状態がまだない・終わったときは書かない */
export function touchHeartbeat(relayDir) {
  const status = readStatus(relayDir);
  if (!status || TERMINAL_STATES.includes(status.state)) return;
  writeJsonAtomic(relayPaths(relayDir).status, { ...status, heartbeatAt: new Date().toISOString() });
}

/** heartbeatAt を intervalMs ごとに書き直す。プロセスの終わりを妨げない（unref）。止める関数を返す */
export function startHeartbeat(relayDir, intervalMs = HEARTBEAT_MS) {
  if (!(intervalMs > 0)) return () => {};
  const timer = setInterval(() => {
    try {
      touchHeartbeat(relayDir);
    } catch {
      // 書けなかったときは、次の回に書く
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** 終わりの状態（結果に書いた理由から、finished か stopped） */
export const terminalStateOf = (reason) => (FINISHED_REASONS.includes(reason) ? 'finished' : 'stopped');

/**
 * 中継の状態を終わりにする（試験の仕組みの入口が、記録と結果のファイルを書き終えてから呼ぶ）。もう終わりなら何もしない。
 * finish で結果を書いてあれば、その理由で finished か stopped。結果がなければ fallback を結果にして stopped。
 * failure（入口が途中で落ちた）があれば、結果にその文を足して stopped。extra は状態に足す欄（outer-report.json の場所など）
 */
export function finalizeRelayStatus(relayDir, { fallback = { reason: 'ended' }, failure = null, extra = {} } = {}) {
  const status = readStatus(relayDir);
  if (status && TERMINAL_STATES.includes(status.state)) return status;
  const base = status?.result ?? null;
  const result = failure
    ? { ...(base ?? {}), ...(base ? { error: failure.message ?? '' } : { ...failure, finishedReason: failure.reason ?? null }) }
    : base ?? { ...fallback, finishedReason: fallback.reason ?? null };
  const state = failure ? 'stopped' : base ? terminalStateOf(base.reason) : 'stopped';
  return writeRelayStatus(relayDir, { ...extra, state, pending: null, phase: undefined, result });
}

/** 問いの id の一覧（連番の順） */
export function listQuestionIds(relayDir) {
  try {
    return fs.readdirSync(relayPaths(relayDir).questions).map((n) => QUESTION_FILE.exec(n)?.[1]).filter(Boolean).sort();
  } catch {
    return [];
  }
}

const answerFile = (relayDir, id) => path.join(relayPaths(relayDir).answers, `${id}.json`);
const questionFile = (relayDir, id) => path.join(relayPaths(relayDir).questions, `${id}.json`);

/** 答えのファイルの答え。ない・形が違うときは null（試験の仕組みは待ち続ける） */
function readAnswer(relayDir, id) {
  const json = readJson(answerFile(relayDir, id));
  return typeof json?.answer === 'string' && json.answer.trim() !== '' ? json.answer : null;
}

/** 答えのファイルがあるのに、試験の仕組みが答えとして読めない理由。ファイルがない・読めるときは null */
function invalidAnswerReason(relayDir, id) {
  const file = answerFile(relayDir, id);
  if (!fs.existsSync(file) || readAnswer(relayDir, id) !== null) return null;
  return `答えのファイル（${file}）の形が誤っています（{"answer":"空でない文字"} ではない）。answer のコマンドで置き直してください。`;
}

/**
 * 答えのない最初の問い。なければ null。答えのファイルの形が誤っている問いも、答えのない問いとして返す（invalidAnswer に理由）。
 * 試験の仕組みは、その答えを読めずに待ち続けるので、統括に置き直してもらう
 */
export function pendingQuestion(relayDir) {
  for (const id of listQuestionIds(relayDir)) {
    if (!fs.existsSync(answerFile(relayDir, id))) return readJson(questionFile(relayDir, id));
    const invalid = invalidAnswerReason(relayDir, id);
    if (invalid) return { ...readJson(questionFile(relayDir, id)), invalidAnswer: invalid };
  }
  return null;
}

/** プロセスが動いているか。権限がなくて確かめられないときは、動いているとみなす */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * 答えを置く（統括のコマンド answer の中身）。問いがない・もう答えた・答えが空なら断る。
 * 置くときは、一時ファイルからリンクを張る（同じ id に 2 つの答えが置かれないように、置き換えずに断る）。
 * 形の誤った答えのファイル（じかに書かれたもの）だけは、置き換える（試験の仕組みは、まだ答えを読んでいない）。
 */
export function answerQuestion(relayDir, id, text) {
  if (!ID_PATTERN.test(String(id ?? ''))) throw new RelayError('usage', `問いの id は数字で書いてください（例：0001）：${id}`);
  if (!fs.existsSync(questionFile(relayDir, id))) throw new RelayError('no_question', `問い ${id} はありません（${relayPaths(relayDir).questions}）。`);
  const invalid = invalidAnswerReason(relayDir, id) !== null;
  if (!invalid && fs.existsSync(answerFile(relayDir, id))) throw new RelayError('already_answered', `問い ${id} には、もう答えています。`);
  if (typeof text !== 'string' || text.trim() === '') throw new RelayError('empty_answer', '答えが空です。開発者の答えを渡してください。');
  const file = answerFile(relayDir, id);
  if (invalid) {
    writeJsonAtomic(file, { answer: text });
    return { ok: true, replaced: true };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${(tmpCounter += 1)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ answer: text }, null, 2)}\n`);
  try {
    fs.linkSync(tmp, file);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new RelayError('already_answered', `問い ${id} には、もう答えています。`);
    throw error;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return { ok: true };
}

// ---- 試験の仕組みの側 ----------------------------------------------------------------------------------

const abortError = () => {
  const error = new Error('開発者の答えを待つのを中断しました。');
  error.name = 'AbortError';
  return error;
};

/**
 * 1 回の会話の中継。createUserRole（user-role.mjs）と同じ形で使う。
 * @param {object} args
 * @param {string} args.relayDir 中継のフォルダ
 * @param {AbortSignal} [args.signal] 中断されたら、待っている答えをあきらめて断る（phase は stopping。終わりの状態は finish で書く）
 * @param {number} [args.pollMs] 答えのファイルを確かめる間隔
 * @param {number} [args.pid] 試験の仕組みのプロセスの番号（状態に書く。統括がプロセスの有無を確かめる）
 * @param {string} [args.runDir]
 * @param {string} [args.workDir] 作業フォルダ（統括が、開発者の示すファイルを置く）
 * @param {number} [args.heartbeatMs] heartbeatAt を書き直す間隔（0 で書かない。入口の outer.mjs が自分で書くとき）
 * @param {boolean} [args.deferTerminal] true なら、finish は結果だけを書き、終わりの状態は入口が finalizeRelayStatus で書く
 *   （記録のファイルと outer-report.json を書き終えてから終わりにするため）
 */
export function createHumanRelay({ relayDir, signal, pollMs = 1000, pid = process.pid, runDir, workDir, heartbeatMs = HEARTBEAT_MS, deferTerminal = false }) {
  if (typeof relayDir !== 'string' || relayDir === '') throw new Error('createHumanRelay には中継のフォルダ（relayDir）が要ります。');
  const paths = relayPaths(relayDir);
  fs.mkdirSync(paths.questions, { recursive: true });
  fs.mkdirSync(paths.answers, { recursive: true });
  const history = [];
  const answers = [];
  let seq = listQuestionIds(relayDir).length;
  let chain = Promise.resolve();

  const setStatus = (patch) => writeRelayStatus(relayDir, patch);
  setStatus({ state: 'running', pid, pending: null, ...(runDir ? { runDir } : {}), ...(workDir ? { workDir } : {}) });
  const stopHeartbeat = startHeartbeat(relayDir, heartbeatMs);
  // 中断されたら、待っている問いをやめる。終わりの状態は、採点と記録が済んでから finish（か入口）が書く
  const markStopping = () => setStatus({ state: 'running', pending: null, phase: 'stopping' });

  function waitForAnswer(id) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const done = (fn, value) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      };
      const onAbort = () => {
        markStopping();
        done(reject, abortError());
      };
      const check = () => {
        const text = readAnswer(relayDir, id);
        if (text !== null) done(resolve, text);
        else timer = setTimeout(check, pollMs);
      };
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      check();
    });
  }

  async function answerNow(question, choices, via, meta, notes) {
    if (signal?.aborted) {
      markStopping();
      throw abortError();
    }
    seq += 1;
    const id = String(seq).padStart(4, '0');
    const index = answers.length;
    const noteList = (Array.isArray(notes) ? notes : [notes]).map((n) => String(n ?? '').trim()).filter(Boolean);
    const noteText = joinNotes(noteList);
    const options = normalizeChoices(choices);
    writeJsonAtomic(path.join(paths.questions, `${id}.json`), {
      id,
      index,
      via,
      header: String(meta.header ?? ''),
      question,
      options,
      multiSelect: Boolean(meta.multiSelect),
      notes: noteList,
      group: meta.group ?? null,
      groupSize: meta.groupSize ?? null,
      askedAt: new Date().toISOString(),
    });
    setStatus({ state: 'waiting', pending: id });
    const text = await waitForAnswer(id);
    setStatus({ state: 'running', pending: null });
    history.push({ ...(noteText ? { notes: noteText } : {}), question, answer: text });
    const entry = { index, via, question, ...(noteText ? { notes: noteText } : {}), choices: options, answer: text, rawAnswer: text, cost: 0, signal: false, ...meta };
    answers.push(entry);
    return entry;
  }

  return {
    relayDir,
    /** 問いを中継のフォルダに書き、統括が答えを置くまで待つ。順に 1 つずつ動く（createUserRole と同じ） */
    answer(question, choices = [], via = 'AskUserQuestion', meta = {}, notes = []) {
      const run = chain.then(() => answerNow(question, choices, via, meta, notes));
      chain = run.catch(() => {});
      return run;
    },
    setStatus,
    /**
     * 試験の仕組みの 1 回が終わったとき（採点と記録が済んだ後）に呼ぶ。会話が最後まで進んだら finished、それ以外は stopped。
     * deferTerminal のときは結果だけを書き（phase は saving）、終わりの状態は入口が finalizeRelayStatus で書く。
     * @param {{ reason: string, message?: string, lastText?: string, score?: number, verdictOk?: boolean, recordFile?: string }} info
     */
    finish(info = {}) {
      stopHeartbeat();
      const result = { ...info, finishedReason: info.reason ?? null };
      if (deferTerminal) return setStatus({ pending: null, phase: 'saving', result });
      return setStatus({ state: terminalStateOf(info.reason), pending: null, phase: undefined, result });
    },
    get history() {
      return history;
    },
    get answers() {
      return answers;
    },
    get signals() {
      return [];
    },
    get cost() {
      return 0;
    },
    get answerCount() {
      return answers.length;
    },
  };
}

// ---- 統括のコマンド ----------------------------------------------------------------------------------------

export function parseRelayArgs(argv) {
  const [command, ...rest] = argv;
  if (!['wait', 'answer', 'status'].includes(command)) throw new RelayError('usage', 'コマンドは wait・answer・status のどれかです。');
  const out = { command, pollMs: 1000 };
  const need = (i, flag) => {
    if (i + 1 >= rest.length) throw new RelayError('usage', `${flag} には値が要ります。`);
    return rest[i + 1];
  };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    switch (flag) {
      case '--relay': out.relay = need(i, flag); i += 1; break;
      case '--id': out.id = need(i, flag); i += 1; break;
      case '--text': out.text = need(i, flag); i += 1; break;
      case '--text-file': out.textFile = need(i, flag); i += 1; break;
      case '--timeout-seconds': out.timeoutSeconds = Number(need(i, flag)); i += 1; break;
      case '--poll-ms': out.pollMs = Number(need(i, flag)); i += 1; break;
      case '--stale-seconds': out.staleSeconds = Number(need(i, flag)); i += 1; break;
      default: throw new RelayError('usage', `知らない引数です：${flag}`);
    }
  }
  if (!out.relay) throw new RelayError('usage', '--relay（中継のフォルダ）が要ります。');
  if (!(Number.isFinite(out.pollMs) && out.pollMs > 0)) throw new RelayError('usage', '--poll-ms は正の数にしてください。');
  if (out.timeoutSeconds !== undefined && !(out.timeoutSeconds > 0)) throw new RelayError('usage', '--timeout-seconds は正の数にしてください。');
  if (out.staleSeconds !== undefined && !(out.staleSeconds > 0)) throw new RelayError('usage', '--stale-seconds は正の数にしてください。');
  if (command === 'answer') {
    if (!out.id) throw new RelayError('usage', '--id（答える問いの id）が要ります。');
    if ((out.text === undefined) === (out.textFile === undefined)) throw new RelayError('usage', '--text か --text-file の、どちらか 1 つで答えを渡してください。');
  }
  return out;
}

/**
 * 試験の仕組みのプロセスがないか。ないと分かったときは、その手がかり（heartbeat か pid）、分からない・動いているときは null。
 * heartbeatAt が staleMs より古ければ、ない。番号の空間が同じなら、pid も確かめる（違う空間の番号は、別のプロセスを指す）
 */
export function deadBy(status, { now = Date.now(), staleMs = STALE_MS, pidNs = currentPidNs() } = {}) {
  const beat = Date.parse(status.heartbeatAt ?? '');
  if (Number.isFinite(beat) && now - beat > staleMs) return 'heartbeat';
  if ((status.pidNs ?? null) === (pidNs ?? null) && !pidAlive(status.pid)) return 'pid';
  return null;
}

/**
 * wait の 1 回の確かめ。終わった・プロセスがない・答えのない問いがあるときは { code, output }、まだ待つときは null。
 * 終わったことを先に見る（中断で残った答えのない問いを、答えを待つ問いとして返さないように）。
 * @param {string} relayDir
 * @param {{ now?: number, staleMs?: number, pidNs?: string|null }} [options] 試験用（deadBy に渡す）
 */
export function checkWait(relayDir, options = {}) {
  const status = readStatus(relayDir);
  if (!status) return null; // 試験の仕組みがまだ状態を書いていない
  if (TERMINAL_STATES.includes(status.state)) return { code: 3, output: status };
  const dead = deadBy(status, options);
  if (dead) return { code: 4, output: { ...status, state: 'dead', deadBy: dead } };
  // 試験の仕組みが待っている問い（status.pending）だけを返す（中断で待つのをやめた問いを、開発者に聞かないように）
  const question = pendingQuestion(relayDir);
  return question && question.id === status.pending ? { code: 0, output: question } : null;
}

/** @returns {Promise<{ code: number, output: object }>} */
export async function runRelayCommand(argv) {
  let args;
  try {
    args = parseRelayArgs(argv);
  } catch (error) {
    return { code: 2, output: { ok: false, error: error.code ?? 'usage', message: error.message } };
  }
  const relayDir = path.resolve(args.relay);
  try {
    if (args.command === 'answer') {
      let text = args.text;
      if (args.textFile !== undefined) {
        try {
          text = fs.readFileSync(args.textFile, 'utf8').replace(/\r?\n$/, '');
        } catch (error) {
          throw new RelayError('no_text_file', `答えのファイルを読めません（${args.textFile}）：${error.message}`);
        }
      }
      return { code: 0, output: answerQuestion(relayDir, args.id, text) };
    }
    if (args.command === 'status') {
      const status = readStatus(relayDir);
      if (!status) throw new RelayError('no_status', `中継のフォルダに status.json がありません（${relayDir}）。`);
      const question = TERMINAL_STATES.includes(status.state) ? null : pendingQuestion(relayDir);
      return { code: 0, output: { status, pending: question && question.id === status.pending ? question : null } };
    }
    const started = Date.now();
    for (;;) {
      const hit = checkWait(relayDir, args.staleSeconds !== undefined ? { staleMs: args.staleSeconds * 1000 } : {});
      if (hit) return hit;
      if (args.timeoutSeconds !== undefined && Date.now() - started >= args.timeoutSeconds * 1000) return { code: 5, output: { state: 'timeout' } };
      await new Promise((resolve) => setTimeout(resolve, args.pollMs));
    }
  } catch (error) {
    if (error instanceof RelayError) return { code: 2, output: { ok: false, error: error.code, message: error.message } };
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { code, output } = await runRelayCommand(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = code;
}
