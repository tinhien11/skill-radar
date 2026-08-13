# skill-radar

Cross-agent skill health radar for AI coding agents. Hook-free usage scoring from real prompt history, content-hash dedup, bulk cleanup TUI.

```
  Health 46/100   ~3090 tokens/turn wasted
  vs last scan: health ↑10  ·  waste ↓146631  ·  dead →  ·  skills →

  52 skills  46 dead  3 dups  0 broken
```

## Why

Every skill's `description` ships in the system prompt **every turn** — even skills you never invoke. A folder of 50+ skills is a quiet tax on every session. Worse: when the listing overflows its budget, the agent silently drops descriptions starting with the skills you use *least*, so dead skills get deader (a ratchet).

`skill-radar` finds the waste and helps you kill it in seconds — across **all** your AI coding agents at once.

## What's different

| | skills-janitor | skills-admin (skm) | skills-cleaner | **skill-radar** |
|---|---|---|---|---|
| Cross-agent | Claude + Codex | 53 agents | Claude only | **16+ agents** |
| Dedup | name + desc Jaccard | name only | AI similarity (costly) | **content-hash + symlink-aware** |
| Usage scoring | transcript scan (Claude) | none | requires hooks | **prompt_history (Devin+Claude+Codex, no hook)** |
| Trend / history | no | no | no | **yes — compounding** |
| TUI bulk delete | swipe (one-by-one) | no | no | **list + `D` nuke-all-dead** |

The moat: **history compounding**. Each scan appends a snapshot to `~/.config/skill-radar/history.jsonl`. Over time you see your hygiene trend — and that trend is the switching cost another tool can't reconstruct.

## Install

```bash
npm install -g skill-radar
# or run once:
npx skill-radar scan
```

## Usage

```bash
# default: interactive TUI (list view, bulk delete)
skill-radar

# one-shot health report (persists a snapshot for trend)
skill-radar scan

# full waste ranking (all skills)
skill-radar score

# show duplicates (content clones, name collisions, symlink aliases)
skill-radar dedup

# structural issues (broken symlinks, missing SKILL.md, empty dirs)
skill-radar doctor

# scan history (the compounding trend)
skill-radar history
```

### TUI keybindings

| key | action |
|---|---|
| `↑` `↓` / `k` `j` | move cursor (vim-style) |
| `PgUp` `PgDn` / `u` | scroll a page |
| `g` / `G` | jump to top / bottom |
| `i` | inspect full description + metadata of cursor row |
| `d` | delete **all copies** of cursor skill across every agent (confirm y/n) |
| `D` | **delete ALL dead skills + all their copies** (the one-keystroke win) |
| `space` | toggle mark |
| `x` | delete all marked |
| `r` | re-scan (score jumps live) |
| `q` | quit |

The list is windowed (20 rows visible) with a scroll indicator showing `1-20 of 52 ↑↓` so every skill is reachable. No swipe — browsing one-by-one is slow. Sort worst-first, nuke the top with `D`.

## How usage scoring works (without a hook)

Other tools need you to install a PreToolUse/PostToolUse hook before they can score usage. `skill-radar` reads prompt history that agents **already log for free**:

- **Devin**: `~/.local/share/devin/cli/sessions.db` → `prompt_history` table (via `sqlite3` CLI, no native dep)
- **Claude Code**: `~/.claude/history.jsonl` → `display` field
- **Codex**: `~/.codex/history.jsonl` → `text` field

It extracts `/skill-name` invocations and counts them + tracks last-used date. No hook, no setup, no background process.

**Limitation (honest):** this catches *manual* `/skill-name` invocations, not model-auto-triggered skills. A skill the model invokes on its own will show "no manual invoke" even if it's active. This is a weaker signal than transcript scanning (which skills-janitor does for Claude), but it works cross-agent and requires zero setup.

## Agents scanned

`~/.agents/skills`, `~/.claude/skills`, `~/.config/devin/skills`, `~/.codex/skills`, `~/.cursor/skills`, `~/.codeium/windsurf/skills`, `~/.gemini/skills`, `~/.cline/skills`, `~/.continue/skills`, `~/.goose/skills`, `~/.opencode/skills`, `~/.roo/skills`, `~/.crush/skills`, `~/.kiro/skills`, and more. Honors `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`.

## License

MIT
