'use strict';

// see .ai/contexts/cli-session-state.md ("V1 trigger reader")
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cli = require('../cli-session-state');
const { createTriggerContext } = require('../src/main/triggers/trigger-context');
const ID = '01234567-89ab-cdef-0123-456789abcdef';

function world(t, { during } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-name-reader-'));
  t.after(() => { cli.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const descriptor = path.join(dir, '300.json');
  const write = fields => fs.writeFileSync(descriptor, JSON.stringify({ pid: 300, sessionId: ID, kind: 'interactive', status: 'idle',
    procStart: '300', name: 'Task', ...fields }));
  write({});
  const starts = { 100: '100', 300: '300' };
  let reads = 0;
  cli.init({ dir, platform: 'linux', isProcessAlive: () => true, readProcStart: pid => starts[pid],
    readParentPid: pid => { if (reads++ === 0) during?.({ write, starts, descriptor }); return ({ 300: 100, 100: 1 })[pid]; } });
  const session = { pty: { pid: 100, write() {} }, generation: 7, host: null, cwd: '/p', composerState: { pending: 0, lastInputAt: 0 } };
  const ctx = createTriggerContext({ activeSessions: new Map([[ID, session]]), cliSessionState: cli, isPtyAlive: () => true,
    getCliStatus: () => undefined, lifecycle: { launchAllowed: () => true } });
  const pinned = ctx.pinDelivery(ID, ctx.getPtyForSession(ID), false, { v1: true, deadline: Date.now() + 5000 });
  return { pinned, starts, write, descriptor, reads: () => reads };
}

test('a stable writer reports the descriptor name from the real ordinary reader', t => {
  assert.equal(world(t).pinned.binding.observeName(), 'Task');
});
const changes = [
  ['the descriptor is replaced by another session', ({ write, descriptor }) => {
    write({ sessionId: '99999999-9999-9999-9999-999999999999' }); fs.utimesSync(descriptor, new Date(), new Date(Date.now() + 5000));
  }],
  ['the descriptor is renamed', ({ write, descriptor }) => { write({ name: 'Other' }); fs.utimesSync(descriptor, new Date(), new Date(Date.now() + 5000)); }],
  ['the descriptor is rewritten for a different process start', ({ write }) => { write({ procStart: '301' }); }],
  ['the writer becomes a background writer', ({ write, descriptor }) => { write({ kind: 'bg' }); fs.utimesSync(descriptor, new Date(), new Date(Date.now() + 5000)); }],
  ['the writer kind disappears', ({ descriptor }) => {
    const raw = JSON.parse(fs.readFileSync(descriptor, 'utf8')); delete raw.kind; fs.writeFileSync(descriptor, JSON.stringify(raw));
  }],
  ['the descriptor PID changes to a live process with the same start', ({ write, starts }) => { starts[301] = '300'; write({ pid: 301 }); }],
  ['the descriptor loses its PID', ({ descriptor }) => {
    const raw = JSON.parse(fs.readFileSync(descriptor, 'utf8')); delete raw.pid; fs.writeFileSync(descriptor, JSON.stringify(raw));
  }],
  ['the descriptor becomes unparseable', ({ descriptor }) => { fs.writeFileSync(descriptor, '{'); }],
  ['the writer PID is reused', ({ starts }) => { starts[300] = '301'; }],
  ['the PTY anchor PID is reused', ({ starts }) => { starts[100] = '101'; }],
];
for (const [label, change] of changes) {
  test(`${label} while the writer is being read yields no name`, t => {
    const w = world(t, { during: change });
    assert.equal(w.pinned.binding.observeName(), null);
  });
}
test('no confirmation read starts once the action is no longer admitted', t => {
  const w = world(t); const confirm = t.mock.method(cli, 'confirmDeliveryWriter');
  let calls = 0;
  assert.equal(w.pinned.binding.observeName(() => calls++ === 0), null);
  assert.equal(confirm.mock.callCount(), 0);
  assert.equal(w.pinned.binding.observeName(() => true), 'Task');
  assert.equal(confirm.mock.callCount(), 1);
});
