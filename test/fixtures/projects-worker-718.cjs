'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function projectsWorker(h, { onMessage = () => {}, onYield = callback => setImmediate(callback), beforeSnapshot = () => {} } = {}) {
  const filename = path.join(__dirname, '../../workers/projects-query.js'), root = path.resolve(__dirname, '../..');
  const modules = new Map(), replies = [];
  let handle;
  class Database {
    constructor(_file, options) { if (!options.readonly || !options.fileMustExist) throw Error('not readonly'); }
    pragma(value) { if (value !== 'busy_timeout = 5000') throw Error('unexpected pragma'); }
    transaction(read) { return () => { beforeSnapshot(); return read(); }; }
    prepare(sql) {
      if (sql === 'SELECT * FROM session_cache') return { all: () => structuredClone([...h.rows.values()]) };
      if (sql.startsWith('SELECT m.*')) return { all: () => [...h.meta].map(([sessionId, fields]) => ({ sessionId, ...fields })) };
      if (sql === 'SELECT * FROM cache_meta') return { all: () => structuredClone([...h.folders.values()]) };
      if (sql === 'SELECT key, value FROM settings') return { all: () => [{ key: 'initial_scan_complete', value: 'true' }] };
      throw Error('database write or unknown query: ' + sql);
    }
  }
  const parentPort = { on: (_event, callback) => { handle = callback; }, postMessage: value => {
    const copy = structuredClone(value); replies.push(copy); onMessage(copy);
  } };
  const context = vm.createContext({ console, process, Buffer, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate: onYield, structuredClone, Map, Set });
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} }; modules.set(file, module);
    const local = createRequire(file);
    const requireModule = name => {
      if (name === 'better-sqlite3') return Database;
      if (name === 'node:worker_threads') return { parentPort, workerData: { dbPath: 'readonly-fixture', projectsDir: h.root } };
      const resolved = local.resolve(name);
      if (!resolved.startsWith(root + path.sep) || resolved.includes(path.sep + 'node_modules' + path.sep) || !resolved.endsWith('.js')) return local(name);
      return load(resolved);
    };
    const wrapper = vm.compileFunction(fs.readFileSync(file, 'utf8'), ['require', 'module', 'exports', '__filename', '__dirname'],
      { parsingContext: context, filename: file });
    wrapper(requireModule, module, module.exports, file, path.dirname(file));
    return module.exports;
  }
  load(filename);
  return { handle: message => handle(message), replies };
}
module.exports = { projectsWorker };
