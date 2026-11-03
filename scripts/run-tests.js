#!/usr/bin/env node
// Runs the node:test suite in two stages, cross-platform (no shell-specific
// syntax, so this works the same under cmd.exe and under a POSIX shell).
//
// Stage 1: every test file except the ISOLATED_FILES, at
// DEFAULT_CONCURRENCY workers (override with SWITCHBOARD_TEST_CONCURRENCY).
// Stage 2: the ISOLATED_FILES alone, serially, with a generous timeout.
// It uses real timers + real fs.watch against wall-clock budgets (no fake-timer
// injection yet -- see .ai/contexts/trigger-watcher.md, "timing tests and host
// load"), so it is far more sensitive to CPU contention from sibling test
// processes than the rest of the suite. Running it alone, after everything
// else, removes that self-inflicted contention; see issue #260.
'use strict';

const { spawnSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const TEST_DIR = path.join(__dirname, '..', 'test');
const ISOLATED_FILES = ['trigger-watcher.test.js', 'trigger-delivery.test.js', 'trigger-continuation-delivery.test.js'];

// Node defaults stage 1 to os.availableParallelism() workers, which on a large
// workstation is a dozen-plus test processes at once. See
// .ai/agent-practices.md, "Test concurrency".
const DEFAULT_CONCURRENCY = 4;

function stageOneConcurrency() {
  const raw = process.env.SWITCHBOARD_TEST_CONCURRENCY;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
    console.error(`run-tests: ignoring SWITCHBOARD_TEST_CONCURRENCY=${raw} (want a positive integer)`);
  }
  const available = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(DEFAULT_CONCURRENCY, available));
}

const mainFiles = fs.readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.js') && !ISOLATED_FILES.includes(name))
  .map((name) => path.join('test', name));

function run(args) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status === null ? 1 : result.status;
}

if (require.main === module) {
  const mainStatus = run(['--test', `--test-concurrency=${stageOneConcurrency()}`, ...mainFiles]);

  // No --test-timeout: with an explicit file operand node applies it to the
  // file-level entry too, and this file legitimately runs for minutes on CI.
  const isolatedStatus = run([
    '--test',
    '--test-concurrency=1',
    ...ISOLATED_FILES.map((name) => path.join('test', name)),
  ]);

  process.exit(mainStatus !== 0 ? mainStatus : isolatedStatus);
}

module.exports = { stageOneConcurrency, DEFAULT_CONCURRENCY, ISOLATED_FILES };
