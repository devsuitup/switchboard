const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

test('busy spinners start paused when the document is unfocused', () => {
  const ctx = setupSidebarDom();
  try {
    assert.equal(ctx.document.hasFocus(), false);
    assert.ok(ctx.document.documentElement.classList.contains('busy-spinners-paused'));
  } finally { ctx.destroy(); }
});

test('busy spinners pause on blur or hidden and resume only when focused and visible', () => {
  const ctx = setupSidebarDom();
  try {
    let focused = true;
    let visibility = 'visible';
    Object.defineProperty(ctx.document, 'hasFocus', { value: () => focused });
    Object.defineProperty(ctx.document, 'visibilityState', { get: () => visibility });
    const paused = () => ctx.document.documentElement.classList.contains('busy-spinners-paused');
    const emit = (target, type) => target.dispatchEvent(new ctx.window.Event(type));

    emit(ctx.window, 'focus');
    assert.equal(paused(), false, 'focused and visible animates');
    focused = false;
    emit(ctx.window, 'blur');
    assert.equal(paused(), true, 'blur pauses immediately');
    focused = true;
    emit(ctx.window, 'focus');
    assert.equal(paused(), false, 'focus resumes immediately');
    visibility = 'hidden';
    emit(ctx.document, 'visibilitychange');
    assert.equal(paused(), true, 'hidden pauses even with focus');
    emit(ctx.window, 'focus');
    assert.equal(paused(), true, 'focus cannot resume a hidden document');
    visibility = 'visible';
    emit(ctx.document, 'visibilitychange');
    assert.equal(paused(), false, 'visible resumes a focused document');
    focused = false;
    emit(ctx.window, 'blur');
    visibility = 'hidden';
    emit(ctx.document, 'visibilitychange');
    visibility = 'visible';
    emit(ctx.document, 'visibilitychange');
    assert.equal(paused(), true, 'visible cannot resume an unfocused document');
    focused = true;
    emit(ctx.window, 'focus');
    assert.equal(paused(), false, 'focus resumes after mixed transitions');
  } finally { ctx.destroy(); }
});

test('pausing animation preserves busy state and newly rendered busy rows', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.activePtyIds.add('spinner');
    ctx.emitHeadTurn('spinner', 'open');
    const projects = [makeSampleProject({ sessions: [{ sessionId: 'spinner', summary: 'Working',
      modified: '2026-10-31T10:00:00.000Z', messageCount: 1 }] })];
    ctx.sidebar.renderProjects(projects, true);
    const iconBefore = ctx.document.querySelector('#si-spinner .session-icon').outerHTML;
    ctx.window.dispatchEvent(new ctx.window.Event('blur'));
    assert.ok(ctx.document.documentElement.classList.contains('busy-spinners-paused'));
    ctx.sidebar.renderProjects(projects, true);
    assert.equal(ctx.document.querySelector('#si-spinner .session-icon').outerHTML, iconBefore);
    assert.ok(ctx.document.querySelector('#si-spinner').classList.contains('cli-busy'));
  } finally { ctx.destroy(); }
});

test('the pause state stops the busy pseudo-element animation without changing its cadence', () => {
  const ctx = setupSidebarDom();
  try {
    const style = ctx.document.createElement('style');
    style.textContent = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
    ctx.document.head.append(style);
    const rules = [...style.sheet.cssRules];
    const pause = rules.find(rule => rule.selectorText === '.busy-spinners-paused .session-icon--busy::before');
    assert.ok(pause, 'the document pause state must target the busy pseudo-element');
    assert.equal(pause.style.getPropertyValue('animation-play-state'), 'paused');
    const busy = rules.find(rule => rule.selectorText === '.session-icon--busy::before');
    assert.equal(busy.style.getPropertyValue('animation'), 'braille-spin 0.8s steps(1) infinite');
  } finally { ctx.destroy(); }
});
