'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function isolateCodexHome(t) {
  const previous = process.env.CODEX_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-codex-home-'));
  process.env.CODEX_HOME = home;
  function restore() {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
  t?.after(restore);
  return { home, restore };
}

module.exports = isolateCodexHome;
