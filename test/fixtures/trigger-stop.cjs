'use strict';

const { createTriggerActions } = require('../../src/main/triggers/trigger-actions');
const { createTriggerContext } = require('../../src/main/triggers/trigger-context');
const { deliverSingle } = require('../../src/main/triggers/trigger-watcher');
const { createComposerState, noteUserInput } = require('../../src/main/terminals/composer-state');
const ID = '01234567-89ab-cdef-0123-456789abcdef';
const STEM = '21234567-89ab-cdef-0123-456789abcdef';

function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const env = { SWITCHBOARD_TRIGGER_QUIET_MS: '50', SWITCHBOARD_BUSY_FALL_SETTLE_MS: '10',
    SWITCHBOARD_SUBMIT_VERIFY_MS: '40', SWITCHBOARD_BUSY_RISE_WAIT_MS: '50', SWITCHBOARD_SUBMIT_ENTER_DELAY_MS: '1',
    SWITCHBOARD_TRANSCRIPT_QUIET_MS: '10' };
  const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const events = [], writes = [], markers = [];
  const session = { pty: { pid: process.pid, write(text) {
    writes.push(text);
    if (text === '\r') { setStatus('busy'); session._cliBusy = true; options.onEnter?.(); }
  } }, generation: 7, cwd: process.cwd(), projectPath: process.cwd(), composerState: createComposerState() };
  const map = new Map([[ID, session]]);
  let status = { status: 'idle', statusUpdatedAt: Date.now() - 100 };
  let allowed = true, identity = 'writer-1', proven = true;
  function setStatus(value, stamp = Date.now()) { status = value == null ? null : { status: value, statusUpdatedAt: stamp }; }
  const lifecycle = { activeSessions: map, launchAllowed: () => allowed,
    broker: { waitForReady: async () => ({ ok: true, validate: () => ({ ok: true }) }),
      request: () => { throw new Error('stop must not request renderer work'); } },
    remoteTarget: async () => false, liveElsewhere: async () => ({ known: true, live: null }),
    getCachedSession: () => null, getCachedFolder: () => null,
    stop: (target, key) => {
      events.push(['stop', target, key]);
      const { stopLocalSession } = require('../../src/main/terminals/stop-session');
      return stopLocalSession(target, key, () => { events.push(['kill']); options.onKill?.(session); return true; });
    },
  };
  const observe = () => ({ writer: proven && status ? { ...status, sessionId: ID } : null, uncertain: !proven, identity });
  const ctx = createTriggerContext({ activeSessions: map, lifecycle, isPtyAlive: () => !session.exited,
    log: { info() {}, warn() {}, error() {} }, getCliStatus: () => status,
    cliSessionState: { deliveryPtyStart: () => 'pty-start', observeTabWriter: observe, observeTabWriterV1: observe,
      findDeliveryTab: () => ({}), refreshProcessTable: async () => {} } });
  const execution = { ctx, deadline: Date.now() + (options.timeout ?? 600),
    acquireSessionLock: async () => { events.push(['fifo']); return () => events.push(['release-fifo']); },
    acquireTabLock: async () => { events.push(['mutex']); return () => events.push(['release-mutex']); },
    saveMarker: marker => { markers.push(marker); },
    publish: result => { events.push(['result', result]); },
    deliver: async ({ pinned, deadline, ...args }) => {
      await pinned.binding.admit(deadline);
      return deliverSingle({ ...args, ctx: pinned.ctx, delivery: pinned.binding, handle: pinned.handle, deliveryDeadline: deadline, v1: true });
    },
  };
  const actions = createTriggerActions();
  const flush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
  const tick = async ms => { t.mock.timers.tick(ms); await flush(); };
  let result, done = false;
  const start = (extra = {}) => {
    const promise = actions.execute({ version: 1, action: 'stop', sessionId: ID, ...extra }, STEM, execution);
    Promise.resolve(promise).then(value => { result = value; done = true; });
    return promise;
  };
  const finish = async () => {
    await flush();
    for (let i = 0; !done && i < 1000; i++) await tick(1);
    return result;
  };
  return { session, map, ctx, lifecycle, execution, writes, events, markers, start, flush, tick, finish, setStatus,
    result: () => result, done: () => done, kills: () => events.filter(e => e[0] === 'kill').length,
    input: text => noteUserInput(session.composerState, text, Date.now()),
    close: () => { allowed = false; }, writer: value => { identity = value; }, proof: value => { proven = value; } };
}

module.exports = { fixture, ID, STEM };
