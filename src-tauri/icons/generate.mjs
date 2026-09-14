// Dependency-free rasterization of the panel's geometric aircraft symbol.
// Run with Node 20: node windows-client/src-tauri/icons/generate.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const directory = dirname(fileURLToPath(import.meta.url));
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([header, body, checksum]);
}
function png(size) {
  const bytes = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, v = (y + 0.5) / size;
      let color = [46, 48, 51, 255];
      if (u > 0.08 && u < 0.92 && v > 0.08 && v < 0.92) color = [10, 20, 16, 255];
      const center = Math.abs(u - 0.5);
      const fuselage = center < 0.035 && v > 0.18 && v < 0.80;
      const wings = v > 0.40 + center * 0.46 && v < 0.55 + center * 0.25 && center < 0.33;
      const tail = v > 0.68 + center * 0.4 && v < 0.77 + center * 0.1 && center < 0.13;
      if (fuselage || wings || tail) color = [40, 224, 110, 255];
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      bytes.set(color, offset);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6; // 8-bit RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(bytes)), chunk('IEND', Buffer.alloc(0))]);
}
for (const [name, size] of [['32x32.png', 32], ['128x128.png', 128], ['128x128@2x.png', 256], ['icon.png', 256]]) {
  writeFileSync(join(directory, name), png(size));
}
const images = [32, 48, 256].map(size => ({ size, bytes: png(size) }));
const header = Buffer.alloc(6); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
let offset = 6 + images.length * 16;
const entries = images.map(({ size, bytes }) => {
  const entry = Buffer.alloc(16);
  entry[0] = size === 256 ? 0 : size; entry[1] = entry[0];
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(bytes.length, 8); entry.writeUInt32LE(offset, 12);
  offset += bytes.length;
  return entry;
});
writeFileSync(join(directory, 'icon.ico'), Buffer.concat([header, ...entries, ...images.map(({ bytes }) => bytes)]));
console.log('Generated four RGBA PNGs and a three-size PNG-backed ICO.');
