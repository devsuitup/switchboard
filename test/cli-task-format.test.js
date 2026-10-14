'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertLaunch, assertNotification, assertChildMeta } = require('./helpers/cli-task-format');
const { normalizeTaskEvidence } = require('../task-records');
const fixture = require('./fixtures/cli-tasks-2.1.296.json');

test('mandatory CLI 2.1.296 fixtures pin consumed launch, notification, job and terminal job fields', () => {
  assert.equal(fixture.cliVersion, '2.1.296');
  assertLaunch(fixture.launch, fixture.cliVersion);
  assertNotification(fixture.notification, fixture.cliVersion);
  assertChildMeta(fixture.childMeta, fixture.cliVersion);
  assert.equal(fixture.childMeta.toolUseId, fixture.use.message.content[0].id);
  assert.equal(fixture.use.message.content[0].name, 'Agent');
  assert.equal(fixture.use.message.content[0].id, fixture.launch.message.content[0].tool_use_id);
  assert.equal(normalizeTaskEvidence(fixture.job).valid, true);
  assert.equal(normalizeTaskEvidence(fixture.terminalJob).terminal, true);
});

test('format alarms detect changed ids, timestamps, kinds, wrappers and terminal values', () => {
  for (const mutate of [
    e => { delete e.toolUseResult.agentId; },
    e => { e.toolUseResult.status = 'launched_v2'; },
    e => { e.toolUseResult.isAsync = 'true'; },
    e => { e.timestamp = 'invalid'; },
    e => { delete e.message.content[0].tool_use_id; },
  ]) {
    const e = structuredClone(fixture.launch);
    mutate(e);
    assert.throws(() => assertLaunch(e, fixture.cliVersion), /PINNED ASSUMPTION BROKEN/);
  }
  for (const [before, after] of [['task-notification', 'task-event'], ['<task-id>', '<id>'], ['<tool-use-id>', '<tool-id>'], ['completed', 'finished_v2']]) {
    const e = structuredClone(fixture.notification);
    e.message.content = e.message.content.replaceAll(before, after);
    assert.throws(() => assertNotification(e, fixture.cliVersion), /PINNED ASSUMPTION BROKEN/);
  }
  for (const mutate of [
    e => { e.fan[0].id = null; },
    e => { e.fan[0].kind = 'new_agent_kind'; },
    e => { e.fan[0].startedAt = 'yesterday'; },
    e => { e.fan[0].doneAt = 'tomorrow'; },
    e => { e.updatedAt = 123; },
    e => { e.inFlight.kinds = ['future_kind']; },
    e => { e.state = 'future_state'; },
  ]) {
    const e = structuredClone(fixture.job);
    mutate(e);
    assert.equal(normalizeTaskEvidence(e).valid, false);
  }
});

