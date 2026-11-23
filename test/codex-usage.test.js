'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const filename = path.join(__dirname, '../src/main/usage/codex-usage.js');
const implementation = fs.existsSync(filename) ? require(filename) : {};
const secret = 'FAKE-1139-TOKEN';
const response = () => ({
  tokens: secret, plan_type: 'private-plan',
  rate_limit: {
    primary_window: { used_percent: 8.9, limit_window_seconds: 18000, reset_at: 1900000000 },
    secondary_window: { used_percent: 92, limit_window_seconds: 604800 },
  },
  additional_rate_limits: [{ limit_name: 'Spark', rate_limit: {
    primary_window: { used_percent: 0, limit_window_seconds: 18000 },
    secondary_window: { used_percent: 12, limit_window_seconds: 604800 },
  } }],
});

function setup(t, overrides = {}) {
  assert.equal(typeof implementation.createCodexUsage, 'function', 'main-side Codex usage service exists');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-1139-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: secret, account_id: 'fake-account' } }));
  const state = { enabled: true, time: 0, reads: [], calls: [], timers: [] };
  const service = implementation.createCodexUsage({
    isEnabled: () => state.enabled,
    env: { CODEX_HOME: home },
    readFile: (...args) => { state.reads.push(args[0]); return fs.readFileSync(...args); },
    fetch: async (...args) => { state.calls.push(args); return { ok: true, json: async () => response() }; },
    now: () => state.time,
    setTimeout: (fn, ms) => { state.timers.push(fn); state.timeoutMs = ms; return state.timers.length; },
    clearTimeout: () => {},
    ...overrides,
  });
  return { home, state, service };
}

test('off never reads even a throwing auth file and never fetches', async t => {
  let reads = 0, calls = 0;
  const h = setup(t, {
    readFile: () => { reads++; throw new Error('auth must not be read'); },
    fetch: () => { calls++; assert.fail('endpoint must not be called'); },
  });
  h.state.enabled = false;
  assert.deepEqual(await h.service.getUsage(), {});
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

test('non-minute Codex durations round to whole minutes', async t => {
  const h = setup(t, { fetch: async () => ({ ok: true, json: async () => ({ rate_limit: {
    primary_window: { used_percent: 42, limit_window_seconds: 5424 },
    secondary_window: { used_percent: 23, limit_window_seconds: 5436 },
  } }) }) });
  assert.deepEqual((await h.service.getUsage()).limits.map(row => row.windowMinutes), [90, 91]);
});

test('a secondary-only Codex payload preserves its window without inventing a primary', async t => {
  const h = setup(t, { fetch: async () => ({ ok: true, json: async () => ({ rate_limit: {
    secondary_window: { used_percent: 23, limit_window_seconds: 604800 },
  } }) }) });
  const rows = (await h.service.getUsage()).limits;
  assert.equal(rows?.length, 1, 'secondary-only payload must produce exactly one row');
  assert.equal(rows[0].windowMinutes, 10080);
  assert.equal(rows[0].percent, 23);
  assert.equal(rows[0].label, 'Codex 1wk');
});

test('on uses the fake CODEX_HOME and sends only renderable rows across IPC', async t => {
  const h = setup(t);
  const usage = await h.service.getUsage();
  assert.equal(h.state.reads[0], path.join(h.home, 'auth.json'));
  assert.equal(h.state.calls.length, 1);
  const [url, options] = h.state.calls[0];
  assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(options.headers.Authorization, `Bearer ${secret}`);
  assert.equal(options.headers['chatgpt-account-id'], 'fake-account');
  assert.deepEqual(Object.keys(options.headers).sort(), ['Authorization', 'Content-Type', 'chatgpt-account-id', 'originator'].sort());
  const { Authorization, ...otherHeaders } = options.headers;
  assert.equal(Authorization, `Bearer ${secret}`);
  assert.ok(!JSON.stringify({ url, headers: otherHeaders, body: options.body }).includes(secret), 'token appears only in Authorization');
  assert.equal(options.redirect, 'error', 'credentials must never follow a redirect');
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(usage), ['limits']);
  assert.deepEqual(usage.limits.map(row => row.percent), [8, 92, 12]);
  assert.deepEqual(usage.limits.map(row => row.short), ['5h', '1wk', '1wk']);
  assert.deepEqual(usage.limits.map(row => row.windowMinutes), [300, 10080, 10080], 'raw durations reach the renderer');
  assert.equal(usage.limits[2].model, 'Spark', 'model identity is separate from the duration label');
  assert.equal(usage.limits[2].label, 'Codex Spark (1wk)');
  assert.ok(usage.limits[0].reset);
  assert.equal(usage.limits[1].severity, 'high');
  assert.doesNotMatch(JSON.stringify(usage), /FAKE-1139-TOKEN|private-plan|fake-account/);
});

test('no CODEX_HOME uses only the injected disposable home', async t => {
  const h = setup(t, { env: {}, homedir: () => h.home });
  fs.mkdirSync(path.join(h.home, '.codex'));
  fs.renameSync(path.join(h.home, 'auth.json'), path.join(h.home, '.codex/auth.json'));
  assert.equal((await h.service.getUsage()).limits.length, 3);
  assert.equal(h.state.reads[0], path.join(h.home, '.codex/auth.json'));
});

for (const status of [429, 500]) {
  test(`HTTP ${status} quietly hides rows and backs off before retry`, async t => {
    let calls = 0;
    const h = setup(t, { fetch: async () => {
      calls++;
      return calls === 1 ? { ok: false, status, headers: { get: () => '120' } } : { ok: true, json: async () => response() };
    } });
    assert.deepEqual(await h.service.getUsage(), {});
    h.state.time = status === 429 ? 119999 : 29999;
    assert.deepEqual(await h.service.getUsage(), {});
    assert.equal(calls, 1, 'retry blocked during backoff');
    h.state.time++;
    assert.equal((await h.service.getUsage()).limits.length, 3);
    assert.equal(calls, 2);
  });
}

test('repeated failures increase backoff and never surface exception contents', async t => {
  let calls = 0;
  const h = setup(t, { fetch: async () => { calls++; throw new Error(secret); } });
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  t.mock.method(console, 'warn', (...args) => logs.push(args));
  t.mock.method(console, 'log', (...args) => logs.push(args));
  assert.deepEqual(await h.service.getUsage(), {});
  h.state.time = 30000;
  assert.deepEqual(await h.service.getUsage(), {});
  h.state.time = 89999;
  assert.deepEqual(await h.service.getUsage(), {});
  assert.equal(calls, 2);
  h.state.time = 90000;
  assert.deepEqual(await h.service.getUsage(), {});
  assert.equal(calls, 3);
  assert.deepEqual(logs, []);
});

test('timeout aborts a hanging request, hides rows and applies backoff', async t => {
  let signal;
  const h = setup(t, { fetch: async (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  const pending = h.service.getUsage();
  await Promise.resolve();
  assert.equal(h.state.timers.length, 1);
  assert.equal(h.state.timeoutMs, 10000);
  h.state.timers[0]();
  assert.equal(signal.aborted, true);
  assert.deepEqual(await pending, {});
  assert.deepEqual(await h.service.getUsage(), {});
  assert.equal(h.state.reads.length, 1);
});

test('simultaneous calls share a request; off cancels it and on rejects its stale result', async t => {
  let resolve, signal, calls = 0;
  const h = setup(t, { fetch: (_url, options) => {
    calls++;
    signal = options.signal;
    return new Promise(done => { resolve = done; });
  } });
  const first = h.service.getUsage();
  const second = h.service.getUsage();
  await Promise.resolve();
  assert.equal(calls, 1);
  h.state.enabled = false;
  h.service.settingsChanged();
  assert.equal(signal.aborted, true);
  assert.deepEqual(await h.service.getUsage(), {});
  h.state.enabled = true;
  h.service.settingsChanged();
  resolve({ ok: true, json: async () => response() });
  assert.deepEqual(await first, {});
  assert.deepEqual(await second, {});
  const next = h.service.getUsage();
  await Promise.resolve();
  resolve({ ok: true, json: async () => response() });
  assert.equal((await next).limits.length, 3);
  assert.equal(calls, 2);
});

test('missing, malformed and non-OAuth auth files hide quietly without fetch', async t => {
  const h = setup(t);
  for (const auth of [null, '{broken', '{}', '{"tokens":{"access_token":42}}']) {
    if (auth === null) fs.unlinkSync(path.join(h.home, 'auth.json'));
    else fs.writeFileSync(path.join(h.home, 'auth.json'), auth);
    h.state.time += 1000000;
    assert.deepEqual(await h.service.getUsage(), {});
  }
  assert.equal(h.state.calls.length, 0);
});

test('malformed endpoint data is quiet and invalid percentages never render', async t => {
  const h = setup(t, { fetch: async () => ({ ok: true, json: async () => ({ rate_limit: {
    primary_window: { used_percent: 'private-data' }, secondary_window: { used_percent: -1 },
  } }) }) });
  assert.deepEqual(await h.service.getUsage(), {});
});

test('over-limit percentages remain visible for account and model windows', async t => {
  const h = setup(t, { fetch: async () => ({ ok: true, json: async () => ({
    rate_limit: { primary_window: { used_percent: 125.8, limit_window_seconds: 18000 } },
    additional_rate_limits: [{ limit_name: 'Spark', rate_limit: {
      secondary_window: { used_percent: 110, limit_window_seconds: 604800 },
    } }],
  }) }) });
  const usage = await h.service.getUsage();
  assert.deepEqual(usage.limits?.map(row => row.percent), [125, 110], 'over-limit windows must not disappear');
  assert.ok(usage.limits.every(row => row.severity === 'high'));
});

test('turning off without a generation change discards an in-flight response', async t => {
  let resolve;
  const h = setup(t, { fetch: () => new Promise(done => { resolve = done; }) });
  const pending = h.service.getUsage();
  h.state.enabled = false;
  resolve({ ok: true, json: async () => response() });
  assert.deepEqual(await pending, {}, 'disabled setting must suppress the result without settingsChanged');
});

test('Retry-After longer than an hour is capped at one hour', async t => {
  let calls = 0;
  const h = setup(t, { fetch: async () => {
    calls++;
    return calls === 1 ? { ok: false, status: 429, headers: { get: () => '7200' } }
      : { ok: true, json: async () => response() };
  } });
  assert.deepEqual(await h.service.getUsage(), {});
  h.state.time = 3599999;
  assert.deepEqual(await h.service.getUsage(), {});
  assert.equal(calls, 1);
  h.state.time = 3600000;
  assert.equal((await h.service.getUsage()).limits?.length, 3, 'retry resumes at the one-hour cap');
  assert.equal(calls, 2);
});
