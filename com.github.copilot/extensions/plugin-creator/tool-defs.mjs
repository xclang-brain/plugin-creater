// ツールの定義（名前の後ろの部分、引数の JSON Schema、確認を省くか）。BLUEPRINT 7章の表のとおり。
// 説明の文は descriptions.mjs にだけある。つなぎ口はここの定義を登録するだけにする。
// 項目・段階・状態の値は、画面に出る日本語の名前をそのまま使う（内部の記号は引数にも返り値にも出さない）。

import { CREATOR_NAME } from './constants.mjs';
import { PARAM_DESCRIPTIONS, TOOL_DESCRIPTIONS } from './descriptions.mjs';
import {
  ASSET_STATUSES,
  ITEMS,
  ITEM_STATUSES,
  KNOWLEDGE_KINDS,
  KNOWLEDGE_SOURCES,
  KNOWLEDGE_STATUSES,
  MAIN_ITEMS,
  OSS_CHOICES,
  OSS_KINDS,
  STAGES,
} from './names.mjs';

export { CREATOR_NAME };

export const toolFullName = (shortName) => `${CREATOR_NAME}_${shortName}`;

const names = (rows) => rows.map((r) => r.name);

// 引数の説明の文を引く。ツールの名前の後ろの部分と、引数の道筋（'items.item' など）で探す
const describe = (tool, path) => PARAM_DESCRIPTIONS[tool]?.[path];

function str(tool, path, extra = {}) {
  return { type: 'string', ...extra, description: describe(tool, path) };
}

function strEnum(tool, path, values) {
  return { type: 'string', enum: values, description: describe(tool, path) };
}

function object(properties, required = []) {
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

const noArgs = () => object({});

const parameters = {
  open: noArgs,

  state: () =>
    object({
      include: strEnum('state', 'include', ['最後の問答', '振り返りの材料']),
    }),

  progress: () =>
    object({
      stage: strEnum('progress', 'stage', names(STAGES)),
      items: {
        type: 'array',
        minItems: 1,
        description: describe('progress', 'items'),
        items: object(
          {
            item: strEnum('progress', 'items.item', names(ITEMS)),
            status: strEnum('progress', 'items.status', names(ITEM_STATUSES).filter((n) => n !== '未着手')),
            quote: str('progress', 'items.quote', { minLength: 1 }),
            holder: str('progress', 'items.holder'),
          },
          ['item', 'status', 'quote'],
        ),
      },
      approvalQuote: str('progress', 'approvalQuote', { minLength: 1 }),
    }),

  record: () =>
    object({
      knowledge: {
        type: 'array',
        minItems: 1,
        description: describe('record', 'knowledge'),
        items: object(
          {
            id: str('record', 'knowledge.id', { pattern: '^K-[0-9]+$' }),
            kind: strEnum('record', 'knowledge.kind', names(KNOWLEDGE_KINDS)),
            item: strEnum('record', 'knowledge.item', names(MAIN_ITEMS)),
            text: str('record', 'knowledge.text', { minLength: 1 }),
            source: strEnum('record', 'knowledge.source', names(KNOWLEDGE_SOURCES)),
            quote: str('record', 'knowledge.quote', { minLength: 1 }),
            example: str('record', 'knowledge.example'),
            exception: str('record', 'knowledge.exception'),
            status: strEnum('record', 'knowledge.status', names(KNOWLEDGE_STATUSES)),
          },
          ['quote'],
        ),
      },
      assets: {
        type: 'array',
        minItems: 1,
        description: describe('record', 'assets'),
        items: object(
          {
            name: str('record', 'assets.name', { minLength: 1 }),
            location: str('record', 'assets.location'),
            note: str('record', 'assets.note'),
            status: strEnum('record', 'assets.status', names(ASSET_STATUSES)),
          },
          ['name', 'status'],
        ),
      },
      oss: {
        type: 'array',
        minItems: 1,
        description: describe('record', 'oss'),
        items: object(
          {
            name: str('record', 'oss.name', { minLength: 1 }),
            kind: strEnum('record', 'oss.kind', names(OSS_KINDS)),
            choice: strEnum('record', 'oss.choice', names(OSS_CHOICES)),
            note: str('record', 'oss.note'),
          },
          ['name', 'kind', 'choice'],
        ),
      },
    }),

  confirm: () =>
    object(
      {
        knowledgeIds: {
          type: 'array',
          minItems: 1,
          description: describe('confirm', 'knowledgeIds'),
          items: { type: 'string', pattern: '^K-[0-9]+$' },
        },
        behavior: str('confirm', 'behavior', { minLength: 1 }),
        taskPath: str('confirm', 'taskPath', { minLength: 1 }),
        evalTasks: {
          type: 'array',
          minItems: 1,
          description: describe('confirm', 'evalTasks'),
          items: object(
            {
              prompt: str('confirm', 'evalTasks.prompt', { minLength: 1 }),
              inputs: {
                type: 'array',
                description: describe('confirm', 'evalTasks.inputs'),
                items: object(
                  {
                    path: str('confirm', 'evalTasks.inputs.path', { minLength: 1 }),
                    provisional: { type: 'boolean', description: describe('confirm', 'evalTasks.inputs.provisional') },
                  },
                  ['path'],
                ),
              },
              criteria: {
                type: 'array',
                description: describe('confirm', 'evalTasks.criteria'),
                items: { type: 'string', pattern: '^K-[0-9]+$' },
              },
              settings: {
                ...object(
                  {
                    maxIterations: { type: 'integer', minimum: 1, description: describe('confirm', 'evalTasks.settings.maxIterations') },
                    task: {
                      type: 'object',
                      additionalProperties: { type: ['string', 'number', 'boolean'] },
                      description: describe('confirm', 'evalTasks.settings.task'),
                    },
                  },
                  [],
                ),
                description: describe('confirm', 'evalTasks.settings'),
              },
            },
            ['prompt'],
          ),
        },
        rebuild: {
          ...object(
            {
              keep: { type: 'array', items: { type: 'string' }, description: describe('confirm', 'rebuild.keep') },
              change: { type: 'array', items: { type: 'string' }, description: describe('confirm', 'rebuild.change') },
            },
            ['keep', 'change'],
          ),
          description: describe('confirm', 'rebuild'),
        },
        version: str('confirm', 'version', { minLength: 1 }),
      },
      ['knowledgeIds', 'behavior', 'taskPath', 'evalTasks'],
    ),

  change: () =>
    object(
      {
        folder: str('change', 'folder', { minLength: 1 }),
        wants: {
          type: 'array',
          minItems: 1,
          description: describe('change', 'wants'),
          items: { type: 'string', minLength: 1 },
        },
      },
      ['folder', 'wants'],
    ),

  results: () =>
    object(
      {
        paths: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          description: describe('results', 'paths'),
          items: { type: 'string', minLength: 1 },
        },
      },
      ['paths'],
    ),

  doc_text: () => object({ path: str('doc_text', 'path', { minLength: 1 }) }, ['path']),

  issue: () =>
    object(
      {
        title: str('issue', 'title', { minLength: 1, maxLength: 256 }),
        body: str('issue', 'body', { minLength: 1 }),
      },
      ['title', 'body'],
    ),
};

// 呼ぶもの：main＝メインのエージェント、reader＝読み取り役。確認を省くか（skipPermission）は BLUEPRINT 7章の表のとおり。
// 起票（issue）だけは確認を省かない。承認された案を起票するときの Copilot CLI の確認を、承認の歯止めにするため（creator-structure.md 4.5）。
const DEFS = [
  { name: 'open', caller: 'main', skipPermission: true },
  { name: 'state', caller: 'main', skipPermission: true },
  { name: 'progress', caller: 'main', skipPermission: true },
  { name: 'record', caller: 'main', skipPermission: true },
  { name: 'confirm', caller: 'main', skipPermission: true },
  { name: 'results', caller: 'main', skipPermission: true },
  { name: 'doc_text', caller: 'reader', skipPermission: true },
  { name: 'issue', caller: 'main', skipPermission: false },
  // 今のプラグインを直す記録を作る（BLUEPRINT 5 C1）。今までのツールの並びを変えないよう、最後に足す
  { name: 'change', caller: 'main', skipPermission: true },
];

export const TOOL_DEFS = Object.freeze(
  DEFS.map((def) =>
    Object.freeze({
      ...def,
      fullName: toolFullName(def.name),
      description: TOOL_DESCRIPTIONS[def.name],
      parameters: parameters[def.name](),
    }),
  ),
);

export const TOOL_SHORT_NAMES = Object.freeze(DEFS.map((d) => d.name));
