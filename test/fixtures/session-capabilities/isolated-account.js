'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.CANARY_TEST_ACCOUNT_HOME;
if (!home || !fs.statSync(home).isDirectory()) throw new Error('Expected disposable test account home');
os.userInfo = () => ({ homedir: home, username: 'canary-fixture', uid: -1, gid: -1, shell: null });
const exists = fs.existsSync;
const boundary = path.resolve(home, '..');
fs.existsSync = file => {
  const candidate = path.resolve(String(file));
  const relative = path.relative(boundary, candidate);
  if ((relative.startsWith('..') || path.isAbsolute(relative)) &&
      /(?:^|[\\/])(?:CLAUDE(?:\.local)?\.md|\.claude[\\/](?:CLAUDE\.md|settings(?:\.local)?\.json))$/i.test(candidate)) return false;
  return exists(file);
};
