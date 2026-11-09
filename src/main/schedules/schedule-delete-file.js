'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { listScheduleFiles, scheduleFileUnlinked, scheduleStateKey, readScheduleStateOnly } = require('./schedule-runner');
const runResults = require('./schedule-run-results');

function deleteScheduleFile(filePath, { projectRoot, stateDir, runsDir }) {
  if (!scheduleFileUnlinked(projectRoot, filePath)) return { ok: false, error: 'linked file: edit it at its source' };
  try {
    const key = scheduleStateKey({ filePath });
    const state = readScheduleStateOnly(stateDir).get(key);
    fs.unlinkSync(filePath);
    for (const name of state?.files || []) {
      try { fs.unlinkSync(path.join(stateDir, name)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    runResults.pruneScheduleRunResults(runsDir, key, 0);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function deleteListedScheduleFile(filePath, { scheduleProjects, stateDir, runsDir }) {
  if (typeof filePath !== 'string') return { ok: false, error: 'invalid schedule path' };
  try {
    const schedule = listScheduleFiles(await scheduleProjects().list()).find(s => s.filePath === filePath);
    if (!schedule) return { ok: false, error: 'schedule is not listed' };
    return deleteScheduleFile(filePath, { projectRoot: schedule.projectPath, stateDir, runsDir });
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = { deleteScheduleFile, deleteListedScheduleFile };
