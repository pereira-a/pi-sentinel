/**
 * pi-sentinel — entry point.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, getConfigPaths, addRuleToConfigFile } from "./src/config";
import { registerCommands } from "./src/commands";
import { evaluateRules, extractSubject } from "./src/rule-engine";
import { promptAction, buildScopedRule } from "./src/prompt";
import type { SentinelConfig, AuditEntry, Rule } from "./src/types";
import type { ConfigPaths } from "./src/config";

// Session-entry type tag used with pi.appendEntry()
const ENTRY_TYPE = "sentinel-override";

export default function (pi: ExtensionAPI) {
  // -------------------------------------------------------------------------
  // Runtime state
  // -------------------------------------------------------------------------

  let config: SentinelConfig | null = null;
  let configPaths: ConfigPaths | null = null;
  const auditLog: AuditEntry[] = [];

  /**
   * Session-level override rules.
   * Stored as actual Rule objects so each rule can carry its own pattern
   * (e.g. "allow write to this specific .env path this session").
   * These are evaluated BEFORE config.rules so they take priority.
   * Populated from pi.appendEntry entries on session_start (recovery).
   */
  const sessionOverrideRules: Rule[] = [];

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
  // session_start: (re)load config, restore session overrides, refresh status
  // -------------------------------------------------------------------------

  pi.on("session_start", async (event, ctx) => {
    // Clear audit log and session rules on every (re)start
    auditLog.length = 0;
    sessionOverrideRules.length = 0;

    // Restore session-level override rules that were persisted via appendEntry
    // (survives /new, /resume, /fork because entries travel with the session file)
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
        const rule = (entry.data as { rule?: Rule })?.rule;
        if (rule && rule.id && rule.action && rule.tool && rule.match) {
          sessionOverrideRules.push(rule);
        }
      }
    }

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

    // Session override rules are evaluated first (they win over config rules)
    const effectiveConfig: SentinelConfig = {
      ...config,
      rules: [...sessionOverrideRules, ...config.rules],
    };

    const result = evaluateRules(
      event.toolName,
      input,
      effectiveConfig,
      ctx.cwd,
    );

    // No rule matched — apply defaultAction
    if (!result) return undefined;

    const subject = extractSubject(event.toolName, input);

    // --- DENY verdict (built-in hard deny) ---
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

    // --- ALLOW verdict (explicit allow rule matched — session or config) ---
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

    // --- ASK verdict: need to prompt the user ---

    // Non-interactive mode: deny conservatively
    if (!ctx.hasUI) {
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

    // Show 3-layer dialog
    const promptResult = await promptAction(
      result.rule,
      subject,
      event.toolName,
      input,
      ctx,
      ctx.cwd,
    );

    const timestamp = Date.now();
    const isAllow = promptResult.action === "allow";

    // --- Handle "once" (persist: false) ---
    if (!promptResult.persist) {
      auditLog.push({
        timestamp,
        toolName: event.toolName,
        ruleId: result.rule.id,
        action: isAllow ? "asked-allowed" : "asked-denied",
        subject,
      });
      if (isAllow) return undefined;
      return { block: true, reason: "Blocked by user (once)" };
    }

    // --- Handle "persist: true" — build and save the scoped rule ---
    const scopedRule = buildScopedRule(
      result.rule,
      promptResult.action,
      promptResult.scope,
      promptResult.targetPath,
      timestamp,
    );

    if (promptResult.persistence === "local") {
      await addRuleToConfigFile(configPaths!.project, scopedRule);
      config = loadConfig(ctx.cwd);
      ctx.ui.notify(
        `[sentinel] Rule saved to project config: ${scopedRule.id}`,
        "info",
      );
    } else if (promptResult.persistence === "global") {
      await addRuleToConfigFile(configPaths!.global, scopedRule);
      config = loadConfig(ctx.cwd);
      ctx.ui.notify(
        `[sentinel] Rule saved to global config: ${scopedRule.id}`,
        "info",
      );
    } else {
      // session: push to in-memory array and persist to session entries
      sessionOverrideRules.push(scopedRule);
      pi.appendEntry(ENTRY_TYPE, { rule: scopedRule });
      ctx.ui.notify(`[sentinel] Session rule added: ${scopedRule.id}`, "info");
    }

    auditLog.push({
      timestamp,
      toolName: event.toolName,
      ruleId: result.rule.id,
      action: isAllow ? "asked-allowed" : "asked-denied",
      subject,
    });

    if (isAllow) return undefined;
    return {
      block: true,
      reason: `Blocked by user (${promptResult.persistence})`,
    };
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
    const sessionCount = sessionOverrideRules.length;
    const sessionLabel =
      sessionCount > 0 ? theme.fg("warning", ` +${sessionCount}s`) : "";

    ctx.ui.setStatus(
      "pi-sentinel",
      theme.fg("dim", "sentinel: ") +
        theme.fg("muted", `${active} rules`) +
        sessionLabel,
    );
  }
}
