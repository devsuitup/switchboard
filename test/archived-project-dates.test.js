'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const openStore = require('./fixtures/conversation-store.cjs');
const { createWriterCommands } = require('../session-index-commands');
const { applyDeletionUnit } = require('../src/main/projects/project-delete-writer');
const { identity } = require('../src/main/projects/project-delete-identity');
const supported = { skip: !openStore.supported && 'real SQLite requires Node 22 or matching native ABI' };

for (const action of ['hideProject', 'unhideProject', 'cleanupWorktree', 'revealAddedProject', 'finalize']) {
  for (const other of [false, true]) test('archive dates: ' + action + ' clears its date and preserves other=' + other, supported, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-dates-'));
    const previous = process.env.SWITCHBOARD_DATA_DIR;
    process.env.SWITCHBOARD_DATA_DIR = root;
    const db = openStore();
    t.after(() => {
      db.closeDb();
      if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
      else process.env.SWITCHBOARD_DATA_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    });
    const projectPath = path.join(root, 'repo'), commands = createWriterCommands(db);
    commands.hideProject(projectPath, 'archive');
    commands.hideProject(projectPath, 'archive');
    if (other) commands.hideProject('/other', 'archive');
    const otherDate = db.getSetting('global').hiddenProjectArchivedAt['/other'];
    if (action === 'hideProject') commands.hideProject(projectPath, 'delete');
    else if (action === 'unhideProject') commands.unhideProject(projectPath, null, projectPath);
    else if (action === 'finalize') applyDeletionUnit(db, { category: 'finalize', target: { project: identity({ alias: null, projectPath }), entry: projectPath, restoreTargets: [] } });
    else commands[action](projectPath);
    const global = db.getSetting('global');
    assert.equal(global.hiddenProjectArchivedAt?.[projectPath], undefined, 'removed archive must not retain its timestamp');
    if (other) assert.deepEqual({ ...global.hiddenProjectArchivedAt }, { '/other': otherDate });
    else assert.equal(Object.hasOwn(global, 'hiddenProjectArchivedAt'), false, 'empty timestamp map must be absent');
  });
}
