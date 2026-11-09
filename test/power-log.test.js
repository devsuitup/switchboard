const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createPowerLog } = require('../src/main/app/power-log');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
  const powerMonitor = new EventEmitter();
  const lines = [];
  const logger = { info: line => lines.push(line) };
  return { powerMonitor, lines, diagnostics: createPowerLog({ powerMonitor, logger }) };
}

test('power and responsiveness events each produce one timestamped log line', () => {
  const { powerMonitor, lines, diagnostics } = setup();
  const window = new EventEmitter();
  window.isDestroyed = () => false;
  window.webContents = { send() {} };
  diagnostics.observeWindow(window);
  const events = ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'on-ac', 'on-battery'];
  for (const event of events) powerMonitor.emit(event);
  window.emit('unresponsive');
  window.emit('responsive');
  assert.equal(lines.length, 8, 'all six power and both window events are logged');
  for (const [i, event] of [...events, 'unresponsive', 'responsive'].entries()) {
    assert.match(lines[i], /^\[power\] \d{4}-\d\d-\d\dT/);
    assert.ok(lines[i].endsWith(` ${event}`));
  }
});

test('renderer backlog logs counts in one bounded line and refuses malformed records', () => {
  const { lines, diagnostics } = setup();
  assert.equal(typeof diagnostics.rendererBacklog, 'function', 'diagnostics accepts event-driven backlog reports');
  diagnostics.rendererBacklog({ gapMs: 9001, sessions: [{ id: '12345678secret\n', chunks: 12, chars: 345 }], omitted: 2 });
  assert.equal(lines.length, 1, 'valid renderer summary reaches the main log');
  assert.match(lines[0], /gapMs=9001.*12345678.*chunks=12.*chars=345.*omitted=2/);
  assert.ok(!lines[0].includes('secret'));
  assert.ok(!lines[0].includes('\n'));
  diagnostics.rendererBacklog({ gapMs: 10000, sessions: Array.from({ length: 1000 }, () => ({ id: 'abcdefgh', chunks: 1, chars: 1 })) });
  assert.ok(lines.at(-1).length < 2048);
  for (const invalid of [null, {}, { gapMs: Infinity, sessions: [] }, { gapMs: -1, sessions: [] }]) diagnostics.rendererBacklog(invalid);
  assert.equal(lines.length, 2);
});

test('backlog IPC accepts only the active window main frame', () => {
  const filename = path.join(__dirname, '..', 'main.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf("ipcMain.on('terminal-backlog'");
  const end = source.indexOf('\n});', start) + 4;
  assert.ok(start >= 0 && end > start, 'main registers the backlog IPC');
  let handler;
  const records = [];
  const webContents = { mainFrame: {} };
  const context = vm.createContext({
    ipcMain: { on: (channel, cb) => { assert.equal(channel, 'terminal-backlog'); handler = cb; } },
    mainWindow: { webContents, isDestroyed: () => false },
    powerLog: { rendererBacklog: record => records.push(record) },
  });
  vm.runInContext(source.slice(start, end), context, { filename, lineOffset: source.slice(0, start).split('\n').length - 1 });
  const record = { gapMs: 9000, sessions: [] };
  handler({ sender: {}, senderFrame: webContents.mainFrame }, record);
  handler({ sender: webContents, senderFrame: {} }, record);
  handler({ sender: webContents }, record);
  assert.equal(records.length, 0);
  handler({ sender: webContents, senderFrame: webContents.mainFrame }, record);
  assert.equal(records.length, 1);
  context.mainWindow = null;
  handler({ sender: webContents, senderFrame: webContents.mainFrame }, record);
  assert.equal(records.length, 1);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(preload, /reportTerminalBacklog: record => ipcRenderer\.send\('terminal-backlog', record\)/);
  assert.match(preload, /onTerminalBacklogRequest: callback => ipcRenderer\.on\('terminal-backlog-request', \(_event\) => callback\(\)\)/);
  assert.match(source, /powerLog\.observeWindow\(mainWindow\)/);
});

test('resume and unlock request a renderer backlog without a polling timer', () => {
  const { powerMonitor, diagnostics } = setup();
  const requests = [];
  const window = new EventEmitter();
  let destroyed = false;
  window.isDestroyed = () => destroyed;
  window.webContents = { send: channel => requests.push(channel) };
  diagnostics.observeWindow(window);
  for (const event of ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'on-ac', 'on-battery']) powerMonitor.emit(event);
  assert.deepEqual(requests, ['terminal-backlog-request', 'terminal-backlog-request'], 'resume and unlock each request one summary');
  destroyed = true;
  powerMonitor.emit('resume');
  assert.equal(requests.length, 2, 'destroyed windows receive no request');
  const replacement = new EventEmitter();
  replacement.isDestroyed = () => false;
  replacement.webContents = { send: channel => requests.push(`replacement:${channel}`) };
  diagnostics.observeWindow(replacement);
  powerMonitor.emit('unlock-screen');
  assert.equal(requests.at(-1), 'replacement:terminal-backlog-request');
  assert.equal(powerMonitor.listenerCount('resume'), 1, 'recreating the window does not duplicate power listeners');
});
