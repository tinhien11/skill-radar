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

  test("extracts skill name from pasted SKILL.md path", async () => {
    mkdirSync(join(FAKE_HOME, ".claude"), { recursive: true });
    writeFileSync(
      join(FAKE_HOME, ".claude/history.jsonl"),
      [
        JSON.stringify({ display: "/data/projects/azr/.devin/skills/azr-workflow/SKILL.md\nload this skill", timestamp: 1700000000000 }),
        JSON.stringify({ display: "some /other-skill text", timestamp: 1700000001000 }),
      ].join("\n") + "\n",
    );

    const { readUsage } = await import("../src/usage.js");
    const usage = readUsage();
    expect(usage.get("azr-workflow")?.count).toBe(1);
    expect(usage.get("azr-workflow")?.sources).toContain("claude");
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

describe("plugin discovery (nested skill roots)", () => {
  test("finds skills under ~/.claude/plugins/marketplaces/.../skills/", async () => {
    // Simulate a Claude plugin marketplace tree:
    //   ~/.claude/plugins/marketplaces/official/plugins/foo/skills/bar/SKILL.md
    const pluginSkillsDir = join(FAKE_HOME, ".claude/plugins/marketplaces/official/plugins/foo/skills");
    mkSkill(pluginSkillsDir, "plugin-skill", "a plugin skill");

    const { scanAll } = await import("../src/scanner.js");
    const { skills } = scanAll();
    const found = skills.find((s) => s.name === "plugin-skill");
    expect(found).toBeDefined();
    expect(found!.agent).toBe("claude-plugin");
  });

  test("finds skills under ~/.kimi-code/plugins/managed/.../skills/", async () => {
    const pluginSkillsDir = join(FAKE_HOME, ".kimi-code/plugins/managed/superpowers/skills");
    mkSkill(pluginSkillsDir, "kimi-plugin-skill", "a kimi plugin skill");

    const { scanAll } = await import("../src/scanner.js");
    const { skills } = scanAll();
    const found = skills.find((s) => s.name === "kimi-plugin-skill");
    expect(found).toBeDefined();
    expect(found!.agent).toBe("kimi-plugin");
  });

  test("does not treat a 'skills' dir without SKILL.md children as a root", async () => {
    // A "skills" dir that's just an empty folder should not be scanned.
    mkdirSync(join(FAKE_HOME, ".claude/plugins/foo/skills"), { recursive: true });
    const { scanAll } = await import("../src/scanner.js");
    const { skills } = scanAll();
    // No skill should be found from this empty root.
    expect(skills.find((s) => s.agent === "claude-plugin")).toBeUndefined();
  });
});

describe("non-standard agent roots", () => {
  test("finds skills in ~/.kimi-code/skills/", async () => {
    const dir = join(FAKE_HOME, ".kimi-code/skills");
    mkSkill(dir, "kimi-direct", "direct kimi skill");

    const { scanAll } = await import("../src/scanner.js");
    const { skills } = scanAll();
    const found = skills.find((s) => s.name === "kimi-direct");
    expect(found).toBeDefined();
    expect(found!.agent).toBe("kimi-code");
  });

  test("finds skills in ~/.commandcode/skills/", async () => {
    const dir = join(FAKE_HOME, ".commandcode/skills");
    mkSkill(dir, "cc-skill", "commandcode skill");

    const { scanAll } = await import("../src/scanner.js");
    const { skills } = scanAll();
    const found = skills.find((s) => s.name === "cc-skill");
    expect(found).toBeDefined();
    expect(found!.agent).toBe("commandcode");
  });
});

describe("project-level skill roots", () => {
  test("finds skills in ./.devin/skills/ from cwd", async () => {
    // We can't easily change cwd in tests, but we can create the dir in the
    // real cwd and clean up after. Instead, verify the candidate list includes
    // project roots pointing to cwd.
    const { candidateRoots } = await import("../src/agents.js");
    const roots = candidateRoots();
    const projectRoots = roots.filter((r) => r.scope === "project");
    expect(projectRoots.length).toBeGreaterThanOrEqual(3);
    expect(projectRoots.some((r) => r.agent === "project-devin")).toBe(true);
    expect(projectRoots.some((r) => r.agent === "project-agents")).toBe(true);
    expect(projectRoots.some((r) => r.agent === "project-windsurf")).toBe(true);
  });
});

describe("backup before deletion", () => {
  test("clean --backup copies skills before removing", async () => {
    const agentsDir = join(FAKE_HOME, ".agents/skills");
    mkdirSync(agentsDir, { recursive: true });
    mkSkill(agentsDir, "to-delete", "will be deleted", "# body to preserve");

    // Set up backup dir under FAKE_HOME
    mkdirSync(join(FAKE_HOME, ".local/share/skill-radar/backups"), { recursive: true });

    const { clean } = await import("../src/clean.js");
    const res = clean({ dead: true, backup: true });
    expect(res.deadRemoved).toBeGreaterThanOrEqual(1);
    expect(res.backup).toBeDefined();
    expect(res.backup!.backedUp).toBeGreaterThanOrEqual(1);
    // The skill should be gone from the original location
    expect(existsSync(join(agentsDir, "to-delete"))).toBe(false);
  });

  test("clean without --backup does not create backup", async () => {
    const agentsDir = join(FAKE_HOME, ".agents/skills");
    mkdirSync(agentsDir, { recursive: true });
    mkSkill(agentsDir, "no-backup", "no backup please", "# body");

    const { clean } = await import("../src/clean.js");
    const res = clean({ dead: true });
    expect(res.backup).toBeUndefined();
  });
});

describe("history rotation", () => {
  test("history file rotates when exceeding MAX_ENTRIES", async () => {
    // Write more than 365 entries to the history file, then trigger rotation
    // by calling appendSnapshot.
    const historyDir = join(FAKE_HOME, ".config", "skill-radar");
    mkdirSync(historyDir, { recursive: true });
    const historyFile = join(historyDir, "history.jsonl");

    // Write 400 fake entries
    const lines: string[] = [];
    for (let i = 0; i < 400; i++) {
      lines.push(JSON.stringify({
        ts: 1700000000000 + i * 1000,
        totalSkills: 10,
        healthScore: 50,
        wastedTokensPerTurn: 100,
        deadCount: 5,
        duplicateCount: 0,
        brokenCount: 0,
        deadNames: [],
      }));
    }
    writeFileSync(historyFile, lines.join("\n") + "\n");

    // Trigger rotation by appending one more snapshot
    const { appendSnapshot, readHistory } = await import("../src/history.js");
    appendSnapshot({
      ts: Date.now(),
      totalSkills: 10,
      healthScore: 80,
      wastedTokensPerTurn: 50,
      deadCount: 2,
      duplicateCount: 0,
      brokenCount: 0,
      deadNames: [],
    });

    // After rotation, active file should have at most 365 entries
    const history = readHistory();
    expect(history.length).toBeLessThanOrEqual(366); // 365 + the new one
    expect(history.length).toBeGreaterThanOrEqual(365);

    // Old file should exist with the overflowed entries
    const oldFile = join(historyDir, "history.jsonl.old");
    expect(existsSync(oldFile)).toBe(true);
  });

  test("history does not rotate when under limit", async () => {
    const historyDir = join(FAKE_HOME, ".config", "skill-radar");
    mkdirSync(historyDir, { recursive: true });
    const historyFile = join(historyDir, "history.jsonl");

    // Write only 10 entries
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(JSON.stringify({
        ts: 1700000000000 + i * 1000,
        totalSkills: 5,
        healthScore: 90,
        wastedTokensPerTurn: 10,
        deadCount: 0,
        duplicateCount: 0,
        brokenCount: 0,
        deadNames: [],
      }));
    }
    writeFileSync(historyFile, lines.join("\n") + "\n");

    const { appendSnapshot, readHistory } = await import("../src/history.js");
    appendSnapshot({
      ts: Date.now(),
      totalSkills: 5,
      healthScore: 90,
      wastedTokensPerTurn: 10,
      deadCount: 0,
      duplicateCount: 0,
      brokenCount: 0,
      deadNames: [],
    });

    const history = readHistory();
    expect(history.length).toBe(11); // 10 + 1 new

    // No old file should be created
    const oldFile = join(historyDir, "history.jsonl.old");
    expect(existsSync(oldFile)).toBe(false);
  });
});

describe("NL regex cap", () => {
  test("buildNlRegex handles 100+ skill names without crash", async () => {
    // Generate 150 fake skill names
    const names: string[] = [];
    for (let i = 0; i < 150; i++) {
      names.push(`skill-${i}-with-a-long-name`);
    }

    // We test indirectly via readUsageWithSkills — it should not throw
    // even with 150 skill names.
    const { readUsageWithSkills } = await import("../src/usage.js");
    expect(() => readUsageWithSkills(names)).not.toThrow();
  });
});

describe("--json output mode", () => {
  test("renderJson produces valid JSON with expected fields", async () => {
    const agentsDir = join(FAKE_HOME, ".agents/skills");
    mkdirSync(agentsDir, { recursive: true });
    mkSkill(agentsDir, "json-test", "test skill for json", "# body");

    const { buildReport } = await import("../src/report.js");
    const { renderJson } = await import("../src/render.js");
    const r = buildReport(false);
    const json = renderJson(r);
    const parsed = JSON.parse(json);

    expect(parsed).toHaveProperty("health");
    expect(parsed).toHaveProperty("skills");
    expect(parsed).toHaveProperty("duplicates");
    expect(parsed).toHaveProperty("issues");
    expect(parsed.health).toHaveProperty("score");
    expect(parsed.health).toHaveProperty("totalSkills");
    expect(Array.isArray(parsed.skills)).toBe(true);
    expect(parsed.skills.length).toBeGreaterThan(0);
    expect(parsed.skills[0]).toHaveProperty("name");
    expect(parsed.skills[0]).toHaveProperty("wasteScore");
    expect(parsed.skills[0]).toHaveProperty("verdict");
  });

  test("renderJson has no ANSI escape codes", async () => {
    const agentsDir = join(FAKE_HOME, ".agents/skills");
    mkdirSync(agentsDir, { recursive: true });
    mkSkill(agentsDir, "no-ansi", "check no ansi", "# body");

    const { buildReport } = await import("../src/report.js");
    const { renderJson } = await import("../src/render.js");
    const r = buildReport(false);
    const json = renderJson(r);
    expect(json).not.toMatch(/\x1b\[/);
  });
});

describe("renderMarkdown report", () => {
  test("renderMarkdown produces valid markdown with expected sections", async () => {
    const agentsDir = join(FAKE_HOME, ".agents/skills");
    mkdirSync(agentsDir, { recursive: true });
    mkSkill(agentsDir, "md-test", "test for markdown", "# body");

    const { buildReport } = await import("../src/report.js");
    const { renderMarkdown } = await import("../src/render.js");
    const r = buildReport(false);
    const md = renderMarkdown(r);

    expect(md).toContain("# Skill Radar Report");
    expect(md).toContain("## Summary");
    expect(md).toContain("## Waste Ranking");
    expect(md).toContain("## Recommendations");
    expect(md).toContain("Health Score");
    expect(md).toContain("|");
  });

  test("renderMarkdown has no ANSI escape codes", async () => {
    const agentsDir = join(FAKE_HOME, ".agents/skills");
    mkdirSync(agentsDir, { recursive: true });
    mkSkill(agentsDir, "md-no-ansi", "no ansi in md", "# body");

    const { buildReport } = await import("../src/report.js");
    const { renderMarkdown } = await import("../src/render.js");
    const r = buildReport(false);
    const md = renderMarkdown(r);
    expect(md).not.toMatch(/\x1b\[/);
  });
});

describe("doctor --fix", () => {
  test("clean with no dead flag only fixes broken + duplicates (not dead skills)", async () => {
    const agentsDir = join(FAKE_HOME, ".agents/skills");
    mkdirSync(agentsDir, { recursive: true });
    mkSkill(agentsDir, "should-survive", "this should not be deleted", "# body");

    const { clean } = await import("../src/clean.js");
    const res = clean({ dead: false, dryRun: false });
    // Should not remove skills that aren't broken or duplicates
    expect(existsSync(join(agentsDir, "should-survive"))).toBe(true);
    expect(res.deadRemoved).toBe(0);
  });

  test("clean --dry-run does not delete anything", async () => {
    const agentsDir = join(FAKE_HOME, ".agents/skills");
    mkdirSync(agentsDir, { recursive: true });
    mkSkill(agentsDir, "dry-run-test", "should survive dry run", "# body");

    const { clean } = await import("../src/clean.js");
    const res = clean({ dead: true, dryRun: true });
    // dry-run should report counts but not actually delete
    expect(existsSync(join(agentsDir, "dry-run-test"))).toBe(true);
  });
});

describe("TUI search/filter logic", () => {
  test("filtering rows by name works case-insensitively", async () => {
    const agentsDir = join(FAKE_HOME, ".agents/skills");
    mkdirSync(agentsDir, { recursive: true });
    mkSkill(agentsDir, "SearchableSkill", "find me", "# body");
    mkSkill(agentsDir, "other-skill", "not matching", "# body");

    const { buildReport } = await import("../src/report.js");
    const { renderJson } = await import("../src/render.js");
    const r = buildReport(false);
    const json = JSON.parse(renderJson(r));
    const skills = json.skills;

    // Simulate TUI search filter logic
    const query = "searchable";
    const filtered = skills.filter((s: { name: string; description: string }) =>
      s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query),
    );
    expect(filtered.length).toBe(1);
    expect(filtered[0].name).toBe("SearchableSkill");
  });

  test("filtering rows by description works", async () => {
    const agentsDir = join(FAKE_HOME, ".agents/skills");
    mkdirSync(agentsDir, { recursive: true });
    mkSkill(agentsDir, "desc-test", "unique keyword here", "# body");
    mkSkill(agentsDir, "no-match", "different text", "# body");

    const { buildReport } = await import("../src/report.js");
    const { renderJson } = await import("../src/render.js");
    const r = buildReport(false);
    const json = JSON.parse(renderJson(r));
    const skills = json.skills;

    const query = "unique keyword";
    const filtered = skills.filter((s: { name: string; description: string }) =>
      s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query),
    );
    expect(filtered.length).toBe(1);
    expect(filtered[0].name).toBe("desc-test");
  });

  test("empty search query returns all rows", async () => {
    const agentsDir = join(FAKE_HOME, ".agents/skills");
    mkdirSync(agentsDir, { recursive: true });
    mkSkill(agentsDir, "skill-a", "first", "# body");
    mkSkill(agentsDir, "skill-b", "second", "# body");

    const { buildReport } = await import("../src/report.js");
    const { renderJson } = await import("../src/render.js");
    const r = buildReport(false);
    const json = JSON.parse(renderJson(r));
    const skills = json.skills;

    const query = "";
    const filtered = query
      ? skills.filter((s: { name: string; description: string }) =>
          s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query),
        )
      : skills;
    expect(filtered.length).toBe(skills.length);
  });
});

describe("autofix", () => {
  test("autofix with --no-dead only removes broken + duplicates, keeps dead skills", async () => {
    const agentsDir = join(FAKE_HOME, ".agents/skills");
    mkdirSync(agentsDir, { recursive: true });
    mkSkill(agentsDir, "dead-skill-keep", "should survive --no-dead", "# body");

    const { clean } = await import("../src/clean.js");
    const res = clean({ dead: false, dryRun: false, backup: true });
    expect(res.deadRemoved).toBe(0);
    expect(existsSync(join(agentsDir, "dead-skill-keep"))).toBe(true);
  });

  test("autofix --dry-run does not delete anything", async () => {
    const agentsDir = join(FAKE_HOME, ".agents/skills");
    mkdirSync(agentsDir, { recursive: true });
    mkSkill(agentsDir, "survive-dry", "should survive dry run", "# body");

    const { clean } = await import("../src/clean.js");
    const res = clean({ dead: true, dryRun: true, backup: true });
    expect(existsSync(join(agentsDir, "survive-dry"))).toBe(true);
  });

  test("autofix with backup creates backup before deleting dead skills", async () => {
    const agentsDir = join(FAKE_HOME, ".agents/skills");
    mkdirSync(agentsDir, { recursive: true });
    mkSkill(agentsDir, "autofix-dead", "will be removed with backup", "# important content");

    const { clean } = await import("../src/clean.js");
    const res = clean({ dead: true, dryRun: false, backup: true });
    expect(res.deadRemoved).toBeGreaterThanOrEqual(1);
    expect(res.backup).toBeDefined();
    expect(res.backup!.backedUp).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(agentsDir, "autofix-dead"))).toBe(false);
  });

  test("autofix --no-backup skips backup", async () => {
    const agentsDir = join(FAKE_HOME, ".agents/skills");
    mkdirSync(agentsDir, { recursive: true });
    mkSkill(agentsDir, "no-backup-test", "no backup", "# body");

    const { clean } = await import("../src/clean.js");
    const res = clean({ dead: true, dryRun: false, backup: false });
    expect(res.backup).toBeUndefined();
  });
});
