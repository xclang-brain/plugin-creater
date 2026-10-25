// 偽物の窓口（BLUEPRINT 3.2）。中心の処理（core）の port に差し替えて、試験で使う。
// 呼ばれた順と引数を calls に記録し、返す値と遅れと失敗を試験から決められる。
//
//   const port = createFakePort({ clock });
//   port.behave('startAgent', { delay: 15_000 });        // 15 秒かかる（時計を進めると返る）
//   port.behave('cancelAgent', { hang: true });          // 返らない
//   port.behave('listTasks', { error: new Error('x') }); // 失敗する
//   port.behave('listTasks', { value: () => [...] });    // 返す値を決める
//   port.behave('listTasks', { delay: 2000, times: 1 }); // 最初の 1 回だけ
//   port.reset('listTasks');                             // 元に戻す
//   port.stubborn.add(agentId);                          // 取り消しても止まらないエージェント
//   port.spawn({ agentId, parentAgentId, agentType });   // 木の下のエージェントが動いている状態にする
//   createFakePort({ clock, idPrefix: 'b-' })            // 統括の番号に頭を付ける（窓口を 2 つ使う試験で番号を分ける）
//
// 既定の動き（本物の Copilot CLI で確かめた形。設計書 11章 #4・#6）：
//   startAgent は番号を返し、一覧に running で載る。
//   cancelAgent は、そのエージェントと下のエージェントを一覧で cancelled にする。
//   sendMessage は、一覧で idle か running のエージェントなら running にして { sent: true } を返す。ほかは
//   { sent: false, error: 'Agent not found or not accepting messages' }（例外にしない。設計書 11章 #19）。
//   setSubagentSettings(map) は overrides に覚え、null で外す。

export function createFakePort({ clock, idPrefix = '' } = {}) {
  const calls = [];
  const behaviors = {};
  const logs = [];
  let seq = 0;

  const port = {
    calls,
    logs,
    tasks: [], // 一覧に載るエージェント { agentId, displayName, status, executionMode, agentType, parentAgentId }
    stubborn: new Set(),
    overrides: null,
    currentModel: { model: 'claude-opus-5-5', isAuto: false },
    models: [
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
      { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
      { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
    ],

    behave(method, behavior) {
      behaviors[method] = behavior;
    },
    reset(method) {
      delete behaviors[method];
    },
    callsOf(method) {
      return calls.filter((c) => c.method === method);
    },
    argsOf(method) {
      return calls.filter((c) => c.method === method).map((c) => c.args[0]);
    },
    task(agentId) {
      return port.tasks.find((t) => t.agentId === agentId);
    },
    spawn({ agentId, parentAgentId, agentType, status = 'running', executionMode = 'sync', displayName = '' }) {
      const t = { agentId, displayName, status, executionMode, agentType, parentAgentId };
      port.tasks.push(t);
      return t;
    },
    setStatus(agentId, status) {
      const t = port.task(agentId);
      if (t) t.status = status;
    },
  };

  function descendantsOf(id) {
    const out = [id];
    for (const t of port.tasks) if (t.parentAgentId === id) out.push(...descendantsOf(t.agentId));
    return out;
  }

  // 呼び出しを記録して、決めた動き（遅れ・失敗・返らない）で返す
  function invoke(method, args, produce) {
    calls.push({ method, args, at: clock ? clock.now() : 0 });
    const b = behaviors[method] ?? {};
    if (b.times !== undefined) {
      b.times -= 1;
      if (b.times <= 0) delete behaviors[method];
    }
    return new Promise((resolve, reject) => {
      if (b.hang) return;
      const finish = () => {
        if (b.error) reject(b.error instanceof Error ? b.error : new Error(String(b.error)));
        else if (typeof b.value === 'function') resolve(b.value(...args));
        else if (b.value !== undefined) resolve(b.value);
        else resolve(produce());
      };
      if (b.delay) clock.setTimeout(finish, b.delay);
      else finish();
    });
  }

  port.startAgent = (args) =>
    invoke('startAgent', [args], () => {
      seq += 1;
      const agentId = `${idPrefix}orch-${seq}`;
      port.tasks.push({
        agentId,
        displayName: args.name,
        status: 'running',
        executionMode: 'background',
        agentType: args.agentType,
        parentAgentId: undefined,
      });
      return { agentId };
    });
  port.cancelAgent = (agentId) =>
    invoke('cancelAgent', [agentId], () => {
      if (!port.stubborn.has(agentId)) {
        for (const id of descendantsOf(agentId)) {
          const t = port.task(id);
          if (t && !port.stubborn.has(id) && (t.status === 'running' || t.status === 'idle')) t.status = 'cancelled';
        }
      }
    });
  port.sendMessage = (agentId, message) =>
    invoke('sendMessage', [agentId, message], () => {
      const t = port.task(agentId);
      if (!t || (t.status !== 'idle' && t.status !== 'running')) return { sent: false, error: 'Agent not found or not accepting messages' };
      t.status = 'running';
      return { sent: true };
    });
  port.listTasks = () => invoke('listTasks', [], () => port.tasks.map((t) => ({ ...t })));
  port.setSubagentSettings = (map) =>
    invoke('setSubagentSettings', [map], () => {
      port.overrides = map;
    });
  port.getCurrentModel = () => invoke('getCurrentModel', [], () => ({ ...port.currentModel }));
  port.listModels = () => invoke('listModels', [], () => port.models.map((m) => (m && typeof m === 'object' ? { ...m } : m)));
  port.log = (text) =>
    invoke('log', [text], () => {
      logs.push(text);
    });

  return port;
}
