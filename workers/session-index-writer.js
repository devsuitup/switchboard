'use strict';

const { parentPort } = require('node:worker_threads');
const { setTimeout: delay, setImmediate: yieldTurn } = require('node:timers/promises');
const { openSessionIndexStore } = require('../session-index-store');
const { createWriterCommands } = require('../session-index-commands');

// see .ai/contexts/session-index-writer.md
const db = openSessionIndexStore({ readonly: false });
const commands = createWriterCommands(db);
const rawCommands = new Set(['setSetting', 'deleteSetting', 'toggleStar', 'setStarred', 'setArchived', 'setName',
  'upsertCachedSessions', 'deleteCachedSession', 'deleteCachedFolder', 'replaceSessionMetrics',
  'touchCachedModified', 'setFolderMeta', 'deleteSearchFolder', 'deleteSearchSession', 'deleteSearchType',
  'upsertSearchEntries', 'applySearchFileBatch', 'setCachedEntrypoints', 'setCachedCustomTitles',
  'setCachedContinuationIndex', 'setInitialScanComplete']);
const settings = () => db.listSettingKeys('').map(key => [key, db.getSetting(key)]);
const queue = [];
let running = false, interactiveBurst = 0;
const backgroundCommands = new Set(['effects', 'upsertCachedSessions', 'replaceSessionMetrics', 'upsertSearchEntries',
  'applySearchFileBatch', 'setCachedEntrypoints', 'setCachedCustomTitles', 'deleteCachedFolder', 'deleteSearchFolder', 'deleteSearchType', 'dropRemoteFolder', 'cleanupWorktree']);

async function transaction(fn) {
  const backoff = [20, 50, 100];
  for (let attempt = 0; ; attempt++) {
    try { return db.transact(() => {
      const before = db.changeCount();
      const result = fn();
      if (db.changeCount() !== before) db.setSetting('_writer_revision', (db.getSetting('_writer_revision') || 0) + 1);
      return { result, committedRevision: db.getSetting('_writer_revision') || 0 };
    }); }
    catch (error) {
      if (!/^SQLITE_BUSY/.test(error.code || '') || attempt === backoff.length) throw error;
      await delay(backoff[attempt]);
    }
  }
}

function* units(name, args) {
  if (name === 'cleanupWorktree') {
    const ids = db.getAllCached().filter(row => row.projectPath === args[0]).map(row => row.sessionId);
    for (const id of ids) { yield* units('deleteCachedSession', [id]); yield* units('deleteSearchSession', [id]); }
    const folder = require('../encode-project-path').encodeProjectPath(args[0]);
    yield* units('deleteCachedFolder', [folder]);
    yield* units('deleteSearchFolder', [folder]);
    yield () => { commands.cleanupWorktree(args[0]); return ids.length; };
  } else if (['upsertCachedSessions', 'setCachedEntrypoints', 'setCachedCustomTitles'].includes(name)) {
    for (const row of args[0]) yield () => db[name]([row]);
  } else if (name === 'replaceSessionMetrics') {
    yield () => db.replaceSessionMetrics(...args);
  } else if (name === 'deleteCachedSession') {
    yield () => db.deleteCachedSession(args[0]);
  } else if (name === 'upsertSearchEntries') {
    for (const entry of args[0]) {
      const token = require('node:crypto').randomUUID();
      yield () => db.beginSearchEntry(token, entry);
      const body = (entry.body || '').slice(0, 32768);
      for (let offset = 0; offset < body.length; offset += 8192) yield () => db.appendSearchBody(token, body.slice(offset, offset + 8192));
      yield () => db.publishSearchEntry(token);
    }
  } else if (name === 'applySearchFileBatch') {
    const [type, deletes, entries] = args;
    for (const id of deletes) yield () => db.applySearchFileBatch(type, [id], []);
    for (const entry of entries) yield* units('upsertSearchEntries', [[entry]]);
  } else if (name === 'deleteCachedFolder') {
    for (const row of db.getCachedByFolder(args[0])) yield* units('deleteCachedSession', [row.sessionId]);
    yield () => db.deleteCachedFolder(args[0]);
  } else if (name === 'deleteSearchFolder' || name === 'deleteSearchType') {
    const rows = name === 'deleteSearchFolder'
      ? db.connection.prepare('SELECT id, type FROM search_map WHERE folder = ?').all(args[0])
      : db.connection.prepare('SELECT id, type FROM search_map WHERE type = ?').all(args[0]);
    for (const row of rows) yield () => db.applySearchFileBatch(row.type, [row.id], []);
  } else if (name === 'effects') {
    if ((db.getSetting('_writer_revision') || 0) !== args[1]) throw Object.assign(new Error('cache snapshot changed before writer admission'), { code: 'WRITER_STALE' });
    for (const effect of args[0]) {
      if (!rawCommands.has(effect.name) && effect.name !== 'completeRepairFolders') throw new Error(`invalid writer effect ${effect.name}`);
      yield* units(effect.name, effect.args);
    }
  } else {
    const fn = commands[name] || (rawCommands.has(name) && db[name]);
    if (!fn) throw new Error(`unknown writer command ${name}`);
    yield () => fn(...args);
  }
}

function* commandUnits(message) {
  if (message.command === 'close') { yield () => { db.closeDb(); }; return; }
  if (message.command === 'drain') { yield () => {}; return; }
  if (message.command === 'measurements') { yield () => db.measurements(); return; }
  if (message.command === 'dropRemoteFolder') {
    yield* units('deleteCachedFolder', message.args);
    yield* units('deleteSearchFolder', message.args);
    yield () => commands.completeRepairFolders(message.args);
    return;
  }
  yield* units(message.command, message.args);
}

async function drain() {
  if (running) return;
  running = true;
  while (queue.length) {
    const interactive = queue.findIndex(job => !backgroundCommands.has(job.command) && !['close', 'drain'].includes(job.command));
    const background = queue.findIndex(job => backgroundCommands.has(job.command));
    const index = interactive >= 0 && (interactiveBurst < 4 || background < 0) ? interactive : background >= 0 ? background : 0;
    const message = queue.splice(index, 1)[0];
    if (backgroundCommands.has(message.command)) interactiveBurst = 0;
    else interactiveBurst++;
    try {
      if (!message.started) { message.started = true; parentPort.postMessage({ id: message.id, started: true }); }
      message.iterator ||= commandUnits(message);
      const unit = message.deferred || message.iterator.next();
      message.deferred = null;
      if (unit.done) {
        parentPort.postMessage({ id: message.id, result: message.command === 'effects' ? { committedRevision: message.committedRevision } : message.result,
          ...(message.mutated ? { settings: settings() } : {}) });
      } else {
        if (['close', 'drain', 'measurements'].includes(message.command)) message.result = unit.value();
        else if (message.command === 'beginOffer') {
          message.result = unit.value();
        } else {
          const before = db.getSetting('_writer_revision') || 0;
          if (message.command === 'effects' && message.committedRevision !== undefined && before !== message.committedRevision) {
            throw Object.assign(new Error('cache snapshot changed between writer effect batches'), { code: 'WRITER_STALE' });
          }
          const buffered = [unit];
          let deferred;
          const acknowledgment = await transaction(() => {
            deferred = null;
            let next = unit, result, count = 0;
            while (!next.done) {
              const applied = db.chunkUnit(next.value, count);
              if (applied.deferred) { deferred = next; break; }
              result = applied.result;
              count++;
              if (count >= db.nextChunkSize()) break;
              next = buffered[count] ||= message.iterator.next();
            }
            return result;
          });
          message.result = acknowledgment.result;
          message.committedRevision = acknowledgment.committedRevision;
          message.deferred = deferred;
          message.mutated ||= (db.getSetting('_writer_revision') || 0) !== before;
        }
        if (backgroundCommands.has(message.command)) queue.unshift(message);
        else queue.push(message);
      }
    } catch (error) {
      parentPort.postMessage({ id: message.id, error: { message: error.message, code: error.code }, settings: settings() });
    }
    await yieldTurn();
  }
  running = false;
}

const heartbeat = setInterval(() => parentPort.postMessage({ heartbeat: true }), 1000);
heartbeat.unref();
parentPort.on('message', message => { queue.push(message); void drain(); });
parentPort.postMessage({ ready: true, settings: settings(), searchFtsRecreated: db.searchFtsRecreated });
