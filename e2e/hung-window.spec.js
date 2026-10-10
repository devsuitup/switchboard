'use strict';

const { test, expect, makeRepo } = require('./fixtures');

const EXIT_TIMEOUT_MS = 60_000;

test('closing a window whose page hangs, then closing it again, still ends the app', async ({ home, env, launch }) => {
  test.setTimeout(150_000);
  makeRepo(home, env, { 'readme.txt': 'fixture\n' });
  const { app, page } = await launch();
  const proc = app.process();
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    setTimeout(() => win.close(), 2000);
    setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 6000);
  });
  await page.evaluate(() => { setTimeout(() => { for (;;) Date.now(); }, 500); });
  await expect.poll(() => proc.exitCode !== null || proc.signalCode !== null, { timeout: EXIT_TIMEOUT_MS }).toBe(true);
  expect(proc.signalCode).toBe(null);
  expect(proc.exitCode).toBe(0);
});
