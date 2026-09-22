// One table of setting defaults (issue #316).
//
// The settings panel used to carry a literal fallback per call site, separate
// from main.js's SETTING_DEFAULTS. The two drifted: with no key stored the
// panel drew IDE Emulation checked while every session started without one.
// These tests pin the class, not the three fields that had diverged:
//
//   1. with nothing stored, every control the panel renders shows the value a
//      new session would actually get — driven off the panel's own field list,
//      so a field added later is covered without anyone adding an assertion;
//   2. no renderer file carries a second default for a setting key.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { SETTING_DEFAULTS } = require('../public/setting-defaults');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PANEL_SRC = fs.readFileSync(path.join(PUBLIC_DIR, 'settings-panel.js'), 'utf8');

function evalInWindow(dom, file) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), dom.getInternalVMContext(), { filename: file });
}

// The panel's field list, read from the panel itself: every `fieldValue()`
// call, paired with the control its value is rendered into (the nearest
// preceding `id="…"` in the template).
function panelFields() {
  const templateStart = PANEL_SRC.indexOf('settingsViewerBody.innerHTML = `');
  assert.ok(templateStart !== -1, 'settings-panel.js must render its form from one template');
  const template = PANEL_SRC.slice(templateStart);

  const fields = [];
  // Both shapes, so re-adding a fallback argument hides nothing from this test.
  const declaration = /const (\w+) = fieldValue\('(\w+)'[^)]*\);/g;
  let m;
  while ((m = declaration.exec(PANEL_SRC)) !== null) {
    const [, varName, field] = m;
    const useAt = template.search(new RegExp('\\b' + varName + '\\b'));
    assert.ok(useAt !== -1, `${varName} is read from settings but never rendered`);
    const ids = [...template.slice(0, useAt).matchAll(/id="([\w-]+)"/g)];
    assert.ok(ids.length, `no control id precedes ${varName} in the template`);
    fields.push({ field, varName, controlId: ids[ids.length - 1][1] });
  }
  assert.ok(fields.length >= 10, 'the panel must expose its fields through fieldValue()');
  return fields;
}

function setupPanel(stored = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <div id="settings-viewer"></div>
    <div id="settings-viewer-title"></div>
    <div id="settings-viewer-body"></div>
    <div id="terminal-area"></div>
    <div id="terminal-header"></div>
    <div id="placeholder"></div>
    <div id="stats-viewer"></div>
    <div id="memory-viewer"></div>
    <div id="jsonl-viewer"></div>
  </body></html>`, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;

  window.api = new Proxy({ platform: 'linux' }, {
    get(target, prop) {
      if (prop === 'platform') return target.platform;
      if (prop === 'getSetting') return async (key) => stored[key] || {};
      if (prop === 'getShellProfiles') return async () => [];
      if (prop === 'getAppVersion') return async () => '0.0.0';
      if (prop === 'onUpdaterEvent') return () => {};
      if (prop === 'getActivityTraceState') return async () => ({ enabled: false, dir: '/tmp' });
      return () => Promise.resolve({ ok: true });
    },
  });

  evalInWindow(dom, path.join(PUBLIC_DIR, 'setting-defaults.js'));
  evalInWindow(dom, path.join(PUBLIC_DIR, 'utils.js'));
  evalInWindow(dom, path.join(PUBLIC_DIR, 'shortcuts.js'));
  evalInWindow(dom, path.join(PUBLIC_DIR, 'terminal-themes.js'));
  evalInWindow(dom, path.join(PUBLIC_DIR, 'settings-panel.js'));

  return { window, document: window.document, destroy() { window.close(); } };
}

// get-effective-settings merges the stored rows over SETTING_DEFAULTS, so with
// no row saved at either scope it returns the table as-is — pinned by the last
// test in this file.
const EFFECTIVE_WITH_NOTHING_STORED = { ...SETTING_DEFAULTS };

function displayed(el) {
  assert.ok(el, 'control must render');
  if (el.type === 'checkbox') return { kind: 'boolean', value: el.checked };
  return { kind: 'string', value: el.value };
}

test('with nothing stored, every field the panel shows displays the value a new session gets', async () => {
  const fields = panelFields();
  const effective = EFFECTIVE_WITH_NOTHING_STORED;
  const ctx = setupPanel();
  try {
    await ctx.window.openSettingsViewer('global');

    for (const { field, controlId } of fields) {
      assert.ok(field in SETTING_DEFAULTS,
        `${field} is offered by the settings panel but absent from SETTING_DEFAULTS, so the panel and a session cannot agree on it`);

      const shown = displayed(ctx.document.querySelector('#' + controlId));
      const expected = effective[field];
      if (shown.kind === 'boolean') {
        assert.equal(shown.value, !!expected, `#${controlId} displays ${shown.value} for ${field}, a session gets ${expected}`);
      } else {
        const asText = expected === null || expected === undefined ? '' : String(expected);
        assert.equal(shown.value, asText, `#${controlId} displays "${shown.value}" for ${field}, a session gets "${asText}"`);
      }
    }
  } finally {
    ctx.destroy();
  }
});

test('an explicitly saved permissionMode of null still displays as Default, never promoted to the table value', async () => {
  const ctx = setupPanel({ global: { permissionMode: null } });
  try {
    await ctx.window.openSettingsViewer('global');
    assert.equal(ctx.document.querySelector('#sv-perm-mode').value, '',
      'a stored null is a deliberate "Default (none)" and must not fall through to SETTING_DEFAULTS');
  } finally {
    ctx.destroy();
  }
});

test('no renderer file carries a second default for a setting key', () => {
  const keys = Object.keys(SETTING_DEFAULTS);
  const literal = String.raw`(?:'[^']*'|"[^"]*"|-?\d+(?:\.\d+)?|true|false)`;
  const fallback = new RegExp(String.raw`(?:\|\||\?\?)\s*` + literal);
  const offences = [];

  for (const file of fs.readdirSync(PUBLIC_DIR)) {
    // codemirror-bundle.js is generated and gitignored, so it is absent on CI
    // and present after a local build: minified vendor code matches a key name
    // beside a `||` often enough to make this guard fire only on a workstation.
    if (!file.endsWith('.js') || file === 'setting-defaults.js') continue;
    if (file === 'codemirror-bundle.js') continue;
    const lines = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (line.includes('SETTING_DEFAULTS')) return;
      const named = keys.find(k => new RegExp('\\b' + k + '\\b').test(line));
      if (named && fallback.test(line)) {
        offences.push(`${file}:${i + 1} falls back to a literal for ${named}: ${line.trim()}`);
      }
      const extraArg = /fieldValue\(\s*'(\w+)'\s*,/.exec(line);
      if (extraArg) offences.push(`${file}:${i + 1} gives ${extraArg[1]} a fallback of its own`);
    });
  }

  assert.deepEqual(offences, [],
    'a setting default belongs in public/setting-defaults.js — a literal in the renderer drifts from what the app applies');
});

test('the main process reads the same table and merges stored rows over it', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.doesNotMatch(src, /const SETTING_DEFAULTS = \{/,
    'main.js must require the shared table rather than declare a second one');
  assert.match(src, /require\('\.\/public\/setting-defaults'\)/, 'main.js must require the shared table');

  const handlerStart = src.indexOf("ipcMain.handle('get-effective-settings'");
  assert.ok(handlerStart !== -1);
  const handlerBody = src.slice(handlerStart, src.indexOf('});', handlerStart));
  assert.match(handlerBody, /\{ \.\.\.SETTING_DEFAULTS \}/, 'the effective settings must start from the shared table');
});
