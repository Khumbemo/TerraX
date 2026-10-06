// Generates the PWA icons (public/icons/*.png): a globe with a graticule,
// drawn with 4×4 supersampling. Run: node scripts/make-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = buf => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function png(w, h, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w * 4; x++) raw[y * (w * 4 + 1) + 1 + x] = rgba[y * w * 4 + x];
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const BG = [5, 10, 20], OCEAN = [8, 36, 64], LINE = [56, 189, 248], LAND = [52, 211, 153];
function icon(size, maskable) {
  const out = new Uint8Array(size * size * 4);
  const R = maskable ? 0.36 : 0.44; // maskable icons keep content inside the 80 % safe zone
  const S = 4;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0];
      for (let sy = 0; sy < S; sy++)
        for (let sx = 0; sx < S; sx++) {
          const u = (x + (sx + 0.5) / S) / size - 0.5, v = (y + (sy + 0.5) / S) / size - 0.5;
          const r = Math.hypot(u, v);
          let c = BG;
          if (r < R) {
            // Orthographic globe tilted 20°: longitude/latitude of the visible point.
            const px = u / R, py = -v / R, pz = Math.sqrt(Math.max(0, 1 - px * px - py * py));
            const tilt = (20 * Math.PI) / 180;
            const yy = py * Math.cos(tilt) + pz * Math.sin(tilt), zz = -py * Math.sin(tilt) + pz * Math.cos(tilt);
            const lat = Math.asin(Math.max(-1, Math.min(1, yy))), lon = Math.atan2(px, zz);
            const land = Math.sin(3 * lon + 1) * Math.cos(2 * lat) + Math.sin(5 * lat + lon) * 0.6 > 0.55;
            c = land ? LAND.map((k, i) => k * 0.55 + OCEAN[i] * 0.45) : OCEAN;
            const grid = 15 * (Math.PI / 180);
            const w = 0.022 / Math.max(0.35, pz);
            const onLat = Math.abs(((lat / grid + 0.5) % 1) - 0.5) * grid < w * 0.5;
            const onLon = Math.abs(((lon / (grid * 2) + 0.5) % 1) - 0.5) * grid * 2 * Math.cos(lat) < w * 0.5;
            if (onLat || onLon) c = c.map((k, i) => k * 0.45 + LINE[i] * 0.55);
            if (r > R * 0.965) c = LINE;
          }
          acc = acc.map((a, i) => a + c[i]);
        }
      out.set([...acc.map(a => Math.round(a / (S * S))), 255], (y * size + x) * 4);
    }
  return png(size, size, out);
}

const OUT = new URL('../public/icons/', import.meta.url);
mkdirSync(OUT, { recursive: true });
for (const [name, size, mask] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['icon-maskable-512.png', 512, true], ['apple-touch-icon.png', 180, false]]) {
  writeFileSync(new URL(name, OUT), icon(size, mask));
  console.log('wrote', name);
}
