'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInputAttach, noteInputAttach } = require('../src/main/terminals/input-attach');
const { createTriggerContext } = require('../src/main/triggers/trigger-context');
const A = '01234567-89ab-cdef-0123-456789abcdef';
const B = '11234567-89ab-cdef-0123-456789abcdef';

test('bracketed paste on marks the input attached, off clears it', () => {
  const s = createInputAttach();
  noteInputAttach(s, 'banner text', 10);
  assert.equal(s.attachedAt, null);
  noteInputAttach(s, '\x1b[?1049h\x1b[?2004h\x1b[?1004h', 20);
  assert.equal(s.attachedAt, 20);
  noteInputAttach(s, '\x1b[?2004h', 30);
  assert.equal(s.attachedAt, 20, 'a reassert keeps the first attach');
  noteInputAttach(s, '\x1b[?2004l', 40);
  assert.equal(s.attachedAt, null);
  noteInputAttach(s, '\x1b[?2004l\x1b[?2004h', 50);
  assert.equal(s.attachedAt, 50, 'the last edge of a chunk wins');
});

test('a marker split across two chunks is still seen', () => {
  const s = createInputAttach();
  noteInputAttach(s, 'abc\x1b[?20', 10);
  assert.equal(s.attachedAt, null);
  noteInputAttach(s, '04h', 11);
  assert.equal(s.attachedAt, 11);
});

test('the trigger context reads the attach state, undefined when the PTY is not tracked', () => {
  const tracked = { pty: { pid: 1 }, inputAttach: createInputAttach() };
  const untracked = { pty: { pid: 2 } };
  const activeSessions = new Map([[A, tracked], [B, untracked]]);
  const ctx = createTriggerContext({ activeSessions, log: { info() {}, warn() {}, error() {}, debug() {} } });
  assert.equal(ctx.getInputAttachedAt(A), null);
  noteInputAttach(tracked.inputAttach, '\x1b[?2004h', 77);
  assert.equal(ctx.getInputAttachedAt(A), 77);
  assert.equal(ctx.getInputAttachedAt(B), undefined);
});
