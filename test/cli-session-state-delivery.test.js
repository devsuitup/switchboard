// see .ai/contexts/trigger-watcher.md
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cli = require('../cli-session-state');

test('delivery process table preserves quoted commands alongside process start identity', () => {
  const commandLine = '"C:\\Program Files\\Claude\\claude.exe" -p task';
  const table = cli.parseProcessTable('200 100 134000000000200000\t' + commandLine);
  assert.deepEqual(table.get(200), { ppid: 100, created: 134000000000200000n, commandLine });
});

for (const [label, commandLine, nested] of [
  ['native CLI', '"C:\\Program Files\\Claude\\claude.exe" -p task', true],
  ['Node CLI', '"C:\\Program Files\\nodejs\\node.exe" "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js" -p task', true],
  ['Node launcher argument', 'node launcher.js claude', false],
  ['Node launcher CLI path argument', 'node launcher.js C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js', false],
  ['Node launcher native CLI argument', 'node launcher.js C:\\Program Files\\Claude\\claude.exe', false],
  ['unrelated claude script', 'node C:\\tools\\claude.js', false],
  ['unquoted Node CLI script', 'node C:\\Program Files\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\cli.js -p task', true],
  ['unquoted Node executable and CLI script', 'C:\\Program Files\\nodejs\\node.exe C:\\Program Files\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\cli.js -p task', true],
  ['quoted Node executable and unquoted CLI script', '"C:\\Program Files\\nodejs\\node.exe" C:\\Program Files\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\cli.js -p task', true],
  ['Node option before CLI script', 'node --no-warnings "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js" -p task', true],
  ['native executable name', 'claude.exe -p task', true],
  ['unquoted native executable path', 'C:\\Program Files\\Claude\\claude.exe -p task', true],
  ['shell mentioning CLI', 'cmd.exe /c echo claude.exe', false],
  ['unreadable command', undefined, null],
]) {
  test(`delivery Windows ${label}: descriptor-less ancestors constrain the closest writer`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-592-process-'));
    t.after(() => { cli.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
    const created = pid => String(134000000000000000n + BigInt(pid * 1000));
    const table = new Map([
      [100, { ppid: 1, created: created(100), commandLine: 'powershell.exe' }],
      [200, { ppid: 100, created: created(200), commandLine }],
      [300, { ppid: 200, created: created(300), commandLine: 'claude.exe' }],
    ]);
    fs.writeFileSync(path.join(dir, '300.json'), JSON.stringify({ pid: 300, sessionId: 'child',
      kind: 'interactive', status: 'idle', procStart: created(300), pidDomain: 'win32:anchor' }));
    cli.init({ dir, platform: 'win32', now: () => Date.now() + 10000,
      isProcessAlive: () => true, readProcessTable: async () => table });
    await cli.refreshProcessTable();
    const tab = { pty: { pid: 100 } };
    const observed = cli.observeTabWriter(100);
    if (nested === false) {
      assert.equal(observed.writer?.sessionId, 'child');
      assert.equal(cli.findDeliveryTab('child', [tab]).tab, tab);
    } else {
      assert.equal(observed.writer, undefined);
      assert.equal(cli.findDeliveryTab('child', [tab]).tab, undefined);
    }
  });
}
