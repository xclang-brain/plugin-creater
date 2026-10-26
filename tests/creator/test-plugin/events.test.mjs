// イベントの集計（skills/test-plugin/scripts/events.mjs）の試験のうち、run.test.mjs の流れの中では確かめにくい、手番の数え方。
// 確かめる要件：REQ-041（生成プラグインありの EVAL を、終わりまで動かして記録する）。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { loadScript } from './helpers.mjs';

const { createTracker } = await loadScript('events.mjs');

describe('手番の数え方', () => {
  test('REQ-041 メッセージを送る前に来た session.idle は、手番の終わりに数えない（送った印で数え直す）', () => {
    const tracker = createTracker();
    tracker.onEvent({ type: 'session.idle', data: {} });
    assert.equal(tracker.state.idleCount, 1, '送る前の idle も、イベントとしては数える');

    tracker.markSent();
    assert.equal(tracker.state.sent, true);
    assert.equal(tracker.state.busy, true);
    assert.equal(tracker.state.idleCount, 0, '送った印で、数え直す。これより後の idle だけが、手番の終わり');
  });

  test('REQ-041 送った後の session.idle で、手番が終わったことになる。次に送ると、また動いている状態になる', () => {
    const tracker = createTracker();
    tracker.markSent();
    tracker.onEvent({ type: 'session.idle', data: {} });
    assert.equal(tracker.state.idleCount, 1);
    assert.equal(tracker.state.busy, false);
    assert.ok(tracker.state.lastIdleAt !== null);

    tracker.markSent();
    assert.equal(tracker.state.busy, true, '2回目の送信で、また動いている状態');
    assert.equal(tracker.state.idleCount, 0);
  });

  test('REQ-051 イベントに通し番号を付け、最後の session.idle と、メインのエージェントへの裏のエージェントの知らせの番号を覚える', () => {
    const tracker = createTracker();
    tracker.onEvent({ type: 'assistant.message', data: { content: 'URL' } });
    tracker.onEvent({ type: 'session.idle', data: {} });
    assert.equal(tracker.state.seq, 2);
    assert.equal(tracker.state.lastIdleSeq, 2);
    assert.equal(tracker.state.lastNoticeSeq, 0);

    tracker.onEvent({ type: 'system.notification', data: { kind: { type: 'agent_idle', agentId: 'w-1' } }, agentId: 'orch-1' });
    assert.equal(tracker.state.lastNoticeSeq, 0, 'サブエージェントに届いた知らせ（agentId 付き）は数えない');
    tracker.onEvent({ type: 'system.notification', data: { kind: { type: 'agent_idle', agentId: 'orch-1' } } });
    assert.equal(tracker.state.lastNoticeSeq, 4);
    assert.equal(tracker.state.busy, true, '知らせを受けたメインのエージェントは動く');
    tracker.onEvent({ type: 'session.idle', data: {} });
    assert.equal(tracker.state.lastIdleSeq, 5);
    assert.equal(tracker.state.busy, false);
  });
});
