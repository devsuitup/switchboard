'use strict';

// Issue #222: the checklist in the Settings host row. A status per item, and for
// each missing item the command to run, with a copy button. The DOM is built
// with textContent only: what the host answered is never parsed as HTML.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'public', 'remote-enrol-panel.js');

function setup({ check, copied = [] } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="row"></div></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  window.api = {
    remoteHostEnrolCheck: check || (async () => ({ ok: true, alias: 'vps', items: [] })),
    writeClipboard: async (text) => { copied.push(text); return { ok: true }; },
  };
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), dom.getInternalVMContext(), { filename: SRC });
  return { window, document: window.document, copied };
}

const ITEMS = [
  { id: 'ssh', label: 'ssh reachable', status: 'ok', detail: 'connected', command: null, where: null },
  { id: 'claude', label: 'claude CLI', status: 'missing', detail: 'not found', command: 'curl -fsSL https://claude.ai/install.sh | bash', where: 'host' },
  { id: 'tmux', label: 'tmux', status: 'unknown', detail: 'not checked', command: null, where: null, optional: true },
  { id: 'auth', label: 'account logged in', status: 'missing', detail: 'log in', command: 'claude auth login', where: 'host' },
  { id: 'ssh2', label: 'ssh again', status: 'missing', detail: 'no', command: 'ssh -o BatchMode=yes vps true', where: 'workstation' },
];

test('renderEnrolChecklist shows a status per item and a copyable command only for items that carry one', async () => {
  const { window, document, copied } = setup();
  const box = document.getElementById('row');
  window.renderEnrolChecklist(box, { ok: true, alias: 'vps', items: ITEMS });

  const rows = [...box.querySelectorAll('.enrol-item')];
  assert.deepEqual(rows.map(r => r.dataset.status), ['ok', 'missing', 'unknown', 'missing', 'missing']);
  assert.deepEqual(rows.map(r => r.querySelector('.enrol-status').textContent), ['ok', 'missing', 'unknown', 'missing', 'missing']);
  assert.equal(rows[0].querySelector('.enrol-command'), null);
  assert.equal(rows[2].querySelector('.enrol-command'), null);

  assert.equal(rows[1].querySelector('.enrol-command code').textContent, 'curl -fsSL https://claude.ai/install.sh | bash');
  assert.match(rows[1].querySelector('.enrol-where').textContent, /on the host/i);
  assert.match(rows[4].querySelector('.enrol-where').textContent, /on this machine/i);

  rows[3].querySelector('.enrol-copy').click();
  await Promise.resolve();
  assert.deepEqual(copied, ['claude auth login']);
});

test('renderEnrolChecklist treats everything the host answered as text, never as markup', () => {
  const { window, document } = setup();
  const box = document.getElementById('row');
  const hostile = '<img src=x onerror="window.pwned=1">';
  window.renderEnrolChecklist(box, {
    ok: true, alias: 'vps',
    items: [{ id: 'ssh', label: hostile, status: 'missing', detail: hostile, command: hostile, where: 'host' }],
  });
  assert.equal(box.querySelector('img'), null);
  assert.ok(box.textContent.includes(hostile));
  assert.equal(window.pwned, undefined);
});

test('renderEnrolChecklist shows an error answer as one line and no checklist', () => {
  const { window, document } = setup();
  const box = document.getElementById('row');
  window.renderEnrolChecklist(box, { ok: false, error: 'not a declared host — save the settings first' });
  assert.equal(box.querySelectorAll('.enrol-item').length, 0);
  assert.match(box.querySelector('.enrol-error').textContent, /save the settings first/);
});

test('the Check host button asks main for the row alias, trimmed, and disables itself while it waits', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const asked = [];
  const { window, document } = setup({ check: async (alias) => { asked.push(alias); await gate; return { ok: true, alias, items: ITEMS }; } });
  const row = document.getElementById('row');
  const btn = document.createElement('button');
  const box = document.createElement('div');
  row.append(btn, box);
  window.wireRemoteEnrolControls(btn, box, () => '  vps ');

  btn.click();
  btn.click();
  assert.deepEqual(asked, ['vps']);
  assert.equal(btn.disabled, true);
  release();
  await new Promise(r => setImmediate(r));
  assert.equal(btn.disabled, false);
  assert.equal(box.querySelectorAll('.enrol-item').length, ITEMS.length);
});

test('the Check host button does not call main for an empty alias', async () => {
  const asked = [];
  const { window, document } = setup({ check: async (a) => { asked.push(a); return { ok: true, items: [] }; } });
  const btn = document.createElement('button');
  const box = document.createElement('div');
  document.body.append(btn, box);
  window.wireRemoteEnrolControls(btn, box, () => '   ');
  btn.click();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(asked, []);
  assert.match(box.querySelector('.enrol-error').textContent, /alias/);
});

test('a rejected IPC call is shown as an error and re-enables the button', async () => {
  const { window, document } = setup({ check: async () => { throw new Error('ipc gone'); } });
  const btn = document.createElement('button');
  const box = document.createElement('div');
  document.body.append(btn, box);
  window.wireRemoteEnrolControls(btn, box, () => 'vps');
  btn.click();
  await new Promise(r => setImmediate(r));
  assert.equal(btn.disabled, false);
  assert.match(box.querySelector('.enrol-error').textContent, /ipc gone/);
});
