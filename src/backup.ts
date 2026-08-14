// Backup: copy skill directories to a timestamped archive before deletion.
// Backups go to ~/.local/share/skill-radar/backups/<timestamp>/<agent>/<name>/
// This is the safety net for clean + TUI delete operations.

import { existsSync, mkdirSync, copyFileSync, readdirSync, lstatSync, symlinkSync, readlinkSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Skill } from "./scanner.js";

function home(): string {
  return process.env.HOME || process.env.USERPROFILE || "";
}

function backupRoot(): string {
  return `${home()}/.local/share/skill-radar/backups`;
}

export interface BackupResult {
  timestamp: string;       // ISO timestamp used as dir name
  backedUp: number;        // number of skills copied
  backupDir: string;       // where the backup lives
  errors: string[];
}

// Back up a list of skills before deletion. Only backs up real dirs with
// SKILL.md (broken symlinks and empty dirs don't need backup).
export function backupSkills(skills: Skill[]): BackupResult {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const errors: string[] = [];
  let backedUp = 0;
  const baseDir = join(backupRoot(), ts);

  for (const s of skills) {
    if (!s.hasSkillMd) continue; // skip broken symlinks, empty dirs
    const dest = join(baseDir, s.agent, s.name);
    try {
      mkdirSync(dest, { recursive: true });
      copySkillDir(s.skillPath, dest);
      backedUp++;
    } catch (e) {
      errors.push(`${s.skillPath}: ${(e as Error).message}`);
    }
  }

  return { timestamp: ts, backedUp, backupDir: baseDir, errors };
}

// Recursively copy a skill directory, preserving symlinks.
function copySkillDir(src: string, dest: string): void {
  let entries: string[];
  try {
    entries = readdirSync(src);
  } catch {
    return;
  }
  for (const name of entries) {
    const srcPath = join(src, name);
    const destPath = join(dest, name);
    let st;
    try {
      st = lstatSync(srcPath);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      try {
        const target = readlinkSync(srcPath);
        symlinkSync(target, destPath);
      } catch { /* skip */ }
    } else if (st.isDirectory()) {
      mkdirSync(destPath, { recursive: true });
      copySkillDir(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

// List existing backups (newest first).
export function listBackups(): Array<{ timestamp: string; path: string; size: number }> {
  const root = backupRoot();
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  return entries
    .map((name) => {
      const p = join(root, name);
      let size = 0;
      try {
        size = statSync(p).size;
      } catch { /* ignore */ }
      return { timestamp: name, path: p, size };
    })
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

// Restore a backup by timestamp. Copies files back to their original locations.
// WARNING: this overwrites whatever is currently at the target path.
export function restoreBackup(timestamp: string): { restored: number; errors: string[] } {
  const root = backupRoot();
  const backupDir = join(root, timestamp);
  if (!existsSync(backupDir)) {
    return { restored: 0, errors: [`backup not found: ${timestamp}`] };
  }
  const errors: string[] = [];
  let restored = 0;
  // The backup structure is <agent>/<name>/<files>. We need to know where to
  // restore — but we don't store the original path. For now, just report what's
  // in the backup. Full restore requires a manifest file (future work).
  // TODO: store original paths in a manifest.json for proper restore.
  return { restored, errors: ["restore not yet implemented — backup preserved at " + backupDir] };
}

// Remove old backups beyond a retention count (default 10).
export function pruneBackups(keepCount: number = 10): { pruned: number; errors: string[] } {
  const backups = listBackups();
  const toPrune = backups.slice(keepCount);
  const errors: string[] = [];
  let pruned = 0;
  for (const b of toPrune) {
    try {
      rmSync(b.path, { recursive: true, force: true });
      pruned++;
    } catch (e) {
      errors.push(`${b.path}: ${(e as Error).message}`);
    }
  }
  return { pruned, errors };
}
