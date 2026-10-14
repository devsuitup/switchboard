'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const transitions = require('../session-transitions');

test('watcher and subagent settle detection route through asynchronous observations', async () => {
  const calls = [];
  transitions.init({ PROJECTS_DIR: os.tmpdir(), activeSessions: new Map(), getMainWindow: () => null,
    log: console, scanTransitions: async folder => { calls.push(folder); } });
  await transitions.detectSessionTransitions('fixture');
  await transitions.detectSubagentTransitions('id', { projectFolder: 'fixture' }, path.join(os.tmpdir(), 'fixture'));
  assert.deepEqual(calls, ['fixture', 'fixture']);
});

test('worker observations preserve subagent bootstrap without synchronous main filesystem calls', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transition-observations-'));
  const dir = path.join(root, 'fixture', 'parent', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-child.jsonl'), '{}\n');
  const worker = new Worker(path.join(__dirname, '../workers/session-transitions-query.js'));
  try {
    const result = await new Promise((resolve, reject) => {
      worker.once('message', message => message.error ? reject(new Error(message.error)) : resolve(message.result));
      worker.once('error', reject);
      worker.postMessage({ id: 1, projectsDir: root, folder: 'fixture', sessions: [{ id: 'parent', knownJsonlFiles: [] }] });
    });
    const session = { projectFolder: 'fixture' };
    transitions.init({ PROJECTS_DIR: root, activeSessions: new Map([['parent', session]]), getMainWindow: () => null, log: console });
    const originals = new Map(['statSync', 'readdirSync', 'openSync', 'readFileSync'].map(name => [name, fs[name]]));
    try {
      for (const name of originals.keys()) fs[name] = () => { throw new Error(`main must not call ${name}`); };
      transitions.detectSessionTransitions('fixture', result.observations);
    } finally { for (const [name, fn] of originals) fs[name] = fn; }
    assert.equal(session.knownSubagents.get('child').completed, true);
  } finally { await worker.terminate(); fs.rmSync(root, { recursive: true, force: true }); }
});
