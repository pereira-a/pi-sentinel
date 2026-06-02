/**
 * Default path-based rules for pi-sentinel.
 *
 * Covers: read, write, edit, grep, find.
 *
 * Path patterns are regex strings matched against the normalized absolute
 * path (forward slashes on all platforms). The "outside-workspace" pathScope
 * sentinel uses workspace boundary checking rather than pattern matching.
 *
 * Rules that apply to both write and edit use tool: ["write", "edit"].
 * Scope rules (outside-workspace) are listed first so they match before
 * the more specific pattern rules — a path outside the workspace is more
 * alarming than a specific filename match inside it.
 */

import type { Rule } from "../types";

// ---------------------------------------------------------------------------
// Read rules
// ---------------------------------------------------------------------------

export const readRules: Rule[] = [
  {
    id: "read.outside-workspace",
    description: "Reading a file outside the workspace boundary",
    enabled: true,
    action: "ask",
    tool: "read",
    match: { pathScope: "outside-workspace" },
  },

  {
    id: "read.env-file",
    description: "Reading a .env file (may contain secrets and credentials)",
    enabled: true,
    action: "ask",
    tool: "read",
    match: { pathPatterns: ["\\.env$", "\\.env\\."] },
  },

  {
    id: "read.secret-files",
    description: "Reading a cryptographic key or certificate file",
    enabled: true,
    action: "ask",
    tool: "read",
    match: {
      pathPatterns: ["\\.(pem|key|p12|pfx|cer|crt|csr|der|jks|keystore)$"],
    },
  },

  {
    id: "read.ssh-dir",
    description: "Reading from SSH config directory (~/.ssh)",
    enabled: true,
    action: "ask",
    tool: "read",
    match: { pathPatterns: ["/\\.ssh/"] },
  },

  {
    id: "read.aws-credentials",
    description: "Reading AWS credentials or config (~/.aws)",
    enabled: true,
    action: "ask",
    tool: "read",
    match: { pathPatterns: ["/\\.aws/(credentials|config)$"] },
  },

  {
    id: "read.gnupg",
    description: "Reading from GnuPG directory (~/.gnupg)",
    enabled: true,
    action: "ask",
    tool: "read",
    match: { pathPatterns: ["/\\.gnupg/"] },
  },

  {
    id: "read.gitconfig",
    description: "Reading git credentials or global config (~/.gitconfig)",
    enabled: true,
    action: "ask",
    tool: "read",
    match: { pathPatterns: ["/\\.gitconfig$", "/\\.git-credentials$"] },
  },

  {
    id: "read.shell-history",
    description: "Reading shell history file",
    enabled: true,
    action: "ask",
    tool: "read",
    match: {
      pathPatterns: ["\\.(bash_history|zsh_history|sh_history|fish_history)$"],
    },
  },

  {
    id: "read.password-managers",
    description: "Reading a password manager database or store",
    enabled: true,
    action: "ask",
    tool: "read",
    match: {
      pathPatterns: [
        "\\.(kdbx|kdb|1pux|agilekeychain|opvault)$",
        "/\\.password-store/",
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Write / edit rules  (tool: ["write", "edit"] = applies to both)
// ---------------------------------------------------------------------------

export const writeRules: Rule[] = [
  // --- DENY ---
  {
    id: "write.ssh-dir",
    description: "Writing to SSH config directory (~/.ssh)",
    enabled: true,
    action: "deny",
    tool: ["write", "edit"],
    match: { pathPatterns: ["/\\.ssh/"] },
  },

  {
    id: "write.hosts-file",
    description: "Writing to /etc/hosts (can redirect network traffic)",
    enabled: true,
    action: "deny",
    tool: ["write", "edit"],
    match: { pathPatterns: ["/etc/hosts$"] },
  },

  {
    id: "write.sudoers",
    description: "Writing to sudoers file (can escalate privileges)",
    enabled: true,
    action: "deny",
    tool: ["write", "edit"],
    match: { pathPatterns: ["/etc/sudoers"] },
  },

  // --- ASK ---
  //

  {
    id: "write.outside-workspace",
    description: "Writing a file outside the workspace boundary",
    enabled: true,
    action: "ask",
    tool: ["write", "edit"],
    match: { pathScope: "outside-workspace" },
  },

  {
    id: "write.env-file",
    description: "Writing a .env file (may expose or overwrite secrets)",
    enabled: true,
    action: "ask",
    tool: ["write", "edit"],
    match: { pathPatterns: ["\\.env$", "\\.env\\."] },
  },

  {
    id: "write.secret-files",
    description: "Writing a cryptographic key or certificate file",
    enabled: true,
    action: "ask",
    tool: ["write", "edit"],
    match: {
      pathPatterns: ["\\.(pem|key|p12|pfx|cer|crt|csr|der|jks|keystore)$"],
    },
  },

  {
    id: "write.gitignore",
    description: "Writing .gitignore (can accidentally expose tracked secrets)",
    enabled: true,
    action: "ask",
    tool: ["write", "edit"],
    match: { pathPatterns: ["\\.gitignore$"] },
  },

  {
    id: "write.package-json",
    description: "Writing package.json (can inject malicious scripts or deps)",
    enabled: true,
    action: "ask",
    tool: ["write", "edit"],
    match: { pathPatterns: ["/package\\.json$", "^package\\.json$"] },
  },
];

// ---------------------------------------------------------------------------
// Grep / find rules
// ---------------------------------------------------------------------------

export const grepRules: Rule[] = [
  {
    id: "grep.outside-workspace",
    description: "Searching files outside the workspace boundary",
    enabled: true,
    action: "ask",
    tool: "grep",
    match: { pathScope: "outside-workspace" },
  },
];

export const findRules: Rule[] = [
  {
    id: "find.outside-workspace",
    description: "Finding files outside the workspace boundary",
    enabled: true,
    action: "ask",
    tool: "find",
    match: { pathScope: "outside-workspace" },
  },
];

export const lsRules: Rule[] = [
  {
    id: "ls.outside-workspace",
    description: "Listing files outside the workspace boundary",
    enabled: true,
    action: "ask",
    tool: "ls",
    match: { pathScope: "outside-workspace" },
  },
];
