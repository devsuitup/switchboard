'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { cleanEnv, scrubSessionEnv } = require('../src/main/shared/clean-env');

const SESSION_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_JOB_DIR',
  'AI_AGENT',
  'CLAUDE_EFFORT',
  'CLAUDE_ENV_FILE',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_REMOTE_SESSION_ID',
  'TRACEPARENT',
  'TRACESTATE',
];

const KEPT = [
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_TASK_LIST_ID',
  'DISABLE_TELEMETRY',
  'HTTPS_PROXY',
  'PATH',
];

for (const name of SESSION_MARKERS) {
  test(`GIVEN ${name} in the parent env WHEN the env is cleaned THEN it is gone`, () => {
    const out = cleanEnv({ [name]: 'x', PATH: '/bin' }, { locale: false });
    assert.ok(!(name in out), `${name} survived`);
    assert.strictEqual(out.PATH, '/bin');
  });
}

test('GIVEN user configuration WHEN the env is cleaned THEN it survives', () => {
  const env = Object.fromEntries(KEPT.map((k) => [k, `v-${k}`]));
  assert.deepStrictEqual(cleanEnv(env, { locale: false }), env);
});

test('GIVEN mixed-case session markers WHEN cleaned THEN Windows cannot inherit an alias', () => {
  const env = { Claude_Code_Session_Id: 'parent', claude_job_dir: 'parent-job', TraceParent: 'parent-trace', tracestate: 'parent-state', Path: '/bin' };
  assert.deepStrictEqual(cleanEnv(env, { locale: false }), { Path: '/bin' });
  assert.strictEqual(env.Claude_Code_Session_Id, 'parent');
});

test('GIVEN GIT_EDITOR=true beside a session marker WHEN the env is cleaned THEN the CLI residue is gone', () => {
  const out = cleanEnv({ CLAUDECODE: '1', GIT_EDITOR: 'true', PATH: '/bin' }, { locale: false });
  assert.deepStrictEqual(out, { PATH: '/bin' });
});

test('GIVEN GIT_EDITOR=true with no session marker WHEN the env is cleaned THEN the user setting survives', () => {
  const out = cleanEnv({ GIT_EDITOR: 'true', PATH: '/bin' }, { locale: false });
  assert.deepStrictEqual(out, { GIT_EDITOR: 'true', PATH: '/bin' });
});

test('GIVEN a user GIT_EDITOR beside a session marker WHEN the env is cleaned THEN the user setting survives', () => {
  const out = cleanEnv({ CLAUDE_CODE_SESSION_ID: 'parent', GIT_EDITOR: 'vim', PATH: '/bin' }, { locale: false });
  assert.deepStrictEqual(out, { GIT_EDITOR: 'vim', PATH: '/bin' });
});

test('GIVEN mixed-case GIT_EDITOR=true beside a mixed-case marker WHEN cleaned THEN Windows cannot inherit the residue', () => {
  const out = cleanEnv({ ClaudeCode: '1', Git_Editor: 'true', Path: '/bin' }, { locale: false });
  assert.deepStrictEqual(out, { Path: '/bin' });
});

test('GIVEN GIT_EDITOR=true beside a session marker WHEN the startup scrub runs THEN the residue leaves process.env too', () => {
  const env = { CLAUDE_PID: '1', GIT_EDITOR: 'true', PATH: '/bin' };
  assert.strictEqual(scrubSessionEnv(env), env);
  assert.deepStrictEqual(env, { PATH: '/bin' });
});

test('GIVEN Electron internals WHEN the env is cleaned THEN they are still stripped', () => {
  const out = cleanEnv({ ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x', WT_SESSION: 'a', HOME: '/h' }, { locale: false });
  assert.deepStrictEqual(out, { HOME: '/h' });
});

test('main.js builds cleanPtyEnv from cleanEnv(process.env)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /const cleanPtyEnv = cleanEnv\(process\.env\)/);
});
