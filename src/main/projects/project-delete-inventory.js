'use strict';

const fs = require('node:fs/promises');
const { createDiscoveryBounds, discoveryTimeout, closeDiscoveryHandle } = require('./project-delete-deadline');
const path = require('node:path');
const { parseFolderKey } = require('../remote/remote-hosts');
const { resolveJsonlPath, subagentSessionId } = require('../../../read-session-file');
const { classifyTranscriptPath } = require('../../../subagent-attribution');
const { durableRowLinks, fail } = require('./project-delete-identity');
const { encodeProjectPath } = require('../../../encode-project-path');
const { worktreeParentPath } = require('../../../public/worktree-nesting');
const { parseFrontmatter, isRunnerScheduleFileName, scheduleStateKey } = require('../schedules/schedule-runner');

function createProjectDeleteInventory(deps) {
  const io = deps.fs || fs, now = deps.now || Date.now;
  const cap = (value, fallback, ceiling) => Number.isFinite(value) ? Math.max(1, Math.min(value, ceiling)) : fallback;
  const maxItems = cap(deps.maxItems, 20000, 50000), maxBytes = cap(deps.maxBytes, 32 << 20, 64 << 20);
  const maxFileBytes = cap(deps.maxFileBytes, 8 << 20, 16 << 20);
  const contexts = new WeakMap(), bound = createDiscoveryBounds(deps);
  function context(budget) {
    let c = contexts.get(budget.signal);
    if (!c) {
      c = { deadline: Math.min(budget.deadline, now() + cap(deps.timeoutMs, 10000, 15000)), items: 0, bytes: 0,
        signal: budget.signal, pendingPorts: budget.pendingPorts ||= new Map(), startedAt: now(),
        limit: Math.min(budget.limit, maxItems), realpaths: new Map(), spellings: new Map(), checkedPaths: new Set(), snapshot: null };
      contexts.set(budget.signal, c);
    }
    c.check = () => { if (budget.signal.aborted || now() >= c.deadline) throw discoveryTimeout(c, now, { port: 'inventory', startedAt: c.startedAt, boundMs: c.deadline - c.startedAt }); };
    c.check();
    return c;
  }
  function charge(c, items = 0, bytes = 0) {
    c.check(); c.items += items; c.bytes += bytes;
    if (c.items > c.limit || c.bytes > maxBytes) throw fail('DISCOVERY_LIMIT', 'Inventory exceeds aggregate budget.');
  }
  const bounded = (c, port, fn, dispose, timeoutMs = cap(deps.portTimeoutMs, 15000, 15000)) =>
    bound(port, fn, c, dispose, timeoutMs);
  const processPort = (c, budget, port, read) => bounded(c, port,
    () => read({ ...budget, deadline: c.deadline, pendingPorts: c.pendingPorts }), undefined, c.deadline - now());
  const propagate = error => { if (['DISCOVERY_LIMIT', 'DISCOVERY_TIMEOUT', 'SNAPSHOT_STALE'].includes(error.code)) throw error; };
  async function readLivenessBatch(c, budget, rows, onError) {
    let next = 0, stopped = false;
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
      while (!stopped && next < rows.length) {
        const row = rows[next++];
        try {
          c.check();
          row.liveness = deps.readLiveness
            ? await processPort(c, budget, 'readLiveness', remaining => deps.readLiveness(row, remaining))
            : { state: 'unknown' };
        } catch (error) {
          try { propagate(error); if (onError) onError(row, error); else throw error; }
          catch (failure) { stopped = true; throw failure; }
        }
      }
    }));
  }
  async function real(c, file) {
    if (!c.realpaths.has(file)) c.realpaths.set(file, bounded(c, 'fs.realpath', () => io.realpath(file)));
    return c.realpaths.get(file);
  }
  const lexical = (file, alias = null) => alias === null
    ? (process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)).replaceAll('\\', '/')
    : path.posix.normalize(file).replace(/\/$/, '') || '/';
  function normalize(c, file, alias = null) {
    const value = lexical(file, alias);
    if (alias !== null) return value;
    let current = value;
    for (;;) {
      if (c.spellings.has(current)) return c.spellings.get(current) + value.slice(current.length);
      const parent = path.posix.dirname(current);
      if (parent === current) return value;
      current = parent;
    }
  }
  async function registerPath(c, file, deniedAncestor = false) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) return;
    let current = file;
    for (;;) {
      if (c.spellings.has(lexical(current))) return;
      try { c.spellings.set(lexical(current), lexical(await real(c, current))); return; }
      catch (error) { propagate(error); if (!['ENOENT', 'ENOTDIR'].includes(error.code) && !(deniedAncestor && ['EACCES', 'EPERM'].includes(error.code))) throw error; }
      const parent = path.dirname(current);
      if (parent === current) return;
      current = parent;
    }
  }
  async function unlinked(c, file) {
    let current = file;
    while (!c.checkedPaths.has(current)) {
      if ((await bounded(c, 'fs.lstat', () => io.lstat(current))).isSymbolicLink()) throw fail('DISCOVERY_CANDIDATE', 'Linked inventory path.');
      c.checkedPaths.add(current);
      if (c.spellings.has(lexical(current))) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  const owned = (c, row, project) => row.alias === project.alias && typeof row.projectPath === 'string'
    && normalize(c, row.projectPath, row.alias) === normalize(c, project.projectPath, project.alias);
  async function entries(c, directory, visit, missing = false) {
    let dir;
    try {
      await unlinked(c, directory);
      dir = await bounded(c, 'fs.opendir', () => io.opendir(directory), late => late.close());
      for (;;) {
        const entry = await bounded(c, 'fs.directory.read', () => dir.read());
        if (!entry) break;
        charge(c, 1);
        await visit(entry, path.join(directory, entry.name));
      }
    } catch (error) { if (!(missing && error.code === 'ENOENT')) throw error; }
    finally { await closeDiscoveryHandle('fs.directory.close', dir, c, deps); }
  }
  async function inspect(c, file, head = false) {
    const stat = await bounded(c, 'fs.lstat', () => io.lstat(file));
    if (!stat.isFile() || stat.isSymbolicLink()) throw fail('DISCOVERY_CANDIDATE', 'Linked or non-regular file.');
    await unlinked(c, file);
    if (!head && stat.size > maxFileBytes) throw fail('DISCOVERY_LIMIT', 'File exceeds inventory byte budget.');
    const handle = await bounded(c, 'fs.open', () => io.open(file, 'r'), late => late.close());
    try {
      const buffer = Buffer.alloc(head ? Math.min(stat.size, 16 << 10) : Math.min(stat.size + 1, maxFileBytes + 1));
      let size = 0;
      while (size < buffer.length) {
        const read = await bounded(c, 'fs.file.read', () => handle.read(buffer, size, buffer.length - size, null));
        if (!read.bytesRead) break;
        charge(c, 0, read.bytesRead);
        size += read.bytesRead;
      }
      const after = await bounded(c, 'fs.file.stat', () => handle.stat());
      if ((!head && size !== stat.size) || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino) throw fail('DISCOVERY_CANDIDATE', 'File changed during inspection.');
      const prefix = buffer.toString('utf8', 0, size);
      let content = prefix;
      if (head && size < stat.size) content = content.slice(0, content.lastIndexOf('\n') + 1);
      return { path: file, size: stat.size, mtimeMs: stat.mtimeMs, content, ...(head ? { prefix } : {}) };
    } finally { await closeDiscoveryHandle('fs.file.close', handle, c, deps); }
  }
  async function pages(c, section, revision) {
    const rows = [];
    let cursor = null;
    do {
      const ceiling = Math.min(8 << 20, Math.max(1, maxBytes - c.bytes));
      let page, pageBytes = Math.min(1048576, ceiling), limit = Math.min(256, Math.max(1, c.limit - c.items));
      for (;;) {
        try {
          page = await bounded(c, 'writer.readProjectDeletionSnapshot', () => deps.writer.readProjectDeletionSnapshot({ section, cursor,
            expectedRevision: revision, limit, maxBytes: pageBytes }));
          break;
        } catch (error) {
          if (section !== 'settings' || error.code !== 'DISCOVERY_LIMIT' || pageBytes >= ceiling) throw error;
          limit = 1; pageBytes = Math.min(ceiling, pageBytes * 2);
        }
      }
      if (page.revision !== revision) throw fail('SNAPSHOT_STALE', 'Inventory revision changed.');
      charge(c, page.rows.length, page.bytes);
      rows.push(...page.rows);
      if (page.nextCursor !== null && page.nextCursor === cursor) throw fail('SNAPSHOT_INCOMPLETE', 'Non-progressing inventory page.');
      cursor = page.nextCursor;
    } while (cursor !== null);
    return rows;
  }
  async function readSnapshot(budget) {
    const c = context(budget), attempts = Math.floor(cap(deps.snapshotAttempts, 3, 5));
    for (let attempt = 0; attempt < attempts; attempt++) {
      try { return await readSnapshotOnce(budget); }
      catch (error) {
        c.snapshot = null;
        if (error.code !== 'SNAPSHOT_STALE' || attempt + 1 === attempts) throw error;
        c.check();
      }
    }
  }
  async function readSnapshotOnce(budget) {
    const c = context(budget), revision = await bounded(c, 'writer.readProjectDeletionRevision', () => deps.writer.readProjectDeletionRevision());
    const snapshot = { complete: true, revision: String(revision), projects: [], declaredHosts: [] };
    for (const section of ['sessions', 'folders', 'metadata', 'fields', 'settings', 'fences']) snapshot[section] = await pages(c, section, revision);
    const settings = Object.fromEntries(snapshot.settings.map(row => {
      let value;
      try { value = JSON.parse(row.value); } catch { value = row.value; }
      return [row.key, value];
    }));
    snapshot.initialScanComplete = settings.initial_scan_complete === true;
    snapshot.declaredHosts = (settings.remoteHosts || []).map(row => row.alias);
    for (const row of [...snapshot.folders, ...snapshot.sessions]) if (parseFolderKey(row.folder).alias === null) await registerPath(c, row.projectPath);
    for (const root of [deps.projectsDir, deps.dataDir, ...(settings.scheduleProjects || [])]) await registerPath(c, root);
    const projects = new Map();
    function add(alias, projectPath, folder) {
      if (typeof projectPath !== 'string') return;
      const key = JSON.stringify([alias, normalize(c, projectPath, alias)]);
      const row = projects.get(key) || { alias, projectPath, folderKeys: [], cacheFolderKeys: [] };
      if (folder && !row.folderKeys.includes(folder)) { row.folderKeys.push(folder); row.cacheFolderKeys.push(folder); }
      projects.set(key, row);
    }
    for (const row of [...snapshot.folders, ...snapshot.sessions]) add(parseFolderKey(row.folder).alias, row.projectPath, row.folder);
    for (const root of settings.scheduleProjects || []) add(null, root);
    for (const entry of Object.keys(settings.archivedProjects || {})) {
      const { alias, folder } = parseFolderKey(entry); add(alias, folder);
    }
    for (const entry of settings.global?.hiddenProjects || []) {
      const { alias, folder } = parseFolderKey(entry); add(alias, folder);
    }
    snapshot.projects = [...projects.values()];
    snapshot.savedWorkingSet = settings.global?.openWorkingSet || [];
    if (await bounded(c, 'writer.readProjectDeletionRevision', () => deps.writer.readProjectDeletionRevision()) !== revision) throw fail('SNAPSHOT_STALE', 'Writer changed during snapshot.');
    c.snapshot = snapshot;
    return snapshot;
  }
  async function discoverOwnership(project, budget) {
    const c = context(budget), snapshot = budget.snapshot || c.snapshot;
    if (!snapshot) throw fail('SNAPSHOT_INCOMPLETE', 'Read a snapshot before discovery.');
    const groups = [], members = [], candidates = [], knownFiles = new Map();
    const candidate = (file, reason) => { charge(c, 1); candidates.push({ path: file, reason }); };
    if (project.alias !== null) {
      if (!deps.readRemoteOwnership) return { complete: true, groups, members, candidates: [{ path: project.projectPath, reason: 'Remote host discovery unavailable.' }] };
      const remote = await processPort(c, budget, 'readRemoteOwnership', remaining => deps.readRemoteOwnership(project, remaining));
      charge(c, (remote.groups?.length || 0) + (remote.members?.length || 0) + (remote.candidates?.length || 0));
      charge(c, 0, Buffer.byteLength(JSON.stringify(remote)));
      return remote;
    }
    const belongs = async (cwd, subagent = false) => {
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return false;
      await registerPath(c, cwd);
      const normalized = normalize(c, cwd), selected = normalize(c, project.projectPath);
      const parent = normalized.match(/^(.+?)\/\.(?:claude\/worktrees|claude-worktrees|worktrees|work-files\/worktrees)\/[^/]+\/?$/)?.[1];
      return normalized === selected || parent === selected || (subagent && normalized.startsWith(selected + '/'));
    };
    const ownFolders = new Set(snapshot.folders.filter(row => owned(c, { alias: null, projectPath: row.projectPath }, project)
      && parseFolderKey(row.folder).alias === null).map(row => row.folder));
    for (const row of snapshot.sessions) if (parseFolderKey(row.folder).alias === null
      && owned(c, { alias: null, projectPath: row.projectPath }, project)) ownFolders.add(row.folder);
    const folderCase = value => process.platform === 'win32' ? value?.toLowerCase() : value;
    const encodedFolders = new Set([project.projectPath, ...snapshot.projects.filter(row => owned(c, row, project)).map(row => row.projectPath)]
      .map(value => folderCase(encodeProjectPath(value))));
    const folderBelongs = folder => ownFolders.has(folder) || encodedFolders.has(folderCase(folder));
    const local = snapshot.sessions.filter(row => parseFolderKey(row.folder).alias === null), folderOwners = new Map();
    for (const row of local) {
      c.check();
      if ((typeof row.projectPath !== 'string' || !path.isAbsolute(row.projectPath)) && folderBelongs(row.folder)) candidate(row.sessionId, 'Cached row has no absolute project ownership.');
      const owners = folderOwners.get(row.folder) || new Set();
      owners.add(row.projectPath ? normalize(c, row.projectPath) : null);
      folderOwners.set(row.folder, owners);
      const file = row.runtime === 'codex' ? row.sessionFile : resolveJsonlPath(deps.projectsDir, row);
      if (file && path.isAbsolute(file) && typeof row.projectPath === 'string' && path.isAbsolute(row.projectPath)) knownFiles.set(normalize(c, file), row);
    }
    const groupMap = new Map(), localById = new Map(local.map(row => [row.sessionId, row]));
    for (const row of local) {
      const owner = { alias: null, projectPath: row.projectPath };
      const child = worktreeParentPath(row.projectPath?.replaceAll('\\', '/'))
        || row.projectPath?.replaceAll('\\', '/').match(/^(.+)\/\.work-files\/worktrees\/[^/]+\/?$/)?.[1];
      if (!owned(c, owner, project) && (!child || normalize(c, child) !== normalize(c, project.projectPath))) continue;
      const runtime = row.runtime || 'claude';
      const previous = groupMap.get(row.folder);
      const group = { ...owner, folderKey: row.folder, runtime, ...(child ? { parentProjectPath: child } : {}), verified: !previous || previous.runtime === runtime };
      if (folderOwners.get(row.folder).size !== 1 || folderOwners.get(row.folder).has(null)) {
        group.verified = false;
        candidate(row.folder, 'Mixed folder ownership must be resolved.');
      }
      groupMap.set(row.folder, group);
      if (!owned(c, owner, project)) continue;
      const file = runtime === 'codex' ? row.sessionFile : resolveJsonlPath(deps.projectsDir, row);
      const member = { ...owner, id: row.sessionId, folderKey: row.folder, runtime, cwd: row.projectPath,
        conversationId: row.mergedIntoSessionId || row.parentSessionId || row.sessionId, partId: row.sessionId,
        parentSessionId: row.parentSessionId || null, subagentId: row.agentId || null, sessionFile: file,
        indexed: true, verified: true, present: false, liveness: { state: 'unknown' } };
      members.push(member);
      if (!file || !path.isAbsolute(file)) { candidate(row.sessionId, 'Missing transcript mapping.'); continue; }
      knownFiles.set(normalize(c, file), row);
      try {
        const inspected = await inspect(c, file, true);
        let cwd, identified = false;
        const layout = runtime === 'claude' ? classifyTranscriptPath(path.relative(path.join(deps.projectsDir, row.folder), file)) : null;
        const subagent = !!row.parentSessionId && layout?.parentSessionId === row.parentSessionId && layout?.agentId === row.agentId;
        const validIds = new Set([row.sessionId, row.bridgeSessionId, row.parentSessionId].filter(Boolean));
        if (runtime === 'claude') {
          identified = !row.parentSessionId && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(row.sessionId)
            && path.basename(file, '.jsonl') === row.sessionId;
          const agent = inspected.prefix.match(/"agentId"\s*:\s*("(?:[^"\\\r\n]|\\.)*")/);
          if (subagent && agent) {
            charge(c, 1);
            if (JSON.parse(agent[1]) !== row.agentId) throw new Error('Transcript agent identity contradicts its indexed mapping.');
            identified = true;
          }
          const match = inspected.prefix.match(/"sessionId"\s*:\s*"([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})"/i);
          if (match) {
            charge(c, 1);
            if (!validIds.has(match[1])) throw new Error('Transcript identity contradicts its indexed mapping.');
            identified = true;
          }
        }
        for (const line of inspected.content.split('\n')) {
          if (!line.trim()) continue;
          charge(c, 1);
          const record = JSON.parse(line);
          const recordedId = runtime === 'codex' ? (record.type === 'session_meta' ? record.payload?.id : null) : record.sessionId;
          if (recordedId) {
            if (!validIds.has(recordedId)) throw new Error('Transcript identity contradicts its indexed mapping.');
            identified = true;
          }
          const recordedCwd = runtime === 'codex' ? record.payload?.cwd : record.cwd;
          if (!cwd && recordedCwd) cwd = recordedCwd;
          if (cwd && identified) break;
        }
        if (!identified) throw new Error('Transcript identity is unavailable.');
        if (!cwd && runtime === 'claude') {
          const rawCwd = inspected.prefix.match(/"cwd"\s*:\s*("(?:[^"\\\r\n]|\\.)*")/);
          if (rawCwd) { charge(c, 1); cwd = JSON.parse(rawCwd[1]); }
          else if (!/"cwd"\s*:/.test(inspected.prefix) && encodeProjectPath(path.resolve(row.projectPath)) === row.folder) cwd = row.projectPath;
        }
        const parentRow = subagent ? localById.get(row.parentSessionId) : null;
        const parentOwned = parentRow?.folder === row.folder && owned(c, { alias: null, projectPath: parentRow.projectPath }, project);
        if (!parentOwned && !await belongs(cwd, subagent)) throw new Error('Transcript ownership unavailable or changed.');
        member.present = true; member.size = inspected.size; member.mtimeMs = inspected.mtimeMs;
      } catch (error) { propagate(error); candidate(file, error.message); }
    }
    await readLivenessBatch(c, budget, members.filter(member => member.present), (member, error) => candidate(member.sessionFile, error.message));
    groups.push(...groupMap.values());
    const ids = new Set(members.map(row => row.id));
    const durableIds = new Set(snapshot.sessions.flatMap(row => [row.sessionId, ...durableRowLinks(row)]));
    const orphanIds = new Set([...snapshot.metadata, ...snapshot.fields].map(row => row.sessionId).filter(id => !durableIds.has(id)));
    const attributableOrphans = new Set();
    for (const row of local.filter(row => owned(c, { alias: null, projectPath: row.projectPath }, project))) {
      for (const id of durableRowLinks(row)) if (!ids.has(id)) candidate(id, 'Durable continuation ownership has no indexed transcript.');
    }
    for (const folder of snapshot.folders.filter(row => owned(c, { alias: null, projectPath: row.projectPath }, project) && parseFolderKey(row.folder).alias === null)) {
      if (!groupMap.has(folder.folder)) groups.push({ alias: null, projectPath: folder.projectPath, folderKey: folder.folder, runtime: 'claude', verified: true });
    }
    async function scan(directory, folder, depth = 0) {
      if (depth > 8) {
        if (folderBelongs(folder)) throw fail('DISCOVERY_LIMIT', 'Transcript layout exceeds depth budget.');
        return;
      }
      await entries(c, directory, async (entry, file) => {
        if (folderBelongs(folder) && !entry.isDirectory() && entry.name.endsWith('.jsonl')) {
          const layout = classifyTranscriptPath(path.relative(path.join(deps.projectsDir, folder), file));
          const id = layout?.parentSessionId && layout.agentId ? subagentSessionId(layout.parentSessionId, layout.agentId)
            : layout ? path.basename(file, '.jsonl') : null;
          if (orphanIds.has(id)) attributableOrphans.add(id);
        }
        if (entry.isSymbolicLink()) { if (folderBelongs(folder)) candidate(file, 'Linked transcript candidate.'); return; }
        if (entry.isDirectory()) { await scan(file, folder, depth + 1); return; }
        if (!entry.name.endsWith('.jsonl') || knownFiles.has(normalize(c, file))) return;
        let cwd;
        try {
          const inspected = await inspect(c, file, true);
          for (const line of inspected.content.split('\n')) {
            if (!line.trim()) continue;
            let record;
            try { record = JSON.parse(line); } catch { continue; }
            cwd = record.cwd || (record.type === 'session_meta' ? record.payload?.cwd : null);
            if (cwd) break;
          }
        } catch (error) { propagate(error); if (folderBelongs(folder)) candidate(file, error.message); return; }
        try {
          if (folderBelongs(folder) || await belongs(cwd)) candidate(file, 'Unindexed or unmappable transcript candidate.');
        } catch (error) {
          propagate(error);
          if (['EACCES', 'EPERM'].includes(error.code) && typeof cwd === 'string' && path.isAbsolute(cwd)) {
            await registerPath(c, path.dirname(cwd), true);
          }
          const selected = normalize(c, project.projectPath), value = typeof cwd === 'string' && path.isAbsolute(cwd) ? normalize(c, cwd) : null;
          if (value && (value === selected || value.startsWith(selected + '/'))) candidate(file, error.message);
        }
      });
    }
    try {
      await entries(c, deps.projectsDir, async (entry, file) => {
        if (entry.isSymbolicLink()) { if (folderBelongs(entry.name)) candidate(file, 'Linked transcript candidate.'); return; }
        if (!entry.isDirectory()) return;
        const knownOwners = snapshot.folders.filter(row => row.folder === entry.name && row.projectPath);
        if (knownOwners.length && !folderBelongs(entry.name)) return;
        try { await scan(file, entry.name); }
        catch (error) { propagate(error); if (folderBelongs(entry.name)) candidate(file, error.message); }
      });
    } catch (error) { propagate(error); candidate(deps.projectsDir, error.message); }
    for (const id of attributableOrphans) candidate(id, 'Historical metadata has no durable ownership.');
    if (budget.options?.settings && !groups.some(row => owned(c, row, project))) candidate(project.projectPath, 'Settings ownership is unavailable for this empty registered project.');
    return { complete: true, groups, members, candidates };
  }
  async function discoverSchedules(project, budget) {
    const c = context(budget), schedules = [], candidates = [];
    if (project.alias !== null) {
      if (!deps.readRemoteSchedules) return { complete: true, schedules, candidates: [{ path: project.projectPath, reason: 'Remote schedule discovery unavailable.' }] };
      const remote = await processPort(c, budget, 'readRemoteSchedules', remaining => deps.readRemoteSchedules(project, remaining));
      charge(c, (remote.schedules?.length || 0) + (remote.candidates?.length || 0) + (remote.retained?.length || 0));
      charge(c, 0, Buffer.byteLength(JSON.stringify(remote)));
      return remote;
    }
    const originalPath = c.snapshot?.projects.find(row => owned(c, row, project))?.projectPath || project.projectPath;
    const directory = path.join(originalPath, '.claude', 'commands');
    try {
      await entries(c, directory, async (entry, file) => {
        if (!isRunnerScheduleFileName(entry.name)) return;
        const row = { ...project, id: file, path: file, readable: false, verified: true, linked: entry.isSymbolicLink(), problems: [] };
        schedules.push(row);
        try {
          const inspected = await inspect(c, file), { meta, body } = parseFrontmatter(inspected.content);
          Object.assign(row, { readable: true, enabled: meta.enabled !== 'false', name: meta.name || entry.name,
            slug: meta.slug || entry.name, stateKey: scheduleStateKey({ filePath: file }), size: inspected.size, mtimeMs: inspected.mtimeMs });
          if (!meta.cron || !body) row.problems.push('Missing cron or prompt.');
        } catch (error) { propagate(error); candidates.push({ path: file, reason: error.message }); }
      }, true);
    } catch (error) { propagate(error); candidates.push({ path: directory, reason: error.message }); }
    const retained = [];
    for (const name of ['schedule-state', 'schedule-runs']) if (deps.dataDir) {
      try {
        await entries(c, path.join(deps.dataDir, name), async (entry, file) => {
          if (!schedules.some(row => row.stateKey && entry.name.startsWith(row.stateKey))) return;
          try { const item = await inspect(c, file); retained.push({ path: file, record: JSON.parse(item.content) }); }
          catch (error) { propagate(error); candidates.push({ path: file, reason: error.message }); }
        }, true);
      } catch (error) { propagate(error); candidates.push({ path: name, reason: error.message }); }
    }
    return { complete: true, schedules, candidates, retained };
  }
  async function readRuntimeState(project, budget) {
    const c = context(budget), candidates = [], tabs = new Map(), jobs = [];
    const snapshot = c.snapshot;
    if (!snapshot) throw fail('SNAPSHOT_INCOMPLETE', 'Read a snapshot before runtime discovery.');
    const active = typeof deps.activeSessions === 'function' ? deps.activeSessions() : deps.activeSessions;
    if (!(active instanceof Map)) throw fail('SNAPSHOT_INCOMPLETE', 'Authoritative active sessions unavailable.');
    if (active.size + snapshot.savedWorkingSet.length > c.limit - c.items) throw fail('DISCOVERY_LIMIT', 'Runtime inventory exceeds entry budget.');
    const byId = new Map(snapshot.sessions.map(row => [row.sessionId, row]));
    for (const row of [...snapshot.savedWorkingSet, ...Array.from(active, ([id, value]) => ({ ...value, id }))]) {
      charge(c, 1);
      const id = row.id || row.sessionId, durable = byId.get(id);
      const record = { id, sessionId: row.sessionId || id,
        alias: row.remoteAlias || row.alias || (durable ? parseFolderKey(durable.folder).alias : null),
        projectPath: row.projectPath || row.cwd || durable?.projectPath,
        runtime: row.runtime || (row.type === 'terminal' ? 'terminal' : durable?.runtime || 'claude'),
        generation: row.generation ?? null, pid: row.pty?.pid ?? row.pid ?? null, startedAt: row.startedAt ?? null,
        conversationId: row.conversationId || durable?.mergedIntoSessionId || durable?.parentSessionId || id,
        jobId: row.jobId || row.attachJobId || null, scheduleId: row.scheduleId || null,
        background: row.background === true || row.bg === true };
      if (!record.projectPath) { candidates.push({ id: record.id, reason: 'Saved or active tab ownership unavailable.' }); continue; }
      if (!owned(c, record, project)) continue;
      if (row.fresh && !durable) candidates.push({ id, reason: 'Pending restore lacks acknowledged durable identity.' });
      record.verified = true;
      tabs.set(record.id, record);
    }
    await readLivenessBatch(c, budget, [...tabs.values()]);
    if (!deps.readJobs || !deps.getScheduleRunSnapshot) throw fail('SNAPSHOT_INCOMPLETE', 'Authoritative jobs and scheduler evidence are required.');
    const [roster, runs] = await Promise.all([
      processPort(c, budget, 'readJobs', remaining => deps.readJobs(project, remaining)),
      bounded(c, 'getScheduleRunSnapshot', () => deps.getScheduleRunSnapshot()),
    ]);
    if (roster.complete !== true || !Array.isArray(roster.jobs)) throw fail('SNAPSHOT_INCOMPLETE', 'Background job discovery incomplete.');
    charge(c, roster.jobs.length + (roster.candidates?.length || 0));
    charge(c, 0, Buffer.byteLength(JSON.stringify(roster)));
    jobs.push(...roster.jobs);
    candidates.push(...(roster.candidates || []));
    charge(c, runs.length);
    charge(c, 0, Buffer.byteLength(JSON.stringify(runs)));
    for (const run of runs) {
      const row = { ...run, alias: null, projectPath: run.cwd, id: run.sessionId, scheduleId: run.scheduleName,
        runtime: 'claude', verified: true, liveness: { state: 'running', source: 'external', pid: run.pid, startedAt: run.startedAt } };
      if (owned(c, row, project)) jobs.push(row);
    }
    return { complete: true, tabs: [...tabs.values()], jobs, candidates };
  }
  return {
    waitForIndex: async budget => { const c = context(budget); if (deps.waitForIndex) await bounded(c, 'waitForIndex', () => deps.waitForIndex(budget)); },
    readSnapshot, discoverOwnership, discoverSchedules, readRuntimeState,
    readRevision: async budget => String(await bounded(context(budget), 'writer.readProjectDeletionRevision', () => deps.writer.readProjectDeletionRevision())),
    inspectRetainedFiles: async (files, budget) => {
      const c = context(budget), result = [];
      for (const file of files) { charge(c, 1); await registerPath(c, path.dirname(file)); const row = await inspect(c, file); delete row.content; result.push(row); }
      return result;
    },
  };
}

module.exports = { createProjectDeleteInventory };
