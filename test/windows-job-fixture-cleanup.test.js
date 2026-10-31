'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runNative } = require('./windows-job-native-runner');

test('the native runner removes its sandbox even when the fixture exits before finally',
  { skip: process.platform !== 'win32' && 'Windows native fixture only' }, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-job-cleanup-test-'));
    const env = { TMP: process.env.TMP, TEMP: process.env.TEMP };
    process.env.TMP = process.env.TEMP = dir;
    const hooks = [];
    const created = () => fs.readdirSync(dir).filter(name => name.startsWith('sb-job-native-'));
    t.after(() => {
      Object.assign(process.env, env);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20 });
    });
    assert.throws(() => runNative({ after: fn => hooks.push(fn), diagnostic() {} }, 'fixture-exit'), /23 !== 0/);
    assert.equal(hooks.length, 1, 'the parent must own cleanup independently of the killed fixture');
    assert.equal(created().length, 1);
    for (const cleanup of hooks) cleanup();
    assert.deepEqual(created(), []);
  });
