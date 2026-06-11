/**
 * Rule engine for pi-sentinel.
 *
 * Evaluates a tool call against the active rule list and returns the first
 * matching rule's verdict, or null if nothing matched.
 *
 * Path handling:
 *   All paths are resolved to absolute and normalized to forward slashes
 *   before pattern matching. This ensures patterns work on Windows and Unix.
 *
 * Matcher semantics:
 *   All present matchers in a rule must pass (AND logic).
 *   A rule with no matchers never matches.
 */

import { resolve } from "node:path";
import type { Rule, SentinelConfig, ToolName } from "./types";
import { parseBashCommand } from "./bash-parser";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MatchResult {
  verdict: "deny" | "ask" | "allow";
  rule: Rule;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize an absolute path to forward slashes for cross-platform matching. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Extract path-like tokens from a bash command string.
 * Matches tokens beginning with ./, ../, /, ~/, or a Windows drive letter
 * (e.g. D:/...) and returns them as-is (caller resolves to absolute paths).
 * Used for matching pathPatterns in hybrid bash+path rules.
 */
export function extractPathsFromBashCommand(command: string): string[] {
  const results: string[] = [];
  // Match tokens that start with ./, ../, /, ~/, or a drive letter (e.g. C:/)
  // Stop at whitespace, semicolons, pipe/redirect chars
  const re = /(?:^|\s)(\.{1,2}\/[^\s;|&><"']*|\/[^\s;|&><"']+|~\/[^\s;|&><"']*|[A-Za-z]:\/[^\s;|&><"']*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const tok = m[1].replace(/['"]+$/g, "").trim(); // strip trailing quotes
    if (tok) results.push(tok);
  }
  return results;
}

/** Check whether an absolute, normalized path is inside any workspace root. */
function isInsideWorkspace(absPath: string, workspacePaths: string[]): boolean {
  const normalized = normalizePath(absPath);
  return workspacePaths.some((wp) => {
    const normalizedWp = normalizePath(wp);
    const wpWithSep = normalizedWp.endsWith("/")
      ? normalizedWp
      : normalizedWp + "/";
    return normalized === normalizedWp || normalized.startsWith(wpWithSep);
  });
}

/** Return true if the rule targets the given tool. */
function toolApplies(rule: Rule, toolName: string): boolean {
  if (rule.tool === "*") return true;
  if (Array.isArray(rule.tool))
    return (rule.tool as string[]).includes(toolName);
  return rule.tool === toolName;
}

/** Extract a subject string from the tool input for display and audit purposes. */
export function extractSubject(
  toolName: string,
  input: Record<string, unknown>,
): string {
  if (toolName === "bash") {
    const cmd = typeof input.command === "string" ? input.command : "";
    return cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
  }
  const path = typeof input.path === "string" ? input.path : "";
  return path;
}

/** Escape special regex characters in a literal string. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Core matcher
// ---------------------------------------------------------------------------

function matchesRule(
  rule: Rule,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  workspacePaths: string[],
): boolean {
  if (!rule.enabled) return false;
  if (!toolApplies(rule, toolName)) return false;

  const { match } = rule;
  let hasChecker = false;

  // --- Command pattern matching (bash only) ---
  if (match.commandPatterns && match.commandPatterns.length > 0) {
    hasChecker = true;
    // commandPatterns only make sense for bash; skip silently for other tools
    if (toolName !== "bash") return false;
    const command = typeof input.command === "string" ? input.command : "";
    const matched = match.commandPatterns.some((p) => {
      try {
        return new RegExp(p, "i").test(command);
      } catch(err) {
        // Malformed pattern — treat as non-matching
        console.warn(`[pi-sentinel] Invalid command pattern: ${p}`, err);
        return false;
      }
    });
    if (!matched) return false;
  }

  // --- Segment pattern matching (bash only) ---
  if (match.segmentPatterns && match.segmentPatterns.length > 0) {
    hasChecker = true;
    if (toolName !== "bash") return false;
    const command = typeof input.command === "string" ? input.command : "";
    const parsed = parseBashCommand(command);
    const matched = parsed.segments.some((seg) =>
      match.segmentPatterns!.some((p) => {
        try {
          return new RegExp(p, "i").test(seg.text);
        } catch (err) {
          console.warn(`[pi-sentinel] Invalid segment pattern: ${p}`, err);
          return false;
        }
      }),
    );
    if (!matched) return false;
  }

  // --- Path pattern matching ---
  if (match.pathPatterns && match.pathPatterns.length > 0) {
    hasChecker = true;

    let pathsToCheck: string[];

    if (toolName === "bash") {
      // For bash, pathPatterns are matched against paths extracted from the command
      // (hybrid rules: allow/deny a command only for a specific folder).
      const command = typeof input.command === "string" ? input.command : "";
      const extracted = extractPathsFromBashCommand(command);
      if (extracted.length === 0) return false;
      pathsToCheck = extracted.map((p) => normalizePath(resolve(cwd, p)));
    } else {
      const rawPath = typeof input.path === "string" ? input.path : "";
      if (!rawPath) return false;
      const testPath = match.pathRelative
        ? rawPath
        : normalizePath(resolve(cwd, rawPath));
      pathsToCheck = [testPath];
    }

    const matched = pathsToCheck.some((testPath) =>
      match.pathPatterns!.some((p) => {
        try {
          return new RegExp(p, "i").test(testPath);
        } catch (err) {
          console.warn(`[pi-sentinel] Invalid path pattern: ${p}`, err);
          return false;
        }
      })
    );
    if (!matched) return false;
  }

  // --- Path scope check ---
  if (match.pathScope) {
    hasChecker = true;
    const rawPath = typeof input.path === "string" ? input.path : "";
    if (!rawPath) return false;

    const absPath = resolve(cwd, rawPath);
    const inside = isInsideWorkspace(absPath, workspacePaths);

    if (match.pathScope === "outside-workspace" && inside) return false;
    if (match.pathScope === "inside-workspace" && !inside) return false;
  }

  // A rule with no matchers at all never matches
  return hasChecker;
}

// ---------------------------------------------------------------------------
// Public: evaluate a tool call against the full rule list
// ---------------------------------------------------------------------------

/**
 * Returns the first matching rule and its verdict, or null if no rule matched.
 * The caller is responsible for applying config.defaultAction when null is returned.
 */
export function evaluateRules(
  toolName: string,
  input: Record<string, unknown>,
  config: SentinelConfig,
  cwd: string,
): MatchResult | null {
  for (const rule of config.rules) {
    if (matchesRule(rule, toolName, input, cwd, config.workspacePaths)) {
      return { verdict: rule.action, rule };
    }
  }
  return null;
}
