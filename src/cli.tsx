// CLI entry. `skill-radar` with no args runs the TUI (the addictive default).
// Subcommands: scan, score, dedup, doctor, history.

import { Command } from "commander";
import { buildReport } from "./report.js";
import { renderSummary, renderScoreTable, renderDuplicates, renderDoctor } from "./render.js";
import { runTui } from "./tui.js";
import { readHistory } from "./history.js";
import { clean } from "./clean.js";

const program = new Command();

program
  .name("skill-radar")
  .description("Cross-agent skill health radar. Hook-free usage scoring, dedup, bulk cleanup.")
  .version("0.1.0")
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
  .action(() => {
    const r = buildReport(true);
    process.stdout.write(renderSummary(r));
    process.stdout.write(renderScoreTable(r, 20));
  });

program
  .command("score")
  .description("Full waste ranking table (all skills, not just top 20).")
  .action(() => {
    const r = buildReport(false);
    process.stdout.write(renderSummary(r));
    process.stdout.write(renderScoreTable(r, 9999));
  });

program
  .command("dedup")
  .description("Show duplicate skills (content clones, name collisions, symlink aliases).")
  .action(() => {
    const r = buildReport(false);
    process.stdout.write(renderSummary(r));
    process.stdout.write(renderDuplicates(r));
  });

program
  .command("doctor")
  .description("Show structural issues (broken symlinks, missing SKILL.md, empty dirs).")
  .action(() => {
    const r = buildReport(false);
    process.stdout.write(renderDoctor(r));
  });

program
  .command("history")
  .description("Show scan history (the compounding trend over time).")
  .action(() => {
    const h = readHistory();
    if (h.length === 0) {
      process.stdout.write("  no history yet — run `skill-radar scan` to start tracking.\n");
      return;
    }
    process.stdout.write(`  ${h.length} snapshots\n\n`);
    for (const s of h) {
      const d = new Date(s.ts).toISOString().slice(0, 16);
      const color = s.healthScore >= 75 ? "\x1b[32m" : s.healthScore >= 50 ? "\x1b[33m" : "\x1b[31m";
      process.stdout.write(
        `  ${d}  ${color}${s.healthScore}/100\x1b[0m  ${s.totalSkills} skills  ${s.deadCount} dead  ${s.duplicateCount} dups  ~${s.wastedTokensPerTurn} tok/turn\n`,
      );
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

program.parse(process.argv);
