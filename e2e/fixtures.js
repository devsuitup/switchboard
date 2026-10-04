// Launches the real app under a throwaway HOME — see docs/e2e.md
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { test: base, expect, _electron: electron } = require('@playwright/test');

const APP_DIR = path.resolve(__dirname, '..');
const CLOSE_TIMEOUT_MS = 10_000;

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

const DROPPED_ENV = /^(CLAUDE|GIT_)|^(ELECTRON_RUN_AS_NODE|HISTFILE)$/;

function isolatedEnv(home) {
  const data = path.join(home, '.switchboard-e2e');
  const inherited = Object.fromEntries(Object.entries(process.env)
    .filter(([k]) => !DROPPED_ENV.test(k)));
  return {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    SWITCHBOARD_DATA_DIR: data,
    SWITCHBOARD_TRIGGERS_DIR: path.join(data, 'triggers'),
    GIT_CONFIG_NOSYSTEM: '1',
    ...GIT_IDENTITY,
  };
}

function writeTranscript(home, projectPath) {
  const sid = '00000000-0000-4000-8000-' + String(Math.floor(Math.random() * 1e12)).padStart(12, '0');
  const now = new Date().toISOString();
  const folder = path.join(home, '.claude', 'projects', projectPath.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(folder, { recursive: true });
  const lines = [
    { type: 'user', sessionId: sid, cwd: projectPath, timestamp: now, uuid: 'u1',
      message: { role: 'user', content: 'fixture' } },
    { type: 'assistant', sessionId: sid, cwd: projectPath, timestamp: now, uuid: 'a1', parentUuid: 'u1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
  ];
  fs.writeFileSync(path.join(folder, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function makeRepo(home, env, files) {
  const repo = path.join(home, 'work', 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), content);
  git('add', '.');
  git('commit', '-qm', 'fixture');
  writeTranscript(home, repo);
  return repo;
}

function makePlainDir(home) {
  const dir = path.join(home, 'work', 'plain');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not under git\n');
  writeTranscript(home, dir);
  return dir;
}

function bounded(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
  return Promise.race([Promise.resolve(promise).catch(() => {}), timeout]).finally(() => clearTimeout(timer));
}

function hasExited(proc) {
  return proc.exitCode !== null || proc.signalCode !== null;
}

function waitForExit(proc, ms) {
  if (hasExited(proc)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { proc.off('exit', onExit); resolve(hasExited(proc)); }, ms);
    proc.once('exit', onExit);
  });
}

function killTree(proc) {
  if (!Number.isInteger(proc.pid) || proc.pid <= 0) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    proc.kill('SIGKILL');
  }
}

async function closeApp(app) {
  const proc = app.process();
  await bounded(app.close(), CLOSE_TIMEOUT_MS);
  if (await waitForExit(proc, CLOSE_TIMEOUT_MS)) return;
  killTree(proc);
  await waitForExit(proc, CLOSE_TIMEOUT_MS);
}

const test = base.extend({
  home: async ({}, use) => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-')));
    try {
      await use(home);
    } finally {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    }
  },

  env: async ({ home }, use) => {
    await use(isolatedEnv(home));
  },

  launch: async ({ env }, use, testInfo) => {
    let app = null;
    let page = null;
    const launch = async () => {
      app = await electron.launch({
        executablePath: require('electron'),
        args: [APP_DIR, '--no-sandbox'],
        cwd: APP_DIR,
        env: { ...env, ELECTRON_IS_DEV: '0' },
      });
      await app.context().tracing.start({ screenshots: true, snapshots: true });
      page = await app.firstWindow();
      await page.locator('.project-new-btn').first().waitFor();
      return { app, page };
    };
    try {
      await use(launch);
    } finally {
      if (app) {
        const failed = testInfo.status !== testInfo.expectedStatus;
        try {
          if (failed && page) await bounded(page.screenshot({ path: testInfo.outputPath('failure.png'), timeout: CLOSE_TIMEOUT_MS }), CLOSE_TIMEOUT_MS);
          await bounded(app.context().tracing.stop(failed ? { path: testInfo.outputPath('trace.zip') } : undefined), CLOSE_TIMEOUT_MS * 3);
        } finally {
          await closeApp(app);
        }
      }
    }
  },
});

async function openPlainTerminal(page) {
  await page.locator('.project-new-btn').first().click();
  await page.locator('.popover-option-terminal').click();
  await expect(page.locator('#terminals .xterm-screen').first()).toBeVisible();
}

async function box(locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('element has no box');
  return b;
}

module.exports = { test, expect, makeRepo, makePlainDir, openPlainTerminal, box };
