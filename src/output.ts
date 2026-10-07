/**
 * Output layout for generated images.
 *
 *   ~/imagenes/<YYYYMMDD-HHmm>-<slug>/<model>.<ext>
 *   ~/imagenes/<YYYYMMDD-HHmm>-<slug>/meta.json
 *
 * - slug: slugified prompt, short and ASCII-safe for filenames.
 * - `<ext>`: derived from the response block's mimeType ONLY (never from a URL
 *   or an id — signed URLs carry no extension and one gateway served JPEG
 *   behind a `.img` URL).
 * - The directory is never reused: a numeric suffix is appended instead.
 *
 * Filesystem effects go through the injectable {@link SaveIo} so the naming,
 * meta.json shape, and write order are unit-testable without touching disk.
 */
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Maximum slug length; keeps directory names readable in terminals. */
export const MAX_SLUG_LENGTH = 48;

/** Slug fallback when a prompt has no ASCII alphanumerics (e.g. CJK/emoji). */
export const SLUG_FALLBACK = "image";

const MIME_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
});

/** What `meta.json` records for reproducibility. */
export interface ImagenMeta {
  model: string;
  provider: string;
  prompt: string;
  /** T5 preset id; `null` until presets exist. */
  preset: string | null;
  /** Size sent to the gateway (profile default for this model). */
  sizeSent: string;
  mimeType: string;
  /** ISO-8601 save timestamp. */
  savedAt: string;
  latencyMs: number;
  stopReason: "stop" | "error" | "aborted";
}

/** Slugify a prompt: lowercase, ASCII-safe, hyphen-separated, short. */
export function slugifyPrompt(prompt: string): string {
  const normalized = (prompt ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  let slug = normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (slug.length > MAX_SLUG_LENGTH) {
    slug = slug.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, "");
  }
  return slug.length > 0 ? slug : SLUG_FALLBACK;
}

/** `YYYYMMDD-HHmm` in LOCAL time (matches how users read their own output). */
export function formatStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

/** File extension for a response mimeType. Unknown types become `.bin`. */
export function extensionForMime(mimeType: string | undefined): string {
  const base = (mimeType ?? "").split(";", 1)[0]!.trim().toLowerCase();
  return MIME_EXTENSIONS[base] ?? ".bin";
}

/** Make a model id safe as a single path segment (`a/b` → `a-b`). */
export function safeModelFileName(model: string): string {
  const safe = (model ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return safe.length > 0 ? safe : "model";
}

/** Absolute paths for one generation output. */
export interface OutputPaths {
  dir: string;
  imageName: string;
  imagePath: string;
  metaPath: string;
}

/** Compute the output paths for a stamp/slug/model combination. */
export function buildOutputPaths(options: {
  root: string;
  stamp: string;
  slug: string;
  model: string;
  ext: string;
}): OutputPaths {
  const dir = join(options.root, `${options.stamp}-${options.slug}`);
  const imageName = `${safeModelFileName(options.model)}${options.ext}`;
  return { dir, imageName, imagePath: join(dir, imageName), metaPath: join(dir, "meta.json") };
}

/** Build the `meta.json` document (key order mirrors the documented shape). */
export function buildMeta(input: {
  model: string;
  provider: string;
  prompt: string;
  sizeSent: string;
  mimeType: string;
  latencyMs: number;
  stopReason: "stop" | "error" | "aborted";
  preset?: string | null;
  savedAt?: Date;
}): ImagenMeta {
  return {
    model: input.model,
    provider: input.provider,
    prompt: input.prompt,
    preset: input.preset ?? null,
    sizeSent: input.sizeSent,
    mimeType: input.mimeType,
    savedAt: (input.savedAt ?? new Date()).toISOString(),
    latencyMs: input.latencyMs,
    stopReason: input.stopReason,
  };
}

/** Filesystem operations used by {@link saveGeneration}; injectable for tests. */
export interface SaveIo {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
}

const defaultIo: SaveIo = {
  mkdir: (path, options) => mkdir(path, options),
  writeFile: (path, data) => writeFile(path, data),
  exists: async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
};

export interface SaveGenerationInput {
  root: string;
  model: string;
  provider: string;
  prompt: string;
  /** Mime type of the generated block — the ONLY source of the extension. */
  mimeType: string;
  bytes: Uint8Array;
  sizeSent: string;
  latencyMs: number;
  stopReason?: "stop" | "error" | "aborted";
  preset?: string | null;
  now?: Date;
}

export interface SavedImage {
  dir: string;
  imagePath: string;
  metaPath: string;
}

/** Write `<image>.<ext>` + `meta.json` into a fresh output directory. */
export async function saveGeneration(input: SaveGenerationInput, io: SaveIo = defaultIo): Promise<SavedImage> {
  const now = input.now ?? new Date();
  const stamp = formatStamp(now);
  const slug = slugifyPrompt(input.prompt);
  const ext = extensionForMime(input.mimeType);
  const base = { root: input.root, stamp, slug, model: input.model, ext };

  let paths = buildOutputPaths(base);
  let suffix = 1;
  while ((await io.exists(paths.dir)) && suffix < 1000) {
    suffix += 1;
    paths = buildOutputPaths({ ...base, slug: `${slug}-${suffix}` });
  }

  const meta = buildMeta({
    model: input.model,
    provider: input.provider,
    prompt: input.prompt,
    sizeSent: input.sizeSent,
    mimeType: input.mimeType,
    latencyMs: input.latencyMs,
    stopReason: input.stopReason ?? "stop",
    preset: input.preset ?? null,
    savedAt: now,
  });

  await io.mkdir(paths.dir, { recursive: true });
  await io.writeFile(paths.imagePath, input.bytes);
  await io.writeFile(paths.metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  return paths;
}
