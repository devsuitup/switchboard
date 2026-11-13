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

function world(t, { during, anchor: anchorMode = 'start' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-name-reader-'));
  t.after(() => { cli.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const descriptor = path.join(dir, '300.json');
  const write = fields => fs.writeFileSync(descriptor, JSON.stringify({ pid: 300, sessionId: ID, kind: 'interactive', status: 'idle',
    procStart: '300', name: 'Task', ...fields }));
  write({});
  const starts = { 100: '100', 300: '300' };
  const anchor = { mode: anchorMode, flipped: 0 };
  let reads = 0;
  cli.init({ dir, platform: 'linux', isProcessAlive: () => true, readProcStart: pid => {
      if (pid === 100 && anchor.mode === 'throw') throw new Error('unreadable');
      if (pid === 100 && anchor.mode === 'flip' && anchor.flipped++ > 0) return '101';
      if (pid === 100 && anchor.mode === 'null') return null;
      if (pid === 100 && anchor.mode === 'undefined') return undefined;
      return starts[pid];
    },
    readParentPid: pid => { if (reads++ === 0) during?.({ write, starts, descriptor, anchor }); return ({ 300: 100, 100: 1 })[pid]; } });
  const session = { pty: { pid: 100, write() {} }, generation: 7, host: null, cwd: '/p', composerState: { pending: 0, lastInputAt: 0 } };
  const ctx = createTriggerContext({ activeSessions: new Map([[ID, session]]), cliSessionState: cli, isPtyAlive: () => true,
    getCliStatus: () => undefined, lifecycle: { launchAllowed: () => true } });
  const pinned = ctx.pinDelivery(ID, ctx.getPtyForSession(ID), false, { v1: true, deadline: Date.now() + 5000 });
  return { pinned, starts, write, descriptor, anchor, session, reads: () => reads };
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
  ['the descriptor and the process are replaced by a self-consistent process with another start', ({ write, starts }) => {
    starts[300] = '301'; write({ procStart: '301' });
  }],
  ['the descriptor changes its PID domain', ({ write }) => { write({ pidDomain: 'win32:unproven' }); }],
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

for (const mode of ['null', 'undefined', 'throw']) {
  test(`an anchor start that reads as ${mode} after the confirmation yields no name`, t => {
    const w = world(t); const real = cli.confirmDeliveryWriter;
    t.mock.method(cli, 'confirmDeliveryWriter', raw => { const confirmed = real(raw); w.anchor.mode = mode; return confirmed; });
    assert.equal(w.pinned.binding.observeName(), null);
    assert.equal(w.pinned.binding.writerIdentity, null);
  });
}
test('an anchor start that changes after the confirmation yields no name', t => {
  const w = world(t); const real = cli.confirmDeliveryWriter;
  t.mock.method(cli, 'confirmDeliveryWriter', raw => { const confirmed = real(raw); w.starts[100] = '101'; return confirmed; });
  assert.equal(w.pinned.binding.observeName(), null);
});
test('an anchor whose start was never readable yields no name even when it stays unreadable', t => {
  const w = world(t, { anchor: 'null' });
  assert.equal(w.pinned.binding.observeName(), null);
});
test('a PTY whose PID changes during the observation yields no name while the old PID keeps its start', t => {
  const w = world(t); const real = cli.confirmDeliveryWriter;
  t.mock.method(cli, 'confirmDeliveryWriter', raw => { const confirmed = real(raw); w.session.pty.pid = 101; return confirmed; });
  assert.equal(w.starts[100], '100');
  assert.equal(w.pinned.binding.observeName(), null);
});
test('an anchor start that changes only at the final read yields no name', t => {
  const w = world(t); const real = cli.confirmDeliveryWriter;
  t.mock.method(cli, 'confirmDeliveryWriter', raw => { const confirmed = real(raw); w.anchor.mode = 'flip'; return confirmed; });
  assert.equal(w.pinned.binding.observeName(), null);
});
test('a PTY start that is readable only during the ordinary ancestry check still yields no name', t => {
  const w = world(t, { anchor: 'null', during: ({ anchor }) => { anchor.mode = 'start'; } });
  const real = cli.confirmDeliveryWriter; const confirmed = [];
  t.mock.method(cli, 'confirmDeliveryWriter', raw => { const ok = real(raw); confirmed.push(ok); w.anchor.mode = 'null'; return ok; });
  assert.equal(w.pinned.binding.observeName(), null);
  assert.deepEqual(confirmed, [true]);
});
