/**
 * Registration-shape test (src/index.ts).
 *
 * CRITICAL contract: registration is a shallow field-level merge with any
 * existing registration of the same provider (e.g. the opendesign bridge).
 * This extension must pass ONLY `images` — supplying `models` would REPLACE
 * the bridge's model list and break chat; `baseUrl` would rewrite every
 * model's endpoint; `refreshModels` would replace the live catalog.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import extension from "../src/index.ts";

interface Registration {
  name: string;
  config: Record<string, unknown>;
}

function runExtension(): Registration[] {
  const registrations: Registration[] = [];
  const pi = {
    registerProvider: (name: string, config: Record<string, unknown>) => {
      registrations.push({ name, config });
    },
  };
  extension(pi);
  return registrations;
}

test("registers one provider: images only — no models, baseUrl, or refreshModels", () => {
  const registrations = runExtension();
  assert.equal(registrations.length, 1);

  const [registration] = registrations;
  assert.equal(registration.name, "opendesign");
  assert.deepEqual(
    Object.keys(registration.config),
    ["images"],
    "config must contain ONLY the images field",
  );
  assert.equal(registration.config.models, undefined);
  assert.equal(registration.config.baseUrl, undefined);
  assert.equal(registration.config.refreshModels, undefined);
  assert.equal(registration.config.apiKey, undefined);
});

test("images map is keyed by the profile's images api and exposes generateImages", () => {
  const [registration] = runExtension();
  const images = registration.config.images as Record<string, { generateImages: unknown }>;
  assert.deepEqual(Object.keys(images), ["openai-images"]);
  assert.equal(typeof images["openai-images"].generateImages, "function");
});
