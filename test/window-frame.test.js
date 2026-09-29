// Frameless window and the strip that replaces the title bar.
// see .ai/contexts/window-frame.md
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const {
  STRIP_HEIGHT,
  KEYBOARD_ROLES,
  windowFrameOptions,
  applicationMenuTemplate,
} = require('../window-frame');
const { initWindowStrip } = require('../public/window-strip');

const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function menuItems(template) {
  const items = [];
  const walk = (list) => {
    for (const item of list) {
      items.push(item);
      if (Array.isArray(item.submenu)) walk(item.submenu);
    }
  };
  walk(template);
  return items;
}

test('every keyboard role is in the application menu, with its default accelerator left alone', () => {
  const items = menuItems(applicationMenuTemplate('Switchboard'));
  const roles = items.filter((i) => i.role).map((i) => i.role);
  for (const role of KEYBOARD_ROLES) {
    assert.ok(roles.includes(role), `the menu must carry role "${role}"`);
  }
  for (const item of items.filter((i) => KEYBOARD_ROLES.includes(i.role))) {
    assert.equal(item.accelerator, undefined, `role "${item.role}" must keep its default accelerator`);
    assert.notEqual(item.registerAccelerator, false, `role "${item.role}" must register its accelerator`);
    assert.notEqual(item.enabled, false, `role "${item.role}" must stay enabled`);
  }
});

test('the keyboard roles are the ones the frame used to carry', () => {
  assert.deepEqual([...KEYBOARD_ROLES].sort(), [
    'copy', 'cut', 'paste', 'redo', 'resetZoom', 'selectAll',
    'toggleDevTools', 'togglefullscreen', 'undo', 'zoomIn', 'zoomOut',
  ].sort());
});

test('main.js installs the menu as the application menu and never removes it', () => {
  assert.match(
    MAIN_SRC,
    /Menu\.setApplicationMenu\(\s*Menu\.buildFromTemplate\(\s*applicationMenuTemplate\(\s*app\.name\s*\)\s*\)\s*\)/,
    'buildMenu must set the template as the application menu: its accelerators live there',
  );
  assert.doesNotMatch(MAIN_SRC, /setApplicationMenu\(\s*null\s*\)/, 'setApplicationMenu(null) unregisters every accelerator');
  assert.doesNotMatch(MAIN_SRC, /\.setMenu\(\s*null\s*\)|removeMenu\(\s*\)/, 'removing the window menu unregisters its accelerators');
  assert.match(MAIN_SRC, /\bbuildMenu\(\);/, 'buildMenu must still be called at startup');
});

test('main.js builds the window from the frame options', () => {
  const at = MAIN_SRC.indexOf('mainWindow = new BrowserWindow({');
  assert.notEqual(at, -1);
  const options = MAIN_SRC.slice(at, MAIN_SRC.indexOf('});', at));
  assert.match(options, /\.\.\.windowFrameOptions\(process\.platform\)/);
  assert.doesNotMatch(options, /\b(resizable|movable|maximizable|minimizable|fullscreenable)\s*:\s*false/);
});

test('Windows and Linux draw the controls over the strip, at its height', () => {
  for (const platform of ['win32', 'linux']) {
    const options = windowFrameOptions(platform);
    assert.equal(options.titleBarStyle, 'hidden');
    assert.equal(options.titleBarOverlay.height, STRIP_HEIGHT);
    assert.equal(options.trafficLightPosition, undefined);
  }
});

test('macOS keeps its traffic lights, inset into the strip', () => {
  const options = windowFrameOptions('darwin');
  assert.equal(options.titleBarStyle, 'hidden');
  assert.equal(options.titleBarOverlay, undefined);
  const { x, y } = options.trafficLightPosition;
  assert.ok(x > 0 && y > 0 && y < STRIP_HEIGHT, 'the lights must sit inside the strip');
});

test('the CSS strip height matches the overlay height', () => {
  const m = /--strip-height:\s*(\d+)px/.exec(CSS);
  assert.ok(m, 'style.css must define --strip-height');
  assert.equal(Number(m[1]), STRIP_HEIGHT);
});

test('the controls are painted in the strip\'s own colours', () => {
  const token = (name) => new RegExp(name + ':\\s*(#[0-9a-f]{6})', 'i').exec(CSS)[1].toLowerCase();
  const { color, symbolColor } = windowFrameOptions('linux').titleBarOverlay;
  assert.equal(color.toLowerCase(), token('--surface-chrome'));
  assert.equal(symbolColor.toLowerCase(), token('--text-muted'));
});

test('the strip is a drag region and every interactive element in it is exempt', () => {
  assert.match(CSS, /#sidebar-tabs\s*\{[^}]*-webkit-app-region:\s*drag/);
  const noDrag = [...CSS.matchAll(/([^{}]+)\{[^{}]*-webkit-app-region:\s*no-drag[^{}]*\}/g)].map((m) => m[1]).join(',');
  for (const selector of ['button', 'input', 'select', 'textarea', 'a', '[role="button"]', '[contenteditable]']) {
    assert.ok(noDrag.includes(selector), `${selector} must be no-drag`);
  }
  for (const overlay of ['.new-session-popover', '.terminal-context-menu', '.new-session-overlay', '.add-project-overlay']) {
    assert.ok(noDrag.includes(overlay), `${overlay} can open over the strip and must be no-drag`);
  }
});

test('the collapsed sidebar keeps a drag region', () => {
  assert.match(CSS, /#sidebar\.collapsed\s*\{[^}]*-webkit-app-region:\s*drag/);
});

test('the menu button sits in the strip', () => {
  const doc = new JSDOM(HTML).window.document;
  const btn = doc.getElementById('app-menu-btn');
  assert.ok(btn, 'index.html must carry #app-menu-btn');
  assert.equal(btn.closest('#sidebar-tabs'), doc.getElementById('sidebar-tabs'));
  assert.equal(btn.tagName, 'BUTTON');
});

function stripDom(platform) {
  const dom = new JSDOM('<!DOCTYPE html><body><button id="app-menu-btn"></button></body>');
  const calls = [];
  let onFullScreen = null;
  const api = {
    platform,
    onFullScreenChanged: (cb) => { onFullScreen = cb; },
    popupAppMenu: (x, y) => { calls.push([x, y]); },
  };
  initWindowStrip(dom.window.document, api);
  return { doc: dom.window.document, calls, fullScreen: (v) => onFullScreen(v) };
}

test('the renderer marks the body frameless with its platform', () => {
  const { doc } = stripDom('linux');
  assert.ok(doc.body.classList.contains('window-frameless'));
  assert.ok(doc.body.classList.contains('platform-linux'));
});

test('full screen is reflected on the body, and leaving it clears the mark', () => {
  const { doc, fullScreen } = stripDom('darwin');
  fullScreen(true);
  assert.ok(doc.body.classList.contains('window-full-screen'));
  fullScreen(false);
  assert.ok(!doc.body.classList.contains('window-full-screen'));
});

test('the menu button opens the application menu under itself', () => {
  const { doc, calls } = stripDom('win32');
  const btn = doc.getElementById('app-menu-btn');
  btn.getBoundingClientRect = () => ({ left: 8, bottom: 30, top: 2, right: 32, width: 24, height: 28 });
  btn.dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(calls, [[8, 30]]);
});

// --- Zoom keys, whatever the layout ---

const { zoomKey, nextZoomLevel } = require('../window-frame');
const key = (k, code, mods = {}) => ({ type: 'keyDown', key: k, code, control: false, meta: false, alt: false, shift: false, ...mods });

test('zoom keys are read by the character produced, on US and AZERTY alike', () => {
  const ctrl = { control: true };
  assert.equal(zoomKey(key('+', 'Equal', { ...ctrl, shift: true }), 'linux'), 'in');     // AZERTY / US Shift+=
  assert.equal(zoomKey(key('=', 'Equal', ctrl), 'linux'), 'in');                          // US without Shift
  assert.equal(zoomKey(key('-', 'Digit6', ctrl), 'linux'), 'out');                        // AZERTY
  assert.equal(zoomKey(key('-', 'Minus', ctrl), 'linux'), 'out');                         // US
  assert.equal(zoomKey(key('à', 'Digit0', ctrl), 'linux'), 'reset');                      // AZERTY, unshifted
  assert.equal(zoomKey(key('0', 'Digit0', ctrl), 'linux'), 'reset');
});

test('the numeric keypad zooms too', () => {
  const ctrl = { control: true };
  assert.equal(zoomKey(key('+', 'NumpadAdd', ctrl), 'linux'), 'in');
  assert.equal(zoomKey(key('-', 'NumpadSubtract', ctrl), 'linux'), 'out');
  assert.equal(zoomKey(key('Insert', 'Numpad0', ctrl), 'linux'), 'reset');                 // NumLock off
});

test('only Ctrl (Cmd on macOS) without Alt, on a key down, is a zoom key', () => {
  assert.equal(zoomKey(key('-', 'Minus'), 'linux'), null, 'a bare minus is typing');
  assert.equal(zoomKey(key('-', 'Minus', { control: true, alt: true }), 'linux'), null);
  assert.equal(zoomKey(key('-', 'Minus', { meta: true }), 'linux'), null);
  assert.equal(zoomKey(key('-', 'Minus', { meta: true }), 'darwin'), 'out');
  assert.equal(zoomKey(key('-', 'Minus', { control: true }), 'darwin'), null);
  assert.equal(zoomKey({ ...key('-', 'Minus', { control: true }), type: 'keyUp' }, 'linux'), null);
  assert.equal(zoomKey(key('c', 'KeyC', { control: true }), 'linux'), null);
});

test('zoom steps by half a level, and reset returns to 0', () => {
  assert.equal(nextZoomLevel(0, 'in'), 0.5);
  assert.equal(nextZoomLevel(0.5, 'out'), 0);
  assert.equal(nextZoomLevel(2, 'reset'), 0);
});

test('main applies the zoom keys and stops them there', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /const zoom = zoomKey\(input, process\.platform\);\n\s*if \(zoom\) \{\n\s*event\.preventDefault\(\);\n\s*mainWindow\.webContents\.setZoomLevel\(nextZoomLevel\(mainWindow\.webContents\.getZoomLevel\(\), zoom\)\);/);
});
