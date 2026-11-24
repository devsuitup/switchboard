'use strict';

module.exports = api => async (patch, remove = []) => {
  const next = { ...(await api.getSetting('global')), ...patch };
  for (const key of remove) delete next[key];
  return api.setSetting('global', next);
};
