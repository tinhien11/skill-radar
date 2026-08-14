// Agent skill directory registry — cross-agent support.
// Each agent has one or more skill roots. We honor env overrides where they exist.
// Inspired by skills-admin's 53-agent coverage but trimmed to agents with real
// skill directories on disk (we skip dirs that don't exist on this machine).

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface AgentRoot {
  agent: string;
  scope: "global" | "project";
  path: string;
  // Whether this root typically holds symlinks to another root (e.g. ~/.claude
  // symlinks into ~/.agents). Used to avoid double-counting in dedup.
  usuallySymlinkFarm?: boolean;
}

function home(): string {
  return process.env.HOME || process.env.USERPROFILE || "";
}

function cwd(): string {
  return process.cwd();
}

// Candidate global skill roots across agents. Existence filtered at scan time.
// Computed lazily so tests can override HOME before calling candidateRoots().
function buildCandidates(): AgentRoot[] {
  const H = home();
  const roots: AgentRoot[] = [
    { agent: "agents", scope: "global", path: `${H}/.agents/skills` },
    { agent: "claude", scope: "global", path: `${H}/.claude/skills`, usuallySymlinkFarm: true },
    { agent: "devin", scope: "global", path: `${H}/.config/devin/skills` },
    { agent: "codex", scope: "global", path: `${H}/.codex/skills` },
    { agent: "cursor", scope: "global", path: `${H}/.cursor/skills` },
    { agent: "windsurf", scope: "global", path: `${H}/.codeium/windsurf/skills` },
    { agent: "gemini", scope: "global", path: `${H}/.gemini/skills` },
    { agent: "cline", scope: "global", path: `${H}/.cline/skills` },
    { agent: "continue", scope: "global", path: `${H}/.continue/skills` },
    { agent: "goose", scope: "global", path: `${H}/.goose/skills` },
    { agent: "opencode", scope: "global", path: `${H}/.opencode/skills` },
    { agent: "opencode-local", scope: "global", path: `${H}/.local/share/opencode/skills` },
    { agent: "roo", scope: "global", path: `${H}/.roo/skills` },
    { agent: "crush", scope: "global", path: `${H}/.crush/skills` },
    { agent: "kiro", scope: "global", path: `${H}/.kiro/skills` },
    { agent: "gemini-home", scope: "global", path: `${H}/.config/gemini/skills` },
    // Non-standard agent dirs that some users have on disk.
    { agent: "kimi-code", scope: "global", path: `${H}/.kimi-code/skills` },
    { agent: "commandcode", scope: "global", path: `${H}/.commandcode/skills` },
  ];

  // Recursively discover plugin/marketplace skill directories.
  // Agents like Claude Code and Kimi Code install skills under nested plugin
  // directories (e.g. ~/.claude/plugins/marketplaces/.../skills/). We walk up
  // to 4 levels deep to find any directory named "skills" that contains at
  // least one subdirectory with a SKILL.md.
  roots.push(...discoverPluginRoots(`${H}/.claude/plugins`, "claude-plugin"));
  roots.push(...discoverPluginRoots(`${H}/.kimi-code/plugins`, "kimi-plugin"));

  // Project-level skill roots from the current working directory.
  // These are only scanned if they exist on disk.
  const C = cwd();
  roots.push(
    { agent: "project-devin", scope: "project", path: `${C}/.devin/skills` },
    { agent: "project-agents", scope: "project", path: `${C}/.agents/skills` },
    { agent: "project-windsurf", scope: "project", path: `${C}/.windsurf/skills` },
    { agent: "project-claude", scope: "project", path: `${C}/.claude/skills` },
  );

  return roots;
}

// Walk a plugin directory tree (up to maxDepth levels) and find any
// subdirectory named "skills" that looks like a skill root (contains at
// least one subdir with SKILL.md). This catches nested plugin installs
// like ~/.claude/plugins/marketplaces/official/plugins/foo/skills/.
function discoverPluginRoots(pluginsDir: string, agentName: string, maxDepth = 4): AgentRoot[] {
  const roots: AgentRoot[] = [];
  if (!existsSync(pluginsDir)) return roots;

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const child = join(dir, name);
      let st;
      try {
        st = statSync(child);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      if (name === "skills") {
        // Verify this looks like a skill root: at least one subdir has SKILL.md.
        if (looksLikeSkillRoot(child)) {
          roots.push({ agent: agentName, scope: "global", path: child });
        }
        // Don't recurse into a skills/ dir — its children are skill dirs, not
        // more plugin trees.
        continue;
      }
      // Recurse into non-skills subdirectories.
      walk(child, depth + 1);
    }
  }

  walk(pluginsDir, 0);
  return roots;
}

// A "skill root" is a directory whose immediate children are skill directories
// (each containing a SKILL.md). We check at least one child has SKILL.md.
function looksLikeSkillRoot(dir: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (existsSync(join(dir, name, "SKILL.md"))) return true;
  }
  return false;
}

let CANDIDATES: AgentRoot[] = buildCandidates();

// Honor common env overrides.
function applyEnvOverrides(): void {
  if (process.env.CLAUDE_CONFIG_DIR) {
    const i = CANDIDATES.findIndex((c) => c.agent === "claude");
    if (i >= 0) CANDIDATES[i].path = `${process.env.CLAUDE_CONFIG_DIR}/skills`;
  }
  if (process.env.CODEX_HOME) {
    const i = CANDIDATES.findIndex((c) => c.agent === "codex");
    if (i >= 0) CANDIDATES[i].path = `${process.env.CODEX_HOME}/skills`;
  }
  if (process.env.XDG_CONFIG_HOME) {
    const i = CANDIDATES.findIndex((c) => c.agent === "devin");
    if (i >= 0) CANDIDATES[i].path = `${process.env.XDG_CONFIG_HOME}/devin/skills`;
  }
}

applyEnvOverrides();

export function candidateRoots(): AgentRoot[] {
  // Rebuild on each call so tests that change HOME see the new paths.
  CANDIDATES = buildCandidates();
  applyEnvOverrides();
  return CANDIDATES;
}
