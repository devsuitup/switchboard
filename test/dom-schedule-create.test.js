'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const settle = () => new Promise(resolve => setImmediate(resolve));
function setup(t) {
  const dom = new JSDOM('<body><div id="schedules-content"></div></body>', { runScripts: 'outside-only', url: 'http://localhost' });
  t.after(() => { dom.window.setSchedulesVisible(false); dom.window.close(); });
  const w = dom.window;
  const calls = [];
  const data = { projects: [{ projectPath: '/p', shortName: 'Project', known: true, archived: false, schedules: [] }, { projectPath: '/archived', shortName: 'Archived', archived: true, schedules: [] }] };
  w.api = { listSchedules: async () => data, createScheduleFile: async (...args) => { calls.push(args); return { ok: true, filePath: '/p/schedule-nightly.md' }; } };
  w.clearAppNotice = () => {};
  w.activeTab = 'schedules';
  for (const name of ['utils.js', 'setting-defaults.js', 'modal-stack.js', 'schedules-view.js']) {
    const filename = path.join(__dirname, '../public', name);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), dom.getInternalVMContext(), { filename });
  }
  w.renderSchedules(data);
  const button = w.document.querySelector('.schedule-create-btn');
  assert.ok(button, 'the Schedules tab offers Create schedule even with no schedules');
  button.focus();
  button.click();
  const form = w.document.querySelector('.schedule-create-form');
  assert.ok(form, 'Create opens a form');
  const field = name => form.elements.namedItem(name);
  const fill = () => { field('name').value = 'Nightly'; field('slug').value = 'nightly'; field('cron').value = '0 9 * * *'; field('prompt').value = 'Review'; };
  const submit = () => form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  return { w, data, calls, form, field, fill, submit };
}
test('creation offers registry projects and all runner fields, defaults to auto, refreshes after success', async t => {
  const h = setup(t);
  for (const name of ['projectPath', 'name', 'slug', 'cron', 'enabled', 'catch-up', 'prompt', 'cli.permission-mode', 'cli.allowed-tools', 'cli.model', 'cli.max-budget-usd', 'cli.append-system-prompt', 'cli.add-dirs']) assert.ok(h.field(name), name);
  assert.equal(h.field('enabled').checked, true);
  assert.equal(h.field('catch-up').checked, false);
  assert.equal(h.field('cli.permission-mode').selectedOptions[0].textContent, 'Default (auto)');
  assert.equal(h.field('projectPath').querySelector('[value="/archived"]').disabled, true);
  assert.equal(h.w.document.activeElement, h.field('projectPath'));
  h.fill();
  h.field('cli.add-dirs').value = '/one\n/two';
  h.submit();
  await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], '/p');
  assert.equal(h.calls[0][1].cli['permission-mode'], undefined);
  assert.deepEqual(Array.from(h.calls[0][1].cli['add-dirs']), ['/one', '/two']);
  assert.equal(h.w.document.querySelector('.schedule-create-form'), null);
  assert.equal(h.w.document.activeElement, h.w.document.querySelector('.schedule-create-btn'));
});
test('field errors stay in the form and focus the rejected field', async t => {
  const h = setup(t);
  h.w.api.createScheduleFile = async () => ({ ok: false, field: 'cron', error: 'cron can never match' });
  h.fill(); h.submit(); await settle();
  assert.equal(h.field('cron').getAttribute('aria-invalid'), 'true');
  assert.match(h.form.textContent, /cron can never match/);
  assert.equal(h.w.document.activeElement, h.field('cron'));
  assert.equal(h.field('name').value, 'Nightly');
});
test('submission is single flight and a backend failure allows retry', async t => {
  const h = setup(t);
  let reply;
  h.w.api.createScheduleFile = () => { h.calls.push('create'); return new Promise(resolve => { reply = resolve; }); };
  h.fill(); h.submit(); h.submit();
  assert.equal(h.calls.length, 1);
  assert.equal(h.form.querySelector('[type="submit"]').disabled, true);
  reply(undefined); await settle();
  assert.match(h.form.textContent, /no result/i);
  assert.equal(h.form.querySelector('[type="submit"]').disabled, false);
});

for (const failure of ['unknown field', 'no field', 'exception', 'no result']) test(`creation failure with ${failure} focuses Create for retry`, async t => {
  const h = setup(t);
  h.w.api.createScheduleFile = async () => {
    if (failure === 'exception') throw new Error('Unavailable');
    if (failure === 'no result') return undefined;
    return { ok: false, field: failure === 'unknown field' ? 'unrecognized' : undefined, error: 'Unavailable' };
  };
  h.fill();
  h.field('prompt').focus();
  h.submit();
  await settle();
  const button = h.form.querySelector('[type="submit"]');
  assert.equal(h.w.document.activeElement, button, 'unmapped failure must focus Create');
  assert.equal(button.disabled, false);
  assert.match(h.form.textContent, /Unavailable|no result/i);
  assert.equal(h.field('name').value, 'Nightly');
});
test('modal keyboard keeps textarea Enter, traps Tab and cancels on Escape with restored focus', t => {
  const h = setup(t);
  h.field('name').focus();
  const inputEnter = new h.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  h.field('name').dispatchEvent(inputEnter);
  assert.equal(inputEnter.defaultPrevented, true, 'text input Enter must prevent implicit form submission');
  h.field('prompt').focus();
  const enter = new h.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  h.field('prompt').dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, false);
  assert.equal(h.calls.length, 0);
  h.form.querySelector('[type="submit"]').focus();
  h.w.document.activeElement.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.equal(h.w.document.activeElement, h.field('projectPath'));
  h.w.document.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(h.w.document.querySelector('.schedule-create-form'), null);
  assert.equal(h.w.document.activeElement, h.w.document.querySelector('.schedule-create-btn'));
});
