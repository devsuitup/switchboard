// test/agents-view-pure.test.js — the decision helpers of the agents view. See .ai/contexts/bg-agents.md.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderSessionIcon } = require('../public/session-state');
global.renderSessionIcon = renderSessionIcon;
const { sortAgentEntries, agentRowIcon, agentVerbAvailability, formatTokens, formatAgentAge, agentsEntryKey, groupAgentEntries, normalizeAgentsGroupBy, AGENT_STATE_META, agentStateMeta,
  agentsCollapseKey, parseCollapsedGroups, serializeCollapsedGroups, AGENTS_COLLAPSE_MAX } = require('../public/agents-view');

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

const ext = (over) => ({ id: null, sessionId: 'i', kind: 'interactive', state: null, status: 'busy', startedAt: 100, ...over });
const ids = (groups) => groups.map(g => [g.label, g.entries.map(e => e.id || e.sessionId)]);

test('group mode: none, state and project are kept; anything else (unset included) is state', () => {
  assert.equal(normalizeAgentsGroupBy('state'), 'state');
  assert.equal(normalizeAgentsGroupBy('project'), 'project');
  assert.equal(normalizeAgentsGroupBy('none'), 'none');
  assert.equal(normalizeAgentsGroupBy('bogus'), 'state');
  assert.equal(normalizeAgentsGroupBy(null), 'state');
  assert.equal(normalizeAgentsGroupBy(undefined), 'state');
});

test('state meta: one emoji and label per state group, in the group order', () => {
  assert.deepEqual(Object.entries(AGENT_STATE_META).map(([k, m]) => [k, m.emoji, m.label]), [
    ['working', '⚙️', 'Working'], ['blocked', '✋', 'Blocked'], ['done', '✅', 'Done'], ['stopped', '⏹️', 'Stopped'],
    ['failed', '❌', 'Failed'], ['external', '🖥️', 'External'], ['unknown', '❓', 'Unknown'],
  ]);
  const every = Object.keys(AGENT_STATE_META).map((k) => (k === 'external' ? ext({ sessionId: k }) : bg({ id: k, state: k === 'unknown' ? null : k })));
  for (const g of groupAgentEntries(every, 'state')) {
    assert.ok(AGENT_STATE_META[g.key], `meta for ${g.key}`);
    assert.equal(g.label, AGENT_STATE_META[g.key].label);
  }
  assert.equal(groupAgentEntries(every, 'state').length, 7);
});

test('state meta lookup: by state, null or unlisted is unknown, interactive is external', () => {
  assert.equal(agentStateMeta(bg()).emoji, '⚙️');
  assert.equal(agentStateMeta(bg({ state: 'failed' })).emoji, '❌');
  assert.equal(agentStateMeta(bg({ state: null })).emoji, '❓');
  assert.equal(agentStateMeta(bg({ state: 'weird' })).label, 'Unknown');
  assert.equal(agentStateMeta(ext({ state: 'working' })).emoji, '🖥️');
  assert.equal(agentStateMeta(ext()).key, 'external');
});

test('group none: one unlabelled group holding every entry in order', () => {
  const entries = [bg({ id: 'w1' }), bg({ id: 'd1', state: 'done' })];
  const groups = groupAgentEntries(entries, 'none');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, '');
  assert.deepEqual(groups[0].entries.map(e => e.id), ['w1', 'd1']);
  assert.deepEqual(groupAgentEntries([], 'none'), []);
  assert.deepEqual(groupAgentEntries([], 'state'), []);
  assert.deepEqual(groupAgentEntries([], 'project'), []);
});

test('group by state: fixed order, external and unknown last, empty groups dropped, entry order kept', () => {
  const groups = groupAgentEntries([
    ext({ sessionId: 'i1' }),
    bg({ id: 'f1', state: 'failed' }),
    bg({ id: 'w1' }),
    bg({ id: 'u1', state: null }),
    bg({ id: 'd1', state: 'done' }),
    bg({ id: 'w2' }),
    bg({ id: 'b1', state: 'blocked' }),
    bg({ id: 's1', state: 'stopped' }),
  ], 'state');
  assert.deepEqual(ids(groups), [
    ['Working', ['w1', 'w2']], ['Blocked', ['b1']], ['Done', ['d1']], ['Stopped', ['s1']],
    ['Failed', ['f1']], ['External', ['i1']], ['Unknown', ['u1']],
  ]);
  assert.deepEqual(groups.map(g => g.key), ['working', 'blocked', 'done', 'stopped', 'failed', 'external', 'unknown']);
  assert.deepEqual(ids(groupAgentEntries([bg({ id: 'd1', state: 'done' })], 'state')), [['Done', ['d1']]]);
});

test('group by project: last path segment, full path as title, live groups first then alphabetical, no project last', () => {
  const groups = groupAgentEntries([
    bg({ id: 'd1', state: 'done', cwd: '/w/alpha' }),
    bg({ id: 'w1', cwd: '/w/zeta' }),
    bg({ id: 'd2', state: 'done', cwd: '/w/Beta/' }),
    bg({ id: 'n1', state: 'done', cwd: null }),
    bg({ id: 'd3', state: 'done', cwd: '/w/alpha' }),
    ext({ sessionId: 'i1', cwd: '/w/mid' }),
  ], 'project');
  assert.deepEqual(ids(groups), [
    ['mid', ['i1']], ['zeta', ['w1']], ['alpha', ['d1', 'd3']], ['Beta', ['d2']], ['No project', ['n1']],
  ]);
  assert.equal(groups[2].title, '/w/alpha');
  assert.equal(groups[2].key, '/w/alpha');
  assert.equal(groups[4].title, '');
});

test('group by project: two cwds with the same last segment stay separate, labelled with their parent', () => {
  const groups = groupAgentEntries([
    bg({ id: 'a', state: 'done', cwd: '/home/x/app' }),
    bg({ id: 'b', state: 'done', cwd: '/srv/y/app' }),
    bg({ id: 'c', state: 'done', cwd: 'C:\\code\\z\\app' }),
    bg({ id: 'd', state: 'done', cwd: '/other' }),
  ], 'project');
  assert.deepEqual(ids(groups), [['app (x)', ['a']], ['app (y)', ['b']], ['app (z)', ['c']], ['other', ['d']]]);
});

test('group by project: same last segment and same parent fall back to the full path', () => {
  const groups = groupAgentEntries([
    bg({ id: 'a', state: 'done', cwd: '/a/p/app' }),
    bg({ id: 'b', state: 'done', cwd: '/b/p/app' }),
  ], 'project');
  assert.deepEqual(ids(groups), [['/a/p/app', ['a']], ['/b/p/app', ['b']]]);
});

test('group by project: keyed by projectRoot, so the worktrees of one git project share a group; unrelated repos stay apart', () => {
  const groups = groupAgentEntries([
    bg({ id: 'a', state: 'done', cwd: '/w/app', projectRoot: '/w/app', worktreeRoot: '/w/app' }),
    bg({ id: 'b', state: 'done', cwd: '/w/app/.claude/worktrees/x', projectRoot: '/w/app', worktreeRoot: '/w/app/.claude/worktrees/x' }),
    bg({ id: 'c', state: 'done', cwd: '/elsewhere/wt-y/src', projectRoot: '/w/app', worktreeRoot: '/elsewhere/wt-y' }),
    bg({ id: 'd', state: 'done', cwd: '/w/other', projectRoot: '/w/other', worktreeRoot: '/w/other' }),
    bg({ id: 'e', state: 'done', cwd: '/w/legacy' }),
    bg({ id: 'n', state: 'done', cwd: null, projectRoot: null }),
  ], 'project');
  assert.deepEqual(ids(groups), [['app', ['a', 'b', 'c']], ['legacy', ['e']], ['other', ['d']], ['No project', ['n']]]);
  assert.equal(groups[0].key, '/w/app');
  assert.equal(groups[0].title, '/w/app');
  assert.equal(groups[0].children, undefined, 'no sub-groups without the option');
});

const wt = (id, worktreeRoot, over) => bg({ id, state: 'done', cwd: worktreeRoot, projectRoot: '/w/app', worktreeRoot, ...over });
const sub = (groups) => groups.map(g => [g.label, g.entries.length, g.children ? g.children.map(c => [c.label, c.entries.map(e => e.id)]) : null]);

test('worktree sub-groups: one per worktree, main first, live first, then alphabetical; the project keeps its total', () => {
  const groups = groupAgentEntries([
    wt('z1', '/w/app/.claude/worktrees/zeta'),
    wt('m1', '/w/app', { cwd: '/w/app/src' }),
    wt('a1', '/w/app/.claude/worktrees/alpha', { cwd: '/w/app/.claude/worktrees/alpha/deep/er' }),
    wt('l1', '/w/app/.claude/worktrees/live', { state: 'working' }),
    wt('m2', '/w/app'),
    wt('a2', '/w/app/.claude/worktrees/alpha'),
  ], 'project', { worktrees: true });
  assert.deepEqual(sub(groups), [['app', 6, [['live', ['l1']], ['main', ['m1', 'm2']], ['alpha', ['a1', 'a2']], ['zeta', ['z1']]]]]);
  const kids = groups[0].children;
  assert.equal(kids[1].key, '/w/app');
  assert.equal(kids[1].title, '/w/app');
  assert.equal(kids[2].title, '/w/app/.claude/worktrees/alpha');
});

test('worktree sub-groups: a project in a single worktree stays flat, even a linked one', () => {
  const groups = groupAgentEntries([
    wt('a', '/w/app/.claude/worktrees/x'),
    wt('b', '/w/app/.claude/worktrees/x', { cwd: '/w/app/.claude/worktrees/x/sub' }),
    bg({ id: 'o', state: 'done', cwd: '/w/other', projectRoot: '/w/other', worktreeRoot: '/w/other' }),
  ], 'project', { worktrees: true });
  assert.deepEqual(sub(groups), [['app', 2, null], ['other', 1, null]]);
});

test('worktree sub-groups: equal directory names in one project are told apart by their parent, then the full path', () => {
  const groups = groupAgentEntries([
    wt('a', '/x/one/feat'),
    wt('b', '/y/two/feat'),
    wt('c', '/p/q/same'),
    wt('d', '/r/q/same'),
  ], 'project', { worktrees: true });
  assert.deepEqual(sub(groups)[0][2], [['/p/q/same', ['c']], ['/r/q/same', ['d']], ['feat (one)', ['a']], ['feat (two)', ['b']]]);
});

test('worktree option is ignored outside project mode', () => {
  const entries = [wt('a', '/w/app'), wt('b', '/w/app/.claude/worktrees/x')];
  assert.ok(groupAgentEntries(entries, 'state', { worktrees: true }).every(g => !g.children));
  assert.ok(groupAgentEntries(entries, 'none', { worktrees: true }).every(g => !g.children));
});

test('collapse keys are scoped by mode and level', () => {
  assert.equal(agentsCollapseKey('state', { key: 'working' }), 'state:working');
  assert.equal(agentsCollapseKey('project', { key: '/w/app' }), 'project:/w/app');
  assert.equal(agentsCollapseKey('project', { key: '' }), 'project:');
  assert.equal(agentsCollapseKey('worktree', { key: '/w/app/.claude/worktrees/x' }, '/w/app'), 'worktree:/w/app|/w/app/.claude/worktrees/x');
  assert.notEqual(agentsCollapseKey('state', { key: 'x' }), agentsCollapseKey('project', { key: 'x' }));
});

test('stored collapsed groups: a JSON array of strings, anything else is empty, capped to the newest', () => {
  assert.deepEqual(parseCollapsedGroups('["state:done","project:/a"]'), ['state:done', 'project:/a']);
  assert.deepEqual(parseCollapsedGroups(null), []);
  assert.deepEqual(parseCollapsedGroups(''), []);
  assert.deepEqual(parseCollapsedGroups('{not json'), []);
  assert.deepEqual(parseCollapsedGroups('{"a":1}'), []);
  assert.deepEqual(parseCollapsedGroups('"state:done"'), []);
  assert.deepEqual(parseCollapsedGroups('["a", 3, null, "a", "b"]'), ['a', 'b']);
  const many = Array.from({ length: AGENTS_COLLAPSE_MAX + 5 }, (_, i) => 'k' + i);
  const parsed = parseCollapsedGroups(JSON.stringify(many));
  assert.equal(parsed.length, AGENTS_COLLAPSE_MAX);
  assert.equal(parsed[0], 'k5');
  assert.equal(parsed[parsed.length - 1], 'k' + (AGENTS_COLLAPSE_MAX + 4));
  const out = JSON.parse(serializeCollapsedGroups(many));
  assert.equal(out.length, AGENTS_COLLAPSE_MAX);
  assert.equal(out[0], 'k5');
  assert.deepEqual(JSON.parse(serializeCollapsedGroups(new Set(['x', 'y']))), ['x', 'y']);
  assert.ok(AGENTS_COLLAPSE_MAX >= 100 && AGENTS_COLLAPSE_MAX <= 500);
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
