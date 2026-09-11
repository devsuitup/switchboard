#!/usr/bin/env node
// Runs the node:test suite in two stages, cross-platform (no shell-specific
// syntax, so this works the same under cmd.exe and under a POSIX shell).
//
// Stage 1: every test file except trigger-watcher.test.js, node's own default
// concurrency.
// Stage 2: trigger-watcher.test.js alone, serially, with a generous timeout.
// It uses real timers + real fs.watch against wall-clock budgets (no fake-timer
// injection yet -- see .ai/contexts/trigger-watcher.md, "timing tests and host
// load"), so it is far more sensitive to CPU contention from sibling test
// processes than the rest of the suite. Running it alone, after everything
// else, removes that self-inflicted contention; see issue #260.
'use strict';

const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const TEST_DIR = path.join(__dirname, '..', 'test');
const ISOLATED_FILE = 'trigger-watcher.test.js';

const mainFiles = fs.readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.js') && name !== ISOLATED_FILE)
  .map((name) => path.join('test', name));

function run(args) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status === null ? 1 : result.status;
}

const mainStatus = run(['--test', ...mainFiles]);

// --test-timeout bounds a single test, not the whole file; generous because
// this file's own per-test waitForFile ceilings already go up to several
// seconds and SWITCHBOARD_TEST_TIME_SCALE can stretch them further under load.
const isolatedStatus = run([
  '--test',
  '--test-concurrency=1',
  '--test-timeout=60000',
  path.join('test', ISOLATED_FILE),
]);

process.exit(mainStatus !== 0 ? mainStatus : isolatedStatus);
