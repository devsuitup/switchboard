'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { loadAppFunctions, readAppSource } = require('./app-source');
const { SETTING_DEFAULTS } = require('../public/setting-defaults');

const codex = { limits: [{ kind: 'codex', short: '5h', label: 'Codex 5h', percent: 42, reset: 'tomorrow' }] };
function setup(t) {
  const dom = new JSDOM('<div id="status-bar-quota"></div><div id="stats"></div>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.statsViewerBody = w.document.querySelector('#stats');
  w.api = { getUsage: async () => ({ session: 5 }), getCodexUsage: async () => codex };
  const ctx = dom.getInternalVMContext();
  for (const file of ['utils.js', 'stats-view.js']) {
    const filename = path.join(__dirname, '../public', file);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), ctx, { filename });
  }
  loadAppFunctions(ctx, {
    functions: ['shortQuotaLabel', 'buildQuotaBar', 'refreshQuotaGauge', ...(readAppSource().includes('function applyCodexUsage(') ? ['applyCodexUsage'] : [])],
    declarations: ['quotaGaugeEl', ...(readAppSource().includes('let quotaRequest =') ? ['quotaRequest'] : [])],
  });
  return w;
}

test('Codex usage defaults off', () => assert.equal(SETTING_DEFAULTS.showCodexUsage, false));

test('sidebar reuses quota bars and distinguishes Codex; failure removes only Codex', async t => {
  const w = setup(t);
  await w.refreshQuotaGauge();
  assert.equal(w.document.querySelectorAll('.quota-item').length, 2);
  assert.equal(w.document.querySelector('[data-runtime="codex"] .quota-label')?.textContent, 'Codex 5h');
  assert.match(w.document.querySelector('[data-runtime="codex"]').title, /42%.*tomorrow/);
  w.api.getCodexUsage = async () => { throw new Error('quiet failure'); };
  await w.refreshQuotaGauge();
  assert.equal(w.document.querySelectorAll('.quota-item').length, 1);
  assert.equal(w.document.querySelector('[data-runtime="codex"]'), null);
});

test('Codex still renders if Claude fails and older refreshes cannot repaint stale rows', async t => {
  const w = setup(t);
  w.api.getUsage = async () => { throw new Error('Claude unavailable'); };
  await w.refreshQuotaGauge();
  assert.equal(w.document.querySelectorAll('.quota-item').length, 1);
  let resolve;
  w.api.getCodexUsage = () => new Promise(done => { resolve = done; });
  const stale = w.refreshQuotaGauge();
  await Promise.resolve();
  w.api.getCodexUsage = async () => ({});
  await w.refreshQuotaGauge();
  resolve(codex);
  await stale;
  assert.equal(w.document.querySelector('[data-runtime="codex"]'), null);
  assert.equal(w.document.querySelector('#status-bar-quota').style.display, 'none');
});

test('stats render separate provider sections and Codex failure removes its cached section', async t => {
  const w = setup(t);
  w.buildUsageSection({ session: 5 });
  w.buildUsageSection(codex, 'codex');
  assert.equal(w.document.querySelectorAll('.usage-container').length, 2);
  assert.equal(w.document.querySelector('.usage-container-codex .daily-chart-title')?.textContent, 'Codex Rate Limits');
  w.api.getCodexUsage = async () => ({});
  await w.document.querySelector('.usage-container-codex .usage-refresh-btn').onclick();
  assert.equal(w.document.querySelector('.usage-container-codex'), null);
  assert.equal(w.document.querySelectorAll('.usage-container').length, 1);
});

test('saving off hides both surfaces immediately and rejects in-flight stats repaint', async t => {
  const w = setup(t);
  assert.equal(typeof w.applyCodexUsage, 'function', 'runtime settings hook exists');
  await w.refreshQuotaGauge();
  w.buildUsageSection(codex, 'codex');
  let resolve;
  w.api.getCodexUsage = () => new Promise(done => { resolve = done; });
  const stale = w.refreshCodexStatsUsage();
  w.api.getCodexUsage = async () => ({});
  w.applyCodexUsage(false);
  assert.equal(w.document.querySelector('[data-runtime="codex"]'), null);
  assert.equal(w.document.querySelector('.usage-container-codex'), null);
  resolve(codex);
  await stale;
  assert.equal(w.document.querySelector('.usage-container-codex'), null);
});

test('loading stats fetches Codex without replacing Claude', async t => {
  const w = setup(t);
  w.api.refreshStats = async () => ({ stats: null, usage: { session: 5 } });
  await w.loadStats();
  assert.equal(w.document.querySelectorAll('.usage-container').length, 2);
});

test('refreshing the gauge never mutates or duplicates the supplied Claude rows', async t => {
  const w = setup(t);
  const claude = { limits: [{ kind: 'session', label: 'Current session', percent: 5 }] };
  w.api.getUsage = async () => claude;
  await w.refreshQuotaGauge();
  await w.refreshQuotaGauge();
  assert.equal(claude.limits.length, 1, 'Claude input rows stay unchanged');
  assert.equal(w.document.querySelectorAll('.quota-item').length, 2);
});
