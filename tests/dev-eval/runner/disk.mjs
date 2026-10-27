// EVAL の実行の仕組みのディスクの守り（testing.md 5章）。外側の EVAL〔改善〕3回目は、ディスクがいっぱいで、直したプラグインの2段目が
// ENOSPC で落ち、クリエイターも Chromium を入れられずに、その理由を調べ続けた。環境の誤りを、クリエイターや生成プラグインの誤りとして
// 採点しないための部品。
//   checkFreeSpace    始める前に、/ と OS の一時フォルダと結果のフォルダの空きを確かめる（足りなければ始めない）
//   removeAgentCache  1回の実行の後に、エージェントのホームの .cache（Playwright が入れたブラウザーなど）を消す
//   diskErrorsOnly    段階の不合格が、すべてディスクの誤り（ENOSPC・EIO）か
//   diskErrorResults  会話の記録のツールの結果のうち、ディスクの誤りが出たもの（クリエイターがディスクがいっぱいの中で動いた印）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 始めるのに要る空き（バイト） */
export const MIN_FREE_BYTES = 2 * 1024 ** 3;

/** ディスクの誤りの理由（Node の ENOSPC・EIO と、Python の OSError の文） */
export const DISK_ERROR = /\bENOSPC\b|no space left on device|\bEIO\b|input\/output error/i;

const gb = (bytes) => (bytes / 1024 ** 3).toFixed(1);

/** p か、その上のフォルダのうち、あるもの（まだ作っていない結果のフォルダの空きを、置かれるディスクで見るため） */
function existingAncestor(p) {
  let dir = path.resolve(p);
  while (!fs.existsSync(dir)) {
    const up = path.dirname(dir);
    if (up === dir) return dir;
    dir = up;
  }
  return dir;
}

/**
 * ディスクの空きを確かめる。空きは、root でない利用者が使える分（statfs の bavail）で見る。見られない場所は見ない。
 * まだない場所（これから作る結果のフォルダ）は、上のフォルダのうち、あるもので見る。
 * @param {{ paths?: string[], dirs?: string[], minBytes?: number, statfs?: Function }} [o] paths は既定で見る場所（/ と OS の一時フォルダ）、
 *   dirs は足して見る場所（結果のフォルダ。実行のフォルダとクリエイターのホームが入る）。statfs は試験で差し替える
 * @returns {{ ok: boolean, low: Array<{ path: string, freeBytes: number }>, message: string }}
 */
export function checkFreeSpace({ paths = ['/', os.tmpdir()], dirs = [], minBytes = MIN_FREE_BYTES, statfs = fs.statfsSync } = {}) {
  const low = [];
  for (const p of new Set([...paths, ...dirs.filter(Boolean)])) {
    let st;
    try {
      st = statfs(existingAncestor(p));
    } catch {
      continue;
    }
    const freeBytes = Number(st.bavail) * Number(st.bsize);
    if (freeBytes < minBytes) low.push({ path: p, freeBytes });
  }
  const message = low.length
    ? `ディスクの空きが足りないので始めません（${low.map((l) => `${l.path} の空き ${gb(l.freeBytes)} GB`).join('、')}。${gb(minBytes)} GB 以上が要ります）。`
      + 'OS の一時フォルダに残った試験のフォルダ（dev-eval-*、outer-change-* など）や、前の実行のフォルダを片づけてから、やり直してください。'
    : '';
  return { ok: low.length === 0, low, message };
}

/**
 * エージェントのホームの .cache を消す。クリエイターや試すエージェントが、2段目の試験のために入れる Playwright の Chromium
 * （.cache/ms-playwright。1回で約 1GB）が、実行ごとにたまるため。セッションの記録（.claude）は消さない（呼ぶ側が決める）。
 * 消せなくても実行は止めない（まだ書いているプロセスがあるときなど）。@returns {boolean} 消せたか
 */
export function removeAgentCache(home) {
  try {
    fs.rmSync(path.join(home, '.cache'), { recursive: true, force: true, maxRetries: 3 });
    return true;
  } catch {
    return false;
  }
}

/** tests/run.py の段階（stages[] の1つ）の不合格が、すべてディスクの誤りか。不合格がなければ偽 */
export function diskErrorsOnly(stage) {
  const failures = stage?.failures ?? [];
  return failures.length > 0 && failures.every((f) => DISK_ERROR.test(String(f?.reason ?? '')));
}

/**
 * 会話の記録（items）のツールの結果（tool.result）のうち、ディスクの誤り（ENOSPC・EIO）が出たものの番号（seq）。
 * クリエイター（とそのサブエージェント）が、ディスクがいっぱいの中で動いた印である。外側の EVAL〔改善〕3回目では、Chromium を入れる
 * コマンドの結果に ENOSPC が出て、クリエイターがその理由を調べ続け、最後の報告も変わった。ツールの呼び出し（tool.use）とチャットの文は見ない
 * （ENOSPC を探すコマンドや、それを伝える文は、ディスクの誤りそのものではないため）
 */
export function diskErrorResults(items) {
  return (items ?? []).filter((it) => it?.kind === 'tool.result' && DISK_ERROR.test(String(it.text ?? ''))).map((it) => it.seq);
}
