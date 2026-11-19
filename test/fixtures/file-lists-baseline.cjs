'use strict';
function folderToShortPath(folder) {
  const parts = folder.replace(/^-/, '').split('-');
  const meaningful = parts.filter(Boolean);
  return meaningful.slice(-2).join('/');
}

ipcMain.handle('get-memories', () => {
  const global = getSetting('global') || {};
  const hiddenProjects = new Set(global.hiddenProjects || []);

  const knownRoots = [...getKnownProjectPaths()];
  const isAllowed = (filePath) => _isAllowedMemoryPath(filePath, knownRoots);

  const bodies = new Map();
  const listed = ({ content, ...entry }) => {
    bodies.set(entry.filePath, content);
    return entry;
  };

  const globalFiles = scanMdFiles(CLAUDE_DIR, isAllowed).map(f => ({ ...listed(f), displayPath: '~/.claude' }));

  const projects = [];
  try {
    if (fs.existsSync(PROJECTS_DIR)) {
      const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== '.git')
        .map(d => d.name);

      for (const folder of folders) {
        const folderPath = path.join(PROJECTS_DIR, folder);
        const projectPath = deriveProjectPath(folderPath, folder);
        if (projectPath && hiddenProjects.has(projectPath)) continue;

        const shortName = projectPath
          ? projectPath.split(/[\\/]/).filter(Boolean).slice(-2).join('/')
          : folderToShortPath(folder);
        const files = [];
        const seenPaths = new Set();

        const claudeHomeFiles = scanMdFiles(folderPath, isAllowed);
        for (const f of claudeHomeFiles) {
          files.push({ ...listed(f), displayPath: '~/.claude', source: 'claude-home' });
          seenPaths.add(f.filePath);
        }
        const memoryDir = path.join(folderPath, 'memory');
        const memoryFiles = scanMdFiles(memoryDir, isAllowed);
        for (const f of memoryFiles) {
          files.push({ ...listed(f), displayPath: '~/.claude', source: 'claude-home' });
          seenPaths.add(f.filePath);
        }

        if (projectPath) {
          for (const name of ['CLAUDE.md', 'GEMINI.md', 'agents.md']) {
            const fp = path.join(projectPath, name);
            const accepted = acceptMdFile(fp, isAllowed);
            if (accepted && !seenPaths.has(fp)) {
              files.push({ ...listed(accepted), displayPath: shortName + '/', source: 'project' });
              seenPaths.add(fp);
            }
          }

          const dotClaudeDir = path.join(projectPath, '.claude');
          const dotClaudeFiles = scanMdFiles(dotClaudeDir, isAllowed);
          for (const f of dotClaudeFiles) {
            if (!seenPaths.has(f.filePath)) {
              files.push({ ...listed(f), displayPath: shortName + '/.claude/', source: 'project' });
              seenPaths.add(f.filePath);
            }
          }
          const commandsDir = path.join(dotClaudeDir, 'commands');
          const commandFiles = scanMdFiles(commandsDir, isAllowed);
          for (const f of commandFiles) {
            if (!seenPaths.has(f.filePath)) {
              files.push({ ...listed(f), displayPath: shortName + '/.claude/commands/', source: 'project' });
              seenPaths.add(f.filePath);
            }
          }
        }

        if (files.length > 0) {
          projects.push({ folder, projectPath: projectPath || '', shortName, files });
        }
      }
    }
  } catch (err) {
    console.error('Error scanning memories:', err);
  }

  projects.sort((a, b) => {
    const aMax = Math.max(...a.files.map(f => new Date(f.modified).getTime()));
    const bMax = Math.max(...b.files.map(f => new Date(f.modified).getTime()));
    return bMax - aMax;
  });

  const result = { global: { files: globalFiles }, projects };

  try {
    const allFiles = [
      ...globalFiles.map(f => ({ ...f, label: 'Global' })),
      ...projects.flatMap(p => p.files.map(f => ({ ...f, label: p.shortName }))),
    ];
    const sig = computeIndexSignature(allFiles.map(f => ({
      filePath: f.filePath,
      mtimeMs: new Date(f.modified).getTime(),
      size: 0,
    })));
    if (shouldReindex('memory', sig)) {
      deleteSearchType('memory');
      upsertSearchEntries(allFiles.map(f => ({
        id: f.filePath, type: 'memory', folder: null,
        title: f.label + ' ' + f.filename,
        body: bodies.get(f.filePath) ?? '',
      })));
    }
  } catch {}

  return result;
});
