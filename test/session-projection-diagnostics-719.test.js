'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function row(extra = {}) {
  return { scope: 'scope-fixture', rootId: 'a', sessionId: 'b', headSessionId: 'b', memberIds: ['a', 'b'],
    background: { jobId: '369b1c23', sessionId: 'b' }, visibleInDefault: true,
    activity: { source: 'job-valid', selection: 'marker', jobId: '369b1c23', valid: true, state: 'done', hosted: true, attached: true, foreground: false },
    inputs: { projectsBuildId: 1, cli: 'included', cliEntryCount: 1, cachedJob: true, jobState: 'done',
      jobEvidenceValid: true, jobEvidenceAt: 1, descriptors: [{ sessionId: 'b', jobId: '369b1c23', kind: 'bg', pid: 4242 }],
      attach: { sessionId: 'b', jobId: '369b1c23', exited: false, host: null },
      proof: { kind: 'continuation', rootId: 'a', partIds: ['a', 'b'], valid: true, reason: null }, filterReason: null }, ...extra };
}
function collector() {
  const { createSessionProjectionDiagnostics } = require('../public/session-projection-diagnostics');
  const lines = []; const d = createSessionProjectionDiagnostics({ emit: record => lines.push(record) });
  return { lines, observe: (rows, removedInputs = {}) => d.observe({ generation: 1, rosterRevision: 1, cause: 'projects', rows, removedInputs }) };
}
test('T6.1 one accepted event combines changed facets and silent observations refresh provenance', () => {
  const d = collector(), original = row(); d.observe([original]); d.observe([structuredClone(original)]);
  assert.equal(d.lines.length, 1);
  const omitted = structuredClone(original); omitted.inputs.cli = 'omitted'; omitted.inputs.jobEvidenceAt++;
  d.observe([omitted]); assert.equal(d.lines.length, 1);
  omitted.background = null; omitted.activity.hosted = false; omitted.activity.source = 'job-invalid'; omitted.activity.valid = false;
  d.observe([omitted]); assert.equal(d.lines.length, 2);
  assert.ok(d.lines[1].changes.includes('background-membership')); assert.ok(d.lines[1].changes.includes('activity-source'));
  assert.equal(d.lines[1].inputs.cli, 'omitted');
  d.observe([]); assert.equal(d.lines.length, 3); assert.ok(d.lines[2].changes.includes('removed'));
  assert.equal(d.lines[2].inputs.proof.reason, 'not-observed-in-current-projection');
  assert.ok(d.lines[2].priorInputs); d.observe([]); assert.equal(d.lines.length, 3);
  d.observe([original]); assert.equal(d.lines.length, 4); assert.deepEqual(d.lines[3].changes, ['initial']);
});
test('T6.3 full sets are compared before truncation and provenance-only selector changes are silent', () => {
  const d = collector(), r = row(); r.memberIds = Array.from({ length: 260 }, (_, i) => `id-${i}`);
  d.observe([r]); const next = structuredClone(r); next.memberIds[259] = 'changed'; d.observe([next]);
  assert.equal(d.lines.length, 2); assert.ok(d.lines[1].next.memberIds.length <= 128);
  assert.equal(d.lines[1].next.memberIdsCount, 260); assert.equal(d.lines[1].next.memberIdsTruncated, true);
  next.activity.selection = 'identity'; next.memberIds.reverse(); d.observe([next]); assert.equal(d.lines.length, 2);
});
test('T6.6 current removal reasons replace prior facts; archive visibility is not removal', () => {
  const d = collector(), r = row(); d.observe([r]);
  r.visibleInDefault = false; r.inputs.filterReason = 'archived'; d.observe([r]);
  assert.deepEqual(d.lines[1].changes, ['visibility']);
  d.observe([], { 'scope-fixture|a': { ...r.inputs, filterReason: 'hidden-project' } });
  assert.equal(d.lines[2].inputs.filterReason, 'hidden-project'); assert.equal(d.lines[2].priorInputs, undefined);
});
test('T6.7 splits log both resulting roots including a newly plain foreground row', () => {
  const d = collector(); d.observe([row()]);
  const foreground = { source: 'none', selection: 'none', jobId: null, valid: false, state: null, hosted: false, attached: false, foreground: false };
  d.observe([row({ sessionId: 'a', headSessionId: 'a', memberIds: ['a'], background: null, activity: foreground }),
    row({ rootId: 'b', memberIds: ['b'], background: null, activity: foreground })]);
  assert.equal(d.lines.length, 3); assert.ok(d.lines[2].changes.includes('merge-membership'));
  d.observe([row()]); assert.equal(d.lines.length, 5); assert.ok(d.lines[4].changes.includes('removed'));
});
test('T6.4 oversized legitimate transitions compact; transport errors do not fail observation', () => {
  const { createSessionProjectionDiagnostics, validateSessionProjectionRecord } = require('../public/session-projection-diagnostics');
  const r = row(); r.memberIds = Array.from({ length: 1024 }, (_, i) => 'a'.repeat(190) + i);
  r.inputs.proof.partIds = r.memberIds; r.inputs.descriptors = r.memberIds.map(sessionId => ({ sessionId, jobId: '369b1c23', kind: 'bg', pid: 1 }));
  const d = collector(); d.observe([r]);
  assert.equal(d.lines.length, 1); assert.ok(Buffer.byteLength(JSON.stringify(d.lines[0])) <= 65536);
  assert.equal(validateSessionProjectionRecord(d.lines[0]), true);
  assert.equal(validateSessionProjectionRecord({ ...d.lines[0], prompt: 'private' }), false);
  assert.doesNotThrow(() => createSessionProjectionDiagnostics({ emit: () => { throw Error('transport'); } }).observe({ rows: [row()] }));
});

test('T6.4 shipped main handler permits only its main frame and emits one info-level JSON line as data', () => {
  const d = collector(); d.observe([row()]); const record = d.lines[0];
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf("ipcMain.on('session-projection-changed'");
  const frame = {}, sender = { mainFrame: frame }, lines = []; let handle;
  vm.runInNewContext(source.slice(start, source.indexOf('\n});', start) + 4), {
    ipcMain: { on: (_channel, callback) => { handle = callback; } },
    mainWindow: { isDestroyed: () => false, webContents: sender },
    require: () => require('../public/session-projection-diagnostics'), log: { info: line => lines.push(line) } });
  handle({ sender: {}, senderFrame: frame }, record); handle({ sender, senderFrame: {} }, record);
  handle({ sender, senderFrame: frame }, { ...record, prompt: 'private\ntext' });
  handle({ sender, senderFrame: frame }, { ...record, rootId: 'a\nforged-line' });
  assert.equal(lines.length, 0);
  handle({ sender, senderFrame: frame }, record);
  assert.equal(lines.length, 1); assert.ok(lines[0].startsWith('[session-projection] '));
  assert.equal(lines[0].includes('\n'), false);
  const decoded = JSON.parse(lines[0].slice('[session-projection] '.length));
  assert.equal(decoded.projectsBuildId, 1); assert.equal(decoded.rosterRevision, 1); assert.ok(decoded.at);
  assert.equal(/prompt|private|cwd|liveVersion/.test(lines[0]), false);
});

test('T6.1 attach provenance names the exact attached old part rather than the selected head job', t => {
  const { setupSidebarDom } = require('./dom-setup'), { loadAppFunctions } = require('./app-source');
  const h = setupSidebarDom(); t.after(() => h.destroy()); const w = h.window, records = [];
  const A = '2a633039-956f-48b4-979a-ce3d4b801ca1', B = '369b1c23-9bd7-47a2-b4bf-36ee3ca4b55f';
  w.TextEncoder = TextEncoder; h.evalPublic('session-projection-diagnostics.js'); h.evalPublic('agents-view.js');
  const row = { sessionId: A, headSessionId: B, projectPath: '/p', mergedMemberIds: [B], bgJobId: 'aaaaaaaa', bgSessionId: B };
  w.cachedProjects = [{ projectPath: '/p', sessions: [row] }]; w.cachedAllProjects = w.cachedProjects;
  w.openSessions.set(A, { attach: true, attachJobId: '369b1c23', session: row });
  w.applyAgentsSnapshot({ roster: [{ id: '369b1c23', sessionId: A, kind: 'background', state: 'done', cachedJob: true },
    { id: 'aaaaaaaa', sessionId: B, kind: 'background', state: 'done', cachedJob: true }] });
  w.api.sessionProjectionChanged = record => records.push(record);
  loadAppFunctions(h.context, { functions: ['observeSessionProjection'] });
  w.observeSessionProjection({ generation: 1, cause: 'projects' });
  assert.equal(records.length, 1); assert.equal(records[0].inputs.attach.sessionId, A);
  assert.equal(records[0].inputs.attach.jobId, '369b1c23');
});
