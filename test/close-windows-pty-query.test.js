'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { queryWindowsProcesses } = require('../src/main/terminals/close-windows-pty');

test('the snapshot uses one hidden bounded native process query through System32 PowerShell', async () => {
  const rows = [{ pid: 897, parentPid: 1, created: '134378573582318229' }];
  let calls = 0;
  let invocation;
  const result = await queryWindowsProcesses({ execute(program, args, opts, done) {
    calls++;
    invocation = { program, args, opts };
    done(null, JSON.stringify(rows));
    return { kill() {} };
  } });
  assert.equal(calls, 1);
  const { program, args, opts } = invocation;
  assert.equal(program, path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(args.length, 4);
  assert.ok(args.every(arg => !/\.ps1$/i.test(arg)));
  const script = fs.readFileSync(path.resolve(__dirname, '../src/main/terminals/windows-process-snapshot.ps1'), 'utf8');
  assert.equal(Buffer.from(args[3], 'base64').toString('utf16le'), script);
  assert.ok([program, ...args].map(arg => `"${arg}"`).join(' ').length < 16000, 'command line must stay below half the Windows 32,767-character limit');
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.timeout, 1500);
  assert.equal(opts.encoding, 'utf8');
  assert.equal(opts.maxBuffer, 8 * 1024 * 1024);
  assert.deepEqual(result, rows);
});

test('failed, malformed and incomplete snapshots are unusable', async () => {
  for (const stdout of ['', '{', 'null', '[null]', '{"pid":897,"parentPid":1}',
    '{"pid":897,"parentPid":1,"created":134378573582318229}',
    '{"pid":897,"parentPid":1,"created":"invalid"}']) {
    assert.equal(await queryWindowsProcesses({ execute(program, args, opts, done) { done(null, stdout); } }), null);
  }
  assert.equal(await queryWindowsProcesses({ execute(program, args, opts, done) { done(new Error('timeout'), '[]'); } }), null);
  assert.equal(await queryWindowsProcesses({ execute() { throw new Error('spawn'); } }), null);
});

test('a subprocess that never completes cannot delay close beyond the snapshot deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let killed = 0;
  const pending = queryWindowsProcesses({ execute() { return { kill() { killed++; } }; } });
  t.mock.timers.tick(1500);
  assert.equal(await pending, null);
  assert.equal(killed, 1);
});
