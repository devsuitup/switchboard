'use strict';

const MARKER = 'schedulesTabDefaultMigrated';
const STARTUP_WAIT_MS = 2000;
const PENDING = 'pending';

function migratedGlobal(global) {
  if (global != null && (typeof global !== 'object' || Array.isArray(global))) return null;
  const current = global || {};
  if (current[MARKER] === true) return null;
  const next = { ...current, [MARKER]: true };
  if (next.schedulesTab === false) delete next.schedulesTab;
  return next;
}

function migrateSchedulesTabDefault(db) {
  const before = db.getSetting('global');
  const next = migratedGlobal(before);
  if (!next) return 'none';
  db.setSetting('global', next);
  return before?.schedulesTab === false ? 'turned-on' : 'marked';
}

async function migrateSchedulesTabOnStartup(writer, log) {
  try {
    const result = await writer.migrateSchedulesTabDefault();
    if (result === 'turned-on') log.info('[schedules] Schedules tab turned on once for a profile saved before it became the default');
    return result;
  } catch (error) {
    log.warn(`[schedules] Schedules tab default migration failed, retried at next launch: ${error.message}`);
    return null;
  }
}

async function migrateSchedulesTabWithinBound(writer, log, { waitMs = STARTUP_WAIT_MS, onLateChange = () => {} } = {}) {
  const migration = migrateSchedulesTabOnStartup(writer, log);
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(resolve, waitMs, PENDING); });
  const result = await Promise.race([migration, deadline]);
  clearTimeout(timer);
  if (result !== PENDING) return result;
  log.warn(`[schedules] Schedules tab default migration still pending after ${waitMs} ms, startup continues without it`);
  migration.then(late => { if (late === 'turned-on') onLateChange(); });
  return PENDING;
}

module.exports = { STARTUP_WAIT_MS, migrateSchedulesTabDefault, migrateSchedulesTabOnStartup, migrateSchedulesTabWithinBound };
