// Shared jsdom harness for public/terminal-manager.js tests.
//
// Extracted from terminal-manager-lifecycle.test.js so the resize-sync suite
// can reuse the same stub set. Mirrors the dom-setup.js pattern (jsdom +
// vm.runInContext) but with a dedicated stub set: terminal-manager.js needs
// xterm constructors and the grid-view/app.js cross-file globals, not the
// sidebar fixtures.
//
// Note: `terminalWriteBuffers` (and other module-level `const`s) live in the
// context's shared lexical scope (like sibling <script> tags), NOT on window —
// so assertions read them via the returned inCtx() helper.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Buffer cell/line stubs: the surface public/terminal-path-links.js reads.
function makeCellStub() {
  let chars = '';
  let width = 1;
  return {
    getChars: () => chars,
    getWidth: () => width,
    _set(c, w) { chars = c; width = w; },
  };
}

function makeBufferLineStub(row) {
  const text = typeof row === 'string' ? row : row.text;
  return {
    isWrapped: typeof row === 'string' ? false : !!row.isWrapped,
    length: text.length,
    getCell(x, cell) { cell._set(text[x] === undefined ? '' : text[x], 1); },
  };
}

function makeTerminalStub(spies) {
  return class TerminalStub {
    constructor(opts) {
      this.options = { ...opts };
      this.buffer = { active: { viewportY: 0, baseY: 0, getLine: (y) => this._lines[y], getNullCell: () => makeCellStub() } };
      this._lines = [];
      this.linkProviders = [];
      this.parser = { registerOscHandler: () => {} };
      this.unicode = { activeVersion: '' };
      this.cols = 80;
      this.rows = 24;
      this._onResize = null;
    }
    loadAddon() {}
    registerLinkProvider(provider) { this.linkProviders.push(provider); return { dispose: () => {} }; }
    // Test-only: fill the buffer with rows the link provider can read.
    setBufferRows(rows) { this._lines = rows.map(makeBufferLineStub); }
    open() {}
    dispose() { spies.dispose++; }
    write(d, cb) { spies.write++; spies.writes.push(d); if (cb) cb(); }
    reset() { spies.reset++; }
    focus() {}
    // Mirrors xterm: resizing to the current size is a no-op and fires nothing.
    resize(cols, rows) {
      spies.resize.push({ cols, rows });
      if (cols === this.cols && rows === this.rows) return;
      this.cols = cols;
      this.rows = rows;
      if (this._onResize) this._onResize({ cols, rows });
    }
    scrollToBottom() {}
    scrollLines() {}
    refresh() {}
    hasSelection() { return false; }
    getSelection() { return ''; }
    attachCustomKeyEventHandler(cb) { this._customKeyHandler = cb; }
    onData() {}
    onResize(cb) { this._onResize = cb; }
    onTitleChange() {}
    onBell() {}
  };
}

// Minimal ResizeObserver stub: jsdom does not implement one. Records every
// live instance so tests can fire callbacks and assert disconnection.
function makeResizeObserverStub(spies) {
  return class ResizeObserverStub {
    constructor(cb) {
      this.cb = cb;
      this.targets = [];
      this.disconnected = false;
      spies.resizeObservers.push(this);
    }
    observe(el) { this.targets.push(el); }
    unobserve(el) { this.targets = this.targets.filter((t) => t !== el); }
    disconnect() { this.disconnected = true; spies.resizeObserverDisconnects++; }
    // Test-only: simulate the browser reporting a geometry change.
    trigger() { this.cb([{ target: this.targets[0] }], this); }
  };
}

// The header/terminal-area fixtures are inert for the terminal-manager suites
// and are what public/file-panel.js builds its panel around (opts.filePanel).
const HARNESS_HTML = `<!DOCTYPE html><html><body>
  <div id="terminal-area"><div id="terminals"></div></div>
  <div id="terminal-header"><div id="terminal-header-controls"><button id="terminal-stop-btn"></button></div></div>
</body></html>`;

// opts.proposeDimensions: (fitAddonInstance) => {cols, rows} | undefined
// opts.filePanel: also load file-panel.js + splitter.js + panel-terminal.js and
//   run initFilePanel() — the panel-shell region lives there.
// opts.openTerminal: (sessionId, projectPath, isNew, sessionOptions) => result
function setupTerminalDom(opts = {}) {
  const dom = new JSDOM(HARNESS_HTML, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const spies = {
    dispose: 0,
    write: 0,
    writes: [],
    reset: 0,
    closeTerminal: 0,
    resize: [],
    resizeTerminal: [],
    resizeObservers: [],
    resizeObserverDisconnects: 0,
    fitCalls: 0,
    openTerminal: [],
    stopSession: [],
  };

  window.api = new Proxy({ platform: 'linux' }, {
    get(target, prop) {
      if (opts.api && Object.prototype.hasOwnProperty.call(opts.api, prop)) return opts.api[prop];
      if (prop in target) return target[prop];
      if (prop === 'closeTerminal') return () => { spies.closeTerminal++; };
      if (prop === 'resizeTerminal') return (id, cols, rows) => { spies.resizeTerminal.push({ id, cols, rows }); };
      if (prop === 'openTerminal') {
        return (id, projectPath, isNew, sessionOptions, initialSize) => {
          spies.openTerminal.push({ id, projectPath, isNew, sessionOptions, initialSize });
          const result = opts.openTerminal
            ? opts.openTerminal(id, projectPath, isNew, sessionOptions)
            : { ok: true };
          return Promise.resolve(result);
        };
      }
      if (prop === 'stopSession') return (id) => { spies.stopSession.push(id); return Promise.resolve({ ok: true }); };
      return () => Promise.resolve({ ok: true });
    },
  });

  spies.webglDispose = 0;
  const noopClass = class { dispose() {} onContextLoss() {} };
  const propose = opts.proposeDimensions || (() => undefined);
  const stubGlobals = {
    Terminal: makeTerminalStub(spies),
    FitAddon: {
      FitAddon: class {
        proposeDimensions() { return propose(); }
        fit() { spies.fitCalls++; }
      },
    },
    WebLinksAddon: { WebLinksAddon: noopClass },
    SearchAddon: { SearchAddon: class { clearDecorations() {} findNext() {} findPrevious() {} } },
    UnicodeGraphemesAddon: { UnicodeGraphemesAddon: noopClass },
    WebglAddon: { WebglAddon: class { dispose() { spies.webglDispose++; } onContextLoss() {} onChangeTextureAtlas() {} onAddTextureAtlasCanvas() {} clearTextureAtlas() {} } },
    ResizeObserver: makeResizeObserverStub(spies),

    TERMINAL_THEME: { background: '#000000' },
    terminalsEl: window.document.getElementById('terminals'),
    openSessions: new Map(),
    gridCards: new Map(),
    sessionMap: new Map(),
    activePtyIds: new Set(),
    activeSessionId: null,
    gridViewActive: false,

    // Cross-file functions terminal-manager.js calls but tests don't exercise.
    toggleGridView: () => {},
    isSessionNavKey: () => false,
    handleSessionNavKey: () => false,
    matchShortcut: () => false,
    appShortcuts: {},
    focusGridCard: () => {},
    wrapInGridCard: () => {},
    showGridView: () => {},
    trackActivity: () => {},
    updatePtyTitle: () => {},
    openFileInPanel: () => {},
    setActiveSession: () => {},
    clearNotifications: () => {},
    hideAllViewers: () => {},
    showTerminalHeader: () => {},
    updateRunningIndicators: () => {},
    // public/session-activity-dom.js is not loaded in this harness — grid-view.js calls this directly.
    isSessionAlive: () => false,
    placeholder: window.document.createElement('div'),
    terminalHeader: window.document.createElement('div'),
    gridViewer: window.document.createElement('div'),
    gridViewerCount: window.document.createElement('span'),
    // Read by grid-view.js's showGridView/layoutGridCards.
    terminalArea: window.document.getElementById('terminal-area'),
    sidebarContent: window.document.createElement('div'),
    statsViewer: window.document.createElement('div'),
    memoryViewer: window.document.createElement('div'),
    settingsViewer: window.document.createElement('div'),
    jsonlViewer: window.document.createElement('div'),
  };
  for (const [k, v] of Object.entries(stubGlobals)) {
    Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  }

  // grid-view.js declares `let gridCards` (and other grid state) in the shared
  // lexical scope — it shadows the window stub, exactly as in production where
  // grid-view.js owns that global. Tests must read grid state via inCtx().
  if (opts.filePanel) {
    Object.defineProperty(window, 'ViewerPanel', {
      value: function ViewerPanelStub() { return { open() {}, destroy() {} }; },
      writable: true,
      configurable: true,
    });
  }

  const ctx = dom.getInternalVMContext();
  const files = ['utils.js', 'shortcuts.js', 'subagent-timing.js', 'terminal-path-links.js', 'terminal-context-menu.js', 'terminal-manager.js', 'grid-view.js'];
  // Same order as index.html: file-panel.js first, the panel-shell pair last.
  if (opts.filePanel) files.unshift('file-panel.js');
  if (opts.filePanel) files.push('splitter.js', 'panel-terminal.js');
  for (const file of files) {
    const fullPath = path.join(PUBLIC_DIR, file);
    // Absolute filename: what c8/V8 attributes the coverage of these files to.
    vm.runInContext(fs.readFileSync(fullPath, 'utf8'), ctx, { filename: fullPath });
  }
  if (opts.filePanel) window.initFilePanel();

  const inCtx = (code) => vm.runInContext(code, ctx);
  return { window, spies, inCtx, destroy: () => window.close() };
}

module.exports = { setupTerminalDom, PUBLIC_DIR };
