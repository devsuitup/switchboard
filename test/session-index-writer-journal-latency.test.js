'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionIndexWriter } = require('../session-index-writer');

const held = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a journal command waiting 200 ms or more for its ACK logs one measurement line; fast and non-journal commands log nothing', async () => {
  const lines = [];
  const client = { ready: Promise.resolve(), async close() {}, async request(name) {
    if (name === 'claimSessionResultNamespace' || name === 'setSetting') await held(450);
    return { state: 'absent' };
  } };
  const writer = createSessionIndexWriter({ client, readonlyBackend: {}, log: { info() {}, warn: line => lines.push(line) } }, {});
  await writer.ready;
  await writer.querySessionRequestOutcome({ stemKey: 'abc' });
  assert.deepEqual(lines, [], 'a journal command answered at once logs nothing');
  await writer.setSetting('slow', true);
  assert.deepEqual(lines, [], 'a slow non-journal command is not a journal wait');
  await writer.claimSessionResultNamespace({ stemKey: 'abc' });
  assert.equal(lines.length, 1, 'exactly one line for the slow claim: ' + JSON.stringify(lines));
  assert.match(lines[0], /^\[session-index-writer\] journal command claimSessionResultNamespace waited \d+ ms$/);
  assert.equal(lines.filter(line => line.includes('querySessionRequestOutcome')).length, 0, 'none for the query');
});
