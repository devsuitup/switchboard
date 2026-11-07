'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

module.exports = function openStore({ readonly = false } = {}) {
  const filename = path.join(__dirname, '../../session-index-store.js');
  const nativeRequire = createRequire(filename);
  let Database;
  try { Database = nativeRequire('better-sqlite3'); new Database(':memory:').close(); }
  catch (error) {
    if (error.code !== 'ERR_DLOPEN_FAILED' && !error.message.includes('NODE_MODULE_VERSION')) throw error;
    const { DatabaseSync } = require('node:sqlite');
    Database = class {
      constructor(file, options = {}) { this.raw = new DatabaseSync(file, { readOnly: !!options.readonly }); this.sequence = 0; }
      get open() { return this.raw.isOpen; }
      prepare(sql) {
        const statement = this.raw.prepare(sql);
        return new Proxy(statement, { get(target, key) {
          const value = target[key];
          return typeof value === 'function' ? (...args) => value.apply(target, args.map(arg => arg === undefined ? null : arg)) : value;
        } });
      }
      exec(sql) { this.raw.exec(sql); }
      close() { this.raw.close(); }
      pragma(sql, options) {
        const rows = this.raw.prepare('PRAGMA ' + sql).all();
        return options?.simple ? Object.values(rows[0])[0] : rows;
      }
      transaction(fn) {
        const run = (...args) => {
          const savepoint = 'test_' + this.sequence++;
          this.exec('SAVEPOINT ' + savepoint);
          try { const result = fn(...args); this.exec('RELEASE ' + savepoint); return result; }
          catch (error) { this.exec('ROLLBACK TO ' + savepoint); this.exec('RELEASE ' + savepoint); throw error; }
        };
        run.immediate = run;
        return run;
      }
    };
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    process, performance, Buffer, console, module, exports: module.exports,
    require: id => id === 'better-sqlite3' ? Database : nativeRequire(id),
  }, { filename });
  return module.exports.openSessionIndexStore({ readonly });
};

module.exports.supported = (() => {
  try { const Database = require('better-sqlite3'); new Database(':memory:').close(); return true; }
  catch { return Number(process.versions.node.split('.')[0]) >= 22; }
})();
