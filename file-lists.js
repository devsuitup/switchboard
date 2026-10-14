'use strict';

// see .ai/contexts/viewer-panel.md (File list workers)
const fs = require('node:fs');
const path = require('node:path');
const { deriveProjectPath } = require('./derive-project-path');
const { isAllowedMemoryPath: _isAllowedMemoryPath } = require('./ipc-path-validator');
const { scanMdFiles: scanMarkdown, acceptMdFile: acceptMarkdown } = require('./scan-md-files');

function getKnownProjectPaths(options) {
  const roots = new Set(options.activeProjectPaths || []);
  try {
    if (fs.existsSync(options.projectsDir)) {
      for (const dir of fs.readdirSync(options.projectsDir, { withFileTypes: true })) {
        if (!dir.isDirectory() || dir.name === '.git') continue;
        const project = deriveProjectPath(path.join(options.projectsDir, dir.name), dir.name);
        if (project) roots.add(project);
      }
    }
  } catch {}
  return [...roots];
}

function folderToShortPath(folder) {
  const parts = folder.replace(/^-/, '').split('-');
  const meaningful = parts.filter(Boolean);
  return meaningful.slice(-2).join('/');
}


const WORK_FILES_CAP = 200;

function walkWorkFiles(dir, baseDir, results) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const fullPath = path.join(dir, e.name);
    if (e.isDirectory()) {
      walkWorkFiles(fullPath, baseDir, results);
    } else if (e.isFile()) {
      try {
        const stat = fs.statSync(fullPath);
        const relativePath = path.relative(baseDir, fullPath);
        results.push({
          filename: e.name,
          filePath: fullPath,
          relativePath,
          modified: stat.mtime.toISOString(),
          size: stat.size,
        });
      } catch {}
    }
  }
}


function listMemories(options, readContent) {
  const CLAUDE_DIR = options.claudeDir;
  const PROJECTS_DIR = options.projectsDir;
  const scanMdFiles = (dir, allowed) => scanMarkdown(dir, allowed, readContent);
  const acceptMdFile = (file, allowed) => acceptMarkdown(file, allowed, readContent);
  const global = { hiddenProjects: options.hiddenProjects };
  const hiddenProjects = new Set(global.hiddenProjects || []);

  const knownRoots = getKnownProjectPaths(options);
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

  return { view: result, files: [...globalFiles.map(f => ({ ...f, title: 'Global ' + f.filename })), ...projects.flatMap(project => project.files.map(f => ({ ...f, title: project.shortName + ' ' + f.filename })))], bodies };
}

function listWorkFiles(options) {
  const PROJECTS_DIR = options.projectsDir;

  const global = { hiddenProjects: options.hiddenProjects };
  const hiddenProjects = new Set(global.hiddenProjects || []);
  const seen = new Set();
  const projects = [];

  try {
    if (fs.existsSync(PROJECTS_DIR)) {
      const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== '.git')
        .map(d => d.name);

      for (const folder of folders) {
        const folderPath = path.join(PROJECTS_DIR, folder);
        const projectPath = deriveProjectPath(folderPath, folder);
        if (!projectPath) continue;
        if (hiddenProjects.has(projectPath)) continue;
        if (seen.has(projectPath)) continue;
        seen.add(projectPath);

        const workFilesDir = path.join(projectPath, '.work-files');
        if (!fs.existsSync(workFilesDir)) continue;

        const shortName = projectPath.split('/').filter(Boolean).slice(-2).join('/');

        const allFiles = [];
        walkWorkFiles(workFilesDir, workFilesDir, allFiles);

        allFiles.sort((a, b) => new Date(b.modified) - new Date(a.modified));

        const totalCount = allFiles.length;
        const files = allFiles.slice(0, WORK_FILES_CAP);

        if (files.length > 0) {
          projects.push({ projectPath, shortName, files, totalCount });
        }
      }
    }
  } catch (err) {
    console.error('Error scanning work-files:', err);
  }

  projects.sort((a, b) => {
    const aMax = a.files.length > 0 ? new Date(a.files[0].modified).getTime() : 0;
    const bMax = b.files.length > 0 ? new Date(b.files[0].modified).getTime() : 0;
    return bMax - aMax;
  });

  return { view: { projects }, files: projects.flatMap(project => project.files.map(f => ({ ...f, title: project.shortName + ' ' + f.relativePath }))) };
}

module.exports = { listMemories, listWorkFiles };
