// 改善の模擬ユーザーの外側の EVAL の採点（outer-grade-change.mjs。BLUEPRINT 7.3）。観点ごとに、合格する作り例と、落ちる作り例で確かめる。
// 純粋な関数なので、ファイルも git もモデルも使わない。

import assert from 'node:assert/strict';
import test from 'node:test';

import { gradeChange, questionUnits, SCREEN_ITEMS } from './outer-grade-change.mjs';

const BASE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const K = (id, text, kind = 'other', item = '進め方') => ({ id, kind, item, text });
const BEFORE = [K('K-01', '手順どおりに進める。'), K('K-02', '失敗したら人に伝える。', 'other', 'いつもと違うとき')];

/** すべての観点に合格する1回分の材料。mutate で1か所ずつ壊す */
function goodCase() {
  const persona = {
    id: 'mini-change',
    kind: 'change',
    target: 'market/plugins/demo',
    expect: {
      carriedMax: 2, replaced: 'K-02', deviceTool: 'kxtool', userSkills: 'tools/skills',
      screenAsked: '画面で[^。？]{0,20}(?:設定したい|見たい)', lastTimeAsked: '最近[^。？]{0,20}1回', explained: ['revert', '起動し直', '\\d+\\.\\d+\\.\\d+'],
    },
    files: [
      { place: 'tools/skills/build/SKILL.md', role: 'skill' },
      { place: 'tools/skills/build/scripts/build.sh', role: 'skill' },
      { place: 'market/plugins/demo/skills/rules/SKILL.md', role: 'repo' },
    ],
    knowledge: [
      { id: 'cc-gcc', fact: 'arm-gcc でビルドする', volunteer: false, from: 'file', file: { path: 'tools/skills/build/SKILL.md', evidence: 'arm-gcc', kind: 'rule', answer: 'このとおり' }, markers: { asked: 'ビルド', answered: 'arm-gcc', embedded: ['arm-gcc でビルド'] } },
      { id: 'cc-pull', fact: 'git pull はたまたま', volunteer: false, from: 'file', file: { path: 'tools/skills/build/SKILL.md', evidence: 'git pull', kind: 'incidental', answer: '決まりではなく、たまたま' }, markers: { asked: 'pull', answered: 'たまたま', excluded: ['git pull'] } },
      // 本物の模擬ユーザー（edl-change）と同じく、asked は元の決まりの文字（printf）にも当たる
      { id: 'log-dbg', fact: 'DBG_LOG で出す', volunteer: false, from: 'file', file: { path: 'market/plugins/demo/skills/rules/SKILL.md', evidence: 'DBG_LOG', kind: 'rule', answer: 'このとおり' }, markers: { asked: 'DBG_LOG|printf', answered: 'DBG_LOG', embedded: ['DBG_LOG で'] } },
      { id: 'k15-now', fact: 'K-02 は古い。reboot してやり直す', volunteer: true, from: 'talk', markers: { asked: 'K-02|古い', answered: 'reboot', embedded: ['reboot[^\\n]{0,10}やり直'] } },
    ],
  };
  const personaFiles = [
    { place: 'tools/skills/build/SKILL.md', role: 'skill', sha256: 'h-skill-md' },
    { place: 'tools/skills/build/scripts/build.sh', role: 'skill', sha256: 'h-build-sh' },
    { place: 'market/plugins/demo/skills/rules/SKILL.md', role: 'repo', sha256: 'h-repo' },
  ];
  const state = {
    stage: 'generate',
    confirmation: { version: '0.2.0', rebuild: { keep: ['できていたことはすべて引き継ぐ'], change: ['ビルドとデプロイのルールのスキルを足す'] } },
    items: { purpose: { status: 'unchanged' }, procedure: { status: 'asked' }, settings: { status: 'unchanged' }, running_view: { status: 'unchanged' }, result_view: { status: 'unchanged' } },
  };
  const snap = (seq, reason, head = BASE, status = []) => ({ seq, at: seq, kind: 'repo.snapshot', reason, head, status });
  // 直す前の確認は、受け付けられた後（seq 10.5）に、1つ目（版・土台）と2つ目（課題・擬似の機器）を、それぞれ問いと一緒に示し、
  // 最後に承認の問いを聞く（make-plugin の confirm.md の3・4、change-confirm.md の3・4）。承認の問いそのものには、4つの言葉がない
  const items = [
    { seq: 1, kind: 'user.request', text: 'demo を直してください' },
    { seq: 2, kind: 'creator.text', text: '今の決まりの一覧です。ログは printf で足します。\n- K-01 手順どおりに進める。\n- K-02 失敗したら人に伝える。' },
    snap(3, 'question'),
    { seq: 4, kind: 'creator.question', header: '決まり', question: '違うもの・古いものはありますか？', options: [{ label: 'すべてこのとおり', description: '' }] },
    { seq: 5, kind: 'user.answer', index: 0, via: 'AskUserQuestion', question: '違うもの・古いものはありますか？', answer: 'K-02 は古い。今は1回 reboot してやり直す' },
    snap(6, 'question'),
    { seq: 7, kind: 'creator.question', header: '決まり', question: '「KX では DBG_LOG で出す」という決まりですか？', options: [{ label: 'このとおり', description: '' }] },
    { seq: 8, kind: 'user.answer', index: 1, via: 'AskUserQuestion', question: '「KX では DBG_LOG で出す」という決まりですか？', answer: 'このとおり' },
    { seq: 9, kind: 'creator.question-text', text: '最近実際にやった1回を、最初から教えてください。', turn: 2 },
    { seq: 10, kind: 'user.answer', index: 2, via: 'text', question: '最近実際にやった1回を、最初から教えてください。', answer: 'ログを足してビルドした' },
    { seq: 11, kind: 'creator.text', text: '直す前の確認の1つ目です。引き継ぐことと変わること：共通の土台を今の版に上げます。新しい版の案は 0.1.0 → 0.2.0 です。' },
    { seq: 12, kind: 'creator.question', header: '確認1', question: '1つ目に、違うところと足りないところはありますか？', options: [{ label: 'ない', description: '' }] },
    { seq: 13, kind: 'user.answer', index: 3, via: 'AskUserQuestion', question: '1つ目に、違うところと足りないところはありますか？', answer: 'ない' },
    { seq: 14, kind: 'creator.text', text: '2つ目です。擬似の機器で試す課題 T-02 を足します。本物の機器への転送は試せません。' },
    { seq: 15, kind: 'creator.question', header: '確認2', question: '2つ目に、違うところと足りないところはありますか？', options: [{ label: 'ない', description: '' }] },
    { seq: 16, kind: 'user.answer', index: 4, via: 'AskUserQuestion', question: '2つ目に、違うところと足りないところはありますか？', answer: 'ない' },
    snap(17, 'question'),
    { seq: 18, kind: 'creator.question', header: '承認', question: 'よいと答えると、元のプラグインのフォルダのファイルを直し始めます。この内容で直してよいですか？', options: [{ label: 'まだ直したいところがある', description: '' }, { label: 'この内容で直してよい', description: '' }] },
    { seq: 19, kind: 'user.answer', index: 5, via: 'AskUserQuestion', question: 'よいと答えると、元のプラグインのフォルダのファイルを直し始めます。この内容で直してよいですか？', answer: 'この内容で直してよい' },
    snap(20, 'tool:progress'),
    snap(22, 'turn-end', HEAD),
    { seq: 23, kind: 'tool.use', owner: 'main', name: 'Bash', input: { command: 'python3 /p/skills/make-plugin/scripts/scaffold.py commit --plugin market/plugins/demo --message "直した"' } },
    { seq: 24, kind: 'creator.text', text: '直して 0.2.0 にしました。戻すときは git revert です。Copilot CLI を起動し直してください。' },
  ];
  const toolEvents = [
    { seq: 10.5, type: 'tool.call', callId: 1, tool: 'confirm', args: { knowledgeIds: ['K-01', 'K-03', 'K-04'], version: '0.2.0' } },
    { seq: 10.6, type: 'tool.result', callId: 1, tool: 'confirm', isError: false, result: '確認を記録しました' },
    { seq: 21, type: 'tool.call', callId: 2, tool: 'progress', args: { stage: '生成', approvalQuote: 'この内容で直してよい' } },
    { seq: 21.5, type: 'tool.result', callId: 2, tool: 'progress', isError: false, result: '生成に進めました' },
  ];
  const stages = { skipped: false, ok: true, stage1: { ok: true }, stage2: { ok: true } };
  const after = [BEFORE[0], K('K-03', 'KX では DBG_LOG で出す。', 'other', '決まった書き方やルール'), K('K-04', '1回 reboot してやり直し、だめなら人に伝える。', 'other', 'いつもと違うとき')];
  const outside = { 'market/README.md': 'h-readme', 'tools/skills/build/SKILL.md': 'h-skill-md', 'tools/skills/build/scripts/build.sh': 'h-build-sh' };
  const repo = {
    baseline: {
      baseCommit: BASE, targetInRepo: 'plugins/demo', pluginName: 'demo', versionBefore: '0.1.0', knowledgeBefore: BEFORE, removedBefore: null,
      evalBefore: [{ dir: 'T-01', prompt: '元の課題' }], stagedBefore: ['README.md'],
      userSkillFiles: { 'tools/skills/build/SKILL.md': 'h-skill-md', 'tools/skills/build/scripts/build.sh': 'h-build-sh' }, userSkillNames: ['build'],
      outsideFiles: outside, originRefs: { 'refs/heads/main': BASE },
    },
    headCommit: HEAD,
    commits: [{ commit: HEAD, parents: [BASE], subject: 'plugin-creator: demo を直した（0.1.0 → 0.2.0）' }],
    diffFiles: ['plugins/demo/plugin.json', 'plugins/demo/skills/build-rules/SKILL.md', 'plugins/demo/tests/knowledge.json'],
    stagedAfter: ['README.md'],
    statusAfter: [],
    tagsAtHead: ['plugin-creator-generated-demo'],
    pluginNameAfter: 'demo',
    versionAfter: '0.2.0',
    knowledgeAfter: after,
    removedAfter: [{ ...BEFORE[1], replacedBy: 'K-04' }],
    added: [
      { rel: 'skills/build-rules/SKILL.md', text: '- arm-gcc でビルドする（K-05）\n- 失敗したら1回 reboot してやり直す（K-04）', sha256: 'h-new-skill' },
      { rel: 'skills/build-rules/scripts/build.sh', text: '#!/bin/sh\necho build', sha256: 'h-build-sh' },
      { rel: 'tests/knowledge.json', text: '"text": "KX では DBG_LOG で出す。"', sha256: 'h-k' },
      { rel: 'tests/eval/T-02/inputs/bin/kxtool', text: 'git pull', sha256: 'h-kxtool' },
    ],
    targetFiles: [
      { rel: 'skills/rules/SKILL.md', sha256: 'h-repo', text: '- KX では DBG_LOG で出す（K-03）' },
      { rel: 'skills/build-rules/SKILL.md', sha256: 'h-new-skill', text: '- arm-gcc でビルドする（K-05）' },
      { rel: 'skills/build-rules/scripts/build.sh', sha256: 'h-build-sh', text: '#!/bin/sh\necho build' },
      { rel: 'tests/knowledge-removed.json', sha256: 'h-r', text: '[{"id":"K-02","replacedBy":"K-04"}]' },
    ],
    targetSkillNames: [{ dir: 'build-rules', name: 'build-rules' }, { dir: 'rules', name: 'rules' }],
    evalAfter: [
      { dir: 'T-01', json: { id: 'T-01', prompt: '元の課題' }, files: ['eval.json'] },
      { dir: 'T-02', json: { id: 'T-02', prompt: '機器に入れて動かす', bin: 'inputs/bin', criteria: [{ id: 'C-02', grading: 'program', check: { type: 'contains', file: 'device-history.log', text: 'send' } }] }, files: ['eval.json', 'inputs/bin/kxtool'] },
    ],
    userSkillFilesAfter: { 'tools/skills/build/SKILL.md': 'h-skill-md', 'tools/skills/build/scripts/build.sh': 'h-build-sh' },
    outsideFilesAfter: { ...outside, '.claude/.cc-writes/x': 'h-empty' },
    leftoverWork: [],
    originRefsAfter: { 'refs/heads/main': BASE },
    newPlugins: [],
  };
  const modelUse = { requested: 'claude-opus-5-5', main: ['claude-opus-5-5'], subagents: [{ type: 'plugin-creator:worker', models: ['claude-haiku-5-5'] }], lowCost: 'claude-haiku-5-5' };
  return { persona, personaFiles, state, items, toolEvents, stages, repo, modelUse, record: { skills: ['plugin-creator:change-plugin'] }, model: 'claude-opus-5-5', arm: 'with' };
}

const gradesOf = (args) => Object.fromEntries(gradeChange(args).grades.map((g) => [g.id, g]));

/** 1か所だけ壊して、その観点だけが落ちることを確かめる */
function expectOnlyFails(mutate, ids) {
  const args = goodCase();
  mutate(args);
  const grading = gradeChange(args);
  const failed = grading.grades.filter((g) => !g.ok).map((g) => g.id).sort();
  assert.deepEqual(failed, [...ids].sort(), JSON.stringify(grading.grades.filter((g) => !g.ok)));
  assert.equal(grading.verdict.ok, false);
  return Object.fromEntries(grading.grades.map((g) => [g.id, g]));
}

test('REQ-052〜062 作り例：すべての観点に合格する。観点はすべて必須で、会話例の候補にはしない', () => {
  const grading = gradeChange(goodCase());
  const failed = grading.grades.filter((g) => !g.ok);
  assert.deepEqual(failed, [], JSON.stringify(failed));
  assert.equal(grading.kind, 'change');
  assert.equal(grading.score, 1);
  assert.equal(grading.verdict.ok, true);
  assert.deepEqual(grading.verdict.required, grading.grades.map((g) => g.id));
  assert.equal(grading.exampleCandidate, false);
  assert.deepEqual(grading.grades.map((g) => g.id), [
    'change-skill-used', 'no-new-folder', 'unchanged-before-approval', 'confirm-contents', 'version-approved', 'rules-list-once', 'rule-replaced', 'ids-kept',
    'added-rule-confirmed', 'embedded:cc-gcc', 'not-embedded:cc-pull', 'embedded:log-dbg', 'embedded:k15-now', 'skill-names-differ', 'user-skills-unchanged',
    'assets-reused', 'unchanged-items', 'no-screen-questions', 'last-time-asked', 'stage1', 'stage2', 'tests-added', 'commit-scoped', 'nothing-outside',
    'not-pushed', 'explained', 'main-model', 'worker-model',
  ]);
  assert.equal(grading.trace.length, 4);
  assert.ok(grading.counts.questions.total >= 4);
  // 要件の番号を持つ
  assert.ok(grading.grades.every((g) => /^REQ-\d{3}$/.test(g.req)), JSON.stringify(grading.grades.filter((g) => !g.req)));
});

test('REQ-052 change-skill-used：change-plugin を呼ばない・make-plugin を始めたら落ちる', () => {
  expectOnlyFails((a) => { a.record.skills = []; }, ['change-skill-used']);
  expectOnlyFails((a) => { a.record.skills.push('plugin-creator:make-plugin'); }, ['change-skill-used']);
});

test('REQ-052 REQ-059 no-new-folder：新しいフォルダにプラグインができたら落ちる', () => {
  expectOnlyFails((a) => { a.repo.newPlugins = ['out/demo']; }, ['no-new-folder']);
});

test('REQ-057 unchanged-before-approval：承認より前に HEAD が進んだ・直すフォルダが変わった・承認の抜き書きが答えにないと落ちる。承認の後の変化は見ない', () => {
  const moved = expectOnlyFails((a) => { a.items.find((i) => i.seq === 6).head = HEAD; }, ['unchanged-before-approval']);
  assert.match(moved['unchanged-before-approval'].detail, /HEAD が進んだ/);
  expectOnlyFails((a) => { a.items.find((i) => i.seq === 20).status = [' M plugin.json']; }, ['unchanged-before-approval']);
  expectOnlyFails((a) => { a.toolEvents.find((e) => e.tool === 'progress' && e.type === 'tool.call').args.approvalQuote = 'まったく違う言葉'; }, ['unchanged-before-approval']);
  // 承認の後（seq 22）の HEAD の変化は、承認の前に入らない
  assert.equal(gradesOf(goodCase())['unchanged-before-approval'].ok, true);
});

test('REQ-057 REQ-061 confirm-contents：確認から承認の問いまでの問いと前の文に、版・土台・擬似の機器・課題がそろわない、引き継ぐことか変わることが空だと落ちる', () => {
  for (const word of ['0.2.0', '土台', '擬似の機器', '課題']) {
    const g = expectOnlyFails((a) => {
      for (const i of a.items) if (i.seq > 10 && i.seq < 19 && i.text) i.text = i.text.replaceAll(word, '〇〇');
    }, ['confirm-contents']);
    assert.match(g['confirm-contents'].detail, new RegExp(word === '0.2.0' ? '新しい版' : word));
  }
  expectOnlyFails((a) => { a.state.confirmation.rebuild.keep = []; }, ['confirm-contents']);
  expectOnlyFails((a) => { a.state.confirmation.rebuild.change = []; }, ['confirm-contents']);
});

test('REQ-057 REQ-061 confirm-contents：スキルのとおり、確認を1つ目・2つ目に分けて問いと一緒に示し、承認の問いだけを聞いても合格する。確認より前の文は数えない', () => {
  // 作り例そのもの：承認の問いとその前の文（なし）には4つの言葉がなく、1つ目に版と土台、2つ目に擬似の機器と課題がある
  const good = goodCase();
  const approval = good.items.find((i) => i.seq === 18);
  assert.doesNotMatch(approval.question, /0\.2\.0|土台|擬似|課題/);
  const g = gradesOf(good)['confirm-contents'];
  assert.equal(g.ok, true, g.detail);
  assert.match(g.detail, /3 つの問い/);
  // 確認より前（決まりの一覧の前の文）に言葉があっても数えない
  expectOnlyFails((a) => {
    a.items.find((i) => i.seq === 11).text = '直す前の確認の1つ目です。新しい版の案は 0.2.0 です。';
    a.items.find((i) => i.seq === 2).text += '\n共通の土台も上げます。';
  }, ['confirm-contents']);
  // 受け付けられた確認がない（断られただけ）なら落ちる
  expectOnlyFails((a) => { a.toolEvents.find((e) => e.tool === 'confirm' && e.type === 'tool.result').isError = true; }, ['confirm-contents']);
  // 断られた後に直して受け付けられたときは、受け付けられた確認から見る
  const retried = goodCase();
  retried.toolEvents.unshift(
    { seq: 10.1, type: 'tool.call', callId: 9, tool: 'confirm', args: {} },
    { seq: 10.2, type: 'tool.result', callId: 9, tool: 'confirm', isError: true, result: '断りました' },
  );
  assert.equal(gradesOf(retried)['confirm-contents'].ok, true);
});

test('REQ-057 version-approved：直した版が確認の版と違う・元の版より大きくないと落ちる', () => {
  expectOnlyFails((a) => { a.repo.versionAfter = '0.1.1'; }, ['version-approved']);
  expectOnlyFails((a) => { a.state.confirmation.version = '0.1.0'; a.repo.versionAfter = '0.1.0'; for (const i of a.items) if (i.text) i.text = i.text.replaceAll('0.2.0', '0.1.0'); }, ['version-approved']);
});

test('REQ-054 rules-list-once：元の決まりの番号が、確認より前の1つの問い（問いとその前の文）にそろって出ないと落ちる', () => {
  expectOnlyFails((a) => { a.items.find((i) => i.seq === 2).text = '今の決まりの一覧です。\n- K-01 手順どおりに進める。'; }, ['rules-list-once']);
  // 問いの欄に番号があっても同じ（前の文と問いを合わせて見る）
  const ok = goodCase();
  ok.items.find((i) => i.seq === 2).text = '今の決まりです。';
  ok.items.find((i) => i.seq === 4).question = 'K-01 と K-02 のうち、違うもの・古いものはありますか？';
  ok.items.find((i) => i.seq === 5).question = ok.items.find((i) => i.seq === 4).question;
  assert.equal(gradesOf(ok)['rules-list-once'].ok, true);
  // 段階「読む」で一覧を聞かず、確認の1つ目（仕事のやり方や決まりの一覧）にだけ番号が並んでも、数えない
  const g = expectOnlyFails((a) => {
    a.items.find((i) => i.seq === 2).text = '今の決まりを確かめます。';
    a.items.find((i) => i.seq === 11).text += '\n- K-01 手順どおりに進める。\n- K-02 失敗したら人に伝える（K-04 に直す）。';
  }, ['rules-list-once']);
  assert.match(g['rules-list-once'].detail, /確認より前/);
});

test('REQ-054 REQ-058 rule-replaced：直した決まりの番号が残っている・付け直した番号が一覧にない・元の最大より大きくないと落ちる', () => {
  const stray = expectOnlyFails((a) => { a.repo.targetFiles.push({ rel: 'com.github.copilot/agents/worker.agent.md', sha256: 'h-w', text: 'K-02 に従う' }); }, ['rule-replaced']);
  assert.match(stray['rule-replaced'].detail, /worker\.agent\.md/);
  expectOnlyFails((a) => { a.repo.removedAfter = []; a.repo.knowledgeAfter = [...a.repo.knowledgeAfter, BEFORE[1]]; }, ['rule-replaced']);
  expectOnlyFails((a) => { a.repo.removedAfter[0].replacedBy = 'K-09'; }, ['rule-replaced']);
  // K-02 は K-20 などの一部としては数えない
  const ok = goodCase();
  ok.repo.targetFiles.push({ rel: 'docs/x.md', sha256: 'h-x', text: 'K-020 と XK-02 は別' });
  assert.equal(gradesOf(ok)['rule-replaced'].ok, true);
});

test('REQ-058 ids-kept：引き継いだ番号の中身が変わった・新しい番号が元の最大以下・外した番号を使った・決まりが消えたら落ちる', () => {
  expectOnlyFails((a) => { a.repo.knowledgeAfter[0] = { ...a.repo.knowledgeAfter[0], text: '書き換えた' }; }, ['ids-kept']);
  expectOnlyFails((a) => { a.repo.knowledgeAfter.push(K('K-02', '同じ番号を使い回した')); }, ['ids-kept']);
  expectOnlyFails((a) => { a.repo.knowledgeAfter = a.repo.knowledgeAfter.filter((k) => k.id !== 'K-01'); }, ['ids-kept']);
  expectOnlyFails((a) => { a.repo.baseline.removedBefore = [K('K-05', '前に外した')]; a.repo.removedAfter.push(K('K-05', '前に外した')); a.repo.knowledgeAfter.push(K('K-05', '外した番号を使い回した')); }, ['ids-kept']);
  expectOnlyFails((a) => { a.repo.knowledgeAfter = null; }, ['ids-kept', 'rule-replaced', 'added-rule-confirmed']);
});

test('REQ-054 added-rule-confirmed：書き足された決まりだけを確かめる問いがない・一覧に入っていないと落ちる。書き足された決まりがない模擬ユーザーでは出ない', () => {
  expectOnlyFails((a) => {
    const q = a.items.find((i) => i.seq === 7);
    q.question = 'ほかに決まりはありますか？';
    a.items.find((i) => i.seq === 8).question = q.question;
  }, ['added-rule-confirmed']);
  expectOnlyFails((a) => { a.repo.knowledgeAfter = a.repo.knowledgeAfter.filter((k) => k.id !== 'K-03'); }, ['added-rule-confirmed']);
  const none = goodCase();
  none.persona.files = none.persona.files.filter((f) => f.role !== 'repo');
  assert.equal(gradesOf(none)['added-rule-confirmed'], undefined);
});

test('REQ-054 added-rule-confirmed：決まりの一覧の問いだけでは、1件ずつ確かめたことにならない（asked の言葉が元の決まりにも当たる本物の模擬ユーザーの場合）', () => {
  /** 書き足された決まりの問い（seq 7）を、決まりと関係のない問いにする */
  const dropSingle = (a) => {
    const q = a.items.find((i) => i.seq === 7);
    q.question = 'ほかに決まりはありますか？';
    a.items.find((i) => i.seq === 8).question = q.question;
  };
  // 決まりの一覧の問いだけ：前の文に printf（元の決まり）があり、問いにも書き足した行の文字がある。元の番号がそろって出る問いなので数えない
  const listed = expectOnlyFails((a) => {
    dropSingle(a);
    const q = a.items.find((i) => i.seq === 4);
    q.question = 'K-01・K-02 と、書き足された「DBG_LOG で出す」のうち、違うもの・古いものはありますか？';
    a.items.find((i) => i.seq === 5).question = q.question;
  }, ['added-rule-confirmed']);
  assert.match(listed['added-rule-confirmed'].detail, /DBG_LOG/);
  // 決まりの文字が前の文にだけあり、問いそのものにない
  expectOnlyFails((a) => {
    const q = a.items.find((i) => i.seq === 7);
    q.question = 'この決まりで合っていますか？';
    a.items.find((i) => i.seq === 8).question = q.question;
    a.items.splice(a.items.indexOf(q), 0, { seq: 6.5, kind: 'creator.text', text: '書き足された行：KX では DBG_LOG で出す' });
  }, ['added-rule-confirmed']);
  // 1件を確かめる問いが、元の決まりの番号に触れていてもよい（一覧の問いでなければ数える）
  const touching = goodCase();
  const q7 = touching.items.find((i) => i.seq === 7);
  q7.question = 'K-01 とは別に、「KX では DBG_LOG で出す」という決まりですか？（skills/rules/SKILL.md より）';
  touching.items.find((i) => i.seq === 8).question = q7.question;
  touching.items.splice(touching.items.indexOf(q7), 0, { seq: 6.5, kind: 'creator.text', text: '古いと答えた決まりは、新しい番号に直します。' });
  assert.equal(gradesOf(touching)['added-rule-confirmed'].ok, true, gradesOf(touching)['added-rule-confirmed'].detail);
  // 確認より後の問いにだけ出る
  expectOnlyFails((a) => {
    dropSingle(a);
    const q = a.items.find((i) => i.seq === 15);
    q.question = '2つ目に、違うところはありますか？（T-02 では DBG_LOG で出すかを見ます）';
    a.items.find((i) => i.seq === 16).question = q.question;
  }, ['added-rule-confirmed']);
});

test('REQ-055 embedded・not-embedded：足した行で見る。決まりの一覧・写した資産・課題の入力は証拠にしない。repo のファイルの決まりは直した後のファイルで見る', () => {
  // ルールが足した行にないと落ちる（決まりの一覧にだけあっても数えない）
  expectOnlyFails((a) => {
    a.repo.added[0].text = '- 失敗したら1回 reboot してやり直す（K-04）';
    a.repo.added[2].text = 'arm-gcc でビルドする';
  }, ['embedded:cc-gcc']);
  // たまたまの書き方が足した行にあると落ちる（課題の入力の写しにあるだけなら数えない）
  expectOnlyFails((a) => { a.repo.added[0].text += '\n- ビルドの前に git pull する'; }, ['not-embedded:cc-pull']);
  // そのまま写した資産（role が skill の SKILL.md でないファイル）の中身は証拠にしない
  expectOnlyFails((a) => { a.repo.added[0].text = '- 失敗したら1回 reboot してやり直す（K-04）'; a.repo.added[1].text = 'arm-gcc でビルドする'; }, ['embedded:cc-gcc']);
  // 作る前からある決まり（repo のファイル）は、足した行になくても、直した後のファイルにあれば合格。消えたら落ちる
  expectOnlyFails((a) => { a.repo.targetFiles[0].text = '- printf で出す'; }, ['embedded:log-dbg']);
  // 話の中の決まり（K-02 の今）は足した行で見る
  expectOnlyFails((a) => { a.repo.added[0].text = '- arm-gcc でビルドする（K-05）'; }, ['embedded:k15-now']);
});

test('REQ-055 skill-names-differ・user-skills-unchanged・assets-reused', () => {
  expectOnlyFails((a) => { a.repo.targetSkillNames.push({ dir: 'build', name: 'build' }); }, ['skill-names-differ']);
  expectOnlyFails((a) => { a.repo.userSkillFilesAfter = { ...a.repo.userSkillFilesAfter, 'tools/skills/build/SKILL.md': 'h-changed' }; a.repo.outsideFilesAfter['tools/skills/build/SKILL.md'] = 'h-changed'; }, ['user-skills-unchanged', 'nothing-outside']);
  const missing = expectOnlyFails((a) => { a.repo.targetFiles = a.repo.targetFiles.filter((f) => f.rel !== 'skills/build-rules/scripts/build.sh'); }, ['assets-reused']);
  assert.match(missing['assets-reused'].detail, /build\.sh/);
  // scripts/ の外に写しても数えない
  expectOnlyFails((a) => { a.repo.targetFiles.find((f) => f.rel === 'skills/build-rules/scripts/build.sh').rel = 'scripts/build.sh'; }, ['assets-reused']);
});

test('REQ-056 unchanged-items・no-screen-questions・last-time-asked', () => {
  for (const key of SCREEN_ITEMS) expectOnlyFails((a) => { a.state.items[key].status = 'asked'; }, ['unchanged-items']);
  expectOnlyFails((a) => { a.state.items = { procedure: { status: 'asked' } }; }, ['unchanged-items']);
  const screen = expectOnlyFails((a) => {
    a.items.push({ seq: 30, kind: 'creator.question', header: '画面', question: '画面で開始前に設定したいことはありますか？', options: [] });
  }, ['no-screen-questions']);
  assert.match(screen['no-screen-questions'].detail, /画面の問いがある/);
  // 前の文に画面の言葉があっても、問いでなければ数えない
  const ok = goodCase();
  ok.items.find((i) => i.seq === 11).text += '画面で設定したいことは、今回は変えないので聞きません。';
  assert.equal(gradesOf(ok)['no-screen-questions'].ok, true);
  expectOnlyFails((a) => {
    const q = a.items.find((i) => i.seq === 9);
    q.text = '作業の流れを教えてください。';
    a.items.find((i) => i.seq === 10).question = q.text;
  }, ['last-time-asked']);
});

test('REQ-061 stage1・stage2・tests-added：1・2段目の不合格・動かせなかった、足した課題がない・擬似の機器の口がそろわないと落ちる', () => {
  expectOnlyFails((a) => { a.stages.stage2.ok = false; }, ['stage2']);
  expectOnlyFails((a) => { a.stages = { skipped: true, reason: '道具が足りない' }; }, ['stage1', 'stage2']);
  expectOnlyFails((a) => { a.stages = null; }, ['stage1', 'stage2']);
  expectOnlyFails((a) => { a.repo.evalAfter = a.repo.evalAfter.slice(0, 1); }, ['tests-added']);
  expectOnlyFails((a) => { delete a.repo.evalAfter[1].json.bin; }, ['tests-added']);
  expectOnlyFails((a) => { a.repo.evalAfter[1].files = ['eval.json', 'inputs/bin/ssh']; }, ['tests-added']);
  expectOnlyFails((a) => { a.repo.evalAfter[1].json.criteria[0].check.file = 'logs/device.log'; }, ['tests-added']);
  // 引き継いだ課題の名前で足しても、頼みの言葉が同じなら足した課題に数えない
  expectOnlyFails((a) => { a.repo.evalAfter[1].json.prompt = '元の課題'; }, ['tests-added']);
});

test('REQ-059 commit-scoped：コミットが1つでない・外のファイルを入れた・git add だけのファイルが変わった・変更が残った・タグがないと落ちる', () => {
  expectOnlyFails((a) => { a.repo.commits.push({ commit: 'd'.repeat(40), parents: [HEAD], subject: '試験の直し' }); }, ['commit-scoped']);
  const outside = expectOnlyFails((a) => { a.repo.diffFiles.push('README.md'); }, ['commit-scoped']);
  assert.match(outside['commit-scoped'].detail, /README\.md/);
  expectOnlyFails((a) => { a.repo.stagedAfter = []; }, ['commit-scoped']);
  expectOnlyFails((a) => { a.repo.statusAfter = ['?? notes.md']; }, ['commit-scoped']);
  expectOnlyFails((a) => { a.repo.tagsAtHead = ['plugin-creator-generated']; }, ['commit-scoped']);
  // リポジトリの直下のプラグインのタグは plugin-creator-generated
  const root = goodCase();
  root.repo.baseline.targetInRepo = '';
  root.repo.tagsAtHead = ['plugin-creator-generated'];
  assert.equal(gradesOf(root)['commit-scoped'].ok, true, gradesOf(root)['commit-scoped'].detail);
});

test('REQ-059 REQ-021 nothing-outside・not-pushed：外のファイルが変わった・作業用の一時フォルダが残った・push したら落ちる', () => {
  expectOnlyFails((a) => { a.repo.outsideFilesAfter['market/README.md'] = 'h-other'; }, ['nothing-outside']);
  expectOnlyFails((a) => { a.repo.outsideFilesAfter['market/NEW.md'] = 'h-new'; }, ['nothing-outside']);
  const left = expectOnlyFails((a) => { a.repo.leftoverWork = ['.plugin-creator-work']; a.repo.outsideFilesAfter['.plugin-creator-work/parts/a.md'] = 'h'; }, ['nothing-outside']);
  assert.match(left['nothing-outside'].detail, /一時フォルダが残っている/);
  assert.doesNotMatch(left['nothing-outside'].detail, /増えた/);
  expectOnlyFails((a) => { a.repo.originRefsAfter = { 'refs/heads/main': HEAD }; }, ['not-pushed']);
  expectOnlyFails((a) => { a.items.push({ seq: 40, kind: 'tool.use', owner: 'main', name: 'Bash', input: { command: 'git -C market push origin main' } }); }, ['not-pushed']);
  for (const command of ['cd market && git push', 'git -c core.x=1 -C "my repo" push --tags', 'out=$(git push 2>&1)']) {
    expectOnlyFails((a) => { a.items.push({ seq: 40, kind: 'tool.use', owner: 'worker', name: 'Bash', input: { command } }); }, ['not-pushed']);
  }
});

test('REQ-059 not-pushed：git の push の呼び出しでないもの（文字、heredoc で書く文、git stash push）では落ちない', () => {
  const ok = goodCase();
  ok.items.push(
    { seq: 40, kind: 'tool.use', owner: 'main', name: 'Bash', input: { command: 'echo "公開するときは git push してください"' } },
    { seq: 41, kind: 'tool.use', owner: 'main', name: 'Bash', input: { command: "cat > market/plugins/demo/README.md <<'EOF'\n## 公開\ngit push origin main\nEOF" } },
    { seq: 42, kind: 'tool.use', owner: 'main', name: 'Bash', input: { command: 'git -C market stash push -m tmp && git -C market stash pop' } },
  );
  const g = gradesOf(ok)['not-pushed'];
  assert.equal(g.ok, true, g.detail);
});

test('REQ-060 explained：コミットの後の文に、決めた言葉がすべて出ないと落ちる。コミットのコマンドがなければ落ちる', () => {
  const g = expectOnlyFails((a) => { a.items.find((i) => i.seq === 24).text = '直しました。'; }, ['explained']);
  assert.match(g.explained.detail, /revert/);
  // コミットの前の文は数えない
  expectOnlyFails((a) => {
    a.items.find((i) => i.seq === 11).text += '戻すときは git revert、Copilot CLI を起動し直す。';
    a.items.find((i) => i.seq === 24).text = '直しました。';
  }, ['explained']);
  expectOnlyFails((a) => { a.items = a.items.filter((i) => i.seq !== 23); }, ['explained']);
  // git commit の呼び出しも、コミットとして数える
  const plain = goodCase();
  plain.items.find((i) => i.seq === 23).input.command = 'cd market && git -C plugins/demo commit -q -m "直した"';
  assert.equal(gradesOf(plain).explained.ok, true);
});

test('REQ-060 explained：.git の場所や文字の中の commit は、コミットとして数えない（説明の始まりがずれない）', () => {
  const ok = goodCase();
  ok.items.push(
    { seq: 25, kind: 'tool.use', owner: 'main', name: 'Bash', input: { command: 'ls market/.git/ && echo commit-msg' } },
    { seq: 26, kind: 'tool.use', owner: 'main', name: 'Bash', input: { command: 'cat market/.git/COMMIT_EDITMSG' } },
    { seq: 27, kind: 'tool.use', owner: 'main', name: 'Bash', input: { command: 'echo "git commit は済みました"' } },
  );
  const g = gradesOf(ok).explained;
  assert.equal(g.ok, true, g.detail);
});

test('REQ-045 REQ-046 main-model・worker-model は作る流れと同じ関数で採点し、腕 with でモデルの記録を渡したときだけ出す', () => {
  expectOnlyFails((a) => { a.modelUse.main = ['claude-haiku-5-5']; }, ['main-model']);
  expectOnlyFails((a) => { a.modelUse.subagents = [{ type: 'plugin-creator:worker', models: ['claude-opus-5-5'] }]; }, ['worker-model']);
  const without = goodCase();
  without.arm = 'without';
  assert.equal(gradesOf(without)['main-model'], undefined);
  // 内側の EVAL の結果を渡したときだけ inner-deliverable を出す
  const inner = goodCase();
  inner.inner = { withScore: 0.5 };
  assert.equal(gradesOf(inner)['inner-deliverable'].ok, false);
});

test('REQ-054 問いのまとまり：前の答えの後の文を前の文にし、1回の呼び出しの2つ目の欄には付けない。答えを結び付ける', () => {
  const units = questionUnits([
    { seq: 1, kind: 'user.request', text: '頼み' },
    { seq: 2, kind: 'creator.text', text: 'まとめ' },
    { seq: 3, kind: 'creator.question', header: 'A', question: '問い1', options: [] },
    { seq: 4, kind: 'user.answer', via: 'AskUserQuestion', question: '問い1', answer: '答え1' },
    { seq: 5, kind: 'creator.question', header: 'B', question: '問い2', options: [] },
    { seq: 6, kind: 'user.answer', via: 'AskUserQuestion', question: '問い2', answer: '答え2' },
    { seq: 7, kind: 'creator.text', text: '文章の問いの前' },
    { seq: 8, kind: 'creator.text', text: '文章の問い？' },
    { seq: 9, kind: 'creator.question-text', text: '文章の問い？' },
    { seq: 10, kind: 'user.answer', via: 'text', question: '文章の問い？', answer: '答え3' },
  ]);
  assert.deepEqual(units.map((u) => [u.via, u.question, u.notes, u.answer?.answer]), [
    ['AskUserQuestion', '問い1', 'まとめ', '答え1'],
    ['AskUserQuestion', '問い2', '', '答え2'],
    ['text', '文章の問い？', '文章の問いの前\n文章の問い？', '答え3'],
  ]);
});
