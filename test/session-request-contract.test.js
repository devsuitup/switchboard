'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const file = require('node:path').join(__dirname, '../src/main/triggers/session-request-contract.js');
const contract = fs.existsSync(file) ? require(file) : {};
const id = 'abcdef01-2345-6789-abcd-0123456789ab';
const request = { version: 1, type: 'session-status', requestId: id, from: id, sessionId: id };
function parse(raw, stem = id) {
  assert.equal(typeof contract.parseSessionRequest, 'function', 'strict typed parser must be available');
  return contract.parseSessionRequest(Buffer.isBuffer(raw) ? raw : Buffer.from(raw), stem);
}
test('typed status accepts exact five fields and case-insensitive filename UUID', () => {
  const result = parse(JSON.stringify(request), id.toUpperCase());
  assert.equal(result.reason, null);
  assert.deepEqual(result.request, request);
});
for (const [name, raw] of [
  ['duplicate', JSON.stringify(request).replace('"version":1', '"version":1,"version":1')],
  ['escaped duplicate', JSON.stringify(request).replace('"version":1', '"version":1,"\\u0076ersion":1')],
  ['nested duplicate', JSON.stringify({ ...request, extra: { a: 1 } }).replace('"a":1', '"a":1,"\\u0061":2')],
  ['prototype', JSON.stringify(request).replace('"version":1', '"version":1,"__proto__":{}')],
  ['mixed action', JSON.stringify({ ...request, action: 'stop' })],
  ['unknown key', JSON.stringify({ ...request, wait: 'none' })],
  ['null type', JSON.stringify({ ...request, type: null })],
  ['unknown type', JSON.stringify({ ...request, type: 'future' })],
  ['wrong version', JSON.stringify({ ...request, version: '1' })],
  ['missing from', JSON.stringify({ ...request, from: undefined })],
  ['array root', '[]'], ['null root', 'null'],
  ['malformed UTF8', Buffer.concat([Buffer.from(JSON.stringify(request).slice(0, -1) + ',"extra":"'), Buffer.from([0xff]), Buffer.from('"}')])],
  ['oversize', Buffer.alloc(65537, 32)],
]) test(`typed parser refuses ${name}`, () => assert.ok(parse(raw).reason));
test('filename mismatch refuses and exact inclusive size remains accepted', () => {
  assert.ok(parse(JSON.stringify(request), '00000000-0000-4000-8000-000000000000').reason);
  const raw = JSON.stringify(request);
  assert.equal(parse(raw + ' '.repeat(65536 - Buffer.byteLength(raw))).reason, null);
});
test('open request is recognized for durable unsupported refusal', () => {
  const result = parse(JSON.stringify({ version: 1, type: 'open-session', requestId: id, from: id,
    kind: 'child', project: process.cwd(), prompt: 'Report.' }));
  assert.equal(result.family, 'open-session');
  assert.equal(result.reason, 'unsupported trigger type');
});
test('open refusal identity normalizes the optional forkFrom UUID as well', () => {
  const result = parse(JSON.stringify({ version: 1, type: 'open-session', requestId: id, from: id,
    kind: 'side-quest', project: process.cwd(), prompt: 'Report.', forkFrom: id.toUpperCase() }));
  assert.equal(result.request.forkFrom, id);
});

for (const [change, reason] of [
  [{ version: 2 }, 'unsupported trigger version'],
  [{ from: null }, 'invalid field: from'],
  [{ from: undefined }, 'missing required field: from'],
  [{ action: 'stop' }, 'incompatible field: action'],
  [{ zzz: 1, aaa: 2 }, 'unknown field: aaa'],
]) test(`typed refusal vocabulary ${reason}`, () => {
  assert.equal(parse(JSON.stringify({ ...request, ...change })).reason, reason);
});
test('duplicate field names and invalid UTF-8 have stable reasons', () => {
  assert.equal(parse(JSON.stringify(request).replace('"version":1', '"version":1,"\\u0076ersion":1')).reason, 'duplicate field: version');
  assert.equal(parse(Buffer.from([0xff])).reason, 'trigger is not valid UTF-8');
});
