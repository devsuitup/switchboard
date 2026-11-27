'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createComposerState, noteUserInput, inputPendingReply } = require('../src/main/terminals/composer-state');

test('GIVEN a running session with an empty prompt THEN the reply says nothing is pending', () => {
  assert.deepEqual(inputPendingReply({ exited: false, composerState: createComposerState() }), { ok: true, pending: false });
});

test('GIVEN a running session whose prompt holds typed text THEN the reply says input is pending', () => {
  const composerState = createComposerState();
  noteUserInput(composerState, 'hello', 1);
  assert.deepEqual(inputPendingReply({ exited: false, composerState }), { ok: true, pending: true });
});

test('GIVEN no session, an exited one or one without a prompt model THEN the reply cannot answer', () => {
  assert.deepEqual(inputPendingReply(undefined), { ok: false });
  assert.deepEqual(inputPendingReply({ exited: true, composerState: createComposerState() }), { ok: false });
  assert.deepEqual(inputPendingReply({ exited: false }), { ok: false });
});
