'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function readRequestFile(fs, file, { captureLimit = 65536, deadline = Date.now() + 2000 } = {}) {
  const before = fs.lstatSync(file);
  if (!before.isFile()) throw new Error('request must be a regular file');
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0)));
    const opened = fs.fstatSync(fd);
    const same = (a, b) => a.isFile() && b.isFile() && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'birthtimeMs'].every(key => a[key] === b[key]);
    if (!same(before, opened)) throw new Error('request changed while opening');
    const digest = createHash('sha256'), buffer = Buffer.alloc(65536), chunks = [];
    let size = 0;
    for (;;) {
      if (Date.now() >= deadline) throw new Error('request hash deadline exceeded');
      const count = fs.readSync(fd, buffer, 0, buffer.length, size);
      if (!count) break;
      size += count;
      digest.update(buffer.subarray(0, count));
      if (size <= captureLimit) chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    if (size !== opened.size || !same(opened, fs.fstatSync(fd)) || !same(opened, fs.lstatSync(file))) throw new Error('request changed while reading');
    return { rawHash: digest.digest('hex'), bytes: size <= captureLimit ? Buffer.concat(chunks) : null, stat: opened };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function createSessionRequestPublication({ fs, renameWithRetry, log, platform = process.platform }) {
  let unsupportedLogged = false;
  function flushParent(directory) {
    let fd;
    try { fd = fs.openSync(directory, fs.constants.O_RDONLY); fs.fsyncSync(fd); }
    catch (error) {
      if (platform !== 'win32' || !['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error;
      if (!unsupportedLogged) {
        unsupportedLogged = true;
        try { log?.warn('[trigger-watcher] directory flush unsupported on Windows:', error.code); } catch {}
      }
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function publish(file, bytes) {
    const temp = file + '.tmp';
    let fd;
    try {
      fs.writeFileSync(temp, bytes);
      fd = fs.openSync(temp, fs.constants.O_RDWR);
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      renameWithRetry(temp, file);
      flushParent(path.dirname(file));
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function cleanup(input, expectedHash, marker) {
    if (expectedHash) {
      let current;
      try { current = readRequestFile(fs, input); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (current && current.rawHash !== expectedHash) throw new Error('request changed before cleanup');
      if (current) {
        try { fs.unlinkSync(input); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    if (marker) {
      try { fs.unlinkSync(marker); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  function archive(input, destination, expectedHash) {
    let existing;
    try { existing = readRequestFile(fs, destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && existing.rawHash !== expectedHash) throw new Error('conflict archive destination is occupied');
    const current = readRequestFile(fs, input);
    if (current.rawHash !== expectedHash) throw new Error('request changed before archive');
    if (existing) fs.unlinkSync(input);
    else renameWithRetry(input, destination);
    flushParent(path.dirname(destination));
  }
  return { publish, cleanup, archive };
}

module.exports = { createSessionRequestPublication, readRequestFile, hash };
