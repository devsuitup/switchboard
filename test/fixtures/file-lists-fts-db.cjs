'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const { Worker } = require('node:worker_threads');
const Database = require('better-sqlite3');
const { encodeProjectPath } = require('../../encode-project-path');

async function run() {
  assert.ok(process.env.SWITCHBOARD_DATA_DIR);
  const db = require('./writer-store.cjs');
  const inspect = new Database(db.DB_PATH, { fileMustExist: true });
  const project = path.join(process.env.SWITCHBOARD_DATA_DIR, 'repo');
  const claudeDir = path.join(process.env.SWITCHBOARD_DATA_DIR, 'claude');
  const projectsDir = path.join(claudeDir, 'projects');
  const folderDir = path.join(projectsDir, encodeProjectPath(project));
  fs.mkdirSync(folderDir, { recursive: true });
  fs.mkdirSync(path.join(project, '.work-files'), { recursive: true });
  fs.writeFileSync(path.join(folderDir, 'session.jsonl'), JSON.stringify({ cwd: project }) + '\n');
  const memory = path.join(project, 'CLAUDE.md');
  const other = path.join(project, 'agents.md');
  const work = path.join(project, '.work-files/note.txt');
  fs.writeFileSync(memory, 'originalterm');
  fs.writeFileSync(other, 'unchangedterm');
  fs.writeFileSync(work, 'workfileterm');
  db.upsertSearchEntries([{ id: 'stale-memory-file', type: 'memory', body: 'staleterm' }]);
  let global = {};
  const ctx = vm.createContext({
    Buffer, path, process, CLAUDE_DIR: claudeDir,
    require: require('node:module').createRequire(path.join(__dirname, '../../main.js')),
    setImmediate, activeSessions: new Map(), getSetting: () => global,
    getSearchFileIds: db.getSearchFileIds, applySearchFileBatch: db.applySearchFileBatch,
  });
  const source = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('const fileListStates ='), source.indexOf('const fileListClients =')), ctx, { filename: path.join(__dirname, '../../main.js') });
  const worker = new Worker(path.join(__dirname, '../../workers/file-lists-query.js'), { workerData: { claudeDir, projectsDir } });
  let id = 0;
  const query = async kind => {
    const state = ctx.fileListsSnapshot(kind);
    const reply = once(worker, 'message');
    worker.postMessage({ ...state, id: ++id });
    const [message] = await reply;
    assert.equal(message.error, undefined);
    assert.equal(await ctx.applyFileListIndex(kind, message.result, () => state.version === ctx.fileListsSnapshot(kind).version), true);
    return message.result;
  };
  const rows = () => inspect.prepare('SELECT * FROM search_map ORDER BY id, type').all();
  try {
    const first = await query('memory');
    assert.deepEqual(first.deletes, ['stale-memory-file']);
    assert.equal(db.searchByType('memory', 'staleterm', 20).length, 0);
    assert.equal(db.searchByType('memory', 'originalterm', 20).length, 1);
    const before = rows();
    const changes = inspect.pragma('data_version', { simple: true });
    assert.equal((await query('memory')).upserts.length, 0);
    assert.deepEqual(rows(), before);
    assert.equal(inspect.pragma('data_version', { simple: true }), changes);
    fs.writeFileSync(memory, 'replacementterm');
    assert.equal((await query('memory')).upserts.length, 1);
    assert.equal(db.searchByType('memory', 'originalterm', 20).length, 0);
    assert.equal(db.searchByType('memory', 'replacementterm', 20).length, 1);
    assert.deepEqual(rows().find(row => row.id === other), before.find(row => row.id === other));
    await query('work-file');
    assert.equal(db.searchByType('work-file', 'workfileterm', 20).length, 1);
    fs.unlinkSync(work);
    await query('work-file');
    assert.equal(db.searchByType('work-file', 'workfileterm', 20).length, 0);
    fs.unlinkSync(memory);
    await query('memory');
    assert.equal(db.searchByType('memory', 'replacementterm', 20).length, 0);
    global = { hiddenProjects: [project] };
    await query('memory');
    assert.deepEqual(db.getSearchFileIds('memory'), []);
    assert.equal(inspect.prepare('SELECT count(*) AS n FROM search_content').get().n, 0);
    inspect.prepare("INSERT INTO search_fts(search_fts, rank) VALUES('integrity-check', 1)").run();
    process.stdout.write('incremental file FTS verified\n');
  } finally {
    await worker.terminate();
    inspect.close();
    db.closeDb();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
