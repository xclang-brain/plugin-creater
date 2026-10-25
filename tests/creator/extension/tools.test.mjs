// 2段目 部品の試験（クリエイターのエクステンション）：ツールとフックの登録。
// 設計書：hearing.md 7章・9章・12章、generated-plugin-structure.md 9章、BLUEPRINT 7章、creator-structure.md 4.3・4.5。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { EXTENSION_DIR, T, withRun } from './helpers.mjs';

// BLUEPRINT 7章の表（ここに独立に書き写す。実装の表と突き合わせる）
const TOOLS = {
  open: { skip: true },
  state: { skip: true },
  progress: { skip: true },
  record: { skip: true },
  confirm: { skip: true },
  results: { skip: true },
  doc_text: { skip: true }, // ユーザーの答え15：確認を省く
  issue: { skip: false }, // creator-structure.md 4.5：確認を省かない
};

const STAGE_NAMES = ['始まり', '実物を受け取る', '読む', 'できていたことの確認', '前回の1回', '決まりの確かめ', '項目の点検', '資産と公開のプラグイン', '画面', '生成前の確認', '生成'];
const ITEM_NAMES = [
  '作業の目的', '頼む場面と言い方', '受け取るもの', '進め方', '成果物', '合否の決め方', '決まった書き方やルール', '守らないと困ること', '使う道具と環境', 'いつもと違うとき',
  '前回の1回', '候補の確かめ', '資産', '標準機能と公開のプラグイン', '開始前に設定したいこと', '実行中に見たいこと', '終わった後に見たい結果と見せ方', 'できていたことの確認',
];

const hasJapanese = (s) => /[぀-ヿ㐀-鿿]/.test(s);

function collectEnums(schema, out = []) {
  if (schema && typeof schema === 'object') {
    if (Array.isArray(schema.enum)) out.push(schema.enum);
    for (const value of Object.values(schema)) collectEnums(value, out);
  }
  return out;
}

describe('ツールの登録', () => {
  test('BLUEPRINT 7章 8つのツールが、plugin-creator_ で始まる名前で登録される', async () => {
    await withRun(async (run) => {
      assert.deepEqual([...run.fake.toolNames].sort(), Object.keys(TOOLS).map(T).sort());
    });
  });

  test('REQ-049 確認を省く（skipPermission）のは起票以外。起票は省かない', async () => {
    await withRun(async (run) => {
      for (const [name, { skip }] of Object.entries(TOOLS)) {
        const tool = run.fake.tool(T(name));
        assert.equal(Boolean(tool.skipPermission), skip, `${name} の skipPermission`);
      }
    });
  });

  test('BLUEPRINT 7章 引数の JSON Schema は、type が object で、required の名前が properties にある', async () => {
    await withRun(async (run) => {
      for (const name of Object.keys(TOOLS)) {
        const { parameters } = run.fake.tool(T(name));
        assert.equal(parameters.type, 'object', name);
        const walk = (schema, where) => {
          if (!schema || typeof schema !== 'object') return;
          if (schema.type === 'object') {
            for (const r of schema.required ?? []) assert.ok(r in (schema.properties ?? {}), `${where}：required の ${r} が properties にない`);
          }
          for (const [k, v] of Object.entries(schema.properties ?? {})) walk(v, `${where}.${k}`);
          if (schema.items) walk(schema.items, `${where}[]`);
        };
        walk(parameters, name);
      }
      // 必須の引数
      const required = (name) => run.fake.tool(T(name)).parameters.required ?? [];
      assert.deepEqual(required('doc_text'), ['path']);
      assert.deepEqual(required('issue'), ['title', 'body']);
      assert.deepEqual(required('results'), ['paths']);
      assert.deepEqual(required('confirm'), ['knowledgeIds', 'behavior', 'taskPath', 'evalTasks']);
    });
  });

  test('REQ-015 項目・段階・状態の値は日本語の名前で、BLUEPRINT 7章の名前と一致する（内部の記号は出ない）', async () => {
    await withRun(async (run) => {
      const progress = run.fake.tool(T('progress')).parameters;
      assert.deepEqual(progress.properties.stage.enum, STAGE_NAMES);
      assert.deepEqual(progress.properties.items.items.properties.item.enum, ITEM_NAMES);
      assert.deepEqual(progress.properties.items.items.properties.status.enum, ['聞いた', '決まりなし', '保留']);

      const record = run.fake.tool(T('record')).parameters.properties.knowledge.items.properties;
      assert.deepEqual(record.kind.enum, ['合否の決め方', 'それ以外']);
      assert.deepEqual(record.status.enum, ['候補', '決まった', '外した']);
      assert.deepEqual(record.item.enum, ITEM_NAMES.slice(0, 10));
      assert.deepEqual(record.source.enum, [
        'ヒアリングの答え',
        'ユーザーが自分から話した',
        '生成前の確認で足した',
        'ファイルから読んで確かめた',
        '既存のプラグインから読んで確かめた',
        'AI の判断（ユーザーが任せた）',
      ]);

      assert.deepEqual(run.fake.tool(T('state')).parameters.properties.include.enum, ['最後の問答', '振り返りの材料']);

      for (const name of Object.keys(TOOLS)) {
        for (const values of collectEnums(run.fake.tool(T(name)).parameters)) {
          for (const value of values) assert.ok(hasJapanese(value), `${name} の選択肢「${value}」が日本語の名前ではない`);
        }
      }
    });
  });

  test('BLUEPRINT 7章 ツールの説明の文は descriptions.mjs にだけある（ほかのモジュールに説明の文を書かない）', async () => {
    const { TOOL_DESCRIPTIONS } = await import(pathToFileURL(path.join(EXTENSION_DIR, 'descriptions.mjs')).href);
    await withRun(async (run) => {
      for (const name of Object.keys(TOOLS)) {
        assert.equal(run.fake.tool(T(name)).description, TOOL_DESCRIPTIONS[name], name);
        assert.ok(TOOL_DESCRIPTIONS[name].length > 10, `${name} の説明が短すぎる`);
      }
    });
    // 説明の文は仕上がっている。仮の印「【仮】」は、足したばかりの引数 evalTasks.settings の説明にだけ許す（B3 が仕上げるまで。X2-02）。仕上がれば、どこにもなくなる
    const { PARAM_DESCRIPTIONS } = await import(pathToFileURL(path.join(EXTENSION_DIR, 'descriptions.mjs')).href);
    const provisional = Object.entries(PARAM_DESCRIPTIONS).flatMap(([tool, params]) => Object.entries(params).filter(([, text]) => text.includes('【仮】')).map(([key]) => `${tool}.${key}`));
    for (const key of provisional) assert.ok(key.startsWith('confirm.evalTasks.settings'), `${key} に仮の印がある`);
    for (const file of fs.readdirSync(EXTENSION_DIR).filter((f) => f.endsWith('.mjs'))) {
      const marks = fs.readFileSync(path.join(EXTENSION_DIR, file), 'utf8').split('【仮】').length - 1;
      assert.equal(marks, file === 'descriptions.mjs' ? provisional.length : 0, `${file} に仮の印が余っている`);
    }
    for (const description of Object.values(TOOL_DESCRIPTIONS)) assert.ok(!description.includes('【仮】'));
  });

  test('BLUEPRINT 7章 引数の説明の文は、実装の引数の名前と過不足なく合う（説明のない引数も、引数のない説明もない）', async () => {
    const { PARAM_DESCRIPTIONS } = await import(pathToFileURL(path.join(EXTENSION_DIR, 'descriptions.mjs')).href);
    await withRun(async (run) => {
      for (const name of Object.keys(TOOLS)) {
        const paths = [];
        const walk = (schema, prefix) => {
          for (const [key, sub] of Object.entries(schema.properties ?? {})) {
            const here = prefix ? `${prefix}.${key}` : key;
            paths.push([here, sub]);
            if (sub.type === 'object') walk(sub, here);
            if (sub.type === 'array' && sub.items?.type === 'object') walk(sub.items, here);
          }
        };
        walk(run.fake.tool(T(name)).parameters, '');
        const described = Object.keys(PARAM_DESCRIPTIONS[name] ?? {}).sort();
        assert.deepEqual(paths.map(([p]) => p).sort(), described, `${name} の引数と説明の名前が合わない`);
        for (const [p, sub] of paths) assert.ok(typeof sub.description === 'string' && sub.description.length >= 3, `${name}.${p} の説明がない`);
      }
    });
  });

  test('REQ-038 EVAL の課題の入力のファイルの説明に、実物は絶対パス、仮のファイルは生成プラグインの中の置き場所と書く（B3 の案）', async () => {
    await withRun(async (run) => {
      const path_ = run.fake.tool(T('confirm')).parameters.properties.evalTasks.items.properties.inputs.items.properties.path;
      assert.equal(
        path_.description,
        '入力のファイルの場所。実物のファイルは、その絶対パス（フォルダは渡せないので、フォルダの中のファイルを1つずつ渡す）。仮のファイル（`provisional` が true）は、生成プラグインの中の置き場所（`tests/eval/<課題の番号>/inputs/<名前>`）。',
      );
    });
  });

  test('REQ-015 状態取得ツールの説明に、コンパクションの後、再開の後、段階の始めにまず呼ぶと書く（hearing.md 7.5）', async () => {
    await withRun(async (run) => {
      const description = run.fake.tool(T('state')).description;
      for (const word of ['コンパクション', '再開', '段階の始め', 'まず呼ぶ']) assert.ok(description.includes(word), `説明に「${word}」がない`);
    });
  });

  test('REQ-015 記録のツールの定義を、ツール検索の裏に回させない（defer: never）', async () => {
    await withRun(async (run) => {
      for (const name of Object.keys(TOOLS)) assert.equal(run.fake.tool(T(name)).defer, 'never', name);
    });
  });
});

describe('フックの登録', () => {
  test('REQ-049 フックは onPostToolUse・onUserPromptSubmitted・onPreToolUse の3つで、許可の求めの受け口は登録しない', async () => {
    await withRun(async (run) => {
      assert.deepEqual(Object.keys(run.fake.config.hooks).sort(), ['onPostToolUse', 'onPreToolUse', 'onUserPromptSubmitted']);
      for (const fn of Object.values(run.fake.config.hooks)) assert.equal(typeof fn, 'function');
      // 許可の求めには答えない（creator-structure.md 4.5）。joinSession に onPermissionRequest を渡さない
      assert.equal(run.fake.config.onPermissionRequest, undefined);
    });
  });

  test('REQ-015 セッションのイベント session.compaction_complete を受ける', async () => {
    await withRun(async (run) => {
      assert.equal(run.fake.listenerCount('session.compaction_complete'), 1);
    });
  });

  test('REQ-043 画面のサーバーは子プロセスを作らない（エクステンションと一緒に終わる）。子プロセスを使うのは起票の gh だけ', () => {
    for (const file of fs.readdirSync(EXTENSION_DIR).filter((f) => f.endsWith('.mjs'))) {
      const source = fs.readFileSync(path.join(EXTENSION_DIR, file), 'utf8');
      const spawns = /node:child_process|from 'child_process'/.test(source);
      assert.equal(spawns, file === 'issue.mjs', `${file}：子プロセスの使い方が設計と違う`);
    }
  });

  test('creator-structure.md 4.3 入口の extension.mjs は joinSession でつなぐだけで、外部の npm パッケージを使わない', () => {
    const imports = [];
    for (const file of fs.readdirSync(EXTENSION_DIR).filter((f) => f.endsWith('.mjs'))) {
      const source = fs.readFileSync(path.join(EXTENSION_DIR, file), 'utf8');
      for (const m of source.matchAll(/^\s*import\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)) imports.push([file, m[1]]);
      for (const m of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) imports.push([file, m[1]]);
    }
    for (const [file, specifier] of imports) {
      const ok = specifier.startsWith('./') || specifier.startsWith('node:') || (file === 'extension.mjs' && specifier === '@github/copilot-sdk/extension');
      assert.ok(ok, `${file} が ${specifier} を読み込んでいる`);
    }
    const entry = fs.readFileSync(path.join(EXTENSION_DIR, 'extension.mjs'), 'utf8');
    assert.ok(entry.split('\n').length < 40, '入口が長い。つなぐ部分は薄くする');
    assert.ok(!/console\.log\(/.test(entry), '標準出力は JSON-RPC の通り道なので console.log を使わない');
  });

  test('creator-structure.md 4.3 どのモジュールも console.log を使わない（標準出力は JSON-RPC の通り道）', () => {
    for (const file of fs.readdirSync(EXTENSION_DIR).filter((f) => f.endsWith('.mjs'))) {
      const source = fs.readFileSync(path.join(EXTENSION_DIR, file), 'utf8');
      assert.ok(!/console\.log\(/.test(source), `${file} が console.log を使っている`);
      assert.ok(!/process\.stdout\.write/.test(source), `${file} が標準出力に書いている`);
    }
  });
});
