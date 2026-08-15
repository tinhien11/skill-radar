// Clean: auto-fix without TUI. Does what `D` + `doctor --fix` would do, but
// non-interactively and safely. Three passes:
//   1. Remove broken symlinks (target gone) — pure garbage, always safe.
//   2. Remove duplicate copies of content-clones, keep canonical (~/.agents).
//   3. Optionally (--dead) remove skills with no manual invoke.
// All changes printed with before/after counts. No confirm prompts — this is
// the "I don't have time to delete one by one" command.

import { lstatSync, unlinkSync, rmSync, existsSync, realpathSync } from "node:fs";
import { scanAll, uniqueSkills, type Skill } from "./scanner.js";
import { findDuplicates } from "./dedup.js";
import { readUsageWithSkills } from "./usage.js";
import { backupSkills, pruneBackups, type BackupResult } from "./backup.js";

interface CleanAction {
  kind: "broken-symlink" | "duplicate-copy" | "dead-skill";
  name: string;
  agent: string;
  path: string;
  action: "unlink" | "rm";
}

function isBrokenSymlink(s: Skill): boolean {
  if (!s.isSymlink) return false;
  // Broken = symlink exists but target (realPath) doesn't.
  return !existsSync(s.realPath);
}

export interface CleanResult {
  brokenRemoved: number;
  duplicatesRemoved: number;
  deadRemoved: number;
  totalBefore: number;
  totalAfter: number;
  actions: CleanAction[];
  errors: string[];
  backup?: BackupResult;
}

export function clean(opts: { dead?: boolean; dryRun?: boolean; backup?: boolean } = {}): CleanResult {
  const errors: string[] = [];
  const actions: CleanAction[] = [];
  const { skills: before } = scanAll();
  const totalBefore = before.length;

  // Pass 1: broken symlinks. Always safe — target already gone.
  for (const s of before) {
    if (!isBrokenSymlink(s)) continue;
    actions.push({ kind: "broken-symlink", name: s.name, agent: s.agent, path: s.skillPath, action: "unlink" });
  }

  // Pass 2: duplicate copies of content-clones. Keep canonical (prefer ~/.agents,
  // else first by agent name sort). Remove the rest (symlink → unlink, real → rm).
  const dups = findDuplicates(before);
  const keepRealPaths = new Set<string>();
  const removePaths = new Set<string>();
  for (const g of dups) {
    if (g.kind !== "content-clone") continue;
    const keep = g.members[g.keepIndex];
    keepRealPaths.add(keep.realPath);
    for (let i = 0; i < g.members.length; i++) {
      if (i === g.keepIndex) continue;
      const m = g.members[i];
      removePaths.add(m.skillPath);
      actions.push({
        kind: "duplicate-copy",
        name: g.name,
        agent: m.agent,
        path: m.skillPath,
        action: m.isSymlink ? "unlink" : "rm",
      });
    }
  }

  // Pass 3 (optional --dead): skills with no manual invoke. Remove ALL copies
  // by realPath (not by name — name-collision would delete an alive skill that
  // shares a name with a dead one). Off by default — dead is a softer signal.
  let deadRealPaths = new Set<string>();
  if (opts.dead) {
    const usage = readUsageWithSkills(uniqueSkills(before).map((s) => s.name));
    // A skill is "dead" if no manual invoke across any agent. Use unique skills
    // (by realPath) to decide, then remove all copies sharing that realPath.
    const seen = new Set<string>();
    for (const s of before) {
      if (!s.hasSkillMd) continue;
      if (seen.has(s.realPath)) continue;
      seen.add(s.realPath);
      const u = usage.get(s.name.toLowerCase());
      if (!u || u.count === 0) deadRealPaths.add(s.realPath);
    }
    for (const s of before) {
      if (!deadRealPaths.has(s.realPath)) continue;
      if (removePaths.has(s.skillPath)) continue; // already queued in pass 2
      actions.push({
        kind: "dead-skill",
        name: s.name,
        agent: s.agent,
        path: s.skillPath,
        action: s.isSymlink ? "unlink" : "rm",
      });
    }
  }

  // Dedupe actions by path (a path may be queued by multiple passes).
  const seenPaths = new Set<string>();
  const uniqueActions = actions.filter((a) => {
    if (seenPaths.has(a.path)) return false;
    seenPaths.add(a.path);
    return true;
  });

  // Execute (or just count if dryRun).
  let brokenRemoved = 0, duplicatesRemoved = 0, deadRemoved = 0;
  let backupResult: BackupResult | undefined;

  // Back up skills that will be deleted (not in dry-run mode, and only if
  // --backup flag is set). Broken symlinks don't need backup (no content).
  if (!opts.dryRun && opts.backup) {
    const toBackup = before.filter((s) =>
      s.hasSkillMd && uniqueActions.some((a) => a.path === s.skillPath && a.kind !== "broken-symlink"),
    );
    if (toBackup.length > 0) {
      backupResult = backupSkills(toBackup);
      pruneBackups(10); // keep last 10 backups
    }
  }

  for (const a of uniqueActions) {
    if (opts.dryRun) {
      if (a.kind === "broken-symlink") brokenRemoved++;
      else if (a.kind === "duplicate-copy") duplicatesRemoved++;
      else deadRemoved++;
      continue;
    }
    try {
      const st = lstatSync(a.path);
      if (st.isSymbolicLink()) {
        unlinkSync(a.path);
      } else {
        rmSync(a.path, { recursive: true, force: true });
      }
      if (a.kind === "broken-symlink") brokenRemoved++;
      else if (a.kind === "duplicate-copy") duplicatesRemoved++;
      else deadRemoved++;
    } catch (e) {
      errors.push(`${a.path}: ${(e as Error).message}`);
    }
  }

  // In dry-run mode, nothing was actually deleted, so a fresh scan would
  // return the same count. Compute the expected after-count instead.
  const totalAfter = opts.dryRun
    ? totalBefore - uniqueActions.length
    : scanAll().skills.length;
  return {
    brokenRemoved,
    duplicatesRemoved,
    deadRemoved,
    totalBefore,
    totalAfter,
    actions: uniqueActions,
    errors,
    backup: backupResult,
  };
}
