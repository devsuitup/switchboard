'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const cache = require('../session-cache');
const { scanContinuationIndex } = require('../session-continuations');
const { fixture, OLD, HEAD } = require('./fixtures/continuation-718.cjs');

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

function boundedOpens(t, file, limit = 16) {
  const open = fs.openSync;
  let count = 0;
  t.mock.method(fs, 'openSync', (target, ...args) => {
    if (target === file) assert.ok(++count <= limit, 'continuation scan exceeded its bounded iteration guard');
    return open(target, ...args);
  });
  return () => count;
}

for (const legacy of [false, true]) {
  test(`multi-chunk cursor reaches EOF at the ns rounding boundary, legacy=${legacy}`, t => {
    const h = fixture(t);
    h.write(OLD, h.padding + h.link());
    const file = h.file(OLD), expectedMtime = boundaryStat(t, file);
    const count = boundedOpens(t, file);
    let serialized = scanContinuationIndex(file, OLD);
    if (legacy) serialized = JSON.stringify({ ...JSON.parse(serialized), mtime: expectedMtime });
    for (let pass = 0; pass < 4 && !JSON.parse(serialized).complete; pass++) {
      const before = JSON.parse(serialized).bytes;
      serialized = scanContinuationIndex(file, OLD, serialized);
      assert.ok(JSON.parse(serialized).bytes > before, 'every incomplete cursor must advance');
    }
    const index = JSON.parse(serialized);
    assert.equal(index.complete, true);
    assert.equal(index.bytes, fs.statSync(file).size);
    assert.equal(index.mtime, expectedMtime, 'reader and cache writer must use the same BigInt rounding');
    assert.deepEqual(index.ids, [HEAD]);
    assert.ok(count() <= 4);
  });
}

for (const operation of ['prepare', 'resolve']) {
  test(`${operation} completes a large transcript despite different Number-stat rounding`, { timeout: 5000 }, async t => {
    const h = fixture(t);
    h.write(OLD, h.link());
    cache.refreshFolder(h.folder);
    h.append(OLD, h.padding);
    h.init();
    const file = h.file(OLD), expectedMtime = boundaryStat(t, file);
    const count = boundedOpens(t, file);
    if (operation === 'prepare') {
      const prepared = await cache.prepareContinuationRefresh(h.folder);
      assert.ok(count() <= 10, 'preparation must finish within five scan passes');
      assert.ok(prepared.get(OLD), 'a stable transcript must produce a prepared index');
      cache.refreshFolder(h.folder, { preparedContinuations: prepared });
    } else {
      h.activeSessions.set(HEAD, { realSessionId: HEAD });
      const result = await cache.resolveSessionContinuations(OLD);
      assert.ok(count() <= 10, 'resolution must finish within five scan passes');
      assert.equal(result.unresolved, false);
      assert.deepEqual(result.candidates.map(candidate => candidate.sessionId), [HEAD]);
    }
    const index = JSON.parse(h.rows.get(OLD).continuationIndex);
    assert.equal(index.complete, true);
    assert.equal(index.bytes, fs.statSync(file).size);
    assert.equal(index.mtime, expectedMtime);
    assert.deepEqual(index.ids, [HEAD]);
  });
}

test('a stalled read defers the row within two passes and a later request retries it', { timeout: 5000 }, async t => {
  const h = fixture(t);
  h.write(OLD, h.link());
  cache.refreshFolder(h.folder);
  h.append(OLD, h.padding);
  h.init();
  const before = structuredClone(h.rows.get(OLD));
  const count = boundedOpens(t, h.file(OLD));
  const read = fs.readSync;
  let chunks = 0;
  const stall = t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    if (buffer.length > 64 && ++chunks > 16) return 0;
    return read(fd, buffer, offset, length, position);
  });
  const prepared = await cache.prepareContinuationRefresh(h.folder);
  assert.ok(count() <= 4, 'a non-advancing cursor must stop within two passes');
  assert.equal(prepared.get(OLD), null);
  assert.equal(h.logs.length, 0, 'deferral must not depend on the test iteration guard throwing');
  cache.refreshFolder(h.folder, { preparedContinuations: prepared });
  assert.deepEqual(h.rows.get(OLD), before);
  assert.equal(h.folders.get(h.folder).indexMtimeMs, 0);
  assert.ok(cache.continuationRefreshScope(h.folder, { files: new Set(['other.jsonl']) }).files.has(OLD + '.jsonl'));
  stall.mock.restore();
  const retry = await cache.prepareContinuationRefresh(h.folder);
  cache.refreshFolder(h.folder, { preparedContinuations: retry });
  assert.equal(JSON.parse(h.rows.get(OLD).continuationIndex).complete, true);
  assert.ok(h.folders.get(h.folder).indexMtimeMs > 0);
});
