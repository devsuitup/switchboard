// test/agents-view-pure.test.js — the decision helpers of the agents view. See .ai/contexts/bg-agents.md.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderSessionIcon } = require('../public/session-state');
global.renderSessionIcon = renderSessionIcon;
const { sortAgentEntries, agentRowIcon, agentVerbAvailability, formatTokens, formatAgentAge, agentsEntryKey } = require('../public/agents-view');

const bg = (over) => ({ id: 'aaaaaaaa', sessionId: 's', kind: 'background', state: 'working', status: 'idle', startedAt: 100, ...over });

test('sort: working and external-interactive first, then newest first, unknown start last', () => {
  const sorted = sortAgentEntries([
    bg({ id: 'd1', state: 'done', startedAt: 500 }),
    bg({ id: 'w1', startedAt: 100 }),
    { kind: 'interactive', sessionId: 'i1', state: null, status: 'busy', startedAt: 300 },
    bg({ id: 'w2', startedAt: null }),
    bg({ id: 'w3', startedAt: 200 }),
  ]);
  assert.deepEqual(sorted.map(e => e.id || e.sessionId), ['i1', 'w3', 'w1', 'w2', 'd1']);
});

test('sort: a blocked job is live and ranks with the working ones', () => {
  const sorted = sortAgentEntries([
    bg({ id: 's1', state: 'stopped', startedAt: 900 }),
    bg({ id: 'b1', state: 'blocked', startedAt: 150 }),
    bg({ id: 'w1', startedAt: 100 }),
    bg({ id: 'd1', state: 'done', startedAt: 800 }),
  ]);
  assert.deepEqual(sorted.map(e => e.id), ['b1', 'w1', 's1', 'd1']);
});

test('row icon: busy spinner, waiting, idle for live rows; stale for finished ones', () => {
  assert.equal(agentRowIcon(bg({ status: 'busy' })).slotClass, 'session-icon--busy');
  assert.equal(agentRowIcon(bg({ status: 'waiting' })).slotClass, 'session-icon--waiting');
  assert.equal(agentRowIcon(bg({ status: 'idle' })).slotClass, 'session-icon--idle');
  assert.equal(agentRowIcon(bg({ state: 'done', status: 'busy' })).slotClass, 'session-icon--stale');
  assert.equal(agentRowIcon(bg({ state: 'stopped', status: 'idle' })).slotClass, 'session-icon--stale');
  assert.equal(agentRowIcon({ kind: 'interactive', status: 'busy' }).slotClass, 'session-icon--busy');
});

test('row icon: a blocked job shows the waiting dot whatever its status', () => {
  assert.equal(agentRowIcon(bg({ state: 'blocked', status: 'idle' })).slotClass, 'session-icon--waiting');
  assert.equal(agentRowIcon(bg({ state: 'blocked', status: null })).slotClass, 'session-icon--waiting');
  assert.equal(agentRowIcon(bg({ state: 'blocked', status: 'busy' })).slotClass, 'session-icon--waiting');
});

test('verb availability follows the state, the kind and the daemon', () => {
  assert.deepEqual(agentVerbAvailability(bg(), true), { transcript: true, attach: true, stop: true, respawn: false, rm: false });
  assert.deepEqual(agentVerbAvailability(bg({ state: 'done' }), true), { transcript: true, attach: false, stop: false, respawn: true, rm: true });
  assert.deepEqual(agentVerbAvailability(bg({ state: 'stopped' }), true), { transcript: true, attach: false, stop: false, respawn: true, rm: true });
  assert.deepEqual(agentVerbAvailability(bg(), false), { transcript: true, attach: false, stop: false, respawn: false, rm: false });
  assert.deepEqual(agentVerbAvailability({ kind: 'interactive', sessionId: 'i' }, true), { transcript: true, attach: false, stop: false, respawn: false, rm: false });
  assert.equal(agentVerbAvailability(bg({ sessionId: null, state: 'done' }), true).transcript, false);
});

test('verb availability: a blocked job is live like a working one', () => {
  assert.deepEqual(agentVerbAvailability(bg({ state: 'blocked' }), true), { transcript: true, attach: true, stop: true, respawn: false, rm: false });
  assert.deepEqual(agentVerbAvailability(bg({ state: 'blocked' }), false), { transcript: true, attach: false, stop: false, respawn: false, rm: false });
});

test('a failed job is finished: sorts after the live rows, stale icon, Delete and Respawn allowed', () => {
  const sorted = sortAgentEntries([bg({ id: 'f1', state: 'failed', startedAt: 900 }), bg({ id: 'w1', startedAt: 100 })]);
  assert.deepEqual(sorted.map(e => e.id), ['w1', 'f1']);
  assert.equal(agentRowIcon(bg({ state: 'failed', status: 'busy' })).slotClass, 'session-icon--stale');
  assert.deepEqual(agentVerbAvailability(bg({ state: 'failed' }), true), { transcript: true, attach: false, stop: false, respawn: true, rm: true });
});

test('formatting helpers', () => {
  assert.equal(formatTokens(null), '');
  assert.equal(formatTokens(274), '274');
  assert.equal(formatTokens(172999), '173k');
  assert.equal(formatTokens(2500000), '2.5M');
  const now = 1_000_000_000;
  assert.equal(formatAgentAge(null, now), '');
  assert.equal(formatAgentAge(now - 30_000, now), '30s');
  assert.equal(formatAgentAge(now - 12 * 60_000, now), '12 min');
  assert.equal(formatAgentAge(now - 3 * 3_600_000, now), '3 h');
  assert.equal(formatAgentAge(now - (2 * 24 + 6) * 3_600_000, now), '2d 6h');
  assert.equal(agentsEntryKey(bg()), 'bg:aaaaaaaa');
  assert.equal(agentsEntryKey({ kind: 'interactive', sessionId: 'x' }), 'int:x');
});
