'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, answerChoiceDialog } = require('./dom-setup');

test('archive choice, Undo and re-enable use counts and Schedules tab while failures keep names', async t => {
  const h = setupSidebarDom();
  t.after(() => h.destroy());
  const project = { projectPath: '/p', folder: '-p', sessions: [], reenableOffer: { names: ['Secret nightly'], failed: [{ name: 'Failed nightly', error: 'EACCES' }] } };
  h.window.cachedAllProjects = [project];
  h.sidebar.renderProjects([project], true);
  const notice = h.document.querySelector('.schedule-reenable-notice');
  assert.match(notice.textContent, /1 schedule was turned off/);
  assert.doesNotMatch(notice.textContent, /Secret nightly/);
  assert.match(notice.textContent, /Schedules/);
  assert.match(notice.textContent, /Could not turn back on: Failed nightly: EACCES/);
  let shown;
  h.window.showSchedules = p => { shown = p; };
  notice.querySelector('.schedule-reenable-show').click();
  assert.equal(shown, '/p');
  h.window.api.getProjectArchivePlan = async () => ({ schedules: [
    { name: 'Secret nightly', filePath: '/p/.claude/commands/schedule-a.md', disableable: true },
    { name: 'Linked nightly', filePath: '/p/.claude/commands/schedule-b.md', disableable: false, reason: 'linked' },
  ] });
  h.window.api.archiveProject = async () => ({ ok: true, archivedAt: 'now', disabled: ['Secret nightly'], failed: [] });
  const pending = h.document.querySelector('.project-archive-btn').onclick({ stopPropagation() {} });
  const overlay = await answerChoiceDialog(h, { confirm: true });
  await pending;
  const label = overlay.querySelector('[data-choice-id="disableSchedules"]').parentElement.textContent;
  assert.match(label, /Disable the 1 enabled schedule.*listed in the Schedules tab/);
  assert.doesNotMatch(overlay.textContent, /Secret nightly|Linked nightly/);
  assert.match(overlay.textContent, /1 schedule stays enabled; see the Schedules tab/);
  h.window.showFolderArchiveUndo(project, [{ projectPath: '/p', folderKey: '-p' }], 'now', [], false, [], ['Secret nightly'], []);
  const undo = h.document.querySelector('#app-notices [role="status"]');
  assert.ok(undo, 'the Undo notice is displayed');
  assert.match(undo.textContent, /1 schedule turned off; Undo turns them back on. See the Schedules tab/);
  assert.doesNotMatch(undo.textContent, /Secret nightly/);
});
