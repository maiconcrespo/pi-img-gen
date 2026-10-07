/**
 * Provider profile table for the pi-imagen image-generation capability.
 *
 * Layer 2 of the two-layer design: the transport (generate.ts) is a generic
 * OpenAI-compatible `POST {baseUrl}/images/generations` client with no
 * provider-specific strings. Everything that differs per provider lives here
 * as one profile row. Adding another provider = one profile row + verification
 * tests, never a transport refactor.
 *
 * Compatibility rule (pi docs, custom-provider.md): profiles describe
 * VERIFIED differences only. v1 ships exactly one verified profile.
 */

/** Per-provider quirks consumed by the generic transport. */
export interface ImageProviderProfile {
  /** Provider id passed to `pi.registerProvider()`; must match `model.provider`. */
  providerId: string;
  /**
   * Key inside the provider's `images` map. MUST equal the `api` value the
   * provider's models.json declares on its image models — lookup is
   * per-model `api` (`extensionImages[model.api]`).
   */
  imagesApi: string;
  /** Endpoint base used when a model carries no `baseUrl` of its own. */
  baseUrl: string;
  /** Default `size` for models without a specific entry. */
  defaultSize: string;
  /** Per-model default sizes (model id → "WIDTHxHEIGHT"). */
  modelSizes: Readonly<Record<string, string>>;
  /**
   * Per-model verified minimum pixel counts (model id → pixels). The gateway
   * rejects sizes below the minimum with HTTP 400; the entry records the
   * verified working floor for that model.
   */
  minPixels?: Readonly<Record<string, number>>;
}

/** Fallback size for any model without a profile entry. */
export const DEFAULT_SIZE = "1024x1024";

/**
 * The verified opendesign gateway profile (v1: the only verified profile).
 * Measured 2026-10-07 against the `/v1/images/generations` endpoint.
 */
export const OPENDESIGN_PROFILE: ImageProviderProfile = {
  providerId: "opendesign",
  imagesApi: "openai-images",
  baseUrl: "https://amr-link.open-design.ai/v1",
  defaultSize: DEFAULT_SIZE,
  modelSizes: {
    // seedream-5.0 rejects anything below ~3.7MP with HTTP 400;
    // 1920x1920 is the verified minimum that passes.
    "seedream-5.0": "1920x1920",
  },
  minPixels: {
    "seedream-5.0": 1920 * 1920,
  },
};

/** All profiles the extension registers. Adding a provider = one more row. */
export const PROFILES: readonly ImageProviderProfile[] = [OPENDESIGN_PROFILE];

/** Image models measured against the opendesign gateway (2026-10-07). */
export const OPENDESIGN_IMAGE_MODELS = [
  "nano-banana-2-lite",
  "nano-banana-2",
  "seedream-5.0-pro",
  "gpt-image-2",
  "seedream-5.0",
] as const;

/**
 * Flat model → default-size map for the verified models, for the future UI
 * layer. Unknown models resolve through {@link resolveDefaultSize} instead.
 */
export const DEFAULT_SIZES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(OPENDESIGN_IMAGE_MODELS.map((id) => [id, resolveDefaultSize(OPENDESIGN_PROFILE, id)])),
);

/** Look up the profile for a provider id; undefined for unprofiled providers. */
export function getProfile(providerId: string): ImageProviderProfile | undefined {
  return PROFILES.find((profile) => profile.providerId === providerId);
}

/** Effective default `size` for a model under a profile. */
export function resolveDefaultSize(profile: ImageProviderProfile, modelId: string): string {
  return profile.modelSizes[modelId] ?? profile.defaultSize;
}
