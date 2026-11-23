'use strict';

function redactLogText(value) {
  return value
    .replace(/\b((?:Proxy-)?Authorization|(?:Set-)?Cookie)(\s*:\s*)[^\r\n]*/gi, '$1$2[REDACTED]')
    .replace(/\b(Bearer\s+)[^\s,;"']+/gi, '$1[REDACTED]')
    .replace(/(\b[A-Za-z0-9_]*(?:token|password|passwd|pass|secret|api[_-]?key|private[_-]?key|access[_-]?key|authorization)["']?\s*[:=]\s*)(?:"[^"\r\n]*(?:"|$)|'[^'\r\n]*(?:'|$)|[^\s,;&]+)/gi, '$1[REDACTED]')
    .replace(/([?&](?:sig|key|signature|code|auth|token|access_token)=)[^\s&#]*/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[a-zA-Z0-9_-]+|gh[pousr]_[a-zA-Z0-9_]+|github_pat_[a-zA-Z0-9_]+|xox[abprs]-[\w-]+|glpat-[\w-]+|AKIA[0-9A-Z]{16}|npm_[\w-]+)\b/g, '[REDACTED]')
    .replace(/\beyJ[\w.-]+/g, token => /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(token) ? '[REDACTED]' : token)
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

module.exports = { redactLogText };
