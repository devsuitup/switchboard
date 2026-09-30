'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { cleanEnv } = require('../clean-env');

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
];

const KEPT = [
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'PATH',
];

for (const name of SESSION_MARKERS) {
  test(`GIVEN ${name} in the parent env WHEN the env is cleaned THEN it is gone`, () => {
    const out = cleanEnv({ [name]: 'x', PATH: '/bin' });
    assert.ok(!(name in out), `${name} survived`);
    assert.strictEqual(out.PATH, '/bin');
  });
}

test('GIVEN user configuration WHEN the env is cleaned THEN it survives', () => {
  const env = Object.fromEntries(KEPT.map((k) => [k, `v-${k}`]));
  assert.deepStrictEqual(cleanEnv(env), env);
});

test('GIVEN Electron internals WHEN the env is cleaned THEN they are still stripped', () => {
  const out = cleanEnv({ ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x', WT_SESSION: 'a', HOME: '/h' });
  assert.deepStrictEqual(out, { HOME: '/h' });
});

test('main.js builds cleanPtyEnv from cleanEnv(process.env)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /const cleanPtyEnv = cleanEnv\(process\.env\)/);
});
