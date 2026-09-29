// What the renderer reports as the user's attention.
//
// app.js cannot be evaluated in jsdom, so the real reportActivityFocus is cut
// out of its source by brace matching and run against stubs: the code under
// test is the shipped code, not a replica of it.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Line endings normalised: a Windows checkout has CRLF.
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n');
const APP_SRC = read('app.js');
const UTILS_SRC = read('utils.js');

function functionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  // The body's brace, not one in a destructured parameter list.
  const body = src.indexOf(') {', start) + 2;
  let depth = 0;
  for (let i = body; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

function run({ activeSessionId = 's1', hasFocus = true, terminalDisplay = '', session = {} } = {}) {
  const reported = [];
  const ctx = {
    window: { api: { reportActivityFocus: (f) => reported.push(f) } },
    document: { hasFocus: () => hasFocus },
    terminalArea: { style: { display: terminalDisplay } },
    sessionMap: new Map([['s1', session]]),
    activeSessionId,
  };
  vm.createContext(ctx);
  vm.runInContext(functionSource(UTILS_SRC, 'cleanDisplayName'), ctx);
  vm.runInContext(functionSource(APP_SRC, 'reportActivityFocus'), ctx);
  vm.runInContext('reportActivityFocus()', ctx);
  assert.equal(reported.length, 1);
  return reported[0];
}

test('the shown session, in a focused window, is reported with its project', () => {
  const f = run({ session: { name: 'dev-panel', projectPath: '/w/switchboard' } });
  assert.equal(f.sessionId, 's1');
  assert.equal(f.name, 'dev-panel');
  assert.equal(f.project, '/w/switchboard');
});

test('a window without focus is not attention', () => {
  assert.equal(run({ hasFocus: false, session: { name: 'x' } }), null);
});

test('a full-page viewer over the terminals is not attention on the session behind it', () => {
  assert.equal(run({ terminalDisplay: 'none', session: { name: 'x' } }), null);
});

test('no session shown is no attention', () => {
  assert.equal(run({ activeSessionId: null }), null);
});

// summary is the first 120 characters of the first prompt. It is what the
// sidebar shows for a session with no name and no title, and it must never
// leave the machine.
test('the first prompt is never sent as the name', () => {
  const f = run({ session: { summary: 'use token ghp_secret to push the fix', projectPath: '/p' } });
  assert.equal(f.name, '', 'a session with only a summary goes out nameless, and main sends its id');
});

test('a given name is preferred, then the generated title', () => {
  assert.equal(run({ session: { name: 'mine', aiTitle: 'generated', summary: 'prompt' } }).name, 'mine');
  assert.equal(run({ session: { aiTitle: 'generated', summary: 'prompt' } }).name, 'generated');
});

// --- The places that trigger a report ---

test('focus is re-reported on window focus and blur', () => {
  assert.match(APP_SRC, /window\.addEventListener\('focus', reportActivityFocus\)/);
  assert.match(APP_SRC, /window\.addEventListener\('blur', reportActivityFocus\)/);
});

test('any viewer hiding the terminals triggers a report, through the element itself', () => {
  assert.match(APP_SRC,
    /new MutationObserver\(reportActivityFocus\)\.observe\(terminalArea, \{ attributes: true, attributeFilter: \['style'\] \}\)/);
});

test('switching session reports focus', () => {
  assert.match(functionSource(APP_SRC, 'setActiveSession'), /reportActivityFocus\(\)/);
});

test('a project reload reports focus, so a title generated late reaches the bucket', () => {
  const load = functionSource(APP_SRC, 'loadProjects');
  assert.ok(load.indexOf('dedup(cachedAllProjects)') < load.indexOf('reportActivityFocus()'),
    'reported after the fresh data is applied');
});

test('a project reload sends the titles of the open sessions', () => {
  const load = functionSource(APP_SRC, 'loadProjects');
  assert.ok(load.indexOf('dedup(cachedAllProjects)') < load.indexOf('reportActivityTitles()'));
  const fn = functionSource(APP_SRC, 'reportActivityTitles');
  const sent = [];
  const ctx = {
    window: { api: { reportActivityTitles: (l) => sent.push(l) } },
    openSessions: new Map([['a', {}], ['b', {}], ['c', {}]]),
    sessionMap: new Map([['a', { name: 'mine' }], ['b', { aiTitle: 'generated', summary: 'p' }], ['c', { summary: 'first prompt' }]]),
  };
  vm.createContext(ctx);
  vm.runInContext(functionSource(UTILS_SRC, 'cleanDisplayName'), ctx);
  vm.runInContext(fn + '\nreportActivityTitles()', ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0])), [{ sessionId: 'a', name: 'mine' }, { sessionId: 'b', name: 'generated' }, { sessionId: 'c', name: '' }],
    'never the summary');
});
