'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const homes = [];

function isolateCodexHome(t, { reuse = false } = {}) {
  if (reuse && homes.some(frame => !frame.released && frame.home === process.env.CODEX_HOME)) {
    return { home: process.env.CODEX_HOME, restore() {} };
  }
  const previous = process.env.CODEX_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-codex-home-'));
  const frame = { previous, home, released: false };
  homes.push(frame);
  process.env.CODEX_HOME = home;
  function restore() {
    if (frame.released) return;
    frame.released = true;
    while (homes.at(-1)?.released) {
      const current = homes.pop();
      if (current.previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = current.previous;
      fs.rmSync(current.home, { recursive: true, force: true });
    }
  }
  t?.after(restore);
  return { home, restore };
}

module.exports = isolateCodexHome;
