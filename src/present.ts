/**
 * Model presentation data for the `/imagen` picker.
 *
 * The overlay renders rows; the notes come from the measured opendesign table
 * in README.md (2026-10-07): latencies vary ±50–70% run to run, so notes are
 * labels, not a contract. `resolveModelId` decides which model an invocation
 * uses: explicit `--model` > persisted default > first available.
 */
import { DEFAULT_SIZE, getProfile, resolveDefaultSize } from "./profiles.ts";

/** Presentation note for one image model. At least one field should exist. */
export interface ModelNote {
  /** Measured typical latency label, e.g. "~15s". */
  latencyNote?: string;
  /** Verified size behavior worth showing next to the model. */
  sizeQuirk?: string;
}

/** Stated once in the header: measured latencies drift heavily run to run. */
export const LATENCY_VARIANCE_NOTE = "latencies vary ±50–70% run to run";

/** Measured labels for the verified opendesign models (T3 live verification). */
export const MODEL_NOTES: Readonly<Record<string, ModelNote>> = Object.freeze({
  "nano-banana-2-lite": {
    latencyNote: "~6s",
    sizeQuirk: "gateway may return a different size than requested",
  },
  "nano-banana-2": {
    latencyNote: "~15s",
    sizeQuirk: "gateway may return a different size than requested",
  },
  "seedream-5.0-pro": { latencyNote: "~47s" },
  "gpt-image-2": { latencyNote: "~81s" },
  "seedream-5.0": { sizeQuirk: "rejects sizes below 1920x1920 (HTTP 400)" },
});

/** Minimum shape the picker needs; matches pi's `ImageModel` for our purposes. */
export interface ModelLike {
  id: string;
  name?: string;
  provider: string;
}

/** One rendered row of the model picker (plus header metadata). */
export interface ModelRow {
  id: string;
  label: string;
  provider: string;
  latencyNote?: string;
  sizeQuirk?: string;
  /** Size the transport will send for this model (profile default). */
  sizeSent: string;
  /** True for the persisted default the picker preselects. */
  isDefault: boolean;
}

/** Build picker rows from registry models, preserving registry order. */
export function presentModels(models: readonly ModelLike[], defaultModelId?: string): ModelRow[] {
  return models.map((model) => {
    const note = MODEL_NOTES[model.id];
    const profile = getProfile(model.provider);
    const label = model.name && model.name.trim().length > 0 && model.name !== model.id ? model.name : model.id;
    const row: ModelRow = {
      id: model.id,
      label,
      provider: model.provider,
      sizeSent: profile ? resolveDefaultSize(profile, model.id) : DEFAULT_SIZE,
      isDefault: model.id === defaultModelId,
    };
    if (note?.latencyNote) row.latencyNote = note.latencyNote;
    if (note?.sizeQuirk) row.sizeQuirk = note.sizeQuirk;
    return row;
  });
}

/** Resolution of the model a given `/imagen` invocation should use. */
export type ModelResolution = { id: string } | { error: string };

/**
 * Pick the model: an explicit request wins when it exists, then the persisted
 * default, then the first available model.
 */
export function resolveModelId(ids: readonly string[], requested?: string, savedDefault?: string): ModelResolution {
  if (requested !== undefined && requested.length > 0) {
    if (ids.includes(requested)) return { id: requested };
    const available = ids.length > 0 ? ids.join(", ") : "(none)";
    return { error: `Unknown image model "${requested}". Available: ${available}` };
  }
  if (savedDefault !== undefined && savedDefault.length > 0 && ids.includes(savedDefault)) {
    return { id: savedDefault };
  }
  const first = ids[0];
  if (first === undefined) {
    return {
      error:
        'No image models are available. Add models with "type": "image" (and a working apiKey) to models.json, or install a provider extension that registers image models.',
    };
  }
  return { id: first };
}
