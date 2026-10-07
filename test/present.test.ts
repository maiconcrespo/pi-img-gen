/**
 * Model presentation data for the /imagen picker (src/present.ts).
 *
 * The overlay renders rows; the latency notes and size quirks are the measured
 * opendesign table from README.md, and model resolution decides which model a
 * given invocation uses (flag > persisted default > first available).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { LATENCY_VARIANCE_NOTE, MODEL_NOTES, presentModels, resolveModelId } from "../src/present.ts";
import { DEFAULT_SIZES, OPENDESIGN_IMAGE_MODELS } from "../src/profiles.ts";

const FIVE_MODELS = OPENDESIGN_IMAGE_MODELS.map((id) => ({
  id,
  name: id.toUpperCase(),
  provider: "opendesign",
}));

test("every measured opendesign model has a presentation note", () => {
  for (const id of OPENDESIGN_IMAGE_MODELS) {
    const note = MODEL_NOTES[id];
    assert.ok(note, `missing note for ${id}`);
    const described = [note.latencyNote, note.sizeQuirk].filter(Boolean).join(" ");
    assert.ok(described.length > 0, `note for ${id} must carry a latency note or a size quirk`);
  }
});

test("latency notes cover the four measured latencies and the variance is stated once", () => {
  assert.equal(MODEL_NOTES["nano-banana-2-lite"].latencyNote, "~6s");
  assert.equal(MODEL_NOTES["nano-banana-2"].latencyNote, "~15s");
  assert.equal(MODEL_NOTES["seedream-5.0-pro"].latencyNote, "~47s");
  assert.equal(MODEL_NOTES["gpt-image-2"].latencyNote, "~81s");
  assert.ok(LATENCY_VARIANCE_NOTE.includes("50"), "measured latencies vary ±50–70%");
});

test("seedream-5.0 carries its min-size quirk", () => {
  assert.match(MODEL_NOTES["seedream-5.0"].sizeQuirk ?? "", /1920x1920/);
  assert.equal(MODEL_NOTES["seedream-5.0"].latencyNote, undefined);
});

test("presentModels keeps registry order and marks the default row", () => {
  const rows = presentModels(FIVE_MODELS, "gpt-image-2");
  assert.deepEqual(
    rows.map((row) => row.id),
    [...OPENDESIGN_IMAGE_MODELS],
  );
  assert.deepEqual(
    rows.map((row) => row.isDefault),
    [false, false, false, true, false],
  );
});

test("presentModels exposes the size the transport will send per model", () => {
  const rows = presentModels(FIVE_MODELS, "nano-banana-2");
  for (const row of rows) {
    assert.equal(row.sizeSent, DEFAULT_SIZES[row.id], `sizeSent mismatch for ${row.id}`);
  }
  assert.equal(rows.find((row) => row.id === "seedream-5.0")!.sizeSent, "1920x1920");
});

test("presentModels labels unknown models without inventing notes", () => {
  const rows = presentModels(
    [
      { id: "mystery-model", name: "mystery-model", provider: "acme" },
      { id: "fancy", name: "Fancy Model", provider: "acme" },
    ],
    undefined,
  );
  assert.equal(rows[0].label, "mystery-model");
  assert.equal(rows[0].latencyNote, undefined);
  assert.equal(rows[0].sizeQuirk, undefined);
  assert.equal(rows[0].isDefault, false);
  assert.equal(rows[1].label, "Fancy Model");
  // Unprofiled providers fall back to the transport's default size.
  assert.equal(rows[0].sizeSent, "1024x1024");
});

test("resolveModelId: an explicit --model wins when it exists", () => {
  const ids = [...OPENDESIGN_IMAGE_MODELS];
  assert.deepEqual(resolveModelId(ids, "gpt-image-2", "nano-banana-2"), { id: "gpt-image-2" });
});

test("resolveModelId: an unknown --model reports the available ids", () => {
  const result = resolveModelId(["nano-banana-2", "gpt-image-2"], "not-a-model");
  assert.ok("error" in result, "expected an error result");
  assert.match(result.error, /not-a-model/);
  assert.match(result.error, /nano-banana-2/);
  assert.match(result.error, /gpt-image-2/);
});

test("resolveModelId: falls back to the persisted default, then the first model", () => {
  const ids = [...OPENDESIGN_IMAGE_MODELS];
  assert.deepEqual(resolveModelId(ids, undefined, "seedream-5.0"), { id: "seedream-5.0" });
  // A persisted default that disappeared from the registry is ignored.
  assert.deepEqual(resolveModelId(ids, undefined, "gone-model"), { id: ids[0] });
  assert.deepEqual(resolveModelId(ids, undefined, undefined), { id: ids[0] });
});

test("resolveModelId: no image models at all is an explainable error", () => {
  const result = resolveModelId([], undefined, undefined);
  assert.ok("error" in result);
  assert.match(result.error, /[Nn]o image models/);
});
