/**
 * Slash commands for pi-sentinel.
 *
 * Phase 1: /sentinel-status only.
 * Phase 4: /sentinel-toggle added.
 * Phase 5: /sentinel-settings, /sentinel-rules, /sentinel-audit added.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getConfigPaths,
  loadConfig,
  saveUserConfig,
  readRawUserConfig,
} from "./config";
import type { SentinelConfig, UserConfig } from "./types";
import type { ConfigPaths } from "./config";
import type { AuditEntry } from "./types";

export function registerCommands(
  pi: ExtensionAPI,
  getConfig: () => SentinelConfig,
  getConfigPaths: () => ConfigPaths,
  getAuditLog: () => AuditEntry[],
): void {
  // -------------------------------------------------------------------------
  // /sentinel-status
  // -------------------------------------------------------------------------
  pi.registerCommand("sentinel-status", {
    description: "Show pi-sentinel status: enabled state, rule counts, config paths",
    handler: async (_args, ctx) => {
      const config = getConfig();
      const paths = getConfigPaths();
      const theme = ctx.ui.theme;

      const enabledLabel = config.enabled
        ? theme.fg("success", "enabled")
        : theme.fg("error", "disabled");

      const totalRules = config.rules.length;
      const activeRules = config.rules.filter((r) => r.enabled);
      const byAction = {
        deny: activeRules.filter((r) => r.action === "deny").length,
        ask: activeRules.filter((r) => r.action === "ask").length,
        allow: activeRules.filter((r) => r.action === "allow").length,
      };

      const rulesSummary =
        `${activeRules.length}/${totalRules} active` +
        ` (deny: ${byAction.deny}, ask: ${byAction.ask}, allow: ${byAction.allow})`;

      const defaultLabel =
        config.defaultAction === "ask"
          ? theme.fg("warning", "ask (strict mode)")
          : theme.fg("dim", "allow");

      const workspacePaths = config.workspacePaths
        .map((p) => `  ${theme.fg("dim", p)}`)
        .join("\n");

      const log = getAuditLog();
      const logSummary =
        log.length === 0
          ? theme.fg("dim", "no decisions yet")
          : `${log.length} decision(s) this session`;

      const lines = [
        `${theme.bold("pi-sentinel")}  ${enabledLabel}`,
        "",
        `${theme.fg("muted", "Rules:")}        ${rulesSummary}`,
        `${theme.fg("muted", "Unmatched:")}    ${defaultLabel}`,
        `${theme.fg("muted", "Audit log:")}    ${logSummary}`,
        "",
        `${theme.fg("muted", "Workspace:")}`,
        workspacePaths,
        "",
        `${theme.fg("muted", "Global config:")}  ${theme.fg("dim", paths.global)}`,
        `${theme.fg("muted", "Project config:")} ${theme.fg("dim", paths.project)}`,
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // -------------------------------------------------------------------------
  // /sentinel-toggle
  // -------------------------------------------------------------------------
  pi.registerCommand("sentinel-toggle", {
    description: "Toggle sentinel on/off and save to config",
    handler: async (_args, ctx) => {
      const config = getConfig();
      const paths = getConfigPaths();
      const theme = ctx.ui.theme;

      // Determine which config file to write to (project > global)
      const targetPath = paths.project; // Always use project config for toggles
      const currentUserConfig = readRawUserConfig(targetPath);
      const newEnabled = !config.enabled;

      // Write the toggle
      const updated: UserConfig = {
        ...currentUserConfig,
        enabled: newEnabled,
      };
      saveUserConfig(targetPath, updated);

      ctx.ui.notify(
        `[sentinel] ${newEnabled ? theme.fg("success", "enabled") : theme.fg("error", "disabled")}`,
        "info",
      );

      // Reload the extension to pick up the change
      await ctx.reload();
    },
  });
}
