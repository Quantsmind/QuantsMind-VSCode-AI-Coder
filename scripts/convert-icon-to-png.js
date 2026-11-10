/**
 * Convert QuantsMind SVG icon to PNG (128x128).
 * Renders SVG vector graphics to PNG using Node.js built-in modules.
 */
const fs = require('fs');
const zlib = require('zlib');

const WIDTH = 128;
const HEIGHT = 128;
const SCALE = WIDTH / 24; // SVG viewBox is 24x24

// Color: #C5C5C5 = RGB(197, 197, 197)
const R = 197, G = 197, B = 197;

const width = WIDTH;
const height = HEIGHT;
const buf = Buffer.alloc(width * height * 4, 0); // RGBA, all transparent

function setPixel(x, y, r, g, b, a) {
  const idx = (y * width + x) * 4;
  buf[idx] = r;
  buf[idx + 1] = g;
  buf[idx + 2] = b;
  buf[idx + 3] = a;
}

function drawCircle(cx, cy, r, fill, stroke, strokeWidth) {
  const rScaled = r * SCALE;
  const cxScaled = cx * SCALE;
  const cyScaled = cy * SCALE;
  const strokeWidthScaled = strokeWidth * SCALE;
  
  const xMin = Math.max(0, Math.floor(cxScaled - rScaled - strokeWidthScaled));
  const xMax = Math.min(width - 1, Math.ceil(cxScaled + rScaled + strokeWidthScaled));
  const yMin = Math.max(0, Math.floor(cyScaled - rScaled - strokeWidthScaled));
  const yMax = Math.min(height - 1, Math.ceil(cyScaled + rScaled + strokeWidthScaled));
  
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      const dx = x - cxScaled;
      const dy = y - cyScaled;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      let set = false;
      if (fill && dist <= rScaled) set = true;
      if (stroke && strokeWidth > 0 && dist >= rScaled - strokeWidthScaled/2 && dist <= rScaled + strokeWidthScaled/2) set = true;
      if (set) setPixel(x, y, R, G, B, 255);
    }
  }
}

function drawLine(x1, y1, x2, y2, stroke, strokeWidth) {
  const x1s = x1 * SCALE;
  const y1s = y1 * SCALE;
  const x2s = x2 * SCALE;
  const y2s = y2 * SCALE;
  const sw = strokeWidth * SCALE;
  
  const steps = Math.max(Math.abs(x2s - x1s), Math.abs(y2s - y1s));
  if (steps === 0) {
    // Single point
    const cx = Math.round(x1s);
    const cy = Math.round(y1s);
    for (let oy = -Math.floor(sw/2); oy <= Math.floor(sw/2); oy++) {
      for (let ox = -Math.floor(sw/2); ox <= Math.floor(sw/2); ox++) {
        const px = cx + ox;
        const py = cy + oy;
        if (px >= 0 && px < width && py >= 0 && py < height) {
          setPixel(px, py, R, G, B, 255);
        }
      }
    }
    return;
  }
  
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x1s + (x2s - x1s) * t;
    const y = y1s + (y2s - y1s) * t;
    const cx = Math.round(x);
    const cy = Math.round(y);
    for (let oy = -Math.floor(sw/2); oy <= Math.floor(sw/2); oy++) {
      for (let ox = -Math.floor(sw/2); ox <= Math.floor(sw/2); ox++) {
        const px = cx + ox;
        const py = cy + oy;
        if (px >= 0 && px < width && py >= 0 && py < height) {
          setPixel(px, py, R, G, B, 255);
        }
      }
    }
  }
}

// Draw all elements from the SVG
drawCircle(11, 11, 7.5, null, true, 1.8);     // Outer circle
drawCircle(11, 11, 3, null, true, 1.8);       // Inner circle
drawLine(16.5, 16.5, 21, 21, true, 1.8);      // Diagonal line
drawCircle(19.5, 4.5, 1.7, true, null, 0);    // Small filled circle

// Build PNG CRC32
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 1) crc = (crc >>> 1) ^ 0xEDB88320;
      else crc = crc >>> 1;
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcVal = crc32(crcInput);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crcVal, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// Build PNG
const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

// IHDR chunk
const ihdrData = Buffer.alloc(13);
ihdrData.writeUInt32BE(width, 0);
ihdrData.writeUInt32BE(height, 4);
ihdrData[8] = 8;  // bit depth
ihdrData[9] = 6;  // color type: RGBA
ihdrData[10] = 0; // compression
ihdrData[11] = 0; // filter
ihdrData[12] = 0; // interlace
const ihdr = chunk('IHDR', ihdrData);

// IDAT chunk
const idatData = [];
for (let y = 0; y < height; y++) {
  idatData.push(0); // filter type: none
  for (let x = 0; x < width; x++) {
    const idx = (y * width + x) * 4;
    idatData.push(buf[idx], buf[idx + 1], buf[idx + 2], buf[idx + 3]);
  }
}
const idat = chunk('IDAT', zlib.deflateSync(Buffer.from(idatData)));

// IEND chunk
const iend = chunk('IEND', Buffer.alloc(0));

const png = Buffer.concat([signature, ihdr, idat, iend]);

fs.writeFileSync('media/icon.png', png);
console.log('Created media/icon.png (' + png.length + ' bytes)');