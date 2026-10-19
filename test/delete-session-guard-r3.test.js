'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeDeleteSessionGuard } = require('../delete-session-guard');

function setup() {
  const activeSessions = new Map([['A', { exited: false }]]);
  const rows = [{ sessionId: 'B', mergedIntoSessionId: 'A', projectPath: '/p', folder: '-p' },
    { sessionId: 'A', projectPath: '/p', folder: '-p' }];
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf('function getConversationPartIds(');
  assert.ok(start >= 0);
  const guardStart = source.indexOf('const deleteSessionGuard = makeDeleteSessionGuard(', start);
  const end = source.indexOf(');', guardStart) + 2;
  const context = vm.createContext({
    makeDeleteSessionGuard, activeSessions, getAllCached: () => rows, sessionCache: require('../sidebar-bg-sessions'),
    bgAgents: { liveJobCheck: () => ({ known: true, job: null }) },
    cliSessionState: { getSidebarDescriptors: () => [], liveElsewhereChecked: async () => ({ known: true, live: null }) },
    sessionHasPty: () => false, ptyPids: () => [],
  });
  const guard = vm.runInContext(source.slice(start, end) + '\ndeleteSessionGuard;', context, { filename: 'main.js' });
  return { activeSessions, guard };
}

test('the main Delete guard allows a merged representative after its own terminal is stopped', async () => {
  const { activeSessions, guard } = setup();
  assert.match(await guard('A'), /session is still running/);
  activeSessions.get('A').exited = true;
  assert.equal(await guard('A'), null);
});

test('the main Delete guard still refuses a live member after the representative stops', async () => {
  const { activeSessions, guard } = setup();
  activeSessions.get('A').exited = true;
  activeSessions.set('B', { exited: false });
  assert.match(await guard('A'), /session is still running/);
});
