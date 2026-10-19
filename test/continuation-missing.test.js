'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveContinuations, resolveContinuationsSync } = require('../session-continuations');
const { setup } = require('./continuations-harness');

for (const [name, other, options] of [
  ['X1 sole proven-missing target', undefined, {}],
  ['X2 unresolved index', { index: { ids: [], unresolved: true } }, {}],
  ['X3 waiting for indexing', { waitingForIndex: true }, {}],
  ['X4 unreadable node', null, {}],
  ['cycle', { index: { ids: ['old'] } }, {}],
  ['depth bound', { index: { ids: ['deep'] } }, { maxDepth: 2 }],
  ['node bound', { index: { ids: [] } }, { maxNodes: 3 }],
]) {
  test(`${name} distinguishes absence from uncertainty in sync and async traversal`, async () => {
    const graph = { old: { index: { ids: ['mid', ...(other === undefined ? [] : ['other'])] } },
      mid: { index: { ids: ['gone'] } }, gone: { missing: true }, other, deep: { index: { ids: ['deeper'] } } };
    for (const resolve of [resolveContinuationsSync, resolveContinuations]) {
      const result = await resolve('old', id => graph[id], options);
      assert.equal(result.unresolved, true);
      assert.equal(result.missing, other === undefined);
    }
  });
}

test('a missing root is not a proven-missing continuation', () => {
  assert.equal(resolveContinuationsSync('old', () => ({ missing: true })).missing, false);
  assert.equal(resolveContinuationsSync('../invalid', () => null).missing, false);
});

function noticeTimer(t, h) {
  const timers = [];
  const original = h.dom.window.setTimeout.bind(h.dom.window);
  t.mock.method(h.dom.window, 'setTimeout', (callback, ms, ...args) => {
    if (ms !== 15_000) return original(callback, ms, ...args);
    timers.push(callback);
    return 999999;
  });
  return timers;
}

function assertMissingOpen(h, timers) {
  assert.deepEqual(h.spawned.map(call => call.id), ['old']);
  assert.deepEqual(h.prompts, []);
  const notice = h.dom.window.document.querySelector('#app-notices [role="status"]');
  assert.ok(notice);
  assert.equal(notice.querySelector('.app-notice-message').textContent,
    '"Kept conversation" continued in a part that no longer exists on disk, so it was opened as it was.');
  assert.ok(notice.querySelector('.app-notice-dismiss'));
  assert.equal(h.dom.window.document.querySelector('#app-notices [role="alert"]'), null);
  assert.equal(timers.length, 1);
  timers[0]();
  assert.equal(h.dom.window.document.querySelector('#app-notices [role="status"]'), null);
  assert.deepEqual(h.settings().openWorkingSet.map(item => item.sessionId), ['old']);
}

for (const automatic of [false, true]) {
  test(`${automatic ? 'R2 restore' : 'R1 manual click'} opens a proven-missing continuation with a 15-second notice`, async t => {
    const h = setup(t, { old: ['gone'] });
    h.rows.get('old').name = 'Kept conversation';
    const timers = noticeTimer(t, h);
    await (automatic ? h.restore() : h.click());
    assertMissingOpen(h, timers);
  });
}

for (const automatic of [false, true]) {
  for (const failure of ['live elsewhere', 'backend failure']) {
    test(`a missing continuation notice waits for a successful ${automatic ? 'restore' : 'manual open'}: ${failure}`, async t => {
      const h = setup(t, { old: ['gone'] }, {
        live: failure === 'live elsewhere' ? { old: { kind: 'interactive', pid: 77 } } : {},
      });
      if (failure === 'backend failure') h.ctx.api.openTerminal = async () => ({ ok: false, error: 'fixture unavailable' });
      await (automatic ? h.restore() : h.click());
      assert.equal(h.dom.window.document.querySelector('[data-notice-id="continuation-missing:old"]'), null);
    });
  }
}

test('a real branch with one absent and one present target still asks manually', async t => {
  const h = setup(t, { old: ['gone', 'present'], present: [] }, { choice: 'present' });
  const result = await h.ctx.api.getSessionContinuations('old');
  assert.equal(result.missing, false);
  assert.equal(result.unresolved, false);
  await h.click();
  assert.deepEqual(h.spawned.map(call => call.id), ['present']);
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0].title, 'Open which part?');
  assert.equal(h.dom.window.document.querySelector('#app-notices [role="status"]'), null);
});

test('an all-missing descendant beside a present target still asks and restore holds', async t => {
  const h = setup(t, { old: ['mid', 'present'], mid: ['gone'], present: [] }, { choice: 'present' });
  await h.restore();
  assert.deepEqual(h.spawned, []);
  await h.click();
  assert.deepEqual(h.spawned.map(call => call.id), ['present']);
  assert.equal(h.prompts[0].title, 'Open which part?');
  assert.match(h.prompts[0].message.join(' '), /list may be incomplete/);
});
