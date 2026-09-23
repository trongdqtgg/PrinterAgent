'use strict';

const { PNG } = require('pngjs');

/**
 * ZKFPM_AcquireFingerprint tra ve anh grayscale tho (1 byte / pixel).
 * Ham nay chuyen thanh PNG (grayscale) roi encode base64, dung cho RESULT
 * cua API /api/finger/send-scan (dinh dang "base64 anh van tay.png").
 */
function rawGrayscaleToPngBase64({ raw, width, height }) {
  const png = new PNG({ width, height, colorType: 0 }); // colorType 0 = grayscale

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcIdx = y * width + x;
      const dstIdx = (width * y + x) << 2;
      const gray = raw[srcIdx] || 0;
      png.data[dstIdx] = gray;
      png.data[dstIdx + 1] = gray;
      png.data[dstIdx + 2] = gray;
      png.data[dstIdx + 3] = 255;
    }
  }

  const buffer = PNG.sync.write(png);
  return buffer.toString('base64');
}

module.exports = { rawGrayscaleToPngBase64 };
