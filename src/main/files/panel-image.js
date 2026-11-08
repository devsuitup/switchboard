'use strict';

const SYSTEM_VIEWER_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.pdf']);

function sniffPanelImage(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const gif = buf.subarray(0, 6).toString('latin1');
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length >= 18 && buf[0] === 0x42 && buf[1] === 0x4d
    && buf.readUInt32LE(6) === 0 && [12, 40, 56, 108, 124].includes(buf.readUInt32LE(14))) return 'image/bmp';
  return null;
}

module.exports = { sniffPanelImage, SYSTEM_VIEWER_EXTENSIONS };
