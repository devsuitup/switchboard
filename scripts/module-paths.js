'use strict';

const fs = require('node:fs');
const path = require('node:path');
const espree = require('espree');

function walk(root, directory, accept = (file) => file.endsWith('.js')) {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return walk(root, file, accept);
    return entry.isFile() && accept(file) ? [file] : [];
  }).sort();
}

function appFiles(root) {
  return [
    ...fs.readdirSync(root).filter((f) => f.endsWith('.js')),
    ...walk(root, 'workers'), ...walk(root, 'src'), ...walk(root, 'scripts'),
  ].sort();
}

function nodes(source) {
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true });
  const result = [];
  function visit(node, parent) {
    if (!node || typeof node.type !== 'string') return;
    result.push({ node, parent });
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'range') continue;
      if (Array.isArray(value)) value.forEach((child) => visit(child, node));
      else if (value && typeof value === 'object') visit(value, node);
    }
  }
  visit(ast, null);
  return result;
}

function requireCalls(source) {
  return nodes(source).filter(({ node }) => node.type === 'CallExpression'
    && ((node.callee.type === 'Identifier' && node.callee.name === 'require')
      || (node.callee.type === 'MemberExpression' && node.callee.object.name === 'require'
        && (node.callee.computed ? node.callee.property.value : node.callee.property.name) === 'resolve')))
    .map(({ node }) => node);
}

function relativeRequires(source) {
  return requireCalls(source).filter((node) => node.arguments[0]?.type === 'Literal'
    && typeof node.arguments[0].value === 'string' && node.arguments[0].value.startsWith('.'))
    .map((node) => node.arguments[0]);
}

function staticDirnameJoins(source) {
  return nodes(source).filter(({ node }) => node.type === 'CallExpression'
    && node.callee.type === 'MemberExpression' && node.callee.object.name === 'path'
    && node.callee.property.name === 'join' && node.arguments[0]?.name === '__dirname'
    && node.arguments.length > 1
    && node.arguments.slice(1).every((part) => part.type === 'Literal' && typeof part.value === 'string'))
    .map(({ node }) => node);
}

module.exports = { walk, appFiles, nodes, relativeRequires, requireCalls, staticDirnameJoins };
