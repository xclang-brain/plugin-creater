// 調べもの用（リポジトリには入れない）。擬似の機器（試験の仕組みが外で動かすプロセス）に、サンドボックスの中の
// scp・ssh の差し替え（PATH の先頭に置いたスクリプト）から、サンドボックスのプロキシ経由の HTTP（localhost）で届くかを確かめる。
// 機器の中身（ルートのフォルダ）は作業フォルダの外に置き、ARM の実行ファイルは qemu-arm で動かす。実際のモデルは呼ばない。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as realSdk from '@anthropic-ai/claude-agent-sdk';

const RUNNER = '/home/user/plugin-creator/tests/dev-eval/runner';
const { makeQueryOptions } = await import(path.join(RUNNER, 'isolation.mjs'));
const { startFakeAnthropic, guardSdk, lastToolResults } = await import(path.join(RUNNER, 'fake-anthropic.mjs'));

const BASE = path.resolve(process.argv[2] ?? '/tmp/pcprobe-device');
fs.rmSync(BASE, { recursive: true, force: true });
const work = path.join(BASE, 'work');
const home = path.join(BASE, 'home');
const rootfs = path.join(BASE, 'device-rootfs'); // 作業フォルダの外（サンドボックスの中からは書けない）
const shim = path.join(BASE, 'shim');
const consoleLog = path.join(BASE, 'device-console.log');
for (const d of [work, home, rootfs, shim]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(work, 'main.c'), '#include <stdio.h>\nint main(void){printf("AVG=%d\\n", 25);return 0;}\n');

// 擬似の機器：/put で受け取ったファイルを rootfs に置き、/exec でコマンドを動かす（ARM の ELF は qemu-arm）。
const history = [];
const device = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://localhost');
    const body = Buffer.concat(chunks);
    if (url.pathname === '/put') {
      const dest = path.join(rootfs, path.normalize(url.searchParams.get('path')).replace(/^\/+/, ''));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, body, { mode: 0o755 });
      history.push(`put ${url.searchParams.get('path')} ${body.length}`);
      res.end('ok\n');
      return;
    }
    if (url.pathname === '/exec') {
      const cmd = body.toString('utf8').trim();
      history.push(`exec ${cmd}`);
      const [prog, ...args] = cmd.split(/\s+/);
      const target = path.join(rootfs, prog.replace(/^\/+/, ''));
      const r = fs.existsSync(target)
        ? spawnSync('qemu-arm', ['-L', '/usr/arm-linux-gnueabihf', target, ...args], { encoding: 'utf8', timeout: 10_000 })
        : { status: 127, stdout: '', stderr: `sh: ${prog}: not found\n` };
      fs.appendFileSync(consoleLog, `# ${cmd}\n${r.stdout}${r.stderr}`);
      res.writeHead(200, { 'x-exit': String(r.status ?? 1) });
      res.end(`${r.stdout}${r.stderr}`);
      return;
    }
    res.writeHead(404).end();
  });
});
await new Promise((r) => device.listen(0, '127.0.0.1', r));
const port = device.address().port;

// 差し替えの scp・ssh。サンドボックスの中では NO_PROXY に localhost が入るので、プロキシを明示して localhost に送る
const client = `#!/usr/bin/env python3
import os, sys, urllib.request
PORT = ${port}
# サンドボックスの NO_PROXY には localhost が入る。localhost もプロキシに送るため外す
for k in ('NO_PROXY', 'no_proxy'):
    os.environ.pop(k, None)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({'http': os.environ.get('HTTP_PROXY') or os.environ.get('http_proxy')}))
def post(path, data):
    with opener.open(urllib.request.Request(f'http://localhost:{PORT}{path}', data=data, method='POST'), timeout=30) as r:
        return r.read().decode(), int(r.headers.get('x-exit', '0'))
name = os.path.basename(sys.argv[0])
if name == 'scp':
    src, dst = sys.argv[-2], sys.argv[-1]
    host, rpath = dst.split(':', 1)
    out, code = post('/put?path=' + rpath, open(src, 'rb').read())
    sys.exit(0)
else:
    host, cmd = sys.argv[1], ' '.join(sys.argv[2:])
    out, code = post('/exec', cmd.encode())
    sys.stdout.write(out); sys.exit(code)
`;
for (const name of ['scp', 'ssh']) fs.writeFileSync(path.join(shim, name), client, { mode: 0o755 });

const command = [
  'arm-linux-gnueabihf-gcc -O0 -g -o sensor.out main.c',
  'scp sensor.out root@192.168.7.2:/opt/app/sensor.out',
  'ssh root@192.168.7.2 /opt/app/sensor.out',
  'echo "exit=$?"',
  'echo "== tamper: write device rootfs directly"; (echo x > ' + rootfs + '/opt/app/fake && echo wrote) 2>&1 | tail -1',
].join(' && ');

let toolResult = null;
const api = await startFakeAnthropic(async ({ body }) => {
  const results = lastToolResults(body);
  if (toolResult === null && body?.tools?.some((t) => t.name === 'Bash')) {
    if (results.length === 0) return { blocks: [{ type: 'tool_use', name: 'Bash', input: { command, description: 'device' } }] };
    toolResult = results.join('\n');
  }
  return { blocks: [{ type: 'text', text: 'done' }] };
});
const options = makeQueryOptions({
  cwd: work, home, model: 'claude-haiku-5-5', sandbox: true, maxTurns: 4,
  envExtra: { ANTHROPIC_API_KEY: 'fake-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ANTHROPIC_BASE_URL: api.url, CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1', PATH: `${shim}:${process.env.PATH}` },
});
options.sandbox = { ...options.sandbox, network: { allowedDomains: ['localhost'] } };
const canCalls = [];
const orig = options.canUseTool;
options.canUseTool = async (t, i, c) => { canCalls.push(t); return t === 'SandboxNetworkAccess' ? { behavior: 'deny', message: 'no' } : orig(t, i, c); };
for await (const m of guardSdk(realSdk, api).query({ prompt: 'go', options })) { /* 流す */ }
await api.close();
device.close();
console.log(JSON.stringify({ toolResult, canCalls, history, consoleLog: fs.existsSync(consoleLog) ? fs.readFileSync(consoleLog, 'utf8') : null, tampered: fs.existsSync(path.join(rootfs, 'opt/app/fake')) }, null, 2));
