'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const fixturesPath = path.join(__dirname, '..', 'e2e', 'fixtures.js');

test('every shared launch disables the reloader even when the journey enables development mode', async () => {
  const launches = [];
  const app = {
    context: () => ({ tracing: { start: async () => {}, stop: async () => {} } }),
    firstWindow: async () => ({ locator: () => ({ first: () => ({ waitFor: async () => {} }) }) }),
    close: async () => {},
    process: () => ({ exitCode: 0, signalCode: null }),
  };
  const context = {
    module: { exports: {} },
    __dirname: path.dirname(fixturesPath),
    process, setTimeout, clearTimeout,
    require: name => {
      if (name === '@playwright/test') return {
        test: { extend: fixtures => fixtures },
        _electron: { launch: async options => { launches.push(options); return app; } },
      };
      if (name === 'electron') return '/fixture/electron';
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(fixturesPath, 'utf8'), context, { filename: fixturesPath });
  const fixture = context.module.exports.test.launch;
  for (const inherited of [undefined, '1', '0']) {
    const env = { SWITCHBOARD_DATA_DIR: '/fixture/data' };
    if (inherited !== undefined) env.ELECTRON_IS_DEV = inherited;
    await fixture({ env }, async launch => {
      await launch();
      assert.equal(launches.at(-1).env.ELECTRON_IS_DEV, '0');
      assert.equal(launches.at(-1).env.SWITCHBOARD_DATA_DIR, env.SWITCHBOARD_DATA_DIR);
      env.ELECTRON_IS_DEV = '1';
      await launch();
      assert.equal(launches.at(-1).env.ELECTRON_IS_DEV, '0');
    }, { status: 'passed', expectedStatus: 'passed' });
  }
  assert.equal(launches.length, 6);
});
