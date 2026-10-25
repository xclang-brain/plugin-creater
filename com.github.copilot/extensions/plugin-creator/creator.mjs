// クリエイターのエクステンションの中心。ツール、フック、イベントの受け口をまとめる。
// Copilot CLI（@github/copilot-sdk/extension）には依らない。つなぎ口は extension.mjs（joinSession を呼ぶだけ）。
// 試験では、偽物のセッション（tests/creator/extension/fake-session.mjs）をつなぐ。
//
// ツールの一覧は BLUEPRINT 7章、設計書は generated-plugin-structure.md 9章、hearing.md 7章・8章・9章。
// 標準出力は JSON-RPC の通り道なので、console.log は使わない（失敗の知らせは標準エラーへ）。

import fs from 'node:fs';
import path from 'node:path';

import { DRAFT_TASK_SUFFIX } from './constants.mjs';
import { DEFAULT_PLUGIN_ROOT, createScreen, createUiLoader, listExamples } from './screen.mjs';
import { DocTextError, documentText } from './doc-text.mjs';
import { evalTaskSettingsProblems, settingLabels } from './eval-settings.mjs';
import { Refusal, createHearing, taskFileHash } from './hearing.mjs';
import { createHooks } from './hooks.mjs';
import { IssueError, fileIssue, runGh as defaultRunGh } from './issue.mjs';
import { checkResultFile, createResultReader } from './results.mjs';
import { hearingView, knowledgeRow, stateText } from './report.mjs';
import { checkTaskDefinition, createSample, injectCriteria, readDraft } from './sample.mjs';
import { copilotHome, createStore } from './store.mjs';
import { TOOL_DEFS } from './tool-defs.mjs';

const STATE_INCLUDES = ['最後の問答', '振り返りの材料'];
const MAX_RESULT_FILES = 20;

/** ツールの失敗の結果。理由の文が、そのままモデルに届く */
const failure = (reason) => ({ textResultForLlm: reason, resultType: 'failure' });
const UNEXPECTED_FAILURE = 'うまくいきませんでした（思いがけない失敗です）。もう一度呼んでも同じときは、ユーザーにそのまま伝えてください。';

const errorMessage = (e) => (e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e));

/**
 * @param {object} options
 * @param {string} options.sessionId セッションの番号（記録の置き場所になる）
 * @param {string} options.home COPILOT_HOME
 * @param {string} [options.cwd] 作業フォルダ
 * @param {{ now: () => number }} [options.clock]
 * @param {string} [options.pluginRoot] クリエイターのプラグインの根
 * @param {string} [options.examplesDir] 会話例のフォルダ（既定は <プラグインの根>/examples）
 * @param {Function} [options.loadUi] ひな形の画面の部品を読み込む関数（試験で差し替える）
 * @param {Function} [options.runGh] gh を動かす関数（試験で差し替える）
 * @param {(text: string) => void} [options.warn]
 */
export function createCreator({
  sessionId,
  home,
  cwd = process.cwd(),
  clock = { now: () => Date.now() },
  pluginRoot = DEFAULT_PLUGIN_ROOT,
  examplesDir = path.join(pluginRoot, 'examples'),
  loadUi = createUiLoader({ pluginRoot }),
  runGh = defaultRunGh,
  warn = (text) => console.error(`[plugin-creator] ${text}`),
}) {
  if (!sessionId) throw new Error('セッションの番号がありません。Copilot CLI の中で動かしてください。');

  let workDir = cwd;
  const store = createStore({ home, sessionId });
  let flushRequests = () => {};
  const hearing = createHearing({ store, sessionId, clock, onCreated: () => flushRequests() });
  const readResult = createResultReader();
  const sample = createSample({ loadUi, clock });
  const recorder = createHooks({ hearing, store, clock, warn });
  const { hooks, onSessionEvent } = recorder;
  flushRequests = recorder.flushRequests;

  // ---- 画面に出す状態 ------------------------------------------------------------------------

  function resultFiles() {
    return store.readResults().map((file) => readResult(file));
  }

  /** 画面に出す課題の設定の値。作業ごとの設定は、案の設定の見出し（label）を添える。見出しが分からないものは、名前（key）を見出しにする */
  function settingsView(settings, labels) {
    const task = Object.entries(settings?.task ?? {}).map(([key, value]) => ({ key, label: labels?.[key] || key, value }));
    return { ...(settings?.maxIterations === undefined ? {} : { maxIterations: settings.maxIterations }), task };
  }

  function confirmationView() {
    const state = hearing.state;
    const c = state?.confirmation;
    if (!c) return null;
    const byId = new Map(state.knowledge.map((k) => [k.id, k]));
    const knowledge = c.knowledgeIds.map((id) => byId.get(id)).filter(Boolean);
    const criteria = knowledge.filter((k) => k.kind === 'criterion').map((k, i) => ({ id: `C-${String(i + 1).padStart(2, '0')}`, text: k.text, knowledge: k.id }));
    return {
      at: c.at,
      behavior: c.behavior,
      knowledge: knowledge.map(knowledgeRow),
      criteria,
      evalTasks: c.evalTasks.map((t) => ({
        prompt: t.prompt,
        inputs: t.inputs,
        criteria: t.criteria.map((id) => ({ id, text: byId.get(id)?.text ?? '' })),
        settings: settingsView(t.settings, c.settingLabels),
      })),
      rebuild: c.rebuild ?? null,
      sampleUrl: sample.url,
    };
  }

  function buildView() {
    const notices = [];
    if (hearing.loadError) notices.push(hearing.loadError.message);
    return {
      title: 'plugin-creator の画面',
      sessionId,
      hearing: hearingView(hearing),
      confirmation: confirmationView(),
      results: resultFiles(),
      examples: listExamples(examplesDir),
      notices,
    };
  }

  const screen = createScreen({ getView: buildView, loadUi, examplesDir });

  // ---- 生成前の確認 ----------------------------------------------------------------------------

  /**
   * 作業の定義の案を読み、合否の基準を差し込み、決まりで確かめて、見本を作り直す。見本の URL と、案の設定の見出しを返す。
   * evalTasks があれば、課題の作業ごとの設定の値が、案の設定に合うかも確かめる（見本を作り直す前に断る。X4-04）
   */
  async function prepareSample({ taskPath, knowledgeRows, evalTasks }) {
    let draft;
    try {
      draft = readDraft(taskPath);
    } catch (error) {
      throw new Refusal(errorMessage(error)); // 読めない理由（平易な日本語）を、そのままモデルに返す
    }
    const criterionRows = knowledgeRows.filter((k) => k.kind === 'criterion');
    if (criterionRows.length === 0) {
      throw new Refusal('種類が「合否の決め方」の仕事のやり方や決まりがありません。合格の条件は、種類が「合否の決め方」の仕事のやり方や決まりから作るので、合格の条件にするものを plugin-creator_record で種類「合否の決め方」にしてください。');
    }
    const task = injectCriteria(draft, criterionRows);
    let ui;
    try {
      ui = await loadUi();
    } catch (error) {
      throw new Refusal(errorMessage(error));
    }
    let schema;
    try {
      schema = JSON.parse(fs.readFileSync(ui.taskSchemaPath, 'utf8'));
    } catch (error) {
      throw new Refusal(`画面と合格の条件の設定の決まり（task.schema.json）を読めません：${errorMessage(error)}`);
    }
    const problems = checkTaskDefinition(task, schema);
    if (problems.length) {
      const shown = problems.slice(0, 8).join('\n');
      throw new Refusal(
        `画面と合格の条件の設定の案が決まりに合いません（${taskPath}）。直してから、もう一度知らせてください。\n${shown}${problems.length > 8 ? `\nほか${problems.length - 8}件` : ''}`,
      );
    }
    if (evalTasks) {
      // 作業ごとの設定を省いた課題は、空の値として比べる（必須で初めの値のない設定があれば、画面で開始できない）
      const found = evalTasks.flatMap((t, i) => evalTaskSettingsProblems(draft.settings, t.settings, `試しに動かして採点する試験の課題 ${i + 1} `));
      if (found.length) {
        const shown = found.slice(0, 8).join('\n');
        throw new Refusal(`課題の、作業の画面に入れる設定の値（settings.task）が、画面と合格の条件の設定の案（${taskPath}）に合いません。直してから、もう一度知らせてください。\n${shown}${found.length > 8 ? `\nほか${found.length - 8}件` : ''}`);
      }
    }
    try {
      return { url: await sample.update(task), settingLabels: settingLabels(draft.settings) };
    } catch (error) {
      throw new Refusal(`作業の画面の見本を開けません：${errorMessage(error)}`);
    }
  }

  /**
   * 課題の、作業の画面に入れる設定の値（eval.json の settings と同じ形：maxIterations と task。grade.mjs の確かめと合わせる）。
   * 省かれたら空のまとまり。名前の書き間違いで、ユーザーがよいと答えた値が黙って落ちないよう、使えない名前は断る。
   */
  function parseSettings(value, index) {
    if (value === undefined || value === null) return {};
    const label = `試しに動かして採点する試験の課題 ${index + 1} の設定（settings）`;
    if (typeof value !== 'object' || Array.isArray(value)) throw new Refusal(`${label}は、繰り返しの上限（maxIterations）と作業ごとの設定の値（task）を持つものにしてください。`);
    const unknown = Object.keys(value).filter((key) => key !== 'maxIterations' && key !== 'task');
    if (unknown.length) throw new Refusal(`${label}に、使えない名前があります：${unknown.join('、')}。使える名前：maxIterations、task`);
    const out = {};
    if (value.maxIterations !== undefined) {
      if (!Number.isInteger(value.maxIterations) || value.maxIterations < 1) throw new Refusal(`${label}の繰り返しの上限（maxIterations）は、1以上の整数で渡してください。`);
      out.maxIterations = value.maxIterations;
    }
    if (value.task !== undefined) {
      if (value.task === null || typeof value.task !== 'object' || Array.isArray(value.task)) throw new Refusal(`${label}の作業ごとの設定の値（task）は、設定の名前と値の組で渡してください。`);
      for (const [key, v] of Object.entries(value.task)) {
        if (!(typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))) {
          throw new Refusal(`${label}の作業ごとの設定「${key}」の値は、文字・数・真偽のどれかで渡してください。`);
        }
      }
      out.task = { ...value.task };
    }
    return out;
  }

  function validateConfirmArgs(args) {
    const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const text = (v) => (typeof v === 'string' ? v.trim() : '');
    if (!Array.isArray(a.knowledgeIds) || a.knowledgeIds.length === 0) throw new Refusal('示す仕事のやり方や決まりの番号の一覧（knowledgeIds）を渡してください。');
    if (!text(a.behavior)) throw new Refusal('できあがるプラグインの振る舞いの案（behavior）を渡してください。');
    if (!text(a.taskPath)) throw new Refusal(`画面と合格の条件の設定の案のパス（taskPath）を渡してください。置き場所は ${DRAFT_TASK_SUFFIX} です。`);
    if (!Array.isArray(a.evalTasks) || a.evalTasks.length === 0) throw new Refusal('試しに動かして採点する試験の課題の案（evalTasks）を、1つ以上渡してください。');
    const evalTasks = a.evalTasks.map((t, i) => {
      if (!t || typeof t !== 'object' || !text(t.prompt)) throw new Refusal(`試しに動かして採点する試験の課題 ${i + 1} に、頼むときの言葉（prompt）がありません。`);
      const inputs = (Array.isArray(t.inputs) ? t.inputs : []).map((f) => {
        const p = typeof f === 'string' ? f : f?.path;
        if (!text(p)) throw new Refusal(`試しに動かして採点する試験の課題 ${i + 1} の入力のファイルに、場所（path）がありません。`);
        return { path: text(p), provisional: typeof f === 'object' && f?.provisional === true };
      });
      return { prompt: text(t.prompt), inputs, criteria: (Array.isArray(t.criteria) ? t.criteria : []).map(String), settings: parseSettings(t.settings, i) };
    });
    let rebuild = null;
    if (a.rebuild !== undefined) {
      const strings = (v) => (Array.isArray(v) ? v.map(String).filter((s) => s.trim() !== '') : []);
      rebuild = { keep: strings(a.rebuild?.keep), change: strings(a.rebuild?.change) };
    }
    // ナレッジの番号は、重なりを除き、番号の小さい順にそろえる。見本の基準の番号（C-01 から）と、生成のときに組み立てのスクリプトが付ける番号を、同じ並びにするため
    const knowledgeIds = [...new Set(a.knowledgeIds.map((id) => String(id).trim()))].sort((x, y) => (Number(x.replace(/^\D+/, '')) || 0) - (Number(y.replace(/^\D+/, '')) || 0) || x.localeCompare(y));
    return { knowledgeIds, behavior: text(a.behavior), taskPath: text(a.taskPath), evalTasks, rebuild };
  }

  async function confirm(args) {
    hearing.checkConfirmable(); // 未着手の項目が残っていれば、残りを返して断る
    const a = validateConfirmArgs(args);
    const normalized = path.resolve(workDir, a.taskPath);
    if (!normalized.split(path.sep).join('/').endsWith(`/${DRAFT_TASK_SUFFIX}`)) {
      throw new Refusal(`画面と合格の条件の設定の案は、作業フォルダの ${DRAFT_TASK_SUFFIX} に置いてください（今のパス：${a.taskPath}）。`);
    }
    if (hearing.state.rebuild && a.rebuild === null) {
      throw new Refusal('作り直しのときは、引き継ぐことと変わること（rebuild）も知らせてください。');
    }
    const rows = hearing.knowledgeByIds(a.knowledgeIds);
    const known = new Map(rows.map((k) => [k.id, k]));
    for (const task of a.evalTasks) {
      for (const id of task.criteria) {
        const k = known.get(id);
        if (!k) throw new Refusal(`試しに動かして採点する試験の課題の合格の条件にした仕事のやり方や決まり ${id} が、示す一覧（knowledgeIds）にありません。`);
        if (k.kind !== 'criterion') throw new Refusal(`仕事のやり方や決まり ${id} は種類が「合否の決め方」ではないので、試しに動かして採点する試験の課題の合格の条件にできません。`);
      }
    }
    // 決まったナレッジは、すべて示す（画面の「決まったこと」の一覧と、生成前の確認の一覧を、同じにする。REQ-043）
    const omitted = hearing.state.knowledge.filter((k) => k.status === 'decided' && !known.has(k.id)).map((k) => k.id);
    if (omitted.length) {
      throw new Refusal(`決まった仕事のやり方や決まりのすべてを、示す一覧（knowledgeIds）に入れてください。入っていないもの：${omitted.join('、')}`);
    }
    // 示す案の中身の印。見本を作る前に取る（見本を作る間に案が変わっても、変わった側に倒れて、示し直しを求める）。生成に進めるときに、今の中身と比べる
    const taskHash = taskFileHash(normalized);
    const prepared = await prepareSample({ taskPath: normalized, knowledgeRows: rows, evalTasks: a.evalTasks });
    hearing.commitConfirmation({ ...a, taskPath: normalized, taskHash, settingLabels: prepared.settingLabels });
    return `作る前の確認で示すものを受け付けました。画面で見られます。作業の画面の見本：${prepared.url}`;
  }

  /** 止まっている見本を作り直す。再開（--continue）のあと、生成前の確認が残っているときのため。失敗しても黙る */
  async function restoreSample() {
    const c = hearing.state?.confirmation;
    if (!c || sample.url || !hearing.active) return; // 生成に進んだ後は、作業の定義の案が消えている（組み立てのスクリプトが消す）ので、作り直さない
    try {
      const rows = hearing.knowledgeByIds(c.knowledgeIds);
      await prepareSample({ taskPath: c.taskPath, knowledgeRows: rows });
    } catch (error) {
      warn(`作業の画面の見本を作り直せませんでした：${errorMessage(error)}`);
    }
  }

  // ---- ツール --------------------------------------------------------------------------------------

  // 状態を変えるツールは、順に1つずつ動かす（確認の途中で、別の記録が割り込まないように）
  let queue = Promise.resolve();
  const serialize = (fn) => (...args) => {
    const run = queue.then(() => fn(...args));
    queue = run.catch(() => {});
    return run;
  };

  const handlers = {
    async open() {
      let url;
      try {
        url = await screen.ensure();
      } catch (error) {
        throw new Refusal(`plugin-creator の画面を起動できません：${errorMessage(error)}`);
      }
      try {
        hearing.setUrl(url);
      } catch (error) {
        warn(`画面の URL を記録できませんでした：${errorMessage(error)}`);
      }
      return `plugin-creator の画面の用意ができました。次の URL をブラウザーで開いてください：${url}`;
    },

    async state(args) {
      const include = args?.include;
      if (include !== undefined && !STATE_INCLUDES.includes(include)) {
        throw new Refusal(`include の値が違います：「${String(include)}」。使える値：${STATE_INCLUDES.join('、')}`);
      }
      const before = hearing.state?.url ?? null;
      let url = null;
      let problem = '';
      try {
        url = await screen.ensure(); // 止まっていれば起動し直す
      } catch (error) {
        problem = `画面を起動できませんでした：${errorMessage(error)}`;
      }
      if (url) {
        try {
          hearing.setUrl(url);
        } catch (error) {
          warn(`画面の URL を記録できませんでした：${errorMessage(error)}`);
        }
        await restoreSample();
      }
      let out = stateText(hearing, { url, sessionId, statePath: store.statePath, qaPath: store.qaPath, readQa: () => store.readQa() }, include);
      if (problem) out += `\n${problem}`;
      if (url && before && before !== url) out += '\n画面の URL が前と変わりました。チャットでユーザーに示してください。';
      return out;
    },

    progress: serialize(async (args) => hearing.applyProgress(args)),

    record: serialize(async (args) => hearing.applyRecord(args)),

    confirm: serialize((args) => confirm(args)),

    async results(args) {
      const list = args?.paths;
      if (!Array.isArray(list) || list.length === 0) throw new Refusal('結果のファイルの場所の一覧（paths）を渡してください。');
      const files = list.map((p) => path.resolve(workDir, String(p)));
      const problems = files.map(checkResultFile).filter(Boolean);
      if (problems.length) throw new Refusal(problems.join('\n'));
      const merged = [...store.readResults().filter((p) => !files.includes(p)), ...new Set(files)].slice(-MAX_RESULT_FILES);
      store.writeResults(merged);
      return `試験の結果${files.length}件を、plugin-creator の画面に出します。`;
    },

    async doc_text(args) {
      if (typeof args?.path !== 'string' || args.path.trim() === '') throw new Refusal('文書の場所（path）を渡してください。');
      const file = path.resolve(workDir, args.path);
      const doc = documentText(file);
      const total = `${doc.totalChars}文字${doc.atLeast ? '以上' : ''}`;
      const head = `ファイル：${path.basename(file)}（${doc.format}、全体で${total}）`;
      const tail = doc.truncated ? `\n\n（長いため、先頭の${[...doc.text].length}文字で切りました。全体は${total}です。残りは読めません）` : '';
      return `${head}\n\n${doc.text}${tail}`;
    },

    async issue(args) {
      return fileIssue({ title: args?.title, body: args?.body }, { run: runGh });
    },
  };

  /**
   * ツールの処理を包む。断るときも、失敗したときも、例外を投げず、理由の文を結果として返す。
   * Copilot CLI 1.0.102 は、処理が例外を投げると、モデルに「Tool execution failed」だけを返し、理由の文を捨てる（V1 不具合 2）。
   * `{ textResultForLlm, resultType: 'failure' }` なら、理由の文がそのままモデルに届く（`rejected` は手番が止まるので使わない）。
   */
  const guard = (handler) => async (args, invocation) => {
    try {
      return await handler(args ?? {}, invocation);
    } catch (error) {
      if (error instanceof Refusal || error instanceof IssueError || error instanceof DocTextError || error?.name === 'RecordUnreadable') {
        return failure(error.message);
      }
      // 想定外の失敗：内部の情報とスタックは返さず（標準エラー＝エクステンションのログに残す）、平易な文だけ返す
      warn(`${error?.stack ?? error}`);
      return failure(UNEXPECTED_FAILURE);
    }
  };

  const tools = TOOL_DEFS.map((def) => ({
    name: def.fullName,
    description: def.description,
    parameters: def.parameters,
    ...(def.skipPermission ? { skipPermission: true } : {}),
    defer: 'never', // ツール検索の裏に回さない（状態取得ツールの説明がモデルに見えなくなるのを避ける。hearing.md 14章 H4）
    handler: guard(handlers[def.name]),
  }));

  return {
    tools,
    hooks,
    onSessionEvent,
    hearing,
    store,
    screen,
    sample,
    handlers,
    get cwd() {
      return workDir;
    },
    setCwd(next) {
      if (typeof next === 'string' && next) workDir = next;
    },
    /** joinSession の返り値（セッション）につなぐ。コンパクションのイベントを受け、作業フォルダを知る */
    async attach(session) {
      session.on('session.compaction_complete', onSessionEvent);
      try {
        const info = await session.rpc?.workspaces?.getWorkspace?.();
        if (info?.workspace?.cwd) workDir = info.workspace.cwd;
      } catch {
        // 分からなければ、起動したときの作業フォルダのまま
      }
    },
    async shutdown() {
      await Promise.allSettled([screen.close(), sample.close()]);
    },
  };
}

/**
 * エクステンションを始める。extension.mjs から呼ぶ。
 * @param {object} options
 * @param {Function} options.joinSession @github/copilot-sdk/extension の joinSession
 */
export async function startCreator({ joinSession, env = process.env, cwd = process.cwd(), ...rest }) {
  const creator = createCreator({ sessionId: env.SESSION_ID, home: copilotHome(env), cwd, ...rest });
  // 確認を省くツールとフックを登録するので、Copilot CLI は読み込みのときに確認を出す（generated-plugin-structure.md 4.1）
  // 許可の求めには答えない（onPermissionRequest は登録しない。creator-structure.md 4.5）
  const session = await joinSession({ tools: creator.tools, hooks: creator.hooks });
  await creator.attach(session);
  return creator;
}
