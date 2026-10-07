'use strict';

const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROFILE_ID_BYTES = 24;
const PROFILE_ID_FILENAME = 'remote-attach-profile-id';
const PROFILE_ID_RE = /^[A-Za-z0-9_-]{22,128}$/;

function loadAttachProfileId(userDataDir, log) {
  const freshId = () => randomBytes(PROFILE_ID_BYTES).toString('base64url');
  try {
    const filename = path.join(userDataDir, PROFILE_ID_FILENAME);
    const read = () => {
      const value = fs.readFileSync(filename, 'utf8');
      if (!PROFILE_ID_RE.test(value)) throw new Error('invalid profile identity');
      return value;
    };
    try {
      return read();
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    fs.mkdirSync(userDataDir, { recursive: true });
    const id = freshId();
    try {
      fs.writeFileSync(filename, id, { flag: 'wx', mode: 0o600 });
      return id;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      return read();
    }
  } catch (err) {
    log.warn(`[remote-attach] profile identity unavailable (${err.message}); using a run-only identity`);
    return freshId();
  }
}

module.exports = { loadAttachProfileId };
