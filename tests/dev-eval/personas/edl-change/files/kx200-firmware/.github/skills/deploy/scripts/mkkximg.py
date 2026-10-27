#!/usr/bin/env python3
"""ELF に見出しを付けて、KX-200 のボードに入れられるイメージを作る。

見出し（32 バイト、リトルエンディアン）：識別子 "KX2I"、見出しの版 1、本体の長さ、本体の CRC32、
アプリの名前（16 バイト、残りは 0 で埋める）。見出しの後に、ELF をそのまま続ける。
"""

import argparse
import json
import os
import re
import struct
import sys
import zlib

NAME_RE = re.compile(r'^[a-z0-9-]{1,15}$')
HEADER = struct.Struct('<4sIII16s')

EPILOG = """成功すると、標準出力に1行の JSON を出す:
  {"image": "/abs/path/sensor.kximg", "name": "sensor", "size": 423788, "crc32": "0x86787a7a"}
  size は本体（ELF）のバイト数、crc32 は本体の CRC32。

終了コード:
  0  成功
  2  引数の誤り（名前の形が違うなど）
  3  ELF を読めない、または ELF でない
  4  イメージを書けない"""


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog='mkkximg.py',
        usage='python3 mkkximg.py ELF NAME OUT',
        description=__doc__,
        epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument('elf', metavar='ELF', help='クロスコンパイルした実行ファイル')
    parser.add_argument('name', metavar='NAME', help='ボードでのアプリの名前（英小文字・数字・ハイフンで 15 文字以内）')
    parser.add_argument('out', metavar='OUT', help='作るイメージのファイル')
    args = parser.parse_args(argv)
    if not NAME_RE.match(args.name):
        parser.error(f'NAME「{args.name}」は、英小文字・数字・ハイフンで 15 文字以内にする')

    try:
        with open(args.elf, 'rb') as f:
            payload = f.read()
    except OSError as e:
        print(f'mkkximg: {args.elf} を読めない（{e.strerror}）', file=sys.stderr)
        return 3
    if payload[:4] != b'\x7fELF':
        print(f'mkkximg: {args.elf} は ELF ではない（クロスコンパイルした実行ファイルを渡す）', file=sys.stderr)
        return 3

    crc = zlib.crc32(payload) & 0xFFFFFFFF
    header = HEADER.pack(b'KX2I', 1, len(payload), crc, args.name.encode('ascii'))
    try:
        with open(args.out, 'wb') as f:
            f.write(header + payload)
    except OSError as e:
        print(f'mkkximg: {args.out} を書けない（{e.strerror}）', file=sys.stderr)
        return 4
    print(json.dumps({'image': os.path.abspath(args.out), 'name': args.name, 'size': len(payload), 'crc32': f'0x{crc:08x}'}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
