// Agent skill directory registry — cross-agent support.
// Each agent has one or more skill roots. We honor env overrides where they exist.
// Inspired by skills-admin's 53-agent coverage but trimmed to agents with real
// skill directories on disk (we skip dirs that don't exist on this machine).

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

// Candidate global skill roots across agents. Existence filtered at scan time.
// Computed lazily so tests can override HOME before calling candidateRoots().
function buildCandidates(): AgentRoot[] {
  const H = home();
  return [
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
  ];
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
