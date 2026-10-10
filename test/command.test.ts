/**
 * Command dispatch for `/imagen` (src/command.ts).
 *
 * Contract under test: the CLI form (`/imagen <prompt> --model <id>`) must run
 * end to end WITHOUT the overlay — it has to work headless (RPC/JSON/print
 * modes have no custom UI) — and every stopReason must surface visibly.
 *
 * The settings.json doctor runs BEFORE any generation or overlay: on findings
 * the actionable message goes through the existing error notification path and
 * the workflow stops with no request made. Tests inject the doctor so no unit
 * test touches the real filesystem.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runImagenCommand, type GenerationPayload, type ImagenCommandOptions } from "../src/command.ts";
import type { DoctorFinding } from "../src/doctor.ts";
import type { SaveGenerationInput } from "../src/output.ts";

interface Recorded {
  customCalls: number;
  notes: { message: string; type: string | undefined }[];
  statuses: (string | undefined)[];
  generated: { modelId: string; context: unknown; hasSignal: boolean }[];
  generateCalls: number;
}

/** Doctor stub for tests that exercise the happy path. */
const doctorPasses = async (): Promise<DoctorFinding[]> => [];

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

/** Extras for the happy path: a returned image block and/or a wizard outcome. */
interface CtxExtras {
  image?: { mimeType: string; data: string };
  customResult?: unknown;
}

function fakeCtx(
  rec: Recorded,
  mode: "tui" | "json" = "json",
  stopReason: "error" | "aborted" = "error",
  availableModels?: () => unknown[],
  extras?: CtxExtras,
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
        return extras?.customResult ?? ({ action: "cancel" as const });
      },
    },
    modelRegistry: {
      getAvailableOfType: async () => (availableModels ? availableModels() : [model]),
      getModelsOfType: () => [model],
      generateImages: async (m: { id: string }, context: unknown, options?: { signal?: AbortSignal }) => {
        rec.generateCalls++;
        rec.generated.push({ modelId: m.id, context, hasSignal: Boolean(options?.signal) });
        if (extras?.image) {
          return {
            api: "openai-images",
            provider: "opendesign",
            model: m.id,
            output: [{ type: "image", mimeType: extras.image.mimeType, data: extras.image.data }],
            stopReason: "stop" as const,
            timestamp: Date.now(),
          };
        }
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
  const opts: ImagenCommandOptions = { statePath: null, doctor: doctorPasses };
  await runImagenCommand("a red fox --model nano-banana-2", fakeCtx(rec, "json"), opts);

  assert.equal(rec.customCalls, 0, "headless modes must not open the overlay");
  assert.equal(rec.generateCalls, 1, "exactly one generation request");
  assert.equal(rec.generated[0].modelId, "nano-banana-2");
  assert.deepEqual(rec.generated[0].context, { input: [{ type: "text", text: "a red fox" }] });
});

test("a failing stopReason is reported visibly, not swallowed", async () => {
  const rec = recorder();
  await runImagenCommand("a red fox", fakeCtx(rec, "json", "error"), { statePath: null, doctor: doctorPasses });
  const notify = rec.notes.map((n) => n.message).join("\n");
  assert.match(notify, /HTTP 500 gateway exploded/);
  assert.equal(rec.notes.some((n) => n.type === "error"), true, "failure must be an error notification");
  assert.equal(rec.statuses.at(-1), undefined, "status text must be cleared after the run");
});

test("an aborted stopReason is reported visibly as well", async () => {
  const rec = recorder();
  await runImagenCommand("a red fox", fakeCtx(rec, "json", "aborted"), { statePath: null, doctor: doctorPasses });
  const notify = rec.notes.map((n) => n.message).join("\n");
  assert.match(notify, /request aborted by user/);
});

test("no args outside the TUI reports how to run it instead of failing silently", async () => {
  const rec = recorder();
  await runImagenCommand("", fakeCtx(rec, "json"), { statePath: null, doctor: doctorPasses });
  assert.equal(rec.generateCalls, 0);
  assert.equal(rec.customCalls, 0);
  const notify = rec.notes.map((n) => n.message).join("\n");
  assert.match(notify, /\/imagen <prompt>/);
});

test("an unusable --model value is reported before any request goes out", async () => {
  const rec = recorder();
  await runImagenCommand("a red fox --model does-not-exist", fakeCtx(rec, "json"), { statePath: null, doctor: doctorPasses });
  assert.equal(rec.generateCalls, 0);
  const notify = rec.notes.map((n) => n.message).join("\n");
  assert.match(notify, /does-not-exist/);
});

test("a malformed --model flag is reported as a usage error", async () => {
  const rec = recorder();
  await runImagenCommand("a red fox --model", fakeCtx(rec, "json"), { statePath: null, doctor: doctorPasses });
  assert.equal(rec.generateCalls, 0);
  const notify = rec.notes.map((n) => n.message).join("\n");
  assert.match(notify, /--model requires a value/);
});

test("the CLI form stays direct even in TUI mode", async () => {
  const rec = recorder();
  await runImagenCommand("a red fox --model nano-banana-2", fakeCtx(rec, "tui"), { statePath: null, doctor: doctorPasses });
  assert.equal(rec.customCalls, 0, "a prompt argument must never open the overlay");
  assert.equal(rec.generateCalls, 1);
});

test("image models without resolvable credentials fall back to the full model list", async () => {
  const rec = recorder();
  await runImagenCommand("a red fox", fakeCtx(rec, "json", "error", () => []), { statePath: null, doctor: doctorPasses });
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
  await runImagenCommand("a red fox", emptyBoth as never, { statePath: null, doctor: doctorPasses });
  assert.equal(rec.generateCalls, 0);
  assert.equal(rec.customCalls, 0);
  const notify = rec.notes.map((n) => n.message).join("\n");
  assert.match(notify, /[Nn]o image models/);
  assert.equal(rec.notes.some((n) => n.type === "error"), true);
});

// ---------------------------------------------------------------------------
// settings.json doctor wiring — fail early, fail actionable
// ---------------------------------------------------------------------------

const doctorFinding: DoctorFinding = {
  code: "required-entry-missing",
  message:
    'settings.json (/home/tester/.pi/agent/settings.json) has an "extensions" array without the required entry "-builtin:codemode". Fix: add "extensions": ["-builtin:codemode"] to settings.json.',
};

test("doctor findings stop the CLI form before any generation", async () => {
  const rec = recorder();
  await runImagenCommand("a red fox --model nano-banana-2", fakeCtx(rec, "json"), {
    statePath: null,
    doctor: async () => [doctorFinding],
  });
  assert.equal(rec.generateCalls, 0, "no request may go out when the doctor fails");
  assert.equal(rec.customCalls, 0);
  assert.equal(rec.notes.length, 1);
  assert.equal(rec.notes[0].type, "error", "findings surface through the error notification path");
  assert.equal(rec.notes[0].message, doctorFinding.message);
});

test("doctor findings keep the overlay from ever opening", async () => {
  const rec = recorder();
  await runImagenCommand("", fakeCtx(rec, "tui"), {
    statePath: null,
    doctor: async () => [doctorFinding],
  });
  assert.equal(rec.customCalls, 0, "the wizard must not open when the doctor fails");
  assert.equal(rec.generateCalls, 0);
  const notify = rec.notes.map((n) => n.message).join("\n");
  assert.match(notify, /-builtin:codemode/);
});

test("every finding is surfaced, not just the first", async () => {
  const rec = recorder();
  const second: DoctorFinding = { code: "settings-not-found", message: "settings.json is missing. Fix: add \"extensions\": [\"-builtin:codemode\"]." };
  await runImagenCommand("a red fox", fakeCtx(rec, "json"), {
    statePath: null,
    doctor: async () => [doctorFinding, second],
  });
  assert.equal(rec.generateCalls, 0);
  assert.deepEqual(rec.notes.map((n) => n.message), [doctorFinding.message, second.message]);
});

test("a healthy doctor lets the flow proceed unchanged", async () => {
  const rec = recorder();
  await runImagenCommand("a red fox --model nano-banana-2", fakeCtx(rec, "json"), {
    statePath: null,
    doctor: async () => [],
  });
  assert.equal(rec.generateCalls, 1, "generation proceeds when the doctor passes");
});

test("a doctor that throws is reported as an error, never propagated", async () => {
  const rec = recorder();
  await runImagenCommand("a red fox", fakeCtx(rec, "json"), {
    statePath: null,
    doctor: async () => {
      throw new Error("doctor exploded");
    },
  });
  assert.equal(rec.generateCalls, 0);
  const notify = rec.notes.map((n) => n.message).join("\n");
  assert.match(notify, /doctor exploded/);
  assert.equal(rec.notes.some((n) => n.type === "error"), true);
});

// ---------------------------------------------------------------------------
// --out-dir wiring: the flag must reach the output layer on both forms
// ---------------------------------------------------------------------------

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");

function captureSaver(sink: SaveGenerationInput[]) {
  return async (input: SaveGenerationInput) => {
    sink.push(input);
    return { dir: input.outDir ?? input.root, imagePath: "/stub/image.png", metaPath: "/stub/meta.json" };
  };
}

test("--out-dir reaches the output layer on the direct form", async () => {
  const rec = recorder();
  const saved: SaveGenerationInput[] = [];
  const tmpRoot = await mkdtemp(join(tmpdir(), "imagen-cmd-"));
  try {
    await runImagenCommand(
      "a red fox --model nano-banana-2 --out-dir /home/u/shots",
      fakeCtx(rec, "json", "error", undefined, { image: { mimeType: "image/png", data: PNG_BASE64 } }),
      { statePath: null, doctor: doctorPasses, outputRoot: tmpRoot, save: captureSaver(saved) },
    );
    assert.equal(saved.length, 1, "exactly one save must happen");
    assert.equal(saved[0].outDir, "/home/u/shots", "the parsed outDir must reach the save step");
    assert.equal(saved[0].prompt, "a red fox", "the prompt must survive flag removal");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("without --out-dir the save step keeps the default output root", async () => {
  const rec = recorder();
  const saved: SaveGenerationInput[] = [];
  const tmpRoot = await mkdtemp(join(tmpdir(), "imagen-cmd-"));
  const outputRoot = join(tmpRoot, "imagenes");
  try {
    await runImagenCommand(
      "a red fox --model nano-banana-2",
      fakeCtx(rec, "json", "error", undefined, { image: { mimeType: "image/png", data: PNG_BASE64 } }),
      { statePath: null, doctor: doctorPasses, outputRoot, save: captureSaver(saved) },
    );
    assert.equal(saved.length, 1);
    assert.equal(saved[0].outDir, undefined, "no outDir means the legacy layout");
    assert.equal(saved[0].root, outputRoot, "the default root is untouched");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

// The wizard form runs through src/overlay.ts, which value-imports
// @earendil-works/pi-tui. Without that peer dependency installed the module
// cannot load, so the wizard path cannot run in this environment; the test is
// skipped with that exact reason and executes where the dependency exists.
const overlayAvailable = await import("../src/overlay.ts").then(() => true, () => false);

test(
  "--out-dir reaches the output layer for wizard-initiated generations",
  {
    skip: overlayAvailable
      ? false
      : "src/overlay.ts cannot load without the @earendil-works/pi-tui peer dependency",
  },
  async () => {
    const rec = recorder();
    const saved: SaveGenerationInput[] = [];
    const tmpRoot = await mkdtemp(join(tmpdir(), "imagen-wizard-"));
    try {
      const payload: GenerationPayload = {
        modelId: "nano-banana-2",
        provider: "opendesign",
        prompt: "a fox from the wizard",
        mimeType: "image/png",
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        sizeSent: "1024x1024",
        latencyMs: 1200,
      };
      const ctx = fakeCtx(rec, "tui", "error", undefined, {
        customResult: { action: "generate", modelId: "nano-banana-2", prompt: payload.prompt, value: payload },
      });
      await runImagenCommand("--out-dir /home/u/shots", ctx, {
        statePath: null,
        doctor: doctorPasses,
        outputRoot: tmpRoot,
        save: captureSaver(saved),
      });
      assert.equal(saved.length, 1, "the wizard generation must reach the save step");
      assert.equal(saved[0].outDir, "/home/u/shots", "--out-dir must apply to wizard runs too");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  },
);
