// Issue #212 — getRemoteSessions(alias) used to render an empty array for
// three situations nothing distinguished: the host has no live session, the
// host was never read, or the last cycle failed (descriptors deliberately
// cleared). These tests pin that the sidebar now shows three distinct states,
// and that a stale status age never reads as fresh.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

function remoteProject(overrides) {
  return makeSampleProject({
    sessions: [],
    ...overrides,
  });
}

function hostDot(ctx, projectPath) {
  const fId = ctx.sidebar.folderId(projectPath);
  const header = ctx.document.getElementById('ph-' + fId);
  assert.ok(header, 'project header must render for ' + projectPath);
  return header.querySelector('.remote-host-dot');
}

test('a host whose last cycle failed shows an unknown state distinct from a genuinely empty host, reason visible', () => {
  const ctx = setupSidebarDom();
  try {
    const failedHost = remoteProject({
      projectPath: '/srv/failed-host',
      folder: 'planificator::-srv-failed-host',
      remoteAlias: 'planificator',
      remoteHostAt: Date.parse('2026-09-08T10:00:00Z'),
      remoteHostError: 'ssh: connect to host planificator port 22: timed out',
    });
    const emptyHost = remoteProject({
      projectPath: '/srv/empty-host',
      folder: 'planificator::-srv-empty-host',
      remoteAlias: 'planificator',
      remoteHostAt: Date.parse('2026-09-09T09:00:00Z'),
      remoteHostError: null,
    });

    ctx.sidebar.renderProjects([failedHost, emptyHost], true);

    const failedDot = hostDot(ctx, '/srv/failed-host');
    const emptyDot = hostDot(ctx, '/srv/empty-host');

    assert.ok(failedDot, 'a failed-cycle host must carry a status dot');
    assert.ok(emptyDot, 'a genuinely empty host must carry a status dot');
    assert.ok(failedDot.classList.contains('remote-host-error'));
    assert.ok(emptyDot.classList.contains('remote-host-empty'));
    assert.notEqual(failedDot.className, emptyDot.className, 'the two states must render as visually distinct');

    assert.match(failedDot.title, /host unreachable/i, 'the reason must be visible, not just "empty"');
    assert.match(failedDot.title, /timed out/, 'the actual ssh failure reason must reach the UI');
    assert.doesNotMatch(emptyDot.title, /unreachable/i, 'a genuinely empty host must not be worded like a failure');
  } finally { ctx.destroy(); }
});

test('a host never yet read is distinct from both a failed host and an empty host', () => {
  const ctx = setupSidebarDom();
  try {
    const neverRead = remoteProject({
      projectPath: '/srv/never-read',
      folder: 'planificator::-srv-never-read',
      remoteAlias: 'planificator',
      // remoteHostAt / remoteHostError intentionally absent: annotateRemoteAttachable
      // never ran (or the alias was never refreshed) — this is the "never read" case.
    });
    const failedHost = remoteProject({
      projectPath: '/srv/failed-host-2',
      folder: 'planificator::-srv-failed-host-2',
      remoteAlias: 'planificator',
      remoteHostAt: Date.parse('2026-09-08T10:00:00Z'),
      remoteHostError: 'ssh: connect to host planificator port 22: timed out',
    });
    const emptyHost = remoteProject({
      projectPath: '/srv/empty-host-2',
      folder: 'planificator::-srv-empty-host-2',
      remoteAlias: 'planificator',
      remoteHostAt: Date.parse('2026-09-09T09:00:00Z'),
      remoteHostError: null,
    });

    ctx.sidebar.renderProjects([neverRead, failedHost, emptyHost], true);

    const neverReadDot = hostDot(ctx, '/srv/never-read');
    const failedDot = hostDot(ctx, '/srv/failed-host-2');
    const emptyDot = hostDot(ctx, '/srv/empty-host-2');

    assert.ok(neverReadDot.classList.contains('remote-host-unknown'));
    assert.match(neverReadDot.title, /not yet synced/i);

    const classes = new Set([neverReadDot.className, failedDot.className, emptyDot.className]);
    assert.equal(classes.size, 3, 'never-read, failed and empty must be three visually distinct states');
  } finally { ctx.destroy(); }
});

test('a live remote session shows its status and age, and a 24h-old status does not read as fresh', () => {
  const ctx = setupSidebarDom();
  try {
    const now = Date.parse('2026-09-09T12:00:00Z');
    const realNow = ctx.window.Date.now;
    ctx.window.Date.now = () => now;
    try {
      const staleSession = {
        sessionId: 'remote-stale',
        summary: 'stale one',
        modified: '2026-09-08T10:00:00.000Z',
        starred: false,
        archived: 0,
        messageCount: 1,
        projectPath: '/srv/live-host',
        remoteAlias: 'planificator',
        status: 'idle',
        statusUpdatedAt: now - 23 * 3600 * 1000, // 23h ago
      };
      const freshSession = {
        sessionId: 'remote-fresh',
        summary: 'fresh one',
        modified: '2026-09-09T11:59:00.000Z',
        starred: false,
        archived: 0,
        messageCount: 1,
        projectPath: '/srv/live-host',
        remoteAlias: 'planificator',
        status: 'idle',
        statusUpdatedAt: now - 26 * 1000, // 26s ago
      };
      const project = remoteProject({
        projectPath: '/srv/live-host',
        folder: 'planificator::-srv-live-host',
        remoteAlias: 'planificator',
        remoteHostAt: now,
        remoteHostError: null,
        sessions: [staleSession, freshSession],
      });

      ctx.sidebar.renderProjects([project], true);

      const staleEl = ctx.document.getElementById('si-remote-stale').querySelector('.session-status');
      const freshEl = ctx.document.getElementById('si-remote-fresh').querySelector('.session-status');
      assert.ok(staleEl, 'the stale session must show a status/age indicator');
      assert.ok(freshEl, 'the fresh session must show a status/age indicator');

      assert.match(freshEl.textContent, /idle.*26s ago/);
      assert.match(staleEl.textContent, /idle.*23h ago/);
      assert.notEqual(staleEl.textContent, freshEl.textContent);
      assert.doesNotMatch(staleEl.textContent, /\ds ago/, 'a 24h-old status must not read as a fresh few-seconds-old one');
    } finally {
      ctx.window.Date.now = realNow;
    }
  } finally { ctx.destroy(); }
});

test('a host genuinely without any live session is distinct from a host with a live one', () => {
  const ctx = setupSidebarDom();
  try {
    const liveSession = {
      sessionId: 'remote-live',
      summary: 'live one',
      modified: '2026-09-09T11:59:00.000Z',
      starred: false,
      archived: 0,
      messageCount: 1,
      projectPath: '/srv/live-project',
      remoteAlias: 'planificator',
      status: 'busy',
      statusUpdatedAt: Date.now() - 5000,
    };
    const liveProject = remoteProject({
      projectPath: '/srv/live-project',
      folder: 'planificator::-srv-live-project',
      remoteAlias: 'planificator',
      remoteHostAt: Date.now(),
      remoteHostError: null,
      sessions: [liveSession],
    });
    const emptyProject = remoteProject({
      projectPath: '/srv/really-empty',
      folder: 'planificator::-srv-really-empty',
      remoteAlias: 'planificator',
      remoteHostAt: Date.now(),
      remoteHostError: null,
      sessions: [],
    });

    ctx.sidebar.renderProjects([liveProject, emptyProject], true);

    const liveDot = hostDot(ctx, '/srv/live-project');
    const emptyDot = hostDot(ctx, '/srv/really-empty');

    assert.ok(liveDot.classList.contains('remote-host-live'));
    assert.ok(emptyDot.classList.contains('remote-host-empty'));
    assert.notEqual(liveDot.className, emptyDot.className);
    assert.match(liveDot.title, /1 live session/);
    assert.match(emptyDot.title, /no live session/i);
  } finally { ctx.destroy(); }
});
