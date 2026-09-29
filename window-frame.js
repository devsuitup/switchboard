'use strict';

// see .ai/contexts/window-frame.md

const STRIP_HEIGHT = 32;
const STRIP_COLOR = '#18181f';
const STRIP_SYMBOL_COLOR = '#9090a8';
const TRAFFIC_LIGHT_POSITION = { x: 12, y: 9 };

const KEYBOARD_ROLES = Object.freeze([
  'undo',
  'redo',
  'cut',
  'copy',
  'paste',
  'selectAll',
  'resetZoom',
  'zoomIn',
  'zoomOut',
  'toggleDevTools',
  'togglefullscreen',
]);

function windowFrameOptions(platform) {
  if (platform === 'darwin') {
    return { titleBarStyle: 'hidden', trafficLightPosition: { ...TRAFFIC_LIGHT_POSITION } };
  }
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: STRIP_COLOR, symbolColor: STRIP_SYMBOL_COLOR, height: STRIP_HEIGHT },
  };
}

function applicationMenuTemplate(appName) {
  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
}

// see .ai/contexts/window-frame.md ("Zoom keys")
const ZOOM_STEP = 0.5;
const ZOOM_MIN_LEVEL = -7.5;
const ZOOM_MAX_LEVEL = 8.5;

function zoomKey(input, platform) {
  if (!input || input.type !== 'keyDown' || input.alt) return null;
  if (!(platform === 'darwin' ? input.meta : input.control)) return null;
  if (input.key === '+' || input.key === '=' || input.code === 'NumpadAdd') return 'in';
  if (input.key === '-' || input.code === 'NumpadSubtract') return 'out';
  if (input.key === '0' || (input.code === 'Digit0' && !input.shift) || input.code === 'Numpad0') return 'reset';
  return null;
}

function nextZoomLevel(level, direction) {
  if (direction === 'reset') return 0;
  const next = level + (direction === 'in' ? ZOOM_STEP : -ZOOM_STEP);
  return Math.min(ZOOM_MAX_LEVEL, Math.max(ZOOM_MIN_LEVEL, next));
}

function menuPopupPoint(position, zoomFactor) {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const coord = (v) => {
    const n = Math.round(Number(v) * zoom);
    return Number.isFinite(n) ? n : 0;
  };
  return { x: coord(position && position.x), y: coord(position && position.y) };
}

module.exports = {
  STRIP_HEIGHT,
  zoomKey,
  nextZoomLevel,
  ZOOM_MIN_LEVEL,
  ZOOM_MAX_LEVEL,
  menuPopupPoint,
  KEYBOARD_ROLES,
  windowFrameOptions,
  applicationMenuTemplate,
};
