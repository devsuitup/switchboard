// remote-enrol-panel.js — the host checklist in Settings — see .ai/contexts/session-cache.md ("Remote hosts — enrolment")

'use strict';

const ENROL_WHERE_TEXT = { host: 'Run on the host:', workstation: 'Run on this machine:' };

function enrolEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function renderEnrolChecklist(containerEl, result) {
  if (!containerEl) return;
  containerEl.textContent = '';
  if (!result || result.ok !== true || !Array.isArray(result.items)) {
    containerEl.appendChild(enrolEl('div', 'enrol-error settings-description', (result && result.error) || 'the check returned no answer'));
    return;
  }
  for (const it of result.items) {
    const row = enrolEl('div', 'enrol-item');
    row.dataset.status = String(it.status);
    const head = enrolEl('div', 'enrol-head');
    head.appendChild(enrolEl('span', 'enrol-status', String(it.status)));
    head.appendChild(enrolEl('span', 'enrol-label', String(it.label)));
    row.appendChild(head);
    row.appendChild(enrolEl('div', 'enrol-detail settings-description', String(it.detail)));
    if (typeof it.command === 'string' && it.command) {
      const cmd = enrolEl('div', 'enrol-command');
      cmd.appendChild(enrolEl('span', 'enrol-where', ENROL_WHERE_TEXT[it.where] || ENROL_WHERE_TEXT.host));
      cmd.appendChild(enrolEl('code', '', it.command));
      const copy = enrolEl('button', 'enrol-copy settings-check-updates-btn', 'Copy');
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        try {
          await window.api.writeClipboard(it.command);
          copy.textContent = 'Copied';
        } catch {
          copy.textContent = 'Failed';
        }
      });
      cmd.appendChild(copy);
      row.appendChild(cmd);
    }
    containerEl.appendChild(row);
  }
}

function wireRemoteEnrolControls(buttonEl, containerEl, getAlias) {
  if (!buttonEl) return;
  buttonEl.addEventListener('click', async () => {
    const alias = String(getAlias() || '').trim();
    if (!alias) {
      renderEnrolChecklist(containerEl, { ok: false, error: 'type an ssh alias first' });
      return;
    }
    buttonEl.disabled = true;
    containerEl.textContent = '';
    containerEl.appendChild(enrolEl('div', 'enrol-pending settings-description', `Checking ${alias}…`));
    try {
      renderEnrolChecklist(containerEl, await window.api.remoteHostEnrolCheck(alias));
    } catch (err) {
      renderEnrolChecklist(containerEl, { ok: false, error: `check failed: ${err.message}` });
    } finally {
      buttonEl.disabled = false;
    }
  });
}

if (typeof window !== 'undefined') {
  window.renderEnrolChecklist = renderEnrolChecklist;
  window.wireRemoteEnrolControls = wireRemoteEnrolControls;
}
