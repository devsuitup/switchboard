// test/merge-placeholder-sessions.test.js — issue #278.
//
// mergePlaceholderSessions() (main.js) folds remote-index.js's synthesized
// descriptor-only sessions into the sidebar payload, before
// annotateRemoteAttachable() runs. Extracted from the real main.js source
// (same brace-matching technique test/annotate-remote-attachable-local-status.test.js
// uses) so this exercises the actual shipped logic.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function extractMergePlaceholderSessionsSource() {
  const src = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const start = src.indexOf('function toSidebarPlaceholderSession(ph)');
  assert.ok(start !== -1, 'main.js must define toSidebarPlaceholderSession');
  const marker2 = 'function mergePlaceholderSessions(projects)';
  const start2 = src.indexOf(marker2, start);
  assert.ok(start2 !== -1, 'main.js must define mergePlaceholderSessions');
  const bodyOpen = src.indexOf('{', start2);
  let depth = 0, end = -1;
  for (let i = bodyOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end !== -1, 'mergePlaceholderSessions body must be balanced');
  return src.slice(start, end + 1);
}

function makeMerge(remoteIndexer) {
  const source = extractMergePlaceholderSessionsSource();
  const factory = new Function(
    'remoteIndexer', 'joinFolderKey',
    source + '\nreturn mergePlaceholderSessions;'
  );
  return factory(remoteIndexer, (alias, folder) => `${alias}::${folder}`);
}

function fakePlaceholder(overrides = {}) {
  return {
    sessionId: 'ph-1',
    remoteAlias: 'vps',
    projectPath: '/srv/echanges/switchboard-test',
    folder: '-srv-echanges-switchboard-test',
    remoteDescriptorSeen: true,
    status: 'busy',
    statusUpdatedAt: 111,
    modified: 111,
    summary: 'switchboard-test',
    placeholder: true,
    ...overrides,
  };
}

test('adds the placeholder session to an already-existing project group', () => {
  const merge = makeMerge({ getAllPlaceholderSessions: () => [fakePlaceholder()] });
  const projects = [{
    folder: 'vps::-srv-echanges-switchboard-test',
    projectPath: '/srv/echanges/switchboard-test',
    remoteAlias: 'vps',
    sessions: [{ sessionId: 'other-real-session', remoteAlias: 'vps' }],
    missing: false,
  }];

  merge(projects);

  assert.equal(projects.length, 1, 'no new project group when one already exists');
  assert.equal(projects[0].sessions.length, 2);
  const ph = projects[0].sessions.find(s => s.sessionId === 'ph-1');
  assert.ok(ph, 'the placeholder session was appended');
  assert.equal(ph.placeholder, true);
  assert.equal(ph.remoteAlias, 'vps');
  assert.equal(ph.remoteDescriptorSeen, true);
  assert.equal(ph.status, 'busy');
  assert.equal(ph.statusUpdatedAt, 111);
  assert.equal(ph.summary, 'switchboard-test');
});

test('creates a new project group when no session for that host+cwd exists yet', () => {
  const merge = makeMerge({ getAllPlaceholderSessions: () => [fakePlaceholder()] });
  const projects = [];

  merge(projects);

  assert.equal(projects.length, 1, 'a brand-new project appears for the descriptor-only session');
  const project = projects[0];
  assert.equal(project.remoteAlias, 'vps');
  assert.equal(project.projectPath, '/srv/echanges/switchboard-test');
  assert.equal(project.folder, 'vps::-srv-echanges-switchboard-test');
  assert.equal(project.missing, false);
  assert.equal(project.sessions.length, 1);
  assert.equal(project.sessions[0].sessionId, 'ph-1');
});

// Acceptance (issue #278): "when the transcript appears, the row is the same
// row (no duplicate, no flicker)". Once buildProjectsFromCache() has already
// indexed the real session under the SAME id, the placeholder must not be
// appended a second time next to it.
test('does not duplicate when a real session with the same id already won the race', () => {
  const merge = makeMerge({ getAllPlaceholderSessions: () => [fakePlaceholder({ sessionId: 'now-real' })] });
  const projects = [{
    folder: 'vps::-srv-echanges-switchboard-test',
    projectPath: '/srv/echanges/switchboard-test',
    remoteAlias: 'vps',
    sessions: [{ sessionId: 'now-real', remoteAlias: 'vps', summary: 'the real transcript' }],
    missing: false,
  }];

  merge(projects);

  assert.equal(projects[0].sessions.length, 1, 'no duplicate row for the same sessionId');
  assert.equal(projects[0].sessions[0].summary, 'the real transcript', 'the real row is untouched');
});

test('no placeholders: the projects array is returned unchanged', () => {
  const merge = makeMerge({ getAllPlaceholderSessions: () => [] });
  const projects = [{ folder: 'local', projectPath: '/home/dev', sessions: [], missing: false }];

  const result = merge(projects);

  assert.equal(result, projects);
  assert.deepEqual(projects, [{ folder: 'local', projectPath: '/home/dev', sessions: [], missing: false }]);
});

test('two placeholders on two different hosts each get their own group', () => {
  const merge = makeMerge({
    getAllPlaceholderSessions: () => [
      fakePlaceholder({ sessionId: 'a', remoteAlias: 'vps', projectPath: '/srv/a', folder: '-srv-a' }),
      fakePlaceholder({ sessionId: 'b', remoteAlias: 'other', projectPath: '/srv/a', folder: '-srv-a' }),
    ],
  });
  const projects = [];

  merge(projects);

  assert.equal(projects.length, 2, 'same projectPath on two aliases stays two groups');
  assert.deepEqual(projects.map(p => p.remoteAlias).sort(), ['other', 'vps']);
});
