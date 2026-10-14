'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanTaskFiles } = require('./helpers/cli-task-canary');
const fixture = require('./fixtures/cli-tasks-2.1.296.json');

test('canary reads past five samples and validates both no-tool-id terminal variants', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-task-canary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = [];
  for (let i = 0; i < 7; i++) {
    const file = path.join(dir, `${i}.jsonl`);
    const entries = i < 5 ? [fixture.launch, fixture.notification] : [i === 5 ? fixture.completedNoTool : fixture.failedNoTool, fixture.monitorEvent, fixture.aggregateStopped];
    fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    files.push(file);
  }
  const counts = await scanTaskFiles(files, fixture.cliVersion);
  assert.equal(counts.launches, 5);
  assert.equal(counts.notifications, 7);
  assert.equal(counts.completedNoTool, 1);
  assert.equal(counts.failedNoTool, 1);
  assert.equal(counts.aggregates, 2);
  assert.equal(counts.aggregateIds, 4);
});

test('canary rejects aggregate records whose listed task ids are not parsed', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-task-canary-invalid-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'invalid.jsonl');
  const entry = structuredClone(fixture.aggregateStopped);
  entry.message.content = entry.message.content.replace('stopped', 'future_terminal');
  fs.writeFileSync(file, JSON.stringify(entry) + '\n');
  await assert.rejects(scanTaskFiles([file], fixture.cliVersion), /PINNED ASSUMPTION BROKEN/);
});
