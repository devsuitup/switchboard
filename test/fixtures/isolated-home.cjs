'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeProjectPath } = require('../../encode-project-path');

function projectNames(home) {
  try {
    return fs.readdirSync(path.join(home, '.claude', 'projects')).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function isolatedHome(t, { realHome = os.homedir(), projects } = {}) {
  const before = projectNames(realHome);
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const tempDir = fs.realpathSync(os.tmpdir());
  const home = fs.realpathSync(fs.mkdtempSync(path.join(tempDir, 'sb-schedule-home-')));
  assert.equal(path.dirname(home), tempDir, 'the disposable home must stay inside the temporary directory');
  const runnerId = require.resolve('../../src/main/schedules/schedule-runner');
  const cachedRunner = require.cache[runnerId];
  t.after(() => {
    try {
      if (projects) assertProjects(projects());
      else assert.deepEqual(projectNames(realHome), before, 'real home projects directory names must stay unchanged');
    } finally {
      for (const key of ['HOME', 'USERPROFILE']) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      if (cachedRunner) require.cache[runnerId] = cachedRunner;
      else delete require.cache[runnerId];
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
  function assertProjects(expected) {
    assert.deepEqual(projectNames(home), [...new Set(expected.map(encodeProjectPath))].sort(),
      'scheduled projects must exist only in the disposable home');
    assert.deepEqual(projectNames(realHome), before, 'real home projects directory names must stay unchanged');
  }
  return {
    home,
    install() {
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      delete require.cache[runnerId];
    },
    assertProjects,
  };
}

module.exports = { isolatedHome };
