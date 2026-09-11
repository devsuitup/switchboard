'use strict';

// subagent-attribution.js: the pure function behind issue #247 — attributing
// a subagent transcript write to its parent, whatever the source
// (local-transcript-activity.js, remote-activity.js). See
// .ai/contexts/subagent-observability.md ("Attribution across sources").

const test = require('node:test');
const assert = require('node:assert/strict');

const { subagentParentFromParts, agentIdFromBasename } = require('../subagent-attribution');

test('subagentParentFromParts resolves the preferred layout (<folder>/<parent>/subagents/agent-<id>.jsonl)', () => {
  const result = subagentParentFromParts(['folder-name', 'parent-uuid', 'subagents', 'agent-7.jsonl']);
  assert.deepEqual(result, { parentSessionId: 'parent-uuid', agentId: '7' });
});

test('subagentParentFromParts resolves the legacy layout (<folder>/<parent>/agent-<id>.jsonl)', () => {
  const result = subagentParentFromParts(['folder-name', 'parent-uuid', 'agent-7.jsonl']);
  assert.deepEqual(result, { parentSessionId: 'parent-uuid', agentId: '7' });
});

test('subagentParentFromParts returns null for a top-level transcript', () => {
  assert.equal(subagentParentFromParts(['folder-name', 'some-uuid.jsonl']), null);
});

test('subagentParentFromParts returns null for a non-transcript', () => {
  assert.equal(subagentParentFromParts(['folder-name', 'sessions-index.json']), null);
  assert.equal(subagentParentFromParts(['folder-name', 'parent-uuid', 'subagents', 'sessions-index.json']), null);
});

test('subagentParentFromParts returns null for a bare folder event and for garbage input', () => {
  assert.equal(subagentParentFromParts(['folder-name']), null);
  assert.equal(subagentParentFromParts(null), null);
  assert.equal(subagentParentFromParts(undefined), null);
  assert.equal(subagentParentFromParts([]), null);
});

test('subagentParentFromParts rejects an unrecognized nesting depth (defensive against a future layout)', () => {
  assert.equal(
    subagentParentFromParts(['folder-name', 'parent-uuid', 'subagents', 'nested', 'agent-7.jsonl']),
    null
  );
});

test('agentIdFromBasename requires the agent- prefix and .jsonl extension', () => {
  assert.equal(agentIdFromBasename('agent-7.jsonl'), '7');
  assert.equal(agentIdFromBasename('agent-uuid-with-dashes.jsonl'), 'uuid-with-dashes');
  assert.equal(agentIdFromBasename('not-an-agent.jsonl'), null);
  assert.equal(agentIdFromBasename('agent-7.json'), null);
  assert.equal(agentIdFromBasename(null), null);
});

// Mutation proof (brief requirement): a mutation that drops the parent
// resolution — e.g. attributing to the wrong path segment — must turn tests
// red. Swapping `rest[0]` for `rest[1]` (or the folder itself) as the
// reported parentSessionId is exactly that class of bug; the two layout
// tests above assert the *value*, not just presence, of parentSessionId
// (distinct from folder-name and from agentId), so either swap fails them.
test('mutation proof: parentSessionId must be the parent segment, not the folder or the agentId', () => {
  const result = subagentParentFromParts(['folder-name', 'parent-uuid', 'subagents', 'agent-7.jsonl']);
  assert.notEqual(result.parentSessionId, 'folder-name');
  assert.notEqual(result.parentSessionId, result.agentId);
  assert.equal(result.parentSessionId, 'parent-uuid');
});
