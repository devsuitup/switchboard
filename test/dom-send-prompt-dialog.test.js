'use strict';

// The "Send a prompt…" dialog (issue #219): it sends {alias, sessionId, text}
// through window.api.remoteSendPrompt, never a socket path, says "Sent" and
// never "delivered", and keeps the text when the send fails.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION = { sessionId: 'remote-9', remoteAlias: 'planificator', summary: 'remote work' };
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(sendResult) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const calls = [];
  window.api = { remoteSendPrompt: (...args) => { calls.push(args); return Promise.resolve(sendResult); } };
  const stubs = { cachedProjects: [], cachedAllProjects: [], sessionMap: new Map(), launchNewSession() {}, openSession() {}, refreshSidebar() {}, pollActiveSessions() {} };
  for (const [k, v] of Object.entries(stubs)) {
    Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  }
  for (const f of ['setting-defaults.js', 'utils.js', 'dialogs.js']) {
    const file = path.join(PUBLIC_DIR, f);
    vm.runInContext(fs.readFileSync(file, 'utf8'), dom.getInternalVMContext(), { filename: file });
  }
  return { window, document: window.document, calls, destroy() { window.close(); } };
}

test('the dialog names the host, sends {alias, sessionId, text} and reports "Sent"', async () => {
  const ctx = setup({ ok: true });
  try {
    ctx.window.showSendPromptDialog(SESSION);
    const dialog = ctx.document.querySelector('.new-session-dialog');
    assert.ok(dialog);
    assert.match(dialog.querySelector('h3').textContent, /planificator/);
    const textarea = dialog.querySelector('textarea');
    textarea.value = '  fix the build\nthen stop  ';
    dialog.querySelector('.send-prompt-send-btn').click();
    await tick();
    assert.deepEqual(ctx.calls, [['planificator', 'remote-9', '  fix the build\nthen stop  ']]);
    const status = dialog.querySelector('.send-prompt-status').textContent;
    assert.match(status, /Sent/);
    assert.doesNotMatch(status, /deliver/i);
  } finally { ctx.destroy(); }
});

test('an empty text sends nothing', async () => {
  const ctx = setup({ ok: true });
  try {
    ctx.window.showSendPromptDialog(SESSION);
    const dialog = ctx.document.querySelector('.new-session-dialog');
    dialog.querySelector('textarea').value = '   \n';
    dialog.querySelector('.send-prompt-send-btn').click();
    await tick();
    assert.equal(ctx.calls.length, 0);
  } finally { ctx.destroy(); }
});

test('a refusal shows the reason and keeps the text for a retry', async () => {
  const ctx = setup({ ok: false, error: 'the messaging socket is gone' });
  try {
    ctx.window.showSendPromptDialog(SESSION);
    const dialog = ctx.document.querySelector('.new-session-dialog');
    const textarea = dialog.querySelector('textarea');
    textarea.value = 'keep me';
    const btn = dialog.querySelector('.send-prompt-send-btn');
    btn.click();
    await tick();
    const status = dialog.querySelector('.send-prompt-status').textContent;
    assert.match(status, /messaging socket is gone/);
    assert.doesNotMatch(status, /Sent/);
    assert.equal(textarea.value, 'keep me');
    assert.equal(btn.disabled, false, 'the user can retry');
  } finally { ctx.destroy(); }
});

test('a session without a session id is sent as is and the main-side refusal is shown', async () => {
  const ctx = setup({ ok: false, error: 'invalid request' });
  try {
    ctx.window.showSendPromptDialog({ remoteAlias: 'planificator' });
    const dialog = ctx.document.querySelector('.new-session-dialog');
    dialog.querySelector('textarea').value = 'x';
    dialog.querySelector('.send-prompt-send-btn').click();
    await tick();
    assert.deepEqual(ctx.calls, [['planificator', undefined, 'x']]);
    assert.match(dialog.querySelector('.send-prompt-status').textContent, /invalid request/);
  } finally { ctx.destroy(); }
});

test('focus stays in the dialog: the overlay is focusable and a click inside returns focus to the textarea, so Escape works', () => {
  const ctx = setup({ ok: true });
  try {
    ctx.window.showSendPromptDialog(SESSION);
    const overlay = ctx.document.querySelector('.new-session-overlay');
    const textarea = ctx.document.querySelector('textarea');
    assert.equal(overlay.getAttribute('tabindex'), '-1');
    assert.equal(ctx.document.activeElement, textarea, 'focused on open');
    textarea.blur();
    assert.notEqual(ctx.document.activeElement, textarea);
    ctx.document.querySelector('.new-session-dialog h3').click();
    assert.equal(ctx.document.activeElement, textarea, 'focus comes back after a click on non-input text');
    overlay.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(ctx.document.querySelector('.new-session-overlay'), null);
  } finally { ctx.destroy(); }
});

test('Cancel and Escape close the dialog without sending', () => {
  const ctx = setup({ ok: true });
  try {
    ctx.window.showSendPromptDialog(SESSION);
    ctx.document.querySelector('.new-session-cancel-btn').click();
    assert.equal(ctx.document.querySelector('.new-session-overlay'), null);
    ctx.window.showSendPromptDialog(SESSION);
    ctx.document.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.notEqual(ctx.document.querySelector('.new-session-overlay'), null, 'an Escape aimed elsewhere does not close it');
    ctx.document.querySelector('textarea').dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(ctx.document.querySelector('.new-session-overlay'), null);
    assert.equal(ctx.calls.length, 0);
  } finally { ctx.destroy(); }
});

test('Ctrl+Enter in the textarea sends', async () => {
  const ctx = setup({ ok: true });
  try {
    ctx.window.showSendPromptDialog(SESSION);
    const textarea = ctx.document.querySelector('textarea');
    textarea.value = 'go';
    textarea.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await tick();
    assert.equal(ctx.calls.length, 1);
  } finally { ctx.destroy(); }
});

test('a rejected send shows its message instead of throwing', async () => {
  const ctx = setup({ ok: true });
  try {
    ctx.window.api.remoteSendPrompt = () => Promise.reject(new Error('ipc down'));
    ctx.window.showSendPromptDialog(SESSION);
    const dialog = ctx.document.querySelector('.new-session-dialog');
    dialog.querySelector('textarea').value = 'x';
    dialog.querySelector('.send-prompt-send-btn').click();
    await tick();
    assert.match(dialog.querySelector('.send-prompt-status').textContent, /ipc down/);
  } finally { ctx.destroy(); }
});

test('the host name and the error are not rendered as HTML', async () => {
  const ctx = setup({ ok: false, error: '<img src=x onerror=alert(1)>' });
  try {
    ctx.window.showSendPromptDialog({ ...SESSION, remoteAlias: 'h<b>x</b>' });
    const dialog = ctx.document.querySelector('.new-session-dialog');
    assert.equal(dialog.querySelector('h3 b'), null);
    dialog.querySelector('textarea').value = 'x';
    dialog.querySelector('.send-prompt-send-btn').click();
    await tick();
    assert.equal(dialog.querySelector('.send-prompt-status img'), null);
  } finally { ctx.destroy(); }
});
