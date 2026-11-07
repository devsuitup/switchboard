'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runner = require('../src/main/schedules/schedule-runner');

test('runner file names are case sensitive and scanning uses the same predicate', t => {
  assert.equal(typeof runner.isRunnerScheduleFileName, 'function');
  const names = ['schedule-a.md', 'Schedule-b.md', 'schedule-c.MD', 'schedule-d.txt'];
  assert.deepEqual(names.map(runner.isRunnerScheduleFileName), [true, false, false, false]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-792-name-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const commands = path.join(root, '.claude', 'commands');
  fs.mkdirSync(commands, { recursive: true });
  for (const name of names) fs.writeFileSync(path.join(commands, name), '---\ncron: * * * * *\n---\nPrompt');
  assert.deepEqual(runner.scanSchedules(null, [root]).map(s => s.file), names.filter(runner.isRunnerScheduleFileName));
});
