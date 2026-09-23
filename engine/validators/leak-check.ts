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
 *   --patterns <file>    Operator pattern file. Overrides CONFIDENTIALITY_DENYLIST_FILE.
 *   --require-patterns   Treat a missing/unreadable pattern file as an error instead of a warning.
 *
 * Pattern file format: one regular expression per line; `#` comments and blank
 * lines are ignored; patterns are matched case-insensitively, one line of input
 * at a time.
 *
 * Two tiers of rules:
 *   1. Built-ins — generic credential shapes that are wrong in any repo (see RULES).
 *   2. Operator patterns — loaded from the file named by `--patterns` or the
 *      `CONFIDENTIALITY_DENYLIST_FILE` env var. This is the public-hook/private-patterns
 *      split: the guard is shared, the sensitive strings never are.
 *
 * WHY THE ENV VAR ENDS IN _FILE (it was renamed, deliberately):
 * it used to be `CONFIDENTIALITY_DENYLIST`, the same name
 * sops/confidentiality-gate.md (§0, §2) gives an org CI secret carrying the
 * HASHED denylist payload consumed by a gate engine with a separate pepper
 * secret. This repo implements only the SOP's PLAINTEXT "local gate" tier, so
 * the value here is a FILE PATH, not a payload. Sharing one name across two
 * contracts was not a naming wart but a fail-open: a SOP-shaped hashed payload
 * fed to the old name produced "pattern file not found", a warning, and exit 0
 * — green on precisely the terms the operator meant to guard. The SOP keeps
 * `CONFIDENTIALITY_DENYLIST` for its payload; this scanner reads
 * `CONFIDENTIALITY_DENYLIST_FILE`, and the suffix states what the value is.
 *
 * Residual, and NOT fixed by the rename: a *readable* file whose contents are
 * hashes still loads happily — every line is a valid regex that matches
 * nothing. `--require-patterns` catches an absent or unreadable file, not a
 * well-formed file of the wrong kind. Verifying payload shape is a job for the
 * hashed tier this repo does not implement.
 *
 * NEVER-ECHO RULE (sops/confidentiality-gate.md §0): this scanner reports
 * `file:line: rule-name` and nothing else. It never prints the matched text, the
 * surrounding line, or the operator pattern that fired — an operator pattern is
 * itself confidential, so operator findings are reported by index (`denylist[3]`)
 * only. Do not add a "context" or "--verbose" mode that breaks this; the tool's
 * output goes into CI logs, PR comments, and hook output that anyone can read.
 *
 * WHAT THE WALK DOES NOT LOOK AT, and why it says so out loud:
 * a symlink met while walking a directory is NOT followed — a symlinked cycle
 * would hang the walk and a symlinked tree would report the same finding under
 * two paths. The count is printed in the summary, because an uncounted skip is
 * a hiding place. A symlink named directly on the command line IS followed and
 * scanned; only the recursive walk declines. Same for binary files (NUL in the
 * first 8 KB) and files over the size cap: skipped, counted, never silent.
 *
 * CODE EXPRESSIONS ARE NOT CREDENTIALS (issue #31): `credential-assignment`
 * used to flag any `token:`/`secret:`/`password:` followed by 8+ unquoted
 * characters, including a code expression that merely happens to be long
 * enough — `token: ZERO_REPORTS().token` (a call), `token: zeroReports.token`
 * (a member access), `token: computeTally(x)` (a call with an argument).
 * "token" was a domain word there, not a secret, and rewording the code to
 * dodge the detector was the wrong fix (see the companion SOP issue #30 and
 * the factory PR #280 review this issue references).
 *
 * The rule now excludes UNQUOTED values that are provably code: a member or
 * call expression (`a.b`, `f(x)`, `a.b.getToken().value`), an object/array
 * literal, or a spread (`{...}`, `[...]`, `...x`) — see
 * `looksLikeCodeExpression()`. This applies only to the unquoted branch of the
 * match. A QUOTED value is a string literal by construction and is never
 * exempted this way: `token: "ghp_…"` and a bare unquoted 40-char token both
 * still block, because quoting a real credential must never launder it past
 * this check.
 *
 * SANCTIONED FALSE-POSITIVE ESCAPE — `leak-check:allow` (issue #31): mirrors
 * `gate:allow` in sops/confidentiality-gate.md §4a, on purpose, because it is
 * the same shape of problem (a finding that is real but acceptable, escaped
 * inline, never a blanket skip and never `--no-verify`):
 *
 *   line of code                          // leak-check:allow <rule> — <reason>
 *
 *   - One line only, same rules as §4a: the marker suppresses findings ONLY
 *     for the rule it names, ONLY on the line it sits on. A different rule's
 *     finding sharing that line is untouched — the marker cannot become a
 *     blanket skip by naming one rule and hiding another.
 *   - A reason is mandatory and must contain a letter or digit — a bare
 *     marker, or one with a punctuation-only "reason" (`— ---`), suppresses
 *     nothing; the finding still blocks and a warning explains why
 *     (`leak-check-allow-unjustified`).
 *   - Any comment syntax works (`//`, `#`, `<!-- -->`, …) — the marker is
 *     matched anywhere on the line, not tied to a language's comment grammar.
 *   - The separator is the em dash `—` (as in the SOP) or `--` as a plain-
 *     ASCII fallback, since not every keyboard types an em dash easily.
 *   - Honoured exemptions are never silent: each prints as
 *     `[EXEMPT] file:line: rule — reason` and is counted in the
 *     `N exemption(s) honoured` summary.
 *
 *   NON-EXEMPTABLE RULES (mirrors §4a's "not exemptable at any severity"
 *   carve-out for denylist/internal-email/compliance-code): `private-key-header`
 *   and every operator pattern (`denylist[N]`) cannot be marked away. A PEM
 *   private-key header is never a false positive — if it's present, it's a
 *   real key, and the fix is removing it, not annotating it. An operator
 *   pattern is this repo's own denylist tier; the SOP is explicit that
 *   denylist findings resolve only via a carve-out in the private source,
 *   never an inline annotation, and a local marker capable of suppressing an
 *   organisation's confidential term would be exactly the security hole that
 *   rule exists to prevent. Naming either still blocks the finding and prints
 *   `leak-check-allow-unsupported`.
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
  /**
   * Defaults to true. false means `leak-check:allow <rule> — <reason>` can
   * never suppress a finding for this rule — see the NON-EXEMPTABLE RULES
   * note in the file header.
   */
  exemptable?: boolean;
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
    // Never a false positive — see the NON-EXEMPTABLE RULES note above.
    exemptable: false,
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
    // placeholder, an environment/CI expression, or (unquoted only — see
    // looksLikeCodeExpression) a code expression.
    // The unquoted branch's stop-set includes a backtick: markdown wraps code
    // in `single backticks`, and without this a value like `token:
    // someObject.token` (inline-code, no space before the closing backtick)
    // captured the backtick itself as part of the value. That trailing
    // backtick broke looksLikeCodeExpression's end-anchored match — the
    // exact false positive this rule exists to fix, now tripping on this
    // file's own header prose (compass-core#31, review on #33).
    re: /\b(?:pass(?:word|wd)|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token)\b\s*[:=]\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'#,;`]+))/i,
    accept: (m) => {
      // A quoted value is a string literal by construction: quoting must
      // never launder a real credential past this check, so the code-
      // expression carve-out below applies ONLY to the unquoted branch.
      const quoted = m[1] ?? m[2];
      if (quoted !== undefined) return !isPlaceholder(quoted);
      const raw = m[3] ?? "";
      if (isPlaceholder(raw)) return false;
      return !looksLikeCodeExpression(raw);
    },
  },
];

/**
 * Values that name a credential without being one. Keeping this list tight
 * matters in both directions: too loose and a real secret slips through the
 * `credential-assignment` rule, too tight and the rule cries wolf until someone
 * deletes the hook.
 */
// Note the `[-_]` after your/my/sample/fake/example: those words only mean
// "placeholder" when they head a hyphenated stand-in (`your-api-key`,
// `my_token_here`). Without the separator the alternation is greedy enough to
// swallow real secrets — `mysecretvalue123` would suppress itself.
const PLACEHOLDER =
  /^(?:x+|\*+|\.+|-+|_+|change[-_ ]?me|redacted|placeholder|unset|dummy|test|todo|tbd|none|null|nil|true|false|undefined|empty|secret|password|token|(?:your|my|sample|fake|example|dummy|replace)[-_][a-z0-9_-]*)$/i;

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

/**
 * A value is "provably code, not a literal" when it has JS/TS syntax that no
 * hand-typed credential would ever have: a member-expression or call chain
 * (`a.b`, `f(x)`, `a.b.getToken().value`), an object/array literal, or a
 * spread. See the CODE EXPRESSIONS ARE NOT CREDENTIALS note in the file
 * header for why, and for the (deliberate) limit that this applies only to
 * UNQUOTED values — `credential-assignment`'s `accept` callback is what
 * enforces that limit, not this function.
 *
 * The object/array/spread branches below are redundant with `isPlaceholder`'s
 * leading-bracket check today (both reject a value starting with `{`/`[`) —
 * kept anyway, and documented as such, so this function states the full
 * "provably code" contract on its own rather than depending on an unrelated
 * function's ordering to hold half of it.
 */
function looksLikeCodeExpression(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return false;
  if (v.startsWith("...")) return true; // spread: ...base
  if (/^\{[\s\S]*\}$/.test(v)) return true; // object literal: {a, b}
  if (/^\[[\s\S]*\]$/.test(v)) return true; // array literal: [a, b]

  const ident = "[A-Za-z_$][\\w$]*";
  const chain = `${ident}(?:\\.${ident})*`; // a, a.b, a.b.c
  // A call expression, optionally chained further: f(x), a.b.f(x).c, f().g
  const call = new RegExp(`^${chain}\\([^()]*\\)(?:\\.${ident}(?:\\([^()]*\\))?)*$`);
  // A member expression with no call at all: a.b, a.b.c
  const member = new RegExp(`^${chain}(?:\\.${ident})+$`);
  return call.test(v) || member.test(v);
}

/**
 * Per-line sanctioned false-positive marker — mirrors `gate:allow`
 * (sops/confidentiality-gate.md §4a). See the SANCTIONED FALSE-POSITIVE
 * ESCAPE note in the file header for the full contract.
 */
const ALLOW_MARKER_RE = /leak-check:allow\s+(\S+)(?:\s*(?:—|--)\s*(.+))?\s*$/;

/** True when a "reason" is nothing but punctuation/whitespace — §4a: "Punctuation-only reasons don't count." */
function isPunctuationOnlyReason(s: string): boolean {
  return !/[A-Za-z0-9]/.test(s);
}

interface AllowMarker {
  /** The rule name as written on the line — compared case-insensitively. */
  rule: string;
  /** null when absent or punctuation-only: a bare marker suppresses nothing. */
  reason: string | null;
}

function parseAllowMarker(line: string): AllowMarker | null {
  const m = ALLOW_MARKER_RE.exec(line);
  if (!m) return null;
  const rawReason = m[2]?.trim() ?? "";
  const reason = rawReason.length > 0 && !isPunctuationOnlyReason(rawReason) ? rawReason : null;
  return { rule: m[1]!, reason };
}

interface Finding {
  display: string;
  line: number;
  rule: string;
}

interface Exemption {
  display: string;
  line: number;
  rule: string;
  reason: string;
}

/**
 * Files the scanner declined to read (binary, or over the size cap). Counted and
 * surfaced in the summary — a silently skipped file is a hiding place, and a
 * reader deserves to know the number is not zero.
 */
let skipped = 0;

/** Symlinks declined by the recursive walk (loop safety — see the header). */
let skippedSymlinks = 0;

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

const envPatterns = (process.env.CONFIDENTIALITY_DENYLIST_FILE ?? "").trim();
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
      // Not exemptable — see the NON-EXEMPTABLE RULES note in the file header:
      // an operator pattern IS this repo's denylist tier, and the SOP is
      // explicit that denylist findings resolve only in the private source,
      // never via an inline annotation in the (public) repo the pattern fired in.
      operatorRules.push({ name: `denylist[${index}]`, re: new RegExp(line, "i"), exemptable: false });
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
    "leak-check: --require-patterns is set but no pattern file was given (--patterns or CONFIDENTIALITY_DENYLIST_FILE).",
  );
  process.exit(EXIT_USAGE);
} else {
  console.error(
    "leak-check: CONFIDENTIALITY_DENYLIST_FILE is unset and no --patterns given — built-in rules only.",
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
      if (entry.isSymbolicLink()) {
        skippedSymlinks++;
        continue;
      }
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
    skipped++;
    return null;
  }
  const buf = readFileSync(path);
  if (looksBinary(buf)) {
    skipped++;
    return null;
  }
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
      skipped++;
      continue;
    }
    if (looksBinary(buf)) {
      skipped++;
      continue;
    }
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
const exemptions: Exemption[] = [];
const warnings: string[] = [];

for (const target of targets) {
  const lines = target.text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length === 0) continue;

    // Computed once per line — it doesn't depend on which rule fired, only
    // on which rule (if any) the marker names.
    const marker = parseAllowMarker(line);

    for (const rule of allRules) {
      // Fresh exec per line; no /g state to carry between lines.
      const m = rule.re.exec(line);
      if (!m) continue;
      if (rule.accept && !rule.accept(m)) continue;

      // A marker suppresses ONLY the rule it names, on the line it sits on —
      // a different rule's finding sharing that line is untouched.
      if (marker && marker.rule.toLowerCase() === rule.name.toLowerCase()) {
        if (rule.exemptable === false) {
          warnings.push(
            `${target.display}:${i + 1}: ${rule.name} is not exemptable via leak-check:allow — finding still blocks (leak-check-allow-unsupported)`,
          );
        } else if (marker.reason) {
          exemptions.push({ display: target.display, line: i + 1, rule: rule.name, reason: marker.reason });
          continue; // suppressed — not added to findings
        } else {
          warnings.push(
            `${target.display}:${i + 1}: leak-check:allow ${rule.name} — marker present without a reason; finding still blocks (leak-check-allow-unjustified)`,
          );
        }
      }

      findings.push({ display: target.display, line: i + 1, rule: rule.name });
    }
  }
}

// ---------------------------------------------------------------------------
// Report — locations and rule names only, never content.
// ---------------------------------------------------------------------------

const ruleSummary = `${RULES.length} built-in rule(s) + ${operatorRules.length} operator pattern(s)`;
const skipParts: string[] = [];
if (skipped > 0) skipParts.push(`${skipped} binary/oversize file(s) NOT scanned`);
if (skippedSymlinks > 0) skipParts.push(`${skippedSymlinks} symlink(s) NOT followed`);
const skipNote = skipParts.length > 0 ? `, ${skipParts.join(", ")}` : "";
const exemptionNote = exemptions.length > 0 ? `, ${exemptions.length} exemption(s) honoured` : "";

// Warnings and honoured exemptions are printed up front, independent of the
// overall pass/fail outcome — §4a: "Visible, never silent."
for (const w of warnings) {
  console.error(`leak-check: ${w}`);
}
for (const e of exemptions) {
  console.error(`[EXEMPT] ${e.display}:${e.line}: ${e.rule} — ${e.reason}`);
}

if (findings.length === 0) {
  console.log(
    `leak-check: clean — ${targets.length} file(s) scanned${skipNote}${exemptionNote}, ${ruleSummary} active.`,
  );
  process.exit(EXIT_CLEAN);
}

const files = new Set(findings.map((f) => f.display));
for (const f of findings) {
  console.error(`${f.display}:${f.line}: ${f.rule}`);
}
console.error(
  `\nleak-check: ${findings.length} finding(s) in ${files.size} file(s) — matched content withheld by design.`,
);
console.error(`Scanned ${targets.length} file(s)${skipNote}${exemptionNote} with ${ruleSummary}.`);
console.error("Open each location yourself. Do not paste the matched text into a PR, an issue, or a chat.");
process.exit(EXIT_FINDINGS);
