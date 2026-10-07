'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

const TEMP_MAX_AGE_MS = 5 * 60 * 1000;
const RENAME_CONFLICTS = new Set(['EEXIST', 'ENOTEMPTY', 'EPERM', 'EBUSY']);

function removeBestEffort(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function stageNodePty(tmpRoot, src) {
  const { version } = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
  const dir = path.join(tmpRoot, `sb-nodepty-${version}-${process.platform}-${process.arch}`);
  const dst = path.join(dir, 'node-pty');
  const marker = path.join(dir, '.complete');
  for (const entry of fs.readdirSync(tmpRoot, { withFileTypes: true })) {
    const stale = path.join(tmpRoot, entry.name);
    if (entry.isDirectory() && entry.name.startsWith('sb-nodepty-') && stale !== dir) {
      try {
        if (entry.name.includes('.tmp-') && Date.now() - fs.statSync(stale).mtimeMs < TEMP_MAX_AGE_MS) continue;
        removeBestEffort(stale);
      } catch {}
    }
  }
  if (fs.existsSync(marker)) return { dir, nodePty: dst };
  if (fs.existsSync(dir)) {
    if (fs.existsSync(marker)) return { dir, nodePty: dst };
    const stale = `${dir}.stale-${randomUUID()}`;
    try {
      fs.renameSync(dir, stale);
    } catch (error) {
      if (fs.existsSync(marker)) return { dir, nodePty: dst };
      if (error.code !== 'ENOENT') throw error;
    }
    removeBestEffort(stale);
  }
  const tmpDir = fs.mkdtempSync(`${dir}.tmp-`);
  const tmpDst = path.join(tmpDir, 'node-pty');
  const prebuild = path.join('prebuilds', `${process.platform}-${process.arch}`);
  try {
    fs.cpSync(path.join(src, 'lib'), path.join(tmpDst, 'lib'), { recursive: true });
    fs.cpSync(path.join(src, prebuild), path.join(tmpDst, prebuild), { recursive: true });
    fs.copyFileSync(path.join(src, 'package.json'), path.join(tmpDst, 'package.json'));
    fs.writeFileSync(path.join(tmpDir, '.complete'), '');
    try {
      fs.renameSync(tmpDir, dir);
    } catch (error) {
      if (!RENAME_CONFLICTS.has(error.code) || !fs.existsSync(marker)) throw error;
      removeBestEffort(tmpDir);
    }
  } catch (error) {
    removeBestEffort(tmpDir);
    throw error;
  }
  return { dir, nodePty: dst };
}

module.exports = { stageNodePty };
