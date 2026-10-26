// 生成プラグインの Web管理画面を、Playwright で人と同じ流れ（設定 → 開始 → 監視 → 結果）で操作する（testing.md 10.4）。
// 実行中の確認（許可の求めなど）には、画面では答えない（答えるのは run.mjs の onPermissionRequest と onUserInputRequest）。
// 人の判断待ちにも、画面では答えない。状態の要点（onSnapshot）に質問を入れ、run.mjs がチャットに決まった返事を送る（human-wait.mjs）。
// 生成プラグインには、試験のためだけの機能を足さない。画面の部品は、ひな形の ui/static（app.js、render.js）が作るものを使う。
//   開始前の設定の欄   #setting-<key>（key の \w と - 以外は _）。最大の繰り返しの回数は #setting-maxIterations
//   開始のボタン      #start。開始できないときの理由は #start-message
//   終わった理由      #s-end の中の #end-reason（出たら終わり）
//   結果の表示        #s-end（まとめ）、#s-iterations（試行ごとの評価基準と合否）

/** 画面の操作で起きた誤り。message は平易な日本語 */
export class ScreenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScreenError';
  }
}

/** チャットに出た文から、画面の URL（http://127.0.0.1:<番号>/?k=<合言葉>）を探す。なければ null */
export function findScreenUrl(text) {
  const match = /https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/\?k=[A-Za-z0-9_-]+/.exec(String(text ?? ''));
  return match ? match[0] : null;
}

/** 設定の欄の id（ui/static/render.js の fieldId と同じ） */
export const fieldId = (key) => `setting-${String(key).replace(/[^\w-]/g, '_')}`;

const firstLine = (text) => String(text ?? '').split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * ブラウザーを起動する。手元の Chrome、Edge の順に試し、どちらもなければ Playwright の Chromium を使う（REQ-048）。
 * 環境変数 PLUGIN_TEST_BROWSER_CHANNEL（chrome、msedge、chromium）があれば、それだけを試す。
 * @returns {Promise<{ browser: object, channel: string }>}
 */
export async function launchBrowser(chromium, { env = process.env } = {}) {
  const forced = env.PLUGIN_TEST_BROWSER_CHANNEL;
  const channels = forced ? [forced === 'chromium' ? undefined : forced] : ['chrome', 'msedge', undefined];
  const errors = [];
  for (const channel of channels) {
    try {
      const browser = await chromium.launch(channel ? { channel } : {});
      return { browser, channel: channel ?? 'chromium' };
    } catch (error) {
      errors.push(`${channel ?? 'Playwright の Chromium'}：${firstLine(error?.message)}`);
    }
  }
  throw new ScreenError(
    `ブラウザーを起動できませんでした（${errors.join(' / ')}）。Chrome か Edge を入れるか、check_tools.py --install で Playwright の Chromium を入れてください。`,
  );
}

async function setField(page, key, value) {
  const field = page.locator(`[id="${fieldId(key)}"]`);
  if ((await field.count()) === 0) throw new ScreenError(`設定「${key}」の欄が画面にありません。`);
  const kind = await field.evaluate((el) => `${el.tagName.toLowerCase()}:${el.type ?? ''}`);
  try {
    if (kind.startsWith('select')) await field.selectOption(String(value), { timeout: 5000 });
    else if (kind === 'input:checkbox') await field.setChecked(Boolean(value), { timeout: 5000 });
    else await field.fill(String(value), { timeout: 5000 });
  } catch (error) {
    throw new ScreenError(`設定「${key}」に「${value}」を入れられませんでした（${firstLine(error?.message)}）。`);
  }
}

/** ページの中から、状態の全体（GET /api/state）を読む。読めなければ null */
async function readState(page) {
  try {
    return await page.evaluate(async () => {
      const key = new URLSearchParams(window.location.search).get('k') ?? '';
      const response = await fetch(`/api/state?k=${encodeURIComponent(key)}`, { cache: 'no-store' });
      return response.ok ? await response.json() : null;
    });
  } catch {
    return null;
  }
}

const agentsOf = (state) => (state?.run?.agents ?? []).map((a) => `${a.role}:${a.status}`);

/** 監視の記録に残す、実行の状態の要点 */
function snapshotOf(state) {
  const run = state?.run;
  return {
    status: run?.status ?? 'preparing',
    phase: run?.phase ?? null,
    iteration: run?.iteration ?? null,
    agents: agentsOf(state),
    waits: (run?.waits ?? []).map((w) => w.kind),
    // 人の判断待ちの質問（generated-plugin-structure.md 4.15）。waiting は、統括が手番を終えて答えを待っているか。run.mjs が決まった返事を送るのに使う
    humanWait: run?.humanWait ? { question: run.humanWait.question ?? '', askedAt: run.humanWait.askedAt ?? null, waiting: Boolean(run.humanWait.waiting) } : null,
  };
}

/**
 * ブラウザーの起動と画面の操作をまとめた入れ物を作る。
 * @param {{ chromium: object, env?: object }} args chromium は Playwright の chromium
 */
export function createScreen({ chromium, env = process.env }) {
  let launched = null;
  return {
    /** ブラウザーを起動する（試験の始めに1回。AI クレジットを使う前に、起動できないと分かるようにするため） */
    async prepare() {
      launched ??= await launchBrowser(chromium, { env });
      return { channel: launched.channel };
    },

    /**
     * 画面を開き、設定を入れて開始し、終わった理由が出るまで見て、結果を読む。
     * @param {object} args
     * @param {string} args.url チャットに出た画面の URL
     * @param {{ maxIterations?: number, task?: object }} [args.settings] 課題の設定（eval.json の settings）
     * @param {number} [args.timeoutMs] 開始してから終わるまでの上限
     * @param {number} [args.pollMs] 状態を見る間隔
     * @param {string} [args.screenshotPath] 最後の画面の写真の場所
     * @param {(snapshot: object) => void} [args.onSnapshot] 状態が変わるたびに呼ぶ
     * @param {AbortSignal} [args.signal] 試験が止まったら中断する
     * @returns {Promise<object>} { finished, timedOut, endReason, endReasonText, resultText, iterationsText, summary, iterations, snapshots }
     * @throws {ScreenError} 画面を開けない・設定を入れられない・開始できないとき
     */
    async operate({ url, settings = {}, timeoutMs = 30 * 60_000, pollMs = 2000, screenshotPath, onSnapshot, signal }) {
      await this.prepare();
      const startedAt = Date.now();
      const context = await launched.browser.newContext();
      const page = await context.newPage();
      const snapshots = [];
      const record = (state) => {
        const snap = { t: Date.now() - startedAt, ...snapshotOf(state) };
        const previous = snapshots.at(-1);
        if (previous && JSON.stringify({ ...previous, t: 0 }) === JSON.stringify({ ...snap, t: 0 })) return;
        if (snapshots.length < 500) snapshots.push(snap);
        onSnapshot?.(snap);
      };
      const take = async (extra) => {
        if (screenshotPath) {
          try {
            await page.screenshot({ path: screenshotPath, fullPage: true });
          } catch {
            // 写真が撮れなくても、結果には影響しない
          }
        }
        return { snapshots, ...extra };
      };
      try {
        page.setDefaultTimeout(30_000);
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('#start', { timeout: 60_000 });
        } catch (error) {
          throw new ScreenError(`画面を開けませんでした（${firstLine(error?.message)}）。`);
        }
        if (settings.maxIterations !== undefined) await setField(page, 'maxIterations', settings.maxIterations);
        for (const [key, value] of Object.entries(settings.task ?? {})) await setField(page, key, value);
        await page.click('#start');
        try {
          await page.waitForFunction(
            () => {
              const message = document.getElementById('start-message');
              return !document.getElementById('start') || Boolean(message && !message.hidden && message.textContent.trim() !== '');
            },
            null,
            { timeout: 60_000 },
          );
        } catch {
          throw new ScreenError('開始のボタンを押しても、画面が変わりませんでした。');
        }
        if ((await page.locator('#start').count()) > 0) {
          const reason = (await page.locator('#start-message').innerText()).trim();
          throw new ScreenError(`画面で開始できませんでした（${reason}）。`);
        }

        const deadline = startedAt + timeoutMs;
        let lost = 0;
        for (;;) {
          if (signal?.aborted) throw new ScreenError('試験が止まったので、画面の操作をやめました。');
          const state = await readState(page);
          lost = state ? 0 : lost + 1;
          if (state) record(state);
          if ((await page.locator('#s-end #end-reason').count()) > 0) {
            const final = (await readState(page)) ?? state;
            if (final) record(final);
            const text = async (selector) => ((await page.locator(selector).count()) > 0 ? (await page.locator(selector).first().innerText()).trim() : '');
            return await take({
              finished: true,
              timedOut: false,
              endReason: final?.run?.endReason ?? null,
              endReasonText: await text('#s-end #end-reason'),
              resultText: await text('#s-end'),
              iterationsText: await text('#s-iterations'),
              summary: final?.run?.summary ?? null,
              iterations: final?.run?.iterations ?? [],
            });
          }
          if (lost >= 10) throw new ScreenError('画面のサーバーにつながらなくなりました（Copilot CLI が終わったか、/clear された可能性があります）。');
          if (Date.now() >= deadline) {
            return await take({ finished: false, timedOut: true, endReason: null, endReasonText: '', resultText: '', iterationsText: '', summary: null, iterations: [] });
          }
          await sleep(pollMs);
        }
      } catch (error) {
        if (error instanceof ScreenError) {
          error.snapshots = snapshots;
          if (screenshotPath) await take({});
        }
        throw error;
      } finally {
        await context.close().catch(() => {});
      }
    },

    async close() {
      const current = launched;
      launched = null;
      await current?.browser.close().catch(() => {});
    },
  };
}
