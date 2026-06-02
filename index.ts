/**
 * pi-sentinel — entry point.
 *
 * Phase 2: rule engine wired into tool_call.
 *   - deny rules block immediately with a notification
 *   - ask rules pass through (prompting added in Phase 3)
 *   - allow rules pass through silently
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, getConfigPaths } from "./src/config";
import { registerCommands } from "./src/commands";
import { evaluateRules, extractSubject } from "./src/rule-engine";
import type { SentinelConfig, AuditEntry } from "./src/types";
import type { ConfigPaths } from "./src/config";

export default function (pi: ExtensionAPI) {
  // -------------------------------------------------------------------------
  // Runtime state
  // -------------------------------------------------------------------------

  let config: SentinelConfig | null = null;
  let configPaths: ConfigPaths | null = null;
  const auditLog: AuditEntry[] = [];

  function getConfig(): SentinelConfig {
    if (!config) throw new Error("[pi-sentinel] Config not yet loaded");
    return config;
  }

  function getPaths(): ConfigPaths {
    if (!configPaths)
      throw new Error("[pi-sentinel] Config paths not yet resolved");
    return configPaths;
  }

  // -------------------------------------------------------------------------
  // session_start: (re)load config and refresh status indicator
  // -------------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    auditLog.length = 0;
    config = loadConfig(ctx.cwd);
    configPaths = getConfigPaths(ctx.cwd);
    updateStatus(ctx);
  });

  // -------------------------------------------------------------------------
  // tool_call: placeholder pass-through (rules wired in Phase 2)
  // -------------------------------------------------------------------------

  pi.on("tool_call", async (event, ctx) => {
    if (!config?.enabled) return undefined;

    const input = event.input as Record<string, unknown>;
    const result = evaluateRules(event.toolName, input, config, ctx.cwd);

    // No rule matched — apply defaultAction.
    // "ask" without a matched rule defers to Phase 3 prompting; pass through for now.
    if (!result) return undefined;

    const subject = extractSubject(event.toolName, input);

    if (result.verdict === "deny") {
      auditLog.push({
        timestamp: Date.now(),
        toolName: event.toolName,
        ruleId: result.rule.id,
        action: "denied",
        subject,
      });

      ctx.ui.notify(
        `[sentinel] Blocked: ${result.rule.id}\n${result.rule.description}\n\n${subject}`,
        "warning",
      );
      return {
        block: true,
        reason: `${result.rule.id}: ${result.rule.description}`,
      };
    }

    if (result.verdict === "allow") {
      // Explicit allow rule (user override)
      ctx.ui.notify(
        `[sentinel] Allow: ${result.rule.id}\n${result.rule.description}\n\n${subject}`,
        "warning",
      );
      return undefined;
    }

    // verdict === "ask" — prompting added in Phase 3, pass through for now.
    ctx.ui.notify(
      `[sentinel] Ask: ${result.rule.id}\n${result.rule.description}\n\n${subject}`,
      "warning",
    );
    return undefined;
  });

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  registerCommands(pi, getConfig, getPaths, () => [...auditLog]);

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function updateStatus(ctx: ExtensionContext): void {
    if (!config) return;

    const theme = ctx.ui.theme;

    if (!config.enabled) {
      ctx.ui.setStatus("pi-sentinel", theme.fg("dim", "sentinel: off"));
      return;
    }

    const active = config.rules.filter((r) => r.enabled).length;
    ctx.ui.setStatus(
      "pi-sentinel",
      theme.fg("dim", "sentinel: ") + theme.fg("muted", `${active} rules`),
    );
  }
}
