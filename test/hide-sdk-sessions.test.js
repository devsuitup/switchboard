// Sessions started through the Agent SDK (entrypoint sdk-cli / sdk-py / sdk-ts)
// are hidden from the project list unless the hideSdkSessions setting is off.
// see .ai/contexts/session-cache.md ("SDK-launched sessions")

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readSessionFile } = require('../read-session-file');
const sessionCache = require('../session-cache');
const { encodeProjectPath } = require('../encode-project-path');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-sdk-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function write(dir, sessionId, entries) {
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return filePath;
}

function user(text, extra = {}) {
  return { type: 'user', timestamp: '2026-10-07T11:42:12.808Z', message: { role: 'user', content: text }, ...extra };
}

function assistant(extra = {}) {
  return { type: 'assistant', timestamp: '2026-10-07T11:42:20.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, ...extra };
}

test('readSessionFile records the entrypoint of the first user turn', () => {
  const tmp = mkTmp();
  try {
    const sdk = write(tmp, 'sdk', [
      { type: 'queue-operation', operation: 'enqueue', content: 'Review this change' },
      user('Review this change', { entrypoint: 'sdk-py', promptSource: 'sdk' }),
      assistant({ entrypoint: 'sdk-py' }),
    ]);
    assert.equal(readSessionFile(sdk, 'f', '/p').entrypoint, 'sdk-py');

    const interactive = write(tmp, 'cli', [user('hello', { entrypoint: 'cli' }), assistant({ entrypoint: 'cli' })]);
    assert.equal(readSessionFile(interactive, 'f', '/p').entrypoint, 'cli');
  } finally {
    cleanup(tmp);
  }
});

test('a scheduled run keeps no entrypoint: its first user turn is pre-seeded by Switchboard', () => {
  const tmp = mkTmp();
  try {
    const scheduled = write(tmp, 'sched', [
      user('Scheduled Task: summarize'),
      user('continue', { entrypoint: 'sdk-cli' }),
      assistant({ entrypoint: 'sdk-cli' }),
    ]);
    assert.equal(readSessionFile(scheduled, 'f', '/p').entrypoint, null);
  } finally {
    cleanup(tmp);
  }
});

function makeFakeDb({ cachedRows, global }) {
  return {
    getAllMeta: () => new Map(),
    getAllCached: () => cachedRows,
    getSetting: (key) => (key === 'global' ? global : {}),
  };
}

function row(sessionId, folder, projectPath, entrypoint) {
  return {
    sessionId, folder, projectPath, summary: sessionId, firstPrompt: sessionId,
    modified: '2026-10-07T10:00:00.000Z', created: '2026-10-07T10:00:00.000Z',
    messageCount: 1, parentSessionId: null, agentId: null, subagentType: null,
    description: null, slug: null, aiTitle: null, entrypoint,
  };
}

function visibleIds(global) {
  const projectsDir = mkTmp();
  try {
    const projectPath = '/srv/runner';
    const folder = encodeProjectPath(projectPath);
    const cachedRows = [
      row('interactive', folder, projectPath, 'cli'),
      row('scheduled', folder, projectPath, null),
      row('sdk-cli-run', folder, projectPath, 'sdk-cli'),
      row('sdk-py-run', folder, projectPath, 'sdk-py'),
      row('sdk-ts-run', folder, projectPath, 'sdk-ts'),
    ];
    sessionCache.init({
      PROJECTS_DIR: projectsDir,
      activeSessions: new Map(),
      getMainWindow: () => null,
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
      db: makeFakeDb({ cachedRows, global }),
    });
    sessionCache.setRemoteRoots(new Map());
    return sessionCache.buildProjectsFromCache(true)
      .flatMap(p => p.sessions.map(s => s.sessionId))
      .sort();
  } finally {
    cleanup(projectsDir);
  }
}

test('SDK-launched sessions are hidden by default', () => {
  assert.deepEqual(visibleIds({}), ['interactive', 'scheduled']);
});

test('turning hideSdkSessions off shows them again', () => {
  assert.deepEqual(visibleIds({ hideSdkSessions: false }),
    ['interactive', 'scheduled', 'sdk-cli-run', 'sdk-py-run', 'sdk-ts-run']);
});
