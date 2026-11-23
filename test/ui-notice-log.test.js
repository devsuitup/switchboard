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
  clock.advance(60000);
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
  clock.advance(60000);
  assert.match(lines.at(-1), /suppressed 980 events/);
});

test('M1 adversarial URL fields finish within 50ms', t => {
  const { send } = setup(t);
  const text = 'http://' + 'a:'.repeat(8190);
  const start = performance.now();
  send({ event: 'show', text, id: text, source: text, title: text, choice: text, choices: Array(20).fill(text) });
  assert.ok(performance.now() - start < 50, 'worst-case IPC redaction must finish under 50 ms');
});

const secretProbes = [
  ...['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'client_secret', 'DB_PASSWORD', 'private_key', 'pass', 'access-key'].map(key => `${key}=probe-secret`),
  'Authorization: Basic probe-secret', 'Proxy-Authorization: Token probe-secret',
  'Cookie: a=probe-secret; b=other', 'Set-Cookie: a=probe-secret; HttpOnly',
  ...['xoxa', 'xoxb', 'xoxp', 'xoxr', 'xoxs'].map(prefix => `${prefix}-probe-secret`),
  'eyJhbGciOiJIUzI1NiJ9.payload.signature', 'glpat-probe-secret', 'AKIA1234567890ABCDEF', 'npm_probe_secret',
  ...['sig', 'key', 'signature', 'code', 'auth', 'token', 'access_token'].map(key => `https://example.test/?${key}=probe-secret&next=ok`),
  'sk-probe-secret', 'ghp_probe_secret', 'github_pat_probe_secret', 'Bearer probe-secret', 'https://user:probe-secret@example.test',
];
for (const probe of secretProbes) test(`M2 masks ${probe.split(/[=:]/)[0]}`, t => {
  const { send, lines } = setup(t);
  send({ event: 'show', text: probe });
  const text = JSON.parse(lines[0].slice('[ui-notice] '.length)).text;
  assert.match(text, /\[REDACTED\]/, `secret probe must be redacted: ${probe}`);
  assert.doesNotMatch(text, /probe.secret|eyJhbGci|AKIA123/);
});

test('M2 every redactor stays bounded on 16KB adversarial fields', () => {
  const { redactLogText } = require('../src/main/shared/redact-log-text');
  for (const input of ['a'.repeat(16384), 'a_'.repeat(8192), 'http://' + 'a:'.repeat(8190), 'eyJ' + 'a'.repeat(16381), 'a'.repeat(16370) + 'token=', '"'.repeat(16384)]) {
    const start = performance.now();
    redactLogText(input);
    assert.ok(performance.now() - start < 50, `adversarial redactor under 50ms: ${input.slice(0, 20)}`);
  }
});

for (const alternating of [false, true]) test(`M3 ten-minute ${alternating ? 'alternating' : 'identical'} loop is bounded`, t => {
  const { send, lines, clock, sink } = setup(t);
  const step = alternating ? 20 : 2000;
  for (let time = 0; time < 600000; time += step) {
    send({ event: 'show', id: alternating ? String(time % 40) : 'same', text: 'x'.repeat(4096) });
    clock.advance(step);
  }
  sink.dispose();
  assert.ok(lines.length <= (alternating ? 610 : 11), `fixed line bound, got ${lines.length}`);
  assert.ok(Buffer.byteLength(lines.join('\n')) <= (alternating ? 2600000 : 6000), 'fixed byte bound');
  assert.match(lines.join('\n'), alternating ? /suppressed \d+ events/ : /repeated \d+×/);
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
