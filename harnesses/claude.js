'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const transcripts = require('../read-session-file');
const projects = require('../derive-project-path');
const { encodeProjectPath } = require('../encode-project-path');
const { resolveContinuations, resolveContinuationsSync } = require('../session-continuations');
const { liveElsewhere } = require('../cli-session-state');
const { getCachedJobs } = require('../src/main/bg-agents/bg-agents');
const { resolveWindowsClaude } = require('../claude-binary');
const { classifyTitleActivity } = require('../classify-title-activity');
const { normalizeBrowserSettings } = require('../public/setting-defaults');

function parseAddDirs(value) {
  if (!value) return [];
  return String(value).split(',').map(dir => dir.trim()).filter(Boolean);
}

function launchName(name) {
  return typeof name === 'string' && name ? ['--name', name] : [];
}

function buildLaunchArgs({ sessionId, isNew, options, name }) {
  const args = [];
  if (options?.forkFrom) args.push('--resume', String(options.forkFrom), '--fork-session');
  else if (isNew) args.push('--session-id', String(sessionId), ...launchName(name));
  else args.push('--resume', String(sessionId));
  if (options?.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
  else if (options?.permissionMode) args.push('--permission-mode', String(options.permissionMode));
  if (isNew && options?.worktree) {
    args.push('--worktree');
    if (options.worktreeName) args.push(String(options.worktreeName));
  }
  if (normalizeBrowserSettings(options, () => {}).browserMode === 'claude-in-chrome') args.push('--chrome');
  for (const dir of parseAddDirs(options?.addDirs)) args.push('--add-dir', dir);
  if (options?.appendSystemPrompt) args.push('--append-system-prompt', String(options.appendSystemPrompt));
  return args;
}

function createClaudeHarness({ projectsDir = path.join(os.homedir(), '.claude', 'projects') } = {}) {
  const folderPath = folder => path.join(projectsDir, folder);
  return {
    id: 'claude', label: 'Claude', binary: 'claude', folderPrefix: null, groupsByProject: true,
    capabilities: Object.freeze({ subagents: true, continuations: true, liveElsewhere: true, bgJobs: true,
      ideBridge: true, sandbox: true, schedule: true, remote: true }),
    sessionsRoot: () => projectsDir,
    available: () => fs.existsSync(projectsDir),
    listFolders() {
      try {
        return fs.readdirSync(projectsDir, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== '.git').map(entry => entry.name);
      } catch { return []; }
    },
    folderPath,
    folderForProject: encodeProjectPath,
    listTranscripts: dir => transcripts.enumerateSessionFiles(dir).map(entry => entry.filePath),
    sessionIdFromPath: filePath => path.basename(filePath, '.jsonl'),
    transcriptPath: row => row.sessionFile || transcripts.resolveJsonlPath(projectsDir, row),
    readSessionFile: transcripts.readSessionFile,
    deriveProjectPath: projects.deriveProjectPath,
    resolveWorktreePath: projects.resolveWorktreePath,
    enumerateSessionFiles: transcripts.enumerateSessionFiles,
    resolveContinuations, resolveContinuationsSync, liveElsewhere, getCachedJobs,
    resolveWindowsLaunch: resolveWindowsClaude,
    needsIdDetection: ({ options }) => !!options?.forkFrom,
    classifyTitleActivity, buildLaunchArgs, parseAddDirs,
  };
}

module.exports = { ...createClaudeHarness(), createClaudeHarness };
