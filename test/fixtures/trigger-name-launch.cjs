'use strict';
// see .ai/contexts/trigger-watcher.md ("Naming a new session")
const { fixture, ID } = require('./trigger-main-open.cjs');
const profiles = require('../../src/main/terminals/shell-profiles');
const { validatePreLaunchCmd } = require('../../src/main/terminals/pre-launch-cmd-guard');

async function launch(shellPath, { name, isNew = true, options = {}, env = {}, transcript = false, git = false } = {}) {
  const f = fixture({ resolveShell: () => ({ path: shellPath }), quoteArgvForShell: profiles.quoteArgvForShell,
    shellArgs: profiles.shellArgs, isWslShell: profiles.isWslShell, windowsToWslPath: profiles.windowsToWslPath, os: require('node:os'),
    validatePreLaunchCmd, sandboxScriptPath: () => '/opt/switchboard/claude-sandbox.sh', sandboxBindEnv: () => null,
    sessionTranscriptExists: () => transcript, cleanPtyEnv: env, isGitRepo: () => git,
    parseAddDirs: value => String(value || '').split(',').map(dir => dir.trim()).filter(Boolean) });
  if (name !== undefined) {
    f.permit.mode = 'new'; f.permit.requestedSessionId = null; f.permit.name = name; f.authorize();
  }
  const result = await f.open(name === undefined ? null : 'permit', isNew, options);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return f.spawns[0];
}

module.exports = { launch, ID };
