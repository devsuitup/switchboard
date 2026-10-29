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
  const changes = new MutationObserver(() => schedule());

  function clear() {
    window.CSS?.highlights?.delete('message-find');
    window.CSS?.highlights?.delete('message-find-active');
    matches = [];
    active = -1;
  }

  function go(index) {
    if (!matches.length) return;
    active = (index + matches.length) % matches.length;
    const range = matches[active];
    for (let element = range.startContainer.parentElement; element && element !== body; element = element.parentElement) {
      if (element.classList.contains('jsonl-tool-body') && element.style.display === 'none') {
        element.style.display = '';
        element.previousElementSibling?.classList.add('expanded');
      }
    }
    CSS.highlights.set('message-find-active', new Highlight(range));
    counter.textContent = `${active + 1} of ${matches.length}`;
    const rect = range.getBoundingClientRect();
    const bounds = body.getBoundingClientRect();
    body.scrollBy({ top: rect.top - bounds.top - bounds.height / 2, behavior: 'instant' });
  }

  function refresh() {
    clearTimeout(timer);
    timer = null;
    clear();
    counter.textContent = '';
    if (bar.style.display === 'none' || !input.value) return;
    const pattern = new RegExp(input.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    for (const entry of body.querySelectorAll('.jsonl-entry')) {
      const nodes = [];
      let text = '';
      const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode());) {
        if (node.parentElement.closest('script, style, button') || node.parentElement.closest('.jsonl-entry') !== entry) continue;
        nodes.push({ node, start: text.length });
        text += node.nodeValue;
      }
      for (const match of text.matchAll(pattern)) {
        const end = match.index + match[0].length;
        const startNode = nodes.findLast(part => part.start <= match.index);
        const endNode = nodes.findLast(part => part.start < end);
        const range = document.createRange();
        range.setStart(startNode.node, match.index - startNode.start);
        range.setEnd(endNode.node, end - endNode.start);
        matches.push(range);
      }
    }
    const highlight = new Highlight();
    for (const range of matches) highlight.add(range);
    CSS.highlights.set('message-find', highlight);
    counter.textContent = matches.length ? `${matches.length} found` : 'No results';
    if (matches.length) go(0);
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(refresh, 100);
  }

  function next(direction) {
    if (timer !== null) {
      refresh();
      if (direction > 0) return;
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

  input.addEventListener('input', schedule);
  viewer.addEventListener('keydown', event => {
    if (event.defaultPrevented || event._handled || typeof hasOpenModal === 'function' && hasOpenModal()) return;
    if (!viewer.contains(document.activeElement)) return;
    for (let element = viewer; element; element = element.parentElement) {
      if (element.hidden || getComputedStyle(element).display === 'none') return;
    }
    const primary = typeof isMac !== 'undefined' && isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (event.key.toLowerCase() === 'f' && primary && !event.shiftKey && !event.altKey) {
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
