'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom } = require('./dom-setup');

test('headActivitySnapshot preserves the complete row snapshot across head, hint, ownership and liveness combinations', () => {
  const ctx = setupSidebarDom();
  try {
    const heads = [undefined, 'unknown', 'open', 'closed'];
    const idleCases = [undefined, 90, 100, 110];
    const promptCases = [
      { promptHint: false }, { promptHint: true },
      { promptHint: true, promptHintAt: 190 },
      { promptHint: true, promptHintAt: 200 },
      { promptHint: true, promptHintAt: 210 },
      { promptHint: false, promptHintAt: 210 },
    ];
    const current = ctx.read('headTurns');
    let cases = 0;
    for (const head of heads) for (const idleHintAt of idleCases) for (const prompt of promptCases) {
      for (const background of [false, true]) for (const ptyHere of [false, true]) {
        for (const liveness of [undefined, 'unknown', 'dead', 'alive']) {
          for (const flags of [{}, { attention: true, ready: true, manualUnread: true },
            { ready: true, ended: true }, { manualUnread: true, waitingForInput: true }]) {
            const { ready, ended, manualUnread, ...rest } = flags;
            const turn = head === undefined ? undefined : { state: head, lastEntryAt: 100, observedAt: 200, ready, ended };
            if (turn) current.set('table', turn);
            else current.delete('table');
            ctx.window.activePtyIds[ptyHere ? 'add' : 'delete']('table');
            ctx.window.tableManualUnread = !!manualUnread;
            ctx.read('localPtyStates.set("table", { snapshot: () => ({ manualUnread: tableManualUnread }) })');
            const snapshot = { marker: 'preserved', ...rest, liveness, idleHintAt, ...prompt, backgroundJob: background };
            const headByIdle = head !== undefined && !background && idleHintAt === 110;
            const headByPromptTime = head === 'open' && prompt.promptHintAt === 210;
            const unknownPrompt = (head === undefined || head === 'unknown') && prompt.promptHint
              && (!background || prompt.promptHintAt !== undefined);
            const effective = headByIdle || headByPromptTime || unknownPrompt ? 'closed' : head || 'unknown';
            const alive = liveness === 'alive' || ptyHere;
            const expected = { ...snapshot, ...ctx.window.writtenActivitySnapshot('table'),
              headTurn: effective, busy: alive && effective === 'open',
              responseReady: !rest.attention && (!!turn?.ready || !!manualUnread),
              waitingForInput: alive && effective !== 'open' && (!ptyHere || !!rest.waitingForInput || !!turn?.ended),
              liveness: alive ? 'alive' : liveness };
            assert.equal(JSON.stringify(ctx.window.headActivitySnapshot('table', snapshot)), JSON.stringify(expected),
              JSON.stringify({ head, idleHintAt, prompt, background, ptyHere, liveness, flags }));
            cases++;
          }
        }
      }
    }
    assert.equal(cases, 6144);
  } finally { ctx.destroy(); }
});

test('the row follows the shared head-precedence export, including sentinel head and busy fields', () => {
  const ctx = setupSidebarDom();
  try {
    const projection = ctx.read('sessionStatusProjection');
    const original = projection.projectHeadActivity;
    try {
      projection.projectHeadActivity = () => ({ headTurn: 'sentinel', busy: 'sentinel-busy',
        waitingForInput: 'sentinel-waiting', liveness: 'sentinel-alive' });
      const result = ctx.window.headActivitySnapshot('sentinel', { liveness: 'alive' });
      assert.equal(result.headTurn, 'sentinel');
      assert.equal(result.busy, 'sentinel-busy');
      assert.equal(result.waitingForInput, 'sentinel-waiting');
      assert.equal(result.liveness, 'sentinel-alive');
    } finally { projection.projectHeadActivity = original; }
  } finally { ctx.destroy(); }
});
