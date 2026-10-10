'use strict';

// Main side of the unsaved-edits handshake (#373): a window close or a blocked
// unload waits for the renderer's answer, and never waits for ever.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const { createUnsavedGuard, LOGOFF_CANCEL_MS } = require('../unsaved-guard');

function setup({ timeoutMs = 1000, probeMs = 1500, dialogCeilingMs, quit, closeFinishes = false } = {}) {
  const ipcMain = new EventEmitter();
  const timers = [];
  const setTimeoutFn = (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; };
  const clearTimeoutFn = (t) => { t.cleared = true; };
  const sent = [];
  const wc = new EventEmitter();
  Object.assign(wc, {
    send: (channel, ...args) => sent.push({ channel, args }),
    isDestroyed: () => false,
    isCrashed: () => false,
    reload: () => { wc.reloads += 1; },
    reloads: 0,
  });
  const win = new EventEmitter();
  Object.assign(win, {
    webContents: wc,
    isDestroyed: () => win.destroys > 0 || win.closed,
    close: () => { win.closes += 1; if (closeFinishes) win.closed = true; },
    destroy: () => { win.destroys += 1; },
    closes: 0,
    destroys: 0,
    closed: false,
  });
  const guard = createUnsavedGuard({ ipcMain, timeoutMs, probeMs, dialogCeilingMs, setTimeoutFn, clearTimeoutFn, quit: quit || (() => win.close()) });
  guard.attach(win);

  const closeEvent = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
  const answer = (id, proceed) => ipcMain.emit('unsaved-check-result', {}, id, proceed);
  const ack = (id) => ipcMain.emit('unsaved-check-ack', {}, id);
  const pong = (token) => ipcMain.emit('unsaved-pong', { sender: wc }, token);
  const pings = () => sent.filter((m) => m.channel === 'unsaved-ping');
  const checks = () => sent.filter((m) => m.channel === 'unsaved-check');
  const reasons = () => sent.filter((m) => m.channel === 'unsaved-check-reason');
  const nativeDialog = (open) => ipcMain.emit('unsaved-dialog', { sender: wc }, open);
  const armed = (ms) => timers.filter((x) => x.ms === ms && !x.cleared);
  return { win, wc, sent, timers, closeEvent, answer, ack, pong, pings, checks, reasons, nativeDialog, armed, ipcMain, guard };
}

const tick = () => new Promise((r) => setImmediate(r));

test('a close is held while the renderer is asked, and goes through on yes', async () => {
  const t = setup();
  const e = t.closeEvent();
  t.win.emit('close', e);
  assert.equal(e.prevented, true);
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].channel, 'unsaved-check');
  assert.equal(t.sent[0].args[1], 'close', 'a window close is told apart from a quit');
  assert.equal(t.win.closes, 0);

  t.answer(t.sent[0].args[0], true);
  await tick();
  assert.equal(t.win.closes, 1);

  const again = t.closeEvent();
  t.win.emit('close', again);
  assert.equal(again.prevented, false, 'the approved close is not asked about again');
});

test('a no keeps the window open and a later close asks again', async () => {
  const t = setup();
  t.win.emit('close', t.closeEvent());
  t.answer(t.sent[0].args[0], false);
  await tick();
  assert.equal(t.win.closes, 0);

  const e = t.closeEvent();
  t.win.emit('close', e);
  assert.equal(e.prevented, true);
  assert.equal(t.sent.length, 2);
});

test('a second close while the question is open asks nothing more', () => {
  const t = setup();
  t.win.emit('close', t.closeEvent());
  const e = t.closeEvent();
  t.win.emit('close', e);
  assert.equal(e.prevented, true);
  assert.equal(t.checks().length, 1);
});

test('a quit the renderer never acknowledges is given up on after the bound', async () => {
  let quits = 0;
  const t = setup({ timeoutMs: 2500, quit: () => { quits += 1; } });
  t.guard.beforeQuit(t.closeEvent(), t.win);
  assert.equal(t.timers.length, 1);
  assert.equal(t.timers[0].ms, 2500);
  t.timers[0].fn();
  await tick();
  assert.equal(quits, 1);
});

test('a window close the renderer has not acknowledged waits: a busy page is asked once it is free', async () => {
  const t = setup({ timeoutMs: 2500 });
  t.win.emit('close', t.closeEvent());
  const [mark] = t.armed(2500);
  mark.fn();
  await tick();
  assert.equal(t.win.closes + t.win.destroys, 0, 'no bound closes the window without the question');
  t.ack(t.sent[0].args[0]);
  t.answer(t.sent[0].args[0], true);
  await tick();
  assert.equal(t.win.closes, 1);
  assert.equal(t.win.destroys, 0);
});

test('an answer cancels its timer and a late answer is ignored', async () => {
  let quits = 0;
  const t = setup({ quit: () => { quits += 1; } });
  t.guard.beforeQuit(t.closeEvent(), t.win);
  const id = t.sent[0].args[0];
  t.answer(id, false);
  assert.equal(t.timers[0].cleared, true);
  await tick();
  t.answer(id, true);
  await tick();
  assert.equal(quits, 0);
});

test('a crashed renderer is not asked', async () => {
  const t = setup();
  t.wc.isCrashed = () => true;
  const e = t.closeEvent();
  t.win.emit('close', e);
  await tick();
  assert.equal(t.sent.length, 0);
  assert.equal(t.win.closes, 1);
});

test('a blocked unload asks the renderer and reloads on yes only', async () => {
  const t = setup();
  const e = t.closeEvent();
  t.wc.emit('will-prevent-unload', e);
  assert.equal(e.prevented, false, 'the page keeps its own veto until the user answers');
  assert.equal(t.sent[0].args[1], 'reload');
  t.answer(t.sent[0].args[0], false);
  await tick();
  assert.equal(t.wc.reloads, 0);

  t.wc.emit('will-prevent-unload', t.closeEvent());
  t.answer(t.sent[1].args[0], true);
  await tick();
  assert.equal(t.wc.reloads, 1);
});

test('a blocked unload during an approved close is let through', () => {
  const t = setup();
  t.win.emit('close', t.closeEvent());
  t.answer(t.sent[0].args[0], true);
  return tick().then(() => {
    const e = t.closeEvent();
    t.wc.emit('will-prevent-unload', e);
    assert.equal(e.prevented, true, 'preventDefault on will-prevent-unload lets the unload proceed');
  });
});

test('an acknowledged check waits for a slow human, past the bound', async () => {
  let quits = 0;
  const t = setup({ timeoutMs: 2500, quit: () => { quits += 1; } });
  t.guard.beforeQuit(t.closeEvent(), t.win);
  const id = t.sent[0].args[0];
  t.ack(id);
  assert.equal(t.timers[0].cleared, true, 'the ack ends the bound');
  await tick();
  assert.equal(quits, 0, 'still waiting for the user');
  t.answer(id, true);
  await tick();
  assert.equal(quits, 1);
});

test('an acknowledged check gives up when the renderer process goes away', async () => {
  const t = setup();
  t.win.emit('close', t.closeEvent());
  t.ack(t.sent[0].args[0]);
  t.wc.emit('render-process-gone');
  await tick();
  assert.equal(t.win.closes, 1);
});

test('a reload approved by timeout reloads once, not in a loop', async () => {
  const t = setup();
  t.wc.emit('will-prevent-unload', t.closeEvent());
  t.timers[0].fn();
  await tick();
  assert.equal(t.wc.reloads, 1);
  const e = t.closeEvent();
  t.wc.emit('will-prevent-unload', e);
  assert.equal(e.prevented, true, 'the reloaded page is let through');
  assert.equal(t.sent.length, 1, 'and is not asked again');
  t.wc.emit('will-prevent-unload', t.closeEvent());
  assert.equal(t.sent.length, 2, 'the allowance covers one unload only');
});

function fakeApp(t, cleanup) {
  const app = new EventEmitter();
  app.quitCalls = 0;
  app.quit = () => {
    app.quitCalls += 1;
    const e = t.closeEvent();
    app.emit('before-quit', e);
    if (e.prevented) return;
    const c = t.closeEvent();
    t.win.emit('close', c);
    if (c.prevented) return;
    app.emit('will-quit');
  };
  app.on('before-quit', (e) => {
    if (t.guard.beforeQuit(e, t.win)) return;
    cleanup();
  });
  return app;
}

test('quit cleanup runs only once the user has confirmed, and Cancel leaves everything alive', async () => {
  let cleaned = 0;
  let app;
  const t = setup({ quit: () => app.quit() });
  app = fakeApp(t, () => { cleaned += 1; });
  let willQuit = 0;
  app.on('will-quit', () => { willQuit += 1; });

  app.quit();
  assert.equal(cleaned, 0, 'no cleanup while the question is open');
  t.ack(t.sent[0].args[0]);
  t.answer(t.sent[0].args[0], false);
  await tick();
  assert.equal(cleaned, 0, 'Cancel: PTYs and watchers untouched');
  assert.equal(willQuit, 0);

  app.quit();
  t.answer(t.sent[1].args[0], true);
  await tick();
  assert.equal(cleaned, 1);
  assert.equal(willQuit, 1);
  assert.equal(t.sent.length, 2, 'the window close after approval asks nothing more');
});

test('an updater install asks before the installer starts: a no leaves it unstarted, a yes pre-approves the quit', async () => {
  const t = setup();
  const first = t.guard.confirmQuit(t.win);
  t.ack(t.sent[0].args[0]);
  t.answer(t.sent[0].args[0], false);
  assert.equal(await first, false);

  const second = t.guard.confirmQuit(t.win);
  t.answer(t.sent[1].args[0], true);
  assert.equal(await second, true);
  const e2 = t.closeEvent();
  assert.equal(t.guard.beforeQuit(e2, t.win), false, 'the quit the installer triggers is not asked about again');
  assert.equal(e2.prevented, false);
  const c = t.closeEvent();
  t.win.emit('close', c);
  assert.equal(c.prevented, false);
});

test('a Windows session end approves the quit so logoff never waits on the dialog, and asks the renderer to save', () => {
  for (const name of ['query-session-end', 'session-end']) {
    const t = setup();
    t.win.emit(name, {});
    const e = t.closeEvent();
    assert.equal(t.guard.beforeQuit(e, t.win), false, name);
    const c = t.closeEvent();
    t.win.emit('close', c);
    assert.equal(c.prevented, false, name);
    assert.deepEqual(t.sent.map((m) => m.channel), ['exit-flush'], `${name}: no dialog, one save request`);
  }
});

test('a window close and a quit share one question, and one answer settles both', async () => {
  const t = setup({ quit: () => {} });
  t.win.emit('close', t.closeEvent());
  const e = t.closeEvent();
  assert.equal(t.guard.beforeQuit(e, t.win), true);
  assert.equal(t.checks().length, 1, 'one dialog, not two');
  t.answer(t.sent[0].args[0], true);
  await tick();
  assert.equal(t.win.closes, 1);
  const again = t.closeEvent();
  assert.equal(t.guard.beforeQuit(again, t.win), false, 'the same yes approved the quit');
});

test('a quit that joins an unanswered reload check tells the renderer it is now an exit, once', async () => {
  const quits = [];
  const t = setup({ quit: () => quits.push(1) });
  t.wc.emit('will-prevent-unload', t.closeEvent());
  const id = t.sent[0].args[0];
  assert.equal(t.sent[0].args[1], 'reload');
  assert.equal(t.guard.beforeQuit(t.closeEvent(), t.win), true);
  t.win.emit('close', t.closeEvent());
  assert.deepEqual(t.sent.map((m) => m.channel), ['unsaved-check', 'unsaved-check-reason'], 'one upgrade, no second question');
  assert.deepEqual(t.sent[1].args, [id, 'quit']);
  t.answer(id, true);
  await tick();
  assert.equal(quits.length, 1);
});

test('a reload check that a quit joined quits without reloading first', async () => {
  const quits = [];
  const t = setup({ quit: () => quits.push(1) });
  t.wc.emit('will-prevent-unload', t.closeEvent());
  const id = t.sent[0].args[0];
  t.guard.beforeQuit(t.closeEvent(), t.win);
  t.answer(id, true);
  await tick();
  assert.equal(t.wc.reloads, 0);
  assert.equal(quits.length, 1);
});

test('a reload joining a quit check leaves it a quit', () => {
  const t = setup();
  t.win.emit('close', t.closeEvent());
  t.wc.emit('will-prevent-unload', t.closeEvent());
  assert.deepEqual(t.sent.map((m) => m.channel), ['unsaved-check']);
});

test('a logoff that never ends the session stops approving quits after a while; a session end keeps it', () => {
  const t = setup();
  t.win.emit('query-session-end', {});
  const revert = t.timers.find((x) => x.ms === LOGOFF_CANCEL_MS && !x.cleared);
  assert.ok(revert, 'the approval is temporary');
  assert.equal(t.guard.beforeQuit(t.closeEvent(), t.win), false);
  revert.fn();
  const e = t.closeEvent();
  assert.equal(t.guard.beforeQuit(e, t.win), true, 'a cancelled logoff asks again on the next quit');
  assert.equal(e.prevented, true);

  const s = setup();
  s.win.emit('query-session-end', {});
  s.win.emit('session-end', {});
  assert.ok(s.timers.filter((x) => x.ms === LOGOFF_CANCEL_MS).every((x) => x.cleared));
  assert.equal(s.guard.beforeQuit(s.closeEvent(), s.win), false);
});

async function closeUnanswered(t) {
  t.guard.beforeQuit(t.closeEvent(), t.win);
  t.timers.filter((x) => x.ms === 2500 && !x.cleared).pop().fn();
  await tick();
}

test('a page that never acknowledges is closed the usual way, and destroyed once reported unresponsive', async () => {
  const t = setup({ timeoutMs: 2500 });
  await closeUnanswered(t);
  assert.equal(t.win.closes, 1, 'a page that is only slow still closes the usual way');
  assert.equal(t.win.destroys, 0);
  assert.equal(t.timers.filter((x) => !x.cleared && x.ms !== 2500).length, 0, 'no fixed delay destroys a busy page');
  t.win.emit('unresponsive');
  assert.equal(t.win.destroys, 1, 'a hung page never runs its beforeunload, so its close would never finish');
});

test('a busy page that answers again is not destroyed', async () => {
  const t = setup({ timeoutMs: 2500, closeFinishes: true });
  await closeUnanswered(t);
  t.win.emit('responsive');
  t.win.emit('unresponsive');
  assert.equal(t.win.destroys, 0, 'the close finished, nothing left to force');
});

test('a page already reported unresponsive is destroyed when its unanswered close does not finish', async () => {
  const t = setup({ timeoutMs: 2500 });
  t.win.emit('unresponsive');
  assert.equal(t.win.destroys, 0, 'unresponsive alone never destroys');
  await closeUnanswered(t);
  assert.equal(t.win.destroys, 1);

  const recovered = setup({ timeoutMs: 2500 });
  recovered.win.emit('unresponsive');
  recovered.win.emit('responsive');
  await closeUnanswered(recovered);
  assert.equal(recovered.win.destroys, 0, 'a page that answered again is given its close');
});

test('closing again a window whose unanswered close did not finish destroys it', async () => {
  const t = setup({ timeoutMs: 2500 });
  await closeUnanswered(t);
  const ours = t.closeEvent();
  t.win.emit('close', ours);
  assert.equal(t.win.destroys, 0, 'the close the guard itself started is not a second one');
  const again = t.closeEvent();
  t.win.emit('close', again);
  assert.equal(t.win.destroys, 1);
});

test('a quit the page never acknowledges goes ahead, and the window is destroyed once reported unresponsive', async () => {
  let quits = 0;
  const t = setup({ timeoutMs: 2500, quit: () => { quits += 1; } });
  assert.equal(t.guard.beforeQuit(t.closeEvent(), t.win), true);
  t.timers.find((x) => x.ms === 2500).fn();
  await tick();
  assert.equal(quits, 1);
  assert.equal(t.win.destroys, 0);
  t.win.emit('unresponsive');
  assert.equal(t.win.destroys, 1, 'app.quit() closes the window, which a hung page holds');
});

test('an answered check never destroys the window, even while the user takes time to answer', async () => {
  const t = setup({ timeoutMs: 2500 });
  t.win.emit('close', t.closeEvent());
  t.ack(t.sent[0].args[0]);
  t.win.emit('unresponsive');
  t.answer(t.sent[0].args[0], true);
  await tick();
  t.win.emit('unresponsive');
  t.win.emit('close', t.closeEvent());
  t.win.emit('close', t.closeEvent());
  assert.equal(t.win.closes, 1);
  assert.equal(t.win.destroys, 0);
});

test('a page that acknowledges a check is no longer counted unresponsive', async () => {
  const t = setup({ timeoutMs: 2500 });
  t.win.emit('unresponsive');
  t.win.emit('close', t.closeEvent());
  t.ack(t.sent[0].args[0]);
  t.answer(t.sent[0].args[0], false);
  await tick();
  await closeUnanswered(t);
  assert.equal(t.win.closes, 1);
  assert.equal(t.win.destroys, 0, 'a busy page is given its close');
});

test('an updater install the page never acknowledges is approved, and the window destroyed once reported unresponsive', async () => {
  const t = setup({ timeoutMs: 2500 });
  const confirmed = t.guard.confirmQuit(t.win);
  t.timers.find((x) => x.ms === 2500).fn();
  assert.equal(await confirmed, true);
  assert.equal(t.win.destroys, 0, 'quitAndInstall still closes the window the usual way');
  t.win.emit('unresponsive');
  assert.equal(t.win.destroys, 1);
  assert.equal(t.guard.beforeQuit(t.closeEvent(), t.win), false, 'the quit that follows is approved');
});

// see .ai/contexts/window-frame.md ("A window that stops answering")
test('a window close the page never acknowledges ends once Electron reports the page unresponsive', async () => {
  const t = setup();
  t.win.emit('close', t.closeEvent());
  t.win.emit('unresponsive');
  await tick();
  assert.equal(t.win.destroys, 1, 'a close() would wait for the hung page\'s beforeunload');
  assert.equal(t.win.closes, 0);
});

test('closing again a page that left the check unacknowledged for the bound ends it; a double click does not', async () => {
  const t = setup({ timeoutMs: 2500 });
  t.win.emit('close', t.closeEvent());
  t.win.emit('close', t.closeEvent());
  await tick();
  assert.equal(t.win.destroys, 0, 'a double click on the close button is not taken for a hang');
  assert.equal(t.pings().length, 0, 'a page that has not taken the check cannot take a ping either');
  t.armed(2500)[0].fn();
  await tick();
  assert.equal(t.win.destroys, 0, 'the bound alone destroys nothing: a busy page is not hung');
  t.win.emit('close', t.closeEvent());
  await tick();
  assert.equal(t.win.destroys, 1);
  assert.equal(t.win.closes, 0);
});

test('a second close of a page that has acknowledged pings it, and one that answers keeps waiting for the question', async () => {
  const t = setup();
  t.win.emit('close', t.closeEvent());
  t.ack(t.sent[0].args[0]);
  t.win.emit('close', t.closeEvent());
  assert.equal(t.pings().length, 1);
  t.pong(t.pings()[0].args[0]);
  t.win.emit('close', t.closeEvent());
  assert.equal(t.pings().length, 2, 'a later close checks again');
  await tick();
  assert.equal(t.win.destroys, 0);
  assert.equal(t.win.closes, 0, 'the user still decides');
});

test('closing again a page that has left a ping unanswered for the probe time ends it', async () => {
  const t = setup();
  t.win.emit('close', t.closeEvent());
  t.ack(t.sent[0].args[0]);
  t.win.emit('close', t.closeEvent());
  const [overdue] = t.armed(1500);
  t.win.emit('close', t.closeEvent());
  await tick();
  assert.equal(t.win.destroys, 0, 'a quick repeat is not enough');
  overdue.fn();
  await tick();
  assert.equal(t.win.destroys, 0, 'the probe time alone destroys nothing: a busy page is not hung');
  t.win.emit('close', t.closeEvent());
  await tick();
  assert.equal(t.win.destroys, 1);
});

test('an acknowledged check is ended by unresponsive only while a ping waits for an answer', async () => {
  const t = setup();
  t.win.emit('close', t.closeEvent());
  t.ack(t.sent[0].args[0]);
  t.win.emit('unresponsive');
  await tick();
  assert.equal(t.win.destroys, 0, 'the user may take their time over the question');
  t.win.emit('close', t.closeEvent());
  t.win.emit('unresponsive');
  await tick();
  assert.equal(t.win.destroys, 1, 'a page that took the check, then hung');
});

test('a quit or an updater install never counts as a second close', async () => {
  const t = setup({ quit: () => {} });
  t.win.emit('close', t.closeEvent());
  t.ack(t.sent[0].args[0]);
  t.guard.beforeQuit(t.closeEvent(), t.win);
  t.guard.confirmQuit(t.win);
  assert.equal(t.pings().length, 0);
  assert.deepEqual(t.armed(1500), []);
});

test('a quit that joins a close question tells the page, and a page that has not acknowledged gets the quit bound', async () => {
  let quits = 0;
  const t = setup({ timeoutMs: 2500, quit: () => { quits += 1; } });
  t.win.emit('close', t.closeEvent());
  const [mark] = t.armed(2500);
  t.guard.beforeQuit(t.closeEvent(), t.win);
  assert.equal(mark.cleared, true);
  assert.deepEqual(t.reasons().map((m) => m.args), [[t.sent[0].args[0], 'quit']]);
  const [bound] = t.armed(2500);
  assert.ok(bound, 'SIGTERM or a logout cannot wait for ever on a busy page');
  bound.fn();
  await tick();
  assert.equal(quits, 1);
  assert.equal(t.win.closes, 1);
});

test('a reload question joined by a close becomes a close, and a quit is never turned back into a close', () => {
  const t = setup();
  t.wc.emit('will-prevent-unload', t.closeEvent());
  t.win.emit('close', t.closeEvent());
  assert.deepEqual(t.reasons().map((m) => m.args[1]), ['close']);

  const u = setup({ quit: () => {} });
  u.guard.beforeQuit(u.closeEvent(), u.win);
  u.win.emit('close', u.closeEvent());
  assert.deepEqual(u.reasons(), []);
  assert.equal(u.armed(1000).length, 1, 'the quit keeps its bound');
});

test('a quit the page never acknowledges ends at once when Electron reports the page unresponsive', async () => {
  let quits = 0;
  const t = setup({ quit: () => { quits += 1; } });
  t.guard.beforeQuit(t.closeEvent(), t.win);
  t.win.emit('unresponsive');
  await tick();
  assert.equal(t.win.destroys, 1);
  assert.equal(quits, 1);
});

test('the shipped preload answers a ping once the check handler is registered', () => {
  const listeners = new Map();
  const sends = [];
  let api;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8'), {
    process: { platform: 'fixture', argv: [] },
    require: () => ({
      contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
      ipcRenderer: { on(channel, cb) { listeners.set(channel, cb); }, send(channel, ...args) { sends.push({ channel, args }); } },
      webUtils: {},
    }),
  });
  assert.equal(listeners.has('unsaved-ping'), false);
  api.onUnsavedCheck(() => {});
  listeners.get('unsaved-ping')({}, 7);
  assert.deepEqual(sends, [{ channel: 'unsaved-pong', args: [7] }]);
  const changed = [];
  api.onUnsavedCheckReason((id, reason) => changed.push([id, reason]));
  listeners.get('unsaved-check-reason')({}, 3, 'quit');
  assert.deepEqual(changed, [[3, 'quit']]);
});

test('a native dialog open in the page holds the probe: no ping, no force', async () => {
  const t = setup({ timeoutMs: 2500 });
  t.win.emit('close', t.closeEvent());
  t.armed(2500)[0].fn();
  t.nativeDialog(true);
  assert.deepEqual(t.armed(2500), [], 'the bound restarts once the dialog is answered');
  t.win.emit('close', t.closeEvent());
  t.win.emit('close', t.closeEvent());
  t.win.emit('unresponsive');
  await tick();
  assert.equal(t.win.destroys, 0, 'the user can still answer the dialog');
  t.nativeDialog(false);
  t.win.emit('close', t.closeEvent());
  await tick();
  assert.equal(t.win.destroys, 0, 'the bound starts from zero');
  t.armed(2500)[0].fn();
  t.win.emit('close', t.closeEvent());
  await tick();
  assert.equal(t.win.destroys, 1);

  const u = setup();
  u.win.emit('close', u.closeEvent());
  u.ack(u.sent[0].args[0]);
  u.nativeDialog(true);
  u.win.emit('close', u.closeEvent());
  assert.equal(u.pings().length, 0);
  u.nativeDialog(false);
  u.win.emit('close', u.closeEvent());
  assert.equal(u.pings().length, 1, 'probing resumes once it is answered');
});

test('a check sent while a native dialog is open waits for it before the bound before the ack runs', async () => {
  const t = setup({ timeoutMs: 2500 });
  t.nativeDialog(true);
  t.guard.beforeQuit(t.closeEvent(), t.win);
  assert.deepEqual(t.armed(2500), []);
  t.nativeDialog(false);
  assert.equal(t.armed(2500).length, 1);
  t.ack(t.sent[0].args[0]);
  assert.deepEqual(t.armed(2500), []);
});

test('a dialog reported by another page, or by a page that crashed since, does not pause the bounds', () => {
  const t = setup({ timeoutMs: 2500 });
  t.ipcMain.emit('unsaved-dialog', { sender: {} }, true);
  t.guard.beforeQuit(t.closeEvent(), t.win);
  assert.equal(t.armed(2500).length, 1);

  const u = setup({ timeoutMs: 2500 });
  u.nativeDialog(true);
  u.wc.emit('render-process-gone');
  u.guard.beforeQuit(u.closeEvent(), u.win);
  assert.equal(u.armed(2500).length, 1);

  const v = setup({ timeoutMs: 2500 });
  v.nativeDialog(true);
  v.wc.emit('did-navigate');
  v.guard.beforeQuit(v.closeEvent(), v.win);
  assert.equal(v.armed(2500).length, 1);
});

test('the shipped preload reports a native dialog to main', () => {
  const sends = [];
  let api;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8'), {
    process: { platform: 'fixture', argv: [] },
    require: () => ({
      contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
      ipcRenderer: { on() {}, send(channel, ...args) { sends.push({ channel, args }); } },
      webUtils: {},
    }),
  });
  api.unsavedDialog(true);
  api.unsavedDialog(false);
  assert.deepEqual(sends, [{ channel: 'unsaved-dialog', args: [true] }, { channel: 'unsaved-dialog', args: [false] }]);
});

test('a ping that cannot be sent ends the check at once, as a hung page would', async () => {
  const t = setup();
  t.win.emit('close', t.closeEvent());
  t.ack(t.sent[0].args[0]);
  t.wc.send = () => { throw new Error('gone'); };
  t.win.emit('close', t.closeEvent());
  await tick();
  assert.equal(t.win.destroys, 1);
});

test('a native dialog pauses the quit bound for at most the ceiling, so a quit (SIGTERM, a logout) cannot wait for ever', async () => {
  let quits = 0;
  const t = setup({ timeoutMs: 2500, dialogCeilingMs: 300000, quit: () => { quits += 1; } });
  t.nativeDialog(true);
  assert.equal(t.guard.beforeQuit(t.closeEvent(), t.win), true);
  assert.deepEqual(t.armed(2500), []);
  const [ceiling] = t.armed(300000);
  assert.ok(ceiling, 'the page cannot acknowledge while the dialog blocks it');
  ceiling.fn();
  await tick();
  assert.equal(quits, 1);
  t.win.emit('unresponsive');
  assert.equal(t.win.destroys, 1, 'the blocked page never runs its beforeunload either');
});

test('a pong from another page does not answer the probe', async () => {
  const t = setup();
  t.win.emit('close', t.closeEvent());
  t.ack(t.sent[0].args[0]);
  t.win.emit('close', t.closeEvent());
  const token = t.pings()[0].args[0];
  t.ipcMain.emit('unsaved-pong', { sender: {} }, token);
  t.win.emit('unresponsive');
  await tick();
  assert.equal(t.win.destroys, 1, 'still waiting for this page');

  const u = setup();
  u.win.emit('close', u.closeEvent());
  u.ack(u.sent[0].args[0]);
  u.win.emit('close', u.closeEvent());
  u.pong(u.pings()[0].args[0]);
  u.win.emit('unresponsive');
  await tick();
  assert.equal(u.win.destroys, 0);
});
