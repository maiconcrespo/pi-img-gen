/**
 * `/imagen` command dispatch — the UX layer entry point.
 *
 * Two forms, one handler (README "Usage"):
 *
 *   /imagen <prompt text> [--model <id>] → direct generation, NO overlay.
 *     Works in every mode: RPC/JSON/print have no custom UI (extensions.md
 *     "UI and modes"), so the CLI form must never touch ctx.ui.custom().
 *   /imagen [flags] → opens the overlay wizard (TUI mode only).
 *
 * Generation dogfoods the capability this package registers:
 * `ctx.modelRegistry.generateImages(model, { input: [{ type:"text", text }] })`,
 * which routes through our `images` implementation and applies the profile's
 * size defaults inside the transport.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ImageApi, ImageModel, ImagesOutputContent } from "@earendil-works/pi-ai";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseImagenArgs } from "./imagen-args.ts";
import { presentModels, resolveModelId, MODEL_NOTES } from "./present.ts";
import { saveGeneration } from "./output.ts";
import { DEFAULT_SIZE, getProfile, resolveDefaultSize } from "./profiles.ts";
import { STATE_FILE_NAME, readState, writeState } from "./state.ts";

/** Status-bar key for progress feedback (`ctx.ui.setStatus`). */
export const STATUS_KEY = "imagen";

/** Injection points for tests and alternative hosts. */
export interface ImagenCommandOptions {
  /** Output root; defaults to `~/imagenes`. */
  outputRoot?: string;
  /** State file path, or `null` to disable default-model persistence. */
  statePath?: string | null;
}

/** What a finished generation hands to the save step. */
export interface GenerationPayload {
  modelId: string;
  provider: string;
  prompt: string;
  mimeType: string;
  bytes: Uint8Array;
  sizeSent: string;
  latencyMs: number;
}

export type GenerateOutcome = { ok: true; value: GenerationPayload } | { ok: false; message: string };

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Resolve the agent directory for the state file; null when unavailable. */
export async function resolveStatePath(): Promise<string | null> {
  try {
    const config = await import("@earendil-works/pi-coding-agent");
    if (typeof config.getAgentDir === "function") return join(config.getAgentDir(), STATE_FILE_NAME);
  } catch {
    // host package not resolvable in this runtime — fall back to the env var
  }
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir && envDir.length > 0) {
    const expanded = envDir.startsWith("~") ? join(homedir(), envDir.slice(1)) : envDir;
    return join(expanded, STATE_FILE_NAME);
  }
  return null;
}

/** Image models with working credentials, falling back to every image model. */
async function listImageModels(ctx: ExtensionCommandContext): Promise<ImageModel<ImageApi>[]> {
  try {
    const available = await ctx.modelRegistry.getAvailableOfType("image");
    if (available.length > 0) return [...available];
  } catch {
    // auth probe failed — fall through to the full list
  }
  try {
    return [...ctx.modelRegistry.getModelsOfType("image")];
  } catch {
    return [];
  }
}

/** Size the transport will send for this model (mirrors generate.ts). */
function sizeSentFor(model: ImageModel<ImageApi>): string {
  const profile = getProfile(model.provider);
  return profile ? resolveDefaultSize(profile, model.id) : DEFAULT_SIZE;
}

function bytesFromBase64(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, "base64"));
}

/**
 * One generation round trip. Never throws: every stopReason comes back as an
 * outcome so the caller can show it (extensions.md: pi reports handler errors
 * rather than surfacing them — we report them ourselves, visibly).
 */
async function generateOnce(
  ctx: ExtensionCommandContext,
  model: ImageModel<ImageApi>,
  prompt: string,
  signal?: AbortSignal,
  onProgress?: (text: string) => void,
): Promise<GenerateOutcome> {
  const sizeSent = sizeSentFor(model);
  const latencyNote = MODEL_NOTES[model.id]?.latencyNote;
  const started = Date.now();
  onProgress?.(
    latencyNote
      ? `Generating with ${model.id}… typical ${latencyNote} (±50–70% run to run)`
      : `Generating with ${model.id}…`,
  );

  const result = await ctx.modelRegistry.generateImages(
    model,
    { input: [{ type: "text", text: prompt }] },
    signal ? { signal } : undefined,
  );
  const latencyMs = Date.now() - started;

  if (result.stopReason !== "stop") {
    const fallback =
      result.stopReason === "aborted" ? "Image generation was aborted." : "Image generation failed.";
    return { ok: false, message: result.errorMessage ?? fallback };
  }

  const image = result.output.find(
    (block): block is Extract<ImagesOutputContent, { type: "image" }> => block.type === "image",
  );
  if (!image) return { ok: false, message: "Image generation returned no image block." };

  return {
    ok: true,
    value: {
      modelId: model.id,
      provider: model.provider,
      prompt,
      mimeType: image.mimeType,
      bytes: bytesFromBase64(image.data),
      sizeSent,
      latencyMs,
    },
  };
}

/** Save the image and report the path back through the UI. */
async function persistGeneration(
  ctx: ExtensionCommandContext,
  payload: GenerationPayload,
  options: ImagenCommandOptions,
): Promise<void> {
  const root = options.outputRoot ?? join(homedir(), "imagenes");
  try {
    const saved = await saveGeneration({
      root,
      model: payload.modelId,
      provider: payload.provider,
      prompt: payload.prompt,
      mimeType: payload.mimeType,
      bytes: payload.bytes,
      sizeSent: payload.sizeSent,
      latencyMs: payload.latencyMs,
      stopReason: "stop",
    });
    const seconds = (payload.latencyMs / 1000).toFixed(1);
    ctx.ui.notify(`Saved ${payload.modelId} image in ${seconds}s: ${saved.imagePath}`, "info");
  } catch (error) {
    ctx.ui.notify(`Image generated but saving failed: ${messageOf(error)}`, "error");
  }
}

/** Persist the model as the next default; persistence failures are non-fatal. */
async function persistDefaultModel(path: string | null, modelId: string): Promise<void> {
  if (!path) return;
  try {
    await writeState(path, { version: 1, lastModel: modelId });
  } catch {
    // never fail the user-visible flow over a convenience default
  }
}

/** Headless-safe generation with visible progress and visible failures. */
async function runDirectGeneration(
  ctx: ExtensionCommandContext,
  model: ImageModel<ImageApi>,
  prompt: string,
  options: ImagenCommandOptions,
  statePath: string | null,
): Promise<void> {
  const latencyNote = MODEL_NOTES[model.id]?.latencyNote;
  ctx.ui.notify(
    latencyNote
      ? `Generating with ${model.id} (typical ${latencyNote}, varies ±50–70%)…`
      : `Generating with ${model.id}…`,
    "info",
  );

  const started = Date.now();
  ctx.ui.setStatus(STATUS_KEY, `imagen: ${model.id} 0s`);
  const ticker = setInterval(() => {
    const elapsed = Math.round((Date.now() - started) / 1000);
    ctx.ui.setStatus(STATUS_KEY, `imagen: ${model.id} ${elapsed}s`);
  }, 1000);

  let outcome: GenerateOutcome;
  try {
    outcome = await generateOnce(ctx, model, prompt);
  } finally {
    clearInterval(ticker);
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  if (!outcome.ok) {
    ctx.ui.notify(`Image generation failed: ${outcome.message}`, "error");
    return;
  }
  await persistGeneration(ctx, outcome.value, options);
  await persistDefaultModel(statePath, model.id);
}

/** Entry point behind `pi.registerCommand("imagen", …)`. */
export async function runImagenCommand(
  rawArgs: string,
  ctx: ExtensionCommandContext,
  options: ImagenCommandOptions = {},
): Promise<void> {
  let invocation;
  try {
    invocation = parseImagenArgs(rawArgs ?? "");
  } catch (error) {
    ctx.ui.notify(messageOf(error), "error");
    return;
  }

  // No prompt → the overlay wizard, which only exists in the TUI. Never reach
  // for custom components in RPC/JSON/print modes (extensions.md, "UI and modes").
  if (invocation.prompt.length === 0 && ctx.mode !== "tui") {
    ctx.ui.notify('No prompt given and the overlay needs the TUI. Usage: /imagen <prompt> [--model <id>]', "error");
    return;
  }

  const statePath = options.statePath === undefined ? await resolveStatePath() : options.statePath;
  const savedDefault = statePath ? ((await readState(statePath)).lastModel ?? undefined) : undefined;

  const models = await listImageModels(ctx);
  const resolution = resolveModelId(
    models.map((candidate) => candidate.id),
    invocation.modelId,
    savedDefault,
  );
  if ("error" in resolution) {
    ctx.ui.notify(resolution.error, "error");
    return;
  }
  const model = models.find((candidate) => candidate.id === resolution.id)!;

  if (invocation.prompt.length > 0) {
    await runDirectGeneration(ctx, model, invocation.prompt, options, statePath);
    return;
  }

  // Overlay wizard. The module is loaded lazily so headless runs (and the
  // unit tests) never pull in terminal-only code.
  let overlay: typeof import("./overlay.ts");
  try {
    overlay = await import("./overlay.ts");
  } catch (error) {
    ctx.ui.notify(`The /imagen overlay could not be loaded: ${messageOf(error)}`, "error");
    return;
  }

  const outcome = await overlay.runImagenWizard<GenerationPayload>(ctx, {
    models: presentModels(models, resolution.id),
    initialModelId: resolution.id,
    generate: (request) => {
      const target = models.find((candidate) => candidate.id === request.modelId) ?? model;
      return generateOnce(ctx, target, request.prompt, request.signal, request.onProgress);
    },
  });

  if (outcome.action !== "generate") {
    if (outcome.lastError) ctx.ui.notify(`Image generation cancelled: ${outcome.lastError}`, "warning");
    return;
  }
  await persistGeneration(ctx, outcome.value, options);
  await persistDefaultModel(statePath, outcome.modelId);
}
