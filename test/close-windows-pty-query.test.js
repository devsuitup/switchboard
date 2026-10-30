'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { queryWindowsProcesses } = require('../src/main/terminals/close-windows-pty');

test('the snapshot uses one hidden bounded native process query through System32 PowerShell', async () => {
  const rows = [{ pid: 897, parentPid: 1, created: '134378573582318229' }];
  let calls = 0;
  const result = await queryWindowsProcesses({ execute(program, args, opts, done) {
    calls++;
    assert.equal(program, path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    assert.deepEqual(args, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.resolve(__dirname, '../src/main/terminals/windows-process-snapshot.ps1')]);
    assert.equal(opts.windowsHide, true);
    assert.equal(opts.timeout, 1500);
    assert.equal(opts.encoding, 'utf8');
    done(null, JSON.stringify(rows));
    return { kill() {} };
  } });
  assert.equal(calls, 1);
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
