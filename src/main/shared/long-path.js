'use strict';

// see .ai/contexts/session-cache.md ("Project Archive and Delete")
const fs = require('fs');

function createLongPathResolver({ platform = process.platform, realpath = fs.realpathSync.native } = {}) {
  if (platform !== 'win32') return null;
  const cache = new Map();
  return value => {
    if (typeof value !== 'string' || !value.includes('~')) return value;
    const key = value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (!cache.has(key)) {
      let resolved = null;
      try { resolved = realpath(value); } catch {}
      cache.set(key, resolved);
    }
    return cache.get(key) ?? value;
  };
}

module.exports = { createLongPathResolver };
