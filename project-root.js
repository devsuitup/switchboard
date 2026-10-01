// see .ai/contexts/bg-agents.md
'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const GIT_TIMEOUT_MS = 2000;
const CLAUDE_WORKTREE_RE = /^(.+?)([/\\]\.claude[/\\]worktrees[/\\][^/\\]+)(?:[/\\].*)?$/;

function projectRootFromPattern(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  const m = cwd.match(CLAUDE_WORKTREE_RE);
  return m ? m[1] : null;
}

function worktreeRootFromPattern(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  const m = cwd.match(CLAUDE_WORKTREE_RE);
  return m ? m[1] + m[2] : null;
}

function rootFromCommonDir(commonDir) {
  if (typeof commonDir !== 'string' || !commonDir) return null;
  const trimmed = commonDir.replace(/[/\\]+$/, '');
  return path.basename(trimmed) === '.git' ? path.dirname(trimmed) : null;
}

function gitEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (!k.startsWith('GIT_')) out[k] = v;
  return out;
}

function runGit(execFile, cwd, env) {
  return new Promise((resolve) => {
    try {
      execFile('git', ['-C', cwd, 'rev-parse', '--git-common-dir', '--show-toplevel'],
        { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, env: gitEnv(env) },
        (err, stdout) => resolve(err ? null : String(stdout || '')));
    } catch {
      resolve(null);
    }
  });
}

async function resolveProjectRoots(cwd, { execFile = childProcess.execFile, env = process.env } = {}) {
  if (typeof cwd !== 'string' || !cwd) return { projectRoot: null, worktreeRoot: null };
  const patternRoot = projectRootFromPattern(cwd);
  if (patternRoot) return { projectRoot: patternRoot, worktreeRoot: worktreeRootFromPattern(cwd) };
  const fallback = { projectRoot: cwd, worktreeRoot: cwd };
  let exists = false;
  try { exists = fs.statSync(cwd).isDirectory(); } catch {}
  if (!exists) return fallback;
  const out = await runGit(execFile, cwd, env);
  if (!out) return fallback;
  const [commonLine, topLine] = out.split(/\r?\n/).map(s => s.trim());
  const worktreeRoot = topLine ? path.resolve(cwd, topLine) : cwd;
  const projectRoot = (commonLine && rootFromCommonDir(path.resolve(cwd, commonLine))) || worktreeRoot;
  return { projectRoot, worktreeRoot };
}

module.exports = {
  projectRootFromPattern, worktreeRootFromPattern, rootFromCommonDir, resolveProjectRoots, gitEnv, GIT_TIMEOUT_MS,
};
