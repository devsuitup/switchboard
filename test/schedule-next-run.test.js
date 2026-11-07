'use strict';

process.env.TZ = 'Europe/Paris';
const test = require('node:test');
const assert = require('node:assert/strict');
const runner = require('../src/main/schedules/schedule-runner');
const minute = 60000;
const year = 366 * 24 * 60 * minute;

function naive(expr, after, horizon = year) {
  for (let t = Math.floor(after / minute) * minute + minute; t <= after + horizon; t += minute) {
    if (runner.cronMatches(expr, new Date(t))) return t;
  }
  return null;
}

test('next run agrees with the naive walk across Paris DST and AND day fields', () => {
  assert.equal(typeof runner.nextCronMatch, 'function');
  const expressions = ['*/15 * * * *', '0 9 * * 1-5', '30 2 * * *', '30 0 * * 1', '0 0 29 2 *', '0 9 1 * 1', '5,35 */3 * 6-8 0,6'];
  const starts = ['2026-03-27T12:00Z', '2026-10-23T12:00Z', '2026-10-25T00:31Z', '2026-03-29T00:59Z'];
  for (const expr of expressions) for (const start of starts) {
    const after = Date.parse(start);
    assert.equal(runner.nextCronMatch(expr, after), naive(expr, after), `${expr} after ${start}`);
  }
});

test('next run includes the repeated Paris hour', () => {
  assert.equal(typeof runner.nextCronMatch, 'function');
  assert.equal(runner.nextCronMatch('30 2 * * *', Date.parse('2026-10-25T00:31Z')), Date.parse('2026-10-25T01:30Z'));
});

test('next run skips to local minute zero in Kolkata', () => {
  assert.equal(typeof runner.nextCronMatch, 'function');
  process.env.TZ = 'Asia/Kolkata';
  try {
    assert.equal(runner.nextCronMatch('*/15 * * * *', Date.parse('2026-12-19T01:18Z')), Date.parse('2026-12-19T01:30Z'));
  } finally { process.env.TZ = 'Europe/Paris'; }
});

test('next run respects the horizon and permits leap day with four years', () => {
  assert.equal(typeof runner.nextCronMatch, 'function');
  const after = Date.parse('2026-11-03T00:00Z');
  assert.equal(runner.nextCronMatch('0 0 29 2 *', after), null);
  assert.equal(runner.nextCronMatch('0 0 29 2 *', after, 4 * year), Date.parse('2028-02-28T23:00Z'));
  assert.equal(runner.nextCronMatch('* * * * *', after, minute - 1), null);
  assert.equal(runner.nextCronMatch('* * * * *', after, minute), after + minute);
});

test('cron descriptions recognize only supported presets', () => {
  assert.equal(typeof runner.describeCron, 'function');
  assert.equal(runner.describeCron('*/15 * * * *'), 'every 15 min');
  assert.equal(runner.describeCron('0 9 * * 1-5'), 'weekdays at 9:00');
  assert.equal(runner.describeCron('30 2 * * *'), 'daily at 2:30');
  for (const expr of ['0 9 1 * 1', '5,35 */3 * 6-8 0,6', '@daily', '*/0 * * * *']) assert.equal(runner.describeCron(expr), expr);
});

test('non-divisor steps retain the raw cron rather than promising a fixed interval', () => {
  assert.equal(runner.describeCron('*/45 * * * *'), '*/45 * * * *');
  assert.equal(runner.describeCron('*/7 * * * *'), '*/7 * * * *');
  assert.equal(runner.describeCron('*/20 * * * *'), 'every 20 min');
});

test('padded cron numbers describe the numeric launch time', () => {
  assert.equal(runner.describeCron('007 09 * * *'), 'daily at 9:07');
});
