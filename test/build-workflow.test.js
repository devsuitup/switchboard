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

function evaluate(value, eventName, ref = 'refs/tags/v1.0.0', headRef = '', extra = {}) {
  const expression = value.match(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/);
  return vm.runInNewContext(expression[1], {
    github: { event_name: eventName, ref, head_ref: headRef, workflow: 'Workflow', ...extra },
    fromJSON: JSON.parse,
    format: (template, ...args) => template.replace(/\{(\d+)\}/g, (_, i) => args[i]),
    startsWith: (value, prefix) => value.startsWith(prefix),
  }, { filename: workflowPath, timeout: 1000 });
}

function matrixFor(eventName, ref) {
  return evaluate(workflow.jobs.build.strategy.matrix.include, eventName, ref);
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

test('dispatch builds the PR matrix even when dispatched on a tag ref', () => {
  for (const ref of ['refs/heads/main', 'refs/tags/v1.0.0']) {
    assert.deepEqual(matrixFor('workflow_dispatch', ref), nonMac);
  }
  assert.deepEqual(matrixFor('push', 'refs/heads/main'), nonMac);
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
  assert.equal(publish.if, "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')");
});

test('dispatch never publishes, including on a tag ref', () => {
  const condition = '${{ ' + workflow.jobs.publish.if + ' }}';
  for (const event of ['workflow_dispatch', 'pull_request', 'push']) {
    for (const ref of ['refs/heads/main', 'refs/tags/v1.0.0']) {
      assert.equal(evaluate(condition, event, ref), event === 'push' && ref.startsWith('refs/tags/v'), `${event}: ${ref}`);
    }
  }
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
    push: { tags: ['v*'] }, workflow_dispatch: null,
    pull_request: { branches: ['main'], paths: [
      'package.json', 'package-lock.json', 'postinstall.js', 'scripts/**',
      '.github/workflows/build.yml', 'build/**',
    ] },
  });
});

const testWorkflow = yaml.load(fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'test.yml'), 'utf8'));
const workflows = { Build: workflow, Test: testWorkflow };

test('every artifact has explicit three-day PR and fourteen-day other retention', () => {
  for (const [name, config] of Object.entries(workflows)) {
    const uploads = Object.values(config.jobs).flatMap(job => job.steps).filter(step => step.uses?.startsWith('actions/upload-artifact@'));
    assert.ok(uploads.length, name);
    for (const step of uploads) {
      assert.equal(step.with['retention-days'], "${{ github.event_name == 'pull_request' && 3 || 14 }}", name);
      for (const event of ['pull_request', 'push', 'workflow_dispatch']) {
        assert.equal(evaluate(step.with['retention-days'], event), event === 'pull_request' ? 3 : 14);
      }
    }
  }
});

test('both workflows group PRs by number and give every other run its own group', () => {
  for (const [name, config] of Object.entries(workflows)) {
    assert.deepEqual(config.concurrency, {
      group: "${{ github.workflow }}-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || github.run_id }}",
      'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
    }, name);
    const group = (event, extra) => config.concurrency.group.replace(/\$\{\{([\s\S]*?)\}\}/g,
      (_, body) => evaluate('${{' + body + '}}', event, 'refs/heads/main', 'same-branch', extra));
    const fork = (number) => ({ event: { pull_request: { number } }, run_id: 1 });
    assert.equal(group('pull_request', fork(7)), 'Workflow-pr-7', name);
    assert.equal(group('pull_request', fork(7)), group('pull_request', { ...fork(7), run_id: 2 }), name);
    assert.notEqual(group('pull_request', fork(7)), group('pull_request', fork(8)), `${name}: same head branch name`);
    for (const event of ['push', 'workflow_dispatch']) {
      assert.notEqual(group(event, { run_id: 1 }), group(event, { run_id: 2 }), `${name}: ${event}`);
      assert.equal(group(event, { run_id: 5 }), 'Workflow-5', name);
    }
    for (const event of ['pull_request', 'push', 'workflow_dispatch']) {
      assert.equal(evaluate(config.concurrency['cancel-in-progress'], event), event === 'pull_request', name);
    }
  }
});

test('jobs have bounded timeouts with the full packaging budget retained', () => {
  for (const [name, config] of Object.entries(workflows)) {
    for (const [id, job] of Object.entries(config.jobs)) {
      assert.equal(job['timeout-minutes'], id === 'build' ? 60 : id === 'test' ? 25 : 10, `${name}: ${id}`);
    }
  }
});

test('Test uses three PR cells and two main-push cells with stable context names', () => {
  const cells = [
    { 'node-version': 22, os: 'ubuntu-latest' },
    { 'node-version': 22, os: 'windows-2022' },
  ];
  const matrix = testWorkflow.jobs.test.strategy.matrix;
  assert.deepEqual(Object.keys(matrix), ['include']);
  assert.equal(typeof matrix.include, 'string');
  assert.deepEqual(evaluate(matrix.include, 'pull_request'), [{ 'node-version': 20, os: 'ubuntu-latest' }, ...cells]);
  assert.deepEqual(evaluate(matrix.include, 'push'), cells);
  for (const event of ['pull_request', 'push']) {
    for (const cell of evaluate(matrix.include, event)) {
      assert.deepEqual(Object.keys(cell), ['node-version', 'os'], `${event}: ${JSON.stringify(cell)}`);
    }
  }
  assert.equal(testWorkflow.jobs.test.name, undefined);
  assert.equal(testWorkflow.jobs.test['runs-on'], '${{ matrix.os }}');
});

test('Test keeps its triggers, real-bwrap, patch coverage, lint and e2e conditions', () => {
  assert.deepEqual(testWorkflow.on, { pull_request: { branches: ['main'] }, push: { branches: ['main'] } });
  for (const id of ['lint', 'e2e', 'test']) assert.equal(testWorkflow.jobs[id].if, undefined, id);
  assert.equal(testWorkflow.jobs.changelog.if, "github.event_name == 'pull_request'");
  const steps = testWorkflow.jobs.test.steps;
  const bwrap = steps.find(step => step.name === 'Enable the real-sandbox tests');
  assert.equal(bwrap.if, "runner.os == 'Linux'");
  assert.match(bwrap.run, /SWITCHBOARD_REQUIRE_REAL_BWRAP=1/);
  assert.equal(steps.find(step => step.name?.startsWith('Patch coverage gate')).if,
    "matrix.node-version == 22 && matrix.os == 'ubuntu-latest' && github.event_name == 'pull_request'");
  assert.equal(steps.find(step => step.run === 'npm run coverage').if, undefined);
  assert.equal(testWorkflow.jobs.e2e.steps.find(step => step.uses?.startsWith('actions/upload-artifact@')).if, 'failure()');
});
