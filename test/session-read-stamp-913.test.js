'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cache = require('../session-cache');
const { readSessionFile } = require('../read-session-file');
const { continuationMtime } = require('../session-continuations');
const { fixture, OLD, line } = require('./fixtures/continuation-718.cjs');

test('a same-size subagent rewrite after reading stays stale and is refreshed', t => {
  const h = fixture(t);
  h.write(OLD);
  const file = path.join(h.dir, OLD, 'subagents', 'agent-child.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = line({ type: 'user', isSidechain: true, agentId: 'child', message: { content: 'before' } });
  const after = before.replace('before', 'after!');
  assert.equal(Buffer.byteLength(before), Buffer.byteLength(after));
  fs.writeFileSync(file, before);
  fs.utimesSync(file, new Date('2026-10-29T10:00:00Z'), new Date('2026-10-29T10:00:00Z'));
  const expected = continuationMtime(fs.statSync(file, { bigint: true }));
  const read = fs.readFileSync;
  let rewritten = false;
  const replacement = t.mock.method(fs, 'readFileSync', (target, ...args) => {
    const bytes = read(target, ...args);
    if (target === file && !rewritten) {
      rewritten = true;
      fs.writeFileSync(file, after);
      fs.utimesSync(file, new Date('2026-10-29T11:00:00Z'), new Date('2026-10-29T11:00:00Z'));
    }
    return bytes;
  });
  const row = readSessionFile(file, h.folder, h.root, { parentSessionId: OLD });
  replacement.mock.restore();
  assert.ok(rewritten);
  assert.equal(row.firstPrompt, 'before');
  assert.equal(row.fileMtime, expected, 'freshness must describe the bytes read, before the rewrite');
  h.db.upsertCachedSessions([readSessionFile(h.file(OLD), h.folder, h.root), row]);
  cache.refreshFolder(h.folder);
  assert.equal(h.rows.get(row.sessionId).firstPrompt, 'after!', 'the next refresh must read the same-size rewrite');
});
