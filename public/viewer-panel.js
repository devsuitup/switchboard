/**
 * viewer-panel.js — Unified viewer component for CodeMirror-based panels.
 *
 * A single component used by memory viewer, work files viewer, and file panel.
 * Manages toolbar, editor, preview area, and all interactions.
 * Watches files for external changes: reloads a clean buffer, and asks before replacing a dirty one.
 *
 * Toolbar buttons are shown/hidden automatically based on file type:
 *   - Preview: shown for markdown files
 *   - Wrap: always shown (defaults on for markdown, off for others)
 *   - Save: shown if onSave is provided
 *   - Close: shown if onClose is provided
 *   - Copy path/content: shown if opted in
 *
 * Depends on: viewer-toolbar.js
 * codemirror-bundle.js is loaded on demand (lazy) via loadCodeMirrorBundle().
 */

// ── Lazy CodeMirror loader ───────────────────────────────────────────────────
//
// Returns a Promise that resolves once codemirror-bundle.js has been injected
// and its globals (CMEditorView, createPlanEditor, …) are available on window.
// The Promise is cached after the first call — the <script> is injected exactly
// once regardless of how many callers race to open a panel.

let _cmBundlePromise = null;

function loadCodeMirrorBundle() {
  if (_cmBundlePromise) return _cmBundlePromise;

  _cmBundlePromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'codemirror-bundle.js';
    script.onload = () => resolve();
    script.onerror = (err) => { _cmBundlePromise = null; reject(err); };
    document.head.appendChild(script);
  });

  return _cmBundlePromise;
}

window.loadCodeMirrorBundle = loadCodeMirrorBundle;

// see .ai/contexts/viewer-panel.md ("Saving over a file that moved")
function asEditorText(text) {
  return typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : '';
}

class ViewerPanel {
  /**
   * @param {HTMLElement} container - Parent element to render into
   * @param {Object} opts
   * @param {Function}  opts.onSave       - async (filePath, content) => result
   * @param {Function}  opts.onClose      - () => void
   * @param {boolean}   opts.copyPath     - Show copy-path button
   * @param {boolean}   opts.copyContent  - Show copy-content button
   * @param {string}    opts.language     - 'markdown' or 'auto' (default 'markdown')
   * @param {string}    opts.storageKey   - localStorage key for preview mode persistence
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.opts = opts;

    // State
    this.filePath = '';
    this.editorView = null;
    this.previewMode = opts.storageKey ? localStorage.getItem(opts.storageKey) === 'true' : false;
    this.wrapMode = false;
    this._watchedPath = null;
    this._pendingSave = null;
    this._saveQueued = false;
    this._agreedBase = null;
    this._lastSeenDisk = null;
    this._noticeState = null;
    this._noticeSeq = 0;
    this._detachedSaves = new WeakMap();
    this._token = null;
    this._pendingContent = null;

    // Create toolbar — always include preview, wrap, save; visibility managed in open()
    this.toolbar = window.createViewerToolbar({
      copyPath: !!opts.copyPath,
      copyContent: !!opts.copyContent,
      preview: true,
      wrap: true,
      gotoLine: true,
      format: !!opts.format,
      delete: !!opts.onDelete,
      save: !!opts.onSave,
      close: !!opts.onClose,
    });
    container.insertBefore(this.toolbar.el, container.firstChild);

    // Hide preview initially (shown in open() if markdown)
    if (this.toolbar.previewBtn) this.toolbar.previewBtn.style.display = 'none';

    this._buildNotice();

    // Create editor area
    this.editorEl = document.createElement('div');
    this.editorEl.className = 'viewer-panel-editor';
    container.appendChild(this.editorEl);

    // Create preview area
    this.previewEl = document.createElement('div');
    this.previewEl.className = 'markdown-preview';
    this.previewEl.style.display = 'none';
    container.appendChild(this.previewEl);

    // Wire toolbar events
    this._wireEvents();

    // Listen for Cmd/Ctrl+S from CM editors
    container.addEventListener('cm-save', () => this._save());

    // Listen for file changes from main process
    this._onFileChanged = (changedPath) => {
      if (changedPath === this._watchedPath) {
        this.rereadFromDisk();
      }
    };
    if (window.api.onFileChanged) {
      window.api.onFileChanged(this._onFileChanged);
    }
  }

  // see .ai/contexts/viewer-panel.md ("Saving over a file that moved")
  _buildNotice() {
    this.noticeEl = document.createElement('div');
    this.noticeEl.className = 'viewer-panel-notice';
    this.noticeEl.style.display = 'none';

    this.noticeTextEl = document.createElement('span');
    this.noticeTextEl.className = 'viewer-panel-notice-text';
    this.noticeEl.appendChild(this.noticeTextEl);

    this.noticeReloadBtn = document.createElement('button');
    this.noticeReloadBtn.className = 'fp-toolbar-btn viewer-panel-notice-reload';
    this.noticeReloadBtn.textContent = 'Reload';
    this.noticeReloadBtn.title = 'Re-read this file from disk, discarding your unsaved edits';
    this.noticeReloadBtn.addEventListener('click', () => this._reloadDiscardingEdits());
    this.noticeEl.appendChild(this.noticeReloadBtn);

    this.noticeKeepBtn = document.createElement('button');
    this.noticeKeepBtn.className = 'fp-toolbar-btn viewer-panel-notice-keep';
    this.noticeKeepBtn.textContent = 'Keep my edits';
    this.noticeKeepBtn.title = 'Keep your edits in the editor; saving writes them over the file';
    this.noticeKeepBtn.addEventListener('click', () => {
      this._agreedBase = this._lastSeenDisk;
      this._setNotice(null);
    });
    this.noticeEl.appendChild(this.noticeKeepBtn);

    this.noticeOverwriteBtn = document.createElement('button');
    this.noticeOverwriteBtn.className = 'fp-toolbar-btn viewer-panel-notice-overwrite';
    this.noticeOverwriteBtn.textContent = 'Overwrite';
    this.noticeOverwriteBtn.title = 'Write your edits over the file on disk';
    this.noticeOverwriteBtn.addEventListener('click', () => this._save());
    this.noticeEl.appendChild(this.noticeOverwriteBtn);

    this.container.insertBefore(this.noticeEl, this.toolbar.el.nextSibling);
  }

  _setNotice(state, detail) {
    this._noticeState = state;
    let text = '';
    if (state === 'changed') {
      text = 'This file changed on disk since you opened it. Reload to discard your unsaved edits, or keep them and save over the file.';
    } else if (state === 'stale') {
      text = 'This file changed on disk since you opened it — your edits were not saved. Reload to discard them, or overwrite the file with them.';
    } else if (state === 'gone') {
      text = this._isDirty()
        ? 'This file no longer exists on disk. Your unsaved edits are kept in the editor.'
        : 'This file no longer exists on disk.';
    } else if (state === 'unreadable') {
      text = `This file can no longer be read: ${detail}`;
    } else if (state === 'save-failed') {
      text = `Save failed: ${detail}`;
    }
    this.noticeTextEl.textContent = text;
    this.noticeEl.style.display = state ? '' : 'none';
    this.noticeEl.classList.toggle('changes-error', !!state);
    this.noticeReloadBtn.style.display = state === 'changed' || state === 'stale' ? '' : 'none';
    this.noticeKeepBtn.style.display = state === 'changed' ? '' : 'none';
    this.noticeOverwriteBtn.style.display = state === 'stale' ? '' : 'none';
  }

  _isDirty(seenDisk = this._lastSeenDisk) {
    if (!this._hasDocument() || this._agreedBase === null) return false;
    const buffer = this._buffer();
    return buffer !== this._agreedBase && buffer !== seenDisk;
  }

  // see .ai/contexts/viewer-panel.md ("An open aimed at a file tab")
  _hasDocument() {
    return this._pendingContent !== null || !!this.editorView;
  }

  _buffer() {
    return this._pendingContent !== null ? this._pendingContent : this.getContent();
  }

  _wireEvents() {
    const { toolbar, opts } = this;

    if (toolbar.previewBtn) {
      toolbar.previewBtn.addEventListener('click', () => this._togglePreview());
    }

    if (toolbar.wrapBtn) {
      toolbar.wrapBtn.addEventListener('click', () => this._toggleWrap());
    }

    if (toolbar.gotoLineBtn) {
      toolbar.gotoLineBtn.addEventListener('click', () => {
        if (this.editorView && window.cmOpenGotoLine) {
          window.cmOpenGotoLine(this.editorView);
        }
      });
    }

    if (toolbar.saveBtn && opts.onSave) {
      toolbar.saveBtn.addEventListener('click', () => this._save());
    }

    if (toolbar.closeBtn && opts.onClose) {
      toolbar.closeBtn.addEventListener('click', () => opts.onClose());
    }

    if (toolbar.copyPathBtn) {
      toolbar.copyPathBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(this.filePath);
        toolbar.flashCopyPath();
      });
    }

    if (toolbar.copyContentBtn) {
      toolbar.copyContentBtn.addEventListener('click', () => {
        const content = this._buffer();
        navigator.clipboard.writeText(content);
        toolbar.flashCopyContent();
      });
    }

    if (toolbar.formatBtn) {
      toolbar.formatBtn.addEventListener('click', () => this._format());
    }

    if (toolbar.deleteBtn && opts.onDelete) {
      toolbar.deleteBtn.addEventListener('click', () => this._delete());
    }
  }

  _format() {
    if (!this.editorView || !this.filePath) return;
    const ext = this.filePath.split('.').pop()?.toLowerCase();
    const raw = this.getContent();
    let formatted = null;
    try {
      if (ext === 'jsonl') {
        // Pretty-print each JSON line, separate with --- to preserve line semantics
        const lines = raw.split('\n').filter(l => l.trim().length > 0);
        formatted = lines.map(l => JSON.stringify(JSON.parse(l), null, 2)).join('\n---\n');
      } else {
        // Default: treat as JSON
        formatted = JSON.stringify(JSON.parse(raw), null, 2);
      }
    } catch (err) {
      window.flashButtonText?.(this.toolbar.formatBtn, '!', 1200);
      return;
    }
    if (formatted === raw) return;
    this.editorView.dispatch({
      changes: { from: 0, to: this.editorView.state.doc.length, insert: formatted },
    });
    window.flashButtonText?.(this.toolbar.formatBtn, '✓', 800);
  }

  async _delete() {
    if (!this.opts.onDelete || !this.filePath) return;
    // Confirm via native-ish browser confirm
    const name = this.filePath.split('/').pop();
    if (!window.confirm(`Delete "${name}"?\n\nThis cannot be undone.`)) return;
    try {
      const result = await this.opts.onDelete(this.filePath);
      if (result && result.ok !== false) {
        // Close panel and trigger refresh through onClose
        if (this.opts.onClose) this.opts.onClose();
      } else {
        window.alert(`Delete failed: ${result?.error || 'unknown error'}`);
      }
    } catch (err) {
      window.alert(`Delete failed: ${err.message}`);
    }
  }

  /**
   * Open a file in the viewer.
   *
   * The toolbar and file-watch are configured synchronously so the panel
   * header appears immediately. CodeMirror editor creation is deferred until
   * codemirror-bundle.js has been loaded (first call triggers the load; all
   * subsequent calls share the same cached Promise and resolve near-instantly).
   */
  open(title, filePath, content, restore = null) {
    this._unwatchFile();
    this._agreedBase = asEditorText(restore ? restore.agreedBase : content);
    this._lastSeenDisk = restore ? asEditorText(restore.lastSeenDisk) : this._agreedBase;
    this._pendingSave = null;
    this._saveQueued = false;
    this._setNotice(null);
    this._token = (restore && restore.token) || {};
    const detached = this._detachedSaves.get(this._token);
    this._detachedSaves.delete(this._token);
    if (detached) {
      if (detached.error) this._setNotice('save-failed', detached.error);
      else this._agreedBase = this._lastSeenDisk = detached.written;
    }

    this.filePath = filePath;
    this._title = title;
    this.toolbar.setTitle(title);
    this.toolbar.setPath(filePath);

    const isMd = this._isMarkdown(filePath);
    const isJsonish = this._isJsonish(filePath);

    // Show/hide preview button based on file type
    if (this.toolbar.previewBtn) {
      this.toolbar.previewBtn.style.display = isMd ? '' : 'none';
    }
    // Format button: only for .json / .jsonl
    if (this.toolbar.formatBtn) {
      this.toolbar.formatBtn.style.display = isJsonish ? '' : 'none';
    }

    // Reset to edit mode before updating content (without touching localStorage)
    if (this.previewMode) {
      this.previewEl.style.display = 'none';
      this.editorEl.style.display = '';
      if (this.toolbar.previewBtn) this.toolbar.previewBtn.classList.remove('active');
      this.previewMode = false;
    }

    // Watch for external changes (sync — does not need CodeMirror)
    this._watchFile(filePath);

    // Snapshot the caller's intent so that if open() is called again before
    // the bundle resolves, the latest content/filePath wins.
    // A monotonically-incrementing generation token lets each .then() callback
    // identify whether it is the most-recent open() call or a stale one.
    this._openGen = (this._openGen || 0) + 1;
    const myGen = this._openGen;
    const pending = { content, filePath, isMd };
    this._openPending = true;
    this._rereadQueued = false;
    this._pendingContent = asEditorText(content);
    if (this.toolbar.saveBtn) this.toolbar.saveBtn.disabled = true;

    // Defer all CodeMirror work until the bundle is available.
    loadCodeMirrorBundle().then(() => {
      // Guard: if open() was called again after this closure was queued,
      // a newer call has incremented _openGen — skip this stale one.
      if (this._openGen !== myGen) return;
      const { content: c, filePath: fp, isMd: md } = pending;

      // Save preview preference before creating/updating editor
      const wantPreview = md && this.opts.storageKey && localStorage.getItem(this.opts.storageKey) === 'true';

      // Create or update editor
      if (!this.editorView) {
        this._createEditor(c, fp);
      } else {
        this._setDocument(c);
      }

      // Set wrap default based on file type
      this.wrapMode = md;
      this.toolbar.setWrapMode(this.wrapMode);
      if (this.editorView && this.editorView._wrapCompartment) {
        this.editorView.dispatch({
          effects: this.editorView._wrapCompartment.reconfigure(
            this.wrapMode ? window.CMEditorView.lineWrapping : []
          ),
        });
      }

      // Re-apply preview preference
      if (wantPreview) {
        this._setPreview(true);
      }
      this._openPending = false;
      this._pendingContent = null;
      if (this.toolbar.saveBtn) this.toolbar.saveBtn.disabled = false;
      if (restore || this._rereadQueued) this._reloadFromDisk();
    }).catch((err) => {
      console.error('[viewer-panel] Failed to load codemirror-bundle:', err);
      this._openPending = false;
    });
  }

  /**
   * Scroll the open file to `lineNumber` — see .ai/contexts/terminal-path-links.md
   *
   * @param {number} lineNumber - 1-based.
   */
  revealLine(lineNumber) {
    if (!Number.isInteger(lineNumber) || lineNumber < 1) return;
    const myGen = this._openGen;
    loadCodeMirrorBundle().then(() => {
      if (this._openGen !== myGen || !this.editorView || !window.cmRevealLine) return;
      window.cmRevealLine(this.editorView, lineNumber);
    }).catch(() => {});
  }

  _createEditor(content, filePath) {
    if (this.opts.language === 'auto') {
      this.editorView = window.createEditableViewer(
        this.editorEl, content, filePath, { wrap: this.wrapMode },
      );
    } else {
      this.editorView = window.createPlanEditor(this.editorEl);
      if (content) this._setDocument(content);
    }
  }

  _togglePreview() {
    this.previewMode = toggleMarkdownPreview({
      editorEl: this.editorEl,
      previewEl: this.previewEl,
      toggleBtn: this.toolbar.previewBtn,
      editorView: this.editorView,
      isPreview: this.previewMode,
      storageKey: this.opts.storageKey,
    });
  }

  _setPreview(show) {
    if (this.previewMode === show) return;
    this._togglePreview();
  }

  _toggleWrap() {
    if (!this.editorView || !this.editorView._wrapCompartment) return;
    this.wrapMode = !this.wrapMode;
    this.editorView.dispatch({
      effects: this.editorView._wrapCompartment.reconfigure(
        this.wrapMode ? window.CMEditorView.lineWrapping : []
      ),
    });
    this.toolbar.setWrapMode(this.wrapMode);
  }

  // see .ai/contexts/viewer-panel.md ("Saving over a file that moved")
  async _save() {
    if (!this.opts.onSave || !this.filePath || this._pendingContent !== null) return;
    if (this._pendingSave !== null) {
      this._saveQueued = true;
      return;
    }
    const content = this.getContent();
    const token = this._token;
    const myGen = this._openGen;
    const noticeSeq = this._noticeSeq;
    this._pendingSave = asEditorText(content);
    let saved = false;
    try {
      let result = await this.opts.onSave(this.filePath, content, this._agreedBase);
      while (this._openGen === myGen && result && result.reason === 'stale' && typeof result.disk === 'string') {
        this._lastSeenDisk = asEditorText(result.disk);
        this._setNotice('stale');
        if (typeof window.confirm !== 'function'
          || !window.confirm('This file changed on disk since you opened it. Overwrite it with your edits?')
          || this._openGen !== myGen) break;
        this._agreedBase = this._lastSeenDisk;
        result = await this.opts.onSave(this.filePath, content, this._agreedBase);
      }
      if (this._token !== token) {
        this._recordDetachedSave(token, content, result);
        return;
      }
      if (result && result.ok !== false) {
        saved = true;
        this._agreedBase = asEditorText(content);
        if (this._noticeSeq === noticeSeq) {
          this._lastSeenDisk = this._agreedBase;
          this._setNotice(null);
        }
        this.toolbar.flashSave();
      } else if (result && result.reason === 'stale') {
        this._setNotice('stale');
      } else if (result) {
        this._setNotice('save-failed', result.error || 'unknown error');
      }
    } catch (err) {
      if (this._token === token) this._setNotice('save-failed', (err && err.message) || 'unknown error');
      else this._recordDetachedSave(token, content, { ok: false, error: err && err.message });
    } finally {
      if (this._openGen === myGen) {
        this._pendingSave = null;
        const queued = this._saveQueued;
        this._saveQueued = false;
        if (queued && saved) this._save();
      }
    }
  }

  // see .ai/contexts/viewer-panel.md ("One viewer, several file tabs")
  _recordDetachedSave(token, content, result) {
    if (result && result.ok !== false) this._detachedSaves.set(token, { written: asEditorText(content) });
    else this._detachedSaves.set(token, { error: (result && result.error) || 'unknown error' });
  }

  getContent() {
    return this.editorView ? this.editorView.state.doc.toString() : '';
  }

  destroy() {
    this._openGen = (this._openGen || 0) + 1;  // invalidate in-flight open() closure
    this._token = null;
    this._unwatchFile();
    if (this.editorView) {
      this.editorView.destroy();
      this.editorView = null;
    }
    // Clear stale search/goto-line bar references so they get recreated with the new editor
    delete this.editorEl._cmSearchBar;
    delete this.editorEl._cmGotoLine;
    this.editorEl.innerHTML = '';
    this.previewEl.innerHTML = '';
    this.previewEl.style.display = 'none';
  }

  // ── File Watching ──────────────────────────────────────────────────

  _watchFile(filePath) {
    if (!filePath || !window.api.watchFile) return;
    const token = {};
    this._watchToken = token;
    Promise.resolve(window.api.watchFile(filePath)).then((result) => {
      if (!result || result.ok === false) return;
      if (this._watchToken === token) this._watchedPath = filePath;
      else if (window.api.unwatchFile) window.api.unwatchFile(filePath);
    }).catch(() => {});
  }

  _unwatchFile() {
    this._watchToken = null;
    if (this._watchedPath && window.api.unwatchFile) {
      window.api.unwatchFile(this._watchedPath);
      this._watchedPath = null;
    }
  }

  // see .ai/contexts/viewer-panel.md ("Saving over a file that moved")
  async _reloadFromDisk() {
    if (!this.filePath || !window.api.readFileForPanel || !this.editorView) return;
    const myGen = this._openGen;
    const result = await window.api.readFileForPanel(this.filePath);
    if (this._openGen !== myGen || !this.editorView || !result) return;

    if (!result.ok) {
      if (result.code === 'ENOENT') this._setNotice('gone');
      else this._setNotice('unreadable', result.error || 'unknown error');
      return;
    }

    const newContent = asEditorText(result.content);
    const previouslySeen = this._lastSeenDisk;
    this._lastSeenDisk = newContent;
    if (this._pendingSave !== null && newContent === this._pendingSave) return;

    if (newContent === this.getContent()) {
      this._agreedBase = newContent;
      this._setNotice(null);
      return;
    }
    if (newContent === this._agreedBase) {
      if (['gone', 'unreadable', 'changed'].includes(this._noticeState)) this._setNotice(null);
      return;
    }
    if (!this._isDirty(previouslySeen)) {
      this._agreedBase = newContent;
      this._replaceContent(newContent);
      this._setNotice(null);
      return;
    }
    if (this._noticeState !== 'stale') this._setNotice('changed');
    this._noticeSeq += 1;
  }

  async _reloadDiscardingEdits() {
    if (this._isDirty() && typeof window.confirm === 'function'
      && !window.confirm('This file has unsaved edits. Discard them?')) return;
    if (!this.filePath || !window.api.readFileForPanel) return;
    const myGen = this._openGen;
    const result = await window.api.readFileForPanel(this.filePath);
    if (this._openGen !== myGen || !this.editorView || !result) return;
    if (!result.ok) {
      if (result.code === 'ENOENT') this._setNotice('gone');
      else this._setNotice('unreadable', result.error || 'unknown error');
      return;
    }
    this._agreedBase = asEditorText(result.content);
    this._lastSeenDisk = this._agreedBase;
    this._replaceContent(this._agreedBase);
    this._setNotice(null);
  }

  // see .ai/contexts/viewer-panel.md ("Undo")
  _setDocument(text) {
    this.editorView.dispatch({ changes: { from: 0, to: this.editorView.state.doc.length, insert: text } });
    if (window.cmResetHistory) window.cmResetHistory(this.editorView);
  }

  // see .ai/contexts/viewer-panel.md ("An open aimed at a file tab")
  hasUnsavedEdits() {
    return this._isDirty();
  }

  rereadFromDisk() {
    if (this._openPending) {
      this._rereadQueued = true;
      return;
    }
    if (this._pendingContent !== null) {
      const state = this.snapshot();
      this.open(this._title, this.filePath, state.content, state);
      return;
    }
    this._reloadFromDisk();
  }

  // see .ai/contexts/viewer-panel.md ("One viewer, several file tabs")
  snapshot() {
    if (!this._hasDocument() || !this.filePath) return null;
    return { filePath: this.filePath, content: this._buffer(), agreedBase: this._agreedBase, lastSeenDisk: this._lastSeenDisk, token: this._token };
  }

  _replaceContent(newContent) {
    if (newContent !== this.getContent()) this._setDocument(newContent);
    if (this.previewMode) {
      this.previewEl.innerHTML = DOMPurify.sanitize(window.marked.parse(newContent));
    }
  }

  _isMarkdown(filePath) {
    if (!filePath) return this.opts.language === 'markdown';
    const ext = filePath.split('.').pop()?.toLowerCase();
    return ext === 'md' || ext === 'mdx';
  }

  _isJsonish(filePath) {
    if (!filePath) return false;
    const ext = filePath.split('.').pop()?.toLowerCase();
    return ext === 'json' || ext === 'jsonl';
  }
}

window.ViewerPanel = ViewerPanel;
