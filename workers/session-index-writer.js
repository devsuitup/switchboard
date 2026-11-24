'use strict';

const { parentPort } = require('node:worker_threads');
const { setTimeout: delay, setImmediate: yieldTurn } = require('node:timers/promises');
const { performance } = require('node:perf_hooks');
const { openSessionIndexStore } = require('../session-index-store');
const { createWriterCommands } = require('../session-index-commands');
const { assertHarnessSettings } = require('../harnesses');
const { createProjectDeleteProgress, commitTransaction } = require('../src/main/projects/project-delete-progress');
const { completeProjectDeletion, bindDeletionProducer, assertDeletionProducer } = require('../src/main/projects/project-delete-writer');
const { folderReadWitness } = require('../src/main/session-index/full-read-state');
const { journalCommands, writerClock } = require('../session-index-writer-client');

// see .ai/contexts/session-index-writer.md
const db = openSessionIndexStore({ readonly: false, onPinChange: pinChange => parentPort.postMessage({ pinChange }) });
const commands = createWriterCommands(db);
const deletionProgress = createProjectDeleteProgress(db);
const rawCommands = new Set(['setSetting', 'deleteSetting', 'toggleStar', 'setStarred', 'setArchived', 'setName',
  'upsertCachedSessions', 'deleteCachedSession', 'deleteCachedFolder', 'replaceSessionMetrics',
  'touchCachedModified', 'setFolderMeta', 'deleteSearchFolder', 'deleteSearchSession', 'deleteSearchType',
  'upsertSearchEntries', 'applySearchFileBatch', 'setCachedEntrypoints', 'setCachedCustomTitles',
  'setCachedContinuationIndex', 'setCachedFileSize', 'setInitialScanComplete', 'invalidateFullIndex', 'invalidateFullRead', 'deriveCachedName', 'certifyNameDerivation']);
const settings = () => db.listSettingKeys('').map(key => [key, db.getSetting(key)]);
const queue = [];
const pendingDeletionHistory = new Set();
const sealedWorkflows = new Set();
const assertWorkflow = message => {
  if (message.workflowId && sealedWorkflows.has(message.workflowId)) throw Object.assign(new Error('project workflow is sealed'), { code: 'WORKFLOW_SEALED' });
};
let running = false, interactiveBurst = 0;
const backgroundCommands = new Set(['effects', 'upsertCachedSessions', 'replaceSessionMetrics', 'upsertSearchEntries',
  'applySearchFileBatch', 'setCachedEntrypoints', 'setCachedCustomTitles', 'deleteCachedFolder', 'deleteSearchFolder', 'deleteSearchType', 'dropRemoteFolder', 'cleanupWorktree', 'certifyFullReads', 'deriveCachedNames']);
const chunkWallTimeMs = 10;
const timing = message => message.receivedAt === undefined ? {}
  : { timing: { receivedAt: message.receivedAt, startedAt: message.startedAt, finishedAt: writerClock() } };

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
  } else if (name === 'certifyFullReads') {
    for (const row of args[2]) yield () => db.certifyFullRead(args[0], args[1], row.sessionId, row.stamp, row.witness);
  } else if (name === 'deriveCachedNames') {
    for (const row of args[0]) yield Object.assign(() => {
      const result = db.deriveCachedName(row.sessionId, row.stamp, row.witness, row.collision);
      return !!result && db.certifyNameDerivation(row.sessionId, row.stamp, result.witness, result.collision);
    }, { producerCommand: 'deriveCachedName', producerArgs: [row.sessionId, row.stamp, row.witness, row.collision] });
  } else if (name === 'replaceSessionMetrics') {
    yield () => db.replaceSessionMetrics(...args);
  } else if (name === 'deleteCachedSession') {
    yield () => db.deleteCachedSession(args[0]);
  } else if (name === 'setSetting' && args[0] === 'global') {
    // see .ai/contexts/cli-harnesses.md ("Picker, toggles and settings")
    yield () => { assertHarnessSettings(args[1]); return db.setSetting(...args); };
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
    yield () => db.deleteCachedFolder(...args);
  } else if (name === 'deleteSearchFolder' || name === 'deleteSearchType') {
    const rows = name === 'deleteSearchFolder'
      ? db.connection.prepare('SELECT id, type FROM search_map WHERE folder = ?').all(args[0])
      : db.connection.prepare('SELECT id, type FROM search_map WHERE type = ?').all(args[0]);
    for (const row of rows) yield () => db.applySearchFileBatch(row.type, [row.id], []);
  } else if (name === 'effects') {
    if (!args[2] && (db.getSetting('_writer_revision') || 0) !== args[1]) throw Object.assign(new Error('cache snapshot changed before writer admission'), { code: 'WRITER_STALE' });
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
  if (message.command === 'readProjectDeletionSnapshot') { yield () => db.projectDeletionSnapshot.read(message.args[0]); return; }
  if (message.command === 'readProjectDeletionRevision') { yield () => db.projectDeletionSnapshot.revision(); return; }
  if (message.command === 'listProjectDeletionOperations') { yield () => db.projectDeletionSnapshot.operations(message.args[0]); return; }
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
    const journal = queue.findIndex(job => journalCommands.has(job.command));
    const index = control >= 0 ? control : journal >= 0 ? journal : interactive >= 0 && (interactiveBurst < 4 || background < 0) ? interactive : background >= 0 ? background : 0;
    const message = queue.splice(index, 1)[0];
    if (!journalCommands.has(message.command)) interactiveBurst = backgroundCommands.has(message.command) ? 0 : interactiveBurst + 1;
    try {
      assertWorkflow(message);
      if (!message.started) {
        message.started = true;
        if (message.receivedAt !== undefined) message.startedAt = writerClock();
        parentPort.postMessage({ id: message.id, started: true });
      }
      message.iterator ||= commandUnits(message);
      message.pending ||= [];
      const unit = message.pending[0] || message.iterator.next();
      if (unit.done) {
        pendingDeletionHistory.delete(message);
        if (message.command === 'certifyFullReads') {
          const receipt = message.certificateReceipt || { certified: true, continuous: true,
            beforeRevision: db.getSetting('_writer_revision') || 0, committedRevision: db.getSetting('_writer_revision') || 0 };
          message.result = message.args[3]?.receipt ? receipt : receipt.certified;
        }
        if (message.command === 'deriveCachedNames') message.result = message.namesDerived ?? true;
        parentPort.postMessage({ id: message.id, ...(message.producerError ? { error: { message: message.producerError.message, code: message.producerError.code } }
          : { result: message.command === 'effects' ? { committedRevision: message.committedRevision } : message.result }),
          ...(message.mutated ? { settings: settings() } : {}), ...timing(message) });
      } else {
        if (message.bindingError) throw message.bindingError;
        if (['close', 'drain', 'measurements', 'getProjectDeletionState', 'readProjectDeletionScope', 'readProjectDeletionSnapshot', 'readProjectDeletionRevision', 'listProjectDeletionOperations', 'querySessionRequestOutcome', 'readProjectArchiveEpochs', 'fenceWorkflow', 'retireWorkflow'].includes(message.command)) message.result = unit.value();
        else if (['fenceProjectDeletion', 'completeProjectDeletion'].includes(message.command)) {
          const before = db.getSetting('_writer_revision') || 0;
          message.result = await transaction(message.command, null, undefined, unit.value);
          try { if (db.projectDeletion.hasHistory()) pendingDeletionHistory.delete(message); } catch { /* see .ai/contexts/project-delete.md */ }
          message.mutated ||= (db.getSetting('_writer_revision') || 0) !== before;
        }
        else if (message.command === 'beginOffer') {
          message.result = unit.value();
        } else {
          const before = db.getSetting('_writer_revision') || 0;
          const folderFence = message.command === 'effects' && message.args[2];
          if (message.command === 'effects' && !folderFence && message.committedRevision !== undefined && before !== message.committedRevision) {
            throw Object.assign(new Error('cache snapshot changed between writer effect batches'), { code: 'WRITER_STALE' });
          }
          const buffered = message.pending.length ? message.pending : [unit];
          let committed = 0;
          const acknowledgment = await transaction(message.command, () => {
            assertWorkflow(message);
            if (folderFence && (message.folderWitness ?? folderFence.witness) !== folderReadWitness(db, folderFence.folder, folderFence.sessionIds)) {
              throw Object.assign(new Error('Startup folder changed between writer effects'), { code: 'WRITER_STALE' });
            }
            let next = unit, result, count = 0, elapsed = 0, certified = true;
            while (!next.done) {
              const execute = () => {
                try {
                  assertDeletionProducer(db, message.producerBinding || [], next.value.producerCommand, next.value.producerArgs);
                  if (next.value.producerFolder !== undefined) assertDeletionProducer(db, message.producerBinding || [], 'deleteCachedFolder', [next.value.producerFolder]);
                }
                catch (error) { message.producerError ||= error; return; }
                return next.value();
              };
              const started = performance.now();
              const applied = db.chunkUnit(execute, count);
              elapsed += performance.now() - started;
              if (applied.deferred) break;
              result = applied.result;
              if (message.command === 'certifyFullReads') certified &&= result === true;
              if (message.command === 'deriveCachedNames') certified &&= result === true;
              count++;
              if (count >= db.nextChunkSize() || elapsed >= chunkWallTimeMs) break;
              next = buffered[count] ||= message.iterator.next();
            }
            committed = count;
            return ['certifyFullReads', 'deriveCachedNames'].includes(message.command) ? certified : result;
          });
          if (folderFence) message.folderWitness = folderReadWitness(db, folderFence.folder, folderFence.sessionIds);
          if (message.command === 'deriveCachedNames') message.namesDerived = (message.namesDerived ?? true) && acknowledgment.result;
          if (message.command === 'certifyFullReads') {
            const previous = message.certificateReceipt;
            message.certificateReceipt = {
              certified: (previous?.certified ?? true) && acknowledgment.result,
              beforeRevision: previous?.beforeRevision ?? before,
              committedRevision: acknowledgment.committedRevision,
              continuous: (previous?.continuous ?? true) && (!previous || before === previous.committedRevision),
            };
          }
          message.result = acknowledgment.result;
          message.committedRevision = acknowledgment.committedRevision;
          message.pending = buffered.slice(committed);
          message.mutated ||= (db.getSetting('_writer_revision') || 0) !== before;
        }
        if (backgroundCommands.has(message.command)) queue.unshift(message);
        else queue.push(message);
      }
    } catch (error) {
      pendingDeletionHistory.delete(message);
      parentPort.postMessage({ id: message.id, error: { message: error.message, code: error.code }, settings: settings(), ...timing(message) });
    }
    await yieldTurn();
  }
  running = false;
}

const heartbeat = setInterval(() => parentPort.postMessage({ heartbeat: true }), 1000);
heartbeat.unref();
parentPort.on('message', message => {
  if (journalCommands.has(message.command)) message.receivedAt = writerClock();
  if (['completeProjectDeletion', 'fenceProjectDeletion'].includes(message.command)) pendingDeletionHistory.add(message);
  try { message.producerBinding = bindDeletionProducer(db, message.command, message.args, pendingDeletionHistory.size > 0); }
  catch (error) { message.bindingError = error; }
  queue.push(message); void drain();
});
const recoveredProjectDeletions = [];
for (let recovered; (recovered = deletionProgress.recover());) recoveredProjectDeletions.push(recovered);
parentPort.postMessage({ ready: true, settings: settings(), searchFtsRecreated: db.searchFtsRecreated, recoveredProjectDeletions });
