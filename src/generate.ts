/**
 * Generic OpenAI-compatible image-generation transport.
 *
 * `POST {baseUrl}/images/generations` with normalized handling for both
 * response shapes (`data[0].b64_json` and `data[0].url`), magic-bytes MIME
 * detection, and error/abort mapping. Contains NO provider-specific strings:
 * per-provider quirks come from the profile table (profiles.ts).
 *
 * Contract (pi-ai types + pi-ai's openrouter-images.js reference): this
 * function NEVER throws. Failures become `stopReason: "error"` results with an
 * `errorMessage`; cancellation becomes `"aborted"`.
 */
import type {
  AssistantImages,
  ImageApi,
  ImageModel,
  ImagesContext,
  ImagesOptions,
  Usage,
} from "@earendil-works/pi-ai";
import { DEFAULT_SIZE, type ImageProviderProfile, getProfile, resolveDefaultSize, validateSize } from "./profiles.ts";

const GENERATIONS_PATH = "/images/generations";
const ERROR_SNIPPET_CHARS = 400;

/** Returned when context.input contains image blocks; endpoint shape is UNVERIFIED (probe task pending). */
export const REFERENCE_IMAGES_UNSUPPORTED_MESSAGE = "reference images not supported yet by this endpoint build";

/** The `/images/generations` payload. Kept as an exported seam: the reference-image field shape is unverified, so image blocks are rejected upstream until a probe task resolves it. */
export interface ImageGenerationRequest {
  model: string;
  prompt: string;
  n: number;
  size: string;
  response_format: "b64_json";
}

// ---------------------------------------------------------------------------
// Magic-byte MIME detection — never derive MIME from URLs or extensions
// (signed URLs carry none; real case: a JPEG served behind a `.img` URL).
// ---------------------------------------------------------------------------

export function detectMime(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 6) {
    const head = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
    if (head === "GIF87a" || head === "GIF89a") {
      return "image/gif";
    }
    const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (
      riff === "RIFF" &&
      bytes.length >= 12 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return "image/webp";
    }
  }
  return "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

/** Prompt = concatenated text blocks; also reports whether image blocks are present. */
function extractPrompt(context: ImagesContext): { prompt: string; hasReferenceImage: boolean } {
  const textBlocks: string[] = [];
  let hasReferenceImage = false;
  for (const block of context.input) {
    if (block.type === "text") {
      textBlocks.push(block.text);
    } else {
      hasReferenceImage = true;
    }
  }
  return { prompt: textBlocks.join("\n"), hasReferenceImage };
}

/** Build the `/images/generations` payload. Exported as the seam a future reference-image probe extends. */
export function buildRequestBody(model: ImageModel<ImageApi>, prompt: string, size: string): ImageGenerationRequest {
  return { model: model.id, prompt, n: 1, size, response_format: "b64_json" };
}

/** Model baseUrl first, else the active profile's; trailing slashes normalized. */
function resolveEndpoint(model: ImageModel<ImageApi>, profile: ImageProviderProfile | undefined): string | undefined {
  const base = (model.baseUrl ?? "").trim() || profile?.baseUrl;
  if (!base) return undefined;
  return `${base.replace(/\/+$/, "")}${GENERATIONS_PATH}`;
}

function applyHeaderRecord(target: Record<string, string>, source: Record<string, string | null> | undefined): void {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") target[key] = value;
  }
}

function requestHeaders(
  model: ImageModel<ImageApi>,
  apiKey: string,
  options: ImagesOptions | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  applyHeaderRecord(headers, model.headers);
  applyHeaderRecord(headers, options?.headers);
  return headers;
}

function apiKeyFrom(options: ImagesOptions | undefined): string | undefined {
  if (typeof options?.apiKey === "string" && options.apiKey.length > 0) return options.apiKey;
  const metadataKey = options?.metadata?.apiKey;
  if (typeof metadataKey === "string" && metadataKey.length > 0) return metadataKey;
  return undefined;
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function fail(output: AssistantImages, stopReason: "error" | "aborted", errorMessage: string): AssistantImages {
  output.output = [];
  output.stopReason = stopReason;
  output.errorMessage = errorMessage;
  return output;
}

function snippet(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > ERROR_SNIPPET_CHARS ? `${compact.slice(0, ERROR_SNIPPET_CHARS)}…` : compact;
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && (error as { name: unknown }).name === "AbortError");
}

/** Best-effort usage mapping; the images API does not consistently report usage. */
function bestEffortUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const pick = (...keys: string[]): number => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return 0;
  };
  const input = pick("input_tokens", "input");
  const output = pick("output_tokens", "output");
  const cacheRead = pick("cache_read_tokens", "cacheRead");
  const cacheWrite = pick("cache_write_tokens", "cacheWrite");
  const totalTokens = pick("total_tokens", "totalTokens") || input + output + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function base64ToBytes(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, "base64"));
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

interface DataItem {
  b64_json?: unknown;
  url?: unknown;
}

function firstDataItem(parsed: unknown): DataItem | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const first = data[0];
  return first && typeof first === "object" ? (first as DataItem) : undefined;
}

/**
 * Generate images for one request. Implements the pi-ai `ProviderImages`
 * contract: resolves auth and endpoint, sends the request, normalizes both
 * response shapes, and maps every failure to a result — never throws.
 */
export async function generateImages(
  model: ImageModel<ImageApi>,
  context: ImagesContext,
  options?: ImagesOptions,
): Promise<AssistantImages> {
  const output: AssistantImages = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    output: [],
    stopReason: "stop",
    timestamp: Date.now(),
  };

  try {
    const profile = getProfile(model.provider);
    const { prompt, hasReferenceImage } = extractPrompt(context);

    // Reference-image endpoint shape is UNVERIFIED; fail clearly instead of guessing.
    if (hasReferenceImage) {
      return fail(output, "error", REFERENCE_IMAGES_UNSUPPORTED_MESSAGE);
    }

    const apiKey = apiKeyFrom(options);
    if (!apiKey) {
      return fail(output, "error", `No API key for provider: ${model.provider}`);
    }

    const endpoint = resolveEndpoint(model, profile);
    if (!endpoint) {
      return fail(output, "error", `No base URL for provider: ${model.provider}`);
    }

    const size = profile ? resolveDefaultSize(profile, model.id) : DEFAULT_SIZE;
    // Pre-flight size validation at the resolution site: fail with the actionable
    // reason before building a payload or touching the network.
    const resolvedSize = validateSize(model.id, profile, size);
    if (!resolvedSize.ok) {
      return fail(output, "error", resolvedSize.reason);
    }
    let payload: unknown = buildRequestBody(model, prompt, resolvedSize.size);
    if (options?.onPayload) {
      const replacement = await options.onPayload(payload, model);
      if (replacement !== undefined) payload = replacement;
    }
    // The onPayload seam can rewrite the size; validate the effective request
    // too — an invalid size must never reach the provider.
    const effectiveSize = (payload as { size?: unknown } | null | undefined)?.size;
    if (typeof effectiveSize === "string") {
      const checked = validateSize(model.id, profile, effectiveSize);
      if (!checked.ok) {
        return fail(output, "error", checked.reason);
      }
    }

    const doFetch = options?.fetch ?? globalThis.fetch;
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: requestHeaders(model, apiKey, options),
      body: JSON.stringify(payload),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    if (options?.onResponse) {
      await options.onResponse({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
    }

    if (!response.ok) {
      const body = snippet(await response.text());
      const statusText = response.statusText ? ` ${response.statusText}` : "";
      return fail(
        output,
        "error",
        `image generation request failed (HTTP ${response.status}${statusText})${body ? `: ${body}` : ""}`,
      );
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail(output, "error", `image generation returned invalid JSON: ${snippet(text)}`);
    }

    const item = firstDataItem(parsed);
    if (!item) {
      return fail(output, "error", `image generation response contained no image data: ${snippet(text)}`);
    }

    let bytes: Uint8Array;
    let data: string;
    if (typeof item.b64_json === "string" && item.b64_json.length > 0) {
      data = item.b64_json;
      bytes = base64ToBytes(data);
    } else if (typeof item.url === "string" && item.url.length > 0) {
      const download = await doFetch(item.url, { ...(options?.signal ? { signal: options.signal } : {}) });
      if (!download.ok) {
        return fail(output, "error", `failed to download generated image (HTTP ${download.status})`);
      }
      bytes = new Uint8Array(await download.arrayBuffer());
      data = bytesToBase64(bytes);
    } else {
      return fail(output, "error", `image generation response contained neither b64_json nor url: ${snippet(text)}`);
    }

    output.output.push({ type: "image", data, mimeType: detectMime(bytes) });

    // Best-effort extras: many OpenAI-compatible gateways omit both.
    if (typeof (parsed as { id?: unknown }).id === "string") {
      output.responseId = (parsed as { id: string }).id;
    }
    const usage = bestEffortUsage((parsed as { usage?: unknown }).usage);
    if (usage) output.usage = usage;

    return output;
  } catch (error) {
    const aborted = options?.signal?.aborted === true || isAbortError(error);
    return fail(output, aborted ? "aborted" : "error", errorMessageOf(error));
  }
}
