'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSessionFile } = require('../read-session-file');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'read-work-1192-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lines = [JSON.stringify({ type: 'user', uuid: 'prompt', message: { content: 'Budget fixture' }, timestamp: '2026-01-01T00:00:00Z' })];
  for (let i = 0; i < 96; i++) lines.push(JSON.stringify({ type: 'assistant', uuid: 'reply-' + i,
    timestamp: '2026-01-01T00:00:01Z', message: { model: 'model-' + i, usage: { output_tokens: 3 }, content: [{ type: 'text', text: 'reply' }] } }));
  lines.push('{"type":"assistant"');
  const file = path.join(root, 'fixture.jsonl');
  fs.writeFileSync(file, lines.join('\n'));
  return { root, file, lines, read: () => readSessionFile(file, 'fixture', root) };
}

test('full transcript reading decodes each JSONL record only once', t => {
  const f = fixture(t), inputs = new Set(f.lines), parse = JSON.parse;
  let decodes = 0;
  t.mock.method(JSON, 'parse', function (text, ...args) {
    if (inputs.has(text)) decodes++;
    return parse.call(this, text, ...args);
  });
  const row = f.read();
  assert.equal(row.messageCount, 97);
  assert.ok(row.fullReadStamp);
  assert.equal(decodes, f.lines.length, 'one JSON decode per record, including the incomplete tail');
});

test('full transcript reading materializes metric buckets only after accumulation', t => {
  const f = fixture(t), values = Map.prototype.values;
  let visited = 0;
  t.mock.method(Map.prototype, 'values', function* () {
    for (const value of values.call(this)) {
      if (value && typeof value.model === 'string' && typeof value.outputTokens === 'number') visited++;
      yield value;
    }
  });
  const row = f.read();
  assert.equal(row.dailyMetrics.length, 97);
  assert.equal(row.dailyMetrics.reduce((sum, bucket) => sum + bucket.outputTokens, 0), 288);
  assert.ok(visited <= 2 * row.dailyMetrics.length, `metric visits must be linear: visited ${visited} for ${row.dailyMetrics.length} buckets`);
});
