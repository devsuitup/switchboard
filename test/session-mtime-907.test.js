'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const cache = require('../session-cache');
const { readSessionFile, readSessionDisplayHeader } = require('../read-session-file');
const { fixture, OLD, line } = require('./fixtures/continuation-718.cjs');

function boundaryStat(t, file) {
  const stat = fs.statSync;
  const milliseconds = Date.parse('2026-10-29T12:00:00.000Z');
  t.mock.method(fs, 'statSync', (target, options) => {
    const result = stat(target, options);
    if (target === file) {
      result.mtime = new Date(milliseconds + (options?.bigint ? 0 : 1));
      result.mtimeMs = options?.bigint ? BigInt(milliseconds) : milliseconds + 0.5;
      if (options?.bigint) result.mtimeNs = BigInt(milliseconds) * 1000000n + 499900n;
    }
    return result;
  });
  return new Date(milliseconds).toISOString();
}

test('refresh skips a subagent immediately after a full read at the rounding boundary', t => {
  const h = fixture(t);
  h.write(OLD);
  const directory = path.join(h.dir, OLD, 'subagents');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'agent-child.jsonl');
  fs.writeFileSync(file, line({ type: 'user', isSidechain: true, agentId: 'child', message: { content: 'child prompt' } }));
  const expected = boundaryStat(t, file);
  const row = readSessionFile(file, h.folder, h.root, { parentSessionId: OLD });
  assert.ok(row);
  h.db.upsertCachedSessions([readSessionFile(h.file(OLD), h.folder, h.root), row]);
  const open = fs.openSync;
  let opens = 0;
  t.mock.method(fs, 'openSync', (target, ...args) => {
    if (target === file) opens++;
    return open(target, ...args);
  });
  cache.refreshFolder(h.folder);
  assert.equal(opens, 0, 'an unchanged subagent must not need a header read');
  assert.equal(h.rows.get(row.sessionId).fileMtime, expected);
  assert.equal(h.rows.get(row.sessionId).modified, '2026-10-29T12:00:00.000Z');
});

for (const parentSessionId of [undefined, OLD]) {
  test(`display header exposes canonical freshness and BigInt display time, subagent=${!!parentSessionId}`, t => {
    const h = fixture(t);
    const file = h.file(OLD);
    fs.writeFileSync(file, line({ type: 'user', isSidechain: true, agentId: 'child', message: { content: 'prompt' } }));
    const expected = boundaryStat(t, file);
    const header = readSessionDisplayHeader(file, { parentSessionId });
    assert.ok(header);
    assert.equal(header.fileMtime, expected);
    assert.equal(header.modified, '2026-10-29T12:00:00.000Z');
  });
}

test('title backfill emits a current legacy row at the rounding boundary and rejects a stale row', t => {
  const h = fixture(t);
  h.write(OLD, line({ type: 'custom-title', customTitle: 'Recovered title' }));
  const file = h.file(OLD), fileMtime = boundaryStat(t, file);
  const filename = path.resolve(__dirname, '../workers/scan-session-titles.js');
  const requireWorker = createRequire(filename), batches = [];
  const context = vm.createContext({ require: name => name === 'node:worker_threads'
    ? { parentPort: { postMessage: batch => batches.push(batch) }, workerData: { files: [
      { sessionId: OLD, file, fileMtime, customTitle: null },
      { sessionId: 'stale', file, fileMtime: '2026-10-29T11:59:59.999Z', customTitle: null },
    ] } } : requireWorker(name) });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  assert.deepEqual(JSON.parse(JSON.stringify(batches.flat())), [
    { sessionId: OLD, fileMtime, customTitle: 'Recovered title' },
  ], 'backfill must recover a current row instead of skipping it on every launch');
});
