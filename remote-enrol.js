// remote-enrol.js — see .ai/contexts/session-cache.md ("Remote hosts — enrolment")
'use strict';

const { isValidAlias } = require('./remote-hosts');

const UNKNOWN_AUTH_TEXT = 'unknown — run `claude` on the host once to log in';
const INSTALL_CLAUDE_COMMAND = 'curl -fsSL https://claude.ai/install.sh | bash';
const INSTALL_TMUX_COMMAND = 'sudo apt install tmux';
const LOGIN_COMMAND = 'claude auth login';
const running = new Set();
const NOT_CHECKED_UNREACHABLE = 'not checked: ssh did not connect';

function item(id, label, status, detail, command = null, where = 'host', optional = false) {
  const out = { id, label, status, detail, command: command || null, where: command ? where : null };
  if (optional) out.optional = true;
  return out;
}

function unreachableItems(alias, detail) {
  return [
    item('ssh', 'ssh reachable', 'missing', detail || 'ssh did not connect', `ssh -o BatchMode=yes ${alias} true`, 'workstation'),
    item('claude', 'claude CLI', 'unknown', NOT_CHECKED_UNREACHABLE),
    item('tmux', 'tmux', 'unknown', NOT_CHECKED_UNREACHABLE, null, 'host', true),
    item('claude-dir', '~/.claude', 'unknown', NOT_CHECKED_UNREACHABLE),
    item('auth', 'account logged in', 'unknown', NOT_CHECKED_UNREACHABLE),
  ];
}

function noFactsItems(detail) {
  const why = `${detail || 'no answer'} — only Linux hosts are checked`;
  return [
    item('ssh', 'ssh reachable', 'ok', 'connected'),
    item('claude', 'claude CLI', 'unknown', why),
    item('tmux', 'tmux', 'unknown', why, null, 'host', true),
    item('claude-dir', '~/.claude', 'unknown', why),
    item('auth', 'account logged in', 'unknown', why),
  ];
}

function authItem(alias, facts) {
  if (!facts.claude) return item('auth', 'account logged in', 'unknown', 'needs the claude CLI first');
  if (facts.auth === true) {
    return item('auth', 'account logged in', 'ok', 'claude auth status exits 0; Switchboard reads only that exit status, never the credentials');
  }
  if (facts.auth === false) {
    return item('auth', 'account logged in', 'missing',
      `claude auth status exits 1: not logged in. Run this on the host, in a terminal there (for example after ssh -t ${alias}). Switchboard never copies or reads credentials.`,
      LOGIN_COMMAND);
  }
  return item('auth', 'account logged in', 'unknown', UNKNOWN_AUTH_TEXT, 'claude');
}

function buildChecklist(alias, result) {
  if (!result || result.reachable !== true) return unreachableItems(alias, result && result.detail);
  const facts = result.facts;
  if (!facts) return noFactsItems(result.detail);
  return [
    item('ssh', 'ssh reachable', 'ok', 'connected'),
    facts.claude
      ? item('claude', 'claude CLI', 'ok', facts.claudeVersion ? `version ${facts.claudeVersion}` : 'present, version unreadable')
      : item('claude', 'claude CLI', 'missing',
        'not found on the PATH of an ssh command. Install it on the host, or make it visible to non-interactive shells.',
        INSTALL_CLAUDE_COMMAND),
    facts.tmux
      ? item('tmux', 'tmux', 'ok', 'installed', null, 'host', true)
      : item('tmux', 'tmux', 'missing',
        'none: the host can be observed, but its sessions cannot be launched or attached from here. Other multiplexers are not supported.',
        INSTALL_TMUX_COMMAND, 'host', true),
    facts.claudeDir
      ? item('claude-dir', '~/.claude', 'ok', 'present')
      : item('claude-dir', '~/.claude', 'missing', 'absent: the CLI has never run for this user on the host.', LOGIN_COMMAND),
    authItem(alias, facts),
  ];
}

async function handleEnrolRequest(payload, deps) {
  const alias = payload && payload.alias;
  if (typeof alias !== 'string' || !isValidAlias(alias) || !deps.isDeclared(alias)) {
    return { ok: false, error: 'not a declared host — save the settings first' };
  }
  if (running.has(alias)) return { ok: false, error: `a check of ${alias} is already running` };
  running.add(alias);
  try {
    const result = await deps.transport.checkHost(alias);
    return { ok: true, alias, items: buildChecklist(alias, result) };
  } catch (err) {
    return { ok: false, error: `check failed: ${err.message}` };
  } finally {
    running.delete(alias);
  }
}

module.exports = { buildChecklist, handleEnrolRequest, UNKNOWN_AUTH_TEXT, LOGIN_COMMAND };
