'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

function setup(t, extra = {}) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.window.dormantWorkingSet = new Map();
  const session = { sessionId: 's1', summary: 'Lifecycle', modified: new Date().toISOString(), ...extra };
  ctx.window.sessionMap.set('s1', session);
  return { ctx, session };
}

function checkSlot(row, expected) {
  const slot = row.querySelector('.session-icon');
  assert.equal(slot.title, expected);
  assert.equal(slot.getAttribute('aria-label'), expected);
  assert.equal(slot.textContent, '');
  return slot;
}

test('#563 an idle sidebar row names its terminal open here on render and repaint', t => {
  const { ctx, session } = setup(t);
  ctx.window.activePtyIds.add('s1');
  ctx.emitHeadTurn('s1', 'closed');
  const row = ctx.sidebar.buildSessionItem(session);
  ctx.window.sidebarContent.append(row);
  checkSlot(row, 'Idle · Open here');
  ctx.window.applyStateClasses('s1', ctx.window.storedActivitySnapshot('s1'));
  checkSlot(row, 'Idle · Open here');
  ctx.window.paintSessionIcon(row.querySelector('.session-icon'), 's1');
  checkSlot(row, 'Idle · Open here');
});

test('#563 a dormant sidebar row names restore on click on render and when cleared', t => {
  const { ctx, session } = setup(t);
  ctx.window.dormantWorkingSet.set('s1', {});
  const row = ctx.sidebar.buildSessionItem(session);
  ctx.window.sidebarContent.append(row);
  checkSlot(row, 'Idle · Not reopened · restores on click');
  const { clearDormantRow } = loadAppFunctions(ctx.context, {
    functions: ['dormantRowIds', 'syncDormantRow', 'clearDormantRow'],
  });
  clearDormantRow('s1');
  assert.equal(row.classList.contains('dormant'), false);
  checkSlot(row, 'Idle · Liveness unknown');
  ctx.window.dormantWorkingSet.set('s1', {});
  ctx.window.syncDormantRow('s1');
  checkSlot(row, 'Idle · Not reopened · restores on click');
});

test('#563 a remote tab open here names the host on render and live update', t => {
  const { ctx, session } = setup(t, { remoteAlias: 'vps' });
  ctx.window.activePtyIds.add('s1');
  ctx.window.openSessions.set('s1', { session, attach: true });
  ctx.read('remoteState("s1").apply({ type: "liveness", value: "alive" })');
  ctx.emitHeadTurn('s1', 'closed');
  const row = ctx.sidebar.buildSessionItem(session);
  ctx.window.sidebarContent.append(row);
  const expected = 'Idle · Attached here · runs on vps';
  checkSlot(row, expected);
  ctx.window.applyStateClasses('s1', ctx.window.storedActivitySnapshot('s1'));
  checkSlot(row, expected);
});

test('#563 the status bar counts terminals open here and omits a zero count', t => {
  const { ctx } = setup(t);
  Object.assign(ctx.window, {
    cachedAllProjects: [{ sessions: [{ sessionId: 's1' }, { sessionId: 'child', parentSessionId: 's1' }] }],
    statusBarInfo: ctx.document.createElement('div'),
  });
  const { renderDefaultStatus } = loadAppFunctions(ctx.context, { functions: ['runningSessionCount', 'renderDefaultStatus'] });
  ctx.window.activePtyIds.add('s1');
  renderDefaultStatus();
  assert.equal(ctx.window.statusBarInfo.textContent, '1 open here · 1 sessions · 1 projects');
  ctx.window.activePtyIds.clear();
  renderDefaultStatus();
  assert.equal(ctx.window.statusBarInfo.textContent, '1 sessions · 1 projects');
});

test('#563 the sidebar filter names sessions open here', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'));
  try {
    assert.equal(dom.window.document.querySelector('#running-toggle').title, 'Show sessions open here only');
  } finally {
    dom.window.close();
  }
});

test('#563 a subagent keeps the same label after an activity update', t => {
  const { ctx } = setup(t);
  const child = { sessionId: 'child', parentSessionId: 's1', agentId: 'agent1', summary: 'Child' };
  ctx.window.sessionMap.set('child', child);
  const row = ctx.sidebar.buildSubagentItem(child);
  ctx.window.sidebarContent.append(row);
  checkSlot(row, 'Idle');
  ctx.window.applyStateClasses('child', ctx.window.storedActivitySnapshot('child'));
  checkSlot(row, 'Idle');
});

test('#563 a merged row shows the exit of its non-head root PTY', t => {
  const { ctx, session } = setup(t, { headSessionId: 'head', mergedMemberIds: ['s1', 'head'] });
  ctx.window.sessionMap.set('head', { sessionId: 'head' });
  ctx.window.noteSessionExit('s1', 1, null, false);
  const row = ctx.sidebar.buildSessionItem(session);
  ctx.window.sidebarContent.append(row);
  const expected = 'Idle · Exited (code 1)';
  checkSlot(row, expected);
  ctx.window.applyStateClasses('s1', ctx.window.storedActivitySnapshot('s1'));
  checkSlot(row, expected);
  ctx.window.paintSessionIcon(row.querySelector('.session-icon'), 's1');
  checkSlot(row, expected);
});
