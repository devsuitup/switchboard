'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const openStore = require('./fixtures/conversation-store.cjs');
const { createWriterCommands } = require('../session-index-commands');
for (const hydrated of [false, true]) {
  test(`two-hop legacy rekey preserves a newer user rename, hydrated first: ${hydrated}`, {
    skip: !openStore.supported && 'native SQLite ABI differs; node:sqlite requires Node 22',
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
