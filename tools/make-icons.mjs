// Génère les icônes PNG (fond vert, ticket de caisse blanc). Usage : node tools/make-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

function crc32(buf) {
  let c, crc = ~0;
  for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function icon(size) {
  const px = (x, y) => {
    const u = x / size, v = y / size;
    // ticket : 0.32..0.68 en largeur, 0.24..0.76 en hauteur, bas en dents de scie
    const zig = 0.76 - Math.abs(((u * 20) % 2) - 1) * 0.03;
    if (u > 0.32 && u < 0.68 && v > 0.24 && v < zig) {
      const line = [0.34, 0.42, 0.50, 0.58].some((l) => v > l && v < l + 0.03);
      if (line && u > 0.38 && u < (v > 0.58 ? 0.52 : 0.62)) return [47, 111, 94];
      return [255, 255, 255];
    }
    return [47, 111, 94];
  };
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) raw.set(px(x, y), y * (size * 3 + 1) + 1 + x * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
for (const s of [192, 512]) writeFileSync(`icons/icon-${s}.png`, icon(s));
