'use strict';

// Main side of the unsaved-edits handshake (#373): a window close or a blocked
// unload waits for the renderer's answer, and never waits for ever.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createUnsavedGuard } = require('../unsaved-guard');

function setup({ timeoutMs = 1000, quit, closeFinishes = false } = {}) {
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
  const guard = createUnsavedGuard({ ipcMain, timeoutMs, setTimeoutFn, clearTimeoutFn, quit });
  guard.attach(win);

  const closeEvent = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
  const answer = (id, proceed) => ipcMain.emit('unsaved-check-result', {}, id, proceed);
  const ack = (id) => ipcMain.emit('unsaved-check-ack', {}, id);
  return { win, wc, sent, timers, closeEvent, answer, ack, ipcMain, guard };
}

const tick = () => new Promise((r) => setImmediate(r));

test('a close is held while the renderer is asked, and goes through on yes', async () => {
  const t = setup();
  const e = t.closeEvent();
  t.win.emit('close', e);
  assert.equal(e.prevented, true);
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].channel, 'unsaved-check');
  assert.equal(t.sent[0].args[1], 'quit');
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
  assert.equal(t.sent.length, 1);
});

test('a renderer that never answers is given up on after the bound', async () => {
  const t = setup({ timeoutMs: 2500 });
  t.win.emit('close', t.closeEvent());
  assert.equal(t.timers.length, 1);
  assert.equal(t.timers[0].ms, 2500);
  t.timers[0].fn();
  await tick();
  assert.equal(t.win.closes, 1);
});

test('an answer cancels its timer and a late answer is ignored', async () => {
  const t = setup();
  t.win.emit('close', t.closeEvent());
  const id = t.sent[0].args[0];
  t.answer(id, false);
  assert.equal(t.timers[0].cleared, true);
  await tick();
  t.answer(id, true);
  await tick();
  assert.equal(t.win.closes, 0);
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
  const t = setup({ timeoutMs: 2500 });
  t.win.emit('close', t.closeEvent());
  const id = t.sent[0].args[0];
  t.ack(id);
  assert.equal(t.timers[0].cleared, true, 'the ack ends the bound');
  await tick();
  assert.equal(t.win.closes, 0, 'still waiting for the user');
  t.answer(id, true);
  await tick();
  assert.equal(t.win.closes, 1);
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

test('a Windows session end approves the quit so logoff never waits on the dialog', () => {
  for (const name of ['query-session-end', 'session-end']) {
    const t = setup();
    t.win.emit(name, {});
    const e = t.closeEvent();
    assert.equal(t.guard.beforeQuit(e, t.win), false, name);
    const c = t.closeEvent();
    t.win.emit('close', c);
    assert.equal(c.prevented, false, name);
    assert.equal(t.sent.length, 0, name);
  }
});

test('a window close and a quit share one question, and one answer settles both', async () => {
  const t = setup();
  t.win.emit('close', t.closeEvent());
  const e = t.closeEvent();
  assert.equal(t.guard.beforeQuit(e, t.win), true);
  assert.equal(t.sent.length, 1, 'one dialog, not two');
  t.answer(t.sent[0].args[0], true);
  await tick();
  assert.equal(t.win.closes, 1);
  const again = t.closeEvent();
  assert.equal(t.guard.beforeQuit(again, t.win), false, 'the same yes approved the quit');
});

async function closeUnanswered(t) {
  t.win.emit('close', t.closeEvent());
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
