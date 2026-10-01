'use strict';

// Main side of the unsaved-edits handshake (#373): a window close or a blocked
// unload waits for the renderer's answer, and never waits for ever.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createUnsavedGuard } = require('../unsaved-guard');

function setup({ timeoutMs = 1000 } = {}) {
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
  Object.assign(win, { webContents: wc, isDestroyed: () => false, close: () => { win.closes += 1; }, closes: 0 });
  const guard = createUnsavedGuard({ ipcMain, timeoutMs, setTimeoutFn, clearTimeoutFn });
  guard.attach(win);

  const closeEvent = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
  const answer = (id, proceed) => ipcMain.emit('unsaved-check-result', {}, id, proceed);
  return { win, wc, sent, timers, closeEvent, answer, ipcMain };
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
