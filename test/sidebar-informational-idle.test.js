'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTaskRecordsClient } = require('../task-records-client');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

for (const delayed of [false, true]) {
  test(`1085: local sidebar stays idle after information (delayed head: ${delayed})`, async t => {
    const ctx = setupSidebarDom();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-info-1085-'));
    const file = path.join(dir, 'root.jsonl');
    const client = createTaskRecordsClient({ onSnapshot: s => ctx.emitTaskSnapshot(s) });
    t.after(async () => {
      await client.dispose();
      ctx.destroy();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    let now = 1_800_000_000_000;
    ctx.window.Date.now = () => now;
    ctx.window.activeSessionId = 'root';
    ctx.window.activePtyIds.add('root');
    const row = { sessionId: 'root', status: 'busy', statusUpdatedAt: now };
    const render = () => ctx.sidebar.renderProjects([makeSampleProject({ sessions: [row] })], true);
    const busy = () => ctx.document.querySelector('#si-root').classList.contains('cli-busy');
    const append = entry => fs.appendFileSync(file, JSON.stringify({ timestamp: new Date(now).toISOString(), ...entry }) + '\n');
    const read = () => client.read(file, 'root', { turnOnly: true });
    render();
    append({ type: 'user', message: { role: 'user', content: 'Work before resume' } });
    if (!delayed) {
      await read();
      assert.equal(busy(), true, 'the fixture must begin with an open busy turn');
    }
    now += 1000;
    ctx.setActivity('root', false, 'onCliBusyState');
    now += 100;
    row.status = 'idle';
    row.statusUpdatedAt = now;
    render();
    assert.equal(busy(), false, 'the idle descriptor must clear the row before the notice');
    now += 1000;
    append({ type: 'system', subtype: 'informational', content: 'auto mode' });
    await read();
    const head = ctx.read('headTurns.get("root")');
    assert.equal(busy(), false, 'idle descriptor and OSC must survive the informational append');
    now += 16000;
    await read();
    assert.equal(busy(), false, 'unchanged data must remain idle after 16 seconds');
    assert.equal(ctx.read('headTurns.get("root").observedAt'), head.observedAt);
    now += 1000;
    append({ type: 'user', message: { role: 'user', content: 'Active turn after stale idle' } });
    await read();
    assert.equal(busy(), true, 'a new prompt must reopen the row despite the old idle descriptor');
    now += 1000;
    append({ type: 'system', subtype: 'informational', content: 'auto mode during work' });
    await read();
    assert.equal(busy(), true, 'active turn plus information must beat stale idle evidence');
  });
}
