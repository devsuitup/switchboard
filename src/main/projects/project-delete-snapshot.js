'use strict';

const { fail } = require('./project-delete-identity');

const sections = new Set(['sessions', 'folders', 'metadata', 'fields', 'settings', 'fences', 'operations']);

function createProjectDeleteSnapshot(readPage, revision) {
  function read(input = {}) {
    const { section = 'sessions', cursor = null, expectedRevision, limit = 256, maxBytes = 1048576 } = input;
    if (!sections.has(section) || (cursor !== null && typeof cursor !== 'string')
      || !Number.isInteger(limit) || limit < 1 || limit > 1000
      || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 8388608
      || (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0))) {
      throw fail('DISCOVERY_LIMIT', 'Invalid bounded snapshot page.');
    }
    const current = revision();
    if (expectedRevision !== undefined && current !== expectedRevision) throw fail('SNAPSHOT_STALE', 'Writer changed between inventory pages.');
    return { revision: current, ...readPage(section, cursor, limit, maxBytes) };
  }
  return { read, revision, operations: input => read({ ...input, section: 'operations' }) };
}

module.exports = { createProjectDeleteSnapshot };
