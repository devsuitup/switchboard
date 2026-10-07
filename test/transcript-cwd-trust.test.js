const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { encodeProjectPath, verifiedTranscriptCwd } = require('../encode-project-path');
const { deriveProjectPath, resolveSessionRealCwd, storedProjectPathMatchesFolder } = require('../derive-project-path');
const sessionCache = require('../session-cache');

function mkTmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-tct-')));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeTranscript(projectsDir, folder, sessionId, cwd) {
  const dir = path.join(projectsDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sessionId + '.jsonl'),
    JSON.stringify({ type: 'user', cwd, sessionId, message: { role: 'user', content: 'hi' } }) + '\n');
}

function project(tmp, ...parts) {
  const dir = path.join(tmp, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('verifiedTranscriptCwd: returns the resolved cwd when it encodes back to the folder', () => {
  const tmp = mkTmp();
  try {
    const p = project(tmp, 'proj');
    assert.equal(verifiedTranscriptCwd(p, encodeProjectPath(p)), p);
  } finally { cleanup(tmp); }
});

test('verifiedTranscriptCwd: a cwd below the folder project, a relative cwd and a non-string are refused', () => {
  const tmp = mkTmp();
  try {
    const p = project(tmp, 'proj');
    const folder = encodeProjectPath(p);
    assert.equal(verifiedTranscriptCwd(path.join(p, 'evil'), folder), null);
    assert.equal(verifiedTranscriptCwd('proj', folder), null);
    assert.equal(verifiedTranscriptCwd('rel-dir', encodeProjectPath(path.resolve('rel-dir'))), null);
    assert.equal(verifiedTranscriptCwd(null, folder), null);
    assert.equal(verifiedTranscriptCwd(42, folder), null);
  } finally { cleanup(tmp); }
});

test('verifiedTranscriptCwd: a cwd with .. segments that resolves to the folder project verifies', () => {
  const tmp = mkTmp();
  try {
    const p = project(tmp, 'proj');
    project(tmp, 'proj', 'sub');
    const dotted = path.join(p, 'sub', '..') + path.sep + 'sub' + path.sep + '..';
    assert.equal(verifiedTranscriptCwd(dotted, encodeProjectPath(p)), p);
  } finally { cleanup(tmp); }
});

test('deriveProjectPath: a forged transcript cwd below the project is skipped for the genuine one', () => {
  const tmp = mkTmp();
  try {
    const p = project(tmp, 'proj');
    const evil = project(tmp, 'proj', 'evil');
    const projectsDir = project(tmp, 'projects');
    const folder = encodeProjectPath(p);
    writeTranscript(projectsDir, folder, 'a-forged', evil);
    writeTranscript(projectsDir, folder, 'b-genuine', p);
    assert.equal(deriveProjectPath(path.join(projectsDir, folder), folder), p);
  } finally { cleanup(tmp); }
});

test('deriveProjectPath: with only a forged transcript the result is null, never the forged cwd', () => {
  const tmp = mkTmp();
  try {
    const p = project(tmp, 'proj');
    const evil = project(tmp, 'proj', 'evil');
    const projectsDir = project(tmp, 'projects');
    const folder = encodeProjectPath(p);
    writeTranscript(projectsDir, folder, 'a-forged', evil);
    assert.equal(deriveProjectPath(path.join(projectsDir, folder), folder), null);
  } finally { cleanup(tmp); }
});

test('deriveProjectPath: a forged subagent transcript in a session subfolder is refused too', () => {
  const tmp = mkTmp();
  try {
    const p = project(tmp, 'proj');
    const evil = project(tmp, 'proj', 'evil');
    const projectsDir = project(tmp, 'projects');
    const folder = encodeProjectPath(p);
    writeTranscript(projectsDir, path.join(folder, 'sess-1', 'subagents'), 'agent-x', evil);
    assert.equal(deriveProjectPath(path.join(projectsDir, folder), folder), null);
  } finally { cleanup(tmp); }
});

test('deriveProjectPath: a worktree folder still collapses to its repository', () => {
  const tmp = mkTmp();
  try {
    const repo = project(tmp, 'repo');
    const wt = project(tmp, 'repo', '.claude', 'worktrees', 'agent-1');
    const projectsDir = project(tmp, 'projects');
    const folder = encodeProjectPath(wt);
    writeTranscript(projectsDir, folder, 'w', wt);
    assert.equal(deriveProjectPath(path.join(projectsDir, folder), folder), repo);
  } finally { cleanup(tmp); }
});

test('deriveProjectPath: a remote folder keeps its recorded cwd, which is not a local path', () => {
  const tmp = mkTmp();
  try {
    const projectsDir = project(tmp, 'projects');
    const folder = '-home-remote-proj';
    writeTranscript(projectsDir, folder, 'r', '/home/remote/proj');
    assert.equal(deriveProjectPath(path.join(projectsDir, folder), folder, { remote: true }), '/home/remote/proj');
  } finally { cleanup(tmp); }
});

test('resolveSessionRealCwd: a forged cwd is not returned, a worktree cwd is', () => {
  const tmp = mkTmp();
  try {
    const p = project(tmp, 'proj');
    const evil = project(tmp, 'proj', 'evil');
    const wt = project(tmp, 'proj', '.claude', 'worktrees', 'w1');
    const projectsDir = project(tmp, 'projects');
    writeTranscript(projectsDir, encodeProjectPath(p), 'forged', evil);
    writeTranscript(projectsDir, encodeProjectPath(wt), 'wtsess', wt);
    assert.equal(resolveSessionRealCwd(projectsDir, 'forged', encodeProjectPath(p)), null);
    assert.equal(resolveSessionRealCwd(projectsDir, 'wtsess', encodeProjectPath(p)), wt);
  } finally { cleanup(tmp); }
});

test('resolveSessionRealCwd: a forged copy of a session id does not shadow the genuine transcript', () => {
  const tmp = mkTmp();
  try {
    const p = project(tmp, 'proj');
    const evil = project(tmp, 'proj', 'evil');
    const wt = project(tmp, 'proj', '.claude', 'worktrees', 'w1');
    const projectsDir = project(tmp, 'projects');
    writeTranscript(projectsDir, encodeProjectPath(p), 'same-id', evil);
    writeTranscript(projectsDir, encodeProjectPath(wt), 'same-id', wt);
    assert.equal(resolveSessionRealCwd(projectsDir, 'same-id', encodeProjectPath(p)), wt);
  } finally { cleanup(tmp); }
});

test('chain A: a schedule created from the sidebar project of a forged folder never targets the forged directory', () => {
  const tmp = mkTmp();
  try {
    const p = project(tmp, 'proj');
    const evil = project(tmp, 'proj', 'evil');
    const projectsDir = project(tmp, 'projects');
    const folder = encodeProjectPath(p);
    writeTranscript(projectsDir, folder, 'forged', evil);
    const sidebarProject = deriveProjectPath(path.join(projectsDir, folder), folder);
    assert.notEqual(sidebarProject, evil);
    assert.equal(sidebarProject, null);
  } finally { cleanup(tmp); }
});

test('chain B: resuming a forged session spawns in the project, and a new session on the sidebar project registers the project, not the forged directory', () => {
  const tmp = mkTmp();
  try {
    const p = project(tmp, 'proj');
    const evil = project(tmp, 'proj', 'evil');
    const projectsDir = project(tmp, 'projects');
    const folder = encodeProjectPath(p);
    writeTranscript(projectsDir, folder, 'forged', evil);
    writeTranscript(projectsDir, folder, 'genuine', p);
    const sidebarProject = deriveProjectPath(path.join(projectsDir, folder), folder);
    assert.equal(sidebarProject, p);
    assert.equal(resolveSessionRealCwd(projectsDir, 'forged', folder), null);
    assert.equal(encodeProjectPath(sidebarProject), folder);
  } finally { cleanup(tmp); }
});

test('first launch of a normal project: open-terminal registers the requested project without any folder precondition', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /^\s*if \(projectPath\) scheduleProjects\(\)\.add\(projectPath\);\s*$/m);
});

test('storedProjectPathMatchesFolder: accepts the folder project and its worktree collapse, refuses a path below it', () => {
  const tmp = mkTmp();
  try {
    const p = project(tmp, 'proj');
    const evil = project(tmp, 'proj', 'evil');
    const wt = project(tmp, 'proj', '.claude', 'worktrees', 'w1');
    assert.equal(storedProjectPathMatchesFolder(p, encodeProjectPath(p)), true);
    assert.equal(storedProjectPathMatchesFolder(p, encodeProjectPath(wt)), true);
    assert.equal(storedProjectPathMatchesFolder(evil, encodeProjectPath(p)), false);
    assert.equal(storedProjectPathMatchesFolder(p, encodeProjectPath(evil)), false);
  } finally { cleanup(tmp); }
});

test('refreshFolder: a forged projectPath already stored in cache_meta is replaced by the verified one', () => {
  const tmp = mkTmp();
  try {
    const p = project(tmp, 'proj');
    const evil = project(tmp, 'proj', 'evil');
    const projectsDir = project(tmp, 'projects');
    const folder = encodeProjectPath(p);
    writeTranscript(projectsDir, folder, 'genuine', p);
    const metaWrites = [];
    sessionCache.init({
      PROJECTS_DIR: projectsDir,
      activeSessions: new Map(),
      getMainWindow: () => null,
      log: console,
      db: {
        deleteCachedFolder: () => {}, getCachedByFolder: () => [], upsertCachedSessions: () => {},
        touchCachedModified: () => {}, deleteCachedSession: () => {}, replaceSessionMetrics: () => {},
        deleteSearchFolder: () => {}, deleteSearchSession: () => {}, upsertSearchEntries: () => {},
        getFolderMeta: () => ({ folder, projectPath: evil, indexMtimeMs: 0 }),
        setFolderMeta: (f, projectPath) => metaWrites.push(projectPath),
        getAllFolderMeta: () => new Map(), getAllMeta: () => new Map(), getAllCached: () => [],
        getSetting: () => ({}), getMeta: () => null, setName: () => {},
      },
    });
    sessionCache.refreshFolder(folder);
    assert.ok(metaWrites.length > 0, 'cache_meta is rewritten');
    assert.ok(metaWrites.every(w => w === p), 'only the verified project path is stored: ' + JSON.stringify(metaWrites));
  } finally { cleanup(tmp); }
});
