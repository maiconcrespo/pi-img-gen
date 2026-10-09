/**
 * pi-img-gen — image-generation capability + `/imagen` UX for pi and gentle-shell.
 *
 * Two layers (README "Design: two layers"):
 * 1. Capability — registers ONLY the `images` implementation for each verified
 *    profile. Deliberately passes NO `models`, NO `baseUrl`, NO
 *    `refreshModels`: `pi.registerProvider()` is a shallow field-level merge
 *    with any existing registration of the same provider (the opendesign bridge
 *    registers the provider with its model list). Supplying `models` would
 *    REPLACE that model list and break chat; `baseUrl` would rewrite every
 *    model's endpoint.
 * 2. UX — the `/imagen` command: a prompt argument generates directly (works
 *    headless, where custom UI does not exist); no argument opens the overlay
 *    wizard in the TUI (src/overlay.ts).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runImagenCommand } from "./command.ts";
import { generateImages } from "./generate.ts";
import { OPENDESIGN_IMAGE_MODELS, PROFILES } from "./profiles.ts";

export default function piImagen(pi: ExtensionAPI): void {
  for (const profile of PROFILES) {
    pi.registerProvider(profile.providerId, {
      // ONE map per registration: the whole `images` map replaces on merge,
      // so every api key of this provider belongs in this single map.
      // Key MUST equal the `api` value the provider's models.json declares.
      images: { [profile.imagesApi]: { generateImages } },
    });
  }

  pi.registerCommand("imagen", {
    description:
      "Generate an image: /imagen <prompt text> [--model <id>] generates directly, /imagen alone opens the overlay wizard",
    getArgumentCompletions: (prefix) => {
      if (prefix.startsWith("-")) {
        return prefix.startsWith("--model")
          ? [{ value: "--model", label: "--model <image-model-id>" }]
          : null;
      }
      const matches = OPENDESIGN_IMAGE_MODELS.filter((id) => id.startsWith(prefix));
      return matches.length > 0 ? matches.map((id) => ({ value: id, label: id })) : null;
    },
    handler: async (args, ctx) => {
      await runImagenCommand(args, ctx);
    },
  });
}

export { runImagenCommand, resolveStatePath, STATUS_KEY } from "./command.ts";
export type { GenerationPayload, GenerateOutcome, ImagenCommandOptions } from "./command.ts";
export { generateImages, REFERENCE_IMAGES_UNSUPPORTED_MESSAGE, buildRequestBody, detectMime } from "./generate.ts";
export {
  DEFAULT_SIZE,
  DEFAULT_SIZES,
  OPENDESIGN_IMAGE_MODELS,
  OPENDESIGN_PROFILE,
  PROFILES,
  type ImageProviderProfile,
  getProfile,
  resolveDefaultSize,
} from "./profiles.ts";
export { LATENCY_VARIANCE_NOTE, MODEL_NOTES, presentModels, resolveModelId } from "./present.ts";
export type { ModelNote, ModelResolution, ModelRow } from "./present.ts";
export { parseImagenArgs, tokenize } from "./imagen-args.ts";
export type { ImagenInvocation } from "./imagen-args.ts";
export {
  MAX_SLUG_LENGTH,
  buildMeta,
  buildOutputPaths,
  extensionForMime,
  formatStamp,
  saveGeneration,
  slugifyPrompt,
} from "./output.ts";
export type { ImagenMeta, OutputPaths, SaveGenerationInput, SaveIo, SavedImage } from "./output.ts";
export { DEFAULT_STATE, STATE_FILE_NAME, parseState, readState, serializeState, writeState } from "./state.ts";
export type { ImagenState } from "./state.ts";
export { displayWidth, rowIndexForCursor, wrapRows } from "./textlayout.ts";
export type { PromptRow } from "./textlayout.ts";
