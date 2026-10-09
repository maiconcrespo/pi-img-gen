/**
 * Behavior tests for the generic images transport (src/generate.ts).
 * Plain `node --test` with fetch mocked through `options.fetch`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ImageApi, ImageModel, ImagesContext } from "@earendil-works/pi-ai";
import { REFERENCE_IMAGES_UNSUPPORTED_MESSAGE, generateImages } from "../src/generate.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const PNG_B64 = Buffer.from(PNG_BYTES).toString("base64");
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const JPEG_B64 = Buffer.from(JPEG_BYTES).toString("base64");

const PROFILE_ENDPOINT = "https://amr-link.open-design.ai/v1/images/generations";

function imageModel(overrides: Partial<ImageModel<ImageApi>> = {}): ImageModel<ImageApi> {
  return {
    type: "image",
    id: "seedream-5.0",
    name: "Seedream 5.0",
    api: "openai-images",
    provider: "opendesign",
    baseUrl: "",
    input: ["text"],
    output: ["image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  } as ImageModel<ImageApi>;
}

function textContext(...texts: string[]): ImagesContext {
  return { input: texts.map((text) => ({ type: "text" as const, text })) };
}

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

function recordFetch(route: Route): { calls: RecordedCall[]; fetchImpl: typeof fetch } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return route(url, init);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function sentBody(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(String(call.init?.body));
}

// ---------------------------------------------------------------------------
// Success paths
// ---------------------------------------------------------------------------

test("b64_json success: stop result, magic-byte MIME, profile endpoint", async () => {
  const { calls, fetchImpl } = recordFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
  const result = await generateImages(imageModel(), textContext("a red fox in snow"), {
    apiKey: "test-key",
    fetch: fetchImpl,
  });

  assert.equal(result.stopReason, "stop");
  assert.equal(result.errorMessage, undefined);
  assert.equal(result.output.length, 1);
  assert.deepEqual(result.output[0], { type: "image", data: PNG_B64, mimeType: "image/png" });
  assert.equal(result.provider, "opendesign");
  assert.equal(result.model, "seedream-5.0");
  assert.equal(result.api, "openai-images");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, PROFILE_ENDPOINT);
});

test("request body carries response_format b64_json, n:1 and the profile size for seedream-5.0", async () => {
  const { calls, fetchImpl } = recordFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
  await generateImages(imageModel(), textContext("a red fox"), { apiKey: "test-key", fetch: fetchImpl });

  const init = calls[0].init!;
  assert.equal(init.method, "POST");
  assert.deepEqual(sentBody(calls[0]), {
    model: "seedream-5.0",
    prompt: "a red fox",
    n: 1,
    size: "1920x1920",
    response_format: "b64_json",
  });
  const headers = init.headers as Record<string, string>;
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["Authorization"], "Bearer test-key");
});

test("request body: models without a profile size entry default to 1024x1024", async () => {
  const { calls, fetchImpl } = recordFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
  await generateImages(imageModel({ id: "nano-banana-2" }), textContext("a red fox"), {
    apiKey: "k",
    fetch: fetchImpl,
  });
  assert.equal(sentBody(calls[0]).size, "1024x1024");
});

test("url success: downloads bytes, MIME from magic bytes not from the URL (JPEG behind .img)", async () => {
  const signedUrl = "https://cdn.open-design.ai/gen/2026-10-07/result.img?X-Signature=abc123";
  const { calls, fetchImpl } = recordFetch((url) => {
    if (url === PROFILE_ENDPOINT) return jsonResponse({ data: [{ url: signedUrl }] });
    // Signed URLs carry no extension info; the payload is a JPEG despite ".img".
    return new Response(JPEG_BYTES, { status: 200, headers: { "content-type": "application/octet-stream" } });
  });

  const result = await generateImages(imageModel(), textContext("a red fox"), {
    apiKey: "k",
    fetch: fetchImpl,
  });

  assert.equal(result.stopReason, "stop");
  assert.equal(result.output.length, 1);
  const image = result.output[0] as { type: string; data: string; mimeType: string };
  assert.equal(image.type, "image");
  assert.equal(image.mimeType, "image/jpeg");
  assert.equal(image.data, JPEG_B64);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, signedUrl);
});

test("prompt is the concatenation of the text blocks", async () => {
  const { calls, fetchImpl } = recordFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
  await generateImages(imageModel(), textContext("first part", "second part"), {
    apiKey: "k",
    fetch: fetchImpl,
  });
  assert.equal(sentBody(calls[0]).prompt, "first part\nsecond part");
});

test("usage is mapped best-effort and onResponse sees the HTTP status", async () => {
  const { fetchImpl } = recordFetch(() =>
    jsonResponse({
      data: [{ b64_json: PNG_B64 }],
      usage: { input_tokens: 7, output_tokens: 11, total_tokens: 18 },
    }),
  );
  const seen: number[] = [];
  const result = await generateImages(imageModel(), textContext("x"), {
    apiKey: "k",
    fetch: fetchImpl,
    onResponse: (response) => {
      seen.push(response.status);
    },
  });

  assert.ok(result.usage);
  assert.equal(result.usage!.input, 7);
  assert.equal(result.usage!.output, 11);
  assert.equal(result.usage!.totalTokens, 18);
  assert.deepEqual(seen, [200]);
});

test("onPayload replacement is what gets sent", async () => {
  const { calls, fetchImpl } = recordFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
  await generateImages(imageModel(), textContext("x"), {
    apiKey: "k",
    fetch: fetchImpl,
    onPayload: (payload) => ({ ...(payload as Record<string, unknown>), size: "2048x2048" }),
  });
  assert.equal(sentBody(calls[0]).size, "2048x2048");
});

// ---------------------------------------------------------------------------
// Pre-flight size validation — fails locally, before any HTTP call
// ---------------------------------------------------------------------------

test("below-minimum size for seedream-5.0 fails validation locally with an actionable message and no HTTP call", async () => {
  const { calls, fetchImpl } = recordFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
  const result = await generateImages(imageModel(), textContext("a red fox"), {
    apiKey: "k",
    fetch: fetchImpl,
    onPayload: (payload) => ({ ...(payload as Record<string, unknown>), size: "1024x1024" }),
  });

  assert.equal(result.stopReason, "error");
  assert.deepEqual(result.output, []);
  assert.match(result.errorMessage ?? "", /seedream-5\.0/);
  assert.match(result.errorMessage ?? "", /1024x1024/);
  assert.match(result.errorMessage ?? "", /3686400/);
  assert.match(result.errorMessage ?? "", /1920x1920/);
  assert.equal(calls.length, 0);
});

test("malformed size reaching the request fails validation locally with no HTTP call", async () => {
  const { calls, fetchImpl } = recordFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
  const result = await generateImages(imageModel(), textContext("a red fox"), {
    apiKey: "k",
    fetch: fetchImpl,
    onPayload: (payload) => ({ ...(payload as Record<string, unknown>), size: "banana" }),
  });

  assert.equal(result.stopReason, "error");
  assert.deepEqual(result.output, []);
  assert.match(result.errorMessage ?? "", /"banana"/);
  assert.match(result.errorMessage ?? "", /WIDTHxHEIGHT/);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// Endpoint resolution and auth
// ---------------------------------------------------------------------------

test("model.baseUrl wins over the profile baseUrl; trailing slashes are normalized", async () => {
  const { calls, fetchImpl } = recordFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
  await generateImages(imageModel({ baseUrl: "https://custom.example/v1/" }), textContext("x"), {
    apiKey: "k",
    fetch: fetchImpl,
  });
  assert.equal(calls[0].url, "https://custom.example/v1/images/generations");
});

test("API key from options.metadata.apiKey is accepted as a fallback", async () => {
  const { calls, fetchImpl } = recordFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
  await generateImages(imageModel(), textContext("x"), {
    fetch: fetchImpl,
    metadata: { apiKey: "metadata-key" },
  });
  const headers = calls[0].init!.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer metadata-key");
});

test("missing API key is an error result, not a throw", async () => {
  const { calls, fetchImpl } = recordFetch(() => jsonResponse({ data: [] }));
  const result = await generateImages(imageModel(), textContext("x"), { fetch: fetchImpl });
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /API key/i);
  assert.deepEqual(result.output, []);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// Error and abort mapping (never throws — mirrors pi-ai openrouter-images.js)
// ---------------------------------------------------------------------------

test("HTTP 400 maps to an error result surfacing the gateway message (seedream 3.7MP rejection)", async () => {
  const gatewayBody = JSON.stringify({
    error: {
      message:
        "Image generation failed: requested size 1024x1024 (1.05 MP) is below the minimum of 3.7 megapixels required for seedream-5.0",
      type: "invalid_request_error",
      code: "image_size_too_small",
    },
  });
  const { fetchImpl } = recordFetch(
    () =>
      new Response(gatewayBody, {
        status: 400,
        statusText: "Bad Request",
        headers: { "content-type": "application/json" },
      }),
  );

  const result = await generateImages(imageModel(), textContext("a red fox"), {
    apiKey: "k",
    fetch: fetchImpl,
  });
  assert.equal(result.stopReason, "error");
  assert.deepEqual(result.output, []);
  assert.match(result.errorMessage ?? "", /HTTP 400/);
  assert.match(result.errorMessage ?? "", /3\.7 megapixels/);
});

test("abort maps to stopReason aborted with an errorMessage", async () => {
  const controller = new AbortController();
  controller.abort();
  const { fetchImpl } = recordFetch(() => {
    throw new DOMException("The operation was aborted.", "AbortError");
  });

  const result = await generateImages(imageModel(), textContext("a red fox"), {
    apiKey: "k",
    fetch: fetchImpl,
    signal: controller.signal,
  });
  assert.equal(result.stopReason, "aborted");
  assert.deepEqual(result.output, []);
  assert.ok(result.errorMessage);
});

test("network failures are error results, never throws", async () => {
  const { fetchImpl } = recordFetch(() => {
    throw new TypeError("fetch failed");
  });
  const result = await generateImages(imageModel(), textContext("x"), {
    apiKey: "k",
    fetch: fetchImpl,
  });
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /fetch failed/);
});

test("response without image data maps to an error result", async () => {
  const { fetchImpl } = recordFetch(() => jsonResponse({ data: [] }));
  const result = await generateImages(imageModel(), textContext("x"), {
    apiKey: "k",
    fetch: fetchImpl,
  });
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /no image data/i);
});

test("failed download of a url response maps to an error result", async () => {
  const { fetchImpl } = recordFetch((url) => {
    if (url === PROFILE_ENDPOINT) return jsonResponse({ data: [{ url: "https://cdn.example.com/gone.png" }] });
    return new Response("expired", { status: 403, statusText: "Forbidden" });
  });
  const result = await generateImages(imageModel(), textContext("x"), {
    apiKey: "k",
    fetch: fetchImpl,
  });
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /HTTP 403/);
  assert.deepEqual(result.output, []);
});

// ---------------------------------------------------------------------------
// Reference images (unverified endpoint shape — explicit seam)
// ---------------------------------------------------------------------------

test("reference image blocks return a clear unsupported error without a network call", async () => {
  const { calls, fetchImpl } = recordFetch(() => jsonResponse({ data: [] }));
  const context: ImagesContext = {
    input: [
      { type: "text", text: "make it like this" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ],
  };

  const result = await generateImages(imageModel(), context, { apiKey: "k", fetch: fetchImpl });
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, REFERENCE_IMAGES_UNSUPPORTED_MESSAGE);
  assert.equal(result.errorMessage, "reference images not supported yet by this endpoint build");
  assert.deepEqual(result.output, []);
  assert.equal(calls.length, 0);
});
