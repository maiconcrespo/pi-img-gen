/**
 * pi-imagen — image-generation capability for pi and gentle-shell.
 *
 * Registers ONLY the `images` implementation for each verified profile.
 * Deliberately passes NO `models`, NO `baseUrl`, NO `refreshModels`:
 * `pi.registerProvider()` is a shallow field-level merge with any existing
 * registration of the same provider (the opendesign bridge registers the
 * provider with its model list). Supplying `models` would REPLACE that model
 * list and break chat; `baseUrl` would rewrite every model's endpoint.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { generateImages } from "./generate.ts";
import { PROFILES } from "./profiles.ts";

export default function piImagen(pi: ExtensionAPI): void {
  for (const profile of PROFILES) {
    pi.registerProvider(profile.providerId, {
      // ONE map per registration: the whole `images` map replaces on merge,
      // so every api key of this provider belongs in this single map.
      // Key MUST equal the `api` value the provider's models.json declares.
      images: { [profile.imagesApi]: { generateImages } },
    });
  }
}

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
