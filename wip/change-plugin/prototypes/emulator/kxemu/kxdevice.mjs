// 試験の仕組みから擬似の機器（kxemu.py）を動かす（試作）。起動・停止・工場出荷に戻す・記録を読む。
//
//   const dev = await startDevice({ stateDir });
//   dev.env            // 試されるエージェントに足す環境変数（PATH の先頭に kxtool、KXEMU_GATEWAY、KXEMU_ADDRS）
//   dev.sandboxNetwork // サンドボックスの network に足すもの（この機器の HTTP のつなぎ口だけを許す）
//   await dev.reset(); const { consoleLog, history } = dev.records(); await dev.stop();
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EMULATOR = path.join(HERE, 'kxemu.py');

async function waitFor(file, ms = 10_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`擬似の機器が ${ms}ms のうちに起動しませんでした（${file}）`);
}

/**
 * @param {object} o
 * @param {string} o.stateDir 機器の中身を置くフォルダ（作業フォルダの外にする）
 * @param {string[]} [o.addresses] 機器のアドレスとして受けるもの（ほかは No route to host）
 * @param {'auto'|'bwrap'|'none'} [o.isolate]
 * @param {boolean} [o.fresh] 真なら工場出荷の状態から始める
 */
export async function startDevice({ stateDir, addresses = ['192.168.7.2'], isolate = 'auto', fresh = true, ports = {} }) {
  let child = null;
  let ready = null;
  const readyFile = `${stateDir}.ready.json`;
  const launch = async () => {
    fs.rmSync(readyFile, { force: true });
    const args = ['-I', EMULATOR, 'serve', '--state', stateDir, '--ready-file', readyFile, '--isolate', isolate,
      '--console-port', String(ports.console ?? 0), '--tftp-port', String(ports.tftp ?? 0), '--http-port', String(ports.http ?? 0)];
    child = spawn('python3', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code) => { if (code && !ready) console.error(`kxemu exited ${code}: ${stderr}`); });
    ready = await waitFor(readyFile);
    ports = { console: ready.console_port, tftp: ready.tftp_port, http: ready.http_port };
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const done = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    await done;
  };
  if (fresh) spawnSync('python3', ['-I', EMULATOR, 'init', '--state', stateDir], { stdio: 'ignore' });
  await launch();
  const gatewayUrl = () => `http://localhost:${ports.http}`;
  return {
    get ready() { return ready; },
    get gatewayUrl() { return gatewayUrl(); },
    get env() {
      return { KXEMU_GATEWAY: gatewayUrl(), KXEMU_ADDRS: addresses.join(',') };
    },
    /** PATH の先頭に足すフォルダ（kxtool がある） */
    binDir: HERE,
    get sandboxNetwork() { return { allowedDomains: [`localhost:${ports.http}`] }; },
    stop,
    /** 工場出荷の状態に戻す（同じポートで起動し直す） */
    async reset() {
      await stop();
      spawnSync('python3', ['-I', EMULATOR, 'init', '--state', stateDir], { stdio: 'ignore' });
      await launch();
    },
    records() {
      const consoleLog = fs.readFileSync(path.join(stateDir, 'console.log'), 'utf8').replace(/\r\n/g, '\n');
      const history = fs.readFileSync(path.join(stateDir, 'history.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      return { consoleLog, history };
    },
  };
}
