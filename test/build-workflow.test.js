'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const yaml = require('js-yaml');

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'build.yml');
const workflow = yaml.load(fs.readFileSync(workflowPath, 'utf8'));
const nonMac = [
  { os: 'windows-2022', platform: 'win' },
  { os: 'ubuntu-latest', platform: 'linux', arch: 'x64' },
  { os: 'ubuntu-24.04-arm', platform: 'linux', arch: 'arm64' },
];

function matrixFor(eventName) {
  const include = workflow.jobs.build.strategy.matrix.include;
  if (Array.isArray(include)) return include;
  const expression = include.match(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/);
  assert.ok(expression, 'matrix.include must be an array or an Actions expression');
  return vm.runInNewContext(expression[1], {
    github: { event_name: eventName },
    fromJSON: JSON.parse,
  }, { filename: workflowPath, timeout: 1000 });
}

test('pull requests build exactly Windows and both Linux architectures', () => {
  assert.deepEqual(matrixFor('pull_request'), nonMac);
});

test('tag pushes also build macOS on the existing runner', () => {
  assert.deepEqual(matrixFor('push'), [
    { os: 'macos-14', platform: 'mac' }, ...nonMac,
  ]);
  assert.equal(workflow.jobs.build['runs-on'], '${{ matrix.os }}');
  assert.equal(workflow.jobs.build.if, undefined, 'tag builds cannot skip macOS');
});

test('macOS has a finite job timeout of at most 60 minutes', () => {
  assert.ok(matrixFor('push').some(({ platform }) => platform === 'mac'));
  const timeout = workflow.jobs.build['timeout-minutes'];
  assert.ok(Number.isInteger(timeout) && timeout > 0 && timeout <= 60,
    'macOS build job must have timeout-minutes between 1 and 60');
});

test('publish waits for every build and retains the default success gate on tags', () => {
  const { publish, ...buildJobs } = workflow.jobs;
  const needs = Array.isArray(publish.needs) ? publish.needs : [publish.needs];
  assert.deepEqual(needs.toSorted(), Object.keys(buildJobs).toSorted());
  assert.deepEqual(needs, ['build']);
  assert.equal(publish.if, "startsWith(github.ref, 'refs/tags/v')");
});

test('build failures remain failures on PRs and tags', () => {
  assert.equal(workflow.jobs.build.strategy['fail-fast'], false);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.equal(job['continue-on-error'], undefined, name);
    for (const step of job.steps) {
      assert.equal(step['continue-on-error'], undefined, `${name}: ${step.name || step.uses}`);
    }
  }
});

test('the workflow retains main PR and version-tag triggers', () => {
  assert.deepEqual(workflow.on, {
    push: { tags: ['v*'] }, pull_request: { branches: ['main'] },
  });
});
