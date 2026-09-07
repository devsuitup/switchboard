// see .ai/contexts/session-cache.md ("Remote hosts")
'use strict';

const path = require('path');

const FOLDER_SEP = '::';
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const MIN_REFRESH_MS = 60_000;
const DEFAULT_REFRESH_MS = 300_000;

function isValidAlias(alias) {
  return typeof alias === 'string' && ALIAS_RE.test(alias) && !alias.includes(FOLDER_SEP);
}

function joinFolderKey(alias, folder) {
  return alias + FOLDER_SEP + folder;
}

function parseFolderKey(key) {
  const s = key == null ? '' : String(key);
  const i = s.indexOf(FOLDER_SEP);
  if (i < 0) return { alias: null, folder: s };
  const alias = s.slice(0, i);
  if (!isValidAlias(alias)) return { alias: null, folder: s };
  return { alias, folder: s.slice(i + FOLDER_SEP.length) };
}

function isRemoteFolder(key) {
  return parseFolderKey(key).alias !== null;
}

function normalizeHosts(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const alias = typeof entry.alias === 'string' ? entry.alias.trim() : '';
    if (!isValidAlias(alias) || seen.has(alias)) continue;
    seen.add(alias);
    out.push({
      alias,
      label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim().slice(0, 64) : alias,
      enabled: entry.enabled !== false,
    });
  }
  return out;
}

function enabledHosts(raw) {
  return normalizeHosts(raw).filter(h => h.enabled);
}

function normalizeRefreshMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_REFRESH_MS;
  return Math.max(MIN_REFRESH_MS, Math.floor(n));
}

function mirrorDirFor(dataDir, alias) {
  return path.join(dataDir, 'remote', alias);
}

function mirrorProjectsDirFor(dataDir, alias) {
  return path.join(mirrorDirFor(dataDir, alias), 'projects');
}

function manifestPathFor(dataDir, alias) {
  return path.join(mirrorDirFor(dataDir, alias), 'inventory.json');
}

// Validated before it is joined onto a local path or handed to scp.
// A leading '-' is allowed: the CLI's own folder names start with one. see .ai/contexts/session-cache.md ("Remote SSH hosts")
const SAFE_REL_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

function isSafeRelPath(rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 512) return false;
  if (!rel.endsWith('.jsonl')) return false;
  if (rel.includes('..')) return false;
  if (rel.split('/').some(seg => seg === '.')) return false;
  return SAFE_REL_RE.test(rel);
}

function topFolderOf(rel) {
  const i = rel.indexOf('/');
  return i < 0 ? null : rel.slice(0, i);
}

module.exports = {
  FOLDER_SEP,
  MIN_REFRESH_MS,
  DEFAULT_REFRESH_MS,
  isValidAlias,
  joinFolderKey,
  parseFolderKey,
  isRemoteFolder,
  normalizeHosts,
  enabledHosts,
  normalizeRefreshMs,
  mirrorDirFor,
  mirrorProjectsDirFor,
  manifestPathFor,
  isSafeRelPath,
  topFolderOf,
};
