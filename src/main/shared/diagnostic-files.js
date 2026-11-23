'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TRACE_FILE_RE } = require('./activity-trace');

function createDiagnosticFiles({ mainLogFile, traceDir, currentTrace, io = fs, now = Date.now }) {
  const real = file => io.realpathSync.native(file);
  const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  const validDays = days => Number.isInteger(days) && days >= 1 && days <= 36500;
  function root(dir) {
    if (io.lstatSync(path.resolve(dir)).isSymbolicLink()) throw new Error('Linked diagnostic directory refused');
    return real(dir);
  }
  function sources() {
    const main = mainLogFile();
    const parsed = path.parse(main);
    return [
      { kind: 'main', dir: parsed.dir, matches: name => name === parsed.base || name === `${parsed.name}.old${parsed.ext}`, active: () => mainLogFile() },
      { kind: 'trace', dir: traceDir, matches: name => TRACE_FILE_RE.test(name), active: currentTrace },
    ];
  }
  function inspect(source, name, days) {
    const dir = root(source.dir);
    const filePath = path.join(dir, name);
    const stat = io.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || !same(path.dirname(real(filePath)), dir)) return null;
    const active = source.active();
    let current = false;
    if (active) {
      try { current = same(real(active), real(filePath)); }
      catch (err) { if (err.code !== 'ENOENT') throw err; else current = same(path.resolve(active), filePath); }
    }
    return { kind: source.kind, name, filePath, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, dev: stat.dev,
      current, eligible: validDays(days) && !current && stat.mtimeMs < now() - days * 86400000 };
  }
  function inventory(days) {
    const result = { groups: [], files: [], count: 0, size: 0, errors: [] };
    try {
      for (const source of sources()) {
        const group = { kind: source.kind, count: 0, size: 0 };
        result.groups.push(group);
        try {
          const dir = root(source.dir);
          for (const name of io.readdirSync(dir)) {
            if (!source.matches(name)) continue;
            try {
              const file = inspect(source, name, days);
              if (!file) continue;
              result.files.push(file);
              group.count++; group.size += file.size;
              if (file.eligible) { result.count++; result.size += file.size; }
            } catch (err) { result.errors.push({ filePath: path.join(dir, name), code: err.code, error: err.message }); }
          }
        } catch (err) { if (err.code !== 'ENOENT') result.errors.push({ filePath: source.dir, code: err.code, error: err.message }); }
      }
    } catch (err) { result.errors.push({ error: err.message }); }
    return result;
  }
  function prune(days, candidates) {
    const result = { deleted: [], skipped: [], failed: [] };
    if (!validDays(days) || !Array.isArray(candidates)) {
      result.failed.push({ error: 'Invalid retention or file selection' });
      return result;
    }
    for (const candidate of candidates) {
      const filePath = candidate?.filePath;
      try {
        const source = sources().find(s => typeof filePath === 'string' && s.matches(path.basename(filePath))
          && same(root(s.dir), real(path.dirname(filePath))));
        if (!source || !same(path.resolve(filePath), path.join(root(source.dir), path.basename(filePath)))) {
          result.skipped.push({ filePath, error: 'Outside diagnostic directories' }); continue;
        }
        const file = inspect(source, path.basename(filePath), days);
        if (!file || !file.eligible || ['size', 'mtimeMs', 'ino', 'dev'].some(key => file[key] !== candidate[key])) {
          result.skipped.push({ filePath, error: 'Active, recent, linked or changed file' }); continue;
        }
        io.unlinkSync(file.filePath);
        result.deleted.push(file);
      } catch (err) {
        const target = err.code === 'ENOENT' ? result.skipped : result.failed;
        target.push({ filePath, code: err.code, error: err.message });
      }
    }
    return result;
  }
  return { inventory, prune };
}

module.exports = { createDiagnosticFiles };
