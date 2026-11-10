'use strict';

const { parentPort } = require('node:worker_threads');
const { setTimeout: delay, setImmediate: yieldTurn } = require('node:timers/promises');
const { openSessionIndexStore } = require('../session-index-store');
const { createWriterCommands } = require('../session-index-commands');
const { createProjectDeleteProgress, commitTransaction } = require('../src/main/projects/project-delete-progress');
const { completeProjectDeletion, bindDeletionProducer, assertDeletionProducer } = require('../src/main/projects/project-delete-writer');

// see .ai/contexts/session-index-writer.md
const db = openSessionIndexStore({ readonly: false });
const commands = createWriterCommands(db);
const deletionProgress = createProjectDeleteProgress(db);
const rawCommands = new Set(['setSetting', 'deleteSetting', 'toggleStar', 'setStarred', 'setArchived', 'setName',
  'upsertCachedSessions', 'deleteCachedSession', 'deleteCachedFolder', 'replaceSessionMetrics',
  'touchCachedModified', 'setFolderMeta', 'deleteSearchFolder', 'deleteSearchSession', 'deleteSearchType',
  'upsertSearchEntries', 'applySearchFileBatch', 'setCachedEntrypoints', 'setCachedCustomTitles',
  'setCachedContinuationIndex', 'setCachedFileSize', 'setInitialScanComplete']);
const settings = () => db.listSettingKeys('').map(key => [key, db.getSetting(key)]);
const queue = [];
const pendingDeletionHistory = new Set();
const sealedWorkflows = new Set();
const assertWorkflow = message => {
  if (message.workflowId && sealedWorkflows.has(message.workflowId)) throw Object.assign(new Error('project workflow is sealed'), { code: 'WORKFLOW_SEALED' });
};
let running = false, interactiveBurst = 0;
const backgroundCommands = new Set(['effects', 'upsertCachedSessions', 'replaceSessionMetrics', 'upsertSearchEntries',
  'applySearchFileBatch', 'setCachedEntrypoints', 'setCachedCustomTitles', 'deleteCachedFolder', 'deleteSearchFolder', 'deleteSearchType', 'dropRemoteFolder', 'cleanupWorktree']);

const busyCounts = new Map();
function flushBusyCounts() {
  if (!busyCounts.size) return;
  parentPort.postMessage({ busyCounts: Object.fromEntries(busyCounts) });
  busyCounts.clear();
}
const busyTimer = setInterval(flushBusyCounts, 60000);
busyTimer.unref();

async function transaction(name, fn, commitHook, execute = () => commitTransaction(db, fn, commitHook)) {
  const backoff = [20, 50, 100];
  for (let attempt = 0; ; attempt++) {
    try { return execute(); }
    catch (error) {
      if (!/^SQLITE_BUSY/.test(error.code || '')) throw error;
      if (!busyCounts.has(name)) busyCounts.set(name, { retries: 0, exhaustions: 0 });
      const counts = busyCounts.get(name);
      if (attempt === backoff.length) { counts.exhaustions++; throw error; }
      counts.retries++;
      await delay(backoff[attempt]);
    }
  }
}

function* units(name, args) {
  for (const unit of targetUnits(name, args)) {
    unit.producerCommand ||= name;
    unit.producerArgs ||= args;
    if (name === 'deleteCachedFolder') unit.producerFolder = args[0];
    yield unit;
  }
}
function* targetUnits(name, args) {
  if (name === 'cleanupWorktree') {
    const ids = db.getAllCached().filter(row => row.projectPath === args[0]).map(row => row.sessionId);
    for (const id of ids) { yield* units('deleteCachedSession', [id]); yield* units('deleteSearchSession', [id]); }
    const folder = require('../encode-project-path').encodeProjectPath(args[0]);
    yield* units('deleteCachedFolder', [folder]);
    yield* units('deleteSearchFolder', [folder]);
    yield () => { commands.cleanupWorktree(args[0]); return ids.length; };
  } else if (['upsertCachedSessions', 'setCachedEntrypoints', 'setCachedCustomTitles'].includes(name)) {
    for (const row of args[0]) yield Object.assign(() => db[name]([row]), { producerCommand: name, producerArgs: [[row]] });
  } else if (name === 'replaceSessionMetrics') {
    yield () => db.replaceSessionMetrics(...args);
  } else if (name === 'deleteCachedSession') {
    yield () => db.deleteCachedSession(args[0]);
  } else if (name === 'upsertSearchEntries') {
    for (const entry of args[0]) {
      const token = require('node:crypto').randomUUID();
      const tag = fn => Object.assign(fn, { producerCommand: name, producerArgs: [[entry]] });
      yield tag(() => db.beginSearchEntry(token, entry));
      const body = (entry.body || '').slice(0, 32768);
      for (let offset = 0; offset < body.length; offset += 8192) yield tag(() => db.appendSearchBody(token, body.slice(offset, offset + 8192)));
      yield tag(() => db.publishSearchEntry(token));
    }
  } else if (name === 'applySearchFileBatch') {
    const [type, deletes, entries] = args;
    for (const id of deletes) yield Object.assign(() => db.applySearchFileBatch(type, [id], []), { producerCommand: name, producerArgs: [type, [id], []] });
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
  if (['completeProjectDeletion', 'fenceProjectDeletion'].includes(message.command)) {
    for (const pending of queue) if (!pending.producerBinding?.length && !pending.bindingError) {
      try { pending.producerBinding = bindDeletionProducer(db, pending.command, pending.args, true); }
      catch (error) { pending.bindingError = error; }
    }
  }
  if (message.command === 'completeProjectDeletion') { yield* completeProjectDeletion(db, message.args[0]); return; }
  if (message.command === 'fenceWorkflow') {
    yield () => {
      const workflowId = message.args[0];
      sealedWorkflows.add(workflowId);
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].workflowId === workflowId) {
        const cancelled = queue.splice(i, 1)[0];
        pendingDeletionHistory.delete(cancelled);
        parentPort.postMessage({ id: cancelled.id, error: { message: 'project workflow is sealed', code: 'WORKFLOW_SEALED' },
          ...(cancelled.mutated ? { settings: settings() } : {}) });
      }
      return true;
    };
    return;
  }
  if (message.command === 'retireWorkflow') { yield () => sealedWorkflows.delete(message.args[0]); return; }
  if (message.command === 'getProjectDeletionState') { yield () => deletionProgress.read(message.args[0]); return; }
  if (message.command === 'readProjectDeletionScope') { yield () => deletionProgress.readScope(message.args[0]); return; }
  if (message.command === 'fenceProjectDeletion') { yield () => deletionProgress.fence(message.args[0]); return; }
  if (message.command === 'close') { yield () => { clearInterval(busyTimer); flushBusyCounts(); db.closeDb(); }; return; }
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
    const control = queue.findIndex(job => ['fenceWorkflow', 'fenceProjectDeletion'].includes(job.command));
    const index = control >= 0 ? control : interactive >= 0 && (interactiveBurst < 4 || background < 0) ? interactive : background >= 0 ? background : 0;
    const message = queue.splice(index, 1)[0];
    if (backgroundCommands.has(message.command)) interactiveBurst = 0;
    else interactiveBurst++;
    try {
      assertWorkflow(message);
      if (!message.started) { message.started = true; parentPort.postMessage({ id: message.id, started: true }); }
      message.iterator ||= commandUnits(message);
      const unit = message.deferred || message.iterator.next();
      message.deferred = null;
      if (unit.done) {
        pendingDeletionHistory.delete(message);
        parentPort.postMessage({ id: message.id, ...(message.producerError ? { error: { message: message.producerError.message, code: message.producerError.code } }
          : { result: message.command === 'effects' ? { committedRevision: message.committedRevision } : message.result }),
          ...(message.mutated ? { settings: settings() } : {}) });
      } else {
        if (message.bindingError) throw message.bindingError;
        if (['close', 'drain', 'measurements', 'getProjectDeletionState', 'readProjectDeletionScope', 'querySessionRequestOutcome', 'readProjectArchiveEpochs', 'fenceWorkflow', 'retireWorkflow'].includes(message.command)) message.result = unit.value();
        else if (['fenceProjectDeletion', 'completeProjectDeletion'].includes(message.command)) {
          const before = db.getSetting('_writer_revision') || 0;
          message.result = await transaction(message.command, null, undefined, unit.value);
          if (db.projectDeletion.hasHistory()) pendingDeletionHistory.delete(message);
          message.mutated ||= (db.getSetting('_writer_revision') || 0) !== before;
        }
        else if (message.command === 'beginOffer') {
          message.result = unit.value();
        } else {
          const before = db.getSetting('_writer_revision') || 0;
          if (message.command === 'effects' && message.committedRevision !== undefined && before !== message.committedRevision) {
            throw Object.assign(new Error('cache snapshot changed between writer effect batches'), { code: 'WRITER_STALE' });
          }
          const buffered = [unit];
          let deferred;
          const acknowledgment = await transaction(message.command, () => {
            assertWorkflow(message);
            deferred = null;
            let next = unit, result, count = 0;
            while (!next.done) {
              const execute = () => {
                try {
                  assertDeletionProducer(db, message.producerBinding || [], next.value.producerCommand, next.value.producerArgs);
                  if (next.value.producerFolder !== undefined) assertDeletionProducer(db, message.producerBinding || [], 'deleteCachedFolder', [next.value.producerFolder]);
                }
                catch (error) { message.producerError ||= error; return; }
                return next.value();
              };
              const applied = db.chunkUnit(execute, count);
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
      pendingDeletionHistory.delete(message);
      parentPort.postMessage({ id: message.id, error: { message: error.message, code: error.code }, settings: settings() });
    }
    await yieldTurn();
  }
  running = false;
}

const heartbeat = setInterval(() => parentPort.postMessage({ heartbeat: true }), 1000);
heartbeat.unref();
parentPort.on('message', message => {
  if (['completeProjectDeletion', 'fenceProjectDeletion'].includes(message.command)) pendingDeletionHistory.add(message);
  try { message.producerBinding = bindDeletionProducer(db, message.command, message.args, pendingDeletionHistory.size > 0); }
  catch (error) { message.bindingError = error; }
  queue.push(message); void drain();
});
const recoveredProjectDeletions = [];
for (let recovered; (recovered = deletionProgress.recover());) recoveredProjectDeletions.push(recovered);
parentPort.postMessage({ ready: true, settings: settings(), searchFtsRecreated: db.searchFtsRecreated, recoveredProjectDeletions });
