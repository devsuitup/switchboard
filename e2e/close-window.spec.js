'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test, expect, makeRepo, openPlainTerminal } = require('./fixtures');

const EXIT_TIMEOUT_MS = 20_000;

function exited(proc) {
  return proc.exitCode !== null || proc.signalCode !== null;
}

async function closeWindow(app) {
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
}

async function quitFromMenu(app) {
  const found = await app.evaluate(({ Menu, app }) => {
    const label = process.platform === 'darwin' ? `Quit ${app.name}` : process.platform === 'win32' ? 'Exit' : 'Quit';
    const find = (items) => {
      for (const item of items) {
        if (item.label === label) return item;
        const inner = item.submenu && find(item.submenu.items);
        if (inner) return inner;
      }
      return null;
    };
    const quit = find(Menu.getApplicationMenu().items);
    if (!quit) return false;
    setImmediate(() => quit.click());
    return true;
  });
  expect(found).toBe(true);
}

test('a window close asks first: Cancel keeps the window and its terminal, Close exits', async ({ home, env, launch }) => {
  const repo = makeRepo(home, env, { 'readme.txt': 'fixture\n' });
  const { app, page } = await launch();
  await openPlainTerminal(page);
  const sessionId = await page.evaluate(() => activeSessionId);

  await closeWindow(app);
  const question = page.locator('.choice-dialog');
  await expect(question).toBeVisible();
  await question.locator('.choice-dialog-cancel').click();
  await expect(question).toHaveCount(0);

  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  const live = await page.evaluate(async () => (await window.api.getActiveSessions()).map((e) => e.sessionId));
  expect(live).toContain(sessionId);
  const marker = path.join(repo, 'still-running.txt');
  await page.evaluate(([id, file]) => window.api.sendInput(id, `echo ok > "${file}"\r`), [sessionId, marker]);
  await expect.poll(() => fs.existsSync(marker)).toBe(true);

  const proc = app.process();
  await closeWindow(app);
  await expect(question).toBeVisible();
  await question.locator('.choice-dialog-confirm').click();
  await expect.poll(() => exited(proc), { timeout: EXIT_TIMEOUT_MS }).toBe(true);
  expect(proc.signalCode).toBe(null);
  expect(proc.exitCode).toBe(0);
});

test('Quit from the menu asks first: Cancel keeps the app and its terminal, Stop exits', async ({ home, env, launch }) => {
  const repo = makeRepo(home, env, { 'readme.txt': 'fixture\n' });
  const { app, page } = await launch();
  await openPlainTerminal(page);
  const sessionId = await page.evaluate(() => activeSessionId);
  const proc = app.process();
  const question = page.locator('.choice-dialog');

  await quitFromMenu(app);
  await expect(question).toBeVisible();
  await expect(question).toContainText('Plain terminal');
  await expect(question).toContainText(sessionId.slice(0, 8));
  await question.locator('.choice-dialog-cancel').click();
  await expect(question).toHaveCount(0);

  expect(exited(proc)).toBe(false);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  const live = await page.evaluate(async () => (await window.api.getActiveSessions()).map((e) => e.sessionId));
  expect(live).toContain(sessionId);
  const marker = path.join(repo, 'menu-cancel-still-running.txt');
  await page.evaluate(([id, file]) => window.api.sendInput(id, `echo ok > "${file}"\r`), [sessionId, marker]);
  await expect.poll(() => fs.existsSync(marker)).toBe(true);

  await quitFromMenu(app);
  await expect(question).toBeVisible();
  await expect(question).toContainText(sessionId.slice(0, 8));
  await question.locator('.choice-dialog-confirm').click();
  await expect.poll(() => exited(proc), { timeout: EXIT_TIMEOUT_MS }).toBe(true);
  expect(proc.signalCode).toBe(null);
  expect(proc.exitCode).toBe(0);
});
