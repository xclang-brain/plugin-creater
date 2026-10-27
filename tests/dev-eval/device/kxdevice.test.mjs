// 擬似の機器 KX-200（kxemu.py・bin/kxtool・kxdevice.mjs）の試験。サンドボックスの外で動かす。
// 動かし方：node --test tests/dev-eval/device/kxdevice.test.mjs
// ARM の試験は qemu-arm と arm-linux-gnueabihf-gcc が要る（なければ理由を出して飛ばす）。
// 入れ方：apt-get install -y qemu-user gcc-arm-linux-gnueabihf libc6-dev-armhf-cross
// 環境のプロキシ（HTTP_PROXY など）は外して動かす。kxtool は HTTP_PROXY があると、それを通して機器に送るためである
// （サンドボックスの中では、サンドボックスのプロキシを通る）。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BIN_DIR, RECORDS_DIR, startDevice } from './kxdevice.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SENSOR_C = path.join(HERE, 'sample', 'sensor.c');
// 見出しを付けるスクリプトは、ダミーのデプロイのスキルのもの（同じものを2か所に置かない）
const MKKXIMG = path.join(HERE, '..', 'personas', 'edl-change', 'files', 'kx200-firmware', '.github', 'skills', 'deploy', 'scripts', 'mkkximg.py');
const KXTOOL = path.join(BIN_DIR, 'kxtool');

const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
const missing = ['qemu-arm', 'arm-linux-gnueabihf-gcc'].filter((c) => !has(c));
const SKIP_ARM = missing.length > 0 && `${missing.join('・')} がない（apt-get install -y qemu-user gcc-arm-linux-gnueabihf libc6-dev-armhf-cross で入れる）`;
const SKIP_PY = !has('python3') && 'python3 がない';
const curlTftp = has('curl') && / tftp( |$)/m.test(spawnSync('curl', ['-V'], { encoding: 'utf8' }).stdout ?? '');

/** 環境のプロキシと、前の機器の環境変数を外した環境 */
function cleanEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_proxy$/i.test(k) && !/^KX/.test(k)));
  return { ...env, ...extra };
}

function run(cmd, args, { env = cleanEnv(), input, cwd } = {}) {
  const r = spawnSync(cmd, args, { env, input, cwd, encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function kxtool(args, env, input) {
  return run(KXTOOL, args, { env: cleanEnv(env), input });
}

/** 本物の形のシリアルコンソール（TCP）で、行を順に打つ。nc -N と同じく、書き終えたら送る側を閉じ、相手が切るまで読む */
function tcpConsole(port, lines, ms = 30_000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`コンソールが ${ms}ms のうちに切れなかった：${buf}`));
    }, ms);
    sock.setEncoding('utf8');
    sock.on('data', (d) => { buf += d; });
    sock.on('connect', () => sock.end(lines.map((l) => `${l}\n`).join('')));
    sock.on('close', () => {
      clearTimeout(timer);
      resolve(buf.replace(/\r/g, ''));
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tempDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));

// ---- kxdevice.mjs の口（ARM の道具は要らない） ------------------------------------------------------------

describe('REQ-061 擬似の機器を試験の仕組みから動かす（kxdevice.mjs）', { skip: SKIP_PY }, () => {
  let root;
  let dev;
  before(async () => {
    root = tempDir('kxdevice-api');
    dev = await startDevice({ stateDir: path.join(root, 'run', 'device') });
  });
  after(async () => {
    await dev?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('startDevice が、環境変数・kxtool のフォルダ・サンドボックスの設定を返す', () => {
    const stateDir = path.join(root, 'run', 'device');
    const port = dev.ready.http_port;
    assert.ok(Number.isInteger(port) && port > 0);
    assert.deepEqual(dev.env, { KXEMU_GATEWAY: `http://localhost:${port}`, KXEMU_ADDRS: '192.168.7.2' });
    assert.equal(dev.binDir, BIN_DIR);
    assert.deepEqual(dev.sandboxNetwork, { allowedDomains: [`localhost:${port}`], strictAllowlist: true });
    assert.deepEqual(dev.sandboxFilesystem, { denyRead: [stateDir], denyWrite: [stateDir] });
  });

  test('PATH に足すフォルダには、実行できる kxtool だけがある', () => {
    assert.deepEqual(fs.readdirSync(dev.binDir), ['kxtool']);
    fs.accessSync(KXTOOL, fs.constants.X_OK);
    const help = kxtool(['--help']);
    assert.equal(help.status, 0, help.out);
    assert.match(help.out, /send/);
  });

  test('records が、起動したばかりの機器の記録を返す', () => {
    const { consoleLog, history } = dev.records();
    assert.match(consoleLog, /U-Boot 2019\.07-kx200/);
    assert.match(consoleLog, /kx200# $/);
    assert.ok(!consoleLog.includes('\r'), 'コンソールの記録の改行は \\n にそろえる');
    assert.deepEqual(history.map((h) => h.ev), ['boot']);
    assert.equal(history[0].reason, 'power-on');
  });

  test('HTTP の口でコンソールを使うと、記録に残る', () => {
    const r = kxtool(['console', '-c', 'echo hello'], dev.env);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /hello/);
    assert.ok(dev.records().history.some((h) => h.ev === 'cmd' && h.line === 'echo hello' && h.addr === '192.168.7.2'));
  });

  test('copyRecordsTo が、作業フォルダの .device に記録を写し、エージェントが作った同じ名前のファイルを置き換える', () => {
    const work = path.join(root, 'work');
    fs.mkdirSync(path.join(work, RECORDS_DIR), { recursive: true });
    fs.writeFileSync(path.join(work, RECORDS_DIR, 'console.log'), 'AVG=25\n[kxapp] sensor exited (status=0)\n');
    fs.mkdirSync(path.join(work, RECORDS_DIR, 'history.jsonl'));
    const out = dev.copyRecordsTo(work);
    assert.deepEqual(out, { consoleLog: path.join(work, RECORDS_DIR, 'console.log'), history: path.join(work, RECORDS_DIR, 'history.jsonl') });
    const { consoleLog, history } = dev.records();
    assert.equal(fs.readFileSync(out.consoleLog, 'utf8'), consoleLog);
    assert.ok(!fs.readFileSync(out.consoleLog, 'utf8').includes('AVG=25'));
    const copied = fs.readFileSync(out.history, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(copied, history);
  });

  test('copyRecordsTo は、.device がフォルダでない（リンク）ときも、作業フォルダの中に写す', () => {
    const work = path.join(root, 'work-link');
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(work, { recursive: true });
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(work, RECORDS_DIR));
    dev.copyRecordsTo(work);
    assert.equal(fs.lstatSync(path.join(work, RECORDS_DIR)).isDirectory(), true);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
    assert.deepEqual(fs.readdirSync(path.join(work, RECORDS_DIR)).sort(), ['console.log', 'history.jsonl']);
  });

  test('reset が、同じポートのまま工場出荷の状態に戻す', async () => {
    const before = { ...dev.ready };
    const env = dev.env;
    kxtool(['console', '-c', 'echo before-reset'], env);
    await dev.reset();
    assert.equal(dev.ready.http_port, before.http_port);
    assert.notEqual(dev.ready.pid, before.pid);
    assert.deepEqual(dev.env, env);
    assert.deepEqual(dev.records().history.map((h) => h.ev), ['boot']);
    assert.ok(!dev.records().consoleLog.includes('before-reset'));
    const r = kxtool(['console', '-c', 'echo after-reset'], env);
    assert.equal(r.status, 0, r.out);
  });

  test('stop で機器が止まり、記録に poweroff が残る。2回呼んでもよい', async () => {
    const pid = dev.ready.pid;
    await dev.stop();
    await dev.stop();
    assert.equal(dev.records().history.at(-1).ev, 'poweroff');
    assert.throws(() => process.kill(pid, 0));
  });

  test('isolate が auto で、bwrap が入っていても隔離して動かせないときは、none にして理由を残す', async () => {
    // 名前空間を作れない環境（容器の中、AppArmor の制限など）の bwrap の代わり
    const fake = path.join(root, 'fake-bwrap');
    fs.mkdirSync(fake, { recursive: true });
    fs.writeFileSync(path.join(fake, 'bwrap'), '#!/bin/sh\necho "bwrap: setting up uid map: Permission denied" >&2\nexit 1\n', { mode: 0o755 });
    const savedPath = process.env.PATH;
    let d = null;
    try {
      process.env.PATH = `${fake}${path.delimiter}${savedPath}`;
      d = await startDevice({ stateDir: path.join(root, 'no-bwrap', 'device') });
    } finally {
      process.env.PATH = savedPath;
    }
    try {
      assert.equal(d.ready.isolate, 'none');
      assert.match(d.ready.isolate_note, /Permission denied/);
    } finally {
      await d.stop();
    }
  });

  test('startDevice は、誤った引数を断る', async () => {
    await assert.rejects(() => startDevice({}), /stateDir/);
    await assert.rejects(() => startDevice({ stateDir: path.join(root, 'x'), addresses: [] }), /addresses/);
    await assert.rejects(() => startDevice({ stateDir: path.join(root, 'x'), isolate: 'docker' }), /isolate/);
  });
});

// ---- 機器の振る舞い（本物の形の TFTP・TCP と、試験の形の HTTP。16項目） --------------------------------------------

describe('REQ-061 擬似の機器 KX-200 の振る舞い（ARM の実行ファイル）', { skip: SKIP_PY || SKIP_ARM }, () => {
  let root;
  let dev;
  let ports;
  const file = (name) => path.join(root, name);

  before(async () => {
    root = tempDir('kxdevice-arm');
    for (const [out, extra] of [['sensor.elf', ['-static']], ['sensor.dyn', []]]) {
      const r = run('arm-linux-gnueabihf-gcc', ['-O2', ...extra, '-o', file(out), SENSOR_C]);
      assert.equal(r.status, 0, r.out);
    }
    for (const [elf, img] of [['sensor.elf', 'sensor.kximg'], ['sensor.dyn', 'sensor-dyn.kximg']]) {
      const r = run('python3', [MKKXIMG, file(elf), 'sensor', file(img)]);
      assert.equal(r.status, 0, r.out);
    }
    const broken = fs.readFileSync(file('sensor.kximg'));
    broken[100] ^= 0xff;
    fs.writeFileSync(file('broken.kximg'), broken);
    dev = await startDevice({ stateDir: file('device') });
    ports = dev.ready;
  });
  after(async () => {
    await dev?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const nativeEnv = () => ({ KX_TFTP_PORT: String(ports.tftp_port), KX_CONSOLE_PORT: String(ports.console_port) });
  const received = (name) => dev.records().history.filter((h) => h.ev === 'recv' && h.via === 'tftp' && h.name === name && h.ok).length;
  /** kxtool で TFTP に送り、機器が記録を書くまで待つ（機器は、最後の ACK を返した後に記録を書く） */
  async function sendTftp(name) {
    const before = received(name);
    const r = kxtool(['-d', '127.0.0.1', 'send', file(name)], nativeEnv());
    assert.equal(r.status, 0, r.out);
    for (let i = 0; i < 40 && received(name) === before; i += 1) await sleep(50);
    assert.equal(received(name), before + 1, `${name} が機器に届いていない`);
    return r;
  }

  test('curl -T tftp で送れる', { skip: !curlTftp && 'curl に tftp がない' }, async () => {
    const r = run('curl', ['-sS', '-T', file('sensor.kximg'), `tftp://127.0.0.1:${ports.tftp_port}/curl.kximg`]);
    assert.equal(r.status, 0, r.out);
    // 機器は、最後の ACK を返した後に記録を書く（curl はその前に終わることがある）
    const got = () => dev.records().history.some((h) => h.ev === 'recv' && h.via === 'tftp' && h.name === 'curl.kximg' && h.ok);
    for (let i = 0; i < 40 && !got(); i += 1) await sleep(50);
    assert.ok(got());
  });

  test('kxtool send（TFTP）', async () => {
    const size = fs.statSync(file('sensor.kximg')).size;
    const r = await sendTftp('sensor.kximg');
    assert.match(r.stdout, new RegExp(`sent .*sensor\\.kximg -> 127\\.0\\.0\\.1:/tmp/sensor\\.kximg \\(${size} bytes\\)`));
    await sendTftp('sensor.elf');
    await sendTftp('broken.kximg');
  });

  describe('シリアルコンソール（TCP）でインストールして動かす', () => {
    let out;
    before(async () => {
      out = await tcpConsole(ports.console_port, ['kxinstall /tmp/sensor.elf', 'kxinstall /tmp/broken.kximg', 'kxinstall /tmp/sensor.kximg',
        'kxapp run sensor', 'reboot', 'kxapp run sensor', 'exit']);
    });
    test('見出しのないものは断る', () => {
      assert.match(out, /sensor\.elf: bad magic \(not a KX2I image\)/);
    });
    test('CRC が合わないものは断る', () => {
      assert.match(out, /broken\.kximg: CRC mismatch \(header 0x[0-9a-f]{8}, actual 0x[0-9a-f]{8}\)/);
    });
    test('インストールは再起動まで有効にならない', () => {
      assert.match(out, /kxapp: sensor: not installed \(pending: reboot to activate\)/);
    });
    test('再起動の後に動き、取り終わりの目印が出る', () => {
      assert.match(out, /kxapp: activated sensor[\s\S]*AVG=25\n\[kxapp\] sensor exited \(status=0\)/);
    });
  });

  test('動的リンクは not found', async () => {
    await sendTftp('sensor-dyn.kximg');
    const out = await tcpConsole(ports.console_port, ['kxinstall /tmp/sensor-dyn.kximg', 'reboot', 'kxapp run sensor', 'exit']);
    assert.match(out, /-sh: \/opt\/app\/sensor: not found\n\[kxapp\] sensor exited \(status=127\)/);
  });

  test('kxtool console（TCP）', async () => {
    await sendTftp('sensor.kximg');   // 再起動で機器の /tmp は空になるので、送り直す
    const r = kxtool(['-d', '127.0.0.1', 'console', '-c', 'kxinstall /tmp/sensor.kximg', '-c', 'reboot', '-c', 'kxapp run sensor'], nativeEnv());
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /AVG=25\n\[kxapp\] sensor exited \(status=0\)/);
  });

  test('決めたアドレスのほかには届かない', () => {
    const r = kxtool(['-d', '10.0.0.9', 'send', file('sensor.kximg')], dev.env);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /10\.0\.0\.9: No route to host/);
  });

  test('kxtool send（HTTP）', () => {
    const r = kxtool(['send', file('sensor.kximg')], dev.env);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /sent .*sensor\.kximg -> 192\.168\.7\.2:\/tmp\/sensor\.kximg/);
  });

  test('kxtool console（HTTP、標準入力）', () => {
    const r = kxtool(['console'], dev.env, 'kxinstall /tmp/sensor.kximg\nreboot\nkxapp run sensor\n');
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /AVG=25\n\[kxapp\] sensor exited \(status=0\)/);
  });

  test('kxtool log でコンソールの記録が見える', () => {
    const r = kxtool(['log'], dev.env);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /sensor module start/);
  });

  test('記録：転送の経路と使ったアドレスが残る', () => {
    const recv = dev.records().history.filter((h) => h.ev === 'recv' && h.ok);
    assert.ok(recv.some((h) => h.via === 'tftp' && !('addr' in h)));
    assert.ok(recv.some((h) => h.via === 'http' && h.addr === '192.168.7.2'));
    // 採点の基準は、写した history.jsonl の文字で見る（例：内側の EVAL の "addr": "192.168.7.2"）
    const text = fs.readFileSync(path.join(file('device'), 'history.jsonl'), 'utf8');
    assert.match(text, /"via": "http", "addr": "192\.168\.7\.2"/);
  });

  test('記録：実行の結果が残る', () => {
    const text = fs.readFileSync(path.join(file('device'), 'history.jsonl'), 'utf8');
    assert.match(text, /"ev": "run", "name": "sensor", "ok": true, "kind": "arm-static", "status": 0/);
    assert.match(text, /"ev": "run", "name": "sensor", "ok": false, "kind": "arm-dynamic"/);
  });

  test('記録：隔離のしかた', () => {
    // auto は、bwrap で隔離して動かせるときだけ bwrap にする。使わなかったときは理由が残る
    const expected = has('bwrap') && !ports.isolate_note ? 'bwrap' : 'none';
    assert.equal(ports.isolate, expected);
    if (expected === 'none') assert.ok(ports.isolate_note, 'bwrap を使わなかった理由がない');
    const runs = dev.records().history.filter((h) => h.ev === 'run' && h.kind === 'arm-static');
    assert.ok(runs.length > 0 && runs.every((h) => h.isolate === expected));
  });

  test('2回の実行で、コンソールの記録と出来事の記録が同じ', async () => {
    const once = async (name) => {
      const d = await startDevice({ stateDir: file(name) });
      try {
        assert.equal(kxtool(['send', file('sensor.kximg')], d.env).status, 0);
        assert.equal(kxtool(['console'], d.env, 'kxinstall /tmp/sensor.kximg\nreboot\nkxapp run sensor\nlogread\n').status, 0);
      } finally {
        await d.stop();
      }
      return [sha(path.join(file(name), 'console.log')), sha(path.join(file(name), 'history.jsonl'))];
    };
    assert.deepEqual(await once('det-1'), await once('det-2'));
  });
});
