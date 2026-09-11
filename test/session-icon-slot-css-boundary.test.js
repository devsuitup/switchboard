// Issue #246 step 3b (coordinator follow-up, 2026-09-11) — the icon slot's
// visual must key on its own session-icon--<rung> class alone.
// renderSessionIcon() (public/session-state.js) already resolves rung
// priority in JS — attention > responseReady > busy > agentsBusy >
// waitingForInput > idle > stale > archived — before the slot's classList is
// ever written (session-activity-dom.js's writeIconSlot). style.css must
// never re-arbitrate that priority itself with a :not() row-class chain
// targeting .session-icon: that was the pre-slot mechanism, back when the
// four row classes (cli-busy/needs-attention/response-ready/has-busy-agents)
// could disagree with each other and CSS had to pick a winner. See
// .ai/contexts/session-state.md ("The icon slot (step 3b)").
//
// Same source-grep shape as test/sidebar-busy-agents-tint.test.js's CSS pins
// — no real CSS parser, just brace/comment stripping good enough to isolate
// selector text.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

// Strip comments first — a couple of them (deliberately) mention ":not()" and
// ".session-icon" in prose explaining what NOT to do, which would otherwise
// false-positive a naive selector-text scan.
const CSS_NO_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

test('style.css: no :not() chain targets .session-icon (the slot resolves priority in JS, not CSS)', () => {
  const ruleBlocks = CSS_NO_COMMENTS.match(/[^{}]+\{[^{}]*\}/g) || [];
  const offenders = [];
  for (const block of ruleBlocks) {
    // Only the last physical line before `{` is the actual selector — guards
    // against a stray non-comment run of text picking up unrelated content.
    const lines = block.split('{')[0].split('\n');
    const selector = lines[lines.length - 1].trim();
    if (!selector) continue;
    if (!/\.session-icon\b/.test(selector)) continue;
    // .remote-host-dot / .session-status-dot are a different row (the
    // project header's per-host reachability dot) — untouched by #246 and
    // out of scope for this guard.
    if (/\.session-status-dot|\.remote-host-dot/.test(selector)) continue;
    if (/:not\(/.test(selector)) offenders.push(selector);
  }
  assert.deepEqual(offenders, [],
    'a .session-icon selector must never use :not() row-class tie-breaking — offending selector(s): ' + JSON.stringify(offenders));
});

test('style.css: sanity — the guard above actually inspects .session-icon rules (not vacuously empty)', () => {
  const ruleBlocks = CSS_NO_COMMENTS.match(/[^{}]+\{[^{}]*\}/g) || [];
  const sessionIconSelectors = ruleBlocks
    .map((block) => {
      const lines = block.split('{')[0].split('\n');
      return lines[lines.length - 1].trim();
    })
    .filter((selector) => /\.session-icon\b/.test(selector) && !/\.session-status-dot|\.remote-host-dot/.test(selector));
  assert.ok(sessionIconSelectors.length >= 8,
    'expected at least the base slot, .running, and the four rung rules to be picked up — got: ' + JSON.stringify(sessionIconSelectors));
});
