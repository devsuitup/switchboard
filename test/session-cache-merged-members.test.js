'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cache = require('../session-cache');

test('the sidebar payload includes merged bridge member ids without changing its representative or counts', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-merged-members-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = { projectPath: dir, folder: 'project', created: '2026-10-10T10:00:00Z', modified: '2026-10-10T10:00:00Z', messageCount: 1 };
  const rows = [
    { ...base, sessionId: 'A', bridgeSessionId: 'cse_1' },
    { ...base, sessionId: 'B', bridgeSessionId: 'cse_1', mergedIntoSessionId: 'A' },
    { ...base, sessionId: 'C', bridgeSessionId: 'cse_1', mergedIntoSessionId: 'A' },
    { ...base, sessionId: 'independent', bridgeSessionId: 'cse_1' },
  ];
  cache.init({ PROJECTS_DIR: dir, activeSessions: new Map(), getMainWindow: () => null, log: console, db: {
    getAllCached: () => rows, getAllMeta: () => new Map(), getAllFolderMeta: () => new Map(), getSetting: () => ({}),
  } });
  const project = JSON.parse(JSON.stringify(cache.buildProjectsFromCache(false))).find(p => p.projectPath === dir);
  const representative = project.sessions.find(s => s.sessionId === 'A');
  assert.deepEqual(representative.mergedMemberIds, ['B', 'C']);
  assert.equal(representative.messageCount, 3);
  assert.deepEqual(project.sessions.map(s => s.sessionId).sort(), ['A', 'independent']);
  assert.deepEqual(project.sessions.find(s => s.sessionId === 'independent').mergedMemberIds, []);
});

test('merged member ids are newest-first regardless of database row order, with a stable id tie-break', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-merged-order-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = { projectPath: dir, folder: 'project', messageCount: 1 };
  const rows = [
    { ...base, sessionId: 'A', modified: '2026-10-10T09:00:00Z' },
    { ...base, sessionId: 'B', mergedIntoSessionId: 'A', modified: '2026-10-10T10:00:00Z' },
    { ...base, sessionId: 'D', mergedIntoSessionId: 'A', modified: '2026-10-10T12:00:00Z' },
    { ...base, sessionId: 'C', mergedIntoSessionId: 'A', modified: '2026-10-10T12:00:00Z' },
    { ...base, sessionId: 'E', mergedIntoSessionId: 'A', modified: null },
  ];
  cache.init({ PROJECTS_DIR: dir, activeSessions: new Map(), getMainWindow: () => null, log: console, db: {
    getAllCached: () => rows, getAllMeta: () => new Map(), getAllFolderMeta: () => new Map(), getSetting: () => ({}),
  } });
  const session = cache.buildProjectsFromCache(false).flatMap(p => p.sessions).find(s => s.sessionId === 'A');
  assert.deepEqual(session.mergedMemberIds, ['C', 'D', 'B', 'E']);
});
