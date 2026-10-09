'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'publish-release.sh');
const TAG = 'v0.1.0';
const REPOSITORY = 'devsuitup/switchboard';
const gitBash = process.platform === 'win32' && process.env.ProgramFiles
  ? path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe') : null;
const bash = gitBash && fs.existsSync(gitBash) ? gitBash : 'bash';
const bashProbe = spawnSync(bash, ['--version'], { encoding: 'utf8', timeout: 5000 });
const hasBash = !bashProbe.error && bashProbe.status === 0;
const shellPath = (value) => value.replace(/\\/g, '/');

const GH_STUB = `#!/bin/sh
printf '%s\\t' "$@" >> "$GH_STUB_LOG"
printf '\\n' >> "$GH_STUB_LOG"
if [ "$1" = api ]; then
  case "$GH_STUB_MODE" in
    missing) exit 0 ;;
    draft) echo true; exit 0 ;;
    published) printf '%s\\n' "$GH_STUB_DRAFT"; exit 0 ;;
    transient) echo 'network connection failed' >&2; exit 1 ;;
  esac
elif [ "$1 $2" = "release create" ]; then
  if [ "$GH_STUB_MODE" = draft ]; then
    echo 'release already exists' >&2
    exit 1
  fi
  exit 0
elif [ "$1 $2" = "release upload" ]; then
  if [ "$GH_STUB_FAIL_ONCE" = 1 ] && [ ! -f "$GH_STUB_RETRY_FILE" ]; then
    : > "$GH_STUB_RETRY_FILE"
    echo 'upload connection failed' >&2
    exit 1
  fi
  exit 0
fi
echo 'unexpected gh invocation' >&2
exit 2
`;

function runRelease(t, mode, failOnce = false, draftValue = 'false') {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-release-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const bin = path.join(temp, 'bin');
  const dist = path.join(temp, 'dist with spaces');
  const log = path.join(temp, 'gh.log');
  const script = path.join(temp, 'publish-release.sh');
  fs.mkdirSync(bin);
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(bin, 'gh'), GH_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(dist, 'one.zip'), 'one');
  fs.writeFileSync(path.join(dist, 'two.exe'), 'two');
  fs.writeFileSync(script, fs.readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'PATH') delete env[key];
  }
  Object.assign(env, {
    PATH: bin + path.delimiter + (process.env.PATH || process.env.Path || ''),
    GITHUB_REF_NAME: TAG,
    GITHUB_REPOSITORY: REPOSITORY,
    GH_TOKEN: 'stub-token',
    DIST_DIR: shellPath(dist),
    RETRY_DELAY: '0',
    GH_STUB_MODE: mode,
    GH_STUB_DRAFT: draftValue,
    GH_STUB_LOG: shellPath(log),
    GH_STUB_FAIL_ONCE: failOnce ? '1' : '0',
    GH_STUB_RETRY_FILE: shellPath(path.join(temp, 'retried')),
  });
  const result = spawnSync(bash, [shellPath(script)], {
    cwd: temp, env, encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(result.error);
  const calls = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trimEnd().split('\n').map((line) => line.replace(/\t$/, '').split('\t'))
    : [];
  t.diagnostic(`${mode}${failOnce ? ' with retry' : ''}: script exit ${result.status}; calls ${JSON.stringify(calls)}`);
  return { ...result, calls, dist: shellPath(dist) };
}

function requireBash(t) {
  if (hasBash) return true;
  t.skip('bash is unavailable on PATH and at the Git for Windows fallback');
  return false;
}

function assertUploads(result, names) {
  assert.deepEqual(result.calls.filter((args) => args[1] === 'upload'), names.map((name) => [
    'release', 'upload', TAG, `${result.dist}/${name}`, '--clobber',
  ]));
}

test('given a missing release, publishing creates a draft and uploads both assets', (t) => {
  if (!requireBash(t)) return;
  const result = runRelease(t, 'missing');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.map((args) => args.slice(0, 2)), [
    ['api', '--paginate'], ['release', 'create'], ['release', 'upload'], ['release', 'upload'],
  ]);
  assert.deepEqual(result.calls[0], [
    'api', '--paginate', `repos/${REPOSITORY}/releases?per_page=100`, '--jq',
    `.[] | select(.tag_name == "${TAG}") | .draft`,
  ]);
  assert.deepEqual(result.calls[1], ['release', 'create', TAG, '--draft', '--title', '0.1.0', '--notes', '']);
  assertUploads(result, ['one.zip', 'two.exe']);
});

test('given a draft, publishing uploads both assets without creating a second draft', (t) => {
  if (!requireBash(t)) return;
  const result = runRelease(t, 'draft');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /draft .* already exists; proceeding to asset upload/);
  assert.deepEqual(result.calls.map((args) => args.slice(0, 2)), [
    ['api', '--paginate'], ['release', 'upload'], ['release', 'upload'],
  ]);
  assertUploads(result, ['one.zip', 'two.exe']);
});

test('given a published release, publishing exits 1 without creating or uploading', (t) => {
  if (!requireBash(t)) return;
  for (const draftValue of ['false', 'unexpected']) {
    const result = runRelease(t, 'published', false, draftValue);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /already published; refusing to overwrite its assets/);
    assert.deepEqual(result.calls.map((args) => args.slice(0, 2)), [['api', '--paginate']]);
  }
});

test('given two releases on the tag, publishing exits 1 without creating or uploading', (t) => {
  if (!requireBash(t)) return;
  const result = runRelease(t, 'published', false, 'true\ntrue');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /more than one release carries .*; refusing to pick one/);
  assert.deepEqual(result.calls.map((args) => args.slice(0, 2)), [['api', '--paginate']]);
});

test('given a transient read failure, publishing exits 1 without creating or uploading', (t) => {
  if (!requireBash(t)) return;
  const result = runRelease(t, 'transient');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /network connection failed/);
  assert.match(result.stdout, /could not read the releases .* refusing to publish blind/);
  assert.deepEqual(result.calls.map((args) => args.slice(0, 2)), [['api', '--paginate']]);
});

test('given a draft and one failed upload, publishing retries and exits 0', (t) => {
  if (!requireBash(t)) return;
  const result = runRelease(t, 'draft', true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /attempt 1 failed; retrying in 0s/);
  assertUploads(result, ['one.zip', 'one.zip', 'two.exe']);
});
