/**
 * Persisted default-model state (src/state.ts): tolerant parsing, stable
 * serialization. The file lives at <agent-dir>/imagen-state.json.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_STATE, STATE_FILE_NAME, parseState, serializeState } from "../src/state.ts";

test("state file lives in the agent directory", () => {
  assert.equal(STATE_FILE_NAME, "imagen-state.json");
});

test("parseState reads a valid state file", () => {
  assert.deepEqual(parseState('{"version":1,"lastModel":"nano-banana-2"}'), {
    version: 1,
    lastModel: "nano-banana-2",
  });
});

test("parseState tolerates garbage instead of throwing", () => {
  for (const raw of ["", "not json", "null", "[]", '"str"', "{}", '{"lastModel":42}', '{"lastModel":""}']) {
    assert.deepEqual(parseState(raw), DEFAULT_STATE, `unexpected result for ${JSON.stringify(raw)}`);
  }
});

test("serializeState round-trips and ends with a newline", () => {
  const text = serializeState({ version: 1, lastModel: "gpt-image-2" });
  assert.ok(text.endsWith("\n"));
  assert.deepEqual(parseState(text), { version: 1, lastModel: "gpt-image-2" });
});

test("serializeState writes null when there is no default model", () => {
  const text = serializeState({ version: 1, lastModel: null });
  assert.match(text, /"lastModel": null/);
  assert.deepEqual(parseState(text), DEFAULT_STATE);
});
