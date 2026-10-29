'use strict';

const claude = require('./claude');
const { assertHarness } = require('./contract');
const { parseFolderKey } = require('../remote-hosts');

const HARNESSES = { [claude.id]: assertHarness(claude) };
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

module.exports = { HARNESSES, DEFAULT_HARNESS, getHarness, allHarnesses, availableHarnesses, harnessForFolder, transcriptPath };
