# pi-imagen

Image-generation capability for **pi** and **gentle-shell**. The package registers a
provider-neutral `images` implementation that speaks the OpenAI-compatible
`POST {baseUrl}/images/generations` protocol, so `models.generateImages()` works for
providers whose models declare `api: "openai-images"` — previously it failed with
`getImagesApiProvider("openai-images") is undefined`.

- Provider-neutral core transport + a per-provider **profile table** (v1 ships one verified profile: `opendesign`).
- Handles both response shapes: `data[0].b64_json` and `data[0].url` (downloads the bytes).
- Detects the image MIME type by **magic bytes** (JPEG/PNG/GIF/WebP), never from the URL — signed URLs carry no extension, and a real gateway response served a JPEG behind a `.img` URL.
- Maps HTTP errors and aborts to `stopReason: "error"` / `"aborted"` with an `errorMessage`. It never throws (mirrors pi-ai's `openrouter-images.js`).

## Install

### pi

```bash
pi install npm:pi-imagen          # once published to npm
pi install git:github.com/<org>/<repo>   # or straight from git
pi list                            # verify it is configured
```

Try it for one invocation without installing:

```bash
pi -e ./pi-imagen
```

### gentle-shell

`gentle-shell` forwards package commands to pi against its isolated home
(`~/.gentle-shell/agent`):

```bash
gentle-shell install npm:pi-imagen
gentle-shell list
gentle-shell remove npm:pi-imagen
```

### Requirements

- The target provider must already define its image models (via `models.json` or an
  existing provider extension such as the opendesign bridge), with
  `"api": "openai-images"` on each image model.
- pi must be able to resolve an API key for that provider (models.json `apiKey`,
  provider auth, or environment). The resolved key is sent as `Authorization: Bearer <key>`.

> **Warning — never touch this settings.json line:**
> Do not remove or edit `"extensions": ["-builtin:codemode"]` from `settings.json`
> (e.g. `~/.gentle-shell/agent/settings.json`). The `/imagen` workflow depends on that
> exact configuration.

## What it does (and does not do)

This is the **capability layer** only. It registers an `images` implementation per
profile — no commands, no UI, no model list changes:

```ts
pi.registerProvider("opendesign", {
  images: { "openai-images": { generateImages } },
});
```

The registration deliberately passes **no `models`, no `baseUrl`, no
`refreshModels`**. `registerProvider()` is a shallow field-level merge with any
existing registration of the same provider; supplying `models` would *replace* the
model list of the bridge registration and break chat.

The **UX layer** — a `/imagen` overlay (model picker, style-preset picker, prompt
input, reference image, output directory with `meta.json`) — comes later as a
separate overlay on top of this capability.

## Design: two layers, provider-neutral core

| Layer | Where | Contents |
|---|---|---|
| 1. Transport | `src/generate.ts` | Generic OpenAI-compatible `/images/generations` client, response normalization, magic-byte MIME detection, error mapping. **No provider strings.** |
| 2. Profiles | `src/profiles.ts` | One row per provider: provider id, images api key, base URL, per-model default sizes, min-pixel rules. |

Reference images (`image` blocks in the input) are **not yet supported**: the
endpoint shape is unverified, so the transport returns a clear error result
(`reference images not supported yet by this endpoint build`) instead of guessing.
A later probe task will resolve the shape and extend the `buildRequestBody` seam.

## Measured model table (opendesign gateway, 2026-10-07)

| Model | Typical latency | Size sent |
|---|---|---|
| `nano-banana-2-lite` | ~6s | 1024x1024 |
| `nano-banana-2` | ~15s | 1024x1024 |
| `seedream-5.0-pro` | ~47s | 1024x1024 |
| `gpt-image-2` | ~81s | 1024x1024 |
| `seedream-5.0` | — | **1920x1920** (rejects <3.7MP with HTTP 400) |

Sizes come from the profile table; the UI layer can read them from the exported
`DEFAULT_SIZES` map or `resolveDefaultSize(profile, modelId)`.

## Adding another provider

Adding a provider is **one profile row + verification tests — never a refactor**:

1. Add a row to `PROFILES` in `src/profiles.ts`:

   ```ts
   {
     providerId: "example",                    // matches model.provider / registerProvider name
     imagesApi: "openai-images",               // MUST equal the `api` value models.json declares
     baseUrl: "https://api.example.com/v1",
     defaultSize: "1024x1024",
     modelSizes: { "big-model": "2048x2048" }, // per-model defaults, if verified
     minPixels: { "big-model": 2048 * 2048 },  // verified rejection floor, if any
   }
   ```

2. Add verification tests (request body, response shapes, error mapping) against
   that gateway. Profiles describe **verified** differences only — do not add flags
   for behavior that has not been measured.

The transport in `src/generate.ts` needs no changes.

## Development

```bash
npm test    # node --test test/*.test.ts  (Node >= 24, runs TypeScript natively)
```

The tests mock fetch through `options.fetch` and cover: `b64_json` success, `url`
success with magic-byte MIME (JPEG behind a `.img` URL), HTTP 400 mapping (the
seedream 3.7MP rejection text surfaces in `errorMessage`), abort mapping,
reference-image rejection, per-model size defaults, auth headers, and the
registration shape (images-only, no `models`/`baseUrl`/`refreshModels`).
