'use strict';

function projectionScope(host, projectPath) {
  const text = JSON.stringify([host || null, projectPath]);
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ text.charCodeAt(i);
  }
  return 'scope-' + (a >>> 0).toString(16) + '-' + (b >>> 0).toString(16);
}

function createSessionProjectionDiagnostics({ emit } = {}) {
  let previous = new Map();
  const ids = values => [...new Set((values || []).map(id => String(id).toLowerCase()))].sort();
  const signature = row => ({ sessionId: row.sessionId.toLowerCase(), headSessionId: row.headSessionId.toLowerCase(),
    memberIds: ids(row.memberIds), background: row.background ? { jobId: row.background.jobId.toLowerCase(), sessionId: row.background.sessionId.toLowerCase() } : null,
    activity: Object.fromEntries(['source', 'jobId', 'valid', 'state', 'hosted', 'attached', 'foreground'].map(k => [k,
      k === 'jobId' ? row.activity?.jobId?.toLowerCase() || null : row.activity?.[k] ?? null])),
    visibleInDefault: !!row.visibleInDefault });
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const boundList = (object, key) => {
    if (!Array.isArray(object?.[key])) return;
    object[key + 'Count'] = object[key].length;
    object[key + 'Truncated'] = object[key].length > 128;
    object[key] = object[key].slice(0, 128);
  };
  const size = record => {
    const text = JSON.stringify(record);
    return typeof Buffer !== 'undefined' ? Buffer.byteLength(text, 'utf8') : new TextEncoder().encode(text).length;
  };
  function publish(record) {
    try {
      const bounded = JSON.parse(JSON.stringify(record));
      for (const sig of [bounded.previous, bounded.next]) boundList(sig, 'memberIds');
      for (const inputs of [bounded.inputs, bounded.priorInputs]) {
        boundList(inputs, 'descriptors');
        boundList(inputs?.proof, 'partIds');
      }
      if (size(bounded) > 64000) {
        bounded.compacted = true;
        for (const sig of [bounded.previous, bounded.next]) if (sig) { sig.memberIds = []; sig.memberIdsTruncated = sig.memberIdsCount > 0; }
        for (const inputs of [bounded.inputs, bounded.priorInputs]) if (inputs) {
          if (inputs.descriptors) { inputs.descriptors = []; inputs.descriptorsTruncated = inputs.descriptorsCount > 0; }
          if (inputs.proof?.partIds) { inputs.proof.partIds = []; inputs.proof.partIdsTruncated = inputs.proof.partIdsCount > 0; }
        }
      }
      if (validateSessionProjectionRecord(bounded)) emit?.(bounded);
    } catch {}
  }
  function observe({ generation = 0, rosterRevision = 0, cause = 'projects', rows = [], removedInputs = {} } = {}) {
    try {
      const current = new Map();
      const oldMembers = new Set([...previous.values()].flatMap(value => value.signature.memberIds.map(id => value.row.scope + '|' + id)));
      for (const row of rows) {
        const id = row.scope + '|' + row.rootId;
        const next = signature(row), prior = previous.get(id), changes = [];
        if (!prior) {
          if (oldMembers.has(row.scope + '|' + row.rootId)) changes.push('merge-membership');
          else if (next.background || next.memberIds.length > 1 || row.activity?.jobId || row.activity?.source === 'unavailable') changes.push('initial');
        } else {
          const before = prior.signature;
          if (!equal(before.background, next.background)) changes.push('background-membership');
          if (!equal(before.memberIds, next.memberIds)) changes.push('merge-membership');
          if (before.sessionId !== next.sessionId) changes.push('representative');
          if (before.headSessionId !== next.headSessionId) changes.push('head');
          if (!equal(before.activity, next.activity)) changes.push('activity-source');
          if (before.visibleInDefault !== next.visibleInDefault) changes.push('visibility');
        }
        if (changes.length) publish({ schema: 1, generation, projectsBuildId: row.inputs?.projectsBuildId ?? null, rosterRevision,
          cause, scope: row.scope, rootId: row.rootId, sessionId: row.sessionId, headSessionId: row.headSessionId,
          changes, previous: prior?.signature || null, next, inputs: row.inputs });
        current.set(id, { row: JSON.parse(JSON.stringify(row)), signature: next });
      }
      for (const [id, prior] of previous) {
        if (current.has(id)) continue;
        let inputs = removedInputs[id];
        if (!inputs) {
          const absorbed = [...current.values()].find(value => value.row.scope === prior.row.scope && value.signature.memberIds.includes(prior.row.rootId));
          if (absorbed) inputs = { ...absorbed.row.inputs, proof: { ...absorbed.row.inputs?.proof, reason: 'absorbed' } };
        }
        publish({ schema: 1, generation, projectsBuildId: inputs?.projectsBuildId ?? null, rosterRevision, cause,
          scope: prior.row.scope, rootId: prior.row.rootId, sessionId: prior.row.sessionId, headSessionId: prior.row.headSessionId,
          changes: ['removed'], previous: prior.signature, next: null,
          inputs: inputs || { proof: { kind: 'unknown', rootId: prior.row.rootId, partIds: [], valid: false, reason: 'not-observed-in-current-projection' }, filterReason: null },
          ...(inputs ? {} : { priorInputs: prior.row.inputs }) });
      }
      previous = current;
    } catch {}
  }
  return { observe };
}

function validateSessionProjectionRecord(record) {
  const token = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
  const number = value => value === null || Number.isFinite(value) && value >= 0;
  const nullableToken = value => value === null || token(value);
  const object = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k));
  const list = value => Array.isArray(value) && value.length <= 128 && value.every(token);
  const counts = value => ['memberIdsCount', 'partIdsCount', 'descriptorsCount'].every(k => value[k] === undefined || number(value[k]))
    && ['memberIdsTruncated', 'partIdsTruncated', 'descriptorsTruncated'].every(k => value[k] === undefined || typeof value[k] === 'boolean');
  const identity = value => value === null || object(value, ['jobId', 'sessionId']) && token(value.jobId) && token(value.sessionId);
  const activity = value => object(value, ['source', 'jobId', 'valid', 'state', 'hosted', 'attached', 'foreground'])
    && ['job-valid', 'job-invalid', 'foreground', 'unavailable', 'none'].includes(value.source)
    && nullableToken(value.jobId) && (typeof value.valid === 'boolean' || value.valid === null) && nullableToken(value.state)
    && ['hosted', 'attached', 'foreground'].every(k => typeof value[k] === 'boolean' || value[k] === null);
  const signature = value => value === null || object(value, ['sessionId', 'headSessionId', 'memberIds', 'memberIdsCount', 'memberIdsTruncated', 'background', 'activity', 'visibleInDefault'])
    && token(value.sessionId) && token(value.headSessionId) && list(value.memberIds) && counts(value)
    && identity(value.background) && activity(value.activity) && typeof value.visibleInDefault === 'boolean';
  const inputs = value => {
    if (!object(value, ['projectsBuildId', 'cli', 'cliEntryCount', 'cachedJob', 'jobState', 'jobEvidenceValid', 'jobEvidenceAt',
      'descriptors', 'descriptorsCount', 'descriptorsTruncated', 'attach', 'proof', 'filterReason']) || !counts(value)) return false;
    if (value.projectsBuildId !== undefined && !number(value.projectsBuildId)) return false;
    if (value.cli !== undefined && !['included', 'omitted', 'unavailable'].includes(value.cli)) return false;
    if (value.cliEntryCount !== undefined && !number(value.cliEntryCount)) return false;
    if (value.cachedJob !== undefined && typeof value.cachedJob !== 'boolean') return false;
    if (value.jobState !== undefined && !nullableToken(value.jobState)) return false;
    if (value.jobEvidenceValid !== undefined && typeof value.jobEvidenceValid !== 'boolean') return false;
    if (value.jobEvidenceAt !== undefined && !number(value.jobEvidenceAt)) return false;
    if (value.filterReason !== undefined && value.filterReason !== null && !['hidden-project', 'archived', 'sdk-only'].includes(value.filterReason)) return false;
    const proof = value.proof;
    if (proof !== undefined && (!object(proof, ['kind', 'rootId', 'partIds', 'partIdsCount', 'partIdsTruncated', 'valid', 'reason'])
      || !token(proof.kind) || !token(proof.rootId) || !list(proof.partIds) || !counts(proof) || typeof proof.valid !== 'boolean' || !nullableToken(proof.reason))) return false;
    const attach = value.attach;
    if (attach !== undefined && attach !== null && (!object(attach, ['sessionId', 'jobId', 'exited', 'host'])
      || !token(attach.sessionId) || !token(attach.jobId) || typeof attach.exited !== 'boolean' || !nullableToken(attach.host))) return false;
    if (value.descriptors !== undefined && (!Array.isArray(value.descriptors) || value.descriptors.length > 128
      || !value.descriptors.every(d => object(d, ['sessionId', 'jobId', 'kind', 'pid']) && token(d.sessionId)
        && nullableToken(d.jobId) && token(d.kind) && (d.pid === null || Number.isInteger(d.pid) && d.pid > 0)))) return false;
    return true;
  };
  try {
    if (!object(record, ['schema', 'generation', 'projectsBuildId', 'rosterRevision', 'cause', 'scope', 'rootId', 'sessionId', 'headSessionId', 'changes', 'previous', 'next', 'inputs', 'priorInputs', 'compacted'])) return false;
    if (record.compacted !== undefined && typeof record.compacted !== 'boolean') return false;
    if (record.schema !== 1 || !number(record.generation) || !number(record.rosterRevision) || !number(record.projectsBuildId)
      || !token(record.cause) || !['scope', 'rootId', 'sessionId', 'headSessionId'].every(k => token(record[k]))) return false;
    if (!Array.isArray(record.changes) || !record.changes.length || record.changes.length > 8
      || !record.changes.every(k => ['initial', 'background-membership', 'merge-membership', 'representative', 'head', 'activity-source', 'visibility', 'removed'].includes(k))) return false;
    if (!signature(record.previous) || !signature(record.next) || !inputs(record.inputs) || record.priorInputs && !inputs(record.priorInputs)) return false;
    const text = JSON.stringify(record);
    return (typeof Buffer !== 'undefined' ? Buffer.byteLength(text) : new TextEncoder().encode(text).length) <= 65000;
  } catch { return false; }
}

if (typeof module !== 'undefined') module.exports = { createSessionProjectionDiagnostics, validateSessionProjectionRecord, projectionScope };
if (typeof window !== 'undefined') window.SessionProjectionDiagnostics = { createSessionProjectionDiagnostics, validateSessionProjectionRecord, projectionScope };
