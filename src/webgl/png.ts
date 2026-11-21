// Just enough PNG decoding to judge a screenshot: 8-bit grey / RGB / grey+alpha / RGBA, not interlaced (what
// Chrome's Page.captureScreenshot writes). No dependencies: zlib inflate plus the five PNG row filters.

import { inflateSync } from "node:zlib";

export interface Rgba {
  width: number;
  height: number;
  /** width * height * 4 bytes, RGBA. */
  data: Uint8Array;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode a PNG to RGBA, or null for a format this does not handle (or a broken file). */
export function decodePng(png: Buffer): Rgba | null {
  try {
    if (png.length < 33 || png.readUInt32BE(0) !== 0x89504e47 || png.readUInt32BE(4) !== 0x0d0a1a0a) return null;
    let pos = 8;
    let width = 0;
    let height = 0;
    let channels = 0;
    const idat: Buffer[] = [];
    while (pos + 8 <= png.length) {
      const len = png.readUInt32BE(pos);
      const type = png.subarray(pos + 4, pos + 8).toString("latin1");
      const body = png.subarray(pos + 8, pos + 8 + len);
      if (type === "IHDR") {
        width = body.readUInt32BE(0);
        height = body.readUInt32BE(4);
        const depth = body[8];
        const colorType = body[9];
        const interlace = body[12];
        channels = CHANNELS[colorType] ?? 0;
        if (depth !== 8 || !channels || interlace !== 0) return null;
      } else if (type === "IDAT") {
        idat.push(body);
      } else if (type === "IEND") {
        break;
      }
      pos += 12 + len;
    }
    if (!width || !height || !channels) return null;
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    if (raw.length < height * (stride + 1)) return null;
    const pixels = new Uint8Array(height * stride);
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)];
      const src = y * (stride + 1) + 1;
      const row = y * stride;
      const prev = row - stride;
      for (let x = 0; x < stride; x++) {
        const v = raw[src + x];
        const a = x >= channels ? pixels[row + x - channels] : 0;
        const b = y > 0 ? pixels[prev + x] : 0;
        const c = y > 0 && x >= channels ? pixels[prev + x - channels] : 0;
        let out: number;
        switch (filter) {
          case 0:
            out = v;
            break;
          case 1:
            out = v + a;
            break;
          case 2:
            out = v + b;
            break;
          case 3:
            out = v + ((a + b) >> 1);
            break;
          case 4:
            out = v + paeth(a, b, c);
            break;
          default:
            return null;
        }
        pixels[row + x] = out & 0xff;
      }
    }
    const data = new Uint8Array(width * height * 4);
    for (let i = 0, j = 0; i < width * height; i++, j += channels) {
      const o = i * 4;
      if (channels >= 3) {
        data[o] = pixels[j];
        data[o + 1] = pixels[j + 1];
        data[o + 2] = pixels[j + 2];
        data[o + 3] = channels === 4 ? pixels[j + 3] : 255;
      } else {
        data[o] = data[o + 1] = data[o + 2] = pixels[j];
        data[o + 3] = channels === 2 ? pixels[j + 1] : 255;
      }
    }
    return { width, height, data };
  } catch {
    return null;
  }
}

/**
 * Share of the pixels in the rectangle that have the most common colour (0..1). 1 means a single flat colour, e.g. a
 * canvas that never drew. The rectangle is clipped to the image; an empty one gives null.
 */
export function dominantColorRatio(img: Rgba, rect?: { x: number; y: number; width: number; height: number }): number | null {
  const x0 = Math.max(0, Math.floor(rect?.x ?? 0));
  const y0 = Math.max(0, Math.floor(rect?.y ?? 0));
  const x1 = Math.min(img.width, Math.floor((rect ? rect.x + rect.width : img.width)));
  const y1 = Math.min(img.height, Math.floor((rect ? rect.y + rect.height : img.height)));
  if (x1 <= x0 || y1 <= y0) return null;
  const counts = new Map<number, number>();
  let best = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * img.width + x) * 4;
      const key = (img.data[o] << 16) | (img.data[o + 1] << 8) | img.data[o + 2];
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      if (n > best) best = n;
    }
  }
  return best / ((x1 - x0) * (y1 - y0));
}
