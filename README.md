# pi-img-gen

Image-generation capability for **pi** and **gentle-shell**. The package registers a
provider-neutral `images` implementation that speaks the OpenAI-compatible
`POST {baseUrl}/images/generations` protocol, so `models.generateImages()` works for
providers whose models declare `api: "openai-images"` — previously it failed with
`getImagesApiProvider("openai-images") is undefined`.

- Provider-neutral core transport + a per-provider **profile table** (v1 ships one verified profile: `opendesign`).
- A `/imagen` command with two forms: direct generation (`/imagen <prompt> --model <id>`, works headless) and an overlay wizard (bare `/imagen`).
- Handles both response shapes: `data[0].b64_json` and `data[0].url` (downloads the bytes).
- Detects the image MIME type by **magic bytes** (JPEG/PNG/GIF/WebP), never from the URL — signed URLs carry no extension, and a real gateway response served a JPEG behind a `.img` URL.
- Maps HTTP errors and aborts to `stopReason: "error"` / `"aborted"` with an `errorMessage`. It never throws (mirrors pi-ai's `openrouter-images.js`).

## Install

### pi

```bash
pi install git:github.com/maiconcrespo/pi-img-gen   # straight from git
pi list                            # verify it is configured
```

Try it for one invocation without installing:

```bash
pi -e ./pi-img-gen
```

### gentle-shell

`gentle-shell` forwards package commands to pi against its isolated home
(`~/.gentle-shell/agent`):

```bash
gentle-shell install git:github.com/maiconcrespo/pi-img-gen
gentle-shell list
gentle-shell remove git:github.com/maiconcrespo/pi-img-gen
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
>
> The package now verifies this dependency early: a settings.json "doctor" runs
> before every `/imagen` invocation and stops before any generation if the line is
> missing or edited. Expect an error notification like `settings.json (…) has an
> "extensions" array without the exact entry "-builtin:codemode" … Fix: add
> "extensions": ["-builtin:codemode"] to settings.json.`

## Usage

### `/imagen` — two forms

```text
/imagen a red fox in the snow --model nano-banana-2   # direct generation, no overlay
/imagen                                                # opens the overlay wizard (TUI only)
```

**Direct form** — `/imagen <prompt text> [--model <id>] [--out-dir <path>]` generates
immediately without opening any UI, so it works in every mode including headless
RPC/JSON runs, where custom terminal components do not exist. `--model` may appear
before or after the prompt, `--model=<id>` is accepted, quotes group words, and an
unknown or valueless `--model` is reported as a usage error before any request goes
out.

**Output directory** — `--out-dir <path>` / `--out-dir=<path>` chooses the directory
where the generated image and its `meta.json` are saved, on **both** forms — including
generations started from the overlay wizard. Missing directories are created
recursively. Without the flag, images go to the default layout under `~/imagenes`
(see [Output layout](#output-layout)). A valueless `--out-dir` is reported as a usage
error before any request goes out.

```text
/imagen a red fox in the snow --out-dir ~/shots/foxes   # saves into ~/shots/foxes
```

**Overlay form** — a bare `/imagen` opens a floating wizard (TUI only):

- persistent header: active model, its measured latency note, the size it will send,
  and the model's size quirk (e.g. `seedream-5.0` rejects sizes below 1920x1920);
- model picker over the **image-type models from the model registry** (today: the five
  opendesign models — `nano-banana-2-lite`, `nano-banana-2`, `seedream-5.0-pro`,
  `gpt-image-2`, `seedream-5.0`) with `↑`/`↓` navigation;
- prompt textarea with an IME-correct hardware cursor (`Focusable` + `CURSOR_MARKER`);
- keys: `Tab`/`Shift+Tab` switch panes · `↑`/`↓` navigate · `Enter` generate ·
  `Esc` cancel (while generating, `Esc` aborts the request) · `Shift+Enter` inserts a
  newline;
- live progress: the overlay shows an elapsed-seconds line (typical latencies run
  6s–80s+, varying ±50–70% run to run) and mirrors it into the status bar, so a slow
  request never looks hung;
- `stopReason: "error"` / `"aborted"` messages are displayed in the overlay instead
  of being swallowed, and failures are also reported as error notifications.

The style-preset ("skill") picker is phase **T5**: the header already renders a preset
line when a preset list is supplied, but no preset logic ships yet (`preset: null` in
`meta.json`). Reference images are **out of scope** — see below.

The last model generated with is persisted as the default for the next run:

```text
<agent-dir>/imagen-state.json        # { "version": 1, "lastModel": "nano-banana-2" }
```

`<agent-dir>` is pi's agent directory — `~/.pi/agent`, or `~/.gentle-shell/agent` when
running under gentle-shell — resolved through the host's `getAgentDir()` and
overridable with `PI_CODING_AGENT_DIR`. The file is plain JSON and safe to delete.

### Output layout

Every successful generation writes:

```text
~/imagenes/<YYYYMMDD-HHmm>-<slug>/
├── <model>.<jpg|png|gif|webp>   # extension comes from the block's mimeType ONLY
└── meta.json                    # reproducibility record
```

- `<YYYYMMDD-HHmm>` is the local save time; `<slug>` is the slugified prompt (lowercase
  ASCII, hyphen-separated, ≤48 chars; `image` when the prompt contains no ASCII
  alphanumerics, e.g. pure CJK/emoji).
- The extension is derived from the response block's `mimeType` (`image/jpeg`→`.jpg`,
  `image/png`→`.png`, `image/gif`→`.gif`, `image/webp`→`.webp`) — **never** from a URL
  or an id. Unknown types become `.bin`.
- If the directory already exists (same prompt within the same minute), `-2`, `-3`, …
  is appended; nothing is ever overwritten.
- `meta.json`:

  ```json
  {
    "model": "nano-banana-2",
    "provider": "opendesign",
    "prompt": "a red fox in the snow",
    "preset": null,
    "sizeSent": "1024x1024",
    "mimeType": "image/jpeg",
    "savedAt": "2026-10-07T08:05:00.000Z",
    "latencyMs": 15240,
    "stopReason": "stop"
  }
  ```

**With `--out-dir <path>`** the stamp-slug directory is skipped entirely: the image
and its `meta.json` are written directly into that directory (created recursively
when missing). Nothing is ever overwritten there either — when a file of the same
name already exists, a numeric suffix is appended (`nano-banana-2-2.png`,
`meta-2.json`). If the path exists but is not a directory, or is not writable, the
failure is reported as an error notification naming the path.

### Reference images: out of scope (v1)

There is **no reference/paste/attachment UI**. The opendesign gateway cannot consume
reference images (T3 live probe: `POST /v1/images/edits` returns 404 for both multipart
and JSON, and every reference field on `/v1/images/generations` is silently ignored —
garbage behaves exactly like valid input, and all responses route as text-to-image), so
building that input would only offer a control that cannot work. The transport keeps
its `buildRequestBody` seam open for a gateway that does accept `image` blocks.

## What it does (and does not do)

This is the **capability layer**: it registers an `images` implementation per
profile — no model-list changes, no `baseUrl` rewrites:

```ts
pi.registerProvider("opendesign", {
  images: { "openai-images": { generateImages } },
});
```

The registration deliberately passes **no `models`, no `baseUrl`, no
`refreshModels`**. `registerProvider()` is a shallow field-level merge with any
existing registration of the same provider; supplying `models` would *replace* the
model list of the bridge registration and break chat.

On top of it sits the **UX layer** — the `/imagen` command (`src/command.ts`) and its
overlay wizard (`src/overlay.ts`, opened with `ctx.ui.custom()`), documented under
[Usage](#usage--imagen--two-forms). The two layers are independent: the capability
works from any code path that calls `models.generateImages()`, with or without the UI.

## Design: two layers, provider-neutral core

| Layer | Where | Contents |
|---|---|---|
| 1. Transport | `src/generate.ts` | Generic OpenAI-compatible `/images/generations` client, response normalization, magic-byte MIME detection, error mapping. **No provider strings.** |
| 2. Profiles | `src/profiles.ts` | One row per provider: provider id, images api key, base URL, per-model default sizes, min-pixel rules. |

Reference images (`image` blocks in the input) are **not supported by the
opendesign gateway build** (verified 2026-10-07, see below): the transport returns
a clear error result (`reference images not supported yet by this endpoint build`)
instead of guessing. The `buildRequestBody` seam stays open for providers whose
gateways do accept image input.

## Measured model table (opendesign gateway, 2026-10-07)

| Model | Typical latency | Size sent |
|---|---|---|
| `nano-banana-2-lite` | ~6s | 1024x1024 |
| `nano-banana-2` | ~15s | 1024x1024 |
| `seedream-5.0-pro` | ~47s | 1024x1024 |
| `gpt-image-2` | ~81s | 1024x1024 |
| `seedream-5.0` | — | **1920x1920** (rejects <3.7MP with HTTP 400) |

Live verification (2026-10-07, all five models, real gateway): latencies vary
±50–70% run to run — treat the table as labels, not a contract. The `nano-banana`
pair **overrides the requested size** (asked 1024x1024, returned 1408x768); the
other three honor it. Output MIME is detected from magic bytes and never from the
URL: the gateway returns JPEG for seedream/nano-banana and PNG for gpt-image-2.
Error mapping verified live: HTTP 400 (size floor) and HTTP 404 (unknown model)
both surface status + body snippet in `errorMessage`, never a thrown error.

Reference-image probe (2026-10-07): `POST /v1/images/edits` returns 404 (both
multipart and JSON), and `POST /v1/images/generations` is strict JSON whose extra
reference fields (`image`, `input_images`, `image_url`, `init_image`, `mask`, …)
are **silently ignored** — garbage values behave identically to valid ones, and
every response routes as `.../text-to-image`. The catalog's
`input_modalities: ["text", "image"]` is not backed by any reachable image-input
channel.

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

## Known limitations

1. **Provider protocol.** The transport speaks exactly one protocol: an
   OpenAI-compatible `POST {baseUrl}/images/generations` endpoint. Providers with
   custom or private image protocols are not supported out of the box — they need
   a profile row in `src/profiles.ts` (for endpoint/size quirks on a compatible
   API) or a config adjustment / separate transport for genuinely different
   wire formats.
2. **Inline image display in the TUI.** Rendering the generated image inside the
   terminal depends on terminal graphics protocols (Kitty graphics / iTerm2
   inline / SIXEL). In a terminal without them, open the generated file
   externally from `~/imagenes/…` instead.
3. **Prompt/parameter quality depends on the host LLM.** This package does not
   improve prompts or pick parameters for you. Per-profile parameter validation
   now rejects unsupported sizes locally before the HTTP call (e.g. a
   `seedream-5.0` request below its 1920x1920 floor) with an actionable
   `errorMessage`, instead of surfacing a provider HTTP 400.
4. **Synchronous request/response.** Generation is a blocking request with no
   live progress preview of the image being produced; the overlay only shows
   elapsed time while the request runs.

## Tested environments

The verified environment is the maintainer's **Linux** workstation (Linux +
Homebrew/linuxbrew tooling). Other setups — macOS, Windows/WSL, other package
managers — are **untested**.

Regardless of OS, inline image rendering in the TUI depends on terminal
graphics support (Kitty graphics / iTerm2 inline / SIXEL); see
[Known limitations](#known-limitations). The same code on another OS may run
fine yet still show no inline preview in a terminal without those protocols.

## Portability

- **No machine-specific values** ship in the package: paths resolve through pi's
  agent directory (`getAgentDir()`, overridable with `PI_CODING_AGENT_DIR`) and
  the documented output layout; nothing is hardcoded to a specific host.
- **API key resolution chain:** `models.json` `apiKey` → provider auth →
  environment. The resolved key is sent as `Authorization: Bearer <key>`; it is
  never stored by this package.
- **`settings.json` dependency:** the
  `"extensions": ["-builtin:codemode"]` line (see the warning under
  [Install](#install)) is a portability constraint — when moving to another
  machine, the target's `settings.json` (e.g.
  `~/.gentle-shell/agent/settings.json`) must reproduce that exact
  configuration or the `/imagen` workflow breaks.
- **Secret hygiene:** never hardcode API keys in code, configs, or docs. Use
  `.env` (kept out of version control via `.gitignore`) or the environment, and
  run secret scanning (e.g. gitleaks) before publishing.

## Development

```bash
npm test    # node --test test/*.test.ts  (Node >= 24, runs TypeScript natively)
```

The tests mock fetch through `options.fetch` and cover: `b64_json` success, `url`
success with magic-byte MIME (JPEG behind a `.img` URL), HTTP 400 mapping (the
seedream 3.7MP rejection text surfaces in `errorMessage`), abort mapping,
reference-image rejection, per-model size defaults, auth headers, the
registration shape (images-only, no `models`/`baseUrl`/`refreshModels`), plus the
UX layer's pure logic: `/imagen` argument parsing, prompt slugging and output
naming (including unicode/punctuation prompts), mimeType→extension mapping, the
`meta.json` shape and the save routine (through an injected filesystem), prompt
text wrapping/cursor placement, model-picker presentation data and model
resolution, the persisted-default state file, and headless command dispatch
(the CLI form never opens the overlay, and every stopReason surfaces visibly).
The overlay rendering itself is exercised interactively (`pi -e ./pi-img-gen`),
not by the unit suite.
