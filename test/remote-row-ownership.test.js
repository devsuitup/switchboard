// Issue #273: an attached remote row is owned by the local-pty path. The
// remote-ssh adapter (remote-seed/remote-watch/remote-decay) must not write
// sessionBusyState/responseReadySessions or repaint the row while attached,
// and a detach/pty.exit handoff must clear busy at once instead of waiting
// out the 20s decay. See .ai/contexts/session-state.md ("The remote-ssh
// adapter"). Same eval-in-jsdom technique as test/remote-session-adapter.test.js.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const STATE_SRC = path.join(__dirname, '..', 'public', 'session-state.js');
const DOM_SRC = path.join(__dirname, '..', 'public', 'session-activity-dom.js');
const ACTIVITY_SRC = path.join(__dirname, '..', 'public', 'session-activity.js');
const SRC = path.join(__dirname, '..', 'public', 'remote-activity-ui.js');

function setup(sessionIds = ['s1']) {
  const items = sessionIds
    .map(id => `<div class="session-item" data-session-id="${id}"><span class="session-status-dot"></span></div>`)
    .join('');
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${items}</body></html>`,
    { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;

  Object.defineProperty(window, 'activeSessionId', { value: null, writable: true, configurable: true });

  let onRemoteActivityCb = null;
  Object.defineProperty(window, 'api', {
    value: { onRemoteActivity: (cb) => { onRemoteActivityCb = cb; } },
    writable: true, configurable: true,
  });

  const scheduled = [];
  let nextId = 1;
  Object.defineProperty(window, 'setTimeout', {
    value: (fn, ms) => {
      const handle = { id: nextId++, fn, ms, cleared: false };
      scheduled.push(handle);
      return handle.id;
    },
    writable: true, configurable: true,
  });
  Object.defineProperty(window, 'clearTimeout', {
    value: (id) => {
      const h = scheduled.find(s => s.id === id);
      if (h) h.cleared = true;
    },
    writable: true, configurable: true,
  });

  const ctx = dom.getInternalVMContext();
  vm.runInContext(fs.readFileSync(STATE_SRC, 'utf8'), ctx, { filename: STATE_SRC });
  vm.runInContext(fs.readFileSync(DOM_SRC, 'utf8'), ctx, { filename: DOM_SRC });
  vm.runInContext(fs.readFileSync(ACTIVITY_SRC, 'utf8'), ctx, { filename: ACTIVITY_SRC });
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: SRC });

  const call = (fnName, ...args) => vm.runInContext(
    `${fnName}(${args.map((a) => JSON.stringify(a)).join(',')})`, ctx
  );
  const read = (expr) => vm.runInContext(expr, ctx);

  return {
    window,
    document: window.document,
    item: (id) => window.document.querySelector(`.session-item[data-session-id="${id}"]`),
    emit: (payload) => onRemoteActivityCb(payload),
    snapshot: (id) => vm.runInContext(`remoteState(${JSON.stringify(id)}).snapshot()`, ctx),
    setRemoteAttached: (id, attached) => call('setRemoteAttached', id, attached),
    seedRemoteActivity: (session) => call('seedRemoteActivity', session),
    reconcileBusyState: (entries, sinceSeq) => vm.runInContext(
      `reconcileBusyState(${JSON.stringify(entries)}, ${JSON.stringify(sinceSeq)})`, ctx
    ),
    sessionBusyState: read('sessionBusyState'),
    responseReadySessions: read('responseReadySessions'),
    scheduled,
    pending: () => scheduled.filter(h => !h.cleared),
    destroy: () => window.close(),
  };
}

// Symptom 1 (trace-2026-09-12.md, session 1cc1ca36): reconcileBusyState (the
// local-pty path, from the attached PTY's OSC titles) sets the row idle and
// arms response-ready; remote-seed/remote-watch must not then delete it and
// force busy back on.
test('symptom 1 (#273): a remote-watch event must not overwrite an attached row the local-pty path just idled', () => {
  const t = setup(['s1']);
  t.setRemoteAttached('s1', true);

  // The local-pty path, via reconcileBusyState: busy, then idle+response-ready.
  t.reconcileBusyState([{ sessionId: 's1', busy: true }], 0);
  t.reconcileBusyState([{ sessionId: 's1', busy: false }], 999999);
  assert.equal(t.responseReadySessions.has('s1'), true, 'precondition: local-pty armed response-ready');
  assert.ok(t.item('s1').classList.contains('response-ready'), 'precondition: painted response-ready');

  // remote-watch fires next (a transcript write the host reported).
  t.emit({ sessionId: 's1', at: Date.now() });

  assert.equal(t.responseReadySessions.has('s1'), true, 'remote-watch must not delete responseReadySessions while attached');
  assert.equal(t.sessionBusyState.get('s1'), false, 'remote-watch must not force busy while attached');
  assert.ok(t.item('s1').classList.contains('response-ready'), 'the row must stay response-ready, not flap back to busy');
  assert.ok(!t.item('s1').classList.contains('cli-busy'));
  t.destroy();
});

// Symptom 2 (trace-2026-09-12.md, throwaway sessions): pty.exit of a remote
// attach fires almost immediately when the host process dies, but the row
// stayed busy for ~20s until remote-decay finally cleared it.
test('symptom 2 (#273): pty.exit of a remote attach clears busy at once, no 20s tail', () => {
  const t = setup(['s1']);
  // Busy accrues on the remote-ssh side (with a live decay timer) before the
  // tab attaches to it — the adapter's own internal state is left busy.
  t.emit({ sessionId: 's1', at: Date.now() });
  t.setRemoteAttached('s1', true);
  assert.ok(t.item('s1').classList.contains('cli-busy'), 'precondition: row shows busy');

  const remoteActiveAt = Date.now() - 5000; // last known activity before the death, captured before the handoff
  t.setRemoteAttached('s1', false); // pty.exit of the local ssh attach

  assert.equal(t.snapshot('s1').busy, false, 'busy must clear at the handoff instant, not wait for the 20s decay');
  assert.ok(!t.item('s1').classList.contains('cli-busy'), 'the row must stop looking busy within one render');
  assert.equal(t.pending().length, 0, 'no decay timer should be left pending to repaint busy later');

  // A subsequent render re-seeds from the session's own (now-stale, unchanged
  // since the process died) remoteActiveAt — must not re-arm the row busy.
  t.seedRemoteActivity({ sessionId: 's1', remoteAlias: 'planificator', remoteActiveAt });
  assert.ok(!t.item('s1').classList.contains('cli-busy'), 'a stale seed window must not re-arm busy after the handoff');
  t.destroy();
});
