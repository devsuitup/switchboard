'use strict';

const path = require('node:path');
const fs = require('node:fs');

function stageNodePty(tmpRoot, src) {
  const { version } = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
  const dir = path.join(tmpRoot, `sb-nodepty-${version}-${process.platform}-${process.arch}`);
  const dst = path.join(dir, 'node-pty');
  const marker = path.join(dir, '.complete');
  for (const entry of fs.readdirSync(tmpRoot, { withFileTypes: true })) {
    const stale = path.join(tmpRoot, entry.name);
    if (entry.isDirectory() && entry.name.startsWith('sb-nodepty-') && stale !== dir) {
      try { fs.rmSync(stale, { recursive: true, force: true }); } catch {}
    }
  }
  if (fs.existsSync(marker)) return { dir, nodePty: dst };
  fs.rmSync(dir, { recursive: true, force: true });
  const prebuild = path.join('prebuilds', `${process.platform}-${process.arch}`);
  fs.cpSync(path.join(src, 'lib'), path.join(dst, 'lib'), { recursive: true });
  fs.cpSync(path.join(src, prebuild), path.join(dst, prebuild), { recursive: true });
  fs.copyFileSync(path.join(src, 'package.json'), path.join(dst, 'package.json'));
  fs.writeFileSync(marker, '');
  return { dir, nodePty: dst };
}

module.exports = { stageNodePty };
