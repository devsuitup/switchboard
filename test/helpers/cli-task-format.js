'use strict';
const assert = require('node:assert/strict');
const { createTaskRegistry } = require('../../public/task-registry');
function assertLaunch(entry, version) {
  const why = `PINNED ASSUMPTION BROKEN: CLI ${version} Agent launch schema`;
  assert.equal(entry.type, 'user', why);
  assert.equal(entry.message.role, 'user', why);
  assert.ok(Number.isFinite(Date.parse(entry.timestamp)), `${why}: timestamp`);
  assert.equal(entry.toolUseResult.isAsync, true, `${why}: isAsync`);
  assert.equal(entry.toolUseResult.status, 'async_launched', `${why}: status`);
  assert.match(entry.toolUseResult.agentId, /^a[0-9a-f]{16}$/, `${why}: agentId`);
  const block = entry.message.content.find(b => b.type === 'tool_result');
  assert.match(block?.tool_use_id || '', /^toolu_\w+$/, `${why}: tool_use_id`);
  assert.ok(block.content.some(b => b.type === 'text' && b.text.startsWith('Async agent launched successfully.')), `${why}: result envelope`);
}

function assertNotification(entry, version) {
  const why = `PINNED ASSUMPTION BROKEN: CLI ${version} terminal task notification schema`;
  assert.ok(Number.isFinite(Date.parse(entry.timestamp)), `${why}: timestamp`);
  const result = createTaskRegistry().notification(entry);
  assert.ok(result, `${why}: wrapper, task-id, tool-use-id, output-file or status`);
  assert.match(result.id, /^[a-z][a-z0-9]+$/, `${why}: task-id`);
  assert.match(result.tool, /^toolu_\w+$/, `${why}: tool-use-id`);
}

function assertChildMeta(meta, version) {
  const why = `PINNED ASSUMPTION BROKEN: CLI ${version} child metadata correlation`;
  assert.match(meta.toolUseId || '', /^toolu_\w+$/, `${why}: toolUseId`);
  assert.equal(typeof meta.agentType, 'string', `${why}: agentType`);
}

module.exports = { assertLaunch, assertNotification, assertChildMeta };
