/**
 * Magic-byte MIME detection tests (src/generate.ts → detectMime).
 * MIME is NEVER derived from URLs or file extensions.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { detectMime } from "../src/generate.ts";

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from([...text].map((c) => c.charCodeAt(0)));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

test("JPEG: FF D8 FF", () => {
  assert.equal(detectMime(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10)), "image/jpeg");
});

test("PNG: 89 50 4E 47 0D 0A 1A 0A", () => {
  assert.equal(detectMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), "image/png");
});

test("GIF87a and GIF89a", () => {
  assert.equal(detectMime(concat(ascii("GIF87a"), bytes(0x01, 0x00))), "image/gif");
  assert.equal(detectMime(concat(ascii("GIF89a"), bytes(0x01, 0x00))), "image/gif");
});

test("WebP: RIFF....WEBP", () => {
  const webp = concat(ascii("RIFF"), bytes(0x10, 0x00, 0x00, 0x00), ascii("WEBP"), bytes(0x56, 0x50));
  assert.equal(detectMime(webp), "image/webp");
});

test("RIFF that is not WebP does not claim image/webp", () => {
  const wav = concat(ascii("RIFF"), bytes(0x10, 0x00, 0x00, 0x00), ascii("WAVE"));
  assert.equal(detectMime(wav), "application/octet-stream");
});

test("unknown bytes fall back to application/octet-stream", () => {
  assert.equal(detectMime(ascii("not an image")), "application/octet-stream");
});

test("truncated buffers never throw", () => {
  assert.equal(detectMime(bytes()), "application/octet-stream");
  assert.equal(detectMime(bytes(0xff)), "application/octet-stream");
  assert.equal(detectMime(bytes(0x89, 0x50)), "application/octet-stream");
});
