// 調べもの用（リポジトリには入れない）。偽の Anthropic API につないだ本物の Claude Code（Agent SDK 0.3.310 同梱）で、
// サンドボックスの中の Bash から、擬似の機器（kxemu）のどの口に届くかを確かめる。実際のモデルは呼ばない（guardSdk）。
//   node probe-sandbox-emu.mjs <variant>   variant = default | localhost | port
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SDK = '/tmp/claude-0/-home-user/64a230fb-e6a2-510f-9e7e-9e6600fd34a8/scratchpad/research-scratch/sdkenv/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
const RUNNER = '/home/user/plugin-creator/tests/dev-eval/runner';
const realSdk = await import(SDK);
const { makeQueryOptions } = await import(path.join(RUNNER, 'isolation.mjs'));
const { startFakeAnthropic, guardSdk, lastToolResults } = await import(path.join(RUNNER, 'fake-anthropic.mjs'));
const { startDevice } = await import(path.join(HERE, 'kxemu', 'kxdevice.mjs'));

const variant = process.argv[2] ?? 'default';
const RUN = path.join(HERE, 'runs', `sandbox-${variant}`);
fs.rmSync(RUN, { recursive: true, force: true });
const dirs = Object.fromEntries(['work', 'home', 'outside', 'cctmp'].map((d) => [d, path.join(RUN, d)]));
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });

// 機器（作業フォルダの外）
const dev = await startDevice({ stateDir: path.join(RUN, 'device') });
const { console_port: CP, tftp_port: TP, http_port: HP } = dev.ready;

// 作業フォルダ：ビルドとイメージ作りまでは済ませておく（ここで確かめたいのは機器への届き方）
const w = dirs.work;
spawnSync('arm-linux-gnueabihf-gcc', ['-O2', '-static', '-o', path.join(w, 'sensor.elf'), path.join(HERE, 'sample', 'sensor.c')]);
spawnSync('python3', [path.join(HERE, 'sample', 'mkkximg.py'), path.join(w, 'sensor.elf'), 'sensor', path.join(w, 'sensor.kximg')]);
fs.writeFileSync(path.join(w, 'connect.py'), `
import base64, os, socket, sys, urllib.parse
host, port, text = sys.argv[1], int(sys.argv[2]), sys.argv[3]
p = urllib.parse.urlsplit(os.environ['HTTP_PROXY'])
s = socket.create_connection((p.hostname, p.port), timeout=5)
auth = ''
if p.username is not None:
    auth = 'Proxy-Authorization: Basic ' + base64.b64encode(f'{urllib.parse.unquote(p.username)}:{urllib.parse.unquote(p.password or "")}'.encode()).decode() + '\\r\\n'
s.sendall(f'CONNECT {host}:{port} HTTP/1.1\\r\\nHost: {host}:{port}\\r\\n{auth}\\r\\n'.encode())
head = s.recv(4096).decode(errors='replace')
print('proxy:', head.splitlines()[0] if head else '(no reply)')
if ' 200' in head.splitlines()[0]:
    s.sendall(text.encode().decode('unicode_escape').encode())
    data = b''
    while True:
        try:
            c = s.recv(4096)
        except socket.timeout:
            break
        if not c:
            break
        data += c
    print(data.decode(errors='replace').replace('\\r', '').strip().splitlines()[-3:])
`);
// FIFO（作業フォルダの外）。外で読む
const fifo = path.join(dirs.outside, 'console.in');
spawnSync('mkfifo', [fifo]);
const fifoReader = spawn('sh', ['-c', `cat '${fifo}' > '${path.join(RUN, 'fifo.got')}'`], { stdio: 'ignore' });

const probe = [
  'echo "== 1 UDP: curl -T tftp://127.0.0.1 (直接)"; curl -sS -m 5 -T sensor.kximg tftp://127.0.0.1:' + TP + '/a.kximg; echo "exit=$?"',
  'echo "== 2 UDP: curl -T tftp:// にプロキシを明示"; curl -sS -m 5 --noproxy "" -x "$HTTP_PROXY" -T sensor.kximg tftp://localhost:' + TP + '/b.kximg; echo "exit=$?"',
  'echo "== 3 TCP: nc 127.0.0.1 コンソール（直接）"; printf "echo direct-tcp\\nexit\\n" | timeout 5 nc -N -w 3 127.0.0.1 ' + CP + '; echo "exit=$?"',
  'echo "== 4 TCP: プロキシの CONNECT でコンソール（localhost）"; timeout 10 python3 connect.py localhost ' + CP + ' "echo via-connect\\nexit\\n"; echo "exit=$?"',
  'echo "== 5 TCP: プロキシの CONNECT で HTTP の口（localhost）"; timeout 10 python3 connect.py localhost ' + HP + ' "GET / HTTP/1.0\\r\\n\\r\\n"; echo "exit=$?"',
  'echo "== 6 通し：中でビルド→イメージ→kxtool send→install→reboot→run→log"; cp ' + path.join(HERE, 'sample', 'sensor.c') + ' ' + path.join(HERE, 'sample', 'mkkximg.py') + ' . && arm-linux-gnueabihf-gcc -O2 -static -o app.elf sensor.c && python3 mkkximg.py app.elf sensor app.kximg && kxtool send app.kximg && kxtool console -c "kxinstall /tmp/app.kximg" -c reboot -c "kxapp run sensor" > device.log && tail -3 device.log; echo "exit=$?"',
  'echo "== 7 HTTP: curl でプロキシを明示せず（NO_PROXY で直接）"; curl -sS -m 5 http://localhost:' + HP + '/ | head -c 80; echo " exit=$?"',
  'echo "== 8 FIFO（作業フォルダの外）に書く"; timeout 3 sh -c "echo fifo-ok > ../outside/console.in"; echo "exit=$?"',
  'echo "== 9 機器の中身を読む"; wc -l < ' + path.join(RUN, 'device', 'history.jsonl') + '; echo "exit=$?"',
  'echo "== 10 機器の中身に書く"; (echo forged >> ' + path.join(RUN, 'device', 'console.log') + ') 2>&1 | tail -1; echo "exit=$?"',
  'echo "== 11 ARM をその場で動かす（機器を使わずに）"; qemu-arm ./sensor.elf | tail -1; echo "exit=$?"',
  'echo "== 12 環境"; env | grep -iE "^(http_proxy|no_proxy|all_proxy|KXEMU)" | sed -E "s#//[^@]*@#//***@#" | sort',
].join('\n');
fs.writeFileSync(path.join(w, 'probe.sh'), probe + '\n');

let toolResult = null;
const api = await startFakeAnthropic(async ({ body }) => {
  if (body?.tools?.some((t) => t.name === 'Bash') && toolResult === null) {
    const results = lastToolResults(body);
    if (results.length === 0) return { blocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'bash probe.sh', description: 'probe', timeout: 120000 } }] };
    toolResult = results.join('\n');
  }
  return { blocks: [{ type: 'text', text: 'done' }] };
});
const sdk = guardSdk(realSdk, api);
const options = makeQueryOptions({
  cwd: w, home: dirs.home, model: 'claude-haiku-5-5', sandbox: true, maxTurns: 4,
  envExtra: {
    ANTHROPIC_API_KEY: 'fake-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ANTHROPIC_BASE_URL: api.url,
    CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', CLAUDE_CODE_TMPDIR: dirs.cctmp,
    PATH: `${dev.binDir}:${process.env.PATH}`, ...dev.env,
  },
});
if (variant === 'localhost') options.sandbox = { ...options.sandbox, network: { allowedDomains: ['localhost'] } };
if (variant === 'port') {
  options.sandbox = { ...options.sandbox, network: { ...dev.sandboxNetwork, strictAllowlist: true },
    filesystem: { denyRead: [path.join(RUN, 'device')], denyWrite: [path.join(RUN, 'device')] } };
}
const canCalls = [];
options.canUseTool = async (toolName, input) => {
  canCalls.push({ toolName, input: JSON.stringify(input).slice(0, 200) });
  return { behavior: 'deny', message: 'denied by probe' };
};
const results = [];
try {
  for await (const m of sdk.query({ prompt: 'probe', options })) if (m.type === 'result') results.push({ subtype: m.subtype, is_error: m.is_error });
} finally {
  await api.close();
  fifoReader.kill();
}
const before = dev.records().history;
await dev.reset();
const afterReset = dev.records().history.map((h) => h.ev);
await dev.stop();
const fifoGot = fs.existsSync(path.join(RUN, 'fifo.got')) ? fs.readFileSync(path.join(RUN, 'fifo.got'), 'utf8').trim() : null;
const history = before;
console.log(JSON.stringify({ variant, sandbox: options.sandbox, toolResult, canCalls, results, fifoGot, afterReset, portsAfterReset: dev.ready,
  deviceEvents: history.map((h) => `${h.ev}${h.via ? `/${h.via}` : ''}${h.addr ? `@${h.addr}` : ''}${h.line ? `:${h.line}` : ''}${h.name ? `:${h.name}` : ''}${h.ok === undefined ? '' : `:${h.ok}`}`) }, null, 2));
