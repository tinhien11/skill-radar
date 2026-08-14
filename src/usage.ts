// Usage reader: the moat. Reads REAL prompt history from each agent's logs
// WITHOUT requiring any hook to be installed. This is the gap no other tool
// fills cross-agent:
//   - skills-janitor scans Claude transcripts (Claude-only)
//   - skills-cleaner / claude-skill-audit require a pre-installed hook
// We read:
//   - Devin:  ~/.local/share/devin/cli/sessions.db  (sqlite, prompt_history table)
//   - Claude: ~/.claude/history.jsonl               (user-typed slash commands)
//   - Codex:  ~/.codex/history.jsonl                (session prompts)
// Each source yields {skillName, count, lastUsedTs} for /skill-name invocations.

import { existsSync, readFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";

// Cross-platform command-existence check. Uses `command -v` on Unix and
// `where` on Windows. Returns true if the command is on PATH.
function commandExists(cmd: string): boolean {
  const check = process.platform === "win32" ? `where ${cmd}` : `command -v ${cmd}`;
  try {
    execSync(check, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface UsageEntry {
  skillName: string;
  count: number;
  lastUsedTs: number; // ms epoch, 0 if never
  sources: string[];  // which agents saw this skill used
}

function home(): string {
  return process.env.HOME || process.env.USERPROFILE || "";
}

// Extract skill invocations from a free-text prompt. Two patterns:
//   1. Slash command: "/simple-english Thanks..."  ->  "simple-english"
//   2. Path paste: ".../skills/azr-workflow/SKILL.md"  ->  "azr-workflow"
// Many users invoke skills by pasting the SKILL.md path rather than typing
// /skill-name, so we catch both.
const SLASH_RE = /(?:^|\s)\/([a-z][a-z0-9_-]*)(?:\s|$)/gi;
const SKILLMD_PATH_RE = /(?:^|[^\w])skills\/([a-z0-9][a-z0-9_-]*)\/SKILL\.md/gi;

function extractSkillNames(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  let m: RegExpExecArray | null;
  SLASH_RE.lastIndex = 0;
  while ((m = SLASH_RE.exec(text)) !== null) {
    out.push(m[1].toLowerCase());
  }
  SKILLMD_PATH_RE.lastIndex = 0;
  while ((m = SKILLMD_PATH_RE.exec(text)) !== null) {
    out.push(m[1].toLowerCase());
  }
  return out;
}

// --- Devin: sqlite via the `sqlite3` CLI (avoids native better-sqlite3 dep,
//     which is painful for npx). Falls back to Python3's built-in sqlite3
//     module (always available on Linux/macOS) if the sqlite3 CLI is missing.
function readDevin(): Map<string, UsageEntry> {
  const out = new Map<string, UsageEntry>();
  const db = `${home()}/.local/share/devin/cli/sessions.db`;
  if (!existsSync(db)) return out;

  // Try sqlite3 CLI first (fastest, native JSON output).
  let rows: Array<{ content: string; timestamp: number }> = [];
  let gotRows = false;

  if (commandExists("sqlite3")) {
    try {
      const raw = execSync(
        `sqlite3 -json "${db}" "SELECT content, timestamp FROM prompt_history"`,
        { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      );
      rows = JSON.parse(raw);
      gotRows = true;
    } catch {
      // query failed
    }
  }

  if (!gotRows) {
    if (commandExists("python3")) {
      try {
        const pyScript = [
          "import sqlite3, json, sys",
          `conn = sqlite3.connect(${JSON.stringify(db)})`,
          "conn.row_factory = sqlite3.Row",
          "cur = conn.cursor()",
          'cur.execute("SELECT content, timestamp FROM prompt_history")',
          "rows = [dict(r) for r in cur.fetchall()]",
          "json.dump(rows, sys.stdout)",
          "conn.close()",
        ].join("\n");
        const raw = execSync(`python3 -c '${pyScript.replace(/'/g, "'\\''")}'`, {
          maxBuffer: 64 * 1024 * 1024,
          encoding: "utf8",
        });
        rows = JSON.parse(raw);
        gotRows = true;
      } catch {
        // Python3 query failed — give up on Devin.
        return out;
      }
    } else {
      // Neither sqlite3 nor python3 available — give up on Devin.
      return out;
    }
  }

  for (const row of rows) {
    const names = extractSkillNames(row.content || "");
    const ts = (row.timestamp || 0) * 1000; // Devin stores seconds
    for (const name of names) {
      const e = out.get(name) || { skillName: name, count: 0, lastUsedTs: 0, sources: [] };
      e.count += 1;
      if (ts > e.lastUsedTs) e.lastUsedTs = ts;
      if (!e.sources.includes("devin")) e.sources.push("devin");
      out.set(name, e);
    }
  }
  return out;
}

// --- Claude: history.jsonl — one JSON object per line, has `display` field.
function readJsonlHistory(
  path: string,
  agent: string,
  displayField: string = "display",
  tsField: string = "timestamp",
  tsIsMs: boolean = true,
): Map<string, UsageEntry> {
  const out = new Map<string, UsageEntry>();
  if (!existsSync(path)) return out;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    const display = String(obj[displayField] ?? "");
    const names = extractSkillNames(display);
    if (names.length === 0) continue;
    const tsRaw = Number(obj[tsField] ?? 0);
    const ts = tsIsMs ? tsRaw : tsRaw * 1000;
    for (const name of names) {
      const e = out.get(name) || { skillName: name, count: 0, lastUsedTs: 0, sources: [] };
      e.count += 1;
      if (ts > e.lastUsedTs) e.lastUsedTs = ts;
      if (!e.sources.includes(agent)) e.sources.push(agent);
      out.set(name, e);
    }
  }
  return out;
}

// Merge multiple usage maps by skill name.
function merge(maps: Map<string, UsageEntry>[]): Map<string, UsageEntry> {
  const out = new Map<string, UsageEntry>();
  for (const map of maps) {
    for (const [name, e] of map) {
      const cur = out.get(name) || { skillName: name, count: 0, lastUsedTs: 0, sources: [] };
      cur.count += e.count;
      if (e.lastUsedTs > cur.lastUsedTs) cur.lastUsedTs = e.lastUsedTs;
      for (const s of e.sources) if (!cur.sources.includes(s)) cur.sources.push(s);
      out.set(name, cur);
    }
  }
  return out;
}

export function readUsage(): Map<string, UsageEntry> {
  return merge([
    readDevin(),
    readJsonlHistory(`${home()}/.claude/history.jsonl`, "claude", "display", "timestamp", true),
    readJsonlHistory(`${home()}/.codex/history.jsonl`, "codex", "text", "ts", false),
  ]);
}

// Natural-language matching: after scanning skills, search prompt history for
// mentions of known skill names as whole words. This catches prompts like
// "có tool nào support stackfield ko?" that don't use /stackfield syntax.
// We only match names >= 4 chars to avoid false positives (e.g. "go", "do").
// Each prompt that mentions a skill name counts as 1 usage (weaker signal).
function buildNlRegex(skillNames: string[]): RegExp | null {
  const filtered = skillNames.filter((n) => n.length >= 4);
  if (filtered.length === 0) return null;
  // Cap at 50 names to avoid regex explosion with 100+ skills.
  // Sort by length descending so longer (more specific) names match first.
  const capped = filtered.sort((a, b) => b.length - a.length).slice(0, 50);
  // Escape regex special chars in names, match as whole words (case-insensitive).
  const escaped = capped
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return new RegExp(`\\b(${escaped})\\b`, "gi");
}

export function readUsageWithSkills(skillNames: string[]): Map<string, UsageEntry> {
  const base = readUsage();
  const names = skillNames.map((n) => n.toLowerCase());
  const nlRe = buildNlRegex(names);
  if (!nlRe) return base;

  // Collect all prompt texts + timestamps from all sources.
  const prompts: Array<{ text: string; ts: number; source: string }> = [];

  // Devin
  const devinRows = readDevinRows();
  for (const row of devinRows) {
    prompts.push({ text: row.content || "", ts: (row.timestamp || 0) * 1000, source: "devin" });
  }

  // Claude
  const claudePath = `${home()}/.claude/history.jsonl`;
  if (existsSync(claudePath)) {
    try {
      const text = readFileSync(claudePath, "utf8");
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t);
          prompts.push({ text: String(obj.display ?? ""), ts: Number(obj.timestamp ?? 0), source: "claude" });
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  // Codex
  const codexPath = `${home()}/.codex/history.jsonl`;
  if (existsSync(codexPath)) {
    try {
      const text = readFileSync(codexPath, "utf8");
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t);
          prompts.push({ text: String(obj.text ?? ""), ts: Number(obj.ts ?? 0) * 1000, source: "codex" });
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  // Match skill names in natural language. Only add if not already found via
  // slash/path detection (we don't double-count the same prompt).
  for (const p of prompts) {
    if (!p.text) continue;
    nlRe.lastIndex = 0;
    const matches = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = nlRe.exec(p.text)) !== null) {
      matches.add(m[1].toLowerCase());
    }
    for (const name of matches) {
      const existing = base.get(name);
      if (existing && existing.count > 0) continue; // already counted via slash/path
      const e = base.get(name) || { skillName: name, count: 0, lastUsedTs: 0, sources: [] };
      e.count += 1;
      if (p.ts > e.lastUsedTs) e.lastUsedTs = p.ts;
      if (!e.sources.includes(p.source)) e.sources.push(p.source);
      base.set(name, e);
    }
  }

  return base;
}

// Extracted helper: read Devin rows (reused by readUsageWithSkills for NL matching).
function readDevinRows(): Array<{ content: string; timestamp: number }> {
  const db = `${home()}/.local/share/devin/cli/sessions.db`;
  if (!existsSync(db)) return [];
  // Try sqlite3 CLI first, then Python3 fallback.
  if (commandExists("sqlite3")) {
    try {
      const raw = execSync(
        `sqlite3 -json "${db}" "SELECT content, timestamp FROM prompt_history"`,
        { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      );
      return JSON.parse(raw);
    } catch { /* fall through */ }
  }
  if (commandExists("python3")) {
    try {
      const pyScript = [
        "import sqlite3, json, sys",
        `conn = sqlite3.connect(${JSON.stringify(db)})`,
        "conn.row_factory = sqlite3.Row",
        "cur = conn.cursor()",
        'cur.execute("SELECT content, timestamp FROM prompt_history")',
        "rows = [dict(r) for r in cur.fetchall()]",
        "json.dump(rows, sys.stdout)",
        "conn.close()",
      ].join("\n");
      const raw = execSync(`python3 -c '${pyScript.replace(/'/g, "'\\''")}'`, {
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
      });
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return [];
}

// Human-readable "last used" label for the TUI.
export function lastUsedLabel(ts: number, now: number = Date.now()): string {
  if (!ts) return "never";
  const days = Math.floor((now - ts) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day";
  if (days < 30) return `${days} days`;
  if (days < 365) return `${Math.floor(days / 30)} mo`;
  return `${Math.floor(days / 365)}y`;
}
