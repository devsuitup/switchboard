// see docs/e2e.md
'use strict';

const { test, expect, makeRepo, makePlainDir, openPlainTerminal, box } = require('./fixtures');

test('the shell opened with no tab fills the panel and is not a sidebar row', async ({ home, env, launch }) => {
  makeRepo(home, env, { 'readme.txt': 'fixture\n' });

  const { page } = await launch();
  await openPlainTerminal(page);
  const rows = page.locator('#sidebar-content .session-item[data-session-id]');
  const rowsBefore = await rows.count();
  expect(rowsBefore).toBeGreaterThan(0);

  await page.locator('#panel-terminal-toggle-btn').click();
  const content = page.locator('#file-panel-content');
  const region = page.locator('#panel-terminal-region');
  await expect(region.locator('.xterm-screen')).toBeVisible();
  await expect(page.locator('#panel-terminal-handle')).toBeHidden();
  await expect.poll(async () => (await box(region)).height / (await box(content)).height).toBeGreaterThan(0.9);

  await page.evaluate(() => window.loadProjects());
  const projects = await page.evaluate(() => window.api.getProjects(false));
  const ids = projects.flatMap((p) => p.sessions.map((s) => s.sessionId));
  expect(ids.filter((id) => id.startsWith('panel:'))).toEqual([]);
  await expect(page.locator('#sidebar-content .session-item[data-session-id^="panel:"]')).toHaveCount(0);
  await expect(rows).toHaveCount(rowsBefore);
});

test('Changes on a project with no git work tree says so, with no git output', async ({ home, launch }) => {
  makePlainDir(home);

  const { page } = await launch();
  await openPlainTerminal(page);
  await page.locator('#changes-toggle-btn').click();

  const list = page.locator('#changes-list');
  await expect(list.locator('.changes-note')).toBeVisible();
  await expect(list.locator('.changes-error, .changes-file-row')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(/fatal:|usage: git/);
});
