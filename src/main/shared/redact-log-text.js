'use strict';

function redactLogText(value) {
  return value
    .replace(/\b(Bearer\s+)[^\s,;"']+/gi, '$1[REDACTED]')
    .replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization)["']?\s*[:=]\s*)(?:"[^"\r\n]*(?:"|$)|'[^'\r\n]*(?:'|$)|[^\s,;&]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[a-zA-Z0-9_-]+|gh[pousr]_[a-zA-Z0-9_]+|github_pat_[a-zA-Z0-9_]+)\b/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

module.exports = { redactLogText };
