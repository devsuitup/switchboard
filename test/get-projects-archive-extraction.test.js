'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const espree = require('espree');

const root = path.join(__dirname, '..');
const filename = path.join(__dirname, 'get-projects-archive-writer.test.js');

function assertMainSlice(source, options) {
  const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const start = mainSource.indexOf('async function getProjectsSnapshot(');
  const handler = mainSource.indexOf("ipcMain.handle('get-projects'");
  const end = mainSource.indexOf('\n});', handler) + 4;
  assert.ok(start >= 0 && handler > start && end > handler);
  assert.equal(options.filename, path.join(root, 'main.js'));
  assert.equal(options.lineOffset, mainSource.slice(0, start).split('\n').length - 1,
    'coverage must start at the snapshot helper main.js line');
  assert.equal(source, mainSource.slice(start, end), 'coverage must use one contiguous shipped source slice');
}

function archiveExtraction() {
  const source = fs.readFileSync(filename, 'utf8');
  const ast = espree.parse(source, { ecmaVersion: 'latest' });
  let script;
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'TemplateLiteral' && node.expressions.length === 1
      && node.expressions[0].name === 'body') script = node.quasis[0].value.cooked;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast);
  assert.ok(script, 'archive fixture child script exists');
  const start = script.indexOf('const source =');
  const end = script.indexOf('(async () =>', start);
  const run = script.indexOf('vm.runInNewContext(', end);
  assert.ok(start >= 0 && end > start && run > end, 'archive fixture extraction boundaries exist');
  return script.slice(start, end) + script.slice(run);
}

test('archive fixture extracts a callable get-projects handler with its snapshot dependencies', async () => {
  const rows = [{ projectPath: '/fixture', sessions: [{ sessionId: 'known' }] }];
  const views = { defaultProjects: rows, allProjects: rows, rows: 1,
    projection: { removedInputs: {} } };
  const requests = [];
  const archivedModes = [];
  const context = vm.createContext({
    fs: { readFileSync: () => fs.readFileSync(path.join(root, 'main.js'), 'utf8') },
    path: { resolve: () => path.join(root, 'main.js') },
    vm: { runInNewContext: (source, context, options) => {
      assertMainSlice(source, options);
      return vm.runInNewContext(source, context, options);
    } }, console, performance, structuredClone, views, assert,
    require: createRequire(path.join(root, 'main.js')),
    db: { getSetting() {} },
    writer: { applyAndPersistArchived: async (projects, archived) => {
      archivedModes.push(archived);
      return projects;
    } },
  });
  vm.runInContext(archiveExtraction(), context, { filename });
  const invoke = vm.runInContext('invoke', context, { filename });
  for (const mode of ['both', false, true]) {
    let result;
    await assert.doesNotReject(async () => { result = await invoke(null, mode); },
      'archive fixture handler must resolve every mode with its extracted dependencies');
    requests.push(JSON.parse(JSON.stringify(result)));
  }
  assert.deepEqual(requests, [
    { defaultProjects: rows, allProjects: rows, projection: views.projection }, rows, rows,
  ]);
  assert.deepEqual(archivedModes, [false, true, false, true]);
});

test('scan fixture extracts a callable get-projects handler with its snapshot dependencies', async () => {
  const fixture = path.join(__dirname, 'fixtures/get-projects-during-scan.cjs');
  const fixtureSource = fs.readFileSync(fixture, 'utf8');
  const start = fixtureSource.indexOf('    let invoke;');
  const end = fixtureSource.indexOf('    hold = true;', start);
  assert.ok(start >= 0 && end > start, 'scan fixture extraction boundaries exist');
  const rows = [{ projectPath: '/scan', sessions: [{ sessionId: 'cached' }] }];
  const mainFilename = path.join(root, 'main.js');
  const context = vm.createContext({
    writer: { applyAndPersistArchived: async projects => projects },
    Date, structuredClone, projectsReconciledAt: Date.now(), require: createRequire(mainFilename),
  });
  const outer = vm.createContext({ context, vm: { runInContext: (source, context, options) => {
    assertMainSlice(source, options);
    return vm.runInContext(source, context, options);
  } }, console, performance, assert,
    source: fs.readFileSync(mainFilename, 'utf8'),
    require: createRequire(fixture),
    db: { getSetting() {}, isInitialScanComplete: () => true,
      isCachePopulated: () => true, isSearchIndexPopulated: () => true },
    projectsClient: { request: async () => ({ defaultProjects: rows, allProjects: rows }) },
  });
  vm.runInContext(fixtureSource.slice(start, end), outer, { filename: fixture });
  const invoke = vm.runInContext('invoke', outer, { filename: fixture });
  let result;
  await assert.doesNotReject(async () => { result = await invoke(null, 'both'); },
    'scan fixture handler must resolve with its extracted dependencies');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { defaultProjects: rows, allProjects: rows });
});

test('shared get-projects handler preserves production coverage line attribution', t => {
  const run = vm.runInNewContext;
  t.mock.method(vm, 'runInNewContext', (source, context, options) => {
    assertMainSlice(source, options);
    return run(source, context, options);
  });
  assert.equal(typeof require('./get-projects-handler.cjs')({}), 'function');
});

test('remote resize fixture loads the open-terminal handler dependencies before attach and reattach', async () => {
  const fixture = path.join(__dirname, 'terminal-refresh-ipc.test.js');
  const source = fs.readFileSync(fixture, 'utf8');
  const ast = espree.parse(source, { ecmaVersion: 'latest', range: true });
  const statement = ast.body.find(node => node.expression?.callee?.name === 'test'
    && node.expression.arguments[0]?.value === 'remote open, reattach and launch preserve the adapter sizing capability in IPC results');
  assert.ok(statement, 'remote resize fixture test exists');
  let run;
  const context = vm.createContext({ fs, path, vm, assert, createRequire, __dirname,
    require: createRequire(fixture), test: (_name, callback) => { run = callback; },
    extractFunction: require('./app-source').extractFunction });
  vm.runInContext(source.slice(...statement.range), context, { filename: fixture });
  await assert.doesNotReject(run, 'remote resize fixture must resolve attach, reattach and launch');
});

for (const file of ['bg-handoff-main.test.js', 'bg-continuation-641b.test.js']) {
  test(`${file}: PTY exit fixtures provide the writer release dependency`, () => {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const ast = espree.parse(source, { ecmaVersion: 'latest' });
    let checked = 0;
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'CallExpression' && node.callee?.object?.name === 'vm'
        && node.callee?.property?.name === 'createContext') {
        const properties = node.arguments[0]?.properties || [];
        const cache = properties.find(property => property.key?.name === 'sessionCache');
        const writer = properties.find(property => property.key?.name === 'writer');
        const releases = property => property?.value?.properties?.some(p => p.key?.name === 'releaseLiveSession');
        if (releases(cache) || releases(writer)) {
          checked++;
          assert.ok(releases(writer), `${file}: PTY exit context must provide writer.releaseLiveSession`);
        }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') visit(value);
      }
    }
    visit(ast);
    assert.equal(checked, file === 'bg-handoff-main.test.js' ? 1 : 2);
  });
}
