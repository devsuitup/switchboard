// Issue #242/#243: a rebuilt sidebar (or a fresh launch) must paint a remote
// session busy — the same braille spinner a local session gets — straight
// from session.remoteActiveAt, without waiting for the next live
// remote-activity IPC message. See .ai/contexts/session-cache.md
// ("Remote hosts — busy spinner (issue #242)"). The live-update path itself
// is covered by test/remote-activity-ui.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

function remoteProject(session) {
  return makeSampleProject({
    projectPath: '/srv/supervision',
    folder: 'planificator::-srv-supervision',
    remoteAlias: 'planificator',
    sessions: [session],
  });
}

// A render function must not arm timers itself — seedRemoteActivity does,
// and this fake clock drives that timer by hand instead of a real wall-clock
// wait. Installed on ctx.window BEFORE renderProjects() so the seed's
// setTimeout call picks it up.
function installFakeTimers(win) {
  let elapsed = 0;
  const timers = [];
  let nextId = 1;
  Object.defineProperty(win, 'setTimeout', {
    value: (fn, ms) => {
      const t = { id: nextId++, at: elapsed + ms, fn, cleared: false, fired: false };
      timers.push(t);
      return t.id;
    },
    writable: true, configurable: true,
  });
  Object.defineProperty(win, 'clearTimeout', {
    value: (id) => {
      const t = timers.find(t => t.id === id);
      if (t) t.cleared = true;
    },
    writable: true, configurable: true,
  });
  return {
    advance(ms) {
      elapsed += ms;
      for (const t of timers) {
        if (!t.cleared && !t.fired && t.at <= elapsed) { t.fired = true; t.fn(); }
      }
    },
    pendingCount: () => timers.filter(t => !t.cleared && !t.fired).length,
  };
}

test('a session active within the decay window renders busy on first render', () => {
  const ctx = setupSidebarDom();
  try {
    const session = {
      sessionId: 'remote-active', summary: 'live now', modified: '2026-09-06T10:00:00.000Z',
      starred: false, archived: 0, messageCount: 1,
      remoteAlias: 'planificator', remoteActiveAt: Date.now() - 5000,
    };
    ctx.sidebar.renderProjects([remoteProject(session)], true);

    const item = ctx.document.querySelector('#si-remote-active');
    assert.ok(item, 'the session row must exist');
    assert.ok(item.classList.contains('cli-busy'), 'a sighting 5s ago is still inside the 20s decay window');
  } finally { ctx.destroy(); }
});

test('a session last active past the decay window renders idle', () => {
  const ctx = setupSidebarDom();
  try {
    const session = {
      sessionId: 'remote-stale', summary: 'quiet now', modified: '2026-09-06T10:00:00.000Z',
      starred: false, archived: 0, messageCount: 1,
      remoteAlias: 'planificator', remoteActiveAt: Date.now() - 60000,
    };
    ctx.sidebar.renderProjects([remoteProject(session)], true);

    const item = ctx.document.querySelector('#si-remote-stale');
    assert.ok(item);
    assert.ok(!item.classList.contains('cli-busy'), 'a sighting a minute ago is well past the 20s decay window');
  } finally { ctx.destroy(); }
});

test('a session with no remoteActiveAt at all renders idle, not crashing on undefined', () => {
  const ctx = setupSidebarDom();
  try {
    const session = {
      sessionId: 'remote-never', summary: 'never seen writing', modified: '2026-09-06T10:00:00.000Z',
      starred: false, archived: 0, messageCount: 1,
      remoteAlias: 'planificator',
    };
    ctx.sidebar.renderProjects([remoteProject(session)], true);

    const item = ctx.document.querySelector('#si-remote-never');
    assert.ok(item);
    assert.ok(!item.classList.contains('cli-busy'));
  } finally { ctx.destroy(); }
});

test('no .remote-activity-dot element remains anywhere in the DOM', () => {
  const ctx = setupSidebarDom();
  try {
    const session = {
      sessionId: 'remote-active', summary: 'live now', modified: '2026-09-06T10:00:00.000Z',
      starred: false, archived: 0, messageCount: 1,
      remoteAlias: 'planificator', remoteActiveAt: Date.now() - 5000,
    };
    ctx.sidebar.renderProjects([remoteProject(session)], true);

    assert.equal(ctx.document.querySelector('.remote-activity-dot'), null);
  } finally { ctx.destroy(); }
});

test('a local session is not marked busy by the remote paint path', () => {
  const ctx = setupSidebarDom();
  try {
    const project = makeSampleProject({
      sessions: [{
        sessionId: 'local-1', summary: 'local work', modified: '2026-09-06T10:00:00.000Z',
        starred: false, archived: 0, messageCount: 2,
      }],
    });
    ctx.sidebar.renderProjects([project], true);

    const item = ctx.document.querySelector('#si-local-1');
    assert.ok(item);
    assert.ok(!item.classList.contains('cli-busy'));
  } finally { ctx.destroy(); }
});

test('a seeded remote session goes idle once the remaining decay window elapses, and not before', () => {
  const ctx = setupSidebarDom();
  try {
    const timers = installFakeTimers(ctx.window);
    const session = {
      sessionId: 'remote-partial', summary: 'partially aged', modified: '2026-09-06T10:00:00.000Z',
      starred: false, archived: 0, messageCount: 1,
      remoteAlias: 'planificator', remoteActiveAt: Date.now() - 15000,
    };
    ctx.sidebar.renderProjects([remoteProject(session)], true);

    let item = ctx.document.querySelector('#si-remote-partial');
    assert.ok(item.classList.contains('cli-busy'), 'seeded busy on first render (15s old, still inside 20s)');

    timers.advance(4000); // total 4000ms — remaining window (~5000ms) not yet elapsed
    item = ctx.document.querySelector('#si-remote-partial');
    assert.ok(item.classList.contains('cli-busy'), 'must not decay before the remaining window elapses');

    timers.advance(1001); // total 5001ms — past the ~5000ms remaining window
    item = ctx.document.querySelector('#si-remote-partial');
    assert.ok(!item.classList.contains('cli-busy'), 'must go idle once the remaining window elapses');
  } finally { ctx.destroy(); }
});

test('seeding the same still-active session again does not stack a second decay timer', () => {
  const ctx = setupSidebarDom();
  try {
    const timers = installFakeTimers(ctx.window);
    const session = {
      sessionId: 'remote-rerender', summary: 'live now', modified: '2026-09-06T10:00:00.000Z',
      starred: false, archived: 0, messageCount: 1,
      remoteAlias: 'planificator', remoteActiveAt: Date.now() - 5000,
    };
    const project = remoteProject(session);

    ctx.sidebar.renderProjects([project], true);
    assert.equal(timers.pendingCount(), 1, 'exactly one decay timer armed on first seed');

    ctx.sidebar.renderProjects([project], false); // re-render, same session data
    assert.equal(timers.pendingCount(), 1, 'a repeat seed must not arm a second timer for the same session');
  } finally { ctx.destroy(); }
});
