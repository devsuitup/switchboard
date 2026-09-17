// cwd resolution for the panel shell — see .ai/contexts/panel-terminal.md.
// The renderer never holds a session's absolute path: open-terminal resolves
// it from the owning session id, reusing the Changes panel's resolver.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePanelTerminalCwd, REMOTE_REFUSAL } = require('../panel-terminal-target');

test('a local session resolves to its own working directory (worktree included)', () => {
  const calls = [];
  const result = resolvePanelTerminalCwd('abc-123', (id) => {
    calls.push(id);
    return { ok: true, kind: 'local', cwd: '/repo/.worktrees/feature' };
  });
  assert.deepEqual(result, { ok: true, cwd: '/repo/.worktrees/feature' });
  assert.deepEqual(calls, ['abc-123'], 'the owner session id is what gets resolved');
});

test('a remote session is refused with a stated reason', () => {
  const result = resolvePanelTerminalCwd('abc-123', () => ({ ok: true, kind: 'remote', alias: 'box', cwd: '/srv/app' }));
  assert.deepEqual(result, { ok: false, error: REMOTE_REFUSAL });
});

test('a resolver failure is passed through verbatim', () => {
  const result = resolvePanelTerminalCwd('abc-123', () => ({ ok: false, error: 'invalid session id' }));
  assert.deepEqual(result, { ok: false, error: 'invalid session id' });
});

test('a missing resolver result still fails closed', () => {
  assert.equal(resolvePanelTerminalCwd('abc-123', () => undefined).ok, false);
  assert.equal(resolvePanelTerminalCwd('abc-123', () => ({ ok: true, kind: 'local', cwd: '' })).ok, false);
});

test('an empty or non-string owner id is refused before the resolver runs', () => {
  let called = 0;
  const resolver = () => { called++; return { ok: true, kind: 'local', cwd: '/x' }; };
  for (const id of ['', null, undefined, 42]) {
    assert.equal(resolvePanelTerminalCwd(id, resolver).ok, false);
  }
  assert.equal(called, 0);
});
