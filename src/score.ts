// Scorer: the addiction hook. Turns raw scan + usage data into:
//   - per-skill waste score (sort key for the TUI — worst first)
//   - overall health score 0-100
//   - "wasted tokens/turn" shock number
//   - dead-skill flag (30d no usage + no rule/hook reference)
//
// Scoring philosophy (informed by gabegiro.com router-pattern analysis):
//   - Every skill's description ships in the system prompt every turn.
//   - A skill you never invoke is pure tax. The more of them, the lower health.
//   - Token cost is approximated as sizeBytes/4 (rough chars→tokens).

import type { Skill } from "./scanner.js";
import type { UsageEntry } from "./usage.js";

export interface SkillScore {
  skill: Skill;
  usageCount: number;
  lastUsedTs: number;
  lastUsedLabel: string;
  tokenCost: number;        // approx tokens this skill costs per turn
  wasteScore: number;       // 0-100, higher = more wasteful (sort desc)
  verdict: string;          // short human label
  isDead: boolean;
  isDuplicate: boolean;
  deletable: boolean;       // false for plugin/symlink-managed skills
}

export interface HealthReport {
  totalSkills: number;       // unique skills
  totalEntries: number;      // including symlink aliases
  healthScore: number;       // 0-100
  wastedTokensPerTurn: number;
  deadCount: number;
  duplicateCount: number;
  brokenCount: number;
  scores: SkillScore[];      // sorted wasteScore desc
}

const DEAD_WINDOW_MS = 30 * 86_400_000; // 30 days

function approxTokens(bytes: number): number {
  // Rough: 4 chars ≈ 1 token.
  return Math.ceil(bytes / 4);
}

// Only the description (+ when_to_use) ships in the system prompt every turn.
// The full SKILL.md body is read on invocation, NOT every turn. So the real
// per-turn cost of a skill is its description token count, not its body size.
// (Per gabegiro.com router-pattern analysis + Claude Code listing budget docs.)
function descriptionTokens(s: Skill): number {
  const desc = s.description || "";
  return Math.max(8, approxTokens(Buffer.byteLength(desc, "utf8")));
}

export function score(
  skills: Skill[],
  usage: Map<string, UsageEntry>,
  duplicateRealPaths: Set<string>,
  brokenPaths: Set<string>,
): HealthReport {
  // Deduplicate by realPath so we score each real skill once.
  const seen = new Set<string>();
  const unique: Skill[] = [];
  for (const s of skills) {
    if (!s.hasSkillMd) continue;
    if (seen.has(s.realPath)) continue;
    seen.add(s.realPath);
    unique.push(s);
  }

  const now = Date.now();
  const scores: SkillScore[] = unique.map((s) => {
    const u = usage.get(s.name.toLowerCase());
    const usageCount = u?.count ?? 0;
    const lastUsedTs = u?.lastUsedTs ?? 0;
    const tokenCost = descriptionTokens(s);
    // "dead" = no manual invoke AND either never used or last used >30d ago.
    // Skills the model auto-triggers won't appear in prompt_history, so this
    // is a manual-use signal, not a total-usage signal. We flag conservatively.
    const isDead = usageCount === 0;
    const isDuplicate = duplicateRealPaths.has(s.realPath);
    const isBroken = brokenPaths.has(s.skillPath);

    // wasteScore: higher = more wasteful. Weighted combo:
    //   - no manual invoke     : +40 (model may still auto-trigger — softer)
    //   - dead (30d no manual) : +20
    //   - duplicate content    : +20
    //   - broken               : +30
    //   - description cost     : +0..10 (log-ish, by description tokens)
    let waste = 0;
    if (usageCount === 0) waste += 40;
    else if (isDead) waste += 20;
    if (isDuplicate) waste += 20;
    if (isBroken) waste += 30;
    // description token cost: 32 tok ≈ +1, capped at +10
    waste += Math.min(10, Math.log2(Math.max(1, tokenCost / 8)));
    waste = Math.max(0, Math.min(100, Math.round(waste)));

    let verdict: string;
    if (isBroken) verdict = "broken — fix or remove";
    else if (isDuplicate && usageCount === 0) verdict = "duplicate + no manual use";
    else if (isDuplicate) verdict = "duplicate — keep one copy";
    else if (usageCount === 0) verdict = "no manual invoke (may auto-trigger)";
    else if (isDead) verdict = "stale — no manual use in 30d";
    else if (usageCount >= 10) verdict = "active";
    else verdict = "rarely used";

    // Deletable: anything with a path we can remove. Real dirs get rmSync(recursive),
    // symlinks get unlink (removes the link, NOT the target it points to).
    // Broken symlinks are also deletable — that's the whole point of doctor.
    const deletable = s.hasSkillMd || s.isSymlink;

    return {
      skill: s,
      usageCount,
      lastUsedTs,
      lastUsedLabel: u ? lastUsedLabel(lastUsedTs, now) : "never",
      tokenCost,
      wasteScore: waste,
      verdict,
      isDead,
      isDuplicate,
      deletable,
    };
  });

  scores.sort((a, b) => b.wasteScore - a.wasteScore);

  const deadCount = scores.filter((s) => s.isDead).length;
  const duplicateCount = scores.filter((s) => s.isDuplicate).length;
  const brokenCount = skills.filter((s) => brokenPaths.has(s.skillPath)).length;
  const wastedTokensPerTurn = scores
    .filter((s) => s.isDead || (s.isDuplicate && s.usageCount === 0))
    .reduce((sum, s) => sum + s.tokenCost, 0);

  // Health score: start at 100, penalize for dead/dup/broken/waste.
  //   - each dead skill:      -2 (capped)
  //   - each duplicate:       -3
  //   - each broken:          -5
  //   - wasted tokens factor: -1 per 200 tokens (capped at -25)
  let health = 100;
  health -= Math.min(30, deadCount * 2);
  health -= Math.min(20, duplicateCount * 3);
  health -= Math.min(15, brokenCount * 5);
  health -= Math.min(25, Math.floor(wastedTokensPerTurn / 200));
  health = Math.max(0, Math.min(100, health));

  return {
    totalSkills: unique.length,
    totalEntries: skills.length,
    healthScore: health,
    wastedTokensPerTurn,
    deadCount,
    duplicateCount,
    brokenCount,
    scores,
  };
}

function lastUsedLabel(ts: number, now: number): string {
  if (!ts) return "never";
  const days = Math.floor((now - ts) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day";
  if (days < 30) return `${days} days`;
  if (days < 365) return `${Math.floor(days / 30)} mo`;
  return `${Math.floor(days / 365)}y`;
}
