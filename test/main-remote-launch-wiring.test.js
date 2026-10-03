'use strict';

// Reads main.js as text: the remote-launch-session IPC and the shared
// registration are glue that no test can load. Behaviour lives in
// test/remote-launch.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');

function handlerBody(anchor, end) {
  const at = mainSrc.indexOf(anchor);
  assert.notEqual(at, -1, `main.js should still contain ${anchor}`);
  const stop = mainSrc.indexOf(end, at);
  assert.notEqual(stop, -1, `${end} should follow ${anchor}`);
  return mainSrc.slice(at, stop);
}

const launch = handlerBody("ipcMain.handle('remote-launch-session'", '// --- IPC: remote-send-prompt');

test('remote-launch-session passes the tier gate, the declared-host check, the adapter and attach to handleLaunchRequest', () => {
  assert.match(launch, /handleLaunchRequest\(payload, \{/);
  assert.match(launch, /launchBlockReason: \(alias\) => launchBlockReason\(remoteIndexer\.getRemoteHostProfile\(alias\)\)/);
  assert.match(launch, /hasHost: \(alias\) => enabledHosts\(/);
  assert.match(launch, /adapter: remoteLaunchAdapter/);
  assert.match(launch, /attach: \(alias, descriptor, size\) => remoteAttachAdapter\.attach\(alias, descriptor, size\)/);
});

test('remote-launch-session lowercases the id before the activeSessions guard', () => {
  const lower = launch.indexOf('rawId.toLowerCase()');
  const guard = launch.indexOf('activeSessions.has(sessionId)');
  assert.ok(lower !== -1 && guard !== -1 && lower < guard);
});

test('remote-launch-session registers the pty under the launched session id, the payload alias and the descriptor cwd', () => {
  assert.match(launch, /registerRemoteAttachSession\(result\.descriptor\.sessionId, \{\s*alias: payload\.alias, projectPath: result\.descriptor\.cwd, cwd: result\.descriptor\.cwd, ptyProcess: result\.attachResult\.ptyProcess,\s*remoteResizeAllowed: result\.attachResult\.remoteResizeAllowed,\s*\}\)/);
  assert.match(launch, /refreshHostNow\(payload\.alias, \{ force: true \}\)/);
});

test('registerRemoteAttachSession records a remote-attach session on its host and wires the pty; open-terminal uses it', () => {
  const reg = handlerBody('function registerRemoteAttachSession(', "ipcMain.handle('open-terminal'");
  assert.match(reg, /host: alias, kind: 'remote-attach'/);
  assert.match(reg, /activeSessions\.set\(sessionId, remoteSession\);/);
  assert.match(reg, /wireSessionPty\(remoteSession, sessionId, ptyProcess\);/);
  assert.match(mainSrc, /registerRemoteAttachSession\(sessionId, \{\s*alias, projectPath, cwd: remoteCwd, ptyProcess: attachResult\.ptyProcess,\s*remoteResizeAllowed: attachResult\.remoteResizeAllowed,\s*\}\)/);
});
