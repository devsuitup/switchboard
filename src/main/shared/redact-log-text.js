'use strict';

function redactFields(value) {
  const keys = /(?<![\w-])-{0,2}([A-Za-z_][\w-]*)(["']?[ \t]*[:=][ \t]*)/g;
  const credential = /(?:^|[_-])pass$|(?:token|password|passwd|secret|secret[_-]?key|password[_-]?hash|api[_-]?key|private[_-]?key|access[_-]?key|authorization)$/i;
  const camelCredential = /[a-z0-9](?:Token|Secret|SecretKey|Password|PasswordHash|Passwd|ApiKey|PrivateKey|AccessKey|Authorization)$/;
  const field = /"[^"\r\n]*"?|'[^'\r\n]*'?|[^\s,;&"'}]+/y;
  const queryValue = /[^\s&#"']+/y;
  const cookieValue = /"[^"\r\n]*"?|'[^'\r\n]*'?|[^\s;,"']+/y;
  const scheme = /(?:Bearer|Basic|Token)[ \t]+/iy;
  const cookie = /[ \t]*[!#$%&'*+.^_`|~\w-]+[ \t]*=[ \t]*/y;
  const separator = /[ \t]*;/y;
  const headerValue = /[^\r\n]+/y;
  const parts = [];
  let copied = 0;
  function mask(start, pattern = field) {
    pattern.lastIndex = start;
    if (!pattern.test(value)) return start;
    parts.push(value.slice(copied, start), '[REDACTED]');
    copied = pattern.lastIndex;
    return copied;
  }
  let key;
  while ((key = keys.exec(value))) {
    if (/^(?:Set-)?Cookie$/i.test(key[1])) {
      let cursor = keys.lastIndex;
      cookie.lastIndex = cursor;
      if (!cookie.test(value)) {
        keys.lastIndex = mask(cursor, /["']/.test(value[cursor] || '') ? field : headerValue);
        continue;
      }
      while (cursor < value.length) {
        cookie.lastIndex = cursor;
        if (!cookie.exec(value)) break;
        cursor = mask(cookie.lastIndex, cookieValue);
        keys.lastIndex = cursor;
        separator.lastIndex = cursor;
        if (!separator.exec(value)) break;
        cursor = separator.lastIndex;
      }
    } else if (credential.test(key[1]) || camelCredential.test(key[1]) || /^X-Amz-(?:Signature|Credential)$/i.test(key[1])) {
      let start = keys.lastIndex;
      if (/^(?:Proxy-)?Authorization$/i.test(key[1])) {
        scheme.lastIndex = start;
        if (scheme.exec(value)) start = scheme.lastIndex;
        else {
          keys.lastIndex = mask(start, /["']/.test(value[start] || '') ? field : headerValue);
          continue;
        }
      }
      keys.lastIndex = mask(start, /[?&]/.test(value[key.index - 1] || '') ? queryValue : field);
    }
  }
  parts.push(value.slice(copied));
  return parts.join('');
}

function redactLogText(value) {
  value = value.replace(/(?<![\w+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/?#"'<>]*/g, (url, scheme) => {
    const at = url.lastIndexOf('@');
    const colon = url.indexOf(':', scheme.length);
    return colon >= 0 && colon < at ? `${url.slice(0, colon + 1)}[REDACTED]${url.slice(at)}` : url;
  });
  return redactFields(value)
    .replace(/(?<![\w-])((?:--(?:token|api-key|password|auth-token)|Bearer)(?:[ \t]+|=))(?:"[^"\r\n]*"?|'[^'\r\n]*'?|[^\s,;"']+)/gi, '$1[REDACTED]')
    .replace(/([?&](?:sig|key|signature|code|auth|token|access_token)=)[^\s&#"']*/gi, '$1[REDACTED]')
    .replace(/(?<![\w-])sk-[A-Za-z0-9_-]+/g, token =>
      /^sk-(?:proj|ant|svcacct|admin|None|or)-/.test(token)
      || (/[0-9]/.test(token) && token.slice(3).split('-').some(part => part.length >= 20))
        ? '[REDACTED]' : token)
    .replace(/(?<![\w-])(?:gh[pousr]_[a-zA-Z0-9_]+|github_pat_[a-zA-Z0-9_]+|xox[abprs]-[\w-]+|glpat-[\w-]+|AKIA[0-9A-Z]{16}|npm_[\w-]+)\b/g, '[REDACTED]')
    .replace(/\beyJ[\w.-]+/g, token => /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(token) ? '[REDACTED]' : token);
}

module.exports = { redactLogText };
