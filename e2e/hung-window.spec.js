'use strict';

const { test, expect, makeRepo } = require('./fixtures');

const EXIT_TIMEOUT_MS = 60_000;

test('closing a window whose page hangs still ends the app', async ({ home, env, launch }) => {
  test.setTimeout(150_000);
  makeRepo(home, env, { 'readme.txt': 'fixture\n' });
  const { app, page } = await launch();
  const proc = app.process();
  await app.evaluate(({ BrowserWindow }) => { setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 2000); });
  await page.evaluate(() => { setTimeout(() => { for (;;) Date.now(); }, 500); });
  await expect.poll(() => proc.exitCode !== null || proc.signalCode !== null, { timeout: EXIT_TIMEOUT_MS }).toBe(true);
  expect(proc.signalCode).toBe(null);
  expect(proc.exitCode).toBe(0);
});
