// see docs/e2e.md
'use strict';

const { test, expect, makePlainDir, box } = require('./fixtures');

const LONG_SEGMENT = 'a-very-long-folder-segment-without-any-spaces-' + 'x'.repeat(80);
const BASE = `C:\\Users\\fixture\\Documents\\Folder With Spaces\\${LONG_SEGMENT}`;

function scheduleFixture() {
  const now = Date.now();
  const runs = Array.from({ length: 20 }, (_, i) => ({
    sessionId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    created: new Date(now - (i + 1) * 3600000).toISOString(),
    messageCount: 2, replied: true, running: false,
    result: i % 2 ? { outcome: 'exited', exitCode: 0 }
      : { outcome: 'refused', error: 'the launcher refused this run because ' + 'the-sandbox-policy-forbids-it-'.repeat(8) },
  }));
  const schedule = (project, slug, extra = {}) => ({
    file: `schedule-${slug}.md`, filePath: `${project}\\.claude\\commands\\schedule-${slug}.md`,
    name: slug, slug, cron: '0 9 * * 1-5', cronText: 'at 9:00 on weekdays', enabled: true, linked: false,
    problems: [], prompt: 'Review', nextRunMs: now + 86400000, catchUp: false, catchUpDueMs: null, runs: [], readError: null,
    ...extra,
  });
  const main = `${BASE}\\main-project`;
  const archived = `${BASE}\\archived-project`;
  const unknown = `${BASE}\\unknown-project`;
  const unreadable = `${BASE}\\unreadable-project`;
  const project = (projectPath, extra) => ({ projectPath, shortName: projectPath.split('\\').pop(), archived: false,
    sandboxed: false, known: true, scanError: null, schedules: [], ...extra });
  return { now, catchUpActive: true, projects: [
    project(main, { schedules: [
      schedule(main, 'nightly', { name: 'Nightly dependency review with a very long descriptive name '.repeat(3).trim(),
        prompt: 'Review the dependencies. '.repeat(40), runs, catchUp: true }),
      schedule(main, 'disabled', { enabled: false }),
      schedule(main, 'malformed', { cron: null, cronText: null, nextRunMs: null,
        problems: ['front matter not read: save with LF line endings'] }),
      schedule(main, 'linked', { linked: true }),
      schedule(main, 'unreadable', { name: 'schedule-unreadable.md', slug: null, enabled: null, cron: null, cronText: null,
        prompt: null, catchUp: null, nextRunMs: null, problems: ['could not read the file (EACCES)'],
        readError: { code: 'EACCES', message: 'permission denied' } }),
    ] }),
    project(archived, { archived: true, schedules: [schedule(archived, 'suspended')] }),
    project(unknown, { known: false, schedules: [schedule(unknown, 'orphan')] }),
    project(unreadable, { scanError: { code: 'EACCES', message: 'permission denied' } }),
  ] };
}

async function openSchedules(app, page, fixture) {
  await app.evaluate(({ ipcMain }, data) => {
    globalThis.scheduleFixture = data;
    globalThis.scheduleListCalls = 0;
    ipcMain.removeHandler('list-schedules');
    ipcMain.handle('list-schedules', () => {
      globalThis.scheduleListCalls++;
      return globalThis.scheduleFixture;
    });
  }, fixture);
  await page.evaluate(() => window._applySchedulesTab(true));
  await page.locator('.sidebar-tab[data-tab="schedules"]').click();
  const count = fixture.projects.reduce((sum, project) => sum + project.schedules.length, 0);
  await expect(page.locator('#schedules-content .schedule-item')).toHaveCount(count);
}

async function windowSize(app, page, width, height, zoom) {
  await app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.setZoomFactor(size.zoom);
    win.setContentSize(size.width, size.height);
  }, { width, height, zoom });
  await expect.poll(async () => Math.abs(await page.evaluate(() => innerWidth) - width / zoom)).toBeLessThanOrEqual(1);
}

async function refreshCount(app) {
  return app.evaluate(() => globalThis.scheduleListCalls);
}

async function refresh(app, page) {
  const before = await refreshCount(app);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('#schedules-content [data-schedule-control]')) el.dataset.e2eBefore = '1';
  });
  await page.evaluate(() => window.loadSchedules());
  await expect.poll(() => refreshCount(app)).toBeGreaterThan(before);
  await expect.poll(() => page.evaluate(() => !document.querySelector('#schedules-content [data-e2e-before]'))).toBe(true);
}

function overflowReport() {
  const content = document.getElementById('schedules-content');
  const outer = content.getBoundingClientRect();
  const failures = [];
  if (content.scrollWidth > content.clientWidth + 1) failures.push(`the tab scrolls sideways: ${content.scrollWidth} > ${content.clientWidth}`);
  for (const el of content.querySelectorAll('button, summary')) {
    const label = `${el.className || el.tagName} "${el.textContent.slice(0, 40)}"`;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) { failures.push(`${label} has no box`); continue; }
    const row = (el.closest('.schedule-actions, .schedule-item, .schedule-scan-error, .schedule-load-error, .schedule-project') || content).getBoundingClientRect();
    if (rect.left < row.left - 1 || rect.right > row.right + 1) failures.push(`${label} overflows its row: ${rect.left}-${rect.right} outside ${row.left}-${row.right}`);
    if (rect.left < outer.left - 1 || rect.right > outer.right + 1) failures.push(`${label} overflows the tab`);
    if (el.scrollWidth > el.clientWidth + 1) failures.push(`${label} clips its text: ${el.scrollWidth} > ${el.clientWidth}`);
  }
  return failures;
}

test('schedule rows keep every action inside the tab at 200, 340 and 600 px, in light and dark, at 100% and 150% zoom', async ({ home, launch }, testInfo) => {
  test.setTimeout(180_000);
  makePlainDir(home);
  const { app, page } = await launch();
  await openSchedules(app, page, scheduleFixture());
  await page.evaluate(() => { for (const details of document.querySelectorAll('#schedules-content details')) details.open = true; });
  await expect(page.locator('#schedules-content .schedule-history-run')).toHaveCount(20);
  for (const [width, height] of [[1400, 900], [800, 500]]) {
    for (const zoom of [1, 1.5]) {
      await windowSize(app, page, width, height, zoom);
      for (const theme of ['light', 'dark']) {
        await page.evaluate(choice => window.appTheme.apply(choice), theme);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        for (const sidebar of [200, 340, 600]) {
          await page.evaluate(px => { document.getElementById('sidebar').style.width = px + 'px'; }, sidebar);
          const shown = await box(page.locator('#sidebar'));
          const name = `schedules-${width}x${height}-zoom${zoom * 100}-${theme}-sidebar${sidebar}`;
          await page.locator('#sidebar').screenshot({ path: testInfo.outputPath(`${name}.png`) });
          testInfo.annotations.push({ type: 'size', description: `${name}: sidebar ${Math.round(shown.width)} css px, platform ${process.platform}` });
          expect(await page.evaluate(overflowReport), name).toEqual([]);
        }
      }
    }
  }
});

test('keyboard focus survives refreshes and the create form stays reachable in a small zoomed window', async ({ home, launch }, testInfo) => {
  makePlainDir(home);
  const { app, page } = await launch();
  await openSchedules(app, page, scheduleFixture());
  const create = page.locator('#schedules-content .schedule-create-btn');
  const focused = selector => page.evaluate(sel => document.activeElement?.matches(sel) && document.activeElement.isConnected, selector);

  await create.focus();
  await refresh(app, page);
  expect(await focused('#schedules-content .schedule-create-btn'), 'Create keeps focus across a refresh').toBe(true);

  await page.keyboard.press('Tab');
  expect(await focused('#schedules-content .schedule-run-btn'), 'Tab from Create reaches the first row action').toBe(true);
  const actions = page.locator('#schedules-content .schedule-actions').first();
  await expect(actions).toHaveCSS('opacity', '1');
  expect(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle)).not.toBe('none');
  await refresh(app, page);
  expect(await focused('#schedules-content .schedule-run-btn'), 'the row action keeps focus across a refresh').toBe(true);
  await page.keyboard.press('Shift+Tab');
  expect(await focused('#schedules-content .schedule-create-btn'), 'Shift+Tab returns to Create').toBe(true);

  const summary = page.locator('#schedules-content .schedule-item summary').first();
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#schedules-content .schedule-item details').first()).toHaveJSProperty('open', true);
  await refresh(app, page);
  await expect(page.locator('#schedules-content .schedule-item details').first()).toHaveJSProperty('open', true);
  expect(await focused('#schedules-content .schedule-item summary'), 'the history toggle keeps focus across a refresh').toBe(true);

  const projectRetry = page.locator('#schedules-content .schedule-scan-error .schedule-retry-btn');
  await projectRetry.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => focused('#schedules-content .schedule-scan-error .schedule-retry-btn:enabled')).toBe(true);

  await windowSize(app, page, 800, 500, 1.5);
  await create.focus();
  await page.keyboard.press('Enter');
  const form = page.locator('.schedule-create-form');
  await expect(form).toBeVisible();
  expect(await page.evaluate(() => !!document.activeElement?.closest('.schedule-create-form'))).toBe(true);
  await page.locator('#schedule-create-name').fill('Kept across refresh');
  await page.locator('#schedule-create-name').focus();
  await refresh(app, page);
  await expect(form).toBeVisible();
  await expect(page.locator('#schedule-create-name')).toHaveValue('Kept across refresh');
  await expect(page.locator('#schedule-create-name')).toBeFocused();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const formBox = await box(form);
  expect(formBox.y).toBeGreaterThanOrEqual(0);
  expect(formBox.y + formBox.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(formBox.x + formBox.width).toBeLessThanOrEqual(viewport.width + 1);
  const submit = form.locator('button[type="submit"]');
  for (let i = 0; i < 40 && !(await focused('.schedule-create-form button[type="submit"]')); i++) await page.keyboard.press('Tab');
  expect(await focused('.schedule-create-form button[type="submit"]'), 'Tab reaches Create in the form').toBe(true);
  const submitBox = await box(submit);
  expect(submitBox.y).toBeGreaterThanOrEqual(formBox.y - 1);
  expect(submitBox.y + submitBox.height).toBeLessThanOrEqual(formBox.y + formBox.height + 1);
  const cancelBox = await box(form.locator('.modal-actions button[type="button"]'));
  expect(cancelBox.y + cancelBox.height).toBeLessThanOrEqual(formBox.y + formBox.height + 1);
  await form.screenshot({ path: testInfo.outputPath('create-form-800x500-zoom150.png') });
  await page.keyboard.press('Escape');
  await expect(form).toHaveCount(0);
  expect(await focused('#schedules-content .schedule-create-btn'), 'closing the form returns focus to the current Create').toBe(true);
});
