'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mcp-diff-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const WebSocket = require('ws');
const { startMcpServer, shutdownMcpServer, shutdownAll } = require('../src/main/integrations/mcp/mcp-bridge');

const log = { info() {}, warn() {}, debug() {}, error() {} };

test.after(() => {
  shutdownAll();
  fs.rmSync(home, { recursive: true, force: true });
});

test('#509: shutdown answers every pending openDiff before it closes the connection', async () => {
  const sent = [];
  const mainWindow = { isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } };
  const { port, authToken } = await startMcpServer('s-diff', [], mainWindow, log);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, 'mcp', { headers: { 'x-claude-code-ide-authorization': authToken } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const answers = new Map();
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    answers.set(msg.id, msg);
  });
  const closed = new Promise(resolve => ws.once('close', resolve));
  for (const id of [1, 2]) {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'openDiff', arguments: {
      old_file_path: path.join(home, `missing-${id}.txt`), new_file_path: path.join(home, `missing-${id}.txt`),
      new_file_contents: 'proposal', tab_name: `tab-${id}`,
    } } }));
  }
  for (let i = 0; i < 200 && sent.filter(args => args[0] === 'mcp-open-diff').length < 2; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(sent.filter(args => args[0] === 'mcp-open-diff').length, 2, 'both diffs reached the renderer');
  shutdownMcpServer('s-diff');
  await closed;
  for (const id of [1, 2]) {
    assert.equal(answers.get(id)?.result?.content?.[0]?.text, 'TAB_CLOSED', `openDiff ${id} is answered before the socket closes`);
  }
});
