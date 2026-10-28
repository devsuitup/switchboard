'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function formatter(now) {
  const filename = path.join(__dirname, '..', 'claude-auth.js');
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return new Date(now).getTime(); }
  }
  const context = vm.createContext({ require: createRequire(filename), module: { exports: {} }, process, console, Date: FixedDate });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context.formatResetTime;
}

function inNewYork(t) {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; });
}

for (const [name, now, reset, expected] of [
  ['today', '2026-01-15T10:00:00-05:00', '2026-01-15T15:30:00-05:00', '3:30pm'],
  ['earlier today', '2026-01-15T10:00:00-05:00', '2026-01-15T09:00:00-05:00', '9am'],
  ['tomorrow less than 24h away', '2026-01-15T23:00:00-05:00', '2026-01-16T07:00:00-05:00', 'tomorrow at 7am'],
  ['tomorrow more than 24h away', '2026-01-15T01:00:00-05:00', '2026-01-16T23:15:00-05:00', 'tomorrow at 11:15pm'],
  ['later', '2026-01-15T10:00:00-05:00', '2026-01-18T07:00:00-05:00', 'Jan 18 at 7am'],
  ['midnight across a year boundary', '2026-12-31T23:59:59-05:00', '2027-01-01T00:00:00-05:00', 'tomorrow at 12am'],
  ['just after midnight', '2027-01-01T00:00:01-05:00', '2027-01-01T07:00:00-05:00', '7am'],
  ['spring DST 23-hour day', '2026-03-08T00:01:00-05:00', '2026-03-09T00:01:00-04:00', 'tomorrow at 12:01am'],
  ['fall DST 25-hour day', '2026-11-01T00:01:00-04:00', '2026-11-02T00:01:00-05:00', 'tomorrow at 12:01am'],
]) {
  test(`quota reset on ${name} uses the local calendar day`, t => {
    inNewYork(t);
    const format = formatter(now);
    const date = new Date(reset);
    const zone = Intl.DateTimeFormat('en', { timeZoneName: 'short' }).formatToParts(date).find(p => p.type === 'timeZoneName').value;
    for (const value of [reset, date.getTime(), date.getTime() / 1000]) {
      assert.equal(format(value), `${expected} (${zone})`);
    }
  });
}

test('invalid or absent quota reset stays null', t => {
  inNewYork(t);
  const format = formatter('2026-01-15T10:00:00-05:00');
  for (const value of [null, undefined, '', 'invalid date', NaN]) assert.equal(format(value), null);
});
