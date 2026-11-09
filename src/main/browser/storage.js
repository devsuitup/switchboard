'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');

function createStorage({ dataDir, fs = require('node:fs'), uid = process.getuid?.(), now = Date.now }) {
  let root;
  function checked(file, kind) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid) || !stat[kind]()) throw new Error(`Unsafe managed-browser path: ${file}`);
    return stat;
  }
  function directory(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
    checked(dir, 'isDirectory');
    fs.chmodSync(dir, 0o700);
  }
  function init() {
    if (!path.isAbsolute(dataDir)) throw new Error('Browser data directory must be absolute');
    root = fs.realpathSync(dataDir);
    checked(root, 'isDirectory');
    const managed = path.join(root, 'managed-browser');
    directory(managed);
    for (const name of ['profile', 'output']) directory(path.join(managed, name));
    return managed;
  }
  function base() { return path.join(root, 'managed-browser'); }
  function read(name) {
    const file = path.join(base(), name);
    try { checked(file, 'isFile'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      if (fs.fstatSync(fd).size > 65536) throw new Error('Managed-browser state is too large');
      return JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally { fs.closeSync(fd); }
  }
  function write(name, value) {
    const file = path.join(base(), name);
    try { checked(file, 'isFile'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temp = path.join(base(), `.${name}.${process.pid}.${randomUUID()}.tmp`);
    let fd;
    try {
      fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, JSON.stringify(value));
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, file);
    } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  function log() {
    const file = path.join(base(), 'browser.log');
    try { checked(file, 'isFile'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0), 0o600);
    fs.fchmodSync(fd, 0o600);
    return fd;
  }
  function tail() {
    const file = path.join(base(), 'browser.log');
    let fd;
    try {
      checked(file, 'isFile'); fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const size = fs.fstatSync(fd).size, buffer = Buffer.alloc(Math.min(4096, size));
      fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      return buffer.toString('utf8');
    } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function prune() {
    const output = path.join(base(), 'output'); checked(output, 'isDirectory');
    for (const name of fs.readdirSync(output)) {
      const file = path.join(output, name), stat = fs.lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink() && (uid === undefined || stat.uid === uid) && stat.mtimeMs < now() - 7 * 86400000) fs.unlinkSync(file);
    }
  }
  return { init, base, read, write, log, tail, prune, close: fd => fs.closeSync(fd) };
}

module.exports = { createStorage };
