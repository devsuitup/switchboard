'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bg = require('../src/main/schedules/schedule-background');
const runner = require('../src/main/schedules/schedule-runner');
const results = require('../src/main/schedules/schedule-run-results');

const JOB = 'a1234567';
const ACTUAL = JOB + '-1234-4123-8123-123456789abc';
const SEED = 'b1234567-1234-4123-8123-123456789abc';
const JOB_B = 'c1234567';
const ACTUAL_B = JOB_B + '-1234-4123-8123-123456789abc';
const immediate = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-bg-recovery-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'project');
  const jobsDir = path.join(home, 'jobs');
  const recordsDir = path.join(home, 'records');
  const filePath = path.join(cwd, '.claude', 'commands', 'schedule-daily.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.mkdirSync(recordsDir);
  fs.writeFileSync(filePath, '---\nname: daily\ncron: * * * * *\nslug: daily\ncatch-up: true\nrun-as-background: true\n---\nDo work\n');
  const seedPath = path.join(home, SEED + '.jsonl');
  fs.writeFileSync(seedPath, JSON.stringify({ type: 'user', sessionId: SEED, message: { content: 'Scheduled Task: do work' }, scheduleSlug: 'daily' }) + '\n');
  const calls = [], written = [], lines = [];
  const log = { info: (...s) => lines.push(s.join(' ')), warn: (...s) => lines.push(s.join(' ')), error: (...s) => lines.push(s.join(' ')) };
  const state = (jobId, extra) => {
    fs.mkdirSync(path.join(jobsDir, jobId), { recursive: true });
    fs.writeFileSync(path.join(jobsDir, jobId, 'state.json'), JSON.stringify({
      sessionId: jobId === JOB ? ACTUAL : ACTUAL_B, name: 'daily', cwd, state: 'done', lastTerminalAt: Date.now(), ...extra }));
  };
  const record = (jobId = JOB, extra = {}) => {
    const startedAtMs = Date.now() - 120000;
    const run = { v: 1, jobId, actualId: jobId === JOB ? ACTUAL : ACTUAL_B, sessionId: SEED, cwd, name: 'daily', slug: 'daily', filePath,
      startedAtMs, deadline: startedAtMs + 3600000, ...extra };
    fs.writeFileSync(path.join(recordsDir, jobId + '.json'), JSON.stringify(run));
    return path.join(recordsDir, jobId + '.json');
  };
  const deps = { homeDir: home, jobsDir, recordsDir, log, pollMs: 1, retryMs: 1, wait: () => immediate(),
    runCommand: async args => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; },
    writeResult: value => { written.push(value); return true; }, isJoined: () => false };
  return { home, cwd, jobsDir, recordsDir, filePath, seedPath, calls, written, lines, log, state, record, deps };
}

const saved = file => JSON.parse(fs.readFileSync(file, 'utf8'));

for (const [label, prepare] of [
  ['an unrelated same-name job created in the same cwd during the call', h => h.state(JOB, { state: 'working', createdAt: Date.now() + 1 })],
  ['a same-name job whose state has no cwd', h => h.state(JOB, { state: 'working', cwd: undefined, createdAt: Date.now() + 1 })],
  ['a single matching job behind more than 200 other jobs', h => {
    for (let i = 0; i < 201; i++) h.state((0x10000000 + i).toString(16), { name: 'other', sessionId: undefined });
    h.state('ffffffff', { state: 'working', createdAt: Date.now() + 1, sessionId: undefined });
  }],
]) test(`a launch without a job id stops and removes nothing: ${label}`, async t => {
  const h = fixture(t);
  const deps = { ...h.deps, runCommand: async args => {
    h.calls.push(args);
    if (args[0] === '--bg') { prepare(h); return { code: 1, stdout: '', stderr: 'Launcher failed before creating a job' }; }
    return { code: 0 };
  } };
  const result = await bg.launchBackgroundSchedule({ argv: runner.buildScheduleCommand(SEED, {}).claudeArgs,
    cwd: h.cwd, name: 'daily', filePath: h.filePath, slug: 'daily', seedPath: h.seedPath }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'spawn-error');
  assert.match(result.error, /Launcher failed/);
  assert.deepEqual(h.calls.slice(1), [], 'no stop or rm without a job id from the launcher');
  assert.match(h.written.at(-1).cleanup, /^unresolved launch: no job id in the output of claude --bg; no job was stopped or removed$/);
  assert.match(h.lines.join('\n'), /unresolved launch/);
  assert.deepEqual(fs.readdirSync(h.recordsDir), [], 'nothing is left to resume');
});

function withCatchUp(t) {
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  delete process.env.SWITCHBOARD_DATA_DIR;
  t.after(() => { if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR; else process.env.SWITCHBOARD_DATA_DIR = previous; });
}

function delayedResume(deps, turns) {
  return claim => {
    let inner;
    let delay = Promise.resolve();
    for (let i = 0; i < turns; i++) delay = delay.then(immediate);
    const discovered = delay.then(() => (inner = bg.resumeBackgroundRuns(deps, claim)).discovered);
    const lifetimes = discovered.then(() => inner);
    lifetimes.discovered = discovered;
    return lifetimes;
  };
}

test('startup catch-up waits for the delayed discovery of a persisted run, with an async project lookup', async t => {
  withCatchUp(t);
  const h = fixture(t);
  h.record(); h.state(JOB, { state: 'working' });
  const launches = [];
  let resumed;
  const resume = delayedResume(h.deps, 5);
  const stop = runner.startScheduler(h.log, (...args) => { launches.push(args); args[3](); return { ok: true }; }, {
    stateDir: path.join(h.home, 'catch-up'),
    projects: async () => { await immediate(); return [h.cwd]; },
    resumeBackgroundRuns: claim => (resumed = resume(claim)),
  });
  t.after(stop);
  assert.equal(await resumed.discovered, 1);
  for (let i = 0; i < 10; i++) await immediate();
  assert.equal(launches.length, 0, 'the catch-up must see the resumed run as in flight');
  assert.match(h.lines.join('\n'), /Skipping daily — still running/);
  h.state(JOB);
  const [details] = await resumed;
  assert.equal(details.outcome, 'exited');
});

test('a minute tick during a slow discovery waits for it, and resumed runs sharing a slug are counted', async t => {
  const h = fixture(t);
  const startMs = Math.floor(Date.now() / 60000) * 60000 + 59000;
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: startMs });
  h.record(JOB, { startedAtMs: startMs - 60000, deadline: startMs + 3600000 });
  h.record(JOB_B, { startedAtMs: startMs - 60000, deadline: startMs + 3600000 });
  h.state(JOB, { state: 'working' }); h.state(JOB_B, { state: 'working' });
  const launches = [];
  let resumed;
  const resume = delayedResume(h.deps, 5);
  const stop = runner.startScheduler(h.log, (...args) => { launches.push(args); args[3](); return { ok: true }; }, {
    projects: async () => [h.cwd], resumeBackgroundRuns: claim => (resumed = resume(claim)),
  });
  t.after(stop);
  t.mock.timers.tick(1000);
  assert.equal(await resumed.discovered, 2);
  for (let i = 0; i < 10; i++) await immediate();
  assert.equal(launches.length, 0, 'the tick fired during discovery must not launch beside the resumed runs');
  h.state(JOB, { lastTerminalAt: startMs + 1 });
  for (let i = 0; i < 50 && !h.written.length; i++) await immediate();
  assert.equal(h.written.length, 1, 'the first resumed run ended');
  t.mock.timers.tick(60000);
  for (let i = 0; i < 10; i++) await immediate();
  assert.equal(launches.length, 0, 'the second resumed run still holds the schedule');
  h.state(JOB_B, { lastTerminalAt: startMs + 1 });
  await resumed;
  t.mock.timers.tick(60000);
  for (let i = 0; i < 10; i++) await immediate();
  assert.equal(launches.length, 1, 'the schedule runs once both resumed runs ended');
});

test('a scheduler does not wait on discovery beyond its bound', async t => {
  const h = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Math.floor(Date.now() / 60000) * 60000 + 1000 });
  const launches = [];
  const never = new Promise(() => {});
  const pending = never.then(() => []);
  pending.discovered = never;
  const stop = runner.startScheduler(h.log, (...args) => { launches.push(args); args[3](); return { ok: true }; }, {
    projects: async () => [h.cwd], resumeBackgroundRuns: () => pending,
  });
  t.after(stop);
  t.mock.timers.tick(10000);
  await immediate();
  assert.match(h.lines.join('\n'), /not read after 10 s/);
  t.mock.timers.tick(50000);
  for (let i = 0; i < 10; i++) await immediate();
  assert.equal(launches.length, 1, 'the minute tick runs once the bound passed');
});

test('a failing stop keeps a cleanup record with the run outcome, and the next start cleans up without watching again', async t => {
  const h = fixture(t);
  const file = h.record(); h.state(JOB);
  let stopWorks = false;
  const deps = { ...h.deps, runCommand: async args => {
    h.calls.push(args);
    return args[0] === 'stop' && !stopWorks ? { code: 1, stderr: 'daemon temporarily unavailable' } : { code: 0 };
  } };
  const [first] = await bg.resumeBackgroundRuns(deps);
  assert.equal(first.outcome, 'exited');
  assert.equal(first.cleanupPending, true);
  assert.match(first.cleanup, /stop failed: daemon temporarily unavailable/);
  assert.equal(h.calls.filter(c => c[0] === 'stop').length, 3, 'bounded retries in this process');
  assert.equal(h.written.length, 0, 'the result waits for the cleanup');
  const pending = saved(file);
  assert.equal(pending.phase, 'cleanup');
  assert.equal(pending.cleanupAttempts, 3);
  assert.deepEqual(pending.result, { outcome: 'exited', code: 0 });
  h.state(JOB, { state: 'working', lastTerminalAt: 0 });
  h.calls.length = 0; stopWorks = true;
  const [second] = await bg.resumeBackgroundRuns(deps);
  assert.equal(second.outcome, 'exited', 'the finished turn keeps its outcome; it is not watched or run again');
  assert.deepEqual(h.calls, [['stop', JOB], ['rm', JOB]]);
  assert.equal(h.written.length, 1);
  assert.equal(h.written[0].cleanup, 'stopped and removed');
  assert.equal(fs.existsSync(file), false);
});

test('a stop that fails once then succeeds settles in the same start', async t => {
  const h = fixture(t);
  const file = h.record(); h.state(JOB);
  let stops = 0;
  const [details] = await bg.resumeBackgroundRuns({ ...h.deps, runCommand: async args => {
    h.calls.push(args);
    if (args[0] === 'stop' && stops++ === 0) throw new Error('timed out');
    return { code: 0 };
  } });
  assert.equal(details.cleanup, 'stopped and removed');
  assert.equal(fs.existsSync(file), false);
  assert.equal(h.written.length, 1);
});

test('after a stop succeeded but rm failed, the next start only removes', async t => {
  const h = fixture(t);
  const file = h.record(); h.state(JOB);
  let rmWorks = false;
  const deps = { ...h.deps, runCommand: async args => {
    h.calls.push(args);
    return args[0] === 'rm' && !rmWorks ? { code: 1, stderr: 'busy' } : { code: 0 };
  } };
  await bg.resumeBackgroundRuns(deps);
  assert.equal(saved(file).cleanupMode, 'rm');
  h.calls.length = 0; rmWorks = true;
  await bg.resumeBackgroundRuns(deps);
  assert.deepEqual(h.calls, [['rm', JOB]]);
  assert.equal(fs.existsSync(file), false);
});

test('cleanup retries are bounded across starts, then the run is recorded as abandoned', async t => {
  const h = fixture(t);
  const file = h.record(JOB, { phase: 'cleanup', cleanupMode: 'stop', cleanupAttempts: 8, result: { outcome: 'timed-out', error: 'late' } });
  h.state(JOB, { state: 'working' });
  const [details] = await bg.resumeBackgroundRuns({ ...h.deps, runCommand: async args => { h.calls.push(args); return { code: 1, stderr: 'down' }; } });
  assert.equal(h.calls.length, 1);
  assert.equal(details.outcome, 'timed-out');
  assert.match(details.cleanup, /^cleanup abandoned after 9 attempts: stop failed: down$/);
  assert.equal(h.written[0].cleanup, details.cleanup);
  assert.equal(fs.existsSync(file), false);
});

test('a cleanup handed to a joined user retires the record', async t => {
  const h = fixture(t);
  const file = h.record(JOB, { phase: 'cleanup', cleanupMode: 'stop', result: { outcome: 'exited', code: 0 } });
  h.state(JOB);
  const [details] = await bg.resumeBackgroundRuns({ ...h.deps, isJoined: () => true });
  assert.equal(details.cleanup, 'left running, joined');
  assert.deepEqual(h.calls, []);
  assert.equal(fs.existsSync(file), false);
});

test('a failed result publication keeps a result record, and the next start publishes it without cleaning again', async t => {
  const h = fixture(t);
  const file = h.record(); h.state(JOB);
  const runsDir = path.join(h.home, 'results');
  fs.writeFileSync(runsDir, 'a file where the results directory goes');
  const write = value => results.writeScheduleRunResult(runsDir, value, h.log);
  const [first] = await bg.resumeBackgroundRuns({ ...h.deps, writeResult: write });
  assert.equal(first.resultPending, true);
  assert.match(h.lines.join('\n'), /Cannot record result/);
  const pending = saved(file);
  assert.equal(pending.phase, 'result');
  assert.equal(pending.cleanup, 'stopped and removed');
  assert.deepEqual(h.calls, [['stop', JOB], ['rm', JOB]]);
  fs.unlinkSync(runsDir);
  h.calls.length = 0;
  const [second] = await bg.resumeBackgroundRuns({ ...h.deps, writeResult: write });
  assert.equal(second.resultPending, undefined);
  assert.deepEqual(h.calls, [], 'no second stop or rm');
  assert.equal(fs.existsSync(file), false);
  const listed = fs.readdirSync(runsDir).filter(name => name.endsWith('.json'));
  assert.equal(listed.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runsDir, listed[0]), 'utf8')).cleanup, 'stopped and removed');
  assert.deepEqual(await bg.resumeBackgroundRuns({ ...h.deps, writeResult: write }), []);
});

test('the result writer acknowledges a write, an existing result and reports a failure', t => {
  const h = fixture(t);
  const runsDir = path.join(h.home, 'ack');
  const input = { sessionId: ACTUAL, filePath: h.filePath, name: 'daily', slug: 'daily', startedAtMs: Date.now(), outcome: 'exited', code: 0 };
  assert.equal(results.writeScheduleRunResult(runsDir, input, h.log), true);
  assert.equal(results.writeScheduleRunResult(runsDir, input, h.log), true, 'already published is acknowledged');
  const blocked = path.join(h.home, 'blocked');
  fs.writeFileSync(blocked, '');
  assert.equal(results.writeScheduleRunResult(blocked, input, h.log), false);
});

for (const [label, extra] of [
  ['an actual id that is not a full UUID', { actualId: JOB + '-not-a-uuid' }],
  ['an actual id of another job', { actualId: ACTUAL_B }],
  ['a missing slug', { slug: undefined }],
  ['an empty name', { name: '' }],
  ['a deadline before its start', { deadline: Date.now() - 200000 }],
  ['a run span over a day', { deadline: Date.now() + 2 * 86400000 }],
  ['a start in 1970', { startedAtMs: 5, deadline: 3600005 }],
  ['a start far in the future', { startedAtMs: Date.now() + 5 * 86400000, deadline: Date.now() + 5 * 86400000 + 1000 }],
  ['an unknown phase', { phase: 'later' }],
  ['a cleanup phase without its outcome', { phase: 'cleanup' }],
  ['an unknown cleanup mode', { phase: 'cleanup', cleanupMode: 'kill', result: { outcome: 'exited' } }],
]) test(`a record with ${label} is set aside and authorizes no stop or rm`, async t => {
  const h = fixture(t);
  const file = h.record(JOB, { deadline: Date.now() - 1, ...extra });
  h.state(JOB, { state: 'working' });
  assert.deepEqual(await bg.resumeBackgroundRuns(h.deps), []);
  assert.deepEqual(h.calls, []);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readdirSync(h.recordsDir).filter(name => name.startsWith(JOB + '.json.corrupt-')).length, 1);
  assert.deepEqual(await bg.resumeBackgroundRuns(h.deps), [], 'a set-aside record is not read again');
});

test('corrupt records do not crowd a valid record out of the resume batch', async t => {
  const h = fixture(t);
  for (let i = 0; i < 70; i++) fs.writeFileSync(path.join(h.recordsDir, (0x10000000 + i).toString(16) + '.json'), '{"v":1}');
  const file = h.record(); h.state(JOB);
  const [details] = await bg.resumeBackgroundRuns(h.deps);
  assert.equal(details?.outcome, 'exited');
  assert.equal(fs.existsSync(file), false);
});

test('a timed-out run whose job now carries another session ends without stop or rm', async t => {
  const h = fixture(t);
  h.record(JOB, { deadline: Date.now() - 1 });
  h.state(JOB, { state: 'working', sessionId: JOB + '-0000-4000-8000-000000000999' });
  const [details] = await bg.resumeBackgroundRuns(h.deps);
  assert.equal(details.outcome, 'job-missing');
  assert.deepEqual(h.calls, []);
});

test('a pending cleanup whose job now carries another session is unresolved, not cleaned', async t => {
  const h = fixture(t);
  const file = h.record(JOB, { phase: 'cleanup', cleanupMode: 'stop', result: { outcome: 'timed-out', error: 'late' } });
  h.state(JOB, { state: 'working', sessionId: JOB + '-0000-4000-8000-000000000999' });
  const [details] = await bg.resumeBackgroundRuns(h.deps);
  assert.match(details.cleanup, /^unresolved: job a1234567 now belongs to session .*nothing was stopped or removed$/);
  assert.deepEqual(h.calls, []);
  assert.equal(fs.existsSync(file), false);
});

test('a pending cleanup whose job state cannot be confirmed is retried, not cleaned', async t => {
  const h = fixture(t);
  const file = h.record(JOB, { phase: 'cleanup', cleanupMode: 'stop', result: { outcome: 'exited', code: 0 } });
  fs.mkdirSync(path.join(h.jobsDir, JOB), { recursive: true });
  fs.writeFileSync(path.join(h.jobsDir, JOB, 'state.json'), '{');
  const [details] = await bg.resumeBackgroundRuns(h.deps);
  assert.equal(details.cleanupPending, true);
  assert.deepEqual(h.calls, []);
  assert.equal(saved(file).phase, 'cleanup');
});
