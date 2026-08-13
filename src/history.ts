// History: append-only scan log. This is the compounding-context moat.
// Each scan appends a snapshot: timestamp, skill count, health, dead list.
// Over time the user sees a trend — and that trend is the switching cost:
// another tool can't reconstruct your hygiene trajectory.
//
// Stored at ~/.config/skill-radar/history.jsonl (XDG-friendly).

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = process.env.XDG_CONFIG_HOME
  ? join(process.env.XDG_CONFIG_HOME, "skill-radar")
  : join(homedir(), ".config", "skill-radar");
const FILE = join(DIR, "history.jsonl");

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
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    appendFileSync(FILE, JSON.stringify(snap) + "\n", "utf8");
  } catch {
    // best-effort — never break a scan because history write failed.
  }
}

export function readHistory(): Snapshot[] {
  if (!existsSync(FILE)) return [];
  let text: string;
  try {
    text = readFileSync(FILE, "utf8");
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
