'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cache = require('../session-cache');
const { encodeProjectPath } = require('../encode-project-path');
const { setup } = require('./continuations-harness');

function installRows(h, rows) {
  h.ctx.sessionMap.clear();
  h.ctx.localMergedMemberRows.clear();
  for (const row of rows) {
    h.ctx.sessionMap.set(row.sessionId, row);
    for (const id of row.mergedMemberIds || []) h.ctx.localMergedMemberRows.set(id, row);
  }
}

function rolledRow(h) {
  h.rows.get('old').modified = '2026-10-19T10:00:00.000Z';
  h.rows.get('mid').modified = '2026-10-19T11:00:00.000Z';
  const rows = cache.buildProjectsFromCache(false).flatMap(project => project.sessions);
  const row = rows.find(row => row.sessionId === 'old');
  assert.equal(row.headSessionId, 'mid');
  assert.deepEqual(row.mergedMemberIds, ['mid']);
  installRows(h, rows);
  return row;
}

for (const initialScanComplete of [true, false]) {
  test(`#789: mirror chain sidebar and click resolution with scan complete=${initialScanComplete}`, async t => {
    const h = setup(t, { old: ['mirror', 'gone'], mirror: ['b'], b: ['c'], c: [] }, { initialScanComplete });
    h.rows.get('old').bridgeSessionId = 'bridge';
    Object.assign(h.rows.get('mirror'), { bridgeSessionId: 'bridge', mergedIntoSessionId: 'old' });
    for (const [i, id] of ['old', 'mirror', 'b', 'c'].entries()) {
      h.rows.get(id).modified = `2026-10-19T10:00:0${i}.000Z`;
    }
    const rows = cache.buildProjectsFromCache(false).flatMap(project => project.sessions);
    if (!initialScanComplete) {
      assert.deepEqual(rows.map(row => row.sessionId).sort(), ['b', 'c', 'old']);
      return;
    }
    assert.deepEqual(rows.map(row => row.sessionId), ['old']);
    const row = rows[0];
    assert.equal(row.headSessionId, 'c');
    assert.deepEqual([...row.mergedMemberIds].sort(), ['b', 'c', 'mirror']);
    assert.deepEqual(cache.conversationMemberIds([...h.rows.values()], 'b').sort(), ['c', 'mirror', 'old']);
    const resolved = await h.ctx.api.getSessionContinuations('old');
    assert.equal(resolved.unresolved, false);
    assert.deepEqual(resolved.candidates.map(candidate => candidate.sessionId), [row.headSessionId]);
    installRows(h, rows);
    await h.app.openSession(h.ctx.rowHeadSession(row));
    assert.deepEqual(h.spawned.map(call => call.id), ['c']);
    assert.deepEqual(h.prompts, []);
  });
}

for (const automatic of [false, true]) {
  test(`rolled old -> mid -> gone ${automatic ? 'restore' : 'click'} opens the head with a missing notice and no prompt`, async t => {
    const h = setup(t, { old: ['mid'], mid: ['gone'] });
    const row = rolledRow(h);
    if (automatic) await h.restore();
    else await h.app.openSession(row);
    await h.app.persistWorkingSet();
    assert.deepEqual(h.spawned.map(call => call.id), ['mid']);
    assert.deepEqual(h.prompts, []);
    const notice = h.dom.window.document.querySelector('#app-notices [role="status"]');
    assert.match(notice?.textContent, /no longer exists on disk/);
    assert.equal(h.dom.window.document.querySelector('#app-notices [role="alert"]'), null);
    assert.deepEqual(h.settings().openWorkingSet.map(item => item.sessionId), ['mid']);
  });

  test(`a rolled row with a newly indexed target in another row ${automatic ? 'holds restore' : 'asks on click'}`, async t => {
    const h = setup(t, { old: ['mid'], mid: ['present'], present: ['gone'] }, { choice: 'present' });
    const present = h.rows.get('present');
    h.rows.delete('present');
    const row = rolledRow(h);
    const otherProject = path.join(h.root, 'other-project');
    fs.mkdirSync(otherProject);
    const otherFolder = encodeProjectPath(otherProject);
    fs.mkdirSync(path.join(h.root, otherFolder));
    fs.renameSync(path.join(h.root, h.folder, 'present.jsonl'), path.join(h.root, otherFolder, 'present.jsonl'));
    h.rows.set('present', { ...present, folder: otherFolder, projectPath: otherProject });
    h.db.setFolderMeta(otherFolder, otherProject, 0);
    const target = cache.buildProjectsFromCache(false).flatMap(project => project.sessions)
      .find(row => row.sessionId === 'present');
    assert.ok(target);
    installRows(h, [row, target]);
    if (automatic) await h.restore();
    else await h.app.openSession(row);
    await h.app.persistWorkingSet();
    if (automatic) {
      assert.deepEqual(h.spawned, []);
      assert.deepEqual(h.prompts, []);
      assert.deepEqual(h.settings().openWorkingSet.map(item => item.sessionId), ['old']);
    } else {
      assert.deepEqual(h.spawned.map(call => call.id), ['present']);
      assert.equal(h.prompts.length, 1);
      assert.equal(h.prompts[0].title, 'Open which part?');
    }
    assert.equal(h.dom.window.document.querySelector('[data-notice-id="continuation-missing:old"]'), null);
  });
}

for (const automatic of [false, true]) {
  for (const uncertainty of ['damaged index', 'waiting for indexing', 'unreadable inventory']) {
    test(`a rolled row with ${uncertainty} ${automatic ? 'holds restore' : 'asks on click'}`, async t => {
      const h = setup(t, { old: ['mid'], mid: ['gone'] });
      const row = rolledRow(h);
      if (uncertainty === 'damaged index') {
        fs.appendFileSync(path.join(h.root, h.folder, 'mid.jsonl'),
          JSON.stringify({ type: 'continued-in', sessionId: 'mid', continuedInSessionId: '../invalid' }) + '\n');
      } else if (uncertainty === 'waiting for indexing') {
        fs.writeFileSync(path.join(h.root, h.folder, 'gone.jsonl'), '{}\n');
      } else {
        t.mock.method(fs.promises, 'readdir', async () => { throw new Error('fixture unreadable'); });
      }
      if (automatic) await h.restore();
      else await h.app.openSession(row);
      assert.deepEqual(h.spawned, []);
      assert.equal(h.prompts.length, automatic ? 0 : 1);
      assert.equal(h.dom.window.document.querySelector('[data-notice-id="continuation-missing:old"]'), null);
    });
  }
}

for (const state of [{ exited: true }, { isPlainTerminal: true }, { host: 'remote' }]) {
  test(`an inactive or unrelated terminal cannot prove a missing target present (${JSON.stringify(state)})`, async t => {
    const h = setup(t, { old: ['here'] }, { active: new Map([['here', state]]) });
    assert.equal((await h.ctx.api.getSessionContinuations('old')).missing, true);
  });
}

for (const automatic of [false, true]) {
  for (const remapped of [false, true]) {
    test(`a target in an own terminal without a transcript (${remapped ? 'real id' : 'map key'}) ${automatic ? 'restores' : 'asks on click'}`, async t => {
      const active = new Map([[remapped ? 'temporary' : 'here', { realSessionId: remapped ? 'here' : undefined, exited: false }]]);
      const h = setup(t, { old: ['here'] }, { active });
      const inventory = t.mock.method(fs.promises, 'readdir');
      const result = await h.ctx.api.getSessionContinuations('old');
      assert.equal(result.missing, false);
      assert.equal(result.unresolved, false);
      assert.deepEqual(result.candidates.map(candidate => candidate.sessionId), ['here']);
      assert.equal(inventory.mock.callCount(), 0);
      await (automatic ? h.restore() : h.click());
      assert.equal(h.prompts.length, automatic ? 0 : 1);
      if (automatic) assert.deepEqual(h.spawned.map(call => call.id), ['here']);
      else assert.equal(h.prompts[0].title, 'Open which part?');
      assert.equal(h.dom.window.document.querySelector('[data-notice-id="continuation-missing:old"]'), null);
    });
  }
}
