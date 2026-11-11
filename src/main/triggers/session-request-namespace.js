'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { hashSessionRequestCommand } = require('../../../session-index-commands');
const { isVersioned, validateTrigger } = require('./trigger-actions');
const { readRequestFile, hash } = require('./session-request-publication');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const canonical = (value, key) => Array.isArray(value) ? '[' + value.map(part => canonical(part)).join(',')
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k], k)).join(',') + '}'
    : JSON.stringify(typeof value === 'string' && ['sessionId', 'requestId', 'from'].includes(key) && uuid.test(value) ? value.toLowerCase()
      : typeof value === 'string' && ['projectPath', 'project'].includes(key) && path.isAbsolute(value) ? path.normalize(value) : value);

function createSessionRequestNamespace({ fs, journal, publisher, actions, processedDir }) {
  async function command(name, input) {
    input = { ...input, actionToken: randomUUID() };
    return journal[name]({ ...input, argsHash: hashSessionRequestCommand(name, input) });
  }
  async function begin(stem, input) {
    if (!journal) throw new Error('request journal is unavailable');
    const stemKey = stem.toLowerCase();
    let outcome = await journal.querySessionRequestOutcome({ stemKey });
    let opened;
    try { opened = readRequestFile(fs, input); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let trigger, family = 'legacy', suppliedHash = null;
    if (opened?.bytes) {
      try { trigger = JSON.parse(opened.bytes.toString('utf8')); }
      catch {
        await new Promise(resolve => setTimeout(resolve, 50));
        opened = readRequestFile(fs, input);
        if (opened.bytes) { try { trigger = JSON.parse(opened.bytes.toString('utf8')); } catch {} }
      }
      if (isVersioned(trigger)) family = 'action';
      const valid = trigger && typeof trigger === 'object' && !Array.isArray(trigger)
        && (family === 'action' ? !validateTrigger(trigger, stem) : typeof trigger.sessionId === 'string' && !!trigger.sessionId);
      if (valid) suppliedHash = hash(Buffer.from(family + ':' + canonical(trigger)));
    }
    const actualStem = family === 'action' ? stemKey : stem;
    const identity = { stemKey, actualStem, family, suppliedHash, rawHash: opened?.rawHash ?? null };
    const resultFile = owner => path.join(processedDir, owner.actualStem + '.result.json');
    const marker = path.join(processedDir, stemKey + '.action.json');
    const entries = outcome.state === 'absent' ? fs.readdirSync(processedDir) : [];
    const results = entries.filter(name => name.toLowerCase() === stemKey + '.result.json');
    const markers = entries.filter(name => name.toLowerCase() === stemKey + '.action.json');
    if (outcome.state === 'absent' && (results.length || markers.length)) {
      if (results.length > 1 || markers.length > 1) throw new Error('ambiguous pre-upgrade result namespace');
      let bytes, priorFamily, priorStem;
      if (results.length) {
        const prior = readRequestFile(fs, path.join(processedDir, results[0]), { captureLimit: 16 * 1024 * 1024 });
        if (!prior.bytes) throw new Error('pre-upgrade result too large');
        bytes = prior.bytes; priorStem = results[0].slice(0, -12);
        let envelope; try { envelope = JSON.parse(bytes.toString('utf8')); } catch {}
        priorFamily = envelope?.version === 1 && ['open', 'stop'].includes(envelope.action) && !Object.hasOwn(envelope, 'type') ? 'action' : 'legacy';
      } else {
        const state = actions.readState(path.join(processedDir, stemKey + '.result.json'), path.join(processedDir, markers[0]));
        if (!state) throw new Error('pre-upgrade marker identity unavailable');
        bytes = Buffer.from(JSON.stringify(state.result) + '\n'); priorFamily = 'action'; priorStem = stemKey;
      }
      outcome = await command('claimSessionResultNamespace', { stemKey, actualStem: priorStem, family: priorFamily,
        suppliedHash: null, rawHash: null, resultBytes: bytes });
      if (!results.length) publisher.publish(resultFile(outcome.owner), outcome.owner.resultBytes);
      if (!opened) { publisher.cleanup(input, null, markers.length ? path.join(processedDir, markers[0]) : null); return { done: true }; }
    }
    if (!opened) {
      if (outcome.state !== 'absent' && outcome.owner.family === 'action' && fs.existsSync(marker)) {
        if (outcome.owner.resultBytes) {
          publisher.publish(resultFile(outcome.owner), Buffer.from(outcome.owner.resultBytes));
        } else {
          const state = actions.readState(resultFile(outcome.owner), marker);
          if (!state) throw new Error('pending action recovery state unavailable');
          const completed = await command('recordSessionResultPublication', { stemKey, actualStem: outcome.owner.actualStem,
            family: 'action', suppliedHash: outcome.owner.suppliedHash, rawHash: outcome.owner.rawHash,
            resultBytes: Buffer.from(JSON.stringify(state.result) + '\n') });
          publisher.publish(resultFile(completed.owner), Buffer.from(completed.owner.resultBytes));
          publisher.cleanup(input, null, marker);
        }
      }
      return { done: true };
    }
    if (outcome.state !== 'absent') outcome = await journal.querySessionRequestOutcome({ stemKey, suppliedHash, rawHash: opened.rawHash });
    if (outcome.state === 'conflict' || (outcome.owner && outcome.owner.family !== family)) {
      const conflict = outcome.conflict || (await command('recordSessionRequestConflict', {
        stemKey, actualStem: stem, rawHash: opened.rawHash,
        resultBytes: Buffer.from(JSON.stringify({ ok: false, error: 'request id conflict', reason: 'request id conflict', submitted: 'no' }) + '\n'),
      })).conflict;
      if (outcome.owner.resultBytes && !fs.existsSync(resultFile(outcome.owner))) {
        publisher.publish(resultFile(outcome.owner), Buffer.from(outcome.owner.resultBytes));
      }
      const base = path.join(processedDir, conflict.actualStem + '.conflict-' + conflict.rawHash);
      publisher.publish(base + '.result.json', Buffer.from(conflict.resultBytes));
      publisher.archive(input, base + '.request', opened.rawHash);
      return { done: true };
    }
    if (outcome.state === 'completed') {
      publisher.publish(resultFile(outcome.owner), Buffer.from(outcome.owner.resultBytes));
      publisher.cleanup(input, opened.rawHash, outcome.owner.family === 'action' ? marker : null);
      return { done: true };
    }
    const wasPending = outcome.state === 'pending';
    if (outcome.state === 'absent') {
      outcome = await command('claimSessionResultNamespace', identity);
      if (outcome.state !== 'pending') throw new Error('request namespace claim changed');
    }
    async function publish(result, finalize) {
      if (finalize) {
        await journal.querySessionRequestOutcome({ stemKey });
        result = finalize(result);
      }
      const completed = await command('recordSessionResultPublication', { ...identity, resultBytes: Buffer.from(JSON.stringify(result) + '\n') });
      if (completed.state !== 'completed') throw new Error('request publication ownership changed');
      publisher.publish(resultFile(completed.owner), Buffer.from(completed.owner.resultBytes));
      publisher.cleanup(input, opened.rawHash, family === 'action' ? marker : null);
    }
    if (wasPending) {
      if (family === 'action') {
        const state = actions.readState(resultFile(outcome.owner), marker);
        await publish(state?.result || actions.refusal(trigger, 'interrupted by restart', { uncertain: true }));
      } else await publish({ ok: false, submitted: 'no', wrote: true, steps_total: 0,
        error: 'interrupted by restart', reason: 'an earlier attempt may have executed; no automatic retry was performed', uncertain: true });
      return { done: true };
    }
    return { done: false, opened, trigger, family, publish };
  }
  return { begin };
}

module.exports = { createSessionRequestNamespace };
