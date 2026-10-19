'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

test('the conversation store uses node:sqlite after a native self-registration failure',
  { skip: Number(process.versions.node.split('.')[0]) < 22 && 'node:sqlite requires Node 22' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-fallback-564-'));
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = root;
  let db;
  t.after(() => {
    db?.closeDb();
    if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
    else process.env.SWITCHBOARD_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const filename = path.join(__dirname, 'fixtures/conversation-store.cjs');
  const nativeRequire = createRequire(filename);
  const BrokenDatabase = class {
    constructor() { throw Object.assign(new Error('Module did not self-register'), { code: 'ERR_DLOPEN_FAILED' }); }
  };
  const requireStore = id => id === 'better-sqlite3' ? BrokenDatabase : nativeRequire(id);
  const module = { exports: {} };
  vm.runInNewContext('(function(require,module,__dirname){' + fs.readFileSync(filename, 'utf8') + '\n})',
    { process, performance, Buffer, console }, { filename })(id => id === 'node:module'
      ? { createRequire: target => {
        const load = createRequire(target);
        return name => name === 'better-sqlite3' ? BrokenDatabase : load(name);
      } } : requireStore(id), module, path.dirname(filename));
  assert.equal(module.exports.supported, true);
  db = module.exports();
  db.setStarred(['a', 'b'], true);
  assert.deepEqual(['a', 'b'].map(id => db.getMeta(id).starred), [1, 1]);
});
