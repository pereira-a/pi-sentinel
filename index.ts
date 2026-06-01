/**
 * pi-sentinel — entry point.
 *
 * Phase 1: skeleton wiring.
 *   - Load and reload config on session_start
 *   - tool_call handler (pass-through, no rules yet)
 *   - Footer status indicator
 *   - /sentinel-status command
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, getConfigPaths } from "./src/config";
import { registerCommands } from "./src/commands";
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
    if (!configPaths) throw new Error("[pi-sentinel] Config paths not yet resolved");
    return configPaths;
  }

  // -------------------------------------------------------------------------
  // session_start: (re)load config and refresh status indicator
  // -------------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(ctx.cwd);
    configPaths = getConfigPaths(ctx.cwd);
    updateStatus(ctx);
  });

  // -------------------------------------------------------------------------
  // tool_call: placeholder pass-through (rules wired in Phase 2)
  // -------------------------------------------------------------------------

  pi.on("tool_call", async (_event, _ctx) => {
    if (!config?.enabled) return undefined;

    // Rule evaluation will be added in Phase 2.
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
