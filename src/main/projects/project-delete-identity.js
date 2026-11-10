'use strict';
const path = require('node:path');
const { createHash } = require('node:crypto');
const { normalizeProjectPath } = require('../shared/normalize-project-path');
const { isValidAlias } = require('../remote/remote-hosts');
const OPTION_KEYS = ['sessions', 'settings', 'schedules', 'transcripts', 'stopBackgroundJobs'];
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && !value.includes('\0');
const fail = (code, error) => Object.assign(new Error(error), { code });

function canonicalPath(value, alias, memo = new Map()) {
  if (!text(value)) throw fail('IDENTITY_UNAVAILABLE', 'A known absolute project path is required.');
  if (alias !== null) {
    if (!isValidAlias(alias) || !path.posix.isAbsolute(value)) throw fail('IDENTITY_UNAVAILABLE', 'Remote identity is unavailable.');
    return path.posix.normalize(value).replace(/\/$/, '') || '/';
  }
  if (!path.isAbsolute(value)) throw fail('IDENTITY_UNAVAILABLE', 'A local absolute path is required.');
  const absolute = path.resolve(value);
  if (!memo.has(absolute)) {
    const normalized = normalizeProjectPath(absolute);
    memo.set(absolute, process.platform === 'win32' ? normalized.toLowerCase() : normalized);
  }
  return memo.get(absolute);
}

function identity(value, memo) {
  if (!isRecord(value) || !Object.hasOwn(value, 'alias')) throw fail('IDENTITY_UNAVAILABLE', 'Ownership must include an explicit host.');
  const alias = value.alias;
  const projectPath = canonicalPath(value.projectPath, alias, memo);
  return { key: JSON.stringify([alias, projectPath]), entry: alias === null ? path.resolve(value.projectPath) : `${alias}::${projectPath}`, alias, projectPath };
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = value => createHash('sha256').update(stable(value)).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function membershipRecord(row, memo, rowPath = (value, key) => value[key] === null ? null : canonicalPath(value[key], value.alias, memo)) {
  const record = { alias: row.alias, projectPath: canonicalPath(row.projectPath, row.alias, memo) };
  for (const key of ['id', 'folderKey', 'runtime', 'conversationId', 'partId', 'subagentId', 'parentSessionId', 'sessionId', 'jobId', 'scheduleId', 'sessionFile', 'path', 'effect', 'kind']) {
    if (Object.hasOwn(row, key)) record[key] = row[key];
  }
  for (const key of ['cwd', 'parentProjectPath']) if (Object.hasOwn(row, key)) record[key] = rowPath(row, key);
  return record;
}
function membershipDigest(project, inventory, memo = new Map()) {
  const membership = {};
  for (const kind of ['groups', 'members', 'tabs', 'jobs', 'schedules']) {
    membership[kind] = inventory[kind].map(row => membershipRecord(row, memo)).sort((a, b) => compare(stable(a), stable(b)));
  }
  return digest({ project: { alias: project.alias, projectPath: canonicalPath(project.projectPath, project.alias, memo) }, ...membership });
}
function durableRowLinks(row) {
  let continuation;
  try { continuation = typeof row.continuationIndex === 'string' ? JSON.parse(row.continuationIndex) : row.continuationIndex; } catch { continuation = null; }
  return [row.parentSessionId, row.mergedIntoSessionId, row.bridgeSessionId, ...(Array.isArray(continuation?.ids) ? continuation.ids : [])].filter(text);
}
module.exports = { canonicalPath, identity, stable, digest, compare, membershipRecord, membershipDigest, durableRowLinks, OPTION_KEYS, isRecord, text, fail };
