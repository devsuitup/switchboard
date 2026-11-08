'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { encodeProjectPath } = require('../../../encode-project-path');
const { listScheduleFiles, nextCronMatch, describeCron, readScheduleStateOnly, latestCronMatch, scheduleStateKey, resolveScheduleSandbox } = require('./schedule-runner');
const MINUTE_MS = 60000;

async function hasAssistant(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type === 'assistant' || (entry.type === 'message' && entry.role === 'assistant')) return true;
    }
    return false;
  } catch { return null; }
  finally { lines.close(); stream.destroy(); }
}

async function buildScheduleList(deps) {
  const { scheduleProjects, getCachedByFolder, isScheduleRunLive, catchUpActive, stateDir, projectsDir,
    getSetting = () => null, defaultSandbox = false, isArchived = () => false, isKnownProject = () => false,
    now: clock = Date.now } = deps;
  const now = clock();
  const nowMinute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const projectPaths = await scheduleProjects().list();
  const files = listScheduleFiles(projectPaths, deps);
  let state = new Map();
  if (catchUpActive) {
    try { state = readScheduleStateOnly(stateDir); } catch { state = null; }
  }
  const projects = [];
  for (const projectPath of projectPaths) {
    const archived = isArchived(projectPath);
    const folders = new Set([encodeProjectPath(projectPath)]);
    try { folders.add(encodeProjectPath(fs.realpathSync(projectPath))); } catch {}
    const cached = new Map();
    for (const folder of folders) {
      for (const row of await getCachedByFolder(folder)) {
        if (!cached.has(row.sessionId)) cached.set(row.sessionId, { row, folder });
      }
    }
    const schedules = [];
    for (const schedule of files.filter(s => s.projectPath === projectPath)) {
      const rows = [...cached.values()].filter(({ row }) => row.scheduleSlug === schedule.slug)
        .sort((a, b) => Date.parse(b.row.created) - Date.parse(a.row.created)).slice(0, 20);
      const runs = [];
      for (const { row, folder } of rows) {
        runs.push({ sessionId: row.sessionId, created: row.created, messageCount: row.messageCount,
          replied: await hasAssistant(path.join(projectsDir, folder, `${row.sessionId}.jsonl`)),
          running: isScheduleRunLive(row.sessionId), result: null });
      }
      let catchUpDueMs = null;
      const runnable = !schedule.problems.some(problem => !problem.startsWith('slug shared with '));
      if (catchUpActive && state && !archived && runnable && schedule.enabled && schedule.prompt && schedule.catchUp && schedule.cron) {
        const recorded = state.get(scheduleStateKey(schedule));
        const handled = !recorded || recorded.handled > nowMinute ? nowMinute - MINUTE_MS : recorded.handled;
        catchUpDueMs = latestCronMatch(schedule.cron, Math.max(handled, nowMinute - 7 * 24 * 60 * MINUTE_MS), nowMinute);
      }
      schedules.push({ ...schedule, cronText: describeCron(schedule.cron), nextRunMs: runnable && schedule.cron ? nextCronMatch(schedule.cron, now) : null,
        catchUpDueMs, runs });
    }
    projects.push({ projectPath, shortName: path.basename(projectPath), archived,
      sandboxed: resolveScheduleSandbox(projectPath, getSetting, defaultSandbox), known: isKnownProject(projectPath), schedules });
  }
  return { now, catchUpActive, projects };
}

module.exports = { buildScheduleList };
