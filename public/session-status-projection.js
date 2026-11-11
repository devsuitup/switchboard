'use strict';

const sessionStatusProjection = {
  projectHeadActivity(snapshot, turn, proof) {
    const { ptyHere = false, background: initialBackground = false } = proof ?? {};
    let background = initialBackground;
    const s = snapshot || {};
    const alive = s.liveness === 'alive' || ptyHere;
    background ||= s.backgroundJob;
    const promptHint = s.promptHint && (!background || Number.isFinite(s.promptHintAt));
    const idleNewer = !background && Number.isFinite(s.idleHintAt) && Number.isFinite(turn?.lastEntryAt) && s.idleHintAt > turn.lastEntryAt
      || turn?.state === 'open' && Number.isFinite(s.promptHintAt) && Number.isFinite(turn?.observedAt) && s.promptHintAt > turn.observedAt;
    const headTurn = idleNewer || (promptHint && (!turn || turn.state === 'unknown')) ? 'closed' : turn?.state || 'unknown';
    return { headTurn, busy: alive && headTurn === 'open',
      waitingForInput: alive && headTurn !== 'open' && (!ptyHere || !!s.waitingForInput || !!turn?.ended),
      liveness: alive ? 'alive' : s.liveness };
  },

  projectSessionStatus(snapshot, turn, proof = {}) {
    proof ??= {};
    const head = sessionStatusProjection.projectHeadActivity(snapshot, turn, proof);
    if (proof.ambiguous) return { state: 'unknown', detail: 'ambiguous' };
    if (proof.confirmedExit && head.liveness === 'dead') return { state: 'exited', detail: 'confirmed-exit' };
    if (head.liveness !== 'alive') return { state: 'unknown', detail: 'no-live-proof' };
    if (proof.blocking) return { state: 'waiting', detail: 'blocking-dialog' };
    if (head.headTurn === 'open') return { state: 'busy', detail: 'open-turn' };
    if (proof.shell) return { state: 'busy', detail: 'shell' };
    if (head.headTurn === 'closed') return { state: 'idle', detail: 'prompt' };
    return { state: 'unknown', detail: 'head-unknown' };
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = sessionStatusProjection;
}
