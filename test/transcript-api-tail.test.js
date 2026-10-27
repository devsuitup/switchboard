'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTranscriptTurnReader } = require('../transcript-turn');
const { createTranscriptTailReader } = require('../transcript-tail');

function statOf(file) {
  const stat = fs.statSync(file, { bigint: true });
  return { dev: stat.dev, ino: stat.ino, size: Number(stat.size), mtimeMs: String(stat.mtimeNs) };
}

function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-api-tail-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 's.jsonl');
}

const prompt = (text = 'do it') => JSON.stringify({ type: 'user', timestamp: new Date(2000).toISOString(), message: { content: text } }) + '\n';

for (const type of ['api-request', 'api-request-shape', 'api-request-blob']) {
  test(`i730: a 50 MB ${type} line is skipped over bounded polls and unchanged snapshots read no bytes`, t => {
    const file = fixture(t);
    fs.writeFileSync(file, prompt() + `{"type":"${type}","params":"`);
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
}

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
  fs.writeFileSync(file, JSON.stringify({ nested: { type: 'api-request', params: 'quoted' },
    type: 'user', timestamp: new Date(2000).toISOString(), message: { content: text } }) + '\n');
  assert.deepEqual(createTranscriptTurnReader().read(file).prompts, [{ at: 2000, text }]);
});

test('i730b: appended API records keep the prompt and read only appended bytes', t => {
  const file = fixture(t);
  const reader = createTranscriptTailReader();
  fs.writeFileSync(file, prompt());
  reader.read(file, statOf(file));
  const realRead = fs.readSync;
  let bytes = 0;
  fs.readSync = (...args) => { const n = realRead(...args); bytes += n; return n; };
  try {
    for (let i = 0; i < 10; i++) {
      const appended = JSON.stringify({ type: 'api-request', params: 'x'.repeat(200_000) }) + '\n{}\n';
      fs.appendFileSync(file, appended);
      bytes = 0;
      const result = reader.read(file, statOf(file));
      assert.ok(result.text.includes('do it'), `prompt lost on append ${i}`);
      assert.ok(bytes <= Buffer.byteLength(appended) + 384, `reread old bytes: ${bytes}`);
    }
  } finally { fs.readSync = realRead; }
});

test('i730b: an unfinished scan progresses while the transcript grows every poll', t => {
  const file = fixture(t);
  const reader = createTranscriptTurnReader();
  fs.writeFileSync(file, prompt() + JSON.stringify({ type: 'api-request', params: 'x'.repeat(3 * 1024 * 1024) }) + '\n');
  let seen = false;
  for (let i = 0; i < 12; i++) {
    fs.appendFileSync(file, JSON.stringify({ type: 'api-request', params: 'x'.repeat(200_000) }) + '\n{}\n');
    if (reader.read(file).prompts.some(p => p.text === 'do it')) seen = true;
  }
  assert.equal(seen, true);
});

for (const location of ['head', 'boundary']) {
  test(`i730b: growth with a rewritten ${location} restarts the scan`, t => {
    const file = fixture(t);
    const reader = createTranscriptTurnReader();
    fs.writeFileSync(file, prompt('old') + JSON.stringify({ type: 'api-request', params: 'x'.repeat(300_000) }) + '\n');
    reader.read(file);
    const fd = fs.openSync(file, 'r+');
    try {
      if (location === 'head') {
        const replacement = Buffer.from(prompt('new').replace('.000Z', '.001Z'));
        fs.writeSync(fd, replacement, 0, replacement.length, 0);
      }
      else fs.writeSync(fd, Buffer.from('!'), 0, 1, fs.statSync(file).size - 3);
    } finally { fs.closeSync(fd); }
    fs.appendFileSync(file, location === 'head' ? '{}\n' : prompt('new'));
    assert.equal(reader.read(file).prompts.at(-1).text, 'new');
  });
}

test('i730b: an oversized unknown partial line cannot expose an older closed turn', t => {
  const file = fixture(t);
  const reader = createTranscriptTurnReader();
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', timestamp: new Date(2000).toISOString(), message: { stop_reason: 'end_turn' } })
    + '\n' + JSON.stringify({ type: 'system', subtype: 'turn_duration' }) + '\n');
  assert.equal(reader.read(file).closed, true);
  fs.appendFileSync(file, '{"type":"user","message":{"content":"' + 'x'.repeat(5 * 1024 * 1024));
  let turn;
  for (let i = 0; i < 7; i++) turn = reader.read(file);
  assert.equal(turn.state, 'unknown');
  fs.appendFileSync(file, '"}}\n' + prompt('new'));
  assert.deepEqual(reader.read(file).prompts, [{ at: 2000, text: 'new' }]);
});

test('i730c: a growing same-inode rewrite in the old middle discards the cached prompt', t => {
  const file = fixture(t);
  const reader = createTranscriptTurnReader();
  const middle = prompt('OLD');
  const prefix = JSON.stringify({ type: 'api-request', params: 'x'.repeat(1000) }) + '\n';
  const suffix = JSON.stringify({ type: 'api-request', params: 'x'.repeat(1000) }) + '\n';
  fs.writeFileSync(file, prefix + middle + suffix);
  const before = fs.statSync(file, { bigint: true });
  assert.equal(reader.read(file).prompts[0].text, 'OLD');
  const fd = fs.openSync(file, 'r+');
  try {
    const replacement = Buffer.from(prompt('NEW'));
    fs.writeSync(fd, replacement, 0, replacement.length, Buffer.byteLength(prefix));
  } finally { fs.closeSync(fd); }
  fs.appendFileSync(file, '{}\n');
  assert.equal(fs.statSync(file, { bigint: true }).ino, before.ino);
  assert.deepEqual(reader.read(file).prompts, [{ at: 2000, text: 'NEW' }]);
});

test('i730c: growth with an older mtime discards edits outside the samples', t => {
  const file = fixture(t);
  const reader = createTranscriptTurnReader();
  const prefix = JSON.stringify({ type: 'api-request', params: 'x'.repeat(1000) }) + '\n';
  fs.writeFileSync(file, prefix + prompt('OLD') + JSON.stringify({ type: 'api-request', params: 'x'.repeat(3 * 1024 * 1024) }) + '\n');
  const before = fs.statSync(file);
  let turn;
  for (let poll = 0; poll < 5; poll++) turn = reader.read(file);
  assert.equal(turn.prompts[0].text, 'OLD');
  const fd = fs.openSync(file, 'r+');
  try {
    const replacement = Buffer.from(prompt('NEW'));
    fs.writeSync(fd, replacement, 0, replacement.length, Buffer.byteLength(prefix));
  } finally { fs.closeSync(fd); }
  fs.appendFileSync(file, '{}\n');
  const older = new Date(before.mtimeMs - 10_000);
  fs.utimesSync(file, older, older);
  for (let poll = 0; poll < 5; poll++) turn = reader.read(file);
  assert.deepEqual(turn.prompts, [{ at: 2000, text: 'NEW' }]);
});

test('i730b: pending fragments of a 30 MiB partial line retain bounded buffers', t => {
  const file = fixture(t);
  fs.writeFileSync(file, prompt() + '{"type":"api-request","params":"' + 'x'.repeat(30 * 1024 * 1024));
  const vm = require('node:vm');
  const filename = path.join(__dirname, '../transcript-tail.js');
  const maps = [];
  class TrackedMap extends Map { constructor(...args) { super(...args); maps.push(this); } }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports,
    require: require('node:module').createRequire(filename), Buffer, Map: TrackedMap }, { filename });
  const reader = module.exports.createTranscriptTailReader();
  for (let i = 0; i < 30; i++) reader.read(file, statOf(file));
  const buffers = new Set();
  function retained(value) {
    if (Buffer.isBuffer(value)) buffers.add(value.buffer);
    else if (value && typeof value === 'object') Object.values(value).forEach(retained);
  }
  maps.forEach(map => [...map.values()].forEach(retained));
  const bytes = [...buffers].reduce((n, buffer) => n + buffer.byteLength, 0);
  assert.ok(bytes <= 5 * 1024 * 1024, `retained ${bytes} bytes`);
  const result = reader.read(file, statOf(file));
  assert.ok(result.text.includes('do it'));
});

test('i730b: the tail cache evicts the least recently used path', t => {
  const first = fixture(t);
  const dir = path.dirname(first);
  const reader = createTranscriptTailReader();
  fs.writeFileSync(first, prompt());
  reader.read(first, statOf(first));
  for (let i = 1; i < 128; i++) {
    const file = path.join(dir, `${i}.jsonl`);
    fs.writeFileSync(file, prompt());
    reader.read(file, statOf(file));
  }
  reader.read(first, statOf(first));
  const extra = path.join(dir, 'extra.jsonl');
  fs.writeFileSync(extra, prompt());
  reader.read(extra, statOf(extra));
  const realRead = fs.readSync;
  let bytes = 0;
  fs.readSync = (...args) => { const n = realRead(...args); bytes += n; return n; };
  try {
    reader.read(first, statOf(first));
    assert.equal(bytes, 0, 'recently accessed path was evicted');
    reader.read(path.join(dir, '1.jsonl'), statOf(path.join(dir, '1.jsonl')));
    assert.ok(bytes > 0, 'least recently accessed path was retained');
  } finally { fs.readSync = realRead; }
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
