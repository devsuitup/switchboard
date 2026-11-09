'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeProjectPath } = require('../encode-project-path');

test('Agent Files and its FTS supply schedules for the renderer setting', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-schedules-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldHome = process.env.HOME;
  const oldProfile = process.env.USERPROFILE;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  t.after(() => { process.env.HOME = oldHome; process.env.USERPROFILE = oldProfile; });
  const { listMemories } = require('../file-lists');
  const project = path.join(root, 'project');
  const claudeDir = path.join(root, '.claude');
  const projectsDir = path.join(claudeDir, 'projects');
  const folder = path.join(projectsDir, encodeProjectPath(project));
  const commands = path.join(project, '.claude', 'commands');
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(commands, { recursive: true });
  fs.writeFileSync(path.join(folder, 'seed.jsonl'), JSON.stringify({ type: 'user', cwd: project }));
  for (const name of ['schedule-a.md', 'deploy.md', 'Schedule-B.md']) fs.writeFileSync(path.join(commands, name), name);
  fs.writeFileSync(path.join(project, '.claude', 'schedule-root.md'), 'keep');
  fs.writeFileSync(path.join(claudeDir, 'schedule-global.md'), 'keep');
  const result = listMemories({ claudeDir, projectsDir, activeProjectPaths: [project] }, p => fs.readFileSync(p, 'utf8'));
  for (const files of [result.files, result.view.projects.flatMap(p => p.files)]) {
    assert.equal(files.some(f => f.filename === 'schedule-a.md'), true, 'schedule files remain available to the renderer');
    for (const name of ['deploy.md', 'Schedule-B.md', 'schedule-root.md']) assert.ok(files.some(f => f.filename === name), name);
  }
  assert.ok(result.view.global.files.some(f => f.filename === 'schedule-global.md'));
});
