/**
 * User prompting for pi-sentinel — three-layer dialog system.
 *
 * Layer 1 — Action + Timing (always shown):
 *   Allow once  / Deny once  → immediate, no rule saved
 *   Allow...    / Deny...    → proceed to Layer 2
 *
 * Layer 2 — Scope (tool-dependent):
 *   bash:       "This command"  |  "This command in <folder>"
 *   path tools: "This file"     |  "This folder"
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
import { extractPathsFromBashCommand } from "./rule-engine";

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
  scope: "command" | "command-in-folder" | "file" | "folder",
  targetPath: string | null,
  timestamp: number,
): Rule {
  const id = `user.${action}.${baseRule.id}.${timestamp}`;
  const description = `User-${action}: ${baseRule.description}`;

  if (scope === "command") {
    return {
      id,
      description,
      enabled: true,
      action,
      tool: baseRule.tool,
      match: {
        commandPatterns: baseRule.match.commandPatterns,
      },
    };
  }

  if (scope === "command-in-folder") {
    if (!targetPath) throw new Error("targetPath required for command-in-folder scope");
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

  if (scope === "file") {
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

  // scope === "folder"
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
// Layer 3: persistence
// ---------------------------------------------------------------------------

async function showLayer3(
  action: "allow" | "deny",
  ctx: ExtensionContext,
): Promise<"local" | "session" | "global" | null> {
  const theme = ctx.ui.theme;
  const title = theme.fg("warning", `Where should this ${action} rule be saved?`);

  const LOCAL   = "Local  (this project only)";
  const SESSION = "Session  (this session, recoverable)";
  const GLOBAL  = "Global  (all projects, permanent)";

  const choice = await ctx.ui.select(title, [LOCAL, SESSION, GLOBAL]);

  if (choice === LOCAL)   return "local";
  if (choice === SESSION) return "session";
  if (choice === GLOBAL)  return "global";
  return null; // cancelled
}

// ---------------------------------------------------------------------------
// Layer 2: scope
// ---------------------------------------------------------------------------

async function showLayer2Bash(
  action: "allow" | "deny",
  baseRule: Rule,
  command: string,
  cwd: string,
  ctx: ExtensionContext,
): Promise<{ scope: "command" | "command-in-folder"; targetPath: string | null } | null> {
  const theme = ctx.ui.theme;
  const title = theme.fg("warning", `${action === "allow" ? "Allow" : "Deny"} which scope?`);

  const THIS_CMD = "This command  (anywhere)";

  // Try to find a folder from the command
  const rawPaths = extractPathsFromBashCommand(command);
  let folderOption: string | null = null;
  let resolvedFolder: string | null = null;

  if (rawPaths.length > 0) {
    // Pick the last/most-specific path-like token as the target
    const lastRaw = rawPaths[rawPaths.length - 1];
    const abs = resolve(cwd, lastRaw);
    // If it looks like a file, use its parent directory
    resolvedFolder = isDirectory(abs) ? abs : dirname(abs);
    const displayFolder = fwd(resolvedFolder).split("/").slice(-2).join("/");
    folderOption = `This command in  ./${displayFolder}`;
  }

  const options = folderOption
    ? [THIS_CMD, folderOption]
    : [THIS_CMD];

  const choice = await ctx.ui.select(title, options);
  if (!choice) return null;

  if (choice === THIS_CMD) return { scope: "command", targetPath: null };
  return { scope: "command-in-folder", targetPath: resolvedFolder };
}

async function showLayer2Path(
  action: "allow" | "deny",
  rawPath: string,
  cwd: string,
  ctx: ExtensionContext,
): Promise<{ scope: "file" | "folder"; targetPath: string } | null> {
  const theme = ctx.ui.theme;
  const title = theme.fg("warning", `${action === "allow" ? "Allow" : "Deny"} which scope?`);

  const absPath = resolve(cwd, rawPath);
  const fileName = basename(absPath);
  const folderName = basename(dirname(absPath));

  const FILE_OPT   = `This file    (${fileName})`;
  const FOLDER_OPT = `This folder  (${folderName}/)`;

  const choice = await ctx.ui.select(title, [FILE_OPT, FOLDER_OPT]);
  if (!choice) return null;

  if (choice === FILE_OPT)   return { scope: "file",   targetPath: absPath };
  return                              { scope: "folder", targetPath: dirname(absPath) };
}

// ---------------------------------------------------------------------------
// Layer 1: action + timing
// ---------------------------------------------------------------------------

const ALLOW_ONCE  = "Allow once";
const DENY_ONCE   = "Deny once";
const ALLOW_MORE  = "Allow\u2026";
const DENY_MORE   = "Deny\u2026";

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Show the three-layer dialog for an "ask" rule.
 *
 * @param rule       The matched rule that triggered the prompt
 * @param subject    Short display string (command snippet or file path)
 * @param toolName   Which tool was called ("bash", "read", "write", etc.)
 * @param input      The raw tool input (used to extract paths/commands)
 * @param ctx        Extension context (for ctx.ui.select)
 * @param cwd        Current working directory (for path resolution)
 */
export async function promptAction(
  rule: Rule,
  subject: string,
  toolName: string,
  input: Record<string, unknown>,
  ctx: ExtensionContext,
  cwd: string,
): Promise<PromptResult> {
  const theme = ctx.ui.theme;

  // Build Layer 1 title with description + subject
  const displaySubject =
    subject.length > 100 ? subject.slice(0, 97) + "..." : subject;
  const title =
    theme.fg("warning", `⚠️  Sentinel: ${rule.description}`) +
    "\n" +
    theme.fg("dim", displaySubject) +
    "\n";

  // --- Layer 1 ---
  const layer1 = await ctx.ui.select(title, [
    ALLOW_ONCE,
    DENY_ONCE,
    ALLOW_MORE,
    DENY_MORE,
  ]);

  // Escape / cancel → default to deny-once
  if (!layer1) return { action: "deny", persist: false };

  if (layer1 === ALLOW_ONCE) return { action: "allow", persist: false };
  if (layer1 === DENY_ONCE)  return { action: "deny",  persist: false };

  const action: "allow" | "deny" = layer1 === ALLOW_MORE ? "allow" : "deny";

  // --- Layer 2: scope ---
  let scope: "command" | "command-in-folder" | "file" | "folder";
  let targetPath: string | null = null;

  if (toolName === "bash") {
    const command = typeof input.command === "string" ? input.command : "";
    const layer2 = await showLayer2Bash(action, rule, command, cwd, ctx);
    if (!layer2) return { action, persist: false }; // cancelled → treat as once
    scope = layer2.scope;
    targetPath = layer2.targetPath;
  } else {
    const rawPath = typeof input.path === "string" ? input.path : subject;
    const layer2 = await showLayer2Path(action, rawPath, cwd, ctx);
    if (!layer2) return { action, persist: false }; // cancelled → treat as once
    scope = layer2.scope;
    targetPath = layer2.targetPath;
  }

  // --- Layer 3: persistence ---
  const persistence = await showLayer3(action, ctx);
  if (!persistence) return { action, persist: false }; // cancelled → treat as once

  return {
    action,
    persist: true,
    scope,
    persistence,
    targetPath,
  };
}
