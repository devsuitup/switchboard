'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
for (const mode of ['stream', 'slow-arm', 'held-drain', 'native', 'update-stream', 'update-native']) {
  test(`quit exits within a bound with ${mode} writer work and preserves committed WAL data`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shutdown-exit-6166h-'));
    try {
      const result = spawnSync(require('electron'), [path.join(__dirname, 'fixtures/shutdown-exit.cjs'), mode], {
        cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 6000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dir },
      });
      assert.equal(result.error, undefined, `process must exit within 6s: ${result.stdout} ${result.stderr}`);
      const native = mode.endsWith('native');
      assert.equal((result.stdout.match(/app.exit reached/g) || []).length, native ? 0 : 1, result.stdout + result.stderr);
      assert.equal((result.stdout.match(/self-kill reached/g) || []).length, native ? 1 : 0, result.stdout + result.stderr);
      if (!native) assert.equal(result.status, 0, result.stdout + result.stderr);
      else assert.notEqual(result.status, 0, result.stdout + result.stderr);
      if (mode === 'held-drain' || native) assert.match(result.stdout, /exiting after shutdown drain timed out/);
      else assert.doesNotMatch(result.stdout, /drain failed/);
      if (mode.startsWith('update-')) assert.match(result.stdout, /installer reached before quit/);
      const recovery = spawnSync(require('electron'), ['-e', `
        const assert = require('node:assert/strict');
        const path = require('node:path');
        const db = new (require('better-sqlite3'))(path.join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
        assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
        assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'committed'").get().value), 'kept');
        if (${JSON.stringify(mode)}.endsWith('stream') || ${JSON.stringify(mode)} === 'slow-arm') {
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
