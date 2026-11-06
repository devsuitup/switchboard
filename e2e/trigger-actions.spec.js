'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { test, expect, makeRepo, openPlainTerminal } = require('./fixtures');

const FIXTURE = path.join(__dirname, 'fixtures', 'trigger-session.cjs');

function seedClosedSession(home, repo) {
  const folder = path.join(home, '.claude', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'));
  const file = fs.readdirSync(folder).find(name => name.endsWith('.jsonl'));
  return path.basename(file, '.jsonl');
}

function wrapperRuns(home) {
  const dir = path.join(home, 'trigger-session-runs');
  return fs.existsSync(dir) ? fs.readdirSync(dir).map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))) : [];
}

function publish(env, request) {
  const uuid = randomUUID();
  const dir = env.SWITCHBOARD_TRIGGERS_DIR;
  fs.writeFileSync(path.join(dir, `${uuid}.tmp`), JSON.stringify(request));
  fs.renameSync(path.join(dir, `${uuid}.tmp`), path.join(dir, `${uuid}.json`));
  const result = path.join(dir, 'processed', `${uuid}.result.json`);
  return async () => {
    await expect.poll(() => fs.existsSync(result), { timeout: 30_000 }).toBe(true);
    return JSON.parse(fs.readFileSync(result, 'utf8'));
  };
}

test('an open-resume trigger shows an ordinary session without taking focus', async ({ home, env, launch }) => {
  const repo = makeRepo(home, env, { 'a.txt': 'fixture\n' });
  const sessionId = seedClosedSession(home, repo);
  const preLaunchCmd = `${process.execPath} ${FIXTURE}`;
  const { app, page } = await launch();
  await page.evaluate(async ({ repoPath, prefix }) => {
    await window.api.setSetting('project:' + repoPath, { sandbox: false, mcpEmulation: false, permissionMode: null, preLaunchCmd: prefix });
  }, { repoPath: repo, prefix: preLaunchCmd });
  const saved = await page.evaluate(path_ => window.api.getEffectiveSettings(path_), repo);
  expect(saved.preLaunchCmd).toBe(preLaunchCmd);
  expect(saved.sandbox).toBeFalsy();
  const permissionArgs = saved.permissionMode ? ['--permission-mode', saved.permissionMode] : [];

  await openPlainTerminal(page);
  const selected = await page.evaluate(() => activeSessionId);
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.focusCalls = 0;
    const win = BrowserWindow.getAllWindows()[0];
    for (const name of ['focus', 'show', 'showInactive', 'restore', 'flashFrame', 'moveTop']) {
      const original = win[name].bind(win);
      win[name] = (...args) => { globalThis.focusCalls += 1; return original(...args); };
    }
  });
  const focusedBefore = await page.evaluateHandle(() => document.activeElement);
  const unchanged = async () => {
    expect(await page.evaluate(() => activeSessionId)).toBe(selected);
    expect(await page.evaluate(element => document.activeElement === element, focusedBefore)).toBe(true);
    expect(await page.evaluate(() => document.querySelectorAll('#terminals .terminal-container.visible').length)).toBe(1);
    expect(await app.evaluate(() => globalThis.focusCalls)).toBe(0);
  };

  const first = await publish(env, { version: 1, action: 'open', sessionId })();
  expect(first).toMatchObject({ outcome: 'opened', ok: true, resumed: true, wrote: false, sessionId });
  await expect.poll(() => wrapperRuns(home).length).toBe(1);
  expect(wrapperRuns(home)[0]).toEqual({ argv: ['claude', '--resume', sessionId, ...permissionArgs], cwd: repo });
  await expect(page.locator(`#si-${sessionId}`)).toBeVisible();
  await unchanged();

  const second = await publish(env, { version: 1, action: 'open', sessionId })();
  expect(second).toMatchObject({ outcome: 'opened', resumed: false });
  expect(wrapperRuns(home)).toHaveLength(1);
  await unchanged();

  await page.locator(`#si-${sessionId}`).click();
  await expect.poll(() => page.evaluate(() => activeSessionId)).toBe(sessionId);
  await expect(page.locator('#terminals .terminal-container.visible')).toHaveCount(1);
  expect(wrapperRuns(home)).toHaveLength(1);
});
