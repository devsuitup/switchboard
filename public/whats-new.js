// see docs/changelog.md
'use strict';

const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s()"'<>]+)\)/g;
const BOLD_RE = /\*\*([^*]+)\*\*/g;

function renderInline(text, escape) {
  return text.split(/`([^`]+)`/).map((part, i) => {
    if (i % 2 === 1) return `<code>${escape(part)}</code>`;
    return escape(part)
      .replace(BOLD_RE, '<strong>$1</strong>')
      .replace(LINK_RE, '<a href="$2" class="whats-new-link">$1</a>');
  }).join('');
}

function renderChangelogMarkdown(md, escape) {
  const out = [];
  let list = null;
  let para = null;
  const flush = () => {
    if (list) out.push(`<ul>${list.map((item) => `<li>${renderInline(item, escape)}</li>`).join('')}</ul>`);
    if (para) out.push(`<p>${renderInline(para.join(' '), escape)}</p>`);
    list = null;
    para = null;
  };
  for (const line of md.split(/\r?\n/)) {
    const bullet = /^[-*] (.*)$/.exec(line);
    if (line.trim() === '') {
      flush();
    } else if (line.startsWith('### ')) {
      flush();
      out.push(`<h4>${renderInline(line.slice(4).trim(), escape)}</h4>`);
    } else if (bullet) {
      if (para) flush();
      list = list || [];
      list.push(bullet[1].trim());
    } else if (list && /^\s/.test(line)) {
      list[list.length - 1] += ' ' + line.trim();
    } else {
      if (list) flush();
      para = para || [];
      para.push(line.trim());
    }
  }
  flush();
  return out.join('');
}

function showWhatsNew(doc, api, escape, payload) {
  if (doc.querySelector('.whats-new-overlay')) return null;

  const overlay = doc.createElement('div');
  overlay.className = 'whats-new-overlay';
  const sections = payload.sections.map((s) => `
    <section class="whats-new-section">
      <h3>v${escape(s.version)} — ${escape(s.date)}</h3>
      ${renderChangelogMarkdown(s.body, escape)}
    </section>`).join('');
  overlay.innerHTML = `
    <div class="whats-new-dialog" role="dialog" aria-modal="true" aria-labelledby="whats-new-title">
      <div class="whats-new-header">
        <h2 id="whats-new-title">What's new in Switchboard</h2>
        <button type="button" class="whats-new-close" title="Close" aria-label="Close">&times;</button>
      </div>
      <div class="whats-new-body">${sections}</div>
    </div>`;
  doc.body.appendChild(overlay);

  function close() {
    overlay.remove();
    doc.removeEventListener('keydown', onKey, true);
    api.whatsNewDismissed();
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  overlay.querySelector('.whats-new-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    const link = e.target.closest('a.whats-new-link');
    if (link) {
      e.preventDefault();
      api.openExternal(link.getAttribute('href'));
    } else if (e.target === overlay) {
      close();
    }
  });
  doc.addEventListener('keydown', onKey, true);
  overlay.querySelector('.whats-new-close').focus();
  return overlay;
}

async function initWhatsNew(doc, api, escape) {
  api.onShowWhatsNew((payload) => showWhatsNew(doc, api, escape, payload));
  const payload = await api.whatsNewStartup();
  if (payload) showWhatsNew(doc, api, escape, payload);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderChangelogMarkdown, showWhatsNew, initWhatsNew };
} else {
  initWhatsNew(document, window.api, escapeHtml);
}
