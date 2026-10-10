'use strict';

function bridgeSessionKey(id) {
  if (typeof id !== 'string') return null;
  const match = /^(?:cse_|session_)(.+)$/.exec(id);
  return match ? match[1] : null;
}

module.exports = { bridgeSessionKey };
