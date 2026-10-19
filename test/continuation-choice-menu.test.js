'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./continuations-harness');
const { setupSidebarDom } = require('./dom-setup');

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function menuFixture(t, { open = false, chosen = 'b' } = {}) {
  const h = setup(t, { old: [], head: ['b', 'c'], b: [], c: [] });
  const ui = setupSidebarDom();
  t.after(() => ui.destroy());
  Object.assign(h.rows.get('old'), { headSessionId: 'head', mergedMemberIds: ['head'] });
  h.ctx.sessionMap.delete('head');
  ui.window.sessionMap.set('old', h.rows.get('old'));
  const record = { chosen, candidates: ['b', 'c'] };
  h.ctx._continuationChoices.set('continuationChoice:old', record);
  ui.window._continuationChoices = h.ctx._continuationChoices;
  ui.window.openSession = (...args) => h.app.openSession(...args);
  h.ctx.appChoose = async question => {
    h.prompts.push(question);
    return ui.window.appChoose(question);
  };
  if (open) h.ctx.openSessions.set('head', { session: h.rows.get('head'), closed: false });
  const menu = () => {
    ui.window.showSessionContextMenu({ clientX: 10, clientY: 20 }, 'old');
    return [...ui.document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === 'Choose part to open…');
  };
  return { h, ui, record, menu };
}

test('S3 the row menu offers Choose part to open only for its representative record', t => {
  const { h, menu } = menuFixture(t);
  assert.ok(menu());
  h.ctx._continuationChoices.delete('continuationChoice:old');
  h.ctx._continuationChoices.set('continuationChoice:head', { chosen: 'b', candidates: ['b', 'c'] });
  assert.equal(menu(), undefined);
});

for (const chosen of ['b', null]) {
  test(`T11 the menu preselects ${chosen ?? 'the clicked head'} and Cancel preserves the saved record`, async t => {
    const { h, ui, record, menu } = menuFixture(t, { chosen });
    await h.ctx.api.setSetting('continuationChoice:old', record);
    const item = menu();
    assert.ok(item, 'remembered rows need the choose-again item');
    item.click();
    await tick(); await tick();
    assert.equal(h.prompts.length, 1);
    assert.equal(h.prompts[0].selectedId, chosen ?? 'head');
    assert.equal(ui.document.querySelector('input[type="radio"]:checked')?.dataset.choiceId, chosen ?? 'head');
    assert.match(ui.document.querySelector('.choice-dialog').textContent, /To choose again, use Choose part to open in the row's menu\./);
    [...ui.document.querySelectorAll('.choice-dialog button')].find(button => button.textContent === 'Cancel').click();
    await tick(); await tick();
    assert.equal(h.ctx._continuationChoices.get('continuationChoice:old'), record);
    assert.deepEqual(await h.ctx.api.getSetting('continuationChoice:old'), record);
    assert.deepEqual(h.spawned, []);
  });
}

test('T13 choosing again overwrites the representative record and the next ordinary open uses it', async t => {
  const { h, ui, menu } = menuFixture(t);
  const item = menu();
  assert.ok(item);
  item.click();
  await tick(); await tick();
  ui.document.querySelector('input[type="radio"][data-choice-id="c"]').click();
  [...ui.document.querySelectorAll('.choice-dialog button')].find(button => button.textContent === 'Open').click();
  await tick(); await tick();
  assert.deepEqual(h.spawned.map(entry => entry.id), ['c']);
  assert.deepEqual(JSON.parse(JSON.stringify(await h.ctx.api.getSetting('continuationChoice:old'))), { chosen: 'c', candidates: ['b', 'c'] });
  h.ctx.openSessions.clear();
  await h.app.openSession(h.ctx.rowHeadSession(h.rows.get('old')));
  assert.equal(h.prompts.length, 1);
  assert.deepEqual(h.spawned.map(entry => entry.id), ['c', 'c']);
});

test('the menu can choose again while the clicked row has an open tab', async t => {
  const { h, ui, menu } = menuFixture(t, { open: true });
  const item = menu();
  assert.ok(item);
  item.click();
  await tick(); await tick();
  assert.equal(h.prompts.length, 1, 'the explicit menu choice must reach the chooser');
  [...ui.document.querySelectorAll('.choice-dialog button')].find(button => button.textContent === 'Cancel').click();
  await tick();
  assert.equal(h.ctx.openSessions.has('head'), true);
  assert.deepEqual(h.spawned, []);
});
