'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSessionFile, mergeBridgeGroups, extractDailyMetrics } = require('../read-session-file');
require('./fixtures/isolated-codex-home.cjs')(test);

test('a transcript above the whole-string limit is indexed with bounded RSS and exact metrics', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-1180-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'huge.jsonl');
  const user = JSON.stringify({ type: 'user', uuid: 'first', timestamp: '2024-01-01T00:00:00.000Z', message: { content: 'huge transcript' } });
  const noise = Buffer.from(JSON.stringify({ type: 'progress', padding: 'x'.repeat(65500) }) + '\n');
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, user + '\n');
  const realSize = !!(process.env.CI || process.env.SWITCHBOARD_TEST_LARGE_TRANSCRIPT);
  const targetBytes = (realSize ? 600 : 2) * 1024 * 1024;
  while (fs.fstatSync(fd).size < targetBytes) fs.writeSync(fd, noise);
  fs.writeSync(fd, user.replace('first', 'last'));
  fs.closeSync(fd);
  const read = fs.readFileSync;
  if (!realSize) t.mock.method(fs, 'readFileSync', function (target, ...args) {
    if (target === file) throw Object.assign(new RangeError('injected whole-string limit'), { code: 'ERR_STRING_TOO_LONG' });
    return read.call(this, target, ...args);
  });
  const row = readSessionFile(file, 'folder', root);
  assert.ok(row, 'a transcript above the V8 whole-string limit must be indexed');
  assert.equal(row.messageCount, 2);
  assert.deepEqual(row.dailyMetrics, extractDailyMetrics([user, user], '2024-01-01'));
  const count = JSON.parse(row.messageCountIndex);
  assert.equal(count.sealedCount, 1);
  assert.equal(JSON.parse(row.fullReadStamp).size, String(fs.statSync(file).size));
  const rss = process.resourceUsage().maxRSS * 1024;
  t.diagnostic(JSON.stringify({ fileBytes: fs.statSync(file).size, peakRssBytes: rss }));
  assert.ok(rss < 350 * 1024 * 1024, 'peak RSS stays below 350 MiB for a 600 MiB transcript');
});

for (const change of ['delete', 'append']) {
  test('bridge signatures are bounded and non-fatal after ' + change, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-snapshot-1180-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'bridge.jsonl');
    const first = { type: 'user', message: { content: 'read-time content' } };
    fs.writeFileSync(file, [{ type: 'bridge-session', bridgeSessionId: 'bridge' }, first].map(row => JSON.stringify(row)).join('\n') + '\n');
    const row = readSessionFile(file, 'folder', root);
    if (change === 'delete') fs.unlinkSync(file);
    else fs.appendFileSync(file, JSON.stringify({ type: 'user', message: { content: 'later content' } }) + '\n');
    let signatures;
    assert.doesNotThrow(() => { signatures = row.messageSignatures; }, 'signature access must not depend on a still-readable file');
    assert.deepEqual(signatures, change === 'delete' ? null : [{ signature: JSON.stringify(['user', first.message]), uuid: null }]);
    assert.doesNotThrow(() => mergeBridgeGroups([], [row], () => null));
  });
}

for (const terminated of [false, true]) {
  test('oversized JSON lines are skipped in every streaming reader: terminated=' + terminated, t => {
    const scanner = require('../jsonl-scan');
    const original = scanner.MAX_LINE_BYTES;
    scanner.MAX_LINE_BYTES = 1024;
    t.after(() => { scanner.MAX_LINE_BYTES = original; });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'line-cap-1180-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'oversized.jsonl');
    const good = JSON.stringify({ type: 'user', message: { content: 'good' } });
    const huge = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(300 * 1024) } });
    fs.writeFileSync(file, good + '\n' + huge + (terminated ? '\n' + good + '\n' : ''));
    const lines = [];
    const scan = scanner.scanLines(file, 0, line => { lines.push(line); });
    assert.deepEqual(lines, terminated ? [good, good] : [good], 'oversized lines must be discarded before UTF-8 conversion');
    assert.equal(scan.tail, '');
    const row = readSessionFile(file, 'folder', root);
    assert.equal(row.messageCount, terminated ? 2 : 1);
    assert.equal(row.dailyMetrics[0].messageCount, terminated ? 2 : 1);
    assert.equal(JSON.parse(row.continuationIndex).skipLine, !terminated);
    const { readMessageCount } = require('../src/main/session-index/message-count');
    const count = readMessageCount(file, null, fs.statSync(file, { bigint: true }));
    assert.equal(count.messageCount, row.messageCount, 'refresh recounts must discard the same oversized lines as full reads');
    const codex = require('./fixtures/warm-start-1152.cjs');
    const rollout = path.join(root, 'rollout-example-' + codex.ids[0] + '.jsonl');
    const largeMessage = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'x'.repeat(300 * 1024) }] } });
    fs.writeFileSync(rollout, codex.body(root, 'good') + largeMessage + (terminated ? '\n' + codex.body(root, 'after') : ''));
    const codexRow = require('../harnesses/codex').readSessionFile(rollout, 'codex/2026/08/26');
    assert.equal(codexRow.messageCount, terminated ? 2 : 1);
  });
}

test('bridge rereads and signature fallback stream instead of reading whole bodies', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-stream-1180-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entries = [{ type: 'bridge-session', bridgeSessionId: 'bridge' }, { type: 'user', timestamp: '2024-01-01T00:00:00.000Z', message: { content: 'shared' } }];
  for (const id of ['one', 'two']) fs.writeFileSync(path.join(root, id + '.jsonl'), entries.map(row => JSON.stringify(row)).join('\n') + '\n');
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (file, ...args) { if (String(file).endsWith('.jsonl')) throw new Error('whole-body read forbidden'); return original.call(this, file, ...args); });
  const reread = (id, dedupeSinceTimestamp, excludedMessageUuids, excludedMessageSignatures) => readSessionFile(path.join(root, id + '.jsonl'), 'folder', root, { dedupeSinceTimestamp, excludedMessageUuids, excludedMessageSignatures });
  const rows = ['one', 'two'].map(id => reread(id));
  assert.ok(rows.every(Boolean), 'bridge bodies must stream');
  assert.equal(rows[0].messageSignatures.length, 1);
  assert.equal(mergeBridgeGroups([], rows, reread).toUpsert.reduce((n, row) => n + row.messageCount, 0), 1);
});
