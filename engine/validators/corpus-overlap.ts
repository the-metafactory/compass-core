#!/usr/bin/env bun
/**
 * corpus-overlap.ts — Scan a diff's added lines for n-word-shingle overlap with a
 * private corpus, without ever revealing where in that corpus a hit lives.
 *
 * Usage:
 *   bun engine/validators/corpus-overlap.ts \
 *     --corpus <path> --base <ref> --head <ref> \
 *     [--n <k>] [--benign <file>]
 *
 *   --corpus <path>   A git checkout of the private corpus. Read only, and only
 *                     its HEAD tree (committed content) — via `git -C <path>
 *                     ls-tree` and `git -C <path> cat-file --batch`. This tool
 *                     never writes to the corpus and never reads it with the
 *                     filesystem directly, and never reads its working tree or
 *                     index (a dirty or half-checked-out corpus can't produce a
 *                     result that looks cleaner than what's actually committed).
 *   --base <ref>      The diff base, in THIS (the consuming) repo. Verified with
 *                     `git rev-parse --verify --end-of-options` before use, and
 *                     refused outright if it starts with "-" — a ref is data,
 *                     never a flag to the git commands it's passed to.
 *   --head <ref>      The diff head, in THIS repo. Same verification as --base.
 *                     Together, --base/--head define "added lines" the way a PR
 *                     review would: `git diff <base> <head>`.
 *   --n <k>           Shingle size in words, after whitespace normalisation.
 *                     Default 6 — the size builders already use by hand (#32).
 *   --benign <file>   The reviewed-benign list, relative to the repo root.
 *                     Default: .corpus-overlap-benign.yaml. ALWAYS loaded from
 *                     --base, never --head (mirrors sops/confidentiality-gate.md
 *                     §4b: no allowlist addition in the same PR as the match).
 *                     This flag does not exempt that path from being scanned —
 *                     see "THE BENIGN LIST" below.
 *
 * THE SEARCH IS A SET INTERSECTION, NOT ONE GREP PER SHINGLE.
 * The corpus's HEAD tree is read once — `ls-tree -r HEAD` for the blob list,
 * `cat-file --batch` (patterns/paths never touch argv, only stdin) for their
 * content — normalised and broken into an in-memory Set<string> of every n-word
 * shingle the corpus contains. The diff's added lines go through the same
 * normalisation and windowing, and matching is a Set lookup. This has no
 * per-shingle process-spawn cost, no argv size limit (an oversized added
 * "word" — a minified bundle, a data: URI — cannot crash a spawn call the way
 * it could when each shingle went through argv to a `git grep` subprocess),
 * and it naturally tolerates whitespace differences on both sides, because
 * both sides are normalised before either is a Set member or a lookup key.
 *
 * NORMALISATION: every run of whitespace — spaces, tabs, newlines, carriage
 * returns, and U+00A0 (non-breaking space, already inside JavaScript's `\s`
 * class) — collapses to a single space before either side is shingled. This
 * is what lets the tool catch text reflowed across lines, re-indented, or
 * pasted with a different line-wrap: the old byte-for-byte `git grep -F`
 * design could not, and that was a regression from the hand-rolled method it
 * replaced. On the corpus side, normalising per FILE (not per line) also means
 * a shingle split across two lines in the corpus is still a corpus shingle.
 * On the diff side, normalising per HUNK (not per added line) means a shingle
 * split across two adjacent added lines in one hunk is still caught — see
 * `extractAddedRuns`.
 *
 * ANY GIT FAILURE DURING THE READ IS INERT, NEVER "NO MATCH". Every git
 * plumbing call this tool makes after argument validation — the corpus
 * ls-tree, the corpus cat-file --batch, the repo's own diff and its --numstat
 * cross-check — is checked for success and for internal consistency (byte
 * counts that don't add up, an object count that doesn't match what was
 * requested, an added-line count that disagrees between the unified diff and
 * --numstat). A failure or an inconsistency at ANY of those points ends the
 * run INERT (exit 2). A search that silently degraded partway through and
 * then reported zero matches would be indistinguishable from a clean result,
 * and that is exactly the failure #32 exists to prevent.
 *
 * THE DIFF SIDE CANNOT BE EMPTIED BY THE THING BEING DIFFED. `git diff` is run
 * with `--no-ext-diff --no-textconv --text`: no external diff driver, no
 * textconv filter, and every file is treated as text regardless of a
 * `.gitattributes -diff` marker or embedded NUL bytes — all three are
 * attacker-controlled by construction, because the PR under scan is what sets
 * them. The parsed added-line count is cross-checked against a separate
 * `git diff --numstat` run (same flags): any disagreement is INERT, because a
 * diff read that disagrees with itself cannot be trusted to have read
 * everything.
 *
 * REF INJECTION: --base/--head are verified with
 * `git rev-parse --verify --end-of-options <ref>` before they are used in any
 * other git command, and rejected outright if either starts with "-" — a ref
 * that git would otherwise parse as an option (e.g. `--output=<file>`, which
 * makes `git diff` write to a file instead of diffing) is refused before it
 * reaches a command that would honour it as a flag.
 *
 * THE BENIGN LIST (.corpus-overlap-benign.yaml, in the CONSUMING repo, public):
 *   - shingle: "display: flex; flex-direction: column;"
 *     reason: "generic CSS reset — collides by coincidence, not by leak"
 *     reviewed_by: "octocat"
 *     date: "2026-09-23"
 * `reason` is mandatory. The file is loaded from --base ONLY: an entry a PR
 * adds to excuse its own match is invisible to that PR's run, by construction.
 * A malformed benign file at --base (invalid YAML, a top-level mapping instead
 * of a list, or any entry missing `shingle` or a non-empty `reason`) is a hard
 * failure — exit 2, naming the file — never a silent "treat it as empty".
 * The benign file ITSELF is scanned like any other added file: only the exact
 * `shingle` values already honoured (i.e. parsed from --base) are exempt from
 * being counted as new matches. A shingle newly added to the file at HEAD is
 * not in that set, so if it matches the corpus it is flagged like anything
 * else — nothing can allowlist itself in the PR that introduces it. `--benign`
 * only changes which path is READ for the allowlist; it never removes any
 * path from the scan.
 *
 * NEVER-LEAK RULE: the corpus is private. This tool's output may name a
 * shingle (words that came from the DIFF, i.e. from the public PR itself —
 * never from the corpus) and may report counts, but it never prints a corpus
 * path, a corpus filename, or a corpus line number. The control shingle
 * itself — the one text fragment this process reads OUT of the corpus — is
 * never printed either, for the same reason operator patterns are withheld
 * in leak-check.ts: it is corpus content, and the corpus is private.
 *
 * WHY A CONTROL SHINGLE: an unsearchable corpus — wrong path, empty checkout,
 * a read that failed or was cut off — would otherwise report zero matches,
 * indistinguishable from "checked, and it's clean." Before trusting a clean
 * result, the tool draws one shingle out of the corpus's own shingle Set and
 * confirms it is a member of that same Set. If none can be drawn (the corpus
 * produced no shingle at all — no commit, no file, or no run of --n words
 * anywhere after normalising), the run is INERT.
 *
 * LIMITS (tracked as a documented gap, not silently absorbed — see #32's
 * follow-up issue, named in sops/confidentiality-gate.md §4c): matching is
 * case-sensitive, and HTML entities are not decoded, so `&amp;` and a literal
 * `&` are different words on either side of the comparison.
 *
 * Exit codes: 0 = no unreviewed matches. 1 = unreviewed matches. 2 = INERT
 * (a control shingle could not be confirmed, or a git read failed or was
 * inconsistent) or a usage/configuration error.
 */

import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const EXIT_CLEAN = 0;
const EXIT_MATCHES = 1;
// Usage errors and an INERT run share exit code 2 by design (see #32) — both
// mean "this result cannot be trusted as a real scan." They're named
// separately here only for a readable call site.
const EXIT_USAGE = 2;
const EXIT_INERT = 2;

const USAGE =
  "Usage: bun engine/validators/corpus-overlap.ts --corpus <path> --base <ref> --head <ref> [--n <k>] [--benign <file>]";

const DEFAULT_BENIGN_FILE = ".corpus-overlap-benign.yaml";

function usageError(message: string): never {
  console.error(`corpus-overlap: ${message}`);
  console.error(USAGE);
  process.exit(EXIT_USAGE);
}

function inert(message: string): never {
  console.error(`corpus-overlap: INERT — ${message}`);
  process.exit(EXIT_INERT);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

let values: {
  corpus?: string;
  base?: string;
  head?: string;
  n?: string;
  benign?: string;
};
try {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: false,
    options: {
      corpus: { type: "string" },
      base: { type: "string" },
      head: { type: "string" },
      n: { type: "string" },
      benign: { type: "string" },
    },
  });
  values = parsed.values;
} catch (err) {
  usageError((err as Error).message);
}

if (!values.corpus) usageError("--corpus <path> is required.");
if (!values.base) usageError("--base <ref> is required.");
if (!values.head) usageError("--head <ref> is required.");

const corpusPath = resolve(values.corpus);
const baseRef = values.base;
const headRef = values.head;
const shingleSize = values.n ? Number.parseInt(values.n, 10) : 6;
if (!Number.isInteger(shingleSize) || shingleSize < 1) {
  usageError(`--n must be a positive integer (got ${JSON.stringify(values.n)}).`);
}
const benignFile = values.benign ?? DEFAULT_BENIGN_FILE;

if (!existsSync(corpusPath)) {
  usageError(`--corpus path does not exist: ${corpusPath}`);
}

// A ref is data, never a flag — refuse anything that could be parsed as one
// before it ever reaches a git command that would honour it (F2).
for (const [flag, ref] of [
  ["--base", baseRef],
  ["--head", headRef],
] as const) {
  if (ref.startsWith("-")) {
    usageError(`${flag} must not look like an option (got ${JSON.stringify(ref)}) — refusing.`);
  }
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

interface RunResult {
  ok: boolean;
  stdout: Uint8Array;
  stderr: string;
}

function run(cmd: string[], cwd: string, stdin?: Uint8Array): RunResult {
  const proc = Bun.spawnSync(cmd, stdin === undefined ? { cwd } : { cwd, stdin });
  return {
    ok: (proc.exitCode ?? 1) === 0,
    stdout: proc.stdout,
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

const utf8 = new TextDecoder("utf-8", { fatal: false });
function decode(bytes: Uint8Array): string {
  return utf8.decode(bytes);
}

/** Every run of whitespace (space, tab, CR, LF, NBSP, ...) collapses to one space. */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** n-word windows out of already-normalised (single-space-separated) text. */
function shingleWindows(normalized: string, n: number): string[] {
  if (normalized.length === 0) return [];
  const words = normalized.split(" ");
  const out: string[] = [];
  for (let i = 0; i + n <= words.length; i++) {
    out.push(words.slice(i, i + n).join(" "));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The consuming repo's root.
// ---------------------------------------------------------------------------

const repoRoot = run(["git", "rev-parse", "--show-toplevel"], process.cwd());
if (!repoRoot.ok) {
  usageError("must be run inside a git repository (git rev-parse --show-toplevel failed).");
}
const root = decode(repoRoot.stdout).trim();

// Verify both refs resolve, with --end-of-options so a ref shaped like an
// option is never handed to git's option parser (F2).
for (const [flag, ref] of [
  ["--base", baseRef],
  ["--head", headRef],
] as const) {
  const verified = run(["git", "rev-parse", "--verify", "--end-of-options", ref], root);
  if (!verified.ok) {
    usageError(`${flag} does not resolve to a commit in this repository: ${JSON.stringify(ref)}`);
  }
}

// ---------------------------------------------------------------------------
// The corpus: read its HEAD tree ONLY, through git plumbing, once. Any
// failure or inconsistency here is INERT — never treated as "no shingles".
// ---------------------------------------------------------------------------

function readCorpusShingles(): Set<string> {
  const lsTree = run(["git", "-C", corpusPath, "ls-tree", "-r", "-z", "--full-tree", "HEAD"], corpusPath);
  if (!lsTree.ok) {
    inert(
      "could not list the corpus's HEAD tree (git ls-tree failed) — wrong path, no commits, or not a git repository.",
    );
  }
  const oids: string[] = [];
  for (const entry of decode(lsTree.stdout).split("\0")) {
    if (entry.length === 0) continue;
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const meta = entry.slice(0, tab).split(" ");
    const type = meta[1];
    const oid = meta[2];
    if (type === "blob" && oid) oids.push(oid);
  }
  if (oids.length === 0) {
    inert("the corpus HEAD tree has no files — nothing to search, so a clean result would be meaningless.");
  }

  const uniqueOids = [...new Set(oids)];
  const batch = run(
    ["git", "-C", corpusPath, "cat-file", "--batch"],
    corpusPath,
    new TextEncoder().encode(uniqueOids.join("\n") + "\n"),
  );
  if (!batch.ok) {
    inert("git cat-file --batch on the corpus failed — the read could not be trusted.");
  }

  const buf = batch.stdout;
  const shingles = new Set<string>();
  const NL = 10; // '\n'
  let offset = 0;
  let parsed = 0;

  while (offset < buf.length) {
    let nl = -1;
    for (let i = offset; i < buf.length; i++) {
      if (buf[i] === NL) {
        nl = i;
        break;
      }
    }
    if (nl === -1) {
      inert("the corpus read was cut off partway through (no object header found) — cannot trust a clean result.");
    }
    const header = decode(buf.subarray(offset, nl));
    offset = nl + 1;

    const missing = /^([0-9a-f]+) missing$/.exec(header);
    if (missing) {
      inert("the corpus read reported a missing object partway through — cannot trust a clean result.");
    }
    const m = /^([0-9a-f]+) (\S+) (\d+)$/.exec(header);
    if (!m) {
      inert("the corpus read produced an unreadable object header — cannot trust a clean result.");
    }
    const size = Number.parseInt(m[3]!, 10);
    if (offset + size > buf.length) {
      inert("the corpus read was cut off partway through an object's content — cannot trust a clean result.");
    }
    const content = buf.subarray(offset, offset + size);
    offset += size;
    if (buf[offset] !== NL) {
      inert("the corpus read was malformed (no separator after an object) — cannot trust a clean result.");
    }
    offset += 1;
    parsed++;

    const normalized = normalizeWhitespace(decode(content));
    for (const s of shingleWindows(normalized, shingleSize)) shingles.add(s);
  }

  if (parsed !== uniqueOids.length) {
    inert(
      `the corpus read returned ${parsed} object(s) but ${uniqueOids.length} were requested — cannot trust a clean result.`,
    );
  }

  return shingles;
}

const corpusShingles = readCorpusShingles();

// ---------------------------------------------------------------------------
// Control: prove a shingle drawn from the corpus is actually findable through
// the same lookup path the diff's shingles will use. Never printed — it is
// corpus content, and the corpus is private.
// ---------------------------------------------------------------------------

function drawControlShingle(): string | null {
  const first = corpusShingles.values().next();
  return first.done ? null : (first.value as string);
}

const controlShingle = drawControlShingle();
if (controlShingle === null || !corpusShingles.has(controlShingle)) {
  inert(
    `no control shingle could be drawn from the corpus (no run of ${shingleSize} words anywhere after normalising ` +
      "whitespace) — the search was never proven capable of finding a match, so a clean result would be meaningless.",
  );
}

// ---------------------------------------------------------------------------
// The diff: added lines between --base and --head, in THIS repo. Forced to
// text mode so the PR under scan cannot empty its own diff (F2).
// ---------------------------------------------------------------------------

// --unified=0: hunks then correspond to exactly one contiguous old/new range,
// so within a hunk the '+' lines ARE contiguous in the resulting file no
// matter how many '-' lines the hunk body lists between them (see
// extractAddedRuns). Any context line that does appear (a "\ No newline..."
// marker, oddities from a diff driver override attempt) still flushes a run
// through the catch-all branch below, so this is a belt, not the only strap.
// --end-of-options MUST be the last option before the (positional) refs —
// git refuses any option, including --numstat, given after it. So it is
// appended by buildDiffArgs(), never hardcoded ahead of a variable option.
//
// --unified=0 is only for the PATCH call. Combined with --numstat, git also
// implies -p and prints the full patch body after the numstat summary
// (--unified/-U is itself a "generate a patch" flag) — the numstat call
// below omits it so its output stays a pure, easily-parsed summary table.
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--text"];
function buildDiffArgs(extra: string[] = []): string[] {
  return ["diff", ...DIFF_FLAGS, ...extra, "--end-of-options", baseRef, headRef];
}

const diff = run(["git", ...buildDiffArgs(["--unified=0"])], root);
if (!diff.ok) {
  inert(`git diff ${baseRef} ${headRef} failed — the diff could not be read.`);
}

/**
 * Runs of added ('+') lines within one diff hunk, joined before normalising —
 * so a shingle split across two adjacent added lines is still caught. A run
 * breaks at a hunk header, a file boundary, or any non-'+'/'-' line; '-'
 * lines are skipped without breaking a run, because with --unified=0 every
 * hunk is one contiguous old/new range, and its '+' lines are contiguous in
 * the resulting file regardless of how many '-' lines sit between them in the
 * diff's own old-then-new hunk body.
 */
function extractAddedRuns(diffText: string): { runs: string[]; plusLineCount: number } {
  const runs: string[] = [];
  let current: string[] = [];
  let plusLineCount = 0;
  const flush = () => {
    if (current.length > 0) {
      runs.push(current.join(" "));
      current = [];
    }
  };
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("@@") || raw.startsWith("diff --git ")) {
      flush();
      continue;
    }
    if (raw.startsWith("+")) {
      current.push(raw.slice(1));
      plusLineCount++;
      continue;
    }
    if (raw.startsWith("-")) {
      continue; // does not break contiguity of the surrounding '+' run
    }
    flush(); // context, "\ No newline at end of file", index lines, etc.
  }
  flush();
  return { runs, plusLineCount };
}

// --unified=0 is deliberately NOT used above: with default context, hunks can
// be huge, but plusLineCount from the unified body must match --numstat
// regardless of context width, so the flags stay identical between the two
// calls and the invariant is checked, not assumed.
const { runs: addedRuns, plusLineCount } = extractAddedRuns(decode(diff.stdout));

const numstat = run(["git", ...buildDiffArgs(["--numstat"])], root);
if (!numstat.ok) {
  inert(`git diff --numstat ${baseRef} ${headRef} failed — the added-line count could not be cross-checked.`);
}
let numstatAdded = 0;
for (const line of decode(numstat.stdout).split("\n")) {
  if (line.trim().length === 0) continue;
  const parts = line.split("\t");
  if (parts.length < 3) {
    inert("git diff --numstat produced an unparsable line — the added-line count could not be cross-checked.");
  }
  const addedStr = parts[0]!;
  if (addedStr === "-") {
    inert(
      "git diff --numstat reported a file as binary even under --text — cannot trust the added-line count for it.",
    );
  }
  const added = Number.parseInt(addedStr, 10);
  if (!Number.isInteger(added)) {
    inert("git diff --numstat produced a non-numeric added-line count — cannot trust the cross-check.");
  }
  numstatAdded += added;
}
if (numstatAdded !== plusLineCount) {
  inert(
    `added-line count mismatch: the unified diff parsed ${plusLineCount} added line(s), --numstat reports ` +
      `${numstatAdded} — refusing to trust a diff read that disagrees with itself.`,
  );
}

const allShingles = new Set<string>();
for (const run_ of addedRuns) {
  for (const s of shingleWindows(normalizeWhitespace(run_), shingleSize)) allShingles.add(s);
}

// ---------------------------------------------------------------------------
// The benign list — loaded from --base, never --head. A malformed file at
// base is a hard failure, never silently treated as empty.
// ---------------------------------------------------------------------------

interface BenignEntry {
  shingle: string;
  reason: string;
  reviewed_by?: string;
  date?: string;
}

function loadBenignList(): BenignEntry[] {
  const shown = run(["git", "show", `${baseRef}:${benignFile}`], root);
  if (!shown.ok) {
    // No benign file at base — either it never existed there, or it was only
    // added at head. Either way: nothing is honoured this run. Not fatal —
    // an ABSENT file is not a MALFORMED one.
    return [];
  }
  const raw = decode(shown.stdout);

  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(raw);
  } catch (err) {
    console.error(`corpus-overlap: ${benignFile} at ${baseRef} is not valid YAML: ${(err as Error).message}`);
    process.exit(EXIT_USAGE);
  }

  if (!Array.isArray(parsedYaml)) {
    console.error(
      `corpus-overlap: ${benignFile} at ${baseRef} must be a top-level YAML list of entries ` +
        `({shingle, reason, reviewed_by, date}) — found ${
          parsedYaml === null ? "null" : typeof parsedYaml
        } instead.`,
    );
    process.exit(EXIT_USAGE);
  }

  const entries: BenignEntry[] = [];
  parsedYaml.forEach((raw, i) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      console.error(`corpus-overlap: ${benignFile} at ${baseRef}, entry ${i + 1}: not a mapping.`);
      process.exit(EXIT_USAGE);
    }
    const shingle = (raw as Record<string, unknown>).shingle;
    const reason = (raw as Record<string, unknown>).reason;
    if (typeof shingle !== "string" || shingle.length === 0) {
      console.error(`corpus-overlap: ${benignFile} at ${baseRef}, entry ${i + 1}: missing a \`shingle\` value.`);
      process.exit(EXIT_USAGE);
    }
    if (typeof reason !== "string" || reason.trim().length === 0) {
      console.error(`corpus-overlap: ${benignFile} at ${baseRef}, entry ${i + 1}: missing a non-empty \`reason\`.`);
      process.exit(EXIT_USAGE);
    }
    const reviewedBy = (raw as Record<string, unknown>).reviewed_by;
    const date = (raw as Record<string, unknown>).date;
    entries.push({
      shingle,
      reason,
      reviewed_by: typeof reviewedBy === "string" ? reviewedBy : undefined,
      date: typeof date === "string" ? date : undefined,
    });
  });
  return entries;
}

const benignEntries = loadBenignList();
const benignByShingle = new Map<string, BenignEntry>();
for (const entry of benignEntries) benignByShingle.set(entry.shingle, entry);

// ---------------------------------------------------------------------------
// Search: an in-memory set intersection, not a subprocess per shingle.
// ---------------------------------------------------------------------------

const rawMatches: string[] = [];
for (const shingle of allShingles) {
  if (corpusShingles.has(shingle)) rawMatches.push(shingle);
}

const unreviewed: string[] = [];
const honoured: string[] = [];
for (const shingle of rawMatches) {
  if (benignByShingle.has(shingle)) honoured.push(shingle);
  else unreviewed.push(shingle);
}

// Stale entries: benign-listed shingles that no longer match anything in the
// corpus at all (independent of whether this diff happens to contain them).
const staleEntries: BenignEntry[] = [];
for (const entry of benignEntries) {
  if (!corpusShingles.has(entry.shingle)) staleEntries.push(entry);
}

// ---------------------------------------------------------------------------
// Report — shingle text and counts only. Never a corpus path or line.
// ---------------------------------------------------------------------------

console.log(`corpus-overlap: ${allShingles.size} shingle(s) drawn from ${plusLineCount} added line(s).`);
console.log(`corpus-overlap: ${rawMatches.length} match(es) against the corpus, ${honoured.length} honoured.`);

if (staleEntries.length > 0) {
  console.log(
    `corpus-overlap: ${staleEntries.length} benign entr${staleEntries.length === 1 ? "y" : "ies"} stale (no longer matches the corpus):`,
  );
  for (const entry of staleEntries) {
    console.log(`  - "${entry.shingle}" (reason: ${entry.reason})`);
  }
}

if (unreviewed.length === 0) {
  console.log(`corpus-overlap: clean — no unreviewed matches.`);
  process.exit(EXIT_CLEAN);
}

console.error(`\ncorpus-overlap: ${unreviewed.length} unreviewed match(es):`);
for (const shingle of unreviewed) {
  console.error(`  "${shingle}"`);
}
console.error(
  `\nEach shingle above collided with the private corpus. Judge it: if it's a real leak, fix the source line.`,
);
console.error(
  `If it's benign (generic text colliding by coincidence), add it to ${benignFile} with a reason, reviewer, and` +
    ` date — in a FOLLOW-UP PR, never this one (sops/confidentiality-gate.md §4b).`,
);
process.exit(EXIT_MATCHES);
