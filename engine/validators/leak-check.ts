#!/usr/bin/env bun
/**
 * leak-check.ts — Scan content for credentials and operator-defined confidential terms.
 *
 * Usage:
 *   bun engine/validators/leak-check.ts <path...> [--patterns <file>] [--require-patterns]
 *   bun engine/validators/leak-check.ts --staged  [--patterns <file>] [--require-patterns]
 *
 *   <path...>            Files or directories to scan (directories are walked recursively).
 *   --staged             Scan the *staged blobs* of the current git repo instead of paths.
 *   --patterns <file>    Operator pattern file. Overrides CONFIDENTIALITY_DENYLIST.
 *   --require-patterns   Treat a missing/unreadable pattern file as an error instead of a warning.
 *
 * Pattern file format: one regular expression per line; `#` comments and blank
 * lines are ignored; patterns are matched case-insensitively, one line of input
 * at a time.
 *
 * Two tiers of rules:
 *   1. Built-ins — generic credential shapes that are wrong in any repo (see RULES).
 *   2. Operator patterns — loaded from the file named by `--patterns` or the
 *      `CONFIDENTIALITY_DENYLIST` env var. This is the public-hook/private-patterns
 *      split: the guard is shared, the sensitive strings never are.
 *
 * NEVER-ECHO RULE (sops/confidentiality-gate.md §0): this scanner reports
 * `file:line: rule-name` and nothing else. It never prints the matched text, the
 * surrounding line, or the operator pattern that fired — an operator pattern is
 * itself confidential, so operator findings are reported by index (`denylist[3]`)
 * only. Do not add a "context" or "--verbose" mode that breaks this; the tool's
 * output goes into CI logs, PR comments, and hook output that anyone can read.
 *
 * Exit codes: 0 = clean, 1 = findings, 2 = usage/configuration error.
 */

import { parseArgs } from "node:util";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const EXIT_CLEAN = 0;
const EXIT_FINDINGS = 1;
const EXIT_USAGE = 2;

const USAGE =
  "Usage: bun engine/validators/leak-check.ts <path...> | --staged [--patterns <file>] [--require-patterns]";

/** Directories never worth scanning — noise, and huge. */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "vendor", "coverage"]);

/** Files above this size are skipped with a visible notice (never silently). */
const MAX_BYTES = 5 * 1024 * 1024;

interface Rule {
  name: string;
  re: RegExp;
  /** Optional second-stage check; receives the match. Return false to drop it. */
  accept?: (m: RegExpExecArray) => boolean;
}

/**
 * Built-in ruleset — deliberately small and shape-based. These are the leaks that
 * are wrong in *any* repository; anything organisation-specific belongs in the
 * operator pattern file, never here (this file is public).
 */
const RULES: Rule[] = [
  {
    name: "private-key-header",
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/,
  },
  {
    name: "anthropic-api-key",
    re: /sk-ant-[A-Za-z0-9_-]{16,}/,
  },
  {
    name: "github-token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{28,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  },
  {
    name: "aws-access-key-id",
    re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b/,
  },
  {
    name: "slack-token",
    re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  },
  {
    name: "credential-assignment",
    // key = value / key: value, where key names a credential and value is not a
    // placeholder or an environment/CI expression.
    re: /\b(?:pass(?:word|wd)|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token)\b\s*[:=]\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'#,;]+))/i,
    accept: (m) => !isPlaceholder(m[1] ?? m[2] ?? m[3] ?? ""),
  },
];

/**
 * Values that name a credential without being one. Keeping this list tight
 * matters in both directions: too loose and a real secret slips through the
 * `credential-assignment` rule, too tight and the rule cries wolf until someone
 * deletes the hook.
 */
const PLACEHOLDER =
  /^(?:x+|\*+|\.+|-+|_+|change[-_ ]?me|redacted|placeholder|unset|example|dummy|fake|test|todo|tbd|none|null|nil|true|false|undefined|empty|your[-_a-z0-9]*|sample[-_a-z0-9]*|my[-_a-z0-9]*|secret|password|token)$/i;

function isPlaceholder(value: string): boolean {
  const v = value.trim();
  if (v.length < 8) return true; // too short to be a credential worth blocking
  // Environment / CI / template indirection: `$VAR`, `${VAR}`, `${{ secrets.X }}`,
  // `<your-key>`, `{{ config }}`, `process.env.X`, `os.environ[...]`.
  if (/^[$<{[]/.test(v)) return true;
  if (/\$\{|\{\{|process\.env|os\.environ|secrets\./i.test(v)) return true;
  if (PLACEHOLDER.test(v)) return true;
  return false;
}

interface Finding {
  display: string;
  line: number;
  rule: string;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

let values: { staged?: boolean; patterns?: string; "require-patterns"?: boolean };
let positionals: string[];
try {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      staged: { type: "boolean" },
      patterns: { type: "string" },
      "require-patterns": { type: "boolean" },
    },
  });
  values = parsed.values;
  positionals = parsed.positionals;
} catch (err) {
  console.error(`leak-check: ${(err as Error).message}`);
  console.error(USAGE);
  process.exit(EXIT_USAGE);
}

if (!values.staged && positionals.length === 0) {
  console.error("leak-check: nothing to scan — pass one or more paths, or --staged.");
  console.error(USAGE);
  process.exit(EXIT_USAGE);
}

// ---------------------------------------------------------------------------
// Operator patterns
// ---------------------------------------------------------------------------

const envPatterns = (process.env.CONFIDENTIALITY_DENYLIST ?? "").trim();
const patternsPath = values.patterns ?? (envPatterns.length > 0 ? envPatterns : undefined);

const operatorRules: Rule[] = [];

if (patternsPath && existsSync(patternsPath) && statSync(patternsPath).isFile()) {
  const raw = readFileSync(patternsPath, "utf8").split(/\r?\n/);
  let index = 0;
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i]!.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    index++;
    try {
      // Case-insensitive: a confidential term is confidential in any casing.
      operatorRules.push({ name: `denylist[${index}]`, re: new RegExp(line, "i") });
    } catch {
      // Fail closed, and never echo the pattern — it may itself be the secret.
      console.error(
        `leak-check: pattern file ${patternsPath} line ${i + 1} is not a valid regular expression (pattern withheld).`,
      );
      process.exit(EXIT_USAGE);
    }
  }
} else if (patternsPath) {
  const message = `leak-check: pattern file not found or unreadable (${patternsPath}) — built-in rules only.`;
  if (values["require-patterns"]) {
    console.error(message.replace("built-in rules only.", "--require-patterns is set, refusing to run degraded."));
    process.exit(EXIT_USAGE);
  }
  console.error(message);
} else if (values["require-patterns"]) {
  console.error(
    "leak-check: --require-patterns is set but no pattern file was given (--patterns or CONFIDENTIALITY_DENYLIST).",
  );
  process.exit(EXIT_USAGE);
} else {
  console.error(
    "leak-check: CONFIDENTIALITY_DENYLIST is unset and no --patterns given — built-in rules only.",
  );
}

const allRules = [...RULES, ...operatorRules];

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/** A unit of content to scan: what to read, and what to call it in a report. */
interface Target {
  display: string;
  text: string;
}

function looksBinary(buf: Buffer): boolean {
  const window = buf.subarray(0, 8000);
  return window.includes(0);
}

function collectFiles(path: string, out: string[]): void {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      collectFiles(join(path, entry.name), out);
    }
    return;
  }
  if (st.isFile()) out.push(path);
}

function readTarget(path: string, display: string): Target | null {
  const st = statSync(path);
  if (st.size > MAX_BYTES) {
    console.error(`leak-check: skipped ${display} — larger than ${MAX_BYTES} bytes, not scanned.`);
    return null;
  }
  const buf = readFileSync(path);
  if (looksBinary(buf)) return null;
  return { display, text: buf.toString("utf8") };
}

function git(args: string[], cwd?: string) {
  const proc = Bun.spawnSync(["git", ...args], cwd ? { cwd } : {});
  return {
    ok: (proc.exitCode ?? 1) === 0,
    stdout: proc.stdout,
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

function stagedTargets(): Target[] {
  const top = git(["rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    console.error("leak-check: --staged requires a git repository (git rev-parse --show-toplevel failed).");
    process.exit(EXIT_USAGE);
  }
  const root = new TextDecoder().decode(top.stdout).trim();

  const list = git(["diff", "--cached", "--name-only", "--diff-filter=ACM", "-z"], root);
  if (!list.ok) {
    console.error(`leak-check: could not list staged files: ${list.stderr.trim()}`);
    process.exit(EXIT_USAGE);
  }
  const names = new TextDecoder()
    .decode(list.stdout)
    .split("\0")
    .filter((n) => n.length > 0);

  const targets: Target[] = [];
  for (const name of names) {
    // Read the STAGED blob, not the working-tree file — they can differ, and it
    // is the staged content that is about to be committed.
    const blob = git(["show", `:${name}`], root);
    if (!blob.ok) continue; // deleted or unreadable in the index — nothing to scan
    const buf = Buffer.from(blob.stdout);
    if (buf.length > MAX_BYTES) {
      console.error(`leak-check: skipped ${name} — larger than ${MAX_BYTES} bytes, not scanned.`);
      continue;
    }
    if (looksBinary(buf)) continue;
    targets.push({ display: name, text: buf.toString("utf8") });
  }
  return targets;
}

function pathTargets(paths: string[]): Target[] {
  const resolvedPatterns = patternsPath ? resolve(patternsPath) : null;
  const files: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) {
      console.error(`leak-check: path not found: ${p}`);
      process.exit(EXIT_USAGE);
    }
    collectFiles(p, files);
  }
  const targets: Target[] = [];
  for (const file of files) {
    // The pattern file legitimately contains every term it defends; scanning it
    // would produce a finding for each one.
    if (resolvedPatterns && resolve(file) === resolvedPatterns) continue;
    const rel = relative(process.cwd(), file);
    const target = readTarget(file, rel.startsWith("..") ? file : rel);
    if (target) targets.push(target);
  }
  return targets;
}

const targets = values.staged ? stagedTargets() : pathTargets(positionals);

const findings: Finding[] = [];
for (const target of targets) {
  const lines = target.text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    for (const rule of allRules) {
      // Fresh exec per line; no /g state to carry between lines.
      const m = rule.re.exec(line);
      if (!m) continue;
      if (rule.accept && !rule.accept(m)) continue;
      findings.push({ display: target.display, line: i + 1, rule: rule.name });
    }
  }
}

// ---------------------------------------------------------------------------
// Report — locations and rule names only, never content.
// ---------------------------------------------------------------------------

const ruleSummary = `${RULES.length} built-in rule(s) + ${operatorRules.length} operator pattern(s)`;

if (findings.length === 0) {
  console.log(`leak-check: clean — ${targets.length} file(s) scanned, ${ruleSummary} active.`);
  process.exit(EXIT_CLEAN);
}

const files = new Set(findings.map((f) => f.display));
for (const f of findings) {
  console.error(`${f.display}:${f.line}: ${f.rule}`);
}
console.error(
  `\nleak-check: ${findings.length} finding(s) in ${files.size} file(s) — matched content withheld by design.`,
);
console.error(`Scanned ${targets.length} file(s) with ${ruleSummary}.`);
console.error("Open each location yourself. Do not paste the matched text into a PR, an issue, or a chat.");
process.exit(EXIT_FINDINGS);
