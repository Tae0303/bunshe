// Draws the app icon — a white baht sign (฿) on teal — and writes every size the PWA needs:
//   icons/apple-touch-icon.png (iPhone home screen), icon-192.png, icon-512.png (Android, install),
//   icons/favicon.svg (browser tab, rounded corners).
// The ฿ is built from simple shapes, so it looks the same everywhere and needs no font.
// Run: npm run icons
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';

const TEAL = [15, 118, 110]; // #0f766e, the app's accent
const WHITE = [255, 255, 255];
const OUT = new URL('../icons/', import.meta.url);

// Geometry on a 512 × 512 canvas. Everything sits inside the central 80% circle,
// so Android can crop it to any shape ("maskable").
const G = {
  s: 44, // stroke width of the B
  x0: 180, // centre line of the B's stem
  top: 138, // centre line of the top stroke
  mid: 250, // centre line of the middle stroke
  bottom: 374, // centre line of the bottom stroke
  xc1: 266, // where the upper bowl starts to curve
  xc2: 276, // where the lower bowl starts to curve
  xb: 252, // centre of the vertical bar: mid-way across the B, clear of the stem
  bw: 32, // vertical bar width
  barTop: 82,
  barBottom: 430,
};
const r1 = (G.mid - G.top) / 2;
const r2 = (G.bottom - G.mid) / 2;
const y1 = (G.top + G.mid) / 2;
const y2 = (G.mid + G.bottom) / 2;
const h = G.s / 2;

/** Is the point (x, y) on the 512 canvas part of the ฿? */
function inBaht(x, y) {
  const stem = Math.abs(x - G.x0) <= h && y >= G.top - h && y <= G.bottom + h;
  const topBar = Math.abs(y - G.top) <= h && x >= G.x0 - h && x <= G.xc1;
  const midBar = Math.abs(y - G.mid) <= h && x >= G.x0 - h && x <= G.xc2;
  const bottomBar = Math.abs(y - G.bottom) <= h && x >= G.x0 - h && x <= G.xc2;
  const upperBowl = x >= G.xc1 && Math.abs(Math.hypot(x - G.xc1, y - y1) - r1) <= h;
  const lowerBowl = x >= G.xc2 && Math.abs(Math.hypot(x - G.xc2, y - y2) - r2) <= h;
  const bar = Math.abs(x - G.xb) <= G.bw / 2 && y >= G.barTop && y <= G.barBottom;
  return stem || topBar || midBar || bottomBar || upperBowl || lowerBowl || bar;
}

function draw(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const k = 512 / size;
  const SS = 4; // 4 × 4 samples per pixel for smooth edges
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (inBaht((px + (sx + 0.5) / SS) * k, (py + (sy + 0.5) / SS) * k)) hits++;
        }
      }
      const a = hits / (SS * SS);
      const i = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) pixels[i + c] = Math.round(TEAL[c] * (1 - a) + WHITE[c] * a);
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}

function png(size, rgba) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The same ฿ as vector paths, on a rounded square for browser tabs. */
function svg() {
  const hex = `#${TEAL.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="${hex}"/>
  <g fill="none" stroke="#fff" stroke-width="${G.s}">
    <path d="M${G.x0} ${G.top - h}V${G.bottom + h}"/>
    <path d="M${G.x0 - h} ${G.top}H${G.xc1}A${r1} ${r1} 0 0 1 ${G.xc1} ${G.mid}H${G.x0 - h}"/>
    <path d="M${G.x0 - h} ${G.mid}H${G.xc2}A${r2} ${r2} 0 0 1 ${G.xc2} ${G.bottom}H${G.x0 - h}"/>
  </g>
  <rect x="${G.xb - G.bw / 2}" y="${G.barTop}" width="${G.bw}" height="${G.barBottom - G.barTop}" fill="#fff"/>
</svg>
`;
}

mkdirSync(OUT, { recursive: true });
for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
  writeFileSync(new URL(name, OUT), png(size, draw(size)));
  console.log(`icons/${name} (${size}x${size})`);
}
writeFileSync(new URL('favicon.svg', OUT), svg());
console.log('icons/favicon.svg');
