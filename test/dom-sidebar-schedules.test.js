const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

const prompt = 'Invoke the journal command';

function session(sessionId, slug, overrides = {}) {
  return {
    sessionId, slug, scheduleSlug: slug,
    firstPrompt: `Scheduled Task: ${prompt}`,
    name: prompt,
    summary: `Scheduled Task: ${prompt}`,
    modified: '2026-10-08T08:00:00Z',
    messageCount: 2,
    ...overrides,
  };
}

function render(sessions, verify) {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([makeSampleProject({ sessions })], true);
    verify(ctx);
  } finally {
    ctx.destroy();
  }
}

function groupNames(ctx) {
  return [...ctx.document.querySelectorAll('.slug-group-name')].map(el => el.textContent);
}

test('a typed Scheduled Task prompt never creates a schedule group', () => {
  render([
    session('plain', 'woolly-scribbling-wirth', { scheduleSlug: null }),
    session('morning', 'journal-morning'),
  ], ctx => {
    assert.equal(ctx.document.querySelector('[data-session-id="plain"]').closest('.slug-group'), null);
    assert.deepEqual(groupNames(ctx), ['journal-morning']);
  });
});

test('schedule provenance groups runs without a prefix or a CLI slug', () => {
  render([session('marked', null, { scheduleSlug: 'journal-morning', firstPrompt: prompt })], ctx => {
    assert.deepEqual(groupNames(ctx), ['journal-morning']);
  });
});

test('invalid schedule markers leave ordinary singleton sessions ungrouped', () => {
  const sessions = [null, '', 1, ['journal-morning'], { length: 1 }].map((scheduleSlug, i) =>
    session('invalid-' + i, 'ordinary-' + i, { scheduleSlug }));
  render(sessions, ctx => {
    assert.equal(ctx.document.querySelectorAll('.slug-group').length, 0);
  });
});

test('legacy expansion migrates once and an explicit collapse survives rebuilding', () => {
  const ctx = setupSidebarDom();
  try {
    loadAppFunctions(ctx.context, { functions: ['getExpandedSlugs', 'saveExpandedSlugs'] });
    ctx.window.sessionStorage.setItem('expandedSlugs', JSON.stringify(['slug-journal-morning']));
    const projects = [makeSampleProject({ sessions: [session('run', 'journal-morning')] })];
    ctx.sidebar.renderProjects(projects, true);
    const group = ctx.document.querySelector('.slug-group');
    assert.ok(!group.classList.contains('collapsed'), 'legacy expansion retained');
    assert.ok(JSON.parse(ctx.window.sessionStorage.getItem('expandedSlugs')).includes(group.id), 'scoped key persisted');
    group.querySelector('.slug-group-header').click();
    ctx.window.sessionStorage.setItem('expandedSlugs', JSON.stringify(['slug-journal-morning']));
    ctx.document.getElementById('sidebar-content').replaceChildren();
    ctx.sidebar.renderProjects(projects, true);
    assert.ok(ctx.document.querySelector('.slug-group').classList.contains('collapsed'), 'legacy key cannot reopen a migrated group');
  } finally {
    ctx.destroy();
  }
});

test('a schedule with one visible run has its own named header', () => {
  render([session('morning-1', 'journal-morning')], ctx => {
    assert.equal(ctx.document.querySelectorAll('.slug-group').length, 1);
    assert.deepEqual(groupNames(ctx), ['journal-morning']);
    const group = ctx.document.querySelector('.slug-group');
    assert.ok(group.querySelector('[data-session-id="morning-1"]'));
    assert.equal(group.querySelector('.slug-group-count').textContent, '1 sessions');
    assert.ok(group.classList.contains('collapsed'));
    group.querySelector('.slug-group-header').click();
    assert.ok(!group.classList.contains('collapsed'));
    ctx.sidebar.renderProjects([makeSampleProject({ sessions: [session('morning-1', 'journal-morning')] })], false);
    assert.ok(!ctx.document.querySelector('.slug-group').classList.contains('collapsed'));
  });
});

test('two schedules with the same prompt keep separate named groups', () => {
  render([
    session('morning-1', 'journal-morning'),
    session('morning-2', 'journal-morning'),
    session('evening-1', 'journal-evening'),
  ], ctx => {
    assert.deepEqual(groupNames(ctx).sort(), ['journal-evening', 'journal-morning']);
    const groups = [...ctx.document.querySelectorAll('.slug-group')];
    const morning = groups.find(group => group.querySelector('.slug-group-name').textContent === 'journal-morning');
    const evening = groups.find(group => group.querySelector('.slug-group-name').textContent === 'journal-evening');
    assert.equal(morning.querySelectorAll('.session-item').length, 2);
    assert.equal(evening.querySelectorAll('.session-item').length, 1);
    assert.ok(evening.querySelector('[data-session-id="evening-1"]'));
  });
});

test('a plain session sharing the prompt and slug stays outside the schedule group', () => {
  render([
    session('morning-1', 'journal-morning'),
    session('plain-1', 'journal-morning', { firstPrompt: prompt, summary: prompt, scheduleSlug: null }),
  ], ctx => {
    const plain = ctx.document.querySelector('[data-session-id="plain-1"]');
    assert.equal(plain.closest('.slug-group'), null);
    assert.deepEqual(groupNames(ctx), ['journal-morning']);
    assert.equal(ctx.document.querySelector('.slug-group-count').textContent, '1 sessions');
  });
});

test('a catch-up run uses its schedule header despite a renamed session', () => {
  render([session('catch-up-1', 'journal-morning', {
    firstPrompt: 'Scheduled Task (catch-up: due 2026-10-07T08:00:00.000Z, started 2026-10-08T08:00:00.000Z): Invoke',
    name: 'Renamed run',
  })], ctx => {
    assert.deepEqual(groupNames(ctx), ['journal-morning']);
  });
});

test('ordinary singleton and shared CLI slugs keep their existing grouping', () => {
  render([
    session('plain-1', 'single', { firstPrompt: prompt, scheduleSlug: null }),
    session('plain-2', 'woolly-scribbling-wirth', { firstPrompt: prompt, scheduleSlug: null }),
    session('plain-3', 'woolly-scribbling-wirth', { firstPrompt: prompt, scheduleSlug: null }),
  ], ctx => {
    assert.equal(ctx.document.querySelector('[data-session-id="plain-1"]').closest('.slug-group'), null);
    assert.deepEqual(groupNames(ctx), [prompt]);
    assert.equal(ctx.document.querySelector('.slug-group-count').textContent, '2 sessions');
  });
});

test('ordinary slug groups and schedule groups with the same slug have distinct DOM identities', () => {
  render([
    session('morning-1', 'journal-morning'),
    session('plain-1', 'journal-morning', { firstPrompt: prompt, scheduleSlug: null }),
    session('plain-2', 'journal-morning', { firstPrompt: prompt, scheduleSlug: null }),
  ], ctx => {
    const groups = [...ctx.document.querySelectorAll('.slug-group')];
    assert.equal(groups.length, 2);
    assert.equal(new Set(groups.map(group => group.id)).size, 2);
    assert.deepEqual(groupNames(ctx).sort(), [prompt, 'journal-morning'].sort());
  });
});

test('schedule slugs differing by punctuation keep distinct identities and collapse states', () => {
  const sessions = [session('dotted', 'journal.morning'), session('underscored', 'journal_morning')];
  render(sessions, ctx => {
    const groups = [...ctx.document.querySelectorAll('.slug-group')];
    assert.equal(new Set(groups.map(group => group.id)).size, 2);
    groups[0].querySelector('.slug-group-header').click();
    ctx.sidebar.renderProjects([makeSampleProject({ sessions: [...sessions].reverse() })], true);
    const dotted = ctx.document.querySelector('[data-session-id="dotted"]').closest('.slug-group');
    const underscored = ctx.document.querySelector('[data-session-id="underscored"]').closest('.slug-group');
    assert.ok(!dotted.classList.contains('collapsed'));
    assert.ok(underscored.classList.contains('collapsed'));
  });
});

test('the same schedule slug in different projects or hosts keeps independent persisted collapse state', () => {
  const ctx = setupSidebarDom();
  try {
    loadAppFunctions(ctx.context, { functions: ['getExpandedSlugs', 'saveExpandedSlugs'] });
    const projects = [
      makeSampleProject({ projectPath: '/project-a', sessions: [session('project-a', 'journal-morning')] }),
      makeSampleProject({ projectPath: '/project-b', sessions: [session('project-b', 'journal-morning')] }),
      makeSampleProject({ projectPath: '/project-a', remoteAlias: 'remote', sessions: [session('remote-a', 'journal-morning')] }),
    ];
    ctx.sidebar.renderProjects(projects, true);
    const groups = [...ctx.document.querySelectorAll('.slug-group')];
    assert.equal(new Set(groups.map(group => group.id)).size, 3);
    groups[0].querySelector('.slug-group-header').click();
    ctx.document.getElementById('sidebar-content').replaceChildren();
    ctx.sidebar.renderProjects(projects, true);
    assert.ok(!ctx.document.querySelector('[data-session-id="project-a"]').closest('.slug-group').classList.contains('collapsed'));
    for (const id of ['project-b', 'remote-a']) {
      assert.ok(ctx.document.querySelector(`[data-session-id="${id}"]`).closest('.slug-group').classList.contains('collapsed'));
    }
  } finally {
    ctx.destroy();
  }
});
