#!/usr/bin/env python3
"""mkkximg: ELF を KX-200 のイメージ（.kximg）にする（ダミーのデプロイのスキルが持つ「ユーザーの資産」の見本）。
   python3 mkkximg.py INPUT.elf APPNAME OUTPUT.kximg
見出し 32 バイト（リトルエンディアン）: magic "KX2I"、版 1、本体の長さ、本体の CRC32（zlib）、名前（16 バイト、NUL 埋め）"""
import struct, sys, zlib
src, name, dst = sys.argv[1:4]
payload = open(src, 'rb').read()
if len(name.encode()) > 15:
    sys.exit('mkkximg: name must be 15 bytes or less')
header = struct.pack('<4sIII16s', b'KX2I', 1, len(payload), zlib.crc32(payload) & 0xFFFFFFFF, name.encode())
open(dst, 'wb').write(header + payload)
print(f'mkkximg: {dst} ({len(payload)} bytes, crc32=0x{zlib.crc32(payload) & 0xFFFFFFFF:08x})')
