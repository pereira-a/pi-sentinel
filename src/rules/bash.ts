/**
 * Default bash command rules for pi-sentinel.
 *
 * Patterns are regex strings matched case-insensitively against the full
 * command string. All paths are normalized to forward slashes before matching.
 *
 * Rule ordering matters: deny rules that are subsets of ask rules come first
 * so they match before the broader ask rule.
 */

import type { Rule } from "../types";

export const bashRules: Rule[] = [
  // -------------------------------------------------------------------------
  // DENY — no dialog, always blocked
  // -------------------------------------------------------------------------

  {
    id: "bash.rm-rf-root",
    description: "Recursive force delete of filesystem root (rm -rf /)",
    enabled: true,
    action: "deny",
    tool: "bash",
    match: {
      commandPatterns: [
        // rm ... / at end-of-command or before a chained operator
        "\\brm\\b[^\\n]{0,80}\\s/\\s*(?:$|;|&&|\\|\\|)",
        // rm ... /* (all of root)
        "\\brm\\b[^\\n]{0,80}\\s/\\*",
      ],
    },
  },

  {
    id: "bash.disk-format",
    description: "Disk formatting or raw disk write (mkfs, fdisk, dd)",
    enabled: true,
    action: "deny",
    tool: "bash",
    match: {
      commandPatterns: [
        "\\bmkfs\\b",
        "\\bfdisk\\b",
        // dd with both if= and of= is a raw device write
        "\\bdd\\b[^\\n]+\\bif=[^\\n]+\\bof=",
      ],
    },
  },

  {
    id: "bash.shutdown",
    description: "System shutdown, reboot, or halt",
    enabled: true,
    action: "deny",
    tool: "bash",
    match: {
      commandPatterns: ["\\b(shutdown|reboot|halt|poweroff)\\b"],
    },
  },

  // -------------------------------------------------------------------------
  // ASK — show confirmation dialog
  // -------------------------------------------------------------------------

  {
    id: "bash.rm-rf",
    description: "Recursive file deletion (rm -r / --recursive)",
    enabled: true,
    action: "ask",
    tool: "bash",
    match: {
      commandPatterns: [
        "\\brm\\s+[^\\n]*(\\s-[a-zA-Z]*r[a-zA-Z]*|\\s--recursive|-rf\\b|-fr\\b)",
      ],
    },
  },

  {
    id: "bash.sudo",
    description: "Elevated privilege execution (sudo)",
    enabled: true,
    action: "ask",
    tool: "bash",
    match: {
      commandPatterns: ["\\bsudo\\b"],
    },
  },

  {
    id: "bash.chmod-777",
    description: "World-writable permission change (chmod 777)",
    enabled: true,
    action: "ask",
    tool: "bash",
    match: {
      commandPatterns: ["\\bchmod\\b[^\\n]*\\b777\\b"],
    },
  },

  {
    id: "bash.pipe-exec",
    description: "Pipe remote content directly into a shell (curl/wget | sh)",
    enabled: true,
    action: "ask",
    tool: "bash",
    match: {
      commandPatterns: [
        "\\b(curl|wget)\\b[^\\n]*\\|\\s*(ba|z|k|c|da|fi|tc)?sh\\b",
      ],
    },
  },

  {
    id: "bash.env-export",
    description: "Export of sensitive environment variable names",
    enabled: true,
    action: "ask",
    tool: "bash",
    match: {
      commandPatterns: [
        "\\bexport\\b[^\\n]*(TOKEN|SECRET|_KEY|PASSWORD|CREDENTIAL|PRIVATE)",
      ],
    },
  },

  {
    id: "bash.truncate-file",
    description: "Redirect that truncates a file at an absolute path (> /path)",
    enabled: true,
    action: "ask",
    tool: "bash",
    match: {
      // Matches > /path but not >> /path (append is less dangerous)
      commandPatterns: ["(?<![>])>(?![>])\\s*/[a-zA-Z]"],
    },
  },

  {
    id: "bash.kill-all",
    description: "Sends a signal to all processes (kill -9 -1 or killall)",
    enabled: true,
    action: "ask",
    tool: "bash",
    match: {
      commandPatterns: ["\\bkill\\s+-9\\s+-1\\b", "\\bkillall\\b"],
    },
  },

  {
    id: "bash.history-clear",
    description: "Shell history deletion or clearing",
    enabled: true,
    action: "ask",
    tool: "bash",
    match: {
      commandPatterns: [
        "\\bhistory\\s+-[cw]\\b",
        "\\brm\\b[^\\n]*(bash_history|zsh_history|sh_history|fish_history)",
      ],
    },
  },

  {
    id: "bash.npm-publish",
    description: "Publishing a package to a registry (npm/yarn/pnpm publish)",
    enabled: true,
    action: "ask",
    tool: "bash",
    match: {
      commandPatterns: ["\\b(npm|yarn|pnpm)\\s+publish\\b"],
    },
  },

  {
    id: "bash.git-force-push",
    description: "Force push to a git remote (rewrites published history)",
    enabled: true,
    action: "ask",
    tool: "bash",
    match: {
      commandPatterns: [
        "\\bgit\\b[^\\n]*\\bpush\\b[^\\n]*(--force|-f\\b)",
      ],
    },
  },
];
