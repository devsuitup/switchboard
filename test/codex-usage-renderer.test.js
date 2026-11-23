'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { loadAppFunctions } = require('./app-source');
const { SETTING_DEFAULTS } = require('../public/setting-defaults');
const { rootTokens, resolveCssVars } = require('./css-vars');
const { createCodexUsage } = require('../src/main/usage/codex-usage');

const codex = { limits: [{ kind: 'codex', windowMinutes: 300, short: '5h', label: 'Codex 5h', percent: 42, reset: 'tomorrow' }] };
function setup(t) {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'), { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.statsViewerBody = w.document.querySelector('#stats-viewer-body');
  w.api = { getUsage: async () => ({ session: 5 }), getCodexUsage: async () => codex, getSetting: async () => ({}) };
  const ctx = dom.getInternalVMContext();
  for (const file of ['setting-defaults.js', 'utils.js', 'stats-view.js']) {
    const filename = path.join(__dirname, '../public', file);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), ctx, { filename });
  }
  loadAppFunctions(ctx, {
    functions: ['quotaWindowLabel', 'shortQuotaLabel', 'buildQuotaBar', 'refreshQuotaGauge', 'replaceQuotaRows', 'refreshCodexQuotaGauge', 'applyCodexUsage', 'refreshCodexUsage', 'applyUsageHarnesses'],
    declarations: ['quotaGaugeEl', 'quotaRequest', 'codexQuotaRequest', 'codexQuotaEnabled', 'disabledQuotaRuntimes'],
  });
  return w;
}

test('Codex usage defaults off', () => assert.equal(SETTING_DEFAULTS.showCodexUsage, false));

test('shipped status bar contains only labelled quota rows after refresh', async t => {
  const w = setup(t);
  await w.refreshQuotaGauge();
  const gauge = w.document.querySelector('#status-bar-quota');
  assert.equal(gauge.children.length, 2, 'no unlabelled placeholder track remains');
  assert.ok([...gauge.children].every(el => el.matches('.quota-group')), 'each CLI has its own group');
  assert.deepEqual([...gauge.querySelectorAll('.quota-group-label')].map(el => el.textContent), ['Claude', 'Codex']);
});

test('shipped gauge hides when Claude is unavailable and Codex is off', async t => {
  const w = setup(t);
  w.api.getUsage = async () => { throw new Error('unavailable'); };
  await w.applyCodexUsage(false);
  await w.refreshQuotaGauge();
  const gauge = w.document.querySelector('#status-bar-quota');
  assert.equal(gauge.style.display, 'none', 'empty gauge must be hidden');
  assert.equal(gauge.children.length, 0);
});

test('opening Stats during deferred turn-off does not fetch Codex', async t => {
  const w = setup(t);
  w.api.refreshStats = async () => ({ stats: null, usage: { session: 5 } });
  await w.applyCodexUsage(false);
  let calls = 0;
  w.api.getCodexUsage = async () => { calls++; return codex; };
  await w.loadStats();
  assert.equal(calls, 0, 'opening Stats must honor the renderer off state');
  assert.equal(w.document.querySelector('.usage-container-codex'), null);
  assert.ok(w.document.querySelector('.usage-container-claude'));
});

test('Codex settings disclosure names the account-id header sent with the token', () => {
  const docs = fs.readFileSync(path.join(__dirname, '../docs/settings.md'), 'utf8');
  assert.match(docs, /account id[^\n]*`chatgpt-account-id`/);
});

test('status bar reuses quota bars and distinguishes Codex; failure removes only Codex', async t => {
  const w = setup(t);
  await w.refreshQuotaGauge();
  assert.equal(w.document.querySelectorAll('.quota-item').length, 2);
  assert.equal(w.document.querySelector('[data-runtime="codex"] .quota-label')?.textContent, '5h');
  assert.match(w.document.querySelector('[data-runtime="codex"] .quota-item').title, /Codex 5h: 42%.*tomorrow/);
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
    { kind: 'codex', windowMinutes: 10080, short: '1wk', label: 'Codex 1wk', percent: 15 },
    { kind: 'codex', windowMinutes: 10080, model: 'Spark', short: '1wk', label: 'Codex Spark (1wk)', percent: 125 },
  ] });
  await w.refreshQuotaGauge();
  assert.deepEqual([...w.document.querySelectorAll('[data-runtime="codex"] .quota-label')].map(el => el.textContent),
    ['Week', 'Spark (Week)']);
  const row = w.document.querySelectorAll('[data-runtime="codex"] .quota-item')[1];
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

for (const [minutes, label] of [[10080, 'Week'], [300, '5h'], [1440, '24h'], [4320, '3d'], [90, '90m'], [null, 'Usage']]) {
  test(`both CLI footer labels describe ${minutes} minutes as ${label}`, t => {
    const w = setup(t);
    for (const kind of ['codex', 'session']) {
      const bar = w.buildQuotaBar({ kind, windowMinutes: minutes, label: 'Original source label', percent: 8 });
      assert.equal(bar.querySelector('.quota-label').textContent, label);
      assert.match(bar.title, /Original source label: 8%/);
    }
  });
}

for (const durations of [[18000, 604800], [604800, 18000], [604800]]) {
  test(`raw Codex windows ${durations.join('/')} render by duration with no invented window`, async t => {
    const w = setup(t);
    const service = createCodexUsage({
      isEnabled: () => true,
      env: { CODEX_HOME: path.join(__dirname, 'unused-auth-fixture') },
      readFile: () => JSON.stringify({ tokens: { access_token: 'FAKE-1208' } }),
      fetch: async () => ({ ok: true, json: async () => ({ rate_limit: {
        primary_window: { used_percent: 11, limit_window_seconds: durations[0] },
        ...(durations[1] ? { secondary_window: { used_percent: 23, limit_window_seconds: durations[1] } } : {}),
      } }) }),
    });
    w.api.getCodexUsage = () => service.getUsage();
    w.api.getUsage = async () => ({ limits: [
      { kind: 'weekly_all', label: 'Week (all models)', percent: 21 },
      { kind: 'session', label: 'Current session', percent: 12, reset: 'today at 5pm' },
      { kind: 'weekly_model', model: 'Fable', label: 'Week (Fable)', percent: 31 },
    ] });
    await w.refreshQuotaGauge();
    const labels = runtime => [...w.document.querySelectorAll(`[data-runtime="${runtime}"] .quota-label`)].map(el => el.textContent);
    assert.deepEqual(labels('codex'), durations.map(d => d === 18000 ? '5h' : 'Week'));
    assert.deepEqual(labels('claude'), ['Week', '5h', 'Fable']);
    assert.match(w.document.querySelector('[data-runtime="claude"] .quota-item:nth-of-type(3)').title, /Claude.*Current session.*today at 5pm/);
  });
}

for (const runtime of ['claude', 'codex']) {
  test(`disabled ${runtime} CLI hides its entire footer group`, async t => {
    const w = setup(t);
    w.api.getSetting = async () => ({ disabledHarnesses: [runtime] });
    await w.refreshQuotaGauge();
    const group = w.document.querySelector(`[data-runtime="${runtime}"]`);
    assert.equal(group?.hidden, true, 'the saved CLI setting hides the group');
    const other = w.document.querySelector(`[data-runtime="${runtime === 'claude' ? 'codex' : 'claude'}"]`);
    assert.equal(other.hidden, false);
  });
}

test('refresh keeps group nodes and live CLI visibility survives pending settings initialization', async t => {
  const w = setup(t);
  assert.equal(typeof w.applyUsageHarnesses, 'function', 'footer supports live CLI settings');
  let resolve;
  w.api.getSetting = () => new Promise(done => { resolve = done; });
  const pending = w.refreshQuotaGauge();
  w.applyUsageHarnesses(['codex']);
  resolve({ disabledHarnesses: [] });
  await pending;
  const group = w.document.querySelector('[data-runtime="codex"]');
  assert.equal(group.hidden, true);
  w.applyUsageHarnesses([]);
  assert.equal(group.hidden, false);
  await w.refreshQuotaGauge();
  assert.equal(w.document.querySelector('[data-runtime="codex"]'), group);
});

for (const theme of ['dark', 'light']) {
  test(`${theme} footer groups use palette tokens and stay on a fixed single row`, async t => {
    const w = setup(t);
    const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
    const tokens = rootTokens(theme === 'light' ? css.replace(':root[data-theme="light"]', ':root') : css);
    w.document.documentElement.dataset.theme = theme;
    const style = w.document.createElement('style');
    style.textContent = resolveCssVars(css, tokens);
    w.document.head.appendChild(style);
    await w.refreshQuotaGauge();
    const group = w.document.querySelector('.quota-group');
    assert.ok(group, 'CLI group is rendered');
    const computed = el => w.getComputedStyle(el);
    const probe = w.document.createElement('span');
    probe.style.color = tokens['--text-label'];
    w.document.body.appendChild(probe);
    assert.equal(computed(group.querySelector('.quota-group-label')).color, computed(probe).color);
    assert.equal(computed(group).flexWrap, 'nowrap');
    const footer = w.document.querySelector('#status-bar');
    assert.equal(computed(footer).height, '22px');
    assert.equal(computed(footer).flexWrap, 'nowrap');
    assert.equal(computed(w.document.querySelector('.quota-pct')).fontVariantNumeric, 'tabular-nums');
    w.applyUsageHarnesses(['claude']);
    assert.equal(computed(group).display, 'none');
    assert.equal(computed(footer).height, '22px');
  });
}
