'use strict';

/**
 * @typedef {Object} TranscriptStore
 * @property {boolean} groupsByProject Whether every transcript in a folder shares a project.
 * @property {function(): string} sessionsRoot Absolute transcript root directory.
 * @property {function(): string[]} listFolders Folder keys under sessionsRoot().
 * @property {function(string): string} folderPath Folder key to absolute directory.
 * @property {function(string): (string|null)} folderForProject Absolute project path to folder key; null for ungrouped stores.
 * @property {function(string): string[]} listTranscripts Absolute folder directory to absolute transcript paths.
 * @property {function(string): (string|null)} sessionIdFromPath Transcript path to filename identity; null if unrecognized.
 * @property {function(Object): (string|null)} transcriptPath Cached row (sessionId, folder, sessionFile) to absolute path.
 */
/**
 * @typedef {Object} TranscriptParser
 * @property {function(string, string, string, Object=): (Object|null)} readSessionFile Absolute transcript path, folder key, project path and optional previous row to metadata.
 * @property {function(string): (string|null)} deriveProjectPath Absolute folder directory to project path; null for ungrouped stores.
 * @property {function(string): string} resolveWorktreePath Absolute worktree path to repository path.
 */
/**
 * @typedef {Object} Launcher
 * @property {function(): boolean} available Whether transcript storage exists; does not probe the CLI binary.
 * @property {function({sessionId: string=, isNew: boolean, options: Object=}): string[]} buildLaunchArgs Launch request to argv; sessionId is required for resume, but a fresh launch may use a temporary id or omit it.
 * @property {function({isNew: boolean, options: Object=}): boolean} needsIdDetection Whether a launch must discover its real id; isNew is the resolved fresh-launch decision and options.forkFrom identifies a fork.
 */
/**
 * @typedef {Object} ActivityClassifier
 * @property {function(string, Object=): {busy: boolean, idle: boolean, via: (string|null)}} classifyTitleActivity Terminal title and optional classifier context to activity signals.
 */
/**
 * @typedef {Object} UsageProvider
 * @property {function(Object): Object} getUsage Provider-specific usage request to usage data.
 */
/**
 * @typedef {Object} Capabilities
 * @property {boolean} subagents
 * @property {boolean} continuations
 * @property {boolean} liveElsewhere
 * @property {boolean} bgJobs
 * @property {boolean} ideBridge
 * @property {boolean} sandbox
 * @property {boolean} schedule
 * @property {boolean} remote
 */
/**
 * @typedef {TranscriptStore & TranscriptParser & Launcher & ActivityClassifier & {
 * id: string, label: string, binary: string, folderPrefix: (string|null),
 * capabilities: Capabilities, usageProvider?: UsageProvider
 * }} Harness
 */

const CAPABILITIES = Object.freeze(['subagents', 'continuations', 'liveElsewhere', 'bgJobs', 'ideBridge', 'sandbox', 'schedule', 'remote']);
const REQUIRED_METHODS = ['available', 'sessionsRoot', 'listFolders', 'folderPath', 'folderForProject',
  'listTranscripts', 'transcriptPath', 'readSessionFile', 'deriveProjectPath', 'resolveWorktreePath',
  'buildLaunchArgs', 'classifyTitleActivity', 'sessionIdFromPath', 'needsIdDetection'];

function assertHarness(harness) {
  for (const key of ['id', 'label', 'binary']) {
    if (typeof harness?.[key] !== 'string' || !harness[key]) throw new TypeError(`Invalid harness ${key}`);
  }
  if (harness.folderPrefix !== null && (typeof harness.folderPrefix !== 'string' || !harness.folderPrefix)) {
    throw new TypeError('Invalid harness folderPrefix');
  }
  if (typeof harness.groupsByProject !== 'boolean') throw new TypeError('Invalid harness groupsByProject');
  for (const name of REQUIRED_METHODS) {
    if (typeof harness[name] !== 'function') throw new TypeError(`Invalid harness method ${name}`);
  }
  for (const name of CAPABILITIES) {
    if (typeof harness.capabilities?.[name] !== 'boolean') throw new TypeError(`Invalid harness capability ${name}`);
  }
  if (harness.usageProvider !== undefined && typeof harness.usageProvider?.getUsage !== 'function') {
    throw new TypeError('Invalid harness usageProvider');
  }
  return harness;
}

module.exports = { CAPABILITIES, assertHarness };
