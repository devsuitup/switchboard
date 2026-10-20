const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { encodeProjectPath } = require('../encode-project-path');
const { isPanelShellSession } = require('../panel-terminal-target');

function loadProjectActionHandlers(overrides = {}) {
  const handlers = new Map();
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf('// --- IPC: remap-project ---');
  const end = source.indexOf('// --- IPC: get-projects ---', start);
  const context = vm.createContext({
    fs, path, encodeProjectPath, isPanelShellSession,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    activeSessions: new Map(),
    getKnownProjectPaths: () => new Set(['/repo']),
    _isKnownProjectRoot: (candidate, known) => known.includes(candidate),
    ...overrides,
  });
  vm.runInContext(source.slice(start, end), context, { filename: 'main.js' });
  return handlers;
}

function bridgeHandlers(window, handlers, calls) {
  const context = vm.createContext({
    process: { platform: process.platform, argv: [] },
    require: id => {
      if (id !== 'electron') throw new Error(id);
      return {
        contextBridge: { exposeInMainWorld: (_name, api) => Object.assign(window.api, api) },
        ipcRenderer: {
          on() {},
          invoke: async (name, ...args) => {
            calls.push([name, ...args]);
            const handler = handlers.get(name);
            if (!handler) throw new Error(`Missing handler: ${name}`);
            return handler(null, ...args);
          },
        },
        webUtils: {},
      };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8'), context, { filename: 'preload.js' });
}

module.exports = { loadProjectActionHandlers, bridgeHandlers };
