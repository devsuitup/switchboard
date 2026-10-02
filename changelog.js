'use strict';

// see docs/changelog.md

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;
const VERSION_BEFORE_WHATS_NEW = '0.0.84';
const VERSION_HEADING_RE =/^## v(\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})$/;

function parseVersion(value) {
  const m = typeof value === 'string' ? VERSION_RE.exec(value) : null;
  if (!m) throw new TypeError(`not a version: ${String(value)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isVersion(value) {
  return typeof value === 'string' && VERSION_RE.test(value);
}

function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}

function parseChangelog(text) {
  let unreleased = null;
  const versions = [];
  let current = null;
  const close = () => {
    if (!current) return;
    const body = current.lines.join('\n').trim();
    if (current.version) versions.push({ version: current.version, date: current.date, body });
    else unreleased = body;
    current = null;
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      close();
      if (line === '## Unreleased') {
        current = { lines: [] };
        continue;
      }
      const m = VERSION_HEADING_RE.exec(line);
      if (!m) throw new Error(`malformed heading: ${line}`);
      current = { version: m[1], date: m[2], lines: [] };
    } else if (line.trim() === '---') {
      close();
    } else if (current) {
      current.lines.push(line);
    }
  }
  close();
  if (versions.length === 0) throw new Error('no version section in the changelog');
  return { unreleased, versions };
}

function sectionsBetween(versions, after, upTo) {
  return versions
    .filter((v) => compareVersions(v.version, after) > 0 && compareVersions(v.version, upTo) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
}

function readSections(readChangelog) {
  try {
    return { versions: parseChangelog(readChangelog()).versions, error: null };
  } catch (err) {
    return { versions: null, error: err.message };
  }
}

function whatsNewOnStartup({ currentVersion, lastSeenVersion, existingInstall, readChangelog }) {
  if (!isVersion(lastSeenVersion)) {
    if (!existingInstall) return { sections: null, record: currentVersion, error: null };
    lastSeenVersion = VERSION_BEFORE_WHATS_NEW;
  }
  if (compareVersions(currentVersion, lastSeenVersion) <= 0) return { sections: null, record: null, error: null };
  const { versions, error } = readSections(readChangelog);
  if (error) return { sections: null, record: null, error };
  const sections = sectionsBetween(versions, lastSeenVersion, currentVersion);
  if (sections.length === 0) return { sections: null, record: currentVersion, error: null };
  return { sections, record: null, error: null };
}

function whatsNewForVersion({ currentVersion, readChangelog }) {
  const { versions, error } = readSections(readChangelog);
  if (error) return { sections: null, error };
  const section = versions.find((v) => compareVersions(v.version, currentVersion) === 0);
  if (!section) return { sections: null, error: `no section for ${currentVersion} in the changelog` };
  return { sections: [section], error: null };
}

function createWhatsNew({ getSetting, setSetting, currentVersion, existingInstall, lastSeenDefault, readChangelog, log }) {
  const record = (version) => {
    const global = getSetting('global') || {};
    global.lastSeenVersion = version;
    setSetting('global', global);
  };
  return {
    startup() {
      const lastSeenVersion = (getSetting('global') || {}).lastSeenVersion ?? lastSeenDefault;
      const result = whatsNewOnStartup({ currentVersion, lastSeenVersion, existingInstall, readChangelog });
      if (result.error) log.warn(`[whats-new] ${result.error}`);
      if (result.record) record(result.record);
      return result.sections ? { version: currentVersion, sections: result.sections } : null;
    },
    dismissed() {
      record(currentVersion);
    },
    forMenu() {
      const { sections, error } = whatsNewForVersion({ currentVersion, readChangelog });
      if (error) {
        log.warn(`[whats-new] ${error}`);
        return null;
      }
      return { version: currentVersion, sections };
    },
  };
}

module.exports = {
  VERSION_BEFORE_WHATS_NEW,
  compareVersions,
  parseChangelog,
  sectionsBetween,
  whatsNewOnStartup,
  whatsNewForVersion,
  createWhatsNew,
};
