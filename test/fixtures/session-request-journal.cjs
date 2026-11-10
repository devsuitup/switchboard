'use strict';
const { createWriterCommands } = require('../../session-index-commands');
const { commitTransaction } = require('../../src/main/projects/project-delete-progress');

function createJournal(db) {
  if (!db) {
    const owners = new Map(), receipts = new Map(), settings = new Map();
    let changes = 0;
    db = { getSetting: key => settings.get(key), setSetting(key, value) { settings.set(key, value); changes++; },
      changeCount: () => changes,
      transact(fn) {
        const saved = [new Map(owners), new Map(receipts), new Map(settings), changes];
        try { return fn(); } catch (error) {
          for (const [map, old] of [[owners, saved[0]], [receipts, saved[1]], [settings, saved[2]]]) {
            map.clear(); for (const entry of old) map.set(...entry);
          }
          changes = saved[3]; throw error;
        }
      },
      sessionRequests: { available: () => true, get: key => owners.get(key) || null,
        receipt: (key, token) => receipts.get(key + ':' + token) || null,
        conflict: (key, hash) => [...receipts.values()].find(r => r.domainId === key && r.command === 'recordSessionRequestConflict' && r.rawHash === hash)?.outcomeJson || null,
        insert(row) { owners.set(row.stemKey, row); changes++; },
        publish(row) { owners.set(row.stemKey, row); changes++; },
        addReceipt(row) { receipts.set(row.domainId + ':' + row.actionToken, row); changes++; },
      },
    };
  }
  const commands = createWriterCommands(db), ports = {};
  for (const name of ['querySessionRequestOutcome', 'recordConsumedSessionStatusRequest', 'recordSessionRequestConflict',
    'claimSessionResultNamespace', 'recordSessionResultPublication']) {
    ports[name] = async input => name === 'querySessionRequestOutcome' ? commands[name](input)
      : commitTransaction(db, () => commands[name](input)).result;
  }
  return ports;
}
module.exports = { createJournal };
