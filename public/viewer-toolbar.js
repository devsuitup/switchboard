/**
 * viewer-toolbar.js — Shared toolbar factory for all CodeMirror viewer panels.
 *
 * Creates a consistent toolbar with title, path, and action buttons.
 * Used by memory viewer, work files viewer, and file panel.
 */

const SAVE_ICON = '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 448 512" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path d="M433.941 129.941l-83.882-83.882A48 48 0 0 0 316.118 32H48C21.49 32 0 53.49 0 80v352c0 26.51 21.49 48 48 48h352c26.51 0 48-21.49 48-48V163.882a48 48 0 0 0-14.059-33.941zM272 80v80H144V80h128zm122 352H54a6 6 0 0 1-6-6V86a6 6 0 0 1 6-6h42v104c0 13.255 10.745 24 24 24h176c13.255 0 24-10.745 24-24V83.882l78.243 78.243a6 6 0 0 1 1.757 4.243V426a6 6 0 0 1-6 6zM224 232c-48.523 0-88 39.477-88 88s39.477 88 88 88 88-39.477 88-88-39.477-88-88-88zm0 128c-22.056 0-40-17.944-40-40s17.944-40 40-40 40 17.944 40 40-17.944 40-40 40z"></path></svg>';

const WRAP_ICON = '<svg stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path d="M4 6l16 0"></path><path d="M4 18l5 0"></path><path d="M4 12h13a3 3 0 0 1 0 6h-4l2 -2m0 4l-2 -2"></path></svg>';

const COPY_ICON = '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"></path></svg>';

const PREVIEW_ICON = '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path fill="none" d="M0 0h24v24H0z"></path><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V5a2 2 0 0 0-2-2zm0 16H5V7h14v12zm-5.5-6c0 .83-.67 1.5-1.5 1.5s-1.5-.67-1.5-1.5.67-1.5 1.5-1.5 1.5.67 1.5 1.5zM12 9c-2.73 0-5.06 1.66-6 4 .94 2.34 3.27 4 6 4s5.06-1.66 6-4c-.94-2.34-3.27-4-6-4zm0 6.5a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5z"></path></svg>';

const GOTO_LINE_ICON = '<svg stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path d="M14 2v4a2 2 0 0 0 2 2h4"></path><path d="M4.268 21a2 2 0 0 0 1.727 1H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v3"></path><path d="m9 18-1.5-1.5"></path><circle cx="5" cy="14" r="3"></circle><g stroke="currentColor" stroke-width="1" text-anchor="middle" font-family="monospace" font-size="8"><text x="10" y="10">1</text><text x="14" y="18">2</text></g></svg>';

const CLOSE_ICON = '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 512 512" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path d="M400 145.49 366.51 112 256 222.51 145.49 112 112 145.49 222.51 256 112 366.51 145.49 400 256 289.49 366.51 400 400 366.51 289.49 256 400 145.49z"></path></svg>';

const FORMAT_ICON = '<svg stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h13"/><path d="m17 8 4 4-4 4"/></svg>';

const DELETE_ICON = '<svg stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

/**
 * Flash a button with a brief color change to indicate success.
 * For icon buttons: flashes green. For text buttons: replaces text temporarily.
 */
function flashButtonText(btn, text, duration = 1200) {
  if (btn.classList.contains('icon-btn')) {
    // Icon button — flash color instead of replacing content
    btn.style.color = '#3ecf5a';
    btn.style.borderColor = 'rgba(62,207,90,0.4)';
    setTimeout(() => { btn.style.color = ''; btn.style.borderColor = ''; }, duration);
  } else {
    const original = btn.innerHTML;
    btn.textContent = text;
    setTimeout(() => { btn.innerHTML = original; }, duration);
  }
}

/**
 * Toggle markdown preview for a viewer.
 */
function toggleMarkdownPreview({ editorEl, previewEl, toggleBtn, editorView, isPreview, storageKey }) {
  if (!isPreview) {
    const content = editorView ? editorView.state.doc.toString() : '';
    renderMarkdownPreview(previewEl, content);
    editorEl.style.display = 'none';
    previewEl.style.display = 'block';
    toggleBtn.classList.add('active');
    toggleBtn.title = 'Back to editor';
    if (storageKey) localStorage.setItem(storageKey, 'true');
    return true;
  } else {
    previewEl.style.display = 'none';
    editorEl.style.display = '';
    toggleBtn.classList.remove('active');
    toggleBtn.title = 'Toggle markdown preview';
    if (storageKey) localStorage.setItem(storageKey, 'false');
    return false;
  }
}

const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx', 'markdown']);

function isMarkdownPath(filePath) {
  return MARKDOWN_EXTENSIONS.has(String(filePath || '').split('.').pop().toLowerCase());
}

// see .ai/contexts/viewer-panel.md ("Invariants")
function renderMarkdownPreview(el, text) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)(?:^---|^\.\.\.)(?:\r?\n|$)/m.exec(text);
  if (!match || match.index !== 0) {
    return setMarkdownPreview(el, '', text);
  }
  const raw = match[1].replace(/\r?\n$/, '');
  let header;
  try {
    const entries = parsePreviewFrontmatter(raw);
    const rows = [];
    const lead = [];
    for (const { key, value, nested } of entries) {
      const safe = escapeHtml(value);
      if (!nested && (key === 'name' || key === 'title')) {
        lead.push(`<strong>${safe}</strong>`);
      } else if (!nested && key === 'description') {
        lead.push(`<p>${safe}</p>`);
      } else {
        rows.push(`<div><dt>${escapeHtml(key)}</dt><dd>${nested ? `<pre>${safe}</pre>` : safe}</dd></div>`);
      }
    }
    header = entries.length ? `<header class="markdown-frontmatter">${lead.join('')}${rows.length ? `<dl>${rows.join('')}</dl>` : ''}</header>`
      : raw.trim() ? `<header class="markdown-frontmatter"><pre>${escapeHtml(raw)}</pre></header>` : '';
  } catch {
    header = `<header class="markdown-frontmatter"><pre>${escapeHtml(raw)}</pre></header>`;
  }
  return setMarkdownPreview(el, header, text.slice(match[0].length));
}


let mermaidBundlePromise = null;
let mermaidRenderQueue = Promise.resolve();
let mermaidRenderId = 0;
let mermaidThemeObserver = null;
const mermaidPreviewStates = new WeakMap();

function loadMermaidBundle() {
  if (mermaidBundlePromise) return mermaidBundlePromise;
  mermaidBundlePromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'mermaid-bundle.js';
    script.onload = () => {
      if (window.previewMermaid) resolve(window.previewMermaid);
      else {
        script.remove();
        mermaidBundlePromise = null;
        reject(new Error('Mermaid bundle unavailable'));
      }
    };
    script.onerror = () => {
      script.remove();
      mermaidBundlePromise = null;
      reject(new Error('Mermaid bundle unavailable'));
    };
    document.head.appendChild(script);
  });
  return mermaidBundlePromise;
}
window.loadMermaidBundle = loadMermaidBundle;

function markdownDiagramTheme() {
  const explicit = document.documentElement.dataset.theme || document.body.dataset.theme;
  if (explicit === 'light' || explicit === 'dark') return explicit === 'light' ? 'default' : 'dark';
  const surface = getComputedStyle(document.documentElement).getPropertyValue('--surface-sunken').trim();
  const hex = /^#([a-f\d]{6})$/i.exec(surface);
  const rgb = hex ? [0, 2, 4].map(offset => parseInt(hex[1].slice(offset, offset + 2), 16))
    : surface.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  return rgb?.length === 3 && rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722 > 128 ? 'default' : 'dark';
}

function watchMarkdownDiagramTheme() {
  if (mermaidThemeObserver) return;
  let theme = markdownDiagramTheme();
  mermaidThemeObserver = new MutationObserver(() => {
    const next = markdownDiagramTheme();
    if (next === theme) return;
    theme = next;
    for (const el of document.querySelectorAll('.markdown-preview')) {
      const state = mermaidPreviewStates.get(el);
      if (state?.sources.length) renderMarkdownDiagrams(el, state);
    }
  });
  for (const el of [document.documentElement, document.body]) {
    mermaidThemeObserver.observe(el, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
  }
}

function setMarkdownPreview(el, header, body) {
  const sources = [];
  const previous = mermaidPreviewStates.get(el);
  const theme = markdownDiagramTheme();
  const diagrams = new Map();
  const renderer = {
    code(token) {
      if (token.lang !== 'mermaid') return window.marked.Renderer.prototype.code.call(this, token);
      sources.push(token.text + '\n');
      return '<pre data-preview-mermaid="' + (sources.length - 1) + '"><code class="language-mermaid">' + escapeHtml(token.text + '\n') + '</code></pre>\n';
    },
    html(token) {
      return token.text.replace(/\sdata-preview-mermaid\b/gi, ' data-untrusted-mermaid');
    },
  };
  const fragment = DOMPurify.sanitize(header + window.marked.parse(body, { renderer: Object.assign(new window.marked.Renderer(), renderer) }), { RETURN_DOM_FRAGMENT: true });
  for (const block of fragment.querySelectorAll('[data-preview-mermaid]')) {
    const index = Number(block.dataset.previewMermaid);
    const cached = previous?.diagrams.get(index);
    if (cached?.source === sources[index] && cached.theme === theme) {
      block.replaceWith(cached.diagram.cloneNode(true));
      diagrams.set(index, cached);
    }
  }
  const { scrollTop, scrollLeft } = el;
  el.replaceChildren(fragment);
  el.scrollTop = scrollTop;
  el.scrollLeft = scrollLeft;
  const state = { sources, diagrams, generation: 0 };
  mermaidPreviewStates.set(el, state);
  if (!sources.length) return Promise.resolve();
  watchMarkdownDiagramTheme();
  return renderMarkdownDiagrams(el, state);
}

function safeDiagramCss(value) {
  return !/[\\<]|@(?!(-webkit-)?keyframes\b)|(?:https?|file|data|javascript):|\/\/|(?:image-set|expression|src)\s*\(/i.test(value)
    && !/url\s*\(/i.test(value.replace(/url\(\s*(['"]?)#[\w:.-]+\1\s*\)/gi, ''));
}

function sanitizeMarkdownDiagram(svg, renderId) {
  const clean = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['foreignObject', 'image', 'feImage', 'animate', 'animateMotion', 'animateTransform', 'set'],
    RETURN_DOM_FRAGMENT: true,
  });
  for (const node of clean.querySelectorAll('*')) {
    if (node.localName === 'style' && !safeDiagramCss(node.textContent)) {
      node.remove();
      continue;
    }
    for (const attr of [...node.attributes]) {
      if ((/^(?:href|xlink:href)$/i.test(attr.name) && !/^#[\w:.-]+$/.test(attr.value))
        || /^(?:src|xml:base)$/i.test(attr.name) || !safeDiagramCss(attr.value)) node.removeAttribute(attr.name);
    }
  }
  const root = clean.querySelector('svg');
  if (!root) throw new Error('No diagram output');
  const ids = new Map();
  for (const node of clean.querySelectorAll('[id]')) {
    const id = renderId + '-' + ids.size;
    ids.set(node.id, id);
    node.id = id;
  }
  const references = value => value.replace(/url\(\s*(['"]?)#([\w:.-]+)\1\s*\)/g,
    (match, quote, id) => ids.has(id) ? 'url(#' + ids.get(id) + ')' : match);
  for (const node of clean.querySelectorAll('*')) {
    for (const attr of [...node.attributes]) {
      let value = references(attr.value);
      if (/^(?:href|xlink:href)$/.test(attr.name) && ids.has(value.slice(1))) value = '#' + ids.get(value.slice(1));
      if (/^aria-(?:labelledby|describedby)$/.test(attr.name)) value = value.split(/\s+/).map(id => ids.get(id) || id).join(' ');
      node.setAttribute(attr.name, value);
    }
    if (node.localName === 'style') {
      let css = references(node.textContent);
      for (const [before, after] of ids) {
        const escaped = before.replace(/[.*+?^$\x7b\x7d()|[\]\\]/g, char => '\\' + char);
        css = css.replace(new RegExp('#' + escaped + '(?![\\w-])', 'g'), '#' + after);
      }
      node.textContent = css;
    }
  }
  const width = Number(root.getAttribute('viewBox')?.trim().split(/[\s,]+/)[2]);
  if (Number.isFinite(width) && width > 0) root.setAttribute('width', String(width));
  return clean;
}

function renderMarkdownDiagrams(el, state) {
  const generation = ++state.generation;
  const theme = markdownDiagramTheme();
  const current = () => mermaidPreviewStates.get(el) === state && state.generation === generation;
  const blocks = [...el.querySelectorAll('[data-preview-mermaid]')].filter(block => {
    const cached = state.diagrams.get(Number(block.dataset.previewMermaid));
    return cached?.source !== state.sources[Number(block.dataset.previewMermaid)] || cached.theme !== theme;
  });
  if (!blocks.length) return Promise.resolve();
  const pending = mermaidRenderQueue.then(async () => {
    if (!current()) return;
    let mermaid;
    try {
      mermaid = await window.loadMermaidBundle();
    } catch {
      if (current()) for (const block of blocks) showMarkdownDiagramError(block, state.sources[Number(block.dataset.previewMermaid)]);
      return;
    }
    for (const block of blocks) {
      if (!current() || !el.contains(block)) return;
      const source = state.sources[Number(block.dataset.previewMermaid)];
      const container = document.createElement('div');
      container.className = 'mermaid-render-scratch';
      container.setAttribute('aria-hidden', 'true');
      try {
        const markup = source.replace(/<<[^<>\n]+>>/g, annotation => annotation.includes('=') ? annotation : '');
        const withoutDirectives = text => text.replace(/%{2}{\s*(?:(\w+)\s*:|(\w+))\s*(?:(\w+)|((?:(?!}%{2}).|\r?\n)*))?\s*(?:}%{2})?/gi, '');
        const normalizedSource = source.replace(/\r\n?/g, '\n');
        const sourceForms = [
          source,
          withoutDirectives(source),
          withoutDirectives(source.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')),
          withoutDirectives(normalizedSource.replace(/^([^\S\n]*)---[^\S\n]*\n[\s\S]*?\n\1---[^\S\n]*(?:\n|$)/, '')),
        ];
        if (/<\s*(?:[a-z][\w:-]*(?=[\s/>])|[!/?])/i.test(markup)
          || /&(?:#|lt;)|\b(?:img|icon)["']?\s*:|@import|(?:url|image-set)\s*\(/im.test(source)
          || (sourceForms.some(text => /sequenceDiagram/i.test(text)) && sourceForms.some(text => /\bdetails[ \t]+[^\n:;]+:/i.test(text)))) throw new Error('Unsupported diagram resources');
        const defaults = mermaid.mermaidAPI.defaultConfig;
        mermaid.initialize({
          startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
          htmlLabels: false, flowchart: { htmlLabels: false }, theme,
          secure: [...new Set([...Object.keys(defaults), 'secure', 'htmlLabels', 'themeCSS'])],
        });
        document.body.appendChild(container);
        const renderId = 'preview-mermaid-' + ++mermaidRenderId;
        const { svg } = await mermaid.render(renderId, source, container);
        if (!current() || !el.contains(block)) return;
        const diagram = document.createElement('div');
        diagram.className = 'mermaid-diagram';
        diagram.dataset.previewMermaid = block.dataset.previewMermaid;
        diagram.appendChild(sanitizeMarkdownDiagram(svg, renderId));
        state.diagrams.set(Number(block.dataset.previewMermaid), { source, theme, diagram: diagram.cloneNode(true) });
        const { scrollTop, scrollLeft } = el;
        block.replaceWith(diagram);
        el.scrollTop = scrollTop;
        el.scrollLeft = scrollLeft;
      } catch {
        if (current() && el.contains(block)) showMarkdownDiagramError(block, source);
      } finally {
        container.remove();
      }
    }
  });
  mermaidRenderQueue = pending.catch(() => {});
  return mermaidRenderQueue;
}

function showMarkdownDiagramError(block, source) {
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'language-mermaid';
  code.textContent = source;
  pre.appendChild(code);
  const error = document.createElement('p');
  error.className = 'mermaid-error';
  error.setAttribute('role', 'status');
  error.textContent = 'Unable to render Mermaid diagram.';
  block.className = 'mermaid-diagram';
  block.replaceChildren(pre, error);
}

// see .ai/contexts/viewer-panel.md ("Markdown frontmatter")
function parsePreviewFrontmatter(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  let cursor = 0;
  function invalid() { throw new Error('Unsupported frontmatter'); }
  function skip() {
    while (cursor < lines.length && /^\s*(?:#.*)?$/.test(lines[cursor])) cursor++;
  }
  function indent(line) {
    if (/^ *\t/.test(line)) invalid();
    return line.match(/^ */)[0].length;
  }
  function scalar(text, flow = false) {
    text = text.trim();
    if (text.startsWith('#')) {
      if (flow) invalid();
      return '';
    }
    if (/^["']/.test(text)) {
      const quoted = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')(?:\s+#.*)?$/.exec(text);
      if (!quoted) invalid();
      return text[0] === '"' ? JSON.parse(quoted[1]) : quoted[1].slice(1, -1).replace(/''/g, "'");
    }
    text = text.replace(/\s+#.*$/, '');
    if (/^[!&*\[\]{}|>@`%]|^(?:[-?:])(?:\s|$)|:\s|:$/.test(text) || (flow && /[\[\]{}]/.test(text))) invalid();
    return text;
  }
  function inline(text) {
    if (!text.startsWith('[')) return scalar(text);
    const match = /^\[(.*)\](?:\s+#.*)?$/.exec(text);
    if (!match) invalid();
    if (!match[1].trim()) return '';
    const items = [];
    let remaining = match[1];
    while (remaining.trim()) {
      const item = /^\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,"'][^,]*)(?:,|$)/.exec(remaining);
      if (!item) invalid();
      items.push(scalar(item[1], true));
      remaining = remaining.slice(item[0].length);
    }
    return items.join(', ');
  }
  function block(marker, parentIndent) {
    const start = cursor;
    let width = null;
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.trim()) {
        const depth = indent(line);
        if (depth <= parentIndent) break;
        if (width === null) width = depth;
        if (depth < width || (marker[0] === '>' && depth > width)) invalid();
      }
      cursor++;
    }
    const content = lines.slice(start, cursor).map(line => line.slice(width || 0)).join('\n').replace(/\n+$/, '');
    const value = marker[0] === '>' ? content.replace(/([^\n])\n(?=[^\n ])/g, '$1 ').replace(/\n\n/g, '\n') : content;
    return value + (marker.endsWith('-') || !content ? '' : '\n');
  }
  function isItem(at) {
    return cursor < lines.length && indent(lines[cursor]) === at && /^-(?:\s|$)/.test(lines[cursor].slice(at));
  }
  function list(at) {
    const items = [];
    while (isItem(at)) {
      items.push(scalar(lines[cursor].slice(at + 1)));
      cursor++;
      skip();
    }
    return items.join(', ');
  }
  function map(depth, level = 0) {
    if (level > 20) invalid();
    const entries = [];
    const keys = new Set();
    skip();
    while (cursor < lines.length) {
      const lineDepth = indent(lines[cursor]);
      if (lineDepth < depth) break;
      if (lineDepth !== depth) invalid();
      const pair = /^([A-Za-z0-9_][\w .-]*):(?:\s+(.*)|$)$/.exec(lines[cursor].slice(depth));
      if (!pair || keys.has(pair[1])) invalid();
      const key = pair[1];
      keys.add(key);
      const text = (pair[2] || '').trim().replace(/^#.*$/, '');
      cursor++;
      let value = '';
      let nested = false;
      if (/^[|>][-+]?(?:\s+#.*)?$/.test(text)) {
        if (text.includes('+')) invalid();
        value = block(text.replace(/\s+#.*$/, ''), depth);
      } else if (text) {
        value = inline(text);
      } else {
        skip();
        if (isItem(depth)) {
          value = list(depth);
        } else if (cursor < lines.length && indent(lines[cursor]) > depth) {
          const childDepth = indent(lines[cursor]);
          if (isItem(childDepth)) {
            value = list(childDepth);
          } else {
            const start = cursor;
            map(childDepth, level + 1);
            value = lines.slice(start, cursor).map(line => line.slice(childDepth)).join('\n').trimEnd();
            nested = true;
          }
        }
      }
      entries.push({ key, value, nested });
      skip();
    }
    return entries;
  }
  const entries = map(0);
  if (cursor !== lines.length) invalid();
  return entries;
}

function setViewerPath(el, text) {
  const value = String(text ?? '');
  const display = value.replace(/[\\/]+$/, '') || value;
  const split = Math.max(display.lastIndexOf('/'), display.lastIndexOf('\\')) + 1;
  el.classList.add('viewer-header-path');
  el.title = value;
  const head = document.createElement('span');
  head.className = 'viewer-path-head';
  head.textContent = display.slice(0, split);
  const tail = document.createElement('span');
  tail.className = 'viewer-path-tail';
  tail.textContent = display.slice(split);
  el.replaceChildren(head, tail);
}

window.setViewerPath = setViewerPath;

/**
 * Create a viewer toolbar.
 *
 * @param {Object} opts
 * @param {boolean} opts.copyPath     - Show copy-path button
 * @param {boolean} opts.copyContent  - Show copy-content button
 * @param {boolean} opts.preview      - Show preview toggle
 * @param {boolean} opts.wrap         - Show wrap toggle
 * @param {boolean} opts.save         - Show save button
 * @param {boolean} opts.close        - Show close button
 * @param {boolean} opts.diffToggle   - Show diff mode toggle
 *
 * @returns {Object} toolbar API:
 *   .el           - The toolbar DOM element
 *   .titleEl      - Title span
 *   .pathEl       - Path span
 *   .previewBtn   - Preview button (or null)
 *   .wrapBtn      - Wrap button (or null)
 *   .saveBtn      - Save button (or null)
 *   .closeBtn     - Close button (or null)
 *   .copyPathBtn  - Copy path button (or null)
 *   .copyContentBtn - Copy content button (or null)
 *   .diffToggleBtn - Diff toggle button (or null)
 *   .setTitle(text)
 *   .setPath(text)
 *   .setPreviewMode(active)
 *   .setWrapMode(active)
 *   .flashSave()
 *   .on(event, handler)  - Attach event handlers
 */
function createViewerToolbar(opts = {}) {
  const el = document.createElement('div');
  el.className = 'viewer-toolbar';

  const infoEl = document.createElement('div');
  infoEl.className = 'viewer-toolbar-info';

  const titleEl = document.createElement('span');
  titleEl.className = 'viewer-toolbar-title';
  infoEl.appendChild(titleEl);

  const pathEl = document.createElement('span');
  pathEl.className = 'viewer-toolbar-path';
  infoEl.appendChild(pathEl);

  let copyPathBtn = null;
  if (opts.copyPath) {
    copyPathBtn = document.createElement('button');
    copyPathBtn.className = 'viewer-toolbar-copy-path';
    copyPathBtn.title = 'Copy file path';
    copyPathBtn.innerHTML = COPY_ICON;
    infoEl.appendChild(copyPathBtn);
  }

  el.appendChild(infoEl);

  const controlsEl = document.createElement('div');
  controlsEl.className = 'viewer-toolbar-controls';

  let diffToggleBtn = null;
  if (opts.diffToggle) {
    diffToggleBtn = document.createElement('button');
    diffToggleBtn.className = 'fp-toolbar-btn';
    diffToggleBtn.style.display = 'none';
    controlsEl.appendChild(diffToggleBtn);
  }

  let previewBtn = null;
  if (opts.preview) {
    previewBtn = document.createElement('button');
    previewBtn.className = 'icon-btn';
    previewBtn.innerHTML = PREVIEW_ICON;
    previewBtn.title = 'Toggle markdown preview';
    controlsEl.appendChild(previewBtn);
  }

  let copyContentBtn = null;
  if (opts.copyContent) {
    copyContentBtn = document.createElement('button');
    copyContentBtn.className = 'icon-btn';
    copyContentBtn.innerHTML = COPY_ICON;
    copyContentBtn.title = 'Copy raw content';
    controlsEl.appendChild(copyContentBtn);
  }

  let wrapBtn = null;
  if (opts.wrap) {
    wrapBtn = document.createElement('button');
    wrapBtn.className = 'icon-btn';
    wrapBtn.title = 'Toggle line wrapping';
    wrapBtn.innerHTML = WRAP_ICON;
    controlsEl.appendChild(wrapBtn);
  }

  let gotoLineBtn = null;
  if (opts.gotoLine) {
    gotoLineBtn = document.createElement('button');
    gotoLineBtn.className = 'icon-btn';
    gotoLineBtn.title = 'Go to line (Cmd+G)';
    gotoLineBtn.innerHTML = GOTO_LINE_ICON;
    controlsEl.appendChild(gotoLineBtn);
  }

  let formatBtn = null;
  if (opts.format) {
    formatBtn = document.createElement('button');
    formatBtn.className = 'icon-btn';
    formatBtn.title = 'Pretty-print JSON / JSONL';
    formatBtn.innerHTML = FORMAT_ICON;
    formatBtn.style.display = 'none'; // Shown by ViewerPanel only when content is parseable
    controlsEl.appendChild(formatBtn);
  }

  let deleteBtn = null;
  if (opts.delete) {
    deleteBtn = document.createElement('button');
    deleteBtn.className = 'icon-btn fp-delete-btn';
    deleteBtn.title = 'Delete file';
    deleteBtn.innerHTML = DELETE_ICON;
    controlsEl.appendChild(deleteBtn);
  }

  let saveBtn = null;
  if (opts.save) {
    saveBtn = document.createElement('button');
    saveBtn.className = 'icon-btn fp-save-btn';
    saveBtn.title = 'Save changes';
    saveBtn.innerHTML = SAVE_ICON;
    controlsEl.appendChild(saveBtn);
  }

  let closeBtn = null;
  if (opts.close) {
    closeBtn = document.createElement('button');
    closeBtn.className = 'icon-btn fp-close-btn';
    closeBtn.innerHTML = CLOSE_ICON;
    closeBtn.title = 'Close panel';
    controlsEl.appendChild(closeBtn);
  }

  el.appendChild(controlsEl);

  // API
  const toolbar = {
    el,
    titleEl,
    pathEl,
    previewBtn,
    wrapBtn,
    saveBtn,
    closeBtn,
    copyPathBtn,
    copyContentBtn,
    diffToggleBtn,
    gotoLineBtn,
    formatBtn,
    deleteBtn,

    setTitle(text) { titleEl.textContent = text; },
    setPath(text) { setViewerPath(pathEl, text); },

    setPreviewMode(active) {
      if (!previewBtn) return;
      previewBtn.classList.toggle('active', active);
      previewBtn.title = active ? 'Back to editor' : 'Toggle markdown preview';
    },

    setWrapMode(active) {
      if (!wrapBtn) return;
      wrapBtn.classList.toggle('active', active);
    },

    flashSave() {
      if (!saveBtn) return;
      flashButtonText(saveBtn, 'Saved!');
    },

    flashCopyPath() {
      if (!copyPathBtn) return;
      flashButtonText(copyPathBtn, '✓', 800);
    },

    flashCopyContent() {
      if (!copyContentBtn) return;
      flashButtonText(copyContentBtn, 'Copied!');
    },
  };

  return toolbar;
}

// Prevent Chromium's default Cmd/Ctrl+S behavior (Save Page)
document.addEventListener('keydown', (e) => {
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey;
  if (e.key === 's' && mod && !e.shiftKey && !e.altKey) {
    e.preventDefault();
  }
});

// Expose globally
window.createViewerToolbar = createViewerToolbar;
window.flashButtonText = flashButtonText;
window.toggleMarkdownPreview = toggleMarkdownPreview;
