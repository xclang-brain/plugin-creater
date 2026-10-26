#!/usr/bin/env python3
"""kxemu: 架空の ARM ボード「KX-200」の擬似の機器（開発の試験用。標準ライブラリだけで動く）。

  python3 -I kxemu.py init  --state DIR
  python3 -I kxemu.py serve --state DIR [--bind 127.0.0.1] [--console-port 0] [--tftp-port 0]
                            [--http-port 0] [--ready-file FILE] [--isolate auto|bwrap|none] [--app-timeout 10]

  --isolate auto は、bwrap があって、実際に隔離して動かせるときだけ bwrap を使う（使わなかった理由は ready の isolate_note）。

機器の外から見えるもの:
  - シリアルコンソール（TCP、行単位。ser2net の raw に近い）。プロンプトは "kx200# "
  - TFTP サーバー（UDP。書き込み WRQ だけ受ける。受けたファイルは機器の /tmp に置く）
  - HTTP のつなぎ口（サンドボックスのプロキシを通れるのは HTTP だけなので、同じ機器を HTTP でも操作できる）
      PUT  /files/<name>      TFTP の WRQ と同じ（/tmp/<name> に置く）
      POST /console           本文の各行をコンソールで打ったのと同じ。返り値は、その間にコンソールに出た文字
      GET  /console.log?from=N コンソールに出た文字の記録（N バイト目から）
      GET  /                  機器の情報
機器の中身（状態のフォルダ）:
  rootfs/etc, rootfs/opt/app, rootfs/var/log, rootfs/tmp, console.log（コンソールの記録）, history.jsonl（出来事の記録）
決まった動き（再現できるように、時刻や乱数を使わない）:
  - 稼働時間は、出来事ごとに決まった量だけ進む疑似の時計
  - アプリは qemu-arm で動かす。-L を付けないので、動的リンクの実行ファイルは「not found」で動かない
  - インストールにはイメージの見出し（magic "KX2I"、版 1、本体の長さ、本体の CRC32、名前）が要る
  - インストールしたアプリは、再起動するまで有効にならない
  - アプリの出力の終わりに「[kxapp] <名前> exited (status=N)」を出す（取り終わりの目印）
"""

import argparse
import base64
import hashlib
import http.server
import json
import os
import re
import shutil
import signal
import socket
import socketserver
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
import zlib

PROMPT = 'kx200# '
MAGIC = b'KX2I'
HEADER = struct.Struct('<4sIII16s')  # magic, version, payload size, payload crc32, name
MAX_FILE = 8 * 1024 * 1024
NAME_RE = re.compile(r'^[A-Za-z0-9._-]{1,64}$')
APP_RE = re.compile(r'^[A-Za-z0-9_-]{1,15}$')
RELEASE = 'KX-200 Linux 1.4.2 (kx200-bsp 2019.07)\n'
UNAME = 'Linux kx200 4.14.98-kx200 #1 PREEMPT Tue Jan 1 00:00:00 UTC 2019 armv7l GNU/Linux'
DEVICE_PATHS = ('/etc', '/opt/app', '/var/log', '/tmp')


# ---- 状態のフォルダ ---------------------------------------------------------------------------

def init_state(state):
    """工場出荷の状態にする（前の中身はすべて消す）。"""
    if os.path.isdir(state):
        shutil.rmtree(state)
    for sub in ('rootfs/etc', 'rootfs/opt/app', 'rootfs/opt/pending', 'rootfs/var/log', 'rootfs/tmp'):
        os.makedirs(os.path.join(state, sub))
    with open(os.path.join(state, 'rootfs/etc/kx-release'), 'w') as f:
        f.write(RELEASE)
    open(os.path.join(state, 'rootfs/var/log/messages'), 'w').close()
    open(os.path.join(state, 'console.log'), 'w').close()
    open(os.path.join(state, 'history.jsonl'), 'w').close()


def parse_image(data):
    """KX2I イメージを読む。(名前, 本体) か、断る理由の文を返す。"""
    if len(data) < HEADER.size:
        return None, 'image too short'
    magic, version, size, crc, raw_name = HEADER.unpack_from(data)
    if magic != MAGIC:
        return None, 'bad magic (not a KX2I image)'
    if version != 1:
        return None, f'unsupported header version {version}'
    payload = data[HEADER.size:]
    if len(payload) != size:
        return None, f'size mismatch (header {size}, actual {len(payload)})'
    actual = zlib.crc32(payload) & 0xFFFFFFFF
    if actual != crc:
        return None, f'CRC mismatch (header 0x{crc:08x}, actual 0x{actual:08x})'
    name = raw_name.rstrip(b'\0').decode('ascii', 'replace')
    if not APP_RE.match(name):
        return None, f'bad app name {name!r}'
    return (name, payload), None


def elf_kind(data):
    """'arm-static'、'arm-dynamic'、'not-arm'、'not-elf' のどれか。"""
    if len(data) < 52 or data[:4] != b'\x7fELF':
        return 'not-elf'
    if data[4] != 1 or data[5] != 1:  # 32 ビット、リトルエンディアン
        return 'not-arm'
    e_machine = struct.unpack_from('<H', data, 18)[0]
    if e_machine != 40:  # EM_ARM
        return 'not-arm'
    e_phoff = struct.unpack_from('<I', data, 28)[0]
    e_phentsize, e_phnum = struct.unpack_from('<HH', data, 42)
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        if off + 4 > len(data):
            break
        if struct.unpack_from('<I', data, off)[0] == 3:  # PT_INTERP
            return 'arm-dynamic'
    return 'arm-static'


# ---- 機器 ----------------------------------------------------------------------------------------

def bwrap_prefix(bwrap):
    """アプリを動かす bwrap の、名前空間と開発機の /usr の見せ方（機器の中身のフォルダと環境変数は呼ぶ側が足す）"""
    return [bwrap, '--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
            '--ro-bind', '/usr', '/usr', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
            '--symlink', 'usr/bin', '/bin', '--proc', '/proc', '--dev', '/dev']


def bwrap_problem(bwrap, qemu, timeout=5):
    """bwrap の隔離で動かせないときは、その理由を返す（動かせるときは None）。
    bwrap が入っていても、名前空間を作れない環境（容器の中、AppArmor の制限など）や、/usr を統合していない配置では動かない。
    アプリを動かすときと同じ置き方で、qemu-arm（なければ true）を1回動かして確かめる。"""
    cmd = bwrap_prefix(bwrap) + ([qemu, '--version'] if qemu else ['/usr/bin/true'])
    try:
        r = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        return f'bwrap を動かせない（{e}）'
    if r.returncode != 0:
        detail = r.stderr.decode('utf-8', 'replace').strip().splitlines()
        return f'bwrap が終了コード {r.returncode} で失敗した（{detail[-1] if detail else "出力なし"}）'
    return None


class Device:
    def __init__(self, state, isolate='auto', app_timeout=10.0):
        self.state = os.path.abspath(state)
        self.rootfs = os.path.join(self.state, 'rootfs')
        self.lock = threading.RLock()
        self.seq = 0
        self.uptime_us = 0
        self.app_timeout = app_timeout
        self.qemu = shutil.which('qemu-arm')
        bwrap = shutil.which('bwrap')
        # auto：bwrap があって、実際に隔離して動かせるときだけ使う。使わなかった理由は isolate_note に残す
        self.isolate_note = None
        if isolate == 'auto':
            self.isolate_note = bwrap_problem(bwrap, self.qemu) if bwrap else 'bwrap がない'
            isolate = 'none' if self.isolate_note else 'bwrap'
        if isolate == 'bwrap' and not bwrap:
            raise SystemExit('kxemu: bwrap が見つかりません（--isolate none で外せます）')
        self.isolate = isolate
        self.bwrap = bwrap

    # -- 記録 --
    def tick(self, us):
        self.uptime_us += us

    def stamp(self):
        return f'[{self.uptime_us // 1_000_000:5d}.{self.uptime_us % 1_000_000:06d}]'

    def history(self, ev, **fields):
        self.seq += 1
        rec = {'seq': self.seq, 'up': self.stamp()[1:-1].strip(), 'ev': ev, **fields}
        with open(os.path.join(self.state, 'history.jsonl'), 'a') as f:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')

    def console_write(self, text):
        with open(os.path.join(self.state, 'console.log'), 'a', encoding='utf-8') as f:
            f.write(text)

    def messages(self, line):
        with open(os.path.join(self.rootfs, 'var/log/messages'), 'a', encoding='utf-8') as f:
            f.write(f'{self.stamp()} {line}\n')

    # -- 起動 --
    def boot(self, reason='power-on'):
        with self.lock:
            self.uptime_us = 0
            tmp = os.path.join(self.rootfs, 'tmp')
            shutil.rmtree(tmp)
            os.makedirs(tmp)
            open(os.path.join(self.rootfs, 'var/log/messages'), 'w').close()  # syslog はメモリの上なので、起動ごとに空になる
            activated = []
            pending = os.path.join(self.rootfs, 'opt/pending')
            for name in sorted(os.listdir(pending)):
                os.replace(os.path.join(pending, name), os.path.join(self.rootfs, 'opt/app', name))
                activated.append(name)
            lines = [
                '',
                'U-Boot 2019.07-kx200 (Jan 01 2019 - 00:00:00 +0000)',
                'DRAM:  256 MiB',
                'Starting kernel ...',
                '',
            ]
            out = '\r\n'.join(lines) + '\r\n'
            for text, us in (
                ('Booting Linux on physical CPU 0x0', 0),
                ('Linux version 4.14.98-kx200 (builder@kx200) #1 PREEMPT', 1000),
                ('kx200: rootfs mounted (ro), /opt/app (rw), /tmp (tmpfs, cleared)', 1_200_000),
                ('kx200: eth0 192.168.7.2/24 up, tftpd on udp/69, console on ttyS0 115200 8N1', 300_000),
            ):
                self.tick(us)
                out += f'{self.stamp()} {text}\r\n'
            for name in activated:
                self.tick(10_000)
                out += f'{self.stamp()} kxapp: activated {name}\r\n'
                self.messages(f'kxapp: activated {name}')
            out += '\r\nKX-200 Linux 1.4.2 kx200 ttyS0\r\n\r\nkx200 login: root (auto login)\r\n' + PROMPT
            self.console_write(out)
            self.messages(f'kernel: boot ({reason})')
            self.history('boot', reason=reason, activated=activated)
            return out

    # -- 転送 --
    def receive_file(self, name, data, via, addr=None):
        extra = {'addr': addr} if addr else {}
        with self.lock:
            if not NAME_RE.match(name or ''):
                self.history('recv', via=via, **extra, name=name, ok=False, reason='bad file name')
                return False, 'bad file name'
            if len(data) > MAX_FILE:
                self.history('recv', via=via, **extra, name=name, ok=False, reason='too large')
                return False, 'file too large'
            with open(os.path.join(self.rootfs, 'tmp', name), 'wb') as f:
                f.write(data)
            self.tick(50_000)
            self.messages(f'tftpd: received /tmp/{name} ({len(data)} bytes)')
            self.history('recv', via=via, **extra, name=name, size=len(data), sha256=hashlib.sha256(data).hexdigest(), ok=True)
            return True, f'/tmp/{name} {len(data)} bytes'

    # -- コンソール --
    def run_line(self, line, via, addr=None):
        """コンソールで1行打ったときの、コンソールに出る文字（打った行のエコーとプロンプトを含む）を返す。"""
        with self.lock:
            line = line.strip()
            self.tick(20_000)
            echo = line + '\r\n'
            self.console_write(echo)
            if line:
                self.history('cmd', via=via, **({'addr': addr} if addr else {}), line=line)
            if line in ('exit', 'logout'):
                self.console_write('logout\r\n')
                return echo + 'logout\r\n', True
            if line == 'reboot':
                self.console_write('The system is going down NOW!\r\nRequesting system reboot\r\n')
                return echo + 'The system is going down NOW!\r\nRequesting system reboot\r\n' + self.boot('reboot'), False
            out = self.command(line) if line else ''
            out = out.replace('\r\n', '\n').replace('\n', '\r\n')
            if out and not out.endswith('\r\n'):
                out += '\r\n'
            out += PROMPT
            self.console_write(out)
            return echo + out, False

    def device_path(self, p):
        p = os.path.normpath('/' + p.lstrip('/')) if p else '/'
        for top in DEVICE_PATHS:
            if p == top or p.startswith(top + '/'):
                return os.path.join(self.rootfs, p[1:])
        return None

    def command(self, line):
        argv = line.split()
        cmd, args = argv[0], argv[1:]
        if cmd == 'help':
            return ('commands: help, uname -a, cat FILE, ls [DIR], rm /tmp/FILE, echo TEXT, logread,\n'
                    '          kxinstall /tmp/IMAGE, kxapp list, kxapp run NAME, reboot, exit')
        if cmd == 'uname':
            return UNAME if args == ['-a'] else 'Linux'
        if cmd == 'echo':
            return ' '.join(args)
        if cmd == 'logread':
            with open(os.path.join(self.rootfs, 'var/log/messages'), encoding='utf-8') as f:
                return f.read()
        if cmd in ('ls', 'cat', 'rm'):
            return self.file_command(cmd, args)
        if cmd == 'kxinstall':
            return self.kxinstall(args)
        if cmd == 'kxapp':
            return self.kxapp(args)
        return f'-sh: {cmd}: not found'

    def file_command(self, cmd, args):
        target = args[0] if args else ('/' if cmd == 'ls' else '')
        if cmd == 'ls' and target in ('/', ''):
            return 'etc  opt  tmp  var'
        if cmd == 'ls' and target == '/opt':
            return 'app'
        if cmd == 'ls' and target == '/var':
            return 'log'
        host = self.device_path(target)
        if host is None or not os.path.exists(host):
            return f'{cmd}: {target}: No such file or directory'
        if cmd == 'ls':
            if os.path.isdir(host):
                return '  '.join(sorted(os.listdir(host)))
            return target
        if cmd == 'cat':
            if os.path.isdir(host):
                return f'cat: read error: Is a directory'
            with open(host, 'rb') as f:
                data = f.read(65536)
            return data.decode('utf-8', 'replace')
        if not target.startswith('/tmp/'):
            return f'rm: can\'t remove \'{target}\': Read-only file system'
        os.remove(host)
        return ''

    def kxinstall(self, args):
        if len(args) != 1:
            return 'usage: kxinstall /tmp/IMAGE'
        host = self.device_path(args[0])
        if host is None or not os.path.isfile(host):
            self.history('install', file=args[0], ok=False, reason='no such file')
            return f'kxinstall: {args[0]}: No such file or directory'
        with open(host, 'rb') as f:
            data = f.read()
        parsed, reason = parse_image(data)
        self.tick(200_000)
        if reason:
            self.messages(f'kxinstall: rejected {args[0]}: {reason}')
            self.history('install', file=args[0], ok=False, reason=reason)
            return f'kxinstall: {args[0]}: {reason}'
        name, payload = parsed
        dest = os.path.join(self.rootfs, 'opt/pending', name)
        with open(dest, 'wb') as f:
            f.write(payload)
        os.chmod(dest, 0o755)  # qemu-arm は実行の権限がないと、何も出さずに終了コード 1 で終わる
        crc = zlib.crc32(payload) & 0xFFFFFFFF
        self.messages(f'kxinstall: staged {name} ({len(payload)} bytes, crc32=0x{crc:08x})')
        self.history('install', file=args[0], ok=True, name=name, size=len(payload), crc32=f'0x{crc:08x}')
        return (f'kxinstall: verified {args[0]} (KX2I v1, {len(payload)} bytes, crc32=0x{crc:08x})\n'
                f'kxinstall: staged {name}; it becomes active after reboot')

    def kxapp(self, args):
        if args == ['list']:
            names = sorted(os.listdir(os.path.join(self.rootfs, 'opt/app')))
            pending = sorted(os.listdir(os.path.join(self.rootfs, 'opt/pending')))
            lines = [f'{n}  active' for n in names] + [f'{n}  pending (reboot to activate)' for n in pending]
            return '\n'.join(lines) if lines else '(no apps installed)'
        if len(args) == 2 and args[0] == 'run':
            return self.run_app(args[1])
        return 'usage: kxapp list | kxapp run NAME'

    def run_app(self, name):
        if not APP_RE.match(name):
            return f'kxapp: bad name {name!r}'
        host = os.path.join(self.rootfs, 'opt/app', name)
        if not os.path.isfile(host):
            note = ' (pending: reboot to activate)' if os.path.exists(os.path.join(self.rootfs, 'opt/pending', name)) else ''
            self.history('run', name=name, ok=False, reason='not installed' + note)
            return f'kxapp: {name}: not installed{note}'
        with open(host, 'rb') as f:
            kind = elf_kind(f.read(65536))
        if kind != 'arm-static':
            msg = {
                'arm-dynamic': f'-sh: /opt/app/{name}: not found',  # 動的リンクのローダーが機器にない
                'not-arm': f'-sh: /opt/app/{name}: cannot execute binary file: Exec format error',
                'not-elf': f'-sh: /opt/app/{name}: cannot execute binary file: Exec format error',
            }[kind]
            self.history('run', name=name, ok=False, kind=kind)
            self.messages(f'kxapp: {name} failed to start ({kind})')
            return msg + f'\n[kxapp] {name} exited (status=127)'
        out, status, timed_out = self.exec_arm(name)
        self.tick(300_000)
        text = out.decode('utf-8', 'replace').rstrip('\n')
        for ln in text.splitlines():
            self.messages(f'{name}: {ln}')
        end = (f'[kxapp] {name} killed (timeout {self.app_timeout:g}s)' if timed_out
               else f'[kxapp] {name} exited (status={status})')
        self.messages(end)
        self.history('run', name=name, ok=(status == 0 and not timed_out), kind=kind, status=status,
                     timeout=timed_out, isolate=self.isolate, output_sha256=hashlib.sha256(out).hexdigest())
        return (text + '\n' if text else '') + end

    def exec_arm(self, name):
        if not self.qemu:
            return b'kxemu: qemu-arm not found\n', 126, False
        app = os.path.join(self.rootfs, 'opt/app', name)
        env = {'PATH': '/bin:/usr/bin', 'HOME': '/root', 'TZ': 'UTC', 'LANG': 'C'}
        if self.isolate == 'bwrap':
            cmd = bwrap_prefix(self.bwrap)
            for k, v in env.items():
                cmd += ['--setenv', k, v]
            cmd += ['--ro-bind', os.path.join(self.rootfs, 'etc'), '/etc',
                    '--ro-bind', os.path.join(self.rootfs, 'opt/app'), '/opt/app',
                    '--bind', os.path.join(self.rootfs, 'var/log'), '/var/log',
                    '--bind', os.path.join(self.rootfs, 'tmp'), '/tmp',
                    '--chdir', '/tmp', self.qemu, f'/opt/app/{name}']
            run_env = None
            cwd = None
        else:
            cmd = [self.qemu, app]
            run_env = env
            cwd = os.path.join(self.rootfs, 'tmp')
        try:
            proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                  env=run_env, cwd=cwd, timeout=self.app_timeout)
            out, rc = proc.stdout[:65536], proc.returncode
            # qemu-user は、機器のプログラムがシグナルで落ちると自分も同じシグナルで終わる。機器のシェルの見え方に直す
            m = re.search(rb'qemu: uncaught target signal (\d+) \(([^)]*)\)[^\n]*\n?', out)
            if m:
                out = out[:m.start()] + m.group(2) + b'\n' + out[m.end():]
                rc = 128 + int(m.group(1))
            elif rc < 0:
                rc = 128 - rc
            return out, rc, False
        except subprocess.TimeoutExpired as e:
            return (e.stdout or b'')[:65536], 137, True


# ---- シリアルコンソール（TCP） ---------------------------------------------------------------------

def strip_telnet(data):
    out = bytearray()
    i = 0
    while i < len(data):
        b = data[i]
        if b == 0xFF and i + 1 < len(data):
            op = data[i + 1]
            i += 3 if op in (0xFB, 0xFC, 0xFD, 0xFE) else 2
            continue
        out.append(b)
        i += 1
    return bytes(out)


class ConsoleHandler(socketserver.BaseRequestHandler):
    def handle(self):
        dev = self.server.device
        if not self.server.busy.acquire(blocking=False):
            self.request.sendall(b'kxemu: console busy (another session is attached)\r\n')
            return
        try:
            self.request.sendall(('\r\n' + PROMPT).encode())
            buf = b''
            while True:
                chunk = self.request.recv(4096)
                if not chunk:
                    return
                buf += strip_telnet(chunk)
                while b'\n' in buf or b'\r' in buf:
                    m = re.search(rb'\r\n|\n|\r', buf)
                    line, buf = buf[:m.start()], buf[m.end():]
                    out, close = dev.run_line(line.decode('utf-8', 'replace'), via='console-tcp')
                    self.request.sendall(out.encode('utf-8'))
                    if close:
                        return
        except (ConnectionError, OSError):
            return
        finally:
            self.server.busy.release()


class ConsoleServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


# ---- TFTP（UDP。WRQ だけ） ------------------------------------------------------------------------

def tftp_error(sock, addr, code, msg):
    sock.sendto(struct.pack('!HH', 5, code) + msg.encode() + b'\0', addr)


def tftp_receive(dev, request, client):
    parts = request[2:].split(b'\0')
    raw = parts[0].decode('ascii', 'replace')
    name = re.sub(r'^/?(tmp/)?', '', raw)  # "x"、"/x"、"tmp/x"、"/tmp/x" を /tmp/x とみなす
    mode = parts[1].decode('ascii', 'replace').lower() if len(parts) > 1 else ''
    opts = {}
    for i in range(2, len(parts) - 1, 2):
        if parts[i]:
            opts[parts[i].decode().lower()] = parts[i + 1].decode()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((dev.bind, 0))
    sock.settimeout(2.0)
    try:
        if mode != 'octet':
            tftp_error(sock, client, 0, 'only octet mode is supported')
            return
        if not NAME_RE.match(name):
            tftp_error(sock, client, 2, 'Access violation')
            return
        blksize = 512
        oack = {}
        if 'blksize' in opts:
            blksize = max(8, min(int(opts['blksize']), 1428))
            oack['blksize'] = str(blksize)
        if 'tsize' in opts:
            if int(opts['tsize']) > MAX_FILE:
                tftp_error(sock, client, 3, 'Disk full or allocation exceeded')
                return
            oack['tsize'] = opts['tsize']
        if 'timeout' in opts:
            oack['timeout'] = opts['timeout']
        reply = (struct.pack('!H', 6) + b''.join(k.encode() + b'\0' + v.encode() + b'\0' for k, v in oack.items())
                 if oack else struct.pack('!HH', 4, 0))
        sock.sendto(reply, client)
        data = bytearray()
        expect = 1
        tries = 0
        while True:
            try:
                pkt, addr = sock.recvfrom(blksize + 4)
            except socket.timeout:
                tries += 1
                if tries > 5:
                    dev.history('recv', via='tftp', name=name, ok=False, reason='timeout')
                    return
                sock.sendto(reply, client)
                continue
            if addr != client:
                tftp_error(sock, addr, 5, 'Unknown transfer ID')
                continue
            op, block = struct.unpack('!HH', pkt[:4])
            if op != 3:
                return
            if block == expect & 0xFFFF:
                data += pkt[4:]
                reply = struct.pack('!HH', 4, block)
                sock.sendto(reply, client)
                expect += 1
                tries = 0
                if len(data) > MAX_FILE:
                    tftp_error(sock, client, 3, 'Disk full or allocation exceeded')
                    return
                if len(pkt) - 4 < blksize:
                    break
            else:
                sock.sendto(reply, client)  # 重複した DATA には、前の ACK を返す
        dev.receive_file(name, bytes(data), via='tftp')
    finally:
        sock.close()


def tftp_loop(dev, sock):
    while True:
        try:
            pkt, client = sock.recvfrom(1500)
        except OSError:
            return
        if len(pkt) < 4:
            continue
        op = struct.unpack('!H', pkt[:2])[0]
        if op == 2:
            threading.Thread(target=tftp_receive, args=(dev, pkt, client), daemon=True).start()
        else:
            tftp_error(sock, client, 2 if op == 1 else 4, 'Access violation' if op == 1 else 'Illegal TFTP operation')


# ---- HTTP のつなぎ口 -------------------------------------------------------------------------------

class GatewayHandler(http.server.BaseHTTPRequestHandler):
    server_version = 'kxemu/0.1'

    def log_message(self, fmt, *args):  # 標準エラーに出さない
        pass

    def reply(self, code, text, ctype='text/plain; charset=utf-8'):
        body = text.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > MAX_FILE:
            return None
        return self.rfile.read(n)

    def do_GET(self):
        dev = self.server.device
        url = urllib.parse.urlsplit(self.path)
        if url.path == '/':
            self.reply(200, json.dumps({'board': 'KX-200', 'release': RELEASE.strip(), 'prompt': PROMPT,
                                        'endpoints': ['PUT /files/<name>', 'POST /console', 'GET /console.log?from=N']}))
        elif url.path == '/console.log':
            start = int(urllib.parse.parse_qs(url.query).get('from', ['0'])[0])
            with open(os.path.join(dev.state, 'console.log'), 'rb') as f:
                f.seek(start)
                data = f.read()
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('X-Console-Size', str(start + len(data)))
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            self.reply(404, 'not found')

    def do_PUT(self):
        dev = self.server.device
        url = urllib.parse.urlsplit(self.path)
        if not url.path.startswith('/files/'):
            return self.reply(404, 'not found')
        data = self.body()
        if data is None:
            return self.reply(413, 'file too large')
        ok, msg = dev.receive_file(urllib.parse.unquote(url.path[len('/files/'):]), data, via='http',
                                   addr=self.headers.get('X-KX-Device'))
        self.reply(200 if ok else 400, msg + '\n')

    def do_POST(self):
        dev = self.server.device
        if urllib.parse.urlsplit(self.path).path != '/console':
            return self.reply(404, 'not found')
        data = self.body() or b''
        if not self.server.busy.acquire(timeout=30):
            return self.reply(409, 'kxemu: console busy (another session is attached)\n')
        try:
            out = ''
            for line in data.decode('utf-8', 'replace').splitlines():
                text, close = dev.run_line(line, via='console-http', addr=self.headers.get('X-KX-Device'))
                out += text
                if close:
                    break
            self.reply(200, out)
        finally:
            self.server.busy.release()


class GatewayServer(http.server.ThreadingHTTPServer):
    daemon_threads = True


# ---- 入口 --------------------------------------------------------------------------------------------

def serve(args):
    if not os.path.isfile(os.path.join(args.state, 'history.jsonl')):
        init_state(args.state)
    dev = Device(args.state, isolate=args.isolate, app_timeout=args.app_timeout)
    dev.bind = args.bind
    busy = threading.Lock()  # コンソールは1つ（TCP と HTTP で共有）
    console = ConsoleServer((args.bind, args.console_port), ConsoleHandler)
    console.device, console.busy = dev, busy
    gateway = GatewayServer((args.bind, args.http_port), GatewayHandler)
    gateway.device, gateway.busy = dev, busy
    tftp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    tftp.bind((args.bind, args.tftp_port))
    dev.boot('power-on')
    for target in (console.serve_forever, gateway.serve_forever, lambda: tftp_loop(dev, tftp)):
        threading.Thread(target=target, daemon=True).start()
    ready = {'pid': os.getpid(), 'state': os.path.abspath(args.state), 'bind': args.bind,
             'console_port': console.server_address[1], 'tftp_port': tftp.getsockname()[1],
             'http_port': gateway.server_address[1], 'isolate': dev.isolate, 'isolate_note': dev.isolate_note}
    if args.ready_file:
        tmp = args.ready_file + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(ready, f)
        os.replace(tmp, args.ready_file)
    print(json.dumps(ready), flush=True)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    stop.wait()
    with dev.lock:
        dev.history('poweroff')
    console.shutdown()
    gateway.shutdown()
    tftp.close()


def main(argv=None):
    p = argparse.ArgumentParser(prog='kxemu', description='KX-200 の擬似の機器（試験用）')
    sub = p.add_subparsers(dest='cmd', required=True)
    pi = sub.add_parser('init')
    pi.add_argument('--state', required=True)
    ps = sub.add_parser('serve')
    ps.add_argument('--state', required=True)
    ps.add_argument('--bind', default='127.0.0.1')
    ps.add_argument('--console-port', type=int, default=0)
    ps.add_argument('--tftp-port', type=int, default=0)
    ps.add_argument('--http-port', type=int, default=0)
    ps.add_argument('--ready-file')
    ps.add_argument('--isolate', choices=('auto', 'bwrap', 'none'), default='auto')
    ps.add_argument('--app-timeout', type=float, default=10.0)
    args = p.parse_args(argv)
    if args.cmd == 'init':
        init_state(args.state)
        print(f'kxemu: initialized {os.path.abspath(args.state)}')
    else:
        serve(args)


if __name__ == '__main__':
    main()
