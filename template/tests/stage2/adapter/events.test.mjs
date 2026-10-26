// 2段目 部品の試験（つなぎ口）：イベントの直し方。
// Copilot CLI のイベント（偽物の SDK から流す）が、中立のイベント（BLUEPRINT 3.1）に直されて中心の処理（core.onEvent）に届くかを確かめる。
// 中心の処理の onEvent を、届いたものを記録するだけの関数に差し替えて見る。
// 設計書：generated-plugin-structure.md 3.2、4.5、4.8、4.14、6.1、10章。
// 実行：node --test "tests/stage2/adapter/*.test.mjs"
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { PLUGIN, cleanupAll, prepareStart, sdkEvent, startPlugin } from './harness.mjs';

after(cleanupAll);

// 中心の処理に届いた中立のイベントを記録する（JSON にして、undefined の項目を除く。記録のファイルに書かれる形と同じ）
async function spy(options) {
  const p = await startPlugin(options);
  const seen = [];
  p.core.onEvent = (e) => seen.push(JSON.parse(JSON.stringify(e)));
  return { p, seen };
}
const withoutTime = (events) => events.map(({ at, ...rest }) => rest);
const T = (seconds) => Date.UTC(2026, 9, 22, 3, 0, seconds);
const iso = (seconds) => new Date(T(seconds)).toISOString();

describe('エージェントのイベント（REQ-008）', () => {
  test('REQ-008 subagent.started は agent.started になる。親の番号は data.parentId から、時刻はイベントの時刻から取る', async () => {
    const { p, seen } = await spy();
    const event = sdkEvent.subagentStarted(
      'ag-1',
      { agentName: 'worker', agentType: 'worker', agentDisplayName: '週報の下書きを書く', agentDescription: '作業エージェントの定義の説明', model: 'claude-opus-5-5', executionMode: 'sync', parentId: 'ag-0' },
      { timestamp: iso(5) },
    );
    event.parentId = 'ev-1つ前のイベント'; // イベントの鎖の1つ前。親のエージェントではない
    p.fake.emit(event);
    assert.deepEqual(seen, [
      {
        type: 'agent.started',
        at: T(5),
        agentId: 'ag-1',
        parentAgentId: 'ag-0',
        agentType: `${PLUGIN}:worker`,
        model: 'claude-opus-5-5',
        executionMode: 'sync',
        description: '週報の下書きを書く',
      },
    ]);
  });

  test('REQ-008 「担当」は、統括が task を呼んだときの説明（引数の description）を、toolCallId で結んで使う。使ったら覚えを消す', async () => {
    const { p, seen } = await spy();
    const task = (agentId, toolCallId, description, toolName = 'task') => p.fake.emit(sdkEvent.toolStart(agentId, toolCallId, toolName, { description, agent_type: 'worker', prompt: '頼む' }));
    const started = (agentId, toolCallId, data = {}) => p.fake.emit(sdkEvent.subagentStarted(agentId, { agentType: 'worker', agentDisplayName: 'worker', toolCallId, parentId: 'ag-0', ...data }));
    task('ag-0', 'tc-a', '先週の記録を3行にまとめる');
    task('ag-0', 'tc-b', '来週の予定を書く');
    started('ag-1', 'tc-b'); // 開始の順は、呼んだ順でなくてよい。toolCallId で結ぶ
    started('ag-2', 'tc-a');
    started('ag-3', 'tc-a'); // 使った覚えは消える。同じ番号がもう一度来ても、今までどおり agentDisplayName
    assert.deepEqual(
      seen.filter((e) => e.type === 'agent.started').map((e) => [e.agentId, e.description]),
      [
        ['ag-1', '来週の予定を書く'],
        ['ag-2', '先週の記録を3行にまとめる'],
        ['ag-3', 'worker'],
      ],
    );
  });

  test('REQ-008 task の説明が見つからないときは、agentDisplayName、なければエージェントの定義の説明を使う。task 以外のツールの description は使わない。親のない統括には付けない', async () => {
    const { p, seen } = await spy();
    p.fake.emit(sdkEvent.toolStart('ag-0', 'tc-bash', 'bash', { description: 'シェルの説明' })); // task ではない
    p.fake.emit(sdkEvent.toolStart('ag-0', 'tc-blank', 'task', { description: '   ' })); // 空の説明は使わない
    p.fake.emit(sdkEvent.toolStart('ag-0', 'tc-none', 'task', { prompt: '説明なし' }));
    p.fake.emit(sdkEvent.toolStart('ag-0', 'tc-text', 'task', 'これは文字列の引数')); // 形が違う
    const started = (agentId, data) => p.fake.emit(sdkEvent.subagentStarted(agentId, { agentType: 'worker', parentId: 'ag-0', ...data }));
    started('ag-1', { toolCallId: 'tc-bash', agentDisplayName: '表示名', agentDescription: '定義の説明' });
    started('ag-2', { toolCallId: 'tc-blank', agentDisplayName: '  ', agentDescription: '定義の説明' });
    started('ag-3', { toolCallId: 'tc-none', agentDisplayName: undefined, agentDescription: '定義の説明' });
    started('ag-4', { toolCallId: 'tc-text', agentDisplayName: undefined, agentDescription: undefined });
    started('ag-5', { toolCallId: 'tc-unknown', agentDisplayName: undefined, agentDescription: undefined });
    p.fake.emit(sdkEvent.toolStart('ag-0', 'tc-root', 'task', { description: '統括の説明' }));
    p.fake.emit(sdkEvent.subagentStarted('ag-6', { agentType: 'orchestrator', toolCallId: 'tc-root', agentDisplayName: '統括 20261022-abc', agentDescription: '定義の説明' })); // 親がない（tasks.startAgent で起動した統括）
    assert.deepEqual(
      seen.filter((e) => e.type === 'agent.started').map((e) => e.description),
      ['表示名', '定義の説明', '定義の説明', undefined, undefined, undefined],
    );
  });

  test('REQ-008 task の呼び出しが終わったら（サブエージェントが始まらなかった場合も）、覚えを消す', async () => {
    const { p, seen } = await spy();
    p.fake.emit(sdkEvent.toolStart('ag-0', 'tc-a', 'task', { description: '消える説明' }));
    p.fake.emit(sdkEvent.toolComplete('ag-0', 'tc-a'));
    p.fake.emit(sdkEvent.subagentStarted('ag-1', { agentType: 'worker', agentDisplayName: 'worker', toolCallId: 'tc-a', parentId: 'ag-0' }));
    assert.equal(seen.find((e) => e.type === 'agent.started').description, 'worker');
  });

  test('REQ-008 agentType は <プラグイン>:<エージェント> の形にそろえる（このプラグインのエージェントだけ。ほかはそのまま）', async () => {
    const { p, seen } = await spy();
    const cases = [
      [{ agentType: `${PLUGIN}:worker` }, `${PLUGIN}:worker`],
      [{ agentType: 'worker' }, `${PLUGIN}:worker`],
      [{ agentType: 'verifier' }, `${PLUGIN}:verifier`],
      [{ agentType: 'orchestrator' }, `${PLUGIN}:orchestrator`],
      [{ agentType: 'explore' }, 'explore'],
      [{ agentType: 'other-plugin:worker' }, 'other-plugin:worker'],
      [{ agentType: 'general-purpose', agentName: 'verifier' }, `${PLUGIN}:verifier`],
      [{ agentType: undefined, agentName: `${PLUGIN}:orchestrator` }, `${PLUGIN}:orchestrator`],
      [{ agentType: undefined, agentName: 'orchestrator' }, `${PLUGIN}:orchestrator`],
      [{ agentType: undefined, agentName: undefined }, ''],
    ];
    cases.forEach(([data], i) => p.fake.emit(sdkEvent.subagentStarted(`ag-${i}`, data)));
    assert.deepEqual(
      seen.map((e) => e.agentType ?? ''),
      cases.map(([, expected]) => expected),
    );
  });

  test('REQ-008 2体目以降の作業エージェント（worker-<名前>）の名前も、プラグインの名前つきにそろえる', async () => {
    const prepared = await prepareStart();
    writeFileSync(join(prepared.plugin.root, 'com.github.copilot', 'agents', 'worker-b.agent.md'), '---\nname: worker-b\n---\n試験用です。\n');
    const p = prepared.finish(await prepared.launch());
    const seen = [];
    p.core.onEvent = (e) => seen.push(e.agentType);
    p.fake.emit(sdkEvent.subagentStarted('ag-1', { agentType: 'worker-b' }));
    p.fake.emit(sdkEvent.subagentStarted('ag-2', { agentType: 'worker-c' }));
    assert.deepEqual(seen, [`${PLUGIN}:worker-b`, 'worker-c']);
  });

  test('REQ-008 subagent.configured は agent.configured に、subagent.failed は agent.failed になる', async () => {
    const { p, seen } = await spy();
    p.fake.emit(sdkEvent.subagentConfigured('ag-1', { model: 'gpt-6-luna' }));
    p.fake.emit(sdkEvent.subagentFailed('ag-1', { error: 'モデルが使えません' }));
    assert.deepEqual(withoutTime(seen), [
      { type: 'agent.configured', agentId: 'ag-1', model: 'gpt-6-luna' },
      { type: 'agent.failed', agentId: 'ag-1', error: 'モデルが使えません' },
    ]);
  });

  test('REQ-008 subagent.completed は agent.completed になる。取り消されたか（cancelled）と、フックで届いた最後の返事がつく', async () => {
    const { p, seen } = await spy();
    await p.fake.callHook('onSubagentStop', { agentId: 'ag-1', agentType: `${PLUGIN}:worker`, agentName: 'worker', stopReason: 'end_turn', response: '最後の返事です。\n2行目です。' });
    p.fake.emit(sdkEvent.subagentCompleted('ag-1', { cancelled: false }));
    p.fake.emit(sdkEvent.subagentCompleted('ag-1', { cancelled: true })); // 返事は1回だけ使う
    p.fake.emit(sdkEvent.subagentCompleted('ag-2')); // フックが届かなかったエージェント。返事はつかない
    assert.deepEqual(withoutTime(seen), [
      { type: 'agent.completed', agentId: 'ag-1', cancelled: false, response: '最後の返事です。\n2行目です。' },
      { type: 'agent.completed', agentId: 'ag-1', cancelled: true },
      { type: 'agent.completed', agentId: 'ag-2', cancelled: false },
    ]);
  });

  test('REQ-008 手番を終えて待ちに入った知らせ（system.notification の agent_idle）は agent.idle になる。ほかの知らせは渡さない', async () => {
    const { p, seen } = await spy();
    p.fake.emit(sdkEvent.agentIdle('ag-1'));
    p.fake.emit(sdkEvent.agentIdle('ag-2')); // 知らせそのものにエージェントの番号はない。kind.agentId を使う
    p.fake.emit({ id: 'e', timestamp: iso(1), parentId: null, type: 'system.notification', data: { content: '完了', kind: { type: 'agent_completed', agentId: 'ag-3', status: 'completed' } } });
    p.fake.emit({ id: 'e', timestamp: iso(1), parentId: null, type: 'system.notification', data: { content: '？', kind: { type: 'unclassified' } } });
    assert.deepEqual(withoutTime(seen), [
      { type: 'agent.idle', agentId: 'ag-1' },
      { type: 'agent.idle', agentId: 'ag-2' },
    ]);
  });

  test('REQ-051 2回目からの手番の終わり（agent_idle だけが出る）にも、フックで届いた最後の返事がつく。返事は 1 回だけ使う', async () => {
    const { p, seen } = await spy();
    // 初めの手番：返事は completed につき、続く idle にはつかない
    await p.fake.callHook('onSubagentStop', { agentId: 'ag-root', stopReason: 'end_turn', response: '人の判断待ち\n質問です' });
    p.fake.emit(sdkEvent.subagentCompleted('ag-root'));
    p.fake.emit(sdkEvent.agentIdle('ag-root'));
    // 2回目からの手番：subagent.completed は出ず、idle だけが出る（Copilot CLI 1.0.102・1.0.103。設計書 11章 #19）
    await p.fake.callHook('onSubagentStop', { agentId: 'ag-root', stopReason: 'end_turn', response: '続けて終わりました' });
    p.fake.emit(sdkEvent.agentIdle('ag-root'));
    assert.deepEqual(withoutTime(seen), [
      { type: 'agent.completed', agentId: 'ag-root', cancelled: false, response: '人の判断待ち\n質問です' },
      { type: 'agent.idle', agentId: 'ag-root' },
      { type: 'agent.idle', agentId: 'ag-root', response: '続けて終わりました' },
    ]);
  });

  test('REQ-008 子のエージェントの終わりのフック（onSubagentStop）は何も返さない（返すと子の動きを変えてしまう）', async () => {
    const p = await startPlugin();
    for (const input of [
      { agentId: 'ag-1', response: '返事' },
      { agentId: 'ag-1' },
      { response: '番号のない返事' },
      {},
      null,
      undefined,
    ]) {
      assert.equal(p.fake.config.hooks.onSubagentStop(input), undefined);
    }
  });
});

describe('ツールのイベント（REQ-013、REQ-008）', () => {
  test('REQ-013 tool.execution_start は tool.started になる。同じ呼び出しの繰り返しを見つけるため、引数もつける', async () => {
    const { p, seen } = await spy();
    p.fake.emit(sdkEvent.toolStart('ag-1', 'tc-1', 'edit', { path: 'a.md', text: '本文' }));
    p.fake.emit(sdkEvent.toolStart('ag-1', 'tc-2', 'view')); // 引数のないツール
    p.fake.emit(sdkEvent.toolStart(undefined, 'tc-3', 'bash', { command: 'ls' })); // メインのエージェント自身の呼び出し
    assert.deepEqual(withoutTime(seen), [
      { type: 'tool.started', agentId: 'ag-1', toolCallId: 'tc-1', toolName: 'edit', arguments: { path: 'a.md', text: '本文' } },
      { type: 'tool.started', agentId: 'ag-1', toolCallId: 'tc-2', toolName: 'view' },
      { type: 'tool.started', toolCallId: 'tc-3', toolName: 'bash', arguments: { command: 'ls' } },
    ]);
  });

  test('REQ-008 tool.execution_complete は tool.completed になる。終わりのイベントにないツールの名前は、開始のイベントから補う', async () => {
    const { p, seen } = await spy();
    p.fake.emit(sdkEvent.toolStart('ag-1', 'tc-1', 'edit', {}));
    p.fake.emit(sdkEvent.toolComplete('ag-1', 'tc-1', { success: true }));
    p.fake.emit(sdkEvent.toolStart('ag-1', 'tc-2', 'bash', {}));
    p.fake.emit(sdkEvent.toolComplete('ag-1', 'tc-2', { success: false, error: { message: 'コマンドが失敗しました', code: 'E1' } }));
    p.fake.emit(sdkEvent.toolComplete('ag-1', 'tc-never', { success: false })); // 開始を見ていない
    p.fake.emit(sdkEvent.toolComplete('ag-1', 'tc-1', { success: true })); // 同じ呼び出しの2回目の終わりは、名前を覚えていない
    assert.deepEqual(withoutTime(seen.filter((e) => e.type === 'tool.completed')), [
      { type: 'tool.completed', agentId: 'ag-1', toolCallId: 'tc-1', toolName: 'edit', success: true },
      { type: 'tool.completed', agentId: 'ag-1', toolCallId: 'tc-2', toolName: 'bash', success: false, error: 'コマンドが失敗しました' },
      { type: 'tool.completed', agentId: 'ag-1', toolCallId: 'tc-never', toolName: '不明なツール', success: false },
      { type: 'tool.completed', agentId: 'ag-1', toolCallId: 'tc-1', toolName: '不明なツール', success: true },
    ]);
  });
});

describe('確認の待ちのイベント（REQ-005）', () => {
  const shell = { kind: 'shell', fullCommandText: 'rm -rf build && npm test', intention: '作り直す', commands: [], possiblePaths: ['/work/build'], possibleUrls: [{ url: 'https://example.com/a' }], hasWriteFileRedirection: false, canOfferSessionApproval: true, warning: '削除を含みます' };
  const flags = { sandboxPermissive: false, sandboxBypass: false };

  test('REQ-005 permission.requested は wait.started（kind は permission）になる。種類ごとに、コマンドの全文・場所・URL・注意を取り出す', async () => {
    const { p, seen } = await spy();
    const cases = [
      [shell, { permissionKind: 'shell', toolKind: 'shell', command: 'rm -rf build && npm test', paths: ['/work/build'], urls: ['https://example.com/a'], warning: '削除を含みます' }],
      [{ ...shell, warning: undefined, possiblePaths: [], possibleUrls: [] }, { permissionKind: 'shell', toolKind: 'shell', command: 'rm -rf build && npm test', paths: [], urls: [] }],
      [{ kind: 'write', fileName: '/work/a.md', intention: '書く', diff: '+1' }, { permissionKind: 'write', toolKind: 'write', paths: ['/work/a.md'] }],
      [{ kind: 'read', path: '/work/b.md', intention: '読む' }, { permissionKind: 'read', toolKind: 'read', paths: ['/work/b.md'] }],
      [{ kind: 'url', url: 'https://example.com/x', intention: '取る' }, { permissionKind: 'url', toolKind: 'url', urls: ['https://example.com/x'] }],
      [{ kind: 'mcp', serverName: 'github', toolName: 'search_issues', toolTitle: '検索', readOnly: true }, { permissionKind: 'mcp', toolKind: 'github/search_issues' }],
      [{ kind: 'mcp' }, { permissionKind: 'mcp', toolKind: 'mcp' }],
      [{ kind: 'custom-tool', toolName: 'other_tool', toolDescription: '説明' }, { permissionKind: 'custom-tool', toolKind: 'other_tool' }],
      [{ kind: 'custom-tool' }, { permissionKind: 'custom-tool', toolKind: 'custom-tool' }],
      [{ kind: 'hook', toolName: 'bash', hookMessage: '確認' }, { permissionKind: 'hook', toolKind: 'bash' }],
      [{ kind: 'memory', fact: '覚える' }, { permissionKind: 'memory', toolKind: 'memory' }],
      [{ kind: 'extension-management', operation: 'reload' }, { permissionKind: 'extension-management', toolKind: 'extension-management' }],
      // エクステンション自身の権限の求めも、種類が分かるように渡す（画面に出さないのは中心の処理が決める。設計書 4.14）
      [{ kind: 'extension-permission-access', extensionName: 'x', capabilities: ['register hooks'] }, { permissionKind: 'extension-permission-access', toolKind: 'extension-permission-access' }],
      [{ kind: 'extension-env-access', extensionName: 'x', environmentVariables: ['GITHUB_TOKEN'] }, { permissionKind: 'extension-env-access', toolKind: 'extension-env-access' }],
      [{ kind: 'something-new' }, { permissionKind: 'something-new', toolKind: 'something-new' }],
    ];
    cases.forEach(([request], i) => p.fake.emit(sdkEvent.permissionRequested('ag-1', `req-${i}`, request)));
    assert.deepEqual(
      withoutTime(seen),
      cases.map(([, detail], i) => ({ type: 'wait.started', requestId: `req-${i}`, agentId: 'ag-1', kind: 'permission', detail: { ...flags, ...detail }, resolvedByHook: false })),
    );
  });

  test('REQ-005 サンドボックスの外で動かす求め（requestSandboxBypass）だけが sandboxBypass になる。記録だけにして中で動かし直す求め（requestSandboxPermissive）は外とは示さない', async () => {
    const { p, seen } = await spy();
    const requests = [
      { ...shell },
      { ...shell, requestSandboxBypass: true },
      { ...shell, requestSandboxBypass: true, requestSandboxPermissive: true },
      { kind: 'write', fileName: '/work/a.md', diff: '', requestSandboxBypass: true },
      { kind: 'url', url: 'https://example.com', requestSandboxBypass: true },
    ];
    requests.forEach((request, i) => p.fake.emit(sdkEvent.permissionRequested('ag-1', `req-${i}`, request)));
    assert.deepEqual(
      seen.map((e) => [e.detail.sandboxBypass, e.detail.sandboxPermissive]),
      [
        [false, false],
        [true, false],
        [false, true],
        [true, false],
        [true, false],
      ],
    );
  });

  test('REQ-005 ほかのフックがすでに答えを決めた求め（resolvedByHook）は、その印をつけて渡す', async () => {
    const { p, seen } = await spy();
    p.fake.emit(sdkEvent.permissionRequested('ag-1', 'req-1', shell, { resolvedByHook: true }));
    p.fake.emit(sdkEvent.permissionRequested('ag-1', 'req-2', shell, { resolvedByHook: false }));
    assert.deepEqual(
      seen.map((e) => e.resolvedByHook),
      [true, false],
    );
  });

  test('REQ-005 返事の待ち・利用の上限の待ちは wait.started（question、limit）に、答えが出たら wait.ended になる。上限の待ちには、エージェントの番号がない', async () => {
    const { p, seen } = await spy();
    p.fake.emit(sdkEvent.userInputRequested('ag-1', 'q-1', 'どちらの形式で保存しますか？'));
    p.fake.emit(sdkEvent.userInputCompleted('q-1'));
    p.fake.emit(sdkEvent.limitRequested('l-1'));
    p.fake.emit(sdkEvent.limitCompleted('l-1', 'add'));
    p.fake.emit(sdkEvent.limitCompleted('l-2', 'cancel'));
    p.fake.emit(sdkEvent.permissionCompleted('req-9'));
    assert.deepEqual(withoutTime(seen), [
      { type: 'wait.started', requestId: 'q-1', agentId: 'ag-1', kind: 'question', detail: { question: 'どちらの形式で保存しますか？' }, resolvedByHook: false },
      { type: 'wait.ended', requestId: 'q-1', kind: 'question' },
      { type: 'wait.started', requestId: 'l-1', kind: 'limit', detail: {}, resolvedByHook: false },
      { type: 'wait.ended', requestId: 'l-1', kind: 'limit', action: 'add' },
      { type: 'wait.ended', requestId: 'l-2', kind: 'limit', action: 'cancel' },
      { type: 'wait.ended', requestId: 'req-9', kind: 'permission' },
    ]);
  });

  test('REQ-005 requestId のない待ちのイベントは渡さない（始めと終わりを結べないため）', async () => {
    const { p, seen } = await spy();
    for (const type of ['permission.requested', 'user_input.requested', 'session_limits_exhausted.requested', 'permission.completed', 'user_input.completed', 'session_limits_exhausted.completed']) {
      p.fake.emit({ id: 'e', timestamp: iso(1), parentId: null, type, data: { permissionRequest: shell, question: '？' } });
      p.fake.emit({ id: 'e', timestamp: iso(1), parentId: null, type, data: { requestId: '' } });
    }
    assert.deepEqual(seen, []);
  });
});

describe('時刻・順番・壊れたイベント（REQ-008）', () => {
  test('REQ-008 時刻（at）はイベントの時刻（ミリ秒）。読めない時刻のときは、受け取った時刻', async () => {
    const { p, seen } = await spy();
    p.fake.emit(sdkEvent.subagentConfigured('ag-1', {}));
    const withTime = { ...sdkEvent.subagentConfigured('ag-2', {}), timestamp: '2026-10-22T03:04:05.678Z' };
    p.fake.emit(withTime);
    const before = Date.now();
    p.fake.emit({ ...sdkEvent.subagentConfigured('ag-3', {}), timestamp: 'いつか' });
    p.fake.emit({ ...sdkEvent.subagentConfigured('ag-4', {}), timestamp: undefined });
    const after = Date.now();
    assert.equal(seen[1].at, Date.UTC(2026, 9, 22, 3, 4, 5, 678));
    for (const e of seen.slice(2)) assert.ok(e.at >= before && e.at <= after, `${e.agentId} の時刻が受け取りの時刻`);
  });

  test('REQ-008 届いた順に、1つずつ中心の処理に渡す', async () => {
    const { p, seen } = await spy();
    const events = [
      sdkEvent.subagentStarted('ag-1', { agentType: 'orchestrator' }),
      sdkEvent.toolStart('ag-1', 'tc-1', 'view', {}),
      sdkEvent.permissionRequested('ag-1', 'req-1', { kind: 'read', path: '/a' }),
      sdkEvent.permissionCompleted('req-1'),
      sdkEvent.toolComplete('ag-1', 'tc-1', {}),
      sdkEvent.subagentCompleted('ag-1'),
    ];
    for (const event of events) p.fake.emit(event);
    assert.deepEqual(
      seen.map((e) => e.type),
      ['agent.started', 'tool.started', 'wait.started', 'wait.ended', 'tool.completed', 'agent.completed'],
    );
  });

  test('REQ-008 つなぎ口が使わないイベントや、壊れたイベントは渡さず、例外も投げない', async () => {
    const { p, seen } = await spy();
    const [listener] = p.fake.listeners();
    const ignored = [
      { id: 'e', timestamp: iso(1), parentId: null, type: 'assistant.message_delta', data: { deltaContent: 'こん' } },
      { id: 'e', timestamp: iso(1), parentId: null, type: 'session.idle', data: {} },
      { id: 'e', timestamp: iso(1), parentId: null, type: 'subagent.started' }, // data がない
      { id: 'e', timestamp: iso(1), parentId: null, type: 'subagent.started', data: null },
      { id: 'e', timestamp: iso(1), parentId: null, type: 'subagent.completed', data: {} }, // agentId がない
      { id: 'e', timestamp: iso(1), parentId: null, type: 'subagent.failed', data: { error: 'x' } },
      { id: 'e', timestamp: iso(1), parentId: null, type: 'system.notification', data: null },
      { id: 'e', timestamp: iso(1), parentId: null, type: 'system.notification', data: { kind: { type: 'agent_idle' } } }, // 番号がない
      { id: 'e', timestamp: iso(1), parentId: null, type: 5, data: {} },
      { type: undefined },
      {},
      null,
      undefined,
      42,
      'subagent.started',
    ];
    for (const event of ignored) assert.doesNotThrow(() => listener(event), JSON.stringify(event));
    assert.deepEqual(seen, []);
  });

  test('REQ-008 中心の処理が例外を投げても、受け取りは例外を投げず、調べるための出力（標準エラー）に残す。標準出力には出さない', async () => {
    const { p } = await spy();
    p.core.onEvent = () => {
      throw new Error('中心の処理の失敗');
    };
    const [listener] = p.fake.listeners();
    const errors = [];
    const out = [];
    const originalError = console.error;
    const originalWrite = process.stdout.write;
    console.error = (...args) => errors.push(args);
    process.stdout.write = (chunk, ...rest) => {
      out.push(String(chunk));
      return originalWrite.call(process.stdout, chunk, ...rest);
    };
    try {
      assert.doesNotThrow(() => listener(sdkEvent.subagentStarted('ag-1', { agentType: 'worker' })));
    } finally {
      console.error = originalError;
      process.stdout.write = originalWrite;
    }
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /つなぎ口/);
    assert.deepEqual(out.filter((text) => text.includes('中心の処理の失敗')), []);
  });
});
