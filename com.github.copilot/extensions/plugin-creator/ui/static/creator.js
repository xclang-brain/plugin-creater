// クリエイターの画面を組み立てる。見るだけの画面：入力の欄、開始と止めるボタン、承認のボタンは出さない（REQ-043）。
// 答えや直しは、Copilot CLI のチャットで行う。状態の全体（GET /api/state）を1秒ごとに取り直し、
// 版が変わったときだけ描き直す。再読み込みなしで、決まったことが増えていく。
// 描画の部品は、ひな形の render.js（window.PluginUi）を使う。できあがるプラグインの作業の画面と同じ部品である。
//
// 決まり：記録やファイルから来た文字は、必ず文字として出す（PluginUi.h の子は文字のノードになる）。HTML としては扱わない。
(function () {
  'use strict';

  const { h, badge, collapsible, formatDateTime } = window.PluginUi;

  // ---- 通信 ---------------------------------------------------------------------------------

  const key = new URLSearchParams(window.location.search).get('k') ?? '';
  const withKey = (path) => `${path}${path.includes('?') ? '&' : '?'}k=${encodeURIComponent(key)}`;

  async function getState() {
    const response = await fetch(withKey('/api/state'), { cache: 'no-store' });
    if (!response.ok) throw new Error(`うまくいきませんでした（${response.status}）`);
    return response.json();
  }

  // ---- 画面が覚えておくこと --------------------------------------------------------------------

  const ui = { state: null, version: null, connected: true, open: new Set() };
  const sections = {};

  // 項目の状態 → 札の色（文字がいつも付くので、色は補助）
  const STATUS_TONE = { 未着手: 'standby', 聞いた: 'completed', 決まりなし: 'info', 保留: 'warn', 変えないので聞かない: 'neutral', 聞かずに案で示す: 'info' };
  const RESULT_TONE = { 合格: 'completed', 不合格: 'failed', 止まった: 'stopped', 試験なし: 'standby', 対象外: 'standby' };

  // ---- 小さな部品 --------------------------------------------------------------------------------

  function table(columns, rows, label, className = '') {
    return h(
      'div',
      { class: `table-wrap ${className}`.trim(), tabindex: '0', role: 'region', 'aria-label': label },
      h(
        'table',
        null,
        h('thead', null, h('tr', null, columns.map((c) => h('th', { scope: 'col' }, c)))),
        h('tbody', null, rows.map((row) => h('tr', null, row.map((cell) => (cell instanceof Node && cell.tagName === 'TD' ? cell : h('td', null, cell)))))),
      ),
    );
  }

  const textCell = (value) => h('td', { class: 'cell-text' }, value);
  const none = (text) => h('p', { class: 'muted' }, text);

  function knowledgeTable(rows, label) {
    if (rows.length === 0) return none('まだありません');
    return table(
      ['番号', '種類', '聞くこと', '文', '出どころ', '例', '例外', 'ユーザーの言葉'],
      rows.map((k) => [k.id, k.kind, k.item, textCell(k.text), k.source, k.example ?? '', k.exception ?? '', textCell(k.quote ?? '')]),
      label,
      'knowledge-table',
    );
  }

  // ---- 部分 -------------------------------------------------------------------------------------

  function renderHead(view) {
    const stage = view.hearing.exists ? view.hearing.stage : null;
    const change = view.hearing.change;
    return [
      h('h1', null, view.title ?? 'plugin-creator の画面'),
      h(
        'div',
        { class: 'top-state stage-line', id: 'stage' },
        stage ? ['今の段階：', badge(stage, 'info')] : badge('お話を聞くことはまだ始まっていません', 'standby'),
        view.hearing.approvedAt ? badge(`ユーザーがよいと答えた時刻：${formatDateTime(view.hearing.approvedAt) ?? view.hearing.approvedAt}`, 'completed') : null,
      ),
      // 今のプラグインを直すとき：直すプラグインと、変えたいこと
      change
        ? h(
            'div',
            { class: 'change-target', id: 'change-target' },
            h('p', null, `直すプラグイン：${change.name}（今の版 ${change.version ?? 'なし'}）`),
            h('p', { class: 'help' }, `フォルダ：${change.folder}`),
            change.wants.length ? h('ul', { class: 'plain-list' }, change.wants.map((w) => h('li', null, `変えたいこと：${w}`))) : null,
          )
        : null,
      h('p', { class: 'help top-message' }, 'この画面は見るだけです。答えや直しは、Copilot CLI のチャットで行ってください。'),
    ];
  }

  function renderConnection() {
    sections.connection.replaceChildren(
      ...(ui.connected
        ? []
        : [
            h(
              'p',
              { class: 'alert alert-error', role: 'alert', id: 'connection-lost' },
              'サーバーにつながりません。Copilot CLI を終えたか、チャットで /clear をしたかもしれません。画面の更新は止まっています。チャットでもう一度頼み、示された画面を開き直してください。',
            ),
          ]),
    );
    sections.connection.hidden = ui.connected;
  }

  function renderNotices(view) {
    return (view.notices ?? []).map((text) => h('p', { class: 'note note-warn' }, text));
  }

  function itemRow(item) {
    return h(
      'li',
      { dataset: { item: item.name, status: item.status } },
      h('span', null, item.name),
      badge(item.status, STATUS_TONE[item.status] ?? 'neutral'),
      item.holder ? h('span', { class: 'item-holder' }, `知っている人：${item.holder}`) : null,
    );
  }

  function renderItems(view) {
    const hearing = view.hearing;
    if (!hearing.exists) return [h('h2', null, 'お話を聞くことの進み具合'), none('お話を聞くことが始まると、聞くことの進み具合がここに出ます。')];
    // 変えないので聞かないもの（今のプラグインを直すとき。REQ-056）は、まだ聞いていないものとも、聞いたものとも分けて示す。
    // 欄は、今のプラグインを直すときに出す（作っていないプラグインでも使う）。聞かずに案で示すものは、済んだものとして、その札で示す
    const skipped = hearing.items.filter((i) => i.skipped);
    const main = hearing.items.filter((i) => i.main && !i.skipped);
    const asked = main.filter((i) => i.done);
    const notAsked = main.filter((i) => !i.done);
    const others = hearing.items.filter((i) => !i.main && !i.skipped);
    return [
      h('h2', null, 'お話を聞くことの進み具合'),
      h(
        'div',
        { class: 'item-columns' },
        h(
          'section',
          { class: 'item-column', id: 'not-asked' },
          h('h3', null, `まだ聞いていないこと（${notAsked.length}）`),
          notAsked.length ? h('ul', { class: 'item-list' }, notAsked.map(itemRow)) : none('ありません'),
        ),
        h(
          'section',
          { class: 'item-column', id: 'asked' },
          h('h3', null, `聞いたこと（${asked.length}）`),
          asked.length ? h('ul', { class: 'item-list' }, asked.map(itemRow)) : none('まだありません'),
        ),
        hearing.change || skipped.length
          ? h(
              'section',
              { class: 'item-column', id: 'skipped' },
              h('h3', null, `変えないので聞かないこと（${skipped.length}）`),
              h('p', { class: 'help' }, '今のプラグインのまま引き継ぐので、聞き直さないことです。'),
              skipped.length ? h('ul', { class: 'item-list' }, skipped.map(itemRow)) : none('まだありません'),
            )
          : null,
      ),
      h('h3', { class: 'sub' }, 'そのほかの聞くこと'),
      others.length ? h('ul', { class: 'item-list', id: 'other-items' }, others.map(itemRow)) : none('ありません'),
    ];
  }

  function renderKnowledge(view) {
    const hearing = view.hearing;
    return [
      h('h2', null, '決まったこと'),
      h('h3', { class: 'sub' }, `仕事のやり方や決まり（${hearing.knowledge.length}件）`),
      h('div', { id: 'knowledge' }, knowledgeTable(hearing.knowledge, '決まった仕事のやり方や決まりの一覧')),
      h('h3', { class: 'sub' }, `流用する資産（${hearing.assets.length}件）`),
      hearing.assets.length
        ? table(['名前', '場所', '説明'], hearing.assets.map((a) => [a.name, a.location ?? '', textCell(a.note ?? '')]), '流用する資産の一覧')
        : none('まだありません'),
      h('h3', { class: 'sub' }, `標準機能と公開のプラグイン（${hearing.oss.length}件）`),
      hearing.oss.length
        ? table(['名前', '種類', '選んだ結果', '説明'], hearing.oss.map((o) => [o.name, o.kind, o.choice, textCell(o.note ?? '')]), '標準機能と公開のプラグインの一覧')
        : none('まだありません'),
    ];
  }

  function renderCandidates(view) {
    const hearing = view.hearing;
    const candidates = hearing.candidates;
    const assetCandidates = hearing.assetCandidates ?? [];
    const dropped = hearing.dropped;
    if (candidates.length === 0 && assetCandidates.length === 0 && dropped.length === 0) return null;
    return [
      candidates.length || assetCandidates.length ? h('h2', null, 'まだ確かめていないこと') : null,
      candidates.length ? h('p', { class: 'help' }, 'ファイルや頼みの文から推し量ったものです。ユーザーが確かめるまで、仕事のやり方や決まりとしては使いません。') : null,
      candidates.length ? h('div', { id: 'candidates' }, knowledgeTable(candidates, '確かめていないことの一覧')) : null,
      assetCandidates.length
        ? h(
            'div',
            { id: 'asset-candidates' },
            h('h3', { class: 'sub' }, '確かめたい資産'),
            table(['名前', '場所', '説明'], assetCandidates.map((a) => [a.name, a.location ?? '', textCell(a.note ?? '')]), '確かめたい資産の一覧'),
          )
        : null,
      dropped.length
        ? collapsible({ key: 'dropped', summary: `外した仕事のやり方や決まり（${dropped.length}件）を開く`, open: ui.open }, knowledgeTable(dropped, '外した仕事のやり方や決まりの一覧'))
        : null,
    ];
  }

  // 課題ごとの、作業の画面に入れる設定の値（繰り返しの上限と、作業ごとの設定）
  function settingsBlock(settings) {
    const entries = [];
    if (settings?.maxIterations !== undefined) entries.push(['繰り返しの上限', settings.maxIterations]);
    for (const item of settings?.task ?? []) entries.push([item.label, item.value]);
    if (entries.length === 0) return h('p', { class: 'help' }, '作業の画面に入れる設定の値はありません');
    return h('div', null, h('p', { class: 'help' }, 'この課題で作業の画面に入れる設定の値'), h('ul', { class: 'plain-list' }, entries.map(([key, value]) => h('li', null, `${key}：${String(value)}`))));
  }

  // 直すときの、直すプラグイン・版・決まりの変わり方（REQ-057）
  function changeBlock(change) {
    const list = (ids) => (ids.length ? ids.join('、') : 'なし');
    return [
      h('h3', { class: 'sub' }, '直すプラグインと版'),
      h(
        'div',
        { id: 'confirm-change' },
        h('p', null, `直すフォルダ：${change.folder}`),
        h('p', { id: 'confirm-version' }, `版：今 ${change.version.from ?? 'なし'} → 直した後 ${change.version.to ?? 'なし'}`),
        h('h4', null, '仕事のやり方や決まりの変わり方'),
        h(
          'ul',
          { class: 'plain-list', id: 'confirm-knowledge-changes' },
          h('li', null, `足す：${list(change.added)}`),
          h('li', null, `直す（新しい番号に付け直す）：${list(change.replaced.map((r) => `${r.from} → ${r.to}`))}`),
          h('li', null, `外す：${list(change.removed)}`),
        ),
      ),
    ];
  }

  function renderConfirmation(view) {
    const c = view.confirmation;
    if (!c) return null;
    const word = c.change ? '直す前の確認' : '作る前の確認';
    const parts = [
      h('h2', null, `${word}で示すもの`),
      h('p', { class: 'help' }, `受け付けた時刻：${formatDateTime(c.at) ?? c.at}。よいと答えることや、直すことは、チャットで行います。`),
      c.change ? changeBlock(c.change) : null,
      h('h3', { class: 'sub' }, `仕事のやり方や決まりの一覧（${c.knowledge.length}件）`),
      h('div', { id: 'confirm-knowledge' }, knowledgeTable(c.knowledge, `${word}で示す仕事のやり方や決まりの一覧`)),
      h('h3', { class: 'sub' }, 'できあがるプラグインの振る舞いの案'),
      h('p', { class: 'text-block', id: 'confirm-behavior' }, c.behavior),
      h('h3', { class: 'sub' }, '作業の画面の見本'),
      c.sampleUrl
        ? h('p', { id: 'confirm-sample' }, h('a', { class: 'sample-link', href: c.sampleUrl, target: '_blank', rel: 'noopener noreferrer' }, '作業の画面の見本を開く（別のタブで開きます）'))
        : h('p', { class: 'muted', id: 'confirm-sample' }, `見本はまだ開けません。チャットで、${word}をやり直すと開けます。`),
      h('h3', { class: 'sub' }, `試しに動かして採点する試験の課題と合格の条件`),
      h('p', { class: 'help' }, '合格の条件は、種類が「合否の決め方」の仕事のやり方や決まりの文のままです。'),
      c.criteria.length
        ? table(['条件の番号', '条件', 'もとの仕事のやり方や決まり'], c.criteria.map((x) => [x.id, textCell(x.text), x.knowledge]), '合格の条件の一覧')
        : none('合格の条件はまだありません'),
      h(
        'div',
        { id: 'confirm-eval' },
        c.evalTasks.map((t, i) =>
          h(
            'article',
            { class: 'result-file', dataset: { evalTask: String(i + 1) } },
            h('h3', null, `課題 ${i + 1}`),
            h('p', { class: 'text-block' }, t.prompt),
            t.inputs.length
              ? h(
                  'div',
                  null,
                  h('p', { class: 'help' }, '入力のファイル（できあがるプラグインのリポジトリに入ります）'),
                  h('ul', { class: 'plain-list' }, t.inputs.map((f) => h('li', null, f.path, f.provisional ? [' ', badge('仮のファイル', 'warn')] : null))),
                )
              : h('p', { class: 'help' }, '入力のファイルはありません'),
            t.criteria.length
              ? h('div', null, h('p', { class: 'help' }, 'この課題の合格の条件'), h('ul', { class: 'plain-list' }, t.criteria.map((x) => h('li', null, `${x.id}：${x.text}`))))
              : null,
            settingsBlock(t.settings),
          ),
        ),
      ),
    ];
    if (c.rebuild) {
      parts.push(
        h('h3', { class: 'sub' }, c.change ? '直すときに、引き継ぐことと変わること' : '作り直しで、引き継ぐことと変わること'),
        h(
          'div',
          { class: 'item-columns', id: 'confirm-rebuild' },
          h('section', { class: 'item-column' }, h('h3', null, '引き継ぐこと'), c.rebuild.keep.length ? h('ul', { class: 'plain-list' }, c.rebuild.keep.map((x) => h('li', null, x))) : none('なし')),
          h('section', { class: 'item-column' }, h('h3', null, '変わること'), c.rebuild.change.length ? h('ul', { class: 'plain-list' }, c.rebuild.change.map((x) => h('li', null, x))) : none('なし')),
        ),
      );
    }
    return parts;
  }

  function stagesResult(result) {
    const v = result.view;
    return [
      h('h3', null, result.name, ' ', badge(v.overall || '結果', RESULT_TONE[v.overall] ?? 'neutral')),
      h('p', { class: 'help' }, result.path),
      table(
        ['段階', '結果', '件数'],
        v.stages.map((s) => [
          s.name,
          h('td', null, badge(s.status || '—', RESULT_TONE[s.status] ?? 'neutral')),
          s.counts ? `${s.counts.total ?? ''}件中、合格${s.counts.passed ?? 0}、不合格${s.counts.failed ?? 0}` : '',
        ]),
        '段階ごとの結果',
      ),
      v.stages.flatMap((s) => [
        ...s.failures.map((f) => h('div', { class: 'failure' }, h('p', { class: 'failure-test' }, `${s.name}：${f.test}`), h('p', { class: 'text-block' }, f.reason))),
        ...s.warnings.map((w) => h('p', { class: 'note note-warn' }, `${s.name}：${w}`)),
      ]),
    ];
  }

  function evalResult(result) {
    const v = result.view;
    const score = (n) => (n === null || n === undefined ? '—' : String(n));
    return [
      h('h3', null, result.name, ' ', badge('試しに動かして採点する試験', 'info')),
      h('p', { class: 'help' }, result.path),
      h(
        'dl',
        { class: 'kv' },
        h('div', { class: 'fact' }, h('dt', null, 'できあがるプラグインありの点数'), h('dd', null, score(v.withScore))),
        h('div', { class: 'fact' }, h('dt', null, 'できあがるプラグインなしの点数'), h('dd', null, score(v.withoutScore))),
        h('div', { class: 'fact' }, h('dt', null, '点数の差'), h('dd', null, score(v.difference))),
        h('div', { class: 'fact' }, h('dt', null, '使った AI クレジット'), h('dd', null, score(v.credits))),
      ),
      v.runs.length
        ? table(
            ['課題', 'あり・なし', '点数', '条件ごとの合否'],
            v.runs.map((r) => [
              r.task,
              r.variant,
              score(r.score),
              h('td', null, r.criteria.length ? h('ul', { class: 'plain-list' }, r.criteria.map((c) => h('li', null, `${c.id}：`, badge(c.pass ? '合格' : '不合格', c.pass ? 'completed' : 'failed')))) : ''),
            ]),
            '実行ごとの結果',
          )
        : null,
    ];
  }

  function renderResults(view) {
    const results = view.results ?? [];
    if (results.length === 0) return null;
    return [
      h('h2', null, 'できあがるプラグインの試験の結果'),
      results.map((result) => {
        let body;
        if (result.error) body = [h('h3', null, result.name), h('p', { class: 'alert alert-error', role: 'alert' }, result.error)];
        else if (result.view.kind === 'stages') body = stagesResult(result);
        else if (result.view.kind === 'eval') body = evalResult(result);
        else body = [h('h3', null, result.name), h('p', { class: 'help' }, result.path), collapsible({ key: `raw:${result.path}`, summary: '結果の中身を開く', open: ui.open }, h('p', { class: 'raw' }, result.view.raw))];
        return h('article', { class: 'result-file', dataset: { result: result.name } }, body);
      }),
    ];
  }

  function renderExamples(view) {
    const examples = view.examples ?? [];
    return [
      h('h2', null, '会話例'),
      h('p', { class: 'help' }, 'AI が演じたユーザーとの会話の例です。plugin-creator の版ごとに作り直されます。'),
      examples.length
        ? h(
            'ul',
            { class: 'plain-list', id: 'examples' },
            examples.map((name) => h('li', null, h('a', { href: withKey(`/api/examples/${encodeURIComponent(name)}`), target: '_blank', rel: 'noopener noreferrer' }, name))),
          )
        : none('会話例はまだありません'),
    ];
  }

  // ---- 全体 --------------------------------------------------------------------------------------------

  const BUILDERS = [
    ['head', renderHead],
    ['notices', renderNotices],
    ['items', renderItems],
    ['knowledge', renderKnowledge],
    ['candidates', renderCandidates],
    ['confirm', renderConfirmation],
    ['results', renderResults],
    ['examples', renderExamples],
  ];

  function renderAll() {
    const view = ui.state;
    if (!view) return;
    document.title = `${view.title ?? 'plugin-creator の画面'}`;
    for (const [id, build] of BUILDERS) {
      const nodes = [build(view) ?? []].flat(Infinity).filter(Boolean);
      sections[id].replaceChildren(...nodes);
      sections[id].hidden = nodes.length === 0;
    }
  }

  async function poll() {
    try {
      const state = await getState();
      const reconnected = !ui.connected;
      ui.connected = true;
      if (!ui.state || state.version !== ui.version) {
        ui.state = state;
        ui.version = state.version;
        renderAll();
      }
      if (reconnected) renderAll();
      renderConnection();
    } catch {
      ui.connected = false;
      renderConnection();
    }
    document.getElementById('loading')?.remove();
  }

  function start() {
    const root = document.getElementById('app');
    sections.connection = h('div', { id: 's-connection', hidden: true });
    root.appendChild(sections.connection);
    sections.head = h('header', { class: 'top', id: 's-head', hidden: true });
    sections.notices = h('div', { id: 's-notices', hidden: true });
    root.append(sections.head, sections.notices);
    const main = h('main', { class: 'main' });
    for (const [id] of BUILDERS) {
      if (id === 'head' || id === 'notices') continue;
      sections[id] = h('section', { class: 'panel', id: `s-${id}`, hidden: true });
      main.appendChild(sections[id]);
    }
    root.appendChild(main);
    root.removeAttribute('aria-busy');

    const loop = async () => {
      await poll();
      window.setTimeout(loop, 1000);
    };
    loop();
  }

  start();
})();
