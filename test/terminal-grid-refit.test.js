'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setupSidebarDom } = require('./dom-setup');

function setup(t) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const { window, document } = ctx;
  const frames = new Map();
  const timers = new Map();
  let id = 0;
  let now = 0;
  window.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
  window.cancelAnimationFrame = key => frames.delete(key);
  window.setTimeout = (callback, delay) => { timers.set(++id, { callback, at: now + delay }); return id; };
  window.clearTimeout = key => timers.delete(key);
  window.terminalsEl = document.getElementById('terminals');
  window.terminalsEl.getBoundingClientRect = () => rect(0, 0, 600, 400);
  window.gridViewActive = true;
  window.ResizeObserver = class { observe() {} };
  window.MutationObserver = class { observe() {} };
  let intersection;
  let thresholds;
  window.IntersectionObserver = class {
    constructor(callback, options) { intersection = callback; thresholds = options.threshold; }
    observe() {}
    unobserve() {}
  };
  ctx.evalPublic('shortcuts.js');
  ctx.evalPublic('terminal-manager.js');
  ctx.evalPublic('grid-view.js');
  window.initGridObservers();
  const appPath = path.resolve(__dirname, '../public/app.js');
  const source = fs.readFileSync(appPath, 'utf8');
  const start = source.indexOf('// --- Terminal geometry re-sync ---');
  const end = source.indexOf('// --- Tab switching ---', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), ctx.context, { filename: appPath });
  function flushFrames() {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback();
  }
  function tick(ms) {
    now += ms;
    for (const [key, timer] of [...timers]) {
      if (timer.at <= now) { timers.delete(key); timer.callback(); }
    }
    flushFrames();
  }
  function card(sid, bounds) {
    const el = document.createElement('div');
    el.className = 'grid-card';
    el.dataset.sessionId = sid;
    const element = document.createElement('div');
    el.append(element);
    window.terminalsEl.append(el);
    const calls = { fits: 0, repaints: 0, clears: 0 };
    const entry = {
      session: { sessionId: sid }, element,
      fitAddon: { proposeDimensions: () => undefined, fit: () => calls.fits++ },
      terminal: {
        rows: 24, buffer: { active: { viewportY: 0, baseY: 0 } },
        refresh: () => calls.repaints++, scrollToBottom() {},
      },
      webglAddon: { clearTextureAtlas: () => calls.clears++, dispose() {} },
    };
    el.getBoundingClientRect = () => bounds;
    element.getBoundingClientRect = () => bounds;
    Object.defineProperty(element, 'clientHeight', { get: () => bounds.height });
    window.openSessions.set(sid, entry);
    ctx.read('gridCards').set(sid, el);
    return { entry, el, calls, move: next => { bounds = next; } };
  }
  let previousThreshold = -1;
  let previousIntersection = false;
  return { ...ctx, card, tick, flushFrames,
    intersect: (card, visible) => intersection([{
      target: card.el, isIntersecting: visible, intersectionRatio: visible ? 1 : 0,
    }]),
    cross: (card, ratio, isIntersecting) => {
      const index = thresholds.filter(threshold => threshold <= ratio).length;
      if (index !== previousThreshold || isIntersecting !== previousIntersection) {
        intersection([{ target: card.el, isIntersecting, intersectionRatio: ratio }]);
      }
      previousThreshold = index;
      previousIntersection = isIntersecting;
    },
    emit: type => window.dispatchEvent(new window.Event(type)),
  };
}

function rect(left, top, width, height) {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

test('a resize burst waits for the shared container debounce and fits once', t => {
  const h = setup(t);
  const visible = h.card('visible', rect(0, 0, 250, 200));
  const delay = h.read('CONTAINER_RESIZE_DEBOUNCE_MS');
  for (let i = 0; i < 5; i++) { h.emit('resize'); h.tick(delay - 1); }
  assert.equal(visible.calls.fits, 0, 'no fit until the last resize settles');
  h.tick(1);
  assert.deepEqual(visible.calls, { fits: 1, repaints: 1, clears: 1 });
});

test('focus repaints only cards intersecting the grid scroll viewport', t => {
  const h = setup(t);
  const visible = h.card('visible', rect(0, 0, 250, 200));
  const partial = h.card('partial', rect(0, 399, 250, 200));
  const below = h.card('below', rect(0, 400, 250, 200));
  const right = h.card('right', rect(600, 0, 250, 200));
  const hidden = h.card('hidden', rect(0, 0, 0, 0));
  const detached = h.card('detached', rect(0, 0, 250, 200));
  detached.el.remove();
  h.emit('focus');
  h.flushFrames();
  assert.equal(visible.calls.repaints, 1);
  assert.equal(partial.calls.repaints, 1);
  for (const card of [below, right, hidden, detached]) {
    assert.deepEqual(card.calls, { fits: 0, repaints: 0, clears: 0 });
  }
});

test('a card scrolled into view is fitted and repainted by the grid observer', t => {
  const h = setup(t);
  const card = h.card('scroll', rect(0, 600, 250, 200));
  h.intersect(card, false);
  h.flushFrames();
  assert.equal(card.calls.fits, 0);
  card.move(rect(0, 100, 250, 200));
  h.window.restoreTerminalWebgl = () => {};
  h.intersect(card, true);
  h.flushFrames();
  assert.equal(card.calls.fits, 1, 'entering the viewport refits stale geometry');
  assert.equal(card.calls.repaints, 1);
});

test('visibility return repaints visible cards but hiding the document does no work', t => {
  const h = setup(t);
  const visible = h.card('visible', rect(0, 0, 250, 200));
  const hidden = h.card('hidden', rect(0, 500, 250, 200));
  Object.defineProperty(h.document, 'hidden', { configurable: true, value: true });
  h.document.dispatchEvent(new h.window.Event('visibilitychange'));
  h.flushFrames();
  assert.equal(visible.calls.repaints, 0);
  Object.defineProperty(h.document, 'hidden', { configurable: true, value: false });
  h.document.dispatchEvent(new h.window.Event('visibilitychange'));
  h.flushFrames();
  assert.equal(visible.calls.repaints, 1);
  assert.equal(hidden.calls.repaints, 0);
});

test('scrolling beyond an intersecting zero-area edge fits a partially visible card', t => {
  const h = setup(t);
  const card = h.card('edge', rect(0, 400, 250, 200));
  h.window.restoreTerminalWebgl = () => {};
  h.cross(card, 0, true);
  h.flushFrames();
  assert.equal(card.calls.fits, 0, 'a touching edge has no visible area');
  card.move(rect(0, 398, 250, 200));
  h.cross(card, 0.01, true);
  h.flushFrames();
  assert.equal(card.calls.fits, 1, 'positive intersection must notify before 99% visibility');
});

test('a queued grid fit skips a card that leaves view before the animation frame', t => {
  const h = setup(t);
  const card = h.card('leaving', rect(0, 0, 250, 200));
  h.emit('focus');
  card.move(rect(0, 500, 250, 200));
  h.flushFrames();
  assert.deepEqual(card.calls, { fits: 0, repaints: 0, clears: 0 });
});
