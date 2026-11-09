function createPowerLog({ powerMonitor, logger }) {
  const write = event => logger.info(`[power] ${new Date().toISOString()} ${event}`);
  for (const event of ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'on-ac', 'on-battery']) {
    powerMonitor.on(event, () => write(event));
  }
  return {
    observeWindow(window) {
      for (const event of ['unresponsive', 'responsive']) window.on(event, () => write(event));
    },
    rendererGap(record) {
      if (!record || !Number.isSafeInteger(record.gapMs) || record.gapMs < 0 || !Array.isArray(record.sessions)) return;
      const sessions = record.sessions.slice(0, 20).filter(s => s && typeof s.id === 'string'
        && Number.isSafeInteger(s.chunks) && s.chunks >= 0 && Number.isSafeInteger(s.chars) && s.chars >= 0);
      const detail = sessions.map(s => `${s.id.slice(0, 8).replace(/[^a-zA-Z0-9_-]/g, '_')}:chunks=${s.chunks},chars=${s.chars}`).join(' ');
      const omitted = Number.isSafeInteger(record.omitted) && record.omitted >= 0 ? record.omitted : 0;
      write(`renderer-gap gapMs=${record.gapMs} ${detail} omitted=${omitted + Math.max(0, record.sessions.length - 20)}`);
    },
  };
}

module.exports = { createPowerLog };
