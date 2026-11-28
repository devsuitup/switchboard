'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setupSidebarDom } = require('./dom-setup');
const { lifecycleLabel } = require('../public/process-exit');

const LIVENESS = path.join(__dirname, '..', 'public', 'cli-liveness.js');

function setup(t) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.window.dormantWorkingSet = new Map();
  vm.runInContext(fs.readFileSync(LIVENESS, 'utf8'), ctx.context, { filename: LIVENESS });
  const timers = [];
  ctx.window.cliLiveness = vm.runInContext('createCliLiveness', ctx.context)({
    setTimer: fn => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
    isOnline: () => true,
    restart: async () => true,
  });
  const fire = () => timers.shift()();
  const session = { sessionId: 's1', summary: 'Restored', modified: new Date().toISOString() };
  ctx.window.sessionMap.set('s1', session);
  ctx.window.activePtyIds.add('s1');
  ctx.emitHeadTurn('s1', 'closed');
  return { ctx, session, fire };
}

const PENDING = 'No CLI connected · Open here · restarts once, when the network is back or within 5 minutes';
const SPENT = 'No CLI connected · Open here · stop it, then click it to start it again';

test('GIVEN a PTY open here with no CLI THEN the lifecycle words say so and what happens next', () => {
  assert.equal(lifecycleLabel({ ptyHere: true, noCli: true, restartPending: true }),
    'Open here · no CLI connected · restarts once, when the network is back or within 5 minutes');
  assert.equal(lifecycleLabel({ ptyHere: true, noCli: true, restartPending: false }),
    'Open here · no CLI connected · stop it, then click it to start it again');
  assert.equal(lifecycleLabel({ noCli: true, exit: { stopped: true } }), 'Stopped');
  assert.equal(lifecycleLabel({ ptyHere: true, attach: true, noCli: true }), 'Attached here · keeps running in the background');
});

test('GIVEN a restored row whose CLI never connected THEN the sidebar slot shows Not running\'s dash and says no CLI, then clears on connect', t => {
  const { ctx, session, fire } = setup(t);
  const row = ctx.sidebar.buildSessionItem(session);
  ctx.window.sidebarContent.append(row);
  const slot = row.querySelector('.session-icon');
  assert.equal(slot.title, 'Idle · Open here');
  ctx.window.cliLiveness.expect('s1');
  ctx.window.cliLiveness.mcpState('s1', 'listening');
  fire();
  ctx.window.applyStateClasses('s1', ctx.window.storedActivitySnapshot('s1'));
  assert.equal(slot.title, PENDING);
  assert.equal(slot.getAttribute('aria-label'), PENDING);
  assert.equal(slot.classList.contains('session-icon--stale'), true);
  const rebuilt = ctx.sidebar.buildSessionItem(session);
  assert.equal(rebuilt.querySelector('.session-icon').title, PENDING);
  ctx.window.cliLiveness.mcpState('s1', 'connected');
  ctx.window.applyStateClasses('s1', ctx.window.storedActivitySnapshot('s1'));
  assert.equal(slot.title, 'Idle · Open here');
  assert.equal(slot.classList.contains('session-icon--stale'), false);
});

test('GIVEN a row whose one automatic restart is spent THEN the slot says to stop and click it', async t => {
  const { ctx, session, fire } = setup(t);
  const row = ctx.sidebar.buildSessionItem(session);
  ctx.window.sidebarContent.append(row);
  ctx.window.cliLiveness.expect('s1');
  ctx.window.cliLiveness.mcpState('s1', 'listening');
  fire();
  fire();
  await new Promise(resolve => setImmediate(resolve));
  ctx.window.paintSessionIcon(row.querySelector('.session-icon'), 's1');
  assert.equal(row.querySelector('.session-icon').title, SPENT);
});

test('GIVEN the tracker reports no CLI for a session without a PTY here THEN the row keeps its own words', t => {
  const { ctx, session, fire } = setup(t);
  ctx.window.cliLiveness.expect('s1');
  ctx.window.cliLiveness.mcpState('s1', 'listening');
  fire();
  ctx.window.activePtyIds.delete('s1');
  const row = ctx.sidebar.buildSessionItem(session);
  assert.equal(row.querySelector('.session-icon').classList.contains('session-icon--stale'), false);
  assert.doesNotMatch(row.querySelector('.session-icon').title, /No CLI/);
});
