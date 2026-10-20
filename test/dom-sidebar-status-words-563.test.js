const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

const now = Date.parse('2026-10-20T12:00:00Z');
const cases = [
  { status: 'busy', text: '1m ago' },
  { status: 'idle', text: '1m ago' },
  { status: 'shell', text: '1m ago' },
  { status: 'waiting', waitingFor: 'permission prompt', text: 'permission prompt · 1m ago' },
];

function sessionFor(entry) {
  return { sessionId: 'status-563', summary: 'Foreground session', modified: new Date(now).toISOString(),
    ...entry, statusUpdatedAt: now - 60000 };
}

test('first render keeps reason plus age and the status slot for every CLI status', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.Date.now = () => now;
    ctx.evalPublic('agents-view.js');
    for (const entry of [...cases, cases[1]]) {
      const item = ctx.sidebar.buildSessionItem(sessionFor(entry));
      const status = item.querySelector('.session-status');
      assert.ok(status, entry.status);
      assert.equal(status.textContent, entry.text, entry.status);
      assert.doesNotMatch(status.textContent.toLowerCase(), /\b(busy|idle|waiting|shell)\b/);
    }
  } finally { ctx.destroy(); }
});

test('live descriptor updates keep the same reason plus age as the first render', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.Date.now = () => now;
    ctx.evalPublic('agents-view.js');
    const session = sessionFor({ status: 'idle' });
    ctx.window.activePtyIds.add(session.sessionId);
    ctx.sidebar.renderProjects([makeSampleProject({ sessions: [session] })], true);
    const item = ctx.document.getElementById('si-' + session.sessionId);
    for (const entry of [...cases, cases[1]]) {
      const updated = sessionFor(entry);
      ctx.window.sessionMap.set(session.sessionId, updated);
      ctx.window.applyStateClasses(session.sessionId, ctx.window.snapshotForLocal(session.sessionId, updated));
      assert.equal(item.querySelector('.session-status').textContent, entry.text, entry.status);
      assert.equal(item.querySelector('.session-status').textContent,
        ctx.sidebar.buildSessionItem(updated).querySelector('.session-status').textContent);
    }
  } finally { ctx.destroy(); }
});

test('first and live status slots expose the CLI status and reason in title and aria-label', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.Date.now = () => now;
    ctx.evalPublic('agents-view.js');
    const session = sessionFor({ status: 'idle' });
    ctx.window.activePtyIds.add(session.sessionId);
    ctx.sidebar.renderProjects([makeSampleProject({ sessions: [session] })], true);
    const item = ctx.document.getElementById('si-' + session.sessionId);
    for (const entry of [...cases, cases[1]]) {
      const updated = sessionFor(entry);
      ctx.window.sessionMap.set(session.sessionId, updated);
      ctx.window.applyStateClasses(session.sessionId, ctx.window.snapshotForLocal(session.sessionId, updated));
      for (const row of [ctx.sidebar.buildSessionItem(updated), item]) {
        const slot = row.querySelector('.session-icon');
        assert.equal(slot.getAttribute('role'), 'img');
        for (const label of [slot.title, slot.getAttribute('aria-label')]) {
          assert.match(label, new RegExp('\\b' + entry.status + '\\b'), entry.status);
          if (entry.waitingFor) assert.ok(label.includes(entry.waitingFor), label);
          else assert.ok(!label.includes('permission prompt'), 'the previous reason is cleared');
        }
        if (row === item) {
          const title = slot.title;
          const accessibleName = slot.getAttribute('aria-label');
          ctx.window.paintSessionIcon(slot, session.sessionId, updated);
          assert.equal(slot.title, title, 'an icon refresh keeps the descriptor detail');
          assert.equal(slot.getAttribute('aria-label'), accessibleName);
        }
      }
    }
  } finally { ctx.destroy(); }
});
