// Three-state sidebar vocabulary — see docs/subagents.md "Live status".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

const BLUE = '#4fc3f7';
const VIOLET = '#8088ff';

function projectWithLiveSubagent() {
  return makeSampleProject({
    sessions: [
      {
        sessionId: 's-top-1',
        name: 'main session',
        summary: 'top level 1',
        modified: '2026-05-22T10:00:00.000Z',
        starred: false,
        archived: 0,
        messageCount: 1,
      },
      {
        sessionId: 'sub:s-top-1:agent-1',
        parentSessionId: 's-top-1',
        agentId: 'agent-1',
        subagentType: 'explore',
        description: 'explore subagent',
        modified: '2026-05-22T09:59:00.000Z',
        messageCount: 1,
      },
    ],
  });
}

// --- the two classes must coexist on the item, or the CSS has nothing to arbitrate

test('a busy session with no subagents carries cli-busy alone', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sessionBusyState.set('s-top-1', true);
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], true);

    const parent = ctx.document.getElementById('si-s-top-1');
    assert.ok(parent.classList.contains('cli-busy'), 'cli-busy set from sessionBusyState');
    assert.ok(!parent.classList.contains('has-busy-agents'), 'no subagent indicator without a live subagent');
  } finally {
    ctx.destroy();
  }
});

test('a busy session with live subagents carries cli-busy AND has-busy-agents at once', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sessionBusyState.set('s-top-1', true);
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], true);
    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore' });

    const parent = ctx.document.getElementById('si-s-top-1');
    assert.ok(parent.classList.contains('cli-busy'), 'cli-busy is not dropped by the subagent indicator');
    assert.ok(parent.classList.contains('has-busy-agents'), 'has-busy-agents is applied even while busy');

    ctx.sidebar.renderProjects([projectWithLiveSubagent()], false);
    const reRendered = ctx.document.getElementById('si-s-top-1');
    assert.ok(reRendered.classList.contains('cli-busy'), 'both classes survive a full re-render');
    assert.ok(reRendered.classList.contains('has-busy-agents'), 'both classes survive a full re-render');
  } finally {
    ctx.destroy();
  }
});

// --- source-level pins: jsdom does not resolve ::before, so the cascade is pinned here

// Issue #246 step 3b (coordinator follow-up, 2026-09-11): the slot's visual
// now keys on its own session-icon--<rung> class alone — renderSessionIcon()
// already resolved which single rung applies in JS, so needs-attention/
// cli-busy precedence is no longer a CSS :not()-chain concern (see
// test/session-icon-slot-css-boundary.test.js for the source-level guard that
// no such chain ever targets .session-icon again). The tests below pin what's
// left: the busy glyph itself, and the has-busy-agents row tint layered on
// top of it (has-busy-agents stays a row-level class, not a slot rung).

test('style.css: cli-busy alone paints the spinner blue', () => {
  const rule = CSS.match(/\.session-icon--busy::before \{[\s\S]*?\}/);
  assert.ok(rule, 'the cli-busy spinner rule must still exist');
  assert.match(rule[0], new RegExp('color:\\s*' + BLUE), 'the plain busy spinner stays light blue');
  assert.match(rule[0], /animation:\s*braille-spin/, 'the spinner animation is the existing one');
});

test('style.css: cli-busy + has-busy-agents tints the same spinner violet', () => {
  const rule = CSS.match(/\.session-item\.has-busy-agents \.session-icon--busy::before \{[\s\S]*?\}/);
  assert.ok(rule, 'a rule must tint the busy spinner when subagents are live');
  assert.match(rule[0], new RegExp('color:\\s*' + VIOLET), 'it reuses the has-busy-agents violet');
  assert.ok(!/content\s*:/.test(rule[0]), 'the glyph must not change — colour only');
  assert.ok(!/animation\s*:/.test(rule[0]), 'no new animation — docs/decisions/0002');
});

test('style.css: the violet tint wins the cascade over the blue one', () => {
  const blueAt = CSS.indexOf('.session-icon--busy::before');
  const violetAt = CSS.indexOf('.session-item.has-busy-agents .session-icon--busy::before');
  assert.notEqual(blueAt, -1);
  assert.notEqual(violetAt, -1);
  assert.ok(violetAt > blueAt, 'the tint must come after the rule it overrides');
});

test('style.css: subagents without cli-busy still get the static glyph, unchanged', () => {
  // No :not(.cli-busy) chain needed any more: renderSessionIcon() only ever
  // resolves the agentsBusy rung (session-icon--agents-busy) when busy is
  // not active — see .ai/contexts/session-state.md priority order.
  const rule = CSS.match(/\.session-icon--agents-busy::before \{[\s\S]*?\}/);
  assert.ok(rule, 'the idle-parent indicator rule must still exist');
  assert.match(rule[0], /content:\s*"\\283F"/, 'still the static ⠿ cell');
  assert.match(rule[0], new RegExp('color:\\s*' + VIOLET), 'still violet');
  assert.ok(!/animation\s*:/.test(rule[0]), 'still static');
});

test('the tint can never collide with response-ready: renderSessionIcon keeps them exclusive', () => {
  // Moved from a source-level regex pin on session-activity.js to a real
  // exercise of session-state.js (the split introduced in .ai/contexts/session-state.md).
  const { createSessionState, renderSessionIcon } = require('../public/session-state.js');
  const state = createSessionState('local-pty');

  state.apply({ type: 'busy', active: true });
  state.apply({ type: 'busy', active: false, armReady: true }); // idle, unseen → response-ready
  assert.ok(renderSessionIcon(state.snapshot()).classes.includes('response-ready'), 'precondition: response-ready armed');

  state.apply({ type: 'busy', active: true }); // busy again
  const classes = renderSessionIcon(state.snapshot()).classes;
  assert.ok(classes.includes('cli-busy'));
  assert.ok(!classes.includes('response-ready'), 'cli-busy is only ever set when the session is not response-ready');
});
