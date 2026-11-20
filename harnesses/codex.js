'use strict';

// see .ai/contexts/cli-harnesses.md ("Codex adapter")
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanLines, readHead } = require('../jsonl-scan');

const id = 'codex';
const label = 'Codex';
const binary = 'codex';
const folderPrefix = 'codex/';
const groupsByProject = false;

const ROLLOUT_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const DATE_KEY_RE = /^(\d{4})\/(\d{2})\/(\d{2})$/;
const INJECTED_RE = /^\s*(?:<[a-z_]+>|# AGENTS\.md instructions\b)/;
const TEXT_TYPES = new Set(['text', 'input_text', 'output_text']);
const SPINNER_MIN = 0x2800, SPINNER_MAX = 0x28FF;
const ACTION_REQUIRED_RE = /action required/i;
const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const APPROVAL_POLICIES = new Set(['on-request', 'never']);
const REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

function codexHome() {
  return process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex');
}

function sessionsRoot() {
  return path.join(codexHome(), 'sessions');
}

function titleIndexPath() {
  return path.join(codexHome(), 'session_index.jsonl');
}

let cachedTitleIndex = null;

function readSessionTitles() {
  const filePath = titleIndexPath();
  let stat;
  try { stat = fs.statSync(filePath); } catch (err) {
    return err?.code === 'ENOENT' ? new Map() : null;
  }
  const cached = cachedTitleIndex;
  if (cached && cached.filePath === filePath && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs
    && cached.ino === stat.ino && cached.size === stat.size) return cached.titles;
  let body;
  try { body = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  const titles = new Map();
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry?.id !== 'string' || typeof entry?.thread_name !== 'string') continue;
    titles.set(entry.id, entry.thread_name.trim() || null);
  }
  cachedTitleIndex = { filePath, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, size: stat.size, titles };
  return titles;
}

function titleIndexMtimeMs() {
  try { return fs.statSync(titleIndexPath()).mtimeMs; } catch { return 0; }
}

function available() {
  return fs.existsSync(sessionsRoot());
}

function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  } catch { return []; }
}

function listFolders() {
  const root = sessionsRoot();
  const folders = [];
  for (const y of subdirs(root)) {
    if (!/^\d{4}$/.test(y)) continue;
    for (const m of subdirs(path.join(root, y))) {
      if (!/^\d{2}$/.test(m)) continue;
      for (const d of subdirs(path.join(root, y, m))) {
        if (/^\d{2}$/.test(d)) folders.push(`${folderPrefix}${y}/${m}/${d}`);
      }
    }
  }
  return folders;
}

function folderPath(folder) {
  if (typeof folder !== 'string') return null;
  const key = folder.startsWith(folderPrefix) ? folder.slice(folderPrefix.length) : folder;
  const match = DATE_KEY_RE.exec(key);
  return match ? path.join(sessionsRoot(), match[1], match[2], match[3]) : null;
}

function watchFolderKey(parts) {
  if (!Array.isArray(parts) || parts.length < 4 || !ROLLOUT_RE.test(parts[parts.length - 1])) return null;
  const folder = folderPrefix + parts.slice(0, 3).join('/');
  return folderPath(folder) ? folder : null;
}

function folderForProject() { return null; }
function deriveProjectPath() { return null; }
function resolveWorktreePath(projectPath) { return projectPath; }

function listTranscripts(dir) {
  try {
    return fs.readdirSync(dir).filter(f => ROLLOUT_RE.test(f)).map(f => path.join(dir, f));
  } catch { return []; }
}

function sessionIdFromPath(filePath) {
  const m = ROLLOUT_RE.exec(path.basename(filePath));
  return m ? m[1] : null;
}

function transcriptPath({ sessionFile }) {
  return sessionFile || null;
}

function isSubagentMeta(payload) {
  return payload.thread_source === 'subagent' || !!payload.parent_thread_id || !!payload.agent_path || !!payload.agent_nickname;
}

function messageText(payload) {
  const content = payload?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(c => c && TEXT_TYPES.has(c.type) && typeof c.text === 'string').map(c => c.text).join('\n');
}

function isToolCall(payload) {
  return payload.type === 'custom_tool_call' || payload.type === 'function_call';
}

function metricsBucket(buckets, date, model) {
  const key = `${date}|${model}`;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { date, model, messageCount: 0, toolCallCount: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    buckets.set(key, bucket);
  }
  return bucket;
}

function readSessionFile(filePath, folder) {
  try {
    const stat = fs.statSync(filePath);
    const sessionId = sessionIdFromPath(filePath);
    if (!sessionId) return null;

    let projectPath = null, summary = '', messageCount = 0, firstTimestamp = null, lastTimestamp = null, subagent = false, model = '';
    const textParts = [];
    const buckets = new Map();
    const dateOf = ts => (typeof ts === 'string' && ts.length >= 10 ? ts.slice(0, 10) : null) || (firstTimestamp || stat.birthtime.toISOString()).slice(0, 10);

    const onLine = line => {
      let entry;
      try { entry = JSON.parse(line); } catch { return; }
      const ts = entry.timestamp;
      if (ts && (!firstTimestamp || ts < firstTimestamp)) firstTimestamp = ts;
      const payload = entry.payload;
      if (!payload) return;
      if (entry.type === 'session_meta') {
        if (isSubagentMeta(payload)) { subagent = true; return false; }
        projectPath = projectPath || payload.cwd || null;
        return;
      }
      if (entry.type === 'turn_context') {
        if (typeof payload.model === 'string') model = payload.model;
        return;
      }
      if (entry.type === 'token_usage_record') {
        const usage = payload.usage;
        if (!usage || typeof usage !== 'object') return;
        const bucket = metricsBucket(buckets, dateOf(ts), model);
        bucket.inputTokens += usage.input_tokens | 0;
        bucket.outputTokens += usage.output_tokens | 0;
        bucket.cacheReadTokens += usage.cached_input_tokens | 0;
        bucket.cacheCreationTokens += usage.cache_write_input_tokens | 0;
        return;
      }
      if (entry.type !== 'response_item') return;
      if (isToolCall(payload)) { metricsBucket(buckets, dateOf(ts), model).toolCallCount += 1; return; }
      if (payload.type !== 'message') return;
      const role = payload.role;
      if (role !== 'user' && role !== 'assistant') return;
      const text = messageText(payload);
      if (role === 'user' && INJECTED_RE.test(text)) return;
      if (ts && (!lastTimestamp || ts > lastTimestamp)) lastTimestamp = ts;
      messageCount++;
      metricsBucket(buckets, dateOf(ts), model).messageCount += 1;
      if (!summary && role === 'user' && text) summary = text.slice(0, 120);
      if (text) textParts.push(text);
    };
    const scan = scanLines(filePath, 0, onLine, stat.size);
    if (scan.tail && !scan.stopped) onLine(scan.tail);
    if (subagent || !projectPath || !summary || messageCount < 1) return null;

    const created = firstTimestamp || stat.birthtime.toISOString();
    return {
      sessionId, folder, projectPath, runtime: id, sessionFile: filePath,
      summary, firstPrompt: summary, created,
      modified: lastTimestamp || created,
      fileMtime: stat.mtime.toISOString(), fileSize: stat.size,
      messageCount, textContent: textParts.join('\n'),
      dailyMetrics: [...buckets.values()].filter(b => b.messageCount || b.toolCallCount || b.inputTokens || b.outputTokens),
      slug: null, customTitle: '', entrypoint: '',
      aiTitle: readSessionTitles()?.get(sessionId) || null,
    };
  } catch {
    return null;
  }
}

function partsText(parts) {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(p => (p && typeof p.text === 'string' ? p.text : '')).join('');
}

function toViewerEntry(entry) {
  if (!entry || entry.type !== 'response_item' || !entry.payload) return null;
  const p = entry.payload;
  const timestamp = entry.timestamp;
  if (p.type === 'message') {
    const role = p.role;
    if (role !== 'user' && role !== 'assistant') return null;
    const text = partsText(p.content);
    if (!text || (role === 'user' && INJECTED_RE.test(text))) return null;
    return { type: role, timestamp, message: { role, content: [{ type: 'text', text }] } };
  }
  if (p.type === 'reasoning') {
    const text = partsText(p.summary);
    return text ? { type: 'assistant', timestamp, message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] } } : null;
  }
  if (isToolCall(p)) {
    return { type: 'assistant', timestamp, message: { role: 'assistant', content: [{
      type: 'tool_use', id: p.call_id || p.id || null, name: p.name || 'tool', input: p.input ?? p.arguments ?? '' }] } };
  }
  if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
    return { type: 'user', timestamp, message: { role: 'user', content: [{
      type: 'tool_result', tool_use_id: p.call_id || p.id || null, content: partsText(p.output) }] } };
  }
  return null;
}

function toViewerEntries(entries) {
  const out = [];
  for (const entry of entries || []) {
    const mapped = toViewerEntry(entry);
    if (mapped) out.push(mapped);
  }
  return out;
}

function hasSpinnerFrame(text) {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= SPINNER_MIN && code <= SPINNER_MAX) return true;
  }
  return false;
}

function parseTitleState(title) {
  const text = String(title || '');
  if (!text) return null;
  if (ACTION_REQUIRED_RE.test(text)) return 'attention';
  if (hasSpinnerFrame(text)) return 'busy';
  return 'idle';
}

function classifyTitleActivity(title) {
  const state = parseTitleState(title);
  return { busy: state === 'busy', idle: state === 'idle', attention: state === 'attention', via: state ? 'codex-title' : null };
}

function classifyNotification(message) {
  const text = String(message || '').trim();
  if (!text) return null;
  return /^approval requested\b/i.test(text) ? 'attention' : 'idle';
}

function needsIdDetection({ isNew }) {
  return !!isNew;
}

function originatorTag(tempId) {
  return 'switchboard_' + String(tempId).replace(/[^a-zA-Z0-9]/g, '');
}

const issuedLaunchTags = new Map();
const LAUNCH_TAG_RETENTION_MS = 24 * 60 * 60 * 1000;

function pruneLaunchTags() {
  const now = Date.now();
  for (const [tag, issued] of issuedLaunchTags) {
    if (issued.expiresAt <= now) issuedLaunchTags.delete(tag);
  }
}

function launchEnv(tempId) {
  pruneLaunchTags();
  const tag = originatorTag(tempId);
  issuedLaunchTags.set(tag, { expiresAt: Date.now() + LAUNCH_TAG_RETENTION_MS, sessionId: null });
  return { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: tag };
}

function recordLaunchAdoption(tag, sessionId) {
  pruneLaunchTags();
  const issued = issuedLaunchTags.get(tag);
  if (issued) issued.sessionId = sessionId;
}

function readLaunchSignals(filePath) {
  const head = readHead(filePath, 65536);
  const newline = head.indexOf('\n');
  if (newline === -1) return null;
  let entry;
  try { entry = JSON.parse(head.slice(0, newline)); } catch { return null; }
  if (!entry || entry.type !== 'session_meta') return null;
  const payload = entry.payload || {};
  return {
    sessionId: sessionIdFromPath(filePath),
    originator: payload.originator || null,
    forkedFrom: payload.forked_from_id || null,
    cwd: payload.cwd || null,
    startedAt: payload.timestamp || entry.timestamp || null,
    isSubagent: isSubagentMeta(payload),
  };
}

const SPAWN_SKEW_MS = 5000;

function startedAfterSpawn(signals, spawnedAt) {
  if (!signals.startedAt) return false;
  const started = Date.parse(signals.startedAt);
  return Number.isFinite(started) && started >= spawnedAt - SPAWN_SKEW_MS;
}

function matchesLaunch(signals, { tag, forkFrom, projectPath, spawnedAt }) {
  pruneLaunchTags();
  if (!signals || signals.isSubagent || !signals.sessionId) return false;
  if (tag && signals.originator === tag) return 'tag';
  const issued = issuedLaunchTags.get(signals.originator);
  if (issued && !(forkFrom && issued.sessionId === forkFrom)) return false;
  if (forkFrom) return signals.forkedFrom === forkFrom && startedAfterSpawn(signals, spawnedAt) ? 'fork' : false;
  if (signals.originator && /^switchboard_/.test(signals.originator)) return false;
  if (!projectPath || signals.cwd !== projectPath) return false;
  return startedAfterSpawn(signals, spawnedAt) ? 'cwd' : false;
}

function readModelCatalog() {
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(codexHome(), 'models_cache.json'), 'utf8')); } catch { return []; }
  const out = [];
  for (const m of Array.isArray(data?.models) ? data.models : []) {
    if (!m || typeof m.slug !== 'string' || !m.slug) continue;
    const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [];
    out.push({
      slug: m.slug,
      label: typeof m.display_name === 'string' && m.display_name ? m.display_name : m.slug,
      efforts: levels.map(l => (typeof l === 'string' ? l : l?.effort)).filter(e => typeof e === 'string' && e),
      defaultEffort: typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level : null,
      visible: m.visibility !== 'hide',
    });
  }
  return out;
}

function buildLaunchArgs({ sessionId, isNew, options }) {
  const args = [
    '-c', 'tui.notifications=true',
    '-c', 'tui.notification_method="osc9"',
    '-c', 'tui.notification_condition="always"',
    '-c', 'tui.terminal_title=["activity","project-name"]',
  ];
  if (options?.forkFrom) args.unshift('fork', String(options.forkFrom));
  else if (!isNew) args.unshift('resume', String(sessionId));
  if (options) {
    if (options.dangerouslySkipPermissions) args.push('--dangerously-bypass-approvals-and-sandbox');
    else {
      if (SANDBOX_MODES.has(options.codexSandbox)) args.push('--sandbox', options.codexSandbox);
      if (APPROVAL_POLICIES.has(options.codexApproval)) args.push('--ask-for-approval', options.codexApproval);
    }
    if (options.codexModel) args.push('--model', String(options.codexModel));
    if (REASONING_EFFORTS.has(options.codexEffort)) args.push('-c', `model_reasoning_effort="${options.codexEffort}"`);
    const canAddDirs = !options.dangerouslySkipPermissions
      && (options.codexSandbox === 'workspace-write' || options.codexSandbox === 'danger-full-access');
    if (options.addDirs && canAddDirs) {
      for (const dir of String(options.addDirs).split(',').map(d => d.trim()).filter(Boolean)) args.push('--add-dir', dir);
    }
  }
  if (isNew && !options?.forkFrom && options?.initialPrompt) args.push(String(options.initialPrompt));
  return args;
}

module.exports = {
  id, label, binary, folderPrefix, groupsByProject,
  capabilities: Object.freeze({ subagents: false, continuations: false, liveElsewhere: false, bgJobs: false,
    ideBridge: false, sandbox: false, schedule: false, remote: false, deleteTranscript: false }),
  codexHome, sessionsRoot, available, listFolders, folderPath, watchFolderKey, folderForProject, deriveProjectPath, resolveWorktreePath,
  listTranscripts, sessionIdFromPath, transcriptPath, isSubagentMeta, readSessionFile,
  titleIndexPath, readSessionTitles, titleIndexMtimeMs,
  toViewerEntry, toViewerEntries,
  parseTitleState, classifyTitleActivity, classifyNotification,
  buildLaunchArgs, needsIdDetection, readModelCatalog,
  originatorTag, launchEnv, recordLaunchAdoption, readLaunchSignals, matchesLaunch,
};
