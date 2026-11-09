'use strict';

const WINDOWS_FILETIME_RE = /^\d{17,19}$/;
const PROC_START_TOLERANCE = 100n;
const abs = (n) => (n < 0n ? -n : n);

function toCreated(value) {
  if (value == null || value === '') return null;
  try { return BigInt(value); } catch { return null; }
}

function procStartMatches(created, procStart) {
  const value = toCreated(created);
  return value !== null && typeof procStart === 'string' && WINDOWS_FILETIME_RE.test(procStart)
    && abs(value - BigInt(procStart)) <= PROC_START_TOLERANCE;
}

module.exports = { procStartMatches, toCreated, WINDOWS_FILETIME_RE, PROC_START_TOLERANCE };
