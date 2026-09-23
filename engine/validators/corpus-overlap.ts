#!/usr/bin/env bun
/**
 * corpus-overlap.ts — Scan a diff's added lines for n-word-shingle overlap with a
 * private corpus, without ever revealing where in that corpus a hit lives.
 *
 * Usage:
 *   bun engine/validators/corpus-overlap.ts \
 *     --corpus <path> --base <ref> --head <ref> \
 *     [--n <k>] [--benign <file>] [--refs HEAD|all]
 *
 *   --corpus <path>   A git checkout of the private corpus. Read only, and only
 *                     COMMITTED content — via `git -C <path> for-each-ref`,
 *                     `ls-tree`, and `cat-file --batch`. This tool never writes
 *                     to the corpus and never reads it with the filesystem
 *                     directly, and never reads its working tree or index (a
 *                     dirty working tree, or an uncommitted draft, cannot
 *                     produce a result that looks cleaner than what's actually
 *                     committed — but see "SCOPE" below: an uncommitted draft
 *                     is not searched at all, by design).
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
 *   --refs HEAD|all   Which corpus commits to search. Default "all": every
 *                     blob reachable from every local branch, remote-tracking
 *                     branch, and tag tip (deduplicated by content), plus
 *                     HEAD itself. "HEAD" restricts the search to HEAD only —
 *                     narrower, and correspondingly less coverage; see SCOPE.
 *
 * SCOPE — WHAT IS AND ISN'T SEARCHED, PRINTED ON EVERY RUN:
 * The corpus's blobs are read once, deduplicated by content (git object id),
 * from every ref this run resolves (all branches/remotes/tags by default, or
 * HEAD alone with --refs HEAD). The first output line reports what that
 * amounted to: refs searched, unique paths reachable, unique blobs actually
 * read, total bytes, and three "not searched" counts that are NEVER folded
 * silently into a clean result:
 *   - gitlinks/submodules: `ls-tree` entries of type `commit` point at a
 *     separate repository this tool does not follow. Counted, never searched.
 *   - binary corpus blobs: content with a NUL in its first 8KB (mirrors
 *     leak-check.ts's binary heuristic). Counted, never shingled.
 *   - UTF-16 blobs (LE or BE, detected by BOM) ARE decoded and searched —
 *     they're counted separately in the scope line, but they count toward
 *     "blobs read," not toward "not searched." A UTF-16 file with no BOM,
 *     or any other multi-byte encoding, is indistinguishable from binary to
 *     the NUL heuristic and is counted as binary.
 * OUT OF SCOPE, not counted because this tool cannot see it: content in the
 * corpus checkout's UNCOMMITTED working tree or index (only committed refs
 * are read), and Git LFS pointer files (the pointer text is searched like any
 * blob, but the real content LFS defers to is never fetched or read).
 *
 * THE SEARCH IS A SET INTERSECTION, NOT ONE GREP PER SHINGLE.
 * Every corpus blob's content is normalised and broken into an in-memory
 * Set<string> of every n-word shingle the corpus contains — patterns and
 * paths never touch a subprocess's argv, only `cat-file --batch`'s stdin.
 * The diff's added lines go through the same normalisation and windowing,
 * and matching is a Set lookup. This has no per-shingle process-spawn cost,
 * no argv size limit (an oversized added "word" — a minified bundle, a
 * data: URI — cannot crash a spawn call the way it could when each shingle
 * went through argv to a `git grep` subprocess), and it naturally tolerates
 * whitespace differences on both sides, because both sides are normalised
 * before either is a Set member or a lookup key.
 *
 * NORMALISATION: every run of whitespace — spaces, tabs, newlines, carriage
 * returns, and U+00A0 (non-breaking space, already inside JavaScript's `\s`
 * class) — collapses to a single space before either side is shingled, and
 * zero-width characters (U+200B–U+200D, U+FEFF) are stripped outright, since
 * `\s` does not treat them as whitespace and left alone they'd silently split
 * a shingle that reads as one word to a human. This is what lets the tool
 * catch text reflowed across lines, re-indented, or pasted with a different
 * line-wrap: byte-for-byte matching could not, and that was a regression from
 * the hand-rolled method this tool replaces. On the corpus side, normalising
 * per FILE (not per line) also means a shingle split across two lines in the
 * corpus is still a corpus shingle. On the diff side, normalising per HUNK
 * (not per added line) means a shingle split across two adjacent added lines
 * in one hunk is still caught — see `extractAddedRuns`.
 *
 * WHY THE CONTROL EXERCISES THE DIFF-SIDE PATH, NOT THE CORPUS ITSELF:
 * a control that just asks "is the corpus's own shingle Set non-empty" can
 * never fail once the corpus has been read at all — it says nothing about
 * whether the DIFF side would actually find something real. So the control
 * draws a raw (pre-normalisation) fragment out of one corpus blob and feeds
 * it through the exact same pipeline a real added diff run goes through —
 * `extractAddedRuns` → `runsToShingles` (normalise, then window) — and then
 * the same `corpusHas` lookup the real search uses. If that produces no
 * match, the run is INERT: not "the corpus is unreadable" specifically, but
 * "the two pipelines disagree about the exact same text," which is the
 * observable symptom of a broken lookup, a normalisation step that silently
 * stopped running, or the corpus and diff sides drifting out of sync with
 * each other — none of which a self-referential check could ever catch.
 *
 * ANY GIT FAILURE DURING THE READ IS INERT, NEVER "NO MATCH". Every git
 * plumbing call this tool makes after argument validation — for-each-ref,
 * ls-tree, cat-file --batch, the repo's own diff and its --numstat
 * cross-check — is checked for success and for internal consistency (byte
 * counts that don't add up, an object count that doesn't match what was
 * requested, an added-line count that disagrees between the unified diff and
 * --numstat). A failure or an inconsistency at ANY of those points ends the
 * run INERT (exit 2).
 *
 * THE DIFF SIDE CANNOT BE EMPTIED BY THE THING BEING DIFFED. `git diff` runs
 * with `--no-ext-diff --no-textconv --text --no-renames`: no external diff
 * driver, no textconv filter, every file forced to text mode regardless of a
 * `.gitattributes -diff` marker or an embedded NUL byte, and no rename
 * detection to keep numstat's paths and the unified diff's paths in exact
 * agreement. The parsed added-line count is cross-checked against a separate
 * `git diff --numstat` run (same flags): any disagreement that isn't
 * explained by a binary file (see BINARY FILES) is INERT.
 *
 * BINARY FILES IN THE DIFF (not the corpus — see SCOPE above for that): a
 * file `--numstat` reports as binary (`-` for both counts, which `--text`
 * does not prevent for every case) is excluded from both the added-line
 * cross-check and from shingling — counted AND NAMED (the path is from the
 * public PR, never the corpus, so naming it is safe) as "N binary file(s)
 * not scanned," never silently folded into a clean result. Every other file
 * in the same diff is still scanned normally. numstat's verdict is itself
 * attacker-influenceable (see THE DIFF SIDE CANNOT BE EMPTIED above — a
 * `.gitattributes -diff` marker makes numstat say "-" for a file `--text`
 * still shows as real content), so a "-" row is only trusted as genuinely
 * binary once the file's actual HEAD content backs it up: a NUL in its first
 * 8KB, same heuristic as the corpus side. If numstat says binary but the
 * content doesn't, that disagreement is INERT, not a silent exclusion — an
 * excluded path is never scanned again, so trusting a false "binary" verdict
 * would be exactly the empty-diff evasion this section exists to close.
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
 * failure — exit 2, naming the file — never a silent "treat it as empty". A
 * benign file that simply doesn't exist at --base (never created, or only
 * added at --head) is not malformed, so this is the one git-read failure
 * that is NOT INERT — it means "nothing is honoured this run," which the
 * benign-file's-own-absence already implies.
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
 * path, a corpus filename, a corpus ref name, or a corpus line number. The
 * control fragment itself — the one text fragment this process reads OUT of
 * the corpus — is never printed either, for the same reason operator
 * patterns are withheld in leak-check.ts: it is corpus content.
 *
 * LIMITS (tracked as a documented gap, not silently absorbed — see #32's
 * follow-up issue, named in sops/confidentiality-gate.md §4c): matching is
 * case-sensitive, and HTML entities are not decoded, so `&amp;` and a literal
 * `&` are different words on either side of the comparison.
 *
 * Exit codes: 0 = no unreviewed matches. 1 = unreviewed matches. 2 = INERT
 * (the control fragment didn't match through the real search path, or a git
 * read failed or was inconsistent) or a usage/configuration error.
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
  "Usage: bun engine/validators/corpus-overlap.ts --corpus <path> --base <ref> --head <ref> " +
  "[--n <k>] [--benign <file>] [--refs HEAD|all]";

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
  refs?: string;
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
      refs: { type: "string" },
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

const refsMode: "HEAD" | "all" = values.refs === undefined ? "all" : values.refs === "HEAD" ? "HEAD" : values.refs === "all" ? "all" : (usageError(`--refs must be "HEAD" or "all" (got ${JSON.stringify(values.refs)}).`) as never);

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

/**
 * Every run of whitespace (space, tab, CR, LF, NBSP, ...) collapses to one
 * space, and zero-width characters are stripped outright — `\s` does not
 * treat U+200B (zero-width space), U+200C/U+200D (joiners), or U+FEFF
 * (zero-width no-break space / BOM) as whitespace, but left alone any of them
 * sitting mid-word would silently split what a human reads as one word into
 * two shingle tokens.
 */
function normalizeWhitespace(text: string): string {
  return text.replace(/[​-‍﻿]/g, "").replace(/\s+/g, " ").trim();
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

/**
 * Turns diff-side "runs" (see extractAddedRuns) into a shingle set. This is
 * THE diff-side pipeline — the real search and the control (G1) both call it,
 * so a future change that breaks diff-side normalisation breaks both the same
 * way, and the control (compared against the corpus's OWN, separately-built
 * shingle set) catches the disagreement instead of silently reporting clean.
 */
function runsToShingles(runs: string[], n: number): Set<string> {
  const out = new Set<string>();
  for (const r of runs) {
    for (const s of shingleWindows(normalizeWhitespace(r), n)) out.add(s);
  }
  return out;
}

/**
 * Runs of added ('+') lines within one diff hunk, joined before normalising —
 * so a shingle split across two adjacent added lines is still caught. A run
 * breaks at a file boundary ("+++ ", "--- "), a hunk header ("@@"), a
 * "diff --git " line, or any other non-'+'/'-' line; '-' lines are skipped
 * without breaking a run, because with --unified=0 every hunk is one
 * contiguous old/new range, and its '+' lines are contiguous in the
 * resulting file regardless of how many '-' lines sit between them in the
 * diff's own old-then-new hunk body.
 *
 * The file-boundary checks require a trailing space ("+++ ", "--- "), not
 * just the three-character prefix: an ADDED line whose own content starts
 * with "++" (e.g. `++counter;`) renders as "+++counter;" — three literal
 * plus signs with no space after them — and must be read as added content,
 * not misread as a file header. Anchoring to the header's own fixed shape
 * (marker, then a space, then a path) tells the two apart.
 *
 * `binaryPaths` (from the --numstat cross-check) excludes a file's '+' lines
 * from both the run output and plusLineCount — they were never counted on
 * the --numstat side either, so the two stay comparable (G4).
 */
function extractAddedRuns(diffText: string, binaryPaths: Set<string>): { runs: string[]; plusLineCount: number } {
  const runs: string[] = [];
  let current: string[] = [];
  let plusLineCount = 0;
  let currentFile: string | null = null;
  const flush = () => {
    if (current.length > 0) {
      runs.push(current.join(" "));
      current = [];
    }
  };
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("+++ ")) {
      flush();
      const p = raw.slice(4).trim();
      currentFile = p === "/dev/null" ? null : p.replace(/^b\//, "");
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("@@") || raw.startsWith("diff --git ")) {
      flush();
      continue;
    }
    if (raw.startsWith("+")) {
      if (currentFile !== null && binaryPaths.has(currentFile)) continue; // G4: excluded, not scanned
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

/**
 * Wraps a raw text fragment as a synthetic single-file, single-hunk unified
 * diff whose only content is that fragment as added ('+') lines — so the
 * control (G1) can be parsed by the REAL extractAddedRuns, not a hand-rolled
 * copy of what it does.
 */
function syntheticAddedDiffText(rawFragment: string): string {
  const lines = rawFragment.split("\n").map((l) => "+" + l);
  return ["+++ b/__corpus_overlap_control__", "@@ -0,0 +1 @@", ...lines, ""].join("\n");
}

/**
 * The raw (pre-normalisation) substring spanning exactly `n` whitespace-
 * delimited words, from the start of the first to the end of the n-th —
 * original spacing, tabs, newlines, and all. Used only to build the control
 * fragment; never printed.
 */
function extractRawSpan(text: string, n: number): string | null {
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  let start = -1;
  let end = -1;
  let count = 0;
  while ((m = re.exec(text)) !== null) {
    if (start === -1) start = m.index;
    end = m.index + m[0].length;
    count++;
    if (count === n) break;
  }
  if (count < n) return null;
  return text.slice(start, end);
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
// The corpus: read every blob reachable from the searched refs (all branch/
// remote/tag tips plus HEAD by default; HEAD alone with --refs HEAD), through
// git plumbing, once. Any failure or inconsistency here is INERT — never
// treated as "no shingles". Classified and counted, never silently dropped
// (G2/G3): gitlinks (submodules) and binary blobs are excluded from search
// and counted; UTF-16 blobs (BOM-detected) are decoded and included.
// ---------------------------------------------------------------------------

interface CorpusRead {
  shingles: Set<string>;
  controlFragment: string | null;
  refsSearchedCount: number;
  pathsReachable: number;
  blobsRead: number;
  bytesRead: number;
  gitlinkCount: number;
  binaryCount: number;
  utf16Count: number;
}

/** Every commit this run searches, deduplicated — plus how many ref pointers that came from. */
function listCorpusCommits(): { commits: string[]; refsSearchedCount: number } {
  const head = run(["git", "-C", corpusPath, "rev-parse", "--verify", "--end-of-options", "HEAD"], corpusPath);
  const headSha = head.ok ? decode(head.stdout).trim() : null;

  if (refsMode === "HEAD") {
    if (headSha === null) return { commits: [], refsSearchedCount: 0 };
    return { commits: [headSha], refsSearchedCount: 1 };
  }

  const refsOut = run(
    ["git", "-C", corpusPath, "for-each-ref", "--format=%(objectname)", "refs/heads", "refs/remotes", "refs/tags"],
    corpusPath,
  );
  if (!refsOut.ok) {
    inert("could not list the corpus's refs (git for-each-ref failed) — wrong path or not a git repository.");
  }
  const names = decode(refsOut.stdout)
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const refsSearchedCount = names.length + (headSha !== null ? 1 : 0);
  const commits = [...new Set(headSha !== null ? [...names, headSha] : names)];
  return { commits, refsSearchedCount };
}

/** Blob and gitlink object ids across every searched commit's full tree, plus the reachable path count. */
function readCorpusTrees(commits: string[]): { blobOids: string[]; gitlinkOids: Set<string>; pathsReachable: number } {
  const blobOids: string[] = [];
  const gitlinkOids = new Set<string>();
  const paths = new Set<string>();
  for (const commit of commits) {
    const lsTree = run(["git", "-C", corpusPath, "ls-tree", "-r", "-z", "--full-tree", commit], corpusPath);
    if (!lsTree.ok) {
      inert("could not list a tree for one of the corpus's searched refs (git ls-tree failed).");
    }
    for (const entry of decode(lsTree.stdout).split("\0")) {
      if (entry.length === 0) continue;
      const tab = entry.indexOf("\t");
      if (tab === -1) continue;
      const meta = entry.slice(0, tab).split(" ");
      const type = meta[1];
      const oid = meta[2];
      const path = entry.slice(tab + 1);
      if (path.length > 0) paths.add(path);
      if (type === "blob" && oid) blobOids.push(oid);
      else if (type === "commit" && oid) gitlinkOids.add(oid); // a submodule/gitlink pointer, not followed
    }
  }
  return { blobOids, gitlinkOids, pathsReachable: paths.size };
}

/** Classifies one blob's raw bytes and decodes it if it's searchable text. */
function classifyBlob(content: Uint8Array): { kind: "text" | "utf16" | "binary"; text: string | null } {
  if (content.length >= 2 && content[0] === 0xff && content[1] === 0xfe) {
    try {
      return { kind: "utf16", text: new TextDecoder("utf-16le").decode(content.subarray(2)) };
    } catch {
      return { kind: "binary", text: null };
    }
  }
  if (content.length >= 2 && content[0] === 0xfe && content[1] === 0xff) {
    try {
      return { kind: "utf16", text: new TextDecoder("utf-16be").decode(content.subarray(2)) };
    } catch {
      return { kind: "binary", text: null };
    }
  }
  // Binary heuristic mirrors leak-check.ts: a NUL in the first 8KB. Anything
  // multi-byte without a BOM (a UTF-16 file with no BOM, UTF-32, etc.) is
  // indistinguishable from binary to this check and is counted as binary.
  const window = content.subarray(0, Math.min(8000, content.length));
  if (window.includes(0)) {
    return { kind: "binary", text: null };
  }
  return { kind: "text", text: decode(content) };
}

function readCorpus(): CorpusRead {
  const { commits, refsSearchedCount } = listCorpusCommits();
  if (commits.length === 0) {
    inert("the corpus has no resolvable ref (no HEAD, and no branch/remote/tag tip) — wrong path or an empty repository.");
  }

  const { blobOids, gitlinkOids, pathsReachable } = readCorpusTrees(commits);
  const uniqueOids = [...new Set(blobOids)];
  if (uniqueOids.length === 0) {
    inert(
      gitlinkOids.size > 0
        ? "the corpus's searched refs contain only submodule/gitlink entries — nothing this tool can read to search."
        : "the corpus's searched refs have no files — nothing to search, so a clean result would be meaningless.",
    );
  }

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
  let controlFragment: string | null = null;
  const NL = 10; // '\n'
  let offset = 0;
  let parsed = 0;
  let bytesRead = 0;
  let binaryCount = 0;
  let utf16Count = 0;
  let textCount = 0;

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
    bytesRead += size;

    const { kind, text } = classifyBlob(content);
    if (kind === "binary") {
      binaryCount++;
      continue; // G2/G3: counted, never searched
    }
    if (kind === "utf16") utf16Count++;
    else textCount++;

    // Corpus-side shingling is DELIBERATELY its own call, not a share of
    // runsToShingles: the control (G1) proves the diff-side pipeline and
    // this one independently agree on the same text. If they shared a
    // function, a bug in it could break both identically and still agree.
    const normalized = normalizeWhitespace(text!);
    for (const s of shingleWindows(normalized, shingleSize)) shingles.add(s);
    if (controlFragment === null) {
      controlFragment = extractRawSpan(text!, shingleSize);
    }
  }

  if (parsed !== uniqueOids.length) {
    inert(
      `the corpus read returned ${parsed} object(s) but ${uniqueOids.length} were requested — cannot trust a clean result.`,
    );
  }

  return {
    shingles,
    controlFragment,
    refsSearchedCount,
    pathsReachable,
    blobsRead: textCount + utf16Count,
    bytesRead,
    gitlinkCount: gitlinkOids.size,
    binaryCount,
    utf16Count,
  };
}

const corpus = readCorpus();

// SCOPE — printed unconditionally, before anything else, so even an INERT
// run (the control failing next) shows what was and wasn't read (G3).
console.log(
  `corpus-overlap: scope — ${corpus.refsSearchedCount} ref(s) searched (--refs ${refsMode}), ` +
    `${corpus.pathsReachable} path(s) reachable, ${corpus.blobsRead} blob(s) read (${corpus.utf16Count} as UTF-16), ` +
    `${corpus.bytesRead} byte(s); NOT searched: ${corpus.gitlinkCount} gitlink(s)/submodule(s), ` +
    `${corpus.binaryCount} binary corpus blob(s).`,
);

function corpusHas(shingle: string): boolean {
  return corpus.shingles.has(shingle);
}

// ---------------------------------------------------------------------------
// Control (G1): the corpus's own shingle Set can never disprove itself, so
// the control instead draws a raw fragment from the corpus and runs it
// through the REAL diff-side pipeline — extractAddedRuns, then
// runsToShingles — checked against corpusHas, the same lookup the real
// search uses. Never printed; it is corpus content.
// ---------------------------------------------------------------------------

if (corpus.controlFragment === null) {
  inert(
    `no run of ${shingleSize} words could be found anywhere in the searched corpus content — the search was never ` +
      "proven capable of finding a match, so a clean result would be meaningless.",
  );
}

const { runs: controlRuns } = extractAddedRuns(syntheticAddedDiffText(corpus.controlFragment), new Set());
const controlShingles = runsToShingles(controlRuns, shingleSize);
if (![...controlShingles].some((s) => corpusHas(s))) {
  inert(
    "a fragment drawn from the corpus, run through the exact diff-side pipeline (extractAddedRuns → " +
      "runsToShingles) used for the real diff, produced no shingle present in the corpus's own index — the " +
      "search was never proven capable of finding a match.",
  );
}

// ---------------------------------------------------------------------------
// The diff: added lines between --base and --head, in THIS repo. Forced to
// text mode so the PR under scan cannot empty its own diff (F2). --numstat
// runs FIRST so binary paths (G4) are known before the unified diff is
// parsed, and both stay excluded from the cross-check symmetrically.
// ---------------------------------------------------------------------------

// --end-of-options MUST be the last option before the (positional) refs —
// git refuses any option, including --numstat, given after it. So it is
// appended by buildDiffArgs(), never hardcoded ahead of a variable option.
// --no-renames keeps every path in --numstat and the unified diff spelled
// identically — a detected rename would show `old => new` in --numstat but
// a plain path in "+++ b/new", breaking the exact-string match G4's binary-
// path exclusion depends on.
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--text", "--no-renames"];
function buildDiffArgs(extra: string[] = []): string[] {
  return ["diff", ...DIFF_FLAGS, ...extra, "--end-of-options", baseRef, headRef];
}

// --unified=0 is only for the PATCH call. Combined with --numstat, git also
// implies -p and prints the full patch body after the numstat summary
// (--unified/-U is itself a "generate a patch" flag) — the numstat call
// below omits it so its output stays a pure, easily-parsed summary table.
/**
 * numstat's binary verdict is itself attacker-influenceable (a `.gitattributes
 * -diff` marker makes numstat print "-" for a file that --text still shows as
 * real line content in the patch — this is F2's original attack, not a new
 * one). So a numstat "-" row is only trusted as GENUINELY binary if the
 * file's actual HEAD content backs it up (a NUL in the first 8KB, the same
 * heuristic used on the corpus side). If numstat says binary but the content
 * says otherwise, that disagreement is exactly the thing INERT exists to
 * catch — excluding the path would silently hide real, scannable text.
 */
function isActuallyBinaryAtHead(path: string): boolean | null {
  const shown = run(["git", "show", `${headRef}:${path}`], root);
  if (!shown.ok) return null; // couldn't verify — caller must not trust it either way
  const window = shown.stdout.subarray(0, Math.min(8000, shown.stdout.length));
  return window.includes(0);
}

const numstat = run(["git", ...buildDiffArgs(["--numstat"])], root);
if (!numstat.ok) {
  inert(`git diff --numstat failed — the added-line count could not be cross-checked.`);
}
const binaryPaths = new Set<string>();
let numstatAdded = 0;
for (const line of decode(numstat.stdout).split("\n")) {
  if (line.trim().length === 0) continue;
  const parts = line.split("\t");
  if (parts.length < 3) {
    inert("git diff --numstat produced an unparsable line — the added-line count could not be cross-checked.");
  }
  const addedStr = parts[0]!;
  const deletedStr = parts[1]!;
  const path = parts.slice(2).join("\t");
  if (addedStr === "-" || deletedStr === "-") {
    const actuallyBinary = isActuallyBinaryAtHead(path);
    if (actuallyBinary !== true) {
      inert(
        `git diff --numstat reported "${path}" as binary, but its HEAD content ${
          actuallyBinary === false ? "contains no NUL bytes in the first 8KB" : "could not be independently verified"
        } — refusing to trust a diff read that disagrees with itself (a .gitattributes -diff marker can force this ` +
          "false classification without changing a single byte of real content).",
      );
    }
    // G4: genuinely binary, confirmed by content. Excluded from the numeric
    // cross-check on both sides — never silently folded into "clean," always
    // counted below.
    binaryPaths.add(path);
    continue;
  }
  const added = Number.parseInt(addedStr, 10);
  if (!Number.isInteger(added)) {
    inert("git diff --numstat produced a non-numeric added-line count — cannot trust the cross-check.");
  }
  numstatAdded += added;
}

const diff = run(["git", ...buildDiffArgs(["--unified=0"])], root);
if (!diff.ok) {
  inert(`git diff failed — the diff could not be read.`);
}
const { runs: addedRuns, plusLineCount } = extractAddedRuns(decode(diff.stdout), binaryPaths);

if (numstatAdded !== plusLineCount) {
  inert(
    `added-line count mismatch (after excluding ${binaryPaths.size} binary file(s) from both sides): the unified ` +
      `diff parsed ${plusLineCount} added line(s), --numstat reports ${numstatAdded} — refusing to trust a diff ` +
      "read that disagrees with itself.",
  );
}

const allShingles = runsToShingles(addedRuns, shingleSize);

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
    // an ABSENT file is not a MALFORMED one, and this is the one git-read
    // failure in this tool that is deliberately not INERT.
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
  if (corpusHas(shingle)) rawMatches.push(shingle);
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
  if (!corpusHas(entry.shingle)) staleEntries.push(entry);
}

// ---------------------------------------------------------------------------
// Report — shingle text and counts only. Never a corpus path or line.
// ---------------------------------------------------------------------------

console.log(`corpus-overlap: ${allShingles.size} shingle(s) drawn from ${plusLineCount} added line(s).`);
if (binaryPaths.size > 0) {
  // Named, not just counted — these paths are from the PUBLIC PR under
  // scan, never the corpus, so naming them is safe and is what makes "not
  // scanned" actually actionable: a reviewer who sees a *.txt or *.js path
  // in this list, not an image, knows to look at it by hand.
  console.log(`corpus-overlap: ${binaryPaths.size} binary file(s) not scanned:`);
  for (const path of binaryPaths) {
    console.log(`  - ${path}`);
  }
}
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
