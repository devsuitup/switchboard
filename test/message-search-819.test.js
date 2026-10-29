'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setupSidebarDom } = require('./dom-setup');

function setup() {
  const ctx = setupSidebarDom();
  ctx.evalPublic('jsonl-viewer.js');
  const file = path.join(__dirname, '../public/message-search.js');
  if (fs.existsSync(file)) ctx.evalPublic('message-search.js');
  const viewer = ctx.document.createElement('div');
  viewer.id = 'jsonl-viewer';
  const body = ctx.document.createElement('div');
  body.id = 'jsonl-viewer-body';
  body.tabIndex = 0;
  body.innerHTML = '<div class="jsonl-entry">Alpha <b>beta</b> alpha</div><div class="jsonl-entry"><div class="jsonl-toggle">Output</div><pre class="jsonl-tool-body" style="display:none">ALPHA beta</pre></div>';
  viewer.append(body);
  ctx.document.body.append(viewer);
  ctx.window.CSS = { highlights: new Map() };
  ctx.window.Highlight = class extends Set { constructor(...ranges) { super(ranges); } };
  ctx.window.Range.prototype.getBoundingClientRect = () => ({ top: 20 });
  body.scrollBy = () => {};
  return { ctx, viewer, body };
}

function key(ctx, element, value, extra = {}) {
  const event = new ctx.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra });
  element.dispatchEvent(event);
  return event;
}

function searchFor(ctx, viewer, body, query = 'alpha') {
  ctx.window.createMessageSearch(viewer, body).open();
  const input = viewer.querySelector('input');
  input.value = query;
  input.dispatchEvent(new ctx.window.Event('input'));
  key(ctx, input, 'Enter');
  return input;
}

function refreshAfter(ctx, viewer, change) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Search counter did not refresh')); }, 2000);
    const observer = new ctx.window.MutationObserver(() => {
      clearTimeout(timer);
      observer.disconnect();
      resolve();
    });
    observer.observe(viewer.querySelector('.terminal-search-count'), { childList: true });
    change();
  });
}

test('streaming and expansion keep the active range without scrolling; replacement keeps the nearest index', async () => {
  const { ctx, viewer, body } = setup();
  try {
    const input = searchFor(ctx, viewer, body);
    key(ctx, input, 'Enter');
    let scrolls = 0;
    body.scrollBy = () => { scrolls++; };
    const before = [...ctx.window.CSS.highlights.get('message-find-active')][0];
    await refreshAfter(ctx, viewer, () => body.insertAdjacentHTML('beforeend', '<div class="jsonl-entry">alpha</div>'));
    assert.equal(viewer.querySelector('.terminal-search-count').textContent, '2 of 4');
    await refreshAfter(ctx, viewer, () => body.insertAdjacentHTML('afterbegin', '<div class="jsonl-entry">alpha</div>'));
    assert.equal(viewer.querySelector('.terminal-search-count').textContent, '3 of 5');
    const after = [...ctx.window.CSS.highlights.get('message-find-active')][0];
    assert.equal(after.startContainer, before.startContainer);
    assert.equal(after.startOffset, before.startOffset);
    await refreshAfter(ctx, viewer, () => body.querySelector('.jsonl-tool-body').append(ctx.document.createElement('span')));
    assert.equal(viewer.querySelector('.terminal-search-count').textContent, '3 of 5');
    await refreshAfter(ctx, viewer, () => body.innerHTML = '<div class="jsonl-entry">alpha alpha alpha alpha</div>');
    assert.equal(viewer.querySelector('.terminal-search-count').textContent, '3 of 4');
    await refreshAfter(ctx, viewer, () => body.innerHTML = '<div class="jsonl-entry">alpha alpha</div>');
    assert.equal(viewer.querySelector('.terminal-search-count').textContent, '2 of 2');
    assert.equal(scrolls, 0, 'observer refresh never scrolls');
    input.value = 'alpha alpha';
    input.dispatchEvent(new ctx.window.Event('input'));
    key(ctx, input, 'Enter');
    assert.equal(viewer.querySelector('.terminal-search-count').textContent, '1 of 1');
    assert.equal(scrolls, 1, 'a new query navigates');
  } finally { ctx.destroy(); }
});

test('message search caps StaticRange highlights at 10000 and counts the cap visibly', () => {
  const { ctx, viewer, body } = setup();
  try {
    body.innerHTML = '<div class="jsonl-entry">' + 'alpha '.repeat(10001) + '</div>';
    searchFor(ctx, viewer, body);
    const ranges = ctx.window.CSS.highlights.get('message-find');
    assert.equal(ranges.size, 10000);
    assert.ok([...ranges].every(range => range instanceof ctx.window.StaticRange));
    assert.equal(viewer.querySelector('.terminal-search-count').textContent, '1 of 10000+');
    viewer.querySelector('.terminal-search-prev').click();
    assert.equal(viewer.querySelector('.terminal-search-count').textContent, '10000 of 10000+');
  } finally { ctx.destroy(); }
});

test('configured shortcuts take precedence over message Find', () => {
  const { ctx, viewer, body } = setup();
  try {
    ctx.evalPublic('shortcuts.js');
    ctx.window.appShortcuts = { gridToggle: { primary: true, shift: false, alt: false, key: 'f' } };
    ctx.window.createMessageSearch(viewer, body);
    body.focus();
    assert.equal(key(ctx, body, 'f', { ctrlKey: true }).defaultPrevented, false);
    assert.equal(viewer.querySelector('.message-search-bar').style.display, 'none');
    ctx.window.appShortcuts = {};
    assert.equal(key(ctx, body, 'f', { ctrlKey: true }).defaultPrevented, true);
  } finally { ctx.destroy(); }
});

test('reopening Find with an unchanged query keeps the current match without scrolling', () => {
  const { ctx, viewer, body } = setup();
  try {
    const input = searchFor(ctx, viewer, body);
    key(ctx, input, 'Enter');
    let scrolls = 0;
    body.scrollBy = () => { scrolls++; };
    key(ctx, input, 'f', { ctrlKey: true });
    assert.equal(viewer.querySelector('.terminal-search-count').textContent, '2 of 3');
    assert.equal(scrolls, 0);
  } finally { ctx.destroy(); }
});

test('message search owns Ctrl+F only in its focused viewer, counts literal matches and wraps navigation', () => {
  const { ctx, viewer, body } = setup();
  try {
    assert.equal(typeof ctx.window.createMessageSearch, 'function', 'message search is shipped');
    ctx.window.createMessageSearch(viewer, body);
    assert.equal(key(ctx, ctx.document.body, 'f', { ctrlKey: true }).defaultPrevented, false);
    assert.equal(key(ctx, body, 'f', { ctrlKey: true }).defaultPrevented, false, 'an unfocused viewer cannot claim Find');
    body.focus();
    assert.equal(key(ctx, body, 'f', { ctrlKey: true }).defaultPrevented, true);
    const input = viewer.querySelector('input');
    const counter = viewer.querySelector('.terminal-search-count');
    assert.equal(ctx.document.activeElement, input);
    input.value = 'alpha';
    input.dispatchEvent(new ctx.window.Event('input'));
    key(ctx, input, 'Enter');
    assert.equal(counter.textContent, '1 of 3');
    key(ctx, input, 'Enter', { shiftKey: true });
    assert.equal(counter.textContent, '3 of 3');
    assert.equal(body.querySelector('.jsonl-tool-body').style.display, '');
    viewer.querySelector('.terminal-search-next').click();
    assert.equal(counter.textContent, '1 of 3');
    viewer.querySelector('.terminal-search-prev').click();
    assert.equal(counter.textContent, '3 of 3');
    input.value = 'Alpha beta';
    input.dispatchEvent(new ctx.window.Event('input'));
    key(ctx, input, 'Enter');
    assert.equal(counter.textContent, '1 of 2', 'matches cross inline markup');
    input.value = '[';
    input.dispatchEvent(new ctx.window.Event('input'));
    key(ctx, input, 'Enter');
    assert.equal(counter.textContent, 'No results', 'query is literal');
    key(ctx, input, 'Escape');
    assert.equal(viewer.querySelector('.message-search-bar').style.display, 'none');
    assert.equal(ctx.document.activeElement, body);
    assert.equal(ctx.window.CSS.highlights.size, 0);
    viewer.style.display = 'none';
    assert.equal(key(ctx, body, 'f', { ctrlKey: true }).defaultPrevented, false);
  } finally { ctx.destroy(); }
});

test('showing messages initializes focused search and hiding the viewer clears it', async () => {
  const { ctx, viewer, body } = setup();
  try {
    Object.assign(ctx.window, { jsonlViewer: viewer, jsonlViewerBody: body, jsonlViewerTitle: ctx.document.createElement('span'),
      jsonlViewerSessionId: ctx.document.createElement('span'), terminalArea: ctx.document.createElement('div'), placeholder: ctx.document.createElement('div'),
      statsViewer: ctx.document.createElement('div'), memoryViewer: ctx.document.createElement('div'), workFilesViewer: ctx.document.createElement('div'), settingsViewer: ctx.document.createElement('div') });
    ctx.evalPublic('memory-workfiles-view.js');
    ctx.window.api.readSessionJsonl = async () => ({ entries: [{ type: 'assistant', message: { content: [{ type: 'text', text: 'alpha' }] } }] });
    await ctx.window.showJsonlViewer({ sessionId: 'one' });
    assert.equal(ctx.document.activeElement, body, 'message viewer receives focus');
    key(ctx, body, 'f', { ctrlKey: true });
    assert.ok(viewer.querySelector('.message-search-bar'), 'viewer wires search');
    ctx.window.hideAllViewers();
    assert.equal(viewer.querySelector('.message-search-bar').style.display, 'none');
    assert.equal(ctx.window.CSS.highlights.size, 0);
  } finally { ctx.destroy(); }
});
