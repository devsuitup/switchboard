'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { JSDOM } = require('jsdom');
const { rootTokens, resolveCssVars } = require('./css-vars');
const baseline = require('./fixtures/theme-dark.json');
const root = path.join(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

function setup(t, choice, osDark = false) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window;
  const listeners = new Set();
  const media = { matches: osDark, addEventListener: (_, fn) => listeners.add(fn) };
  w.matchMedia = query => { assert.equal(query, '(prefers-color-scheme: dark)'); return media; };
  w.api = { getInitialTheme: () => choice };
  function load(file) {
    const filename = path.join(root, 'public', file);
    if (fs.existsSync(filename)) vm.runInContext(fs.readFileSync(filename,'utf8'), dom.getInternalVMContext(), { filename });
  }
  load('setting-defaults.js');
  load('theme.js');
  return { w, load, context: dom.getInternalVMContext(), change(dark) { media.matches = dark; for (const fn of listeners) fn(media); } };
}

test('Theme defaults to Dark in the shared settings table', () => {
  assert.equal(require('../public/setting-defaults').SETTING_DEFAULTS.theme, 'dark');
});

test('CSS resolution uses dark root tokens and resolves absent-token fallbacks', () => {
  const css = ':root { --link: #4fc3f7; } :root[data-theme="light"] { --link: #005a80; }';
  assert.equal(resolveCssVars('var(--link) var(--link, red) var(--absent, rgba(1, 2, 3, 0.5)) var(--unknown)', rootTokens(css)),
    '#4fc3f7 #4fc3f7 rgba(1, 2, 3, 0.5) var(--unknown)');
});

test('theme normalization reads the shared choices', t => {
  const h = setup(t, 'dark');
  assert.equal(vm.runInContext('typeof THEME_CHOICES', h.context, { filename: __filename }), 'object', 'shared theme choices exist');
  vm.runInContext("THEME_CHOICES.push(['test-theme', 'Test theme'])", h.context, { filename: __filename });
  h.w.appTheme.apply('test-theme');
  assert.equal(h.w.document.documentElement.dataset.theme, 'test-theme');
});

test('native select controls follow the effective palette', t => {
  const css = source('public/style.css');
  const light = rootTokens(css.replace(':root[data-theme="light"]', ':root'));
  for (const [theme, tokens] of [['dark', rootTokens(css)], ['light', light]]) {
    const dom = new JSDOM(`<html data-theme="${theme}"><head><style>${resolveCssVars(css, tokens)}</style></head><body><select class="control-select"></select></body></html>`);
    t.after(() => dom.window.close());
    assert.equal(dom.window.getComputedStyle(dom.window.document.querySelector('select')).colorScheme, theme);
  }
});

for (const color of ['#4a9', '#9b4058', '#5a7a6a', '#6068b0', '#7a5a5a', '#997a33', '#4a8a8a', '#8a7ab8', '#3b5a7a', '#5a4a7a', '#3f6b5a']) {
  test(`remaining action and badge color ${color} has a distinct light token`, () => {
    const css = source('public/style.css');
    const dark = rootTokens(css);
    const light = rootTokens(css.replace(':root[data-theme="light"]', ':root'));
    const keys = Object.keys(dark).filter(key => dark[key] === color);
    assert.ok(keys.length, `${color} has a dark token`);
    for (const key of keys) assert.notEqual(light[key], color, `${key} swaps in Light`);
    const rules = css.replace(/:root(?:\[data-theme="light"\])?\s*\{[^}]+\}/g, '');
    assert.ok(!rules.includes(color), `${color} is no longer literal in a rule`);
  });
}

test('saving global appearance refreshes the native window after persistence', async () => {
  const filename = path.join(root, 'main.js');
  const main = source('main.js');
  const start = main.indexOf("ipcMain.handle('set-setting',");
  const end = main.indexOf('\n});', start) + '\n});'.length;
  assert.ok(start >= 0 && end > start);
  const handlers = new Map();
  const calls = [];
  const context = vm.createContext({
    ipcMain: { handle: (name, fn) => { handlers.set(name, fn); } },
    getSetting: () => ({}),
    setSetting: async () => { await Promise.resolve(); calls.push('persisted'); },
    writer: { mergeGlobal: async patch => { await Promise.resolve(); calls.push('merged'); return patch; } },
    windowTheme: { refresh: () => calls.push('refresh') },
    codexUsage: { settingsChanged() {} }, applyUpdateChannel() {},
    restartHarnessWatchers() {}, notifyRendererProjectsChanged() {},
  });
  vm.runInContext(require('./app-source').extractFunction(main, 'writeGlobalSettings'), context, { filename });
  vm.runInContext(main.slice(start, end), context, { filename });
  const mergeStart = main.indexOf("ipcMain.handle('merge-global-settings',");
  assert.ok(mergeStart >= 0);
  vm.runInContext(main.slice(mergeStart, main.indexOf('\n});', mergeStart) + '\n});'.length), context, { filename });
  const handler = handlers.get('set-setting');
  await handler({}, 'global', { theme: 'light' });
  assert.deepEqual(calls, ['persisted', 'refresh']);
  calls.length = 0;
  await handler({}, 'project', { theme: 'dark' });
  assert.deepEqual(calls, ['persisted']);
  calls.length = 0;
  await handlers.get('merge-global-settings')({}, { theme: 'dark' }, ['chrome']);
  assert.deepEqual(calls, ['merged', 'refresh'], 'a Settings merge refreshes the window after the writer commits');
  await assert.rejects(handlers.get('merge-global-settings')({}, ['theme']), /Invalid global settings patch/);
});

test('Dark and Light apply synchronously and ignore OS changes', t => {
  for (const choice of ['dark', 'light']) {
    const h = setup(t, choice, choice === 'light');
    assert.equal(h.w.document.documentElement.dataset.theme, choice);
    h.change(choice !== 'light');
    assert.equal(h.w.document.documentElement.dataset.theme, choice);
  }
});

test('System follows the OS live and stops following when explicitly selected', t => {
  const h = setup(t, 'system', false);
  assert.equal(h.w.document.documentElement.dataset.theme, 'light');
  h.change(true);
  assert.equal(h.w.document.documentElement.dataset.theme, 'dark');
  h.w.appTheme.apply('light');
  h.change(false); h.change(true);
  assert.equal(h.w.document.documentElement.dataset.theme, 'light');
  h.w.appTheme.apply('system');
  assert.equal(h.w.document.documentElement.dataset.theme, 'dark');
});

test('missing and invalid stored themes use the shared default', t => {
  for (const choice of [undefined, null, 'sepia']) {
    const h = setup(t, choice);
    assert.equal(h.w.document.documentElement.dataset.theme, 'dark');
  }
});

test('open session and panel terminals swap live and recover the selected dark palette', t => {
  const h = setup(t, 'dark');
  h.load('terminal-themes.js');
  assert.equal(typeof h.w.bindTerminalThemes, 'function', 'terminal theme binding exists');
  const entries = new Map(['session', 'panel:session'].map(id => [id, { terminal: { options: {} }, element: h.w.document.createElement('div') }]));
  h.w.bindTerminalThemes(() => entries);
  h.w._applyTerminalTheme('dracula');
  const dark = entries.get('session').terminal.options.theme;
  assert.equal(dark.background, '#282a36');
  h.w.appTheme.apply('light');
  for (const e of entries.values()) {
    assert.equal(e.terminal.options.theme.background, '#ffffff');
    assert.equal(e.element.style.backgroundColor, 'rgb(255, 255, 255)');
    assert.equal(e.terminal.options.theme.foreground, '#1c1c28');
  }
  h.w._applyTerminalTheme('nord');
  assert.equal(entries.get('session').terminal.options.theme.background, '#ffffff');
  h.w.appTheme.apply('dark');
  assert.equal(entries.get('session').terminal.options.theme.background, '#2e3440');
});

test('theme bootstrap is in the head before styles and the body, with synchronous preload settings', () => {
  const html = source('public/index.html');
  const theme = html.indexOf('<script src="theme.js">');
  assert.ok(theme > 0 && theme < html.indexOf('<link'), 'theme bootstrap precedes styles');
  assert.ok(html.indexOf('<script src="setting-defaults.js">') < theme);
  assert.equal(html.match(/src="setting-defaults.js"/g).length, 1);
  assert.match(source('preload.js'), /getInitialTheme:.*sendSync\('get-initial-theme'\)/);
  assert.match(source('main.js'), /installWindowTheme/);
  assert.match(source('main.js'), /\.\.\.windowTheme\.frameOptions\(\)/);
  assert.match(source('public/app.js'), /window.bindTerminalThemes\(\(\) => openSessions\)/);
});

test('light tokens cover chrome and dark token expansion preserves every original declaration', () => {
  const css = source('public/style.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /:root\[data-theme="light"\]/, 'light token swap exists');
  const light = Object.fromEntries([...css.match(/:root\[data-theme="light"\]\s*\{([^}]+)\}/)[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
  for (const [key, value] of Object.entries({ '--surface-chrome': '#f3f3f7', '--surface-sunken': '#ffffff', '--text': '#1c1c28', '--accent': '#5a63e6' })) {
    assert.equal(light[key], value, key + ' uses the light palette');
  }
  for (const [key, value] of Object.entries(light).filter(([key]) => !['--control-color-scheme', '--notice-shadow'].includes(key))) assert.match(value, /^(#[\da-f]{3,6}|rgba?\([\d., ]+\))$/i, key + ' has a valid light color');
  assert.match(light['--notice-shadow'], /^0 4px 16px rgba\([\d., ]+\)$/, '--notice-shadow is a box shadow with a light color');
  const tokens = rootTokens(css);
  for (const [key, value] of Object.entries(baseline.tokens)) assert.equal(tokens[key], value, key);
  const expanded = resolveCssVars(css.replace(/:root(?:\[data-theme="light"\])?\s*\{[^}]+\}/g, ''), tokens).replace(/\s+/g, '').replace(/0\.10\)/g, '0.1)');
  assert.equal(crypto.createHash('sha256').update(expanded).digest('hex'), baseline.cssHash, 'all dark declarations retain their exact resolved values');
  for (const [file, expected] of Object.entries(baseline.inline)) {
    const resolved = resolveCssVars(source('public/' + file), tokens)
      .replace(/\s+/g, '').replace(/(0\.\d*?[1-9])0+\)/g, '$1)');
    assert.equal(crypto.createHash('sha256').update(resolved).digest('hex'), expected, file + ' retains its dark inline colors');
  }
});

test('native window colors follow saved and system themes, including startup', () => {
  const filename = path.join(root, 'src/main/app/window-theme.js');
  assert.ok(fs.existsSync(filename), 'native theme controller exists');
  const { installWindowTheme } = require(filename);
  const ipcMain = new EventEmitter();
  const nativeTheme = new EventEmitter();
  nativeTheme.shouldUseDarkColors = false;
  let theme = 'light';
  const overlays = [], backgrounds = [];
  const win = { isDestroyed: () => false, setTitleBarOverlay: o => overlays.push(o), setBackgroundColor: c => backgrounds.push(c) };
  const controller = installWindowTheme({ ipcMain, nativeTheme, getSetting: () => ({ theme }), getWindow: () => win, platform: 'win32' });
  assert.equal(typeof controller.frameOptions, 'function', 'native frame palette is available before window construction');
  assert.deepEqual(controller.frameOptions(), { titleBarOverlay: { height: 32, color: '#f3f3f7', symbolColor: '#5f5f74' } });
  assert.deepEqual(controller.colors(), { background: '#ffffff', color: '#f3f3f7', symbolColor: '#5f5f74' });
  controller.refresh();
  assert.equal(overlays.at(-1).color, '#f3f3f7');
  assert.equal(backgrounds.at(-1), '#ffffff');
  const event = {};
  ipcMain.emit('get-initial-theme', event);
  assert.equal(event.returnValue, 'light');
  theme = 'system'; nativeTheme.shouldUseDarkColors = true; nativeTheme.emit('updated');
  assert.equal(overlays.at(-1).color, '#18181f');
  assert.equal(overlays.at(-1).symbolColor, '#9090a8');
  theme = 'light'; nativeTheme.emit('updated');
  assert.equal(overlays.at(-1).color, '#f3f3f7');
});
