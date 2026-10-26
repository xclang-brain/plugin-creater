// 調べもの用（リポジトリには入れない）。偽の Anthropic API で本物の Claude Code（Agent SDK 0.3.310）を動かし、
// サンドボックスの中のコマンドから、作業フォルダの Unix ソケット・外の Unix ソケット・ホストの TCP（127.0.0.1）・
// qemu-arm・クロスコンパイラ・git（下位フォルダのリポジトリ／作業フォルダ自身のリポジトリ）・PATH の差し替えが効くかを見る。
// 実際のモデルは呼ばない（guardSdk で、偽の API につながらない呼び出しを断る）。
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as realSdk from '@anthropic-ai/claude-agent-sdk';

const REPO_RUNNER = '/home/user/plugin-creator/tests/dev-eval/runner';
const { makeQueryOptions } = await import(path.join(REPO_RUNNER, 'isolation.mjs'));
const { startFakeAnthropic, guardSdk, lastToolResults } = await import(path.join(REPO_RUNNER, 'fake-anthropic.mjs'));

const BASE = path.resolve(process.argv[2] ?? './exp');
const ALLOW_ALL_UNIX = process.argv.includes('--allow-all-unix');
const ALLOW_LOCALHOST = process.argv.includes('--allow-localhost-domain');
fs.rmSync(BASE, { recursive: true, force: true });
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

function prepare(name, { repoAtRoot }) {
  const root = path.join(BASE, name);
  const work = path.join(root, 'work');
  const home = path.join(root, 'home');
  const outside = path.join(root, 'outside');
  const shim = path.join(root, 'shim');
  for (const d of [work, home, outside, shim]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(work, 'hello.c'), '#include <stdio.h>\nint main(void){printf("AVG=%d\\n", 25);return 0;}\n');
  run('arm-linux-gnueabihf-gcc', ['-o', path.join(work, 'hello'), path.join(work, 'hello.c')]);
  const repo = repoAtRoot ? work : path.join(work, 'market');
  fs.mkdirSync(path.join(repo, 'plugins', 'p'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'plugins', 'p', 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'top\n');
  run('git', ['init', '-q', repo]);
  run('git', ['-C', repo, 'config', 'user.name', 'Repo User']);
  run('git', ['-C', repo, 'config', 'user.email', 'repo@example.invalid']);
  run('git', ['-C', repo, 'add', '-A']);
  run('git', ['-C', repo, 'commit', '-qm', 'init']);
  // ほかのフォルダに git add しただけの変更（REQ-059 の、コミットをフォルダの中に限る確かめ用）
  fs.writeFileSync(path.join(repo, 'README.md'), 'top changed\n');
  run('git', ['-C', repo, 'add', 'README.md']);
  // PATH の差し替え（擬似の機器へのつなぎを、ssh・scp の名前で置く案）
  fs.writeFileSync(path.join(shim, 'ssh'), '#!/bin/sh\necho "SHIM-SSH $*"\n', { mode: 0o755 });
  return { root, work, home, outside, shim, repo };
}

function probeScript({ work, outside, tcpPort, httpPort, repo, repoAtRoot }) {
  const py = (sock) => `python3 -c "import socket;s=socket.socket(socket.AF_UNIX);s.settimeout(3);s.connect('${sock}');s.sendall(b'ping');print(s.recv(100).decode())" 2>&1 | tail -1`;
  return [
    'echo "== whoami/pwd"; id -u; pwd',
    `echo "== unix socket in work (relative)"; ${py('dev.sock')}`,
    `echo "== unix socket outside work (relative)"; ${py('../outside/dev.sock')}`,
    `echo "== tcp 127.0.0.1 (host)"; python3 -c "import socket;s=socket.create_connection(('127.0.0.1',${tcpPort}),timeout=3);print(s.recv(100).decode())" 2>&1 | tail -1`,
    `echo "== curl http 127.0.0.1 direct"; curl -sS -m 3 http://127.0.0.1:${httpPort}/ 2>&1 | tail -1`,
    `echo "== curl http localhost via sandbox proxy"; curl -sS -m 5 --noproxy "" -x "$HTTP_PROXY" http://localhost:${httpPort}/ 2>&1 | tail -1`,
    'echo "== proxy env"; env | grep -i "_proxy=" | sed "s/=.*@/=***@/" | sort | head -8',
    'echo "== qemu-arm prebuilt"; qemu-arm -L /usr/arm-linux-gnueabihf ./hello 2>&1',
    'echo "== cross compile + run"; arm-linux-gnueabihf-gcc -o hello2 hello.c 2>&1 && qemu-arm -L /usr/arm-linux-gnueabihf ./hello2 2>&1; file hello2 2>/dev/null | cut -c1-80',
    `echo "== git"; cd ${repo} && echo b >> plugins/p/a.txt && git status --porcelain 2>&1 | head -5 && git commit -q -m change -- plugins/p 2>&1 | tail -2; git log --format="%an <%ae> %s" -2 2>&1; git diff --cached --name-only 2>&1; cd ${work}`,
    `echo "== git config readable"; git -C ${repo} config user.name 2>&1; ls -la ${repo}/.git/config 2>&1 | cut -c1-60`,
    `echo "== write .git/config"; (echo "#x" >> ${repo}/.git/config && echo wrote) 2>&1 | tail -1`,
    `echo "== write outside"; (touch ${outside}/x && echo wrote) 2>&1 | tail -1`,
    'echo "== PATH shim"; command -v ssh; ssh root@192.168.7.2 uname 2>&1 | head -1',
    'echo "== listen+connect inside one command"; python3 -c "\nimport socket,threading\ns=socket.socket();s.bind((\'127.0.0.1\',0));s.listen();p=s.getsockname()[1]\nthreading.Thread(target=lambda:(s.accept()[0].sendall(b\'in-sandbox-ok\')),daemon=True).start()\nc=socket.create_connection((\'127.0.0.1\',p));print(c.recv(100).decode())" 2>&1 | tail -1',
    `echo "== repoAtRoot=${repoAtRoot}"`,
  ].join('\n');
}

async function servers({ work, outside }) {
  const list = [];
  // Unix ソケットの場所の長さの上限（108 バイト）に当たらないよう、相対の場所で開く
  const cwd = process.cwd();
  process.chdir(path.dirname(work));
  for (const sock of ['work/dev.sock', 'outside/dev.sock']) {
    const s = net.createServer((c) => c.on('data', () => c.end(`UNIX-OK ${path.dirname(sock)}`)));
    await new Promise((r) => s.listen(sock, r));
    list.push(s);
  }
  process.chdir(cwd);
  const tcp = net.createServer((c) => c.end('TCP-OK'));
  await new Promise((r) => tcp.listen(0, '127.0.0.1', r));
  list.push(tcp);
  const web = http.createServer((q, r) => r.end('HTTP-OK'));
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  list.push(web);
  return { list, tcpPort: tcp.address().port, httpPort: web.address().port };
}

async function experiment(name, { repoAtRoot }) {
  const p = prepare(name, { repoAtRoot });
  const srv = await servers(p);
  fs.writeFileSync(path.join(p.work, 'probe.sh'), probeScript({ ...p, ...srv, repoAtRoot }));
  let toolResult = null;
  const api = await startFakeAnthropic(async ({ index, body }) => {
    if (body?.tools?.some((t) => t.name === 'Bash') && toolResult === null && index < 10) {
      const results = lastToolResults(body);
      if (results.length === 0) return { blocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'bash probe.sh', description: 'probe' } }] };
      toolResult = results.join('\n');
      return { blocks: [{ type: 'text', text: 'done' }] };
    }
    return { blocks: [{ type: 'text', text: 'done' }] };
  });
  const sdk = guardSdk(realSdk, api);
  const options = makeQueryOptions({
    cwd: p.work, home: p.home, model: 'claude-haiku-5-5', sandbox: true, maxTurns: 4,
    envExtra: {
      ANTHROPIC_API_KEY: 'fake-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ANTHROPIC_BASE_URL: api.url,
      CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      PATH: `${p.shim}:${process.env.PATH}`,
    },
  });
  if (ALLOW_ALL_UNIX || ALLOW_LOCALHOST) options.sandbox = { ...options.sandbox, network: { ...(ALLOW_ALL_UNIX ? { allowAllUnixSockets: true } : {}), ...(ALLOW_LOCALHOST ? { allowedDomains: ['localhost'] } : {}) } };
  const canCalls = [];
  const origCan = options.canUseTool;
  options.canUseTool = async (toolName, input, ctx) => { canCalls.push({ toolName, input: JSON.stringify(input).slice(0, 300) }); return process.argv.includes('--deny-other') && toolName !== 'AskUserQuestion' ? { behavior: 'deny', message: 'denied by probe' } : origCan(toolName, input, ctx); };
  const messages = [];
  try {
    for await (const m of sdk.query({ prompt: 'probe', options })) messages.push(m.type === 'result' ? { type: 'result', subtype: m.subtype, is_error: m.is_error, result: String(m.result ?? '').slice(0, 300) } : m.type);
  } finally {
    await api.close();
    for (const s of srv.list) s.close();
  }
  const log = spawnSync('git', ['-C', p.repo, 'log', '--format=%an|%s', '-3'], { encoding: 'utf8' }).stdout;
  const staged = spawnSync('git', ['-C', p.repo, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }).stdout;
  return { name, allowAllUnix: ALLOW_ALL_UNIX, allowLocalhost: ALLOW_LOCALHOST, sandbox: options.sandbox, toolResult, canCalls, result: messages.filter((m) => typeof m === 'object'), hostGitLog: log, hostStaged: staged, outsideTouched: fs.existsSync(path.join(p.outside, 'x')) };
}

const out = [];
out.push(await experiment('sub-repo', { repoAtRoot: false }));
if (!process.argv.includes('--only-sub')) out.push(await experiment('root-repo', { repoAtRoot: true }));
console.log(JSON.stringify(out, null, 2));
