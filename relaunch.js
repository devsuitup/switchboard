'use strict';

// see .ai/contexts/updater-relaunch.md
module.exports = async function relaunch({
  execPath = process.env.APPIMAGE || process.execPath, argv = process.argv.slice(1), cwd = process.cwd(),
  env = process.env, spawnSync = require('node:child_process').spawnSync, now = Date.now,
  quit, notify, log = console,
}) {
  const args = ['--user', `--unit=switchboard-relaunch-${now()}-${process.pid}`, '--collect', '--service-type=exec', `--working-directory=${cwd}`];
  for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'SWITCHBOARD_DATA_DIR']) {
    if (env[key]) args.push(`--setenv=${key}=${env[key]}`);
  }
  const commandArgs = argv.filter(arg => arg !== '--switchboard-relaunch').map(arg => arg.replace(/\$/g, () => '$$'));
  args.push('--', execPath, ...commandArgs, '--switchboard-relaunch');
  let result;
  try {
    result = spawnSync('systemd-run', args, { shell: false, timeout: 5000, encoding: 'utf8', env });
  } catch (error) { result = { error }; }
  if (result.error || result.status !== 0) {
    log.warn('[relaunch] user service unavailable:', result.error?.message || result.stderr || result.status);
    await notify('Switchboard will close; start it again from the application menu.');
  }
  quit();
};
