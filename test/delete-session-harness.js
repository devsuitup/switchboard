const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const targets = require('../delete-session-target');

function loadDeletionHandlers(overrides) {
  const handlers = new Map();
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('delete-session-preview'");
  const end = source.indexOf("ipcMain.handle('archive-session'", start);
  const context = vm.createContext({
    fs, ...targets,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    log: { info() {}, warn() {}, error() {} },
    activeSessions: new Map(),
    deleteSessionGuard: async () => null,
    isRemoteFolder: folder => folder?.includes('::'),
    REMOTE_READ_ONLY: 'remote transcript is read-only',
    mainTouchedCache: { dropSession() {} },
    ...overrides,
  });
  vm.runInContext(source.slice(start, end), context, { filename: 'main.js' });
  return handlers;
}

module.exports = { loadDeletionHandlers };
