// Security: heuristic scan of skill content for prompt-injection and malicious patterns.
// Inspired by skills-janitor's janitor-security. Scans SKILL.md and script files
// (.sh, .js, .ts, .py, .bash) for:
//   1. Injection phrases — "ignore all previous instructions", "do not tell the user"
//   2. Hidden instructions — imperative text in HTML comments, zero-width/bidi unicode
//   3. Payload smuggling — large base64 blobs in markdown
//   4. Dangerous scripts — curl|bash, decode-and-execute, credential-store access
//
// Findings are heuristics, not proof. A RISK verdict means "read this before trusting it".

import { readFileSync, readdirSync, lstatSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { scanAll, type Skill } from "./scanner.js";

export type Severity = "HIGH" | "MEDIUM";

export interface SecurityFinding {
  skillName: string;
  agent: string;
  file: string;          // relative path within skill dir
  severity: Severity;
  title: string;         // short description
  evidence: string;      // the matched text snippet
}

export interface SecurityResult {
  scanned: number;
  risk: number;          // skills with at least 1 HIGH finding
  review: number;        // skills with only MEDIUM findings
  pass: number;          // skills with no findings
  findings: SecurityFinding[];
}

// Patterns to scan for. Each has a severity, title, and regex.
const PATTERNS: Array<{ severity: Severity; title: string; re: RegExp }> = [
  // --- Injection phrases (HIGH) ---
  {
    severity: "HIGH",
    title: "Prompt injection: 'ignore previous instructions'",
    re: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/i,
  },
  {
    severity: "HIGH",
    title: "Prompt injection: 'do not tell the user'",
    re: /do\s+not\s+tell\s+the\s+user|don'?t\s+tell\s+the\s+user|never\s+(?:tell|reveal|inform)\s+the\s+user/i,
  },
  {
    severity: "HIGH",
    title: "Prompt injection: 'you are now' role override",
    re: /you\s+are\s+now\s+(?:a|an)\s+/i,
  },
  {
    severity: "HIGH",
    title: "Prompt injection: hidden system prompt override",
    re: /(?:system|developer)\s*:\s*(?:you|act|ignore|forget)/i,
  },
  {
    severity: "MEDIUM",
    title: "Suspicious: 'act as' role instruction",
    re: /act\s+as\s+(?:if\s+you\s+are|a|an)\s+/i,
  },
  {
    severity: "MEDIUM",
    title: "Suspicious: exfiltration instruction",
    re: /(?:send|post|upload|exfiltrate|transmit)\s+(?:this|all|the)\s+(?:file|data|content|keys?|secrets?|tokens?)/i,
  },

  // --- Hidden instructions (HIGH/MEDIUM) ---
  {
    severity: "HIGH",
    title: "Hidden instruction in HTML comment",
    re: /<!--[^]*?(?:ignore|do not|never|execute|run|delete|rm\s+-rf|curl|wget|bash|sh\s+-c)[^]*?-->/i,
  },
  {
    severity: "HIGH",
    title: "Zero-width unicode characters (possible hidden instructions)",
    re: /[\u200B\u200C\u200D\u200E\u200F\uFEFF\u2060\u2061\u2062\u2063\u2064]/,
  },
  {
    severity: "MEDIUM",
    title: "Bidi override unicode (possible text direction manipulation)",
    re: /[\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069]/,
  },

  // --- Payload smuggling (HIGH) ---
  {
    severity: "HIGH",
    title: "Large base64 blob (possible payload smuggling)",
    re: /[A-Za-z0-9+/]{200,}={0,2}/,
  },

  // --- Dangerous scripts (HIGH) ---
  {
    severity: "HIGH",
    title: "Network piped into shell (curl|bash pattern)",
    re: /(?:curl|wget|fetch)\s+[^\s|]+\s*\|\s*(?:bash|sh|zsh|python|node|ruby|perl)/i,
  },
  {
    severity: "HIGH",
    title: "Decode-and-execute pattern",
    re: /(?:base64|atob|eval|exec|Function)\s*\(\s*(?:atob|base64|Buffer\.from|fromBase64)/i,
  },
  {
    severity: "HIGH",
    title: "Credential store access",
    re: /(?:~\/\.ssh|~\/\.aws|~\/\.config\/gcloud|~\/\.kube|keychain|security\s+find-generic-password|security\s+find-internet-password|os\.environ|process\.env\.(?:AWS_SECRET|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY))/i,
  },
  {
    severity: "MEDIUM",
    title: "URL shortener usage (possible obfuscation)",
    re: /(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly)/i,
  },
  {
    severity: "MEDIUM",
    title: "Plain HTTP call (no TLS)",
    re: /http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)/i,
  },
  {
    severity: "MEDIUM",
    title: "Data exfiltration via curl/wget",
    re: /(?:curl|wget)\s+(?:--data|--data-raw|-d|--upload-file|-T)\s+/i,
  },
];

const SCRIPT_EXTENSIONS = new Set([".sh", ".js", ".ts", ".py", ".bash", ".zsh", ".rb", ".pl"]);
const MAX_FILE_SIZE = 1024 * 1024; // 1MB — skip larger files
const MAX_FILES_PER_SKILL = 200;

function scanFile(filePath: string, skillName: string, agent: string, relPath: string): SecurityFinding[] {
  let content: string;
  try {
    const st = lstatSync(filePath);
    if (!st.isFile()) return [];
    if (st.size > MAX_FILE_SIZE) return [];
    content = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const findings: SecurityFinding[] = [];
  for (const { severity, title, re } of PATTERNS) {
    const match = content.match(re);
    if (match) {
      // Extract context around the match (up to 80 chars each side)
      const idx = match.index ?? 0;
      const start = Math.max(0, idx - 80);
      const end = Math.min(content.length, idx + match[0].length + 80);
      let evidence = content.slice(start, end).replace(/\n/g, "\\n").trim();
      if (start > 0) evidence = "…" + evidence;
      if (end < content.length) evidence = evidence + "…";
      findings.push({
        skillName,
        agent,
        file: relPath,
        severity,
        title,
        evidence,
      });
    }
  }
  return findings;
}

function scanSkillDir(skillPath: string, skillName: string, agent: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  let fileCount = 0;

  function walk(dir: string) {
    if (fileCount >= MAX_FILES_PER_SKILL) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (fileCount >= MAX_FILES_PER_SKILL) return;
      if (name.startsWith(".") && name !== ".env") continue;
      const fullPath = join(dir, name);
      let st;
      try {
        st = lstatSync(fullPath);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue; // don't follow symlinks
      if (st.isDirectory()) {
        walk(fullPath);
      } else if (st.isFile()) {
        fileCount++;
        const ext = extname(name).toLowerCase();
        const isMarkdown = name.endsWith(".md") || name.endsWith(".markdown");
        const isScript = SCRIPT_EXTENSIONS.has(ext);
        // Always scan SKILL.md, other markdown, and script files
        if (name === "SKILL.md" || isMarkdown || isScript) {
          const relPath = relative(skillPath, fullPath);
          findings.push(...scanFile(fullPath, skillName, agent, relPath));
        }
      }
    }
  }

  walk(skillPath);
  return findings;
}

export function scanSecurity(customPath?: string): SecurityResult {
  const findings: SecurityFinding[] = [];
  let scanned = 0;

  if (customPath) {
    // Scan a single directory
    if (!existsSync(customPath)) {
      return { scanned: 0, risk: 0, review: 0, pass: 0, findings: [] };
    }
    scanned = 1;
    const name = customPath.split("/").pop() || "unknown";
    findings.push(...scanSkillDir(customPath, name, "custom"));
  } else {
    // Scan all installed skills
    const { skills } = scanAll();
    const seen = new Set<string>();
    for (const s of skills) {
      if (!s.hasSkillMd) continue;
      // Scan each unique real path once (don't re-scan symlink targets)
      if (seen.has(s.realPath)) continue;
      seen.add(s.realPath);
      scanned++;
      findings.push(...scanSkillDir(s.skillPath, s.name, s.agent));
    }
  }

  // Compute per-skill verdicts
  const skillFindings = new Map<string, SecurityFinding[]>();
  for (const f of findings) {
    const key = `${f.agent}/${f.skillName}`;
    const arr = skillFindings.get(key) || [];
    arr.push(f);
    skillFindings.set(key, arr);
  }

  let risk = 0, review = 0, pass = 0;
  if (customPath) {
    // Single skill — check its findings
    const hasHigh = findings.some((f) => f.severity === "HIGH");
    if (findings.length === 0) pass = 1;
    else if (hasHigh) risk = 1;
    else review = 1;
  } else {
    // Multiple skills — need to count per-skill
    const { skills } = scanAll();
    const seen = new Set<string>();
    for (const s of skills) {
      if (!s.hasSkillMd) continue;
      if (seen.has(s.realPath)) continue;
      seen.add(s.realPath);
      const key = `${s.agent}/${s.name}`;
      const sf = skillFindings.get(key) || [];
      if (sf.length === 0) pass++;
      else if (sf.some((f) => f.severity === "HIGH")) risk++;
      else review++;
    }
  }

  return { scanned, risk, review, pass, findings };
}
