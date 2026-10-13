'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function loadScheduleRunner({ home, platform = process.platform, pathModule = path,
  realpath = fs.realpathSync.native } = {}) {
  const modules = new Map();
  const filesystem = { ...fs, realpathSync: Object.assign(value => fs.realpathSync(value), { native: realpath }) };
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    const filename = path.join(__dirname, '..', file);
    const localRequire = createRequire(filename);
    const context = vm.createContext({ module: { exports: {} }, process: { platform, env: {} },
      require: name => {
        if (name === 'fs') return filesystem;
        if (name === 'path') return pathModule;
        if (name === 'os') return { homedir: () => home };
        if (name === './normalize-project-path') return load('normalize-project-path.js');
        return localRequire(name);
      },
    });
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    modules.set(file, context.module.exports);
    return context.module.exports;
  }
  return { runner: load('schedule-runner.js'), load, filesystem };
}

module.exports = { loadScheduleRunner };
