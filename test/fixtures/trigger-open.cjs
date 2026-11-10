'use strict';

const { createTriggerActions } = require('../../src/main/triggers/trigger-actions');
const ID = '01234567-89ab-cdef-0123-456789abcdef';
const NEW = '11234567-89ab-cdef-0123-456789abcdef';
const STEM = '21234567-89ab-cdef-0123-456789abcdef';
const project = process.cwd();
function fixture({ now } = {}) {
  const events = [];
  const session = { pty: { pid: 1 }, generation: 7, cwd: project, projectPath: project };
  const entry = { session, ptyProcess: session.pty, cwd: project };
  const map = new Map([[ID, session]]);
  const ctx = {
    getPtyForSession: () => entry,
    pinDelivery: (_id, e) => ({ binding: { tab: e.session, deadline: Infinity, admit: async () => {}, readId: () => ID }, ctx: {}, handle: {} }),
    lifecycle: {
      activeSessions: map, launchAllowed: () => true,
      getProjectSnapshot: async () => ({ allProjects: [{ projectPath: project }], hiddenProjects: [], hiddenProjectKinds: {} }),
      liveElsewhere: async () => ({ known: true, live: null }), remoteTarget: async () => false,
      resolveTarget: async () => ({ ok: true, sessionId: ID, project, cwd: project, folder: 'folder', transcript: 'file' }),
      randomUUID: () => NEW,
      broker: { request: async (op, save) => {
        events.push(['renderer', op]); await save();
        if (op.mode !== 'reattach') { map.set(op.tabKey, session); ctx.getPtyForSession = () => entry; }
        return { ok: true, generation: 7, ...(op.mode === 'new' ? { created: true } : op.mode === 'resume' ? { resumed: true } : {}) };
      } },
      saveName: async (id, name) => { events.push(['name', id, name]); return { name }; },
    },
  };
  const execution = { ctx, deadline: Date.now() + 5000,
    acquireSessionLock: async id => { events.push(['fifo', id]); return () => events.push(['release-fifo']); },
    acquireTabLock: async tab => { events.push(['mutex', tab]); return () => events.push(['release-mutex']); },
    saveMarker: marker => events.push(['marker', marker]),
    publish: result => events.push(['result', result]),
    deliver: async () => { events.push(['deliver']); return { ok: true, submitted: 'assumed', wrote: true, text_written: true, enter_written: true }; },
  };
  const actions = createTriggerActions(now ? { now } : {});
  return { events, ctx, execution, session, map,
    open: extra => actions.execute({ version: 1, action: 'open', sessionId: ID, ...extra }, STEM, execution),
    new: extra => actions.execute({ version: 1, action: 'open', new: { project, name: '  Task  ' }, prompt: 'hello', ...extra }, STEM, execution) };
}
module.exports = { fixture, ID, NEW, STEM, project };
