# Changelog

All notable changes to skill-radar will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-08-14

### Added
- `--json` output mode for `scan`, `score`, `dedup`, `doctor`, `history` commands — enables scripting, CI/CD, and custom dashboards
- `skill-radar init` — first-run setup wizard that checks agent directories, verifies history access, runs a quick scan, and explains next steps
- `skill-radar report` — generates a shareable markdown report with health summary, waste ranking, duplicates, issues, and recommendations (`-o` flag to write to file)
- `doctor --fix` — auto-remediation: removes broken symlinks and duplicate copies (with `--dry-run` support)
- TUI search/filter — press `/` to search by name or description, `Esc` to clear, live filtering as you type
- LICENSE file (MIT)
- CHANGELOG.md
- `--backup` flag for `clean` command — copies skills to `~/.local/share/skill-radar/backups/` before deletion
- Backup module with prune (keeps last 10 backups)
- Cross-platform command-existence check (`commandExists`) — uses `where` on Windows, `command -v` on Unix
- Natural-language skill detection — matches skill names mentioned in prompts (not just `/skill-name` or path paste)
- Python3 fallback for reading Devin sqlite history (when `sqlite3` CLI is not installed)
- Plugin/marketplace discovery — recursively walks `~/.claude/plugins/` and `~/.kimi-code/plugins/` to find nested skill dirs
- Non-standard agent roots: `~/.kimi-code/skills/`, `~/.commandcode/skills/`
- Project-level skill roots: `.devin/skills`, `.agents/skills`, `.windsurf/skills`, `.claude/skills` in cwd
- Path-paste usage detection — matches `skills/<name>/SKILL.md` patterns in prompt history
- History rotation — keeps last 365 entries in active file, moves older to `history.jsonl.old`

### Fixed
- Windows compatibility — replaced Unix-only `command -v` with cross-platform `commandExists` helper
- NL regex explosion — capped at 50 skill names (sorted by length descending) to prevent regex crash with 100+ skills
- Silent skill disappearance — scanner now finds skills in plugin dirs, non-standard agent roots, and project-level dirs
- `azr-workflow` and similar skills reported as "dead" despite usage — path-paste detection now catches `skills/<name>/SKILL.md` patterns
- Devin history silently skipped when `sqlite3` CLI missing — Python3 fallback reads the same data

## [0.1.0] - 2026-08-13

### Added
- Cross-agent skill scanning (16+ agents)
- Content-hash dedup (not just name-based)
- Hook-free usage scoring from prompt history (Devin sqlite, Claude jsonl, Codex jsonl)
- Health score (0-100) with waste token estimation
- History compounding — each scan appends a snapshot for trend tracking
- TUI with bulk delete (`D` = nuke all dead, `d` = delete all copies of one skill)
- Commands: `scan`, `score`, `dedup`, `doctor`, `history`, `clean`
- CI: test on Ubuntu + macOS × Node 20 + 22
- npm Trusted Publishing via OIDC
