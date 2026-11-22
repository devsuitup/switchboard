'use strict';

(() => {
  const defaults = typeof module !== 'undefined' && module.exports
    ? require('./setting-defaults').SETTING_DEFAULTS : SETTING_DEFAULTS;
  const choices = typeof module !== 'undefined' && module.exports
    ? require('./setting-defaults').THEME_CHOICES : THEME_CHOICES;
  const normalize = value => choices.some(([key]) => key === value) ? value : defaults.theme;
  const resolve = (value, osDark) => normalize(value) === 'system' ? (osDark ? 'dark' : 'light') : normalize(value);
  const colors = theme => theme === 'light'
    ? { background: '#ffffff', color: '#f3f3f7', symbolColor: '#5f5f74' }
    : { background: '#111118', color: '#18181f', symbolColor: '#9090a8' };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { normalize, resolve, colors };
    return;
  }
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let choice = normalize(window.api.getInitialTheme());
  function apply(value) {
    choice = normalize(value);
    const theme = resolve(choice, media.matches);
    if (document.documentElement.dataset.theme === theme) return;
    document.documentElement.dataset.theme = theme;
    window.dispatchEvent(new CustomEvent('app-theme-changed', { detail: theme }));
  }
  window.appTheme = { apply };
  media.addEventListener('change', () => apply(choice));
  apply(choice);
})();
