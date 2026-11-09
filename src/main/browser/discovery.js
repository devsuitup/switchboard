'use strict';

const path = require('node:path');

function snap(file) {
  return /(^|\/)snap(\/|$)|(^|\/)(snap|snapd)$/.test(file.replace(/\\/g, '/'));
}

function executable(file, fs) {
  if (!path.isAbsolute(file)) throw new Error('Browser binary must be absolute');
  let current = file;
  for (let hop = 0; hop < 40; hop++) {
    if (snap(current)) throw new Error('Snap browsers are unsupported; configure a native executable');
    const parts = path.resolve(current).split(path.sep);
    let prefix = parts.shift() + path.sep;
    let redirected = false;
    for (let i = 0; i < parts.length; i++) {
      prefix = path.join(prefix, parts[i]);
      const stat = fs.lstatSync(prefix);
      if (stat.isSymbolicLink()) {
        current = path.resolve(path.dirname(prefix), fs.readlinkSync(prefix), ...parts.slice(i + 1));
        redirected = true;
        break;
      }
    }
    if (redirected) continue;
    const real = fs.realpathSync(current);
    if (snap(real) || /headless[_-]shell/.test(real)) throw new Error('Snap and headless-shell browsers are unsupported');
    if (!fs.statSync(real).isFile()) throw new Error('Browser is not an executable file');
    fs.accessSync(real, fs.constants?.X_OK ?? 1);
    const fd = fs.openSync(real, 'r');
    const magic = Buffer.alloc(4);
    try { fs.readSync(fd, magic, 0, magic.length, 0); } finally { fs.closeSync(fd); }
    if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error(`Browser ${real} is not ELF; configure the real Chromium binary (for example /usr/lib/chromium/chromium), not its launcher script`);
    return real;
  }
  throw new Error('Browser symlink chain is too long');
}

function discoverBrowser({ binaryPath = '', env = process.env, home = require('node:os').homedir(), fs = require('node:fs') } = {}) {
  if (binaryPath) {
    try { return { binary: executable(binaryPath, fs), source: 'configured' }; }
    catch (error) { throw new Error(`Configure an absolute executable Chromium binary: ${error.message}`); }
  }
  const root = env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(home, '.cache', 'ms-playwright');
  if (!path.isAbsolute(root)) throw new Error('PLAYWRIGHT_BROWSERS_PATH must be absolute');
  let revisions;
  try { revisions = fs.readdirSync(root).filter(name => /^chromium-\d+$/.test(name)); } catch { revisions = []; }
  revisions.sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  for (const revision of revisions) {
    for (const layout of ['chrome-linux64', 'chrome-linux']) {
      try { return { binary: executable(path.join(root, revision, layout, 'chrome'), fs), source: 'playwright-cache' }; } catch {}
    }
  }
  throw new Error('Install Playwright Chromium manually or configure an absolute executable browser path');
}

module.exports = { discoverBrowser };
