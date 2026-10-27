// 開発の試験（tests/dev-eval の *.test.mjs と、その道具）が作る一時フォルダの後始末。作ったフォルダを覚え、試験のプロセスが終わるときに消す。
// 試験が途中で落ちても残らないように、試験ごとではなくプロセスの終わりに消す。試験の残りがディスクをあふれさせ、外側の EVAL の
// 生成プラグインの2段目が ENOSPC で落ちたためである（外側の EVAL〔改善〕3回目。/tmp に 28GB。testing.md 5章）。
// 試験だけが読み込む（実行の仕組みの部品は読み込まない。実行のフォルダは残すため）。
// あわせて、ディスクの空きの確かめ（disk.mjs の checkFreeSpace）の代わりに、いつも足りると答える diskOk を持つ。入口（outer.mjs・inner.mjs の
// main、runPlan、innerEval）を動かす試験が、試験の機械の空きに左右されないためである（空きが少ないときこそ試験を回すので）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIRS = [];
let registered = false;

/** dir を、試験のプロセスが終わるときに消す。@returns {string} dir */
export function removeAtExit(dir) {
  if (!registered) {
    registered = true;
    process.on('exit', () => {
      for (const d of DIRS) {
        try {
          fs.rmSync(d, { recursive: true, force: true });
        } catch {
          // 子プロセスがまだ書いているなどで消せないものは残す（試験の合否には入れない）
        }
      }
    });
  }
  DIRS.push(dir);
  return dir;
}

/** OS の一時フォルダに `<prefix>-XXXXXX` を作り、試験のプロセスが終わるときに消す */
export const tempDir = (prefix) => removeAtExit(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));

/** ディスクの空きの確かめの代わり：いつも足りる（disk.mjs の checkFreeSpace と同じ形）。空きを確かめる試験のほかは、これを渡す */
export const diskOk = () => ({ ok: true, low: [], message: '' });
