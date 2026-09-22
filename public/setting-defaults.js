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
  chrome: false,
  sandbox: false,
  preLaunchCmd: '',
  addDirs: '',
  visibleSessionCount: 10,
  sessionMaxAgeDays: 3,
  sidebarWidth: 340,
  terminalTheme: 'switchboard',
  terminalRightClick: 'menu',
  restoreOnStartup: 'ask',
  mcpEmulation: false,
  // Automatic update download + install-on-quit. On by default so behaviour is
  // unchanged; off means the app never fetches or swaps its own binary without
  // being asked. The manual "Check for Updates" button still works either way.
  autoUpdate: true,
  shellProfile: 'auto',
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SETTING_DEFAULTS };
}
