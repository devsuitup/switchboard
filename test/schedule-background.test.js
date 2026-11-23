'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { extractFunction } = require('./app-source');
const runner = require('../src/main/schedules/schedule-runner');
const { guardResume } = require('../public/resume-guard');
const SID = '61100000-0000-4000-8000-000000000001';
const JOB = '61111111';
const ACTUAL = JOB + '-0000-4000-8000-000000000002';
const root = path.resolve(__dirname, '..');
const turn = () => new Promise(resolve => setImmediate(resolve));

function setup(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-bg611-'));
  const jobsDir = path.join(home, 'jobs');
  fs.mkdirSync(path.join(jobsDir, JOB), { recursive: true });
  const cwd = home;
  const calls = [], records = [], logs = [], tracks = [];
  let done = 0, resolveDone;
  const finished = new Promise(resolve => { resolveDone = resolve; });
  const state = (value = 'working', timestamp = Date.now() + 1) => fs.writeFileSync(path.join(jobsDir, JOB, 'state.json'), JSON.stringify({
    sessionId: ACTUAL, state: value, createdAt: new Date().toISOString(),
    lastTerminalAt: new Date(timestamp).toISOString(), updatedAt: new Date(timestamp).toISOString(),
  }));
  state('done', 1);
  const seed = path.join(home, SID + '.jsonl');
  fs.writeFileSync(seed, JSON.stringify({ type: 'user', sessionId: SID, scheduleSlug: 'daily', slug: 'daily', message: { role: 'user', content: 'Scheduled Task: do work' } }) + '\n');
  const actualFile = path.join(home, require('../encode-project-path').encodeProjectPath(home), ACTUAL + '.jsonl');
  fs.mkdirSync(path.dirname(actualFile), { recursive: true });
  fs.writeFileSync(actualFile, [
    { type: 'user', sessionId: ACTUAL, cwd: home, timestamp: new Date().toISOString(), message: { role: 'user', content: 'do work' } },
    { type: 'assistant', existingDaemonRecord: true, sessionId: ACTUAL, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const localRequire = createRequire(path.join(root, 'main.js'));
  const activeSessions = new Map(options.joined ? [[ACTUAL, { isAttach: true, attachJobId: JOB, pty: {}, exited: false }]] : []);
  const context = vm.createContext({
    require: name => {
      if (name.endsWith('/schedule-run-results')) return { scheduleRunsDir: () => home, writeScheduleRunResult: (_dir, record) => records.push(record) };
      if (name.endsWith('/schedule-background')) {
        const mod = localRequire(name);
        return { ...mod, launchBackgroundSchedule: (input, deps) => mod.launchBackgroundSchedule(input, { ...deps, jobsDir, pollMs: 5, seedPath: seed, projectsDir: home }) };
      }
      return localRequire(name);
    },
    fs, path, os, process, activeSessions,
    DB_PATH: path.join(home, 'db'),
    getSetting: () => ({}), isProjectSettingsArchived: () => false,
    SETTING_DEFAULTS: { shellProfile: 'test', sandbox: false }, resolveShell: () => ({ path: 'fake-shell' }),
    cleanPtyEnv: { PATH: 'fake' }, resolveScheduleSandbox: () => !!options.sandbox,
    headlessClaudeLaunch: (shell, args) => ({ program: shell, args }),
    scheduleLaunchRefusal: () => null, sandboxScriptPath: () => 'sandbox.sh', sandboxBindEnv: () => null,
    encodeProjectPath: () => 'project', quoteArgvForShell: (_shell, args) => args.join(' '), shellArgs: (_shell, cmd) => [cmd],
    cpSpawn: (_program, args) => {
      calls.push([...args]);
      const child = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 123;
      setImmediate(() => { child.emit('spawn'); setImmediate(() => child.emit('exit', 0)); });
      return child;
    },
    runClaudeCommand: async args => {
      calls.push([...args]);
      if (args[0] === '--bg') return options.untrusted
        ? { code: 1, stdout: '', stderr: 'Workspace not trusted. Run claude once and accept the trust prompt.' }
        : { code: 0, stdout: `backgrounded · ${JOB} · daily`, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    cliSessionState: {
      trackScheduleRun: (...args) => tracks.push(args),
      readAllDescriptors: () => options.externalJoined ? [{ sessionId: ACTUAL, kind: 'interactive', jobId: JOB, pid: 456 }] : [],
    },
    activityReporter: { sessionStarted() {}, sessionEnded() {} },
    scheduleIpc: { reportRunExit() {} }, mainWindow: null,
    log: { info: (...s) => logs.push(s.join(' ')), warn: (...s) => logs.push(s.join(' ')), error: (...s) => logs.push(s.join(' ')) },
  });
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  vm.runInContext(extractFunction(main.replace(/^    (async )?function runScheduleCommand/m, '$1function runScheduleCommand'), 'runScheduleCommand'), context, { filename: path.join(root, 'main.js') });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const schedule = { name: 'daily', prompt: 'do work', slug: 'daily', cli: { model: 'haiku', 'add-dirs': 'first,second' }, runAsBackground: true };
  const argv = runner.buildScheduleCommand(SID, schedule).claudeArgs;
  return { calls, records, logs, tracks, state, finished, seed, home, schedule, argv,
    get done() { return done; },
    start: extra => context.runScheduleCommand(argv, cwd, 'daily', () => { done++; resolveDone(); }, {
      filePath: path.join(home, 'schedule-daily.md'), slug: 'daily', background: schedule, timeoutMs: 5000, ...extra,
    }),
  };
}

test('background run ignores launcher exit and stale done until a fresh terminal timestamp', async t => {
  const h = setup(t);
  await h.start(); await turn(); await turn();
  assert.equal(h.done, 0, 'launcher exit and stale done must not finish the run');
  h.state(); h.state('done'); await h.finished;
  assert.equal(h.done, 1);
});

test('background completion stops then removes the job and records its actual session', async t => {
  const h = setup(t); await h.start(); h.state('done'); await h.finished;
  assert.deepEqual(h.calls.slice(1), [['stop', JOB], ['rm', JOB]], 'completion must stop then rm');
  assert.equal(h.records.at(-1).sessionId, ACTUAL);
  assert.equal(h.records.at(-1).code, 0);
});

test('background launch applies options at creation and delimits the last prompt', async t => {
  const h = setup(t); const result = await h.start(); h.state('done'); await h.finished;
  assert.deepEqual(h.calls[0].slice(0, 4), ['--bg', '--name', 'daily', '--permission-mode']);
  assert.deepEqual(h.calls[0].slice(-2), ['--', 'do work']);
  assert.equal(h.calls[0].includes('--resume'), false);
  assert.equal(result.sessionId, ACTUAL);
  assert.equal(fs.existsSync(h.seed), false);
  const provenance = fs.readFileSync(path.join(h.home, require('../encode-project-path').encodeProjectPath(h.home), ACTUAL + '.jsonl'), 'utf8');
  assert.match(provenance, /"scheduleSlug":"daily"/);
  assert.match(provenance, /"existingDaemonRecord":true/);
  const entries = provenance.trim().split('\n').map(JSON.parse);
  assert.equal(entries.filter(row => row.type === 'user').length, 1, 'provenance transfer must not add a second conversation root');
  const marker = entries.find(row => row.type === 'schedule-provenance');
  assert.equal(marker?.scheduleSlug, 'daily');
  const reader = require('../read-session-file');
  const actualFile = path.join(h.home, require('../encode-project-path').encodeProjectPath(h.home), ACTUAL + '.jsonl');
  assert.equal(reader.readSessionFile(actualFile, 'project', h.home).scheduleSlug, 'daily');
  assert.equal(reader.readSessionDisplayHeader(actualFile).scheduleSlug, 'daily');
});

test('untrusted workspace reports a clear failure without cleanup of an unknown job', async t => {
  const h = setup(t, { untrusted: true }); const result = await h.start();
  assert.equal(result.ok, false, 'untrusted launch must fail');
  assert.match(result.error, /Workspace not trusted/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.done, 1);
});

test('background timeout is recorded and cleans the job', async t => {
  const h = setup(t); await h.start({ timeoutMs: 25 }); await h.finished;
  assert.equal(h.records.at(-1).outcome, 'timed-out');
  assert.deepEqual(h.calls.slice(1), [['stop', JOB], ['rm', JOB]]);
});

for (const joined of ['joined', 'externalJoined']) test(`background cleanup preserves a ${joined} user`, async t => {
  const h = setup(t, { [joined]: true }); await h.start(); h.state('done'); await h.finished;
  assert.match(h.records.at(-1).cleanup || '', /left running, joined/);
  assert.equal(h.calls.length, 1);
});

test('background failed terminal state records failure', async t => {
  const h = setup(t); await h.start(); h.state('failed'); await h.finished;
  assert.equal(h.records.at(-1).code, 1);
});

test('tracked background schedule attaches through the existing resume guard', async t => {
  const h = setup(t); await h.start(); h.state('done'); await h.finished;
  const options = h.tracks[0]?.[4];
  assert.equal(options?.jobId, JOB, 'tracked schedule must carry its background job');
  const verdict = await guardResume({ sessionId: ACTUAL }, { live: { kind: 'bg', jobId: options.jobId }, confirm: () => assert.fail('must attach') });
  assert.deepEqual(verdict, { attach: JOB, cwd: null });
  const state = require('../cli-session-state');
  const lifetime = new EventEmitter();
  state.trackScheduleRun(ACTUAL, lifetime, h.home, 'daily', options);
  t.after(() => lifetime.emit('exit', 0));
  assert.equal(state.isScheduleRunLive(ACTUAL), true);
  const live = await state.liveElsewhere(ACTUAL, () => false);
  assert.equal(live.kind, 'bg');
  assert.deepEqual(await guardResume({ sessionId: ACTUAL }, { live, confirm: () => assert.fail('must attach') }), { attach: JOB, cwd: h.home });
  lifetime.emit('exit', 0);
  assert.equal(state.isScheduleRunLive(ACTUAL), false);
});

test('headless command remains byte-identical with setting off', () => {
  const expected = ['--resume', SID, '-p', 'Run the scheduled task', '--permission-mode', 'auto', '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch'];
  assert.deepEqual(runner.buildScheduleCommand(SID, { runAsBackground: false }).claudeArgs, expected);
});

test('schedule setting is explicitly opt in', () => {
  assert.equal(runner.scheduleFields('schedule-daily.md', {}).runAsBackground, false);
  assert.equal(runner.scheduleFields('schedule-daily.md', { runAsBackground: 'true' }).runAsBackground, true);
});
