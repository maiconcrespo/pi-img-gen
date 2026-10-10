/**
 * settings.json doctor — verify the one host configuration line the `/imagen`
 * workflow depends on, and fail EARLY when it is broken.
 *
 * The dependency (README "Warning — never touch this settings.json line"):
 * the Pi host settings.json `extensions` array must contain the exact entry
 * `"-builtin:codemode"`, e.g. `"extensions": ["-builtin:codemode"]`. When it
 * is missing or edited, the workflow used to die with a cryptic runtime
 * failure; the doctor turns that into an actionable finding naming the file,
 * the required entry, and the minimal fix.
 *
 * Design rules honored here:
 * - Pure, testable core (`checkSettingsJson`); IO is injected (`readFile`,
 *   `homedir`) so unit tests never touch the real filesystem.
 * - Never throws across the boundary: parse/IO problems become findings.
 * - Provider/host-neutral: settings locations are the two documented host
 *   homes, expanded via `os.homedir()`. No pi-internal API is required (the
 *   installed pi docs expose no extension-facing settings-read API; the
 *   file-based resolution below is the supported fallback).
 */
import { readFile as fsReadFile } from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";

/** The exact entry the settings.json `extensions` array must contain. */
export const REQUIRED_EXTENSION_ENTRY = "-builtin:codemode";

/** Stable shape of the minimal fix, quoted verbatim in every message. */
const FIX = '"extensions": ["-builtin:codemode"]';

export type DoctorFindingCode =
  | "settings-not-found"
  | "settings-unreadable"
  | "settings-unparseable"
  | "settings-invalid-shape"
  | "extensions-missing"
  | "extensions-not-array"
  | "required-entry-missing";

/** One actionable problem. Every message names the file, the required entry, and the fix. */
export interface DoctorFinding {
  code: DoctorFindingCode;
  message: string;
}

/** Injectable IO so tests never read the real filesystem. */
export interface DoctorIo {
  readFile: (path: string) => Promise<string>;
  homedir: () => string;
}

export interface LoadSettingsOptions {
  /** Explicit settings.json path; tried before the documented host homes. */
  settingsPath?: string;
  /** Text reader override (tests / alternative hosts). */
  readFile?: DoctorIo["readFile"];
  /** Home directory override (tests / alternative hosts). */
  homedir?: DoctorIo["homedir"];
}

export interface SettingsLoadResult {
  /** The parsed settings and the path it came from, when a candidate parsed. */
  loaded?: { path: string; settings: unknown };
  /** Load-time findings (missing / unreadable / unparseable); empty on success. */
  findings: DoctorFinding[];
}

/** The documented host homes for settings.json, in resolution order. */
export function defaultSettingsCandidates(home: string): string[] {
  return [
    join(home, ".gentle-shell", "agent", "settings.json"),
    join(home, ".pi", "agent", "settings.json"),
  ];
}

function finding(code: DoctorFindingCode, message: string): DoctorFinding {
  return { code, message };
}

/** Name the file in a message: `settings.json` or `settings.json (<path>)`. */
function fileLabel(path?: string): string {
  return path ? `settings.json (${path})` : "settings.json";
}

/**
 * Pure content check on an already-parsed settings value.
 * Findings when `extensions` is missing, not an array, or lacks the exact
 * entry `"-builtin:codemode"`; malformed shapes are findings too — this
 * function never throws. Extra array entries are fine.
 */
export function checkSettingsJson(settings: unknown, sourcePath?: string): DoctorFinding[] {
  const file = fileLabel(sourcePath);
  const need =
    `/imagen requires the entry "${REQUIRED_EXTENSION_ENTRY}" inside the "extensions" array. ` +
    `Fix: add ${FIX} to ${file}.`;

  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    return [
      finding(
        "settings-invalid-shape",
        `${file} is not a JSON object, so /imagen cannot find its dependency. ${need}`,
      ),
    ];
  }

  const extensions = (settings as { extensions?: unknown }).extensions;
  if (extensions === undefined) {
    return [finding("extensions-missing", `${file} has no "extensions" array. ${need}`)];
  }
  if (!Array.isArray(extensions)) {
    return [
      finding(
        "extensions-not-array",
        `${file} has an "extensions" value that is not an array. ${need}`,
      ),
    ];
  }
  const present = extensions.some(
    (entry) => entry === REQUIRED_EXTENSION_ENTRY,
  );
  if (!present) {
    return [
      finding(
        "required-entry-missing",
        `${file} has an "extensions" array without the exact entry "${REQUIRED_EXTENSION_ENTRY}" ` +
          `(other entries are fine). ${need}`,
      ),
    ];
  }
  return [];
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * Locate and parse the settings file: the explicit path first, then the
 * documented host homes. A missing candidate falls through to the next; the
 * first candidate that reads is the one that counts (corrupt content is
 * reported, never silently skipped). Missing/unreadable/unparseable files are
 * findings — this function never throws.
 */
export async function loadSettingsJson(options: LoadSettingsOptions = {}): Promise<SettingsLoadResult> {
  const read = options.readFile ?? ((path: string) => fsReadFile(path, "utf8"));
  const home = options.homedir ?? osHomedir;
  const candidates = options.settingsPath
    ? [options.settingsPath, ...defaultSettingsCandidates(home())]
    : defaultSettingsCandidates(home());

  const attempted: string[] = [];
  for (const path of candidates) {
    attempted.push(path);
    let text: string;
    try {
      text = await read(path);
    } catch (error) {
      if (isMissing(error)) continue;
      return {
        findings: [
          finding(
            "settings-unreadable",
            `${fileLabel(path)} could not be read (${String(error)}). ` +
              `Fix: make the file readable and ensure it contains ${FIX}.`,
          ),
        ],
      };
    }
    try {
      return { loaded: { path, settings: JSON.parse(text) }, findings: [] };
    } catch (error) {
      return {
        findings: [
          finding(
            "settings-unparseable",
            `${fileLabel(path)} is not valid JSON (${String(error)}). ` +
              `Fix: repair the JSON so it contains ${FIX}.`,
          ),
        ],
      };
    }
  }

  return {
    findings: [
      finding(
        "settings-not-found",
        `No settings.json found (looked at: ${attempted.join(", ")}). ` +
          `Fix: create settings.json with ${FIX}.`,
      ),
    ],
  };
}

/**
 * The doctor entry point: locate + parse + check. Returns every finding so the
 * caller can surface them and stop the workflow; empty means the dependency
 * is intact. Never throws.
 */
export async function runDoctor(options: LoadSettingsOptions = {}): Promise<DoctorFinding[]> {
  try {
    const result = await loadSettingsJson(options);
    if (result.findings.length > 0) return result.findings;
    return checkSettingsJson(result.loaded?.settings, result.loaded?.path);
  } catch (error) {
    return [
      finding(
        "settings-unreadable",
        `settings.json could not be checked (${String(error)}). ` +
          `Fix: ensure settings.json contains ${FIX}.`,
      ),
    ];
  }
}
