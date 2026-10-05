'use strict';

// The MCP openFile tool hands the renderer a normalised path and nothing read
// from it: the renderer opens it through the panel's guarded read, so the
// bytes of a file the panel refuses never cross IPC on this route.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mcp-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const WebSocket = require('ws');
const { startMcpServer, shutdownAll } = require('../mcp-bridge');

const log = { info() {}, warn() {}, debug() {}, error() {} };

test.after(() => {
  shutdownAll();
  fs.rmSync(home, { recursive: true, force: true });
});

async function connect(sessionId, sent) {
  const mainWindow = { isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } };
  const { port, authToken } = await startMcpServer(sessionId, [], mainWindow, log);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, 'mcp', { headers: { 'x-claude-code-ide-authorization': authToken } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const call = (id, name, args) => new Promise((resolve) => {
    ws.on('message', function onMessage(data) {
      const msg = JSON.parse(data.toString());
      if (msg.id !== id) return;
      ws.off('message', onMessage);
      resolve(msg);
    });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }));
  });
  return { ws, call };
}

test('openFile sends the renderer the path resolved, dot segments removed, and no content', async () => {
  const dir = fs.mkdtempSync(path.join(home, 'repo-'));
  fs.writeFileSync(path.join(dir, 'a.md'), 'a0\n');
  const sent = [];
  const { ws, call } = await connect('s-open', sent);
  try {
    const reply = await call(1, 'openFile', { filePath: `${dir}/./sub/../a.md`, preview: true, startText: 'a', endText: 'b' });
    assert.equal(reply.result.content[0].text, 'ok');
    const [channel, sessionId, data] = sent.find((args) => args[0] === 'mcp-open-file');
    assert.equal(channel, 'mcp-open-file');
    assert.equal(sessionId, 's-open');
    assert.deepEqual(data, { filePath: path.join(dir, 'a.md') });
  } finally { ws.close(); }
});

test('openFile on a file that cannot be read is still answered ok and sends only the path', async () => {
  const sent = [];
  const { ws, call } = await connect('s-missing', sent);
  try {
    const missing = path.join(home, 'no-such-dir', 'gone.md');
    const reply = await call(1, 'openFile', { filePath: missing });
    assert.equal(reply.result.content[0].text, 'ok');
    const [, , data] = sent.find((args) => args[0] === 'mcp-open-file');
    assert.deepEqual(data, { filePath: missing });
  } finally { ws.close(); }
});

test('openFile without a usable filePath is answered with an error and opens nothing', async () => {
  const sent = [];
  const { ws, call } = await connect('s-invalid', sent);
  try {
    for (const [id, args] of [[1, {}], [2, { filePath: 42 }], [3, { filePath: '' }]]) {
      const reply = await call(id, 'openFile', args);
      assert.equal(reply.error && reply.error.code, -32602, JSON.stringify(args));
    }
    assert.deepEqual(sent.filter((args) => args[0] === 'mcp-open-file'), []);
  } finally { ws.close(); }
});
