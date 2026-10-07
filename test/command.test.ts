/**
 * Command dispatch for `/imagen` (src/command.ts).
 *
 * Contract under test: the CLI form (`/imagen <prompt> --model <id>`) must run
 * end to end WITHOUT the overlay — it has to work headless (RPC/JSON/print
 * modes have no custom UI) — and every stopReason must surface visibly.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runImagenCommand, type ImagenCommandOptions } from "../src/command.ts";

interface Recorded {
  customCalls: number;
  notes: { message: string; type: string | undefined }[];
  statuses: (string | undefined)[];
  generated: { modelId: string; context: unknown; hasSignal: boolean }[];
  generateCalls: number;
}

function fakeModel() {
  return {
    type: "image",
    id: "nano-banana-2",
    name: "Nano Banana 2",
    api: "openai-images",
    provider: "opendesign",
    baseUrl: "",
    input: ["text"],
    output: ["image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function fakeCtx(
  rec: Recorded,
  mode: "tui" | "json" = "json",
  stopReason: "error" | "aborted" = "error",
  availableModels?: () => unknown[],
) {
  const model = fakeModel();
  const ctx = {
    mode,
    hasUI: mode !== "json",
    ui: {
      notify: (message: string, type?: string) => {
        rec.notes.push({ message, type });
      },
      setStatus: (_key: string, text: string | undefined) => {
        rec.statuses.push(text);
      },
      custom: async () => {
        rec.customCalls++;
        return { action: "cancel" as const };
      },
    },
    modelRegistry: {
      getAvailableOfType: async () => (availableModels ? availableModels() : [model]),
      getModelsOfType: () => [model],
      generateImages: async (m: { id: string }, context: unknown, options?: { signal?: AbortSignal }) => {
        rec.generateCalls++;
        rec.generated.push({ modelId: m.id, context, hasSignal: Boolean(options?.signal) });
        return {
          api: "openai-images",
          provider: "opendesign",
          model: m.id,
          output: [],
          stopReason,
          errorMessage: stopReason === "aborted" ? "request aborted by user" : "HTTP 500 gateway exploded",
          timestamp: Date.now(),
        };
      },
    },
  };
  return ctx as unknown as ExtensionCommandContext;
}

function recorder(): Recorded {
  return { customCalls: 0, notes: [], statuses: [], generated: [], generateCalls: 0 };
}

test("CLI form generates without ever opening the overlay", async () => {
  const rec = recorder();
  const opts: ImagenCommandOptions = { statePath: null };
  await runImagenCommand("a red fox --model nano-banana-2", fakeCtx(rec, "json"), opts);

  assert.equal(rec.customCalls, 0, "headless modes must not open the overlay");
  assert.equal(rec.generateCalls, 1, "exactly one generation request");
  assert.equal(rec.generated[0].modelId, "nano-banana-2");
  assert.deepEqual(rec.generated[0].context, { input: [{ type: "text", text: "a red fox" }] });
});

test("a failing stopReason is reported visibly, not swallowed", async () => {
  const rec = recorder();
  await runImagenCommand("a red fox", fakeCtx(rec, "json", "error"), { statePath: null });
  const notify = rec.notes.map((n) => n.message).join("\n");
  assert.match(notify, /HTTP 500 gateway exploded/);
  assert.equal(rec.notes.some((n) => n.type === "error"), true, "failure must be an error notification");
  assert.equal(rec.statuses.at(-1), undefined, "status text must be cleared after the run");
});

test("an aborted stopReason is reported visibly as well", async () => {
  const rec = recorder();
  await runImagenCommand("a red fox", fakeCtx(rec, "json", "aborted"), { statePath: null });
  const notify = rec.notes.map((n) => n.message).join("\n");
  assert.match(notify, /request aborted by user/);
});

test("no args outside the TUI reports how to run it instead of failing silently", async () => {
  const rec = recorder();
  await runImagenCommand("", fakeCtx(rec, "json"), { statePath: null });
  assert.equal(rec.generateCalls, 0);
  assert.equal(rec.customCalls, 0);
  const notify = rec.notes.map((n) => n.message).join("\n");
  assert.match(notify, /\/imagen <prompt>/);
});

test("an unusable --model value is reported before any request goes out", async () => {
  const rec = recorder();
  await runImagenCommand("a red fox --model does-not-exist", fakeCtx(rec, "json"), { statePath: null });
  assert.equal(rec.generateCalls, 0);
  const notify = rec.notes.map((n) => n.message).join("\n");
  assert.match(notify, /does-not-exist/);
});

test("a malformed --model flag is reported as a usage error", async () => {
  const rec = recorder();
  await runImagenCommand("a red fox --model", fakeCtx(rec, "json"), { statePath: null });
  assert.equal(rec.generateCalls, 0);
  const notify = rec.notes.map((n) => n.message).join("\n");
  assert.match(notify, /--model requires a value/);
});

test("the CLI form stays direct even in TUI mode", async () => {
  const rec = recorder();
  await runImagenCommand("a red fox --model nano-banana-2", fakeCtx(rec, "tui"), { statePath: null });
  assert.equal(rec.customCalls, 0, "a prompt argument must never open the overlay");
  assert.equal(rec.generateCalls, 1);
});

test("image models without resolvable credentials fall back to the full model list", async () => {
  const rec = recorder();
  await runImagenCommand("a red fox", fakeCtx(rec, "json", "error", () => []), { statePath: null });
  assert.equal(rec.generateCalls, 1, "the unauthenticated list still yields a usable model");
  assert.equal(rec.generated[0].modelId, "nano-banana-2");
});

test("no image models at all is an explainable error, not a crash", async () => {
  const rec = recorder();
  const emptyBoth = {
    mode: "json",
    ui: {
      notify: (message: string, type?: string) => rec.notes.push({ message, type }),
      setStatus: () => undefined,
      custom: async () => {
        rec.customCalls++;
      },
    },
    modelRegistry: {
      getAvailableOfType: async () => [],
      getModelsOfType: () => [],
      generateImages: async () => {
        rec.generateCalls++;
        throw new Error("must not be called");
      },
    },
  };
  await runImagenCommand("a red fox", emptyBoth as never, { statePath: null });
  assert.equal(rec.generateCalls, 0);
  assert.equal(rec.customCalls, 0);
  const notify = rec.notes.map((n) => n.message).join("\n");
  assert.match(notify, /[Nn]o image models/);
  assert.equal(rec.notes.some((n) => n.type === "error"), true);
});
