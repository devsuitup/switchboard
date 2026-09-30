'use strict';

// The MCP openFile tool hands the renderer a normalised path, so a file tab can
// be matched to the same file however the CLI spelt it.

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

test('openFile sends the renderer the path resolved, dot segments removed, with the file read from it', async () => {
  const dir = fs.mkdtempSync(path.join(home, 'repo-'));
  fs.writeFileSync(path.join(dir, 'a.md'), 'a0\n');
  const sent = [];
  const { ws, call } = await connect('s-open', sent);
  try {
    const reply = await call(1, 'openFile', { filePath: `${dir}/./sub/../a.md` });
    assert.equal(reply.result.content[0].text, 'ok');
    const [channel, sessionId, data] = sent.find((args) => args[0] === 'mcp-open-file');
    assert.equal(channel, 'mcp-open-file');
    assert.equal(sessionId, 's-open');
    assert.equal(data.filePath, path.join(dir, 'a.md'));
    assert.equal(data.content, 'a0\n');
  } finally { ws.close(); }
});
