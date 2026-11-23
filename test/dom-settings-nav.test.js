'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { loadAppFunctions } = require('./app-source');

const root = path.join(__dirname, '..');
const settle = () => new Promise(resolve => setImmediate(resolve));
const globalPages = ['general', 'sessions', 'keyboard', 'automation', 'remote', 'integrations', 'archived', 'advanced'];

test('a saved host with zero transcripts opens the same remote launch flow as project plus', async t => {
  const h = setup(t);
  h.saved.global = { remoteHosts: [{ alias: 'box', label: 'Sandbox', enabled: true }] };
  const ipc = [];
  Object.assign(h.w, {
    cachedProjects: [], pendingSessions: new Map(), sessionMap: new Map(),
    encodeProjectPath: p => p.replace(/\//g, '-'),
    createTerminalEntry: () => ({ initialSize: { cols: 90, rows: 25 }, terminal: { write() {} } }),
    syncPtySizeAfterOpen() {}, showSession() {}, schedulePersistWorkingSet() {}, pollActiveSessions() {}, refreshSidebar() {},
  });
  h.w.api.remoteLaunchSession = async payload => { ipc.push(JSON.parse(JSON.stringify(payload))); return { ok: true }; };
  for (const file of ['modal-stack.js', 'dialogs.js']) {
    const filename = path.join(root, 'public', file);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), h.ctx, { filename });
  }
  loadAppFunctions(h.ctx, { functions: ['launchRemoteSession'] });
  await h.open('global', { section: 'remote' });
  const button = h.q('.rh-new-session');
  assert.ok(button, 'a host with zero transcripts offers New session');
  assert.equal(button.disabled, false);
  assert.match(button.title, /New session on Sandbox/);
  button.click();
  await settle();
  assert.equal(h.q('#rld-path').value, '', 'host entry asks for a remote working directory');
  h.q('#rld-path').value = '/sandbox/work/first';
  h.q('#rld-mode-grid [data-mode="plan"]').click();
  h.q('.new-session-start-btn').click();
  await settle();
  assert.equal(ipc.length, 1);
  h.w.showRemoteLaunchDialog({ remoteAlias: 'box', projectPath: '/sandbox/work/first' });
  h.q('#rld-mode-grid [data-mode="plan"]').click();
  h.q('.new-session-start-btn').click();
  await settle();
  assert.equal(ipc.length, 2);
  assert.match(ipc[0].sessionId, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...ipc[0], sessionId: ipc[1].sessionId }, ipc[1], 'host and project launch payloads differ only by generated UUID');
  assert.deepEqual(ipc[0], { alias: 'box', sessionId: ipc[0].sessionId, cwd: '/sandbox/work/first',
    options: { permissionMode: 'plan' }, initialSize: { cols: 90, rows: 25 } });
});

test('host launch requires a saved enabled alias and follows alias edits and Save', async t => {
  const h = setup(t);
  const opened = [];
  h.w.showRemoteLaunchDialog = p => opened.push(p.remoteAlias);
  h.saved.global = { remoteHosts: [{ alias: 'box', enabled: true }, { alias: 'off', enabled: false }] };
  await h.open('global', { section: 'remote' });
  const rows = [...h.w.document.querySelectorAll('.remote-host-row')];
  assert.ok(rows[0].querySelector('.rh-new-session'), 'each host row offers the action');
  assert.equal(rows[1].querySelector('.rh-new-session').disabled, true, 'a disabled host has a disabled launch button');
  rows[1].querySelector('.rh-new-session').click();
  await settle();
  assert.deepEqual(opened, [], 'disabled hosts cannot launch');
  rows[0].querySelector('.rh-alias').value = 'unsaved';
  rows[0].querySelector('.rh-alias').dispatchEvent(new h.w.Event('input', { bubbles: true }));
  rows[0].querySelector('.rh-new-session').click();
  await settle();
  assert.deepEqual(opened, [], 'edited alias must be saved before launch');
  assert.match(h.q('.remote-host-enrol').textContent, /save.*settings/i);
  h.q('#sv-save-btn').click();
  await settle(); await settle();
  h.q('.rh-new-session').click();
  await settle();
  assert.deepEqual(opened, ['unsaved']);
});

test('host launch button follows host toggle changes', async t => {
  const h = setup(t);
  h.saved.global = { remoteHosts: [{ alias: 'box', enabled: true }] };
  await h.open('global', { section: 'remote' });
  const toggle = h.q('.rh-enabled');
  for (const enabled of [false, true]) {
    toggle.checked = enabled;
    toggle.dispatchEvent(new h.w.Event('change', { bubbles: true }));
    assert.equal(h.q('.rh-new-session').disabled, !enabled, 'the launch button follows the host toggle');
  }
});

test('host launch title follows label and alias edits', async t => {
  const h = setup(t);
  h.saved.global = { remoteHosts: [{ alias: 'box', label: 'Sandbox', enabled: true }] };
  await h.open('global', { section: 'remote' });
  const label = h.q('.rh-label');
  label.value = 'Renamed';
  label.dispatchEvent(new h.w.Event('input', { bubbles: true }));
  assert.equal(h.q('.rh-new-session').title, 'New session on Renamed…');
  label.value = '';
  label.dispatchEvent(new h.w.Event('input', { bubbles: true }));
  assert.equal(h.q('.rh-new-session').title, 'New session on box…');
  h.q('.rh-alias').value = 'other';
  h.q('.rh-alias').dispatchEvent(new h.w.Event('input', { bubbles: true }));
  assert.equal(h.q('.rh-new-session').title, 'New session on other…');
});

test('repeated host launch clicks open only one dialog while the saved settings read is pending', async t => {
  const h = setup(t);
  h.saved.global = { remoteHosts: [{ alias: 'box', enabled: true }] };
  await h.open('global', { section: 'remote' });
  let resolve;
  let reads = 0;
  h.w.api.getSetting = () => { reads++; return new Promise(r => { resolve = r; }); };
  const opened = [];
  h.w.showRemoteLaunchDialog = p => opened.push(p.remoteAlias);
  const button = h.q('.rh-new-session');
  button.click();
  assert.equal(button.disabled, true, 'the pending settings read disables the launch button synchronously');
  button.click();
  const toggle = h.q('.rh-enabled');
  toggle.checked = false;
  toggle.dispatchEvent(new h.w.Event('change', { bubbles: true }));
  toggle.checked = true;
  toggle.dispatchEvent(new h.w.Event('change', { bubbles: true }));
  assert.equal(button.disabled, true, 'toggling the host cannot unlock a pending launch');
  button.dispatchEvent(new h.w.Event('click'));
  assert.equal(reads, 1, 'repeated clicks share one pending settings read');
  resolve(h.saved.global);
  await settle();
  assert.deepEqual(opened, ['box']);
  assert.equal(button.disabled, false, 'the button is restored after the read settles');
});

test('General Appearance offers and saves Theme only globally', async t => {
  const h = setup(t);
  const applied = [];
  h.w.appTheme = { apply: value => applied.push(value) };
  await h.open();
  const select = h.q('#sv-theme');
  assert.ok(select, 'Theme select exists');
  assert.equal(select.closest('.settings-page').dataset.section, 'general');
  assert.equal(select.value, 'dark');
  assert.deepEqual([...select.options].map(o => [o.value, o.textContent]), [['dark', 'Dark'], ['light', 'Light'], ['system', 'System']]);
  select.value = 'system';
  h.q('#sv-save-btn').click(); await settle(); await settle();
  assert.equal(h.saved.global.theme, 'system');
  assert.deepEqual(applied, ['system']);
  await h.open();
  assert.equal(h.q('#sv-theme').value, 'system');
  await h.open('project');
  assert.equal(h.q('#sv-theme'), null);
});

test('Appearance options come from the shared theme choices', async t => {
  const h = setup(t);
  assert.equal(vm.runInContext('typeof THEME_CHOICES', h.ctx, { filename: __filename }), 'object', 'shared theme choices exist');
  vm.runInContext("THEME_CHOICES.push(['test-theme', 'Test theme'])", h.ctx, { filename: __filename });
  await h.open();
  assert.ok([...h.q('#sv-theme').options].some(option => option.value === 'test-theme' && option.textContent === 'Test theme'));
});

test('settings filter is labelled and keyboard reachable above navigation in both scopes', async t => {
  const h = setup(t);
  for (const scope of ['global', 'project']) {
    await h.open(scope);
    const filter = h.q('#sv-filter');
    assert.ok(filter, 'Settings exposes a filter field');
    assert.equal(filter.getAttribute('aria-label'), 'Filter settings');
    assert.equal(filter.placeholder, 'Filter settings…');
    assert.equal(filter.tabIndex, 0);
    assert.ok(filter.compareDocumentPosition(h.q('.settings-nav')) & h.w.Node.DOCUMENT_POSITION_FOLLOWING);
    filter.focus();
    assert.equal(h.w.document.activeElement, filter);
  }
});

function filterSettings(h, value) {
  const filter = h.q('#sv-filter');
  assert.ok(filter, 'Settings exposes a filter field');
  filter.value = value;
  filter.dispatchEvent(new h.w.Event('input', { bubbles: true }));
  return filter;
}

function visibleSettingsRows(h) {
  return [...h.w.document.querySelectorAll('.settings-page .settings-field')]
    .filter(row => !row.closest('[hidden]'));
}

test('project filter ignores the Use global default control label', async t => {
  const h = setup(t);
  await h.open('project');
  assert.ok(h.q('#settings-page-launch .settings-use-global'));
  filterSettings(h, 'global');
  assert.deepEqual(visibleSettingsRows(h), [], 'global must not match any Launch row');
  assert.deepEqual(h.active(), []);
});

test('filter ignores select option labels and shortcut bindings', async t => {
  const h = setup(t);
  await h.open();
  assert.match(h.q('#sv-codex-sandbox').textContent, /Full access \(danger\)/);
  const shortcut = h.q('.settings-shortcut-btn').textContent;
  assert.ok(shortcut.trim());
  for (const term of ['Full access (danger)', shortcut]) {
    filterSettings(h, term);
    assert.deepEqual(visibleSettingsRows(h), [], term + ' is only control text');
  }
});

test('filter ignores dynamic values and statuses but keeps descriptive prose searchable', async t => {
  const h = setup(t);
  h.w.api.getActivityReportingState = async () => ({ destination: 'uniquedestination', url: 'http://uniqueurl:5600' });
  h.w.api.getActivityTraceState = async () => ({ dir: '/uniquetracedir' });
  h.saved.global = { remoteHosts: [{ alias: 'uniquehost', label: 'Unique host', enabled: true }] };
  await h.open();
  const texts = [
    ['#sv-current-version', 'uniqueversion'],
    ['#sv-update-status', 'uniqueupdatestatus'],
    ['#sv-activity-reporting-status', 'uniquereportingstatus'],
    ['#sv-remote-status', 'uniqueremotestatus'],
    ['.sv-harness-desc', 'uniqueharnessstatus'],
  ];
  for (const [selector, text] of texts) h.q(selector).textContent = text;
  const hosts = h.q('#sv-remote-hosts');
  assert.ok(hosts.querySelector('.rh-check'));
  for (const term of [...texts.map(([, text]) => text), 'uniquedestination', 'uniqueurl', 'uniquetracedir', 'Check host', 'Add host']) {
    await t.test(term, () => {
      assert.ok(h.q('.settings-form').textContent.includes(term), 'excluded text is present in the DOM');
      filterSettings(h, term);
      assert.deepEqual(visibleSettingsRows(h), [], term + ' must not match a setting');
    });
  }
  filterSettings(h, 'local time tracker');
  assert.deepEqual(visibleSettingsRows(h), [h.q('#sv-activity-reporting').closest('.settings-field')]);
  filterSettings(h, '~/.ssh/config');
  assert.deepEqual(visibleSettingsRows(h), [hosts.closest('.settings-field')]);
  assert.equal(h.q('#sv-remote-hosts'), hosts, 'search leaves the live controls in place');
  for (const [selector, text] of texts) assert.equal(h.q(selector).textContent, text);
});

test('filter beta leaves only its row under General and dims every other navigation item', async t => {
  const h = setup(t);
  await h.open();
  h.click('sessions');
  filterSettings(h, '  BeTa  ');
  assert.deepEqual(h.active(), ['general']);
  assert.deepEqual(visibleSettingsRows(h).map(row => row.querySelector('.settings-label').textContent), ['Receive beta versions']);
  assert.equal(h.q('#settings-page-general h2').textContent, 'General');
  for (const button of h.nav()) assert.equal(button.classList.contains('settings-no-match'), button.dataset.section !== 'general');
  assert.deepEqual([...h.q('#settings-page-general').querySelectorAll('.settings-section')].filter(group => !group.hidden).map(group => group.querySelector('h3').textContent), ['Updates']);
});

test('filter reads current descriptions across pages, not ids, values or fuzzy words', async t => {
  const h = setup(t);
  await h.open();
  filterSettings(h, 'downgrades');
  assert.deepEqual(visibleSettingsRows(h).map(row => row.querySelector('input')?.id), ['sv-receive-beta-versions']);
  h.q('#sv-pre-launch').value = 'uniquefiltervalue';
  for (const term of ['uniquefiltervalue', 'sv-receive-beta-versions', 'recbeta']) {
    filterSettings(h, term);
    assert.deepEqual(visibleSettingsRows(h), [], term + ' must not match');
    assert.deepEqual(h.active(), []);
    assert.equal(h.q('.settings-filter-empty')?.hidden, false);
    assert.match(h.q('.settings-filter-empty').textContent, /No settings match/);
  }
  for (const id of ['sv-receive-beta-versions', 'sv-pre-launch']) {
    h.q('#' + id).closest('.settings-field').querySelector('.settings-description').append(' currentfiltertext');
  }
  filterSettings(h, 'currentfiltertext');
  assert.deepEqual(h.active(), ['general', 'sessions']);
  assert.equal(visibleSettingsRows(h).length, 2, 'matching reads live DOM descriptions');
});

test('Escape or clearing restores the current page, rows and navigation without persisting a filter', async t => {
  const h = setup(t);
  await h.open();
  h.click('keyboard');
  const filter = filterSettings(h, 'beta');
  assert.deepEqual(h.active(), ['general']);
  assert.equal(h.w.localStorage.getItem('settingsSection:global'), 'keyboard');
  filter.focus();
  const escape = new h.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  filter.dispatchEvent(escape);
  assert.equal(filter.value, '');
  assert.equal(escape.defaultPrevented, true);
  assert.equal(h.w.document.activeElement, filter);
  assert.deepEqual(h.active(), ['keyboard']);
  assert.equal(visibleSettingsRows(h).length, 8);
  assert.ok(h.nav().every(button => !button.classList.contains('settings-no-match')));
  filterSettings(h, 'beta');
  filterSettings(h, '');
  assert.deepEqual(h.active(), ['keyboard']);
  filterSettings(h, 'beta');
  await h.open();
  assert.equal(h.q('#sv-filter').value, '');
  assert.deepEqual(h.active(), ['keyboard']);
});

test('filtered navigation keeps results stacked and Tab focuses a visible matching control', async t => {
  const h = setup(t);
  await h.open();
  filterSettings(h, 'beta');
  const nav = h.click('sessions');
  assert.deepEqual(h.active(), ['general'], 'navigation cannot expose unrelated rows while filtering');
  nav.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.equal(h.w.document.activeElement, h.q('#sv-receive-beta-versions'));
  filterSettings(h, '');
  assert.deepEqual(h.active(), ['sessions']);
});

test('a filtered global row saves through the same form and filtering is never a dirty edit', async t => {
  const h = setup(t);
  await h.open();
  const toggle = h.q('#sv-receive-beta-versions');
  filterSettings(h, 'beta');
  assert.equal(h.q('#sv-unsaved').textContent, '', 'filter is not a setting');
  assert.deepEqual(visibleSettingsRows(h), [toggle.closest('.settings-field')]);
  assert.equal(h.q('#sv-receive-beta-versions'), toggle);
  toggle.click();
  h.q('#sv-save-btn').click();
  await settle();
  assert.equal(h.saved.global.receiveBetaVersions, true);
  assert.equal(Object.hasOwn(h.saved.global, 'filter'), false);
  assert.equal(h.q('#sv-unsaved').textContent, '');
  filterSettings(h, 'other text');
  assert.equal(h.q('#sv-unsaved').textContent, '');
});

test('project filtering reveals Launch settings, preserves inheritance and saves overrides', async t => {
  const h = setup(t);
  await h.open('project');
  h.click('project');
  filterSettings(h, 'pre-launch');
  assert.deepEqual(h.active(), ['launch']);
  assert.deepEqual(visibleSettingsRows(h).map(row => row.querySelector('.settings-label').textContent), ['Pre-launch Command']);
  const field = h.q('#sv-pre-launch');
  assert.equal(field.disabled, true);
  h.q('[data-field="preLaunchCmd"]').click();
  field.value = 'echo filter';
  field.dispatchEvent(new h.w.Event('input', { bubbles: true }));
  h.q('#sv-save-btn').click();
  await settle();
  assert.equal(h.saved['project:/project'].preLaunchCmd, 'echo filter');
  filterSettings(h, '');
  assert.deepEqual(h.active(), ['project']);
  assert.equal(h.q('#sv-archive-btn').closest('[hidden]'), null);
});

test('Archived retains its independent filter and selection when settings filtering is cleared', async t => {
  const h = setup(t);
  h.saved.global = { hiddenProjects: ['/alpha', '/beta'] };
  await h.open('global', { section: 'archived' });
  const archivedFilter = h.q('.archived-filter');
  archivedFilter.value = 'beta';
  archivedFilter.dispatchEvent(new h.w.Event('input', { bubbles: true }));
  const selection = h.q('.archived-row input[type="checkbox"]');
  assert.ok(selection);
  selection.click();
  const archived = h.q('#settings-page-archived');
  const archivedMarkup = archived.innerHTML;
  const descendants = [...archived.querySelectorAll('*')];
  const mutations = new h.w.MutationObserver(() => {});
  mutations.observe(archived, { attributes: true, childList: true, subtree: true });
  t.after(() => mutations.disconnect());
  const assertArchivedUntouched = () => {
    assert.equal(archived.innerHTML, archivedMarkup, 'filter must not add hidden attributes inside Archived');
    assert.deepEqual([...archived.querySelectorAll('*')], descendants, 'Archived keeps its DOM nodes');
    assert.equal(mutations.takeRecords().filter(record => record.target !== archived).length, 0, 'only the Archived page itself may change visibility');
  };
  filterSettings(h, 'beta');
  assertArchivedUntouched();
  assert.deepEqual(h.active(), ['general'], 'Archived is excluded from settings matches');
  assert.equal(h.q('#sv-unsaved').textContent, '');
  filterSettings(h, '');
  assertArchivedUntouched();
  assert.deepEqual(h.active(), ['archived']);
  assert.equal(h.q('.archived-filter'), archivedFilter);
  assert.equal(archivedFilter.value, 'beta');
  assert.equal(selection.checked, true);
  assert.equal(h.w.document.querySelectorAll('.archived-row').length, 1);
  assert.match(h.q('.archived-row').textContent, /beta/);
});

test('filter layout hides unmatched flex rows and stacks results in a shared scrolling area', () => {
  const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
  assert.match(css, /\.settings-layout \[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /\.settings-filtering \.settings-pages\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.settings-filtering \.settings-page\s*\{[^}]*height:\s*auto/);
  assert.match(css, /\.settings-nav button\.settings-no-match\s*\{[^}]*opacity:/);
});

test('Codex usage is opt-in under CLI Agents and saving applies it without restart', async t => {
  const h = setup(t);
  const applied = [];
  h.w._applyCodexUsage = value => applied.push(value);
  await h.open();
  const toggle = h.q('#sv-show-codex-usage');
  assert.ok(toggle, 'Show Codex usage toggle exists');
  assert.equal(toggle.checked, false);
  assert.equal(toggle.closest('.settings-page').dataset.section, 'sessions');
  assert.equal(toggle.closest('.settings-section').querySelector('.settings-section-title').textContent, 'CLI Agents');
  assert.match(toggle.closest('.settings-field').textContent, /chatgpt.com/);
  for (const enabled of [true, false]) {
    toggle.checked = enabled;
    toggle.dispatchEvent(new h.w.Event('change', { bubbles: true }));
    h.q('#sv-save-btn').click();
    await settle();
    assert.equal(h.saved.global.showCodexUsage, enabled);
    assert.equal(applied.at(-1), enabled);
  }
  await h.open('project');
  assert.equal(h.q('#sv-show-codex-usage'), null);
});

for (const runtime of ['claude', 'codex']) {
  test(`saving the ${runtime} CLI toggle immediately hides and restores its footer group`, async t => {
    const h = setup(t);
    loadAppFunctions(h.ctx, {
      functions: ['quotaWindowLabel', 'shortQuotaLabel', 'buildQuotaBar', 'replaceQuotaRows', 'applyUsageHarnesses'],
      declarations: ['quotaGaugeEl', 'disabledQuotaRuntimes'],
    });
    h.w._applyUsageHarnesses = h.w.applyUsageHarnesses;
    h.w.replaceQuotaRows([{ kind: 'session', label: 'Current session', percent: 7 }], 'claude');
    h.w.replaceQuotaRows([{ kind: 'codex', windowMinutes: 10080, label: 'Codex 1wk', percent: 11 }], 'codex');
    const group = h.q(`[data-runtime="${runtime}"]`);
    await h.open();
    const toggle = h.q(`.sv-harness-toggle[data-harness="${runtime}"]`);
    for (const enabled of [false, true]) {
      toggle.checked = enabled;
      toggle.dispatchEvent(new h.w.Event('change', { bubbles: true }));
      h.q('#sv-save-btn').click();
      await settle();
      assert.equal(group.hidden, !enabled, 'Save applies CLI visibility to the whole footer group');
      assert.equal(h.q(`[data-runtime="${runtime}"]`), group);
    }
  });
}

function setup(t) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'public/index.html'), 'utf8'), { url: 'http://localhost', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window;
  const ctx = dom.getInternalVMContext();
  const saved = {};
  const timers = [];
  const observers = [];
  w.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  w.clearTimeout = id => { if (timers[id - 1]) timers[id - 1].fn = () => {}; };
  w.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
  };
  w.cachedAllProjects = [];
  w.setRemoteHostLabels = () => {};
  w.api = new Proxy({
    platform: 'linux',
    getSetting: async key => saved[key] || {},
    setSetting: async (key, value) => { saved[key] = value; },
    getShellProfiles: async () => [],
    getHarnesses: async () => [{ id: 'claude', label: 'Claude', enabled: true }, { id: 'codex', label: 'Codex', enabled: true }],
    getHarnessModels: async () => [],
    getAppVersion: async () => '0.0.0',
  }, { get: (target, key) => target[key] || (() => Promise.resolve({})) });
  loadAppFunctions(ctx, { functions: ['saveGlobalSettings'], declarations: ['_persistChain'] });
  loadAppFunctions(ctx, { sourcePath: path.join(root, 'public/sidebar.js'), functions: ['isProjectDeleting', 'projectDeletionKey', 'paintProjectDeletionBusy'], declarations: ['deletingProjectKeys', 'projectDeletionUnavailable'] });
  for (const file of ['setting-defaults.js', 'utils.js', 'app-notices.js', 'shortcuts.js', 'terminal-themes.js', 'remote-enrol-panel.js', 'archived-manager.js', 'settings-panel.js']) {
    const filename = path.join(root, 'public', file);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), ctx, { filename });
  }
  const q = selector => w.document.querySelector(selector);
  const nav = () => [...w.document.querySelectorAll('.settings-nav button')];
  const open = (scope = 'global', options) => w.openSettingsViewer(scope, scope === 'project' ? '/project' : null, null, options);
  const click = id => {
    const button = nav().find(b => b.dataset.section === id);
    assert.ok(button, `navigation has ${id}`);
    button.click();
    return button;
  };
  const active = () => [...w.document.querySelectorAll('.settings-page')].filter(p => !p.hidden).map(p => p.dataset.section);
  return { w, q, nav, open, click, active, saved, timers, observers, ctx };
}

test('Archived shows the latest snapshot and count after refresh was skipped on General', async t => {
  const h = setup(t);
  await h.open();
  assert.deepEqual(h.active(), ['general']);
  const nav = h.nav().find(button => button.dataset.section === 'archived');
  assert.equal(nav.textContent, 'Archived (0 · 0)');
  let reads = 0;
  h.w.api.getSetting = async key => { reads++; return h.saved[key] || {}; };
  h.w.cachedAllProjects = [{ projectPath: '/repo', sessions: [
    { sessionId: 'newly-archived', name: 'New archive', archived: 1 },
  ] }];
  await h.w.refreshArchivedManager(h.w.cachedAllProjects, {});
  assert.equal(reads, 0, 'hidden Archived page does not read settings');
  assert.equal(h.q('.archived-session-row'), null);
  h.click('archived'); await settle();
  assert.equal(h.q('.archived-session-row')?.dataset.entry, 'session:newly-archived', 'opening Archived renders the skipped snapshot');
  assert.equal(nav.textContent, 'Archived (0 · 1)');
  assert.equal(reads, 2, 'showing a dirty manager refreshes both settings');
  h.click('general'); h.click('archived'); await settle();
  assert.equal(reads, 2, 'a clean manager does not repeat the refresh');
});

test('unrelated global saves and repeated saves do not reapply Codex usage', async t => {
  const h = setup(t);
  const applied = [];
  h.w._applyCodexUsage = value => applied.push(value);
  await h.open();
  h.q('#sv-visible-count').value = '42';
  h.q('#sv-save-btn').click();
  await settle();
  assert.deepEqual(applied, [], 'unrelated Save must not refresh usage');
  for (const enabled of [true, false]) {
    h.q('#sv-show-codex-usage').checked = enabled;
    h.q('#sv-save-btn').click();
    await settle();
    assert.equal(applied.at(-1), enabled);
    const count = applied.length;
    h.q('#sv-save-btn').click();
    await settle();
    assert.equal(applied.length, count, 'unchanged repeated Save must not refresh usage');
  }
  assert.deepEqual(applied, [true, false]);
});

test('saving without a registered Codex harness preserves its enabled usage state', async t => {
  const h = setup(t);
  h.saved.global = { showCodexUsage: true };
  h.w.api.getHarnesses = async () => [{ id: 'claude', label: 'Claude', enabled: true }];
  const applied = [];
  h.w._applyCodexUsage = value => applied.push(value);
  await h.open();
  assert.equal(h.q('#sv-show-codex-usage'), null);
  h.q('#sv-visible-count').value = '42';
  h.q('#sv-save-btn').click();
  await settle();
  assert.equal(h.saved.global.showCodexUsage, true);
  assert.deepEqual(applied, [], 'missing toggle must not disable renderer usage');
});

test('flushing a deferred enable refreshes Codex rows after persistence', async t => {
  const h = setup(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-deferred-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'global.json');
  fs.writeFileSync(file, JSON.stringify({ showCodexUsage: false }));
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  h.w.api.getSetting = async () => read();
  h.w.api.setSetting = async (_key, value) => fs.writeFileSync(file, JSON.stringify(value));
  h.w.statsViewerBody = h.q('#stats-viewer-body');
  const statsFile = path.join(root, 'public/stats-view.js');
  vm.runInContext(fs.readFileSync(statsFile, 'utf8'), h.ctx, { filename: statsFile });
  loadAppFunctions(h.ctx, {
    functions: ['quotaWindowLabel', 'shortQuotaLabel', 'buildQuotaBar', 'replaceQuotaRows', 'refreshCodexQuotaGauge', 'applyCodexUsage', 'refreshCodexUsage', 'applyUsageHarnesses'],
    declarations: ['quotaGaugeEl', 'codexQuotaRequest', 'codexQuotaEnabled', 'disabledQuotaRuntimes'],
  });
  h.w._applyCodexUsage = h.w.applyCodexUsage;
  await h.w.applyCodexUsage(false);
  const sidebarFile = path.join(root, 'public/sidebar.js');
  const flush = fs.readFileSync(sidebarFile, 'utf8').match(/^window\.flushDeferredProjectDeletionWrites = \(\) => \{[\s\S]*?^\};/m);
  assert.ok(flush);
  vm.runInContext(flush[0], h.ctx, { filename: sidebarFile });
  let callsAfterSave = 0;
  h.w.api.getCodexUsage = async () => {
    if (!read().showCodexUsage) return {};
    callsAfterSave++;
    return { limits: [{ kind: 'codex', windowMinutes: 300, short: '5h', label: 'Codex 5h', percent: 42 }] };
  };
  await h.open();
  h.w.api.getSetting = async () => {
    h.w.projectDeletionWritesBlocked = true;
    return read();
  };
  h.q('#sv-show-codex-usage').checked = true;
  h.q('#sv-save-btn').click();
  await settle();
  assert.equal(read().showCodexUsage, false);
  assert.equal(h.q('[data-runtime="codex"]'), null);
  h.w.api.getSetting = async () => read();
  h.w.projectDeletionWritesBlocked = false;
  h.w.flushDeferredProjectDeletionWrites();
  await settle();
  assert.equal(read().showCodexUsage, true);
  assert.ok(callsAfterSave > 0, 'successful flush must refresh Codex immediately');
  assert.equal(h.q('[data-runtime="codex"] .quota-pct')?.textContent, '42%');
  assert.ok(h.q('.usage-container-codex'));
});

test('global and project navigation expose the ordered pages and named regions', async t => {
  const h = setup(t);
  await h.open();
  assert.deepEqual(h.nav().map(b => b.dataset.section), globalPages);
  assert.equal(h.q('nav').getAttribute('aria-label'), 'Settings sections');
  for (const page of h.w.document.querySelectorAll('.settings-page')) {
    assert.equal(page.getAttribute('role'), 'region');
    assert.equal(h.q('#' + page.getAttribute('aria-labelledby')).tagName, 'H2');
  }
  await h.open('project');
  assert.deepEqual(h.nav().map(b => b.dataset.section), ['launch', 'project']);
  assert.deepEqual(h.active(), ['launch']);
});

test('click and keyboard select one page with roving focus; Tab enters its controls', async t => {
  const h = setup(t);
  await h.open();
  h.click('keyboard');
  assert.deepEqual(h.active(), ['keyboard']);
  assert.equal(h.nav()[2].getAttribute('aria-current'), 'page');
  const key = (button, key) => button.dispatchEvent(new h.w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  for (const [from, pressed, index] of [[2, 'ArrowDown', 3], [3, 'End', 7], [7, 'Home', 0], [0, 'ArrowUp', 7]]) {
    key(h.nav()[from], pressed);
    assert.equal(h.w.document.activeElement, h.nav()[index]);
    assert.deepEqual(h.active(), [globalPages[index]]);
    assert.equal(h.nav().filter(b => b.tabIndex === 0).length, 1);
  }
  key(h.nav()[7], 'Tab');
  assert.equal(h.w.document.activeElement, h.q('#sv-activity-trace'));
});

test('page memory is scope-specific and unknown or unavailable storage is safe', async t => {
  const h = setup(t);
  await h.open();
  h.click('remote');
  assert.equal(h.w.localStorage.getItem('settingsSection:global'), 'remote');
  await h.open('project');
  h.click('project');
  await h.open();
  assert.deepEqual(h.active(), ['remote']);
  await h.open('project');
  assert.deepEqual(h.active(), ['project']);
  h.w.localStorage.setItem('settingsSection:global', '<unknown>');
  await h.open();
  assert.deepEqual(h.active(), ['general']);
  Object.defineProperty(h.w, 'localStorage', { get() { throw new Error('blocked storage'); } });
  await h.open();
  h.click('keyboard');
  assert.doesNotThrow(() => h.w.closeSettingsViewer());
});

test('an explicit Archived deep link wins and is remembered; unknown links fall back', async t => {
  const h = setup(t);
  h.w.localStorage.setItem('settingsSection:global', 'remote');
  await h.open('global', { section: 'archived' });
  assert.deepEqual(h.active(), ['archived']);
  assert.equal(h.w.localStorage.getItem('settingsSection:global'), 'archived');
  await h.open('global', { section: 'missing' });
  assert.deepEqual(h.active(), ['archived']);
  h.w.localStorage.setItem('settingsSection:global', 'missing-too');
  await h.open('global', { section: 'missing' });
  assert.deepEqual(h.active(), ['general']);
});

test('one Save persists edits on multiple pages, resets the counter and stays open', async t => {
  const h = setup(t);
  await h.open();
  h.click('sessions');
  h.q('#sv-visible-count').value = '42';
  h.q('#sv-visible-count').dispatchEvent(new h.w.Event('input', { bubbles: true }));
  assert.match(h.q('#sv-unsaved').textContent, /1 unsaved change/);
  h.click('general');
  h.q('#sv-restore-startup').value = 'auto';
  h.q('#sv-restore-startup').dispatchEvent(new h.w.Event('change', { bubbles: true }));
  assert.match(h.q('#sv-unsaved').textContent, /2 unsaved changes/);
  h.q('#sv-save-btn').click();
  await settle();
  assert.equal(h.saved.global.visibleSessionCount, 42);
  assert.equal(h.saved.global.restoreOnStartup, 'auto');
  assert.equal(h.q('#sv-unsaved').textContent, '');
  assert.ok(h.q('#sv-save-btn').classList.contains('saved'));
  assert.ok(h.timers.some(timer => timer.ms === 1500));
  h.timers.forEach(timer => timer.fn());
  assert.equal(h.q('#settings-viewer').style.display, 'flex');
  assert.equal(h.q('#sv-save-btn').textContent, 'Save Settings');
  await h.open();
  assert.equal(h.q('#sv-visible-count').value, '42');
});

test('all existing controls retain their ids, scope, groups and inheritance', async t => {
  const h = setup(t);
  const common = ['perm-mode', 'worktree', 'worktree-name', 'browser-mode', 'sandbox', 'pre-launch', 'add-dirs', 'save-btn', 'cancel-btn'];
  const global = ['terminal-theme', 'right-click', 'restore-startup', 'shell-profile', 'visible-count', 'max-age', 'hide-sdk', 'schedules-tab', 'mcp-emulation', 'auto-update', 'receive-beta-versions', 'current-version', 'check-updates-btn', 'update-status', 'remote-hosts', 'remote-add', 'remote-status', 'remote-refresh', 'activity-reporting', 'activity-reporting-status', 'activity-trace', 'activity-trace-list', 'archived-projects', 'codex-sandbox', 'codex-approval', 'codex-model', 'codex-effort'];
  await h.open();
  for (const id of [...common, ...global]) assert.ok(h.q('#sv-' + id), id);
  assert.equal(h.q('#sv-pre-launch').closest('.settings-page')?.dataset.section, 'sessions');
  assert.equal(h.q('#sv-schedules-tab').closest('.settings-page')?.dataset.section, 'automation');
  assert.equal(h.q('#sv-codex-model').closest('.settings-section').querySelector('h3')?.textContent, 'Codex');
  assert.equal(h.w.document.querySelectorAll('.settings-shortcut-btn').length, 8);
  for (const id of ['changesToggle', 'diffToggle', 'touchedToggle', 'shellToggle', 'sessionNavArrows', 'sessionNavBrackets', 'gridToggle', 'agentsToggle']) {
    assert.ok(h.q('#sv-sc-' + id), id);
  }
  assert.equal(h.w.document.querySelectorAll('.settings-page details').length, 2);
  await h.open('project');
  for (const id of [...common, 'archive-btn', 'delete-btn']) assert.ok(h.q('#sv-' + id), id);
  for (const id of global) assert.equal(h.q('#sv-' + id), null, id);
  assert.equal(h.q('#sv-worktree').disabled, true);
  h.q('[data-field="worktree"]').click();
  assert.equal(h.q('#sv-worktree').disabled, false);
});

test('ResizeObserver alone switches the narrow layout at 720px and is cleaned up', async t => {
  const h = setup(t);
  await h.open();
  assert.equal(h.observers.length, 1, 'viewer observes its own width');
  const observer = h.observers[0];
  assert.equal(observer.target, h.q('#settings-viewer'));
  for (const [width, narrow] of [[719, true], [720, false], [480, true], [1000, false]]) {
    observer.callback([{ target: observer.target, contentRect: { width } }]);
    assert.equal(observer.target.classList.contains('settings-narrow'), narrow);
  }
  await h.open();
  assert.equal(observer.disconnected, true);
  h.w.closeSettingsViewer();
  assert.equal(h.observers[1].disconnected, true);
});

test('dirty tracking handles host edits, removal, shortcuts, reversions and live switches', async t => {
  const h = setup(t);
  await h.open();
  assert.ok(h.q('#sv-unsaved'), 'footer has an unsaved counter');
  h.click('remote');
  h.q('#sv-remote-add').click();
  assert.match(h.q('#sv-unsaved').textContent, /1 unsaved change/);
  h.q('.rh-remove').click();
  assert.equal(h.q('#sv-unsaved').textContent, '');
  h.click('integrations');
  h.q('#sv-activity-reporting').click();
  assert.equal(h.q('#sv-unsaved').textContent, '');
  h.click('keyboard');
  const shortcut = h.q('.settings-shortcut-btn');
  shortcut.click();
  shortcut.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'q', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  assert.match(h.q('#sv-unsaved').textContent, /1 unsaved change/);
});

test('remote host defaults come from the shared defaults and keep the five-minute fallback', async t => {
  const { SETTING_DEFAULTS } = require('../public/setting-defaults');
  assert.deepEqual(SETTING_DEFAULTS.remoteHosts, []);
  assert.equal(SETTING_DEFAULTS.remoteRefreshMs, 300000);
  const h = setup(t);
  await h.open();
  assert.equal(h.q('#sv-remote-refresh').value, '5');
  h.q('#sv-remote-refresh').value = '';
  h.q('#sv-save-btn').click();
  await settle();
  assert.equal(h.saved.global.remoteRefreshMs, 300000);
});

test('consecutive saves apply both directions of SDK filtering and IDE notices', async t => {
  const h = setup(t);
  let reloads = 0;
  h.w.loadProjects = async () => { reloads++; };
  await h.open();
  h.q('#sv-hide-sdk').click();
  h.q('#sv-mcp-emulation').click();
  h.q('#sv-save-btn').click();
  await settle();
  assert.equal(reloads, 1);
  h.q('#sv-hide-sdk').click();
  h.q('#sv-mcp-emulation').click();
  h.q('#sv-save-btn').click();
  await settle();
  assert.equal(reloads, 2, 'saving the second toggle reloads filtered project data');
  assert.equal(h.w.document.querySelectorAll('.settings-notice').length, 2, 'both IDE changes are announced');
});

test('edits made while Save is pending remain dirty after the submitted values are saved', async t => {
  const h = setup(t);
  await h.open();
  let release;
  h.w.api.remoteHostsApply = () => new Promise(resolve => { release = resolve; });
  h.q('#sv-visible-count').value = '42';
  h.q('#sv-save-btn').click();
  await settle();
  assert.equal(typeof release, 'function');
  h.q('#sv-visible-count').value = '43';
  h.q('#sv-visible-count').dispatchEvent(new h.w.Event('input', { bubbles: true }));
  release();
  await settle();
  assert.equal(h.saved.global.visibleSessionCount, 42);
  assert.match(h.q('#sv-unsaved').textContent, /1 unsaved change/);
});

test('a rejected host alias remains visibly unsaved', async t => {
  const h = setup(t);
  await h.open();
  h.q('#sv-remote-add').click();
  h.q('.rh-alias').value = 'invalid alias';
  h.q('.rh-alias').dispatchEvent(new h.w.Event('input', { bubbles: true }));
  h.q('#sv-save-btn').click();
  await settle();
  assert.equal(h.saved.global.remoteHosts.length, 0);
  assert.match(h.q('#sv-remote-status').textContent, /Not saved/);
  assert.match(h.q('#sv-unsaved').textContent, /1 unsaved change/);
  assert.match(h.q('#sv-save-btn').textContent, /not saved/);
});

test('Save cannot overlap another Save while fields remain editable', async t => {
  const h = setup(t);
  await h.open();
  let release;
  let applies = 0;
  h.w.api.remoteHostsApply = () => { applies++; return new Promise(resolve => { release = resolve; }); };
  h.q('#sv-visible-count').value = '42';
  h.q('#sv-save-btn').click();
  await settle();
  assert.equal(h.q('#sv-save-btn').disabled, true, 'Save is disabled until its work completes');
  h.q('#sv-visible-count').value = '43';
  h.q('#sv-save-btn').click();
  await settle();
  assert.equal(applies, 1);
  release();
  await settle();
  assert.equal(h.saved.global.visibleSessionCount, 42);
  assert.equal(h.q('#sv-save-btn').disabled, false);
  assert.match(h.q('#sv-unsaved').textContent, /1 unsaved change/);
});

test('Save displays normalized values and a clean baseline in global and project forms', async t => {
  for (const scope of ['global', 'project']) {
    await t.test(scope, async t => {
      const h = setup(t);
      await h.open(scope);
      if (scope === 'project') {
        for (const field of ['worktreeName', 'preLaunchCmd', 'addDirs']) h.q(`[data-field="${field}"]`).click();
      }
      const fields = [['worktree-name', '  branch  ', 'branch'], ['pre-launch', '  env  ', 'env'], ['add-dirs', '  /tmp  ', '/tmp']];
      if (scope === 'global') fields.push(['visible-count', '', '10'], ['max-age', '', '3'], ['remote-refresh', '0', '5']);
      if (scope === 'global') {
        h.q('#sv-remote-add').click();
        for (const [selector, value] of [['.rh-alias', '  myhost  '], ['.rh-label', ' Lab ']]) {
          h.q(selector).value = value;
          h.q(selector).dispatchEvent(new h.w.Event('input', { bubbles: true }));
        }
        h.q('#sv-remote-add').click();
      }
      for (const [id, value] of fields) h.q('#sv-' + id).value = value;
      h.q('#sv-save-btn').click();
      await settle();
      for (const [id, , expected] of fields) assert.equal(h.q('#sv-' + id).value, expected, `${scope}: ${id} shows saved value`);
      if (scope === 'global') {
        assert.equal(JSON.stringify(h.saved.global.remoteHosts), JSON.stringify([{ alias: 'myhost', label: 'Lab', enabled: true }]));
        assert.equal(h.w.document.querySelectorAll('.remote-host-row').length, 1, 'Save removes the empty host row');
        assert.equal(h.q('.rh-alias').value, 'myhost');
        assert.equal(h.q('.rh-label').value, 'Lab');
        assert.equal(h.q('.rh-enabled').checked, true);
      }
      assert.equal(h.q('#sv-unsaved').textContent, '');
      await h.open(scope);
      for (const [id, , expected] of fields) assert.equal(h.q('#sv-' + id).value, expected, `${scope}: ${id} survives reopen`);
    });
  }
});

test('saving Use global default displays inherited values and a clean baseline', async t => {
  const { SETTING_DEFAULTS } = require('../public/setting-defaults');
  const h = setup(t);
  h.saved.global = { permissionMode: 'plan', worktree: false, worktreeName: 'global-branch', browserMode: 'off', sandbox: false, preLaunchCmd: 'global-env', addDirs: null };
  h.saved['project:/project'] = { permissionMode: 'auto', worktree: true, worktreeName: 'project-branch', browserMode: 'claude-in-chrome', sandbox: true, preLaunchCmd: 'project-env', addDirs: '/project-extra' };
  await h.open('project');
  const fields = { permissionMode: 'perm-mode', worktree: 'worktree', worktreeName: 'worktree-name', browserMode: 'browser-mode', sandbox: 'sandbox', preLaunchCmd: 'pre-launch', addDirs: 'add-dirs' };
  for (const field of Object.keys(fields)) h.q(`[data-field="${field}"]`).click();
  h.q('#sv-save-btn').click();
  await settle();
  assert.equal(JSON.stringify(h.saved['project:/project']), '{}');
  for (const [field, id] of Object.entries(fields)) {
    const control = h.q('#sv-' + id);
    const expected = h.saved.global[field] ?? SETTING_DEFAULTS[field];
    assert.equal(control.disabled, true);
    assert.equal(control.type === 'checkbox' ? control.checked : control.value, expected, `${field} displays inherited value`);
  }
  assert.equal(h.q('#sv-unsaved').textContent, '');
});

test('a deferred normalized host save survives later edits and Cancel unchanged on disk', async t => {
  const h = setup(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-deferred-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'global.json');
  fs.writeFileSync(file, '{}');
  const read = async () => JSON.parse(fs.readFileSync(file, 'utf8'));
  h.w.api.getSetting = read;
  h.w.api.setSetting = async (_key, value) => fs.writeFileSync(file, JSON.stringify(value));
  const filename = path.join(root, 'public/sidebar.js');
  const source = fs.readFileSync(filename, 'utf8');
  const flush = source.match(/^window\.flushDeferredProjectDeletionWrites = \(\) => \{[\s\S]*?^\};/m);
  assert.ok(flush, 'load the production deferred-write flush');
  vm.runInContext(flush[0], h.ctx, { filename });
  await h.open();
  h.q('#sv-remote-add').click();
  h.q('.rh-alias').value = '  myhost  ';
  h.q('.rh-alias').dispatchEvent(new h.w.Event('input', { bubbles: true }));
  h.q('.rh-label').value = ' Saved ';
  h.q('.rh-label').dispatchEvent(new h.w.Event('input', { bubbles: true }));
  h.w.api.getSetting = async () => {
    h.w.projectDeletionWritesBlocked = true;
    return read();
  };
  h.q('#sv-save-btn').click();
  await settle();
  const patch = h.w.projectDeletionDeferredSettings.patch;
  const submitted = JSON.stringify(patch);
  assert.match(h.q('#sv-save-btn').textContent, /Applied/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{}');
  h.q('.rh-label').value = 'Cancelled';
  h.q('.rh-label').dispatchEvent(new h.w.Event('input', { bubbles: true }));
  h.q('#sv-cancel-btn').click();
  assert.equal(JSON.stringify(patch), submitted, 'Cancel must not mutate the queued save patch');
  h.w.api.getSetting = read;
  h.w.projectDeletionWritesBlocked = false;
  h.w.flushDeferredProjectDeletionWrites();
  await settle();
  assert.deepEqual((await read()).remoteHosts, [{ alias: 'myhost', label: 'Saved', enabled: true }]);
  assert.equal(h.w.projectDeletionDeferredSettings, null);
});

test('editing a normalized host after Save leaves app-wide labels at the saved value', async t => {
  const h = setup(t);
  h.saved.global = { remoteHosts: [{ alias: 'myhost', label: ' Saved ', enabled: true }] };
  await h.open();
  h.q('#sv-save-btn').click();
  await settle();
  assert.equal(h.w.remoteHostLabel('myhost'), 'Saved');
  h.q('.rh-label').value = 'Unsaved';
  h.q('.rh-label').dispatchEvent(new h.w.Event('input', { bubbles: true }));
  assert.equal(h.w.remoteHostLabel('myhost'), 'Saved', 'typing must not publish an unsaved host label');
  h.q('#sv-cancel-btn').click();
  assert.equal(h.w.remoteHostLabel('myhost'), 'Saved');
});

for (const pending of [false, true]) {
  test(`an unrelated Save preserves a ${pending ? 'pending' : 'completed'} Check host result`, async t => {
    const h = setup(t);
    h.saved.global = { remoteHosts: [{ alias: 'myhost', label: 'Lab', enabled: true }] };
    await h.open();
    let release;
    const result = { ok: true, items: [{ status: 'ok', label: 'SSH', detail: 'Connected' }] };
    h.w.api.remoteHostEnrolCheck = () => pending ? new Promise(resolve => { release = resolve; }) : Promise.resolve(result);
    h.q('.rh-check').click();
    await settle();
    if (!pending) assert.equal(h.q('.enrol-detail').textContent, 'Connected');
    h.q('#sv-visible-count').value = '42';
    h.q('#sv-save-btn').click();
    await settle();
    if (pending) {
      release(result);
      await settle();
    }
    assert.equal(h.q('.remote-host-enrol .enrol-detail')?.textContent, 'Connected', 'Check host result must remain visible after unrelated Save');
    assert.equal(h.q('.rh-check').disabled, false);
    assert.equal(h.q('#sv-unsaved').textContent, '');
  });
}

for (const [field, id, inherited, override, expected] of [
  ['permissionMode', 'perm-mode', null, 'plan', ''],
  ['browserMode', 'browser-mode', 'managed', 'claude-in-chrome', 'off'],
]) {
  test(`Use global Save displays inherited ${field} ${inherited} with a clean counter`, async t => {
    const h = setup(t);
    h.saved.global = { [field]: inherited };
    h.saved['project:/project'] = { [field]: override };
    await h.open('project');
    h.q(`[data-field="${field}"]`).click();
    h.q('#sv-save-btn').click();
    await settle();
    assert.equal(Object.hasOwn(h.saved['project:/project'], field), false);
    assert.equal(h.q('#sv-' + id).value, expected, 'inherited value must use the same display mapping as initial render');
    assert.equal(h.q('#sv-unsaved').textContent, '', 'inherited display must match the saved baseline');
  });
}

test('host normalization preserves edits made while Save is pending', async t => {
  const h = setup(t);
  await h.open();
  h.q('#sv-remote-add').click();
  h.q('.rh-alias').value = '  myhost  ';
  h.q('.rh-alias').dispatchEvent(new h.w.Event('input', { bubbles: true }));
  let release;
  h.w.api.remoteHostsApply = () => new Promise(resolve => { release = resolve; });
  h.q('#sv-save-btn').click();
  await settle();
  h.q('.rh-label').value = 'pending label';
  h.q('.rh-label').dispatchEvent(new h.w.Event('input', { bubbles: true }));
  h.q('#sv-remote-add').click();
  release();
  await settle();
  assert.equal(h.saved.global.remoteHosts[0].label, '');
  assert.equal(h.q('.rh-alias').value, '  myhost  ');
  assert.equal(h.q('.rh-label').value, 'pending label');
  assert.equal(h.w.document.querySelectorAll('.remote-host-row').length, 2);
  assert.match(h.q('#sv-unsaved').textContent, /1 unsaved change/);
});

test('normalization preserves pending edits and compares them with the saved baseline', async t => {
  const h = setup(t);
  await h.open();
  let release;
  h.w.api.remoteHostsApply = () => new Promise(resolve => { release = resolve; });
  h.q('#sv-visible-count').value = '';
  h.q('#sv-worktree-name').value = '  branch  ';
  h.q('#sv-remote-refresh').value = '0';
  h.q('#sv-save-btn').click();
  await settle();
  h.q('#sv-visible-count').value = '11';
  h.q('#sv-worktree-name').value = 'new branch';
  release();
  await settle();
  assert.equal(h.q('#sv-visible-count').value, '11');
  assert.equal(h.q('#sv-worktree-name').value, 'new branch');
  assert.equal(h.q('#sv-remote-refresh').value, '5');
  assert.match(h.q('#sv-unsaved').textContent, /2 unsaved changes/);
  h.q('#sv-visible-count').value = '10';
  h.q('#sv-worktree-name').value = 'branch';
  h.q('#sv-visible-count').dispatchEvent(new h.w.Event('input', { bubbles: true }));
  assert.equal(h.q('#sv-unsaved').textContent, '', 'returning to persisted normalized values clears the counter');
});

test('unlisted template rows remain reachable in both settings scopes', async t => {
  for (const scope of ['global', 'project']) {
    await t.test(scope, async t => {
      const h = setup(t);
      const body = h.q('#settings-viewer-body');
      const descriptor = Object.getOwnPropertyDescriptor(h.w.Element.prototype, 'innerHTML');
      Object.defineProperty(body, 'innerHTML', {
        set(html) {
          descriptor.set.call(this, html);
          const row = h.w.document.createElement('div');
          row.className = 'settings-field';
          row.innerHTML = '<label>Future option<input id="sv-future-option" value="kept"></label>';
          this.querySelector('.settings-section').append(row);
        },
        get() { return descriptor.get.call(this); },
      });
      await h.open(scope);
      const control = h.q('#sv-future-option');
      assert.ok(control, `${scope}: an unlisted row is not deleted`);
      const page = control.closest('.settings-page');
      assert.ok(page, 'fallback belongs to a navigable page');
      h.click(page.dataset.section);
      assert.equal(page.hidden, false);
      control.value = 'changed';
      control.dispatchEvent(new h.w.Event('input', { bubbles: true }));
      assert.match(h.q('#sv-unsaved').textContent, /1 unsaved change/);
    });
  }
});

test('opening a narrow strip brings the remembered or explicit active item into view', async t => {
  const h = setup(t);
  const scrolled = [];
  h.w.HTMLElement.prototype.scrollIntoView = function (options) { scrolled.push({ id: this.dataset.section, options }); };
  h.w.localStorage.setItem('settingsSection:global', 'advanced');
  for (const options of [undefined, { section: 'archived' }]) {
    await h.open('global', options);
    const observer = h.observers.at(-1);
    observer.callback([{ target: observer.target, contentRect: { width: 480 } }]);
    assert.equal(scrolled.at(-1)?.id, options?.section || 'advanced');
    assert.equal(scrolled.at(-1).options.inline, 'nearest');
    assert.equal(scrolled.at(-1).options.block, 'nearest');
  }
});

test('reporting row retains its bottom corners and spacing before its disclosure', async t => {
  const h = setup(t);
  await h.open();
  const row = h.q('#sv-activity-reporting').closest('.settings-field');
  assert.equal(row.nextElementSibling.tagName, 'DETAILS');
  const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)];
  const rule = rules.find(([, selector, body]) => selector.includes('.settings-section > .settings-field') && body.includes('border-bottom-left-radius'));
  assert.ok(rule && row.matches(rule[1].trim()), 'reporting matches the production last-row rule');
  assert.match(rule[2], /border-bottom-left-radius:\s*10px/);
  assert.match(rule[2], /border-bottom-right-radius:\s*10px/);
  assert.match(rule[2], /margin-bottom:\s*20px/);
});
