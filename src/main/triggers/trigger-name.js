// trigger-name.js — see .ai/contexts/trigger-watcher.md, "Naming a new session"
'use strict';

const NAME_VERSION = 1;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const hasLoneSurrogate = name => LONE_SURROGATE.test(name);

function requestedNameFields(trigger) {
  return typeof trigger?.new?.name === 'string' ? { requestedName: trigger.new.name.trim(), actualName: null } : {};
}

function markerNaming(name) {
  return { nameVersion: NAME_VERSION, requestedName: name };
}

function recoveredNaming(marker) {
  const name = marker.requestedName;
  const valid = marker.action === 'open' && marker.mode === 'new' && marker.nameVersion === NAME_VERSION
    && typeof name === 'string' && name !== '' && name === name.trim() && name.length <= 256
    && !/[\x00-\x1f\x7f]/.test(name) && !hasLoneSurrogate(name);
  return valid ? { requestedName: name, actualName: null } : {};
}

module.exports = { hasLoneSurrogate, requestedNameFields, markerNaming, recoveredNaming };
