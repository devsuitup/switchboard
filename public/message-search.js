function createMessageSearch(viewer, body) {
  const bar = document.createElement('div');
  bar.className = 'terminal-search-bar message-search-bar';
  bar.style.display = 'none';
  bar.innerHTML = '<input class="terminal-search-input" type="text" placeholder="Find..." aria-label="Find in messages">'
    + '<span class="terminal-search-count" aria-live="polite"></span>'
    + '<button class="terminal-search-prev" aria-label="Previous match" title="Previous (Shift+Enter)">&#9650;</button>'
    + '<button class="terminal-search-next" aria-label="Next match" title="Next (Enter)">&#9660;</button>'
    + '<button class="terminal-search-close" aria-label="Close search" title="Close (Escape)">&times;</button>';
  viewer.appendChild(bar);
  const input = bar.querySelector('input');
  const counter = bar.querySelector('.terminal-search-count');
  let matches = [];
  let active = -1;
  let timer = null;
  let query = '';
  let capped = false;
  const changes = new MutationObserver(() => schedule(false));

  function clear() {
    window.CSS?.highlights?.delete('message-find');
    window.CSS?.highlights?.delete('message-find-active');
    matches = [];
    active = -1;
  }

  function go(index, scroll = true) {
    if (!matches.length) return;
    active = (index + matches.length) % matches.length;
    const range = matches[active];
    for (let element = scroll && range.startContainer.parentElement; element && element !== body; element = element.parentElement) {
      if (element.classList.contains('jsonl-tool-body') && element.style.display === 'none') {
        element.style.display = '';
        element.previousElementSibling?.classList.add('expanded');
      }
    }
    CSS.highlights.set('message-find-active', new Highlight(range));
    counter.textContent = `${active + 1} of ${matches.length}${capped ? '+' : ''}`;
    if (!scroll) return;
    const geometry = document.createRange();
    geometry.setStart(range.startContainer, range.startOffset);
    geometry.setEnd(range.endContainer, range.endOffset);
    const rect = geometry.getBoundingClientRect();
    const bounds = body.getBoundingClientRect();
    body.scrollBy({ top: rect.top - bounds.top - bounds.height / 2, behavior: 'instant' });
  }

  function refresh(newQuery = input.value !== query) {
    clearTimeout(timer);
    timer = null;
    const previous = matches[active];
    const previousIndex = active;
    clear();
    query = input.value;
    capped = false;
    counter.textContent = '';
    if (bar.style.display === 'none' || !input.value) return;
    const pattern = new RegExp(input.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    entries: for (const entry of body.querySelectorAll('.jsonl-entry')) {
      const nodes = [];
      let text = '';
      const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode());) {
        if (node.parentElement.closest('script, style, button') || node.parentElement.closest('.jsonl-entry') !== entry) continue;
        nodes.push({ node, start: text.length });
        text += node.nodeValue;
      }
      let startIndex = 0;
      let endIndex = 0;
      for (const match of text.matchAll(pattern)) {
        if (matches.length === 10000) {
          capped = true;
          break entries;
        }
        const end = match.index + match[0].length;
        while (startIndex + 1 < nodes.length && nodes[startIndex + 1].start <= match.index) startIndex++;
        while (endIndex + 1 < nodes.length && nodes[endIndex + 1].start < end) endIndex++;
        matches.push(new StaticRange({
          startContainer: nodes[startIndex].node, startOffset: match.index - nodes[startIndex].start,
          endContainer: nodes[endIndex].node, endOffset: end - nodes[endIndex].start,
        }));
      }
    }
    const highlight = new Highlight();
    for (const range of matches) highlight.add(range);
    CSS.highlights.set('message-find', highlight);
    counter.textContent = matches.length ? `${matches.length} found` : 'No results';
    if (matches.length) {
      const same = !newQuery && previous?.startContainer.isConnected && previous?.endContainer.isConnected
        ? matches.findIndex(range => range.startContainer === previous.startContainer && range.startOffset === previous.startOffset
          && range.endContainer === previous.endContainer && range.endOffset === previous.endOffset) : -1;
      go(newQuery ? 0 : same >= 0 ? same : Math.max(0, Math.min(previousIndex, matches.length - 1)), newQuery);
    }
  }

  function schedule(newQuery = true) {
    clearTimeout(timer);
    timer = setTimeout(() => refresh(newQuery || input.value !== query), 100);
  }

  function next(direction) {
    if (timer !== null) {
      const changed = input.value !== query;
      refresh();
      if (changed && direction > 0) return;
    }
    go(active + direction);
  }

  function close(focus = true) {
    clearTimeout(timer);
    timer = null;
    changes.disconnect();
    clear();
    bar.style.display = 'none';
    input.value = '';
    query = '';
    counter.textContent = '';
    if (focus) body.focus({ preventScroll: true });
  }

  function open() {
    const selection = window.getSelection();
    if (selection?.rangeCount && body.contains(selection.anchorNode) && body.contains(selection.focusNode)) input.value = selection.toString();
    bar.style.display = 'flex';
    input.focus();
    input.select();
    refresh();
    changes.observe(body, { childList: true, characterData: true, subtree: true });
  }

  input.addEventListener('input', () => schedule(true));
  viewer.addEventListener('keydown', event => {
    if (event.defaultPrevented || event._handled || typeof hasOpenModal === 'function' && hasOpenModal()) return;
    if (!viewer.contains(document.activeElement)) return;
    for (let element = viewer; element; element = element.parentElement) {
      if (element.hidden || getComputedStyle(element).display === 'none') return;
    }
    const primary = typeof isMac !== 'undefined' && isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (event.key.toLowerCase() === 'f' && primary && !event.shiftKey && !event.altKey) {
      if (typeof matchShortcut === 'function' && typeof SHORTCUT_DEFS !== 'undefined'
          && SHORTCUT_DEFS.some(def => matchShortcut(def.id, event, typeof isMac !== 'undefined' && isMac,
            typeof appShortcuts === 'undefined' ? {} : appShortcuts))) return;
      event.preventDefault();
      event.stopPropagation();
      event._handled = true;
      open();
    } else if (bar.style.display !== 'none' && (event.key === 'Escape' || event.key === 'Enter' && event.target === input)) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') close();
      else next(event.shiftKey ? -1 : 1);
    }
  });
  bar.querySelector('.terminal-search-prev').onclick = () => next(-1);
  bar.querySelector('.terminal-search-next').onclick = () => next(1);
  bar.querySelector('.terminal-search-close').onclick = () => close();
  return { open, close, refresh };
}

function focusMessageViewer() {
  jsonlViewer.messageSearch ||= createMessageSearch(jsonlViewer, jsonlViewerBody);
  jsonlViewerBody.tabIndex = 0;
  if (typeof hasOpenModal !== 'function' || !hasOpenModal()) jsonlViewerBody.focus({ preventScroll: true });
}
