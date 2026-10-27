#!/bin/bash
# サンドボックスの外で、擬似の機器を通しで確かめる（試作の試験）。
#   bash test_native.sh
# クロスコンパイル → イメージにする → 転送（curl の TFTP、kxtool の TFTP、kxtool の HTTP）→ インストール → 再起動 → 実行 → ログ
set -u
E=$(cd "$(dirname "$0")" && pwd)
R=$E/runs/test-native
rm -rf "$R"; mkdir -p "$R"; cd "$R"
pass=0; failn=0
check() { # 名前 期待する正規表現 実際の文
  if printf '%s' "$3" | grep -Eq -- "$2"; then echo "ok   $1"; pass=$((pass+1)); else echo "FAIL $1"; echo "---- got:"; printf '%s\n' "$3" | tail -15; failn=$((failn+1)); fi
}

python3 -I "$E/kxemu/kxemu.py" serve --state "$R/dev" --ready-file "$R/ready.json" > serve.out 2> serve.err &
EMU=$!
trap 'kill $EMU 2>/dev/null' EXIT
for _ in $(seq 1 50); do [ -f ready.json ] && break; sleep 0.1; done
port() { python3 -c "import json;print(json.load(open('ready.json'))['$1'])"; }
CP=$(port console_port); TP=$(port tftp_port); HP=$(port http_port)

arm-linux-gnueabihf-gcc -O2 -static -o sensor.elf "$E/sample/sensor.c"
arm-linux-gnueabihf-gcc -O2 -o sensor.dyn "$E/sample/sensor.c"
python3 "$E/sample/mkkximg.py" sensor.elf sensor sensor.kximg > /dev/null
python3 "$E/sample/mkkximg.py" sensor.dyn sensor sensor-dyn.kximg > /dev/null
cp sensor.kximg broken.kximg; printf '\x00' | dd of=broken.kximg bs=1 seek=100 conv=notrunc status=none

# 1. curl の TFTP と nc のコンソール（本物の道具の形）
curl -sS -T sensor.kximg "tftp://127.0.0.1:$TP/sensor.kximg"; check "curl -T tftp で送れる" '^0$' "$?"
curl -sS -T broken.kximg "tftp://127.0.0.1:$TP/broken.kximg"
curl -sS -T sensor.elf "tftp://127.0.0.1:$TP/sensor.elf"
out=$(printf 'kxinstall /tmp/sensor.elf\nkxinstall /tmp/broken.kximg\nkxinstall /tmp/sensor.kximg\nkxapp run sensor\nreboot\nkxapp run sensor\nexit\n' | timeout 30 nc -N 127.0.0.1 "$CP" | tr -d '\r')
check "見出しのないものは断る" 'sensor.elf: bad magic' "$out"
check "CRC が合わないものは断る" 'broken.kximg: CRC mismatch \(header 0x[0-9a-f]{8}, actual 0x[0-9a-f]{8}\)' "$out"
check "インストールは再起動まで有効にならない" 'kxapp: sensor: not installed \(pending: reboot to activate\)' "$out"
check "再起動の後に動き、取り終わりの目印が出る" 'AVG=25.*\[kxapp\] sensor exited \(status=0\)' "$(printf '%s' "$out" | tr '\n' ' ')"

# 2. 動的リンクは機器で動かない
curl -sS -T sensor-dyn.kximg "tftp://127.0.0.1:$TP/sensor-dyn.kximg"
out=$(printf 'kxinstall /tmp/sensor-dyn.kximg\nreboot\nkxapp run sensor\nexit\n' | timeout 30 nc -N 127.0.0.1 "$CP" | tr -d '\r')
check "動的リンクは not found" '-sh: /opt/app/sensor: not found' "$out"

# 3. kxtool の本物の形（TFTP と TCP）
export KX_TFTP_PORT=$TP KX_CONSOLE_PORT=$CP
out=$("$E/kxemu/kxtool" -d 127.0.0.1 send sensor.kximg 2>&1); check "kxtool send（TFTP）" 'sent sensor.kximg -> 127.0.0.1:/tmp/sensor.kximg \(423820 bytes\)' "$out"
out=$("$E/kxemu/kxtool" -d 127.0.0.1 console -c 'kxinstall /tmp/sensor.kximg' -c reboot -c 'kxapp run sensor' 2>&1)
check "kxtool console（TCP）" 'AVG=25' "$out"
unset KX_TFTP_PORT KX_CONSOLE_PORT

# 4. kxtool の試験の形（HTTP のつなぎ口。プロキシなし）
export KXEMU_GATEWAY=http://localhost:$HP KXEMU_ADDRS=192.168.7.2
out=$("$E/kxemu/kxtool" -d 10.0.0.9 send sensor.kximg 2>&1); check "決めたアドレスのほかには届かない" 'No route to host' "$out"
out=$("$E/kxemu/kxtool" send sensor.kximg 2>&1); check "kxtool send（HTTP）" 'sent sensor.kximg -> 192.168.7.2:/tmp/sensor.kximg' "$out"
out=$(printf 'kxinstall /tmp/sensor.kximg\nreboot\nkxapp run sensor\n' | "$E/kxemu/kxtool" console 2>&1)
check "kxtool console（HTTP、標準入力）" 'AVG=25' "$out"
out=$("$E/kxemu/kxtool" log 2>&1); check "kxtool log でコンソールの記録が見える" 'sensor module start' "$out"
unset KXEMU_GATEWAY KXEMU_ADDRS

# 5. 機器の記録
check "記録：転送の経路と使ったアドレスが残る" '"via": "tftp".*"via": "http", "addr": "192.168.7.2"' "$(tr '\n' ' ' < dev/history.jsonl)"
check "記録：実行の結果が残る" '"ev": "run", "name": "sensor", "ok": true, "kind": "arm-static", "status": 0' "$(cat dev/history.jsonl)"
check "記録：隔離のしかた" '"isolate": "bwrap"' "$(cat dev/history.jsonl)"

# 6. 同じ手順を2回やると、コンソールの記録が同じになる（決まった動き）
kill $EMU; wait $EMU 2>/dev/null
run_once() {
  rm -rf "$R/det"; rm -f det.json
  python3 -I "$E/kxemu/kxemu.py" serve --state "$R/det" --ready-file det.json > /dev/null 2>&1 &
  local pid=$!
  for _ in $(seq 1 50); do [ -f det.json ] && break; sleep 0.1; done
  local hp; hp=$(python3 -c "import json;print(json.load(open('det.json'))['http_port'])")
  KXEMU_GATEWAY=http://localhost:$hp "$E/kxemu/kxtool" send sensor.kximg > /dev/null
  printf 'kxinstall /tmp/sensor.kximg\nreboot\nkxapp run sensor\nlogread\n' | KXEMU_GATEWAY=http://localhost:$hp "$E/kxemu/kxtool" console > /dev/null
  kill $pid; wait $pid 2>/dev/null
  sha256sum < "$R/det/console.log" | cut -c1-16
  sha256sum < "$R/det/history.jsonl" | cut -c1-16
}
a=$(run_once); b=$(run_once)
check "2回の実行で、コンソールの記録と出来事の記録が同じ" "^$(printf '%s' "$a" | tr '\n' ' ')\$" "$(printf '%s' "$b" | tr '\n' ' ')"
echo "pass=$pass fail=$failn"
