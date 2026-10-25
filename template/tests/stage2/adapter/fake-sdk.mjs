// 偽物の Copilot SDK。joinSession と、それが返すセッションの代わりをする。つなぎ口（adapter.mjs）の試験で使う。
// 本物の SDK 1.0.25 の動き（dist/session.js の _executeToolAndRespond、_handleHooksInvoke、_dispatchEvent、
// _handleBroadcastEvent）に合わせてある。Copilot CLI がなくても、つなぎ口を動かせる。
//
//   const fake = createFakeSdk({ cwd, sessionId });
//   await startAdapter({ joinSession: fake.joinSession });
//   fake.config                          joinSession に渡された設定 { tools, hooks, onPermissionRequest }
//   fake.calls                           rpc と log の呼び出しの記録 [{ method, args }]（callsOf(method) で絞る）
//   fake.behave('tasks.startAgent', { error })   呼び出しを失敗させる（tasks.sendMessage も同じ）
//   fake.behave('model.list', { value: ... })    返す値を決める（関数でもよい）
//   fake.behave('workspaces.getWorkspace', { gate })   gate（Promise）が解けるまで、呼び出しを返さない
//   fake.tasks                           tasks.list に載るタスク（spawn で足す）
//   fake.emit(event)                     イベントを流す（permission.requested は、本物と同じく許可の求めの受け口にも届く）
//   fake.callTool(name, args, { agentId })       ツールの呼び出し。{ ok, text }、失敗の結果は { ok: false, error: 理由の文, resultType, raw }。例外を投げたら { ok: false, thrown: true, error }
//   fake.callHook('onPreToolUse', input)         フックの呼び出し。例外は undefined になる（本物と同じく、拒まずに進む）
//   fake.answers                         本物の SDK が Copilot CLI に返す、許可の求めへの答え（答えない no-result は入らない）

let eventSeq = 0;

/** SDK の形のイベント（session-events.d.ts）を作る。 */
export function makeEvent(type, data = {}, { agentId, timestamp } = {}) {
  eventSeq += 1;
  return {
    id: `ev-${eventSeq}`,
    timestamp: timestamp ?? new Date(Date.UTC(2026, 9, 22, 3, 0, 0) + eventSeq * 1000).toISOString(),
    parentId: null,
    ...(agentId === undefined ? {} : { agentId }),
    type,
    data,
  };
}

/** よく使うイベントの作り方。 */
export const sdkEvent = {
  subagentStarted: (agentId, data = {}, options = {}) =>
    makeEvent('subagent.started', { agentName: 'x', agentDisplayName: 'x', agentDescription: '', toolCallId: `tc-${agentId}`, ...data }, { agentId, ...options }),
  subagentConfigured: (agentId, data = {}) => makeEvent('subagent.configured', { model: 'm', multiTurn: true, ...data }, { agentId }),
  subagentCompleted: (agentId, data = {}) =>
    makeEvent('subagent.completed', { agentName: 'x', agentDisplayName: 'x', toolCallId: `tc-${agentId}`, ...data }, { agentId }),
  subagentFailed: (agentId, data = {}) =>
    makeEvent('subagent.failed', { agentName: 'x', agentDisplayName: 'x', toolCallId: `tc-${agentId}`, error: '失敗', ...data }, { agentId }),
  agentIdle: (agentId, data = {}) =>
    makeEvent('system.notification', { content: '手番を終えました', kind: { type: 'agent_idle', agentId, agentType: 'x', ...data } }),
  toolStart: (agentId, toolCallId, toolName, args) =>
    makeEvent('tool.execution_start', { toolCallId, toolName, ...(args === undefined ? {} : { arguments: args }) }, { agentId }),
  toolComplete: (agentId, toolCallId, data = {}) => makeEvent('tool.execution_complete', { toolCallId, success: true, ...data }, { agentId }),
  permissionRequested: (agentId, requestId, permissionRequest, data = {}) =>
    makeEvent('permission.requested', { requestId, permissionRequest, ...data }, { agentId }),
  permissionCompleted: (requestId, data = {}) => makeEvent('permission.completed', { requestId, result: { kind: 'approved' }, ...data }),
  userInputRequested: (agentId, requestId, question) => makeEvent('user_input.requested', { requestId, question }, { agentId }),
  userInputCompleted: (requestId, data = {}) => makeEvent('user_input.completed', { requestId, answer: 'はい', ...data }),
  limitRequested: (requestId, data = {}) => makeEvent('session_limits_exhausted.requested', { requestId, maxAiCredits: 10, usedAiCredits: 10, ...data }),
  limitCompleted: (requestId, action = 'cancel') => makeEvent('session_limits_exhausted.completed', { requestId, response: { action } }),
};

export function createFakeSdk({ sessionId = 'session-fake-1', cwd = process.cwd() } = {}) {
  const calls = [];
  const behaviors = {};
  const handlers = new Set();
  const parents = new Map(); // タスクの番号 → 親の番号（本物の tasks.list には親の番号がない。取り消しが下に及ぶ動きを作るために持つ）
  const answers = [];
  let seq = 0;

  const fake = {
    sessionId,
    cwd,
    config: null,
    joinCount: 0,
    calls,
    answers,
    tasks: [],
    overrides: undefined, // updateSubagentSettings で置かれた subagents（undefined は呼ばれていない、null は外された）
    currentModel: { modelId: 'claude-opus-5-5' },
    models: [
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
      { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
      { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
    ],
    workspace: undefined, // undefined なら { workspace: { id, cwd } }。null や関数で変えられる

    behave(method, behavior) {
      behaviors[method] = behavior;
    },
    reset(method) {
      delete behaviors[method];
    },
    callsOf(method) {
      return calls.filter((c) => c.method === method);
    },

    /** tasks.list に載るエージェントを足す。parentAgentId は、取り消しが下に及ぶ動きのためだけに覚える。 */
    spawn({ agentId, parentAgentId, agentType = 'x', status = 'running', executionMode = 'sync', displayName = '', extra = {} }) {
      const task = {
        type: 'agent',
        id: agentId,
        toolCallId: `tc-${agentId}`,
        displayName,
        description: '',
        status,
        startedAt: new Date(0).toISOString(),
        agentType,
        prompt: '',
        executionMode,
        ...extra,
      };
      fake.tasks.push(task);
      if (parentAgentId) parents.set(agentId, parentAgentId);
      return task;
    },
    task(agentId) {
      return fake.tasks.find((t) => t.id === agentId);
    },

    /** イベントを流す。本物の _dispatchEvent と同じく、許可の求めは先に受け口へ、その後に session.on の受け取りへ。 */
    emit(event) {
      broadcast(event);
      for (const handler of [...handlers]) {
        try {
          handler(event);
        } catch {
          // 本物の SDK も、受け取りの例外は飲み込む
        }
      }
    },

    async callTool(name, args = {}, { agentId, toolCallId = `tc-call-${(seq += 1)}` } = {}) {
      const tool = fake.config.tools.find((t) => t.name === name);
      if (!tool) throw new Error(`ツール ${name} は登録されていません`);
      try {
        const raw = await tool.handler(args, { sessionId, toolCallId, toolName: name, arguments: args, agentId });
        // 本物の SDK（isToolResultObject）：textResultForLlm と resultType があるオブジェクトは、そのまま結果になる
        if (raw !== null && typeof raw === 'object' && typeof raw.textResultForLlm === 'string' && typeof raw.resultType === 'string') {
          const failed = raw.resultType !== 'success';
          return { ok: !failed, text: raw.textResultForLlm, resultType: raw.resultType, raw, ...(failed ? { error: raw.textResultForLlm } : {}) };
        }
        return { ok: true, text: raw == null ? '' : typeof raw === 'string' ? raw : JSON.stringify(raw) };
      } catch (error) {
        // 例外の文は、本物の SDK は error として Copilot CLI に渡すが、Copilot CLI 1.0.102 はモデルに文を届けない（V1 の不具合 2）。
        // つなぎ口は例外を投げない作りなので、ここに来るのは作りの誤り。試験で見つけられるよう、エラーの印をつける。
        return { ok: false, thrown: true, error: error instanceof Error ? error.message : String(error) };
      }
    },

    async callHook(type, input = {}) {
      const handler = fake.config.hooks?.[type];
      if (!handler) return undefined;
      try {
        return await handler({ sessionId, timestamp: new Date(), workingDirectory: cwd, ...input }, { sessionId });
      } catch {
        return undefined;
      }
    },

    async joinSession(config) {
      fake.config = config;
      fake.joinCount += 1;
      if (behaviors.joinSession?.error) throw behaviors.joinSession.error;
      return session;
    },
  };
  fake.joinSession = fake.joinSession.bind(fake);

  // 本物の _handleBroadcastEvent：許可の求めは、受け口があれば呼ぶ。no-result は答えない。例外のときは user-not-available で答えてしまう。
  function broadcast(event) {
    if (event.type !== 'permission.requested' || !fake.config?.onPermissionRequest) return;
    if (event.data?.resolvedByHook) return;
    void (async () => {
      try {
        const result = await fake.config.onPermissionRequest(event.data.permissionRequest, {
          sessionId,
          managedSettingsEnabled: false,
          ...(event.data.promptRequest === undefined ? {} : { promptRequest: event.data.promptRequest }),
        });
        if (result.kind !== 'no-result') answers.push({ requestId: event.data.requestId, result });
      } catch {
        answers.push({ requestId: event.data.requestId, result: { kind: 'user-not-available' } });
      }
    })();
  }

  // 呼び出しを記録して、決めた動き（失敗・返す値）で返す
  function invoke(method, args, produce) {
    calls.push({ method, args });
    const behavior = behaviors[method] ?? {};
    return new Promise((resolve, reject) => {
      const settle = () => {
        if (behavior.error) return reject(behavior.error);
        try {
          if (behavior.value !== undefined) resolve(typeof behavior.value === 'function' ? behavior.value(args) : behavior.value);
          else resolve(produce());
        } catch (error) {
          reject(error);
        }
      };
      if (behavior.gate) behavior.gate.then(settle, reject);
      else settle();
    });
  }

  function descendantsOf(id) {
    const out = [id];
    for (const [child, parent] of parents) if (parent === id) out.push(...descendantsOf(child));
    return out;
  }

  const rpc = {
    tasks: {
      startAgent: (args) =>
        invoke('tasks.startAgent', args, () => {
          seq += 1;
          const agentId = `ag-root-${seq}`;
          fake.spawn({ agentId, agentType: args.agentType, displayName: args.name, executionMode: 'background', extra: { prompt: args.prompt, model: args.model } });
          return { agentId };
        }),
      cancel: (args) =>
        invoke('tasks.cancel', args, () => {
          const target = fake.task(args.id);
          if (!target || ['completed', 'failed', 'cancelled'].includes(target.status)) return { cancelled: false };
          for (const id of descendantsOf(args.id)) {
            const t = fake.task(id);
            if (t && !['completed', 'failed'].includes(t.status)) t.status = 'cancelled';
          }
          return { cancelled: true };
        }),
      list: () => invoke('tasks.list', undefined, () => ({ tasks: fake.tasks.map((t) => ({ ...t })) })),
      // 本物（Copilot CLI 1.0.102・1.0.103 で確かめた。設計書 11章 #19）：待ち（idle）のエージェントは動き出して { sent: true }。
      // ない番号や取り消したエージェントには、例外ではなく { sent: false, error } が返る
      sendMessage: (args) =>
        invoke('tasks.sendMessage', args, () => {
          const target = fake.task(args.id);
          if (!target || !['idle', 'running'].includes(target.status)) return { sent: false, error: 'Agent not found or not accepting messages' };
          target.status = 'running';
          return { sent: true };
        }),
    },
    tools: {
      updateSubagentSettings: (args) =>
        invoke('tools.updateSubagentSettings', args, () => {
          fake.overrides = args.subagents;
          return {};
        }),
    },
    model: {
      getCurrent: () => invoke('model.getCurrent', undefined, () => ({ ...fake.currentModel })),
      list: () => invoke('model.list', undefined, () => ({ list: fake.models.map((m) => (typeof m === 'object' && m !== null ? { ...m } : m)) })),
    },
    workspaces: {
      getWorkspace: () =>
        invoke('workspaces.getWorkspace', undefined, () => {
          if (typeof fake.workspace === 'function') return fake.workspace();
          if (fake.workspace !== undefined) return fake.workspace;
          return { workspace: { id: 'ws-1', cwd } };
        }),
    },
  };

  const session = {
    sessionId,
    rpc,
    log: (message, options) => invoke('session.log', { message, options }, () => undefined),
    on(first, second) {
      const handler = typeof first === 'function' ? first : (event) => event.type === first && second(event);
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  fake.session = session;
  fake.handlerCount = () => handlers.size;
  fake.listeners = () => [...handlers]; // session.on で登録された受け口。試験が直接呼ぶ（例外を飲み込まない）

  return fake;
}
