// Scanner: walk each agent root, resolve symlinks, find SKILL.md, parse frontmatter.
// A "skill" is a directory containing a SKILL.md file. We record both the
// apparent path (where the symlink lives) and the real path (what it points to)
// so dedup can collapse symlink farms.

import { readFileSync, readdirSync, lstatSync, realpathSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { candidateRoots, type AgentRoot } from "./agents.js";

export interface Skill {
  name: string;
  agent: string;            // agent that owns this root
  rootPath: string;         // the agent root this was found under
  skillPath: string;        // path to the skill directory (may be a symlink)
  realPath: string;         // resolved realpath (collapses symlinks)
  isSymlink: boolean;
  hasSkillMd: boolean;
  // Parsed frontmatter / first heading
  description: string;
  // Content hash of SKILL.md body (for dedup by content)
  contentHash: string;
  // Size of SKILL.md in bytes (proxy for token cost)
  sizeBytes: number;
  // Frontmatter fields we care about
  frontmatter: Record<string, string>;
}

// Minimal YAML-ish frontmatter parser. Skills use simple key: value blocks.
function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } {
  const fm: Record<string, string> = {};
  let body = text;
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end > 0) {
      const block = text.slice(3, end).trim();
      body = text.slice(end + 4).trimStart();
      for (const line of block.split("\n")) {
        const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (m) fm[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
      }
    }
  }
  return { fm, body };
}

function hashContent(text: string): string {
  // Normalize whitespace before hashing so reformatted-but-identical skills
  // still match. This is the key to content-based dedup that beats by-name.
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function scanRoot(root: AgentRoot): Skill[] {
  if (!existsSync(root.path)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root.path);
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const skillPath = join(root.path, name);
    let st;
    try {
      st = lstatSync(skillPath);
    } catch {
      continue;
    }
    if (!st.isDirectory() && !st.isSymbolicLink()) continue;
    const skillMdPath = join(skillPath, "SKILL.md");
    // existsSync returns true for directories too — verify it's a regular file.
    const hasSkillMd = existsSync(skillMdPath) && statSync(skillMdPath).isFile();
    // Use lstatSync to detect symlinks — do NOT compare realpath !== skillPath,
    // because on macOS /var → /private/var so every dir under tmpdir() would
    // falsely appear as a symlink.
    const isSymlink = st.isSymbolicLink();
    // Always resolve realPath via realpathSync so that a real dir and a symlink
    // pointing to it share the same realPath (both resolve through /var → /private/var).
    // For broken symlinks, realpathSync throws — fall back to skillPath.
    let realPath = skillPath;
    try {
      realPath = realpathSync(skillPath);
    } catch {
      // broken symlink — target doesn't exist, keep skillPath as realPath
    }
    let description = "";
    let contentHash = "";
    let sizeBytes = 0;
    const frontmatter: Record<string, string> = {};
    if (hasSkillMd) {
      try {
        const text = readFileSync(skillMdPath, "utf8");
        sizeBytes = Buffer.byteLength(text, "utf8");
        const { fm, body } = parseFrontmatter(text);
        Object.assign(frontmatter, fm);
        description = (fm.description || fm.name || firstHeading(body) || "").trim();
        contentHash = hashContent(body);
      } catch {
        // unreadable
      }
    }
    skills.push({
      name,
      agent: root.agent,
      rootPath: root.path,
      skillPath,
      realPath,
      isSymlink,
      hasSkillMd,
      description,
      contentHash,
      sizeBytes,
      frontmatter,
    });
  }
  return skills;
}

function firstHeading(body: string): string {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : "";
}

export interface ScanResult {
  skills: Skill[];
  rootsScanned: AgentRoot[];
  rootsFound: AgentRoot[];
}

export function scanAll(): ScanResult {
  const roots = candidateRoots();
  const rootsFound: AgentRoot[] = [];
  const skills: Skill[] = [];
  for (const root of roots) {
    if (!existsSync(root.path)) continue;
    rootsFound.push(root);
    const found = scanRoot(root);
    skills.push(...found);
  }
  return { skills, rootsScanned: roots, rootsFound };
}

// Group skills by realpath to collapse symlink farms. Returns groups where
// the same real skill appears under multiple agent roots.
export function groupByRealPath(skills: Skill[]): Map<string, Skill[]> {
  const map = new Map<string, Skill[]>();
  for (const s of skills) {
    const key = s.hasSkillMd ? s.realPath : `__broken__:${s.skillPath}`;
    const arr = map.get(key) || [];
    arr.push(s);
    map.set(key, arr);
  }
  return map;
}

// Unique skills (one per realpath). Use this for counts to avoid double-counting
// the same skill installed as symlink in multiple agent dirs.
export function uniqueSkills(skills: Skill[]): Skill[] {
  const seen = new Set<string>();
  const out: Skill[] = [];
  for (const s of skills) {
    const key = s.hasSkillMd ? s.realPath : `__broken__:${s.skillPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
