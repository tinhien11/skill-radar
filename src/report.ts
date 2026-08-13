// Report: assemble everything (scan + usage + dedup + doctor + score + trend)
// into one object the CLI/TUI consumes. Single source of truth for a run.

import { scanAll, uniqueSkills, type Skill } from "./scanner.js";
import { readUsage } from "./usage.js";
import { findDuplicates } from "./dedup.js";
import { doctor } from "./doctor.js";
import { score as scoreAll, type HealthReport } from "./score.js";
import { lastSnapshot, trend, appendSnapshot, type Snapshot, type Trend } from "./history.js";

export interface Report {
  skills: Skill[];
  unique: Skill[];
  health: HealthReport;
  duplicates: ReturnType<typeof findDuplicates>;
  issues: ReturnType<typeof doctor>;
  prev: Snapshot | null;
  trend: Trend | null;
}

export function buildReport(persist: boolean = true): Report {
  const { skills } = scanAll();
  const usage = readUsage();
  const duplicates = findDuplicates(skills);
  const issues = doctor(skills);

  // Build sets for the scorer.
  const dupRealPaths = new Set<string>();
  for (const g of duplicates) {
    if (g.kind === "content-clone") {
      // every member except the keepIndex is a duplicate
      g.members.forEach((m, i) => {
        if (i !== g.keepIndex) dupRealPaths.add(m.realPath);
      });
    }
  }
  const brokenPaths = new Set(issues.filter((i) => i.severity === "broken").map((i) => i.skillPath));

  const health = scoreAll(skills, usage, dupRealPaths, brokenPaths);
  const prev = lastSnapshot();
  const snap: Snapshot = {
    ts: Date.now(),
    totalSkills: health.totalSkills,
    healthScore: health.healthScore,
    wastedTokensPerTurn: health.wastedTokensPerTurn,
    deadCount: health.deadCount,
    duplicateCount: health.duplicateCount,
    brokenCount: health.brokenCount,
    deadNames: health.scores.filter((s) => s.isDead).map((s) => s.skill.name),
  };
  const tr = trend(prev, snap);
  if (persist) appendSnapshot(snap);

  return {
    skills,
    unique: uniqueSkills(skills),
    health,
    duplicates,
    issues,
    prev,
    trend: tr,
  };
}
