'use strict';

const { test, expect, makeRepo, openPlainTerminal } = require('./fixtures');

test('keyboard Configure focuses the selected mode, Escape returns to + and one Enter starts New Session', async ({ home, env, launch }) => {
  makeRepo(home, env, { 'focus.txt': 'keyboard fixture\n' });
  const { app, page } = await launch();
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('get-effective-settings');
    ipcMain.handle('get-effective-settings', () => ({ permissionMode: 'acceptEdits' }));
    globalThis.newSessionLaunches = [];
    ipcMain.removeHandler('open-terminal');
    ipcMain.handle('open-terminal', (_event, id, projectPath, isNew, options) => {
      globalThis.newSessionLaunches.push({ id, projectPath, isNew, options });
      return { ok: true };
    });
  });
  const opener = page.locator('.project-header .project-new-btn').first();
  await opener.focus();
  await page.keyboard.press('Space');
  const configure = page.locator('.new-session-popover').getByRole('menuitem').nth(1);
  await page.keyboard.press('ArrowDown');
  await expect(configure).toBeFocused();
  await page.keyboard.press('Enter');
  const dialog = page.locator('.new-session-dialog');
  await expect(dialog.locator('[data-mode="acceptEdits"]')).toBeFocused();
  await expect(page.locator('.new-session-popover')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(dialog.locator('[data-mode="acceptEdits"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('#terminals .terminal-container.visible .xterm-helper-textarea')).toBeFocused();
  const launches = await app.evaluate(() => globalThis.newSessionLaunches);
  expect(launches).toHaveLength(1);
  expect(launches[0].isNew).toBe(true);
  expect(launches[0].options.permissionMode).toBe('acceptEdits');
});

test('F6 leaves a plain terminal and Shift+F6 returns to it', async ({ home, env, launch }) => {
  makeRepo(home, env, { 'readme.txt': 'fixture\n' });
  const { page } = await launch();
  await openPlainTerminal(page);
  await page.locator('#terminals .xterm-screen').first().click();
  expect(await page.evaluate(() => !!document.activeElement?.closest('.xterm'))).toBe(true);
  await page.keyboard.press('F6');
  expect(await page.evaluate(() => !!document.activeElement?.closest('.xterm'))).toBe(false);
  expect(await page.evaluate(() => !!document.activeElement?.closest('#sidebar'))).toBe(true);
  await page.keyboard.press('Shift+F6');
  expect(await page.evaluate(() => !!document.activeElement?.closest('.xterm'))).toBe(true);
  await page.evaluate(() => { window.showChoiceDialog({ title: 'Focus guard' }); });
  const confirm = page.locator('.choice-dialog-confirm');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('F6');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Shift+F6');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Escape');
});

test('the project New session menu launches Terminal with the keyboard and Escape returns to +', async ({ home, env, launch }) => {
  makeRepo(home, env, { 'readme.txt': 'fixture\n' });
  const { page } = await launch();
  const opener = page.locator('.project-header .project-new-btn').first();
  await opener.focus();
  await page.keyboard.press('Enter');
  const menu = page.locator('.new-session-popover');
  const items = menu.getByRole('menuitem');
  await expect(items.first()).toBeFocused();
  await expect(opener).toHaveAttribute('aria-expanded', 'true');
  await menu.click({ position: { x: 2, y: 2 } });
  await expect(menu).toBeVisible();
  await items.first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(2)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(page.locator('#terminals .xterm-screen').first()).toBeVisible();
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(opener).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const cancel = page.locator('.new-session-overlay .new-session-cancel-btn');
  await cancel.focus();
  await page.keyboard.press('F6');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Shift+F6');
  await expect(cancel).toBeFocused();
  await cancel.click();
});

test('Tab and Shift+Tab leave the New session menu through the opener native tab order', async ({ home, env, launch }) => {
  makeRepo(home, env, { 'readme.txt': 'fixture\n' });
  const { page } = await launch();
  const opener = page.locator('.project-header .project-new-btn').first();
  const menu = page.locator('.new-session-popover');
  for (const key of ['Tab', 'Shift+Tab']) {
    await opener.focus();
    await page.keyboard.press(key);
    const destination = await page.evaluateHandle(() => document.activeElement);
    expect(await destination.evaluate(element => element !== document.body && element !== document.documentElement)).toBe(true);
    for (const index of [0, 2]) {
      await opener.focus();
      await page.keyboard.press('Enter');
      await expect(menu.getByRole('menuitem').first()).toBeFocused();
      await expect(opener).toHaveAttribute('aria-expanded', 'true');
      await menu.getByRole('menuitem').nth(index).focus();
      await page.keyboard.press(key);
      await expect(menu).toHaveCount(0);
      await expect(opener).toHaveAttribute('aria-expanded', 'false');
      await expect.poll(() => destination.evaluate(element => element === document.activeElement)).toBe(true);
    }
    await destination.dispose();
  }
});

test('Tab reveals a session-row Archive button and its focus outline', async ({ home, env, launch }) => {
  makeRepo(home, env, { 'readme.txt': 'fixture\n' });
  const { page } = await launch();
  const archive = page.locator('#sidebar .session-item .session-archive-btn').first();
  await archive.waitFor();
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.activeElement?.blur());

  let reached = false;
  for (let i = 0; i < 60 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await archive.evaluate(button => button === document.activeElement);
  }
  expect(reached, 'Tab reaches the row Archive button').toBe(true);

  await expect.poll(() => archive.evaluate(button => {
    for (let element = button; element; element = element.parentElement) {
      if (element.getAnimations().some(animation => animation.playState === 'running')) return false;
    }
    return true;
  }), { message: 'Focus and opacity transitions have settled' }).toBe(true);

  const focused = await archive.evaluate(button => {
    let opacity = 1;
    for (let element = button; element; element = element.parentElement) {
      opacity *= Number(getComputedStyle(element).opacity);
    }
    const style = getComputedStyle(button);
    return {
      focused: button === document.activeElement,
      hoveredRow: button.closest('.session-item').matches(':hover'),
      opacity,
      outlineStyle: style.outlineStyle,
      outlineWidth: parseFloat(style.outlineWidth),
      outlineColor: style.outlineColor,
    };
  });
  expect(focused.focused).toBe(true);
  expect(focused.hoveredRow, 'The mouse does not reveal the actions').toBe(false);
  expect(focused.opacity).toBe(1);
  expect(focused.outlineStyle).not.toBe('none');
  expect(focused.outlineWidth).toBeGreaterThan(0);
  expect(focused.outlineColor).not.toMatch(/^(transparent|rgba\(.*,[\s]*0\))$/);
});

test('Clicking a rename input does not reveal session-row actions after the pointer leaves', async ({ home, env, launch }) => {
  makeRepo(home, env, { 'readme.txt': 'fixture\n' });
  const { page } = await launch();
  const row = page.locator('#sidebar .session-item').first();
  await row.evaluate(element => { element.onclick = null; });
  await row.locator('.session-summary').dispatchEvent('dblclick');
  const input = row.locator('.session-rename-input');
  await input.focus();
  await page.mouse.move(0, 0);
  await expect(input).toBeFocused();
  await expect.poll(() => row.locator('.session-actions').evaluate(actions =>
    Number(getComputedStyle(actions).opacity))).toBe(0);
  expect(await row.evaluate(element => element.matches(':hover'))).toBe(false);
});
