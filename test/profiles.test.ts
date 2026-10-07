/**
 * Profile-table tests (src/profiles.ts).
 * The table is the ONLY place provider-specific quirks live.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_SIZE,
  DEFAULT_SIZES,
  OPENDESIGN_IMAGE_MODELS,
  PROFILES,
  getProfile,
  resolveDefaultSize,
} from "../src/profiles.ts";

test("v1 ships exactly one verified profile", () => {
  assert.equal(PROFILES.length, 1);
  assert.equal(PROFILES[0].providerId, "opendesign");
});

test("opendesign profile row has the verified values", () => {
  const profile = getProfile("opendesign");
  assert.ok(profile);
  assert.equal(profile.providerId, "opendesign");
  // MUST match the `api` value the user's models.json declares on image models.
  assert.equal(profile.imagesApi, "openai-images");
  assert.equal(profile.baseUrl, "https://amr-link.open-design.ai/v1");
  assert.equal(profile.defaultSize, "1024x1024");
  assert.equal(profile.modelSizes["seedream-5.0"], "1920x1920");
  assert.ok(profile.minPixels);
  assert.equal(profile.minPixels!["seedream-5.0"], 1920 * 1920);
});

test("seedream-5.0 default size satisfies its own min-pixel rule (gateway rejects <3.7MP)", () => {
  const profile = getProfile("opendesign")!;
  const [w, h] = resolveDefaultSize(profile, "seedream-5.0").split("x").map(Number);
  assert.ok(w * h >= profile.minPixels!["seedream-5.0"]);
});

test("models without a profile size entry fall back to the default size", () => {
  const profile = getProfile("opendesign")!;
  assert.equal(resolveDefaultSize(profile, "nano-banana-2"), DEFAULT_SIZE);
  assert.equal(resolveDefaultSize(profile, "gpt-image-2"), "1024x1024");
  assert.equal(resolveDefaultSize(profile, "some-future-model"), "1024x1024");
});

test("DEFAULT_SIZES exposes the verified model table for the UI layer", () => {
  assert.equal(DEFAULT_SIZES["seedream-5.0"], "1920x1920");
  for (const id of ["nano-banana-2-lite", "nano-banana-2", "seedream-5.0-pro", "gpt-image-2"]) {
    assert.ok(OPENDESIGN_IMAGE_MODELS.includes(id as (typeof OPENDESIGN_IMAGE_MODELS)[number]), id);
    assert.equal(DEFAULT_SIZES[id], "1024x1024");
  }
});

test("unknown provider ids resolve to no profile", () => {
  assert.equal(getProfile("some-other-provider"), undefined);
});
