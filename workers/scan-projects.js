const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { getFolderIndexMtimeMs } = require('../folder-index-state');
const { deriveProjectPath } = require('../derive-project-path');
const { readSessionFile, enumerateSessionFiles, mergeBridgeGroups, subagentSessionId } = require('../read-session-file');

const PROJECTS_DIR = workerData.projectsDir;
// Non-empty only for a remote mirror root; `folder` is then <alias>::<folder>.
const FOLDER_PREFIX = workerData.folderPrefix ? workerData.folderPrefix + '::' : '';

function readFolderFromFilesystem(folder) {
  const folderPath = path.join(PROJECTS_DIR, folder);
  const projectPath = deriveProjectPath(folderPath, folder);
  if (!projectPath) return null;
  const key = FOLDER_PREFIX + folder;
  const sessions = [];
  const indexMtimeMs = getFolderIndexMtimeMs(folderPath);

  for (const { filePath, parentSessionId } of enumerateSessionFiles(folderPath)) {
    try {
      const s = readSessionFile(filePath, key, projectPath, { parentSessionId });
      if (s) sessions.push(s);
    } catch {}
  }

  // Merge compaction mirrors sharing a bridgeSessionId -- see mergeBridgeGroups.
  // existingRows=[] (fresh scan): every group member is re-derived from scratch.
  const reread = (sessionId, cutoff) => {
    try {
      return readSessionFile(path.join(folderPath, sessionId + '.jsonl'), key, projectPath, { dedupeSinceTimestamp: cutoff });
    } catch { return null; }
  };
  const { toUpsert } = mergeBridgeGroups([], sessions, reread);
  return { folder: key, projectPath, sessions: toUpsert, indexMtimeMs };
}

// rel is POSIX-separated (remote inventory, not the local fs) -- see
// .ai/contexts/session-cache.md ("Remote hosts file-level rescan").
function sessionIdFromRel(rel, parentSessionId) {
  const parts = String(rel).split('/');
  const filename = parts[parts.length - 1];
  if (!parentSessionId) return path.basename(filename, '.jsonl');
  const m = filename.match(/^agent-(.+)\.jsonl$/);
  return m ? subagentSessionId(parentSessionId, m[1]) : null;
}

// File-subset scan for the remote path -- see .ai/contexts/session-cache.md
// ("Remote hosts file-level rescan").
function readFolderFileSubsetFromFilesystem(folder, files, existingRows) {
  const folderPath = path.join(PROJECTS_DIR, folder);
  const projectPath = deriveProjectPath(folderPath, folder);
  if (!projectPath) return null;
  const key = FOLDER_PREFIX + folder;
  const indexMtimeMs = getFolderIndexMtimeMs(folderPath);

  const freshRows = [];
  const goneIds = [];
  for (const rel of files || []) {
    const parts = String(rel).split('/');
    let parentSessionId = null;
    if (parts.length === 3 && parts[1] === 'subagents') parentSessionId = parts[0];
    else if (parts.length === 2) parentSessionId = parts[0];
    const filePath = path.join(folderPath, ...parts);

    try {
      fs.statSync(filePath);
    } catch {
      const sessionId = sessionIdFromRel(rel, parentSessionId);
      if (sessionId) goneIds.push(sessionId);
      continue;
    }
    try {
      const s = readSessionFile(filePath, key, projectPath, { parentSessionId });
      if (s) freshRows.push(s);
    } catch {}
  }

  const reread = (sessionId, cutoff) => {
    try {
      return readSessionFile(path.join(folderPath, sessionId + '.jsonl'), key, projectPath, { dedupeSinceTimestamp: cutoff });
    } catch { return null; }
  };
  const { toUpsert, toDelete } = mergeBridgeGroups(existingRows || [], freshRows, reread);
  return { folder: key, projectPath, sessions: toUpsert, toDelete: [...goneIds, ...toDelete], indexMtimeMs, partial: true };
}

// Scan all folders, streaming one message per folder as soon as it's read
// instead of buffering every folder into one `results` array and posting a
// single message at the very end. A large ~/.claude/projects/ (1GB+,
// witnessed live) took many minutes to fully scan, during which the caller
// (session-cache.js) had nothing to write to the DB or push to the renderer
// \u2014 the sidebar showed a bare "Loading\u2026" the whole time. Streaming lets the
// caller write + notify after every folder instead.
try {
  // workerData.folders restricts the sweep to a subset; absent, walk the root.
  const folders = Array.isArray(workerData.folders)
    ? workerData.folders.filter(f => typeof f === 'string' && f && f !== '.git' && f !== '.' && f !== '..' && !/[\\/]/.test(f))
    : fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.git')
      .map(d => d.name);

  // see .ai/contexts/session-cache.md ("Remote hosts file-level rescan")
  const targets = Array.isArray(workerData.targets) ? workerData.targets : [];
  const total = folders.length + targets.length;
  let current = 0;

  for (let i = 0; i < folders.length; i++) {
    const result = readFolderFromFilesystem(folders[i]);
    current++;
    parentPort.postMessage({ type: 'folder', result, current, total });
  }
  for (const t of targets) {
    const result = readFolderFileSubsetFromFilesystem(t && t.folder, t && t.files, t && t.existingRows);
    current++;
    parentPort.postMessage({ type: 'folder', result, current, total });
  }
  parentPort.postMessage({ type: 'done', ok: true, total });
} catch (err) {
  parentPort.postMessage({ type: 'done', ok: false, error: err.message });
}
