// run-schedule-now-target.js — validation and target resolution for the
// run-schedule-now IPC action. Electron-free so it can be tested directly.
// See .ai/contexts/ipc-bridge.md, "IPC path-guard inventory".
'use strict';

const path = require('path');
const { resolveOnDisk } = require('./resolve-path-on-disk');

const SCHEDULE_FILENAME_RE = /^schedule-.*\.md$/i;

/**
 * Resolve and validate the file `run-schedule-now` was asked to run.
 *
 * @param {string}   filePath      - Path from the renderer, unvalidated.
 * @param {function} isPathAllowed - (resolvedPath: string) => boolean
 * @returns {{ok: true, realPath: string, projectPath: string} | {ok: false, error: string}}
 */
function resolveRunNowTarget(filePath, isPathAllowed) {
  if (typeof filePath !== 'string' || !filePath) {
    return { ok: false, error: 'invalid path' };
  }

  // The shape checks run on the requested location, not on the symlink-free
  // one. A schedule file is defined by the directory that *lists* it — the
  // project's .claude/commands — and a user who keeps their configuration in a
  // versioned dotfiles repo links it in from elsewhere on disk. Testing the
  // real path instead refused exactly those, with "not inside a project
  // .claude/commands directory", while the cron loop went on firing the same
  // file every week: the scheduler reads through the link, this guard did not.
  //
  // Nothing is relaxed by the move. The two path-guard duties stay where they
  // were: the file is still resolved on disk, and both the resolved file and
  // the project the run would be rooted at still have to pass isPathAllowed
  // below — a link pointing out of every allowed root is refused there, which
  // is what the "symlinked commands directory escaping the project" test
  // pins. What changes is only which string has to *look* like a schedule:
  // the one the renderer listed.
  const requested = path.resolve(filePath);

  if (!SCHEDULE_FILENAME_RE.test(path.basename(requested))) {
    return { ok: false, error: 'not a schedule file' };
  }

  const commandsDir = path.dirname(requested);
  const dotClaudeDir = path.dirname(commandsDir);

  if (path.basename(commandsDir) !== 'commands' || path.basename(dotClaudeDir) !== '.claude') {
    return { ok: false, error: 'not inside a project .claude/commands directory' };
  }

  const real = resolveOnDisk(requested);
  if (!real) {
    return { ok: false, error: 'file not found' };
  }

  // The spawn is rooted here, so it is resolved and allowlisted in its own
  // right rather than inferred from the file: with a linked-in schedule the
  // two live on different branches of the filesystem, and the project the run
  // belongs to is the one whose .claude/commands lists it.
  const projectPath = resolveOnDisk(path.dirname(dotClaudeDir));
  if (!projectPath) {
    return { ok: false, error: 'file not found' };
  }

  if (typeof isPathAllowed !== 'function' || !isPathAllowed(real) || !isPathAllowed(projectPath)) {
    return { ok: false, error: 'path not allowed' };
  }

  return { ok: true, realPath: real, projectPath };
}

module.exports = { resolveRunNowTarget };
