// History: append-only scan log. This is the compounding-context moat.
// Each scan appends a snapshot: timestamp, skill count, health, dead list.
// Over time the user sees a trend — and that trend is the switching cost:
// another tool can't reconstruct your hygiene trajectory.
//
// Stored at ~/.config/skill-radar/history.jsonl (XDG-friendly).

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Compute paths lazily so tests that override HOME/XDG_CONFIG_HOME see the
// new paths on each call (module-level constants would cache the first value).
function dir(): string {
  return process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "skill-radar")
    : join(homedir(), ".config", "skill-radar");
}
function file(): string { return join(dir(), "history.jsonl"); }
function oldFile(): string { return join(dir(), "history.jsonl.old"); }
const MAX_ENTRIES = 365;

export interface Snapshot {
  ts: number;
  totalSkills: number;
  healthScore: number;
  wastedTokensPerTurn: number;
  deadCount: number;
  duplicateCount: number;
  brokenCount: number;
  deadNames: string[];
}

export function appendSnapshot(snap: Snapshot): void {
  try {
    const d = dir();
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    appendFileSync(file(), JSON.stringify(snap) + "\n", "utf8");
    // Rotate: if history exceeds MAX_ENTRIES, move old entries to .old file
    // and keep only the most recent MAX_ENTRIES in the active file.
    rotateIfNeeded();
  } catch {
    // best-effort — never break a scan because history write failed.
  }
}

// If the history file has more than MAX_ENTRIES lines, move the oldest
// entries to history.jsonl.old (appending if it already exists) and rewrite
// the active file with only the most recent MAX_ENTRIES.
function rotateIfNeeded(): void {
  const f = file();
  if (!existsSync(f)) return;
  let text: string;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    return;
  }
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length <= MAX_ENTRIES) return;
  // Split: oldest go to .old, newest stay in active file.
  const keep = lines.slice(-MAX_ENTRIES);
  const move = lines.slice(0, -MAX_ENTRIES);
  // Append old entries to .old file (preserving history across rotations).
  try {
    appendFileSync(oldFile(), move.join("\n") + "\n", "utf8");
  } catch {
    // best-effort
  }
  // Rewrite active file with only kept entries.
  try {
    writeFileSync(f, keep.join("\n") + "\n", "utf8");
  } catch {
    // best-effort
  }
}

export function readHistory(): Snapshot[] {
  const f = file();
  if (!existsSync(f)) return [];
  let text: string;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    return [];
  }
  const out: Snapshot[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

export function lastSnapshot(): Snapshot | null {
  const h = readHistory();
  return h.length ? h[h.length - 1] : null;
}

// Trend vs the previous snapshot. Positive = improved.
export interface Trend {
  healthDelta: number;   // cur - prev, positive = improved
  skillsDelta: number;   // prev - cur, positive = fewer skills = cleaner
  wastedDelta: number;   // prev - cur, positive = less waste
  deadDelta: number;     // prev - cur, positive = fewer dead
}

export function trend(prev: Snapshot | null, cur: Snapshot): Trend | null {
  if (!prev) return null;
  return {
    healthDelta: cur.healthScore - prev.healthScore,
    skillsDelta: prev.totalSkills - cur.totalSkills,
    wastedDelta: prev.wastedTokensPerTurn - cur.wastedTokensPerTurn,
    deadDelta: prev.deadCount - cur.deadCount,
  };
}
