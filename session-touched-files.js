// session-touched-files.js — the files a session's file tools touched — see .ai/contexts/touched-files.md

'use strict';

const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { enumerateSessionFiles, readSubagentMeta } = require('./read-session-file');
const { isValidChangesSessionId } = require('./git-changes-target');
const { extractCwdFromJsonl } = require('./derive-project-path');
const { verifiedTranscriptCwd } = require('./encode-project-path');

const TOUCH_TOOLS = Object.freeze(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const MAX_PATH_LENGTH = 4096;
const MAX_RAW_DISPLAY = 300;
const MAX_FILES = 500;
const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;
const MAX_LINE_CHARS = 32 * 1024 * 1024;
const MAX_TOOL_LINE_CHARS = 4 * 1024 * 1024;
const STAT_CONCURRENCY = 8;
const STAT_TIMEOUT_MS = 3000;
const MAX_TIMED_OUT_CHECKS = 8;

const PREFILTER_TOOL = /"(?:Edit|Write|MultiEdit|NotebookEdit)"/;
const UNSAFE_CHARS_SOURCE = '[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\p{Cf}]';
const CONTROL_CHARS = new RegExp(UNSAFE_CHARS_SOURCE, 'u');
const CONTROL_CHARS_GLOBAL = new RegExp(UNSAFE_CHARS_SOURCE, 'gu');
const WIN_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const WIN_DRIVE_RELATIVE = /^[A-Za-z]:/;

function touchTarget(block) {
  const input = block.input;
  if (!input || typeof input !== 'object') return null;
  const key = block.name === 'NotebookEdit' ? 'notebook_path' : 'file_path';
  const value = input[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function extractTouches(line) {
  const none = { touches: [], malformed: false };
  if (typeof line !== 'string' || !line.includes('tool_use') || !PREFILTER_TOOL.test(line)) return none;
  if (line.length > MAX_TOOL_LINE_CHARS) return { touches: [], malformed: false, oversized: true };
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return { touches: [], malformed: true };
  }
  if (!entry || entry.type !== 'assistant' || !entry.message || !Array.isArray(entry.message.content)) return none;
  const touches = [];
  for (const block of entry.message.content) {
    if (!block || block.type !== 'tool_use' || !TOUCH_TOOLS.includes(block.name)) continue;
    const target = touchTarget(block);
    if (target !== null) touches.push({ tool: block.name, path: target });
  }
  return { touches, malformed: false };
}

function isWindowsOps(pathOps) {
  return pathOps.sep === '\\';
}

function isSepChar(c) {
  return c === '/' || c === '\\';
}

// see .ai/contexts/touched-files.md ("Trust")
function resolveTouchedPath(raw, { cwd = null, pathOps = path } = {}) {
  if (typeof raw !== 'string' || raw === '' || raw.length > MAX_PATH_LENGTH) return { unresolved: 'invalid' };
  if (CONTROL_CHARS.test(raw)) return { unresolved: 'control-character' };
  if (raw[0] === '~') return { unresolved: 'home-relative' };

  let absolute;
  if (isWindowsOps(pathOps)) {
    if (isSepChar(raw[0]) && isSepChar(raw[1])) return { unresolved: 'unsupported-form' };
    if (WIN_DRIVE_ABSOLUTE.test(raw)) absolute = true;
    else if (WIN_DRIVE_RELATIVE.test(raw)) return { unresolved: 'drive-relative' };
    else if (isSepChar(raw[0])) return { unresolved: 'rooted-no-drive' };
    else absolute = false;
  } else {
    absolute = pathOps.isAbsolute(raw);
  }

  let resolved;
  if (absolute) {
    resolved = pathOps.resolve(raw);
  } else {
    if (typeof cwd !== 'string' || !pathOps.isAbsolute(cwd)) return { unresolved: 'relative-no-cwd' };
    resolved = pathOps.resolve(cwd, raw);
  }
  if (resolved.length > MAX_PATH_LENGTH) return { unresolved: 'invalid' };
  return { path: resolved };
}

// see .ai/contexts/touched-files.md ("Bounds")
async function* readTranscriptLines(filePath, budget) {
  const decoder = new StringDecoder('utf8');
  const stream = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
  let pending = '';
  let skipping = false;
  let cut = false;
  try {
    for await (const chunk of stream) {
      if (budget.remaining <= 0) { budget.truncated = true; cut = true; break; }
      let buf = chunk;
      if (buf.length > budget.remaining) {
        buf = buf.subarray(0, budget.remaining);
        budget.truncated = true;
        cut = true;
      }
      budget.remaining -= buf.length;
      pending += decoder.write(buf);
      let nl = pending.indexOf('\n');
      while (nl !== -1) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (skipping) skipping = false;
        else yield line;
        nl = pending.indexOf('\n');
      }
      if (pending.length > MAX_LINE_CHARS) { pending = ''; skipping = true; budget.skipped += 1; }
      if (cut) break;
    }
  } catch {
    return;
  } finally {
    stream.destroy();
  }
  if (!cut && !skipping && pending !== '') yield pending;
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) {
    workers.push((async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i]);
      }
    })());
  }
  await Promise.all(workers);
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function inspectPath(filePath, deps) {
  let sensitive;
  try { sensitive = await deps.isSensitive(filePath); } catch { sensitive = true; }
  if (sensitive) return 'refused';
  try {
    const stat = await deps.statPath(filePath);
    return stat && stat.isFile() ? 'present' : 'not-file';
  } catch (err) {
    return err && (err.code === 'ENOENT' || err.code === 'ENOTDIR') ? 'gone' : 'unreadable';
  }
}

async function diskState(filePath, deps, gate) {
  if (gate.timedOut >= deps.maxTimedOutChecks) return 'unreadable';
  try {
    return await withTimeout(inspectPath(filePath, deps), deps.statTimeoutMs);
  } catch {
    gate.timedOut += 1;
    return 'unreadable';
  }
}

function escapeUnsafe(text) {
  return text.replace(CONTROL_CHARS_GLOBAL, (ch) => {
    const cp = ch.codePointAt(0);
    const hex = cp.toString(16).toUpperCase();
    return cp <= 0xffff ? '\\u' + hex.padStart(4, '0') : '\\u{' + hex + '}';
  });
}

function defaultLabel(entry) {
  return entry.parentSessionId ? 'subagent ' + String(entry.sessionId).replace(/^agent-/, '') : 'session';
}

function safeLabel(value) {
  return String(value).replace(CONTROL_CHARS_GLOBAL, ' ').slice(0, 80);
}

function tally(map, key, make, touch, label) {
  let row = map.get(key);
  if (!row) {
    row = make();
    map.set(key, row);
  }
  row.tools.add(touch.tool);
  row.count += 1;
  row.sources.add(label);
}

function present(row) {
  return { tools: [...row.tools].sort(), count: row.count, sources: [...row.sources] };
}

async function collectSessionTouchedFiles(options) {
  const {
    folderPath,
    sessionId,
    isSensitive,
    cwdOf = () => null,
    labelOf = defaultLabel,
    enumerate = enumerateSessionFiles,
    statPath = (p) => fs.promises.stat(p),
    pathOps = path,
    maxFiles = MAX_FILES,
    maxBytes = MAX_TRANSCRIPT_BYTES,
    statTimeoutMs = STAT_TIMEOUT_MS,
    maxTimedOutChecks = MAX_TIMED_OUT_CHECKS,
  } = options;
  if (typeof isSensitive !== 'function') throw new TypeError('isSensitive is required');

  const all = enumerate(folderPath);
  const parent = all.find((e) => e.parentSessionId === null && e.sessionId === sessionId);
  if (!parent) return { ok: false, reason: 'no-transcript', error: 'this session has no transcript on disk' };
  const subagents = all
    .filter((e) => e.parentSessionId === sessionId)
    .sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0));
  const entries = [parent, ...subagents];

  const caseFold = isWindowsOps(pathOps);
  const resolvedRows = new Map();
  const unresolvedRows = new Map();
  let omitted = 0;
  const budget = { remaining: maxBytes, truncated: false, skipped: 0 };
  let malformedLines = 0;
  let oversizedLines = 0;

  for (const entry of entries) {
    let cwd = null;
    try { cwd = cwdOf(entry); } catch { cwd = null; }
    let label;
    try { label = safeLabel(labelOf(entry)); } catch { label = defaultLabel(entry); }

    for await (const line of readTranscriptLines(entry.filePath, budget)) {
      const { touches, malformed, oversized } = extractTouches(line);
      if (malformed) malformedLines += 1;
      if (oversized) oversizedLines += 1;
      for (const touch of touches) {
        const resolved = resolveTouchedPath(touch.path, { cwd, pathOps });
        if (resolved.path !== undefined) {
          const key = caseFold ? resolved.path.toLowerCase() : resolved.path;
          if (!resolvedRows.has(key) && resolvedRows.size >= maxFiles) { omitted += 1; continue; }
          tally(resolvedRows, key, () => ({ path: resolved.path, tools: new Set(), count: 0, sources: new Set() }), touch, label);
        } else {
          const raw = escapeUnsafe(touch.path.slice(0, MAX_RAW_DISPLAY));
          if (!unresolvedRows.has(raw) && unresolvedRows.size >= maxFiles) { omitted += 1; continue; }
          tally(unresolvedRows, raw, () => ({ raw, reason: resolved.unresolved, tools: new Set(), count: 0, sources: new Set() }), touch, label);
        }
      }
    }
  }

  const files = [...resolvedRows.values()].map((row) => ({ path: row.path, state: 'unknown', openable: false, ...present(row) }));
  const gate = { timedOut: 0 };
  await mapLimit(files, STAT_CONCURRENCY, async (file) => {
    file.state = await diskState(file.path, { isSensitive, statPath, statTimeoutMs, maxTimedOutChecks }, gate);
    file.openable = file.state === 'present';
  });

  return {
    ok: true,
    files,
    unresolved: [...unresolvedRows.values()].map((row) => ({ raw: row.raw, reason: row.reason, ...present(row) })),
    omitted,
    coverage: {
      transcripts: entries.length,
      subagents: subagents.length,
      malformedLines,
      skippedLines: oversizedLines + budget.skipped,
      truncated: budget.truncated,
    },
  };
}

function plainFolderName(folder) {
  return typeof folder === 'string' && folder !== '' && folder !== '.' && folder !== '..' && !/[/\\]/.test(folder);
}

function subagentLabel(entry) {
  const shortId = String(entry.sessionId).replace(/^agent-/, '').slice(0, 7);
  let type = '';
  const meta = readSubagentMeta(entry.filePath);
  if (meta && typeof meta.agentType === 'string') type = meta.agentType.trim();
  return type ? `subagent ${type} (${shortId})` : `subagent ${shortId}`;
}

async function listSessionTouchedFiles(sessionId, deps) {
  if (!isValidChangesSessionId(sessionId)) return { ok: false, error: 'invalid session id' };
  let folder = null;
  try { folder = deps.getCachedFolder(sessionId); } catch { folder = null; }
  if (deps.isRemoteFolder(folder)) {
    return { ok: false, reason: 'remote', error: 'the touched files of a remote session are not available' };
  }
  if (!plainFolderName(folder)) return { ok: false, reason: 'no-transcript', error: 'this session has no transcript on disk' };
  return collectSessionTouchedFiles({
    folderPath: path.join(deps.projectsDir, folder),
    sessionId,
    isSensitive: deps.isSensitive,
    cwdOf: (entry) => verifiedTranscriptCwd(extractCwdFromJsonl(entry.filePath), folder),
    labelOf: (entry) => (entry.parentSessionId ? subagentLabel(entry) : 'session'),
  });
}

module.exports = { TOUCH_TOOLS, extractTouches, resolveTouchedPath, collectSessionTouchedFiles, listSessionTouchedFiles };
