# ⚡ Pi Fleet

Manage multiple [pi](https://github.com/badlogic/pi-mono) instances across git worktrees from a single dashboard.

When you're working on multiple features in parallel using `git worktree`, each worktree gets its own pi instance. Pi Fleet gives you visibility across all of them — what's running, what's idle, and quick access to create/switch/remove worktrees.

## Install

Copy or clone into your global pi extensions directory:

```bash
git clone https://github.com/samyakjain0606/pi-fleet.git ~/.pi/agent/extensions/pi-fleet
```

Then `/reload` in any running pi session.

## Commands

| Command | Description |
|---------|-------------|
| `/fleet` | Open the TUI dashboard |
| `/fleet status` | Quick one-line summary |
| `/fleet create [name]` | Create a new worktree (interactive if no name) |
| `/fleet launch <name>` | Show command to launch pi in a worktree |
| `/fleet switch <name>` | Show command to switch to a worktree |
| `/fleet remove <name>` | Remove a worktree |

## Dashboard

```
  ⚡ Pi Fleet ─ my-repo                              3 worktrees

  ▸ ● my-repo (main) ★ you  main               opus-4-6
      idle • 15 turns • just now
      "fix the agent config schema"

    ● auth-refactor          feature/auth-refactor  sonnet-4
      streaming → edit • 2s ago
      "refactor the auth middleware"

    ○ pipeline-fix           feature/pipeline-fix   (new)
      no sessions yet

  ↑↓ navigate │ enter open │ s switch │ l launch │ d details
  c create worktree │ x remove │ r refresh │ q quit
```

### Status Icons

| Icon | Meaning |
|------|---------|
| 🟢 `●` (green) | Pi running — idle |
| 🔵 `●` (blue) | Pi running — streaming |
| 🟡 `●` (yellow) | Pi running — executing a tool |
| ⚪ `○` (gray) | No pi running, has past sessions |
| `○` (dim) | No pi running, no sessions (fresh worktree) |
| `★` | Current worktree (where you're running this pi) |

### Keys

| Key | Action |
|-----|--------|
| `↑↓` / `jk` | Navigate |
| `enter` | Show command to open this worktree |
| `s` | Show command to switch (open + close current) |
| `l` | Show command to launch pi |
| `c` | Create a new worktree |
| `x` | Remove selected worktree |
| `d` | Toggle expanded details (path, PID, sessions) |
| `r` | Refresh |
| `q` / `Esc` | Quit |

## How It Works

**Heartbeat system** — every pi instance writes a JSON heartbeat file to `~/.pi/agent/fleet/<pid>.json` with its live status (idle/streaming/tool running), model, turn count, last message, etc. Heartbeats update on every event and refresh every 30 seconds. Stale heartbeats from dead processes are auto-cleaned.

**Three-layer discovery:**

1. `git worktree list --porcelain` → all worktrees (ground truth)
2. `~/.pi/agent/sessions/` → which worktrees have session history
3. `~/.pi/agent/fleet/` → which worktrees have a live pi instance

**Worktree management** — creates worktrees with `feature/<name>` branch naming. Reads `pi-worktrees-settings.json` if [@zenobius/pi-worktrees](https://www.npmjs.com/package/@zenobius/pi-worktrees) is installed (for `parentDir` and `onCreate` hooks), otherwise defaults to `../<project>.worktrees/`.

## File Structure

```
~/.pi/agent/extensions/pi-fleet/
├── index.ts          # Entry point — commands, event handlers, heartbeat
├── dashboard.ts      # TUI dashboard component
├── discovery.ts      # Git worktree + session + heartbeat merging
├── heartbeat.ts      # PID-keyed heartbeat file management
├── worktree.ts       # Worktree create/remove operations
└── terminal.ts       # Command helpers for launching pi
```

## License

MIT
