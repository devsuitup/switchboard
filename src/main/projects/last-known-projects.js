'use strict';

// see .ai/contexts/ipc-bridge.md ("Last known projects")
const fs = require('node:fs');
const path = require('node:path');

const FORMAT_VERSION = 2;
const FILENAME = 'last-known-projects.json';
const MAX_BYTES = 8 * 1024 * 1024;
const WRITE_DELAY_MS = 2000;
const PROJECT_FIELDS = ['projectPath', 'name', 'folder', 'missing', 'remoteAlias', 'remoteHostProfile', 'remoteHostError',
  'remoteHostAt', 'remoteHostNextAttemptAt', 'hiddenRepository'];
const SESSION_FIELDS = ['name', 'aiTitle', 'archived', 'starred', 'runtime', 'runtimeLabel', 'canLaunch', 'type', 'placeholder',
  'projectPath', 'cwd', 'recordedCwd', 'sourceFolder', 'scheduleSlug', 'parentSessionId', 'workflowRunId', 'workflowName',
  'agentId', 'subagentType', 'description', 'headSessionId', 'mergedMemberIds', 'mergedMemberStatuses',
  'status', 'statusUpdatedAt', 'waitingFor', 'remoteAlias', 'remoteDescriptorSeen', 'remoteMemberDescriptorSeen',
  'remoteAttachable', 'remoteAttachBlocked', 'remoteSendBlocked', 'remoteActiveAt', 'bgJobId', 'bgJobName',
  'bgSessionId', 'identityJobId', 'identitySessionId', 'descriptorOnly', 'runningScheduleIds', 'bridgeSessionId'];
const COMMON_FIELDS = ['projectPath', 'cwd', 'sourceFolder', 'runtime', 'canLaunch'];
const pick = (value, fields) => Object.fromEntries(fields.filter(key => value[key] !== undefined && value[key] !== null).map(key => [key, value[key]]));
const scope = project => JSON.stringify([project.remoteAlias || null, project.projectPath]);

function compactProjects({ defaultProjects, allProjects }) {
  const defaults = new Map(defaultProjects.map((project, index) => [scope(project), { project, index }]));
  return allProjects.map(project => {
    const first = project.sessions[0] || {};
    const common = pick(first, COMMON_FIELDS.filter(key => project.sessions.every(row => row[key] === first[key])));
    const saved = { ...pick(project, PROJECT_FIELDS), common, sessions: project.sessions.map(row => {
      const extra = pick(row, SESSION_FIELDS.filter(key => !Object.hasOwn(common, key)
        && row[key] !== null && row[key] !== undefined && row[key] !== 0
        && (!Array.isArray(row[key]) || row[key].length)));
      const tuple = [row.sessionId, row.summary, row.modified, row.messageCount];
      if (Object.keys(extra).length) tuple.push(extra);
      while (tuple.length > 1 && tuple.at(-1) === undefined) tuple.pop();
      return tuple;
    }) };
    const visible = defaults.get(scope(project));
    if (visible) {
      saved.defaultOrder = visible.index;
      const indices = new Map(project.sessions.map((row, index) => [row.sessionId, index]));
      const rows = visible.project.sessions.map(row => indices.get(row.sessionId));
      if (rows.some(index => index === undefined)) throw new Error('default row missing from all projects');
      if (rows.length !== project.sessions.length || rows.some((index, position) => index !== position)) saved.defaultRows = rows;
      defaults.delete(scope(project));
    }
    return saved;
  });
}

function restoreProjects(projects) {
  if (!Array.isArray(projects)) throw new Error('invalid projects');
  const defaults = [];
  const allProjects = projects.map(saved => {
    if (!saved || typeof saved.projectPath !== 'string' || !Array.isArray(saved.sessions)) throw new Error('invalid project');
    const project = { ...pick(saved, PROJECT_FIELDS), sessions: saved.sessions.map(tuple => {
      if (!Array.isArray(tuple) || typeof tuple[0] !== 'string' || tuple.length > 5) throw new Error('invalid row');
      const row = { ...pick(saved.common || {}, COMMON_FIELDS), ...pick(tuple[4] || {}, SESSION_FIELDS), sessionId: tuple[0] };
      for (const [index, field] of [[1, 'summary'], [2, 'modified'], [3, 'messageCount']]) {
        if (tuple[index] !== undefined && tuple[index] !== null) row[field] = tuple[index];
      }
      return row;
    }) };
    if (saved.defaultOrder !== undefined) {
      if (!Number.isInteger(saved.defaultOrder) || saved.defaultOrder < 0 || saved.defaultOrder >= projects.length || defaults[saved.defaultOrder]) throw new Error('invalid default order');
      if (saved.defaultRows !== undefined && (!Array.isArray(saved.defaultRows)
        || saved.defaultRows.some(index => !Number.isInteger(index) || index < 0 || index >= project.sessions.length))) throw new Error('invalid default rows');
      defaults[saved.defaultOrder] = { ...project, sessions: saved.defaultRows ? saved.defaultRows.map(index => project.sessions[index]) : [...project.sessions] };
    }
    return project;
  });
  return { defaultProjects: defaults.filter(Boolean), allProjects };
}

function createLastKnownProjectsStore({ dir, appVersion, log = console, maxBytes = MAX_BYTES, writeDelayMs = WRITE_DELAY_MS,
  setTimeout: schedule = setTimeout, clearTimeout: cancel = clearTimeout }) {
  const filename = path.join(dir, FILENAME);
  let queued = null;
  let timer = null;
  let writing = Promise.resolve();
  let oversizeWarned = false;

  async function discard(reason) {
    log.warn(`[projects] last known projects discarded (${reason}); the sidebar starts empty`);
    await fs.promises.unlink(filename).catch(() => {});
  }

  async function load() {
    let text;
    try { text = await fs.promises.readFile(filename, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') log.warn(`[projects] last known projects unreadable (${error.message}); the sidebar starts empty`);
      return null;
    }
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { await discard('corrupt file'); return null; }
    if (!parsed || typeof parsed !== 'object') { await discard('not an object'); return null; }
    if (parsed.version !== FORMAT_VERSION) { await discard(`format ${parsed.version} is not ${FORMAT_VERSION}`); return null; }
    if (parsed.appVersion !== appVersion) { await discard(`written by ${parsed.appVersion}, running ${appVersion}`); return null; }
    try { return { ...restoreProjects(parsed.projects), savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : null }; }
    catch { await discard('invalid shape'); return null; }
  }

  async function write(payload) {
    let text;
    try { text = JSON.stringify({ version: FORMAT_VERSION, appVersion, savedAt: payload.savedAt, projects: compactProjects(payload) }); }
    catch (error) { log.warn(`[projects] last known projects not saved: ${error.message}`); return; }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > maxBytes) {
      if (!oversizeWarned) log.warn(`[projects] last known projects not saved: ${bytes} bytes exceed ${maxBytes}; the previous file is kept`);
      oversizeWarned = true;
      return;
    }
    const temporary = filename + '.tmp';
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(temporary, text, 'utf8');
      await fs.promises.rename(temporary, filename);
    } catch (error) {
      log.warn(`[projects] last known projects not saved: ${error.message}`);
      await fs.promises.unlink(temporary).catch(() => {});
    }
  }

  function flush() {
    if (timer) { cancel(timer); timer = null; }
    const payload = queued;
    queued = null;
    if (payload) writing = writing.then(() => write(payload));
    return writing;
  }

  function remember({ defaultProjects, allProjects }) {
    queued = { savedAt: Date.now(), defaultProjects, allProjects };
    if (!timer) timer = schedule(() => { timer = null; flush(); }, writeDelayMs);
  }

  return { load, remember, flush, filename };
}

module.exports = { createLastKnownProjectsStore, FORMAT_VERSION, MAX_BYTES, WRITE_DELAY_MS };
