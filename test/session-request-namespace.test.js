'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { rig, mutate, sha } = require('./fixtures/session-request-watcher.cjs');
const { createJournal } = require('./fixtures/session-request-journal.cjs');
const openStore = require('./fixtures/conversation-store.cjs');
const { createRequestStore } = require('./fixtures/session-request-store.cjs');
const original = Buffer.from('{"immutable":"owner"}\n');

for (const upperFirst of [false, true]) test(`equal raw action case alias terminates without retries, upperFirst=${upperFirst}`, async t => {
  const lower = 'abcdef01-2345-6789-abcd-0123456789ab';
  const stem = upperFirst ? lower.toUpperCase() : lower;
  const r = await rig(t, { stem, payload: { version: 1, action: 'stop', sessionId: lower } });
  const output = path.join(r.processed, lower + '.result.json'), bytes = fs.readFileSync(output), effects = r.effects();
  const alias = (upperFirst ? lower : lower.toUpperCase()) + '.json';
  fs.writeFileSync(path.join(r.dir, alias), r.body);
  await r.notify(alias);
  assert.equal(fs.existsSync(path.join(r.dir, alias)), false, 'equal raw case alias must be consumed');
  assert.equal(r.errors.length, 0, 'owner replay cannot throw a conflict error');
  assert.equal(r.timers.size, 0, 'owner replay must terminate without retained retry');
  assert.deepEqual(fs.readFileSync(output), bytes); assert.equal(r.effects(), effects);
});

test('ordinary journalled trigger avoids enumerating processed artifacts', async t => {
  const journal = createJournal(), first = await rig(t, { journal, payload: {} });
  let scans = 0;
  const r = await rig(t, { journal, stem: first.stem, payload: {}, fs: {
    readdirSync(file, ...args) { if (path.basename(file) === 'processed') scans++; return fs.readdirSync(file, ...args); },
  } });
  scans = 0;
  fs.writeFileSync(r.input, r.body); await r.notify();
  assert.equal(scans, 0, 'a journalled owner needs no pre-upgrade directory scan');
  assert.equal(fs.existsSync(r.input), false);
});

for (const family of ['session-status', 'legacy', 'action']) for (const incoming of ['legacy', 'action', 'malformed', 'stale', 'oversize']) {
  for (const sameCase of [true, false]) test(`${family} owner blocks ${incoming} incoming, sameCase=${sameCase}`, async t => {
    const stem = 'ABCDEF01-2345-6789-abcd-0123456789ab', journal = createJournal();
    const ownerStem = family === 'action' ? stem.toLowerCase() : stem;
    await mutate(journal, family === 'session-status' ? 'recordConsumedSessionStatusRequest' : 'claimSessionResultNamespace', {
      stemKey: stem, actualStem: ownerStem, family, suppliedHash: 'a'.repeat(64), resultBytes: original,
    });
    const r = await rig(t, { journal, stem: sameCase ? stem : stem.toLowerCase(),
      ...(incoming === 'action' ? { payload: { version: 1, action: 'stop', sessionId: stem } } : {}),
      ...(incoming === 'malformed' ? { raw: Buffer.from('{bad') } : {}),
      ...(incoming === 'oversize' ? { raw: Buffer.alloc(100000, 'x') } : {}), stale: incoming === 'stale',
      setup({ processed }) { fs.writeFileSync(path.join(processed, ownerStem + '.result.json'), original); },
    });
    assert.equal(r.effects(), 0, 'occupied namespace must prevent every lifecycle/PTY/input lookup');
    assert.deepEqual(fs.readFileSync(path.join(r.processed, ownerStem + '.result.json')), original);
    assert.ok(fs.readdirSync(r.processed).includes(ownerStem + '.result.json'), 'physical owner spelling survives Windows case aliases');
    const suffix = '.conflict-' + sha(r.body);
    assert.ok(fs.existsSync(path.join(r.processed, r.stem + suffix + '.result.json')), 'conflict publishes a sidecar');
    assert.deepEqual(fs.readFileSync(path.join(r.processed, r.stem + suffix + '.request')), r.body);
    assert.equal(fs.existsSync(r.input), false);
  });
}

test('failed ownership lookup retains byte-identical input and publishes nothing', async t => {
  const r = await rig(t, { queryError: true });
  assert.equal(r.effects(), 0, 'query errors are not authoritative absence');
  assert.deepEqual(fs.readFileSync(r.input), r.body);
  assert.deepEqual(fs.readdirSync(r.processed), []);
});

test('legacy result replay uses the original spelling and stored bytes even after processed deletion and current age changes', async t => {
  const journal = createJournal();
  const r = await rig(t, { stem: 'LeGaCy', payload: {} , journal });
  const output = path.join(r.processed, 'LeGaCy.result.json');
  assert.ok(fs.readdirSync(r.processed).includes('LeGaCy.result.json'), 'legacy ordinary results must retain physical filename spelling');
  const bytes = fs.readFileSync(output);
  fs.unlinkSync(output);
  fs.writeFileSync(r.input, r.body); fs.utimesSync(r.input, new Date(0), new Date(0));
  await r.notify();
  assert.deepEqual(fs.readFileSync(output), bytes, 'replay cannot recompute a stale refusal');
  assert.deepEqual(fs.readdirSync(r.processed), ['LeGaCy.result.json']);
});

test('pre-upgrade artifacts without request identity cannot authorize overwrite or effects', async t => {
  const r = await rig(t, { setup({ processed }) { fs.writeFileSync(path.join(processed, 'AbCdEf01-2345-6789-abcd-0123456789ab.result.json'), original); } });
  assert.equal(r.effects(), 0);
  assert.deepEqual(fs.readFileSync(path.join(r.processed, r.stem + '.result.json')), original);
  assert.ok(fs.readdirSync(r.processed).some(name => name.endsWith('.request')));
});

test('orphan action recovery cannot publish over a typed owner', async t => {
  const journal = createJournal(), stem = 'abcdef01-2345-6789-abcd-0123456789ab';
  await mutate(journal, 'recordConsumedSessionStatusRequest', { stemKey: stem, actualStem: stem.toUpperCase(), family: 'session-status', suppliedHash: 'a'.repeat(64), resultBytes: original });
  const markerBytes = Buffer.from(JSON.stringify({ version: 1, action: 'stop', sessionId: stem }));
  const r = await rig(t, { journal, stem, orphan: true, setup({ processed }) {
    fs.writeFileSync(path.join(processed, stem.toUpperCase() + '.result.json'), original);
    fs.writeFileSync(path.join(processed, stem + '.action.json'), markerBytes);
  } });
  assert.deepEqual(fs.readFileSync(path.join(r.processed, stem.toUpperCase() + '.result.json')), original);
  assert.deepEqual(fs.readFileSync(path.join(r.processed, stem + '.action.json')), markerBytes);
  assert.equal(r.effects(), 0);
});

test('simultaneous case aliases share one namespace decision before any session effect', async t => {
  const journal = createJournal(), query = journal.querySessionRequestOutcome;
  let release, active = 0, peak = 0;
  const gate = new Promise(resolve => { release = resolve; });
  journal.querySessionRequestOutcome = async input => {
    active++; peak = Math.max(peak, active);
    await gate; active--;
    return query(input);
  };
  const r = await rig(t, { journal });
  const alias = r.stem.toLowerCase() + '.json';
  fs.writeFileSync(path.join(r.dir, alias), r.body);
  await r.notify(alias);
  release(); await r.settle();
  assert.equal(peak, 1, 'case aliases cannot overlap their ordered ownership decision');
  assert.equal(r.effects(), 1, 'the same supplied request can execute only once');
});

test('a failed orphan-marker lookup retains the marker and publishes nothing', async t => {
  const r = await rig(t, { orphan: true, queryError: true, stem: 'abcdef01-2345-6789-abcd-0123456789ab',
    setup({ processed }) { fs.writeFileSync(path.join(processed, 'abcdef01-2345-6789-abcd-0123456789ab.action.json'), '{"version":1,"action":"stop"}'); } });
  assert.equal(r.effects(), 0);
  assert.deepEqual(fs.readdirSync(r.processed), [r.stem + '.action.json']);
});

test('writer-backed publication survives store reopen and processed deletion', {
  skip: !openStore.supported && 'native SQLite ABI differs; node:sqlite requires Node 22',
}, async t => {
  const open = createRequestStore(t), db = open(), journal = createJournal(db);
  const r = await rig(t, { journal, payload: {} });
  const output = path.join(r.processed, r.stem + '.result.json');
  assert.ok(fs.existsSync(output), 'the real journal must acknowledge publication');
  const bytes = fs.readFileSync(output);
  db.closeDb(); const reopened = open();
  const outcome = await createJournal(reopened).querySessionRequestOutcome({ stemKey: r.stem });
  assert.deepEqual(Buffer.from(outcome.owner.resultBytes), bytes);
  fs.unlinkSync(output);
  const next = await rig(t, { journal: createJournal(reopened), stem: r.stem, payload: {}, stale: true });
  assert.deepEqual(fs.readFileSync(path.join(next.processed, next.stem + '.result.json')), bytes);
});

for (const family of ['legacy', 'action']) test(`a pending ${family} owner prevents malformed incoming effects without changing its pending bytes`, async t => {
  const journal = createJournal(), stem = 'abcdef01-2345-6789-abcd-0123456789ab';
  const owner = await mutate(journal, 'claimSessionResultNamespace', { stemKey: stem, actualStem: stem, family,
    suppliedHash: 'a'.repeat(64), rawHash: 'b'.repeat(64) });
  const r = await rig(t, { stem, journal, raw: Buffer.from('{broken') });
  assert.equal(r.effects(), 0);
  assert.deepEqual((await journal.querySessionRequestOutcome({ stemKey: stem })).owner, owner.owner);
  assert.equal(fs.existsSync(path.join(r.processed, stem + '.result.json')), false, 'an unfinished owner has no invented ordinary result');
  assert.ok(fs.readdirSync(r.processed).some(name => name.endsWith('.request')));
});

test('same supplied legacy request replays canonical identity across spelling and JSON key-order aliases', async t => {
  const r = await rig(t);
  const output = path.join(r.processed, r.stem + '.result.json');
  assert.ok(fs.existsSync(output));
  const bytes = fs.readFileSync(output), effects = r.effects();
  fs.unlinkSync(output);
  const alias = r.stem.toLowerCase() + '.json';
  fs.writeFileSync(path.join(r.dir, alias), '{ "command": "hello", "sessionId": "missing" }');
  await r.notify(alias);
  assert.deepEqual(fs.readFileSync(output), bytes);
  assert.equal(r.effects(), effects);
  assert.deepEqual(fs.readdirSync(r.processed), [r.stem + '.result.json']);
});
