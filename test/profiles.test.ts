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
  validateSize,
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

// ---------------------------------------------------------------------------
// Pre-flight size validation (validateSize) — pure, provider-neutral
// ---------------------------------------------------------------------------

test("validateSize rejects malformed sizes with an actionable format example", () => {
  const profile = getProfile("opendesign");
  for (const bad of ["1024", "abc", "0x1024", "1920x1920x1", ""]) {
    const result = validateSize("seedream-5.0", profile, bad);
    assert.equal(result.ok, false, `should reject ${JSON.stringify(bad)}`);
    if (!result.ok) {
      assert.ok(result.reason.includes(`"${bad}"`), `reason names the offending size: ${result.reason}`);
      assert.match(result.reason, /WIDTHxHEIGHT/);
    }
  }
});

test("validateSize rejects sizes below the model's verified minPixels floor with an actionable reason", () => {
  const profile = getProfile("opendesign");
  const result = validateSize("seedream-5.0", profile, "1024x1024");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /seedream-5\.0/); // model id
    assert.match(result.reason, /1024x1024/); // requested size
    assert.match(result.reason, /3686400/); // required pixel count (1920*1920)
    assert.match(result.reason, /1920x1920/); // verified example size
  }
});

test("validateSize accepts the exact verified minimum and larger sizes", () => {
  const profile = getProfile("opendesign");
  assert.deepEqual(validateSize("seedream-5.0", profile, "1920x1920"), { ok: true, size: "1920x1920" });
  assert.deepEqual(validateSize("seedream-5.0", profile, "2048x2048"), { ok: true, size: "2048x2048" });
});

test("validateSize passes through unchanged when there is no profile (provider-neutral core)", () => {
  // Below the seedream floor — but with no profile there is no constraint to enforce.
  assert.deepEqual(validateSize("seedream-5.0", undefined, "1024x1024"), { ok: true, size: "1024x1024" });
});

test("validateSize passes through for models without a minPixels entry", () => {
  const profile = getProfile("opendesign");
  assert.deepEqual(validateSize("nano-banana-2", profile, "512x512"), { ok: true, size: "512x512" });
  assert.deepEqual(validateSize("some-future-model", profile, "64x64"), { ok: true, size: "64x64" });
});
