// TUI: ink-based list view. No swipe (too slow). Instead:
//   ↑/↓ k/j  move cursor (vim-style too)
//   PgUp/PgDn / u  scroll a page
//   g / G     jump to top / bottom
//   i         inspect full description of cursor row (toggle)
//   d        delete ALL copies of cursor skill across every agent (with confirm)
//   D        delete ALL dead skills + all their copies (the big win — one keystroke)
//   space    toggle mark
//   x        delete all marked
//   /        search/filter by name or description (Esc to clear)
//   r        re-scan (score jumps live — the pleasure loop)
//   s        toggle security view (prompt injection & malicious patterns)
//   q        quit
// The header shows health score + wasted tokens, updating after each delete.
// The list is windowed (PAGE_SIZE rows visible) with a scroll indicator so all
// skills are reachable — no "…more" dead end. The cursor row expands to show
// a short description inline; press `i` for the full description + metadata.

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { rmSync, lstatSync, unlinkSync } from "node:fs";
import { buildReport, type Report } from "./report.js";
import { scanAll } from "./scanner.js";
import { renderSummary, renderScoreTable } from "./render.js";
import { backupSkills, pruneBackups } from "./backup.js";
import { scanSecurity, type SecurityFinding, type SecurityResult } from "./security.js";

// Visible rows in the list window. Terminal height varies; 20 is a safe default
// that leaves room for the header, trend, stat row, column header, and footer.
const PAGE_SIZE = 20;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

interface Row {
  name: string;
  agent: string;
  waste: number;
  used: string;
  verdict: string;
  deletable: boolean;
  isDead: boolean;
  isDup: boolean;
  path: string;
  description: string;
}

function toRows(r: Report): Row[] {
  return r.health.scores.map((s) => ({
    name: s.skill.name,
    agent: s.skill.agent,
    waste: s.wasteScore,
    used: s.lastUsedLabel,
    verdict: s.verdict,
    deletable: s.deletable,
    isDead: s.isDead,
    isDup: s.isDuplicate,
    path: s.skill.skillPath,
    description: s.skill.description || "",
  }));
}

const App: React.FC = () => {
  const [report, setReport] = useState<Report | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(0); // first visible row index (windowing)
  const [marked, setMarked] = useState<Set<number>>(new Set());
  const [msg, setMsg] = useState<string>("");
  const [confirm, setConfirm] = useState<null | "current" | "dead" | "marked">(null);
  const [inspect, setInspect] = useState(false); // 'i' toggles full-description view
  const [search, setSearch] = useState(""); // search query string
  const [searchMode, setSearchMode] = useState(false); // when true, typing builds search query
  const [secView, setSecView] = useState(false); // 's' toggles security findings view
  const [secResult, setSecResult] = useState<SecurityResult | null>(null);
  const { exit } = useApp();

  const refresh = useCallback(() => {
    const r = buildReport(false);
    setReport(r);
    setRows(toRows(r));
    setCursor(0);
    setOffset(0);
    setMarked(new Set());
    setMsg(`scanned ${r.health.totalSkills} skills`);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Filtered rows for search. useMemo so useInput closure sees current value.
  const displayRows = useMemo(() => {
    if (!search) return rows;
    const q = search.toLowerCase();
    return rows.filter((r) =>
      r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q),
    );
  }, [rows, search]);

  useInput((input, key) => {
    // Search mode: type to filter, Esc/Enter to exit search mode, backspace to delete
    if (searchMode) {
      if (key.escape) {
        setSearchMode(false);
        setSearch("");
        setCursor(0);
        setOffset(0);
        setMsg("");
        return;
      }
      if (key.return) {
        setSearchMode(false);
        setCursor(0);
        setOffset(0);
        setMsg(search ? `${displayRows.length} matches for "${search}"` : "");
        return;
      }
      if (key.backspace || key.delete) {
        setSearch((s) => s.slice(0, -1));
        setCursor(0);
        setOffset(0);
        return;
      }
      if (input && !key.ctrl && !key.meta && input.length === 1 && input !== "/") {
        setSearch((s) => s + input);
        setCursor(0);
        setOffset(0);
        return;
      }
      return;
    }

    if (confirm) {
      if (input === "y" || input === "Y") {
        // CRITICAL: scan fresh RAW (not deduped scores) so we catch EVERY copy
        // — real dirs AND symlinks AND broken symlinks. `rows` comes from
        // health.scores which dedupes by realPath, so it only has 1 entry per
        // real skill and misses symlink copies. That was the bug: `d` deleted
        // the real dir, symlinks became broken zombies, user saw "still there".
        const rawSkills = scanAll().skills;
        const targetNames = new Set<string>();
        if (confirm === "current") {
          const name = displayRows[cursor]?.name;
          if (name) targetNames.add(name);
        } else if (confirm === "dead") {
          displayRows.filter((x) => x.isDead).forEach((x) => targetNames.add(x.name));
        } else if (confirm === "marked") {
          [...marked].map((i) => displayRows[i]?.name).filter(Boolean).forEach((n) => targetNames.add(n as string));
        }
        // Every raw skill entry whose name matches — across all agent roots.
        const toDelete = rawSkills.filter((s) => targetNames.has(s.name));

        // BACKUP before deleting: only skills with real content (hasSkillMd).
        // Broken symlinks and empty dirs don't need backup. This matches
        // the `autofix` / `clean --backup` behavior — safe by default.
        const toBackup = toDelete.filter((s) => s.hasSkillMd);
        let backupDir = "";
        if (toBackup.length > 0) {
          const bk = backupSkills(toBackup);
          pruneBackups(10);
          backupDir = bk.backupDir;
        }

        const deletedNames: string[] = [];
        const deletedAgents: string[] = [];
        const skipped: string[] = [];
        let n = 0;
        let unlinked = 0;
        for (const s of toDelete) {
          try {
            // Symlink → unlink (removes the link, NOT the target).
            // Real dir → rmSync recursive. Broken symlink → unlink.
            const st = lstatSync(s.skillPath);
            if (st.isSymbolicLink()) {
              unlinkSync(s.skillPath);
              unlinked++;
            } else {
              rmSync(s.skillPath, { recursive: true, force: true });
            }
            n++;
            if (!deletedNames.includes(s.name)) deletedNames.push(s.name);
            if (!deletedAgents.includes(s.agent)) deletedAgents.push(s.agent);
          } catch (e) {
            setMsg(`failed: ${s.name} — ${(e as Error).message}`);
          }
        }
        setConfirm(null);
        setMarked(new Set());
        if (n > 0) {
          const before = report?.health.totalSkills ?? 0;
          // re-scan immediately so the score jumps (pleasure loop)
          setTimeout(() => {
            const r = buildReport(false);
            setReport(r);
            setRows(toRows(r));
            setCursor(0);
            setOffset(0);
            setMarked(new Set());
            const after = r.health.totalSkills;
            const names = deletedNames.length <= 3
              ? deletedNames.join(", ")
              : `${deletedNames.slice(0, 3).join(", ")} +${deletedNames.length - 3} more`;
            const agents = deletedAgents.length <= 4
              ? deletedAgents.join("/")
              : `${deletedAgents.slice(0, 4).join("/")}+${deletedAgents.length - 4}`;
            const skipNote = skipped.length > 0 ? ` · skipped ${skipped.length} non-deletable` : "";
            const unlinkNote = unlinked > 0 ? ` · ${unlinked} symlink${unlinked > 1 ? "s" : ""} unlinked` : "";
            const backupNote = backupDir ? ` · backed up` : "";
            const copyWord = n === 1 ? "copy" : "copies";
            const skillWord = deletedNames.length === 1 ? "skill" : "skills";
            setMsg(`deleted ${n} ${copyWord} of ${deletedNames.length} ${skillWord} across ${agents} — ${before}→${after} skills${unlinkNote}${skipNote}${backupNote}`);
          }, 50);
        } else {
          setMsg(skipped.length > 0
            ? `nothing deleted — ${skipped.length} skill(s) non-deletable`
            : "nothing deletable in selection");
        }
        return;
      }
      if (input === "n" || input === "N" || key.escape) {
        setConfirm(null);
        setMsg("cancelled");
        return;
      }
      return;
    }

    // Navigation. We keep the cursor inside the visible window by adjusting
    // `offset` whenever the cursor would leave [offset, offset+PAGE_SIZE).
    const moveCursor = (next: number) => {
      const clamped = Math.max(0, Math.min(displayRows.length - 1, next));
      setCursor(clamped);
      // Scroll window if cursor escapes it.
      setOffset((o) => {
        if (clamped < o) return clamped;
        if (clamped >= o + PAGE_SIZE) return clamped - PAGE_SIZE + 1;
        return o;
      });
    };

    if (key.upArrow || input === "k") {
      moveCursor(cursor - 1);
      return;
    }
    if (key.downArrow || input === "j") {
      moveCursor(cursor + 1);
      return;
    }
    if (key.pageUp || input === "u") {
      moveCursor(cursor - PAGE_SIZE);
      return;
    }
    if (key.pageDown) {
      moveCursor(cursor + PAGE_SIZE);
      return;
    }
    if (input === "g") {
      moveCursor(0);
      return;
    }
    if (input === "G") {
      moveCursor(rows.length - 1);
      return;
    }
    if (input === "i") {
      setInspect((v) => !v);
      return;
    }
    if (input === "q" || (input === "c" && key.ctrl)) {
      exit();
      return;
    }
    if (input === "/") {
      setSearchMode(true);
      setSearch("");
      setMsg("search: (type to filter, Esc to clear)");
      return;
    }
    if (input === "r") {
      refresh();
      return;
    }
    if (input === "s") {
      if (secView) {
        setSecView(false);
        setSecResult(null);
        setMsg("");
      } else {
        setMsg("scanning for security issues…");
        const sr = scanSecurity();
        setSecResult(sr);
        setSecView(true);
        setInspect(false);
        setMsg(`security: ${sr.risk} risk · ${sr.review} review · ${sr.pass} clean`);
      }
      return;
    }
    if (input === "d") {
      const row = displayRows[cursor];
      if (!row) return;
      if (!row.deletable) {
        setMsg(`not deletable (no SKILL.md and not a symlink)`);
        return;
      }
      // If this is a dead skill, hint that D would nuke all dead at once.
      const deadCount = displayRows.filter((x) => x.isDead && x.deletable).length;
      if (row.isDead && deadCount > 1) {
        setConfirm("current");
        setMsg(`tip: press D to delete all ${deadCount} dead skills at once`);
      } else {
        setConfirm("current");
      }
      return;
    }
    if (input === "D") {
      const dead = displayRows.filter((x) => x.isDead && x.deletable);
      if (dead.length === 0) {
        setMsg("no dead deletable skills");
        return;
      }
      setConfirm("dead");
      return;
    }
    if (input === " ") {
      setMarked((m) => {
        const next = new Set(m);
        if (next.has(cursor)) next.delete(cursor);
        else next.add(cursor);
        return next;
      });
      return;
    }
    if (input === "x") {
      if (marked.size === 0) {
        setMsg("nothing marked (press space to mark)");
        return;
      }
      setConfirm("marked");
      return;
    }
  });

  if (!report) {
    return <Text color="cyan">scanning…</Text>;
  }

  const h = report.health;
  const healthColor = h.healthScore >= 75 ? "green" : h.healthScore >= 50 ? "yellow" : "red";

  return (
    <Box flexDirection="column">
      {/* Headline: health + waste + trend */}
      <Box>
        <Text>
          <Text color={healthColor} bold>  Health {h.healthScore}/100</Text>
          <Text dimColor>   </Text>
          <Text color="red" bold>~{h.wastedTokensPerTurn} tokens/turn wasted</Text>
        </Text>
      </Box>
      {report.trend && (
        <Box>
          <Text dimColor>
            {"  vs last: "}
            health {report.trend.healthDelta > 0 ? "↑" : report.trend.healthDelta < 0 ? "↓" : "→"}
            {Math.abs(report.trend.healthDelta)}   waste{" "}
            {report.trend.wastedDelta > 0 ? "↓" : report.trend.wastedDelta < 0 ? "↑" : "→"}
            {Math.abs(report.trend.wastedDelta)}   dead{" "}
            {report.trend.deadDelta > 0 ? "↓" : report.trend.deadDelta < 0 ? "↑" : "→"}
            {Math.abs(report.trend.deadDelta)}
          </Text>
        </Box>
      )}
      <Box>
        <Text dimColor>
          {"  "}
          {h.totalSkills} skills · {h.deadCount} dead · {h.duplicateCount} dups · {h.brokenCount} broken
          {secResult && secResult.findings.length > 0 && (
            <Text color="red"> · {secResult.findings.length} security findings</Text>
          )}
        </Text>
      </Box>

      {secView && secResult ? (
        // Security view: list all findings grouped by skill.
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text bold color="red">  Security findings</Text>
            <Text dimColor> — {secResult.scanned} scanned · </Text>
            <Text color="red" bold>{secResult.risk} risk</Text>
            <Text dimColor> · </Text>
            <Text color="yellow" bold>{secResult.review} review</Text>
            <Text dimColor> · </Text>
            <Text color="green" bold>{secResult.pass} clean</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>  press s to return to skill list · q to quit</Text>
          </Box>
          {secResult.findings.length === 0 ? (
            <Box marginTop={1}>
              <Text color="green">  No security issues found. All {secResult.scanned} skills clean.</Text>
            </Box>
          ) : (
            <Box flexDirection="column" marginTop={1}>
              {secResult.findings.slice(0, PAGE_SIZE + 5).map((f, i) => (
                <Box key={i} flexDirection="column">
                  <Box>
                    <Text color={f.severity === "HIGH" ? "red" : "yellow"} bold>
                      {"  "}{f.severity === "HIGH" ? "RISK" : "REVIEW"}{" "}
                    </Text>
                    <Text color="cyan" bold>{f.skillName}</Text>
                    <Text dimColor>  ({f.agent})  {f.file}</Text>
                  </Box>
                  <Box>
                    <Text dimColor>    {f.title}</Text>
                  </Box>
                  <Box>
                    <Text color="gray">    {truncate(f.evidence, 76)}</Text>
                  </Box>
                </Box>
              ))}
              {secResult.findings.length > PAGE_SIZE + 5 && (
                <Box>
                  <Text dimColor>  …and {secResult.findings.length - (PAGE_SIZE + 5)} more. Run `skill-radar security` for full list.</Text>
                </Box>
              )}
            </Box>
          )}
        </Box>
      ) : inspect && displayRows[cursor] ? (
        // Inspect mode: full description + metadata for the cursor row.
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text bold color="cyan">  {displayRows[cursor].name}</Text>
            <Text dimColor>  ({displayRows[cursor].agent})</Text>
          </Box>
          <Box>
            <Text dimColor>  path: </Text>
            <Text>{displayRows[cursor].path}</Text>
          </Box>
          <Box>
            <Text dimColor>  waste: </Text>
            <Text color={displayRows[cursor].waste >= 60 ? "red" : displayRows[cursor].waste >= 30 ? "yellow" : "green"}>
              {displayRows[cursor].waste}
            </Text>
            <Text dimColor>  · used: {displayRows[cursor].used}  · verdict: {displayRows[cursor].verdict}</Text>
          </Box>
          <Box marginTop={1}>
            <Text>  {displayRows[cursor].description || "(no description)"}</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>  press i to return to list · d to delete · q to quit</Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          {displayRows.slice(offset, offset + PAGE_SIZE).map((row, vi) => {
            const i = offset + vi; // absolute index
            const isCur = i === cursor;
            const isMarked = marked.has(i);
            const wasteColor = row.waste >= 60 ? "red" : row.waste >= 30 ? "yellow" : "green";
            const nameColor = row.isDead ? "red" : row.isDup ? "magenta" : isCur ? "cyan" : "white";
            const prefix = isMarked ? "● " : isCur ? "▸ " : "  ";
            const name = row.name.length > 33 ? row.name.slice(0, 32) + "…" : row.name;
            return (
              <Box key={`${row.name}-${i}`} flexDirection="column">
                <Box>
                  <Text>
                    <Text color={isMarked ? "green" : isCur ? "cyan" : "gray"}>{prefix}</Text>
                    <Text color={nameColor} bold={isCur}>{name.padEnd(34)}</Text>
                    <Text color={wasteColor}>{String(row.waste).padStart(3)}</Text>
                    <Text dimColor>   {row.used.padEnd(9)} </Text>
                    <Text color={row.isDead ? "red" : row.isDup ? "magenta" : "gray"}>
                      {row.verdict}
                    </Text>
                  </Text>
                </Box>
                {/* Expand-on-cursor: short description under the focused row. */}
                {isCur && row.description && (
                  <Box>
                    <Text dimColor>      {truncate(row.description, 80)}</Text>
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      {/* Scroll indicator — hidden in inspect mode. */}
      {!inspect && displayRows.length > PAGE_SIZE && (
        <Box>
          <Text dimColor>
            {"  "}
            {offset + 1}-{Math.min(offset + PAGE_SIZE, displayRows.length)} of {displayRows.length}
            {search ? ` (filtered from ${rows.length})` : ""}{" "}
            {offset > 0 ? "↑" : " "} {offset + PAGE_SIZE < displayRows.length ? "↓" : " "}
            {cursor + 1 !== offset + 1 && offset + PAGE_SIZE !== cursor + 1 ? `· cursor #${cursor + 1}` : ""}
          </Text>
        </Box>
      )}

      {/* Search input line — visible when in search mode or when search is active. */}
      {(searchMode || search) && (
        <Box>
          <Text dimColor>
            {"  "}
            {searchMode ? "search: " : "filter: "}
            <Text color="cyan">{search}</Text>
            {searchMode ? "_" : ""}
            <Text dimColor> ({displayRows.length} matches)</Text>
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {confirm
            ? (() => {
                // Count REAL copies (including symlinks) via fresh scan, not
                // the deduped rows — so the confirm prompt is accurate.
                const raw = scanAll().skills;
                if (confirm === "dead") {
                  const deadNames = new Set(displayRows.filter((x) => x.isDead).map((x) => x.name));
                  const copies = raw.filter((s) => deadNames.has(s.name));
                  const agents = [...new Set(copies.map((s) => s.agent))];
                  return `  DELETE ${deadNames.size} dead skill${deadNames.size > 1 ? "s" : ""} (${copies.length} copies: ${agents.join("/")}) — backed up first? y/n`;
                }
                if (confirm === "marked") {
                  const markedNames = new Set([...marked].map((i) => displayRows[i]?.name).filter(Boolean));
                  const copies = raw.filter((s) => markedNames.has(s.name));
                  const agents = [...new Set(copies.map((s) => s.agent))];
                  return `  DELETE ${markedNames.size} skill${markedNames.size > 1 ? "s" : ""} (${copies.length} copies: ${agents.join("/")}) — backed up first? y/n`;
                }
                const name = displayRows[cursor]?.name;
                const copies = raw.filter((s) => s.name === name);
                const agents = [...new Set(copies.map((s) => s.agent))];
                return copies.length > 1
                  ? `  DELETE "${name}" (${copies.length} copies: ${agents.join("/")}) — backed up first? y/n`
                  : `  DELETE "${name}" — backed up first? y/n`;
              })()
            : `  ↑↓/jk move · d delete · D DELETE ALL DEAD · i inspect · s security · / search · r rescan · q quit`}
        </Text>
      </Box>
      {msg && (
        <Box>
          <Text color="cyan">  {msg}</Text>
        </Box>
      )}
    </Box>
  );
};

export function runTui(): void {
  render(React.createElement(App));
}
