'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { fixture: mainFixture, ID } = require('./fixtures/trigger-main-open.cjs');
const { fixture: rendererFixture } = require('./fixtures/trigger-renderer-open.cjs');
const cli = require('../cli-session-state');
const { createTriggerRendererBridge } = require('../src/main/triggers/trigger-renderer-bridge');
const { createTriggerContext } = require('../src/main/triggers/trigger-context');
const { start } = require('../src/main/triggers/trigger-watcher');
const { resolveLocalTarget, resolveProject } = require('../src/main/triggers/trigger-actions');
const { validateTriggerOpen } = require('../src/main/triggers/trigger-launch');
const { encodeProjectPath } = require('../encode-project-path');

async function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-lifecycle-')));
  const dirs = Object.fromEntries(['sessions', 'projects', 'project', 'triggers'].map(name => [name, path.join(root, name)]));
  Object.values(dirs).forEach(dir => fs.mkdirSync(dir));
  const previous = {};
  for (const [key, value] of Object.entries({ SWITCHBOARD_TRIGGERS_DIR: dirs.triggers, SWITCHBOARD_TRIGGER_QUIET_MS: '1',
    SWITCHBOARD_BUSY_FALL_SETTLE_MS: '10', SWITCHBOARD_SUBMIT_ENTER_DELAY_MS: '1', SWITCHBOARD_SUBMIT_VERIFY_MS: '400' })) {
    previous[key] = process.env[key]; process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const main = mainFixture(); const renderer = rendererFixture(t);
  const sent = [], writes = [], events = [];
  const ipcMain = new EventEmitter(); const handlers = new Map();
  ipcMain.handle = (name, fn) => handlers.set(name, fn); ipcMain.removeHandler = name => handlers.delete(name);
  const wc = new EventEmitter(); wc.mainFrame = {}; wc.isDestroyed = () => false;
  const win = new EventEmitter(); win.webContents = wc; win.isDestroyed = () => false;
  const event = () => ({ sender: wc, senderFrame: wc.mainFrame });
  wc.send = (channel, payload) => {
    sent.push([channel, payload]);
    if (channel === 'trigger-session-action') void renderer.f.handleTriggerSessionAction(payload);
  };
  const broker = createTriggerRendererBridge({ ipcMain, getWindow: () => win, getSession: id => main.map.get(id), launchAllowed: () => true });
  broker.attach(win); handlers.get('trigger-actions-ready')(event());
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  cli.init({ dir: dirs.sessions, activeSessions: main.map, platform: 'linux', log, onIdle() {}, isProcessAlive: () => true,
    readProcStart: () => '30', readParentPid: () => 1, readCliProcess: () => false,
    v1ProcFs: { readdirSync: () => [String(process.pid)], readlinkSync: () => 'host',
      readFileSync: file => file.endsWith('/status') ? `NSpid:\t${process.pid}\n`
        : `0 (claude) ${['S', '1', ...Array(17).fill('0'), '30'].join(' ')}` } });
  const folder = encodeProjectPath(dirs.project);
  fs.mkdirSync(path.join(dirs.projects, folder));
  const transcript = path.join(dirs.projects, folder, ID + '.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', sessionId: ID, cwd: dirs.project, message: { content: 'start' } }) + '\n');
  const deps = {
    activeSessions: main.map, broker, launchAllowed: () => true, projectsDir: dirs.projects,
    getCachedSession: () => null, getCachedFolder: () => null,
    getProjectSnapshot: async () => ({ allProjects: [{ projectPath: dirs.project }], hiddenProjects: [], hiddenProjectKinds: {} }),
    resolveTarget: resolveLocalTarget, resolveProject, remoteTarget: async () => false,
    liveElsewhere: (id, deadline) => cli.liveElsewhereV1Checked(id, () => false, cli.makePtyPids(main.map), { deadline }),
    saveName: async (id, name) => { events.push(['name', id, name]); fs.writeFileSync(path.join(root, 'name.json'), JSON.stringify({ id, name })); return { name }; },
  };
  Object.assign(main.context, { mainWindow: win, PROJECTS_DIR: dirs.projects, cliSessionState: cli,
    triggerRendererBridge: broker, validateTriggerOpen: permit => validateTriggerOpen(permit, deps),
    encodeProjectPath, getCachedFolder: () => null,
    wireSessionPty: session => { session.generation = 1; },
    spawnPty: (_shell, args, options) => {
      events.push(['spawn', args, options]);
      const id = /--(?:resume|session-id)\s+([a-f0-9-]+)/.exec(args.join(' '))[1];
      const descriptor = status => fs.writeFileSync(path.join(dirs.sessions, process.pid + '.json'), JSON.stringify({
        pid: process.pid, procStart: '30', sessionId: id, kind: 'interactive', status,
        statusUpdatedAt: Date.now() + (status === 'busy' ? 1 : 0), cwd: dirs.project,
      }));
      descriptor('idle');
      return { pid: process.pid, write(data) {
        writes.push(data); events.push(['write', data]);
        if (data === '\r') { main.map.get(id)._cliBusy = true; descriptor('busy'); }
      } };
    },
  });
  Object.assign(renderer.w.api, { openTerminal: (...args) => main.invoke(event(), ...args),
    triggerSessionActionResult: ack => ipcMain.emit('trigger-session-action-result', event(), ack),
    getSessionLiveElsewhere: id => cli.liveElsewhere(id, () => false) });
  renderer.w.guardResume = require('../public/resume-guard').guardResume;
  renderer.w.resolveDefaultSessionOptions = async () => ({ mcpEmulation: false });
  const ctx = createTriggerContext({ activeSessions: main.map, log, projectsDir: dirs.projects,
    getCliStatus: id => cli.getStatus(id), cliSessionState: cli, lifecycle: deps });
  const watcher = start(ctx);
  t.after(() => { watcher.close(); broker.dispose(); cli.stop(); });
  const publish = async (payload, requestId = '21234567-89ab-cdef-0123-456789abcdef') => {
    fs.writeFileSync(path.join(dirs.triggers, requestId + '.tmp'), JSON.stringify(payload));
    fs.renameSync(path.join(dirs.triggers, requestId + '.tmp'), path.join(dirs.triggers, requestId + '.json'));
    const result = path.join(dirs.triggers, 'processed', requestId + '.result.json');
    const deadline = Date.now() + 6000;
    while (!fs.existsSync(result) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(fs.existsSync(result), 'the file request must reach a terminal result');
    return JSON.parse(fs.readFileSync(result, 'utf8'));
  };
  return { dirs, events, writes, main, renderer, publish, sent };
}

test('file -> watcher -> broker -> renderer -> main -> verified resume prompt -> result', async t => {
  const f = await fixture(t);
  const result = await f.publish({ version: 1, action: 'open', sessionId: ID.toUpperCase(), prompt: 'hello', timeout_ms: 3000 });
  assert.equal(result.outcome, 'opened', JSON.stringify(result)); assert.equal(result.resumed, true);
  assert.equal(result.sessionId, ID); assert.deepEqual(f.writes, ['hello', '\r']);
  const spawn = f.events.find(e => e[0] === 'spawn');
  assert.match(spawn[1][0], new RegExp(`--resume ${ID}`)); assert.equal(spawn[2].cwd, f.dirs.project);
  assert.equal(f.renderer.calls.some(c => c[0] === 'focus'), false);
  const duplicate = await f.publish({ version: 1, action: 'open', sessionId: ID, prompt: 'do not replay' });
  assert.deepEqual(duplicate, result); assert.equal(f.events.filter(e => e[0] === 'spawn').length, 1);
  assert.deepEqual(f.writes, ['hello', '\r']);
});
test('file -> ordinary new lifecycle saves exact new name before prompt', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.dirs.sessions, '999999.json'), '{');
  const result = await f.publish({ version: 1, action: 'open', new: { project: f.dirs.project, name: '  Next task  ' }, prompt: 'hello', timeout_ms: 3000 });
  assert.equal(result.outcome, 'opened', JSON.stringify(result)); assert.equal(result.created, true);
  assert.notEqual(result.sessionId, ID); assert.equal(f.renderer.w.pendingSessions.get(result.sessionId)?.session.name, 'Next task');
  assert.ok(f.events.findIndex(e => e[0] === 'name') < f.events.findIndex(e => e[0] === 'write'));
  assert.deepEqual(f.events.find(e => e[0] === 'name').slice(1), [result.sessionId, 'Next task']);
  assert.equal(f.renderer.calls.some(c => c[0] === 'focus'), false);
});

for (const variant of ['case', 'separator', 'parent', 'short-temp']) {
  test(`new trigger ${variant} project alias launches with the known spelling`, {
    skip: variant !== 'parent' && process.platform !== 'win32' ? 'Windows path alias'
      : variant === 'short-temp' && !os.tmpdir().includes('~') ? 'requires the brief short TEMP run' : false,
  }, async t => {
    const f = await fixture(t);
    const project = variant === 'case' ? f.dirs.project.toUpperCase()
      : variant === 'separator' ? f.dirs.project.replace(/\\/g, '/')
        : variant === 'parent' ? f.dirs.project + path.sep + '..' + path.sep + 'project'
          : path.join(os.tmpdir(), path.relative(fs.realpathSync.native(os.tmpdir()), f.dirs.project));
    assert.notEqual(project, f.dirs.project, 'the request must use a distinct spelling');
    const result = await f.publish({ version: 1, action: 'open', new: { project, name: 'Alias' }, prompt: 'hello', timeout_ms: 3000 });
    assert.equal(result.outcome, 'opened', JSON.stringify(result));
    assert.equal(f.events.find(e => e[0] === 'spawn')?.[2].cwd, f.dirs.project, 'spawn must use the known project spelling');
    assert.equal(f.sent.find(([channel]) => channel === 'trigger-session-action')?.[1].project, f.dirs.project);
    assert.equal(f.renderer.w.pendingSessions.get(result.sessionId)?.projectPath, f.dirs.project);
  });
}

test('file request joins an ordinary pending exact resume with one spawn and resumed false', async t => {
  const f = await fixture(t); let release;
  f.main.context.sessionTranscriptExists = () => true;
  f.main.context.sessionTransitions.snapshotContinuationsBeforeSpawn = () => new Promise(resolve => { release = resolve; });
  const clicked = f.renderer.f.openSession({ sessionId: ID, headSessionId: ID, projectPath: f.dirs.project, mergedMemberIds: [] }, null,
    { continuationResolved: true });
  await new Promise(resolve => setImmediate(resolve));
  const result = f.publish({ version: 1, action: 'open', sessionId: ID, timeout_ms: 3000 });
  const limit = Date.now() + 2000;
  while (!f.sent.some(([channel]) => channel === 'trigger-session-action') && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(typeof release, 'function'); release(null); await clicked;
  const done = await result;
  assert.equal(done.outcome, 'opened', JSON.stringify(done)); assert.equal(done.resumed, false);
  assert.equal(f.events.filter(e => e[0] === 'spawn').length, 1);
  assert.deepEqual(f.writes, []);
  assert.equal(f.renderer.calls.filter(c => c[0] === 'focus').length, 1, 'only the original manual click activates');
});
