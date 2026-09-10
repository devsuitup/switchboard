// test/annotate-remote-attachable-local-status.test.js — issue #245.
//
// annotateRemoteAttachable() (main.js) attaches the shared status/statusUpdatedAt
// pair to every session: from the remote host's mirrored descriptor when the
// session carries a remoteAlias, and from the local ~/.claude/sessions/<pid>.json
// descriptor (via cliSessionState.getStatus) otherwise. This test extracts the
// REAL function body from main.js's source (same brace-matching technique
// test/get-projects-cold-start-reconcile.test.js uses) so it exercises the
// actual shipped logic, not a hand-copied re-implementation that could drift.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function extractAnnotateRemoteAttachableSource() {
  const src = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const marker = 'function annotateRemoteAttachable(projects)';
  const start = src.indexOf(marker);
  assert.ok(start !== -1, 'main.js must define annotateRemoteAttachable');
  const bodyOpen = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = bodyOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end !== -1, 'annotateRemoteAttachable body must be balanced');
  return src.slice(start, end + 1);
}

function makeAnnotate(mocks) {
  const source = extractAnnotateRemoteAttachableSource();
  const factory = new Function(
    'remoteIndexer', 'remoteAttachAdapter', 'remoteActivityTracker', 'cliSessionState',
    source + '\nreturn annotateRemoteAttachable;'
  );
  return factory(
    mocks.remoteIndexer || { getRemoteSessions: () => ({ sessions: [], at: null, error: null }) },
    mocks.remoteAttachAdapter || { supports: () => false },
    mocks.remoteActivityTracker || { activeAt: () => null },
    mocks.cliSessionState || { getStatus: () => undefined }
  );
}

test('a local session (no remoteAlias) whose sessionId matches a local descriptor gets status/statusUpdatedAt attached', () => {
  const annotateRemoteAttachable = makeAnnotate({
    cliSessionState: {
      getStatus: (sessionId) => (sessionId === 'local-1' ? { status: 'idle', statusUpdatedAt: 12345 } : undefined),
    },
  });

  const projects = [{
    projectPath: '/home/dev/proj',
    sessions: [{ sessionId: 'local-1' }],
  }];

  annotateRemoteAttachable(projects);

  assert.equal(projects[0].sessions[0].status, 'idle');
  assert.equal(projects[0].sessions[0].statusUpdatedAt, 12345);
});

test('a local session with no matching local descriptor leaves status/statusUpdatedAt undefined', () => {
  const annotateRemoteAttachable = makeAnnotate({
    cliSessionState: { getStatus: () => undefined },
  });

  const projects = [{
    projectPath: '/home/dev/proj',
    sessions: [{ sessionId: 'no-descriptor' }],
  }];

  annotateRemoteAttachable(projects);

  assert.equal(projects[0].sessions[0].status, undefined);
  assert.equal(projects[0].sessions[0].statusUpdatedAt, undefined);
});

test('a remote session still gets status/statusUpdatedAt from the remote descriptor, not from cliSessionState', () => {
  const annotateRemoteAttachable = makeAnnotate({
    remoteIndexer: {
      getRemoteSessions: (alias) => ({
        sessions: alias === 'planificator'
          ? [{ sessionId: 'remote-1', status: 'busy', statusUpdatedAt: 999 }]
          : [],
        at: 111,
        error: null,
      }),
    },
    remoteAttachAdapter: { supports: () => true },
    cliSessionState: { getStatus: () => { throw new Error('must not be called for a remote session'); } },
  });

  const projects = [{
    projectPath: '/srv/proj',
    remoteAlias: 'planificator',
    sessions: [{ sessionId: 'remote-1', remoteAlias: 'planificator' }],
  }];

  annotateRemoteAttachable(projects);

  assert.equal(projects[0].sessions[0].status, 'busy');
  assert.equal(projects[0].sessions[0].statusUpdatedAt, 999);
  assert.equal(projects[0].sessions[0].remoteAttachable, true);
});
