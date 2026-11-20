'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

const A = 'a9f4e948-5ec1-4bb3-af62-0606a8b4ca77', B = '5190855a-a999-4843-962c-ea84cc36d4ee', J = '22d3a9d7';

function fixture(t) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const file = path.join(__dirname, '../public/agents-view.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx.context, { filename: file });
  const row = { sessionId: B, headSessionId: B, mergedMemberIds: [A], summary: 'switchboard-dev',
    modified: '2026-01-01T00:00:00Z', bgJobId: J, bgSessionId: B };
  const newer = { sessionId: 'newer', summary: 'New', modified: '2026-11-20T00:00:00Z' };
  const projects = [makeSampleProject({ sessions: [newer, row] })];
  ctx.window.visibleSessionCount = 1;
  ctx.window.sessionMap.set(B, row);
  ctx.window.sessionMap.set('newer', newer);
  const roster = (state, hosted) => ctx.window.applyAgentsSnapshot({ cliAvailable: true, cliEntryCount: 1,
    roster: [{ id: J, sessionId: B, kind: 'background', state, cachedJob: true, hosted, listed: true,
      taskEvidence: { valid: true, at: 1, tasks: [], inFlight: 0 } }] });
  const older = () => ctx.document.getElementById('si-' + B)?.closest('.sessions-older') || null;
  return { ctx, row, projects, roster, older };
}

test('a merged conversation hosted by a live background job stays out of Older whatever its date', t => {
  const { ctx, projects, roster, older } = fixture(t);
  roster('working', true);
  ctx.sidebar.renderProjects(projects, true);
  assert.ok(ctx.document.getElementById('si-' + B).querySelector('.bg-badge'), 'the row already shows the job badge');
  assert.equal(older(), null, 'a hosted working job is a running row, never older');
  assert.equal(ctx.window.sortedOrder[0].itemIds[0], 'si-' + B, 'the running row sorts with the running rows');
  roster('done', true);
  ctx.sidebar.renderProjects(projects, true);
  assert.equal(older(), null, 'a hosted job idle at its prompt is still alive');
  roster('done', false);
  ctx.sidebar.renderProjects(projects, true);
  assert.ok(older(), 'a finished job returns the row to ordinary truncation');
});

test('the Running filter lists a conversation hosted by a live background job', t => {
  const { ctx, projects, roster } = fixture(t);
  ctx.window.showRunningOnly = true;
  roster('working', true);
  ctx.sidebar.renderProjects(projects, true);
  assert.ok(ctx.document.getElementById('si-' + B), 'Running must include the hosted job');
  assert.equal(ctx.document.getElementById('si-newer'), null);
  roster('done', false);
  ctx.sidebar.renderProjects(projects, true);
  assert.equal(ctx.document.getElementById('si-' + B), null, 'a finished job leaves Running');
});
