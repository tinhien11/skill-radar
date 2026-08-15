// CLI entry. `skill-radar` with no args runs the TUI (the addictive default).
// Subcommands: scan, score, dedup, doctor, history, clean, report, init.

import { Command } from "commander";
import { writeFileSync, existsSync } from "node:fs";
import { buildReport } from "./report.js";
import {
  renderSummary, renderScoreTable, renderDuplicates, renderDoctor,
  renderJson, renderMarkdown,
} from "./render.js";
import { runTui } from "./tui.js";
import { readHistory } from "./history.js";
import { clean } from "./clean.js";
import { scanAll } from "./scanner.js";
import { candidateRoots } from "./agents.js";
import { readUsageWithSkills } from "./usage.js";
import { uniqueSkills } from "./scanner.js";

const program = new Command();

program
  .name("skill-radar")
  .description("Cross-agent skill health radar. Hook-free usage scoring, dedup, bulk cleanup.")
  .version("0.3.0")
  .action(() => {
    // default = TUI (the addictive loop). Fall back to text scan if not a TTY
    // (e.g. piped output, CI, non-interactive shell) so the tool never crashes.
    if (process.stdin.isTTY && process.stdout.isTTY) {
      runTui();
    } else {
      const r = buildReport(true);
      process.stdout.write(renderSummary(r));
      process.stdout.write(renderScoreTable(r, 20));
      process.stdout.write(
        "\n  (non-interactive shell — run `skill-radar` in a terminal for the TUI)\n",
      );
    }
  });

program
  .command("scan")
  .description("One-shot health report (no TUI). Persists a snapshot for trend.")
  .option("--json", "output as JSON (for scripting/automation)")
  .action((opts) => {
    const r = buildReport(true);
    if (opts.json) {
      process.stdout.write(renderJson(r) + "\n");
    } else {
      process.stdout.write(renderSummary(r));
      process.stdout.write(renderScoreTable(r, 20));
    }
  });

program
  .command("score")
  .description("Full waste ranking table (all skills, not just top 20).")
  .option("--json", "output as JSON (for scripting/automation)")
  .action((opts) => {
    const r = buildReport(false);
    if (opts.json) {
      process.stdout.write(renderJson(r) + "\n");
    } else {
      process.stdout.write(renderSummary(r));
      process.stdout.write(renderScoreTable(r, 9999));
    }
  });

program
  .command("dedup")
  .description("Show duplicate skills (content clones, name collisions, symlink aliases).")
  .option("--json", "output as JSON (for scripting/automation)")
  .action((opts) => {
    const r = buildReport(false);
    if (opts.json) {
      process.stdout.write(renderJson(r) + "\n");
    } else {
      process.stdout.write(renderSummary(r));
      process.stdout.write(renderDuplicates(r));
    }
  });

program
  .command("doctor")
  .description("Show structural issues (broken symlinks, missing SKILL.md, empty dirs).")
  .option("--json", "output as JSON (for scripting/automation)")
  .option("--fix", "auto-fix: remove broken symlinks, replace duplicates with symlinks")
  .option("--dry-run", "show what would be fixed without changing anything")
  .action((opts) => {
    if (opts.fix) {
      const res = clean({ dead: false, dryRun: opts.dryRun, backup: false });
      const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";
      const verb = opts.dryRun ? "would fix" : "fixed";
      process.stdout.write(`\n  ${B}doctor --fix${X} ${D}${opts.dryRun ? "(dry run)" : ""}${X}\n\n`);
      if (res.brokenRemoved > 0) {
        process.stdout.write(`  ${R}${res.brokenRemoved}${X} ${D}broken symlinks ${verb}${X}\n`);
        for (const a of res.actions.filter((x) => x.kind === "broken-symlink")) {
          process.stdout.write(`    ${D}${a.agent}${X}  ${a.path}\n`);
        }
      }
      if (res.duplicatesRemoved > 0) {
        process.stdout.write(`  ${Y}${res.duplicatesRemoved}${X} ${D}duplicate copies ${verb} (canonical kept)${X}\n`);
        for (const a of res.actions.filter((x) => x.kind === "duplicate-copy")) {
          process.stdout.write(`    ${D}${a.agent}${X}  ${a.name}  ${a.path}\n`);
        }
      }
      if (res.brokenRemoved + res.duplicatesRemoved === 0) {
        process.stdout.write(`  ${G}nothing to fix — already healthy${X}\n`);
      }
      process.stdout.write(`\n  ${B}${res.totalBefore}→${res.totalAfter}${X} ${D}skill entries${X}\n\n`);
    } else {
      const r = buildReport(false);
      if (opts.json) {
        process.stdout.write(renderJson(r) + "\n");
      } else {
        process.stdout.write(renderDoctor(r));
      }
    }
  });

program
  .command("history")
  .description("Show scan history (the compounding trend over time).")
  .option("--json", "output as JSON (for scripting/automation)")
  .action((opts) => {
    const h = readHistory();
    if (h.length === 0) {
      if (opts.json) {
        process.stdout.write("[]\n");
      } else {
        process.stdout.write("  no history yet — run `skill-radar scan` to start tracking.\n");
      }
      return;
    }
    if (opts.json) {
      process.stdout.write(JSON.stringify(h, null, 2) + "\n");
    } else {
      process.stdout.write(`  ${h.length} snapshots\n\n`);
      for (const s of h) {
        const d = new Date(s.ts).toISOString().slice(0, 16);
        const color = s.healthScore >= 75 ? "\x1b[32m" : s.healthScore >= 50 ? "\x1b[33m" : "\x1b[31m";
        process.stdout.write(
          `  ${d}  ${color}${s.healthScore}/100\x1b[0m  ${s.totalSkills} skills  ${s.deadCount} dead  ${s.duplicateCount} dups  ~${s.wastedTokensPerTurn} tok/turn\n`,
        );
      }
    }
  });

program
  .command("clean")
  .description("Auto-fix: remove broken symlinks + duplicate copies (keep canonical). No TUI, no confirm.")
  .option("--dead", "also remove skills with no manual invoke (aggressive)")
  .option("--dry-run", "show what would be removed without deleting")
  .option("--backup", "back up skills to ~/.local/share/skill-radar/backups/ before deleting")
  .action((opts) => {
    const res = clean({ dead: opts.dead, dryRun: opts.dryRun, backup: opts.backup });
    const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";
    const verb = opts.dryRun ? "would remove" : "removed";
    process.stdout.write(`\n  ${B}clean${X} ${D}${opts.dryRun ? "(dry run)" : ""}${X}\n\n`);
    if (res.brokenRemoved > 0) {
      process.stdout.write(`  ${R}${res.brokenRemoved}${X} ${D}broken symlinks ${verb}${X}\n`);
      for (const a of res.actions.filter((x) => x.kind === "broken-symlink")) {
        process.stdout.write(`    ${D}${a.agent}${X}  ${a.path}\n`);
      }
    }
    if (res.duplicatesRemoved > 0) {
      process.stdout.write(`  ${Y}${res.duplicatesRemoved}${X} ${D}duplicate copies ${verb} (canonical kept)${X}\n`);
      for (const a of res.actions.filter((x) => x.kind === "duplicate-copy")) {
        process.stdout.write(`    ${D}${a.agent}${X}  ${a.name}  ${a.path}\n`);
      }
    }
    if (res.deadRemoved > 0) {
      process.stdout.write(`  ${R}${res.deadRemoved}${X} ${D}dead skills ${verb}${X}\n`);
      const seen = new Set<string>();
      for (const a of res.actions.filter((x) => x.kind === "dead-skill")) {
        if (seen.has(a.name)) continue;
        seen.add(a.name);
        process.stdout.write(`    ${D}${a.name}${X}\n`);
      }
    }
    if (res.brokenRemoved + res.duplicatesRemoved + res.deadRemoved === 0) {
      process.stdout.write(`  ${G}nothing to clean — already tidy${X}\n`);
    }
    process.stdout.write(`\n  ${B}${res.totalBefore}→${res.totalAfter}${X} ${D}skill entries${X}\n`);
    if (res.backup && res.backup.backedUp > 0) {
      process.stdout.write(`  ${G}${res.backup.backedUp}${X} ${D}skills backed up to ${res.backup.backupDir}${X}\n`);
    }
    if (res.errors.length > 0) {
      process.stdout.write(`\n  ${R}${res.errors.length} errors:${X}\n`);
      for (const e of res.errors) process.stdout.write(`    ${e}\n`);
    }
    process.stdout.write("\n");
  });

program
  .command("report")
  .description("Generate a markdown report (shareable, for teams/docs/GitHub).")
  .option("-o, --output <file>", "write to file instead of stdout")
  .action((opts) => {
    const r = buildReport(false);
    const md = renderMarkdown(r);
    if (opts.output) {
      writeFileSync(opts.output, md, "utf8");
      process.stdout.write(`  report written to ${opts.output}\n`);
    } else {
      process.stdout.write(md + "\n");
    }
  });

program
  .command("autofix")
  .description("One-shot: backup + remove broken symlinks + dedup + remove dead skills. Safe by default.")
  .option("--dry-run", "preview what would be done without changing anything")
  .option("--no-dead", "skip removing dead skills (only fix broken + duplicates)")
  .option("--no-backup", "skip backup before deleting (NOT recommended)")
  .action((opts) => {
    const doBackup = opts.backup !== false; // default true
    const removeDead = opts.dead !== false; // default true
    const res = clean({ dead: removeDead, dryRun: opts.dryRun, backup: doBackup });
    const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";
    const verb = opts.dryRun ? "would fix" : "fixed";
    process.stdout.write(`\n  ${B}autofix${X} ${D}${opts.dryRun ? "(dry run)" : ""}${X}\n\n`);

    if (res.brokenRemoved > 0) {
      process.stdout.write(`  ${R}${res.brokenRemoved}${X} ${D}broken symlinks ${verb}${X}\n`);
    }
    if (res.duplicatesRemoved > 0) {
      process.stdout.write(`  ${Y}${res.duplicatesRemoved}${X} ${D}duplicate copies ${verb} (canonical kept)${X}\n`);
    }
    if (res.deadRemoved > 0) {
      process.stdout.write(`  ${R}${res.deadRemoved}${X} ${D}dead skills ${verb}${X}\n`);
    }
    const total = res.brokenRemoved + res.duplicatesRemoved + res.deadRemoved;
    if (total === 0) {
      process.stdout.write(`  ${G}nothing to fix — already healthy${X}\n`);
    }
    process.stdout.write(`\n  ${B}${res.totalBefore}→${res.totalAfter}${X} ${D}skill entries${X}\n`);
    if (res.backup && res.backup.backedUp > 0) {
      process.stdout.write(`  ${G}${res.backup.backedUp}${X} ${D}skills backed up to ${res.backup.backupDir}${X}\n`);
    } else if (doBackup && !opts.dryRun && total > 0) {
      process.stdout.write(`  ${D}no backup needed (only broken symlinks removed)${X}\n`);
    }
    if (res.errors.length > 0) {
      process.stdout.write(`\n  ${R}${res.errors.length} errors:${X}\n`);
      for (const e of res.errors) process.stdout.write(`    ${e}\n`);
    }
    process.stdout.write("\n");
  });

program
  .command("init")
  .description("First-run setup wizard: check agents, verify history access, explain output.")
  .action(() => {
    const B = "\x1b[1m", D = "\x1b[2m", G = "\x1b[32m", Y = "\x1b[33m", R = "\x1b[31m", C = "\x1b[36m", X = "\x1b[0m";
    process.stdout.write(`\n  ${B}skill-radar init${X} — checking your setup\n\n`);

    // 1. Check agent roots
    const roots = candidateRoots();
    const found = roots.filter((r) => existsSync(r.path));
    process.stdout.write(`  ${B}Agents detected${X}\n`);
    if (found.length === 0) {
      process.stdout.write(`  ${R}No agent skill directories found.${X}\n`);
      process.stdout.write(`  ${D}Install at least one AI coding agent (Claude, Devin, Codex, etc.)${X}\n`);
    } else {
      for (const r of found) {
        process.stdout.write(`  ${G}✓${X} ${r.agent.padEnd(16)} ${D}${r.path}${X}\n`);
      }
    }
    process.stdout.write(`\n  ${D}${found.length} agent(s) with skill directories${X}\n\n`);

    // 2. Check history access
    process.stdout.write(`  ${B}Usage history sources${X}\n`);
    const { skills } = scanAll();
    const skillNames = uniqueSkills(skills).map((s) => s.name);
    const usage = readUsageWithSkills(skillNames);
    const sources = new Set<string>();
    for (const [, e] of usage) for (const s of e.sources) sources.add(s);
    if (sources.size === 0) {
      process.stdout.write(`  ${Y}⚠ No usage history found${X}\n`);
      process.stdout.write(`  ${D}This is normal on first run. Skills will show as "no manual invoke" until you use them.${X}\n`);
    } else {
      for (const s of ["devin", "claude", "codex"]) {
        if (sources.has(s)) {
          process.stdout.write(`  ${G}✓${X} ${s.padEnd(16)} ${D}history readable${X}\n`);
        }
      }
    }
    process.stdout.write("\n");

    // 3. Quick scan preview
    process.stdout.write(`  ${B}Quick scan${X}\n`);
    const r = buildReport(false);
    const h = r.health;
    const healthColor = h.healthScore >= 75 ? G : h.healthScore >= 50 ? Y : R;
    process.stdout.write(`  Health: ${healthColor}${h.healthScore}/100${X}  ${C}${h.totalSkills}${X} skills  ${R}${h.deadCount}${X} dead  ${Y}${h.duplicateCount}${X} dups  ${Y}${h.brokenCount}${X} broken\n\n`);

    // 4. Next steps
    process.stdout.write(`  ${B}Next steps${X}\n`);
    if (h.brokenCount > 0) {
      process.stdout.write(`  ${Y}→${X} Run ${B}skill-radar doctor --fix${X} to remove ${h.brokenCount} broken symlinks\n`);
    }
    if (h.duplicateCount > 0) {
      process.stdout.write(`  ${Y}→${X} Run ${B}skill-radar clean --backup${X} to deduplicate ${h.duplicateCount} skills\n`);
    }
    if (h.deadCount > 0) {
      process.stdout.write(`  ${Y}→${X} Run ${B}skill-radar clean --dead --backup${X} to remove ${h.deadCount} dead skills\n`);
    }
    if (h.brokenCount === 0 && h.duplicateCount === 0 && h.deadCount === 0) {
      process.stdout.write(`  ${G}All clean! Run ${B}skill-radar${X} for the interactive TUI.${X}\n`);
    }
    process.stdout.write(`\n  ${D}Run ${B}skill-radar${X} for the TUI, or ${B}skill-radar scan${X} for a quick check.${X}\n\n`);
  });

program.parse(process.argv);
