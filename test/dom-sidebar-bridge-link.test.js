const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

function render(ctx, session) {
  const full = {
    summary: 's', modified: '2026-09-06T10:00:00.000Z',
    starred: false, archived: 0, messageCount: 1, ...session,
  };
  ctx.window.sessionMap.set(full.sessionId, full);
  ctx.sidebar.renderProjects([makeSampleProject({ sessions: [full] })], true);
  return ctx.document.querySelector('#si-' + session.sessionId);
}

test('a session with a bridge id shows "Open on claude.ai", which opens the bridge URL externally', () => {
  const ctx = setupSidebarDom();
  try {
    const opened = [];
    ctx.window.api.openExternal = (url) => { opened.push(url); };
    const item = render(ctx, { sessionId: 'with-bridge', bridgeSessionId: 'cse_0189wicjnQ3j6mppaWVWuntM' });
    const btn = item.querySelector('.session-bridge-btn');
    assert.ok(btn, 'the row carries the bridge button');
    assert.equal(btn.title, 'Open on claude.ai');
    btn.click();
    assert.deepEqual(opened, ['https://claude.ai/code/session_0189wicjnQ3j6mppaWVWuntM']);
  } finally { ctx.destroy(); }
});

test('a session without a bridge id shows no bridge button', () => {
  const ctx = setupSidebarDom();
  try {
    const item = render(ctx, { sessionId: 'no-bridge', bridgeSessionId: null });
    assert.equal(item.querySelector('.session-bridge-btn'), null);
    const item2 = render(ctx, { sessionId: 'no-bridge-2' });
    assert.equal(item2.querySelector('.session-bridge-btn'), null);
  } finally { ctx.destroy(); }
});
