// Integration tests: build a fake multi-agent skill tree in a temp HOME,
// then exercise scanner → dedup → clean → delete-by-name end to end.
// No mocking of internals — we test the real filesystem paths the tool uses.

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  existsSync,
  lstatSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let FAKE_HOME: string;
let REAL_HOME: string;
let REAL_XDG: string | undefined;

function mkSkill(root: string, name: string, description: string, body: string = "# skill") {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
  );
  return dir;
}

function mkSymlink(target: string, root: string, name: string) {
  const link = join(root, name);
  symlinkSync(target, link);
  return link;
}

function mkBrokenSymlink(root: string, name: string) {
  const link = join(root, name);
  symlinkSync(join(root, "__nonexistent_target__"), link);
  return link;
}

beforeEach(() => {
  FAKE_HOME = join(tmpdir(), `skill-radar-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(FAKE_HOME, { recursive: true });
  REAL_HOME = process.env.HOME!;
  REAL_XDG = process.env.XDG_CONFIG_HOME;
  process.env.HOME = FAKE_HOME;
  // XDG_CONFIG_HOME on Linux CI can override ~/.config — unset so our
  // FAKE_HOME/.config/devin/skills is the one scanner finds.
  delete process.env.XDG_CONFIG_HOME;
  // Also clear Claude/Codex env overrides that agents.ts honors.
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
});

afterEach(() => {
  process.env.HOME = REAL_HOME;
  if (REAL_XDG !== undefined) process.env.XDG_CONFIG_HOME = REAL_XDG;
  else delete process.env.XDG_CONFIG_HOME;
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

describe("scanner", () => {
  test("finds real dirs, symlinks, and broken symlinks across agents", async () => {
    const agentsDir = join(FAKE_HOME, ".agents/skills");
    const claudeDir = join(FAKE_HOME, ".claude/skills");
    const kiroDir = join(FAKE_HOME, ".kiro/skills");
    for (const d of [agentsDir, claudeDir, kiroDir]) mkdirSync(d, { recursive: true });

    // Real skill in agents
    mkSkill(agentsDir, "real-skill", "a real skill");
    // Symlink in claude → agents
    mkSymlink(join(agentsDir, "real-skill"), claudeDir, "real-skill");
    // Broken symlink in kiro
    mkBrokenSymlink(kiroDir, "dead-link");

    const { scanAll } = await import("../src/scanner.js");
    const { skills } = scanAll();

    const realSkill = skills.find((s) => s.name === "real-skill" && s.agent === "agents");
    expect(realSkill).toBeDefined();
    expect(realSkill!.isSymlink).toBe(false);
    expect(realSkill!.hasSkillMd).toBe(true);

    const symlinkSkill = skills.find((s) => s.name === "real-skill" && s.agent === "claude");
    expect(symlinkSkill).toBeDefined();
    expect(symlinkSkill!.isSymlink).toBe(true);

    const broken = skills.find((s) => s.name === "dead-link");
    expect(broken).toBeDefined();
    expect(broken!.isSymlink).toBe(true);
    expect(broken!.hasSkillMd).toBe(false);
  });

  test("parses frontmatter description and computes content hash", async () => {
    const agentsDir = join(FAKE_HOME, ".agents/skills");
    mkdirSync(agentsDir, { recursive: true });
    mkSkill(agentsDir, "parsed", "my cool skill", "# heading\nbody text");

    const { scanAll } = await import("../src/scanner.js");
    const { skills } = scanAll();
    const s = skills.find((x) => x.name === "parsed");
    expect(s).toBeDefined();
    expect(s!.description).toBe("my cool skill");
    expect(s!.contentHash).toHaveLength(16);
    expect(s!.sizeBytes).toBeGreaterThan(0);
  });

  test("uniqueSkills collapses symlink aliases to one entry", async () => {
    const agentsDir = join(FAKE_HOME, ".agents/skills");
    const claudeDir = join(FAKE_HOME, ".claude/skills");
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    const real = mkSkill(agentsDir, "shared", "shared skill");
    mkSymlink(real, claudeDir, "shared");

    const { scanAll, uniqueSkills } = await import("../src/scanner.js");
    const { skills } = scanAll();
    expect(skills.length).toBe(2); // 1 real + 1 symlink
    const uniq = uniqueSkills(skills);
    expect(uniq.length).toBe(1); // collapsed
  });
});

describe("dedup", () => {
  test("detects content-clone: same SKILL.md body, different real paths", async () => {
    const agentsDir = join(FAKE_HOME, ".agents/skills");
    const devinDir = join(FAKE_HOME, ".config/devin/skills");
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(devinDir, { recursive: true });

    const body = "# identical body\nsame content here";
    mkSkill(agentsDir, "tdai-memory", "memory skill", body);
    mkSkill(devinDir, "tdai-memory", "memory skill", body);

    const { scanAll } = await import("../src/scanner.js");
    const { findDuplicates } = await import("../src/dedup.js");
    const { skills } = scanAll();
    const dups = findDuplicates(skills);
    const clone = dups.find((d) => d.kind === "content-clone");
    expect(clone).toBeDefined();
    expect(clone!.name).toBe("tdai-memory");
    expect(clone!.members.length).toBe(2);
    // keepIndex should point to the agents copy (canonical)
    expect(clone!.members[clone!.keepIndex].agent).toBe("agents");
  });

  test("detects symlink-alias: same realPath via symlink", async () => {
    const agentsDir = join(FAKE_HOME, ".agents/skills");
    const claudeDir = join(FAKE_HOME, ".claude/skills");
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    const real = mkSkill(agentsDir, "aliased", "aliased skill");
    mkSymlink(real, claudeDir, "aliased");

    const { scanAll } = await import("../src/scanner.js");
    const { findDuplicates } = await import("../src/dedup.js");
    const dups = findDuplicates(scanAll().skills);
    const alias = dups.find((d) => d.kind === "symlink-alias");
    expect(alias).toBeDefined();
    expect(alias!.members.length).toBe(2);
  });

  test("detects name-collision: same name, different content", async () => {
    const agentsDir = join(FAKE_HOME, ".agents/skills");
    const devinDir = join(FAKE_HOME, ".config/devin/skills");
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(devinDir, { recursive: true });
    mkSkill(agentsDir, "conflict", "version A", "# body A");
    mkSkill(devinDir, "conflict", "version B", "# body B");

    const { scanAll } = await import("../src/scanner.js");
    const { findDuplicates } = await import("../src/dedup.js");
    const dups = findDuplicates(scanAll().skills);
    const collision = dups.find((d) => d.kind === "name-collision");
    expect(collision).toBeDefined();
    expect(collision!.name).toBe("conflict");
  });
});

describe("clean", () => {
  test("removes broken symlinks", async () => {
    const kiroDir = join(FAKE_HOME, ".kiro/skills");
    mkdirSync(kiroDir, { recursive: true });
    mkBrokenSymlink(kiroDir, "zombie1");
    mkBrokenSymlink(kiroDir, "zombie2");

    const { clean } = await import("../src/clean.js");
    const res = clean();
    expect(res.brokenRemoved).toBe(2);
    expect(existsSync(join(kiroDir, "zombie1"))).toBe(false);
    expect(existsSync(join(kiroDir, "zombie2"))).toBe(false);
  });

  test("removes duplicate copies, keeps canonical (~/.agents)", async () => {
    const agentsDir = join(FAKE_HOME, ".agents/skills");
    const devinDir = join(FAKE_HOME, ".config/devin/skills");
    const codexDir = join(FAKE_HOME, ".codex/skills");
    for (const d of [agentsDir, devinDir, codexDir]) mkdirSync(d, { recursive: true });

    const body = "# same body\nidentical";
    mkSkill(agentsDir, "dup-skill", "dup", body);
    mkSkill(devinDir, "dup-skill", "dup", body);
    mkSkill(codexDir, "dup-skill", "dup", body);

    const { clean } = await import("../src/clean.js");
    const res = clean();
    expect(res.duplicatesRemoved).toBe(2);
    // canonical kept
    expect(existsSync(join(agentsDir, "dup-skill", "SKILL.md"))).toBe(true);
    // copies removed
    expect(existsSync(join(devinDir, "dup-skill"))).toBe(false);
    expect(existsSync(join(codexDir, "dup-skill"))).toBe(false);
  });

  test("--dry-run reports but does not delete", async () => {
    const kiroDir = join(FAKE_HOME, ".kiro/skills");
    mkdirSync(kiroDir, { recursive: true });
    mkBrokenSymlink(kiroDir, "ghost");

    const { clean } = await import("../src/clean.js");
    const res = clean({ dryRun: true });
    expect(res.brokenRemoved).toBe(1);
    // still exists
    expect(lstatSync(join(kiroDir, "ghost")).isSymbolicLink()).toBe(true);
  });

  test("--dead removes skills with no manual invoke", async () => {
    const agentsDir = join(FAKE_HOME, ".agents/skills");
    mkdirSync(agentsDir, { recursive: true });
    // Give different bodies so they're not content-clone duplicates.
    mkSkill(agentsDir, "unused", "never invoked", "# unused skill body");
    mkSkill(agentsDir, "used", "sometimes invoked", "# used skill body");

    // Write a Claude history.jsonl that references "used" but not "unused"
    mkdirSync(join(FAKE_HOME, ".claude"), { recursive: true });
    writeFileSync(
      join(FAKE_HOME, ".claude/history.jsonl"),
      JSON.stringify({ display: "/used do something", timestamp: Date.now() }) + "\n",
    );

    const { clean } = await import("../src/clean.js");
    const res = clean({ dead: true });
    expect(res.deadRemoved).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(agentsDir, "unused"))).toBe(false);
    expect(existsSync(join(agentsDir, "used"))).toBe(true);
  });
});

describe("usage reader", () => {
  test("extracts /skill-name from Claude history.jsonl", async () => {
    mkdirSync(join(FAKE_HOME, ".claude"), { recursive: true });
    writeFileSync(
      join(FAKE_HOME, ".claude/history.jsonl"),
      [
        JSON.stringify({ display: "/frontend-design make it pretty", timestamp: 1700000000000 }),
        JSON.stringify({ display: "just a normal prompt", timestamp: 1700000001000 }),
        JSON.stringify({ display: "/frontend-design again", timestamp: 1700000002000 }),
        JSON.stringify({ display: "/debug this crash", timestamp: 1700000003000 }),
      ].join("\n") + "\n",
    );

    const { readUsage } = await import("../src/usage.js");
    const usage = readUsage();
    expect(usage.get("frontend-design")?.count).toBe(2);
    expect(usage.get("debug")?.count).toBe(1);
    expect(usage.get("frontend-design")?.sources).toContain("claude");
  });

  test("returns empty map when no history files exist", async () => {
    const { readUsage } = await import("../src/usage.js");
    const usage = readUsage();
    expect(usage.size).toBe(0);
  });
});

describe("delete-by-name across agents (the bug fix)", () => {
  test("deleting a skill removes real dir + all symlinks, no zombies left", async () => {
    const agentsDir = join(FAKE_HOME, ".agents/skills");
    const claudeDir = join(FAKE_HOME, ".claude/skills");
    const kiroDir = join(FAKE_HOME, ".kiro/skills");
    for (const d of [agentsDir, claudeDir, kiroDir]) mkdirSync(d, { recursive: true });

    const real = mkSkill(agentsDir, "multi-copy", "has copies everywhere");
    mkSymlink(real, claudeDir, "multi-copy");
    mkSymlink(real, kiroDir, "multi-copy");

    // Simulate what TUI `d` does: scanAll raw, filter by name, delete each.
    const { scanAll } = await import("../src/scanner.js");
    const { lstatSync, unlinkSync, rmSync } = await import("node:fs");
    const raw = scanAll().skills;
    const targets = raw.filter((s) => s.name === "multi-copy");
    expect(targets.length).toBe(3); // 1 real + 2 symlinks

    for (const s of targets) {
      const st = lstatSync(s.skillPath);
      if (st.isSymbolicLink()) unlinkSync(s.skillPath);
      else rmSync(s.skillPath, { recursive: true, force: true });
    }

    // Verify: nothing left, no broken symlinks
    expect(existsSync(join(agentsDir, "multi-copy"))).toBe(false);
    expect(existsSync(join(claudeDir, "multi-copy"))).toBe(false);
    expect(existsSync(join(kiroDir, "multi-copy"))).toBe(false);

    // Re-scan: should find 0 entries for this name
    const after = scanAll().skills.filter((s) => s.name === "multi-copy");
    expect(after.length).toBe(0);
  });
});

describe("doctor", () => {
  test("flags broken symlinks and missing SKILL.md", async () => {
    const agentsDir = join(FAKE_HOME, ".agents/skills");
    const kiroDir = join(FAKE_HOME, ".kiro/skills");
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(kiroDir, { recursive: true });

    // broken symlink
    mkBrokenSymlink(kiroDir, "broken-one");
    // dir without SKILL.md
    mkdirSync(join(agentsDir, "no-skillmd"), { recursive: true });

    const { scanAll } = await import("../src/scanner.js");
    const { doctor } = await import("../src/doctor.js");
    const issues = doctor(scanAll().skills);
    expect(issues.some((i) => i.severity === "broken")).toBe(true);
    expect(issues.some((i) => i.severity === "missing" || i.severity === "empty")).toBe(true);
  });

  test("reports no issues on a clean tree", async () => {
    const agentsDir = join(FAKE_HOME, ".agents/skills");
    mkdirSync(agentsDir, { recursive: true });
    mkSkill(agentsDir, "clean-skill", "totally fine");

    const { scanAll } = await import("../src/scanner.js");
    const { doctor } = await import("../src/doctor.js");
    const issues = doctor(scanAll().skills);
    expect(issues.length).toBe(0);
  });
});

describe("score", () => {
  test("health score penalizes dead + duplicate + broken", async () => {
    const agentsDir = join(FAKE_HOME, ".agents/skills");
    const devinDir = join(FAKE_HOME, ".config/devin/skills");
    const kiroDir = join(FAKE_HOME, ".kiro/skills");
    for (const d of [agentsDir, devinDir, kiroDir]) mkdirSync(d, { recursive: true });

    // 1 healthy skill (with usage)
    mkSkill(agentsDir, "healthy", "used skill");
    mkdirSync(join(FAKE_HOME, ".claude"), { recursive: true });
    writeFileSync(
      join(FAKE_HOME, ".claude/history.jsonl"),
      JSON.stringify({ display: "/healthy go", timestamp: Date.now() }) + "\n",
    );
    // 1 dead skill (no usage)
    mkSkill(agentsDir, "dead-one", "unused skill");
    // 1 duplicate
    const body = "# same";
    mkSkill(agentsDir, "dup", "dup", body);
    mkSkill(devinDir, "dup", "dup", body);
    // 1 broken symlink
    mkBrokenSymlink(kiroDir, "broken-skill");

    const { scanAll } = await import("../src/scanner.js");
    const { findDuplicates } = await import("../src/dedup.js");
    const { readUsage } = await import("../src/usage.js");
    const { score } = await import("../src/score.js");

    const { skills } = scanAll();
    const dups = findDuplicates(skills);
    const dupRealPaths = new Set<string>();
    for (const g of dups) {
      if (g.kind === "content-clone") {
        g.members.forEach((m, i) => {
          if (i !== g.keepIndex) dupRealPaths.add(m.realPath);
        });
      }
    }
    const brokenPaths = new Set(
      skills.filter((s) => !s.hasSkillMd && s.isSymlink).map((s) => s.skillPath),
    );
    const usage = readUsage();
    const report = score(skills, usage, dupRealPaths, brokenPaths);

    expect(report.healthScore).toBeLessThan(100);
    expect(report.deadCount).toBeGreaterThanOrEqual(1);
    expect(report.duplicateCount).toBeGreaterThanOrEqual(1);
    expect(report.brokenCount).toBeGreaterThanOrEqual(1);
    // healthy skill should have low waste, dead/dup should have high waste
    const healthy = report.scores.find((s) => s.skill.name === "healthy");
    const dead = report.scores.find((s) => s.skill.name === "dead-one");
    expect(healthy!.wasteScore).toBeLessThan(dead!.wasteScore);
  });
});
