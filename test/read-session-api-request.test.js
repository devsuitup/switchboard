'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSessionEntrypoint } = require('../read-session-file');

test('i730 measurement: the live SDK tail finds a terminal user before a 300000-byte API request', t => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-i730-sdk-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const entries = [
    { type: 'user', entrypoint: 'sdk-cli', message: { content: 'review' } },
    ...Array(600).fill({ type: 'assistant', message: { content: 'x'.repeat(4096) } }),
    { type: 'user', entrypoint: 'cli', message: { content: 'typed later' } },
    { type: 'api-request', params: 'x'.repeat(300_000 - Buffer.byteLength(JSON.stringify({ type: 'api-request', params: '' }))) },
  ];
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  assert.ok(fs.statSync(file).size > 2 * 1024 * 1024);
  assert.equal(readSessionEntrypoint(file, { full: true }), 'cli');
  assert.equal(readSessionEntrypoint(file), 'cli');
});

test('i730b: one-shot entrypoint reads find terminal users behind 3 MiB on every changed snapshot', t => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-i730b-sdk-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, [
    { type: 'user', entrypoint: 'sdk-cli' },
    { type: 'assistant', message: { content: 'x'.repeat(300_000) } },
    { type: 'user', entrypoint: 'cli' },
    { type: 'api-request', params: 'x'.repeat(3 * 1024 * 1024) },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  const realRead = fs.readSync;
  let bytes = 0;
  fs.readSync = (...args) => { const n = realRead(...args); bytes += n; return n; };
  try {
    for (let i = 0; i < 3; i++) {
      bytes = 0;
      assert.equal(readSessionEntrypoint(file), 'cli');
      assert.ok(bytes < 5 * 1024 * 1024, `unbounded one-shot read: ${bytes}`);
      fs.appendFileSync(file, '{}\n');
    }
    bytes = 0;
    assert.equal(readSessionEntrypoint(file), 'cli');
    assert.ok(bytes > 3 * 1024 * 1024, 'one-shot read reused retained tail buffers');
  } finally { fs.readSync = realRead; }
});
