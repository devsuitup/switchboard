'use strict';

// Issue #709: main tags each refusal of a trace delete and a project remap
// with a code, so the renderer can say what to do for that refusal.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { loadAppFunctions } = require('./app-source');

const MAIN = path.join(__dirname, '..', 'main.js');

function traceDelete({ current = '/traces/now.jsonl', unlink = () => {} } = {}) {
  const context = vm.createContext({
    resolveTraceFile: filePath => (filePath.startsWith('/traces/') ? filePath : null),
    activityTrace: { currentFile: () => current },
    fs: { unlinkSync: unlink },
  });
  return loadAppFunctions(context, { functions: ['deleteActivityTraceFile'], sourcePath: MAIN }).deleteActivityTraceFile;
}

test('GIVEN debug mode writing a trace WHEN it is deleted THEN main refuses with the recording code', () => {
  const remove = traceDelete();
  assert.deepEqual({ ...remove('/traces/now.jsonl') }, { ok: false, code: 'recording', error: 'the trace is writing to this file — turn debug mode off first' });
});

test('GIVEN a path outside the trace folder WHEN it is deleted THEN main refuses with the not-trace code', () => {
  const remove = traceDelete();
  assert.equal(remove('/elsewhere/x.jsonl').code, 'not-trace');
});

test('GIVEN an unlink error WHEN a trace is deleted THEN main passes the filesystem code on', () => {
  const remove = traceDelete({ unlink: () => { throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }); } });
  assert.deepEqual({ ...remove('/traces/old.jsonl') }, { ok: false, code: 'EBUSY', error: 'EBUSY: resource busy' });
  assert.deepEqual({ ...traceDelete()('/traces/old.jsonl') }, { ok: true });
});

function remap({ exists = [], stat = { '/new': true }, active = [], rewrite = async () => {} } = {}) {
  const calls = { notified: [] };
  const context = vm.createContext({
    fs: {
      existsSync: p => exists.includes(p),
      lstatSync: p => {
        if (!(p in stat)) throw new Error('ENOENT');
        return { isDirectory: () => stat[p] };
      },
    },
    path,
    PROJECTS_DIR: '/projects',
    encodeProjectPath: p => p.replace(/\//g, '-'),
    activeSessions: new Map(active.map((projectPath, i) => [String(i), { projectPath, exited: false }])),
    isPanelShellSession: () => false,
    writer: { remapProjectTranscripts: rewrite, refreshFolder: async () => {} },
    notifyRendererProjectsChanged: reason => calls.notified.push(reason),
  });
  const { remapMissingProject } = loadAppFunctions(context, { functions: ['remapProjectRefusal', 'remapMissingProject'], sourcePath: MAIN });
  return { remapMissingProject, calls };
}

test('GIVEN each remap refusal WHEN main answers THEN the answer carries its own code', async () => {
  const folder = path.join('/projects', '-old');
  const cases = [
    [remap(), [1, '/new'], 'invalid-arguments'],
    [remap({ exists: ['/old'] }), ['/old', '/new'], 'path-back'],
    [remap(), ['/old', '/absent'], 'target-missing'],
    [remap({ stat: { '/file': false } }), ['/old', '/file'], 'target-not-directory'],
    [remap(), ['/old', '/new'], 'no-session-data'],
    [remap({ exists: [folder], active: ['/old'] }), ['/old', '/new'], 'active-sessions'],
    [remap({ exists: [folder], rewrite: async () => { throw new Error('EBUSY: transcript locked'); } }), ['/old', '/new'], 'failed'],
  ];
  for (const [ctx, args, code] of cases) {
    const result = await ctx.remapMissingProject(...args);
    assert.equal(result.code, code, code);
    assert.equal(typeof result.error, 'string', code + ' keeps its reason');
  }
  const ok = remap({ exists: [folder] });
  assert.deepEqual({ ...await ok.remapMissingProject('/old', '/new') }, { ok: true });
  assert.deepEqual(ok.calls.notified, ['project-remap']);
});
