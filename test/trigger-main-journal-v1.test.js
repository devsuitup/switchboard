'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const espree = require('espree');
const { createJournal } = require('./fixtures/session-request-journal.cjs');

const filename = path.resolve(__dirname, '../main.js');
const source = fs.readFileSync(filename, 'utf8');
const nativeRequire = createRequire(filename);
const REQUEST = '21234567-89ab-cdef-0123-456789abcdef';

function findStart(node, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (node.type === 'TryStatement' && source.slice(...node.range).includes("trigger-watcher').start(")) found.push(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => findStart(child, found));
    else if (value && typeof value.type === 'string') findStart(value, found);
  }
  return found;
}

test('the shipped bootstrap hands its request journal through the context to the real watcher', async t => {
  const ast = espree.parse(source, { ecmaVersion: 2024, sourceType: 'commonjs', range: true });
  const candidates = findStart(ast);
  const statement = candidates.sort((a, b) => (a.range[1] - a.range[0]) - (b.range[1] - b.range[0]))[0];
  assert.ok(statement, 'main.js starts the trigger watcher');
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-main-journal-')));
  const previous = process.env.SWITCHBOARD_TRIGGERS_DIR;
  process.env.SWITCHBOARD_TRIGGERS_DIR = root;
  let watcher;
  t.after(() => {
    watcher?.close();
    if (previous === undefined) delete process.env.SWITCHBOARD_TRIGGERS_DIR; else process.env.SWITCHBOARD_TRIGGERS_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const real = nativeRequire('./src/main/triggers/trigger-watcher');
  const context = vm.createContext({
    process, console, setTimeout, clearTimeout,
    require: request => request === './src/main/triggers/trigger-watcher'
      ? { ...real, start: ctx => { watcher = real.start(ctx); return watcher; } } : nativeRequire(request),
    createTriggerContext: nativeRequire('./src/main/triggers/trigger-context').createTriggerContext,
    activeSessions: new Map(), log: { info() {}, warn() {}, error() {}, debug() {} },
    cliSessionState: { getStatus() {}, findLiveProcess() {} }, PROJECTS_DIR: path.join(root, 'projects'),
    triggerLifecycleDeps: () => ({}), writer: createJournal(), sessionTransitions: { currentSessionId: id => id },
    getSetting: () => ({}), SETTING_DEFAULTS: {}, enabledHosts: () => [], remoteIndexer: {}, remoteSendAdapter: {},
    normalizeRefreshMs: value => value,
  });
  vm.runInContext(source.slice(...statement.range), context, { filename });
  assert.ok(watcher, 'the shipped statement started the watcher');
  const input = path.join(root, REQUEST + '.json');
  fs.writeFileSync(path.join(root, REQUEST + '.tmp'), JSON.stringify({ version: 1, action: 'open' }));
  fs.renameSync(path.join(root, REQUEST + '.tmp'), input);
  const result = path.join(root, 'processed', REQUEST + '.result.json');
  const end = performance.now() + 5000;
  while (!fs.existsSync(result) && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(result), 'the request reaches a terminal result through the shipped journal wiring');
  assert.equal(JSON.parse(fs.readFileSync(result, 'utf8')).outcome, 'refused');
});
