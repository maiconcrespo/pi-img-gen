/**
 * CLI argument parsing for `/imagen`.
 *
 * The slash command hands the handler the raw argument string exactly as the
 * user typed it, so parsing is string-level and deliberately small:
 * quote-aware tokenization, `--model <id>` / `--model=<id>` removed from
 * anywhere in the input, everything else is prompt text.
 *
 * Forms:
 *   /imagen a red fox                      → prompt only (overlay wizard not needed)
 *   /imagen a red fox --model nano-banana-2 → direct generation, works headless
 *   /imagen --model nano-banana-2           → opens the overlay with that model preselected
 */

/** Parsed `/imagen` invocation. `prompt` is empty when only flags were given. */
export interface ImagenInvocation {
  prompt: string;
  /** `--model` value, present only when the flag was given. */
  modelId?: string;
}

const MODEL_FLAG = "--model";
const MODEL_FLAG_PREFIX = `${MODEL_FLAG}=`;

/** Usage error raised for malformed flags; the command reports it as a notification. */
export function usageError(message: string): Error {
  return new Error(message);
}

/**
 * Split raw command text into tokens. Single and double quotes group words and
 * are stripped; an unterminated quote simply consumes the rest of the input.
 */
export function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let open = false;

  for (const ch of raw) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      open = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (open) tokens.push(current);
      current = "";
      open = false;
      continue;
    }
    current += ch;
    open = true;
  }
  if (open) tokens.push(current);
  return tokens;
}

/** Parse the raw `/imagen` argument string into prompt + optional model id. */
export function parseImagenArgs(raw: string): ImagenInvocation {
  const tokens = tokenize(raw ?? "");
  const promptParts: string[] = [];
  let modelId: string | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    if (token === MODEL_FLAG) {
      const value = tokens[i + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw usageError(`${MODEL_FLAG} requires a value: /imagen <prompt> --model <image-model-id>`);
      }
      modelId = value;
      i += 1;
      continue;
    }

    if (token.startsWith(MODEL_FLAG_PREFIX)) {
      const value = token.slice(MODEL_FLAG_PREFIX.length);
      if (value.length === 0) {
        throw usageError(`${MODEL_FLAG} requires a value: /imagen <prompt> --model <image-model-id>`);
      }
      modelId = value;
      continue;
    }

    promptParts.push(token);
  }

  const prompt = promptParts.join(" ").trim();
  return modelId === undefined ? { prompt } : { prompt, modelId };
}
