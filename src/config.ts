/**
 * Config loading, merging, and saving for pi-sentinel.
 *
 * Config resolution order (last wins):
 *   1. Built-in defaults
 *   2. Global config   (~/.pi/agent/extensions/pi-sentinel/config.json)
 *   3. Project config  (<cwd>/.pi/pi-sentinel/config.json)
 *
 * Rules are merged by id. Non-rule scalars use last-wins. workspacePaths
 * from each layer are appended together (not replaced).
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import type { Rule, SentinelConfig, UserConfig } from "./types";

import { getDefaultRules } from "./rules/index";

// ---------------------------------------------------------------------------
// Default full config
// ---------------------------------------------------------------------------

function buildDefaults(cwd: string): SentinelConfig {
  return {
    enabled: true,
    rules: getDefaultRules(),
    workspacePaths: [resolve(cwd)],
    defaultAction: "ask",
  };
}

// ---------------------------------------------------------------------------
// Config file paths
// ---------------------------------------------------------------------------

export interface ConfigPaths {
  global: string;
  project: string;
}

export function getConfigPaths(cwd: string): ConfigPaths {
  return {
    global: join(getAgentDir(), "pi-sentinel", "config.json"),
    project: join(cwd, ".pi", "pi-sentinel", "config.json"),
  };
}

// ---------------------------------------------------------------------------
// Read a single user config file
// ---------------------------------------------------------------------------

function readUserConfig(path: string): UserConfig | null {
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as UserConfig;
  } catch (err) {
    // Return null on parse errors so a bad file never crashes the extension.
    console.warn(`[pi-sentinel] Failed to parse config at ${path}:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Merge a UserConfig layer on top of a base SentinelConfig
// ---------------------------------------------------------------------------

function mergeLayer(
  base: SentinelConfig,
  layer: UserConfig,
  cwd: string,
): SentinelConfig {
  const result = { ...base };

  if (typeof layer.enabled === "boolean") {
    result.enabled = layer.enabled;
  }

  if (layer.defaultAction !== undefined) {
    result.defaultAction = layer.defaultAction;
  }

  // Append extra workspace paths without duplicates
  if (Array.isArray(layer.workspacePaths)) {
    const existing = new Set(result.workspacePaths);
    for (const p of layer.workspacePaths) {
      const abs = resolve(cwd, p);
      if (!existing.has(abs)) {
        result.workspacePaths = [...result.workspacePaths, abs];
        existing.add(abs);
      }
    }
  }

  // Merge rules by id: user layer can override any field of a default rule,
  // or introduce entirely new rules.
  if (Array.isArray(layer.rules)) {
    const ruleMap = new Map<string, Rule>(result.rules.map((r) => [r.id, r]));

    for (const override of layer.rules) {
      const existing = ruleMap.get(override.id);
      if (existing) {
        ruleMap.set(override.id, { ...existing, ...override } as Rule);
      } else {
        // New rule introduced by user config — must be complete enough to be valid.
        // We do a best-effort inclusion; the rule engine will skip incomplete rules.
        ruleMap.set(override.id, override as Rule);
      }
    }

    result.rules = Array.from(ruleMap.values());
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public: load the merged config
// ---------------------------------------------------------------------------

export function loadConfig(cwd: string): SentinelConfig {
  const paths = getConfigPaths(cwd);
  let config = buildDefaults(cwd);

  const globalLayer = readUserConfig(paths.global);
  if (globalLayer) {
    config = mergeLayer(config, globalLayer, cwd);
  }

  const projectLayer = readUserConfig(paths.project);
  if (projectLayer) {
    config = mergeLayer(config, projectLayer, cwd);
  }

  return config;
}

// ---------------------------------------------------------------------------
// Public: save a UserConfig to a specific path (global or project)
// ---------------------------------------------------------------------------

export function saveUserConfig(filePath: string, userConfig: UserConfig): void {
  const dir = join(filePath, "..");
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(userConfig, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Public: read the raw UserConfig from a path (null if missing/invalid)
// ---------------------------------------------------------------------------

export function readRawUserConfig(filePath: string): UserConfig {
  return readUserConfig(filePath) ?? {};
}
