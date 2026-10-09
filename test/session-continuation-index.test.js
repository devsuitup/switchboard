'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { readSessionFile } = require('../read-session-file');

test('Observed-format fixture: CLI 2.1.289 and 2.1.295 continued-in field names are indexed mid-file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-continuation-canary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'old.jsonl');
  fs.writeFileSync(file, [
    { type: 'user', message: { content: 'fixture' } },
    { type: 'continued-in', sessionId: 'old', continuedInSessionId: 'new', timestamp: '2026-10-09T12:00:00Z' },
    { type: 'continued-in', sessionId: 'other', continuedInSessionId: 'wrong', timestamp: '2026-10-09T12:01:00Z' },
    { type: 'last-prompt', lastPrompt: 'bookkeeping follows' },
  ].map(JSON.stringify).join('\n') + '\n');
  const row = readSessionFile(file, 'folder', dir);
  assert.ok(row.continuationIndex, 'the scanner must preserve the observed continued-in contract');
  const index = JSON.parse(row.continuationIndex);
  assert.deepEqual(index.ids, ['new']);
});

