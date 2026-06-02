/**
 * User prompting for pi-sentinel.
 *
 * Shows a dialog for "ask" rules with 6 choices:
 *   - Allow once (pass through, no state)
 *   - Allow in this session (in-memory, survives other tool calls)
 *   - Allow always (write allow rule to config)
 *   - Deny once (block, no state)
 *   - Deny in this session (in-memory, survives other tool calls)
 *   - Deny always (write deny rule to config)
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Rule } from "./types";

export type PromptChoice =
  | "allow-once"
  | "allow-session"
  | "allow-always"
  | "deny-once"
  | "deny-session"
  | "deny-always";

/**
 * Show a styled dialog and return the user's choice.
 * Uses yellow/warning colors to make the prompt stand out.
 */
export async function promptAction(
  rule: Rule,
  subject: string,
  ctx: ExtensionContext,
): Promise<PromptChoice> {
  const theme = ctx.ui.theme;

  // Format the title with warning color
  const title = theme.fg(
    "warning",
    `⚠️  Sentinel: ${rule.description}`,
  );

  // Format the subject (truncate if too long)
  const displaySubject =
    subject.length > 100 ? subject.slice(0, 97) + "..." : subject;

  const message = `\n${theme.fg("dim", displaySubject)}\n`;

  const choices = [
    "Allow once",
    "Allow in this session",
    "Allow always (save to config)",
    "Deny once",
    "Deny in this session",
    "Deny always (save to config)",
  ];

  const choice = await ctx.ui.select(title + message, choices);

  switch (choice) {
    case "Allow once":
      return "allow-once";
    case "Allow in this session":
      return "allow-session";
    case "Allow always (save to config)":
      return "allow-always";
    case "Deny once":
      return "deny-once";
    case "Deny in this session":
      return "deny-session";
    case "Deny always (save to config)":
      return "deny-always";
    default:
      // User cancelled (Escape) — treat as deny-once
      return "deny-once";
  }
}

/**
 * Create an "allow" override rule from a matched rule.
 * This rule will be written to config to permanently allow the matched pattern.
 */
export function createAllowRule(baseRule: Rule, timestamp: number): Rule {
  return {
    id: `user.allow.${baseRule.id}.${timestamp}`,
    description: `User-allowed: ${baseRule.description}`,
    enabled: true,
    action: "allow",
    match: baseRule.match,
    tool: baseRule.tool,
  };
}

/**
 * Create a "deny" override rule from a matched rule.
 * This rule will be written to config to permanently deny the matched pattern.
 */
export function createDenyRule(baseRule: Rule, timestamp: number): Rule {
  return {
    id: `user.deny.${baseRule.id}.${timestamp}`,
    description: `User-denied: ${baseRule.description}`,
    enabled: true,
    action: "deny",
    match: baseRule.match,
    tool: baseRule.tool,
  };
}
