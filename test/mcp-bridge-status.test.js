'use strict';

// What the bridge reports about a session is what holds: listening until the
// CLI attaches, connected while it is attached, and a server that cannot listen
// is a refusal, not a started server (#320).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mcp-status-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const WebSocket = require('ws');
const { startMcpServer, shutdownAll, getMcpState } = require('../mcp-bridge');

const log = { info() {}, warn() {}, debug() {}, error() {} };

test.after(() => {
  shutdownAll();
  fs.rmSync(home, { recursive: true, force: true });
});

function windowSpy(sent) {
  return { isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } };
}

function open(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, 'mcp', { headers: { 'x-claude-code-ide-authorization': token } });
  return new Promise((resolve, reject) => { ws.once('open', () => resolve(ws)); ws.once('error', reject); });
}

const until = async (predicate) => {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10));
};

test('a session nobody started a server for is off', () => {
  assert.equal(getMcpState('never-started'), 'off');
});

test('a started server is listening, connected once the CLI attaches, and listening again when it leaves', async () => {
  const sent = [];
  const { port, authToken } = await startMcpServer('s-state', [], windowSpy(sent), log);
  assert.equal(getMcpState('s-state'), 'listening');
  assert.deepEqual(sent.filter((a) => a[0] === 'mcp-status'), []);

  const ws = await open(port, authToken);
  await until(() => getMcpState('s-state') === 'connected');
  assert.equal(getMcpState('s-state'), 'connected');
  assert.deepEqual(sent.filter((a) => a[0] === 'mcp-status').at(-1), ['mcp-status', 's-state', 'connected']);

  ws.close();
  await until(() => getMcpState('s-state') === 'listening');
  assert.equal(getMcpState('s-state'), 'listening');
  assert.deepEqual(sent.filter((a) => a[0] === 'mcp-status').at(-1), ['mcp-status', 's-state', 'listening']);
});

test('a connection with a bad token does not make the session connected', async () => {
  const sent = [];
  const { port } = await startMcpServer('s-badauth', [], windowSpy(sent), log);
  const ws = await open(port, 'not-the-token');
  await new Promise((r) => ws.once('close', r));
  assert.equal(getMcpState('s-badauth'), 'listening');
  assert.deepEqual(sent.filter((a) => a[0] === 'mcp-status'), []);
});

test('a port already claimed by another process rejects the start and leaves no lock file behind', async () => {
  const peer = net.createServer();
  await new Promise((r) => peer.listen(0, '127.0.0.1', r));
  const { port } = peer.address();
  try {
    await assert.rejects(startMcpServer('s-busy', [], windowSpy([]), log, { port }), /EADDRINUSE/);
    assert.equal(getMcpState('s-busy'), 'off');
    assert.equal(fs.existsSync(path.join(home, '.claude', 'ide', `${port}.lock`)), false);
  } finally { peer.close(); }
});
