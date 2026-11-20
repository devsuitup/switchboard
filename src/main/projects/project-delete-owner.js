'use strict';
const path = require('node:path');
const { resolveWorktreePath } = require('../../../derive-project-path');
const { identity } = require('./project-delete-identity');

function groupedOwner(project, memo = new Map()) {
  const exact = identity(project, memo);
  if (exact.alias !== null) return exact;
  const key = JSON.stringify(['grouped-owner', project.projectPath]);
  if (!memo.has(key)) memo.set(key, identity({ ...project, projectPath: resolveWorktreePath(path.resolve(project.projectPath)) }, memo));
  return memo.get(key);
}

module.exports = { groupedOwner };
