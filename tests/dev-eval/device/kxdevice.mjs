// 擬似の機器 KX-200（kxemu.py）を、開発の試験の仕組みから動かす。起動・止める・工場出荷に戻す・記録を読む・記録を作業フォルダに写す。
// 機器は、試されるエージェントのサンドボックスの外で動かす。エージェントは PATH の先頭の kxtool（メーカーの道具の役）で、
// 機器の HTTP の口（1ポート）にだけ届く（testing.md 7章）。
//
//   const dev = await startDevice({ stateDir: '<実行のフォルダ>/device' });   // 機器の中身。作業フォルダの外に置く
//   dev.env                // エージェントに足す環境変数（KXEMU_GATEWAY、KXEMU_ADDRS）
//   dev.binDir             // PATH の先頭に足すフォルダ（kxtool だけがある）
//   dev.sandboxNetwork     // サンドボックスの network（この機器の HTTP の口だけを許す）
//   dev.sandboxFilesystem  // サンドボックスの filesystem（機器の中身を見せない・書かせない）
//   await dev.reset();     // 工場出荷の状態に戻す（同じポートで起動し直す）
//   dev.records();         // { consoleLog, history }
//   dev.copyRecordsTo(workDir);  // <workDir>/.device/console.log と history.jsonl に写す（採点の前）
//   await dev.stop();
//
// 機器を操作する口（起動・止める・初期化）は、HTTP の口に載せず、プロセスの起動と終了で行う。
// エージェントが機器を工場出荷に戻したり、記録を消したりできないようにするためである。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 擬似の機器の本体 */
export const EMULATOR = path.join(HERE, 'kxemu.py');
/** PATH の先頭に足すフォルダ。kxtool だけを置く（kxemu.py などを PATH に入れないため） */
export const BIN_DIR = path.join(HERE, 'bin');
/** copyRecordsTo が作業フォルダに作るフォルダの名前 */
export const RECORDS_DIR = '.device';
/** 機器が起動したら書くファイル（状態のフォルダの中。サンドボックスからは見えない） */
const READY_FILE = 'ready.json';
const ISOLATES = ['auto', 'bwrap', 'none'];
const START_MS = 10_000;
const STOP_MS = 5_000;

const live = new Set();
let exitHookSet = false;
/** 試験の仕組みが先に終わっても、機器のプロセスを残さない */
function track(child) {
  live.add(child);
  child.once('exit', () => live.delete(child));
  if (!exitHookSet) {
    exitHookSet = true;
    process.once('exit', () => {
      for (const c of live) c.kill('SIGKILL');
    });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function initState(stateDir) {
  const r = spawnSync('python3', ['-I', EMULATOR, 'init', '--state', stateDir], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`擬似の機器の中身を作れませんでした（${stateDir}）：${(r.stderr || r.error?.message || '').trim()}`);
  }
}

/** kxemu.py serve を起動し、ready.json が書かれるまで待つ */
async function launch(stateDir, isolate, ports) {
  const readyFile = path.join(stateDir, READY_FILE);
  fs.rmSync(readyFile, { force: true });
  const args = ['-I', EMULATOR, 'serve', '--state', stateDir, '--ready-file', readyFile, '--isolate', isolate,
    '--console-port', String(ports.console), '--tftp-port', String(ports.tftp), '--http-port', String(ports.http)];
  const child = spawn('python3', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  track(child);
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  let spawnError = null;
  child.once('error', (e) => { spawnError = e; });
  const until = Date.now() + START_MS;
  while (Date.now() < until) {
    if (spawnError || child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`擬似の機器が起動しませんでした：${(spawnError?.message || stderr || `終了コード ${child.exitCode}`).trim()}`);
    }
    try {
      return { child, ready: JSON.parse(fs.readFileSync(readyFile, 'utf8')) };
    } catch {
      await sleep(50);
    }
  }
  child.kill('SIGKILL');
  throw new Error(`擬似の機器が ${START_MS / 1000} 秒のうちに起動しませんでした（${stateDir}）：${stderr.trim()}`);
}

async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), STOP_MS);
  await done;
  clearTimeout(timer);
}

/**
 * 擬似の機器を、工場出荷の状態から起動する。
 * @param {object} o
 * @param {string} o.stateDir 機器の中身を置くフォルダ（作業フォルダの外にする。前の中身は消える）
 * @param {string[]} [o.addresses] 機器のアドレスとして受けるもの（ほかのアドレスへの kxtool は No route to host で失敗する）
 * @param {'auto'|'bwrap'|'none'} [o.isolate] 機器の中でアプリを動かすときの隔離（auto：bwrap があって、実際に隔離して動かせるときだけ使う。
 *   使えないときは none にし、理由を ready.isolate_note に残す）
 */
export async function startDevice({ stateDir, addresses = ['192.168.7.2'], isolate = 'auto' } = {}) {
  if (typeof stateDir !== 'string' || stateDir === '') throw new Error('startDevice：stateDir（機器の中身を置くフォルダ）が要ります。');
  if (!Array.isArray(addresses) || addresses.length === 0 || !addresses.every((a) => typeof a === 'string' && /^[0-9A-Za-z.:-]+$/.test(a))) {
    throw new Error('startDevice：addresses は、機器のアドレスの文字の並び（1つ以上）で渡します。');
  }
  if (!ISOLATES.includes(isolate)) throw new Error(`startDevice：isolate は ${ISOLATES.join('・')} のどれかです。`);
  const state = path.resolve(stateDir);
  fs.mkdirSync(path.dirname(state), { recursive: true });
  initState(state);
  let { child, ready } = await launch(state, isolate, { console: 0, tftp: 0, http: 0 });
  const ports = { console: ready.console_port, tftp: ready.tftp_port, http: ready.http_port };

  const readRecords = () => {
    const consoleLog = fs.readFileSync(path.join(state, 'console.log'), 'utf8').replace(/\r\n/g, '\n');
    const historyText = fs.readFileSync(path.join(state, 'history.jsonl'), 'utf8');
    return { consoleLog, historyText };
  };

  return {
    /** 起動の情報（pid、ポート、実際の隔離のしかた isolate と、auto で bwrap を使わなかった理由 isolate_note）。I10 の外の読み取り専用の情報 */
    get ready() { return { ...ready }; },
    get env() {
      return { KXEMU_GATEWAY: `http://localhost:${ports.http}`, KXEMU_ADDRS: addresses.join(',') };
    },
    binDir: BIN_DIR,
    get sandboxNetwork() {
      return { allowedDomains: [`localhost:${ports.http}`], strictAllowlist: true };
    },
    get sandboxFilesystem() {
      return { denyRead: [state], denyWrite: [state] };
    },
    /** 工場出荷の状態に戻す（止める → 中身を作り直す → 同じポートで起動し直す） */
    async reset() {
      await terminate(child);
      initState(state);
      ({ child, ready } = await launch(state, isolate, ports));
    },
    /** 機器の記録。consoleLog はコンソールに出た文字のすべて（改行は \n にそろえる）、history は出来事の記録の並び */
    records() {
      const { consoleLog, historyText } = readRecords();
      const history = historyText.split('\n').filter(Boolean).map((line) => JSON.parse(line));
      return { consoleLog, history };
    },
    /**
     * 機器の記録を、作業フォルダの <workDir>/.device/console.log と history.jsonl に写す（採点の前に呼ぶ）。
     * エージェントが同じ名前のファイルを作っていたら、先に消す。.device がフォルダでない（リンクなど）ときも消す。
     * @returns {{ consoleLog: string, history: string }} 写した先の絶対パス
     */
    copyRecordsTo(workDir) {
      const dir = path.join(path.resolve(workDir), RECORDS_DIR);
      let st = null;
      try {
        st = fs.lstatSync(dir);
      } catch {
        st = null;
      }
      if (st && !st.isDirectory()) fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const { consoleLog, historyText } = readRecords();
      const out = { consoleLog: path.join(dir, 'console.log'), history: path.join(dir, 'history.jsonl') };
      for (const file of Object.values(out)) fs.rmSync(file, { recursive: true, force: true });
      fs.writeFileSync(out.consoleLog, consoleLog);
      fs.writeFileSync(out.history, historyText);
      return out;
    },
    /** 止める（SIGTERM。機器は記録に poweroff を足して終わる） */
    async stop() {
      await terminate(child);
    },
  };
}
