'use strict';

const path = require('node:path');
const deletion = require('../../../worktree-delete');
const { canonicalPath, fail } = require('./project-delete-identity');

function createProjectDeleteWorktrees({ runGit, readActivity, now = Date.now }) {
  const check = budget => {
    if (budget.signal.aborted || now() >= budget.deadline) throw fail('DISCOVERY_TIMEOUT', 'Worktree preview timed out. Reopen Delete to retry.');
  };
  async function preview(project, budget) {
    if (project.alias !== null) throw fail('WORKTREE_UNAVAILABLE', 'Remote worktree removal is unavailable.');
    check(budget);
    const list = await runGit(['-C', project.projectPath, 'worktree', 'list', '--porcelain', '-z']);
    check(budget);
    const records = list.split('\0\0').filter(Boolean).map(value => value.split('\0'));
    if (records.length > Math.min(128, budget.limit) || records.some(fields => !fields[0].startsWith('worktree '))) {
      throw fail('DISCOVERY_LIMIT', 'Worktree registration is invalid or exceeds 128 entries. Review it with Git.');
    }
    const rows = [];
    for (const [index, fields] of records.entries()) {
      check(budget);
      const directory = fields[0].slice(9);
      if (!path.isAbsolute(directory)) throw fail('WORKTREE_UNAVAILABLE', 'Git returned a relative worktree path.');
      const candidate = canonicalPath(directory, null), owner = canonicalPath(project.projectPath, null);
      const row = { path: directory, branch: fields.find(field => field.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') || '(detached HEAD)',
        main: index === 0, projectDirectory: candidate === owner || owner.startsWith(candidate + '/'),
        removable: false, sessions: [], dirty: [], selected: false, statusKnown: false, sessionsKnown: false };
      if (row.main || row.projectDirectory) {
        row.reason = 'The main checkout and the selected project directory are always kept.';
        try {
          const status = await runGit(['-C', directory, 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
          row.dirty = status.split('\0').filter(Boolean); row.statusKnown = true;
          const activity = await readActivity({ alias: null, projectPath: directory }, budget);
          row.sessions = activity.sessions || []; row.jobs = activity.jobs || [];
          row.sessionsKnown = activity.complete === true && !activity.candidates?.length;
        } catch (error) { row.reason += ' Preview unavailable: ' + error.message; }
      }
      else {
        try {
          const status = await deletion.readStatus(directory, project.projectPath, runGit);
          check(budget);
          const activity = await readActivity({ alias: null, projectPath: directory }, budget);
          check(budget);
          Object.assign(row, status, { statusKnown: true, sessions: activity.sessions || [], jobs: activity.jobs || [],
            sessionsKnown: activity.complete === true && !activity.candidates?.length });
          if (activity.complete !== true || !Array.isArray(activity.sessions) || !Array.isArray(activity.jobs)
            || !Array.isArray(activity.candidates) || activity.candidates.length) row.reason = 'Worktree activity is uncertain. Check its sessions and Agents, then reopen Delete.';
          else if (activity.jobs.length) row.reason = 'Background jobs prevent worktree removal (#1090). Check the Agents view.';
          else if (activity.sessions.length) row.reason = 'Stop the sessions in this worktree first, then reopen Delete.';
          else if (status.locked || status.submodules?.length) row.reason = 'Locked worktrees and submodules require the dedicated Delete worktree dialog.';
          else row.removable = true;
        } catch (error) { row.reason = error.message; }
      }
      rows.push(row);
    }
    return rows;
  }
  async function remove(project, selected, record) {
    const budget = { signal: new AbortController().signal, deadline: now() + 15000, limit: 20000 };
    try {
      const current = await preview(project, budget);
      for (const row of selected) {
        const fresh = current.find(item => item.path === row.path);
        if (!fresh?.removable || fresh.main || fresh.projectDirectory || fresh.fingerprint !== row.fingerprint) {
          record({ path: row.path, state: 'failed', error: fresh?.reason || 'Worktree changed. Review a fresh preview before confirming again.' });
          return false;
        }
      }
    } catch (error) {
      record({ path: selected[0]?.path, state: 'failed', error: error.message }); return false;
    }
    for (const row of selected) {
      let result;
      try {
        result = await deletion.removeWorktree(row.path, project.projectPath, row, async () => {
          const current = await preview(project, { ...budget, deadline: now() + 15000 });
          const fresh = current.find(item => item.path === row.path);
          if (!fresh?.removable || fresh.main || fresh.projectDirectory) throw fail('WORKTREE_UNAVAILABLE', fresh?.reason || 'Worktree registration changed.');
          return fresh;
        }, runGit);
      } catch (error) { result = { ok: false, error: error.message }; }
      record({ path: row.path, state: result.ok ? 'removed' : 'failed', error: result.error });
      if (!result.ok) return false;
    }
    return true;
  }
  return { preview, remove };
}

module.exports = { createProjectDeleteWorktrees };
