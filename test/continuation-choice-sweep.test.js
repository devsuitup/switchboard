'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { extractFunction } = require('./app-source');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

function fixture(complete) {
  const settings = new Map([
    ['continuationChoice:live', {}], ['continuationChoice:gone', {}], ['continuationChoice:sub', {}],
    ['global', { sentinel: true }], ['project:gone', {}], ['continuationChoiceOther:gone', {}],
  ]);
  const listed = [], deleted = [];
  const context = vm.createContext({
    isInitialScanComplete: () => complete,
    getAllCached: () => [{ sessionId: 'live', parentSessionId: null }, { sessionId: 'sub', parentSessionId: 'live' }],
    listSettingKeys: prefix => { listed.push(prefix); return [...settings.keys()].filter(key => key.startsWith(prefix)); },
    deleteSetting: async key => { await Promise.resolve(); deleted.push(key); settings.delete(key); },
  });
  vm.runInContext(extractFunction(source, 'sweepContinuationChoices'), context);
  return { settings, listed, deleted, context };
}

test('S5 a completed-scan sweep deletes gone and subagent choices, retaining top-level and unrelated settings', async () => {
  const f = fixture(true);
  await f.context.sweepContinuationChoices();
  assert.deepEqual(f.deleted.sort(), ['continuationChoice:gone', 'continuationChoice:sub']);
  assert.deepEqual(f.listed, ['continuationChoice:']);
  assert.deepEqual([...f.settings.keys()].sort(), ['continuationChoice:live', 'continuationChoiceOther:gone', 'global', 'project:gone']);
});

test('S6 an incomplete initial scan leaves every choice and unrelated setting untouched', async () => {
  const f = fixture(false);
  await f.context.sweepContinuationChoices();
  assert.deepEqual(f.deleted, []);
  assert.deepEqual(f.listed, []);
  assert.equal(f.settings.size, 6);
});

test('the startup population runs the sweep only after the scan promise settles', async () => {
  const f = fixture(true);
  let done;
  f.context.populateCacheViaWorker = () => new Promise(resolve => { done = resolve; });
  f.context.log = { warn: assert.fail, error: assert.fail };
  const marker = source.indexOf('// Full cache rebuild on every startup');
  const start = source.indexOf('populateCacheViaWorker();', marker);
  const statement = source.slice(marker).match(/\n\s*(populateCacheViaWorker\(\)(?:\.[\s\S]*?)?;)/)?.[1];
  assert.ok(statement, 'startup must run population');
  assert.ok(start === -1 || statement.includes('sweepContinuationChoices'), 'startup must attach the sweep to population');
  const pending = vm.runInContext(statement, f.context);
  assert.equal(f.settings.has('continuationChoice:gone'), true);
  done();
  await pending;
  assert.equal(f.settings.has('continuationChoice:gone'), false);
});
