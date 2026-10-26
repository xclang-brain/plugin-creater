import { ABORT_REASON_TEXT, LIMITS, PHASE_LABELS, ROLE_LABELS, SUMMARY_END_KINDS } from './constants.mjs';
import { RECORD_TOOL_NAMES } from './tools.mjs';
import { stableStringify, summarizeText } from './util.mjs';

// 記録（log.jsonl の行）から、課題とまとめを機械的に作る（4.10）。
// 実行が終わるときと、途中で切れた実行を読み直すときの両方で、同じ関数を使う。
// 画面に出す文字なので、平易な日本語で書く（REQ-025）。

// 'weekly-report:worker' → 'worker'
export function baseAgentName(agentType, pluginName) {
  const s = String(agentType ?? '');
  const prefix = `${pluginName}:`;
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

export function roleOfAgentType(agentType, pluginName) {
  const base = baseAgentName(agentType, pluginName);
  if (base === 'orchestrator') return 'orchestrator';
  if (base === 'verifier') return 'verifier';
  if (base.startsWith('worker')) return 'worker';
  return null;
}

// 記録の行から、試行ごとの形（実行中の状態の iterations と同じ形）を作る
export function iterationsFromEntries(entries, userCriteria = []) {
  const iterations = [];
  const byN = new Map();
  let current = null;
  const agentRoles = new Map();
  for (const entry of entries) {
    if (entry.t === 'record' && entry.tool === 'plan') {
      const a = entry.args ?? {};
      const it = {
        n: a.iteration,
        criteria: (a.criteria ?? []).map((c) => ({
          id: c.id,
          text: c.text,
          fromUser: userCriteria.some((u) => u.id === c.id && u.text === c.text),
        })),
        plan: a.plan ?? '',
        verdicts: null,
        agentIds: [],
      };
      iterations.push(it);
      byN.set(it.n, it);
      current = it;
    } else if (entry.t === 'record' && entry.tool === 'verdict') {
      const it = byN.get(entry.args?.iteration);
      if (it) it.verdicts = (entry.args.verdicts ?? []).map((v) => ({ criterionId: v.criterionId, pass: v.pass === true, note: v.note ?? '' }));
    } else if (entry.t === 'event' && entry.e?.type === 'agent.started') {
      const e = entry.e;
      agentRoles.set(e.agentId, e.agentType);
      if (current && e.parentAgentId) current.agentIds.push(e.agentId);
    }
  }
  return iterations;
}

function passCount(it) {
  return it.verdicts ? it.verdicts.filter((v) => v.pass).length : 0;
}

// 止めた・終わった時点の機械的なまとめ（試行の数、最後の合否、フェーズ）
export function buildMechanicalSummary({ iterations, phase }) {
  const phaseText = phase && PHASE_LABELS[phase] ? `終わった時点のフェーズは「${PHASE_LABELS[phase]}」でした。` : '';
  if (iterations.length === 0) {
    return `計画が記録される前に終わりました。${phaseText}`.trim();
  }
  const last = iterations[iterations.length - 1];
  const judged = last.verdicts
    ? `最後の試行は、評価基準 ${last.criteria.length} 件中 ${passCount(last)} 件が合格でした。`
    : '最後の試行は、合否が記録される前に終わりました。';
  return `試行は ${iterations.length} 回です。${judged}${phaseText}`.trim();
}

// 統括が振り返るために返す文（<名前>_review の返り値）
export function formatReviewText({ pluginName, issues, iterations, finishRecorded }) {
  const lines = [];
  lines.push('機械的に洗い出した課題：');
  if (issues.length === 0) lines.push('- 見つかった課題はありません。');
  for (const issue of issues) lines.push(`- ${issue.title}`);
  lines.push('');
  lines.push('記録の要点：');
  if (iterations.length === 0) lines.push('- 試行の記録がありません。');
  for (const it of iterations) {
    if (!it.verdicts) {
      lines.push(`- 試行 ${it.n}：合否の記録がありません。`);
      continue;
    }
    const failed = it.verdicts.filter((v) => !v.pass);
    const head = `- 試行 ${it.n}：評価基準 ${it.criteria.length} 件中 ${passCount(it)} 件が合格。`;
    if (failed.length === 0) {
      lines.push(head);
    } else {
      lines.push(`${head}不合格：${failed.map((v) => `${v.criterionId}${v.note ? `（${summarizeText(v.note, 80)}）` : ''}`).join('、')}`);
    }
  }
  lines.push('');
  lines.push(
    finishRecorded
      ? '実行全体のまとめは、すでに記録されています。'
      : `振り返って、このプラグイン自身の改善につながる課題があれば ${pluginName}_issue で Issue の案を足し、最後に ${pluginName}_finish で実行全体のまとめを記録してください。`,
  );
  return lines.join('\n');
}

function roleLabel(role) {
  return ROLE_LABELS[role] ?? 'エージェント';
}

function minutes(ms) {
  return Math.floor(ms / 60_000);
}

// 機械的に洗い出した課題。返り値は { title, body } の配列。
// opts：{ pluginName, runId, endReason, endAt, unstopped:[{agentId, role}], isAuto, models:{orchestrator,worker,verifier}, userCriteria }
export function analyzeEntries(entries, opts) {
  const { pluginName, runId, endReason, endAt, unstopped = [], isAuto = false, models = {}, cause = null } = opts;
  const agents = new Map();
  const toolFailures = new Map();
  const agentFailures = [];
  const repeats = [];
  const nonSync = [];
  const stalled = new Map();
  const last = new Map();
  const waiting = new Map();
  const lastSig = new Map();
  const iterations = [];
  let current = null;
  let retryLimit = false;
  let finishRecorded = false;

  const chain = (id) => {
    const out = [];
    const seen = new Set();
    let cur = id;
    while (cur && agents.has(cur) && !seen.has(cur)) {
      out.push(cur);
      seen.add(cur);
      cur = agents.get(cur).parent;
    }
    return out;
  };
  const roleOf = (id) => {
    for (const x of chain(id)) if (agents.get(x).role) return agents.get(x).role;
    return null;
  };
  // 人の判断待ち（4.15）の時間は、イベントがない時間に数えない。待ちが終わったとき、それまでの最後の時刻を待ちの長さだけ後ろにずらす
  let humanSince = null;
  const endHumanWait = (at) => {
    if (humanSince === null || !Number.isFinite(at)) return;
    const gap = Math.max(0, at - humanSince);
    for (const [id, prev] of last) last.set(id, prev <= humanSince ? prev + gap : at);
    humanSince = null;
  };
  const touch = (id, at) => {
    for (const x of chain(id)) {
      const prev = last.get(x);
      if (prev !== undefined && at - prev >= LIMITS.STALL_MS && !(waiting.get(x) > 0) && !stalled.has(x)) {
        stalled.set(x, at - prev);
      }
      last.set(x, at);
    }
  };

  for (const entry of entries) {
    if (entry.t === 'note' && entry.kind === 'retry_limit') retryLimit = true;
    if (entry.t === 'status' && Number.isFinite(entry.at)) {
      if (entry.status === 'waiting_human') humanSince ??= entry.at;
      else endHumanWait(entry.at);
    }
    if (entry.t === 'record') {
      if (entry.tool === 'finish') finishRecorded = true;
      if (entry.tool === 'plan') {
        current = { n: entry.args?.iteration, workers: [], verifiers: [], judged: false };
        iterations.push(current);
      } else if (entry.tool === 'verdict') {
        const it = iterations.find((x) => x.n === entry.args?.iteration);
        if (it) it.judged = true;
      }
    }
    if (entry.t !== 'event' || !entry.e) continue;
    const e = entry.e;
    const at = Number.isFinite(entry.at) ? entry.at : (e.at ?? 0);
    switch (e.type) {
      case 'agent.started': {
        agents.set(e.agentId, {
          id: e.agentId,
          parent: e.parentAgentId ?? null,
          type: e.agentType,
          role: roleOfAgentType(e.agentType, pluginName),
          model: e.model ?? null,
          ended: false,
        });
        if (e.parentAgentId && e.executionMode && e.executionMode !== 'sync') {
          nonSync.push({ agentId: e.agentId, type: baseAgentName(e.agentType, pluginName), mode: e.executionMode });
        }
        const role = agents.get(e.agentId).role;
        if (current && role === 'worker') current.workers.push(e.agentId);
        if (current && role === 'verifier') current.verifiers.push(e.agentId);
        touch(e.agentId, at);
        break;
      }
      case 'agent.configured': {
        const a = agents.get(e.agentId);
        if (a && e.model) a.model = e.model;
        touch(e.agentId, at);
        break;
      }
      case 'agent.completed':
      case 'agent.idle': {
        const a = agents.get(e.agentId);
        if (a) a.ended = true;
        touch(e.agentId, at);
        break;
      }
      case 'agent.failed': {
        const a = agents.get(e.agentId);
        if (a) a.ended = true;
        agentFailures.push({ agentId: e.agentId, error: e.error });
        touch(e.agentId, at);
        break;
      }
      case 'tool.started': {
        touch(e.agentId, at);
        if (e.arguments !== undefined) {
          const sig = `${e.toolName}\u0000${stableStringify(e.arguments)}`;
          const prev = lastSig.get(e.agentId);
          if (prev && prev.sig === sig) {
            prev.count += 1;
            if (prev.count === LIMITS.REPEAT_COUNT) {
              prev.record = { agentId: e.agentId, tool: e.toolName, count: prev.count };
              repeats.push(prev.record);
            } else if (prev.record) {
              prev.record.count = prev.count;
            }
          } else {
            lastSig.set(e.agentId, { sig, count: 1, record: null });
          }
        }
        break;
      }
      case 'tool.completed': {
        touch(e.agentId, at);
        // 記録のツールの断りは、決まりを守らせるふつうの動き。続けて断られた場合は、やり直しの上限の課題になる
        const isRecordTool = RECORD_TOOL_NAMES.some((n) => String(e.toolName).endsWith(`${pluginName}_${n}`));
        if (e.success === false && !isRecordTool) {
          const role = roleOf(e.agentId);
          const key = `${role}|${e.toolName}`;
          const f = toolFailures.get(key) ?? { role, tool: e.toolName, count: 0, firstError: e.error ?? '' };
          f.count += 1;
          toolFailures.set(key, f);
        }
        break;
      }
      case 'wait.started': {
        if (e.agentId) {
          touch(e.agentId, at);
          for (const x of chain(e.agentId)) waiting.set(x, (waiting.get(x) ?? 0) + 1);
        }
        break;
      }
      case 'wait.ended': {
        // どのエージェントの待ちかは、始めのイベントでしか分からないので、待ちの数は始めに合わせて数える
        const a = e.agentId;
        if (a) {
          touch(a, at);
          for (const x of chain(a)) waiting.set(x, Math.max(0, (waiting.get(x) ?? 0) - 1));
        }
        break;
      }
      default:
        break;
    }
  }

  // 終わった時点で、まだ終わっていないエージェントの沈黙
  const unstoppedIds = new Set(unstopped.map((u) => u.agentId));
  if (Number.isFinite(endAt)) {
    endHumanWait(endAt);
    for (const a of agents.values()) {
      if (a.ended || unstoppedIds.has(a.id) || stalled.has(a.id) || waiting.get(a.id) > 0) continue;
      const l = last.get(a.id);
      if (l !== undefined && endAt - l >= LIMITS.STALL_MS) stalled.set(a.id, endAt - l);
    }
  }

  const issues = [];
  const add = (title, lines) => issues.push({ title, body: lines.filter((l) => l !== null).join('\n') });
  const runLine = `実行の番号：${runId}`;

  // 1. 実行の失敗
  if (endReason?.kind === 'aborted') {
    const reasonText = ABORT_REASON_TEXT[endReason.detail] ?? '理由は分かりません';
    add(`実行が途中で終わりました（${reasonText}）`, [
      `評価基準をすべて満たす前に、実行が途中で終わりました。理由：${reasonText}。`,
      endReason.message ? `くわしい内容：${summarizeText(endReason.message, 300)}` : null,
      runLine,
    ]);
  }
  for (const f of toolFailures.values()) {
    add(`ツール「${f.tool}」が失敗しました（${roleLabel(f.role)}）`, [
      `${roleLabel(f.role)}が使った「${f.tool}」が ${f.count} 回失敗しました。`,
      f.firstError ? `最初の失敗の内容：${summarizeText(f.firstError, 300)}` : null,
      runLine,
    ]);
  }
  for (const f of agentFailures) {
    const role = roleOf(f.agentId);
    add(`${roleLabel(role)}が失敗しました`, [
      `${roleLabel(role)}（番号：${f.agentId}）が失敗して終わりました。`,
      f.error ? `失敗の内容：${summarizeText(f.error, 300)}` : null,
      runLine,
    ]);
  }

  // 2. 詰まり・止まり
  for (const [id, gap] of stalled) {
    const role = roleOf(id);
    add(`${roleLabel(role)}が ${minutes(gap)} 分以上動きませんでした`, [
      `${roleLabel(role)}（番号：${id}）から ${minutes(gap)} 分以上、何の知らせもありませんでした。詰まっていた可能性があります。`,
      runLine,
    ]);
  }
  for (const r of repeats) {
    const role = roleOf(r.agentId);
    add(`${roleLabel(role)}が同じ「${r.tool}」を同じ内容で繰り返しました`, [
      `${roleLabel(role)}（番号：${r.agentId}）が、同じツール「${r.tool}」を同じ内容で ${r.count} 回続けて呼びました。`,
      runLine,
    ]);
  }
  for (const u of unstopped) {
    add(`止めても止まらないエージェントがありました（${roleLabel(u.role)}）`, [
      `${roleLabel(u.role)}（番号：${u.agentId}）が、止めても止まりませんでした。そのエージェントのツールは使えないようにしてあります。`,
      '止め方：チャットで Esc を2回押すか、Copilot CLI を終えてください。',
      runLine,
    ]);
  }

  // 3. データの流れ
  const lastIndex = iterations.length - 1;
  iterations.forEach((it, i) => {
    const endedNormally = endReason?.kind === 'all_passed' || endReason?.kind === 'max_iterations';
    // 途中で止まった最後の試行は、終わった理由の課題で足りる。人の指示で終えたときは、人がそこで終えると決めたので課題にしない（4.15）
    if (i === lastIndex && !endedNormally) return;
    const missing = [];
    if (it.workers.length === 0) missing.push('作業の開始');
    if (it.verifiers.length === 0) missing.push('検証の開始');
    if (!it.judged) missing.push('合否の記録');
    if (missing.length > 0) {
      add(`試行 ${it.n} で、${missing.join('・')}がそろいませんでした`, [
        `計画 → 作業 → 検証 → 合否の記録の流れで、試行 ${it.n} には ${missing.join('、')}がありませんでした。`,
        runLine,
      ]);
    }
  });
  const normalEnd = SUMMARY_END_KINDS.includes(endReason?.kind); // まとめ中に入って終わった（人の指示で終えたときを含む）
  if (normalEnd && cause?.creditLimit) {
    add('まとめ中に AI クレジットの上限に達しました', [
      '繰り返しが終わった後のまとめの途中で、AI クレジットの上限に達し、統括エージェントが終わりました。',
      runLine,
    ]);
  } else if (normalEnd && cause?.cause === 'cancelled') {
    add('まとめ中に統括エージェントが取り消されました', [
      '繰り返しが終わった後のまとめの途中で、統括エージェントが取り消されて終わりました。チャットから中断された可能性があります。',
      runLine,
    ]);
  }
  if (normalEnd && !finishRecorded) {
    add('まとめを記録しないまま統括エージェントが終わりました', [
      '繰り返しが終わった後、統括エージェントが実行全体のまとめを記録しないまま終わりました。まとめは記録から機械的に作りました。',
      runLine,
    ]);
  }
  const mismatchRoles = new Set();
  for (const a of agents.values()) {
    const role = a.role ?? roleOf(a.id);
    const selected = role ? models[role] : null;
    if (!selected || !a.model || mismatchRoles.has(role)) continue;
    if (String(selected).toLowerCase() !== String(a.model).toLowerCase()) {
      mismatchRoles.add(role); // 役割ごとに 1 件で足りる
      add(`選んだモデルと実際のモデルが違いました（${roleLabel(role)}）`, [
        `選んだモデル：${selected}`,
        `実際に動いたモデル：${a.model}`,
        isAuto ? 'Copilot CLI のモデルが Auto のため、役割ごとのモデルが効かなかった可能性があります。' : null,
        runLine,
      ]);
    }
  }
  if (nonSync.length > 0) {
    add('作業・検証が決まりと違う呼び方で動きました', [
      '統括エージェントは、作業・検証を 1 体ずつ順に呼ぶ決まりです。次のエージェントは、裏で動かす呼び方で動きました。',
      ...nonSync.map((n) => `- ${n.type}（番号：${n.agentId}、呼び方：${n.mode}）`),
      runLine,
    ]);
  }
  if (retryLimit) {
    add('記録のやり直しが上限を超えました', [
      `統括エージェントか検証エージェントが、記録のやり直しを ${LIMITS.RETRY_LIMIT} 回より多く断られたため、統括エージェントを取り消しました。`,
      runLine,
    ]);
  }
  return issues;
}

// 課題の案に番号を付ける。機械的な案は M1、M2…、統括が足した案は O1、O2…
export function numberIssues(drafts, prefix, source) {
  return drafts.map((d, i) => ({ id: `${prefix}${i + 1}`, title: d.title, body: d.body, source }));
}

// 記録の行をたどって、終わった時点のフェーズを求める（実行中と同じ決め方。4.5）
export function phaseFromEntries(entries, pluginName) {
  const agents = new Map();
  for (const entry of entries) {
    if (entry.t !== 'event' || !entry.e) continue;
    const e = entry.e;
    if (e.type === 'agent.started') {
      const parentRole = e.parentAgentId ? agents.get(e.parentAgentId)?.role : null;
      agents.set(e.agentId, { role: roleOfAgentType(e.agentType, pluginName) ?? parentRole ?? null, active: true });
    } else if (['agent.completed', 'agent.failed', 'agent.idle'].includes(e.type)) {
      const a = agents.get(e.agentId);
      if (a) a.active = false;
    }
  }
  let doing = false;
  let planning = false;
  for (const a of agents.values()) {
    if (!a.active) continue;
    if (a.role === 'verifier') return 'study';
    if (a.role === 'worker') doing = true;
    if (a.role === 'orchestrator') planning = true;
  }
  if (doing) return 'do';
  return planning ? 'plan' : null;
}
