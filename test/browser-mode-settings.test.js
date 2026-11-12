'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const shared = require('../public/setting-defaults');
const { setup } = require('./fixtures/browser-mode.cjs');

function effectiveReader(rows, notices = []) {
  const filename = path.join(__dirname, '../main.js');
  const source = fs.readFileSync(filename, 'utf8');
  const handlerStart = source.indexOf("ipcMain.handle('get-effective-settings'");
  const declarationsStart = source.indexOf('const warnedBrowserModes =');
  const start = declarationsStart < 0 ? handlerStart : declarationsStart;
  const end = source.indexOf('\n});', handlerStart) + 4;
  let handler;
  const context = { ...shared, log: { warn: message => notices.push(message) }, getSetting: key => rows[key],
    ipcMain: { handle: (_name, fn) => { handler = fn; } } };
  vm.runInNewContext(source.slice(start, end), context, { filename });
  return projectPath => handler(null, projectPath);
}

function effective(global, project) {
  return effectiveReader({ global, 'project:/fixture': project })('/fixture');
}

test('invalid browser settings warn once per scope and stored value across effective reads', () => {
  const rows = { global: { browserMode: 'invalid' }, 'project:/fixture': { browserMode: 'invalid' } };
  const notices = [];
  const read = effectiveReader(rows, notices);
  assert.equal(read('/fixture').browserMode, 'off');
  assert.equal(read('/fixture').browserMode, 'off');
  assert.equal(notices.length, 2, 'repeated reads must warn only once for each scope and value');
  rows['project:/other'] = { browserMode: 'invalid' };
  read('/other');
  assert.equal(notices.length, 3, 'each project scope must diagnose its own invalid setting');
  rows.global.browserMode = 'different-invalid';
  read('/fixture');
  assert.equal(notices.length, 4, 'a different invalid value in the same scope must warn');
  rows.global.browserMode = 'off';
  read();
  rows.global.browserMode = 'invalid';
  read('/fixture');
  assert.equal(notices.length, 4, 'returning to an already diagnosed value must stay quiet');
  rows.global.browserMode = null;
  read();
  read();
  assert.equal(notices.length, 5, 'null must warn once as its own invalid value');
  rows.global.browserMode = { invalid: true };
  read();
  rows.global.browserMode = { invalid: true };
  read();
  assert.equal(notices.length, 6, 'equivalent stored JSON values must stay quiet across reads');
  assert.ok(notices.every(message => /Invalid browserMode/.test(message)));
  assert.deepEqual(rows['project:/fixture'], { browserMode: 'invalid' }, 'reads must not rewrite storage');
});

for (const [name, global, project, expected] of [
  ['legacy true', { chrome: true }, {}, 'claude-in-chrome'],
  ['legacy false', { chrome: false }, {}, 'off'],
  ['absent', {}, {}, 'off'],
  ['project false defeats global managed', { browserMode: 'managed' }, { chrome: false }, 'off'],
  ['project absent inherits managed', { browserMode: 'managed' }, {}, 'managed'],
  ['explicit mode beats legacy', { chrome: true, browserMode: 'off' }, {}, 'off'],
  ['project legacy true overrides off', { browserMode: 'off' }, { chrome: true }, 'claude-in-chrome'],
  ['invalid is explicit off', { browserMode: 'managed' }, { browserMode: 'invalid' }, 'off'],
  ['null is explicit off', { browserMode: 'managed' }, { browserMode: null }, 'off'],
  ['string false is safe', { chrome: 'false' }, {}, 'off'],
]) {
  test(`effective browser mode: ${name}`, () => {
    const before = JSON.stringify([global, project]);
    const result = effective(global, project);
    assert.equal(result.browserMode, expected);
    assert.equal(Object.hasOwn(result, 'chrome'), false);
    assert.equal(JSON.stringify([global, project]), before);
  });
}

test('normalizer reports invalid values without changing input or unrelated nulls', () => {
  assert.equal(typeof shared.normalizeBrowserSettings, 'function', 'shared normalizer must exist');
  const notices = [];
  const row = Object.freeze({ browserMode: null, chrome: true, permissionMode: null });
  const result = shared.normalizeBrowserSettings(row, message => notices.push(message));
  assert.equal(result.browserMode, 'off');
  assert.equal(result.permissionMode, null);
  assert.equal(Object.hasOwn(result, 'chrome'), false);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /browserMode/);
  assert.equal(Object.hasOwn(shared.normalizeBrowserSettings({}), 'browserMode'), false);
});

for (const [scope, row, global, expected, inherited] of [
  ['global', { chrome: true, untouched: 'keep' }, {}, 'claude-in-chrome', false],
  ['project', { chrome: false }, { browserMode: 'managed' }, 'off', false],
  ['project', {}, { chrome: true }, 'claude-in-chrome', true],
  ['project', { browserMode: null }, { chrome: true }, 'off', false],
]) {
  test(`${scope} displays and saves normalized ${JSON.stringify(row)}`, async () => {
    const key = scope === 'global' ? 'global' : 'project:/fixture';
    const ctx = setup({ rows: { global, [key]: row } });
    try {
      await assert.doesNotReject(() => ctx.window.openSettingsViewer(scope, '/fixture'));
      const select = ctx.document.querySelector('#sv-browser-mode');
      assert.ok(select, 'Browser select must render');
      assert.equal(select.value, expected);
      assert.equal(select.disabled, inherited);
      assert.equal(ctx.calls.filter(c => c[0] === 'save').length, 0);
      if (scope === 'project') {
        const inherit = ctx.document.querySelector('[data-field="browserMode"]');
        assert.equal(inherit.checked, inherited);
        inherit.checked = true;
        inherit.dispatchEvent(new ctx.window.Event('change'));
      } else select.value = 'off';
      if (scope === 'global') assert.equal(typeof ctx.window.saveGlobalSettings, 'function', 'global Settings must load the shared persistence function');
      ctx.document.querySelector('#sv-save-btn').click();
      await ctx.flush();
      assert.equal(Object.hasOwn(ctx.rows[key], 'chrome'), false);
      if (scope === 'project') assert.equal(Object.hasOwn(ctx.rows[key], 'browserMode'), false);
      else {
        assert.equal(ctx.rows[key].browserMode, 'off');
        assert.equal(ctx.rows[key].untouched, 'keep');
      }
    } finally { ctx.destroy(); }
  });
}
