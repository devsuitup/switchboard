/**
 * BT2 — Golden-output characterization tests for readSessionFile and
 * readSessionDisplayHeader. These tests pin the full output contract against a
 * checked-in synthetic fixture so a perf refactor must produce identical output
 * to stay green.
 *
 * Fixture: test/fixtures/golden-session.jsonl
 *   - 2 user turns + 2 assistant turns (messageCount = 4)
 *   - slug = "golden-slug-abc123"
 *   - model = "claude-opus-4-5"
 *   - inputTokens = 20 + 30 = 50
 *   - outputTokens = 10 + 15 = 25
 *   - cacheReadTokens = 5 + 3 = 8
 *   - summary = first user message text
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readSessionFile, readSessionDisplayHeader } = require('../read-session-file');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'golden-session.jsonl');

test('parser output requires a content version bump for Claude, bridge and Codex derivation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-index-1144-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(root, 'codex');
  t.after(() => { process.env.CODEX_HOME = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const user = (uuid, day, text) => ({ type: 'user', uuid, timestamp: `2024-01-${day}T00:00:00.000Z`, message: { content: text } });
  const bridge = { type: 'bridge-session', bridgeSessionId: 'cse_golden' };
  const write = (name, entries) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    return file;
  };
  write('parent.jsonl', [user('shared', '01', 'shared text'), user('parent', '03', 'parent text'), bridge]);
  write('mirror.jsonl', [user('shared', '01', 'shared text'), user('own', '04', 'mirror text'), bridge]);
  const reread = (id, dedupeSinceTimestamp, excludedMessageUuids, excludedMessageSignatures) => readSessionFile(path.join(root, id + '.jsonl'), 'folder', '/fixture',
    { dedupeSinceTimestamp, excludedMessageUuids, excludedMessageSignatures });
  const merged = require('../read-session-file').mergeBridgeGroups([], ['parent', 'mirror'].map(id => reread(id)), reread);
  const codexFile = write('rollout-2024-01-01-00000000-0000-0000-0000-000000000001.jsonl', [
    { type: 'session_meta', timestamp: '2024-01-01T00:00:00.000Z', payload: { cwd: '/fixture' } },
    { type: 'response_item', timestamp: '2024-01-01T00:00:01.000Z', payload: { type: 'message', role: 'user', content: 'Codex golden body' } },
  ]);
  const rows = [readSessionFile(FIXTURE_PATH, 'folder', '/fixture'), ...merged.toUpsert,
    require('../harnesses/codex').readSessionFile(codexFile, 'codex/2024/01/01')];
  const normalize = value => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => {
      let next = value[key];
      if (['fileMtime', 'dev', 'ino', 'birthtimeNs', 'mtimeNs', 'ctimeNs', 'mtime'].includes(key)) next = '<filesystem>';
      else if (key === 'sessionFile') next = path.basename(next);
      else if (['fullReadStamp', 'continuationIndex', 'messageCountIndex'].includes(key) && next) next = JSON.parse(next);
      return [key, normalize(next)];
    }));
  };
  const output = normalize(rows.map(row => ({ row, metrics: row.dailyMetrics,
    search: { title: ((row.customTitle || row.aiTitle || '') + ' ' + row.summary).trimStart(), body: row.textContent } })));
  const digest = require('node:crypto').createHash('sha256').update(JSON.stringify(output)).digest('hex');
  const state = require('../src/main/session-index/full-read-state');
  assert.equal(digest, state.CONTENT_GOLDEN_DIGESTS?.[state.SESSION_CONTENT_INDEX_VERSION], 'digest matches immutable content-version ledger');
});

test('readSessionFile: golden output matches fixture — full shape', () => {
  const stat = fs.statSync(FIXTURE_PATH);
  const row = readSessionFile(FIXTURE_PATH, 'test-folder', '/some/project');

  assert.ok(row, 'readSessionFile must return a non-null row for a valid fixture');

  // sessionId derived from filename (basename without .jsonl)
  assert.equal(row.sessionId, 'golden-session');
  assert.equal(row.folder, 'test-folder');
  assert.equal(row.projectPath, '/some/project');

  // summary = first real user message (not tool_result, not bash command)
  assert.equal(row.summary, 'What is the capital of France?');

  // messageCount: user + assistant + user + assistant = 4
  assert.equal(row.messageCount, 4);

  // slug from JSONL content
  assert.equal(row.slug, 'golden-slug-abc123');

  // modified = last MESSAGE timestamp in the transcript, not the file's mtime.
  // Upstream split the two: resuming a session appends untimestamped bookkeeping
  // records that bump mtime without real activity, so mtime made idle sessions
  // read "just now". fileMtime carries the mtime and is the re-index key.
  assert.equal(row.modified, '2024-03-15T10:01:01.000Z',
    'modified must be the last message timestamp from the fixture');
  assert.equal(row.created, '2024-03-15T10:00:00.000Z',
    'created must be the first message timestamp from the fixture');
  assert.equal(row.fileMtime, stat.mtime.toISOString(),
    'fileMtime carries the filesystem mtime (cache-invalidation key)');

  // dailyMetrics: all 4 messages share the same date (2024-03-15)
  // The 2 assistant turns are on claude-opus-4-5; the 2 user turns bucket under ''
  assert.ok(Array.isArray(row.dailyMetrics), 'dailyMetrics must be an array');

  const assistantMetric = row.dailyMetrics.find(m => m.model === 'claude-opus-4-5');
  assert.ok(assistantMetric, 'expected a metric row for claude-opus-4-5');
  assert.equal(assistantMetric.date, '2024-03-15');
  assert.equal(assistantMetric.inputTokens, 50,  'inputTokens: 20 + 30');
  assert.equal(assistantMetric.outputTokens, 25, 'outputTokens: 10 + 15');
  assert.equal(assistantMetric.cacheReadTokens, 8, 'cacheReadTokens: 5 + 3');
  assert.equal(assistantMetric.messageCount, 2, 'two assistant messages');
});

test('readSessionFile: partial-write — truncated last line is skipped, rest parses fine', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-golden-partial-'));
  try {
    const filePath = path.join(tmp, 'partial.jsonl');
    // Valid line + truncated line (missing closing brace)
    const content =
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello partial' } }) + '\n' +
      '{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-5","content":[{"type":"text","text":"hi"}';
    // Intentionally NOT closing the JSON — simulates mid-write truncation
    fs.writeFileSync(filePath, content, 'utf8');

    const row = readSessionFile(filePath, 'folder', '/proj');
    assert.ok(row, 'must return a row even with a truncated last line');
    assert.equal(row.summary, 'hello partial');
    // Only the complete line counts toward messageCount (the assistant line is truncated)
    assert.equal(row.messageCount, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('readSessionDisplayHeader: parity with readSessionFile on summary / slug / agentId for golden fixture', () => {
  const full = readSessionFile(FIXTURE_PATH, 'folder', '/proj');
  const header = readSessionDisplayHeader(FIXTURE_PATH);

  assert.ok(full, 'readSessionFile must succeed');
  assert.ok(header, 'readSessionDisplayHeader must succeed');

  // Fields the header path is required to return correctly
  assert.equal(header.summary, full.summary,
    'summary must match between full and header read');
  assert.equal(header.slug, full.slug,
    'slug must match between full and header read');
  assert.equal(header.sessionId, full.sessionId,
    'sessionId (from filename) must match');
  // `modified` deliberately does NOT match any more. The full read reports the
  // last message timestamp; the header read only sees the first 256 KB of the
  // transcript, so it cannot know that and still reports the file mtime — which
  // is what full.fileMtime holds. Asserting the pairing rather than equality
  // keeps the divergence intentional instead of latent.
  assert.equal(header.modified, full.fileMtime,
    'header modified falls back to file mtime, which the full read exposes as fileMtime');
  assert.notEqual(header.modified, full.modified,
    'header cannot recover the last-message time from a head-only read');
});
