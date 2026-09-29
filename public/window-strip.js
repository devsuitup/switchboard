// see .ai/contexts/window-frame.md
'use strict';

function initWindowStrip(doc, api) {
  const body = doc.body;
  body.classList.add('window-frameless', 'platform-' + (api.platform || 'unknown'));
  api.onFullScreenChanged((isFullScreen) => {
    body.classList.toggle('window-full-screen', !!isFullScreen);
  });
  const menuBtn = doc.getElementById('app-menu-btn');
  if (menuBtn) {
    menuBtn.addEventListener('click', () => {
      const rect = menuBtn.getBoundingClientRect();
      api.popupAppMenu(rect.left, rect.bottom);
    });
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { initWindowStrip };
} else {
  initWindowStrip(document, window.api);
}
