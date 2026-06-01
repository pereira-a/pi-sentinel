# pi-sentinel: Implementation Plan

## Goal

A pi extension that intercepts tool calls before execution, evaluates each action against a
configurable rule set, and prompts the user to allow or deny anything that falls into a
"protected" category. The user can escalate a one-time decision to session-wide or permanent
allowance, and permanent decisions are written back to the config file automatically.

---

## Architecture Overview

```
tool_call event
     │
     ▼
Rule Engine
     │── match against DENY rules  ──► block immediately (notify user)
     │── match against ALLOW rules ──► pass through silently
     └── match against ASK rules   ──► show dialog
                                           │
                              ┌────────────┼────────────┐
                              ▼            ▼            ▼
                          Allow once   Allow session  Allow always
                                            │               │
                                      session cache   write to config
```

---

## File Structure

```
pi-control/
├── package.json            # Extension package with pi entry point
├── README.md
├── index.ts                # Extension entry: wires everything together
└── src/
    ├── types.ts            # All shared types and interfaces
    ├── config.ts           # Load/save config.json; merge defaults
    ├── rule-engine.ts      # Match tool calls against rules; return verdict
    ├── rules/
    │   ├── bash.ts         # Bash command pattern definitions and matchers
    │   ├── paths.ts        # Path-based rules: secrets, outside-workspace
    │   └── index.ts        # Re-exports all rule sets
    ├── prompt.ts           # User interaction: dialog, decision escalation
    └── commands.ts         # /guard-status, /guard-rules, /guard-toggle
```

---

## Config Schema

Stored at two levels (project wins over global):
- **Global:** `~/.pi/agent/extensions/pi-sentinel/config.json`
- **Project:** `.pi/pi-sentinel/config.json`

```typescript
interface Config {
  // Master switch. Setting to false disables all interception.
  enabled: boolean;

  // Rules evaluated in order. First match wins.
  rules: Rule[];

  // Paths that are always considered "inside the workspace".
  // Defaults to [process.cwd()]. Can add extra trusted paths.
  workspacePaths: string[];

  // What to do when no rule matches a tool call.
  // "allow" = pass through silently (default)
  // "ask"   = prompt for every unmatched call (strict mode)
  defaultAction: "allow" | "ask";
}

interface Rule {
  id: string;              // Unique stable identifier (e.g., "bash.rm-rf")
  description: string;     // Human-readable label shown in dialogs
  enabled: boolean;        // Can be toggled without deleting
  action: "deny" | "ask" | "allow";

  // Tool this rule applies to. "*" = all tools.
  tool: "bash" | "read" | "write" | "edit" | "grep" | "find" | "*";

  // Matcher: at least one must be provided.
  match: {
    // For bash: regex patterns matched against the command string
    commandPatterns?: string[];

    // For path-based tools: glob or regex matched against the path
    pathPatterns?: string[];

    // Whether path is relative to workspace root (false = absolute)
    pathRelative?: boolean;

    // "outside-workspace": special sentinel that checks if the resolved
    // path escapes all configured workspacePaths
    pathScope?: "outside-workspace" | "inside-workspace";
  };
}
```

### Merged Config Strategy

On load, the extension merges `defaults` + `global config` + `project config`:
- Rules from all layers are merged by `id`. Project config wins on conflicts.
- `workspacePaths` from project config is appended to (not replaced).
- Unknown `id`s in user config are preserved (forward compatibility).

---

## Default Rules

The defaults file ships with the extension and is never modified. User overrides are
written to the appropriate config file only.

### Bash Rules

| id | Pattern | Default Action |
|----|---------|----------------|
| `bash.rm-rf-root` | `rm -rf /`, `rm -rf /*` | **deny** |
| `bash.rm-rf` | `rm -r?f?` (recursive remove) | **ask** |
| `bash.sudo` | `sudo ...` | **ask** |
| `bash.chmod-777` | `chmod.*777` | **ask** |
| `bash.disk-format` | `mkfs`, `fdisk`, `dd if=.*of=` | **deny** |
| `bash.pipe-exec` | `curl.*\| (ba)?sh`, `wget.*\| (ba)?sh` | **ask** |
| `bash.env-export` | `export.*TOKEN\|SECRET\|KEY\|PASS` | **ask** |
| `bash.truncate-file` | `> somefile` (truncation via redirect) | **ask** |
| `bash.kill-all` | `kill -9 -1`, `killall` | **ask** |
| `bash.shutdown` | `shutdown`, `reboot`, `halt`, `poweroff` | **deny** |
| `bash.history-clear` | `history -c`, `rm.*bash_history` | **ask** |
| `bash.npm-publish` | `npm publish`, `yarn publish` | **ask** |
| `bash.git-force-push` | `git push.*--force` | **ask** |

### Read Rules

| id | Pattern | Default Action |
|----|---------|----------------|
| `read.env-file` | `\.env$`, `\.env\..*` | **ask** |
| `read.secret-files` | `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.cer` | **ask** |
| `read.ssh-dir` | `/.ssh/` | **ask** |
| `read.aws-credentials` | `/.aws/credentials`, `/.aws/config` | **ask** |
| `read.gnupg` | `/.gnupg/` | **ask** |
| `read.outside-workspace` | path escapes CWD | **ask** |
| `read.gitconfig` | `~/.gitconfig`, `~/.git-credentials` | **ask** |
| `read.shell-history` | `.*_history`, `.*rc` in home dir | **ask** |
| `read.password-managers` | `*.kdbx`, `*.1pux`, `pass/` store paths | **ask** |

### Write / Edit Rules

| id | Pattern | Default Action |
|----|---------|----------------|
| `write.outside-workspace` | path escapes CWD | **deny** |
| `write.env-file` | `\.env$`, `\.env\..*` | **ask** |
| `write.secret-files` | `*.pem`, `*.key`, etc. | **ask** |
| `write.gitignore` | `.gitignore` | **ask** |
| `write.package-json` | `package.json` | **ask** (can add malicious scripts) |
| `write.ci-config` | `.github/`, `.gitlab-ci.yml`, Jenkinsfile | **ask** |
| `write.ssh-dir` | `~/.ssh/` | **deny** |
| `write.hosts-file` | `/etc/hosts` | **deny** |
| `write.sudoers` | `/etc/sudoers*` | **deny** |

### Grep / Find Rules

| id | Pattern | Default Action |
|----|---------|----------------|
| `grep.outside-workspace` | path escapes CWD | **ask** |
| `find.outside-workspace` | path escapes CWD | **ask** |

---

## User Interaction Flow

When a rule with `action: "ask"` matches:

```
┌────────────────────────────────────────────────────────────┐
│  Sentinel: Action requires confirmation                    │
│                                                            │
│  Tool:    bash                                             │
│  Command: rm -rf ./dist                                    │
│  Rule:    bash.rm-rf — recursive file deletion             │
│                                                            │
│  > Allow once                                              │
│    Allow for this session                                  │
│    Always allow (save to config)                           │
│    Deny                                                    │
└────────────────────────────────────────────────────────────┘
```

For a **deny** rule (no prompt option), a notification is shown:

```
[sentinel] Blocked: bash.rm-rf-root — rm -rf / is never allowed
```

### Decision Escalation

| Choice | Effect |
|--------|--------|
| Allow once | Unblock this specific call. No state saved. |
| Allow for session | Add an in-memory `allow` override for (tool + pattern) until session ends. |
| Always allow | Append an `allow` rule to the user config file (global or project, user's choice). |
| Deny | Block the call. Return `{ block: true, reason }`. |

For "Always allow", the extension writes a new rule entry to the config file with `action: "allow"` and the same `match` signature. It also sets `enabled: true` and a generated `id` like `user.allow.bash.rm-rf.1748123456`.

---

## Persistence Strategy

### Session-level memory

An in-memory `Map<string, "allow" | "deny">` keyed by a fingerprint of `(toolName, matchedRuleId, inputHash)` stores decisions made during the session. Consulted before rules are re-evaluated on subsequent matching calls.

### Permanent rules

Written to config JSON using Node's `fs.writeFileSync` with a read-modify-write pattern. The write is wrapped in `withFileMutationQueue` to be safe against concurrent writes from the extension itself.

The extension re-reads the config file on each `session_start` and after any write, so changes take effect without a `/reload`.

---

## Commands

### `/sentinel-status`
Shows:
- Enabled/disabled state
- Active rule count (by action type)
- Session-level overrides in effect
- Config file paths being used

### `/sentinel-rules`
Opens a `SettingsList`-style custom UI listing all active rules with:
- Toggle on/off per rule
- Current action (deny / ask / allow)
- Edit pattern (opens `ctx.ui.editor`)
- Delete rule

### `/sentinel-toggle`
Quick toggle: enable/disable the extension without changing any rules.
Writes the `enabled` flag to config.

### `/sentinel-audit`
Show a log of all blocked/allowed decisions made in the current session (in-memory log).

---

## Implementation Phases

### Phase 1: Core Skeleton

- `package.json` with `name: "pi-sentinel"` and extension entry point
- `types.ts` with all interfaces
- `config.ts`: load defaults, merge with user config, expose typed config object
- `index.ts`: wire `tool_call` event, always pass through (no rules yet)
- Basic `/sentinel-status` command

### Phase 2: Rule Engine

- `rule-engine.ts`: match a tool call against a list of rules; return `{ verdict, rule }`
- `bash.ts`: compile all bash patterns (regex), export as `Rule[]`
- `paths.ts`: path resolution helpers (resolve, check workspace escape), export as `Rule[]`
- `rules/index.ts`: aggregate all default rules

### Phase 3: User Prompting

- `prompt.ts`: build the `ctx.ui.select` dialog with 4 choices
- Wire the verdict → prompt → decision → block or pass flow in `index.ts`
- Session-level memory: in-memory allow/deny cache

### Phase 4: Persistence

- "Always allow" writes a new rule to the user config file
- `/sentinel-toggle` writes `enabled` flag
- Config re-read on `session_start`

### Phase 5: Commands & UI

- `/sentinel-rules` custom TUI list (toggle, edit, delete)
- `/sentinel-audit` session log view
- Footer status indicator showing "sentinel: active (N rules)" or "sentinel: off"

### Phase 6: Polish

- `README.md` with full rule reference and usage guide
- Handle non-interactive mode (`ctx.hasUI === false`): fall back to `deny` for `ask` rules
- Validate config on load; warn on bad patterns without crashing
- `before_agent_start` hook: inject a one-line note into the system prompt when sentinel is active,
  so the model knows some actions will be gated

---

## Tech Stack

- **TypeScript** (jiti, no compilation needed)
- **Node.js builtins**: `node:fs`, `node:path`, `node:os`
- **pi APIs**: `tool_call`, `session_start`, `before_agent_start`, `ctx.ui.*`, `pi.appendEntry`, `pi.registerCommand`, `withFileMutationQueue`
- **No external npm dependencies** (keeps installation trivial)

---

## Key Design Decisions

1. **Rule merging, not replacement**: Default rules ship with the extension. User config only
   overrides or extends them. Deleting a rule in the UI sets `enabled: false`, not a physical
   removal, so the default can be restored.

2. **Workspace boundary as first-class concept**: Path rules compare resolved absolute paths
   against the configured `workspacePaths` list. The default is `[process.cwd()]`. This is the
   primary protection against accidental reads/writes to home directory or system paths.

3. **No regex in user-facing config (initially)**: User config uses glob patterns for paths and
   literal substring prefixes for bash commands. Regex is only used internally. This keeps the
   config readable and safe from injection surprises.

4. **deny rules cannot be bypassed**: Rules with `action: "deny"` never show a dialog. They
   block silently and notify the user. Only `action: "ask"` rules offer the allow/deny/escalate
   dialog. This prevents prompt fatigue from causing accidental bypasses on truly dangerous
   actions.

5. **Audit trail in-memory only (phase 1)**: Session audit log is in-memory. A future phase
   could use `pi.appendEntry` to persist the log across restarts.
