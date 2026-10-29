'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createWriterCommands } = require('../session-index-commands');
const supported = (() => {
  if (Number(process.versions.node.split('.')[0]) >= 22) return true;
  try { const Database = require('better-sqlite3'); new Database(':memory:').close(); return true; }
  catch { return false; }
})();

function openStore() {
  const filename = require.resolve('../session-index-store');
  const nativeRequire = createRequire(filename);
  let Database;
  try {
    Database = nativeRequire('better-sqlite3');
    new Database(':memory:').close();
  } catch (error) {
    if (error.code !== 'ERR_DLOPEN_FAILED' && !error.message.includes('NODE_MODULE_VERSION')) throw error;
    const { DatabaseSync } = require('node:sqlite');
    Database = class {
      constructor(file) { this.raw = new DatabaseSync(file); this.sequence = 0; }
      get open() { return this.raw.isOpen; }
      prepare(sql) { return this.raw.prepare(sql); }
      exec(sql) { this.raw.exec(sql); }
      close() { this.raw.close(); }
      pragma(sql, options) {
        const rows = this.raw.prepare('PRAGMA ' + sql).all();
        return options?.simple ? Object.values(rows[0])[0] : rows;
      }
      transaction(fn) {
        const run = (...args) => {
          const savepoint = 'rekey_' + this.sequence++;
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
    require: id => id === 'better-sqlite3' ? Database : nativeRequire(id),
    module, exports: module.exports, process, performance, Buffer, console,
  }, { filename });
  return module.exports.openSessionIndexStore({ readonly: false });
}

for (const hydrated of [false, true]) {
  test(`two-hop legacy rekey preserves a newer user rename, hydrated first: ${hydrated}`, {
    skip: !supported && 'native SQLite ABI differs; node:sqlite requires Node 22',
  }, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rekey-696-'));
    const prior = process.env.SWITCHBOARD_DATA_DIR;
    process.env.SWITCHBOARD_DATA_DIR = root;
    const db = openStore();
    t.after(() => {
      db.closeDb();
      if (prior === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
      else process.env.SWITCHBOARD_DATA_DIR = prior;
      fs.rmSync(root, { recursive: true, force: true });
    });
    const commands = createWriterCommands(db);
    db.connection.prepare('INSERT INTO session_meta (sessionId, name) VALUES (?, ?)').run('A', 'legacy A');
    assert.equal(db.getMeta('A', true).nameRevision, null);
    if (hydrated) db.upsertCachedSessions([{ sessionId: 'A', folder: 'fixture', projectPath: root,
      summary: null, firstPrompt: null, created: null, modified: null, customTitle: 'transcript A' }]);
    commands.renameSession('C', 'first C');
    commands.renameSession('C', 'user C');
    assert.equal(db.getMeta('C', true).nameRevision, 2);

    commands.rekeySessionMeta('A', 'B');
    assert.equal(db.getMeta('B').name, 'legacy A');
    commands.rekeySessionMeta('B', 'C');

    assert.equal(db.getMeta('C').name, 'user C', 'a copied legacy name must not undo a newer user rename');
    assert.equal(db.getMeta('C', true).nameRevision, 2);
    assert.equal(db.getMeta('B', true).nameRevision, 0, 'copying legacy metadata does not mint an edit');
    commands.renameSession('D', 'next user edit');
    assert.equal(db.getMeta('D', true).nameRevision, 3, 'rekeying does not advance the edit allocator');
  });
}
