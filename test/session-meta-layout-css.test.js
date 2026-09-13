// Issue #286 — `.session-meta`'s short session id used to shift between the
// far right (two children: time, short id) and the middle (three children:
// status also appended) depending on whether the row currently had a live
// process. See .ai/contexts/session-state.md ("Surfacing status on the
// session object (`.session-meta` layout, issue #286)").
//
// Same source-grep shape as test/session-icon-slot-css-boundary.test.js — no
// real CSS parser, just brace/comment stripping good enough to isolate
// selector text.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
const CSS_NO_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

function ruleFor(selectorPattern) {
  const ruleBlocks = CSS_NO_COMMENTS.match(/[^{}]+\{[^{}]*\}/g) || [];
  return ruleBlocks.find((block) => {
    const lines = block.split('{')[0].split('\n');
    const selector = lines[lines.length - 1].trim();
    return selectorPattern.test(selector);
  });
}

test('style.css: .session-item .session-meta no longer uses justify-content: space-between', () => {
  const rule = ruleFor(/^\.session-item \.session-meta$/);
  assert.ok(rule, 'expected a .session-item .session-meta rule to exist');
  assert.doesNotMatch(rule, /justify-content:\s*space-between/,
    'space-between makes a middle child\'s position depend on how many siblings it has — see issue #286');
});

test('style.css: .session-status is pinned to the right independently of the other .session-meta children', () => {
  const rule = ruleFor(/\.session-meta \.session-status$/);
  assert.ok(rule, 'expected a rule targeting .session-item .session-meta .session-status');
  assert.match(rule, /margin-left:\s*auto/,
    'the status slot, not the short id, should be the element whose position absorbs leftover space');
});
