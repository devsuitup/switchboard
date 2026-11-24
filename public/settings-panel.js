// Settings panel component
// Manages the global and project settings viewer UI.

(function () {
  const settingsViewer = document.getElementById('settings-viewer');
  const settingsViewerTitle = document.getElementById('settings-viewer-title');
  const settingsViewerBody = document.getElementById('settings-viewer-body');
  let settingsResizeObserver = null;
  let savedFlashTimer = null;

  function closeSettingsViewer() {
    settingsResizeObserver?.disconnect();
    clearTimeout(savedFlashTimer);
    settingsViewer.style.display = 'none';
    const terminalArea = document.getElementById('terminal-area');
    const terminalHeader = document.getElementById('terminal-header');
    const placeholder = document.getElementById('placeholder');
    let gridViewActive = false;
    try { gridViewActive = localStorage.getItem('gridViewActive') === '1'; } catch {}
    const activeSessionId = sessionStorage.getItem('activeSessionId') || null;
    // Check if there's an active session with an open terminal
    if (activeSessionId && window._openSessions && window._openSessions.has(activeSessionId)) {
      terminalArea.style.display = '';
      terminalHeader.style.display = '';
    } else if (gridViewActive) {
      terminalArea.style.display = '';
    } else {
      placeholder.style.display = '';
    }
  }

  async function openSettingsViewer(scope, projectPath, folderKey) {
    const options = arguments[3] || {};
    settingsResizeObserver?.disconnect();
    clearTimeout(savedFlashTimer);
    const isProject = scope === 'project';
    const settingsKey = isProject ? 'project:' + projectPath : 'global';
    const current = normalizeBrowserSettings((await window.api.getSetting(settingsKey)) || {});
    const globalSettings = normalizeBrowserSettings(isProject ? ((await window.api.getSetting('global')) || {}) : {});

    const shortName = isProject
      ? shortProjectPath(projectPath)
      : 'Global';

    settingsViewerTitle.textContent = (isProject ? 'Project Settings — ' : 'Global Settings — ') + shortName;

    // Show settings viewer, hide others
    document.getElementById('placeholder').style.display = 'none';
    document.getElementById('terminal-area').style.display = 'none';
    document.getElementById('stats-viewer').style.display = 'none';
    document.getElementById('memory-viewer').style.display = 'none';
    document.getElementById('jsonl-viewer').style.display = 'none';
    if (typeof hideAgentsView === 'function') hideAgentsView({ restore: false });
    settingsViewer.style.display = 'flex';

    function useGlobalCheckbox(fieldName) {
      if (!isProject) return '';
      const useGlobal = current[fieldName] === undefined || current[fieldName] === null;
      return `<label class="settings-use-global"><input type="checkbox" data-field="${fieldName}" class="use-global-cb" ${useGlobal ? 'checked' : ''}> Use global default</label>`;
    }

    // Same resolution order as get-effective-settings — see .ai/contexts/ipc-bridge.md
    function fieldValue(fieldName) {
      if (isProject && (current[fieldName] === undefined || current[fieldName] === null)) {
        return globalSettings[fieldName] !== undefined ? globalSettings[fieldName] : SETTING_DEFAULTS[fieldName];
      }
      return current[fieldName] !== undefined ? current[fieldName] : SETTING_DEFAULTS[fieldName];
    }

    function fieldDisabled(fieldName) {
      if (!isProject) return '';
      return (current[fieldName] === undefined || current[fieldName] === null) ? 'disabled' : '';
    }

    const permModeValue = fieldValue('permissionMode');
    const worktreeValue = fieldValue('worktree');
    const worktreeNameValue = fieldValue('worktreeName');
    const browserModeValue = fieldValue('browserMode');
    const sandboxValue = fieldValue('sandbox');
    const isLinux = window.api.platform === 'linux';
    const preLaunchValue = fieldValue('preLaunchCmd');
    const addDirsValue = fieldValue('addDirs');
    const visCountValue = fieldValue('visibleSessionCount');
    const maxAgeValue = fieldValue('sessionMaxAgeDays');
    let appliedLogRetention = fieldValue('logRetentionDays');
    const hideSdkValue = fieldValue('hideSdkSessions');
    let appliedHideSdk = hideSdkValue;
    let appliedCodexUsage = fieldValue('showCodexUsage') === true;
    const themeValue = fieldValue('terminalTheme');
    const appThemeValue = fieldValue('theme');
    const rightClickValue = fieldValue('terminalRightClick');
    const restoreStartupValue = fieldValue('restoreOnStartup');
    const mcpEmulationValue = fieldValue('mcpEmulation');
    let appliedMcpEmulation = mcpEmulationValue;
    const schedulesTabValue = fieldValue('schedulesTab');
    const autoUpdateValue = fieldValue('autoUpdate');
    const receiveBetaVersionsValue = fieldValue('receiveBetaVersions');
    const shellProfileValue = fieldValue('shellProfile');

    // Working copy of the global-only host list, written back on Save.
    let remoteHosts = (!isProject && Array.isArray(current.remoteHosts) ? current.remoteHosts : SETTING_DEFAULTS.remoteHosts)
      .filter(h => h && typeof h === 'object')
      .map(h => ({ alias: String(h.alias || ''), label: String(h.label || ''), enabled: h.enabled !== false }));
    const remoteRefreshMinutes = Math.max(1, Math.round((Number(current.remoteRefreshMs) || SETTING_DEFAULTS.remoteRefreshMs) / 60000));

    // Live switch, not a form field — main owns the state. See docs/activity-trace.md.
    let traceState = { enabled: false };
    if (!isProject) {
      try { traceState = (await window.api.getActivityTraceState()) || traceState; } catch {};
    }
    // see .ai/contexts/activitywatch.md ("The IPC surface")
    let reportingState = { enabled: false, reachable: null, destination: 'ActivityWatch', url: '', buckets: {} };
    if (!isProject && typeof window.api.getActivityReportingState === 'function') {
      try { reportingState = (await window.api.getActivityReportingState()) || reportingState; } catch {};
    }

    // see .ai/contexts/cli-harnesses.md ("Picker, toggles and settings")
    let harnessList = [];
    let codexModels = [];
    if (!isProject && typeof window.api.getHarnesses === 'function') {
      try { const list = await window.api.getHarnesses(); harnessList = Array.isArray(list) ? list.filter(h => h && typeof h.id === 'string') : []; } catch {}
      if (harnessList.some(h => h.id === 'codex') && typeof window.api.getHarnessModels === 'function') {
        try { const models = await window.api.getHarnessModels('codex'); codexModels = Array.isArray(models) ? models.filter(m => m && typeof m.slug === 'string' && m.visible !== false) : []; } catch {}
      }
    }
    const codexSelect = (id, key, choices) => `<select class="settings-select control-select" id="${id}">
      ${choices.map(([value, label]) => `<option value="${escapeHtml(value)}" ${(current[key] || '') === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}
    </select>`;
    const codexModelChoices = [['', 'Codex default']].concat(codexModels.map(m => [m.slug, m.label || m.slug]));
    if (current.codexModel && !codexModelChoices.some(([value]) => value === current.codexModel)) codexModelChoices.push([current.codexModel, current.codexModel]);
    const harnessSection = !isProject && harnessList.length ? `<div class="settings-section">
        <div class="settings-section-title">CLI Agents</div>
        ${harnessList.map(h => `<div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">${escapeHtml(h.label)}</span>
            <div class="settings-description sv-harness-desc" data-settings-filter-exclude data-harness="${escapeHtml(h.id)}">${h.available ? 'Sessions indexed, watched and offered in the + menu' : 'Not installed here: no sessions found for it'}</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" class="sv-harness-toggle" data-harness="${escapeHtml(h.id)}" ${h.enabled ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>`).join('')}
        ${harnessList.some(h => h.id === 'codex') ? `
        <div class="settings-field">
          <div class="settings-field-info"><span class="settings-label">Show Codex usage</span><div class="settings-description" id="sv-show-codex-usage-help">Off by default. Uses your local Codex sign-in to request usage from chatgpt.com. Hides quietly when unavailable.</div></div>
          <div class="settings-field-control"><label class="settings-toggle"><input type="checkbox" id="sv-show-codex-usage" aria-label="Show Codex usage" aria-describedby="sv-show-codex-usage-help" ${fieldValue('showCodexUsage') ? 'checked' : ''}><span class="settings-toggle-slider"></span></label></div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info"><span class="settings-label">Codex sandbox</span><div class="settings-description">Passed as <code>--sandbox</code>; empty leaves codex's own config</div></div>
          <div class="settings-field-control">${codexSelect('sv-codex-sandbox', 'codexSandbox', CODEX_CHOICES.codexSandbox)}</div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info"><span class="settings-label">Codex approval</span><div class="settings-description">Passed as <code>--ask-for-approval</code></div></div>
          <div class="settings-field-control">${codexSelect('sv-codex-approval', 'codexApproval', CODEX_CHOICES.codexApproval)}</div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info"><span class="settings-label">Codex model</span><div class="settings-description">From codex's own model cache</div></div>
          <div class="settings-field-control">${codexSelect('sv-codex-model', 'codexModel', codexModelChoices)}</div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info"><span class="settings-label">Codex reasoning effort</span><div class="settings-description">Passed as <code>model_reasoning_effort</code></div></div>
          <div class="settings-field-control">${codexSelect('sv-codex-effort', 'codexEffort', CODEX_CHOICES.codexEffort)}</div>
        </div>
        <div class="settings-field settings-field-wide">
          <div class="settings-field-info"><label class="settings-label" for="sv-codex-custom-args">Custom arguments</label><div class="settings-description">Appended to Codex commands. Use your selected shell's quoting. One line, no control characters.</div></div>
          <div class="settings-field-control"><textarea rows="1" class="settings-input" id="sv-codex-custom-args">${escapeHtml(fieldValue('codexCustomArgs'))}</textarea></div>
        </div>` : ''}
      </div>` : '';

    // Working copy of the (global-only) re-bindable keyboard shortcuts.
    let scShortcuts = normalizeShortcuts(isProject ? null : current.shortcuts);
    const scIsMac = typeof isMac !== 'undefined' ? isMac : /Mac|iPhone|iPad/.test(navigator.platform);

    // Discover available shell profiles
    let shellProfiles = [];
    try { shellProfiles = await window.api.getShellProfiles(); } catch {};
    const project = isProject ? cachedAllProjects.find(p => p.projectPath === projectPath && (!folderKey || p.folder === folderKey)) : null;

    settingsViewerBody.innerHTML = `
    <div class="settings-form">
      <div class="settings-section">
        <div class="settings-section-title">Claude CLI Options</div>

        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <label class="settings-label" for="sv-custom-args">Custom Arguments</label>
            ${useGlobalCheckbox('customArgs')}
            <div class="settings-description">Appended to Claude commands. Use your selected shell's quoting. ${isProject ? 'This override applies to local launches only.' : 'Remote launches use only global arguments, passed to the remote POSIX shell as typed.'} Windows cmd/PowerShell schedules split literal quoted arguments without shell expansion. One line, no control characters.</div>
          </div>
          <div class="settings-field-control"><textarea rows="1" class="settings-input" id="sv-custom-args" ${fieldDisabled('customArgs')}>${escapeHtml(fieldValue('customArgs'))}</textarea></div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Permission Mode</span>
              ${useGlobalCheckbox('permissionMode')}
            </div>
            <div class="settings-description">Permission mode passed to the <code>claude</code> command</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select control-select" id="sv-perm-mode" ${fieldDisabled('permissionMode')}>
              ${PERMISSION_MODES.map(m => m.value === null
                ? '<option value="">Default (none)</option>'
                : `<option value="${m.value}" ${permModeValue === m.value ? 'selected' : ''}>${escapeHtml(m.label)}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Worktree</span>
              ${useGlobalCheckbox('worktree')}
            </div>
            <div class="settings-description">Enable worktree for new sessions</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-worktree" ${worktreeValue ? 'checked' : ''} ${fieldDisabled('worktree')}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Worktree Name</span>
              ${useGlobalCheckbox('worktreeName')}
            </div>
            <div class="settings-description">Custom name for worktree branches</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-worktree-name" placeholder="auto" value="${escapeHtml(worktreeNameValue)}" ${fieldDisabled('worktreeName')} style="width:140px">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Browser</span>
              ${useGlobalCheckbox('browserMode')}
            </div>
            <div class="settings-description">Choose browser automation for the next session launch. Existing sessions keep their launch settings.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select control-select" id="sv-browser-mode" aria-label="Browser" ${fieldDisabled('browserMode')}>
              ${BROWSER_MODES.filter(mode => mode.value !== 'managed').map(mode => `<option value="${mode.value}" ${(browserModeValue === mode.value || (browserModeValue === 'managed' && mode.value === 'off')) ? 'selected' : ''}>${mode.label}</option>`).join('')}
            </select>
          </div>
        </div>

        ${isLinux ? `<div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Sandbox</span>
              ${useGlobalCheckbox('sandbox')}
            </div>
            <div class="settings-description">Run claude in a bubblewrap sandbox — only the project directory and Claude's own config are visible. Requires <code>bwrap</code> (bubblewrap). Takes effect for new sessions.</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-sandbox" ${sandboxValue ? 'checked' : ''} ${fieldDisabled('sandbox')}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>` : ''}

        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Additional Directories</span>
              ${useGlobalCheckbox('addDirs')}
            </div>
            <div class="settings-description">Extra directories to include in Claude sessions</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-add-dirs" placeholder="/path/to/dir1, /path/to/dir2" value="${escapeHtml(addDirsValue)}" ${fieldDisabled('addDirs')}>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Session Launch</div>

        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Pre-launch Command</span>
              ${useGlobalCheckbox('preLaunchCmd')}
            </div>
            <div class="settings-description">Prepended to the claude command (e.g. "aws-vault exec profile --")</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-pre-launch" placeholder="e.g. aws-vault exec profile --" value="${escapeHtml(preLaunchValue)}" ${fieldDisabled('preLaunchCmd')}>
          </div>
        </div>
      </div>

      ${harnessSection}

      ${!isProject ? `<div class="settings-section">
        <div class="settings-section-title">Application</div>

        <div class="settings-field">
          <div class="settings-field-info">
            <label class="settings-label" for="sv-theme">Theme</label>
            <div class="settings-description">App and terminal colors. System follows your device's appearance live.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select control-select" id="sv-theme">
              ${THEME_CHOICES.map(([value, label]) =>
                `<option value="${value}" ${appThemeValue === value ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Terminal Theme</span>
            <div class="settings-description">Terminal palette when the app uses Dark. Light uses a matching light palette.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select control-select" id="sv-terminal-theme">
              ${Object.entries(TERMINAL_THEMES).map(([key, t]) =>
                `<option value="${key}" ${themeValue === key ? 'selected' : ''}>${escapeHtml(t.label)}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Terminal Right-Click</span>
            <div class="settings-description">What a right-click does in the terminal. "Context menu" offers file-link actions (open in panel / system editor, copy path), copy and paste. Takes effect on the next right-click.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select control-select" id="sv-right-click">
              <option value="menu" ${rightClickValue === 'menu' ? 'selected' : ''}>Context menu (default)</option>
              <option value="paste" ${rightClickValue === 'paste' ? 'selected' : ''}>Paste clipboard</option>
              <option value="default" ${rightClickValue === 'default' ? 'selected' : ''}>Native (xterm)</option>
              <option value="none" ${rightClickValue === 'none' ? 'selected' : ''}>Do nothing</option>
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Restore Sessions on Startup</span>
            <!-- No live-apply hook — this setting is only read at next app launch. -->
            <div class="settings-description">Re-open the sessions that were open when Switchboard last closed. "On click" only marks them in the sidebar and resumes each one when you click it.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select control-select" id="sv-restore-startup">
              <option value="off" ${restoreStartupValue === 'off' ? 'selected' : ''}>Don't restore</option>
              <option value="ask" ${restoreStartupValue === 'ask' ? 'selected' : ''}>Ask on startup (default)</option>
              <option value="lazy" ${restoreStartupValue === 'lazy' ? 'selected' : ''}>Restore on click</option>
              <option value="auto" ${restoreStartupValue === 'auto' ? 'selected' : ''}>Restore automatically</option>
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Shell Profile</span>
            <div class="settings-description">Shell used for terminal and Claude sessions. Changes take effect for new sessions only.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select control-select" id="sv-shell-profile">
              <option value="auto" ${shellProfileValue === 'auto' ? 'selected' : ''}>Auto (detect)</option>
              ${shellProfiles.map(p =>
                `<option value="${escapeHtml(p.id)}" ${shellProfileValue === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Max Visible Sessions</span>
            <div class="settings-description">Show up to this many sessions before collapsing the rest behind "+N older"</div>
          </div>
          <div class="settings-field-control">
            <input type="number" class="settings-input settings-input-compact" id="sv-visible-count" min="1" max="100" value="${visCountValue}">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Session Max Age (days)</span>
            <div class="settings-description">Sessions older than this are hidden behind "+N older" even if under the count limit</div>
          </div>
          <div class="settings-field-control">
            <input type="number" class="settings-input settings-input-compact" id="sv-max-age" min="1" max="365" value="${maxAgeValue}">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Hide SDK-launched Sessions</span>
            <div class="settings-description">Hide sessions started by a program rather than typed in a terminal: Claude Agent SDK runs and non-interactive codex exec runs (headless runs, review agents). Scheduled tasks stay visible.</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-hide-sdk" ${hideSdkValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Schedules tab</span>
            <div class="settings-description">Show the Schedules tab instead of schedule files in Agent Files. On by default; this setting will be removed in a later release. Takes effect when saved, without a restart; scheduled tasks keep running either way.</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-schedules-tab" ${schedulesTabValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">IDE Emulation</span>
            <div class="settings-description">Emulate an IDE so Claude can open files and diffs in a side panel. Disable to use your own IDE instead. Changes take effect for new sessions only.</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-mcp-emulation" ${mcpEmulationValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>
      </div>` : ''}

      ${!isProject ? `<div class="settings-section">
        <div class="settings-section-title">Keyboard Shortcuts</div>
        ${SHORTCUT_DEFS.map(def => `
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">${escapeHtml(def.label)}</span>
            <div class="settings-description">${escapeHtml(def.description)}</div>
          </div>
          <div class="settings-field-control">
            <button class="settings-shortcut-btn" id="sv-sc-${def.id}" data-sc-id="${def.id}">${escapeHtml(formatBinding(def.id, scIsMac, scShortcuts))}</button>
          </div>
        </div>`).join('')}
        <div class="settings-hint">Click a shortcut, then press the new combination. At least one modifier (${scIsMac ? 'Cmd' : 'Ctrl'}, ${scIsMac ? 'Option' : 'Alt'} or Shift) is required. Press Esc to cancel, or click again to reset to defaults.</div>
      </div>` : ''}

      ${!isProject ? `<div class="settings-section">
        <div class="settings-section-title">Updates</div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Automatic Updates</span>
            <div class="settings-description">Download updates in the background and install them when Switchboard quits. Turn off to keep the installed binary exactly as it is \u2014 "Check for Updates" below still works on demand. Takes effect on next launch.</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-auto-update" ${autoUpdateValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Receive beta versions</span>
            <div class="settings-description">Include beta releases when checking for updates. Applies when you save; turning it off never downgrades your installed version, but a beta already downloaded still installs at quit.</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-receive-beta-versions" ${receiveBetaVersionsValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Version</span>
            <div class="settings-description" data-settings-filter-exclude><span id="sv-current-version"></span> <span id="sv-update-status"></span></div>
          </div>
          <div class="settings-field-control">
            <button class="settings-check-updates-btn" id="sv-check-updates-btn">Check for Updates</button>
          </div>
        </div>
      </div>` : ''}

      ${!isProject ? `<div class="settings-section">
        <div class="settings-section-title">Remote Hosts</div>
        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <span class="settings-label">SSH hosts to observe</span>
            <div class="settings-description">Each host is an alias from your <code>~/.ssh/config</code> — Switchboard never stores or reads a key, a password or a port. Its Claude sessions are mirrored read-only into the local database and appear in the sidebar, the search and the heatmap alongside your own. Opening one shows its transcript; it cannot be resumed from here.</div>
            <div class="remote-hosts-list" id="sv-remote-hosts" data-settings-filter-exclude></div>
            <button class="settings-check-updates-btn" id="sv-remote-add">Add host</button>
            <span id="sv-remote-status" class="settings-description" data-settings-filter-exclude></span>
          </div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Refresh every</span>
            <div class="settings-description">Minutes between pulls. A pull lists the remote transcripts over one SSH call and copies only what changed; nothing is watched live, because file watching cannot cross SSH. Minimum 1 minute.</div>
          </div>
          <div class="settings-field-control">
            <input type="number" class="settings-input settings-input-compact" id="sv-remote-refresh" min="1" max="1440" value="${remoteRefreshMinutes}">
          </div>
        </div>
      </div>` : ''}

      ${!isProject ? `<div class="settings-section">
        <div class="settings-section-title">Activity Reporting</div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Send session activity to ActivityWatch</span>
            <div class="settings-description">Destination: <strong data-settings-filter-exclude>${escapeHtml(reportingState.destination || 'ActivityWatch')}</strong>, the local time tracker, at <code data-settings-filter-exclude>${escapeHtml(reportingState.url || '')}</code>. Nothing leaves this machine. Takes effect immediately and is remembered across launches.</div>
            <div class="settings-description" id="sv-activity-reporting-status" data-settings-filter-exclude></div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-activity-reporting" ${reportingState.enabled ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>
        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <span class="settings-label">What is sent</span>
            <div class="settings-description">
              Two separate buckets, so that the time you spent on a session is never added to the time it ran on its own.<br>
              <strong>Your attention</strong> — <code>${escapeHtml((reportingState.buckets && reportingState.buckets.attention) || '')}</code>: the session whose terminal is on screen, while the window has focus and you are at the keyboard, with its id, its project and its name. It stops after 3 minutes without input, and while Settings, Memory or another full-page view replaces the terminals. It appears in ActivityWatch's Editor view.<br>
              <strong>What ran</strong> — <code>${escapeHtml((reportingState.buckets && reportingState.buckets.running) || '')}</code>: every Claude session from start to exit, scheduled runs included, whether or not you were looking at it, with its id, its project and its name. Sessions overlap there, as they did. Each one is updated every minute while it runs, so a crash loses at most the last minute of it. Shells are not counted: a shell sitting open is not work running.<br>
              A session's name is the one you gave it, or the title generated for it; a session with neither is sent under its id. Its first prompt — which the sidebar shows for such a session — is never sent, nor is any other prompt, command or transcript content.
            </div>
          </div>
        </div>
      </div>` : ''}

      ${!isProject ? `<div class="settings-section">
        <div class="settings-section-title">Diagnostics</div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Debug Mode</span>
            <div class="settings-description">Record an activity trace of the sidebar's activity indicators — both processes into one ordered JSONL file, next to the database. Takes effect immediately, without a restart, and is remembered across launches. Turn it on only while investigating.</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-activity-trace" ${traceState.enabled ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>
        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <span class="settings-label">What it records</span>
            <div class="settings-description">
              For every chunk sent to a terminal it records the chunk's length, and code points <strong>only from the chunk's first control character</strong> (C0 or DEL) onwards. A chunk of printable text has no control character, so it contributes a length and nothing else — no code points at all. That rule is what stops the probe from being a keylogger.<br>
              The bound of that guarantee: ten code points are kept from the control character, so a chunk whose sequence is followed by text — a bracketed paste, <code>ESC [ 200 ~</code> then the pasted content — can still carry a few characters of it. No chunk of plain text is ever rendered, and no rendering ever starts before a control character.<br>
              Disk use is bounded: at most 4 rotating segments of 16 MB each, a 64 MB ceiling by default. When the cap is reached the oldest segment is deleted.
            </div>
          </div>
        </div>
        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <span class="settings-label">Trace files</span>
            <div class="settings-description" data-settings-filter-exclude>${escapeHtml(traceState.dir || '')}</div>
            <div class="activity-trace-list" id="sv-activity-trace-list" data-settings-filter-exclude></div>
          </div>
        </div>
        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <span class="settings-label">Switchboard log files</span>
            <div id="sv-diagnostic-inventory" class="settings-description" data-settings-filter-exclude></div>
            <label for="sv-log-retention-days">Delete files older than</label>
            <input id="sv-log-retention-days" class="settings-input settings-input-compact" type="number" min="1" max="36500" step="1" required value="${escapeHtml(String(fieldValue('logRetentionDays')))}" aria-label="Log retention in days"> days
            <button type="button" id="sv-prune-logs" class="settings-check-updates-btn">Delete old files…</button>
            <div class="settings-description">Current log and recording traces are kept. Save remembers the number of days.</div>
            <div id="sv-prune-result" class="settings-description" role="status" data-settings-filter-exclude></div>
          </div>
        </div>
      </div>` : ''}

      ${!isProject ? `<div class="settings-section">
        <div class="settings-description">Unarchive restores sidebar groups. Folder schedules stay off until you choose Turn back on. Actions apply immediately.</div>
        <div id="sv-archived-projects"></div>
      </div>` : ''}

      <div class="settings-btn-row">
        <button class="settings-cancel-btn" id="sv-cancel-btn">Cancel</button>
        <button class="settings-save-btn" id="sv-save-btn">Save Settings</button>
        ${isProject ? '<button class="settings-cancel-btn" id="sv-archive-btn">Archive Project</button><button class="settings-remove-btn" id="sv-delete-btn">Delete Project</button>' : ''}
      </div>
    </div>
  `;

    const form = settingsViewerBody.querySelector('.settings-form');
    const footer = form.querySelector('.settings-btn-row');
    const pageDefs = isProject
      ? [['launch', 'Launch'], ['project', 'This project']]
      : [['general', 'General'], ['sessions', 'Sessions'], ['keyboard', 'Keyboard'], ['automation', 'Automation'], ['remote', 'Remote hosts'], ['integrations', 'Integrations'], ['archived', 'Archived'], ['advanced', 'Advanced']];
    const layout = document.createElement('div');
    layout.className = 'settings-layout';
    layout.innerHTML = `<div class="settings-navigation"><input type="search" id="sv-filter" class="settings-input settings-filter" aria-label="Filter settings" placeholder="Filter settings…"><nav class="settings-nav" aria-label="Settings sections"><ul>${pageDefs.map(([id, label]) => `<li><button type="button" data-section="${id}" aria-controls="settings-page-${id}" tabindex="-1">${label}</button></li>`).join('')}</ul></nav></div><div class="settings-pages"></div>`;
    form.prepend(layout);
    const pages = new Map(pageDefs.map(([id, label]) => {
      const page = document.createElement('section');
      page.className = 'settings-page';
      page.id = 'settings-page-' + id;
      page.dataset.section = id;
      page.setAttribute('role', 'region');
      page.setAttribute('aria-labelledby', 'settings-heading-' + id);
      page.hidden = true;
      page.innerHTML = `<h2 id="settings-heading-${id}" tabindex="-1">${label}</h2>`;
      layout.querySelector('.settings-pages').append(page);
      return [id, page];
    }));
    function moveGroup(pageId, title, ids) {
      const group = document.createElement('div');
      group.className = 'settings-section';
      const heading = document.createElement('h3');
      heading.className = 'settings-section-title';
      heading.textContent = title;
      group.append(heading);
      for (const id of ids) {
        const row = form.querySelector('#' + id)?.closest('.settings-field');
        if (row) group.append(row);
      }
      if (group.children.length > 1) pages.get(pageId).append(group);
    }
    const launchPage = isProject ? 'launch' : 'sessions';
    moveGroup(launchPage, 'Launch', ['sv-pre-launch', 'sv-add-dirs', 'sv-worktree', 'sv-worktree-name', 'sv-browser-mode', 'sv-sandbox']);
    moveGroup(launchPage, 'Claude', ['sv-perm-mode', 'sv-custom-args']);
    if (isProject) {
      const identity = document.createElement('dl');
      identity.className = 'settings-project-identity';
      const alias = project?.remoteAlias || parseFolderKey(folderKey).alias;
      const sessions = Array.isArray(project?.sessions)
        ? project.sessions.filter(s => !s.parentSessionId && s.type !== 'terminal') : null;
      const counts = Array.isArray(sessions)
        ? `${sessions.length} session${sessions.length === 1 ? '' : 's'} · ${sessions.filter(session => session.archived).length} archived`
        : 'Unavailable';
      for (const [id, label, value] of [
        ['name', 'Name', shortName],
        ['path', 'Full path', projectPath],
        ['host', 'Host', alias ? (typeof remoteHostLabel === 'function' ? remoteHostLabel(alias, globalSettings.remoteHosts) : alias) : 'Local'],
        ['folder', 'Folder key', project?.folder || folderKey || 'Unavailable'],
        ['sessions', 'Sessions', counts],
      ]) {
        const term = document.createElement('dt');
        term.textContent = label;
        const detail = document.createElement('dd');
        detail.id = 'sv-project-' + id;
        detail.textContent = value;
        identity.append(term, detail);
      }
      const danger = document.createElement('div');
      danger.className = 'settings-section settings-danger-zone';
      danger.innerHTML = '<h3 class="settings-section-title">Danger zone</h3><div class="settings-project-actions"></div>';
      danger.querySelector('.settings-project-actions').append(form.querySelector('#sv-archive-btn'), form.querySelector('#sv-delete-btn'));
      pages.get('project').append(identity, danger);
    } else {
      moveGroup('general', 'Startup', ['sv-restore-startup']);
      moveGroup('general', 'Shell', ['sv-shell-profile']);
      moveGroup('general', 'Appearance', ['sv-theme']);
      moveGroup('general', 'Terminal', ['sv-terminal-theme', 'sv-right-click']);
      moveGroup('general', 'IDE', ['sv-mcp-emulation']);
      const harnessGroup = form.querySelector('.sv-harness-toggle')?.closest('.settings-section');
      if (harnessGroup) pages.get('sessions').insertBefore(harnessGroup, pages.get('sessions').lastElementChild);
      moveGroup('sessions', 'Codex', ['sv-codex-sandbox', 'sv-codex-approval', 'sv-codex-model', 'sv-codex-effort', 'sv-codex-custom-args']);
      moveGroup('sessions', 'Sidebar list', ['sv-visible-count', 'sv-max-age', 'sv-hide-sdk']);
      moveGroup('automation', 'Schedules', ['sv-schedules-tab']);
      for (const [pageId, selector] of [['general', '#sv-auto-update'], ['keyboard', '.settings-shortcut-btn'], ['remote', '#sv-remote-hosts'], ['integrations', '#sv-activity-reporting'], ['advanced', '#sv-activity-trace'], ['archived', '#sv-archived-projects']]) {
        pages.get(pageId).append(form.querySelector(selector).closest('.settings-section'));
      }
      for (const pageId of ['integrations', 'advanced']) {
        const row = pages.get(pageId).querySelectorAll('.settings-field')[1];
        const details = document.createElement('details');
        details.className = 'settings-details';
        const summary = document.createElement('summary');
        summary.textContent = row.querySelector('.settings-label').textContent;
        details.append(summary, row.querySelector('.settings-description'));
        row.replaceWith(details);
      }
    }
    for (const section of [...form.children]) {
      if (!section.classList.contains('settings-section')) continue;
      if (section.querySelector('.settings-field')) pages.get(isProject ? 'launch' : 'advanced').append(section);
      else section.remove();
    }
    form.querySelectorAll('div.settings-section-title').forEach(old => {
      const heading = document.createElement('h3');
      heading.className = old.className;
      heading.textContent = old.textContent;
      old.replaceWith(heading);
    });
    const navButtons = [...layout.querySelectorAll('.settings-nav button')];
    const storageKey = 'settingsSection:' + (isProject ? 'project' : 'global');
    const filter = layout.querySelector('#sv-filter');
    const emptyResults = document.createElement('p');
    emptyResults.className = 'settings-description settings-filter-empty';
    emptyResults.setAttribute('role', 'status');
    emptyResults.textContent = 'No settings match. Clear the filter to see all settings.';
    emptyResults.hidden = true;
    layout.querySelector('.settings-pages').append(emptyResults);
    let selectedPage;
    function applySettingsFilter() {
      const query = filter.value.trim().toLowerCase();
      layout.classList.toggle('settings-filtering', Boolean(query));
      let anyMatch = false;
      for (const [id, page] of pages) {
        let matches = false;
        if (id !== 'archived') {
          for (const row of page.querySelectorAll('.settings-field')) {
            const text = [...row.querySelectorAll('.settings-label, .settings-description')]
              .filter(node => !node.closest('[data-settings-filter-exclude]'))
              .map(node => {
                const copy = node.cloneNode(true);
                copy.querySelectorAll('[data-settings-filter-exclude]').forEach(excluded => excluded.remove());
                return copy.textContent;
              }).join(' ').toLowerCase();
            row.hidden = Boolean(query) && !text.includes(query);
            if (!row.hidden) matches = true;
          }
          for (const group of page.querySelectorAll('.settings-section')) {
            group.hidden = Boolean(query) && ![...group.querySelectorAll('.settings-field')].some(row => !row.hidden);
          }
          page.querySelectorAll('.settings-details').forEach(details => { details.hidden = Boolean(query); });
        }
        page.hidden = query ? !matches : id !== selectedPage;
        navButtons.find(button => button.dataset.section === id).classList.toggle('settings-no-match', Boolean(query) && !matches);
        anyMatch ||= matches;
      }
      emptyResults.hidden = !query || anyMatch;
    }
    filter.addEventListener('input', applySettingsFilter);
    filter.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !filter.value) return;
      event.preventDefault();
      event.stopPropagation();
      filter.value = '';
      applySettingsFilter();
    });
    function revealActiveNav() {
      if (settingsViewer.classList.contains('settings-narrow')) {
        navButtons.find(button => button.classList.contains('active'))?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      }
    }
    function selectPage(id) {
      if (!pages.has(id)) id = pageDefs[0][0];
      selectedPage = id;
      applySettingsFilter();
      if (id === 'archived' && activeArchivedProjectsManager?.dirty
        && pages.get(id).contains(activeArchivedProjectsManager.container)) {
        activeArchivedProjectsManager.refresh(cachedAllProjects)
          .catch(error => console.warn('[switchboard] archived refresh failed', error));
      }
      for (const button of navButtons) {
        const selected = button.dataset.section === id;
        button.classList.toggle('active', selected);
        button.tabIndex = selected ? 0 : -1;
        if (selected) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      }
      try { localStorage.setItem(storageKey, id); } catch {}
      revealActiveNav();
    }
    for (const [index, button] of navButtons.entries()) {
      button.addEventListener('click', () => selectPage(button.dataset.section));
      button.addEventListener('keydown', event => {
        let next;
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % navButtons.length;
        if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index + navButtons.length - 1) % navButtons.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = navButtons.length - 1;
        if (next !== undefined) {
          event.preventDefault();
          navButtons[next].click();
          navButtons[next].focus();
        } else if (event.key === 'Tab' && !event.shiftKey) {
          event.preventDefault();
          const selected = pages.get(button.dataset.section);
          const page = selected.hidden ? [...pages.values()].find(page => !page.hidden) : selected;
          const control = page && [...page.querySelectorAll('input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), summary')].find(control => !control.closest('[hidden]'));
          (control || page?.querySelector('h2') || form.querySelector('#sv-save-btn')).focus();
        }
      });
    }
    let remembered;
    try { remembered = localStorage.getItem(storageKey); } catch {}
    selectPage(pages.has(options.section) ? options.section : remembered);
    settingsViewer.classList.remove('settings-narrow', 'settings-compact');
    if (typeof ResizeObserver !== 'undefined') {
      settingsResizeObserver = new ResizeObserver(entries => {
        for (const entry of entries) {
          if (entry.target === settingsViewer && entry.contentRect.width > 0) {
            settingsViewer.classList.toggle('settings-narrow', entry.contentRect.width < 720);
            settingsViewer.classList.toggle('settings-compact', entry.contentRect.width < 480);
            revealActiveNav();
          }
        }
      });
      settingsResizeObserver.observe(settingsViewer);
    }
    const unsaved = document.createElement('span');
    unsaved.id = 'sv-unsaved';
    unsaved.className = 'settings-unsaved';
    unsaved.setAttribute('role', 'status');
    footer.prepend(unsaved);
    const trackedControls = [...form.querySelectorAll('input, select, textarea')].filter(control => !['sv-filter', 'sv-activity-trace', 'sv-activity-reporting'].includes(control.id));
    const controlValue = control => String(control.type === 'checkbox' ? control.checked : control.value);
    let initialHosts;
    let initialShortcuts;
    function dirtySnapshot() {
      return { values: trackedControls.map(controlValue), hosts: JSON.stringify(remoteHosts), shortcuts: JSON.stringify(scShortcuts) };
    }
    function resetDirty(snapshot = dirtySnapshot()) {
      trackedControls.forEach((control, index) => { control.dataset.initial = snapshot.values[index]; });
      initialHosts = snapshot.hosts;
      initialShortcuts = snapshot.shortcuts;
      updateDirty();
    }
    function updateDirty() {
      const count = trackedControls.filter(control => controlValue(control) !== control.dataset.initial).length
        + Number(JSON.stringify(remoteHosts) !== initialHosts)
        + Number(JSON.stringify(scShortcuts) !== initialShortcuts);
      unsaved.textContent = count ? `● ${count} unsaved change${count === 1 ? '' : 's'}` : '';
    }
    resetDirty();
    form.addEventListener('input', updateDirty);
    form.addEventListener('change', updateDirty);

    // see .ai/contexts/cli-harnesses.md ("Picker, toggles and settings")
    const harnessToggles = [...settingsViewerBody.querySelectorAll('.sv-harness-toggle')];
    const syncHarnessLock = () => {
      const on = harnessToggles.filter(t => t.checked);
      for (const t of harnessToggles) {
        const lock = on.length === 1 && t.checked;
        t.disabled = lock;
        const desc = settingsViewerBody.querySelector(`.sv-harness-desc[data-harness="${t.dataset.harness}"]`);
        if (desc && lock) desc.textContent = 'Kept on — at least one CLI must stay enabled';
        else if (desc && desc.textContent.startsWith('Kept on')) desc.textContent = 'Sessions indexed, watched and offered in the + menu';
      }
    };
    harnessToggles.forEach(t => t.addEventListener('change', syncHarnessLock));
    syncHarnessLock();

    let renderRemoteHosts;
    if (!isProject) {
      const list = settingsViewerBody.querySelector('#sv-archived-projects');
      const archivedManager = renderArchivedProjects(list, {
        entries: current.hiddenProjects || [], kinds: { ...current.hiddenProjectKinds },
        dates: current.hiddenProjectArchivedAt || {}, hosts: remoteHosts,
        folders: await window.api.getSetting('archivedProjects') || {},
        projects: typeof cachedAllProjects === 'undefined' ? [] : cachedAllProjects,
        onCount: count => {
          const nav = settingsViewerBody.querySelector('.settings-nav [data-section="archived"]');
          if (nav) nav.textContent = `Archived (${count})`;
        },
      });
      const renderArchived = () => archivedManager.setHosts(remoteHosts);

      const listEl = settingsViewerBody.querySelector('#sv-remote-hosts');

      renderRemoteHosts = () => {
        listEl.innerHTML = remoteHosts.map((h, i) => `
          <div class="remote-host-row" data-i="${i}">
            <label class="settings-toggle"><input type="checkbox" class="rh-enabled" ${h.enabled ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
            <input type="text" class="settings-input rh-alias" placeholder="ssh alias" value="${escapeHtml(h.alias)}">
            <input type="text" class="settings-input rh-label" placeholder="label (optional)" value="${escapeHtml(h.label)}">
            <button class="settings-check-updates-btn rh-check" title="Check this host: ssh, claude, tmux, ~/.claude and the login. Read-only.">Check host</button>
            <button class="settings-check-updates-btn rh-new-session" title="New session on ${escapeHtml(remoteHostLabel(h.alias, remoteHosts))}…" ${h.enabled ? '' : 'disabled'}>New session…</button>
            <button class="settings-remove-btn rh-remove" title="Remove host">Remove</button>
          </div>
          <div class="remote-host-enrol" data-i="${i}"></div>`).join('');
        listEl.querySelectorAll('.remote-host-row').forEach(row => {
          const i = Number(row.dataset.i);
          const launchButton = row.querySelector('.rh-new-session');
          let launchPending = false;
          const updateLaunchTitle = () => {
            launchButton.title = `New session on ${remoteHostLabel(remoteHosts[i].alias, remoteHosts)}…`;
          };
          row.querySelector('.rh-alias').addEventListener('input', e => {
            remoteHosts[i].alias = e.target.value;
            updateLaunchTitle();
            renderArchived();
          });
          row.querySelector('.rh-label').addEventListener('input', e => {
            remoteHosts[i].label = e.target.value;
            updateLaunchTitle();
            renderArchived();
          });
          row.querySelector('.rh-enabled').addEventListener('change', e => {
            remoteHosts[i].enabled = e.target.checked;
            launchButton.disabled = launchPending || !e.target.checked;
          });
          launchButton.addEventListener('click', async () => {
            if (launchPending) return;
            launchPending = true;
            launchButton.disabled = true;
            const alias = remoteHosts[i].alias.trim();
            const status = listEl.querySelector(`.remote-host-enrol[data-i="${i}"]`);
            try {
              const saved = await window.api.getSetting('global');
              if (!row.isConnected || remoteHosts[i].alias.trim() !== alias) return;
              if (!remoteHosts[i].enabled || !saved?.remoteHosts?.some(h => h.alias === alias && h.enabled !== false)) {
                status.textContent = 'Save the settings with this host enabled before starting a session.';
                return;
              }
              showRemoteLaunchDialog({ remoteAlias: alias, projectPath: '' });
            } catch (error) {
              status.textContent = 'Could not open a new session: ' + error.message;
            } finally {
              launchPending = false;
              launchButton.disabled = !remoteHosts[i]?.enabled;
            }
          });
          if (typeof wireRemoteEnrolControls === 'function') {
            wireRemoteEnrolControls(row.querySelector('.rh-check'), listEl.querySelector(`.remote-host-enrol[data-i="${i}"]`), () => remoteHosts[i].alias, () => remoteHostLabel(remoteHosts[i].alias.trim(), remoteHosts));
          }
          row.querySelector('.rh-remove').addEventListener('click', () => {
            remoteHosts.splice(i, 1);
            renderRemoteHosts();
            renderArchived();
          });
        });
        updateDirty();
      };
      renderRemoteHosts();

      settingsViewerBody.querySelector('#sv-remote-add').addEventListener('click', () => {
        remoteHosts.push({ alias: '', label: '', enabled: true });
        renderRemoteHosts();
        const rows = listEl.querySelectorAll('.rh-alias');
        if (rows.length) rows[rows.length - 1].focus();
      });
    }

    // Debug mode is a live switch: it does not go through Save.
    if (!isProject && typeof wireActivityReportingToggle === 'function') {
      const reportingStatus = settingsViewerBody.querySelector('#sv-activity-reporting-status');
      renderActivityReportingStatus(reportingStatus, reportingState);
      wireActivityReportingToggle(settingsViewerBody.querySelector('#sv-activity-reporting'), reportingStatus);
    }
    if (!isProject && typeof wireActivityTraceToggle === 'function') {
      const traceList = settingsViewerBody.querySelector('#sv-activity-trace-list');
      wireActivityTraceToggle(settingsViewerBody.querySelector('#sv-activity-trace'), traceList);
      renderActivityTraceFiles(traceList);
      window.wireDiagnosticFiles(settingsViewerBody, traceList);
    }

    // Use-global checkboxes toggle field disabled state
    const inheritedControls = {
      permissionMode: 'sv-perm-mode',
      worktree: 'sv-worktree',
      worktreeName: 'sv-worktree-name',
      browserMode: 'sv-browser-mode',
      sandbox: 'sv-sandbox',
      preLaunchCmd: 'sv-pre-launch',
      customArgs: 'sv-custom-args',
      addDirs: 'sv-add-dirs',
    };
    settingsViewerBody.querySelectorAll('.use-global-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const field = cb.dataset.field;
        const input = settingsViewerBody.querySelector('#' + inheritedControls[field]);
        if (input) input.disabled = cb.checked;
      });
    });

    // --- Keyboard shortcut rebinding (global only) ---
    // Capture listeners live on the button element itself (not on document), so
    // they can never leak app-wide: losing focus (incl. the settings viewer being
    // dismissed by ANY path) fires `blur` → stops capture, and re-opening the
    // viewer replaces settingsViewerBody, discarding the old listeners with it.
    let capturingBtn = null;
    function stopShortcutCapture() {
      if (capturingBtn) {
        capturingBtn.classList.remove('capturing');
        capturingBtn.textContent = formatBinding(capturingBtn.dataset.scId, scIsMac, scShortcuts);
        capturingBtn = null;
      }
    }
    settingsViewerBody.querySelectorAll('.settings-shortcut-btn').forEach(btn => {
      const id = btn.dataset.scId;
      const def = SHORTCUT_DEFS.find(d => d.id === id);
      btn.addEventListener('click', () => {
        // Clicking the button that is already capturing resets it to default.
        if (capturingBtn === btn) {
          scShortcuts = { ...scShortcuts, [id]: normalizeShortcuts(null)[id] };
          stopShortcutCapture();
          updateDirty();
          btn.blur();
          return;
        }
        stopShortcutCapture();
        capturingBtn = btn;
        btn.classList.add('capturing');
        btn.textContent = 'Press keys…';
        btn.focus();
      });
      // keydown only acts while THIS button is the one capturing.
      btn.addEventListener('keydown', (e) => {
        if (capturingBtn !== btn) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') { stopShortcutCapture(); btn.blur(); return; }
        const binding = captureBinding(e, def, scIsMac);
        if (!binding) return; // chord incomplete — keep listening
        scShortcuts = { ...scShortcuts, [id]: binding };
        stopShortcutCapture();
        updateDirty();
        btn.blur();
      });
      // Losing focus (click elsewhere, panel dismissed, tab switch) cancels capture.
      btn.addEventListener('blur', () => {
        if (capturingBtn === btn) stopShortcutCapture();
      });
    });

    // Save button
    async function saveSettings() {
      for (const input of settingsViewerBody.querySelectorAll('#sv-custom-args, #sv-codex-custom-args')) {
        if (input.disabled) continue;
        const check = validateCustomArgs(input.value);
        input.setCustomValidity(check.ok ? '' : check.error);
        if (!check.ok) {
          const page = input.closest('.settings-page');
          settingsViewerBody.querySelector(`.settings-nav [data-section="${page?.dataset.section}"]`)?.click();
          input.reportValidity();
          return;
        }
      }
      let settings = {};
      let rejectedHosts = false;
      const submitted = dirtySnapshot();

      if (isProject) {
        // Only save fields where "use global" is unchecked
        settingsViewerBody.querySelectorAll('.use-global-cb').forEach(cb => {
          if (!cb.checked) {
            const field = cb.dataset.field;
            const fieldMap = {
              permissionMode: () => settingsViewerBody.querySelector('#sv-perm-mode').value || null,
              worktree: () => settingsViewerBody.querySelector('#sv-worktree').checked,
              worktreeName: () => settingsViewerBody.querySelector('#sv-worktree-name').value.trim(),
              browserMode: () => settingsViewerBody.querySelector('#sv-browser-mode').value,
              sandbox: () => settingsViewerBody.querySelector('#sv-sandbox').checked,
              preLaunchCmd: () => settingsViewerBody.querySelector('#sv-pre-launch').value.trim(),
              customArgs: () => settingsViewerBody.querySelector('#sv-custom-args').value,
              addDirs: () => settingsViewerBody.querySelector('#sv-add-dirs').value.trim(),
            };
            if (fieldMap[field]) settings[field] = fieldMap[field]();
          }
        });
      } else {
        settings.permissionMode = settingsViewerBody.querySelector('#sv-perm-mode').value || null;
        settings.worktree = settingsViewerBody.querySelector('#sv-worktree').checked;
        settings.worktreeName = settingsViewerBody.querySelector('#sv-worktree-name').value.trim();
        settings.browserMode = settingsViewerBody.querySelector('#sv-browser-mode').value;
        const sandboxToggle = settingsViewerBody.querySelector('#sv-sandbox');
        if (sandboxToggle) settings.sandbox = sandboxToggle.checked;
        settings.preLaunchCmd = settingsViewerBody.querySelector('#sv-pre-launch').value.trim();
        settings.customArgs = settingsViewerBody.querySelector('#sv-custom-args').value;
        settings.addDirs = settingsViewerBody.querySelector('#sv-add-dirs').value.trim();
        if (harnessToggles.length) settings.disabledHarnesses = harnessToggles.filter(t => !t.checked).map(t => t.dataset.harness);
        const usageToggle = settingsViewerBody.querySelector('#sv-show-codex-usage');
        if (usageToggle) settings.showCodexUsage = usageToggle.checked;
        for (const [key, id] of [['codexSandbox', 'sv-codex-sandbox'], ['codexApproval', 'sv-codex-approval'], ['codexModel', 'sv-codex-model'], ['codexEffort', 'sv-codex-effort'], ['codexCustomArgs', 'sv-codex-custom-args']]) {
          const field = settingsViewerBody.querySelector('#' + id);
          if (field) settings[key] = field.value;
        }
        settings.visibleSessionCount = parseInt(settingsViewerBody.querySelector('#sv-visible-count').value) || SETTING_DEFAULTS.visibleSessionCount;
        settings.sessionMaxAgeDays = parseInt(settingsViewerBody.querySelector('#sv-max-age').value) || SETTING_DEFAULTS.sessionMaxAgeDays;
        const logRetention = settingsViewerBody.querySelector('#sv-log-retention-days');
        settings.logRetentionDays = logRetention.checkValidity() ? Number(logRetention.value) : appliedLogRetention;
        settings.terminalTheme = settingsViewerBody.querySelector('#sv-terminal-theme').value || SETTING_DEFAULTS.terminalTheme;
        settings.theme = settingsViewerBody.querySelector('#sv-theme').value || SETTING_DEFAULTS.theme;
        settings.terminalRightClick = settingsViewerBody.querySelector('#sv-right-click').value || SETTING_DEFAULTS.terminalRightClick;
        settings.restoreOnStartup = settingsViewerBody.querySelector('#sv-restore-startup').value || SETTING_DEFAULTS.restoreOnStartup;
        settings.hideSdkSessions = settingsViewerBody.querySelector('#sv-hide-sdk').checked;
        settings.mcpEmulation = settingsViewerBody.querySelector('#sv-mcp-emulation').checked;
        settings.schedulesTab = settingsViewerBody.querySelector('#sv-schedules-tab').checked;
        settings.autoUpdate = settingsViewerBody.querySelector('#sv-auto-update').checked;
        settings.receiveBetaVersions = settingsViewerBody.querySelector('#sv-receive-beta-versions').checked;
        settings.shellProfile = settingsViewerBody.querySelector('#sv-shell-profile').value || SETTING_DEFAULTS.shellProfile;
        settings.shortcuts = scShortcuts;
        // Same alias rule as remote-hosts.js; a failing row is reported.
        const aliasRe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
        const rejected = [];
        settings.remoteHosts = remoteHosts
          .map(h => ({ alias: h.alias.trim(), label: h.label.trim(), enabled: h.enabled }))
          .filter(h => {
            if (!h.alias) return false;
            if (aliasRe.test(h.alias)) return true;
            rejected.push(h.alias);
            return false;
          });
        const statusEl = settingsViewerBody.querySelector('#sv-remote-status');
        rejectedHosts = rejected.length > 0;
        if (rejectedHosts) submitted.hosts = JSON.stringify(settings.remoteHosts);
        if (statusEl) {
          statusEl.textContent = rejected.length
            ? 'Not saved (an ssh alias may only contain letters, digits, dot, dash or underscore): ' + rejected.join(', ')
            : '';
        }
        settings.remoteRefreshMs = Math.max(1, parseInt(settingsViewerBody.querySelector('#sv-remote-refresh').value, 10) || SETTING_DEFAULTS.remoteRefreshMs / 60000) * 60000;
      }
      stopShortcutCapture();

      delete settings.chrome;
      if (window.projectDeletionWritesBlocked || (isProject && isProjectDeleting(project || { projectPath }))) {
        showAppNotice({ id: 'settings-delete-busy', kind: 'error', message: 'Settings were not saved while a project deletion is pending. Check its outcome, then save again.' });
        return;
      }
      let deferred = false;
      if (!isProject) {
        deferred = await saveGlobalSettings(settings, { remove: ['chrome'] }) === 'deferred';
        if (deferred) {
          showAppNotice({ id: 'settings-delete-busy', message: 'Settings applied. They will be saved when the project deletion finishes.' });
        }
      } else await window.api.setSetting(settingsKey, settings);
      if (!isProject) setRemoteHostLabels(settings.remoteHosts);

      // Update visibleSessionCount, sessionMaxAgeDays, and theme
      if (!isProject) {
        window._applySchedulesTab?.(settings.schedulesTab);
        if (Array.isArray(settings.disabledHarnesses)) window._applyUsageHarnesses?.(settings.disabledHarnesses);
        if (typeof settings.showCodexUsage === 'boolean' && settings.showCodexUsage !== appliedCodexUsage) {
          window._applyCodexUsage?.(settings.showCodexUsage);
          appliedCodexUsage = settings.showCodexUsage;
        }
        if (settings.visibleSessionCount && typeof window._setVisibleSessionCount === 'function') {
          window._setVisibleSessionCount(settings.visibleSessionCount);
        }
        if (settings.sessionMaxAgeDays && typeof window._setSessionMaxAge === 'function') {
          window._setSessionMaxAge(settings.sessionMaxAgeDays);
        }
        window.appTheme?.apply(settings.theme);
        if (settings.terminalTheme && typeof window._applyTerminalTheme === 'function') {
          window._applyTerminalTheme(settings.terminalTheme);
        }
        if (settings.terminalRightClick && typeof window._applyTerminalRightClick === 'function') {
          window._applyTerminalRightClick(settings.terminalRightClick);
        }
        if (settings.shortcuts && typeof window._applyShortcuts === 'function') {
          window._applyShortcuts(settings.shortcuts);
        }
        if (settings.hideSdkSessions !== appliedHideSdk && typeof loadProjects === 'function') {
          await Promise.resolve(loadProjects()).catch(error => { if (!loadProjects.state?.reportedErrors?.has(error)) console.warn('[switchboard] project reload failed', error); });
        } else if (typeof refreshSidebar === 'function') {
          refreshSidebar();
        }
        appliedHideSdk = settings.hideSdkSessions;
        appliedLogRetention = settings.logRetentionDays;
        // Re-arm the remote refresher so a host added here pulls immediately.
        try { await window.api.remoteHostsApply(); } catch {}
      }

      if (!form.isConnected) return;

      // Notify if IDE Emulation changed
      if (!isProject && settings.mcpEmulation !== appliedMcpEmulation) {
        const notice = document.createElement('div');
        notice.className = 'settings-notice';
        notice.textContent = 'IDE Emulation setting changed. New sessions will use the updated setting \u2014 running sessions are not affected.';
        const saveBtn = settingsViewerBody.querySelector('#sv-save-btn');
        saveBtn.parentElement.insertBefore(notice, saveBtn);
        setTimeout(() => notice.remove(), 8000);
      }
      appliedMcpEmulation = settings.mcpEmulation;

      const normalizedControls = {
        'sv-worktree-name': settings.worktreeName,
        'sv-pre-launch': settings.preLaunchCmd,
        'sv-add-dirs': settings.addDirs,
        'sv-visible-count': settings.visibleSessionCount,
        'sv-max-age': settings.sessionMaxAgeDays,
        'sv-log-retention-days': settings.logRetentionDays,
        'sv-remote-refresh': settings.remoteRefreshMs === undefined ? undefined : settings.remoteRefreshMs / 60000,
      };
      if (isProject) {
        for (const [field, id] of Object.entries(inheritedControls)) {
          if (!(field in settings)) normalizedControls[id] = globalSettings[field] !== undefined ? globalSettings[field] : SETTING_DEFAULTS[field];
        }
      }
      if (normalizedControls['sv-browser-mode'] === 'managed') normalizedControls['sv-browser-mode'] = 'off';
      trackedControls.forEach((control, index) => {
        if (normalizedControls[control.id] === undefined) return;
        const normalized = String(control.type === 'checkbox' ? !!normalizedControls[control.id] : normalizedControls[control.id] ?? '');
        if (controlValue(control) === submitted.values[index]) {
          if (control.type === 'checkbox') control.checked = normalizedControls[control.id];
          else control.value = normalized;
        }
        submitted.values[index] = normalized;
      });
      if (!isProject && !rejectedHosts && JSON.stringify(remoteHosts) === submitted.hosts && JSON.stringify(settings.remoteHosts) !== submitted.hosts) {
        remoteHosts = settings.remoteHosts.map(h => ({ ...h }));
        renderRemoteHosts();
        submitted.hosts = JSON.stringify(remoteHosts);
      }

      const saveBtn = settingsViewerBody.querySelector('#sv-save-btn');
      saveBtn.textContent = rejectedHosts ? 'Some changes not saved' : deferred ? '✓ Applied' : '✓ Saved';
      saveBtn.classList.toggle('saved', !rejectedHosts);
      resetDirty(submitted);
      clearTimeout(savedFlashTimer);
      savedFlashTimer = setTimeout(() => {
        saveBtn.classList.remove('saved');
        saveBtn.textContent = 'Save Settings';
      }, 1500);
    }
    const saveButton = form.querySelector('#sv-save-btn');
    saveButton.addEventListener('click', async () => {
      if (saveButton.disabled) return;
      saveButton.disabled = true;
      try {
        await saveSettings();
      } finally {
        saveButton.disabled = false;
      }
    });

    // Cancel button
    settingsViewerBody.querySelector('#sv-cancel-btn').addEventListener('click', () => {
      stopShortcutCapture();
      closeSettingsViewer();
    });

    // Check for updates button + current version + inline status
    const checkUpdatesBtn = settingsViewerBody.querySelector('#sv-check-updates-btn');
    if (checkUpdatesBtn) {
      const updateStatusEl = settingsViewerBody.querySelector('#sv-update-status');
      window.api.getAppVersion().then(v => {
        const el = settingsViewerBody.querySelector('#sv-current-version');
        if (el) el.textContent = `v${v}`;
      });
      const settingsUpdaterHandler = (type, data) => {
        if (!updateStatusEl) return;
        switch (type) {
          case 'checking': updateStatusEl.textContent = '\u2014 checking\u2026'; break;
          case 'update-available': updateStatusEl.textContent = `\u2014 v${data.version} available`; break;
          case 'update-not-available': updateStatusEl.textContent = '\u2014 up to date'; break;
          case 'download-progress': updateStatusEl.textContent = `\u2014 downloading ${Math.round(data.percent)}%`; break;
          case 'update-downloaded': updateStatusEl.textContent = `\u2014 v${data.version} ready, restart to update`; break;
          case 'error': updateStatusEl.textContent = '\u2014 check failed'; break;
        }
      };
      window.api.onUpdaterEvent(settingsUpdaterHandler);
      checkUpdatesBtn.addEventListener('click', () => {
        window.api.updaterCheck();
      });
    }

    for (const action of ['archive', 'delete']) {
      const button = settingsViewerBody.querySelector('#sv-' + action + '-btn');
      if (!button) continue;
      if (project) button.dataset.deleteProjectKey = projectDeletionKey(project);
      paintProjectDeletionBusy();
      button.addEventListener('click', async () => {
        const deleting = action === 'delete';
        if (deleting) {
          if (!project) {
            showAppNotice({ id: 'project-delete-unavailable', kind: 'error', message: 'Project identity is unavailable. Reload the project list, then reopen Settings.' });
            return;
          }
          const completed = await confirmAndDeleteProjectFolder(project, button);
          if (completed) { settingsViewer.style.display = 'none'; document.getElementById('placeholder').style.display = 'flex'; }
          return;
        }
        if (project && isProjectDeleting(project)) return;
        try {
          const response = await window.api.archiveProjectSettings(projectPath, folderKey);
          if (response.error) throw new Error(response.error);
          if (!deleting) window.showProjectArchiveUndo(response.entry, shortName);
          settingsViewer.style.display = 'none';
          document.getElementById('placeholder').style.display = 'flex';
          if (typeof loadProjects === 'function') await Promise.resolve(loadProjects()).catch(error => { if (!loadProjects.state?.reportedErrors?.has(error)) console.warn('[switchboard] project reload failed', error); });
        } catch (err) {
          await appAlert({ title: `Could not ${action} project`, message: err.message });
        }
      });
    }
  }

  // Expose globally
  window.openSettingsViewer = openSettingsViewer;
  window.closeSettingsViewer = closeSettingsViewer;
})();
