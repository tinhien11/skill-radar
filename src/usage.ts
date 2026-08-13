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

export interface UsageEntry {
  skillName: string;
  count: number;
  lastUsedTs: number; // ms epoch, 0 if never
  sources: string[];  // which agents saw this skill used
}

function home(): string {
  return process.env.HOME || process.env.USERPROFILE || "";
}

// Extract /skill-name from a free-text prompt. Handles:
//   "/simple-english Thanks for the review..."  ->  "simple-english"
//   "/yolo"                                      ->  "yolo"
//   "/frontend-design"                           ->  "frontend-design"
// We only take the first token after the slash, lowercased, kebab-ish.
const SLASH_RE = /(?:^|\s)\/([a-z][a-z0-9_-]*)(?:\s|$)/gi;

function extractSkillNames(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  let m: RegExpExecArray | null;
  SLASH_RE.lastIndex = 0;
  while ((m = SLASH_RE.exec(text)) !== null) {
    out.push(m[1].toLowerCase());
  }
  return out;
}

// --- Devin: sqlite via the `sqlite3` CLI (avoids native better-sqlite3 dep,
//     which is painful for npx). Falls back gracefully if sqlite3 isn't installed.
function readDevin(): Map<string, UsageEntry> {
  const out = new Map<string, UsageEntry>();
  const db = `${home()}/.local/share/devin/cli/sessions.db`;
  if (!existsSync(db)) return out;
  let sqlite3Available = false;
  try {
    execSync("command -v sqlite3", { stdio: "ignore" });
    sqlite3Available = true;
  } catch {
    // sqlite3 not on PATH — skip Devin source. (macOS ships sqlite3 by default.)
  }
  if (!sqlite3Available) return out;
  // Pull every prompt + timestamp. content may contain newlines; use null separator.
  let raw: string;
  try {
    raw = execSync(
      `sqlite3 -json "${db}" "SELECT content, timestamp FROM prompt_history"`,
      { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
    );
  } catch {
    return out;
  }
  let rows: Array<{ content: string; timestamp: number }> = [];
  try {
    rows = JSON.parse(raw);
  } catch {
    return out;
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
