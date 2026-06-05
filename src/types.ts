/**
 * Shared types for pi-sentinel.
 */

// ---------------------------------------------------------------------------
// Domain constants
// ---------------------------------------------------------------------------

export const TOOL = {
  BASH: "bash",
  READ: "read",
  WRITE: "write",
  EDIT: "edit",
  GREP: "grep",
  FIND: "find",
  LS: "ls",
} as const;

export const ACTION = {
  ALLOW: "allow",
  DENY: "deny",
  ASK: "ask",
} as const;

export const SCOPE = {
  COMMAND: "command",
  COMMAND_IN_FOLDER: "command-in-folder",
  FILE: "file",
  FOLDER: "folder",
} as const;

export const PERSISTENCE = {
  LOCAL: "local",
  SESSION: "session",
  GLOBAL: "global",
} as const;

// ---------------------------------------------------------------------------
// Derived types
// ---------------------------------------------------------------------------

export type ToolName = (typeof TOOL)[keyof typeof TOOL];
export type RuleVerdict = (typeof ACTION)[keyof typeof ACTION];
export type Scope = (typeof SCOPE)[keyof typeof SCOPE];
export type PersistenceLevel = (typeof PERSISTENCE)[keyof typeof PERSISTENCE];

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
  action: RuleVerdict;

  /**
   * Which tool(s) this rule applies to.
   * Use an array to target multiple tools, e.g. ["write", "edit"].
   * "*" matches every tool.
   */
  tool: ToolName | ToolName[] | "*";

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
   *   "allow" - pass through silently (least intrusive)
   *   "ask"   - prompt for every unmatched call (strict mode, default)
   */
  defaultAction: typeof ACTION.ALLOW | typeof ACTION.ASK;
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
  defaultAction?: typeof ACTION.ALLOW | typeof ACTION.ASK;
}

// ---------------------------------------------------------------------------
// Runtime audit log entry
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Prompt result — returned by the 3-layer dialog in prompt.ts
// ---------------------------------------------------------------------------

/**
 * What the user decided in the prompt dialog.
 *
 * persist: false  → one-time decision, no rule written or cached
 * persist: true   → a scoped rule is created and stored at `persistence` level
 *
 * scope values:
 *   "command"            bash: allow/deny the matched command pattern everywhere
 *   "command-in-folder"  bash: allow/deny only when the command targets `targetPath`
 *   "file"               path tool: allow/deny access to the exact file at `targetPath`
 *   "folder"             path tool: allow/deny access to the folder tree at `targetPath`
 *
 * targetPath is null only for scope === "command".
 */
export type PromptResult =
  | { action: typeof ACTION.ALLOW | typeof ACTION.DENY; persist: false }
  | {
      action: typeof ACTION.ALLOW | typeof ACTION.DENY;
      persist: true;
      scope: Scope;
      persistence: PersistenceLevel;
      targetPath: string | null;
    };

export type AuditAction =
  | "allowed"
  | "denied"
  | "asked-allowed"
  | "asked-denied";

export interface AuditEntry {
  timestamp: number;
  toolName: string;
  ruleId: string | null;
  action: AuditAction;
  /** Short description of what was attempted (command snippet or path). */
  subject: string;
}
