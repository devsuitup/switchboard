'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scrubSessionEnv } = require('../src/main/shared/clean-env');

function validatePr(pr) {
  if (!/^\d+$/.test(String(pr ?? ''))) throw new Error('PR must be numeric: task test-pr PR=<number>');
}

function hasProxyCredentials(value) {
  if (/[\u0000-\u001f\u007f]/.test(value)) return true;
  const normalized = value.trim();
  if (/[^\x20-\x7e]/.test(normalized)) return true;
  if (normalized === '') return false;
  try {
    const proxy = new URL(/^(?:[a-z][a-z\d+.-]*:\/\/|https?:)/i.test(normalized)
      ? normalized : `http:${normalized.startsWith('//') ? '' : '//'}${normalized}`);
    return proxy.username !== '' || proxy.password !== '';
  } catch {
    return true;
  }
}

function buildLaunch({ pr, home = process.env.HOME || os.homedir(), env = process.env,
  isolated = false, tempHome, port = 9223, platform = process.platform, entry = '.' }) {
  validatePr(pr);
  env = scrubSessionEnv({ ...env });
  const pathKeys = Object.keys(env).filter(key => key.toUpperCase() === 'PATH').sort();
  if (platform === 'win32' && pathKeys.length) {
    const originalPath = env[pathKeys[0]];
    env = { ...Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== 'PATH')), PATH: originalPath };
  }
  const data = path.join(home, `.switchboard-dev-pr${pr}`);
  if (!isolated) {
    return { env: { ...env, SWITCHBOARD_DATA_DIR: data, SWITCHBOARD_TRIGGERS_DIR: path.join(data, 'triggers') },
      args: [entry, '--no-sandbox'] };
  }
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error('Debug port must be an integer from 1 to 65535');
  if (!tempHome) throw new Error('Isolated mode requires a temporary home');
  const inherited = Object.fromEntries(Object.entries(env).filter(([key, value]) =>
    key !== 'PATH' && !/^(CLAUDE|GIT_|ANTHROPIC_|AWS_)|^(CODEX_HOME|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_CACHE_HOME|XDG_STATE_HOME|ZDOTDIR|BASH_ENV|ENV|ORIGINAL_PATH|ELECTRON_RUN_AS_NODE|HISTFILE|GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|SSH_AUTH_SOCK|SSH_AGENT_PID|OPENAI_API_KEY|GOOGLE_APPLICATION_CREDENTIALS)$/i.test(key) &&
    !/_(TOKEN|API_KEY|APIKEY|SECRET|SECRET_KEY|PASSWORD|PAT)$/i.test(key) &&
    !/(PASSWORD|TOKEN)$|^MYSQL_PWD$/i.test(key) &&
    !/^(GLAB_|GITLAB_|AZURE_)|^DOCKER_AUTH_CONFIG$/i.test(key) &&
    !(/^(?:(HTTP|HTTPS|ALL)_PROXY|npm_config_https_proxy)$/i.test(key) && hasProxyCredentials(value))));
  const originalPath = env.PATH || '';
  const fixtureData = path.join(tempHome, '.switchboard-test-pr');
  return {
    env: {
      ...inherited,
      HOME: tempHome,
      USERPROFILE: tempHome,
      CODEX_HOME: path.join(tempHome, '.codex'),
      APPDATA: path.join(tempHome, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(tempHome, 'AppData', 'Local'),
      XDG_CONFIG_HOME: path.join(tempHome, '.config'),
      XDG_DATA_HOME: path.join(tempHome, '.local', 'share'),
      XDG_CACHE_HOME: path.join(tempHome, '.cache'),
      XDG_STATE_HOME: path.join(tempHome, '.local', 'state'),
      PATH: path.join(tempHome, 'bin') + path.delimiter + originalPath,
      SWITCHBOARD_DATA_DIR: fixtureData,
      SWITCHBOARD_TRIGGERS_DIR: path.join(fixtureData, 'triggers'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(tempHome, '.gitconfig'),
    },
    args: [entry, '--no-sandbox', `--remote-debugging-port=${Number(port)}`],
  };
}

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

const DROPPED_ENV = /^(CLAUDE|GIT_)|^(CODEX_HOME|ELECTRON_RUN_AS_NODE|HISTFILE|ZDOTDIR|BASH_ENV|ENV|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_CACHE_HOME|XDG_STATE_HOME)$/i;

function isolatedEnv(home, env = process.env) {
  const data = path.join(home, '.switchboard-e2e');
  const inherited = Object.fromEntries(Object.entries(env)
    .filter(([k]) => !DROPPED_ENV.test(k)));
  return {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    SWITCHBOARD_DATA_DIR: data,
    SWITCHBOARD_TRIGGERS_DIR: path.join(data, 'triggers'),
    GIT_CONFIG_NOSYSTEM: '1',
    ...GIT_IDENTITY,
  };
}

function writeRefusingStubs(home, { allowClaude = false } = {}) {
  for (const command of allowClaude ? ['codex'] : ['claude', 'codex']) {
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const message = `${command} is disabled in isolated test-pr mode`;
    fs.writeFileSync(path.join(bin, command), `#!/bin/sh\necho '${message}' >&2\nexit 1\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, `${command}.cmd`), `@echo off\r\necho ${message} 1>&2\r\nexit /b 1\r\n`);
    fs.writeFileSync(path.join(bin, `${command}.ps1`), `[Console]::Error.WriteLine('${message}')\nexit 1\n`);
  }
}

module.exports = { validatePr, buildLaunch, isolatedEnv, writeRefusingStubs };
