'use strict';

// see .ai/contexts/session-index-writer.md
let log = console;
const rawStore = require('./session-index-store').openSessionIndexStore({ readonly: true });
const store = Object.fromEntries(Object.entries(rawStore).map(([name, value]) => [name,
  typeof value !== 'function' || !/^(get|list|is|search)/.test(name) ? value : (...args) => {
    try { return value(...args); }
    catch (error) {
      if (/^SQLITE_BUSY/.test(error?.code || '')) {
        const caller = new Error().stack.split('\n').find(frame => /^\s*at /.test(frame) && !frame.includes(`${__filename}:`));
        log.warn(`[session-index-reader] ${name}: ${error.code} ${error.message}${caller ? ' ' + caller.trim() : ''}`);
      }
      throw error;
    }
  },
]));
const settings = new Map(store.listSettingKeys('').map(key => [key, store.getSetting(key)]));
function applySettingsAcknowledgment(entries) {
  settings.clear();
  for (const [key, value] of entries) settings.set(key, value);
}
module.exports = {
  ...store,
  getSetting: (key, { fresh = false } = {}) => structuredClone((fresh ? store.getSetting(key) : settings.get(key)) ?? null),
  listSettingKeys: prefix => [...settings.keys()].filter(key => key.startsWith(prefix)),
  isInitialScanComplete: () => settings.get('initial_scan_complete') === true,
  applySettingsAcknowledgment,
  setReadLogger: logger => { log = logger; },
};
