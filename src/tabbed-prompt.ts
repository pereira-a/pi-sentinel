/**
 * WizardPrompt — sequential 3-step wizard with back/next navigation.
 *
 * Replaces the three sequential ctx.ui.select() calls in prompt.ts with a
 * single custom TUI component that lets the user navigate forward and back
 * between layers before finalizing.
 *
 * Step 1 — Action + Timing:
 *   Allow once  / Deny once  → immediate, no rule saved
 *   Allow...    / Deny...    → proceed to Step 2
 *
 * Step 2 — Scope (tool-dependent):
 *   bash:       "Any folder" | "Only in ./<folder>"
 *   path tools: "This file"  | "This folder"
 *
 * Step 3 — Persistence:
 *   Local   → .pi/pi-sentinel/config.json (project-level)
 *   Session → pi.appendEntry() (in-memory + session recovery)
 *   Global  → ~/.pi/agent/extensions/pi-sentinel/config.json
 */

import { statSync } from "node:fs";
import { resolve, basename, dirname } from "node:path";
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Rule, PromptResult, Scope, PersistenceLevel } from "./types";
import { SCOPE, PERSISTENCE, ACTION, TOOL } from "./types";
import { extractPathsFromBashCommand } from "./rule-engine";

// ---------------------------------------------------------------------------
// Path helpers (duplicated from prompt.ts to keep this file self-contained)
// ---------------------------------------------------------------------------

/** Normalize path separators to forward slashes. */
function fwd(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Try to determine if a path is a directory. Falls back to false on error. */
function isDirectory(absPath: string): boolean {
  try {
    return statSync(absPath).isDirectory();
  } catch {
    return !basename(absPath).includes(".");
  }
}

// ---------------------------------------------------------------------------
// Action option definitions
// ---------------------------------------------------------------------------

interface ActionOption {
  label: string;
  immediate: boolean;
  action: "allow" | "deny";
}

const ACTION_OPTIONS: ActionOption[] = [
  { label: "Allow once", immediate: true, action: "allow" },
  { label: "Deny once", immediate: true, action: "deny" },
  { label: "Allow...", immediate: false, action: "allow" },
  { label: "Deny...", immediate: false, action: "deny" },
];

// ---------------------------------------------------------------------------
// Scope option definitions
// ---------------------------------------------------------------------------

interface ScopeOption {
  label: string;
  scope: Scope;
  targetPath: string | null;
}

function buildScopeOptions(
  toolName: string,
  subject: string,
  input: Record<string, unknown>,
  cwd: string,
): ScopeOption[] {
  if (toolName === TOOL.BASH) {
    const rawPaths = extractPathsFromBashCommand(subject);
    let resolvedFolder: string | null = null;

    if (rawPaths.length > 0) {
      const lastRaw = rawPaths[rawPaths.length - 1];
      const abs = resolve(cwd, lastRaw);
      resolvedFolder = isDirectory(abs) ? abs : dirname(abs);
    }

    const displayFolder = resolvedFolder
      ? fwd(resolvedFolder).split("/").slice(-2).join("/")
      : null;

    const options: ScopeOption[] = [
      { label: "Any folder", scope: SCOPE.COMMAND, targetPath: null },
    ];

    if (displayFolder) {
      options.push({
        label: `Only in ./${displayFolder}`,
        scope: SCOPE.COMMAND_IN_FOLDER,
        targetPath: resolvedFolder,
      });
    }

    return options;
  }

  // Path-based tools
  const rawPath = typeof input.path === "string" ? input.path : subject;
  const absPath = resolve(cwd, rawPath);
  const fileName = basename(absPath);
  const folderName = basename(dirname(absPath));

  return [
    {
      label: `This file (${fileName})`,
      scope: SCOPE.FILE,
      targetPath: absPath,
    },
    {
      label: `This folder (${folderName}/)`,
      scope: SCOPE.FOLDER,
      targetPath: dirname(absPath),
    },
  ];
}

// ---------------------------------------------------------------------------
// Persistence option definitions
// ---------------------------------------------------------------------------

interface PersistOption {
  label: string;
  value: PersistenceLevel;
}

const PERSIST_OPTIONS: PersistOption[] = [
  { label: "Local    (in this workspace)", value: PERSISTENCE.LOCAL },
  { label: "Session  (during this session)", value: PERSISTENCE.SESSION },
  {
    label: "Global   (across all sessions/workspaces)",
    value: PERSISTENCE.GLOBAL,
  },
];

// ---------------------------------------------------------------------------
// Step labels
// ---------------------------------------------------------------------------

const STEP_LABELS = ["Action", "Scope", "Save"];

// ---------------------------------------------------------------------------
// WizardPrompt component
// ---------------------------------------------------------------------------

export interface WizardPromptOptions {
  /** Themed description string (tool, command, path info). */
  description: string;
  /** Which tool triggered the prompt. */
  toolName: string;
  /** Short display string (command snippet or file path). */
  subject: string;
  /** Raw tool input (used to extract paths/commands). */
  input: Record<string, unknown>;
  /** Current working directory (for path resolution). */
  cwd: string;
  /** The matched rule that triggered the prompt. */
  rule: Rule;
  /** Called with the final PromptResult when the user confirms. */
  onComplete: (result: PromptResult) => void;
  /** Called when the user cancels (escape or cancel button). */
  onCancel: () => void;
  /** Theme from the ctx.ui.custom callback. */
  theme: Theme;
  /** TUI instance for requesting re-renders. */
  tui: { requestRender: () => void };
}

export class WizardPrompt {
  private opts: WizardPromptOptions;

  // Current step (0 = Action, 1 = Scope, 2 = Save)
  private step: 0 | 1 | 2 = 0;

  // Selection indices per step
  private actionIdx = 0;
  private scopeIdx = 0;
  private persistIdx = 0;

  // Resolved scope options (built once from tool/input)
  private scopeOptions: ScopeOption[];

  // Cached render output
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(opts: WizardPromptOptions) {
    this.opts = opts;
    this.scopeOptions = buildScopeOptions(
      opts.toolName,
      opts.subject,
      opts.input,
      opts.cwd,
    );
  }

  // -----------------------------------------------------------------------
  // Input handling
  // -----------------------------------------------------------------------

  handleInput(data: string): void {
    // Escape always cancels
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }

    switch (this.step) {
      case 0:
        this.handleStep1Input(data);
        break;
      case 1:
        this.handleStep2Input(data);
        break;
      case 2:
        this.handleStep3Input(data);
        break;
    }

    this.invalidate();
    this.opts.tui.requestRender();
  }

  private handleStep1Input(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.actionIdx =
        this.actionIdx > 0 ? this.actionIdx - 1 : ACTION_OPTIONS.length - 1;
    } else if (matchesKey(data, Key.down)) {
      this.actionIdx =
        this.actionIdx < ACTION_OPTIONS.length - 1 ? this.actionIdx + 1 : 0;
    } else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
      const selected = ACTION_OPTIONS[this.actionIdx];
      if (selected.immediate) {
        // Allow once / Deny once — close immediately
        this.opts.onComplete({
          action: selected.action,
          persist: false,
        });
      } else {
        // Allow... / Deny... — proceed to scope step
        this.step = 1;
        this.scopeIdx = 0;
      }
    }
  }

  private handleStep2Input(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.scopeIdx =
        this.scopeIdx > 0 ? this.scopeIdx - 1 : this.scopeOptions.length - 1;
    } else if (matchesKey(data, Key.down)) {
      this.scopeIdx =
        this.scopeIdx < this.scopeOptions.length - 1 ? this.scopeIdx + 1 : 0;
    } else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
      // Proceed to persistence step
      this.step = 2;
      this.persistIdx = 0;
    } else if (matchesKey(data, Key.left) || matchesKey(data, Key.backspace)) {
      // Go back to action step
      this.step = 0;
    }
  }

  private handleStep3Input(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.persistIdx =
        this.persistIdx > 0 ? this.persistIdx - 1 : PERSIST_OPTIONS.length - 1;
    } else if (matchesKey(data, Key.down)) {
      this.persistIdx =
        this.persistIdx < PERSIST_OPTIONS.length - 1 ? this.persistIdx + 1 : 0;
    } else if (matchesKey(data, Key.enter)) {
      // Confirm — build and return the result
      this.confirm();
    } else if (matchesKey(data, Key.left) || matchesKey(data, Key.backspace)) {
      // Go back to scope step
      this.step = 1;
    }
  }

  private confirm(): void {
    const actionOption = ACTION_OPTIONS.find(
      (o) => !o.immediate && o.action === this.getChosenAction(),
    );
    if (!actionOption) {
      this.opts.onCancel();
      return;
    }

    const scopeOption = this.scopeOptions[this.scopeIdx];
    const persistOption = PERSIST_OPTIONS[this.persistIdx];

    this.opts.onComplete({
      action: actionOption.action,
      persist: true,
      scope: scopeOption.scope,
      persistence: persistOption.value,
      targetPath: scopeOption.targetPath,
    });
  }

  private getChosenAction(): "allow" | "deny" {
    // The user chose either "Allow..." (index 2) or "Deny..." (index 3)
    return this.actionIdx >= 2
      ? ACTION_OPTIONS[this.actionIdx].action
      : "allow";
  }

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const t = this.opts.theme;
    const contentWidth = width - 2; // reserve columns for left/right border
    const lines: string[] = [];

    // --- Step indicator ---
    const stepLabel = `Step ${this.step + 1} of 3: ${STEP_LABELS[this.step]}`;
    lines.push(t.fg("accent", t.bold(stepLabel)));

    // Progress dots: ● = current, ◆ = completed, ○ = future
    const dots = [0, 1, 2]
      .map((i) => {
        if (i === this.step) return t.fg("accent", "\u25CF"); // ●
        if (i < this.step) return t.fg("success", "\u25C6"); // ◆
        return t.fg("dim", "\u25CB"); // ○
      })
      .join(
        t.fg("dim", "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"),
      );
    lines.push("  " + dots);

    // Step labels row
    const labelRow = STEP_LABELS.map((label, i) => {
      if (i === this.step) return t.fg("accent", t.bold(label));
      if (i < this.step) return t.fg("success", label);
      return t.fg("dim", label);
    }).join(t.fg("dim", "    "));
    lines.push("  " + labelRow);

    lines.push(""); // spacer

    // --- Description ---
    // Strip existing theme from description (it was pre-themed in promptAction)
    // and re-wrap. We just render it as-is since it already has ANSI codes.
    const descLines = this.opts.description.split("\n");
    for (const dl of descLines) {
      if (dl.trim()) {
        lines.push("  " + dl);
      }
    }
    lines.push("");

    // --- Step content ---
    switch (this.step) {
      case 0:
        this.renderStep1(lines, width);
        break;
      case 1:
        this.renderStep2(lines, width);
        break;
      case 2:
        this.renderStep3(lines, width);
        break;
    }

    lines.push(""); // spacer

    // --- Navigation bar (center within content width) ---
    this.renderNavBar(lines, contentWidth);

    // --- Wrap everything in a yellow border ---
    // Add a blank line at top and bottom for inner padding
    lines.unshift("");
    lines.push("");
    const bordered = this.applyBorder(lines, width);

    this.cachedWidth = width;
    this.cachedLines = bordered;
    return bordered;
  }

  private renderStep1(lines: string[], _width: number): void {
    const t = this.opts.theme;
    for (let i = 0; i < ACTION_OPTIONS.length; i++) {
      const opt = ACTION_OPTIONS[i];
      const prefix = i === this.actionIdx ? t.fg("accent", "\u276F ") : "  "; // ❯
      const label =
        i === this.actionIdx
          ? t.fg("accent", opt.label)
          : t.fg("text", opt.label);
      lines.push(prefix + label);
    }
  }

  private renderStep2(lines: string[], _width: number): void {
    const t = this.opts.theme;
    for (let i = 0; i < this.scopeOptions.length; i++) {
      const opt = this.scopeOptions[i];
      const prefix = i === this.scopeIdx ? t.fg("accent", "\u276F ") : "  ";
      const label =
        i === this.scopeIdx
          ? t.fg("accent", opt.label)
          : t.fg("text", opt.label);
      lines.push(prefix + label);
    }
  }

  private renderStep3(lines: string[], _width: number): void {
    const t = this.opts.theme;
    for (let i = 0; i < PERSIST_OPTIONS.length; i++) {
      const opt = PERSIST_OPTIONS[i];
      const prefix = i === this.persistIdx ? t.fg("accent", "\u276F ") : "  ";
      const label =
        i === this.persistIdx
          ? t.fg("accent", opt.label)
          : t.fg("text", opt.label);
      lines.push(prefix + label);
    }
  }

  /** Wrap content lines with a closed yellow rectangle border. */
  private applyBorder(content: string[], width: number): string[] {
    const t = this.opts.theme;
    const borderW = Math.max(2, width - 2); // inner width between border columns
    const result: string[] = [];

    function yellow(s: string): string {
      return t.fg("warning", s);
    }

    // Top border: ╔═...═╗
    result.push(yellow("\u2554") + yellow("\u2550").repeat(borderW) + yellow("\u2557"));

    // Content lines with side borders: ║ ... ║
    for (const line of content) {
      const visLen = visibleWidth(line);
      const padNeeded = Math.max(0, borderW - visLen);
      result.push(yellow("\u2551") + line + " ".repeat(padNeeded) + yellow("\u2551"));
    }

    // Bottom border: ╚═...═╝
    result.push(yellow("\u255a") + yellow("\u2550").repeat(borderW) + yellow("\u255d"));

    return result;
  }

  private renderNavBar(lines: string[], width: number): void {
    const t = this.opts.theme;

    // Build button labels
    const backBtn = t.fg("muted", "[\u2190 Back]");
    const nextBtn = t.fg("accent", "[Next \u2192]");
    const confirmBtn = t.fg("accent", "[Confirm \u2192]");

    let navStr: string;

    switch (this.step) {
      case 0:
        // [Next ->]
        navStr = `${nextBtn}`;
        break;
      case 1:
        // [<- Back]  [Next ->]
        navStr = `${backBtn}  ${nextBtn}`;
        break;
      case 2:
        // [<- Back]  [Confirm ->]
        navStr = `${backBtn}  ${confirmBtn}`;
        break;
    }

    // Center the nav bar
    const visibleLen = visibleWidth(navStr);
    const pad = Math.max(0, Math.floor((width - visibleLen) / 2));
    lines.push(" ".repeat(pad) + navStr);

    // Help text
    const help = t.fg(
      "dim",
      "\u2191\u2195 navigate | Enter/\u2192 select | Esc cancel",
    );
    const helpPad = Math.max(0, Math.floor((width - visibleWidth(help)) / 2));
    lines.push(" ".repeat(helpPad) + help);
  }
}

// ---------------------------------------------------------------------------
// Visible width helper (ANSI-safe)
// ---------------------------------------------------------------------------

/** Get the visible width of a string, ignoring ANSI escape codes. */
function visibleWidth(str: string): number {
  // Strip ANSI escape sequences
  return str.replace(/\x1b\[[0-9;]*m/g, "").length;
}
