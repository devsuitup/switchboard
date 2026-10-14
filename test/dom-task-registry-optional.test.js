'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

test('sidebar and grid load and render safely when a minimal harness has no task registry', t => {
  const h = setupSidebarDom({ loadTaskRegistry: false });
  t.after(() => h.destroy());
  assert.equal(h.window.taskRegistry, undefined);
  h.sidebar.renderProjects([makeSampleProject()], true);
  h.evalPublic('shortcuts.js');
  h.evalPublic('grid-view.js');
  h.window.pruneStaleGridSubagents();
  assert.equal(h.window.parentHasActiveSubagent('missing'), false);
});
