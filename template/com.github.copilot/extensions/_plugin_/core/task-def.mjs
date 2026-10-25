import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 作業の定義（task.json。6.4）の読み込みと、エージェントの定義の model の読み取り（4.6）。

export function normalizeTask(raw, pluginName = '') {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('作業の定義（task.json）が読めません。');
  }
  const workers =
    Array.isArray(raw.workers) && raw.workers.length > 0
      ? raw.workers.map((w) => ({ agent: String(w.agent), label: String(w.label ?? w.agent) }))
      : [{ agent: 'worker', label: '作業' }];
  const maxDefault = Number.isInteger(raw.maxIterationsDefault) && raw.maxIterationsDefault >= 1 ? raw.maxIterationsDefault : 3;
  return {
    name: String(raw.name ?? pluginName),
    maxIterationsDefault: maxDefault,
    criteria: (Array.isArray(raw.criteria) ? raw.criteria : []).map((c) => ({
      id: String(c.id),
      text: String(c.text),
      knowledge: c.knowledge ?? null,
    })),
    workers,
    settings: Array.isArray(raw.settings) ? raw.settings : [],
    displays: Array.isArray(raw.displays) ? raw.displays : [],
  };
}

// 思考の深さを選ぶエージェント（4.6）：統括、作業エージェントのそれぞれ、検証。label は画面と断りの文に出す呼び名
export function effortAgents(task) {
  return [
    { agent: 'orchestrator', label: '統括' },
    ...task.workers.map((w) => ({ agent: w.agent, label: w.label === '作業' ? '作業' : `作業（${w.label}）` })),
    { agent: 'verifier', label: '検証' },
  ];
}

export function loadTaskFile(path, pluginName) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`作業の定義（${path}）が読めません：${e.message}`);
  }
  return normalizeTask(raw, pluginName);
}

function unquote(s) {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

function stripComment(s) {
  // 引用符の外の " #" 以降を捨てる（簡単な読み取りで足りる範囲）
  const m = /^(.*?)\s+#.*$/.exec(s);
  return m && !/["']/.test(s) ? m[1] : s;
}

// *.agent.md の先頭の --- で囲まれた部分から、model（または models）を読む。
// 書き方は 1 つのモデル、[a, b]、行頭に - を付けた一覧のどれでもよい（4.6）。
export function parseModelList(markdown) {
  const text = String(markdown ?? '').replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return [];
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const km = /^(model|models)\s*:\s*(.*)$/.exec(lines[i]);
    if (!km) continue;
    const rest = stripComment(km[2].trim());
    if (rest.startsWith('[')) {
      return rest
        .replace(/^\[/, '')
        .replace(/\]\s*$/, '')
        .split(',')
        .map(unquote)
        .filter(Boolean);
    }
    if (rest) return [unquote(rest)];
    const list = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const im = /^\s+-\s+(.*)$/.exec(lines[j]);
      if (!im) break;
      list.push(unquote(stripComment(im[1])));
    }
    return list.filter(Boolean);
  }
  return [];
}

export function readAgentModels(pluginRoot, agentName) {
  if (!pluginRoot) return [];
  try {
    const text = readFileSync(join(pluginRoot, 'com.github.copilot', 'agents', `${agentName}.agent.md`), 'utf8');
    return parseModelList(text);
  } catch {
    return [];
  }
}

// 役割ごとの既定のモデル。定義の model の中で、選べるモデルにある最初のもの。
// なければ、選べるモデルの一覧があるときは今のモデル、その最初の順に使う。
// 一覧が取れないときは、定義の最初、今のモデルの順に使う。
export function pickDefaultModel(candidates, availableIds, currentModel) {
  const ids = new Set(availableIds);
  const hit = candidates.find((m) => ids.has(m));
  if (hit) return hit;
  if (availableIds.length > 0) return currentModel && ids.has(currentModel) ? currentModel : availableIds[0];
  return candidates[0] ?? currentModel ?? '';
}
