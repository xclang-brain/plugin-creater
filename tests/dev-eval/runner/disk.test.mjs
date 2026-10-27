// EVAL の実行の仕組みのディスクの守り（disk.mjs。testing.md 5章）の試験。ディスクの空きは偽の statfs で決める。実際のモデルは使わない。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkFreeSpace, DISK_ERROR, diskErrorResults, diskErrorsOnly, MIN_FREE_BYTES, removeAgentCache, removeSessionRecords } from './disk.mjs';
import { tempDir } from './temp-dirs.mjs';

const GB = 1024 ** 3;
/** 場所ごとの空き（バイト）を返す偽の statfs。ない場所は投げる */
const fakeStatfs = (free) => (p) => {
  if (!Object.hasOwn(free, p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  return { bsize: 4096, bavail: Math.floor(free[p] / 4096) };
};

test('testing.md 5章 ディスクの空き：/ と OS の一時フォルダが 2GB 以上なら始めてよい。既定で見るのはこの2つ', () => {
  const seen = [];
  const statfs = (p) => { seen.push(p); return { bsize: 4096, bavail: (3 * GB) / 4096 }; };
  const r = checkFreeSpace({ statfs });
  assert.equal(r.ok, true);
  assert.deepEqual(r.low, []);
  assert.equal(r.message, '');
  assert.deepEqual(seen, [...new Set(['/', os.tmpdir()])]);
  assert.equal(MIN_FREE_BYTES, 2 * GB);
});

test('testing.md 5章 ディスクの空き：2GB 未満の場所があれば始めない。どこがどれだけ空いているかと、片づけ方を示す。見られない場所は見ない', () => {
  const r = checkFreeSpace({ paths: ['/', '/tmp', os.homedir()], statfs: fakeStatfs({ '/': 70 * 1024 ** 2, '/tmp': 5 * GB }) });
  assert.equal(r.ok, false);
  assert.deepEqual(r.low.map((l) => l.path), ['/']);
  assert.match(r.message, /ディスクの空きが足りないので始めません/);
  assert.match(r.message, /\/ の空き 0\.1 GB/);
  assert.match(r.message, /2\.0 GB 以上が要ります/);
  assert.match(r.message, /片づけてから/);
  // ちょうど 2GB は足りる。1 バイト足りなければ断る
  assert.equal(checkFreeSpace({ paths: ['/'], statfs: fakeStatfs({ '/': 2 * GB }) }).ok, true);
  assert.equal(checkFreeSpace({ paths: ['/'], statfs: fakeStatfs({ '/': 2 * GB - 4096 }) }).ok, false);
});

test('testing.md 5章 ディスクの空き：結果のフォルダ（dirs）も見る。まだないフォルダは、置かれる場所（あるうちで一番近い上のフォルダ）で見る', () => {
  const root = tempDir('disk-dirs');
  const seen = [];
  const statfs = (p) => {
    seen.push(p);
    return { bsize: 4096, bavail: p === root ? 100 : (3 * GB) / 4096 };
  };
  const out = path.join(root, 'not-yet', 'out');
  const r = checkFreeSpace({ paths: ['/'], dirs: [out, undefined], statfs });
  assert.equal(r.ok, false);
  assert.deepEqual(r.low.map((l) => l.path), [out]);
  assert.match(r.message, /not-yet/);
  assert.deepEqual(seen, ['/', root]);
  assert.equal(fs.existsSync(path.join(root, 'not-yet')), false, '確かめるだけで、フォルダは作らない');
});

test('testing.md 5章 実行の後の片づけ：エージェントのホームの .cache（Playwright の Chromium など）を消し、セッションの記録（.claude）は残す', () => {
  const home = tempDir('disk-home');
  fs.mkdirSync(path.join(home, '.cache', 'ms-playwright', 'chromium-1200'), { recursive: true });
  fs.writeFileSync(path.join(home, '.cache', 'ms-playwright', 'chromium-1200', 'chrome'), 'x');
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  assert.equal(removeAgentCache(home), true);
  assert.equal(fs.existsSync(path.join(home, '.cache')), false);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'projects')), true);
  // .cache がないときも、ホームがないときも、誤りにしない
  assert.equal(removeAgentCache(home), true);
  assert.equal(removeAgentCache(path.join(home, 'none')), true);
});

test('testing.md 5章 実行の後の片づけ：セッションの記録（.claude）を消す。止めた後も子プロセスが書いていて消せない（ENOTEMPTY）ときは、誤りにせず残す', () => {
  const home = tempDir('disk-session');
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(home, '.cache'), { recursive: true });
  assert.equal(removeSessionRecords(home), true);
  assert.equal(fs.existsSync(path.join(home, '.claude')), false);
  assert.equal(fs.existsSync(path.join(home, '.cache')), true, '.claude のほかは消さない');
  assert.equal(removeSessionRecords(home), true, 'ないときも誤りにしない');
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  const busy = () => {
    const error = new Error(`ENOTEMPTY: directory not empty, rmdir '${path.join(home, '.claude')}'`);
    error.code = 'ENOTEMPTY';
    throw error;
  };
  assert.equal(removeSessionRecords(home, busy), false);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'projects')), true);
});

test('testing.md 6.5 2段目の不合格がすべてディスクの誤り（ENOSPC・EIO）か：外側の EVAL〔改善〕3回目の3つの形と、Python の形を見分ける。ほかの不合格が1つでも混ざれば偽', () => {
  // 3回目の 78 件の理由の形（mkdtemp 64 件、写したフォントのファイル 10 件、mkdir 4 件）
  const run3 = [
    "ENOSPC: no space left on device, mkdtemp '/tmp/adapter-plugin-XXXXXX'",
    "\"ENOSPC, No space left on device '/tmp/adapter-plugin-rqFJa4/com.github.copilot/extensions/weekly-report/ui/static/fonts/ibm-plex-sans-jp'\"",
    "ENOSPC: no space left on device, mkdir '/tmp/adapter-plugin-abc/x'",
  ];
  const stage = (reasons) => ({ id: 'stage2', status: 'failed', failures: reasons.map((reason, i) => ({ test: `t${i}`, reason })) });
  assert.equal(diskErrorsOnly(stage(run3)), true);
  assert.equal(diskErrorsOnly(stage(['OSError: [Errno 28] No space left on device', "EIO: i/o error, write", 'OSError: [Errno 5] Input/output error'])), true);
  assert.equal(diskErrorsOnly(stage([...run3, 'AssertionError: 期待と違う'])), false);
  assert.equal(diskErrorsOnly(stage([])), false);
  assert.equal(diskErrorsOnly({ id: 'stage2', status: 'passed', failures: [] }), false);
  assert.equal(diskErrorsOnly(undefined), false);
  // 言葉の一部には当たらない
  assert.equal(DISK_ERROR.test('THEIOS の設定'), false);
});

test('testing.md 6.5 クリエイターがディスクがいっぱいの中で動いた印：ツールの結果（tool.result）にディスクの誤りが出たものの番号。ツールの呼び出しと文は見ない', () => {
  // 外側の EVAL〔改善〕3回目の [539]（Chromium を入れるコマンドの結果）と [610]（試験の結果）。[607] は ENOSPC を探すコマンド、[632] は報告の文
  const items = [
    { seq: 538, kind: 'tool.use', owner: 'main', name: 'Bash', input: { command: 'npx playwright install chromium' } },
    { seq: 539, kind: 'tool.result', owner: 'main', isError: false, text: "|  30% of 173.9 MiB\n[Error: ENOSPC: no space left on device, write] {\n  errno: -28," },
    { seq: 607, kind: 'tool.use', owner: 'main', name: 'Bash', input: { command: 'node --test 2>&1 | grep -E "error:|ENOSPC"' } },
    { seq: 608, kind: 'tool.result', owner: 'main', isError: false, text: 'ok 1 - 試験' },
    { seq: 610, kind: 'tool.result', owner: 'worker-1', isError: true, text: "error: \"EIO, Input/output error '/tmp/adapter-plugin-P4Fhho/x'\"" },
    { seq: 632, kind: 'creator.text', text: 'このパソコンのディスクがいっぱいで（ENOSPC）、ブラウザーを入れられませんでした。' },
  ];
  assert.deepEqual(diskErrorResults(items), [539, 610]);
  assert.deepEqual(diskErrorResults([{ seq: 1, kind: 'tool.result', text: 'THEIOS の設定を読んだ' }]), []);
  assert.deepEqual(diskErrorResults(undefined), []);
});
