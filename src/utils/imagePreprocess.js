const sharp = require("sharp");

const preprocessImage = async (buffer) => {
  return await sharp(buffer)
    .grayscale()         // remove colors
    .normalize()         // improve contrast
    .sharpen()           // enhance text clarity
    .toFormat("png")     // ensure OCR-friendly format
    .toBuffer();
};

module.exports = { preprocessImage };