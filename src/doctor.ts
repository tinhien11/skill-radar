// Doctor: structural health — broken symlinks, missing SKILL.md, empty dirs.
import type { Skill } from "./scanner.js";

export interface DoctorIssue {
  severity: "broken" | "missing" | "empty" | "warn";
  skillPath: string;
  agent: string;
  message: string;
}

export function doctor(skills: Skill[]): DoctorIssue[] {
  const issues: DoctorIssue[] = [];
  for (const s of skills) {
    if (s.isSymlink && !s.hasSkillMd) {
      issues.push({
        severity: "broken",
        skillPath: s.skillPath,
        agent: s.agent,
        message: `broken symlink → ${s.realPath}`,
      });
    } else if (!s.isSymlink && !s.hasSkillMd) {
      // Real directory without SKILL.md — either empty or not a skill.
      issues.push({
        severity: s.sizeBytes === 0 ? "empty" : "missing",
        skillPath: s.skillPath,
        agent: s.agent,
        message: s.sizeBytes === 0 ? "empty directory (no SKILL.md)" : "missing SKILL.md",
      });
    }
  }
  // Sort: broken first, then missing, then empty.
  const order = { broken: 0, missing: 1, empty: 2, warn: 3 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  return issues;
}
