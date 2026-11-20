'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { formatResetTime } = require('../../../claude-auth');

function windowLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'usage';
  if (seconds >= 2419200) return `${Math.round(seconds / 2592000)}mo`;
  if (seconds >= 604800) return `${Math.round(seconds / 604800)}wk`;
  if (seconds >= 86400) return `${Math.round(seconds / 86400)}d`;
  return `${Math.max(1, Math.round(seconds / 3600))}h`;
}

function usageRows(raw) {
  const limits = [];
  const add = (win, model = null) => {
    if (!win || !Number.isFinite(win.used_percent) || win.used_percent < 0 || win.used_percent > 100) return;
    const percent = Math.floor(win.used_percent);
    if (model && percent === 0) return;
    const short = windowLabel(win.limit_window_seconds);
    limits.push({
      kind: 'codex', short,
      label: model ? `Codex ${model} (${short})` : `Codex ${short}`,
      percent,
      reset: formatResetTime(win.reset_at),
      severity: percent >= 90 ? 'high' : 'normal',
    });
  };
  add(raw?.rate_limit?.primary_window);
  add(raw?.rate_limit?.secondary_window);
  for (const extra of Array.isArray(raw?.additional_rate_limits) ? raw.additional_rate_limits : []) {
    const name = typeof extra?.limit_name === 'string' ? extra.limit_name : 'model';
    add(extra?.rate_limit?.primary_window, name);
    add(extra?.rate_limit?.secondary_window, name);
  }
  return limits.length ? { limits } : {};
}

function createCodexUsage({ isEnabled, env = process.env, homedir = os.homedir,
  readFile = fs.readFileSync, fetch = globalThis.fetch, now = Date.now,
  setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout }) {
  let pending = null;
  let controller = null;
  let generation = 0;
  let retryAt = 0;
  let failures = 0;

  function settingsChanged() {
    generation++;
    controller?.abort();
    controller = null;
    pending = null;
  }

  async function getUsage() {
    if (!isEnabled()) return {};
    if (pending) return pending;
    if (now() < retryAt) return {};
    const requestGeneration = generation;
    const abort = new AbortController();
    controller = abort;
    let timer;
    const request = async () => {
      let retryAfter = 0;
      try {
        const home = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(homedir(), '.codex');
        const auth = JSON.parse(readFile(path.join(home, 'auth.json'), 'utf8'));
        const token = auth?.tokens?.access_token;
        if (typeof token !== 'string' || !token) throw new Error();
        const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', originator: 'codex_cli_rs' };
        if (typeof auth.tokens.account_id === 'string') headers['chatgpt-account-id'] = auth.tokens.account_id;
        const cancelled = new Promise((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error()), { once: true }));
        timer = setTimeout(() => abort.abort(), 10000);
        const result = await Promise.race([cancelled, (async () => {
          const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
            headers, signal: abort.signal, redirect: 'error',
          });
          if (!res.ok) {
            if (res.status === 429) {
              const value = res.headers?.get('retry-after');
              const seconds = Number(value);
              retryAfter = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now();
            }
            throw new Error();
          }
          return usageRows(await res.json());
        })()]);
        if (requestGeneration !== generation || !isEnabled()) return {};
        if (!result.limits?.length) throw new Error();
        failures = 0;
        retryAt = 0;
        return result;
      } catch {
        if (requestGeneration === generation) {
          const backoff = Math.min(300000, 30000 * 2 ** Math.min(failures++, 4));
          retryAt = now() + Math.max(backoff, Number.isFinite(retryAfter) ? Math.min(3600000, retryAfter) : 0);
        }
        return {};
      } finally {
        clearTimeout(timer);
      }
    };
    pending = request();
    try {
      return await pending;
    } finally {
      if (requestGeneration === generation) {
        pending = null;
        controller = null;
      }
    }
  }

  return { getUsage, settingsChanged };
}

module.exports = { createCodexUsage };
