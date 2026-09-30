// test/schedule-catch-up.test.js — a schedule with `catch-up: true` runs once
// for the minutes it missed while no tick looked at them.
// see .ai/contexts/schedule-runner.md ("Catch-up")
'use strict';

const test         = require('node:test');
const assert       = require('node:assert/strict');
const fs           = require('fs');
const os           = require('os');
const path         = require('path');
const EventEmitter = require('events');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-catch-up-')));
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT;
delete process.env.SWITCHBOARD_DATA_DIR;

const { startScheduler, claimScheduleMinute, scanSchedules } = require('../schedule-runner');

const STATE_DIR = path.join(ROOT, 'data', 'schedule-state');
const PROJECT = path.join(ROOT, 'project');
const COMMANDS = path.join(PROJECT, '.claude', 'commands');
const FOLDER = path.join(ROOT, '.claude', 'projects', '-project');

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const at = (day, hour, minute, second = 0) => new Date(2026, 0, day, hour, minute, second).getTime();

function writeSchedule({ cron, catchUp = true, file = 'schedule-report.md', catchUpLine }) {
  const lines = ['---', 'name: Report', `cron: ${cron}`];
  if (catchUpLine !== undefined) lines.push(catchUpLine);
  else if (catchUp) lines.push('catch-up: true');
  lines.push('---', '', 'Write the report.', '');
  fs.writeFileSync(path.join(COMMANDS, file), lines.join('\n'));
}

function rig(schedule) {
  for (const dir of [path.join(ROOT, 'data'), path.join(ROOT, '.claude'), PROJECT]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(COMMANDS, { recursive: true });
  fs.mkdirSync(FOLDER, { recursive: true });
  fs.writeFileSync(path.join(FOLDER, 'seed.jsonl'), JSON.stringify({ type: 'user', cwd: PROJECT }) + '\n');
  if (schedule) writeSchedule(schedule);

  const runs = [];
  const pending = [];
  const lines = [];
  const resume = new EventEmitter();
  const log = {
    info: (...a) => lines.push(a.join(' ')),
    warn: (...a) => lines.push(a.join(' ')),
    error: (...a) => lines.push(a.join(' ')),
  };
  let hold = false;
  const run = (argv, cwd, name, onDone) => {
    runs.push({ argv, cwd, name });
    if (hold) pending.push(onDone); else onDone();
  };
  return {
    runs, lines, resume,
    holdRuns() { hold = true; },
    finishRuns() { hold = false; pending.splice(0).forEach((done) => done()); },
    start: (stateDir = STATE_DIR) => startScheduler(log, run, { resumeSource: resume, stateDir }),
    firstMessages: () => fs.readdirSync(FOLDER)
      .filter((f) => f !== 'seed.jsonl')
      .map((f) => JSON.parse(fs.readFileSync(path.join(FOLDER, f), 'utf8').split('\n')[0]).message.content),
  };
}

function fakeClock(t, now) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now });
}

test('catch-up: three missed daily runs while Switchboard was closed give one run at the next launch', (t) => {
  const r = rig({ cron: '0 20 * * *' });
  fakeClock(t, at(5, 12, 0, 30));
  r.start()();

  t.mock.timers.setTime(at(8, 9, 0, 30));
  const stop = r.start();
  assert.equal(r.runs.length, 1, 'the launch catches up once');
  t.mock.timers.tick(10 * 60_000);
  stop();

  assert.equal(r.runs.length, 1, 'no further run for the other missed days');
  assert.ok(!r.lines.some((l) => l.includes('already triggered')), 'the minute already run is not reconsidered');
  assert.ok(r.lines.some((l) => l.includes('[schedule] Catching up: Report') && l.includes(new Date(at(7, 20, 0)).toISOString())),
    'the log line names the catch-up and the minute it was due');
  const [first] = r.firstMessages();
  assert.match(first, /^Scheduled Task \(catch-up: due /);
  assert.ok(first.includes(new Date(at(7, 20, 0)).toISOString()), 'the session says when the run was due');
  assert.ok(first.endsWith('Write the report.'));
});

test('catch-up: without `catch-up: true` a minute missed while closed is still skipped', (t) => {
  const r = rig({ cron: '0 20 * * *', catchUp: false });
  fakeClock(t, at(5, 12, 0, 30));
  r.start()();

  t.mock.timers.setTime(at(8, 9, 0, 30));
  const stop = r.start();
  t.mock.timers.tick(10 * 60_000);
  stop();

  assert.equal(r.runs.length, 0);
  assert.equal(fs.existsSync(STATE_DIR), false, 'nothing is recorded for a schedule that did not opt in');
});

test('catch-up: a schedule seen for the first time does not catch up', (t) => {
  const r = rig({ cron: '0 20 * * *' });
  fakeClock(t, at(8, 9, 0, 30));
  const stop = r.start();
  t.mock.timers.tick(10 * 60_000);
  stop();

  assert.equal(r.runs.length, 0);
});

test('catch-up: the record survives a restart and lives outside the schedule file', (t) => {
  const r = rig({ cron: '0 20 * * *' });
  const before = fs.readFileSync(path.join(COMMANDS, 'schedule-report.md'), 'utf8');
  fakeClock(t, at(5, 19, 59, 30));
  const stop = r.start();
  t.mock.timers.tick(60_000);
  stop();

  assert.equal(r.runs.length, 1, 'the on-time run');
  assert.equal(fs.readFileSync(path.join(COMMANDS, 'schedule-report.md'), 'utf8'), before);
  assert.equal(fs.readdirSync(STATE_DIR).length, 1, 'one record for the schedule');
});

test('catch-up: a suspend over the due minute gives one run on resume', (t) => {
  const r = rig({ cron: '0 20 * * *' });
  fakeClock(t, at(5, 19, 30, 30));
  const stop = r.start();

  t.mock.timers.setTime(at(5, 22, 0, 10));
  r.resume.emit('resume');
  assert.equal(r.runs.length, 1, 'the resume catches up before any tick');
  t.mock.timers.tick(5 * 60_000);
  assert.equal(r.runs.length, 1, 'the late tick after the resume does not run it again');

  stop();
  t.mock.timers.setTime(at(6, 22, 0, 10));
  r.resume.emit('resume');
  assert.equal(r.runs.length, 1, 'a stopped scheduler no longer listens for resume');
});

test('catch-up: nothing runs when the cron did not match within the gap, once when it matched only there', (t) => {
  const r = rig({ cron: '0 3 * * *' });
  fakeClock(t, at(5, 12, 0, 30));
  r.start()();

  t.mock.timers.setTime(at(6, 2, 0, 30));
  r.start()();
  assert.equal(r.runs.length, 0, '12:00 to 02:00 holds no 03:00');

  t.mock.timers.setTime(at(6, 4, 0, 30));
  r.start()();
  assert.equal(r.runs.length, 1, '02:00 to 04:00 holds 03:00, and 04:00 itself does not match');
});

test('catch-up: a due minute older than seven days is not caught up', (t) => {
  const r = rig({ cron: '0 20 1 * *' });
  fakeClock(t, at(1, 12, 0, 30));
  r.start()();

  t.mock.timers.setTime(at(9, 12, 0, 30));
  r.start()();
  assert.equal(r.runs.length, 0, 'Jan 1 20:00 lies 7 days 16 hours back');
});

test('catch-up: a due minute within seven days is caught up', (t) => {
  const r = rig({ cron: '0 20 1 * *' });
  fakeClock(t, at(1, 12, 0, 30));
  r.start()();

  t.mock.timers.setTime(at(8, 12, 0, 30));
  r.start()();
  assert.equal(r.runs.length, 1, 'Jan 1 20:00 lies 6 days 16 hours back');
});

test('catch-up: a tick in the same minute as a catch-up does not run the task again', (t) => {
  const r = rig({ cron: '0 20 * * *' });
  fakeClock(t, at(5, 19, 0, 30));
  const stop = r.start();

  t.mock.timers.setTime(at(5, 20, 0, 5));
  r.resume.emit('resume');
  assert.equal(r.runs.length, 1);
  t.mock.timers.tick(30_000);
  assert.equal(r.runs.length, 1, 'the overdue tick lands in 20:00 too');
  t.mock.timers.tick(2 * 60_000);
  stop();
  assert.equal(r.runs.length, 1);
  assert.ok(r.lines.some((l) => l.includes('[schedule] Triggering: Report')), 'a run in its own minute is not labelled a catch-up');
  assert.match(r.firstMessages()[0], /^Scheduled Task: /);
});

test('catch-up: a schedule without catch-up does not run on resume, even in its own minute', (t) => {
  const r = rig({ cron: '0 20 * * *', catchUp: false });
  fakeClock(t, at(5, 19, 0, 30));
  const stop = r.start();

  t.mock.timers.setTime(at(5, 20, 0, 5));
  r.resume.emit('resume');
  assert.equal(r.runs.length, 0);
  t.mock.timers.tick(30_000);
  stop();
  assert.equal(r.runs.length, 1, 'the tick runs it, as before');
});

test('catch-up: a catch-up while the previous run is still going is skipped, not queued', (t) => {
  const r = rig({ cron: '0 20 * * *' });
  r.holdRuns();
  fakeClock(t, at(5, 19, 59, 30));
  const stop = r.start();
  t.mock.timers.tick(60_000);
  assert.equal(r.runs.length, 1, 'the 20:00 run, still going');

  t.mock.timers.setTime(at(6, 21, 0, 10));
  r.resume.emit('resume');
  assert.equal(r.runs.length, 1);
  assert.ok(r.lines.some((l) => l.includes('Skipping Report') && l.includes('still running')));

  r.finishRuns();
  t.mock.timers.tick(5 * 60_000);
  stop();
  assert.equal(r.runs.length, 1, 'the skipped minute is not run once the previous run ends');
});

test('catch-up: two schedulers on one record run a due minute once', (t) => {
  const r = rig({ cron: '0 20 * * *' });
  fakeClock(t, at(5, 19, 59, 30));
  const stopA = r.start();
  const stopB = r.start();
  t.mock.timers.tick(60_000);
  assert.equal(r.runs.length, 1, 'on time');

  stopA(); stopB();
  t.mock.timers.setTime(at(6, 21, 0, 30));
  const stopC = r.start();
  const stopD = r.start();
  stopC(); stopD();
  assert.equal(r.runs.length, 2, 'one catch-up for the two launches');
});

test('catch-up: a minute claimed by another scheduler after the record was read is not run', (t) => {
  const r = rig({ cron: '0 20 * * *', file: 'schedule-a.md' });
  writeSchedule({ cron: '0 20 * * *', file: 'schedule-b.md' });
  fakeClock(t, at(5, 12, 0, 30));
  r.start()();

  const due = at(7, 20, 0);
  const keyOf = (file) => require('crypto').createHash('sha256').update(path.join(COMMANDS, file)).digest('hex').slice(0, 16);
  const runs = [];
  const lines = [];
  const log = { info: (...a) => lines.push(a.join(' ')), warn() {}, error() {} };
  const run = (argv, cwd, name, onDone) => {
    runs.push(name);
    for (const file of ['schedule-a.md', 'schedule-b.md']) {
      try { fs.writeFileSync(path.join(STATE_DIR, `${keyOf(file)}-${due}.json`), '{}', { flag: 'wx' }); } catch {}
    }
    onDone();
  };
  t.mock.timers.setTime(at(8, 9, 0, 30));
  startScheduler(log, run, { stateDir: STATE_DIR })();

  assert.equal(runs.length, 1, 'the second schedule finds its minute taken');
  assert.ok(lines.some((l) => l.includes('already triggered for that minute')));
});

test('claimScheduleMinute: the first claim of a minute wins, a second one is refused', () => {
  rig();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const minute = at(5, 20, 0);
  assert.equal(claimScheduleMinute(STATE_DIR, '0123456789abcdef', minute, {}), true);
  assert.equal(claimScheduleMinute(STATE_DIR, '0123456789abcdef', minute, {}), false);
  assert.equal(claimScheduleMinute(STATE_DIR, '0123456789abcdef', minute + 60_000, {}), true);
});

test('catch-up: a renamed schedule file is a new schedule and does not catch up', (t) => {
  const r = rig({ cron: '0 20 * * *' });
  fakeClock(t, at(5, 12, 0, 30));
  r.start()();

  fs.renameSync(path.join(COMMANDS, 'schedule-report.md'), path.join(COMMANDS, 'schedule-daily.md'));
  t.mock.timers.setTime(at(8, 9, 0, 30));
  r.start()();
  assert.equal(r.runs.length, 0);
});

test('catch-up: when the record cannot be read the schedule still runs on its minute', (t) => {
  const r = rig({ cron: '0 20 * * *' });
  fs.mkdirSync(path.dirname(STATE_DIR), { recursive: true });
  fs.writeFileSync(STATE_DIR, 'not a directory');
  fakeClock(t, at(5, 19, 59, 30));
  const stop = r.start();
  t.mock.timers.tick(60_000);
  stop();

  assert.equal(r.runs.length, 1);
  assert.ok(r.lines.some((l) => l.includes('[schedule]') && l.includes('catch-up')), 'the failure is logged');
});

test('catch-up: when the record cannot be written the schedule still runs on its minute', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, (t) => {
  const r = rig({ cron: '0 20 * * *' });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.chmodSync(STATE_DIR, 0o555);
  t.after(() => fs.chmodSync(STATE_DIR, 0o755));
  fakeClock(t, at(5, 19, 59, 30));
  const stop = r.start();
  t.mock.timers.tick(60_000);
  stop();

  assert.equal(r.runs.length, 1);
  assert.ok(r.lines.some((l) => l.includes('Cannot keep the catch-up record of Report')));
});

test('catch-up: a schedule first seen in its own minute still runs on time', (t) => {
  const r = rig();
  fakeClock(t, at(5, 19, 59, 30));
  const stop = r.start();
  t.mock.timers.tick(10_000);
  writeSchedule({ cron: '0 20 * * *' });
  t.mock.timers.tick(60_000);
  stop();

  assert.equal(r.runs.length, 1, 'the 20:00 tick is the first to see the file');
  assert.ok(r.lines.some((l) => l.includes('[schedule] Triggering: Report')));
});

test('catch-up: after the clock is set back, the schedule runs at its minute again', (t) => {
  const r = rig({ cron: '0 20 * * *' });
  fakeClock(t, at(5, 19, 59, 30));
  let stop = r.start();
  t.mock.timers.tick(60_000);
  stop();
  assert.equal(r.runs.length, 1, 'Jan 5 20:00, recorded');

  t.mock.timers.setTime(at(4, 19, 59, 30));
  stop = r.start();
  t.mock.timers.tick(60_000);
  stop();
  assert.equal(r.runs.length, 2, 'Jan 4 20:00 after the clock went back a day');
  assert.ok(r.lines.some((l) => l.includes('ahead of the clock')), 'the reset is logged');
});

test('catch-up: a clock booted fast that catches up early does not silence the real due minute', (t) => {
  const r = rig({ cron: '0 20 * * *' });
  fakeClock(t, at(5, 12, 0, 30));
  r.start()();

  t.mock.timers.setTime(at(5, 20, 30, 30));
  let stop = r.start();
  assert.equal(r.runs.length, 1, 'caught up early on a clock two hours fast');
  stop();

  t.mock.timers.setTime(at(5, 18, 30, 30));
  stop = r.start();
  t.mock.timers.tick(90 * 60_000);
  stop();
  assert.equal(r.runs.length, 2, 'the real 20:00 runs after the clock is corrected');
});

test('catch-up: each instance keeps its own record, so a second instance does not take the first one\'s minute', (t) => {
  const r = rig({ cron: '0 20 * * *' });
  const otherStateDir = path.join(ROOT, 'data-other', 'schedule-state');
  t.after(() => fs.rmSync(path.dirname(otherStateDir), { recursive: true, force: true }));
  fakeClock(t, at(5, 19, 59, 30));
  const stopA = r.start();
  const stopB = r.start(otherStateDir);
  t.mock.timers.tick(60_000);
  stopA(); stopB();

  assert.equal(r.runs.length, 2, 'each instance runs its minute, like a schedule without catch-up');
  assert.equal(fs.readdirSync(STATE_DIR).length, 1);
  assert.equal(fs.readdirSync(otherStateDir).length, 1);
});

test('catch-up: a schedule without catch-up does not run at startup, even in its own minute', (t) => {
  const r = rig({ cron: '0 20 * * *', catchUp: false });
  fakeClock(t, at(5, 20, 0, 10));
  const stop = r.start();
  assert.equal(r.runs.length, 0);
  stop();
});

for (const [line, expected] of [
  [null, false],
  ['catch-up: false', false],
  ['catch-up: no', false],
  ['catch-up: not true', false],
  ['catch-up: true', true],
  ['catch-up: True', true],
  ['catch-up: TRUE', true],
  ['catch-up: "true"', true],
  ["catch-up: 'true'", true],
]) {
  test(`catch-up: front matter ${line === null ? 'without the key' : `\`${line}\``} ${expected ? 'opts in' : 'does not opt in'}`, () => {
    rig();
    writeSchedule({ cron: '0 20 * * *', catchUpLine: line === null ? '' : line });
    const [schedule] = scanSchedules();
    assert.equal(schedule.catchUp, expected);
  });
}

test('catch-up: an instance with SWITCHBOARD_DATA_DIR set does not catch up, and says so once', (t) => {
  const r = rig({ cron: '0 20 * * *' });
  fakeClock(t, at(5, 12, 0, 30));
  r.start()();

  process.env.SWITCHBOARD_DATA_DIR = path.join(ROOT, 'isolated');
  t.after(() => { delete process.env.SWITCHBOARD_DATA_DIR; });
  t.mock.timers.setTime(at(8, 9, 0, 30));
  const stop = r.start();
  t.mock.timers.tick(5 * 60_000);
  stop();

  assert.equal(r.runs.length, 0, 'the runs missed since Jan 5 are not caught up');
  assert.equal(r.lines.filter((l) => l.includes('catch-up is off')).length, 1);
});

test('catch-up: an instance with SWITCHBOARD_DATA_DIR set runs an opted-in schedule on cron, without a record', (t) => {
  const r = rig({ cron: '0 20 * * *' });
  process.env.SWITCHBOARD_DATA_DIR = path.join(ROOT, 'isolated');
  t.after(() => { delete process.env.SWITCHBOARD_DATA_DIR; });
  fakeClock(t, at(5, 19, 59, 30));
  const stop = r.start();
  t.mock.timers.tick(60_000);
  stop();

  assert.equal(r.runs.length, 1);
  assert.equal(fs.existsSync(STATE_DIR), false);
  assert.ok(!r.lines.some((l) => l.includes('Cannot read')), 'no warning on each tick');
});
