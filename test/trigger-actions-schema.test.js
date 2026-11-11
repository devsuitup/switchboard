'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start } = require('./fixtures/trigger-watcher.cjs');

const id = 'abcdef01-2345-6789-abcd-0123456789ab';
const request = '12345678-1234-1234-1234-123456789abc';
const base = { version: 1, action: 'open', sessionId: id };
const newBase = { version: 1, action: 'open', new: { project: path.resolve('project'), name: 'Next' }, prompt: 'Do it' };
const stop = { version: 1, action: 'stop', sessionId: id };
const log = { info() {}, warn() {}, error() {} };

async function runTrigger(t, payload, name = request) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-v1-schema-')));
  const previous = process.env.SWITCHBOARD_TRIGGERS_DIR;
  process.env.SWITCHBOARD_TRIGGERS_DIR = dir;
  let effects = 0;
  fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(payload));
  const watcher = start({ log, getPtyForSession: () => { effects++; return null; }, isSessionBusy: () => false,
    remote: { lookup() { effects++; }, send() { effects++; } } });
  t.after(() => {
    watcher.close();
    if (previous === undefined) delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    else process.env.SWITCHBOARD_TRIGGERS_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const resultFile = path.join(dir, 'processed', name.toLowerCase() + '.result.json');
  const deadline = performance.now() + 2500;
  while (!fs.existsSync(resultFile)) {
    assert.ok(performance.now() < deadline, 'one terminal result must be published');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.deepEqual(fs.readdirSync(path.join(dir, 'processed')).filter(file => file.endsWith('.result.json')),
    [path.basename(resultFile)], 'result filename must match the exact canonical spelling');
  return { result: JSON.parse(fs.readFileSync(resultFile, 'utf8')), effects };
}

const cases = [
  ['action without version', { action: 'open' }, 'unsupported version'],
  ['string version before action', { version: '1', action: 'bad', cli: true }, 'unsupported version'],
  ['null version', { version: null }, 'unsupported version'],
  ['action before filename', { version: 1, action: 'bad' }, 'unsupported action', 'bad'],
  ['filename before targets', { version: 1, action: 'open' }, 'trigger filename must be a lowercase UUID', request.toUpperCase()],
  ['both targets before fields', { ...base, new: null, cli: true }, 'open requires exactly one of sessionId or new'],
  ['neither target before fields', { version: 1, action: 'open', focus: true }, 'open requires exactly one of sessionId or new'],
  ['missing stop target', { version: 1, action: 'stop', new: {} }, 'missing required field: sessionId'],
  ['sorted fields before UUID', { ...base, sessionId: false, z: true, cli: true }, 'unsupported field: cli'],
  ['nested dotted field order', { ...newBase, new: { ...newBase.new, options: null }, z: true }, 'unsupported field: new.options'],
  ['new type before nested fields', { ...newBase, new: [] }, 'new must be an object'],
  ['invalid UUID', { ...base, sessionId: '../escape' }, 'sessionId must be a UUID'],
  ['null target counts as present', { ...base, sessionId: null }, 'sessionId must be a UUID'],
  ['project before name', { ...newBase, new: { project: 'relative', name: '' } }, 'new.project must be an absolute path'],
  ['missing project', { ...newBase, new: { name: 'Name' } }, 'new.project must be an absolute path'],
  ['blank name', { ...newBase, new: { project: newBase.new.project, name: '  ' } }, 'new.name must be a non-empty string'],
  ['long name before control', { ...newBase, new: { ...newBase.new, name: '\x00' + 'a'.repeat(256) } }, 'new.name too long (max 256 characters)'],
  ['name controls', { ...newBase, new: { ...newBase.new, name: 'a\x7f' } }, 'new.name contains control characters'],
  ['missing new prompt', { version: 1, action: 'open', new: newBase.new }, 'prompt must be a non-empty string'],
  ['null resume prompt', { ...base, prompt: null }, 'prompt must be a non-empty string'],
  ['blank before', { ...stop, before: ' \t ' }, 'before must be a non-empty string'],
  ['text length before controls', { ...base, prompt: '\n' + 'a'.repeat(4096), timeout_ms: 0 }, 'prompt too long (max 4 KB)'],
  ['text controls before timeout', { ...base, prompt: 'a\n', timeout_ms: 0 }, 'prompt contains forbidden control characters (\\r \\n \\0 \\x1b)'],
  ['before controls', { ...stop, before: 'a\x1b' }, 'before contains forbidden control characters (\\r \\n \\0 \\x1b)'],
  ['timeout before cwd', { ...base, timeout_ms: 0, expectedCwd: '' }, 'invalid timeout_ms'],
  ['cwd invalid', { ...base, expectedCwd: null }, 'expectedCwd must be a non-empty string when present'],
];

for (const [name, payload, expected, filename] of [
  ['blank prompt', { ...base, prompt: ' ' }, 0],
  ['null prompt', { ...base, prompt: null }, 0],
  ['oversized prompt', { ...base, prompt: 'a'.repeat(4097) }, 0],
  ['control in before', { ...stop, before: 'a\n' }, 0],
  ['rejected before field', { ...base, before: 'valid text' }, 0],
  ['rejected prompt field', { ...stop, prompt: 'valid text' }, 0],
  ['valid prompt before invalid timeout', { ...base, prompt: 'valid text', timeout_ms: 0 }, 1],
  ['text never reached after unsupported field', { ...base, prompt: 'valid text', focus: true }, 0],
  ['text never reached after invalid filename', { ...base, prompt: 'valid text' }, 0, request.toUpperCase()],
]) {
  test(`steps_total counts validated text: ${name}`, async t => {
    const { result } = await runTrigger(t, payload, filename);
    assert.equal(result.steps_total, expected, 'only text that passed validation counts as a step');
  });
}
for (const field of ['command', 'key', 'chain', 'cli', 'options', 'focus', 'wait', 'before']) {
  cases.push([`resume rejects ${field}`, { ...base, [field]: null }, `unsupported field: ${field}`]);
}
for (const field of ['prompt', 'new']) cases.push([`stop rejects ${field}`, { ...stop, [field]: false }, `unsupported field: ${field}`]);
for (const field of ['options', 'permissionMode']) cases.push([`new rejects ${field}`, { ...newBase, new: { ...newBase.new, [field]: null } }, `unsupported field: new.${field}`]);
cases.push(['new rejects cwd', { ...newBase, expectedCwd: 'x' }, 'unsupported field: expectedCwd']);
for (const value of [-1, 600001, 1.5, '1', null, false]) cases.push([`timeout ${JSON.stringify(value)}`, { ...base, timeout_ms: value }, 'invalid timeout_ms']);
for (const value of ['', ' ', false, 2]) cases.push([`prompt ${JSON.stringify(value)}`, { ...base, prompt: value }, 'prompt must be a non-empty string']);
for (const ch of ['\r', '\n', '\0', '\x1b']) cases.push([`control ${JSON.stringify(ch)}`, { ...base, prompt: 'a' + ch }, 'prompt contains forbidden control characters (\\r \\n \\0 \\x1b)']);

for (const [name, payload, reason, filename] of cases) {
  test(`v1 validation: ${name}`, async t => {
    const { result, effects } = await runTrigger(t, payload, filename);
    assert.equal(result.reason, reason);
    assert.equal(result.outcome, 'refused');
    assert.equal(result.ok, false);
    assert.equal(result.submitted, 'no');
    assert.equal(result.wrote, false);
    assert.equal(effects, 0, 'schema refusals cannot reach local or remote delivery');
    assert.deepEqual(result.version, payload?.version ?? null);
    assert.deepEqual(result.action, payload?.action ?? null);
  });
}

for (const payload of [base, { ...base, sessionId: id.toUpperCase(), prompt: ' a\tb ', timeout_ms: 1 },
  { ...base, prompt: 'a'.repeat(4096), timeout_ms: 600000, expectedCwd: 'x' },
  newBase, { ...newBase, new: { ...newBase.new, name: 'a'.repeat(256) } }, stop, { ...stop, before: 'Save' }]) {
  test(`v1 accepts schema then explicitly refuses unavailable action: ${JSON.stringify(payload).slice(0, 140)}`, async t => {
    const { result, effects } = await runTrigger(t, payload);
    assert.equal(result.reason, 'session action not implemented in this build');
    assert.equal(result.outcome, 'refused');
    assert.equal(result.ok, false);
    assert.equal(result.version, 1);
    assert.equal(result.action, payload.action);
    assert.equal(result.sessionId, payload.sessionId?.toLowerCase() ?? null);
    assert.equal(result.steps_total, Object.hasOwn(payload, 'prompt') || Object.hasOwn(payload, 'before') ? 1 : 0);
    assert.equal(result.submitted, 'no');
    assert.equal(result.wrote, false);
    if (payload.action === 'open') assert.equal(result[payload.new ? 'created' : 'resumed'], false);
    assert.equal(effects, 0);
  });
}

test('the standalone v1 validator keeps rejecting non-objects with its typed reason', () => {
  const { validateTrigger } = require('../src/main/triggers/trigger-actions');
  for (const value of [null, [], 7, 'text', true, undefined]) {
    assert.equal(validateTrigger(value, request), 'trigger must be an object');
  }
});
