const fs = require('fs');
const { enumerateSessionFiles } = require('./read-session-file');

/**
 * Atomically rewrite cwd occurrences of oldPath → newPath in a single JSONL
 * file. Uses a .tmp sibling + rename for crash safety. On any failure the .tmp
 * orphan is cleaned up so it cannot block a future remap attempt.
 */
function rewriteJsonlAtomic(filePath, oldPath, newPath) {
  const tmp = filePath + '.tmp';
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const updated = content.split('\n').map(line => {
      if (!line) return line;
      try {
        const parsed = JSON.parse(line);
        if (parsed.cwd === oldPath) {
          parsed.cwd = newPath;
          return JSON.stringify(parsed);
        }
      } catch {}
      return line;
    }).join('\n');
    fs.writeFileSync(tmp, updated);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

// see .ai/contexts/session-cache.md ("Transcript cwd trust")
function remapProjectTranscripts({ folder, folderPath, oldPath, newPath, getSetting, setSetting }) {
  const recorded = getSetting('projectRemaps');
  const remaps = recorded && typeof recorded === 'object' && !Array.isArray(recorded) ? recorded : {};
  setSetting('projectRemaps', { ...remaps, [folder]: newPath });
  for (const { filePath } of enumerateSessionFiles(folderPath)) {
    rewriteJsonlAtomic(filePath, oldPath, newPath);
  }
}

module.exports = { rewriteJsonlAtomic, remapProjectTranscripts };
