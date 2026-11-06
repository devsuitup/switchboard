'use strict';

process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = '1';
process.env.SWITCHBOARD_SUBMIT_VERIFY_MS = '300';
process.env.SWITCHBOARD_BUSY_FALL_SETTLE_MS = '20';
process.env.SWITCHBOARD_TRIGGER_QUIET_MS = '0';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ID_A, ID_B } = require('./helpers/trigger-world');

const { arrange, ID_C } = require('./helpers/trigger-flow');

const writesOf = events => events.filter(event => event[0] === 'write').map(event => event[2]);

test('an open target receives the prompt once, is re-acknowledged and never spawned', async t => {
  const a = arrange(t);
  a.world.addSession(ID_A);
  const result = await a.submit({ version: 1, action: 'open', sessionId: ID_A, prompt: 'hello there' });
  assert.equal(result.outcome, 'opened');
  assert.equal(result.ok, true);
  assert.equal(result.resumed, false);
  assert.equal(result.sessionId, ID_A);
  assert.equal(result.wrote, true);
  assert.equal(result.steps_total, 1);
  assert.deepEqual(a.spawns, []);
  assert.deepEqual(a.events.filter(event => event[0] === 'ensureOpen'), [['ensureOpen', 'reattach', ID_A, ID_A, 1]]);
  assert.deepEqual(writesOf(a.events), ['hello there', '\r']);
});

test('a closed transcript is resumed once before its prompt, and the flags match the effects', async t => {
  const a = arrange(t);
  const result = await a.submit({ version: 1, action: 'open', sessionId: ID_A.toUpperCase(), prompt: 'wake up' });
  assert.equal(result.outcome, 'opened');
  assert.equal(result.resumed, true);
  assert.equal(result.sessionId, ID_A);
  assert.deepEqual(a.spawns, [ID_A]);
  assert.equal(a.events[0][0], 'ensureOpen');
  assert.equal(a.events[0][1], 'resume');
  assert.deepEqual(writesOf(a.events), ['wake up', '\r']);
  assert.equal(result.wrote, true);
});

test('a resume without prompt writes nothing and reports submitted no', async t => {
  const a = arrange(t);
  const result = await a.submit({ version: 1, action: 'open', sessionId: ID_A });
  assert.equal(result.outcome, 'opened');
  assert.equal(result.resumed, true);
  assert.equal(result.wrote, false);
  assert.equal(result.submitted, 'no');
  assert.equal(result.steps_total, 0);
  assert.deepEqual(writesOf(a.events), []);
});

test('a new session is created under the reserved id, named before the prompt is typed', async t => {
  const a = arrange(t);
  const result = await a.submit({ version: 1, action: 'open', new: { project: '/work/project', name: '  Follow-up  ' }, prompt: 'investigate' });
  assert.equal(result.outcome, 'opened');
  assert.equal(result.created, true);
  assert.equal(result.sessionId, ID_B);
  assert.equal(Object.hasOwn(result, 'resumed'), false);
  assert.deepEqual(a.saved, [[ID_B, 'Follow-up']]);
  const order = a.events.map(event => event[0]);
  assert.ok(order.indexOf('saveName') < order.indexOf('write'));
  assert.deepEqual(writesOf(a.events), ['investigate', '\r']);
});

test('a name that cannot be saved is refused with the created id and the session left open', async t => {
  const a = arrange(t, { deps: { saveName: async () => { throw new Error('disk full'); } } });
  const result = await a.submit({ version: 1, action: 'open', new: { project: '/work/project', name: 'n' }, prompt: 'go' });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'session name could not be saved');
  assert.equal(result.created, true);
  assert.equal(result.sessionId, ID_B);
  assert.deepEqual(writesOf(a.events), []);
  assert.ok(a.world.activeSessions.has(ID_B));
});

test('a backend that cannot open the session is refused with its error and no false created flag', async t => {
  const a = arrange(t, { deps: { bridge: { waitReady: async () => ({ ok: true }), ensureOpen: async () => ({ ok: false, reason: 'session open failed', error: 'spawn failed', preSpawn: true }) } } });
  const result = await a.submit({ version: 1, action: 'open', sessionId: ID_A, prompt: 'x' });
  assert.equal(result.reason, 'session open failed');
  assert.equal(result.error, 'spawn failed');
  assert.equal(result.resumed, false);
  assert.deepEqual(writesOf(a.events), []);
});

test('two requests for one closed id resume once and deliver in order, uppercase and lowercase alike', async t => {
  const a = arrange(t);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  a.hooks.beforeAck = async op => { if (op.mode === 'resume') await held; };
  const first = a.submit({ version: 1, action: 'open', sessionId: ID_A, prompt: 'first' });
  await new Promise(resolve => setTimeout(resolve, 150));
  const second = a.submit({ version: 1, action: 'open', sessionId: ID_A.toUpperCase(), prompt: 'second' });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(a.events.filter(event => event[0] === 'ensureOpen').map(event => event[1]), ['resume'], 'the second waits for the first');
  release();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.resumed, true);
  assert.equal(two.resumed, false);
  assert.deepEqual(a.spawns, [ID_A]);
  assert.deepEqual(writesOf(a.events), ['first', '\r', 'second', '\r']);
  assert.deepEqual(a.events.filter(event => event[0] === 'ensureOpen').map(event => event[1]), ['resume', 'reattach']);
});

test('an unrelated tab is not blocked by a held open of another session', async t => {
  const a = arrange(t);
  a.world.addSession(ID_C);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  a.hooks.beforeAck = async op => { if (op.mode === 'resume') await held; };
  const blocked = a.submit({ version: 1, action: 'open', sessionId: ID_A, prompt: 'slow' });
  const quick = await a.submit({ version: 1, action: 'open', sessionId: ID_C, prompt: 'quick' });
  assert.equal(quick.outcome, 'opened');
  release();
  assert.equal((await blocked).outcome, 'opened');
});

function aliasWorld(t) {
  const a = arrange(t, { world: { resolveSessionId: id => id === ID_A ? ID_B : id } });
  const folder = path.join(a.projectsDir, 'proj');
  fs.writeFileSync(path.join(folder, `${ID_A}.jsonl`), JSON.stringify({ type: 'continued-in', sessionId: ID_A, continuedInSessionId: ID_B }) + '\n');
  fs.writeFileSync(path.join(folder, `${ID_B}.jsonl`), '\n');
  const session = a.world.addSession(ID_B);
  return { ...a, session };
}

test('a historical id resolves to the tab keyed by its successor: RPC carries A, tab key B and its generation, one delivery, zero spawns', async t => {
  const a = aliasWorld(t);
  const result = await a.submit({ version: 1, action: 'open', sessionId: ID_A, prompt: 'via alias' });
  assert.equal(result.outcome, 'opened');
  assert.equal(result.sessionId, ID_A);
  assert.equal(result.resumed, false);
  assert.deepEqual(a.events.filter(event => event[0] === 'ensureOpen'), [['ensureOpen', 'reattach', ID_A, ID_B, 1]]);
  assert.deepEqual(a.events.filter(event => event[0] === 'write'), [['write', ID_B, 'via alias'], ['write', ID_B, '\r']]);
  assert.deepEqual(a.spawns, []);
  assert.equal(a.world.activeSessions.has(ID_A), false);
  a.renderer.clear();
  const again = await a.submit({ version: 1, action: 'open', sessionId: ID_A });
  assert.equal(again.outcome, 'opened');
  assert.deepEqual(a.events.filter(event => event[0] === 'ensureOpen').at(-1), ['ensureOpen', 'reattach', ID_A, ID_B, 1]);
  assert.ok(a.renderer.has(ID_B));
  assert.deepEqual(a.spawns, []);
});

test('replacing the main entry while the acknowledgement is pending delivers nothing and falls back to no spawn', async t => {
  const a = aliasWorld(t);
  a.hooks.beforeAck = async () => { a.world.activeSessions.delete(ID_B); a.world.addSession(ID_B); };
  const result = await a.submit({ version: 1, action: 'open', sessionId: ID_A, prompt: 'late' });
  assert.equal(result.outcome, 'refused');
  assert.match(result.reason, /pinned tab\/PTY generation binding changed|session target changed/);
  assert.deepEqual(writesOf(a.events), []);
  assert.deepEqual(a.spawns, []);
});
