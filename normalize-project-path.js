const fs = require('fs');

function normalizeProjectPath(value) {
  try { value = fs.realpathSync.native(value); } catch {}
  value = value.replace(/\\/g, '/');
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

module.exports = { normalizeProjectPath };
