'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTranscriptTurnReader } = require('../transcript-turn');

function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-api-tail-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 's.jsonl');
}

const prompt = (text = 'do it') => JSON.stringify({ type: 'user', timestamp: new Date(2000).toISOString(), message: { content: text } }) + '\n';

test('i730: a 50 MB API line is skipped over bounded polls and unchanged snapshots read no bytes', t => {
  const file = fixture(t);
  fs.writeFileSync(file, prompt() + '{"type":"api-request","params":"');
  const block = 'x'.repeat(1024 * 1024);
  for (let i = 0; i < 50; i++) fs.appendFileSync(file, block);
  fs.appendFileSync(file, '"}\n');
  const reader = createTranscriptTurnReader();
  const realRead = fs.readSync;
  let bytes = 0;
  fs.readSync = (...args) => { const count = realRead(...args); bytes += count; return count; };
  try {
    let turn;
    for (let i = 0; i < 52; i++) {
      bytes = 0;
      turn = reader.read(file);
      assert.ok(bytes <= 1024 * 1024, 'read ' + bytes + ' bytes in one poll');
      if (turn.prompts.length) break;
    }
    assert.deepEqual(turn.prompts, [{ at: 2000, text: 'do it' }]);
    bytes = 0;
    reader.read(file);
    assert.equal(bytes, 0);
  } finally { fs.readSync = realRead; }
});

test('i730: API prefixes spanning chunk boundaries preserve UTF-8 prompts and ignore partial API writes', t => {
  const file = fixture(t);
  const text = 'é 🧭 do it';
  const tailBytes = 257;
  const reader = createTranscriptTurnReader({ tailBytes });
  const prefix = ' { "type" : "api-request", "params":"';
  const bodyBytes = 300_000 + (9 - (Buffer.byteLength(prefix) + 300_000) % tailBytes + tailBytes) % tailBytes;
  fs.writeFileSync(file, prompt(text) + prefix + 'x'.repeat(bodyBytes));
  assert.deepEqual(reader.read(file).prompts, [{ at: 2000, text }]);
  fs.appendFileSync(file, '"}\n');
  assert.deepEqual(reader.read(file).prompts, [{ at: 2000, text }]);
});

for (const change of ['truncate', 'replace', 'rewrite', 'forget']) {
  test(`i730: ${change} does not retain a discarded prompt`, t => {
    const file = fixture(t);
    const reader = createTranscriptTurnReader();
    fs.writeFileSync(file, prompt('old') + JSON.stringify({ type: 'api-request', params: 'x'.repeat(300_000) }) + '\n');
    assert.equal(reader.read(file).prompts[0].text, 'old');
    if (change === 'replace') fs.renameSync(file, file + '.old');
    if (change === 'forget') reader.forget(file);
    fs.writeFileSync(file, change === 'rewrite' ? prompt('new') + JSON.stringify({ type: 'api-request', params: 'x'.repeat(300_000) }) + '\n' : prompt('new'));
    const now = new Date(Date.now() + 10_000);
    fs.utimesSync(file, now, now);
    assert.deepEqual(reader.read(file).prompts, [{ at: 2000, text: 'new' }]);
  });
}

test('i730: user text containing an API prefix remains a prompt', t => {
  const file = fixture(t);
  const text = '{"type":"api-request","params":"quoted"}';
  fs.writeFileSync(file, prompt(text));
  assert.deepEqual(createTranscriptTurnReader().read(file).prompts, [{ at: 2000, text }]);
});

test('i730: an oversized non-API output keeps its complete fingerprint after bounded scanning', t => {
  const file = fixture(t);
  const reader = createTranscriptTurnReader();
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { content: 'baseline' } }) + '\n');
  const baseline = reader.read(file).writtenOutput;
  fs.appendFileSync(file, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(2 * 1024 * 1024) }] } }) + '\n');
  let turn;
  for (let i = 0; i < 4; i++) turn = reader.read(file);
  assert.notEqual(turn.writtenOutput, baseline);
  assert.match(turn.writtenOutput, /^[a-f0-9]{64}$/);
});
