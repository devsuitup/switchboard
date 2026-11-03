#!/usr/bin/env node
const { execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { scrubSessionEnv } = require('../src/main/shared/clean-env');

if (require.main === module) {
  scrubSessionEnv(process.env);

  try {
    execSync('npx electron-builder install-app-deps', { stdio: 'inherit' });
  } catch (err) {
    console.error('electron-builder install-app-deps failed:', err.message);
    console.log('Attempting fallback: rebuilding better-sqlite3 for Electron...');
    try {
      execSync('npx @electron/rebuild -f -m . -o better-sqlite3', { stdio: 'inherit' });
      console.log('Fallback rebuild succeeded.');
    } catch (err2) {
      console.error('Fallback rebuild also failed:', err2.message);
    }
  }
}

if (require.main === module && process.platform !== 'win32') {
  try {
    const nodeModules = path.join(__dirname, '..', 'node_modules');
    findFiles(nodeModules, '.node').forEach(file => {
      try {
        codesignFile(file);
      } catch {}
    });
  } catch {}

  const spawnHelperGlob = path.join(
    __dirname, '..', 'node_modules', 'node-pty', 'prebuilds'
  );
  if (fs.existsSync(spawnHelperGlob)) {
    try {
      findFiles(spawnHelperGlob, 'spawn-helper').forEach(file => {
        fs.chmodSync(file, 0o755);
      });
    } catch {}
  }
}

function findFiles(dir, suffix) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findFiles(full, suffix));
      } else if (entry.name.endsWith(suffix)) {
        results.push(full);
      }
    }
  } catch {}
  return results;
}

function codesignFile(file, sign = execFileSync) {
  sign('codesign', ['--sign', '-', '--force', file], { stdio: 'ignore' });
}

module.exports = { findFiles, codesignFile };
