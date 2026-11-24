'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { isolatedHome } = require('./fixtures/isolated-home.cjs');

const realHome = process.env.SWITCHBOARD_TEST_REAL_HOME || os.homedir();
const suiteProjects = () => {
  try { return fs.readdirSync(path.join(realHome, '.claude', 'projects')).filter(name => name.includes('schedule-bg-recovery-')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
const projectsBefore = new Set(suiteProjects());
const processes = [];
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const native = childProcess[name];
  childProcess[name] = (...args) => {
    processes.push([name, ...args.filter(arg => typeof arg === 'string' || Array.isArray(arg))]);
    throw new Error(`the background recovery suite must never start a process: ${name} ${JSON.stringify(args[0])}`);
  };
  test.after(() => { childProcess[name] = native; });
}
test.after(() => {
  assert.deepEqual(processes, [], 'no test may start a process, the claude CLI least of all');
  assert.deepEqual(suiteProjects().filter(name => !projectsBefore.has(name)), [], 'scheduled seeds must stay in the disposable home');
});
isolatedHome(test, { realHome }).install();

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

function stalledThenResumed(deps, stalls) {
  const attempts = [];
  let finish;
  const delayed = new Promise(resolve => { finish = resolve; });
  const resume = claim => {
    let inner;
    const gate = attempts.length < stalls ? delayed : Promise.resolve();
    const discovered = gate.then(() => (inner = bg.resumeBackgroundRuns(deps, claim)).discovered);
    const lifetimes = discovered.then(() => inner);
    lifetimes.discovered = discovered;
    attempts.push(lifetimes);
    return lifetimes;
  };
  const found = async () => (await Promise.all(attempts.map(attempt => attempt.discovered))).reduce((sum, n) => sum + n, 0);
  return { resume, attempts, finish, found, settled: () => Promise.all(attempts) };
}

test('a discovery stalled beyond its bound keeps a minute tick from launching beside a persisted working run', async t => {
  const h = fixture(t);
  const start = Math.floor(Date.now() / 60000) * 60000 + 59000;
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: start });
  h.record(JOB, { startedAtMs: start - 60000, deadline: start + 3600000 }); h.state(JOB, { state: 'working' });
  const launches = [];
  const slow = stalledThenResumed(h.deps, Infinity);
  const stop = runner.startScheduler(h.log, (...args) => { launches.push(args); args[3](); return { ok: true }; }, {
    projects: async () => [h.cwd], resumeBackgroundRuns: slow.resume,
  });
  t.after(stop);
  t.mock.timers.tick(1000);
  await immediate();
  assert.equal(launches.length, 0, 'the tick is held before the bound');
  t.mock.timers.tick(9000);
  for (let i = 0; i < 5; i++) await immediate();
  assert.equal(launches.length, 0, 'the bound does not authorize an overlapping launch');
  assert.match(h.lines.join('\n'), /not read after 10 s \(attempt 1\); automatic launches stay suspended/);
  assert.equal(slow.attempts.length, 2, 'discovery is retried');
  t.mock.timers.tick(60000);
  for (let i = 0; i < 5; i++) await immediate();
  assert.equal(launches.length, 0, 'later ticks stay held while the records are unknown');
  slow.finish();
  assert.equal(await slow.found(), 1, 'the persisted run is claimed once across attempts');
  for (let i = 0; i < 10; i++) await immediate();
  assert.equal(launches.length, 0, 'the released check sees the run as in flight');
  assert.match(h.lines.join('\n'), /Skipping daily — still running/);
  h.state(JOB, { lastTerminalAt: start + 1 });
  await slow.settled();
  assert.equal(h.written.length, 1, 'the run is supervised once');
  t.mock.timers.tick(60000);
  for (let i = 0; i < 10; i++) await immediate();
  assert.equal(launches.length, 1, 'the schedule runs once the resumed run ended');
});

test('a startup catch-up stays held past the discovery bound until the persisted run is claimed', async t => {
  withCatchUp(t);
  const h = fixture(t);
  const start = Math.floor(Date.now() / 60000) * 60000 + 1000;
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: start });
  h.record(JOB, { startedAtMs: start - 60000, deadline: start + 3600000 }); h.state(JOB, { state: 'working' });
  const launches = [];
  const slow = stalledThenResumed(h.deps, Infinity);
  const stop = runner.startScheduler(h.log, (...args) => { launches.push(args); args[3](); return { ok: true }; }, {
    stateDir: path.join(h.home, 'catch-up'), projects: async () => [h.cwd], resumeBackgroundRuns: slow.resume,
  });
  t.after(stop);
  t.mock.timers.tick(10000);
  for (let i = 0; i < 5; i++) await immediate();
  assert.equal(launches.length, 0, 'the startup catch-up is not released by the bound');
  slow.finish();
  assert.equal(await slow.found(), 1);
  for (let i = 0; i < 10; i++) await immediate();
  assert.equal(launches.length, 0, 'the catch-up sees the resumed run as in flight');
  assert.match(h.lines.join('\n'), /Skipping daily — still running/);
  h.state(JOB, { lastTerminalAt: start + 1 });
  await slow.settled();
});

test('a stalled discovery is retried with a growing delay, and scheduling resumes once a retry reads the records', async t => {
  const h = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Math.floor(Date.now() / 60000) * 60000 + 1000 });
  const launches = [];
  const slow = stalledThenResumed(h.deps, 2);
  const stop = runner.startScheduler(h.log, (...args) => { launches.push(args); args[3](); return { ok: true }; }, {
    projects: async () => [h.cwd], resumeBackgroundRuns: slow.resume,
  });
  t.after(stop);
  assert.equal(slow.attempts.length, 1, 'startup returns while the first discovery is pending');
  t.mock.timers.tick(10000);
  await immediate();
  assert.equal(slow.attempts.length, 2);
  assert.deepEqual({ ...stop.getHealth(), since: 0 }, { suspended: true, reason: 'slow', path: null, code: null, message: 'not read after 10 s', since: 0, retryMs: 10000 });
  t.mock.timers.tick(19000);
  await immediate();
  assert.equal(slow.attempts.length, 2, 'the second wait is longer than the first');
  t.mock.timers.tick(1000);
  assert.equal(slow.attempts.length, 3);
  await slow.attempts[2].discovered;
  await immediate();
  assert.equal(h.lines.filter(line => line.includes('not read after')).length, 1, 'a stall that persists is logged once');
  assert.match(h.lines.join('\n'), /read after 3 attempts; scheduling resumes/);
  assert.deepEqual(stop.getHealth(), { suspended: false });
  t.mock.timers.tick(30000);
  for (let i = 0; i < 10; i++) await immediate();
  assert.equal(launches.length, 1, 'the minute tick runs once the records are known');
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

function resultFixture(h, file) {
  const runsDir = path.join(h.home, 'results');
  fs.mkdirSync(runsDir, { recursive: true });
  const destination = path.join(runsDir, `${runner.scheduleStateKey({ filePath: h.filePath })}-${saved(file).startedAtMs}-${ACTUAL}.json`);
  return { destination, write: value => results.writeScheduleRunResult(runsDir, value, h.log) };
}

test('an invalid result file keeps the result record and the report names the file', async t => {
  const h = fixture(t);
  const file = h.record(JOB, { phase: 'result', result: { outcome: 'exited', code: 0 }, cleanup: 'stopped and removed' });
  const r = resultFixture(h, file);
  fs.writeFileSync(r.destination, '{');
  const reports = [];
  const deps = { ...h.deps, writeResult: value => results.publishScheduleRunResult(path.dirname(r.destination), value, h.log), report: value => reports.push(value) };
  const [details] = await bg.resumeBackgroundRuns(deps);
  assert.equal(details.resultPending, true);
  assert.match(details.persistenceError, /unreadable; remove or fix it/);
  assert.equal(fs.readFileSync(r.destination, 'utf8'), '{', 'the invalid file is not repaired behind the user');
  assert.equal(saved(file).phase, 'result');
  assert.ok(reports[0].persistenceError.includes(r.destination));
});

for (const code of ['ENOTSUP', 'EXDEV']) {
  test(`a store without hard links (${code}) keeps the recovered result in its record and reports why`, async t => {
    const h = fixture(t);
    const file = h.record(JOB, { phase: 'result', result: { outcome: 'exited', code: 0 }, cleanup: 'stopped and removed' });
    const r = resultFixture(h, file);
    const link = () => { throw Object.assign(new Error('hard links not supported'), { code }); };
    const [details] = await bg.resumeBackgroundRuns({ ...h.deps, writeResult: value => results.publishScheduleRunResult(path.dirname(r.destination), value, h.log, { link }) });
    assert.equal(details.resultPending, true);
    assert.match(details.persistenceError, /does not support hard links/);
    assert.equal(fs.existsSync(r.destination), false, 'no destination is created');
    assert.equal(saved(file).phase, 'result', 'the record keeps the result for a later start');
    assert.equal(saved(file).cleanup, 'stopped and removed');
  });
}

test('a publication failure reaches the report, keeps the record, and is logged once per distinct error', async t => {
  const h = fixture(t);
  const file = h.record(JOB, { phase: 'result', result: { outcome: 'exited', code: 0 }, cleanup: 'stopped and removed' });
  const r = resultFixture(h, file);
  const reports = [];
  const link = () => { throw Object.assign(new Error('the volume refused the link'), { code: 'EIO' }); };
  const deps = { ...h.deps, report: value => reports.push(value),
    writeResult: value => results.publishScheduleRunResult(path.dirname(r.destination), value, h.log, { link }) };
  for (let i = 0; i < 2; i++) {
    const [value] = await bg.resumeBackgroundRuns(deps);
    assert.equal(value.resultPending, true);
    assert.match(value.persistenceError, /the volume refused the link/);
    assert.equal(saved(file).phase, 'result');
  }
  assert.equal(results.readScheduleRunResults(path.dirname(r.destination), [ACTUAL]).size, 0);
  assert.equal(reports.length, 2);
  for (const report of reports) assert.match(report.persistenceError, /the volume refused the link/, 'publication failure is visible in the report sent to the UI');
  assert.equal(h.lines.filter(line => line.includes('result not recorded')).length, 1, 'retries do not repeat the same warning');
  assert.equal(h.lines.filter(line => line.includes('Cannot record result')).length, 1);
});

test('a lock file left by an older version does not block publication', t => {
  const h = fixture(t);
  const runsDir = path.join(h.home, 'race');
  fs.mkdirSync(runsDir);
  const input = { sessionId: ACTUAL, filePath: h.filePath, name: 'daily', slug: 'daily', startedAtMs: Date.now(), outcome: 'exited', code: 0 };
  const lock = path.join(runsDir, `${runner.scheduleStateKey({ filePath: h.filePath })}-${input.startedAtMs}-${ACTUAL}.json.lock`);
  fs.writeFileSync(lock, 'old writer');
  assert.equal(results.writeScheduleRunResult(runsDir, input, h.log), true);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'old writer', 'publication never reads, takes or removes a lock');
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

test('a job that changes session while it is being stopped is not removed', async t => {
  const h = fixture(t);
  const file = h.record(JOB, { phase: 'cleanup', cleanupMode: 'stop', result: { outcome: 'exited', code: 0 } });
  h.state(JOB);
  const [details] = await bg.resumeBackgroundRuns({ ...h.deps, runCommand: async args => {
    h.calls.push(args);
    if (args[0] === 'stop') h.state(JOB, { state: 'working', sessionId: JOB + '-0000-4000-8000-000000000999' });
    return { code: 0 };
  } });
  assert.deepEqual(h.calls, [['stop', JOB]], 'rm never targets the replacement session');
  assert.match(details.cleanup, /^unresolved: job a1234567 now belongs to session .*it was stopped but nothing was removed$/);
  assert.equal(fs.existsSync(file), false);
});

test('a job whose state cannot be read after its stop is not removed', async t => {
  const h = fixture(t);
  const file = h.record(JOB, { phase: 'cleanup', cleanupMode: 'stop', result: { outcome: 'exited', code: 0 } });
  h.state(JOB);
  const [details] = await bg.resumeBackgroundRuns({ ...h.deps, runCommand: async args => {
    h.calls.push(args);
    if (args[0] === 'stop') fs.writeFileSync(path.join(h.jobsDir, JOB, 'state.json'), '{');
    return { code: 0 };
  } });
  assert.deepEqual(h.calls.filter(c => c[0] === 'rm'), []);
  assert.equal(details.cleanupPending, true);
  assert.equal(saved(file).cleanupMode, 'rm', 'the next start only removes, after confirming the identity');
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

function failingRead(t, operation, target) {
  const native = fs.promises[operation];
  const failure = { on: true };
  t.mock.method(fs.promises, operation, async function(file, ...args) {
    if (failure.on && path.resolve(String(file)) === path.resolve(target)) {
      throw Object.assign(new Error('temporary recovery I/O failure'), { code: 'EACCES' });
    }
    return native.call(this, file, ...args);
  });
  return failure;
}

function recoveringScheduler(t, h) {
  const start = Math.floor(Date.now() / 60000) * 60000 + 59000;
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: start });
  const launches = [], attempts = [];
  let changes = 0;
  const stop = runner.startScheduler(h.log, (...args) => { launches.push(args); args[3](); return { ok: true }; }, {
    projects: async () => [h.cwd],
    resumeBackgroundRuns: claim => { const resumed = bg.resumeBackgroundRuns(h.deps, claim); attempts.push(resumed); return resumed; },
    onHealthChange: () => { changes++; },
  });
  t.after(stop);
  const settle = async (n = 20) => { for (let i = 0; i < n; i++) await immediate(); };
  return { start, launches, attempts, settle, stop, changes: () => changes };
}

test('a records directory read error keeps automatic launches held until a retry reads the records', async t => {
  const h = fixture(t);
  const s0 = Math.floor(Date.now() / 60000) * 60000 + 59000;
  h.record(JOB, { startedAtMs: s0 - 60000, deadline: s0 + 3600000 }); h.state(JOB, { state: 'working' });
  const failure = failingRead(t, 'readdir', h.recordsDir);
  const s = recoveringScheduler(t, h);
  await assert.rejects(s.attempts[0].discovered, /temporary recovery I\/O failure/);
  t.mock.timers.tick(1000);
  await s.settle();
  assert.equal(s.launches.length, 0, 'an unreadable records directory is not an empty one');
  assert.match(h.lines.join('\n'), /Cannot read the background run records/);
  failure.on = false;
  t.mock.timers.tick(9000);
  await s.settle();
  assert.equal(s.attempts.length, 2, 'discovery is retried after its bounded wait');
  assert.equal(await s.attempts[1].discovered, 1);
  await s.settle();
  assert.equal(s.launches.length, 0, 'the released check sees the recovered run as in flight');
  h.state(JOB, { lastTerminalAt: s.start + 1 });
  await s.attempts[1];
  assert.equal(h.written.length, 1);
  t.mock.timers.tick(60000);
  await s.settle();
  assert.equal(s.launches.length, 1, 'the schedule runs once the recovered run ended');
});

test('a record read error keeps the runs already claimed and the hold, and a retry claims only the rest', async t => {
  const h = fixture(t);
  const s0 = Math.floor(Date.now() / 60000) * 60000 + 59000;
  const file = h.record(JOB, { startedAtMs: s0 - 60000, deadline: s0 + 3600000 }); h.state(JOB, { state: 'working' });
  h.record(JOB_B, { startedAtMs: s0 - 60000, deadline: s0 + 3600000 }); h.state(JOB_B, { state: 'working' });
  const failure = failingRead(t, 'readFile', file);
  const s = recoveringScheduler(t, h);
  await assert.rejects(s.attempts[0].discovered, /temporary recovery I\/O failure/);
  t.mock.timers.tick(1000);
  await s.settle();
  assert.equal(s.launches.length, 0, 'an unread record keeps the hold');
  assert.equal(fs.existsSync(file), true, 'an unread record is left in place');
  failure.on = false;
  t.mock.timers.tick(9000);
  await s.settle();
  assert.equal(await s.attempts[1].discovered, 1, 'the retry claims only the record that failed');
  h.state(JOB, { lastTerminalAt: s.start + 1 }); h.state(JOB_B, { lastTerminalAt: s.start + 1 });
  await Promise.allSettled(s.attempts);
  assert.equal(h.written.length, 2, 'each run is supervised once');
  assert.deepEqual(h.calls.filter(c => c[1] === JOB_B), [['stop', JOB_B], ['rm', JOB_B]], 'the run claimed before the failure is not claimed again');
  t.mock.timers.tick(60000);
  await s.settle();
  assert.equal(s.launches.length, 1);
});

for (const [label, prepare] of [['empty', () => {}], ['missing', h => fs.rmSync(h.recordsDir, { recursive: true })]]) {
  test(`an ${label} records directory releases automatic ticks at once`, async t => {
    const h = fixture(t);
    prepare(h);
    const s = recoveringScheduler(t, h);
    assert.equal(await s.attempts[0].discovered, 0);
    t.mock.timers.tick(1000);
    await s.settle();
    assert.equal(s.launches.length, 1);
    assert.equal(s.attempts.length, 1);
  });
}

test('a permanent records read failure is reported by the scheduler and the Schedules listing until discovery succeeds', async t => {
  const h = fixture(t);
  const { buildScheduleList } = require('../src/main/schedules/schedule-list');
  const failure = failingRead(t, 'readdir', h.recordsDir);
  const s = recoveringScheduler(t, h);
  const deps = { scheduleProjects: () => ({ list: async () => [h.cwd] }), getCachedByFolder: () => [], isScheduleRunLive: () => false,
    catchUpActive: false, projectsDir: h.home, runsDir: path.join(h.home, 'results'), now: () => s.start };
  const healthy = await buildScheduleList(deps);
  assert.deepEqual(healthy.health, { suspended: false, resultFailure: null });
  await s.attempts[0].discovered.catch(() => {});
  for (const wait of [10000, 20000, 40000, 80000, 160000, 300000, 300000]) {
    t.mock.timers.tick(wait);
    await s.settle();
  }
  assert.equal(s.attempts.length, 8);
  assert.equal(s.launches.length, 0, 'the hold itself is unchanged');
  assert.equal(h.lines.filter(line => line.includes('automatic launches stay suspended')).length, 1, 'the same failure is logged once');
  const health = s.stop.getHealth();
  assert.equal(health.suspended, true);
  assert.equal(health.reason, 'unreadable');
  assert.equal(health.code, 'EACCES');
  assert.equal(path.resolve(health.path), path.resolve(h.recordsDir));
  assert.equal(health.retryMs, 300000);
  assert.ok(Number.isFinite(health.since));
  const held = await buildScheduleList({ ...deps, schedulerHealth: () => ({ ...s.stop.getHealth(), resultFailure: null }) });
  assert.notDeepEqual(held, healthy, 'Schedules listing must expose suspended automatic scheduling');
  assert.equal(held.health.suspended, true);
  const announced = s.changes();
  assert.ok(announced >= 1, 'the suspension is announced');
  failure.on = false;
  t.mock.timers.tick(300000);
  await s.settle();
  assert.equal(await s.attempts[8].discovered, 0);
  await s.settle();
  assert.deepEqual(s.stop.getHealth(), { suspended: false }, 'a successful discovery clears the suspension');
  assert.equal(s.changes(), announced + 1, 'the recovery is announced');
});

test('an accepted record whose result cannot be named stays unresolved when another run publishes', async t => {
  const h = fixture(t);
  const s0 = Date.now() - 120000 + 0.5;
  const file = h.record(JOB, { phase: 'result', result: { outcome: 'exited', code: 0 }, cleanup: 'stopped and removed', startedAtMs: s0, deadline: s0 + 3600000 });
  const runsDir = path.join(h.home, 'results');
  const before = results.latestResultFailure()?.count || 0;
  const pending = bg.resumeBackgroundRuns({ ...h.deps, writeResult: value => results.publishScheduleRunResult(runsDir, value, h.log) });
  assert.equal(await pending.discovered, 1, 'discovery accepts the saved result record');
  const [details] = await pending;
  assert.equal(details.resultPending, true);
  assert.equal(results.latestResultFailure().message, 'Invalid schedule run identity');
  assert.equal(results.latestResultFailure().path, null);
  assert.equal(results.latestResultFailure().count, before + 1);
  const other = { sessionId: ACTUAL_B, filePath: h.filePath, name: 'daily', slug: 'daily', startedAtMs: Date.now(), outcome: 'exited', code: 0 };
  assert.equal(results.publishScheduleRunResult(runsDir, other, h.log).ok, true);
  assert.equal(saved(file).phase, 'result');
  assert.equal(results.latestResultFailure()?.count || 0, before + 1, 'success for another run must not erase the unresolved failure');
});

test('an access denial keeps the result record, and a later start publishes it without cleaning again', async t => {
  const h = fixture(t);
  const file = h.record(JOB, { phase: 'result', result: { outcome: 'exited', code: 0 }, cleanup: 'stopped and removed' });
  const runsDir = path.join(h.home, 'results');
  const [first] = await bg.resumeBackgroundRuns({ ...h.deps, writeResult: value => results.publishScheduleRunResult(runsDir, value, h.log, {
    link() { throw Object.assign(new Error('locked'), { code: 'EPERM' }); },
  }) });
  assert.equal(first.resultPending, true);
  assert.match(first.persistenceError, /^Access was denied while recording the result \(EPERM: locked\)/);
  assert.equal(saved(file).phase, 'result');
  assert.deepEqual(fs.readdirSync(runsDir), []);
  const [second] = await bg.resumeBackgroundRuns({ ...h.deps, writeResult: value => results.publishScheduleRunResult(runsDir, value, h.log) });
  assert.equal(second.resultPending, undefined);
  assert.equal(fs.existsSync(file), false);
  assert.equal(results.readScheduleRunResults(runsDir, [ACTUAL]).get(ACTUAL).exitCode, 0);
  assert.deepEqual(h.calls, [], 'a result-phase retry does not repeat cleanup');
});
