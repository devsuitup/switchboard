// Tests for the first-run cold-start indexing banner.
//
// updateIndexingBanner and dismissIndexingBanner are extracted from the real
// public/app.js (test/app-source.js) and run in the jsdom window that
// dom-setup.js builds, next to the real formatIndexingBannerText of utils.js.
//
// Invariants under test:
//   1. formatIndexingBannerText renders "i/N projects, X sessions so far".
//   2. A cold-start progress event (coldStart:true, done:false) shows the banner.
//   3. done:true hides the banner immediately.
//   4. An event without coldStart (shouldn't happen, but defends the gate) is ignored.
//   5. Clicking the dismiss button hides the banner immediately, before done:true
//      (PR #124 review finding F2: the banner was documented as "dismissible" but
//      had no actual close control, only an auto-hide-on-done path).
//   6. Once dismissed, further non-done progress events don't re-show the banner.
//   7. A done:true event resets the dismissed flag so a future cold-start run
//      (e.g. after a cache-clearing migration) can show its own banner again.
//   8. A done:true event carrying an error shows the failure in the banner
//      (even past a dismiss) instead of silently hiding it -- the tiny status
//      indicator used to be the only trace of a failed scan.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

test('formatIndexingBannerText: renders the one-time first-run message with counters', () => {
  const { window, destroy } = setupSidebarDom();
  try {
    const text = window.formatIndexingBannerText({ current: 3, total: 16, sessionsSoFar: 128 });
    assert.equal(text, 'Indexing your Claude Code history — one-time, 3/16 projects, 128 sessions so far');
  } finally {
    destroy();
  }
});

function withHarness(fn) {
  const ctx = setupSidebarDom();
  try {
    const banner = ctx.document.createElement('div');
    banner.style.display = 'none';
    const bannerText = ctx.document.createElement('span');
    banner.appendChild(bannerText);
    ctx.window.indexingBanner = banner;
    ctx.window.indexingBannerText = bannerText;
    const fns = loadAppFunctions(ctx.context, {
      declarations: ['indexingBannerDismissed'],
      functions: ['updateIndexingBanner', 'dismissIndexingBanner'],
    });
    fn({
      banner,
      bannerText,
      updateIndexingBanner: fns.updateIndexingBanner,
      dismissIndexingBanner: fns.dismissIndexingBanner,
      isDismissed: () => vm.runInContext('indexingBannerDismissed', ctx.context),
    });
  } finally {
    ctx.destroy();
  }
}

test('updateIndexingBanner: shows the banner with progress text on a cold-start event', () => {
  withHarness(({ banner, bannerText, updateIndexingBanner }) => {
    updateIndexingBanner({ coldStart: true, current: 1, total: 16, sessionsSoFar: 4, done: false });
    assert.equal(banner.style.display, '');
    assert.match(bannerText.textContent, /1\/16 projects, 4 sessions so far/);
  });
});

test('updateIndexingBanner: hides the banner immediately on done:true', () => {
  withHarness(({ banner, updateIndexingBanner }) => {
    updateIndexingBanner({ coldStart: true, current: 5, total: 16, sessionsSoFar: 50, done: false });
    assert.equal(banner.style.display, '');
    updateIndexingBanner({ coldStart: true, current: 16, total: 16, sessionsSoFar: 200, done: true });
    assert.equal(banner.style.display, 'none', 'banner must disappear once indexing completes');
  });
});

test('updateIndexingBanner: ignores events without coldStart (warm-start rebuilds never emit these, but defend the gate)', () => {
  withHarness(({ banner, updateIndexingBanner }) => {
    updateIndexingBanner({ coldStart: false, current: 1, total: 5, sessionsSoFar: 1, done: false });
    assert.equal(banner.style.display, 'none', 'no coldStart flag must never show the banner');
  });
});

test('updateIndexingBanner: ignores a null/undefined payload without throwing', () => {
  withHarness(({ banner, updateIndexingBanner }) => {
    assert.doesNotThrow(() => updateIndexingBanner(null));
    assert.equal(banner.style.display, 'none');
  });
});

test('dismissIndexingBanner: hides the banner immediately, before done:true', () => {
  withHarness(({ banner, updateIndexingBanner, dismissIndexingBanner }) => {
    updateIndexingBanner({ coldStart: true, current: 2, total: 16, sessionsSoFar: 10, done: false });
    assert.equal(banner.style.display, '', 'sanity: banner is showing before dismiss');

    dismissIndexingBanner();

    assert.equal(banner.style.display, 'none', 'dismiss must hide the banner without waiting for done:true');
  });
});

test('dismissIndexingBanner: once dismissed, further non-done progress events do not re-show the banner', () => {
  withHarness(({ banner, updateIndexingBanner, dismissIndexingBanner }) => {
    updateIndexingBanner({ coldStart: true, current: 2, total: 16, sessionsSoFar: 10, done: false });
    dismissIndexingBanner();

    updateIndexingBanner({ coldStart: true, current: 3, total: 16, sessionsSoFar: 20, done: false });

    assert.equal(banner.style.display, 'none', 'a dismissed banner must stay hidden until the run completes');
  });
});

test('formatIndexingBannerText: a payload with an error renders the failure message', () => {
  const { window, destroy } = setupSidebarDom();
  try {
    const text = window.formatIndexingBannerText({ current: 3, total: 16, sessionsSoFar: 128, error: 'ENOSPC: no space left on device' });
    assert.equal(text, 'Indexing failed: ENOSPC: no space left on device — it will resume on the next launch.');
  } finally {
    destroy();
  }
});

test('updateIndexingBanner: done:true with an error shows the failure instead of hiding the banner', () => {
  withHarness(({ banner, bannerText, updateIndexingBanner }) => {
    updateIndexingBanner({ coldStart: true, current: 2, total: 16, sessionsSoFar: 10, done: false });

    updateIndexingBanner({ coldStart: true, current: 5, total: 16, sessionsSoFar: 40, done: true, error: 'worker exited unexpectedly' });

    assert.equal(banner.style.display, '', 'a failed scan must stay visible, not silently disappear');
    assert.match(bannerText.textContent, /Indexing failed: worker exited unexpectedly/);
  });
});

test('updateIndexingBanner: a failure surfaces even after the user dismissed the progress banner', () => {
  withHarness(({ banner, bannerText, updateIndexingBanner, dismissIndexingBanner }) => {
    updateIndexingBanner({ coldStart: true, current: 2, total: 16, sessionsSoFar: 10, done: false });
    dismissIndexingBanner();

    updateIndexingBanner({ coldStart: true, current: 5, total: 16, sessionsSoFar: 40, done: true, error: 'boom' });

    assert.equal(banner.style.display, '',
      '"your history did not finish indexing" is new information, not more of the dismissed progress stream');
    assert.match(bannerText.textContent, /Indexing failed: boom/);
  });
});

test('a done:true event resets the dismissed flag for a future cold-start run', () => {
  withHarness(({ updateIndexingBanner, dismissIndexingBanner, isDismissed }) => {
    updateIndexingBanner({ coldStart: true, current: 2, total: 16, sessionsSoFar: 10, done: false });
    dismissIndexingBanner();
    assert.equal(isDismissed(), true);

    updateIndexingBanner({ coldStart: true, current: 16, total: 16, sessionsSoFar: 200, done: true });

    assert.equal(isDismissed(), false, 'done:true must clear the dismissed flag so a later run gets its own banner');
  });
});
