// 中心の処理：Issue の起票（設計書 4.11、10章「起票」）。偽物の gh（実行ファイル）を使う。
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as realSleep } from 'node:timers/promises';
import test from 'node:test';
import { createFakeGh, expectRefusal, github, LIMITS, makeHarness } from './harness.mjs';

const REPO = 'example/weekly-report';

// 偽物の gh は、拡張子のない shebang の実行ファイルなので、Windows の spawn では動かせない。
// 偽物の gh を使う試験は、Windows では飛ばす（gh の呼び出しは、ひな形の外の最終確認で見る）。
const FAKE_GH_SKIP = process.platform === 'win32' ? '偽物の gh（拡張子のない実行ファイル）は Windows の spawn で動かせないため、飛ばす' : false;
const gtest = (name, fn) => test(name, { skip: FAKE_GH_SKIP }, fn);

function newGh(t) {
  const dir = mkdtempSync(join(tmpdir(), 'a1-gh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createFakeGh(dir);
}

async function waitFor(fn, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return;
    await realSleep(10);
  }
  throw new Error('待っていた条件が満たされませんでした');
}

// 実行を最後まで動かして、統括が Issue の案を足した状態にする
async function finishedRun(h, issues = [{ title: '統括の案', body: '振り返りで見つけたこと' }]) {
  await h.toSummarizing();
  for (const issue of issues) await h.tool('issue', issue, h.root);
  await h.tool('finish', { summary: 'まとめ' }, h.root);
  await h.rootIdle();
  await h.clock.advance(100);
  return h.run();
}

const markerOf = (h, runId, issueId) => `<!-- weekly-report-issue:${runId}/${issueId} -->`;
const markerFile = (h, runId, issueId) => join(h.dataRoot, runId, 'issues', `${issueId}.json`);
const createCalls = (gh) => gh.calls().filter((c) => c.args[0] === 'issue' && c.args[1] === 'create');
const filingOf = (h, issueId) => h.run().issues.find((i) => i.id === issueId).filing;

gtest('REQ-014 案を承認すると、gh で起票され、できた Issue の URL が出る。承認していない案は起票されない', async (t) => {
  const gh = newGh(t);
  const h = await makeHarness(t, { gh });
  const run = await finishedRun(h, [{ title: '案 1', body: '本文 1' }, { title: '案 2', body: '本文 2' }]);
  const result = await h.core.fileIssue('O1');
  assert.deepEqual(result, { state: 'filed', url: 'https://github.com/example/weekly-report/issues/1' });
  const calls = createCalls(gh);
  assert.equal(calls.length, 1, '承認していない案は起票されない');
  assert.deepEqual(calls[0].args, ['issue', 'create', '--repo', REPO, '--title', '案 1', '--body-file', '-']);
  // 本文は標準入力で渡し、終わりに案ごとの印が付く
  assert.ok(calls[0].stdin.startsWith('本文 1\n'));
  assert.ok(calls[0].stdin.includes(markerOf(h, run.id, 'O1')));
  assert.ok(!calls[0].stdin.includes(markerOf(h, run.id, 'O2')));
  assert.deepEqual(filingOf(h, 'O1'), { state: 'filed', url: 'https://github.com/example/weekly-report/issues/1', reason: null });
  assert.equal(filingOf(h, 'O2').state, 'none');
  // 起票の状態は、案ごとの印のファイルに書く
  const marker = JSON.parse(readFileSync(markerFile(h, run.id, 'O1'), 'utf8'));
  assert.equal(marker.state, 'filed');
  assert.equal(marker.url, 'https://github.com/example/weekly-report/issues/1');
});

gtest('REQ-014 題と本文は、シェルを通さず、引数の配列と標準入力でそのまま渡される', async (t) => {
  const gh = newGh(t);
  const h = await makeHarness(t, { gh });
  const title = '"; touch /tmp/pwned; echo "$(whoami) `id` $HOME \' \\';
  const body = '本文 $(rm -rf /) `x` ; && | > file\n2 行目';
  await finishedRun(h, [{ title, body }]);
  await h.core.fileIssue('O1');
  const [call] = createCalls(gh);
  assert.equal(call.args[call.args.indexOf('--title') + 1], title);
  assert.ok(call.stdin.startsWith(body));
});

gtest('REQ-014 同じ案を 2 回続けて承認しても、1 件だけ起票される', async (t) => {
  const gh = newGh(t);
  const h = await makeHarness(t, { gh });
  await finishedRun(h);
  const results = await Promise.allSettled([h.core.fileIssue('O1'), h.core.fileIssue('O1')]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.match(results.find((r) => r.status === 'rejected').reason.message, /起票しています|起票しました/);
  assert.equal(createCalls(gh).length, 1);
  assert.match(await expectRefusal(h.core.fileIssue('O1')), /すでに起票しました/);
  assert.equal(createCalls(gh).length, 1);
});

gtest('REQ-014 2 つのセッションから同じ案を承認しても、1 件だけ起票される', async (t) => {
  const gh = newGh(t);
  const a = await makeHarness(t, { gh, sessionId: 's1' });
  await finishedRun(a);
  const b = await makeHarness(t, { reuse: a, gh, sessionId: 's2' });
  await b.core.open({ requestText: 'x' });
  const results = await Promise.allSettled([a.core.fileIssue('O1'), b.core.fileIssue('O1')]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(createCalls(gh).length, 1);
  // 準備中に開けた前の結果の案にも、起票の状態が見える
  assert.equal(b.state().previous.issues[0].filing.state, 'filed');
});

gtest('REQ-014 同じ記録を見ているほかの Copilot CLI が先に印を作っていたときは、「ほかの Copilot CLI が、この案を起票しています」と断り、起票しない', async (t) => {
  const gh = newGh(t);
  const h = await makeHarness(t, { gh });
  const run = await finishedRun(h);
  // ほかのプロセスが印を書いている途中（読めない形）。こちらは印を作れない
  writeFileSync(markerFile(h, run.id, 'O1'), '{"runId":');
  const message = await expectRefusal(h.core.fileIssue('O1'));
  assert.equal(message, 'ほかの Copilot CLI が、この案を起票しています。');
  assert.doesNotMatch(message, /セッション/, '説明のない言葉を使わない（REQ-025）');
  assert.equal(createCalls(gh).length, 0);
});

gtest('REQ-014 準備中に開けた前の実行の案も、承認して起票できる', async (t) => {
  const gh = newGh(t);
  const h = await makeHarness(t, { gh });
  const run = await finishedRun(h);
  await h.core.open({ requestText: '次の依頼' });
  assert.equal(h.state().run, null);
  const result = await h.core.fileIssue('O1');
  assert.equal(result.state, 'filed');
  assert.equal(h.state().previous.issues[0].filing.state, 'filed');
  assert.equal(JSON.parse(readFileSync(markerFile(h, run.id, 'O1'), 'utf8')).state, 'filed');
});

gtest('REQ-014 gh が失敗すると、印が失敗になり、理由が出て、もう一度承認できる', async (t) => {
  const gh = newGh(t);
  const h = await makeHarness(t, { gh });
  await finishedRun(h);
  gh.configure({
    '--version': { stdout: 'gh' },
    'auth status': { stdout: 'ok' },
    'issue create': { code: 1, stderr: 'HTTP 401: Bad credentials' },
    'issue list': { stdout: '[]' },
  });
  const message = await expectRefusal(h.core.fileIssue('O1'));
  assert.match(message, /gh が失敗しました/);
  assert.match(message, /Bad credentials/);
  assert.equal(filingOf(h, 'O1').state, 'failed');
  assert.match(filingOf(h, 'O1').reason, /Bad credentials/);
  // 直してもう一度承認する。失敗の印は退けられ、新しい印で起票される
  gh.configure({
    '--version': { stdout: 'gh' },
    'auth status': { stdout: 'ok' },
    'issue create': { stdout: 'https://github.com/example/weekly-report/issues/5\n' },
    'issue list': { stdout: '[]' },
  });
  const result = await h.core.fileIssue('O1');
  assert.equal(result.url, 'https://github.com/example/weekly-report/issues/5');
  assert.equal(filingOf(h, 'O1').state, 'filed');
  assert.equal(createCalls(gh).length, 2);
  assert.equal(gh.calls().filter((c) => c.args[1] === 'list').length, 0, '失敗の後は、起票していないと分かっているので探さない');
});

gtest('REQ-014 gh が時間の上限を超えると、止めて、印が「起票したか分からない」になる', async (t) => {
  const gh = newGh(t);
  const h = await makeHarness(t, { gh });
  const run = await finishedRun(h);
  gh.configure({ '--version': { stdout: 'gh' }, 'auth status': { stdout: 'ok' }, 'issue create': { hang: true }, 'issue list': { stdout: '[]' } });
  const refusal = expectRefusal(h.core.fileIssue('O1'));
  await waitFor(() => createCalls(gh).length === 1);
  assert.equal(filingOf(h, 'O1').state, 'filing');
  await h.clock.advance(LIMITS.GH_TIMEOUT_MS);
  const message = await refusal;
  assert.match(message, /起票できたかは分かりません/);
  assert.deepEqual([filingOf(h, 'O1').state, JSON.parse(readFileSync(markerFile(h, run.id, 'O1'), 'utf8')).state], ['unknown', 'unknown']);
});

gtest('REQ-014 起票中のまま 5 分過ぎた印も、「起票したか分からない」と読む。もう一度承認できる', async (t) => {
  const gh = newGh(t);
  const h = await makeHarness(t, { gh });
  const run = await finishedRun(h);
  // Copilot CLI ごと終わって、起票中の印だけが残った
  writeFileSync(markerFile(h, run.id, 'O1'), JSON.stringify({ runId: run.id, issueId: 'O1', attempt: 'old', state: 'filing', startedAt: h.clock.now(), url: null, reason: null }));
  assert.equal(filingOf(h, 'O1').state, 'filing');
  assert.match(await expectRefusal(h.core.fileIssue('O1')), /いま起票しています/);
  await h.clock.advance(LIMITS.FILING_STALE_MS + 1);
  assert.equal(filingOf(h, 'O1').state, 'unknown');
  // もう一度承認すると、起票したかを探してから起票する
  const result = await h.core.fileIssue('O1');
  assert.equal(result.state, 'filed');
  assert.equal(gh.calls().filter((c) => c.args[1] === 'list').length, 1);
  assert.equal(createCalls(gh).length, 1);
  assert.ok(readdirSync(join(h.dataRoot, run.id, 'issues')).some((f) => f.includes('.old-')), '前の印は名前を変えて退けられる');
});

gtest('REQ-014 起票したか分からない案をもう一度承認すると、本文にその案の印がある Issue があれば、その URL を起票済みにする', async (t) => {
  const gh = newGh(t);
  const h = await makeHarness(t, { gh });
  const run = await finishedRun(h);
  gh.configure({ '--version': { stdout: 'gh' }, 'auth status': { stdout: 'ok' }, 'issue create': { hang: true }, 'issue list': { stdout: '[]' } });
  const first = expectRefusal(h.core.fileIssue('O1'));
  await waitFor(() => createCalls(gh).length === 1);
  await h.clock.advance(LIMITS.GH_TIMEOUT_MS);
  await first;
  // 実は送信は済んでいた
  gh.configure({
    '--version': { stdout: 'gh' },
    'auth status': { stdout: 'ok' },
    'issue create': { stdout: 'https://github.com/example/weekly-report/issues/99\n' },
    'issue list': {
      stdout: [
        { title: '別の Issue', url: 'https://github.com/example/weekly-report/issues/3', body: '無関係' },
        { title: '統括の案', url: 'https://github.com/example/weekly-report/issues/7', body: `振り返りで見つけたこと\n\n${markerOf(h, run.id, 'O1')}\n` },
      ],
    },
  });
  const result = await h.core.fileIssue('O1');
  assert.deepEqual(result, { state: 'filed', url: 'https://github.com/example/weekly-report/issues/7' });
  assert.equal(createCalls(gh).length, 1, '二重に起票しない');
  const list = gh.calls().find((c) => c.args[1] === 'list');
  assert.deepEqual(list.args, ['issue', 'list', '--repo', REPO, '--state', 'all', '--limit', '100', '--json', 'title,url,body']);
  assert.equal(filingOf(h, 'O1').url, 'https://github.com/example/weekly-report/issues/7');
});

gtest('REQ-014 探して見つからなければ起票する。前の実行に同じ題の Issue があっても、今回の案は起票される', async (t) => {
  const gh = newGh(t);
  const h = await makeHarness(t, { gh });
  await finishedRun(h);
  gh.configure({ '--version': { stdout: 'gh' }, 'auth status': { stdout: 'ok' }, 'issue create': { hang: true }, 'issue list': { stdout: '[]' } });
  const first = expectRefusal(h.core.fileIssue('O1'));
  await waitFor(() => createCalls(gh).length === 1);
  await h.clock.advance(LIMITS.GH_TIMEOUT_MS);
  await first;
  gh.configure({
    '--version': { stdout: 'gh' },
    'auth status': { stdout: 'ok' },
    'issue create': { stdout: 'https://github.com/example/weekly-report/issues/12\n' },
    'issue list': { stdout: [{ title: '統括の案', url: 'https://github.com/example/weekly-report/issues/2', body: '前の実行の Issue\n\n<!-- weekly-report-issue:20260101-000000-aaaaaa/O1 -->' }] },
  });
  const result = await h.core.fileIssue('O1');
  assert.equal(result.url, 'https://github.com/example/weekly-report/issues/12');
  assert.equal(createCalls(gh).length, 2);
});

gtest('REQ-014 探す処理が失敗するか時間の上限を超えると、起票せず、「起票したか分からない」のままになる', async (t) => {
  const gh = newGh(t);
  const h = await makeHarness(t, { gh });
  await finishedRun(h);
  const timeout = { '--version': { stdout: 'gh' }, 'auth status': { stdout: 'ok' }, 'issue create': { hang: true }, 'issue list': { stdout: '[]' } };
  gh.configure(timeout);
  const first = expectRefusal(h.core.fileIssue('O1'));
  await waitFor(() => createCalls(gh).length === 1);
  await h.clock.advance(LIMITS.GH_TIMEOUT_MS);
  await first;

  // 探す処理が失敗する
  gh.configure({ ...timeout, 'issue list': { code: 1, stderr: 'network down' } });
  assert.match(await expectRefusal(h.core.fileIssue('O1')), /確かめられません/);
  assert.equal(filingOf(h, 'O1').state, 'unknown');
  assert.equal(createCalls(gh).length, 1, '起票に進まない');

  // 探す処理が時間の上限を超える
  gh.configure({ ...timeout, 'issue list': { hang: true } });
  const second = expectRefusal(h.core.fileIssue('O1'));
  await waitFor(() => gh.calls().filter((c) => c.args[1] === 'list').length === 2);
  await h.clock.advance(LIMITS.GH_TIMEOUT_MS);
  assert.match(await second, /時間の上限を超えた/);
  assert.equal(filingOf(h, 'O1').state, 'unknown');
  assert.equal(createCalls(gh).length, 1);
});

gtest('REQ-014 前の試みの結果が、新しい印を上書きしない', async (t) => {
  const gh = newGh(t);
  const h = await makeHarness(t, { gh });
  const run = await finishedRun(h);
  gh.configure({ '--version': { stdout: 'gh' }, 'auth status': { stdout: 'ok' }, 'issue create': { hang: true }, 'issue list': { stdout: '[]' } });
  const first = expectRefusal(h.core.fileIssue('O1'));
  await waitFor(() => createCalls(gh).length === 1);
  // 別のセッションが、印を退けて、自分の印を作り、起票を終えた
  const path = markerFile(h, run.id, 'O1');
  renameSync(path, `${path}.old-other`);
  writeFileSync(path, JSON.stringify({ runId: run.id, issueId: 'O1', attempt: 'other-session', state: 'filed', startedAt: h.clock.now(), url: 'https://github.com/example/weekly-report/issues/40', reason: null }));
  await h.clock.advance(LIMITS.GH_TIMEOUT_MS);
  await first;
  const marker = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(marker.attempt, 'other-session');
  assert.equal(marker.state, 'filed');
  assert.equal(filingOf(h, 'O1').url, 'https://github.com/example/weekly-report/issues/40');
});

gtest('REQ-014 起票できるときは、起票できる印と、リポジトリが状態に入る', async (t) => {
  const gh = newGh(t);
  const h = await makeHarness(t, { gh });
  await finishedRun(h);
  await h.core.open({ requestText: 'x' });
  await waitFor(() => h.state().previous?.canFile.code !== 'checking');
  assert.deepEqual(h.state().previous.canFile, { ok: true, reason: null, code: null, steps: [], repo: REPO });
});

// 起票できないときの理由と手順を、状態から読む（偽物の gh がなくても確かめられる場合）
async function canFileOf(h) {
  await finishedRun(h);
  await h.core.open({ requestText: 'x' });
  await waitFor(() => h.state().previous?.canFile.code !== 'checking');
  return h.state().previous.canFile;
}

test('REQ-014 repository がないときと GitHub の URL でないときは、起票できず、理由と直し方が出る。直し方は入れ方ごとの反映のしかたを書く', async (t) => {
  for (const c of [
    { name: 'repository がない', repository: '', code: 'no_repository', reason: /repository が書かれていません/ },
    { name: 'GitHub の URL でない', repository: 'https://gitlab.com/example/weekly-report', code: 'not_github', reason: /GitHub の URL ではありません/ },
  ]) {
    const h = await makeHarness(t, { gh: null, repository: c.repository }); // gh は入っていない環境でも、repository の手順は出る
    const canFile = await canFileOf(h);
    assert.equal(canFile.ok, false, c.name);
    assert.equal(canFile.code, c.code, c.name);
    assert.match(canFile.reason, c.reason, c.name);
    const step = canFile.steps.find((s) => /repository/.test(s));
    assert.ok(step, `${c.name}：${canFile.steps.join(' / ')}`);
    // 手元のフォルダから入れたものはコピーされず、起動し直すと読まれる。GitHub などから入れたときは、アンインストールしてから、もう一度インストールする
    assert.match(step, /手元のフォルダからインストールしたときは、Copilot CLI を終了して起動し直すか、\/clear で新しい会話を始める/);
    assert.match(step, /GitHub などからインストールしたときは、直した plugin\.json を GitHub に送り、このプラグインをアンインストールしてから、もう一度インストールする/);
    assert.doesNotMatch(step, /入れ直|反映/, '比喩やぼかした言葉を使わず、することを書く（REQ-025）');
    assert.doesNotMatch(step, /コピー|セッション/, '入れ方によらず「コピー」とは書かず、説明のない「セッション」を使わない（REQ-025）');
    assert.ok(canFile.steps.some((s) => /公開する/.test(s)), c.name);
    // 案は並ぶが、承認しても起票されない
    assert.equal(h.state().previous.issues.length, 1, c.name);
    assert.match(await expectRefusal(h.core.fileIssue('O1')), /起票できません/, c.name);
  }
});

test('REQ-014 gh がないときは、起票できず、gh を入れてログインする直し方が出る', async (t) => {
  const h = await makeHarness(t, { gh: null });
  const canFile = await canFileOf(h);
  assert.deepEqual([canFile.ok, canFile.code, canFile.repo], [false, 'no_gh', REPO]);
  assert.ok(canFile.steps.some((s) => /gh（GitHub の公式のコマンド）を入れて/.test(s)));
  assert.match(await expectRefusal(h.core.fileIssue('O1')), /起票できません/);
});

gtest('REQ-014 gh が認証できないときは、起票できず、ログインする直し方が出る。承認しても gh で起票しない', async (t) => {
  const gh = newGh(t);
  gh.configure({ '--version': { stdout: 'gh' }, 'auth status': { code: 1, stderr: 'not logged in' }, 'issue create': { stdout: 'https://x/1' }, 'issue list': { stdout: '[]' } });
  const h = await makeHarness(t, { gh });
  const canFile = await canFileOf(h);
  assert.deepEqual([canFile.ok, canFile.code], [false, 'not_logged_in']);
  assert.ok(canFile.reason.length > 0);
  assert.ok(canFile.steps.some((s) => /gh auth login/.test(s)));
  assert.match(await expectRefusal(h.core.fileIssue('O1')), /起票できません/);
  assert.equal(createCalls(gh).length, 0);
});

test('REQ-014 リポジトリは plugin.json の repository（GitHub の URL）から OWNER/REPO を取り出す', () => {
  const parse = github.parseGithubRepo;
  assert.equal(parse('https://github.com/example/weekly-report'), 'example/weekly-report');
  assert.equal(parse('https://github.com/example/weekly-report.git'), 'example/weekly-report');
  assert.equal(parse('https://github.com/example/weekly-report/'), 'example/weekly-report');
  assert.equal(parse('git+https://github.com/example/weekly-report.git'), 'example/weekly-report');
  assert.equal(parse('git@github.com:example/weekly-report.git'), 'example/weekly-report');
  assert.equal(parse({ type: 'git', url: 'https://github.com/example/weekly-report' }), 'example/weekly-report');
  assert.equal(parse('https://github.com/example'), null);
  assert.equal(parse('https://gitlab.com/example/weekly-report'), null);
  assert.equal(parse('https://example.com/github.com/a/b'), null);
  assert.equal(parse(''), null);
  assert.equal(parse(undefined), null);
});

gtest('REQ-014 起票の状態は result.json に書き足さない', async (t) => {
  const gh = newGh(t);
  const h = await makeHarness(t, { gh });
  const run = await finishedRun(h);
  const before = readFileSync(join(h.dataRoot, run.id, 'result.json'), 'utf8');
  await h.core.fileIssue('O1');
  assert.equal(readFileSync(join(h.dataRoot, run.id, 'result.json'), 'utf8'), before);
});

gtest('REQ-014 知らない案、実行中の案は承認できない', async (t) => {
  const gh = newGh(t);
  const h = await makeHarness(t, { gh });
  await finishedRun(h);
  assert.match(await expectRefusal(h.core.fileIssue('Z9')), /見つかりません/);
  const g = await makeHarness(t, { gh });
  await g.begin();
  assert.match(await expectRefusal(g.core.fileIssue('O1')), /見つかりません/);
});
