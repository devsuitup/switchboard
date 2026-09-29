// activity-reporting-panel.js — the Settings section for sending session
// activity to an external tracker — see .ai/contexts/activitywatch.md

'use strict';

// see .ai/contexts/activitywatch.md ("The IPC surface")
function activityReportingStatusText(state) {
  if (!state || !state.enabled) return 'Off — nothing is sent, and no connection is attempted.';
  if (state.reachable === true) return `Connected to ${state.destination} at ${state.url}.`;
  if (state.reachable === false) {
    return `${state.destination} is not answering at ${state.url}. Nothing is queued while it is down; `
      + 'Switchboard retries on its own, backing off to once a minute.';
  }
  return `Checking ${state.destination} at ${state.url}…`;
}

function renderActivityReportingStatus(statusEl, state) {
  if (!statusEl) return;
  statusEl.textContent = activityReportingStatusText(state);
  statusEl.dataset.reachable = state && state.enabled ? String(state.reachable) : 'off';
}

function wireActivityReportingToggle(inputEl, statusEl) {
  if (!inputEl) return;
  inputEl.addEventListener('change', async () => {
    inputEl.disabled = true;
    renderActivityReportingStatus(statusEl, { enabled: inputEl.checked, reachable: null, destination: 'ActivityWatch', url: '' });
    try {
      const state = await window.api.setActivityReportingEnabled(inputEl.checked);
      if (state && typeof state.enabled === 'boolean') inputEl.checked = state.enabled;
      renderActivityReportingStatus(statusEl, state);
    } catch {
      inputEl.checked = !inputEl.checked;
    } finally {
      inputEl.disabled = false;
    }
  });
}

if (typeof window !== 'undefined') {
  window.wireActivityReportingToggle = wireActivityReportingToggle;
  window.renderActivityReportingStatus = renderActivityReportingStatus;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { activityReportingStatusText };
}
