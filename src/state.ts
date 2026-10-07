/**
 * Persisted `/imagen` state: the last model the user generated with, reused
 * as the default selection for the next invocation.
 *
 * Location: `<agent-dir>/imagen-state.json` (extensions.md "State" →
 * "Durable data excluded from model context" / "Data outside one session →
 * External storage"). `<agent-dir>` is pi's `getAgentDir()` — `~/.pi/agent` by
 * default, `~/.gentle-shell/agent` for gentle-shell, overridable with
 * `PI_CODING_AGENT_DIR`.
 *
 * Parsing is tolerant: a missing, corrupt, or partially-invalid file behaves
 * like "no default" instead of breaking the command.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** File name inside the agent directory. */
export const STATE_FILE_NAME = "imagen-state.json";

export interface ImagenState {
  version: 1;
  /** Model id of the last successful generation, or null when never set. */
  lastModel: string | null;
}

export const DEFAULT_STATE: ImagenState = Object.freeze({ version: 1, lastModel: null });

/** Parse state JSON; any garbage yields the default state. */
export function parseState(text: string): ImagenState {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const lastModel = (parsed as { lastModel?: unknown }).lastModel;
      if (typeof lastModel === "string" && lastModel.length > 0) {
        return { version: 1, lastModel };
      }
    }
  } catch {
    // fall through to the default state
  }
  return { version: 1, lastModel: DEFAULT_STATE.lastModel };
}

/** Serialize state as stable, human-editable JSON. */
export function serializeState(state: ImagenState): string {
  return `${JSON.stringify({ version: 1, lastModel: state.lastModel ?? null }, null, 2)}\n`;
}

/** Read the state file; missing/unreadable files mean "no default". */
export async function readState(path: string): Promise<ImagenState> {
  try {
    return parseState(await readFile(path, "utf8"));
  } catch {
    return { version: 1, lastModel: DEFAULT_STATE.lastModel };
  }
}

/** Write the state file, creating the agent directory when needed. */
export async function writeState(path: string, state: ImagenState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeState(state), "utf8");
}
