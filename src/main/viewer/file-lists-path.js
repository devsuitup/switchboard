'use strict';

const path = require('node:path');

function fileListPathKey(filePath, platform = process.platform) {
  const normalized = path.resolve(filePath).replace(/\\/g, '/');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

module.exports = { fileListPathKey };
