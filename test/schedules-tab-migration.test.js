'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createWriterCommands } = require('../session-index-commands');
const { SETTING_DEFAULTS } = require('../public/setting-defaults');

const ROOT = path.join(__dirname, '..');
const MARKER = 'schedulesTabDefaultMigrated';

function store(global) {
  const settings = new Map(global === undefined ? [] : [['global', structuredClone(global)]]);
  const writes = [];
  const db = {
    failWrites: false,
    getSetting: key => structuredClone(settings.get(key) ?? null),
    setSetting: (key, value) => {
      if (db.failWrites) throw new Error('SQLITE_FULL: database or disk is full');
      writes.push(key);
      settings.set(key, structuredClone(value));
    },
  };
  return { db, writes, global: () => settings.get('global') ?? null };
}

const launch = s => createWriterCommands(s.db).migrateSchedulesTabDefault();
const shown = global => (global?.schedulesTab ?? SETTING_DEFAULTS.schedulesTab) === true;

test('a stored false without the marker turns the tab on once and writes the marker with it (#1239)', () => {
  const s = store({ schedulesTab: false, theme: 'dark', remoteHosts: [{ alias: 'h' }] });
  assert.equal(launch(s), 'turned-on');
  assert.deepEqual(s.global(), { theme: 'dark', remoteHosts: [{ alias: 'h' }], [MARKER]: true });
  assert.equal(shown(s.global()), true);
  assert.deepEqual(s.writes, ['global'], 'one write carries both changes');
});

test('a stored false with the marker is an opt-out made after the update and stays off (#1239)', () => {
  const s = store({ schedulesTab: false, [MARKER]: true });
  assert.equal(launch(s), 'none');
  assert.deepEqual(s.global(), { schedulesTab: false, [MARKER]: true });
  assert.equal(shown(s.global()), false);
  assert.deepEqual(s.writes, []);
});

test('a profile with no global settings gets the marker so a later opt-out is kept (#1239)', () => {
  const s = store();
  assert.equal(launch(s), 'marked');
  assert.deepEqual(s.global(), { [MARKER]: true });
  assert.equal(shown(s.global()), true);
});

test('global settings without a schedulesTab key get the marker and keep the default (#1239)', () => {
  const s = store({ theme: 'light' });
  assert.equal(launch(s), 'marked');
  assert.deepEqual(s.global(), { theme: 'light', [MARKER]: true });
  assert.equal(shown(s.global()), true);
});

test('a stored true is left unchanged apart from the marker (#1239)', () => {
  const s = store({ schedulesTab: true });
  assert.equal(launch(s), 'marked');
  assert.deepEqual(s.global(), { schedulesTab: true, [MARKER]: true });
});

test('a stored value that is not an object is not overwritten (#1239)', () => {
  const s = store('corrupt');
  assert.equal(launch(s), 'none');
  assert.equal(s.global(), 'corrupt');
  assert.deepEqual(s.writes, []);
});

test('the migration is idempotent across launches and keeps an opt-out made in between (#1239)', () => {
  const s = store({ schedulesTab: false });
  assert.equal(launch(s), 'turned-on');
  assert.equal(launch(s), 'none');
  assert.deepEqual(s.writes, ['global']);
  s.db.setSetting('global', { ...s.global(), schedulesTab: false });
  assert.equal(launch(s), 'none');
  assert.equal(shown(s.global()), false, 'turning the tab off after the update is honoured');
});

test('a failed write leaves the settings untouched and the next launch migrates (#1239)', () => {
  const s = store({ schedulesTab: false });
  s.db.failWrites = true;
  assert.throws(() => launch(s), /SQLITE_FULL/);
  assert.deepEqual(s.global(), { schedulesTab: false });
  s.db.failWrites = false;
  assert.equal(launch(s), 'turned-on');
  assert.equal(s.global()[MARKER], true);
});

test('startup survives a rejected migration and logs it, then a later launch migrates (#1239)', async () => {
  const { migrateSchedulesTabOnStartup } = require('../src/main/schedules/schedules-tab-migration');
  const warnings = [];
  const log = { warn: message => warnings.push(message), info() {} };
  const failing = { migrateSchedulesTabDefault: async () => { throw new Error('writer is closing'); } };
  assert.equal(await migrateSchedulesTabOnStartup(failing, log), null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /writer is closing/);
  const s = store({ schedulesTab: false });
  const working = { migrateSchedulesTabDefault: async () => launch(s) };
  assert.equal(await migrateSchedulesTabOnStartup(working, log), 'turned-on');
  assert.equal(shown(s.global()), true);
});

test('main waits for the migration at load only up to its bound, before the window, and pushes a late change (#1239)', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.equal(main.includes('await migrateSchedulesTabOnStartup('), false, 'startup never awaits the unbounded migration');
  const at = main.indexOf('await migrateSchedulesTabWithinBound(writer, log, {');
  assert.notEqual(at, -1);
  assert.ok(at > main.indexOf('const INSTALL_PREDATES_LAUNCH ='), 'after the install signal is read');
  assert.ok(at < main.indexOf('function createWindow'));
  assert.ok(at < main.indexOf('app.whenReady().then('));
  const call = main.slice(at, main.indexOf('});', at));
  assert.match(call, /onLateChange: \(\) => \{/);
  assert.match(call, /webContents\.send\('schedules-tab-migrated'\)/);
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  assert.match(preload, /onSchedulesTabMigrated: .*ipcRenderer\.on\('schedules-tab-migrated'/);
  const facade = fs.readFileSync(path.join(ROOT, 'session-index-writer.js'), 'utf8');
  assert.ok(facade.includes("request('migrateSchedulesTabDefault')"));
});

const flush = () => new Promise(resolve => setImmediate(resolve));

function boundHarness(migrate) {
  const warnings = [];
  const late = [];
  const log = { warn: message => warnings.push(message), info() {} };
  return { warnings, late, log, writer: { migrateSchedulesTabDefault: migrate }, onLateChange: () => late.push('notified') };
}

test('a stalled writer releases startup after the bound and a late turn-on reaches the renderer (#1239)', async () => {
  const { migrateSchedulesTabWithinBound, STARTUP_WAIT_MS } = require('../src/main/schedules/schedules-tab-migration');
  assert.ok(STARTUP_WAIT_MS > 0 && STARTUP_WAIT_MS <= 2000, 'the default bound keeps the first window within two seconds');
  let finish;
  const h = boundHarness(() => new Promise(resolve => { finish = resolve; }));
  const started = Date.now();
  assert.equal(await migrateSchedulesTabWithinBound(h.writer, h.log, { waitMs: 30, onLateChange: h.onLateChange }), 'pending');
  assert.ok(Date.now() - started < 1000, 'startup continues at the bound, not when the writer answers');
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /30 ms/);
  assert.deepEqual(h.late, []);
  finish('turned-on');
  await flush();
  assert.deepEqual(h.late, ['notified'], 'the renderer is told once the late migration commits');
});

test('a late migration that changes nothing visible, or fails, never notifies the renderer (#1239)', async () => {
  const { migrateSchedulesTabWithinBound } = require('../src/main/schedules/schedules-tab-migration');
  for (const outcome of ['marked', 'none', 'reject']) {
    let finish;
    let fail;
    const h = boundHarness(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    assert.equal(await migrateSchedulesTabWithinBound(h.writer, h.log, { waitMs: 10, onLateChange: h.onLateChange }), 'pending');
    if (outcome === 'reject') fail(new Error('command timed out'));
    else finish(outcome);
    await flush();
    assert.deepEqual(h.late, [], outcome);
    if (outcome === 'reject') assert.match(h.warnings.at(-1), /command timed out/);
  }
});

test('a migration that answers within the bound returns its result and does not notify (#1239)', async () => {
  const { migrateSchedulesTabWithinBound } = require('../src/main/schedules/schedules-tab-migration');
  const s = store({ schedulesTab: false });
  const h = boundHarness(async () => launch(s));
  assert.equal(await migrateSchedulesTabWithinBound(h.writer, h.log, { waitMs: 5000, onLateChange: h.onLateChange }), 'turned-on');
  await flush();
  assert.deepEqual(h.late, []);
  assert.deepEqual(h.warnings, []);
  assert.equal(shown(s.global()), true);
});

function writerLaunch(dir, scenario) {
  const result = spawnSync(require('electron'), ['-e', `
    const assert = require('node:assert/strict');
    const { createSessionIndexWriter } = require('./session-index-writer');
    const writer = createSessionIndexWriter();
    (async () => {
      try { await writer.ready; const db = require('./db'); ${scenario} }
      finally { await writer.closeDb(); }
      console.log('launch verified');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dir },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /launch verified/);
}

test('through the real writer, the migrated value is what main reads, and a second launch writes nothing (#1239)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedules-tab-migration-'));
  try {
    writerLaunch(dir, `
      await writer.setSetting('global', { schedulesTab: false, theme: 'dark' });
      assert.equal(await writer.migrateSchedulesTabDefault(), 'turned-on');
      assert.deepEqual(db.getSetting('global'), { theme: 'dark', ${MARKER}: true });
    `);
    writerLaunch(dir, `
      assert.equal(await writer.migrateSchedulesTabDefault(), 'none');
      await writer.patchGlobal({ schedulesTab: false });
    `);
    writerLaunch(dir, `
      assert.equal(await writer.migrateSchedulesTabDefault(), 'none');
      assert.deepEqual(db.getSetting('global'), { theme: 'dark', ${MARKER}: true, schedulesTab: false });
    `);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
