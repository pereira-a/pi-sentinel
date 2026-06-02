/**
 * pi-sentinel — entry point.
 *
 * Phase 3: user prompting wired in.
 *   - deny rules block immediately with a notification
 *   - ask rules show a dialog with 6 choices
 *   - allow rules pass through silently
 *   - session and permanent overrides tracked
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, getConfigPaths, addRuleToConfigFile } from "./src/config";
import { registerCommands } from "./src/commands";
import { evaluateRules, extractSubject } from "./src/rule-engine";
import {
  promptAction,
  createAllowRule,
  createDenyRule,
} from "./src/prompt";
import type { SentinelConfig, AuditEntry } from "./src/types";
import type { ConfigPaths } from "./src/config";

export default function (pi: ExtensionAPI) {
  // -------------------------------------------------------------------------
  // Runtime state
  // -------------------------------------------------------------------------

  let config: SentinelConfig | null = null;
  let configPaths: ConfigPaths | null = null;
  const auditLog: AuditEntry[] = [];

  // Session-level caches for user decisions
  const sessionAllowedRuleIds = new Set<string>();
  const sessionDeniedRuleIds = new Set<string>();

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
  // session_start: (re)load config, clear session caches, refresh status
  // -------------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    auditLog.length = 0;
    sessionAllowedRuleIds.clear();
    sessionDeniedRuleIds.clear();
    config = loadConfig(ctx.cwd);
    configPaths = getConfigPaths(ctx.cwd);
    updateStatus(ctx);
  });

  // -------------------------------------------------------------------------
  // tool_call: evaluate rules and handle verdicts
  // -------------------------------------------------------------------------

  pi.on("tool_call", async (event, ctx) => {
    if (!config?.enabled) return undefined;

    const input = event.input as Record<string, unknown>;
    const result = evaluateRules(event.toolName, input, config, ctx.cwd);

    // No rule matched — apply defaultAction.
    // "ask" defaultAction without a rule goes to Phase 5 (for now, pass through)
    if (!result) return undefined;

    const subject = extractSubject(event.toolName, input);

    // --- DENY verdict ---
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

    // --- ALLOW verdict ---
    if (result.verdict === "allow") {
      auditLog.push({
        timestamp: Date.now(),
        toolName: event.toolName,
        ruleId: result.rule.id,
        action: "allowed",
        subject,
      });
      return undefined;
    }

    // --- ASK verdict: check session overrides first ---
    if (sessionAllowedRuleIds.has(result.rule.id)) {
      auditLog.push({
        timestamp: Date.now(),
        toolName: event.toolName,
        ruleId: result.rule.id,
        action: "allowed",
        subject,
      });
      return undefined;
    }

    if (sessionDeniedRuleIds.has(result.rule.id)) {
      auditLog.push({
        timestamp: Date.now(),
        toolName: event.toolName,
        ruleId: result.rule.id,
        action: "denied",
        subject,
      });
      return { block: true, reason: "Blocked by session override" };
    }

    // --- ASK verdict: show dialog ---
    if (!ctx.hasUI) {
      // Non-interactive mode: fall back to deny for ask rules
      auditLog.push({
        timestamp: Date.now(),
        toolName: event.toolName,
        ruleId: result.rule.id,
        action: "denied",
        subject,
      });
      return {
        block: true,
        reason: `${result.rule.id}: blocked in non-interactive mode`,
      };
    }

    const choice = await promptAction(result.rule, subject, ctx);
    const timestamp = Date.now();

    switch (choice) {
      case "allow-once":
        auditLog.push({
          timestamp,
          toolName: event.toolName,
          ruleId: result.rule.id,
          action: "asked-allowed",
          subject,
        });
        return undefined;

      case "allow-session":
        sessionAllowedRuleIds.add(result.rule.id);
        auditLog.push({
          timestamp,
          toolName: event.toolName,
          ruleId: result.rule.id,
          action: "asked-allowed",
          subject,
        });
        return undefined;

      case "allow-always":
        sessionAllowedRuleIds.add(result.rule.id);
        const allowRule = createAllowRule(result.rule, timestamp);
        // Write to project config by default
        await addRuleToConfigFile(configPaths!.project, allowRule);
        config = loadConfig(ctx.cwd); // reload config
        auditLog.push({
          timestamp,
          toolName: event.toolName,
          ruleId: result.rule.id,
          action: "asked-allowed",
          subject,
        });
        ctx.ui.notify(
          `[sentinel] Saved allow rule to config: ${allowRule.id}`,
          "info",
        );
        return undefined;

      case "deny-once":
        auditLog.push({
          timestamp,
          toolName: event.toolName,
          ruleId: result.rule.id,
          action: "asked-denied",
          subject,
        });
        return { block: true, reason: "Blocked by user (once)" };

      case "deny-session":
        sessionDeniedRuleIds.add(result.rule.id);
        auditLog.push({
          timestamp,
          toolName: event.toolName,
          ruleId: result.rule.id,
          action: "asked-denied",
          subject,
        });
        return { block: true, reason: "Blocked by user (session)" };

      case "deny-always":
        sessionDeniedRuleIds.add(result.rule.id);
        const denyRule = createDenyRule(result.rule, timestamp);
        // Write to project config by default
        await addRuleToConfigFile(configPaths!.project, denyRule);
        config = loadConfig(ctx.cwd); // reload config
        auditLog.push({
          timestamp,
          toolName: event.toolName,
          ruleId: result.rule.id,
          action: "asked-denied",
          subject,
        });
        ctx.ui.notify(
          `[sentinel] Saved deny rule to config: ${denyRule.id}`,
          "info",
        );
        return { block: true, reason: "Blocked by user (always)" };
    }
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
