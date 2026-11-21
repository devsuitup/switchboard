'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { loadAppFunctions } = require('./app-source');
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
    functions: ['shortQuotaLabel', 'buildQuotaBar', 'refreshQuotaGauge', 'replaceQuotaRows', 'refreshCodexQuotaGauge', 'applyCodexUsage'],
    declarations: ['quotaGaugeEl', 'quotaRequest', 'codexQuotaRequest', 'codexQuotaEnabled'],
  });
  return w;
}

test('Codex usage defaults off', () => assert.equal(SETTING_DEFAULTS.showCodexUsage, false));

test('status bar reuses quota bars and distinguishes Codex; failure removes only Codex', async t => {
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

test('turning off with a deferred save hides Codex without any usage request', async t => {
  const w = setup(t);
  await w.refreshQuotaGauge();
  w.buildUsageSection(codex, 'codex');
  const claude = w.document.querySelector('[data-runtime="claude"]');
  let codexCalls = 0, claudeCalls = 0;
  w.api.getCodexUsage = async () => { codexCalls++; return codex; };
  w.api.getUsage = async () => { claudeCalls++; return { session: 5 }; };
  await w.applyCodexUsage(false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(codexCalls, 0, 'deferred off must not fetch Codex while main still has it on');
  assert.equal(claudeCalls, 0, 'turning Codex off must not refresh Claude');
  assert.equal(w.document.querySelector('[data-runtime="codex"]'), null);
  assert.equal(w.document.querySelector('.usage-container-codex'), null);
  assert.equal(w.document.querySelector('[data-runtime="claude"]'), claude);
});

test('turning on refreshes only Codex and preserves the Claude status bar node', async t => {
  const w = setup(t);
  await w.refreshQuotaGauge();
  const claude = w.document.querySelector('[data-runtime="claude"]');
  let claudeCalls = 0, codexCalls = 0;
  w.api.getUsage = async () => { claudeCalls++; return { session: 8 }; };
  w.api.getCodexUsage = async () => { codexCalls++; return codex; };
  await w.applyCodexUsage(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(claudeCalls, 0, 'enabling Codex must not refresh Claude');
  assert.ok(codexCalls > 0);
  assert.equal(w.document.querySelector('[data-runtime="claude"]'), claude);
  assert.equal(w.document.querySelectorAll('[data-runtime="codex"]').length, 1);
});

test('disabled Stats refresh removes Codex without fetching even if main is still enabled', async t => {
  const w = setup(t);
  w.buildUsageSection({ session: 5 });
  w.buildUsageSection(codex, 'codex');
  let calls = 0;
  w.api.getCodexUsage = async () => { calls++; return codex; };
  await w.refreshCodexStatsUsage(false);
  assert.equal(calls, 0, 'disabled Stats must not fetch');
  assert.equal(w.document.querySelector('.usage-container-codex'), null);
  assert.ok(w.document.querySelector('.usage-container-claude'));
});

test('weekly Codex model labels differ from account labels and over-limit bars clamp', async t => {
  const w = setup(t);
  w.api.getCodexUsage = async () => ({ limits: [
    { kind: 'codex', short: '1wk', label: 'Codex 1wk', percent: 15 },
    { kind: 'codex', short: '1wk', label: 'Codex Spark (1wk)', percent: 125 },
  ] });
  await w.refreshQuotaGauge();
  assert.deepEqual([...w.document.querySelectorAll('[data-runtime="codex"] .quota-label')].map(el => el.textContent),
    ['Codex 1wk', 'Codex Spark (1wk)']);
  const row = w.document.querySelectorAll('[data-runtime="codex"]')[1];
  assert.equal(row.querySelector('.quota-fill').style.width, '100%');
  assert.equal(row.querySelector('.quota-pct').textContent, '125%');
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
