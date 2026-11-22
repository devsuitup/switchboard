'use strict';

const theme = require('../../../public/theme');
const { STRIP_HEIGHT } = require('./window-frame');

function installWindowTheme({ ipcMain, nativeTheme, getSetting, getWindow, platform }) {
  const choice = () => theme.normalize(getSetting('global')?.theme);
  const colors = () => theme.colors(theme.resolve(choice(), nativeTheme.shouldUseDarkColors));
  const frameOptions = () => {
    const palette = colors();
    return platform === 'darwin' ? {} : { titleBarOverlay: { height: STRIP_HEIGHT, color: palette.color, symbolColor: palette.symbolColor } };
  };
  function refresh() {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    const palette = colors();
    win.setBackgroundColor(palette.background);
    if (platform !== 'darwin') win.setTitleBarOverlay({ color: palette.color, symbolColor: palette.symbolColor });
  }
  ipcMain.on('get-initial-theme', event => { event.returnValue = choice(); });
  nativeTheme.on('updated', refresh);
  return { colors, frameOptions, refresh };
}

module.exports = { installWindowTheme };
