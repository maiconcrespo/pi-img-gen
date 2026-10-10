# Code Review Rules

You are reviewing changes in **pi-img-gen**, a TypeScript ESM Pi extension
package. Apply these rules literally. When a rule is violated: REJECT the
change and name the violated rule.

## Secrets (strict — check this FIRST)

REJECT:

- Any hardcoded API key, token, password, credential, or secret of any kind,
  in any file: source, tests, fixtures, config, docs, scripts, workflows.
- Secret values in logs, error messages, debug output, test snapshots, or
  example commands — never print key values.
- Real credentials in example/placeholder files (placeholders only).
- Committed `.env` files. Local secrets live in `.env`, which is gitignored.

PREFER:

- Keys resolve at runtime in this order: models.json `apiKey` → provider auth
  → environment variables. Never inline a key to make something "work".
- Reference credentials by variable name (`IMAGE_API_KEY`), never by value.
- Redact anything echoed or logged (mirror `gitleaks --redact`).

## Repo conventions

REJECT:

- Import specifiers without `.ts` extensions. This is TypeScript ESM with
  direct `.ts` imports (e.g. `import { generate } from "./generate.ts"`).
- Any `throw` in the image transport (`src/generate.ts`). The transport NEVER
  throws: errors map to `stopReason: "error"` / `"aborted"` plus `errorMessage`.
- Provider-specific strings (endpoints, model names, quirks) outside the
  profile table (`src/profiles.ts`). "Adding a provider = one profile row" —
  never a transport edit.
- Bypassing the `validateSize` pre-flight contract (requests must be validated
  before they reach the provider).
- Behavior changes without tests. Test-first: a behavior change needs its
  failing test written before the implementation.

PREFER:

- Keep `src/generate.ts` provider-neutral; put every provider difference in
  `src/profiles.ts`.
- Tests via `node --test test/*.test.ts`, behavioral rather than
  implementation-coupled.
- Small, focused diffs over drive-by refactors.

## Quick checklist

1. Secrets rule first — scan the full diff, including fixtures and docs.
2. Transport invariants intact: never throws; `validateSize` honored.
3. Provider logic lives only in the profile table.
4. Imports are direct `.ts` ESM specifiers.
5. Behavior changes carry tests, green under `node --test`.

## Blocking scope (what justifies REJECT)

REJECT only when an explicit REJECT rule above is violated (secrets first).
Style preferences, test-robustness opinions, naming tastes, path-construction
preferences, or refactoring suggestions that no rule above names are
NON-BLOCKING: report them only as non-blocking notes, never as REJECT.
When uncertain whether a rule is violated, it is not violated.
