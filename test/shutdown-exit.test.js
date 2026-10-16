'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');

function watchdog() {
  const child = new EventEmitter();
  child.unref = () => {};
  child.channel = { unref() {} };
  const calls = [], timers = new Set();
  const context = {
    require: () => ({ spawn: () => child }), module: { exports: {} },
    process: { execPath: 'electron', pid: 12345, env: {}, kill: (pid, signal) => calls.push([pid, signal]) },
    setTimeout: fn => { timers.add(fn); return fn; }, clearTimeout: fn => timers.delete(fn),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../shutdown-exit.js'), 'utf8'), context);
  context.module.exports.exitWithWatchdog({ exit: () => calls.push('app.exit') }, { error() {} });
  return { child, calls, timers };
}

test('exit waits until its independent watchdog has armed its deadline', () => {
  const t = watchdog();
  t.child.emit('spawn');
  assert.deepEqual(t.calls, []);
  t.child.emit('message', 'armed');
  t.child.emit('message', 'armed');
  assert.deepEqual(t.calls, ['app.exit']);
  assert.equal(t.timers.size, 0);
});

for (const failure of ['exit', 'error', 'startup timeout']) {
  test(`watchdog ${failure} force-exits only its own parent PID`, () => {
    const t = watchdog();
    if (failure === 'startup timeout') for (const fn of t.timers) fn();
    else t.child.emit(failure, new Error('watchdog startup failed'));
    assert.deepEqual(t.calls, [[12345, 'SIGKILL']]);
    assert.equal(t.timers.size, 0);
  });
}

for (const mode of ['stream', 'held-drain', 'native']) {
  test(`quit exits within a bound with ${mode} writer work and preserves committed WAL data`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shutdown-exit-6166h-'));
    try {
      const result = spawnSync(require('electron'), [path.join(__dirname, 'fixtures/shutdown-exit.cjs'), mode], {
        cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 6000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dir },
      });
      assert.equal(result.error, undefined, `process must exit within 6s: ${result.stdout} ${result.stderr}`);
      assert.equal((result.stdout.match(/app.exit reached/g) || []).length, 1, result.stdout + result.stderr);
      if (mode !== 'native') assert.equal(result.status, 0, result.stdout + result.stderr);
      if (mode !== 'stream') assert.match(result.stdout, /exiting after shutdown drain timed out/);
      else assert.doesNotMatch(result.stdout, /drain failed/);
      const recovery = spawnSync(require('electron'), ['-e', `
        const assert = require('node:assert/strict');
        const path = require('node:path');
        const db = new (require('better-sqlite3'))(path.join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
        assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
        assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'committed'").get().value), 'kept');
        if (${JSON.stringify(mode)} === 'stream') {
          const global = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'global'").get().value);
          assert.equal(global.finalBounds, true);
          for (let i = 0; i < 64; i++) assert.equal(global['stream:' + i], i);
        }
        db.close();
      `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 5000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dir } });
      assert.equal(recovery.status, 0, recovery.stderr);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
