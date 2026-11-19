'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

const codex = require('../harnesses/codex');
const claude = require('../harnesses/claude');

test('Codex titles: a spinner frame is busy, "Action Required" is attention, anything else is idle', () => {
  const table = [
    ['⠋ switchboard', 'busy'], ['[ ! ] Action Required · switchboard', 'attention'], ['[ . ] action required', 'attention'],
    ['switchboard', 'idle'], ['', null], [null, null],
  ];
  for (const [title, state] of table) {
    assert.equal(codex.parseTitleState(title), state, String(title));
    const activity = codex.classifyTitleActivity(title, { allowFallback: true });
    assert.equal(activity.busy, state === 'busy', String(title));
    assert.equal(activity.idle, state === 'idle', String(title));
    assert.equal(activity.attention, state === 'attention', String(title));
    assert.equal(activity.via, state ? 'codex-title' : null, String(title));
  }
  assert.equal(claude.classifyTitleActivity('✳ Claude').idle, true, 'Claude keeps its own classifier');
  assert.equal(claude.classifyTitleActivity('⠋ Claude').busy, true);
  assert.equal(claude.classifyTitleActivity('⠋ Claude').attention, undefined);
});

test('OSC 9 notifications: Codex says approval or done, Claude keeps the renderer rules', () => {
  assert.equal(codex.classifyNotification('Approval requested: rm -rf build'), 'attention');
  assert.equal(codex.classifyNotification('  approval requested  '), 'attention');
  assert.equal(codex.classifyNotification('I finished the refactor.'), 'idle');
  assert.equal(codex.classifyNotification(''), null);
  assert.equal(codex.classifyNotification(null), null);
  assert.equal(claude.classifyNotification('Claude Code needs your attention'), 'attention');
  assert.equal(claude.classifyNotification('Claude needs your permission to use Bash'), 'attention');
  assert.equal(claude.classifyNotification('Claude Code wants to enter plan mode'), 'attention');
  assert.equal(claude.classifyNotification('Claude is waiting for your input'), 'idle');
  assert.equal(claude.classifyNotification('Task completed'), null);
  const { assertHarness } = require('../harnesses/contract');
  assert.throws(() => assertHarness({ ...claude, classifyNotification: undefined }), /classifyNotification/);
});

test('the renderer classifies a notification by the kind main sends, and by its own rules without one', () => {
  const h = setupSidebarDom();
  try {
    const fns = loadAppFunctions(h.context, { functions: ['terminalNotificationState'] });
    assert.equal(fns.terminalNotificationState('Approval requested: rm', 'attention'), 'attention');
    assert.equal(fns.terminalNotificationState('done', 'idle'), 'idle');
    assert.equal(fns.terminalNotificationState('Claude Code needs your attention', undefined), 'attention');
    assert.equal(fns.terminalNotificationState('Claude is waiting for your input', undefined), 'idle');
    assert.equal(fns.terminalNotificationState('Task completed', undefined), null);
    assert.equal(fns.terminalNotificationState('Claude Code needs your attention', 'idle'), 'idle', 'an explicit kind wins over the regex');
  } finally { h.destroy(); }
});

test('main classifies titles and notifications through the session harness and forwards the kind', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8').replace(/\r\n/g, '\n');
  const wire = source.slice(source.indexOf('function wireSessionPty('), source.indexOf('\n}\n', source.indexOf('function wireSessionPty(')));
  assert.match(wire, /const sessionHarness = getHarness\(session\.runtime\);/);
  assert.match(wire, /sessionHarness\.classifyTitleActivity\(payload, \{ allowFallback: !session\.isPlainTerminal \}\)/);
  assert.match(wire, /const kind = sessionHarness\.classifyNotification\(payload\);/);
  assert.match(wire, /mainWindow\.webContents\.send\('terminal-notification', currentId, payload, kind\)/);
  assert.match(wire, /if \(level === '0'\) continue;/, 'OSC 9;4 4;0 stays ignored');
  assert.match(wire, /session\._titleAttention/);
  const preload = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');
  assert.match(preload, /ipcRenderer\.on\('terminal-notification', \(_event, sessionId, message, kind\) => callback\(sessionId, message, kind\)\)/);
});

test('a Codex title that asks for action raises attention once, through the notification path', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8').replace(/\r\n/g, '\n');
  const wire = source.slice(source.indexOf('function wireSessionPty('), source.indexOf('\n}\n', source.indexOf('function wireSessionPty(')));
  const sent = [];
  const handlers = {};
  const ptyProcess = { pid: 7, onData: fn => { handlers.data = fn; }, onExit: fn => { handlers.exit = fn; }, kill() {} };
  const session = { pty: ptyProcess, runtime: 'codex', exited: false, isPlainTerminal: false, outputBuffer: [], outputBufferSize: 0, projectPath: '/p' };
  const context = {
    getHarness: require('../harnesses').getHarness, mainWindow: { isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } },
    log: { debug() {}, info() {}, warn() {}, error() {} }, LOG_DEBUG_ON: false, TRACE: { on: false }, trace() {}, codePoints: () => '',
    busyDecision: () => '', progressDecision: () => '', Date, setTimeout, clearTimeout, Buffer, activeSessions: new Map([['codex-tab', session]]),
    cliSessionState: { deliveryPtyStart: () => 'start' }, ptyGenerationCounter: 0, cancellationIn: () => false,
    sessionTransitions: { holdContinuationExit: () => false }, appendToOutputBuffer() {}, MAX_BUFFER_SIZE: 1024,
    ptyExitSignalName: () => null, shutdownMcpServer() {}, appQuitting: false, holdBackgroundExit: () => false,
    writer: { releaseLiveSession: async () => false }, taskRecords: { ownerDied() {} }, localTranscriptTracker: { record() {} },
    activityReporter: { sessionEnded() {}, sessionStarted() {} }, process: { platform: 'linux' }, require,
  };
  const vm = require('node:vm');
  vm.createContext(context);
  vm.runInContext(wire + '\n}\nglobalThis.wire = wireSessionPty;', context, { filename: 'main.js' });
  context.wire(session, 'codex-tab', ptyProcess);
  handlers.data('\x1b]0;⠋ switchboard\x07');
  const last = type => sent.filter(args => args[0] === type).at(-1);
  assert.deepEqual(last('cli-busy-state'), ['cli-busy-state', 'codex-tab', true]);
  handlers.data('\x1b]0;[ ! ] Action Required · switchboard\x07');
  handlers.data('\x1b]0;[ ! ] Action Required · switchboard\x07');
  const attention = sent.filter(args => args[0] === 'terminal-notification');
  assert.deepEqual(attention, [['terminal-notification', 'codex-tab', '[ ! ] Action Required · switchboard', 'attention']], 'one attention per rising edge');
  handlers.data('\x1b]0;switchboard\x07');
  assert.deepEqual(last('cli-busy-state'), ['cli-busy-state', 'codex-tab', false]);
  handlers.data('\x1b]9;Approval requested: git push\x07');
  assert.deepEqual(last('terminal-notification'), ['terminal-notification', 'codex-tab', 'Approval requested: git push', 'attention']);
  handlers.data('\x1b]9;All done.\x07');
  assert.deepEqual(last('terminal-notification'), ['terminal-notification', 'codex-tab', 'All done.', 'idle']);
});
