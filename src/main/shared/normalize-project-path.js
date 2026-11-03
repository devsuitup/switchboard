const fs = require('fs');

function normalizeProjectPath(value) {
  if (typeof value !== 'string') return value;
  let resolved = true;
  try { value = fs.realpathSync.native(value); } catch { resolved = false; }
  value = value.replace(/\\/g, '/');
  return !resolved && process.platform === 'win32' ? value.toLowerCase() : value;
}

module.exports = { normalizeProjectPath };
