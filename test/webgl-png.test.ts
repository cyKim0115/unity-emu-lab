// PNG decoding and the flat-colour measure used for canvas_blank (src/webgl/png.ts).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { decodePng, dominantColorRatio } from "../src/webgl/png.ts";

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, "latin1"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tb));
  return Buffer.concat([len, tb, crc]);
}

/** Encode raw pixel rows (channels per pixel) with the given filter byte per row (filters applied here). */
function encodePng(width: number, height: number, channels: 3 | 4, pixels: number[], filters: number[], o: { interlace?: number } = {}): Buffer {
  const colorType = channels === 4 ? 6 : 2;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  ihdr[12] = o.interlace ?? 0;
  const stride = width * channels;
  const rows: number[] = [];
  for (let y = 0; y < height; y++) {
    const f = filters[y % filters.length];
    rows.push(f);
    for (let x = 0; x < stride; x++) {
      const v = pixels[y * stride + x];
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const pred = [0, a, b, (a + b) >> 1, paeth][f];
      rows.push((v - pred) & 0xff);
    }
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from(rows))), chunk("IEND", Buffer.alloc(0))]);
}

describe("decodePng", () => {
  test("RGB and RGBA with all five filters round-trip", () => {
    const w = 7;
    const h = 5;
    for (const channels of [3, 4] as const) {
      const px: number[] = [];
      for (let i = 0; i < w * h * channels; i++) px.push((i * 37 + 11) & 0xff);
      const img = decodePng(encodePng(w, h, channels, px, [0, 1, 2, 3, 4]));
      assert.ok(img, `channels ${channels}`);
      assert.equal(img.width, w);
      assert.equal(img.height, h);
      for (let i = 0; i < w * h; i++) {
        for (let k = 0; k < 3; k++) assert.equal(img.data[i * 4 + k], px[i * channels + k], `px ${i} ch ${k}`);
        assert.equal(img.data[i * 4 + 3], channels === 4 ? px[i * channels + 3] : 255);
      }
    }
  });

  test("interlaced, truncated or not a PNG: null", () => {
    const px = new Array(4 * 4 * 3).fill(9);
    assert.equal(decodePng(encodePng(4, 4, 3, px, [0], { interlace: 1 })), null);
    assert.equal(decodePng(encodePng(4, 4, 3, px, [0]).subarray(0, 40)), null);
    assert.equal(decodePng(Buffer.from("not a png at all, just some text here")), null);
  });
});

describe("dominantColorRatio", () => {
  test("flat colour is 1, a gradient is low, the rectangle is clipped", () => {
    const w = 10;
    const h = 10;
    const flat = decodePng(encodePng(w, h, 3, new Array(w * h * 3).fill(0), [1]))!;
    assert.equal(dominantColorRatio(flat), 1);
    const grad: number[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) grad.push(x * 20, y * 20, 0);
    const g = decodePng(encodePng(w, h, 3, grad, [4]))!;
    assert.equal(dominantColorRatio(g), 1 / 100);
    // Left half black, right half gradient: only the left half is flat.
    const half: number[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) half.push(x < 5 ? 0 : x * 20, x < 5 ? 0 : y * 20, 0);
    const hh = decodePng(encodePng(w, h, 3, half, [2]))!;
    assert.equal(dominantColorRatio(hh, { x: 0, y: 0, width: 5, height: 10 }), 1);
    assert.equal(dominantColorRatio(hh), 0.5);
    assert.equal(dominantColorRatio(hh, { x: -5, y: -5, width: 10, height: 15 }), 1, "clipped to the image");
    assert.equal(dominantColorRatio(hh, { x: 20, y: 0, width: 5, height: 5 }), null);
  });
});
