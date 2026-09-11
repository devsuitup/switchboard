'use strict';

// Pure decision behind the shared stop control — see
// .ai/contexts/session-state.md ("Lifecycle decisions (2026-09-11)"). No DOM,
// no IPC: this is the only thing that differs between a local and a remote
// stop, so app.js's confirmAndStopSession has a single confirm() call site.

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSessionStop } = require('../public/stop-session-ui');

test('a local session (no remoteAlias) resolves to the plain stop dialog and the local IPC', () => {
  const plan = resolveSessionStop({ sessionId: 's1' });
  assert.deepEqual(plan, { remote: false, alias: null, confirmText: 'Stop this session?' });
});

test('an undefined session (row not found) still resolves to the local stop, never throws', () => {
  const plan = resolveSessionStop(undefined);
  assert.deepEqual(plan, { remote: false, alias: null, confirmText: 'Stop this session?' });
});

test('a remote session resolves to the remote IPC with the host alias named in the dialog text', () => {
  const plan = resolveSessionStop({ sessionId: 's1', remoteAlias: 'vps' });
  assert.equal(plan.remote, true);
  assert.equal(plan.alias, 'vps');
  assert.match(plan.confirmText, /vps/, 'the host alias must be shown, same text shape as the local dialog');
  assert.match(plan.confirmText, /^Stop this session/, 'same text shape as the local confirm()');
});
