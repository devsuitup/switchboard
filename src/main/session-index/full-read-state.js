'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SESSION_CONTENT_INDEX_VERSION = 1;
const CONTENT_GOLDEN_DIGESTS = Object.freeze({ 1: '068456510a189d17ee5b332c541ba439d26fbf4c1f2d30fbd90d3348b00e0fe3' });
const fields = ['dev', 'ino', 'birthtimeNs', 'mtimeNs', 'ctimeNs', 'size'];

function observation(file, stat) {
  try {
    stat ||= fs.statSync(file, { bigint: true });
    return Object.fromEntries(fields.map(key => [key, String(stat[key])]));
  } catch (error) { return ['ENOENT', 'ENOTDIR'].includes(error.code) ? null : undefined; }
}

function relativeSource(file, parentSessionId) {
  const parts = path.resolve(file).split(path.sep);
  const parent = parentSessionId ? parts.lastIndexOf(parentSessionId) : -1;
  return parts.slice(parent < 0 ? -1 : parent).join('/');
}

function fullReadStamp(file, runtime, relativePath, before, bytes, dependencies = {}, previousDependencies = dependencies, after = observation(file)) {
  if (!before || !after || BigInt(bytes) !== BigInt(before.size)
    || fields.some(key => before[key] !== after[key])
    || Object.values(dependencies).some(value => value === undefined)
    || JSON.stringify(previousDependencies) !== JSON.stringify(dependencies)) return null;
  return JSON.stringify({ format: 1, runtime, relativePath, ...before, dependencies });
}

function fullIndexConfig(settings, projectsDir) {
  return JSON.stringify({ remaps: Object.entries(settings.remappedProjects || {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
    disabledHarnesses: [...new Set(settings.disabledHarnesses || [])].sort(),
    roots: [path.resolve(projectsDir), path.resolve(process.env.CODEX_HOME || path.join(require('node:os').homedir(), '.codex'), 'sessions')] });
}

function rowWitness(row) {
  return JSON.stringify(['projectPath', 'summary', 'firstPrompt', 'created', 'modified', 'messageCount', 'slug', 'aiTitle',
    'parentSessionId', 'agentId', 'subagentType', 'description', 'fileMtime', 'bridgeSessionId', 'mergedIntoSessionId',
    'entrypoint', 'scheduleSlug', 'continuationIndex', 'customTitle', 'fileSize', 'workflowRunId', 'messageCountIndex', 'runtime', 'sessionFile']
    .map(key => key === 'runtime' ? row[key] || 'claude' : key === 'messageCount' ? row[key] || 0
      : key === 'entrypoint' || key === 'customTitle' || key === 'fileSize' ? row[key] ?? null : row[key] || null));
}

function matchesFullRead(file, serialized, runtime = 'claude', relativePath) {
  let stamp;
  try { stamp = JSON.parse(serialized); } catch { return false; }
  if (stamp?.format !== 1 || stamp.runtime !== runtime || stamp.relativePath !== relativePath) return false;
  const current = observation(file);
  if (!current || fields.some(key => current[key] !== stamp[key])) return false;
  const dependencies = stamp.dependencies;
  if (!dependencies || typeof dependencies !== 'object') return false;
  if (relativePath.includes('/') && !Object.hasOwn(dependencies, 'meta')) return false;
  if (Object.hasOwn(dependencies, 'meta')) {
    const meta = observation(file.replace(/\.jsonl$/, '.meta.json'));
    if (meta === undefined || JSON.stringify(meta) !== JSON.stringify(dependencies.meta)) return false;
  }
  return true;
}

function sourceRelativePath(row) {
  try {
    const stamp = JSON.parse(row.fullReadStamp);
    if (stamp?.format === 1 && stamp.runtime === 'claude' && safeRelativePath(stamp.relativePath)) return stamp.relativePath;
  } catch {}
  return null;
}

function safeRelativePath(relativePath) {
  return typeof relativePath === 'string' && relativePath.length > 0 && !relativePath.includes('\\')
    && !path.isAbsolute(relativePath) && !relativePath.includes(':') && relativePath.split('/').every(part => part && part !== '.' && part !== '..');
}

function nameDerivationWitness(meta, collision = false) {
  return JSON.stringify({ revision: meta?.nameRevision ?? null, name: meta?.name ?? null, source: meta?.nameSource ?? null,
    transcriptTitle: meta?.nameTranscriptTitle ?? null, collision });
}

function folderReadWitness(db, folder) {
  const rows = db.getCachedByFolder(folder);
  return JSON.stringify({ rows, meta: db.getFolderMeta(folder) || null,
    metadata: rows.map(row => [row.sessionId, db.getMeta(row.sessionId, true) || null]) });
}

module.exports = { SESSION_CONTENT_INDEX_VERSION, CONTENT_GOLDEN_DIGESTS, observation, relativeSource, fullReadStamp, fullIndexConfig, rowWitness,
  matchesFullRead, sourceRelativePath, safeRelativePath, nameDerivationWitness, folderReadWitness };
