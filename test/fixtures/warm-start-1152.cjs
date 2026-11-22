'use strict';
const fs = require('node:fs');
const path = require('node:path');
const base = require('./warm-start-1144.cjs');
const ids = Array.from({ length: 12 }, (_, i) => '01a03f6c-fdf9-7c83-86e3-' + String(i + 1).padStart(12, '0'));
function body(cwd, text, meta = {}) {
  return [
    { type: 'session_meta', timestamp: '2026-08-26T10:00:00.000Z', payload: { id: 'lineage', cwd, originator: 'codex_cli_rs', ...meta } },
    { type: 'turn_context', payload: { model: 'gpt-6' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: '<environment_context>injected fixture</environment_context>' } },
    { type: 'response_item', timestamp: '2026-08-26T10:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'text', text }] } },
    { type: 'token_usage_record', timestamp: '2026-08-26T10:00:02.000Z', payload: { usage: { input_tokens: 12, output_tokens: 5 } } },
    { type: 'response_item', timestamp: '2026-08-26T10:00:03.000Z', payload: { type: 'custom_tool_call', name: 'synthetic' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n';
}
async function fixture(t) {
  const f = await base.fixture(t);
  const home = process.env.CODEX_HOME;
  const folder = 'codex/2026/08/26', other = 'codex/2026/08/27';
  const write = (i, text = 'originalword', opts = {}) => {
    const key = opts.folder || folder;
    const dir = path.join(process.env.CODEX_HOME, 'sessions', ...key.slice(6).split('/'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'rollout-2026-08-26T11-55-02-' + ids[i] + '.jsonl');
    fs.writeFileSync(file, body(opts.cwd || f.root, text, opts.meta));
    return file;
  };
  const titles = entries => fs.writeFileSync(path.join(process.env.CODEX_HOME, 'session_index.jsonl'), entries.map(([id, thread_name]) => JSON.stringify({ id, thread_name })).join('\n') + '\n');
  const scans = () => f.scans().filter(row => row.runtime === 'codex');
  return Object.defineProperties({ ...f, home, codexFolder: folder, other, codexWrite: write, titles, codexScans: scans, ids },
    Object.fromEntries(['db', 'reader', 'writer', 'worker'].map(key => [key, { get: () => f[key] }])));
}
module.exports = { ...base, fixture, ids, body };

function scan({ projectsDir, inventory = [], force = false, scope, disabledHarnesses = ['claude'], onMessage }) {
  const isolation = require('./isolated-codex-home.cjs')(null, { reuse: true });
  try {
    const filename = require.resolve('../../workers/scan-projects');
    const native = require('node:module').createRequire(filename);
    const messages = [];
    require('node:vm').runInNewContext(fs.readFileSync(filename, 'utf8'), { Buffer, console, process,
      require: name => name === 'worker_threads' ? { parentPort: { postMessage: msg => { messages.push(msg); onMessage?.(msg); } },
        workerData: { projectsDir, disabledHarnesses, folders: [], startup: { inventory, force, scope } } } : native(name),
    }, { filename });
    return messages;
  } finally { isolation.restore(); }
}
module.exports.scan = scan;

function scanFixture(t) {
  require('./isolated-codex-home.cjs')(t);
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'codex-scan-1152-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = 'codex/2026/08/26', adapter = require('../../harnesses/codex');
  const dir = adapter.folderPath(folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'rollout-example-' + ids[0] + '.jsonl');
  fs.writeFileSync(file, body(root, 'originalword'));
  const titleFile = adapter.titleIndexPath();
  fs.writeFileSync(titleFile, JSON.stringify({ id: ids[0], thread_name: 'original title' }) + '\n');
  const row = adapter.readSessionFile(file, folder);
  const config = require('../../src/main/session-index/full-read-state').fullIndexConfig({ disabledHarnesses: ['claude'] }, root);
  const entry = { folder, rows: [row], meta: { projectPath: null, fullIndexVersion: 1, fullIndexConfig: config, fullIndexPending: null } };
  return { root, folder, dir, file, titleFile, row, entry, adapter, scan: opts => scan({ projectsDir: root, inventory: [entry], ...opts }) };
}
module.exports.scanFixture = scanFixture;
