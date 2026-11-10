'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const openStore = require('./conversation-store.cjs');

function createRequestStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-request-store-'));
  const stores = new Set();
  t.after(() => {
    for (const db of stores) db.closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return () => {
    const previous = process.env.SWITCHBOARD_DATA_DIR;
    try {
      process.env.SWITCHBOARD_DATA_DIR = dir;
      const db = openStore();
      stores.add(db);
      return db;
    } finally {
      if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
      else process.env.SWITCHBOARD_DATA_DIR = previous;
    }
  };
}

module.exports = { createRequestStore };
