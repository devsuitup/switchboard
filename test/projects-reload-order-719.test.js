'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

for (const consumer of ['loadStartupProjects', 'markRestoreIndexingDone']) {
  test(`T4.6 ${consumer} reports an effective generation failure once`, async t => {
    const h = setupSidebarDom(); t.after(() => h.destroy()); const w = h.window, warnings = []; let calls = 0;
    w.console.warn = (...args) => warnings.push(args);
    w.loadingStatus = w.document.createElement('div'); w.cachedProjects = []; w.cachedAllProjects = [];
    for (const name of ['reportActivityFocus', 'reportActivityTitles', 'renderDefaultStatus', 'setRemoteHostLabels', 'refreshSidebar', 'clearAppNotice']) w[name] = () => {};
    w.restoreStartupSessions = async () => {}; w.pollActiveSessions = async () => undefined;
    w.tickRestorePlanner = async () => {}; w.maybeRetryRestoreWorkingSet = async () => {}; w.restorePlanner = { isSettled: () => false };
    w.skippedWorkingSetEntries = new Map(); w.api.getSetting = async () => ({}); w.api.getActiveTerminals = async () => [];
    w.api.getProjects = async () => {
      if (++calls === 1) throw Error('single effective failure');
      return { defaultProjects: [], allProjects: [] };
    };
    loadAppFunctions(h.context, { functions: ['dedup', 'loadProjects', consumer] });
    await w[consumer](); assert.equal(warnings.length, 1);
  });
}
function fixture(t) {
  const h = setupSidebarDom(); t.after(() => h.destroy());
  const w = h.window, requests = [], settings = [], polls = [], paints = [];
  w.loadingStatus = w.document.createElement('div'); w.cachedProjects = []; w.cachedAllProjects = [];
  for (const name of ['reportActivityFocus', 'reportActivityTitles', 'renderDefaultStatus', 'setRemoteHostLabels']) w[name] = () => {};
  w.refreshSidebar = () => paints.push(w.cachedProjects[0]?.projectPath);
  w.api.getProjects = mode => { assert.equal(mode, 'both'); const d = deferred(); requests.push(d); return d.promise; };
  w.api.getSetting = () => { const d = deferred(); settings.push(d); return d.promise; };
  w.api.getActiveTerminals = async () => [];
  w.pollActiveSessions = () => { const d = deferred(); polls.push(d); return d.promise; };
  const { loadProjects, reloadProjects } = loadAppFunctions(h.context, { functions: ['dedup', 'loadProjects', 'reloadProjects'] });
  const reply = (i, name) => requests[i].resolve({ defaultProjects: [{ projectPath: name, sessions: [] }], allProjects: [{ projectPath: name, sessions: [] }] });
  return { ...h, w, requests, settings, polls, paints, loadProjects, reloadProjects, reply };
}

for (const boundary of ['projects', 'settings', 'terminals', 'poll']) {
  test(`T4.2 older ${boundary} completion cannot alter a newer accepted projection`, async t => {
    const h = fixture(t), terminals = [];
    h.w.api.getActiveTerminals = () => { const d = deferred(); terminals.push(d); return d.promise; };
    const old = h.loadProjects();
    if (boundary !== 'projects') { h.reply(0, 'old'); await flush(); }
    if (['terminals', 'poll'].includes(boundary)) { h.settings[0].resolve({}); await flush(); }
    if (boundary === 'poll') { terminals[0].resolve([]); await flush(); }
    const current = h.loadProjects(); h.reply(1, 'new'); await flush();
    h.settings.at(-1).resolve({}); await flush(); terminals.at(-1).resolve([]); await flush(); h.polls.at(-1).resolve();
    await current; await old;
    if (boundary === 'projects') h.reply(0, 'old');
    if (boundary === 'settings') h.settings[0].resolve({});
    if (boundary === 'terminals') terminals[0].resolve([{ sessionId: 'obsolete', projectPath: 'old' }]);
    if (boundary === 'poll') h.polls[0].resolve({ entries: [{ sessionId: 'obsolete' }], seq: 0 });
    await flush();
    assert.deepEqual(h.paints, ['new']); assert.equal(h.w.cachedProjects[0].projectPath, 'new');
    assert.equal(h.w.pendingSessions.has('obsolete'), false);
  });
}

test('T4.6 a superseding plain reload retains the pending resort intent', async t => {
  const h = fixture(t), intents = []; h.w.refreshSidebar = options => intents.push(options.resort);
  const older = h.loadProjects({ resort: true }), latest = h.loadProjects();
  h.reply(1, 'new'); await flush(); h.settings[0].resolve({}); await flush(); h.polls[0].resolve();
  await latest; await older; assert.deepEqual(intents, [true]);
  h.requests[0].reject(Error('obsolete')); await flush();
});

for (const eventName of ['onSessionDetected', 'onSessionForked']) for (const active of [true, false]) for (const failed of [false, true]) {
  test(`T4.6 ${eventName} joins newest member projection and respects active intent, active=${active}, failed=${failed}`, async t => {
    const h = fixture(t), w = h.w; let event;
    w.api[eventName] = callback => { event = callback; };
    w.openSessions.set('temp', { session: { sessionId: 'temp', projectPath: '/p' }, terminal: { focus() {} } });
    w.activeSessionId = 'temp'; w.setActiveSession = id => { w.activeSessionId = id; };
    w.terminalHeaderId = w.document.createElement('span'); w.terminalHeaderName = w.document.createElement('span');
    w.rekeyActivityState = () => {}; w.schedulePersistWorkingSet = () => {};
    w.pollActiveSessions = async () => undefined;
    w.refreshSidebar = () => h.sidebar.renderProjects(w.cachedProjects, true);
    loadAppFunctions(h.context, { functions: ['followProjectsSettlement', 'rekeySessionTab'] });
    const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
    const start = source.indexOf('window.api.' + eventName + '(');
    vm.runInContext(source.slice(start, source.indexOf('\n});', start) + 4), h.context);
    event('temp', 'real', 'fork'); if (!active) w.activeSessionId = 'other';
    const newest = h.loadProjects(); const result = Promise.allSettled([newest]);
    if (failed) h.requests[1].reject(Error('effective failure'));
    else {
      const owner = { sessionId: 'owner', mergedMemberIds: ['real'], projectPath: '/p', summary: 'effective owner', modified: new w.Date().toISOString() };
      h.requests[1].resolve({ defaultProjects: [{ projectPath: '/p', sessions: [owner] }], allProjects: [{ projectPath: '/p', sessions: [{ ...owner }] }] });
      await flush(); h.settings[0].resolve({}); await flush();
    }
    await result; await flush();
    const item = w.document.querySelector('.session-item[data-session-id="owner"]');
    assert.equal(!!item?.classList.contains('active'), active && !failed);
    assert.equal(w.activeSessionId, active ? 'real' : 'other');
    if (eventName === 'onSessionForked' && active && !failed) assert.equal(w.terminalHeaderName.textContent, 'effective owner');
    h.requests[0].reject(Error('obsolete event request')); await flush();
  });
}
test('T4.1 old settings cannot overwrite a newer committed generation; followers settle before the held operation', async t => {
  const h = fixture(t);
  const first = h.loadProjects(); h.reply(0, 'old'); await flush();
  let firstSettled = false; first.then(() => { firstSettled = true; }, () => { firstSettled = true; });
  const second = h.loadProjects(); h.reply(1, 'new'); await flush();
  h.settings[1].resolve({}); await flush(); h.polls[0].resolve(); await flush();
  assert.equal(h.w.cachedProjects[0].projectPath, 'new');
  assert.equal(firstSettled, true, 'the older caller follows the newer settlement without waiting for old settings');
  assert.equal((await first).generation, (await second).generation);
  h.settings[0].resolve({}); await flush();
  assert.deepEqual(h.paints, ['new']);
});
test('T4.2 held old poll stages all side effects until admission', async t => {
  const h = fixture(t);
  const first = h.loadProjects(); h.reply(0, 'old'); await flush(); h.settings[0].resolve({}); await flush();
  assert.equal(h.w.cachedProjects.length, 0, 'no half publication before poll');
  const second = h.loadProjects(); h.reply(1, 'new'); await flush(); h.settings[1].resolve({}); await flush();
  h.polls[1].resolve(); await second; h.polls[0].resolve(); await first; await flush();
  assert.deepEqual(h.paints, ['new']);
});

test('T4.2 actual reload-origin poll cannot publish PTY, busy, header or timer effects after a newer commit', async t => {
  const h = fixture(t), polls = [], applied = [];
  h.w.api.getActiveSessions = () => { const d = deferred(); polls.push(d); return d.promise; };
  h.w.currentActivitySeq = () => 0;
  h.w.reconcileBusyState = entries => applied.push(entries[0].sessionId);
  h.w.updateRunningIndicators = () => {}; h.w.updateTerminalHeader = () => {}; h.w.scheduleActiveSessionsPoll = () => {};
  loadAppFunctions(h.context, { functions: ['pollActiveSessions'] });
  const first = h.loadProjects(); h.reply(0, 'old'); await flush(); h.settings[0].resolve({}); await flush();
  const second = h.loadProjects(); h.reply(1, 'new'); await flush(); h.settings[1].resolve({}); await flush();
  polls[1].resolve([{ sessionId: 'new' }]); await second; await first;
  polls[0].resolve([{ sessionId: 'old' }]); await flush();
  assert.deepEqual(applied, ['new']); assert.deepEqual(Array.from(h.w.activePtyIds), ['new']);
});
test('T4.3 newer failure rejects followers while an older eligible operation still publishes', async t => {
  const h = fixture(t);
  const first = h.loadProjects(); h.reply(0, 'old'); await flush();
  const second = h.loadProjects(); let settled = false;
  const rejected = Promise.allSettled([first, second]).then(value => { settled = true; return value; });
  h.requests[1].reject(new Error('latest failed')); await flush();
  assert.equal(settled, true, 'both callers reject the latest failure while the old operation is held');
  assert.deepEqual((await rejected).map(r => r.status), ['rejected', 'rejected']);
  h.settings[0].resolve({}); await flush(); assert.equal(h.polls.length, 1, 'eligible older load reaches guarded poll'); h.polls[0].resolve(); await flush();
  assert.equal(h.w.cachedProjects[0].projectPath, 'old'); assert.deepEqual(h.paints, ['old']);
  assert.equal(h.w.loadingStatus.style.display, 'none');
});
for (const seeded of [false, true]) {
  test(`T4.7 sustained starts publish raw views, DOM, labels and diagnostics while newer work stays pending, C0=${seeded}`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const h = fixture(t), calls = [], labels = [], records = [];
    const w = h.w, sid = '369b1c23-9bd7-47a2-b4bf-36ee3ca4b55f';
    w.TextEncoder = TextEncoder; h.evalPublic('session-projection-diagnostics.js');
    w.api.sessionProjectionChanged = record => records.push(record);
    w.setRemoteHostLabels = hosts => labels.push(hosts[0].label);
    w.refreshSidebar = () => { h.paints.push(w.cachedProjects[0].sessions[0].summary); h.sidebar.renderProjects(w.cachedProjects, true); };
    loadAppFunctions(h.context, { functions: ['observeSessionProjection'] });
    if (seeded) {
      w.cachedProjects = [{ projectPath: '/p', sessions: [{ sessionId: sid, projectPath: '/p', summary: 'C0', mergedMemberIds: ['initial'] }] }];
      w.cachedAllProjects = w.cachedProjects;
    }
    const complete = async n => {
      const row = { sessionId: sid, projectPath: '/p', summary: String(n), modified: new w.Date().toISOString(), mergedMemberIds: ['part-' + n] };
      h.requests[n].resolve({ defaultProjects: [{ projectPath: '/p', sessions: [row] }], allProjects: [{ projectPath: '/p', sessions: [{ ...row }] }], projection: { buildId: n + 1, removedInputs: {} } });
      await flush(); assert.ok(h.settings[n], 'a completed eligible response continues despite newer pending starts');
      h.settings[n].resolve({ remoteHosts: [{ label: String(n) }] }); await flush(); h.polls[n].resolve(); await flush();
      assert.equal(w.cachedProjects[0].sessions[0].summary, String(n));
      assert.equal(w.cachedAllProjects[0].sessions[0], w.cachedProjects[0].sessions[0]);
      assert.equal(w.sessionMap.get(sid), w.cachedProjects[0].sessions[0]);
      assert.equal(h.document.querySelector('.session-summary').textContent, String(n));
      assert.equal(labels.at(-1), String(n)); assert.equal(records.length, n + 1);
      assert.equal(records.at(-1).generation, n + 1);
      assert.equal(h.paints.length, n + 1);
    };
    for (let i = 0; i < 11; i++) {
      t.mock.timers.tick(1500); calls.push(h.loadProjects());
      if (i >= 3) { await complete(i - 3); assert.equal(w.loadingStatus.textContent, 'Refreshing…'); }
    }
    for (let n = 8; n < 11; n++) await complete(n);
    assert.equal((await Promise.all(calls)).every(r => r.accepted && r.generation === 11), true);
    assert.equal(w.loadingStatus.style.display, 'none');
  });
}

for (const fail of [false, true]) {
  test(`T4.5 restore callers follow a plain load and coalesce one planner tick, failure=${fail}`, async t => {
    const h = fixture(t); let ticks = 0;
    h.w.tickRestorePlanner = async () => { ticks++; };
    loadAppFunctions(h.context, { functions: ['followProjectsSettlement', 'maybeRetryRestoreWorkingSet'] });
    const retry1 = h.reloadProjects({ restoreRetry: true }), retry2 = h.reloadProjects({ restoreRetry: true });
    const plain = h.loadProjects(); const settled = Promise.allSettled([retry1, retry2, plain]);
    if (fail) h.requests[2].reject(new Error('plain failed'));
    else { h.reply(2, 'effective'); await flush(); h.settings[0].resolve({}); await flush(); h.polls[0].resolve(); }
    const outcomes = await settled;
    assert.equal(outcomes[0].value, !fail); assert.equal(outcomes[1].value, !fail); assert.equal(ticks, fail ? 0 : 1);
    h.requests[0].reject(new Error('old rejected')); h.requests[1].reject(new Error('old rejected')); await flush();
    assert.equal(ticks, fail ? 0 : 1);
  });
}

test('T4.4 three successive generations follow newest settlement and obsolete failures never replace it', async t => {
  const h = fixture(t), calls = [h.loadProjects(), h.loadProjects(), h.loadProjects()];
  const settled = Promise.all(calls); h.reply(2, 'third'); await flush(); h.settings[0].resolve({}); await flush(); h.polls[0].resolve();
  assert.equal((await settled).every(r => r.generation === 3), true);
  h.requests[0].reject(new Error('obsolete first')); h.requests[1].reject(new Error('obsolete second')); await flush();
  assert.deepEqual(h.paints, ['third']); assert.equal(h.w.loadingStatus.style.display, 'none');
});
