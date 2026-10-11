'use strict';

const { test, expect, makeRepo } = require('./fixtures');

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
  await row.locator('.session-summary').dblclick();
  const input = row.locator('.session-rename-input');
  await input.click();
  await page.mouse.move(0, 0);
  await expect(input).toBeFocused();
  await expect.poll(() => row.locator('.session-actions').evaluate(actions =>
    Number(getComputedStyle(actions).opacity))).toBe(0);
  expect(await row.evaluate(element => element.matches(':hover'))).toBe(false);
});
