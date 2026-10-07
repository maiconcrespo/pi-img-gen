/**
 * Output naming, extension mapping, meta.json shape, and the save routine
 * (src/output.ts).
 *
 * All filesystem effects go through the injectable SaveIo, so the save path is
 * asserted without touching the real filesystem.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";

import {
  buildMeta,
  buildOutputPaths,
  extensionForMime,
  formatStamp,
  saveGeneration,
  slugifyPrompt,
  type SaveIo,
} from "../src/output.ts";

// ---------------------------------------------------------------------------
// slug
// ---------------------------------------------------------------------------

test("slug: ascii prompt becomes a lowercase hyphen slug", () => {
  assert.equal(slugifyPrompt("A red fox in the snow"), "a-red-fox-in-the-snow");
});

test("slug: punctuation and extra whitespace collapse into single hyphens", () => {
  assert.equal(slugifyPrompt("  Multiple   spaces  and!!punct "), "multiple-spaces-and-punct");
});

test("slug: accented latin characters are transliterated, not dropped", () => {
  assert.equal(slugifyPrompt("¡Hola, ¿cómo estás?"), "hola-como-estas");
});

test("slug: prompts without ascii alphanumerics fall back to a safe token", () => {
  assert.equal(slugifyPrompt("猫と犬🐱"), "image");
  assert.equal(slugifyPrompt("---"), "image");
  assert.equal(slugifyPrompt(""), "image");
  assert.equal(slugifyPrompt("   "), "image");
});

test("slug: long prompts are truncated short and never end in a hyphen", () => {
  const slug = slugifyPrompt("the quick brown fox jumps over the lazy dog again and again and again");
  assert.ok(slug.length <= 48, `expected <= 48 chars, got ${slug.length}`);
  assert.ok(!slug.endsWith("-"), `unexpected trailing hyphen: ${slug}`);
  assert.ok(slug.startsWith("the-quick-brown-fox"));
});

// ---------------------------------------------------------------------------
// directory / file naming
// ---------------------------------------------------------------------------

test("stamp uses the local date and time as YYYYMMDD-HHmm", () => {
  assert.equal(formatStamp(new Date(2026, 9, 7, 8, 5)), "20261007-0805");
  assert.equal(formatStamp(new Date(2026, 0, 31, 23, 59)), "20260131-2359");
});

test("output paths follow <root>/<stamp>-<slug>/<model><ext> + meta.json", () => {
  const paths = buildOutputPaths({
    root: "/home/u/imagenes",
    stamp: "20261007-0805",
    slug: "a-red-fox",
    model: "nano-banana-2",
    ext: ".jpg",
  });
  assert.equal(paths.dir, join("/home/u/imagenes", "20261007-0805-a-red-fox"));
  assert.equal(paths.imagePath, join(paths.dir, "nano-banana-2.jpg"));
  assert.equal(paths.metaPath, join(paths.dir, "meta.json"));
});

test("model ids with path separators are flattened for the filename", () => {
  const paths = buildOutputPaths({
    root: "/r",
    stamp: "20261007-0805",
    slug: "s",
    model: "google/gemini-2.5-flash-image",
    ext: ".png",
  });
  assert.equal(paths.imagePath, join(paths.dir, "google-gemini-2.5-flash-image.png"));
});

// ---------------------------------------------------------------------------
// mime → extension
// ---------------------------------------------------------------------------

test("extension mapping covers the four verified image types", () => {
  assert.equal(extensionForMime("image/jpeg"), ".jpg");
  assert.equal(extensionForMime("image/png"), ".png");
  assert.equal(extensionForMime("image/gif"), ".gif");
  assert.equal(extensionForMime("image/webp"), ".webp");
});

test("extension mapping tolerates parameters, case, and the image/jpg alias", () => {
  assert.equal(extensionForMime("image/png; charset=binary"), ".png");
  assert.equal(extensionForMime("IMAGE/JPEG"), ".jpg");
  assert.equal(extensionForMime("image/jpg"), ".jpg");
});

test("unknown or missing mime types never pretend to be a known image", () => {
  assert.equal(extensionForMime("application/octet-stream"), ".bin");
  assert.equal(extensionForMime(undefined), ".bin");
  assert.equal(extensionForMime(""), ".bin");
});

// ---------------------------------------------------------------------------
// meta.json
// ---------------------------------------------------------------------------

test("meta.json has exactly the documented shape", () => {
  const savedAt = new Date("2026-10-07T08:05:00.000Z");
  const meta = buildMeta({
    model: "nano-banana-2",
    provider: "opendesign",
    prompt: "a red fox",
    sizeSent: "1024x1024",
    mimeType: "image/jpeg",
    latencyMs: 15240,
    stopReason: "stop",
    savedAt,
  });
  assert.deepEqual(Object.keys(meta), [
    "model",
    "provider",
    "prompt",
    "preset",
    "sizeSent",
    "mimeType",
    "savedAt",
    "latencyMs",
    "stopReason",
  ]);
  assert.equal(meta.model, "nano-banana-2");
  assert.equal(meta.provider, "opendesign");
  assert.equal(meta.prompt, "a red fox");
  assert.equal(meta.preset, null, "T5 presets are not wired yet: preset must be null");
  assert.equal(meta.sizeSent, "1024x1024");
  assert.equal(meta.mimeType, "image/jpeg");
  assert.equal(meta.savedAt, savedAt.toISOString());
  assert.equal(meta.latencyMs, 15240);
  assert.equal(meta.stopReason, "stop");
});

test("meta.json preset can carry a value once T5 presets exist", () => {
  const meta = buildMeta({
    model: "m",
    provider: "p",
    prompt: "x",
    sizeSent: "1024x1024",
    mimeType: "image/png",
    latencyMs: 1,
    stopReason: "stop",
    preset: "watercolor",
  });
  assert.equal(meta.preset, "watercolor");
});

// ---------------------------------------------------------------------------
// saveGeneration (fake io — no real filesystem)
// ---------------------------------------------------------------------------

interface FakeIo {
  io: SaveIo;
  mkdirs: string[];
  writes: { path: string; data: string | Uint8Array }[];
  existing: string[];
}

function fakeIo(existing: string[] = []): FakeIo {
  const rec: FakeIo = { io: undefined as unknown as SaveIo, mkdirs: [], writes: [], existing };
  rec.io = {
    mkdir: async (path: string) => {
      rec.mkdirs.push(path);
      return undefined;
    },
    writeFile: async (path: string, data: string | Uint8Array) => {
      rec.writes.push({ path, data });
    },
    exists: async (path: string) => rec.existing.includes(path),
  };
  return rec;
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const NOW = new Date(2026, 9, 7, 8, 5);

test("saveGeneration writes the image bytes and meta.json into the output dir", async () => {
  const rec = fakeIo();
  const saved = await saveGeneration(
    {
      root: "/home/u/imagenes",
      model: "nano-banana-2",
      provider: "opendesign",
      prompt: "a red fox",
      mimeType: "image/png",
      bytes: PNG_BYTES,
      sizeSent: "1024x1024",
      latencyMs: 15240,
      now: NOW,
    },
    rec.io,
  );

  const dir = join("/home/u/imagenes", "20261007-0805-a-red-fox");
  assert.equal(saved.dir, dir);
  assert.equal(saved.imagePath, join(dir, "nano-banana-2.png"));
  assert.equal(saved.metaPath, join(dir, "meta.json"));
  assert.deepEqual(rec.mkdirs, [dir]);

  assert.equal(rec.writes.length, 2);
  const imageWrite = rec.writes.find((w) => w.path === saved.imagePath);
  assert.ok(imageWrite, "image bytes must be written");
  assert.deepEqual(imageWrite.data, PNG_BYTES);

  const metaWrite = rec.writes.find((w) => w.path === saved.metaPath);
  assert.ok(metaWrite, "meta.json must be written");
  assert.equal(typeof metaWrite.data, "string");
  const meta = JSON.parse(metaWrite.data as string);
  assert.equal(meta.model, "nano-banana-2");
  assert.equal(meta.provider, "opendesign");
  assert.equal(meta.prompt, "a red fox");
  assert.equal(meta.preset, null);
  assert.equal(meta.sizeSent, "1024x1024");
  assert.equal(meta.mimeType, "image/png");
  assert.equal(meta.savedAt, NOW.toISOString());
  assert.equal(meta.latencyMs, 15240);
  assert.equal(meta.stopReason, "stop");
});

test("saveGeneration never overwrites an existing output directory", async () => {
  const rec = fakeIo([join("/home/u/imagenes", "20261007-0805-a-red-fox")]);
  const saved = await saveGeneration(
    {
      root: "/home/u/imagenes",
      model: "nano-banana-2",
      provider: "opendesign",
      prompt: "a red fox",
      mimeType: "image/jpeg",
      bytes: PNG_BYTES,
      sizeSent: "1024x1024",
      latencyMs: 10,
      now: NOW,
    },
    rec.io,
  );
  assert.equal(saved.dir, join("/home/u/imagenes", "20261007-0805-a-red-fox-2"));
  assert.equal(saved.imagePath, join(saved.dir, "nano-banana-2.jpg"));
});
