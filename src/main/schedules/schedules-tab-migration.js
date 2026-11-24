'use strict';

const MARKER = 'schedulesTabDefaultMigrated';

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

module.exports = { migrateSchedulesTabDefault, migrateSchedulesTabOnStartup };
