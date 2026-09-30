// The What's new dialog and its markdown renderer — see docs/changelog.md.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const { renderChangelogMarkdown, showWhatsNew, initWhatsNew } = require('../public/whats-new');

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function makeDom() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only' });
  const utils = path.join(ROOT, 'public', 'utils.js');
  vm.runInContext(fs.readFileSync(utils, 'utf8'), dom.getInternalVMContext(), { filename: utils });
  return { doc: dom.window.document, window: dom.window, escape: dom.window.escapeHtml };
}

function fakeApi(startupPayload = null) {
  const calls = { dismissed: 0, opened: [] };
  const api = {
    whatsNewStartup: async () => startupPayload,
    whatsNewDismissed: async () => { calls.dismissed++; },
    openExternal: async (url) => { calls.opened.push(url); },
    onShowWhatsNew: (cb) => { api._show = cb; },
  };
  return { api, calls };
}

const PAYLOAD = {
  version: '0.0.86',
  sections: [
    { version: '0.0.86', date: '2026-10-02', body: '### New\n- Eighty-six. (#2)' },
    { version: '0.0.85', date: '2026-10-01', body: '### Fixed\n- Eighty-five. (#1)' },
  ],
};

function render(md) {
  return renderChangelogMarkdown(md, makeDom().escape);
}

test('a third-level heading becomes a group title', () => {
  assert.equal(render('### New'), '<h4>New</h4>');
});

test('bullets become one list, and an indented line continues its item', () => {
  assert.equal(render('- One.\n  Still one.\n- Two.'), '<ul><li>One. Still one.</li><li>Two.</li></ul>');
});

test('a blank line ends a list, and plain lines form a paragraph', () => {
  assert.equal(render('- One.\n\nA line\nand another.'), '<ul><li>One.</li></ul><p>A line and another.</p>');
});

test('a blank line separates two paragraphs', () => {
  assert.equal(render('A.\n\nB.'), '<p>A.</p><p>B.</p>');
});

test('bold, inline code and https links are rendered', () => {
  assert.equal(
    render('- **Bold** and `code` and [Releases](https://github.com/devsuitup/switchboard/releases).'),
    '<ul><li><strong>Bold</strong> and <code>code</code> and '
      + '<a href="https://github.com/devsuitup/switchboard/releases" class="whats-new-link">Releases</a>.</li></ul>',
  );
});

test('raw HTML in the changelog is shown as text, never parsed', () => {
  const html = render('- <img src=x onerror="alert(1)"> & <script>alert(2)</script>');
  assert.equal(html, '<ul><li>&lt;img src=x onerror="alert(1)"&gt; &amp; &lt;script&gt;alert(2)&lt;/script&gt;</li></ul>');
  const { doc } = makeDom();
  doc.body.innerHTML = html;
  assert.equal(doc.querySelector('img, script'), null);
});

test('markup inside inline code stays literal and escaped', () => {
  assert.equal(render('`**x** <b>`'), '<p><code>**x** &lt;b&gt;</code></p>');
});

test('a link whose URL tries to leave the attribute is not a link', () => {
  const { doc, escape } = makeDom();
  doc.body.innerHTML = renderChangelogMarkdown('[x](https://a.example/"onmouseover="x)', escape);
  const a = doc.querySelector('a');
  assert.ok(!a || !a.hasAttribute('onmouseover'), 'the URL broke out of href');
  assert.equal(doc.querySelector('[onmouseover]'), null);
});

test('only http and https URLs become links', () => {
  assert.equal(render('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>');
  assert.equal(render('[x](file:///etc/passwd)'), '<p>[x](file:///etc/passwd)</p>');
});

test('the dialog lists every section given, newest first, each under its version and date', () => {
  const { doc, escape } = makeDom();
  const { api } = fakeApi();
  showWhatsNew(doc, api, escape, PAYLOAD);
  const overlay = doc.querySelector('.whats-new-overlay');
  assert.ok(overlay);
  const dialog = overlay.querySelector('.whats-new-dialog');
  assert.equal(dialog.getAttribute('role'), 'dialog');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.deepEqual([...dialog.querySelectorAll('.whats-new-section h3')].map((h) => h.textContent),
    ['v0.0.86 — 2026-10-02', 'v0.0.85 — 2026-10-01']);
  assert.match(dialog.querySelector('.whats-new-body').innerHTML, /Eighty-six[\s\S]*Eighty-five/);
});

test('a section heading is escaped too: the dialog does not trust what crosses the IPC', () => {
  const { doc, escape } = makeDom();
  showWhatsNew(doc, fakeApi().api, escape, { version: '1', sections: [
    { version: '<img src=x>', date: '<b>d</b>', body: '' },
  ] });
  const heading = doc.querySelector('.whats-new-section h3');
  assert.equal(heading.textContent, 'v<img src=x> — <b>d</b>');
  assert.equal(heading.querySelector('img, b'), null);
});

test('the close button closes the dialog and records it as seen, once', () => {
  const { doc, escape } = makeDom();
  const { api, calls } = fakeApi();
  showWhatsNew(doc, api, escape, PAYLOAD);
  const close = doc.querySelector('.whats-new-close');
  assert.equal(close.getAttribute('aria-label'), 'Close');
  close.click();
  assert.equal(doc.querySelector('.whats-new-overlay'), null);
  assert.equal(calls.dismissed, 1);
});

test('Escape closes the dialog, and a later Escape does nothing more', () => {
  const { doc, escape, window } = makeDom();
  const { api, calls } = fakeApi();
  showWhatsNew(doc, api, escape, PAYLOAD);
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(doc.querySelector('.whats-new-overlay'), null);
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(calls.dismissed, 1);
});

test('the Escape that closes the dialog does not also reach the element behind it', () => {
  const { doc, escape, window } = makeDom();
  const terminal = doc.createElement('textarea');
  doc.body.appendChild(terminal);
  let reached = 0;
  terminal.addEventListener('keydown', () => { reached++; });
  showWhatsNew(doc, fakeApi().api, escape, PAYLOAD);
  terminal.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(doc.querySelector('.whats-new-overlay'), null);
  assert.equal(reached, 0);
});

test('another key leaves the dialog open', () => {
  const { doc, escape, window } = makeDom();
  const { api, calls } = fakeApi();
  showWhatsNew(doc, api, escape, PAYLOAD);
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.ok(doc.querySelector('.whats-new-overlay'));
  assert.equal(calls.dismissed, 0);
});

test('a click on the backdrop closes the dialog; a click inside it does not', () => {
  const { doc, escape } = makeDom();
  const { api, calls } = fakeApi();
  showWhatsNew(doc, api, escape, PAYLOAD);
  doc.querySelector('.whats-new-body').click();
  assert.ok(doc.querySelector('.whats-new-overlay'));
  doc.querySelector('.whats-new-overlay').click();
  assert.equal(doc.querySelector('.whats-new-overlay'), null);
  assert.equal(calls.dismissed, 1);
});

test('the dialog takes the focus, so keys do not reach a terminal behind it', () => {
  const { doc, escape } = makeDom();
  showWhatsNew(doc, fakeApi().api, escape, PAYLOAD);
  assert.equal(doc.activeElement, doc.querySelector('.whats-new-close'));
});

test('a link opens in the browser through the main process, not in the window', () => {
  const { doc, escape, window } = makeDom();
  const { api, calls } = fakeApi();
  showWhatsNew(doc, api, escape, { version: '0.0.86', sections: [
    { version: '0.0.86', date: '2026-10-02', body: '- See [the release](https://example.com/r).' },
  ] });
  const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  doc.querySelector('.whats-new-link').dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(calls.opened, ['https://example.com/r']);
  assert.ok(doc.querySelector('.whats-new-overlay'), 'following a link does not close the dialog');
});

test('a second request while the dialog is open does not stack another one', () => {
  const { doc, escape } = makeDom();
  const { api } = fakeApi();
  showWhatsNew(doc, api, escape, PAYLOAD);
  showWhatsNew(doc, api, escape, PAYLOAD);
  assert.equal(doc.querySelectorAll('.whats-new-overlay').length, 1);
});

test('on startup the dialog opens when the main process sends sections, and not when it sends nothing', async () => {
  const withSections = makeDom();
  await initWhatsNew(withSections.doc, fakeApi(PAYLOAD).api, withSections.escape);
  assert.ok(withSections.doc.querySelector('.whats-new-overlay'));

  const empty = makeDom();
  await initWhatsNew(empty.doc, fakeApi(null).api, empty.escape);
  assert.equal(empty.doc.querySelector('.whats-new-overlay'), null);
});

test('the Help menu entry opens the dialog through the show-whats-new event', async () => {
  const { doc, escape } = makeDom();
  const { api } = fakeApi(null);
  await initWhatsNew(doc, api, escape);
  api._show(PAYLOAD);
  assert.ok(doc.querySelector('.whats-new-overlay'));
});

test('the dialog body scrolls when long, and the overlay is exempt from the window drag region', () => {
  const body = CSS.match(/\.whats-new-body\s*\{([^}]*)\}/);
  assert.ok(body, 'style.css must style .whats-new-body');
  assert.match(body[1], /overflow-y:\s*auto/);
  const dialog = CSS.match(/\.whats-new-dialog\s*\{([^}]*)\}/);
  assert.match(dialog[1], /max-height:/);
  const noDrag = CSS.match(/body\.window-frameless :is\(([^)]*)\)\s*\{[^}]*no-drag/);
  assert.match(noDrag[1], /\.whats-new-overlay/);
});

test('index.html loads whats-new.js after utils.js, which defines escapeHtml', () => {
  const utils = HTML.indexOf('<script src="utils.js">');
  const whatsNew = HTML.indexOf('<script src="whats-new.js">');
  assert.notEqual(whatsNew, -1);
  assert.ok(whatsNew > utils);
});
