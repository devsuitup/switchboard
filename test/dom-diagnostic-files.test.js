'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { loadAppFunctions } = require('./app-source');
const root = path.join(__dirname, '..');
const settle = () => new Promise(resolve => setImmediate(resolve));

test('Diagnostics previews counts and bytes, confirms, reports failures and saves retention', async t => {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'public/index.html'), 'utf8'), { url: 'http://localhost', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window;
  const ctx = dom.getInternalVMContext();
  const saved = {};
  const requests = [];
  let confirm = false;
  let question;
  w.cachedAllProjects = [];
  w.appConfirm = async options => { question = options; return confirm; };
  const plan = { groups: [{ kind: 'main', count: 2, size: 2048 }, { kind: 'trace', count: 1, size: 1024 }],
    count: 1, size: 1024, files: [{ filePath: '/logs/main.old.log', eligible: true }] };
  w.api = new Proxy({
    platform: 'linux', getSetting: async key => saved[key] || {},
    setSetting: async (key, value) => { saved[key] = value; },
    getShellProfiles: async () => [], getHarnesses: async () => [], listActivityTraceFiles: async () => [],
    getDiagnosticFiles: async days => { requests.push(['preview', days]); return plan; },
    pruneDiagnosticFiles: async (...args) => { requests.push(['delete', ...args]); return { deleted: [], skipped: [], failed: [{ filePath: '<locked>', code: 'EPERM', error: 'denied' }] }; },
  }, { get: (target, key) => target[key] || (() => Promise.resolve({})) });
  loadAppFunctions(ctx, { functions: ['saveGlobalSettings'], declarations: ['_persistChain'] });
  loadAppFunctions(ctx, { sourcePath: path.join(root, 'public/sidebar.js'), functions: ['isProjectDeleting', 'projectDeletionKey', 'paintProjectDeletionBusy'], declarations: ['deletingProjectKeys', 'projectDeletionUnavailable'] });
  for (const file of ['setting-defaults.js', 'utils.js', 'shortcuts.js', 'terminal-themes.js', 'remote-enrol-panel.js', 'archived-manager.js', 'activity-trace-panel.js', 'settings-panel.js']) {
    const filename = path.join(root, 'public', file);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), ctx, { filename });
  }
  await w.openSettingsViewer('global', null, null, { section: 'advanced' });
  await settle();
  const q = selector => w.document.querySelector(selector);
  assert.ok(q('#sv-log-retention-days'), 'Diagnostics exposes the retention control');
  assert.equal(q('#sv-log-retention-days').value, '14');
  assert.match(q('#sv-diagnostic-inventory').textContent, /Main logs: 2 files.*2.0 KB/);
  q('#sv-prune-logs').click(); await settle();
  assert.ok(question, 'deletion must ask for confirmation');
  assert.match(question.message, /1 files.*1.0 KB/);
  assert.equal(question.danger, true);
  assert.equal(requests.filter(r => r[0] === 'delete').length, 0, 'Cancel never deletes');
  confirm = true;
  q('#sv-log-retention-days').value = '30';
  q('#sv-prune-logs').click(); await settle(); await settle();
  assert.equal(requests.find(r => r[0] === 'delete')[1], 30);
  assert.match(q('#sv-prune-result').textContent, /0 deleted.*0 skipped.*1 failed/);
  assert.match(q('#sv-prune-result').textContent, /<locked>.*EPERM/);
  assert.equal(q('#sv-prune-result locked'), null);
  q('#sv-save-btn').click(); await settle(); await settle();
  assert.equal(saved.global.logRetentionDays, 30);
});
