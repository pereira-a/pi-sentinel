/**
 * Shared types for pi-sentinel.
 */

// ---------------------------------------------------------------------------
// Rule schema
// ---------------------------------------------------------------------------

export interface RuleMatch {
  /**
   * Regex patterns matched against the full bash command string.
   * Only relevant when rule.tool is "bash" or "*".
   */
  commandPatterns?: string[];

  /**
   * Patterns matched against the resolved file path.
   * Each entry is treated as a regex string.
   * Only relevant for path-based tools (read, write, edit, grep, find).
   */
  pathPatterns?: string[];

  /**
   * When true, pathPatterns are matched against the path relative to the
   * workspace root instead of the absolute path.
   */
  pathRelative?: boolean;

  /**
   * Special scope check. "outside-workspace" blocks/asks when the resolved
   * path is not under any configured workspacePaths.
   */
  pathScope?: "outside-workspace" | "inside-workspace";
}

export interface Rule {
  /** Unique stable identifier, e.g. "bash.rm-rf" or "read.env-file". */
  id: string;

  /** Human-readable label shown in dialogs and the rules list. */
  description: string;

  /** Whether this rule is active. Disabled rules are skipped entirely. */
  enabled: boolean;

  /**
   * Verdict when this rule matches.
   *   deny  - block immediately, no dialog
   *   ask   - show allow/deny dialog to the user
   *   allow - pass through silently (used for explicit allow overrides)
   */
  action: "deny" | "ask" | "allow";

  /**
   * Which tool this rule applies to.
   * "*" matches every tool.
   */
  tool: "bash" | "read" | "write" | "edit" | "grep" | "find" | "*";

  /** At least one matcher field must be set. */
  match: RuleMatch;
}

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

export interface SentinelConfig {
  /** Master on/off switch. When false, all tool calls pass through. */
  enabled: boolean;

  /**
   * Ordered list of rules. Evaluated top-to-bottom; first match wins.
   * Built-in defaults are merged with user overrides (by id).
   */
  rules: Rule[];

  /**
   * Absolute paths considered "inside the workspace".
   * Defaults to [process.cwd()]. Additional entries are appended from
   * project config on top of global config.
   */
  workspacePaths: string[];

  /**
   * What to do when no rule matches a tool call.
   *   "allow" - pass through silently (default, least intrusive)
   *   "ask"   - prompt for every unmatched call (strict mode)
   */
  defaultAction: "allow" | "ask";
}

// ---------------------------------------------------------------------------
// User config (stored in config.json — partial overrides only)
// ---------------------------------------------------------------------------

/**
 * Shape of the JSON files written to disk. Each field is optional; omitted
 * fields fall back to defaults. Rules are matched by id and merged on top of
 * the built-in defaults.
 */
export interface UserConfig {
  enabled?: boolean;
  /** Partial rule overrides keyed by id. Only supplied fields are merged. */
  rules?: Array<{ id: string } & Partial<Omit<Rule, "id">>>;
  /** Extra workspace paths appended to the effective list. */
  workspacePaths?: string[];
  defaultAction?: "allow" | "ask";
}

// ---------------------------------------------------------------------------
// Runtime audit log entry
// ---------------------------------------------------------------------------

export type AuditAction = "allowed" | "denied" | "asked-allowed" | "asked-denied";

export interface AuditEntry {
  timestamp: number;
  toolName: string;
  ruleId: string | null;
  action: AuditAction;
  /** Short description of what was attempted (command snippet or path). */
  subject: string;
}
