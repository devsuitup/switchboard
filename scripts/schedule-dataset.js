#!/usr/bin/env node
// Writes a fake HOME and data directory holding projects, schedules and recorded runs — see docs/testing-a-pr.md
'use strict';

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { encodeProjectPath } = require('../encode-project-path');

const DAY_MS = 24 * 60 * 60 * 1000;

const SCHEDULES = {
  alpha: [
    { file: 'schedule-weekly-audit.md', name: 'Weekly memory audit', cron: '17 3 * * 1',
      runs: [{ daysAgo: 2, outcome: 'exited', exitCode: 0 }, { daysAgo: 9, outcome: 'exited', exitCode: 1, failure: 'exit' }] },
    { file: 'schedule-daily-collect.md', name: 'CI metrics (daily collect)', cron: '7 3 * * 1-5', catchUp: true,
      runs: [{ daysAgo: 1, outcome: 'exited', exitCode: 0 }, { daysAgo: 2, outcome: 'signal', signal: 'SIGTERM' },
        { daysAgo: 3, outcome: 'refused', error: 'project archived' }, { daysAgo: 4, result: false }] },
    { file: 'schedule-logout-check.md', name: 'Check the logout-crash fix', cron: '0 3 * * *', enabled: false },
    { file: 'schedule-every-quarter-hour.md', name: 'Every quarter hour (never due: day 31 of February)', cron: '*/15 * 31 2 *' },
    { file: 'schedule-bad-cron.md', name: 'Malformed expression', cron: '61 * * * *' },
    { file: 'schedule-background.md', name: 'Joinable background run', cron: '37 3 * * 0', runAsBackground: true },
    { file: 'schedule-linked.md', name: 'Linked from a shared folder', cron: '47 3 * * 1', linked: true,
      runs: [{ daysAgo: 6, outcome: 'exited', exitCode: 0 }] },
    { file: 'schedule-a-very-long-file-name-that-wraps-in-a-narrow-sidebar.md',
      name: 'A schedule whose display name is long enough to wrap onto several lines in the sidebar', cron: '57 3 1 * *' },
  ],
  beta: [
    { file: 'schedule-nightly.md', name: 'Nightly', cron: '27 3 * * *', runs: [{ daysAgo: 1, outcome: 'exited', exitCode: 0 }] },
  ],
  gamma: [],
};

function usage() {
  return 'Usage: node scripts/schedule-dataset.js <fake-home> [--data-dir <dir>] [--now <ISO date>]\n'
    + 'Writes projects, schedules and recorded runs under <fake-home> (default data dir: <fake-home>/.switchboard-dev).';
}

function parseArgs(argv) {
  const args = { home: null, dataDir: null, now: Date.now() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--data-dir') args.dataDir = argv[++i];
    else if (arg === '--now') args.now = Date.parse(argv[++i]);
    else if (arg === '-h' || arg === '--help') return null;
    else if (!args.home && !arg.startsWith('-')) args.home = arg;
    else throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }
  if (!args.home) return null;
  if (!Number.isFinite(args.now)) throw new Error('--now must be a date Date.parse reads');
  args.home = path.resolve(args.home);
  args.dataDir = path.resolve(args.dataDir || path.join(args.home, '.switchboard-dev'));
  return args;
}

function frontMatter(schedule) {
  const lines = ['---', `name: ${schedule.name}`, `cron: ${schedule.cron}`];
  if (schedule.enabled === false) lines.push('enabled: false');
  if (schedule.catchUp) lines.push('catch-up: true');
  if (schedule.runAsBackground) lines.push('run-as-background: true');
  lines.push('---', '', `Fixture prompt for "${schedule.name}". Reply with one line.`, '');
  return lines.join('\n');
}

function slugOf(file) {
  return file.replace(/^schedule-/, '').replace(/\.md$/, '');
}

function writeTranscript(folder, projectPath, slug, prompt, startedMs, reply) {
  const sessionId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const started = new Date(startedMs).toISOString();
  const lines = [{ type: 'user', parentUuid: null, uuid: userId, sessionId, cwd: projectPath, slug, scheduleSlug: slug,
    timestamp: started, message: { role: 'user', content: `Scheduled Task: ${prompt}` } }];
  if (reply) {
    lines.push({ type: 'assistant', parentUuid: userId, uuid: crypto.randomUUID(), sessionId, cwd: projectPath,
      timestamp: new Date(startedMs + 30000).toISOString(),
      message: { role: 'assistant', model: 'fixture', stop_reason: 'end_turn', content: [{ type: 'text', text: reply }] } });
  }
  fs.writeFileSync(path.join(folder, `${sessionId}.jsonl`), lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  return sessionId;
}

function writeResult(runsDir, filePath, schedule, slug, sessionId, startedMs, run) {
  const key = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16);
  const record = { v: 1, sessionId, file: filePath, name: schedule.name, slug, manual: false, dueMs: null,
    startedAt: new Date(startedMs).toISOString(), endedAt: new Date(startedMs + 60000).toISOString(),
    outcome: run.outcome, exitCode: run.exitCode ?? null, signal: run.signal ?? null,
    failure: run.failure ?? null, error: run.error ?? null };
  fs.writeFileSync(path.join(runsDir, `${key}-${startedMs}-${sessionId}.json`), JSON.stringify(record) + '\n');
}

function createDataset({ home, dataDir, now }) {
  if (fs.existsSync(home) && fs.readdirSync(home).length) throw new Error(`${home} is not empty; give a new directory`);
  const runsDir = path.join(dataDir, 'schedule-runs');
  const shared = path.join(home, 'shared');
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(shared, { recursive: true });
  const projects = [];
  for (const [name, schedules] of Object.entries(SCHEDULES)) {
    const projectPath = path.join(home, 'work', name);
    const commands = path.join(projectPath, '.claude', 'commands');
    const folder = path.join(home, '.claude', 'projects', encodeProjectPath(projectPath));
    fs.mkdirSync(commands, { recursive: true });
    fs.mkdirSync(folder, { recursive: true });
    if (spawnSync('git', ['init', '-q', projectPath]).status !== 0) fs.mkdirSync(path.join(projectPath, '.git'));
    writeTranscript(folder, projectPath, null, 'New project', now - 30 * DAY_MS, null);
    for (const schedule of schedules) {
      const slug = slugOf(schedule.file);
      const filePath = path.join(commands, schedule.file);
      if (schedule.linked) {
        const target = path.join(shared, schedule.file);
        fs.writeFileSync(target, frontMatter(schedule));
        fs.symlinkSync(target, filePath);
      } else {
        fs.writeFileSync(filePath, frontMatter(schedule));
      }
      for (const run of schedule.runs || []) {
        const startedMs = Math.floor((now - run.daysAgo * DAY_MS) / 60000) * 60000;
        const reply = run.outcome === 'exited' && run.exitCode === 0 ? 'Done: nothing to report.' : null;
        const sessionId = writeTranscript(folder, projectPath, slug, `Fixture prompt for "${schedule.name}".`, startedMs, reply);
        if (run.result !== false) writeResult(runsDir, filePath, schedule, slug, sessionId, startedMs, run);
      }
    }
    projects.push(projectPath);
  }
  return { projects, runsDir };
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args) {
      console.log(usage());
      process.exit(2);
    }
    const { projects } = createDataset(args);
    console.log(`Fake HOME: ${args.home}\nData dir: ${args.dataDir}\nProjects (git checkouts with schedules are registered at first launch):\n${projects.map(p => `  ${p}`).join('\n')}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { SCHEDULES, createDataset, parseArgs };
