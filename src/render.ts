// Text rendering for non-TUI commands. Colored, compact, table-ish.
// Uses ANSI escapes directly (no dep) so `skill-radar scan` works everywhere.

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";

function healthColor(score: number): string {
  if (score >= 75) return GREEN;
  if (score >= 50) return YELLOW;
  return RED;
}

function trendArrow(delta: number, goodWhenPositive: boolean = true): string {
  if (delta === 0) return `${GRAY}→${RESET}`;
  const positive = delta > 0;
  const good = goodWhenPositive ? positive : !positive;
  const color = good ? GREEN : RED;
  const arrow = positive ? "↑" : "↓";
  return `${color}${arrow}${Math.abs(delta)}${RESET}`;
}

import type { Report } from "./report.js";

export function renderSummary(r: Report): string {
  const h = r.health;
  const lines: string[] = [];
  lines.push("");
  // Headline shock number + health score side by side.
  const healthStr = `${healthColor(h.healthScore)}${BOLD}${h.healthScore}${RESET}/100`;
  const wasteStr = `${RED}${BOLD}~${h.wastedTokensPerTurn}${RESET} ${DIM}tokens/turn wasted${RESET}`;
  lines.push(`  Health ${healthStr}   ${wasteStr}`);

  // Trend line (the compounding hook). All deltas defined so positive = improved.
  if (r.trend) {
    const t = r.trend;
    // metricUpWhenPositive: does a positive delta mean the metric itself went up?
    //   health: delta = cur - prev, positive = health up    → up
    //   waste:  delta = prev - cur, positive = waste down   → down
    //   dead:   delta = prev - cur, positive = dead down    → down
    //   skills: delta = prev - cur, positive = skills down  → down
    const fmt = (delta: number, metricUpWhenPositive: boolean) => {
      if (delta === 0) return `${GRAY}→${RESET}`;
      const good = delta > 0; // all deltas: positive = improvement
      const color = good ? GREEN : RED;
      const metricWentUp = metricUpWhenPositive ? delta > 0 : delta < 0;
      const arrow = metricWentUp ? "↑" : "↓";
      return `${color}${arrow}${Math.abs(delta)}${RESET}`;
    };
    const parts: string[] = [];
    parts.push(`health ${fmt(t.healthDelta, true)}`);
    parts.push(`waste ${fmt(t.wastedDelta, false)}`);
    parts.push(`dead ${fmt(t.deadDelta, false)}`);
    parts.push(`skills ${fmt(t.skillsDelta, false)}`);
    lines.push(`  ${DIM}vs last scan:${RESET} ${parts.join(`  ${GRAY}·${RESET}  `)}`);
  } else {
    lines.push(`  ${DIM}first scan — run again to see trends${RESET}`);
  }

  lines.push("");
  // Stat row.
  const stat = (n: number, label: string, color: string) =>
    `${color}${BOLD}${n}${RESET} ${DIM}${label}${RESET}`;
  lines.push(
    `  ${stat(h.totalSkills, "skills", CYAN)}  ${stat(h.deadCount, "dead", RED)}  ${stat(
      h.duplicateCount,
      "dups",
      MAGENTA,
    )}  ${stat(h.brokenCount, "broken", YELLOW)}`,
  );
  lines.push("");
  return lines.join("\n");
}

export function renderScoreTable(r: Report, limit: number = 20): string {
  const h = r.health;
  const lines: string[] = [];
  lines.push(`${BOLD}  Waste ranking (worst first)${RESET}`);
  lines.push(`  ${GRAY}┌─────────────────────────────────┬──────┬──────────┬──────────────────────────┐${RESET}`);
  lines.push(`  ${GRAY}│${RESET} skill                            ${GRAY}│${RESET} waste ${GRAY}│${RESET} last used ${GRAY}│${RESET} verdict                  ${GRAY}│${RESET}`);
  lines.push(`  ${GRAY}├─────────────────────────────────┼──────┼──────────┼──────────────────────────┤${RESET}`);
  for (const s of h.scores.slice(0, limit)) {
    const name = s.skill.name.length > 31 ? s.skill.name.slice(0, 30) + "…" : s.skill.name;
    const pad = " ".repeat(Math.max(0, 31 - name.length));
    const wasteColor = s.wasteScore >= 60 ? RED : s.wasteScore >= 30 ? YELLOW : GREEN;
    const verdictColor = s.isDead ? RED : s.isDuplicate ? MAGENTA : s.usageCount > 0 ? GREEN : GRAY;
    const used = s.lastUsedLabel.padEnd(9);
    const verdict = s.verdict.length > 24 ? s.verdict.slice(0, 23) + "…" : s.verdict;
    const vpad = " ".repeat(Math.max(0, 24 - verdict.length));
    lines.push(
      `  ${GRAY}│${RESET} ${name}${pad} ${GRAY}│${RESET} ${wasteColor}${String(s.wasteScore).padStart(3)}${RESET}   ${GRAY}│${RESET} ${used} ${GRAY}│${RESET} ${verdictColor}${verdict}${vpad}${GRAY}│${RESET}`,
    );
  }
  lines.push(`  ${GRAY}└─────────────────────────────────┴──────┴──────────┴──────────────────────────┘${RESET}`);
  if (h.scores.length > limit) {
    lines.push(`  ${DIM}…and ${h.scores.length - limit} more. Run \`skill-radar tui\` to see all.${RESET}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderDuplicates(r: Report): string {
  const lines: string[] = [];
  if (r.duplicates.length === 0) {
    lines.push(`  ${GREEN}No duplicates found.${RESET}`);
    lines.push("");
    return lines.join("\n");
  }
  lines.push(`${BOLD}  Duplicates${RESET}`);
  for (const g of r.duplicates) {
    const kindColor = g.kind === "content-clone" ? RED : g.kind === "name-collision" ? YELLOW : MAGENTA;
    lines.push(`  ${kindColor}${g.kind}${RESET} ${BOLD}${g.name}${RESET}`);
    g.members.forEach((m, i) => {
      const mark = i === g.keepIndex ? `${GREEN}keep${RESET}` : `${RED}dup ${RESET}`;
      lines.push(`    ${mark}  ${DIM}${m.agent}${RESET}  ${m.skillPath}`);
    });
    lines.push("");
  }
  return lines.join("\n");
}

export function renderDoctor(r: Report): string {
  const lines: string[] = [];
  if (r.issues.length === 0) {
    lines.push(`  ${GREEN}No structural issues.${RESET}`);
    lines.push("");
    return lines.join("\n");
  }
  lines.push(`${BOLD}  Structural issues${RESET}`);
  for (const i of r.issues) {
    const color = i.severity === "broken" ? RED : i.severity === "missing" ? YELLOW : GRAY;
    lines.push(`  ${color}${i.severity.padEnd(7)}${RESET} ${DIM}${i.agent}${RESET}  ${i.skillPath}`);
    lines.push(`  ${GRAY}           ${i.message}${RESET}`);
  }
  lines.push("");
  return lines.join("\n");
}
