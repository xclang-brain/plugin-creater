// 改善の模擬ユーザー edl-change の内側の EVAL の見本の記録（inner/golden/.device/ と inner/golden/logs/device.log）を、
// 擬似の機器を1回動かして作る。
// 手順は、取り込む決まりどおりの正しい1回：直したソース（inner/golden/inputs/src）を cross-compile のスキルのスクリプトで
// ビルド → deploy のスキルのスクリプトでイメージにする → kxtool で送る → kxinstall → reboot → kxapp run →
// コンソールに出た文字を、頼まれた場所（確かめ B の logs/device.log）にログとして保存する → 機器の記録を写す。
// 機器は決まった動きをするので、同じツールチェーンなら毎回同じ記録になる。qemu-arm と arm-linux-gnueabihf-gcc が要る。
//
//   node tests/dev-eval/personas/edl-change/inner/make_golden.mjs [--out <フォルダ>]   （既定は inner/golden）

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { startDevice } from '../../../device/kxdevice.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILLS = path.join(HERE, '..', 'files', 'kx200-firmware', '.github', 'skills');
const KX_BUILD = path.join(SKILLS, 'cross-compile', 'scripts', 'kx-build.sh');
const MKKXIMG = path.join(SKILLS, 'deploy', 'scripts', 'mkkximg.py');
const ADDRESS = '192.168.7.2';
const APP = 'sensor';
/** 確かめ B（inner/standalone.json）で頼む、ログの保存先 */
const LOG_DIR = 'logs';
const LOG_NAME = 'device.log';

function run(cmd, args, env) {
  const r = spawnSync(cmd, args, { env, encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args.join(' ')} が失敗した（${r.status}）：${r.stderr || r.stdout}`);
  return r.stdout;
}

/**
 * 見本の記録を作る。
 * @param {string} outDir 記録を写すフォルダ（<outDir>/.device/console.log・history.jsonl と、保存したログ <outDir>/logs/device.log）
 */
export async function makeGolden(outDir = path.join(HERE, 'golden')) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'edl-golden-'));
  // 試験の外のプロキシを通さない（kxtool は HTTP_PROXY があると、それを通して機器に送る）
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_proxy$/i.test(k) && !/^KX/.test(k)));
  let dev = null;
  try {
    const src = path.join(temp, 'src');
    fs.cpSync(path.join(HERE, 'inputs', 'src'), src, { recursive: true });
    fs.cpSync(path.join(HERE, 'golden', 'inputs', 'src'), src, { recursive: true });
    const { elf } = JSON.parse(run('bash', [KX_BUILD, '--src', src, '--name', APP, '--out', path.join(temp, 'build')], base));
    const { image } = JSON.parse(run('python3', [MKKXIMG, elf, APP, path.join(temp, 'build', `${APP}.kximg`)], base));
    dev = await startDevice({ stateDir: path.join(temp, 'device'), addresses: [ADDRESS] });
    const env = { ...base, ...dev.env, PATH: `${dev.binDir}${path.delimiter}${base.PATH ?? ''}` };
    run('kxtool', ['-d', ADDRESS, 'send', image], env);
    const log = run('kxtool', ['-d', ADDRESS, 'console', '-c', `kxinstall /tmp/${APP}.kximg`, '-c', 'reboot', '-c', `kxapp run ${APP}`], env);
    fs.mkdirSync(path.join(outDir, LOG_DIR), { recursive: true });
    fs.writeFileSync(path.join(outDir, LOG_DIR, LOG_NAME), log.replace(/\r\n/g, '\n'));
    dev.copyRecordsTo(outDir);
    return outDir;
  } finally {
    await dev?.stop();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const i = process.argv.indexOf('--out');
  const out = await makeGolden(i > 0 ? path.resolve(process.argv[i + 1]) : undefined);
  console.log(`見本の記録を作った：${path.join(out, '.device')}、${path.join(out, LOG_DIR, LOG_NAME)}`);
}
