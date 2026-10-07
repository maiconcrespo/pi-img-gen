/**
 * Registration-shape test (src/index.ts).
 *
 * CRITICAL contract: registration is a shallow field-level merge with any
 * existing registration of the same provider (e.g. the opendesign bridge).
 * This extension must pass ONLY `images` — supplying `models` would REPLACE
 * the bridge's model list and break chat; `baseUrl` would rewrite every
 * model's endpoint; `refreshModels` would replace the live catalog.
 *
 * Also asserts the UX layer entry point: the `/imagen` command registration.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import extension from "../src/index.ts";

interface Registration {
  name: string;
  config: Record<string, unknown>;
}

interface CommandRegistration {
  name: string;
  options: Record<string, unknown>;
}

function runExtension(): { registrations: Registration[]; commands: CommandRegistration[] } {
  const registrations: Registration[] = [];
  const commands: CommandRegistration[] = [];
  const pi = {
    registerProvider: (name: string, config: Record<string, unknown>) => {
      registrations.push({ name, config });
    },
    registerCommand: (name: string, options: Record<string, unknown>) => {
      commands.push({ name, options });
    },
  };
  extension(pi);
  return { registrations, commands };
}

test("registers one provider: images only — no models, baseUrl, or refreshModels", () => {
  const { registrations } = runExtension();
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
  const { registrations } = runExtension();
  const [registration] = registrations;
  const images = registration.config.images as Record<string, { generateImages: unknown }>;
  assert.deepEqual(Object.keys(images), ["openai-images"]);
  assert.equal(typeof images["openai-images"].generateImages, "function");
});

test("registers the /imagen command with a handler and both usage forms in its description", () => {
  const { commands } = runExtension();
  const imagen = commands.find((command) => command.name === "imagen");
  assert.ok(imagen, "the /imagen command must be registered");
  assert.equal(typeof imagen.options.handler, "function");
  const description = String(imagen.options.description);
  assert.match(description, /--model/);
  assert.match(description, /overlay/i);
});

test("/imagen argument completions suggest the measured image models", () => {
  const { commands } = runExtension();
  const imagen = commands.find((command) => command.name === "imagen");
  const completions = imagen.options.getArgumentCompletions as (prefix: string) => { value: string }[] | null;
  const all = completions("");
  assert.ok(Array.isArray(all));
  assert.deepEqual(
    all.map((item) => item.value),
    ["nano-banana-2-lite", "nano-banana-2", "seedream-5.0-pro", "gpt-image-2", "seedream-5.0"],
  );
  const narrowed = completions("seed");
  assert.deepEqual(
    narrowed.map((item) => item.value),
    ["seedream-5.0-pro", "seedream-5.0"],
  );
  assert.equal(completions("zzz"), null, "no matches returns null");
});
