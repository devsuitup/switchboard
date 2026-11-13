// The one table of setting defaults, read by the main process and the renderer —
// see .ai/contexts/ipc-bridge.md ("Settings").
'use strict';

const SETTING_DEFAULTS = {
  // 'auto' is Claude Code's own default permission mode (it classifies each
  // action, allows routine work, and stops for risky ones). It applies only
  // when NEITHER global nor project settings have ever saved this key — see
  // get-effective-settings in main.js. A user who explicitly picked "Default"
  // (prompt for all actions, --permission-mode omitted) has that stored as an
  // explicit `null`, which is honored as-is and never promoted to 'auto'.
  permissionMode: 'auto',
  dangerouslySkipPermissions: false,
  worktree: false,
  worktreeName: '',
  browserMode: 'off',
  sandbox: false,
  preLaunchCmd: '',
  addDirs: '',
  visibleSessionCount: 10,
  sessionMaxAgeDays: 3,
  hideSdkSessions: true,
  sidebarWidth: 340,
  terminalTheme: 'switchboard',
  terminalRightClick: 'menu',
  restoreOnStartup: 'ask',
  mcpEmulation: false,
  // Automatic update download + install-on-quit. On by default so behaviour is
  // unchanged; off means the app never fetches or swaps its own binary without
  // being asked. The manual "Check for Updates" button still works either way.
  autoUpdate: true,
  receiveBetaVersions: false,
  shellProfile: 'auto',
  activityReporting: false, // see .ai/contexts/activitywatch.md
  remoteTriggers: false,
  schedulesTab: false,
  lastSeenVersion: null, // see docs/changelog.md
};

const PROJECT_DELETE_PREVIEW_TIMEOUT_MS = 20000;
const PROJECT_DELETE_DIALOG_TIMEOUT_MS = PROJECT_DELETE_PREVIEW_TIMEOUT_MS + 1000;
const PROJECT_DELETE_FOLLOWUP_TIMEOUT_MS = 3 * PROJECT_DELETE_PREVIEW_TIMEOUT_MS + 2 * 10000 + 60000 + 60000 + 70000 + 10000 + 3 * 10000 + 15000;
const PROJECT_DELETE_WORKTREE_INSPECTION_TIMEOUT_MS = 15000;
const PROJECT_DELETE_WORKTREE_REMOVE_TIMEOUT_MS = 120000;
const DIRECTORY_SCAN_MS = 5000;

const BROWSER_MODES = Object.freeze([
  Object.freeze({ value: 'off', label: 'Off' }),
  Object.freeze({ value: 'claude-in-chrome', label: 'Claude in Chrome' }),
  Object.freeze({ value: 'managed', label: 'Managed browser' }),
]);

function normalizeBrowserSettings(settings, diagnostic = message => console.warn(message)) {
  const normalized = { ...settings };
  if (normalized.browserMode !== undefined) {
    if (!BROWSER_MODES.some(mode => mode.value === normalized.browserMode)) {
      diagnostic('[settings] Invalid browserMode; using Off');
      normalized.browserMode = SETTING_DEFAULTS.browserMode;
    }
  } else if (normalized.chrome !== undefined) {
    normalized.browserMode = normalized.chrome === true ? 'claude-in-chrome' : SETTING_DEFAULTS.browserMode;
  }
  delete normalized.chrome;
  return normalized;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SETTING_DEFAULTS, BROWSER_MODES, normalizeBrowserSettings,
    PROJECT_DELETE_PREVIEW_TIMEOUT_MS, PROJECT_DELETE_DIALOG_TIMEOUT_MS, PROJECT_DELETE_FOLLOWUP_TIMEOUT_MS,
    PROJECT_DELETE_WORKTREE_INSPECTION_TIMEOUT_MS, PROJECT_DELETE_WORKTREE_REMOVE_TIMEOUT_MS, DIRECTORY_SCAN_MS };
}
