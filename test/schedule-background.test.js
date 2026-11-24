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
const { encodeProjectPath } = require('../encode-project-path');
const { guardResume } = require('../public/resume-guard');
const { deleteSessionRefusal } = require('../delete-session-guard');
const { customArgsForLaunch } = require('../src/main/terminals/shell-profiles');
const SID = '61100000-0000-4000-8000-000000000001';
const JOB = '61111111';
const OTHER_JOB = '61122222';
const ACTUAL = JOB + '-0000-4000-8000-000000000002';
const root = path.resolve(__dirname, '..');
const turn = () => new Promise(resolve => setImmediate(resolve));
const BACKGROUND = './src/main/schedules/schedule-background';

function setup(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-bg611-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const jobsDir = path.join(home, 'jobs');
  fs.mkdirSync(path.join(jobsDir, JOB), { recursive: true });
  const cwd = home;
  const folder = path.join(home, encodeProjectPath(home));
  fs.mkdirSync(folder, { recursive: true });
  const calls = [], callOptions = [], records = [], reports = [], logs = [], tracks = [], spawns = [];
  let done = 0, resolveDone;
  const finished = new Promise(resolve => { resolveDone = resolve; });
  const state = (value = 'working', timestamp = Date.now() + 1, extra = {}) => fs.writeFileSync(path.join(jobsDir, JOB, 'state.json'), JSON.stringify({
    sessionId: ACTUAL, state: value, createdAt: new Date().toISOString(),
    lastTerminalAt: new Date(timestamp).toISOString(), updatedAt: new Date(timestamp).toISOString(), ...extra,
  }));
  state('done', 1);
  const seed = path.join(folder, SID + '.jsonl');
  const content = options.content || 'Scheduled Task: do work';
  fs.writeFileSync(seed, JSON.stringify({ type: 'user', sessionId: SID, scheduleSlug: 'daily', slug: 'daily', message: { role: 'user', content } }) + '\n');
  const actualFile = path.join(folder, ACTUAL + '.jsonl');
  if (options.provenanceFails) fs.mkdirSync(actualFile);
  else fs.writeFileSync(actualFile, [
    { type: 'user', sessionId: ACTUAL, cwd: home, timestamp: new Date().toISOString(), message: { role: 'user', content } },
    { type: 'assistant', existingDaemonRecord: true, sessionId: ACTUAL, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const localRequire = createRequire(path.join(root, 'main.js'));
  const limitMs = options.limitMs ?? 5000;
  const extra = { jobsDir, pollMs: 5, limitMs, homeDir: home, seedPath: seed, projectsDir: home };
  const activeSessions = new Map(options.joined ? [[ACTUAL, { isAttach: true, attachJobId: JOB, pty: {}, exited: false }]] : []);
  const context = vm.createContext({
    require: name => {
      if (name.endsWith('/schedule-run-results')) return { scheduleRunsDir: () => home, writeScheduleRunResult: (_dir, record) => { records.push(record); return options.writeAck ?? true; } };
      if (name.endsWith('/schedule-background')) {
        const mod = localRequire(name);
        return { ...mod,
          launchBackgroundSchedule: (input, deps) => mod.launchBackgroundSchedule(input, { ...deps, ...extra }),
          resumeBackgroundRuns: (deps, claim) => mod.resumeBackgroundRuns({ ...deps, ...extra }, claim) };
      }
      return localRequire(name);
    },
    fs, path, os, process, activeSessions,
    DB_PATH: path.join(home, 'db'),
    getSetting: options.getSetting || (() => ({})), isProjectSettingsArchived: () => false,
    SETTING_DEFAULTS: { shellProfile: 'test', sandbox: false }, resolveShell: () => ({ path: options.shell || 'fake-shell' }),
    cleanPtyEnv: { PATH: 'fake' }, resolveScheduleSandbox: () => !!options.sandbox,
    customArgsForLaunch, headlessClaudeLaunch: (shell, args) => ({ program: shell, args }),
    scheduleLaunchRefusal: () => null, sandboxScriptPath: () => 'sandbox.sh', sandboxBindEnv: () => null, scheduleProjects: () => ({ list: async () => [] }),
    encodeProjectPath: () => 'project', quoteArgvForShell: (_shell, args) => args.join(' '), shellArgs: (_shell, cmd) => [cmd],
    cpSpawn: (_program, args) => {
      spawns.push([...args]);
      const child = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 123;
      setImmediate(() => { child.emit('spawn'); setImmediate(() => child.emit('exit', 0)); });
      return child;
    },
    runClaudeCommand: async (args, opts) => {
      calls.push([...args]); callOptions.push(opts);
      if (args[0] === '--bg') {
        if (options.orphan) {
          fs.mkdirSync(path.join(jobsDir, OTHER_JOB), { recursive: true });
          fs.writeFileSync(path.join(jobsDir, OTHER_JOB, 'state.json'), JSON.stringify({ name: 'daily', cwd, state: 'working', createdAt: new Date().toISOString() }));
        }
        return options.untrusted || options.orphan
          ? { code: 1, stdout: '', stderr: 'Workspace not trusted. Run claude once and accept the trust prompt.' }
          : { code: 0, stdout: `backgrounded · ${JOB} · daily`, stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    cliSessionState: {
      trackScheduleRun: (...args) => tracks.push(args),
      readAllDescriptors: () => options.externalJoined ? [{ sessionId: ACTUAL, kind: 'interactive', jobId: JOB, pid: 456 }] : [],
    },
    activityReporter: { sessionStarted() {}, sessionEnded() {} },
    scheduleIpc: { reportRunExit: (_window, payload) => reports.push(payload) }, mainWindow: null,
    log: { info: (...s) => logs.push(s.join(' ')), warn: (...s) => logs.push(s.join(' ')), error: (...s) => logs.push(s.join(' ')) },
  });
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  for (const name of ['scheduleBackgroundDeps', 'runScheduleCommand']) {
    if (name !== 'runScheduleCommand' && !new RegExp(`^    function ${name}[(]`, 'm').test(main)) continue;
    vm.runInContext(extractFunction(main.replace(new RegExp(`^    (async )?function ${name}`, 'm'), `$1function ${name}`), name), context, { filename: path.join(root, 'main.js') });
  }
  const schedule = { name: 'daily', prompt: 'do work', slug: 'daily', cli: { model: 'haiku', 'add-dirs': 'first,second', ...options.cli }, runAsBackground: true };
  const argv = runner.buildScheduleCommand(SID, schedule).claudeArgs;
  const recordsDir = path.join(home, 'schedule-state', 'background');
  return { calls, callOptions, records, reports, logs, tracks, spawns, state, finished, seed, home, jobsDir, recordsDir, actualFile, argv, context,
    get done() { return done; },
    start: () => context.runScheduleCommand(argv, cwd, 'daily', () => { done++; resolveDone(); }, {
      filePath: path.join(home, 'schedule-daily.md'), slug: 'daily', background: { ...schedule, seedPath: seed, timeoutMs: limitMs }, timeoutMs: limitMs,
    }),
    resume: claim => context.require(BACKGROUND).resumeBackgroundRuns(context.scheduleBackgroundDeps(), claim),
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
  assert.equal(h.callOptions[2].cwd, h.home, 'rm runs from the home directory');
  assert.equal(h.records.at(-1).sessionId, ACTUAL);
  assert.equal(h.records.at(-1).code, 0);
});

test('background launch applies options at creation and sends the seed message as the last prompt', async t => {
  const h = setup(t); const result = await h.start(); h.state('done'); await h.finished;
  assert.deepEqual(h.calls[0].slice(0, 4), ['--bg', '--name', 'daily', '--permission-mode']);
  assert.deepEqual(h.calls[0].slice(-2), ['--', 'Scheduled Task: do work'], 'the prompt is the seed message, heading included');
  assert.equal(h.calls[0].includes('--resume'), false);
  assert.equal(result.sessionId, ACTUAL);
  assert.equal(fs.existsSync(h.seed), false);
  const provenance = fs.readFileSync(h.actualFile, 'utf8');
  assert.match(provenance, /"scheduleSlug":"daily"/);
  assert.match(provenance, /"existingDaemonRecord":true/);
  const entries = provenance.trim().split('\n').map(JSON.parse);
  assert.equal(entries.filter(row => row.type === 'user').length, 1, 'provenance transfer must not add a second conversation root');
  const marker = entries.find(row => row.type === 'schedule-provenance');
  assert.equal(marker?.scheduleSlug, 'daily');
  const reader = require('../read-session-file');
  assert.equal(reader.readSessionFile(h.actualFile, 'project', h.home).scheduleSlug, 'daily');
  assert.equal(reader.readSessionDisplayHeader(h.actualFile).scheduleSlug, 'daily');
});

test('a catch-up run sends its catch-up heading with the prompt', async t => {
  const content = 'Scheduled Task (catch-up: due 2026-01-05T20:00:00.000Z, started 2026-01-06T21:00:10.000Z): do work';
  const h = setup(t, { content }); await h.start(); h.state('done'); await h.finished;
  assert.deepEqual(h.calls[0].slice(-2), ['--', content]);
});

test('the launch timeout is floored at 30 s whatever the run limit', async t => {
  const h = setup(t, { limitMs: 25 }); await h.start(); await h.finished;
  assert.equal(h.callOptions[0].timeout, 30000);
});

test('untrusted workspace records and reports a failure without cleanup of an unknown job', async t => {
  const h = setup(t, { untrusted: true }); const result = await h.start();
  assert.equal(result.ok, false, 'untrusted launch must fail');
  assert.match(result.error, /Workspace not trusted/);
  assert.equal(h.calls.length, 1);
  await h.finished;
  assert.equal(h.done, 1);
  assert.equal(h.records.at(-1).outcome, 'spawn-error');
  assert.equal(h.reports.at(-1).outcome, 'spawn-error', 'a background failure is reported like a headless one');
  assert.match(h.reports.at(-1).error, /Workspace not trusted/);
});

test('a launch without a job id stops nothing, even a same-name job in its cwd, and records an unresolved launch', async t => {
  const h = setup(t, { orphan: true }); const result = await h.start(); await h.finished;
  assert.equal(result.ok, false);
  assert.deepEqual(h.calls.slice(1), [], 'a job found by name, cwd and creation time is not proof of ownership');
  assert.equal(h.records.at(-1).outcome, 'spawn-error');
  assert.match(h.records.at(-1).cleanup, /^unresolved launch: no job id .*no job was stopped or removed$/);
  assert.match(h.logs.join('\n'), /unresolved launch/);
});

test('the main result callback returns the writer acknowledgement, and a refused write keeps the record', async t => {
  const h = setup(t, { writeAck: false }); await h.start(); h.state('done'); await h.finished;
  assert.equal(h.records.length, 1, 'the write was attempted');
  const saved = JSON.parse(fs.readFileSync(path.join(h.recordsDir, JOB + '.json'), 'utf8'));
  assert.equal(saved.phase, 'result');
  assert.equal(saved.result.outcome, 'exited');
  assert.equal(saved.cleanup, 'stopped and removed');
  assert.equal(h.context.scheduleBackgroundDeps().writeResult({ sessionId: ACTUAL }), true, 'a record without a schedule file has nothing to publish');
});

test('background timeout is recorded, reported as a timeout and cleans the job', async t => {
  const h = setup(t, { limitMs: 25 }); await h.start(); await h.finished;
  assert.equal(h.records.at(-1).outcome, 'timed-out');
  assert.deepEqual(h.calls.slice(1), [['stop', JOB], ['rm', JOB]]);
  assert.equal(h.reports.at(-1).outcome, 'timed-out');
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

test('a stopped job ends the run with its own outcome and is removed without a second stop', async t => {
  const h = setup(t); await h.start(); h.state('stopped'); await h.finished;
  assert.equal(h.records.at(-1).outcome, 'stopped');
  assert.deepEqual(h.calls.slice(1), [['rm', JOB]]);
  assert.equal(h.reports.at(-1).outcome, 'stopped');
});

test('a job whose state disappears ends the run as missing, with nothing to clean', async t => {
  const h = setup(t); await h.start();
  fs.rmSync(path.join(h.jobsDir, JOB), { recursive: true, force: true });
  await h.finished;
  assert.equal(h.records.at(-1).outcome, 'job-missing');
  assert.equal(h.calls.length, 1);
});

test('a provenance transfer error keeps monitoring the live job and records the warning', async t => {
  const h = setup(t, { provenanceFails: true }); const result = await h.start();
  assert.equal(result.ok, true, 'the live job is not abandoned');
  h.state('done'); await h.finished;
  assert.equal(h.records.at(-1).outcome, 'exited');
  assert.equal(h.records.at(-1).code, 0);
  assert.match(h.records.at(-1).warning || '', /provenance not recorded/);
  assert.deepEqual(h.calls.slice(1), [['stop', JOB], ['rm', JOB]]);
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
  const refusal = await deleteSessionRefusal(ACTUAL, { activeSessions: new Map(), liveJobCheck: () => ({ known: true }),
    liveElsewhereChecked: async () => ({ known: true, live }), describeLiveProcess: true });
  assert.doesNotMatch(refusal, /pid undefined/, 'a synthetic lifetime has no pid to describe');
  lifetime.emit('exit', 0);
  assert.equal(state.isScheduleRunLive(ACTUAL), false);
});

test('the monitor record survives until the result is written', async t => {
  const h = setup(t); await h.start();
  const saved = JSON.parse(fs.readFileSync(path.join(h.recordsDir, JOB + '.json'), 'utf8'));
  assert.equal(saved.actualId, ACTUAL);
  assert.equal(saved.filePath, path.join(h.home, 'schedule-daily.md'));
  assert.equal(saved.deadline - saved.startedAtMs, 5000);
  h.state('done'); await h.finished;
  assert.equal(fs.existsSync(path.join(h.recordsDir, JOB + '.json')), false, 'the record goes once the result is written');
});

test('after a restart, a recorded run is monitored to its end, cleaned and recorded', async t => {
  const h = setup(t);
  const startedAtMs = Date.now() - 1000;
  fs.mkdirSync(h.recordsDir, { recursive: true });
  fs.writeFileSync(path.join(h.recordsDir, JOB + '.json'), JSON.stringify({ v: 1, jobId: JOB, actualId: ACTUAL, sessionId: SID, cwd: h.home,
    name: 'daily', runName: 'daily', filePath: path.join(h.home, 'schedule-daily.md'), slug: 'daily', manual: false, dueMs: null,
    startedAtMs, deadline: startedAtMs + 60000 }));
  const claims = [];
  const resumed = h.resume(run => { claims.push(run.slug); return () => claims.push('released'); });
  for (let i = 0; i < 400 && !h.tracks.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.tracks[0]?.[0], ACTUAL, 'the resumed run is live again for the resume guard');
  assert.equal(h.tracks[0]?.[4].jobId, JOB);
  h.state('done');
  const [details] = await resumed;
  assert.equal(details.outcome, 'exited');
  assert.deepEqual(h.calls, [['stop', JOB], ['rm', JOB]]);
  assert.equal(h.records.at(-1).sessionId, ACTUAL);
  assert.equal(h.records.at(-1).startedAtMs, startedAtMs);
  assert.deepEqual(claims, ['daily', 'released'], 'the schedule stays in flight until the resumed run ends');
  assert.equal(fs.existsSync(path.join(h.recordsDir, JOB + '.json')), false);
});

test('after a restart past its limit, a recorded run times out and is cleaned', async t => {
  const h = setup(t);
  const startedAtMs = Date.now() - 120000;
  fs.mkdirSync(h.recordsDir, { recursive: true });
  fs.writeFileSync(path.join(h.recordsDir, JOB + '.json'), JSON.stringify({ v: 1, jobId: JOB, actualId: ACTUAL, cwd: h.home,
    name: 'daily', filePath: path.join(h.home, 'schedule-daily.md'), slug: 'daily', manual: true, dueMs: null, startedAtMs, deadline: startedAtMs + 60000 }));
  fs.writeFileSync(path.join(h.recordsDir, 'deadbeef.json'), '{');
  const [details] = await h.resume();
  assert.equal(details.outcome, 'timed-out');
  assert.deepEqual(h.calls, [['stop', JOB], ['rm', JOB]]);
  assert.match(h.logs.join('\n'), /unreadable background run record: deadbeef\.json/);
});

test('a restart without records resumes nothing', async t => {
  const h = setup(t);
  assert.deepEqual(await h.resume(), []);
});

for (const [label, options] of [
  ['sandbox', { sandbox: true }],
  ['project pre-launch wrapper', { getSetting: key => key === 'project:' + 'HOME' ? { preLaunchCmd: 'aws-vault exec dev --' } : {} }],
  ['WSL shell', { shell: 'C:\\Windows\\System32\\wsl.exe' }],
  ['max-budget-usd cap', { cli: { 'max-budget-usd': '2' } }],
]) test(`a background schedule under a ${label} runs headless with the fallback notice`, async t => {
  const previous = process.env.SWITCHBOARD_TRIGGERS_DIR;
  const triggers = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-bg611-triggers-'));
  process.env.SWITCHBOARD_TRIGGERS_DIR = triggers;
  t.after(() => {
    if (previous === undefined) delete process.env.SWITCHBOARD_TRIGGERS_DIR; else process.env.SWITCHBOARD_TRIGGERS_DIR = previous;
    fs.rmSync(triggers, { recursive: true, force: true });
  });
  let home;
  const resolved = options.getSetting ? { getSetting: key => options.getSetting(key.replace(path.resolve(home), 'HOME')) } : {};
  const h = setup(t, { ...options, ...resolved });
  home = h.home;
  assert.equal((await h.start()).ok, true);
  await h.finished;
  assert.equal(h.calls.length, 0, 'no background launch');
  assert.equal(h.spawns.length, 1, 'the headless launch runs instead');
  assert.match(h.reports[0]?.backgroundFallback || '', /using headless/);
  if (label.startsWith('max-budget')) assert.match(h.reports[0].backgroundFallback, /max-budget-usd/);
});

test('a global pre-launch command, which headless schedules never apply, keeps background mode', async t => {
  const h = setup(t, { getSetting: key => key === 'global' ? { preLaunchCmd: 'aws-vault exec dev --' } : {} });
  await h.start(); h.state('done'); await h.finished;
  assert.equal(h.calls[0][0], '--bg');
  assert.equal(h.spawns.length, 0);
});

test('headless command remains byte-identical with setting off', () => {
  const expected = ['--resume', SID, '-p', 'Run the scheduled task', '--permission-mode', 'auto', '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch'];
  assert.deepEqual(runner.buildScheduleCommand(SID, { runAsBackground: false }).claudeArgs, expected);
});

test('schedule setting is explicitly opt in and parses like catch-up', () => {
  assert.equal(runner.scheduleFields('schedule-daily.md', {}).runAsBackground, false);
  for (const value of ['true', 'TRUE', '"true"', "'True'"]) {
    assert.equal(runner.scheduleFields('schedule-daily.md', { 'run-as-background': value }).runAsBackground, true, value);
    assert.equal(runner.scheduleFields('schedule-daily.md', { 'catch-up': value }).catchUp, true, value);
  }
  for (const value of ['false', 'yes', '"true', { nested: 'true' }]) {
    assert.equal(runner.scheduleFields('schedule-daily.md', { 'run-as-background': value }).runAsBackground, false, String(value));
  }
  assert.equal(runner.scheduleFields('schedule-daily.md', { runAsBackground: 'true' }).runAsBackground, false, 'only the kebab-case key is read');
  assert.equal('timeoutMs' in runner.scheduleFields('schedule-daily.md', { timeoutMs: '5' }), false, 'no timeout front matter');
});
