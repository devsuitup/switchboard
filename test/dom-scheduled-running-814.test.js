'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

function fixture(t, grouped) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  loadAppFunctions(ctx.context, { functions: ['getExpandedSlugs', 'saveExpandedSlugs'] });
  const run = { sessionId: 'run', summary: 'Audit', modified: '2026-01-01T00:00:00Z',
    ...(grouped ? { scheduleSlug: 'audit' } : {}), runningScheduleIds: ['run'] };
  const newer = { sessionId: 'newer', summary: 'New', modified: '2026-10-31T00:00:00Z' };
  const projects = [makeSampleProject({ sessions: [newer, run] })];
  ctx.window.visibleSessionCount = 1;
  ctx.window.sessionMap.set('run', run);
  ctx.window.sessionMap.set('newer', newer);
  return { ctx, run, projects };
}

for (const grouped of [false, true]) {
  test(`schedule ${grouped ? 'group' : 'row'} liveness changes restore ordering during ordinary reloads`, t => {
    const { ctx, run, projects } = fixture(t, grouped);
    ctx.sidebar.renderProjects(projects, true);
    assert.equal(ctx.document.getElementById('si-run').closest('.sessions-older'), null);
    delete run.runningScheduleIds;
    ctx.sidebar.renderProjects(projects);
    assert.ok(ctx.document.getElementById('si-run').closest('.sessions-older'), 'ordinary reload restores completed schedule ordering');
  });

  test(`a live scheduled ${grouped ? 'group' : 'row'} survives Running and returns to ordinary order on end`, t => {
    const { ctx, run, projects } = fixture(t, grouped);
    ctx.window.showRunningOnly = true;
    ctx.sidebar.renderProjects(projects, true);
    const row = ctx.document.getElementById('si-run');
    assert.ok(row, 'Running must include the headless scheduled run');
    assert.equal(ctx.document.getElementById('si-newer'), null);
    assert.match(row.querySelector('.session-icon').title, /scheduled run in progress/i);
    assert.match(row.querySelector('.session-icon').getAttribute('aria-label'), /scheduled run in progress/i);
    if (grouped) {
      assert.ok(row.closest('.slug-group').querySelector('.slug-group-dot.running'), 'schedule header counts as running');
      assert.ok(row.closest('.slug-group').classList.contains('has-promoted'), 'the running child stays visible in a collapsed group');
    }
    ctx.window.showRunningOnly = false;
    ctx.sidebar.renderProjects(projects, true);
    assert.equal(ctx.document.getElementById('si-run').closest('.sessions-older'), null, 'running item is never older');
    delete run.runningScheduleIds;
    ctx.sidebar.renderProjects(projects, true);
    assert.ok(ctx.document.getElementById('si-run').closest('.sessions-older'), 'completed item returns to ordinary truncation');
    assert.doesNotMatch(ctx.document.getElementById('si-run').querySelector('.session-icon').title, /scheduled run in progress/i);
    ctx.window.showRunningOnly = true;
    ctx.sidebar.renderProjects(projects, true);
    assert.equal(ctx.document.getElementById('si-run'), null);
  });
}

test('schedule running presentation survives activity repaint and ignores a matching remote id', t => {
  const { ctx, run, projects } = fixture(t, false);
  ctx.sidebar.renderProjects(projects, true);
  const icon = ctx.document.getElementById('si-run').querySelector('.session-icon');
  ctx.window.paintSessionIcon(icon, 'run', run);
  assert.match(icon.title, /scheduled run in progress/i);
  const remote = { ...run, sessionId: 'remote', remoteAlias: 'host', runningScheduleIds: ['run'] };
  ctx.window.showRunningOnly = true;
  ctx.sidebar.renderProjects([makeSampleProject({ remoteAlias: 'host', sessions: [remote] })], true);
  assert.equal(ctx.document.getElementById('si-remote'), null);
});
