'use strict';

// see .ai/contexts/session-cache.md (Startup indexing worker)
function boundedEffects(effects) {
  const result = [];
  const chunks = (name, args, text) => {
    for (let start = 0; start < text.length;) {
      let end = Math.min(text.length, start + 16000);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      result.push({ name, args: [...args, text.slice(start, end)] });
      start = end;
    }
  };
  for (const effect of effects) {
    if (Buffer.byteLength(JSON.stringify(effect)) <= 128 * 1024) { result.push(effect); continue; }
    if (effect.name === 'upsertCachedSessions' || effect.name === 'upsertSearchEntries') {
      const row = { ...effect.args[0][0] };
      const fields = Object.entries(row).filter(([, value]) => typeof value === 'string')
        .sort((a, b) => b[1].length - a[1].length);
      const removed = [];
      for (const [field, value] of fields) {
        if (Buffer.byteLength(JSON.stringify({ name: effect.name, args: [[row]] })) <= 128 * 1024) break;
        row[field] = '';
        removed.push([field, value]);
      }
      result.push({ name: effect.name, args: [[row]] });
      for (const [field, value] of removed) chunks(effect.name === 'upsertCachedSessions' ? 'appendCachedField' : 'appendSearchField',
        effect.name === 'upsertCachedSessions' ? [row.sessionId, field] : [row.type, row.id, field], value);
    } else if (effect.name === 'setName') {
      result.push({ name: 'setName', args: [effect.args[0], ''] });
      chunks('appendSessionName', [effect.args[0]], effect.args[1]);
    } else result.push(effect);
  }
  return result;
}

function normalizeEffects(effects) {
  return effects.flatMap(effect => {
    if (effect.name === 'upsertCachedSessions' || effect.name === 'upsertSearchEntries') {
      return effect.args[0].map(row => {
        const stored = { ...row };
        if (effect.name === 'upsertCachedSessions') { delete stored.dailyMetrics; delete stored.textContent; }
        return { name: effect.name, args: [[stored]] };
      });
    }
    if (effect.name === 'replaceSessionMetrics') return [{ name: effect.name, args: [effect.args[0], []] },
      ...(effect.args[1] || []).map(row => ({ name: 'appendSessionMetrics', args: [effect.args[0], [row]] }))];
    return [effect];
  });
}

function effectBatches(effects) {
  const batches = [];
  let batch = [], bytes = 0;
  for (const effect of boundedEffects(normalizeEffects(effects))) {
    const size = Buffer.byteLength(JSON.stringify(effect));
    if (size > 128 * 1024) throw new Error('index effect exceeds 128 KiB: ' + effect.name);
    if (batch.length === 50 || bytes + size > 128 * 1024) { batches.push({ effects: batch, bytes }); batch = []; bytes = 0; }
    batch.push(effect); bytes += size;
  }
  if (batch.length) batches.push({ effects: batch, bytes });
  return batches;
}

module.exports = { boundedEffects, effectBatches };
