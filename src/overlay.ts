/**
 * The `/imagen` overlay wizard.
 *
 * Lifecycle follows docs/tui.md ("Use custom screens and overlays") and the
 * `overlay-test.ts` / `qna.ts` examples: `ctx.ui.custom(factory, { overlay:
 * true })` hands one component the interactive area; the promise resolves when
 * the component calls the `done` callback supplied to the factory, which also
 * disposes the component. Each wizard run constructs a fresh instance.
 *
 *   ┌ /imagen ─────────────────────────────────────────────┐
 *   │ header: active model + measured latency + size quirk │  ← persistent
 *   │ model picker (↑/↓)                                   │
 *   │ prompt textarea (Focusable + CURSOR_MARKER)          │
 *   │ status + key help                                    │
 *   └──────────────────────────────────────────────────────┘
 *
 * Keys: Tab/Shift+Tab switch panes · ↑/↓ move · Enter generate ·
 * Esc cancel (Esc aborts a running generation) · Shift+Enter inserts a newline.
 *
 * Reference images are OUT OF SCOPE (T3 verified the opendesign gateway
 * ignores every reference field), so the input is text-only by design.
 */
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { LATENCY_VARIANCE_NOTE, type ModelRow } from "./present.ts";
import {
  lineEndAt,
  lineStartAt,
  nextIndex,
  previousIndex,
  rowIndexForCursor,
  wrapRows,
  type PromptRow,
} from "./textlayout.ts";

/** Overlay width in columns. */
const WIDTH = 76;
/** Maximum prompt rows rendered before scrolling. */
const PROMPT_ROWS = 4;
/** Maximum model rows rendered before scrolling the list. */
const MODEL_ROWS = 6;

/** T5 seam: preset ("skill") options the header will render when they exist. */
export interface WizardPresetOption {
  id: string;
  label: string;
}

export interface WizardGenerateRequest {
  modelId: string;
  prompt: string;
  /** Owned by the overlay; abort it by pressing Esc during generation. */
  signal: AbortSignal;
  /** Free-form progress line shown in the overlay and the status bar. */
  onProgress: (text: string) => void;
}

export type WizardGenerateResult<T> = { ok: true; value: T } | { ok: false; message: string };

export type WizardOutcome<T> =
  | { action: "generate"; modelId: string; prompt: string; value: T }
  | { action: "cancel"; lastError?: string };

export interface WizardOptions<T> {
  /** Picker rows, already in registry order (src/present.ts). */
  models: readonly ModelRow[];
  /** Preselected model (explicit `--model` > persisted default > first). */
  initialModelId: string;
  /** T5 seam: rendered as a header line when a preset list is supplied. */
  presets?: readonly WizardPresetOption[];
  /** T5 seam: id of the active preset, shown in the header. */
  activePresetId?: string;
  /** One generation round trip; expected to never reject. */
  generate: (request: WizardGenerateRequest) => Promise<WizardGenerateResult<T>>;
  /** Mirrors the busy line into `ctx.ui.setStatus("imagen", …)`. */
  onStatus?: (text: string | undefined) => void;
}

type Pane = "models" | "prompt";
type StatusKind = "ready" | "busy" | "error";

/**
 * Open the wizard as an overlay and resolve with the user's decision.
 * Pattern copied from examples/extensions/overlay-test.ts (overlay:true +
 * completion callback) and qna.ts (await the custom() promise).
 */
export async function runImagenWizard<T>(
  ctx: ExtensionCommandContext,
  options: WizardOptions<T>,
): Promise<WizardOutcome<T>> {
  return ctx.ui.custom<WizardOutcome<T>>(
    (tui, theme, _keybindings, done) => new ImagenOverlay<T>(tui, theme, options, done),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: WIDTH, maxHeight: 24 },
    },
  );
}

class ImagenOverlay<T> implements Component, Focusable {
  /** Set by the TUI when the overlay receives focus (Focusable contract). */
  focused = false;
  /** Fallback width when no overlayOptions are supplied. */
  readonly width = WIDTH;

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly options: WizardOptions<T>;
  private readonly done: (outcome: WizardOutcome<T>) => void;

  private pane: Pane = "models";
  private selected = 0;
  private prompt = "";
  private cursor = 0;
  private scroll = 0;
  private modelScroll = 0;

  private busy = false;
  private abort: AbortController | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private startedAt = 0;
  private statusKind: StatusKind = "ready";
  private statusText = "Ready.";
  private lastError: string | undefined;
  private closed = false;

  /** Inner width of the last render; used to keep the caret visible. */
  private innerWidth = WIDTH - 2;

  constructor(tui: TUI, theme: Theme, options: WizardOptions<T>, done: (outcome: WizardOutcome<T>) => void) {
    this.tui = tui;
    this.theme = theme;
    this.options = options;
    this.done = done;
    const index = options.models.findIndex((model) => model.id === options.initialModelId);
    this.selected = index >= 0 ? index : 0;
    this.modelScroll = this.modelScrollFor();
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  handleInput(data: string): void {
    if (this.closed) return;

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      if (this.busy) this.abortGeneration();
      else this.close({ action: "cancel", lastError: this.lastError });
      return;
    }

    // While a generation runs the only meaningful keys are the ones above.
    if (this.busy) return;

    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      this.pane = this.pane === "models" ? "prompt" : "models";
      this.renderSoon();
      return;
    }

    if (matchesKey(data, "return") || matchesKey(data, "enter")) {
      void this.startGeneration();
      return;
    }

    if (matchesKey(data, "up")) {
      this.moveVertical(-1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.moveVertical(1);
      return;
    }

    if (this.pane === "prompt") {
      if (matchesKey(data, "backspace")) {
        if (this.cursor > 0) {
          const start = previousIndex(this.prompt, this.cursor);
          this.prompt = this.prompt.slice(0, start) + this.prompt.slice(this.cursor);
          this.cursor = start;
          this.renderSoon();
        }
        return;
      }
      if (matchesKey(data, "delete")) {
        if (this.cursor < this.prompt.length) {
          const end = nextIndex(this.prompt, this.cursor);
          this.prompt = this.prompt.slice(0, this.cursor) + this.prompt.slice(end);
          this.renderSoon();
        }
        return;
      }
      if (matchesKey(data, "left")) {
        this.cursor = previousIndex(this.prompt, this.cursor);
        this.renderSoon();
        return;
      }
      if (matchesKey(data, "right")) {
        this.cursor = nextIndex(this.prompt, this.cursor);
        this.renderSoon();
        return;
      }
      if (matchesKey(data, "home")) {
        this.cursor = lineStartAt(this.prompt, this.cursor);
        this.renderSoon();
        return;
      }
      if (matchesKey(data, "end")) {
        this.cursor = lineEndAt(this.prompt, this.cursor);
        this.renderSoon();
        return;
      }
      if (matchesKey(data, "shift+enter")) {
        this.insert("\n");
        return;
      }
    }

    if (data === "\n") {
      this.insert("\n");
      return;
    }
    if (this.isPrintable(data)) {
      // Typing anywhere jumps to the prompt pane (overlay-test.ts pattern).
      this.pane = "prompt";
      this.insert(data);
    }
  }

  private isPrintable(data: string): boolean {
    if (data.length === 0) return false;
    if (data.startsWith("\x1b")) return false;
    const code = data.charCodeAt(0);
    return code >= 32 && code !== 0x7f;
  }

  private insert(text: string): void {
    this.prompt = this.prompt.slice(0, this.cursor) + text + this.prompt.slice(this.cursor);
    this.cursor += text.length;
    this.renderSoon();
  }

  private moveVertical(delta: -1 | 1): void {
    if (this.pane === "models") {
      if (this.options.models.length === 0) return;
      const next = Math.min(this.options.models.length - 1, Math.max(0, this.selected + delta));
      if (next !== this.selected) {
        this.selected = next;
        this.modelScroll = this.modelScrollFor();
        this.renderSoon();
      }
      return;
    }

    const rows = this.promptRows();
    const current = rowIndexForCursor(rows, this.cursor);
    const target = Math.min(rows.length - 1, Math.max(0, current + delta));
    if (target !== current) {
      this.cursor = rows[target]!.start;
      this.renderSoon();
    }
  }

  private modelScrollFor(): number {
    const count = this.options.models.length;
    const visible = Math.min(MODEL_ROWS, count);
    const first = Math.max(0, Math.min(this.selected - Math.floor(visible / 2), count - visible));
    return first;
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  private async startGeneration(): Promise<void> {
    if (this.closed || this.busy) return;
    const model = this.activeModel();
    if (!model) {
      this.setStatus("error", "No image model selected.");
      return;
    }
    const prompt = this.prompt.trim();
    if (prompt.length === 0) {
      this.setStatus("error", "Type a prompt first, then press Enter.");
      return;
    }

    this.busy = true;
    this.abort = new AbortController();
    this.startedAt = Date.now();
    this.setStatus("busy", `Generating with ${model.id}…`);
    this.startTimer();

    let result: WizardGenerateResult<T>;
    try {
      result = await this.options.generate({
        modelId: model.id,
        prompt,
        signal: this.abort.signal,
        onProgress: (text) => {
          if (this.closed) return;
          this.setStatus("busy", text);
        },
      });
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }

    if (this.closed) return;
    this.busy = false;
    this.stopTimer();

    if (result.ok) {
      this.close({ action: "generate", modelId: model.id, prompt, value: result.value });
      return;
    }
    this.lastError = result.message;
    this.setStatus("error", result.message);
  }

  private abortGeneration(): void {
    if (!this.busy) return;
    this.abort?.abort();
    this.setStatus("busy", "Aborting…");
  }

  private startTimer(): void {
    this.stopTimer();
    const model = this.activeModel();
    const typical = model?.latencyNote;
    this.timer = setInterval(() => {
      if (!this.busy || this.closed) return;
      const elapsed = Math.round((Date.now() - this.startedAt) / 1000);
      const suffix = typical ? ` / typical ${typical} (±50–70%)` : "";
      this.setStatus("busy", `Generating with ${model?.id ?? "model"}… ${elapsed}s${suffix}`);
    }, 1000);
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private setStatus(kind: StatusKind, text: string): void {
    this.statusKind = kind;
    this.statusText = text;
    this.options.onStatus?.(kind === "busy" ? text : undefined);
    this.renderSoon();
  }

  private close(outcome: WizardOutcome<T>): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTimer();
    this.options.onStatus?.(undefined);
    this.done(outcome);
  }

  invalidate(): void {
    // Nothing is cached across renders; theme colors are applied per render.
  }

  dispose(): void {
    this.closed = true;
    this.stopTimer();
    this.options.onStatus?.(undefined);
  }

  private renderSoon(): void {
    this.tui.requestRender();
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private activeModel(): ModelRow | undefined {
    return this.options.models[this.selected] ?? this.options.models[0];
  }

  private promptRows(): PromptRow[] {
    return wrapRows(this.prompt, Math.max(6, this.innerWidth - 3));
  }

  render(width: number): string[] {
    const theme = this.theme;
    const inner = Math.max(8, width - 2);
    this.innerWidth = inner;

    const pad = (content: string): string => {
      const clipped = visibleWidth(content) > inner ? truncateToWidth(content, inner, "") : content;
      return clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
    };
    const row = (content: string): string => theme.fg("border", "│") + pad(content) + theme.fg("border", "│");

    const lines: string[] = [];
    lines.push(theme.fg("border", `╭${"─".repeat(inner)}╮`));
    lines.push(row(` ${theme.fg("accent", "/imagen")} ${theme.fg("dim", "image generation")}`));

    // ---- persistent header: active model + measured notes -----------------
    const model = this.activeModel();
    if (model) {
      const label = model.label !== model.id ? ` ${theme.fg("dim", `— ${model.label}`)}` : "";
      lines.push(row(` model  ${theme.fg("accent", model.id)}${label}`));

      const facts: string[] = [];
      if (model.latencyNote) facts.push(`${model.latencyNote} typical`);
      facts.push(`size ${model.sizeSent}`);
      facts.push(LATENCY_VARIANCE_NOTE);
      lines.push(row(`        ${theme.fg("dim", facts.join(" · "))}`));

      if (model.sizeQuirk) {
        lines.push(row(`        ${theme.fg("warning", `⚠ ${model.sizeQuirk}`)}`));
      }

      // T5 seam: the preset/"skill" line appears only once a list exists.
      if (this.options.presets && this.options.presets.length > 0) {
        const active =
          this.options.presets.find((preset) => preset.id === this.options.activePresetId) ?? this.options.presets[0];
        lines.push(row(` skill  ${theme.fg("accent", active!.label)} ${theme.fg("dim", "(presets)")}`));
      }
    }

    lines.push(theme.fg("border", `├${"─".repeat(inner)}┤`));

    // ---- model picker ------------------------------------------------------
    const models = this.options.models;
    const first = this.modelScroll;
    const last = Math.min(models.length, first + MODEL_ROWS);
    if (first > 0) lines.push(row(` ${theme.fg("dim", "…")}`));
    for (let i = first; i < last; i++) {
      const candidate = models[i]!;
      const isSelected = i === this.selected;
      const marker = isSelected ? theme.fg("accent", "▸ ") : "  ";
      const facts: string[] = [];
      if (candidate.latencyNote) facts.push(candidate.latencyNote);
      if (candidate.isDefault) facts.push("default");
      const suffix = facts.length > 0 ? `  ${theme.fg("dim", facts.join(" · "))}` : "";
      lines.push(row(` ${marker}${isSelected ? candidate.id : theme.fg("dim", candidate.id)}${suffix}`));
    }
    if (last < models.length) lines.push(row(` ${theme.fg("dim", "…")}`));

    lines.push(theme.fg("border", `├${"─".repeat(inner)}┤`));

    // ---- prompt textarea ---------------------------------------------------
    const paneLabel = this.pane === "prompt" ? theme.fg("accent", "[editing]") : theme.fg("dim", "[Tab to edit]");
    lines.push(row(` prompt ${paneLabel}`));

    const rows = this.promptRows();
    const caretRow = this.focused && this.pane === "prompt" ? rowIndexForCursor(rows, this.cursor) : -1;
    if (rows.length > PROMPT_ROWS) {
      const desired = Math.max(0, Math.min(caretRow - Math.floor(PROMPT_ROWS / 2), rows.length - PROMPT_ROWS));
      if (this.cursor > 0) this.scroll = desired;
    } else {
      this.scroll = 0;
    }
    const end = Math.min(rows.length, this.scroll + PROMPT_ROWS);
    for (let i = this.scroll; i < end; i++) {
      const promptRow = rows[i]!;
      const marker = this.pane === "prompt" ? theme.fg("accent", "▸ ") : "  ";
      lines.push(row(` ${marker}${this.renderPromptRow(promptRow, i === caretRow)}`));
    }
    if (rows.length === 0) lines.push(row(` ${theme.fg("dim", "(type your prompt)")}`));

    lines.push(theme.fg("border", `├${"─".repeat(inner)}┤`));

    // ---- status + help -----------------------------------------------------
    const statusColor = { ready: "dim", busy: "warning", error: "error" } as const;
    lines.push(row(` ${theme.fg(statusColor[this.statusKind], this.statusText)}`));
    const help = this.busy
      ? "Esc aborts · generation runs in the foreground"
      : "Tab panes · ↑↓ model/prompt · Enter generate · Esc cancel";
    lines.push(row(` ${theme.fg("dim", help)}`));

    lines.push(theme.fg("border", `╰${"─".repeat(inner)}╮`));
    return lines;
  }

  /** Render one prompt row, placing CURSOR_MARKER at the caret when focused. */
  private renderPromptRow(promptRow: PromptRow, isCaretRow: boolean): string {
    if (!isCaretRow) return promptRow.text;

    const offset = this.cursor - promptRow.start;
    const before = promptRow.text.slice(0, offset);
    const cp = promptRow.text.codePointAt(offset);
    if (cp === undefined) {
      // Caret sits just past the last character: show a blank highlighted cell.
      return `${before}${CURSOR_MARKER}\x1b[7m \x1b[27m`;
    }
    const at = String.fromCodePoint(cp);
    return `${before}${CURSOR_MARKER}\x1b[7m${at}\x1b[27m${promptRow.text.slice(offset + at.length)}`;
  }
}
