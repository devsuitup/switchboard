'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const cliSessionState = require('../cli-session-state');

module.exports = function loadGetProjectsHandler(context) {
  const filename = path.join(__dirname, '../main.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf("ipcMain.handle('get-projects'");
  const end = source.indexOf('\n});', start) + 4;
  assert.ok(start >= 0 && end > start, 'shipped get-projects registration must exist');
  let handler;
  const helperStart = source.indexOf('async function getProjectsSnapshot(');
  const helperEnd = source.indexOf('\n}', helperStart) + 2;
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  vm.runInNewContext(source.slice(helperStart, helperEnd) + '\n' + source.slice(start, end), {
    console, performance, structuredClone, Buffer, cliSessionState, require: createRequire(filename), ...context,
    ipcMain: { handle: (name, callback) => { assert.equal(name, 'get-projects'); handler = callback; } },
  }, { filename, lineOffset: source.slice(0, start).split('\n').length - 1 });
  return handler;
};
