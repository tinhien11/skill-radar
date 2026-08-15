// Backup: copy skill directories to a timestamped archive before deletion.
// Backups go to ~/.local/share/skill-radar/backups/<timestamp>/<agent>/<name>/
// A manifest.json is written alongside the backup recording original paths
// so restoreBackup can copy files back to the right location.
// This is the safety net for clean + TUI delete operations.

import { existsSync, mkdirSync, copyFileSync, readdirSync, lstatSync, symlinkSync, readlinkSync, statSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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

interface ManifestEntry {
  agent: string;
  name: string;
  originalPath: string;    // skillPath at backup time
  backupPath: string;      // path inside backup dir
}

interface Manifest {
  timestamp: string;
  entries: ManifestEntry[];
}

// Back up a list of skills before deletion. Only backs up real dirs with
// SKILL.md (broken symlinks and empty dirs don't need backup).
export function backupSkills(skills: Skill[]): BackupResult {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const errors: string[] = [];
  let backedUp = 0;
  const baseDir = join(backupRoot(), ts);
  const manifestEntries: ManifestEntry[] = [];

  for (const s of skills) {
    if (!s.hasSkillMd) continue; // skip broken symlinks, empty dirs
    const dest = join(baseDir, s.agent, s.name);
    try {
      mkdirSync(dest, { recursive: true });
      copySkillDir(s.skillPath, dest);
      manifestEntries.push({
        agent: s.agent,
        name: s.name,
        originalPath: s.skillPath,
        backupPath: dest,
      });
      backedUp++;
    } catch (e) {
      errors.push(`${s.skillPath}: ${(e as Error).message}`);
    }
  }

  // Write manifest so restoreBackup knows where to copy files back.
  if (manifestEntries.length > 0) {
    const manifest: Manifest = { timestamp: ts, entries: manifestEntries };
    try {
      writeFileSync(join(baseDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    } catch (e) {
      errors.push(`manifest.json: ${(e as Error).message}`);
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

// Restore a backup by timestamp. Reads manifest.json from the backup dir and
// copies each skill back to its original path. Overwrites whatever is currently
// at the target path.
export function restoreBackup(timestamp: string): { restored: number; errors: string[]; skipped: number } {
  const root = backupRoot();
  const backupDir = join(root, timestamp);
  if (!existsSync(backupDir)) {
    return { restored: 0, errors: [`backup not found: ${timestamp}`], skipped: 0 };
  }
  const manifestPath = join(backupDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    return { restored: 0, errors: [`manifest not found in backup ${timestamp} — cannot restore without original paths`], skipped: 0 };
  }
  const errors: string[] = [];
  let restored = 0;
  let skipped = 0;

  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    return { restored: 0, errors: [`failed to parse manifest.json: ${(e as Error).message}`], skipped: 0 };
  }

  for (const entry of manifest.entries) {
    try {
      // Remove whatever is currently at the original path (could be nothing,
      // could be a re-created skill, could be a stale symlink).
      if (existsSync(entry.originalPath) || isSymlink(entry.originalPath)) {
        rmSync(entry.originalPath, { recursive: true, force: true });
      }
      // Ensure parent dir exists (agent root may have been deleted).
      mkdirSync(entry.originalPath, { recursive: true });
      // Copy backup contents back to original path.
      copySkillDir(entry.backupPath, entry.originalPath);
      restored++;
    } catch (e) {
      errors.push(`${entry.originalPath}: ${(e as Error).message}`);
      skipped++;
    }
  }

  return { restored, errors, skipped };
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
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
