// see .ai/contexts/schedule-runner.md ("Imported history")
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { encodeProjectPath } = require('../../../encode-project-path');
const { renameWithRetry } = require('../shared/atomic-write');

const MARKER = 'scheduleHistoryImported';
const SEED_FIRST_BYTES = 8 * 1024;
const SEED_MAX_BYTES = 64 * 1024;
const BATCH = 32;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = '(\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z)';
const HEADING_RE = new RegExp(`^Scheduled Task(?: \\(catch-up: due ${ISO}, started ${ISO}\\))?: `);
const LOOKALIKE_RE = /^Scheduled Task[ :(]/;
const SEED_KEYS = ['cwd', 'message', 'parentUuid', 'sessionId', 'slug', 'timestamp', 'type', 'uuid'].join();

function storeFileOf(dataDir) {
  return path.join(dataDir, 'schedule-history', 'imported.json');
}

async function readSeedLine(file) {
  const handle = await fs.promises.open(file, 'r');
  try {
    let text = '';
    let offset = 0;
    for (const size of [SEED_FIRST_BYTES, SEED_MAX_BYTES - SEED_FIRST_BYTES]) {
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, offset);
      offset += bytesRead;
      text += buffer.toString('latin1', 0, bytesRead);
      const end = text.indexOf('\n');
      if (end >= 0) return Buffer.from(text.slice(0, end), 'latin1').toString('utf8');
      if (bytesRead < size) return null;
    }
    return null;
  } finally { await handle.close(); }
}

function isoTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function sameFolder(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function seedAttribution(line, { sessionId, folder }) {
  let seed;
  try { seed = JSON.parse(line); } catch { return null; }
  if (!seed || typeof seed !== 'object' || Array.isArray(seed)) return null;
  if (Object.keys(seed).sort().join() !== SEED_KEYS) return null;
  const { type, parentUuid, uuid, cwd, slug, timestamp, message } = seed;
  if (type !== 'user' || parentUuid !== null || seed.sessionId !== sessionId) return null;
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid) || !UUID_RE.test(sessionId)) return null;
  if (typeof slug !== 'string' || !slug || !isoTime(timestamp)) return null;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !sameFolder(encodeProjectPath(cwd), folder)) return null;
  if (!message || typeof message !== 'object' || Object.keys(message).sort().join() !== 'content,role') return null;
  if (message.role !== 'user' || typeof message.content !== 'string') return null;
  const heading = HEADING_RE.exec(message.content);
  if (!heading) return null;
  let dueMs = null;
  if (heading[1]) {
    if (heading[2] !== timestamp || !isoTime(heading[1]) || Date.parse(heading[1]) > Date.parse(timestamp)) return null;
    dueMs = Date.parse(heading[1]);
  }
  return { slug, created: timestamp, dueMs };
}

function readStore(file) {
  try {
    const store = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (store?.v === 1 && store.projects && typeof store.projects === 'object' && !Array.isArray(store.projects)) return store;
  } catch {}
  return null;
}

function writeStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(store) + '\n');
    renameWithRetry(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function createScheduleHistoryImport(deps) {
  const { dataDir, projectsDir, scheduleProjects, listSchedules, getCachedByFolder,
    isIndexReady = () => true, isMarked, mark, onProgress = () => {}, onSettled = () => {}, log = console,
    readHead = readSeedLine, pause = () => new Promise(resolve => setImmediate(resolve)), realpath = fs.realpathSync } = deps;
  const file = storeFileOf(dataDir);
  let store = readStore(file);
  let state = store && isMarked() ? 'done' : 'pending';
  let error = null;
  let running = null;
  let imported = null;

  function importedRuns() {
    if (imported) return imported;
    imported = new Map();
    for (const [projectPath, entry] of Object.entries(store?.projects || {})) {
      for (const [sessionId, run] of Object.entries(entry?.runs || {})) imported.set(sessionId, { projectPath, ...run });
    }
    return imported;
  }

  function status() {
    const unattributed = Object.values(store?.projects || {}).reduce((sum, entry) => sum + (entry?.unattributed || 0), 0);
    return error ? { state, unattributed, error } : { state, unattributed };
  }

  async function importProject(projectPath) {
    const slugs = new Set(listSchedules([projectPath]).map(schedule => schedule.slug).filter(Boolean));
    const folders = new Set([encodeProjectPath(projectPath)]);
    try { folders.add(encodeProjectPath(realpath(projectPath))); } catch {}
    const runs = {};
    let unattributed = 0;
    let read = 0;
    const seen = new Set();
    for (const folder of folders) {
      for (const row of await getCachedByFolder(folder)) {
        if (seen.has(row.sessionId) || row.scheduleSlug || row.parentSessionId || !UUID_RE.test(row.sessionId || '')) continue;
        const lookalike = LOOKALIKE_RE.test(row.firstPrompt || row.summary || '');
        if (!lookalike && !slugs.has(row.slug)) continue;
        seen.add(row.sessionId);
        if (++read % BATCH === 0) await pause();
        let line;
        try { line = await readHead(path.join(projectsDir, folder, `${row.sessionId}.jsonl`)); }
        catch (readError) {
          if (readError.code === 'ENOENT') continue;
          throw readError;
        }
        const attribution = line === null ? null : seedAttribution(line, { sessionId: row.sessionId, folder });
        if (attribution && slugs.has(attribution.slug)) runs[row.sessionId] = { slug: attribution.slug, folder, created: attribution.created, dueMs: attribution.dueMs };
        else if (!attribution && lookalike) unattributed++;
      }
    }
    return { runs, unattributed };
  }

  async function run() {
    state = 'running';
    error = null;
    try {
      if (!store) store = { v: 1, projects: {} };
      for (const projectPath of await scheduleProjects().list()) {
        if (Object.hasOwn(store.projects, projectPath)) continue;
        const entry = await importProject(projectPath);
        store = { ...store, projects: { ...store.projects, [projectPath]: entry } };
        writeStore(file, store);
        imported = null;
        onProgress(projectPath);
        await pause();
      }
      await mark();
      state = 'done';
      log.info?.(`[schedules] Imported ${importedRuns().size} run(s) made before the schedule marker`);
    } catch (failure) {
      state = 'failed';
      error = failure.message;
      log.warn?.(`[schedules] Run history import stopped, resumed at the next Schedules listing: ${failure.message}`);
    }
    onSettled(state);
  }

  function ensureStarted() {
    if (running || state === 'done') return;
    if (!isIndexReady()) { state = 'waiting'; return; }
    running = run().finally(() => { running = null; });
  }

  return { ensureStarted, status, importedRuns, whenIdle: () => running || Promise.resolve() };
}

module.exports = { MARKER, SEED_MAX_BYTES, storeFileOf, readSeedLine, seedAttribution, createScheduleHistoryImport };
