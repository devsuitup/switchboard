// see docs/e2e.md
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test, expect, makeRepo, makePlainDir, openPlainTerminal, box } = require('./fixtures');

async function viewport(app, page, width, height = 600, zoom = 0) {
  await app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.setZoomLevel(size.zoom);
    win.setContentSize(size.width, size.height);
  }, { width, height, zoom });
  await expect.poll(async () => Math.abs(await page.evaluate(() => innerWidth) - width / Math.pow(1.2, zoom))).toBeLessThanOrEqual(1);
}

async function panelBox(page) {
  return page.locator('#file-panel').evaluate(el => {
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  });
}

async function geometry(page, header = '#terminal-header') {
  const [bar, panel, terminal, top] = await Promise.all([
    box(page.locator('#tool-bar')), panelBox(page),
    box(page.locator('#terminals')), box(page.locator(header)),
  ]);
  const width = await page.evaluate(() => innerWidth);
  const barWidth = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tool-bar-width')));
  expect(barWidth).toBe(34);
  expect(Math.abs(bar.width - barWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs(bar.x + bar.width - width)).toBeLessThanOrEqual(1);
  expect(bar.y).toBeGreaterThanOrEqual(top.y + top.height - 1);
  expect(panel.x + panel.width).toBeLessThanOrEqual(bar.x + 1);
  expect(terminal.width).toBeGreaterThanOrEqual(199);
}

async function shellAtBottom(page, reference) {
  const region = await box(page.locator('#panel-terminal-region'));
  const content = await box(page.locator('#file-panel-content'));
  expect(Math.abs(region.y - reference.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(region.height - reference.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(region.y + region.height - content.y - content.height)).toBeLessThanOrEqual(1);
}

for (const grid of [false, true]) {
  test(`E1: the bar bounds closed and open panels in ${grid ? 'grid' : 'single'} view`, async ({ home, env, launch }) => {
    makeRepo(home, env, { 'a.txt': 'fixture\n' });
    const { app, page } = await launch();
    await openPlainTerminal(page);
    await viewport(app, page, 1400, 900);
    if (grid) {
      await page.locator('#grid-toggle-btn').click();
      await expect(page.locator('.grid-card')).toHaveCount(1);
      await page.locator('.grid-card').click();
    }
    const header = grid ? '#grid-viewer-header' : '#terminal-header';
    await geometry(page, header);
    await page.locator('#changes-toggle-btn').click();
    await expect(page.locator('#file-panel')).toHaveClass('open');
    await geometry(page, header);
  });
}

test('E2a-E2c: tools keep the shell at the bottom, shell-only fills, and stored height returns', async ({ home, env, launch }) => {
  makeRepo(home, env, { 'a.txt': 'fixture\n' });
  const { app, page } = await launch();
  await openPlainTerminal(page);
  await viewport(app, page, 1400, 900);
  await page.locator('#changes-toggle-btn').click();
  await page.locator('#panel-terminal-toggle-btn').click();
  await expect(page.locator('#panel-terminal-region .xterm-screen')).toBeVisible();
  const reference = await box(page.locator('#panel-terminal-region'));
  await page.locator('#touched-toggle-btn').click();
  await shellAtBottom(page, reference);
  await page.evaluate(() => window.openDiffTab(window._openSessions.keys().next().value, 'e2-diff', {
    oldFilePath: '/fixture/a.txt', oldContent: 'before', newContent: 'after',
  }));
  await expect(page.locator('#file-panel-body .cm-editor').first()).toBeVisible();
  await shellAtBottom(page, reference);
  await page.locator('#changes-toggle-btn').click();
  await shellAtBottom(page, reference);
  await page.locator('#changes-toggle-btn').click();
  const content = await box(page.locator('#file-panel-content'));
  const full = await box(page.locator('#panel-terminal-region'));
  expect(Math.abs(full.y - content.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(full.height - content.height)).toBeLessThanOrEqual(1);
  await expect(page.locator('#panel-terminal-handle')).toBeHidden();
  await page.locator('#changes-toggle-btn').click();
  await shellAtBottom(page, reference);
});

test('E3: a tool fills the content without a shell and the empty panel has zero width', async ({ home, env, launch }) => {
  makeRepo(home, env, { 'a.txt': 'fixture\n' });
  const { page } = await launch();
  await openPlainTerminal(page);
  await page.locator('#changes-toggle-btn').click();
  await expect(page.locator('#panel-terminal-region')).toBeHidden();
  const tool = await box(page.locator('#file-panel-changes'));
  const content = await box(page.locator('#file-panel-content'));
  expect(tool.height / content.height).toBeGreaterThan(0.9);
  await page.locator('#changes-toggle-btn').click();
  expect((await panelBox(page)).width).toBe(0);
  await expect(page.locator('#tool-bar')).toBeVisible();
});

test('E4: Refresh stays beside the id with short and long session and PTY titles', async ({ home, launch }) => {
  makePlainDir(home);
  const { app, page } = await launch();
  await openPlainTerminal(page);
  for (const width of [800, 1400]) {
    await viewport(app, page, width);
    for (const name of ['Session', 'Session '.repeat(30)]) {
      for (const title of ['Shell', 'Program title '.repeat(30)]) {
        await page.evaluate(({ name, title }) => {
          document.getElementById('terminal-header-name').textContent = name;
          const el = document.getElementById('terminal-header-pty-title');
          el.textContent = title;
          el.style.display = '';
        }, { name, title });
        const id = await box(page.locator('#terminal-header-id'));
        const refresh = await box(page.locator('#terminal-refresh-btn'));
        const stop = await box(page.locator('#terminal-stop-btn'));
        const header = await box(page.locator('#terminal-header'));
        expect(refresh.x - id.x - id.width).toBeGreaterThanOrEqual(0);
        expect(refresh.x - id.x - id.width).toBeLessThan(24);
        for (const control of [refresh, stop]) {
          expect(control.x).toBeGreaterThanOrEqual(header.x);
          expect(control.x + control.width).toBeLessThanOrEqual(header.x + header.width);
        }
        await expect(page.locator('#terminal-header [data-header-kind="toggle"]')).toHaveCount(0);
      }
    }
  }
});

test('E5: all 32 narrow-window and zoom combinations keep the bar and panel bounded', async ({ home, env, launch }) => {
  test.setTimeout(90_000);
  makeRepo(home, env, { 'a.txt': 'fixture\n' });
  const { app, page } = await launch();
  await openPlainTerminal(page);
  for (const zoom of [0, 0.5, 1, 2]) {
    await viewport(app, page, 800, 500, zoom);
    for (const sidebar of [200, 340, 600, 'collapsed']) {
      await page.evaluate(width => {
        const el = document.getElementById('sidebar');
        el.classList.remove('collapsed');
        el.style.width = typeof width === 'number' ? width + 'px' : '340px';
      }, sidebar);
      if (sidebar === 'collapsed') await page.locator('#sidebar-collapse-btn').click();
      for (const open of [false, true]) {
        if (await page.locator('#file-panel').evaluate(el => el.classList.contains('open')) !== open) {
          await page.locator('#changes-toggle-btn').click();
        }
        await geometry(page);
      }
    }
  }
});

test('E5b: width is given up in order and restored without changing stored widths', async ({ home, env, launch }) => {
  makeRepo(home, env, { 'a.txt': 'fixture\n' });
  const { app, page } = await launch();
  await page.addInitScript(() => localStorage.setItem('filePanelWidth', '450'));
  await page.reload();
  await page.locator('.project-new-btn').first().waitFor();
  await page.evaluate(() => { document.getElementById('sidebar').style.width = '340px'; });
  await openPlainTerminal(page);
  await page.locator('#changes-toggle-btn').click();
  const stored = await page.evaluate(async () => ({ sidebar: (await window.api.getSetting('global'))?.sidebarWidth, panel: localStorage.getItem('filePanelWidth') }));
  for (const step of [
    { width: 1100, zoom: 0, sidebar: 340, panel: 450 },
    { width: 926, zoom: 0, sidebar: 340, panelOffset: 562 },
    { width: 800, zoom: 0, sidebarOffset: 502, panel: 280 },
    { width: 800, zoom: 1, sidebar: 200, panelOffset: 422 },
    { width: 1100, zoom: 0, sidebar: 340, panel: 450 },
  ]) {
    await viewport(app, page, step.width, 600, step.zoom);
    const width = await page.evaluate(() => innerWidth);
    const sidebar = await box(page.locator('#sidebar'));
    const panel = await box(page.locator('#file-panel'));
    expect(Math.abs(sidebar.width - (step.sidebar ?? width - step.sidebarOffset))).toBeLessThanOrEqual(2);
    expect(Math.abs(panel.width - (step.panel ?? width - step.panelOffset))).toBeLessThanOrEqual(2);
    await geometry(page);
  }
  expect(await page.locator('#sidebar').evaluate(el => el.style.width)).toBe('340px');
  expect(await page.evaluate(async () => ({ sidebar: (await window.api.getSetting('global'))?.sidebarWidth, panel: localStorage.getItem('filePanelWidth') }))).toEqual(stored);
});

test('E6: the bar stays below the strip at low, normal and high zoom', async ({ home, launch }) => {
  makePlainDir(home);
  const { app, page } = await launch();
  await openPlainTerminal(page);
  for (const zoom of [-1, 0, 2]) {
    await viewport(app, page, 1400, 900, zoom);
    await geometry(page);
  }
});

test('E7: Changes follows the focused grid card between two working directories', async ({ home, env, launch }) => {
  const a = makeRepo(home, env, { 'a.txt': 'fixture\n' });
  const b = makePlainDir(home);
  execFileSync('git', ['init', '-q'], { cwd: b, env });
  fs.writeFileSync(path.join(a, 'only-a.txt'), 'A\n');
  fs.writeFileSync(path.join(b, 'only-b.txt'), 'B\n');
  const { page } = await launch();
  for (const dir of [a, b]) {
    const id = await page.evaluate(async cwd => {
      const projects = await window.api.getProjects(false);
      const project = projects.find(p => p.projectPath === cwd);
      if (!project) throw new Error('fixture project missing');
      return 'ph-' + window.folderId(project.projectPath);
    }, dir);
    await page.locator('[id="' + id + '"] .project-new-btn').click();
    await page.locator('.popover-option-terminal').click();
    await expect(page.locator('#terminals .terminal-container:not(.panel-terminal)')).toHaveCount(dir === a ? 1 : 2);
  }
  const owners = await page.evaluate(() => [...window._openSessions.keys()]);
  expect(owners).toHaveLength(2);
  await page.evaluate(id => window.showSession(id), owners[0]);
  await page.locator('#grid-toggle-btn').click();
  await page.locator('.grid-card[data-session-id="' + owners[1] + '"]').click();
  await page.locator('#changes-toggle-btn').click();
  await expect(page.locator('.changes-file-row[data-path="only-b.txt"]')).toBeVisible();
  await expect(page.locator('.changes-file-row[data-path="only-a.txt"]')).toHaveCount(0);
});

test('E8: native Tab enters and exits the bar once in both directions', async ({ home, env, launch }) => {
  makeRepo(home, env, { 'a.txt': 'fixture\n' });
  const { page } = await launch();
  await openPlainTerminal(page);
  await page.locator('#changes-toggle-btn').click();
  const last = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('#file-panel button, #file-panel input, #file-panel select, #file-panel textarea, #file-panel [tabindex], #file-panel a[href]')]
      .filter(el => el.tabIndex >= 0 && !el.disabled && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
    const el = controls.at(-1);
    if (!el) throw new Error('panel has no focusable control');
    el.dataset.e8 = 'last';
    el.focus();
    return document.activeElement === el;
  });
  expect(last).toBe(true);
  const stop = page.locator('#tool-bar [tabindex="0"]');
  await page.keyboard.press('Tab');
  await expect(stop).toBeFocused();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement.closest('#tool-bar'))).toBe(false);
  await page.keyboard.press('Shift+Tab');
  await expect(stop).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#file-panel [data-e8="last"]')).toBeFocused();
});
