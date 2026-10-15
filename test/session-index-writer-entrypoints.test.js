'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { extractFunction } = require('./app-source');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');

test('the projects watcher timer logs a rejected refresh instead of leaking its rejection', async () => {
  let watch, timer;
  const errors = [];
  const context = vm.createContext({
    PROJECTS_DIR: 'fixture', path, console, projectsWatcher: null,
    fs: { existsSync: () => true, watch: (_dir, _opts, callback) => { watch = callback; return { on() {} }; } },
    setTimeout: fn => { timer = fn; return 1; }, clearTimeout() {},
    detectSessionTransitions() {}, notifyRendererProjectsChanged() {},
    writer: { refreshFolder: async () => { throw new Error('refresh failed'); } },
    log: { error: (...args) => errors.push(args.join(' ')) },
  });
  vm.runInContext(extractFunction(source, 'startProjectsWatcher'), context);
  context.startProjectsWatcher();
  watch('rename', 'folder');
  await assert.doesNotReject(async () => timer());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /refresh failed/);
});

for (const entry of ['move', 'close']) {
  test(`the window ${entry} entry point logs failures before the bounds write`, async () => {
    let timer;
    const handlers = new Map(), errors = [];
    const context = vm.createContext({
      appQuitting: false,
      mainWindow: {
        on: (name, fn) => handlers.set(name, fn), isDestroyed: () => false, isMinimized: () => false,
        getBounds: () => { throw new Error('bounds failed'); },
      },
      setTimeout: fn => { timer = fn; return 1; }, clearTimeout() {},
      writer: { patchGlobal: async () => {} }, log: { error: (...args) => errors.push(args.join(' ')) },
    });
    const start = source.indexOf('  let boundsTimer = null;');
    const end = source.indexOf("  mainWindow.on('closed'", start);
    assert.ok(start !== -1 && end > start);
    vm.runInContext(source.slice(start, end), context);
    await assert.doesNotReject(async () => {
      if (entry === 'move') { handlers.get('move')(); await timer(); }
      else await handlers.get('close')();
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /bounds failed/);
  });
}
