'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cli = require('../../cli-session-state');
const { createV1Reader } = require('../../src/main/cli/session-state-v1');
const { createTriggerContext } = require('../../src/main/triggers/trigger-context');

const ID = '01234567-89ab-cdef-0123-456789abcdef';
const B = '11234567-89ab-cdef-0123-456789abcdef';

function createWorld(t, { historical = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-sandbox-world-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'descriptors'), procRoot = path.join(root, 'proc'), projectsDir = path.join(root, 'projects');
  fs.mkdirSync(dir); fs.mkdirSync(procRoot); fs.mkdirSync(path.join(projectsDir, 'folder'), { recursive: true });
  let clock = Date.now();
  const deadline = clock + 10000;
  function put(pid, parent, start, ns, inner = pid) {
    const p = path.join(procRoot, String(pid));
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'status'), `NSpid:\t${pid}\t${inner}\n`);
    fs.writeFileSync(path.join(p, 'stat'), `${pid} (claude) ${['S', parent, ...Array(17).fill('0'), start].join(' ')}`);
    fs.mkdirSync(path.join(p, 'ns'), { recursive: true });
    try { fs.unlinkSync(path.join(p, 'ns/pid')); } catch {}
    fs.symlinkSync(ns, path.join(p, 'ns/pid'));
  }
  put(100, 1, '10', 'pid:[1]');
  put(200, 100, '20', 'pid:[2]', 2);
  let start = '30';
  function writer(next) {
    start = next;
    put(300, 200, start, 'pid:[2]', 3);
    fs.writeFileSync(path.join(dir, '3.json'), JSON.stringify({ pid: 3, sessionId: historical ? B : ID,
      kind: 'interactive', status: 'idle', statusUpdatedAt: clock - 500, procStart: start }));
  }
  writer(start);
  const translate = file => String(file).replace(/^\/proc(?=\/|$)/, procRoot);
  const procFs = { readdirSync: p => fs.readdirSync(translate(p)),
    readFileSync: (p, ...args) => fs.readFileSync(translate(p), ...args), readlinkSync: p => fs.readlinkSync(translate(p)) };
  const descriptorFs = { ...fs };
  const reader = createV1Reader({ dir, platform: 'linux', now: () => clock, procFs, descriptorFs,
    parseDescriptor: cli.parseDescriptor, parseState: cli.parseState, readCliProcess: () => false, scheduledRuns: new Map() });
  const writes = [], observations = [];
  const session = { generation: 7, sandbox: true, pty: { pid: 100, write: data => writes.push({ data, start }) },
    cwd: root, projectPath: root, projectFolder: 'folder', composerState: { pending: 0, lastInputAt: 0 } };
  const map = new Map([[historical ? B : ID, session]]);
  const source = { deliveryPtyStart: () => '10', observeTabWriter: () => ({ uncertain: true }),
    observeTabWriterV1: args => {
      const result = reader.observeTabWriterV1(args);
      observations.push({ deadline: args.deadline, identity: result.identity });
      return result;
    },
    findDeliveryTab: () => ({}), refreshProcessTable: async () => {} };
  const lifecycle = { activeSessions: map, launchAllowed: () => true,
    broker: { waitForReady: async () => ({ ok: true, validate: () => ({ ok: true }) }) } };
  const ctx = createTriggerContext({ activeSessions: map, cliSessionState: source, isPtyAlive: () => true,
    projectsDir, resolveSessionId: id => historical && id === ID ? B : id, lifecycle });
  if (historical) {
    fs.writeFileSync(path.join(projectsDir, 'folder', ID + '.jsonl'), JSON.stringify({ type: 'continued-in', sessionId: ID, continuedInSessionId: B }) + '\n');
    fs.writeFileSync(path.join(projectsDir, 'folder', B + '.jsonl'), '\n');
  }
  const pin = () => ctx.pinDelivery(ID, ctx.getPtyForSession(ID), false, { v1: true, deadline });
  return { root, dir, reader, procFs, descriptorFs, ctx, pin, session, map, lifecycle, source, writer, writes, observations,
    deadline, clock: () => clock, expire: () => { clock = deadline + 1; } };
}

module.exports = { createWorld, ID, B };
