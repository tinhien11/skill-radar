// Dedup: detect duplicate skills across agent roots.
// Three kinds of duplication:
//   1. Symlink alias: same realPath appears under multiple agent roots (benign,
//      but we report it so the user understands their layout).
//   2. Content clone: different paths, identical contentHash (real waste —
//      e.g. the 3 tdai-memory copies on this machine).
//   3. Name collision: same skill name under different roots with DIFFERENT
//      content (potential conflict — agent may load the wrong one).

import type { Skill } from "./scanner.js";

export interface DupGroup {
  kind: "symlink-alias" | "content-clone" | "name-collision";
  name: string;
  members: Skill[];          // the duplicate entries
  // For content-clone / name-collision: which path to keep is suggested.
  keepIndex: number;
}

export function findDuplicates(skills: Skill[]): DupGroup[] {
  const groups: DupGroup[] = [];

  // 1. Symlink aliases — group by realPath.
  const byReal = new Map<string, Skill[]>();
  for (const s of skills) {
    if (!s.hasSkillMd) continue;
    const arr = byReal.get(s.realPath) || [];
    arr.push(s);
    byReal.set(s.realPath, arr);
  }
  for (const [, arr] of byReal) {
    if (arr.length > 1) {
      groups.push({
        kind: "symlink-alias",
        name: arr[0].name,
        members: arr,
        keepIndex: 0,
      });
    }
  }

  // 2. Content clones — group by contentHash, but only across DIFFERENT realPaths.
  const byHash = new Map<string, Skill[]>();
  for (const s of skills) {
    if (!s.hasSkillMd || !s.contentHash) continue;
    const arr = byHash.get(s.contentHash) || [];
    arr.push(s);
    byHash.set(s.contentHash, arr);
  }
  for (const [, arr] of byHash) {
    const uniqueReal = new Set(arr.map((s) => s.realPath));
    if (uniqueReal.size > 1) {
      // Keep the one under ~/.agents (canonical source) if present, else first.
      let keepIndex = 0;
      const agentsIdx = arr.findIndex((s) => s.agent === "agents");
      if (agentsIdx >= 0) keepIndex = agentsIdx;
      groups.push({
        kind: "content-clone",
        name: arr[0].name,
        members: arr,
        keepIndex,
      });
    }
  }

  // 3. Name collisions — same name, different content, different realPaths.
  const byName = new Map<string, Skill[]>();
  for (const s of skills) {
    if (!s.hasSkillMd) continue;
    const arr = byName.get(s.name) || [];
    arr.push(s);
    byName.set(s.name, arr);
  }
  for (const [name, arr] of byName) {
    const hashes = new Set(arr.map((s) => s.contentHash));
    const uniqueReal = new Set(arr.map((s) => s.realPath));
    if (uniqueReal.size > 1 && hashes.size > 1) {
      let keepIndex = 0;
      const agentsIdx = arr.findIndex((s) => s.agent === "agents");
      if (agentsIdx >= 0) keepIndex = agentsIdx;
      groups.push({
        kind: "name-collision",
        name,
        members: arr,
        keepIndex,
      });
    }
  }

  return groups;
}
