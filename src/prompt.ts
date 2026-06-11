/**
 * User prompting for pi-sentinel — three-layer dialog system.
 *
 * Uses the WizardPrompt component (src/tabbed-prompt.ts) for a sequential
 * wizard with back/next navigation instead of three blocking selects.
 *
 * Layer 1 — Action + Timing (always shown):
 *   Allow once  / Deny once  → immediate, no rule saved
 *   Allow...    / Deny...    → proceed to Layer 2
 *
 * Layer 2 — Scope (tool-dependent):
 *   bash:       "Any folder"  |  "Only in ./<folder>"
 *   path tools: "This file"   |  "This folder"
 *
 * Layer 3 — Persistence:
 *   Local   → .pi/pi-sentinel/config.json (project-level)
 *   Session → pi.appendEntry() (in-memory + session recovery)
 *   Global  → ~/.pi/agent/extensions/pi-sentinel/config.json
 */

import { statSync } from "node:fs";
import { resolve, basename, dirname } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Rule, PromptResult } from "./types";
import { SCOPE, ACTION, TOOL } from "./types";
import { parseBashCommand } from "./bash-parser";
import { WizardPrompt } from "./tabbed-prompt";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Escape special regex chars in a literal string. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Normalize path separators to forward slashes. */
function fwd(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Build a regex pattern that exactly matches one normalized absolute path. */
export function makeFilePattern(absPath: string): string {
  return escapeRegex(fwd(absPath)) + "$";
}

/** Build a regex pattern that matches a normalized absolute path and any descendants. */
export function makeFolderPattern(absPath: string): string {
  const normalized = fwd(absPath).replace(/\/$/, ""); // strip trailing slash
  return escapeRegex(normalized) + "(/.*)?$";
}

/** Try to determine if a path is a directory. Falls back to false on error. */
function isDirectory(absPath: string): boolean {
  try {
    return statSync(absPath).isDirectory();
  } catch {
    // Path doesn't exist yet — guess from the extension (no extension = likely folder)
    return !basename(absPath).includes(".");
  }
}

// ---------------------------------------------------------------------------
// Rule builder
// ---------------------------------------------------------------------------

/**
 * Create a targeted allow/deny rule based on what the user chose in the
 * 3-layer dialog.
 *
 * scope === "command"           → commandPatterns only (allow/deny cmd anywhere)
 * scope === "command-in-folder" → commandPatterns + folder pathPattern (hybrid)
 * scope === "file"              → exact file pathPattern
 * scope === "folder"            → folder-tree pathPattern
 */
export function buildScopedRule(
  baseRule: Rule,
  action: "allow" | "deny",
  scope: "command" | "command-in-folder" | "segment" | "segment-in-folder" | "file" | "folder",
  targetPath: string | null,
  timestamp: number,
  segmentText?: string,
): Rule {
  const id = `user.${action}.${baseRule.id}.${timestamp}`;
  const description = `User-${action}: ${baseRule.description}`;

  if (
    scope === SCOPE.COMMAND ||
    scope === SCOPE.SEGMENT
  ) {
    if (scope === SCOPE.SEGMENT && !segmentText) {
      throw new Error("segmentText required for segment scope");
    }

    const patterns: string[] =
      scope === SCOPE.SEGMENT
        ? [segPattern(segmentText!)]
        : baseRule.match.commandPatterns ?? [];

    return {
      id,
      description,
      enabled: true,
      action,
      tool: scope === SCOPE.SEGMENT ? TOOL.BASH : baseRule.tool,
      match: {
        segmentPatterns:
          scope === SCOPE.SEGMENT ? patterns : undefined,
        commandPatterns:
          scope === SCOPE.COMMAND ? patterns : undefined,
      },
    };
  }

  if (scope === SCOPE.COMMAND_IN_FOLDER) {
    if (!targetPath)
      throw new Error("targetPath required for command-in-folder scope");

    return {
      id,
      description,
      enabled: true,
      action,
      tool: baseRule.tool,
      match: {
        commandPatterns: baseRule.match.commandPatterns,
        pathPatterns: [makeFolderPattern(targetPath)],
      },
    };
  }

  if (scope === SCOPE.SEGMENT_IN_FOLDER) {
    if (!targetPath)
      throw new Error("targetPath required for segment-in-folder scope");
    if (!segmentText)
      throw new Error("segmentText required for segment scope");

    return {
      id,
      description,
      enabled: true,
      action,
      tool: TOOL.BASH,
      match: {
        segmentPatterns: [segPattern(segmentText)],
        pathPatterns: [makeFolderPattern(targetPath)],
      },
    };
  }

  if (scope === SCOPE.FILE) {
    if (!targetPath) throw new Error("targetPath required for file scope");
    return {
      id,
      description,
      enabled: true,
      action,
      tool: baseRule.tool,
      match: {
        pathPatterns: [makeFilePattern(targetPath)],
      },
    };
  }

  // scope === SCOPE.FOLDER
  if (!targetPath) throw new Error("targetPath required for folder scope");
  return {
    id,
    description,
    enabled: true,
    action,
    tool: baseRule.tool,
    match: {
      pathPatterns: [makeFolderPattern(targetPath)],
    },
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Show the three-layer dialog for an "ask" rule using the WizardPrompt
 * component with back/next navigation.
 *
 * @param rule       The matched rule that triggered the prompt
 * @param subject    Short display string (command snippet or file path)
 * @param toolName   Which tool was called ("bash", "read", "write", etc.)
 * @param input      The raw tool input (used to extract paths/commands)
 * @param ctx        Extension context (for ctx.ui.custom)
 * @param cwd        Current working directory (for path resolution)
 */
/** Build a regex pattern that matches the exact segment text. */
function segPattern(segmentText: string): string {
  return "^" + escapeRegex(segmentText.trim()) + "$";
}

export async function promptAction(
  rule: Rule,
  subject: string,
  toolName: string,
  input: Record<string, unknown>,
  ctx: ExtensionContext,
  cwd: string,
): Promise<PromptResult> {
  const theme = ctx.ui.theme;

  let description =
    "\n" + theme.fg("text", `Tool: `) + theme.fg("muted", `${toolName}\n`);
  if (toolName === TOOL.BASH) {
    // Show parsed segments for chained commands
    const parsed = parseBashCommand(subject);
    if (!parsed.isSimple) {
      description += theme.fg("text", `Command chain (${parsed.segments.length} segments):\n`);
      for (const seg of parsed.segments) {
        const idx = theme.fg("dim", `[${seg.index + 1}] `);
        const op = seg.operator ? theme.fg("dim", `${seg.operator} `) : "";
        description += `  ${idx}${op}${theme.fg("text", seg.text)}\n`;
      }
      description += "\n";
      description += theme.fg("dim", "  Tip: You can scope decisions to a specific segment in the next step.") + "\n";
    } else {
      description +=
        theme.fg("text", `Command: `) + theme.fg("muted", `${subject}\n`);
    }
  } else {
    description +=
      theme.fg("text", `Path: `) + theme.fg("muted", `${subject}\n`);
  }

  // Use the WizardPrompt component for a navigable 3-step wizard
  // Build scope options with segment support for chained commands
  const parsed = toolName === TOOL.BASH ? parseBashCommand(subject) : null;

  const result = await ctx.ui.custom<PromptResult | null>(
    (tui, wizardTheme, _kb, done) => {
      const wizard = new WizardPrompt({
        title: "pi-sentinel",
        reason: rule.description,
        description,
        toolName,
        subject,
        input,
        cwd,
        rule,
        parsedSegments: parsed?.isSimple ? null : (parsed?.segments ?? null),
        onComplete: (r: PromptResult) => done(r),
        onCancel: () => done(null),
        theme: wizardTheme,
        tui,
      });
      return wizard;
    },
  );

  // Cancel / escape → default to deny-once
  if (!result) return { action: ACTION.DENY, persist: false };
  return result;
}
