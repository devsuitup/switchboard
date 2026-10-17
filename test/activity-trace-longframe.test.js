'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(enabled, types) {
  const observers = [], sent = [];
  let push, typeReads = 0;
  class PerformanceObserver {
    static get supportedEntryTypes() { typeReads++; return types; }
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(options) { this.options = options; }
    disconnect() { this.disconnected = true; }
    deliver(entries) { this.callback({ getEntries: () => entries }); }
  }
  const window = { PerformanceObserver, api: {
    activityTraceEnabled: enabled, traceActivity: (...args) => sent.push(args),
    onActivityTraceState: callback => { push = callback; },
  } };
  const filename = path.join(__dirname, '../public/activity-trace.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { window }, { filename });
  return { observers, sent, push: state => push(state), typeReads: () => typeReads };
}

test('longframe observer is absent when off, armed once when on, and disconnected on disable', () => {
  const f = fixture(false, ['long-animation-frame', 'longtask']);
  assert.equal(f.observers.length, 0);
  assert.equal(f.typeReads(), 0);
  f.push(true);
  assert.equal(f.observers.length, 1);
  assert.equal(f.observers[0].options.type, 'long-animation-frame');
  f.push(true);
  assert.equal(f.observers.length, 1);
  f.observers[0].deliver([{ duration: 49, blockingDuration: 2 }, { duration: 50, blockingDuration: 8 }]);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0][0], 'renderer.longframe');
  assert.equal(f.sent[0][2].durationMs, 50);
  assert.equal(f.sent[0][2].blockingMs, 8);
  f.push(false);
  assert.equal(f.observers[0].disconnected, true);
  f.observers[0].deliver([{ duration: 100, blockingDuration: 50 }]);
  assert.equal(f.sent.length, 1);
  f.push(true);
  assert.equal(f.observers.length, 2);
  f.observers[0].deliver([{ duration: 100, blockingDuration: 50 }]);
  assert.equal(f.sent.length, 1, 'a stale observer cannot cross trace windows');
});

test('startup-enabled probe falls back to longtask and estimates blocking beyond 50 ms', () => {
  const f = fixture(true, ['longtask']);
  assert.equal(f.observers.length, 1);
  assert.equal(f.observers[0].options.type, 'longtask');
  f.observers[0].deliver([{ duration: 80 }]);
  assert.equal(f.sent[0][2].durationMs, 80);
  assert.equal(f.sent[0][2].blockingMs, 30);
});

test('probe tolerates unsupported browsers', () => {
  const f = fixture(true, []);
  assert.equal(f.observers.length, 0);
  assert.equal(f.sent.length, 0);
});
