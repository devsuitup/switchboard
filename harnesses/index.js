'use strict';

const claude = require('./claude');
const codex = require('./codex');
const { assertHarness } = require('./contract');
const { parseFolderKey } = require('../src/main/remote/remote-hosts');
const { getTranscriptsIndexMtimeMs } = require('../folder-index-state');

const HARNESSES = { [claude.id]: assertHarness(claude), [codex.id]: assertHarness(codex) };
const DEFAULT_HARNESS = claude.id;

function getHarness(runtime) {
  return Object.hasOwn(HARNESSES, runtime) ? HARNESSES[runtime] : HARNESSES[DEFAULT_HARNESS];
}

function allHarnesses() {
  return Object.values(HARNESSES);
}

function availableHarnesses() {
  return allHarnesses().filter(harness => harness.available());
}

function harnessForFolder(key) {
  const { folder } = parseFolderKey(key);
  return allHarnesses().find(harness => harness.folderPrefix && folder.startsWith(harness.folderPrefix)) || getHarness();
}

function transcriptPath(row) {
  return getHarness(row.runtime).transcriptPath(row);
}

// see .ai/contexts/cli-harnesses.md ("Picker, toggles and settings")
function disabledSet(disabledIds) {
  return new Set(Array.isArray(disabledIds) ? disabledIds.map(String) : []);
}

function enabledHarnesses(disabledIds) {
  const disabled = disabledSet(disabledIds);
  return allHarnesses().filter(harness => !disabled.has(harness.id));
}

function assertHarnessSettings(fields) {
  if (fields && fields.disabledHarnesses !== undefined) {
    if (!Array.isArray(fields.disabledHarnesses) || fields.disabledHarnesses.some(id => typeof id !== 'string')) {
      throw Object.assign(new TypeError('disabledHarnesses must be a list of CLI ids'), { code: 'HARNESS_GUARD' });
    }
    if (!enabledHarnesses(fields.disabledHarnesses).length) {
      throw Object.assign(new Error('at least one CLI must stay enabled'), { code: 'HARNESS_GUARD' });
    }
  }
  return fields;
}

// see .ai/contexts/session-cache.md ("Harness folders")
function prefixedHarnesses(disabledIds) {
  return enabledHarnesses(disabledIds).filter(harness => harness.folderPrefix);
}

function harnessFolderIndexMtimeMs(harness, dir, files) {
  return getTranscriptsIndexMtimeMs(dir, files, harness.titleIndexMtimeMs ? harness.titleIndexMtimeMs() : 0);
}

function readHarnessFolder(harness, folder) {
  const dir = harness.folderPath(folder);
  if (!dir) return null;
  const files = harness.listTranscripts(dir);
  const sessions = [];
  for (const file of files) {
    try {
      const session = harness.readSessionFile(file, folder, null);
      if (session) sessions.push(session);
    } catch {}
  }
  return { folder, projectPath: null, sessions, indexMtimeMs: harnessFolderIndexMtimeMs(harness, dir, files) };
}

module.exports = { HARNESSES, DEFAULT_HARNESS, getHarness, allHarnesses, availableHarnesses, harnessForFolder, transcriptPath,
  prefixedHarnesses, harnessFolderIndexMtimeMs, readHarnessFolder, enabledHarnesses, assertHarnessSettings };
