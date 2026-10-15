'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const transitions = require('../session-transitions');
const cli = require('../cli-session-state');
const bg = require('../bg-agents');

const OLD = '11111111-1111-4111-8111-111111111111';
const HEAD = '22222222-2222-4222-8222-222222222222';

for (const proof of ['descriptor', 'job']) {
  test(`main wiring recognizes sanitized ${proof} proof and sends the background payload`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-main-bg-639-'));
    const projects = path.join(root, 'projects'), descriptors = path.join(root, 'sessions'), jobs = path.join(root, 'jobs');
    fs.mkdirSync(path.join(projects, 'project'), { recursive: true });
    fs.mkdirSync(descriptors);
    fs.mkdirSync(jobs);
    const continuationSnapshot = transitions.snapshotContinuations(path.join(projects, 'project', OLD + '.jsonl'), OLD);
    fs.writeFileSync(path.join(projects, 'project', OLD + '.jsonl'), JSON.stringify({ type: 'continued-in', sessionId: OLD, continuedInSessionId: HEAD }) + '\n');
    if (proof === 'descriptor') fs.writeFileSync(path.join(descriptors, '77.json'), JSON.stringify({ pid: 77, sessionId: HEAD, kind: 'bg', jobId: '1234abcd', cwd: root, status: 'idle' }));
    else {
      fs.mkdirSync(path.join(jobs, '1234abcd'));
      fs.writeFileSync(path.join(jobs, '1234abcd', 'state.json'), JSON.stringify({ sessionId: HEAD, state: 'working', name: 'launch (2)', nameSource: 'collision' }));
    }
    const entry = { projectFolder: 'project', knownJsonlFiles: new Set([OLD + '.jsonl']), pty: { pid: 7 },
      continuationSnapshot, backgroundCommandSource: OLD };
    const activeSessions = new Map([[OLD, entry]]);
    cli.init({ dir: descriptors, activeSessions, isProcessAlive: () => true, onIdle() {} });
    cli.ensureWatching();
    bg.init({ jobsDir: jobs, cliSessionState: cli, resolveProjectRoots: async () => null });
    bg.start();
    const events = [], metadata = [];
    const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
    const start = source.indexOf('sessionTransitions.init({');
    const end = source.indexOf('\n});', start) + '\n});'.length;
    vm.runInNewContext(source.slice(start, end), {
      PROJECTS_DIR: projects, activeSessions, sessionTransitions: transitions,
      mainWindow: { isDestroyed: () => false, webContents: { send: (...args) => events.push(args) } },
      log: { info() {}, debug() {} }, rekeyMcpServer() {},
      activityReporter: { rekey() {} }, taskRecords: { rekey() {}, hasRecord: () => false },
      cliSessionState: cli, bgAgents: bg, getCachedSession: () => ({ customTitle: 'original title' }),
      writer: { rekeySessionMeta: async (...args) => { metadata.push(args); } },
    });
    t.after(() => { transitions.init({ activeSessions: new Map() }); cli.stop(); bg.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    transitions.detectSessionTransitions('project');
    if (proof === 'descriptor') {
      assert.equal(activeSessions.get(OLD), entry);
      assert.equal(events.length, 0);
      assert.equal(metadata.length, 0);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Late background job was not re-keyed')), 5000);
        const unsubscribe = bg.onJobsChanged(async () => {
          transitions.detectPendingBackgroundContinuations();
          await transitions.drainMetadataWrites();
          if (!activeSessions.has(HEAD)) return;
          clearTimeout(timer);
          resolve();
        });
        t.after(() => { clearTimeout(timer); unsubscribe(); });
        fs.mkdirSync(path.join(jobs, '1234abcd'));
        fs.writeFileSync(path.join(jobs, '1234abcd', 'state.json'), JSON.stringify({ sessionId: HEAD, state: 'working' }));
      });
    }
    await transitions.drainMetadataWrites();
    assert.equal(activeSessions.get(HEAD), entry);
    assert.deepEqual(metadata, [[OLD, HEAD]]);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].slice(0, 4), ['session-forked', OLD, HEAD, 'background']);
    assert.equal(events[0][4].jobId, '1234abcd');
  });
}
