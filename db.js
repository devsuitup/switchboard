'use strict';

// see .ai/contexts/session-index-writer.md
const store = require('./session-index-store').openSessionIndexStore({ readonly: true });
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
};
