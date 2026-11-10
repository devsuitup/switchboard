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

function isolatedHome(t, { realHome = process.env.SWITCHBOARD_TEST_REAL_HOME || os.homedir(), projects } = {}) {
  const firedProjects = new Set();
  const tempPrefixes = ['sb-schedule-home-', 'sb-preloaded-home-', 'sb-project-archive-',
    'sb-run-result-', 'reenable-792-', 'sb-schedule-marker-'];
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const tempDir = fs.realpathSync(os.tmpdir());
  const home = fs.realpathSync(fs.mkdtempSync(path.join(tempDir, 'sb-schedule-home-')));
  assert.equal(path.dirname(home), tempDir, 'the disposable home must stay inside the temporary directory');
  const runnerId = require.resolve('../../src/main/schedules/schedule-runner');
  const cachedRunner = require.cache[runnerId];
  t.after(() => {
    try {
      if (projects) assertProjects(projects());
      else assertRealProjects();
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
  function assertRealProjects() {
    const forbidden = new Set();
    const caseKey = name => process.platform === 'win32' ? name.toLowerCase() : name;
    for (const project of firedProjects) {
      const variants = new Set([project, path.resolve(project)]);
      try { variants.add(fs.realpathSync.native(project)); } catch {}
      for (const variant of variants) {
        forbidden.add(caseKey(encodeProjectPath(variant)));
        forbidden.add(caseKey(variant.replace(/[^a-zA-Z0-9]/g, '-')));
      }
    }
    for (const name of projectNames(realHome)) {
      assert.equal(forbidden.has(caseKey(name)) || tempPrefixes.some(prefix => caseKey(name).includes(prefix)), false,
        `real home must not contain test project: ${name}`);
    }
  }
  function assertProjects(expected) {
    expected.forEach(project => firedProjects.add(project));
    assert.deepEqual(projectNames(home), [...new Set(expected.map(encodeProjectPath))].sort(),
      'scheduled projects must exist only in the disposable home');
    assertRealProjects();
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
