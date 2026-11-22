'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSessionFile, mergeBridgeGroups, extractDailyMetrics } = require('../read-session-file');

test('a 600 MiB transcript is indexed with bounded RSS and exact metrics', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-1180-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'huge.jsonl');
  const user = JSON.stringify({ type: 'user', uuid: 'first', timestamp: '2024-01-01T00:00:00.000Z', message: { content: 'huge transcript' } });
  const noise = Buffer.from(JSON.stringify({ type: 'progress', padding: 'x'.repeat(65500) }) + '\n');
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, user + '\n');
  while (fs.fstatSync(fd).size < 600 * 1024 * 1024) fs.writeSync(fd, noise);
  fs.writeSync(fd, user.replace('first', 'last'));
  fs.closeSync(fd);
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
