'use strict';
const { applySessionName, establishTranscriptBaseline } = require('./session-name');

// see .ai/contexts/session-index-writer.md
function openSessionIndexStore({ readonly = true, clock = () => performance.now() } = {}) {
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

const DATA_DIR = process.env.SWITCHBOARD_DATA_DIR
  ? path.resolve(process.env.SWITCHBOARD_DATA_DIR.replace(/^~(?=$|\/)/, os.homedir()))
  : path.join(os.homedir(), '.switchboard');
const fs = require('fs');
if (!readonly && !fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'switchboard.db');

const OLD_LOCATIONS = process.env.SWITCHBOARD_DATA_DIR ? [] : [
  path.join(os.homedir(), '.claude', 'browser', 'switchboard.db'),
  path.join(os.homedir(), '.claude', 'browser', 'session-browser.db'),
  path.join(os.homedir(), '.claude', 'session-browser.db'),
];

const IS_DEFAULT_DATA_DIR = !process.env.SWITCHBOARD_DATA_DIR;
if (!readonly && IS_DEFAULT_DATA_DIR && !fs.existsSync(DB_PATH)) {
  for (const oldPath of OLD_LOCATIONS) {
    if (fs.existsSync(oldPath)) {
      fs.renameSync(oldPath, DB_PATH);
      try { fs.renameSync(oldPath + '-wal', DB_PATH + '-wal'); } catch {}
      try { fs.renameSync(oldPath + '-shm', DB_PATH + '-shm'); } catch {}
      break;
    }
  }
}
const raw = new Database(DB_PATH, { readonly, fileMustExist: readonly, timeout: 100 });
let budget = null;
const measured = [];
let chunkSize = 32;
const totalChanges = () => raw.prepare('SELECT total_changes() AS n').get().n;
const db = new Proxy(raw, {
  get(target, key) {
    if (key === 'prepare') return sql => {
      const statement = raw.prepare(sql);
      return new Proxy(statement, { get(stmt, method) {
        const value = stmt[method];
        if (typeof value !== 'function') return value;
        if (!['run', 'get', 'all'].includes(method)) return value.bind(stmt);
        return (...args) => {
          if (!budget) return value.apply(stmt, args);
          budget.bytes += Buffer.byteLength(JSON.stringify(args));
          const changes = totalChanges();
          const started = clock();
          const result = value.apply(stmt, args);
          const ms = clock() - started;
          budget.statements.push(ms);
          budget.ms += ms;
          budget.rows += totalChanges() - changes;
          return result;
        };
      } });
    };
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
function transact(command) {
  let sample;
  const result = raw.transaction(() => {
    budget = { bytes: 0, statements: [], ms: 0, rows: 0 };
    try {
      const value = command();
      sample = { ms: budget.ms, rows: budget.rows, bytes: budget.bytes, statements: budget.statements };
      return value;
    } finally { budget = null; }
  }).immediate();
  measured.push(sample);
  if (measured.length > 256) measured.shift();
  if (sample.ms > 10) chunkSize = Math.max(1, Math.floor(chunkSize / Math.max(2, Math.ceil(sample.ms / 10))));
  else if (sample.ms < 5 && sample.rows <= 32 && sample.bytes <= 65536) chunkSize = Math.min(32, chunkSize + 1);
  return result;
}
function chunkUnit(fn, count) {
  const previous = { bytes: budget.bytes, rows: budget.rows };
  raw.exec('SAVEPOINT writer_unit');
  try {
    const result = fn();
    if (count && (budget.rows > 31 || budget.bytes > 65000)) {
      raw.exec('ROLLBACK TO writer_unit');
      Object.assign(budget, previous);
      return { deferred: true };
    }
    return { result };
  } finally { raw.exec('RELEASE writer_unit'); }
}

let searchFtsRecreated = false;
if (!readonly) {

db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 100');

db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS session_meta (
    sessionId TEXT PRIMARY KEY,
    name TEXT,
    starred INTEGER DEFAULT 0,
    archived INTEGER DEFAULT 0
  )
`);

db.exec(`CREATE TABLE IF NOT EXISTS session_meta_fields (
  sessionId TEXT NOT NULL, field TEXT NOT NULL, revision INTEGER NOT NULL, source TEXT NOT NULL,
  PRIMARY KEY (sessionId, field)
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_session_meta_fields_revision ON session_meta_fields(revision)');
if (!db.prepare('PRAGMA table_info(session_meta_fields)').all().some(c => c.name === 'transcriptTitle')) {
  db.exec('ALTER TABLE session_meta_fields ADD COLUMN transcriptTitle TEXT');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS session_cache (
    sessionId TEXT PRIMARY KEY,
    folder TEXT NOT NULL,
    projectPath TEXT,
    summary TEXT,
    firstPrompt TEXT,
    created TEXT,
    modified TEXT,
    messageCount INTEGER DEFAULT 0,
    slug TEXT,
    aiTitle TEXT,
    parentSessionId TEXT,
    agentId TEXT,
    subagentType TEXT,
    description TEXT,
    fileMtime TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS cache_meta (
    folder TEXT PRIMARY KEY,
    projectPath TEXT,
    indexMtimeMs REAL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_session_cache_folder ON session_cache(folder)');
db.exec('CREATE INDEX IF NOT EXISTS idx_session_cache_slug ON session_cache(slug)');

const migrations = [
  
  () => {},
  
  (db) => {
    try { db.exec('DELETE FROM session_cache'); } catch {}
    try { db.exec('DELETE FROM cache_meta'); } catch {}
    try { db.exec('DELETE FROM search_map'); } catch {}
    try { db.exec('DROP TABLE IF EXISTS search_fts'); } catch {}
    searchFtsRecreated = true;
  },

  (db) => {
    try { db.exec('ALTER TABLE session_cache ADD COLUMN aiTitle TEXT'); } catch {}
    try { db.exec('DELETE FROM session_cache'); } catch {}
    try { db.exec('DELETE FROM cache_meta'); } catch {}
  },

  (db) => {
    try { db.exec('ALTER TABLE session_cache ADD COLUMN parentSessionId TEXT'); } catch {}
    try { db.exec('ALTER TABLE session_cache ADD COLUMN agentId TEXT'); } catch {}
    try { db.exec('ALTER TABLE session_cache ADD COLUMN subagentType TEXT'); } catch {}
    try { db.exec('ALTER TABLE session_cache ADD COLUMN description TEXT'); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_session_cache_parent ON session_cache(parentSessionId)'); } catch {}
    try { db.exec('DELETE FROM session_cache'); } catch {}
    try { db.exec('DELETE FROM cache_meta'); } catch {}
  },

  (db) => {
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS session_metrics (
        sessionId TEXT NOT NULL,
        date TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        messageCount INTEGER DEFAULT 0,
        toolCallCount INTEGER DEFAULT 0,
        inputTokens INTEGER DEFAULT 0,
        outputTokens INTEGER DEFAULT 0,
        cacheReadTokens INTEGER DEFAULT 0,
        cacheCreationTokens INTEGER DEFAULT 0,
        PRIMARY KEY (sessionId, date, model)
      )`);
      if (db.prepare("SELECT type FROM sqlite_master WHERE name = 'session_metrics'").get()?.type === 'table') db.exec('CREATE INDEX IF NOT EXISTS idx_session_metrics_date ON session_metrics(date)');
    } catch {}
  },

  (db) => {
    try { db.exec('DROP TABLE IF EXISTS search_fts'); } catch {}
    try { db.exec('DROP TABLE IF EXISTS search_content'); } catch {}
    try { db.exec('DELETE FROM search_map'); } catch {}
    try { db.exec('VACUUM'); } catch {}
    searchFtsRecreated = true;
  },

  (db) => {
    try { db.exec('ALTER TABLE session_cache ADD COLUMN fileMtime TEXT'); } catch {}
    try { db.exec('DELETE FROM session_cache'); } catch {}
    try { db.exec('DELETE FROM cache_meta'); } catch {}
  },

  (db) => {
    try {
      const row = db.prepare('SELECT COUNT(*) AS cnt FROM session_cache').get();
      if (row.cnt > 0) {
        
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('initial_scan_complete', 'true')").run();
      }
    } catch {}
  },

  (db) => {
    try {

      const bad = db.prepare(`SELECT sessionId, folder FROM session_cache
         WHERE summary LIKE '<command-name>%' OR summary LIKE '<command-message>%'
            OR summary LIKE '<local-command-stdout>%'`
      ).all();
      if (bad.length === 0) return;
      const delRow = db.prepare('DELETE FROM session_cache WHERE sessionId = ?');
      const delFolderMeta = db.prepare('DELETE FROM cache_meta WHERE folder = ?');

      db.transaction(() => {
        for (const { sessionId, folder } of bad) {
          delRow.run(sessionId);
          if (folder) delFolderMeta.run(folder);
        }

        try {
          const delMetrics = db.prepare('DELETE FROM session_metrics WHERE sessionId = ?');
          const delFts = db.prepare("DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = 'session' AND id = ?)");
          const delContent = db.prepare("DELETE FROM search_content WHERE rowid IN (SELECT rowid FROM search_map WHERE type = 'session' AND id = ?)");
          const delMap = db.prepare("DELETE FROM search_map WHERE type = 'session' AND id = ?");
          for (const { sessionId } of bad) {
            delMetrics.run(sessionId);
            delFts.run(sessionId);
            delContent.run(sessionId);
            delMap.run(sessionId);
          }
        } catch {}
      })();
    } catch {}
  },
];

const currentDbVersion = (() => {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'db_version'").get();
    return row ? JSON.parse(row.value) : 0;
  } catch { return 0; }
})();

for (let i = currentDbVersion; i < migrations.length; i++) {
  migrations[i](db);
}
if (migrations.length > currentDbVersion) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', ?)").run(JSON.stringify(migrations.length));
}

{
  const cols = new Set(db.prepare('PRAGMA table_info(session_cache)').all().map(c => c.name));
  let mustReindex = false;
  if (!cols.has('aiTitle')) db.exec('ALTER TABLE session_cache ADD COLUMN aiTitle TEXT');

  for (const col of ['parentSessionId', 'agentId', 'subagentType', 'description', 'bridgeSessionId', 'mergedIntoSessionId']) {
    if (!cols.has(col)) {
      db.exec(`ALTER TABLE session_cache ADD COLUMN ${col} TEXT`);
      mustReindex = true;
    }
  }
  // see .ai/contexts/session-cache.md ("SDK-launched sessions")
  if (!cols.has('entrypoint')) db.exec('ALTER TABLE session_cache ADD COLUMN entrypoint TEXT');
  if (!cols.has('scheduleSlug')) db.exec('ALTER TABLE session_cache ADD COLUMN scheduleSlug TEXT');
  if (!cols.has('continuationIndex')) db.exec('ALTER TABLE session_cache ADD COLUMN continuationIndex TEXT');
  if (!cols.has('customTitle')) db.exec('ALTER TABLE session_cache ADD COLUMN customTitle TEXT');
  if (db.prepare("SELECT value FROM settings WHERE key = 'custom_title_backfill_version'").get()?.value !== '2') {
    db.transaction(() => {
      db.exec(`UPDATE session_meta_fields SET transcriptTitle = NULL WHERE field = 'name' AND source = 'user'
        AND sessionId IN (SELECT sessionId FROM session_cache WHERE parentSessionId IS NULL AND instr(folder, '::') = 0)`);
      db.exec("UPDATE session_cache SET customTitle = NULL WHERE parentSessionId IS NULL AND instr(folder, '::') = 0");
      db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('custom_title_backfill_version', '2')").run();
    })();
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_cache_parent ON session_cache(parentSessionId)');

  db.exec(`CREATE TABLE IF NOT EXISTS session_metrics (
    sessionId TEXT NOT NULL,
    date TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    messageCount INTEGER DEFAULT 0,
    toolCallCount INTEGER DEFAULT 0,
    inputTokens INTEGER DEFAULT 0,
    outputTokens INTEGER DEFAULT 0,
    cacheReadTokens INTEGER DEFAULT 0,
    cacheCreationTokens INTEGER DEFAULT 0,
    PRIMARY KEY (sessionId, date, model)
  )`);
  if (db.prepare("SELECT type FROM sqlite_master WHERE name = 'session_metrics'").get()?.type === 'table') db.exec('CREATE INDEX IF NOT EXISTS idx_session_metrics_date ON session_metrics(date)');
  if (!cols.has('fileMtime')) {
    db.exec('ALTER TABLE session_cache ADD COLUMN fileMtime TEXT');

    mustReindex = true;
  }
  if (mustReindex) {
    db.exec('DELETE FROM session_cache');
    db.exec('DELETE FROM cache_meta');

    db.exec("DELETE FROM settings WHERE key = 'initial_scan_complete'");
  }
}

db.exec('CREATE TEMP TABLE search_staging (token TEXT PRIMARY KEY, id TEXT, type TEXT, folder TEXT, title TEXT, body TEXT)');
}
db.pragma('busy_timeout = 100');
const FTS_BODY_MAX_CHARS = 32768; 

const { buildFtsMatch } = require('./fts-match');

db.exec(`
  CREATE TABLE IF NOT EXISTS search_content (
    rowid INTEGER PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    body  TEXT NOT NULL DEFAULT ''
  )
`);

db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
    title, body,
    content='search_content',
    tokenize='trigram case_sensitive 0'
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS search_map (
    rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    folder TEXT
  )
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_search_map_type_id ON search_map(type, id)');

const stmts = {
  get: db.prepare('SELECT * FROM session_meta WHERE sessionId = ?'),
  getAll: db.prepare('SELECT * FROM session_meta'),
  upsertName: db.prepare(`
    INSERT INTO session_meta (sessionId, name) VALUES (?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET name = excluded.name
  `),
  upsertStar: db.prepare(`
    INSERT INTO session_meta (sessionId, starred) VALUES (?, 1)
    ON CONFLICT(sessionId) DO UPDATE SET starred = CASE WHEN starred = 1 THEN 0 ELSE 1 END
  `),
  setStar: db.prepare(`INSERT INTO session_meta (sessionId, starred) VALUES (?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET starred = excluded.starred`),
  upsertArchived: db.prepare(`
    INSERT INTO session_meta (sessionId, archived) VALUES (?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET archived = excluded.archived
  `),
  
  cacheCount: db.prepare('SELECT COUNT(*) as cnt FROM session_cache'),
  cacheGetAll: db.prepare('SELECT * FROM session_cache'),
  cacheUpsert: db.prepare(`
    INSERT INTO session_cache (sessionId, folder, projectPath, summary, firstPrompt, created, modified, messageCount, slug, aiTitle, parentSessionId, agentId, subagentType, description, fileMtime, bridgeSessionId, mergedIntoSessionId, entrypoint, scheduleSlug, continuationIndex, customTitle)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET
      folder = excluded.folder, projectPath = excluded.projectPath,
      summary = excluded.summary, firstPrompt = excluded.firstPrompt,
      created = excluded.created, modified = excluded.modified,
      messageCount = excluded.messageCount, slug = excluded.slug,
      aiTitle = excluded.aiTitle, fileMtime = excluded.fileMtime,
      parentSessionId = excluded.parentSessionId, agentId = excluded.agentId,
      subagentType = excluded.subagentType, description = excluded.description,
      bridgeSessionId = excluded.bridgeSessionId,
      mergedIntoSessionId = excluded.mergedIntoSessionId,
      entrypoint = excluded.entrypoint, scheduleSlug = excluded.scheduleSlug,
      continuationIndex = excluded.continuationIndex, customTitle = COALESCE(excluded.customTitle, session_cache.customTitle)
  `),
  cacheGetByParent: db.prepare('SELECT * FROM session_cache WHERE parentSessionId = ? ORDER BY created ASC'),

  cacheGetByFolder: db.prepare('SELECT * FROM session_cache WHERE folder = ?'),
  cacheGetMissingEntrypoint: db.prepare('SELECT sessionId, folder FROM session_cache WHERE entrypoint IS NULL AND parentSessionId IS NULL'),
  cacheSetEntrypoint: db.prepare('UPDATE session_cache SET entrypoint = ? WHERE sessionId = ?'),
  cacheSetContinuationIndex: db.prepare('UPDATE session_cache SET continuationIndex = ? WHERE sessionId = ?'),
  cacheSetCustomTitle: db.prepare('UPDATE session_cache SET customTitle = ? WHERE sessionId = ? AND customTitle IS NULL AND fileMtime IS ?'),
  cacheGetMissingCustomTitle: db.prepare('SELECT sessionId, folder, fileMtime FROM session_cache WHERE customTitle IS NULL AND parentSessionId IS NULL'),
  cacheGetFolder: db.prepare('SELECT folder FROM session_cache WHERE sessionId = ?'),
  cacheGetSession: db.prepare('SELECT * FROM session_cache WHERE sessionId = ?'),
  cacheDeleteSession: db.prepare('DELETE FROM session_cache WHERE sessionId = ?'),
  cacheDeleteFolder: db.prepare('DELETE FROM session_cache WHERE folder = ?'),

  cacheTouchModified: db.prepare('UPDATE session_cache SET modified = ?, fileMtime = ? WHERE sessionId = ?'),
  
  metricsDeleteBySession: db.prepare('DELETE FROM session_metrics WHERE sessionId = ?'),
  metricsDeleteByFolder: db.prepare('DELETE FROM session_metrics WHERE sessionId IN (SELECT sessionId FROM session_cache WHERE folder = ?)'),
  metricsInsert: db.prepare(`
    INSERT INTO session_metrics
      (sessionId, date, model, messageCount, toolCallCount, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  
  metaGet: db.prepare('SELECT * FROM cache_meta WHERE folder = ?'),
  metaGetAll: db.prepare('SELECT * FROM cache_meta'),
  metaUpsert: db.prepare(`
    INSERT INTO cache_meta (folder, projectPath, indexMtimeMs)
    VALUES (?, ?, ?)
    ON CONFLICT(folder) DO UPDATE SET
      projectPath = excluded.projectPath, indexMtimeMs = excluded.indexMtimeMs
  `),
  metaDelete: db.prepare('DELETE FROM cache_meta WHERE folder = ?'),

  searchDeleteContentBySession: db.prepare('DELETE FROM search_content WHERE rowid IN (SELECT rowid FROM search_map WHERE type = \'session\' AND id = ?)'),
  searchDeleteBySession: db.prepare('DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = \'session\' AND id = ?)'),
  searchMapDeleteBySession: db.prepare('DELETE FROM search_map WHERE type = \'session\' AND id = ?'),
  searchDeleteContentByFolder: db.prepare('DELETE FROM search_content WHERE rowid IN (SELECT rowid FROM search_map WHERE type = \'session\' AND folder = ?)'),
  searchDeleteByFolder: db.prepare('DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = \'session\' AND folder = ?)'),
  searchMapDeleteByFolder: db.prepare('DELETE FROM search_map WHERE type = \'session\' AND folder = ?'),
  searchDeleteContentByType: db.prepare('DELETE FROM search_content WHERE rowid IN (SELECT rowid FROM search_map WHERE type = ?)'),
  searchDeleteByType: db.prepare('DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = ?)'),
  searchMapDeleteByType: db.prepare('DELETE FROM search_map WHERE type = ?'),

  searchInsertContent: db.prepare('INSERT OR REPLACE INTO search_content(rowid, title, body) VALUES (?, ?, ?)'),
  searchInsertFts: db.prepare('INSERT OR REPLACE INTO search_fts(rowid, title, body) SELECT rowid, title, body FROM search_content WHERE rowid = ?'),
  searchInsertMap: db.prepare('INSERT OR REPLACE INTO search_map(id, type, folder) VALUES (?, ?, ?)'),
  searchMapLookup: db.prepare('SELECT rowid FROM search_map WHERE id = ? AND type = ?'),

  searchUpdateTitle: db.prepare('UPDATE search_content SET title = ? WHERE rowid = (SELECT rowid FROM search_map WHERE id = ? AND type = ?)'),
  searchDeleteContentByRowid: db.prepare('DELETE FROM search_content WHERE rowid = ?'),
  searchDeleteByRowid: db.prepare('DELETE FROM search_fts WHERE rowid = ?'),
  searchMapDeleteByRowid: db.prepare('DELETE FROM search_map WHERE rowid = ?'),
  searchContentGet: db.prepare('SELECT title, body FROM search_content WHERE rowid = ?'),

  searchFtsDeleteRow: db.prepare("INSERT INTO search_fts(search_fts, rowid, title, body) SELECT 'delete', rowid, title, body FROM search_content WHERE rowid = ?"),
  searchFtsInsertRow: db.prepare('INSERT INTO search_fts(rowid, title, body) SELECT rowid, title, body FROM search_content WHERE rowid = ?'),
  
  settingsGet: db.prepare('SELECT value FROM settings WHERE key = ?'),
  settingsUpsert: db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
  settingsDelete: db.prepare('DELETE FROM settings WHERE key = ?'),
  settingsKeysWithPrefix: db.prepare('SELECT key FROM settings WHERE substr(key, 1, ?) = ?'),
  searchQuery: db.prepare(`
    SELECT search_map.id, snippet(search_fts, 1, '<mark>', '</mark>', '...', 40) as snippet
    FROM search_fts
    JOIN search_map ON search_fts.rowid = search_map.rowid
    WHERE search_map.type = ? AND search_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `),
};

const metaFieldGet = db.prepare('SELECT revision, source, transcriptTitle FROM session_meta_fields WHERE sessionId = ? AND field = ?');
const metaGetWithNameSource = db.prepare(`SELECT m.*, f.source AS nameSource, f.revision AS nameRevision, f.transcriptTitle AS nameTranscriptTitle FROM session_meta m
  LEFT JOIN session_meta_fields f ON f.sessionId = m.sessionId AND f.field = 'name' WHERE m.sessionId = ?`);
const metaFieldNext = db.prepare('SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM session_meta_fields');
const metaFieldSet = db.prepare(`INSERT INTO session_meta_fields (sessionId, field, revision, source, transcriptTitle) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(sessionId, field) DO UPDATE SET revision = excluded.revision, source = excluded.source, transcriptTitle = excluded.transcriptTitle`);

const rekeySessionMeta = db.transaction((oldId, newId, title) => {
  if (oldId === newId) return;
  const original = stmts.get.get(oldId);
  if (!original) return;
  const target = stmts.get.get(newId);
  const values = {};
  for (const field of ['name', 'starred', 'archived']) {
    const from = metaFieldGet.get(oldId, field), to = metaFieldGet.get(newId, field);
    const copy = field !== 'name' || (from ? from.source === 'user' : original.name !== title);
    const keepTarget = field !== 'name' || (to ? to.source === 'user' : target?.name !== stmts.cacheGetSession.get(newId)?.customTitle);
    const useOriginal = copy && (!target || !keepTarget || (from?.revision || 0) > (to?.revision || 0));
    values[field] = useOriginal ? original[field] : (keepTarget ? target?.[field] : null) ?? (field === 'name' ? null : 0);
    if (useOriginal) metaFieldSet.run(newId, field, from?.revision ?? 0, from?.source || 'user', from?.transcriptTitle ?? null);
  }
  db.prepare(`INSERT INTO session_meta (sessionId, name, starred, archived) VALUES (?, ?, ?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET name = excluded.name, starred = excluded.starred, archived = excluded.archived`)
    .run(newId, values.name, values.starred, values.archived);
});

function getMeta(sessionId, withNameSource = false) {
  if (withNameSource) return metaGetWithNameSource.get(sessionId) || null;
  return stmts.get.get(sessionId) || null;
}

function getAllMeta(withNameSource = false) {
  const rows = withNameSource ? db.prepare(`SELECT m.*, f.source AS nameSource, f.revision AS nameRevision, f.transcriptTitle AS nameTranscriptTitle FROM session_meta m
    LEFT JOIN session_meta_fields f ON f.sessionId = m.sessionId AND f.field = 'name'`).all() : stmts.getAll.all();
  const map = new Map();
  for (const row of rows) map.set(row.sessionId, row);
  return map;
}

const partIds = ids => Array.isArray(ids) ? [...new Set(ids)] : [ids];
const setName = db.transaction((ids, name, source = 'user') => {
  for (const sessionId of partIds(ids)) {
    const previous = getMeta(sessionId, true);
    const next = applySessionName(previous, sessionId, name, source, stmts.cacheGetSession.get(sessionId)?.customTitle ?? null);
    if (next === previous) continue;
    stmts.upsertName.run(sessionId, name);
    metaFieldSet.run(sessionId, 'name', metaFieldNext.get().revision, source, next.nameTranscriptTitle);
  }
});

const toggleStar = db.transaction(sessionId => {
  stmts.upsertStar.run(sessionId);
  metaFieldSet.run(sessionId, 'starred', metaFieldNext.get().revision, 'user', null);
  const row = stmts.get.get(sessionId);
  return row.starred;
});

const setStarred = db.transaction((ids, starred) => {
  for (const sessionId of partIds(ids)) {
    stmts.setStar.run(sessionId, starred ? 1 : 0);
    metaFieldSet.run(sessionId, 'starred', metaFieldNext.get().revision, 'user', null);
  }
  return starred ? 1 : 0;
});

const setArchived = db.transaction((ids, archived) => {
  for (const sessionId of partIds(ids)) {
    stmts.upsertArchived.run(sessionId, archived ? 1 : 0);
    metaFieldSet.run(sessionId, 'archived', metaFieldNext.get().revision, 'user', null);
  }
});

function isCachePopulated() {
  return stmts.cacheCount.get().cnt > 0;
}

function getAllCached() {
  return stmts.cacheGetAll.all();
}

const projectsRevisionQuery = db.prepare('SELECT total_changes() AS changes');
function getProjectsRevision() {
  return `${projectsRevisionQuery.get().changes}:${db.pragma('data_version', { simple: true })}`;
}

const upsertCachedSessionsBatch = db.transaction((sessions) => {
  for (const s of sessions) {
    const previous = getMeta(s.sessionId, true);
    const next = establishTranscriptBaseline(previous, s);
    stmts.cacheUpsert.run(
      s.sessionId, s.folder, s.projectPath, s.summary,
      s.firstPrompt, s.created, s.modified, s.messageCount || 0,
      s.slug || null, s.aiTitle || null,
      s.parentSessionId || null, s.agentId || null,
      s.subagentType || null, s.description || null,
      s.fileMtime || null, s.bridgeSessionId || null, s.mergedIntoSessionId || null,
      typeof s.entrypoint === 'string' ? s.entrypoint : null,
      s.scheduleSlug || null, s.continuationIndex || null, s.customTitle ?? null
    );
    if (next !== previous) metaFieldSet.run(s.sessionId, 'name', previous.nameRevision ?? 0, 'user', next.nameTranscriptTitle);
  }
});

const replaceSessionMetricsBatch = db.transaction((sessionId, rows) => {
  stmts.metricsDeleteBySession.run(sessionId);
  for (const r of rows || []) stmts.metricsInsert.run(sessionId, r.date, r.model || '', r.messageCount | 0,
    r.toolCallCount | 0, r.inputTokens | 0, r.outputTokens | 0, r.cacheReadTokens | 0, r.cacheCreationTokens | 0);
});
function replaceSessionMetrics(sessionId, rows) { replaceSessionMetricsBatch(sessionId, rows); }

function getCachedByParent(parentSessionId) {
  return stmts.cacheGetByParent.all(parentSessionId);
}

function upsertCachedSessions(sessions) {
  upsertCachedSessionsBatch(sessions);
}

const setCachedCustomTitles = db.transaction((pairs) => {
  for (const { sessionId, customTitle, fileMtime, promoteName = false } of pairs) {
    const changed = stmts.cacheSetCustomTitle.run(customTitle || '', sessionId, fileMtime || null).changes;
    const field = metaFieldGet.get(sessionId, 'name');
    if (changed && (!field || field.source === 'user') && field?.transcriptTitle == null && getMeta(sessionId)?.name) {
      metaFieldSet.run(sessionId, 'name', field?.revision ?? 0, 'user', customTitle || '');
    }
    if (changed && promoteName && customTitle && field?.source === 'transcript') setName(sessionId, customTitle, 'transcript');
  }
});

function getCachedMissingEntrypoint() {
  return stmts.cacheGetMissingEntrypoint.all();
}

function getCachedMissingCustomTitle() {
  return stmts.cacheGetMissingCustomTitle.all();
}

const setCachedEntrypoints = db.transaction((pairs) => {
  for (const { sessionId, entrypoint } of pairs) stmts.cacheSetEntrypoint.run(entrypoint, sessionId);
});

function getCachedByFolder(folder) {
  return stmts.cacheGetByFolder.all(folder);
}

function getCachedFolder(sessionId) {
  const row = stmts.cacheGetFolder.get(sessionId);
  return row ? row.folder : null;
}

function getCachedSession(sessionId) {
  return stmts.cacheGetSession.get(sessionId) || null;
}

function deleteCachedSession(sessionId) {
  stmts.metricsDeleteBySession.run(sessionId);
  stmts.cacheDeleteSession.run(sessionId);
}

function deleteCachedFolder(folder) {

  stmts.metricsDeleteByFolder.run(folder);
  stmts.cacheDeleteFolder.run(folder);
  stmts.metaDelete.run(folder);
}

function getFolderMeta(folder) {
  return stmts.metaGet.get(folder) || null;
}

function getAllFolderMeta() {
  const rows = stmts.metaGetAll.all();
  const map = new Map();
  for (const row of rows) map.set(row.folder, row);
  return map;
}

function setFolderMeta(folder, projectPath, indexMtimeMs) {
  stmts.metaUpsert.run(folder, projectPath, indexMtimeMs);
}

const upsertSearchEntriesBatch = db.transaction((entries) => {
  for (const e of entries) {

    const existing = stmts.searchMapLookup.get(e.id, e.type);
    if (existing) {
      stmts.searchDeleteByRowid.run(existing.rowid);
      stmts.searchDeleteContentByRowid.run(existing.rowid);
      stmts.searchMapDeleteByRowid.run(existing.rowid);
    }
    const result = stmts.searchInsertMap.run(e.id, e.type, e.folder || null);
    const rid = result.lastInsertRowid;
    const title = e.title || '';

    const body = (e.body || '').slice(0, FTS_BODY_MAX_CHARS);

    stmts.searchInsertContent.run(rid, title, body);
    stmts.searchInsertFts.run(rid);
  }
});

function beginSearchEntry(token, entry) {
  db.prepare("INSERT INTO search_staging(token, id, type, folder, title, body) VALUES (?, ?, ?, ?, ?, '')")
    .run(token, entry.id, entry.type, entry.folder || null, entry.title || '');
}
function appendSearchBody(token, body) {
  db.prepare('UPDATE search_staging SET body = body || ? WHERE token = ?').run(body, token);
}
function publishSearchEntry(token) {
  const entry = db.prepare('SELECT id, type, folder, title FROM search_staging WHERE token = ?').get(token);
  if (!entry) throw new Error('search staging entry missing');
  const row = entry.type === 'session' && getCachedSession(entry.id);
  const title = row ? ((getMeta(entry.id)?.name || row.customTitle || row.aiTitle || '') + ' ' + (row.summary || '')).trimStart() : entry.title;
  const existing = stmts.searchMapLookup.get(entry.id, entry.type);
  if (existing) {
    stmts.searchDeleteByRowid.run(existing.rowid);
    stmts.searchDeleteContentByRowid.run(existing.rowid);
    stmts.searchMapDeleteByRowid.run(existing.rowid);
  }
  const rid = stmts.searchInsertMap.run(entry.id, entry.type, entry.folder).lastInsertRowid;
  db.prepare('INSERT INTO search_content(rowid, title, body) SELECT ?, ?, body FROM search_staging WHERE token = ?').run(rid, title, token);
  stmts.searchInsertFts.run(rid);
  db.prepare('DELETE FROM search_staging WHERE token = ?').run(token);
}

function deleteSearchSession(sessionId) {

  stmts.searchDeleteBySession.run(sessionId);
  stmts.searchDeleteContentBySession.run(sessionId);
  stmts.searchMapDeleteBySession.run(sessionId);
}

function deleteSearchFolder(folder) {
  
  stmts.searchDeleteByFolder.run(folder);
  stmts.searchDeleteContentByFolder.run(folder);
  stmts.searchMapDeleteByFolder.run(folder);
}

function deleteSearchType(type) {
  
  stmts.searchDeleteByType.run(type);
  stmts.searchDeleteContentByType.run(type);
  stmts.searchMapDeleteByType.run(type);
}

function upsertSearchEntries(entries) {
  upsertSearchEntriesBatch(entries);
}

function getSearchFileIds(type) {
  return db.prepare('SELECT id FROM search_map WHERE type = ?').all(type).map(row => row.id);
}

const applySearchFileBatch = db.transaction((type, deletes, entries) => {
  for (const id of deletes) {
    const existing = stmts.searchMapLookup.get(id, type);
    if (!existing) continue;
    stmts.searchDeleteByRowid.run(existing.rowid);
    stmts.searchDeleteContentByRowid.run(existing.rowid);
    stmts.searchMapDeleteByRowid.run(existing.rowid);
  }
  upsertSearchEntriesBatch(entries);
});

function updateSearchTitle(id, type, title) {

  try {
    const mapRow = stmts.searchMapLookup.get(id, type);
    if (!mapRow) return;
    const rid = mapRow.rowid;
    const contentRow = stmts.searchContentGet.get(rid);
    if (!contentRow) return;
    
    stmts.searchFtsDeleteRow.run(rid);
    stmts.searchUpdateTitle.run(title, id, type);

    stmts.searchFtsInsertRow.run(rid);
  } catch {}
}

function searchByType(type, query, limit = 50, titleOnly = false) {
  try {

    const match = buildFtsMatch(query, titleOnly);
    return stmts.searchQuery.all(type, match, limit);
  } catch {
    return [];
  }
}

function isSearchIndexPopulated() {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM search_map WHERE type = ?').get('session');
  return row.cnt > 0;
}

function getSetting(key) {
  const row = stmts.settingsGet.get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function setSetting(key, value) {
  stmts.settingsUpsert.run(key, JSON.stringify(value));
}

function deleteSetting(key) {
  stmts.settingsDelete.run(key);
}

function listSettingKeys(prefix) {
  return stmts.settingsKeysWithPrefix.all(prefix.length, prefix).map(row => row.key);
}

const INITIAL_SCAN_COMPLETE_KEY = 'initial_scan_complete';

function isInitialScanComplete() {
  return getSetting(INITIAL_SCAN_COMPLETE_KEY) === true;
}

function setInitialScanComplete() {
  setSetting(INITIAL_SCAN_COMPLETE_KEY, true);
}

let dailyMetricsStmt;
function getDailyMetrics() {
  dailyMetricsStmt ??= db.prepare(`
    SELECT date,
           SUM(messageCount)            AS messageCount,
           SUM(toolCallCount)           AS toolCallCount,
           SUM(inputTokens + outputTokens) AS tokens,
           COUNT(DISTINCT sessionId)    AS sessionCount
    FROM session_metrics
    GROUP BY date
    ORDER BY date ASC
  `);
  return dailyMetricsStmt.all();
}

let dailyModelTokensStmt;
function getDailyModelTokens() {
  dailyModelTokensStmt ??= db.prepare(`
    SELECT date, model, SUM(inputTokens + outputTokens) AS tokens
    FROM session_metrics
    WHERE model != ''
    GROUP BY date, model
  `);
  const rows = dailyModelTokensStmt.all();
  const byDate = new Map();
  for (const r of rows) {
    let entry = byDate.get(r.date);
    if (!entry) {
      entry = { date: r.date, tokensByModel: {} };
      byDate.set(r.date, entry);
    }
    entry.tokensByModel[r.model] = r.tokens;
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

let modelUsageStmt;
function getModelUsage() {
  modelUsageStmt ??= db.prepare(`
    SELECT model,
           SUM(inputTokens)  AS inputTokens,
           SUM(outputTokens) AS outputTokens
    FROM session_metrics
    WHERE model != ''
    GROUP BY model
  `);
  const rows = modelUsageStmt.all();
  const out = {};
  for (const r of rows) {
    out[r.model] = { inputTokens: r.inputTokens, outputTokens: r.outputTokens };
  }
  return out;
}

let totalSessionsStmt;
let totalMetricsStmt;
function getTotalCounts() {
  totalSessionsStmt ??= db.prepare(
    'SELECT COUNT(*) AS cnt FROM session_cache WHERE parentSessionId IS NULL AND mergedIntoSessionId IS NULL'
  );
  totalMetricsStmt ??= db.prepare(`
    SELECT
      SUM(messageCount)            AS totalMessages,
      SUM(toolCallCount)           AS totalToolCalls,
      SUM(inputTokens + outputTokens) AS totalTokens
    FROM session_metrics
  `);
  const sessions = totalSessionsStmt.get();
  const metrics = totalMetricsStmt.get();
  return {
    totalSessions: sessions.cnt || 0,
    totalMessages: metrics.totalMessages || 0,
    totalToolCalls: metrics.totalToolCalls || 0,
    totalTokens: metrics.totalTokens || 0,
  };
}

function closeDb() {
  if (!raw.open) return;
  if (!readonly) {
    const result = db.pragma('wal_checkpoint(TRUNCATE)');
    if (result.some(row => row.busy)) throw new Error('writer WAL checkpoint is busy');
  }
  db.close();
}

// see .ai/contexts/session-cache.md ("Bridge history divergence")
if (!readonly) try {
  if (getSetting('bridge_uuid_index_version') !== 1) {
    db.transaction(() => {
      const bridged = db.prepare("SELECT sessionId, folder FROM session_cache WHERE parentSessionId IS NULL AND bridgeSessionId IS NOT NULL AND bridgeSessionId != ''").all();
      setSetting('bridge_uuid_reindex_folders', [...new Set(bridged.map(row => row.folder))]);
      const deleteFolderMeta = db.prepare('DELETE FROM cache_meta WHERE folder = ?');
      for (const { sessionId, folder } of bridged) {
        deleteSearchSession(sessionId);
        deleteCachedSession(sessionId);
        deleteFolderMeta.run(folder);
      }
      setSetting('bridge_uuid_index_version', 1);
    })();
  }
} catch (err) {
  console.warn('Bridge UUID repair failed; will retry on next database open:', err.message);
}

return {
  beginSearchEntry, appendSearchBody, publishSearchEntry,
  connection: db, transact, chunkUnit, changeCount: totalChanges, measurements: () => measured.slice(), nextChunkSize: () => chunkSize,
  rekeySessionMeta,
  getMeta, getAllMeta, setName, toggleStar, setStarred, setArchived,
  isCachePopulated, getAllCached, getCachedByFolder, getCachedMissingEntrypoint, setCachedEntrypoints, getCachedByParent, getCachedFolder, getCachedSession, upsertCachedSessions,
  touchCachedModified: (sessionId, modified, fileMtime = modified) => stmts.cacheTouchModified.run(modified, fileMtime, sessionId),
  setCachedContinuationIndex: (sessionId, index) => stmts.cacheSetContinuationIndex.run(index, sessionId),
  setCachedCustomTitles, getCachedMissingCustomTitle,
  deleteCachedSession, deleteCachedFolder,
  replaceSessionMetrics,
  getFolderMeta, getAllFolderMeta, setFolderMeta,
  upsertSearchEntries, updateSearchTitle, deleteSearchSession, deleteSearchFolder, deleteSearchType,
  getSearchFileIds, applySearchFileBatch,
  searchByType, isSearchIndexPopulated, searchFtsRecreated,
  getSetting, setSetting, deleteSetting, listSettingKeys,
  isInitialScanComplete, setInitialScanComplete,
  getDailyMetrics, getDailyModelTokens, getModelUsage, getTotalCounts,
  closeDb,

  DB_PATH,
  getProjectsRevision,
};

}

module.exports = { openSessionIndexStore };
