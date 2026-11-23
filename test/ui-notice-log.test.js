'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const createClock = require('./fixtures/main-error-clock.cjs');

function setup(t) {
  const filename = path.join(__dirname, '../src/main/app/ui-notice-log.js');
  assert.ok(fs.existsSync(filename), 'the real main UI notice sink exists');
  const { installUiNoticeLog } = require(filename);
  const ipcMain = new EventEmitter();
  const clock = createClock();
  const lines = [];
  const webContents = { mainFrame: {}, isDestroyed: () => false };
  const win = { webContents, isDestroyed: () => false };
  const sink = installUiNoticeLog({ ipcMain, log: { info: line => lines.push(line) }, getWindow: () => win, ...clock });
  t.after(() => sink.dispose());
  const send = value => ipcMain.emit('ui-notice-log', { sender: webContents, senderFrame: webContents.mainFrame }, value);
  return { send, lines, clock, sink, ipcMain, webContents };
}

test('sink writes bounded redacted single-line fields, preserves paths and rejects foreign frames', t => {
  const { send, lines, ipcMain, webContents } = setup(t);
  const event = { event: 'show', kind: 'error', id: 'remote:a', source: 'remote',
    text: 'C:\\project\\file.txt\nAuthorization: Bearer abc-secret token=private password="two words" sk-test0123456789abcdefghijk',
    title: 'api_key=title-secret', choices: ['secret=choice-secret'], choice: 'token=result-secret' };
  ipcMain.emit('ui-notice-log', { sender: {}, senderFrame: webContents.mainFrame }, event);
  ipcMain.emit('ui-notice-log', { sender: webContents, senderFrame: {} }, event);
  assert.equal(lines.length, 0);
  send(event);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[ui-notice\]/);
  assert.doesNotMatch(lines[0], /abc-secret|private|two words|sk-test012|title-secret|choice-secret|result-secret|\n/);
  assert.match(lines[0], /C:\\\\project\\\\file\.txt/);
  send({ event: 'show', kind: 'warning', id: 'x'.repeat(10000), text: 'y'.repeat(100000), choices: Array(1000).fill('z'.repeat(10000)) });
  assert.ok(lines.at(-1).length < 16000, 'event has a fixed total size bound');
  const payload = JSON.parse(lines.at(-1).slice('[ui-notice] '.length));
  assert.ok(payload.id.length <= 160);
  assert.ok(payload.text.length <= 4096);
  assert.ok(payload.choices.length <= 20);
  assert.ok(payload.choices.every(choice => choice.length <= 256));
  send(null);
  send({ event: 'arbitrary', text: 'invalid' });
  assert.equal(lines.length, 2);
});

test('identical consecutive events are counted until transition or deadline, with no live timer after disposal', t => {
  const { send, lines, clock, sink } = setup(t);
  const event = { event: 'show', kind: 'error', id: 'restore:a', text: 'Failed' };
  for (let i = 0; i < 100; i++) send(event);
  assert.equal(lines.length, 1);
  send({ ...event, event: 'dismiss' });
  assert.match(lines[1], /repeated 99×/);
  assert.match(lines[2], /dismiss/);
  send(event);
  send(event);
  clock.advance(1000);
  assert.match(lines.at(-1), /repeated 1×/);
  assert.equal(clock.size, 0);
  send(event);
  send(event);
  sink.dispose();
  assert.match(lines.at(-1), /repeated 1×/);
  assert.equal(clock.size, 0);
});

test('alternating-event loops have a bounded write rate and counted suppressed events', t => {
  const { send, lines, clock } = setup(t);
  for (let i = 0; i < 1000; i++) send({ event: i % 2 ? 'replace' : 'show', kind: 'error', id: 'loop', text: String(i) });
  assert.ok(lines.length <= 20, 'a changing loop cannot flood main.log');
  clock.advance(1000);
  assert.match(lines.at(-1), /suppressed 980 events/);
});

test('timers are unreferenced and logging errors never escape IPC handling', t => {
  const filename = path.join(__dirname, '../src/main/app/ui-notice-log.js');
  assert.ok(fs.existsSync(filename), 'the real main UI notice sink exists');
  const { installUiNoticeLog } = require(filename);
  const ipcMain = new EventEmitter();
  const webContents = { mainFrame: {}, isDestroyed: () => false };
  let unrefs = 0;
  const sink = installUiNoticeLog({ ipcMain, getWindow: () => ({ webContents, isDestroyed: () => false }),
    log: { info() { throw new Error('disk failure'); } }, setTimer: () => ({ unref() { unrefs++; } }), clearTimer() {} });
  t.after(() => sink.dispose());
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  assert.doesNotThrow(() => { ipcMain.emit('ui-notice-log', event, { event: 'show', text: 'one' }); });
  assert.equal(unrefs, 1);
});
