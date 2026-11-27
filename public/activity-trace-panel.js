// Diagnostics panel: the debug-mode switch and the trace files it produces.
// Rendered inside the global settings viewer by settings-panel.js.
// See docs/activity-trace.md and .ai/contexts/ipc-bridge.md "Activity trace".

let activityTracePanel = null;
// The list the Diagnostics section last rendered into, so a delete made from
// the viewer's own toolbar refreshes it too.
let activityTraceListEl = null;

function activityTraceViewerEl() {
  return document.getElementById('activity-trace-viewer');
}

function refreshActivityTraceList() {
  if (activityTraceListEl && activityTraceListEl.isConnected) {
    renderActivityTraceFiles(activityTraceListEl);
  }
}

function getActivityTracePanel() {
  if (activityTracePanel) return activityTracePanel;
  const container = activityTraceViewerEl();
  if (!container || typeof ViewerPanel !== 'function') return null;
  activityTracePanel = new ViewerPanel(container, {
    copyPath: true, copyContent: true,
    openExternal: true, revealInFolder: true,
    language: 'auto', storageKey: 'activityTracePreviewMode',
    format: true,
    onDelete: async (filePath) => {
      let result;
      try {
        result = await window.api.deleteActivityTraceFile(filePath);
      } catch (err) {
        return { ok: false, error: (err && err.message) || String(err) };
      }
      if (result && result.ok) {
        container.style.display = 'none';
        refreshActivityTraceList();
      }
      return result;
    },
    onClose: () => { container.style.display = 'none'; },
  });
  return activityTracePanel;
}

function formatTraceSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatTraceDate(iso) {
  if (typeof formatDate === 'function') {
    try { return formatDate(new Date(iso)); } catch { /* fall through */ }
  }
  return new Date(iso).toLocaleString();
}

async function openActivityTraceFile(file) {
  const panel = getActivityTracePanel();
  if (!panel) return;
  let result;
  try {
    result = await window.api.readActivityTraceFile(file.filePath);
  } catch (err) {
    result = { ok: false, error: (err && err.message) || String(err) };
  }
  if (!result || !result.ok) {
    setTraceRowFailure(file, 'Could not open this trace — try Open again, or reopen Diagnostics to refresh the list.', (result && result.error) || 'unknown error');
    return;
  }
  setTraceRowFailure(file, null);
  if (typeof hideAllViewers === 'function') hideAllViewers();
  if (typeof terminalArea !== 'undefined' && terminalArea) terminalArea.style.display = 'none';
  if (typeof placeholder !== 'undefined' && placeholder) placeholder.style.display = 'none';
  const container = activityTraceViewerEl();
  if (container) container.style.display = 'flex';
  const title = result.truncated
    ? `${file.name} — last ${formatTraceSize(result.shown)} of ${formatTraceSize(result.size)}`
    : file.name;
  panel.open(title, file.filePath, result.content);
}

function setTraceRowFailure(file, message, reason) {
  const rows = activityTraceListEl ? activityTraceListEl.querySelectorAll('.activity-trace-file') : [];
  const row = [...rows].find(candidate => candidate.dataset.filePath === file.filePath);
  const failure = row && row.querySelector('.activity-trace-file-error');
  if (!failure) return;
  failure.textContent = message || '';
  failure.title = message ? reason : '';
  failure.hidden = !message;
}

function buildActivityTraceRow(file, listEl) {
  const row = document.createElement('div');
  row.className = 'activity-trace-file';
  row.dataset.filePath = file.filePath;

  const info = document.createElement('div');
  info.className = 'activity-trace-file-info';

  const name = document.createElement('div');
  name.className = 'activity-trace-file-name';
  name.textContent = file.name;
  if (file.current) {
    const badge = document.createElement('span');
    badge.className = 'activity-trace-current';
    badge.textContent = 'recording';
    name.appendChild(badge);
  }

  const meta = document.createElement('div');
  meta.className = 'activity-trace-file-meta';
  meta.textContent = `${formatTraceSize(file.size)} · ${formatTraceDate(file.modified)}`;

  const failure = document.createElement('div');
  failure.className = 'activity-trace-file-error';
  failure.setAttribute('role', 'alert');
  failure.hidden = true;

  info.appendChild(name);
  info.appendChild(meta);
  info.appendChild(failure);

  const actions = document.createElement('div');
  actions.className = 'activity-trace-file-actions';

  const openBtn = document.createElement('button');
  openBtn.className = 'settings-check-updates-btn';
  openBtn.textContent = 'Open';
  openBtn.addEventListener('click', () => openActivityTraceFile(file));

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'settings-check-updates-btn activity-trace-delete-btn';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', async () => {
    if (!await appConfirm({ title: 'Delete?', message: `Delete "${file.name}"?\n\nThis cannot be undone.`, confirmLabel: 'Delete', danger: true })) return;
    deleteBtn.disabled = true;
    let result;
    try {
      result = await window.api.deleteActivityTraceFile(file.filePath);
    } catch (err) {
      result = { ok: false, error: (err && err.message) || String(err) };
    } finally {
      deleteBtn.disabled = false;
    }
    if (result && result.ok) {
      renderActivityTraceFiles(listEl);
    } else {
      setTraceRowFailure(file, 'Could not delete this file — try Delete again, or close any program that has it open.', (result && result.error) || 'unknown error');
    }
  });

  actions.appendChild(openBtn);
  actions.appendChild(deleteBtn);
  row.appendChild(info);
  row.appendChild(actions);
  return row;
}

async function renderActivityTraceFiles(listEl) {
  if (!listEl) return;
  activityTraceListEl = listEl;
  let files = [];
  try { files = (await window.api.listActivityTraceFiles()) || []; } catch { files = []; }
  listEl.innerHTML = '';
  if (!files.length) {
    const empty = document.createElement('div');
    empty.className = 'activity-trace-empty';
    empty.textContent = 'No trace files yet.';
    listEl.appendChild(empty);
    return;
  }
  for (const file of files) listEl.appendChild(buildActivityTraceRow(file, listEl));
}

function wireActivityTraceToggle(inputEl, listEl) {
  if (!inputEl) return;
  inputEl.addEventListener('change', async () => {
    inputEl.disabled = true;
    try {
      const state = await window.api.setActivityTraceEnabled(inputEl.checked);
      if (state && typeof state.enabled === 'boolean') inputEl.checked = state.enabled;
    } catch {
      inputEl.checked = !inputEl.checked;
    } finally {
      inputEl.disabled = false;
    }
    await renderActivityTraceFiles(listEl);
  });
}

window.openActivityTraceFile = openActivityTraceFile;
window.renderActivityTraceFiles = renderActivityTraceFiles;
window.wireActivityTraceToggle = wireActivityTraceToggle;

function wireDiagnosticFiles(container, traceList) {
  const inventory = container.querySelector('#sv-diagnostic-inventory');
  const daysInput = container.querySelector('#sv-log-retention-days');
  const button = container.querySelector('#sv-prune-logs');
  const status = container.querySelector('#sv-prune-result');
  if (!inventory || !daysInput || !button || !status) return;
  const refresh = async days => {
    const plan = await window.api.getDiagnosticFiles(days);
    if (!inventory.isConnected) return plan;
    inventory.textContent = plan.groups.map(g => `${g.kind === 'main' ? 'Main logs' : 'Activity traces'}: ${g.count} files · ${formatTraceSize(g.size)}`).join(' | ');
    if (plan.errors?.length) inventory.textContent += ' — ' + plan.errors.map(e => `${e.filePath || ''}: ${e.error}`).join('; ');
    return plan;
  };
  refresh(Number(daysInput.value)).catch(err => { inventory.textContent = `Could not list log files: ${err.message}`; });
  button.addEventListener('click', async () => {
    if (button.disabled || !daysInput.reportValidity()) return;
    const days = Number(daysInput.value);
    if (!Number.isInteger(days) || days < 1 || days > 36500) return;
    button.disabled = true;
    daysInput.disabled = true;
    try {
      const plan = await refresh(days);
      if (!plan.count) { status.textContent = 'No eligible files to delete.'; return; }
      if (!await appConfirm({ title: 'Delete old log files?', message: `Delete ${plan.count} ${plan.count === 1 ? 'file' : 'files'} (${formatTraceSize(plan.size)}) older than ${days} days?\n\nCurrent files are kept. This cannot be undone.`, confirmLabel: 'Delete', danger: true })) return;
      const result = await window.api.pruneDiagnosticFiles(days, plan.files.filter(f => f.eligible));
      status.textContent = `${result.deleted.length} deleted · ${result.skipped.length} skipped · ${result.failed.length} failed`;
      for (const file of [...result.skipped, ...result.failed]) {
        const detail = document.createElement('div');
        detail.textContent = `${file.filePath || ''}: ${file.code || ''} ${file.error || ''}`;
        status.appendChild(detail);
      }
      await refresh(days);
      await renderActivityTraceFiles(traceList);
    } catch (err) {
      status.textContent = `Could not delete log files: ${err.message}`;
    } finally {
      button.disabled = false;
      daysInput.disabled = false;
    }
  });
}

window.wireDiagnosticFiles = wireDiagnosticFiles;
