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

test('through cmd.exe the shim path is escaped for one parse only, since %* re-parses the arguments but not the command', () => {
  const env = { PATH: 'C:\\Users\\u u\\npm', ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
  const r = resolveWindowsClaude(['--name', 'a&b'], env, deps({ 'C:\\Users\\u u\\npm\\claude.cmd': 'unknown shim' }));
  assert.equal(r.args[3], '"^"C:\\Users\\u^ u\\npm\\claude.cmd^" ^^^"--name^^^" ^^^"a^^^&b^^^""');
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

test('escapeForCmd escapes once for one cmd parse and twice for a shim re-parse', () => {
  assert.equal(escapeForCmd('a&b', 1), '^"a^&b^"');
  assert.equal(escapeForCmd('a&b'), '^^^"a^^^&b^^^"');
  assert.equal(escapeForCmd('a\\'), '^^^"a\\\\^^^"');
});

test('a shim whose node line carries an interpreter option is not unwrapped, so the option is kept', () => {
  const shim = '@echo off\r\nnode --require "%~dp0\\setup.cjs" "%~dp0\\cli.js" %*\r\n';
  const files = { [`${NPM}\\claude.cmd`]: shim, [`${NPM}\\claude.ps1`]: '', [`${NPM}\\setup.cjs`]: '', [`${NPM}\\cli.js`]: '', 'C:\\node\\node.exe': '' };
  const r = resolveWindowsClaude(['--name', 'review'], { PATH: `${NPM};C:\\node`, ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, deps(files));
  assert.equal(r.program, 'C:\\Windows\\System32\\cmd.exe', 'the shim runs as written instead of node on its target alone');
  assert.equal(r.verbatim, true);
  assert.match(r.args[3], /claude\.cmd/);
});

test('an npm-spelled shim with an interpreter option before its %dp0% target is not unwrapped either', () => {
  const shim = '@ECHO off\r\nSET dp0=%~dp0\r\n"%_prog%" --require "%dp0%\\setup.cjs" "%dp0%\\cli.js" %*\r\n';
  const files = { [`${NPM}\\claude.cmd`]: shim, [`${NPM}\\setup.cjs`]: '', [`${NPM}\\cli.js`]: '', 'C:\\node\\node.exe': '' };
  const r = resolveWindowsClaude(['--name', 'review'], { PATH: `${NPM};C:\\node`, ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, deps(files));
  assert.equal(r.program, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(r.verbatim, true);
});

test('a JavaScript target with no interpreter on its line, or one followed by more than %*, is not unwrapped', () => {
  for (const shim of ['"%dp0%\\cli.js" %*\r\n', 'node "%~dp0\\cli.js" %* > nul\r\n', '"C:\\other\\node.exe" "%dp0%\\cli.js" %*\r\n']) {
    const files = { [`${NPM}\\claude.cmd`]: shim, [`${NPM}\\cli.js`]: '', 'C:\\node\\node.exe': '' };
    const r = resolveWindowsClaude(['--name', 'review'], { PATH: `${NPM};C:\\node`, ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, deps(files));
    assert.equal(r.program, 'C:\\Windows\\System32\\cmd.exe', shim);
  }
});

const NPM_HEAD = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n';
const NPM_TRAILERS = {
  'cmd-shim 4.1.0 to 9.0.0 (npm 7.24 to 11)': 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ',
  'cmd-shim 9.0.2': 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & ',
};

for (const [generator, trailer] of Object.entries(NPM_TRAILERS)) {
  test(`the npm shim of ${generator}, with its title trailer before "%_prog%", is unwrapped to node on its cli.js`, () => {
    const shim = `${NPM_HEAD}${trailer}"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`;
    const cli = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
    const r = resolveWindowsClaude(['--name', 'a\nb'], { PATH: `${NPM};C:\\node` }, deps({ [`${NPM}\\claude.cmd`]: shim, [cli]: '', 'C:\\node\\node.exe': '' }));
    assert.deepEqual(r, { program: 'C:\\node\\node.exe', args: [cli, '--name', 'a\nb'], verbatim: false });
  });
}

test('an npm-shaped trailer that runs another command before "%_prog%" is not unwrapped', () => {
  for (const trailer of [
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set NODE_OPTIONS=--require setup.cjs & ',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & set NODE_PATH=%dp0% & ',
    'endLocal & goto #_undefined_# 2>NUL || echo on & ',
  ]) {
    const shim = `${NPM_HEAD}${trailer}"%_prog%"  "%dp0%\\cli.js" %*\r\n`;
    const files = { [`${NPM}\\claude.cmd`]: shim, [`${NPM}\\cli.js`]: '', 'C:\\node\\node.exe': '' };
    const r = resolveWindowsClaude(['--name', 'review'], { PATH: `${NPM};C:\\node`, ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, deps(files));
    assert.equal(r.program, 'C:\\Windows\\System32\\cmd.exe', trailer);
    assert.equal(r.verbatim, true);
  }
});

test('a pnpm claude.cmd shim, which spells its target with %~dp0, runs node on the cli.js it points to', () => {
  const shim = '@SETLOCAL\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n) ELSE (\r\n  node  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n)\r\n';
  const cli = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
  const files = { [`${NPM}\\claude.cmd`]: shim, [`${NPM}\\claude.ps1`]: '', [cli]: '', 'C:\\node\\node.exe': '' };
  const r = resolveWindowsClaude(['--bg', 'a\nb'], { PATH: `${NPM};C:\\node` }, deps(files));
  assert.deepEqual(r, { program: 'C:\\node\\node.exe', args: [cli, '--bg', 'a\nb'], verbatim: false });
});
