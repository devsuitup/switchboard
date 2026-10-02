'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveWindowsClaude, escapeForCmd } = require('../claude-binary');

const NPM = 'C:\\Users\\u\\AppData\\Roaming\\npm';
const SHIM = '@ECHO off\r\nSET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';

function deps(files) {
  return { exists: (p) => Object.prototype.hasOwnProperty.call(files, p), readFile: (p) => files[p] };
}

test('a claude.exe on PATH is run directly', () => {
  const env = { PATH: 'C:\\bin;C:\\tools' };
  const r = resolveWindowsClaude(['agents', '--json'], env, deps({ 'C:\\tools\\claude.exe': '' }));
  assert.deepEqual(r, { program: 'C:\\tools\\claude.exe', args: ['agents', '--json'], verbatim: false });
});

test('an npm claude.cmd shim runs node on the cli.js it points to', () => {
  const env = { PATH: `${NPM};C:\\node` };
  const files = {
    [`${NPM}\\claude.cmd`]: SHIM,
    [`${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`]: '',
    'C:\\node\\node.exe': '',
  };
  const r = resolveWindowsClaude(['--bg', 'say "hi" & bye\nline two'], env, deps(files));
  assert.equal(r.program, 'C:\\node\\node.exe');
  assert.deepEqual(r.args, [`${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`, '--bg', 'say "hi" & bye\nline two']);
  assert.equal(r.verbatim, false);
});

test('a .cmd shim that cannot be unwrapped goes through cmd.exe with escaped arguments', () => {
  const env = { PATH: NPM, ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
  const r = resolveWindowsClaude(['stop', 'aaaaaaaa'], env, deps({ [`${NPM}\\claude.cmd`]: 'unknown shim' }));
  assert.equal(r.program, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(r.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(r.verbatim, true);
  assert.match(r.args[3], /claude\.cmd/);
});

test('through cmd.exe a multi-line argument is refused instead of being cut', () => {
  const env = { PATH: NPM };
  const r = resolveWindowsClaude(['--bg', 'a\nb'], env, deps({ [`${NPM}\\claude.cmd`]: 'unknown shim' }));
  assert.match(r.error, /multi-line/);
});

test('no claude on PATH is reported', () => {
  assert.match(resolveWindowsClaude(['agents'], { PATH: 'C:\\bin' }, deps({})).error, /not found/);
});

test('escapeForCmd quotes the argument and escapes the cmd metacharacters', () => {
  assert.ok(escapeForCmd('a&b').includes('^&'));
  assert.ok(!/(^|[^^])&/.test(escapeForCmd('a&b')));
});

test('the current npm shim, which points to bin\claude.exe, runs that exe directly', () => {
  const shim = '@ECHO off\r\nSET dp0=%~dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
  const exe = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
  const r = resolveWindowsClaude(['--bg', 'a\nb'], { PATH: NPM }, deps({ [`${NPM}\\claude.cmd`]: shim, [exe]: '' }));
  assert.deepEqual(r, { program: exe, args: ['--bg', 'a\nb'], verbatim: false });
});

test('the extensionless sh shim npm leaves next to claude.cmd is never picked', () => {
  const shim = '@ECHO off\r\nSET dp0=%~dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
  const exe = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
  const files = { [`${NPM}\\claude`]: '#!/bin/sh', [`${NPM}\\claude.cmd`]: shim, [exe]: '' };
  const r = resolveWindowsClaude(['agents'], { PATH: NPM }, deps(files));
  assert.equal(r.program, exe);
});
