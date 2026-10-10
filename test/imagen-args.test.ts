/**
 * CLI argument parsing for `/imagen` (src/imagen-args.ts).
 *
 * The slash command hands the handler the raw argument string, so parsing is
 * string-level: quote-aware tokenization, `--model <id>` / `--model=<id>`
 * removed from anywhere in the input, everything else is prompt text.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseImagenArgs } from "../src/imagen-args.ts";

test("bare prompt parses to a prompt with no model", () => {
  const parsed = parseImagenArgs("a red fox in the snow");
  assert.equal(parsed.prompt, "a red fox in the snow");
  assert.equal(parsed.modelId, undefined);
});

test("prompt whitespace is normalized and trimmed", () => {
  assert.equal(parseImagenArgs("  a   red\tfox  ").prompt, "a red fox");
});

test("punctuation inside the prompt survives untouched", () => {
  assert.equal(parseImagenArgs("Hello, world! #42 (2026) — 50%").prompt, "Hello, world! #42 (2026) — 50%");
});

test("--model after the prompt binds the model and keeps the prompt", () => {
  const parsed = parseImagenArgs("a red fox --model nano-banana-2");
  assert.equal(parsed.prompt, "a red fox");
  assert.equal(parsed.modelId, "nano-banana-2");
});

test("--model before the prompt works too", () => {
  const parsed = parseImagenArgs("--model seedream-5.0 a red fox");
  assert.equal(parsed.prompt, "a red fox");
  assert.equal(parsed.modelId, "seedream-5.0");
});

test("--model=<id> equals form is accepted", () => {
  const parsed = parseImagenArgs("--model=gpt-image-2 a red fox");
  assert.equal(parsed.prompt, "a red fox");
  assert.equal(parsed.modelId, "gpt-image-2");
});

test("quotes group words and are stripped from prompt and model", () => {
  const parsed = parseImagenArgs('"a red fox" --model "seedream-5.0-pro"');
  assert.equal(parsed.prompt, "a red fox");
  assert.equal(parsed.modelId, "seedream-5.0-pro");
});

test("repeated --model: the last occurrence wins", () => {
  const parsed = parseImagenArgs("--model nano-banana-2-lite a cat --model nano-banana-2");
  assert.equal(parsed.prompt, "a cat");
  assert.equal(parsed.modelId, "nano-banana-2");
});

test("--model without a value throws a usage error", () => {
  assert.throws(() => parseImagenArgs("a red fox --model"), /--model requires a value/);
});

test("--model followed by another flag counts as a missing value", () => {
  assert.throws(() => parseImagenArgs("a red fox --model --other"), /--model requires a value/);
});

test("--model with an empty quoted value throws", () => {
  assert.throws(() => parseImagenArgs('a red fox --model ""'), /--model requires a value/);
});

test("empty input yields an empty prompt and no model", () => {
  for (const raw of ["", "   ", "\t"]) {
    const parsed = parseImagenArgs(raw);
    assert.equal(parsed.prompt, "");
    assert.equal(parsed.modelId, undefined);
  }
});

test("a quoted empty prompt stays empty", () => {
  assert.equal(parseImagenArgs('"" --model nano-banana-2').prompt, "");
});

// ---------------------------------------------------------------------------
// --out-dir
// ---------------------------------------------------------------------------

test("--out-dir after the prompt binds the directory and keeps the prompt", () => {
  const parsed = parseImagenArgs("a red fox --out-dir /tmp/shots");
  assert.equal(parsed.prompt, "a red fox");
  assert.equal(parsed.outDir, "/tmp/shots");
});

test("--out-dir=<path> equals form is accepted", () => {
  const parsed = parseImagenArgs("--out-dir=/tmp/shots a red fox");
  assert.equal(parsed.prompt, "a red fox");
  assert.equal(parsed.outDir, "/tmp/shots");
});

test("--out-dir values keep quoted paths with spaces intact", () => {
  const doubled = parseImagenArgs('a red fox --out-dir "my shots 2026"');
  assert.equal(doubled.outDir, "my shots 2026");
  assert.equal(doubled.prompt, "a red fox");
  const single = parseImagenArgs("a red fox --out-dir '/tmp/my shots'");
  assert.equal(single.outDir, "/tmp/my shots");
});

test("--out-dir is removed from anywhere without disturbing the prompt", () => {
  const parsed = parseImagenArgs("a red --out-dir /tmp/shots fox in snow");
  assert.equal(parsed.prompt, "a red fox in snow");
  assert.equal(parsed.outDir, "/tmp/shots");
});

test("--out-dir without a value throws a usage error naming the flag", () => {
  assert.throws(() => parseImagenArgs("a red fox --out-dir"), /--out-dir requires a value/);
});

test("--out-dir= with an empty value throws a usage error", () => {
  assert.throws(() => parseImagenArgs("a red fox --out-dir="), /--out-dir requires a value/);
});

test("--out-dir followed by another flag counts as a missing value", () => {
  assert.throws(
    () => parseImagenArgs("a red fox --out-dir --model nano-banana-2"),
    /--out-dir requires a value/,
  );
});

test("--out-dir combines with --model in one invocation", () => {
  const parsed = parseImagenArgs("a red fox --model nano-banana-2 --out-dir /tmp/shots");
  assert.equal(parsed.prompt, "a red fox");
  assert.equal(parsed.modelId, "nano-banana-2");
  assert.equal(parsed.outDir, "/tmp/shots");
});

test("no --out-dir leaves outDir undefined", () => {
  const parsed = parseImagenArgs("a red fox --model nano-banana-2");
  assert.equal(parsed.outDir, undefined);
});
