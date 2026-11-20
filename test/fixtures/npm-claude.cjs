'use strict';

const fs = require('node:fs');
const path = require('node:path');

function writeNpmClaude(dir, { native = false, bundled = false } = {}) {
  const target = `node_modules\\@anthropic-ai\\claude-code\\${native ? 'cli.exe' : 'cli.js'}`;
  const file = path.join(dir, target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (native) fs.copyFileSync(process.execPath, file);
  else fs.writeFileSync(file, 'require("fs").writeFileSync(process.env.SB_ARGV_OUT,JSON.stringify(process.argv.slice(2)))');
  if (bundled) fs.copyFileSync(process.execPath, path.join(dir, 'node.exe'));
  fs.writeFileSync(path.join(dir, 'claude.cmd'), [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start',
    'SETLOCAL', 'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')',
    '> "%SB_ARGV_OUT%.cmd" ECHO shim',
    `endLocal & goto #_undefined_# 2>NUL & ${native ? '' : '"%_prog%" '}"%dp0%\\${target}" %*`, '',
  ].join('\r\n'));
  fs.writeFileSync(path.join(dir, 'claude.ps1'), [
    '#!/usr/bin/env pwsh', '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
    '$exe=""', 'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) { $exe=".exe" }', '$ret=0',
    '[IO.File]::WriteAllText($env:SB_ARGV_OUT + ".ps1", "shim")',
    ...(native ? [`& "$basedir/${target.replace(/\\/g, '/')}" $args`, '$ret=$LASTEXITCODE'] : [
      'if (Test-Path "$basedir/node$exe") {',
      `  & "$basedir/node$exe" "$basedir/${target.replace(/\\/g, '/')}" $args`,
      '} else {', `  & "node$exe" "$basedir/${target.replace(/\\/g, '/')}" $args`, '}', '$ret=$LASTEXITCODE',
    ]), 'exit $ret', '',
  ].join('\r\n'));
  fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\nexit 99\n');
}

module.exports = { writeNpmClaude };
