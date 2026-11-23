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
  customArgs: '',
  addDirs: '',
  visibleSessionCount: 10,
  sessionMaxAgeDays: 3,
  hideSdkSessions: true,
  sidebarWidth: 340,
  theme: 'dark',
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
  logRetentionDays: 14,
  remoteTriggers: false,
  remoteHosts: [],
  remoteRefreshMs: 300000,
  schedulesTab: false,
  lastSeenVersion: null, // see docs/changelog.md
  // see .ai/contexts/cli-harnesses.md ("Picker, toggles and settings")
  disabledHarnesses: [],
  codexSandbox: '',
  codexApproval: '',
  codexModel: '',
  codexEffort: '',
  codexCustomArgs: '',
  showCodexUsage: false,
};

const PROJECT_DELETE_PREVIEW_TIMEOUT_MS = 20000;
const PROJECT_DELETE_DIALOG_TIMEOUT_MS = PROJECT_DELETE_PREVIEW_TIMEOUT_MS + 1000;
const PROJECT_DELETE_FOLLOWUP_TIMEOUT_MS = 3 * PROJECT_DELETE_PREVIEW_TIMEOUT_MS + 2 * 10000 + 60000 + 60000 + 70000 + 10000 + 3 * 10000 + 15000;
const PROJECT_DELETE_WORKTREE_INSPECTION_TIMEOUT_MS = 15000;
const PROJECT_DELETE_WORKTREE_REMOVE_TIMEOUT_MS = 120000;
const DIRECTORY_SCAN_MS = 5000;

const THEME_CHOICES = [['dark', 'Dark'], ['light', 'Light'], ['system', 'System']];

const CODEX_CHOICES = {
  codexSandbox: [['', 'Codex default'], ['read-only', 'Read-only'], ['workspace-write', 'Workspace write'], ['danger-full-access', 'Full access (danger)']],
  codexApproval: [['', 'Codex default'], ['on-request', 'On request'], ['never', 'Never']],
  codexEffort: [['', 'Codex default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max'], ['ultra', 'Ultra']],
};

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

function validateCustomArgs(value) {
  if (typeof value !== 'string') return { ok: false, error: 'Custom arguments must be a string' };
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) {
    return { ok: false, error: 'Custom arguments must not contain newlines or control characters' };
  }
  return { ok: true };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SETTING_DEFAULTS, THEME_CHOICES, CODEX_CHOICES, BROWSER_MODES, normalizeBrowserSettings, validateCustomArgs,
    PROJECT_DELETE_PREVIEW_TIMEOUT_MS, PROJECT_DELETE_DIALOG_TIMEOUT_MS, PROJECT_DELETE_FOLLOWUP_TIMEOUT_MS,
    PROJECT_DELETE_WORKTREE_INSPECTION_TIMEOUT_MS, PROJECT_DELETE_WORKTREE_REMOVE_TIMEOUT_MS, DIRECTORY_SCAN_MS };
}
