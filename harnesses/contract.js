'use strict';

/**
 * @typedef {Object} TranscriptStore
 * @property {function(): string} sessionsRoot
 * @property {function(): string[]} listFolders
 * @property {function(string): string} folderPath
 * @property {function(string): string} folderForProject
 * @property {function(string): string[]} listTranscripts
 * @property {function(Object): (string|null)} transcriptPath
 */
/**
 * @typedef {Object} TranscriptParser
 * @property {function(string, string, string, Object=): (Object|null)} readSessionFile
 * @property {function(string): (string|null)} deriveProjectPath
 * @property {function(string): string} resolveWorktreePath
 */
/**
 * @typedef {Object} Launcher
 * @property {function(): boolean} available
 * @property {function({sessionId: string, isNew: boolean, options: Object=}): string[]} buildLaunchArgs
 */
/**
 * @typedef {Object} ActivityClassifier
 * @property {function(string, Object=): {busy: boolean, idle: boolean, via: (string|null)}} classifyTitleActivity
 */
/**
 * @typedef {Object} UsageProvider
 * @property {function(Object): Object} getUsage
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
  'buildLaunchArgs', 'classifyTitleActivity'];

function assertHarness(harness) {
  for (const key of ['id', 'label', 'binary']) {
    if (typeof harness?.[key] !== 'string' || !harness[key]) throw new TypeError(`Invalid harness ${key}`);
  }
  if (harness.folderPrefix !== null && (typeof harness.folderPrefix !== 'string' || !harness.folderPrefix)) {
    throw new TypeError('Invalid harness folderPrefix');
  }
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
