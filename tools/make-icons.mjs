// Draws the app icon (a white coin with a plus on teal) and writes the PNG sizes the PWA needs.
// Run: npm run icons
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';

const TEAL = [15, 118, 110];
const WHITE = [255, 255, 255];
const OUT = new URL('../icons/', import.meta.url);

function draw(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const coin = size * 0.3; // inside the 40% safe zone, so it also works as a maskable icon
  const arm = size * 0.15;
  const bar = size * 0.042;
  const SS = 4; // 4x4 samples per pixel for smooth edges
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const rgb = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = x + (sx + 0.5) / SS - c;
          const dy = y + (sy + 0.5) / SS - c;
          const inCoin = Math.hypot(dx, dy) <= coin;
          const inPlus = (Math.abs(dx) <= bar && Math.abs(dy) <= arm) || (Math.abs(dy) <= bar && Math.abs(dx) <= arm);
          const color = inCoin && !inPlus ? WHITE : TEAL;
          for (let k = 0; k < 3; k++) rgb[k] += color[k];
        }
      }
      const i = (y * size + x) * 4;
      for (let k = 0; k < 3; k++) pixels[i + k] = Math.round(rgb[k] / (SS * SS));
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

mkdirSync(OUT, { recursive: true });
for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
  writeFileSync(new URL(name, OUT), png(size, draw(size)));
  console.log(`icons/${name} (${size}x${size})`);
}
