'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HOST_NS = 'pid:[4026531836]';

function makeProc(root) {
  fs.mkdirSync(root, { recursive: true });
  const dir = pid => path.join(root, String(pid));
  const proc = {
    root,
    add(pid, { nspid = [pid], start, ppid = 1, ns = HOST_NS } = {}) {
      fs.mkdirSync(path.join(dir(pid), 'ns'), { recursive: true });
      fs.writeFileSync(path.join(dir(pid), 'status'), `Name:\tnode\nNSpid:\t${nspid.join('\t')}\nPid:\t${pid}\n`);
      const tail = ['S', ppid, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, start, 0, 0].join(' ');
      fs.writeFileSync(path.join(dir(pid), 'stat'), `${pid} (node worker) ${tail}\n`);
      fs.rmSync(path.join(dir(pid), 'ns', 'pid'), { force: true });
      if (ns) fs.symlinkSync(ns, path.join(dir(pid), 'ns', 'pid'));
      return proc;
    },
    remove(pid) { fs.rmSync(dir(pid), { recursive: true, force: true }); return proc; },
    unreadable(pid) { fs.chmodSync(path.join(dir(pid), 'status'), 0); return proc; },
    restore(pid) { fs.chmodSync(path.join(dir(pid), 'status'), 0o644); return proc; },
  };
  return proc;
}

module.exports = { makeProc, HOST_NS };
