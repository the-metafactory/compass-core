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
 *                     blob in the TIP TREE of every local branch, remote-
 *                     tracking branch, and tag (deduplicated by content),
 *                     plus HEAD's own tip tree. "HEAD" restricts it to HEAD's
 *                     tip tree only — narrower, correspondingly less
 *                     coverage; see SCOPE. Neither mode walks history: a
 *                     commit's tree at the moment it was HEAD-of-some-ref is
 *                     read, not every tree it and its ancestors ever had.
 *
 * SCOPE — WHAT IS AND ISN'T SEARCHED, PRINTED ON EVERY RUN:
 * The corpus's blobs are read once, deduplicated by content (git object id),
 * from the TIP TREE of every ref this run resolves (all branches/remotes/
 * tags by default, or HEAD alone with --refs HEAD) — "tip tree," not "every
 * reachable blob": git's own sense of "reachable" includes history, and this
 * tool does not walk it (see OUT OF SCOPE below). The first output line
 * reports what that amounted to: refs searched, unique paths reachable in
 * those tip trees, unique blobs actually fetched, total bytes fetched
 * (searched and not — see BINARY below), and three "not searched" counts
 * that are NEVER folded silently into a clean result:
 *   - gitlinks/submodules: `ls-tree` entries of type `commit` point at a
 *     separate repository this tool does not follow. Counted, never searched.
 *   - binary corpus blobs: content with a NUL in its first 8KB (mirrors
 *     leak-check.ts's binary heuristic). Counted, never shingled. (This
 *     heuristic applies to the CORPUS side only — see BINARY FILES IN THE
 *     DIFF below for why the diff side does not use one at all.)
 *   - UTF-16 blobs (LE or BE, detected by BOM) ARE decoded and searched —
 *     they're counted separately in the scope line, but they count toward
 *     "blobs read," not toward "not searched." A UTF-16 file with no BOM,
 *     or any other multi-byte encoding, is indistinguishable from binary to
 *     the NUL heuristic and is counted as binary.
 * OUT OF SCOPE ENTIRELY, not counted because this tool has no way to see it:
 *   - the corpus checkout's UNCOMMITTED working tree or index (only
 *     committed, ref-tip content is ever read);
 *   - HISTORY: text that exists only in an older commit — not at any current
 *     ref's tip — is not searched, by the "tip tree only" design above;
 *   - `refs/stash`: for-each-ref is given refs/heads, refs/remotes, and
 *     refs/tags explicitly, and a stash is none of those;
 *   - Git LFS pointer files (the pointer text is searched like any blob, but
 *     the real content LFS defers to is never fetched or read).
 *
 * THE SEARCH IS A LOOKUP, NOT ONE GREP PER SHINGLE.
 * Every corpus blob's content is normalised and broken into an in-memory
 * Map<string, count> of every n-word shingle the corpus contains — patterns
 * and paths never touch a subprocess's argv, only `cat-file --batch`'s
 * stdin. The diff's added lines go through the same normalisation and
 * windowing, and matching is a lookup (`corpusHas`) through `findMatches`
 * (shared with the control — see below). This has no per-shingle process-
 * spawn cost, no argv size limit (an oversized added "word" — a minified
 * bundle, a data: URI — cannot crash a spawn call the way it could when
 * each shingle went through argv to a `git grep` subprocess), and it
 * naturally tolerates whitespace differences on both sides, because both
 * sides are normalised before either is a lookup key.
 *
 * NORMALISATION: every run of whitespace — spaces, tabs, newlines, carriage
 * returns, and U+00A0 (non-breaking space, already inside JavaScript's `\s`
 * class) — collapses to a single space before either side is shingled, and
 * a fixed set of non-whitespace characters is stripped outright: zero-width
 * characters (U+200B–U+200D, U+FEFF — `\s` does not treat them as
 * whitespace, and left alone one sitting mid-word would silently split a
 * shingle that reads as one word to a human) and NUL (U+0000 — round 4's
 * H1: a NUL glued directly onto a word is not whitespace either, and left
 * in place it turns that word into a token that will never equal the clean
 * version, a single byte silently defeating the match). This is what lets
 * the tool catch text reflowed across lines, re-indented, or pasted with a
 * different line-wrap: byte-for-byte matching could not, and that was a
 * regression from the hand-rolled method this tool replaces. On the corpus
 * side, normalising per FILE (not per line) also means a shingle split
 * across two lines in the corpus is still a corpus shingle. On the diff
 * side, normalising per HUNK (not per added line) means a shingle split
 * across two adjacent added lines in one hunk is still caught — see
 * `extractAddedRuns`.
 *
 * WHY THE CONTROL EXERCISES THE DIFF-SIDE PATH, NOT THE CORPUS ITSELF:
 * a control that just asks "is the corpus's own shingle set non-empty" can
 * never fail once the corpus has been read at all — it says nothing about
 * whether the DIFF side would actually find something real. So the control
 * draws a raw (pre-normalisation) fragment out of one corpus blob and
 * injects it as one more element of `addedRuns` — the SAME array the real
 * diff's shingles come from, not a parallel computation — before the shared
 * `runsToShingles()` and `findMatches()` calls run (round 4: this closes the
 * "wiring" gaps a round-3 review found — the search loop and the specific
 * assignment that builds the diff's shingle set were not previously
 * exercised by the control at all). Provenance (control-only vs. genuinely
 * present in the diff) is tracked by COUNT, not by excluding the control's
 * shingle value from the result: a real match that happens to equal the
 * exact text the control drew must still be reported, and a naive "not
 * equal to the control shingle" filter would silently drop it — see
 * `fromRealDiff`. If the control's own shingle produces no match at all,
 * the run is INERT: not "the corpus is unreadable" specifically, but "the
 * diff-side pipeline and the corpus's own index disagree about the exact
 * same text," which is the observable symptom of a broken lookup, a
 * normalisation step that silently stopped running, or the corpus and diff
 * sides drifting out of sync — none of which a self-referential check
 * could ever catch.
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
 * driver, no textconv filter, and every file forced to text mode regardless
 * of a `.gitattributes -diff` marker. `--no-renames` means a move/rename is
 * a delete (old path) plus an add (new path), each scanned independently and
 * normally (H2, round 4) — with rename detection on, a moved binary file's
 * old path vanishes into a single R(ename) record that this tool does not
 * specially parse, so treating every changed path as its own add or delete
 * is what keeps ordinary asset reshuffling from going INERT. The parsed
 * added-line count is cross-checked against a separate `git diff --numstat`
 * run (same flags): any disagreement not explained by a binary file (see
 * BINARY FILES IN THE DIFF) is INERT. IMPORTANT — this does NOT mean a NUL
 * byte, or any other content shape, can make the tool treat a file as unseen:
 * see the next section for what "explained by a binary file" actually covers,
 * and why it is narrower than that.
 *
 * BINARY FILES IN THE DIFF (not the corpus — see SCOPE above for that; and
 * NOT a content-based exemption — see H1 below): a file `--numstat` reports
 * as binary (`-` for both counts, which `--text` does not prevent for every
 * case) is excluded from the added-line cross-check ONLY — counted AND
 * NAMED (the path is from the public PR, never the corpus, so naming it is
 * safe) as "N binary file(s) excluded from the line-count cross-check."
 * Every file's '+' lines, binary-flagged or not, are still turned into runs
 * and shingled exactly the same way — see extractAddedRuns and H1 below.
 * numstat and the full patch can list a path differently when it needs
 * quoting (a tab, a literal quote, a non-ASCII byte): numstat with `-z`
 * gives it raw, the patch's "+++ " header still quotes it, and there is no
 * flag that makes the two agree on one string. So a binary file's exclusion
 * from the cross-check is correlated by POSITION (both list changed files in
 * the same order for the same base/head/flags) rather than by path string —
 * see the comment on `fileOrder` in extractAddedRuns.
 *
 * H1 (round 4): round 3 also required a numstat-binary verdict to be backed
 * up by the file's actual HEAD content (a NUL in its first 8KB) before
 * trusting it, and went INERT on any file where that check disagreed with
 * numstat. That content check is REMOVED, not tightened: a single NUL byte
 * anywhere in an otherwise-ordinary text file made the ENTIRE file invisible
 * to the search under that design — exactly the "one byte past the
 * detector" pattern a private-corpus scrub exists to catch, not produce. The
 * fix is not a better binary check; it's making sure nothing but the
 * numeric cross-check depends on the answer to "is this binary" at all. A
 * `.gitattributes -diff` marker attempting the same trick — making numstat
 * call a real text file binary — now simply fails to hide anything, because
 * the file is scanned regardless of what numstat says about it.
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
 * space. Two further, DIFFERENT corrections happen alongside that:
 *   - U+200B (zero-width space), U+200C/U+200D (joiners), U+FEFF (zero-width
 *     no-break space / BOM) are STRIPPED OUTRIGHT (replaced with nothing) —
 *     invisible, and `\s` does not treat them as whitespace, so left alone
 *     one sitting mid-word would split what a human reads as one word into
 *     two shingle tokens.
 *   - U+0000 (NUL) is TREATED AS WHITESPACE (replaced with a space, then
 *     folded into the same collapse as real whitespace) — round 4's H1
 *     finding was that leaving a NUL glued onto a word ("\0The") corrupted
 *     the token into one that would never equal "The"; round 5's follow-up
 *     is that NUL must not be stripped OUTRIGHT the way the zero-width
 *     characters are, because a PR could then use it as a space substitute
 *     to defeat the match on purpose ("mike\0november" stripped to nothing
 *     becomes "mikenovember", ONE word, not two — exactly as hidden from a
 *     6-word shingle window as if the space had never been removed at all).
 *     Mapping it to a real separator instead keeps the words apart either
 *     way. (This is a word-SHINGLE limit, not fixed by this mapping alone:
 *     any OTHER non-whitespace separator a PR substitutes for a space — not
 *     just NUL — has the same defeating effect and isn't stripped here,
 *     because there is no fixed, safe set of "characters nobody's real text
 *     ever uses as a separator" to add to. NUL costs nothing to fix and
 *     closes the version of this that is hardest for a reviewer to see.)
 */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\u0000/g, " ")
    .replace(/[​-‍﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
// Counts, not a Set: the control (below) is injected as one more run
// alongside the real diff's runs, in the SAME call, so a shingle that is
// genuinely present in the diff AND happens to equal the control's own
// fragment must still be reportable — a plain Set would collapse the two
// occurrences into one and there would be no way to tell them apart. The
// count says whether a shingle's presence is explained ENTIRELY by the
// control (never reported — it's corpus content) or partly/wholly by the
// diff's own runs (reportable — it's the PR's own content).
//
// Also returns `wordCount`, the exact word total of whatever `runs` THIS
// CALL actually processed (round 6, K1/word-count fix) — not a count
// maintained in a separate variable elsewhere, which a mutation could leave
// correct while changing what's actually passed to a *different* call. The
// caller compares this against an independently-captured expectation
// (`plusWordCount`, from extractAddedRuns) immediately after the call that
// produces the shingle set actually used for matching, so a bypass of that
// specific call — not just a narrowing of the array feeding it — is caught.
function runsToShingles(runs: string[], n: number): { shingles: Map<string, number>; wordCount: number } {
  const shingles = new Map<string, number>();
  let wordCount = 0;
  for (const r of runs) {
    const normalized = normalizeWhitespace(r);
    if (normalized.length > 0) wordCount += normalized.split(" ").length;
    for (const s of shingleWindows(normalized, n)) {
      shingles.set(s, (shingles.get(s) ?? 0) + 1);
    }
  }
  return { shingles, wordCount };
}

/**
 * Runs of added ('+') lines within one diff hunk, joined before normalising —
 * so a shingle split across two adjacent added lines is still caught.
 *
 * PARSED STRUCTURALLY, NOT BY LINE PREFIX (round 5, J1). A round-4 version of
 * this function decided "is this line a file header" by checking whether the
 * RAW LINE started with "+++ " or "--- ", wherever that line appeared. That
 * is ambiguous: an ADDED line whose own content is `++ <text>` renders as
 * `+++ <text>` — three literal plus signs, a space, then the text — which is
 * byte-for-byte indistinguishable from a genuine "+++ b/path" header by text
 * alone. A PR could exploit this: plant `++ <the phrase>` as an added line,
 * pair it with a change that has a --numstat row but NO "+++ " line at all
 * (an empty new file, a mode-only change) so the file-count cross-check
 * still balances, and the planted line vanishes as a phantom "file header"
 * instead of being scanned — silent, exit 0.
 *
 * The fix tracks where in the patch's OWN STRUCTURE we are, not what a line
 * merely looks like:
 *   - `diff --git ` ALWAYS starts a new section, exactly one per changed
 *     path — the only line this function treats as a section boundary. This
 *     line is unprefixed, synthesised by git, and never confusable with
 *     added content (which always carries its own '+'/'-' prefix).
 *   - Each section has a HEADER REGION, from `diff --git ` up to (but not
 *     including) that section's own FIRST "@@ ...@@" hunk header. "+++ ",
 *     "--- ", "index ", "old/new mode ", "similarity index ", "rename
 *     from/to " — none of these can legitimately appear anywhere else, and
 *     NOTHING in this region is ever turned into a run.
 *   - Once a section's first "@@ " line is seen, header parsing for that
 *     section is over for good — "+++ "/"--- " are simply never checked for
 *     again until the NEXT `diff --git ` line. Inside a hunk, a line
 *     starting with '+' is unconditionally content, whatever follows the
 *     '+': there is no longer a competing interpretation for it to be
 *     confused with. A later "@@ " line just starts the section's next hunk.
 *   - Some changes have a --numstat row but NO hunk at all (an empty new
 *     file, a mode-only change) — their section still gets exactly one
 *     `fileOrder` entry, left at 0 (round 5, J2: these used to make
 *     `fileOrder` shorter than `numstatRows`, going INERT on ordinary,
 *     harmless changes).
 *   - A file↔symlink type change is the opposite shape: it renders as TWO
 *     consecutive sections for the SAME path (delete the old type, add the
 *     new) but --numstat gives it only one row — see `lastSectionKey`,
 *     which merges them back into a single `fileOrder` entry (also J2).
 * '-' lines are skipped without breaking a run's contiguity: within one
 * hunk, the lines removed from the old side don't survive into the new
 * file, so they don't sit between the hunk's '+' lines in the result the
 * corpus might contain a leak of.
 *
 * NOTHING is exempt from being turned into runs here — not a binary file,
 * not a file numstat calls binary, not a file with a NUL anywhere in it.
 * `--text` (see buildDiffArgs) already forces every file's added bytes into
 * this same '+'-line patch format, so every file's content is scanned the
 * same way (H1, round 4): a single NUL byte, or any other content shape,
 * cannot exempt a file from the search — there is no content-based check
 * here to evade. `fileOrder` (added-line count per SECTION, in section
 * order) exists ONLY so the caller can subtract a numstat-binary-flagged
 * file's contribution back out of the numeric cross-check — never to decide
 * what gets scanned. `plusWordCount` (round 5, J3) is a running, independent
 * tally of the same content's word count, checked again by the caller right
 * before it's used, so that a later mutation reassigning `addedRuns` (or the
 * array built from it) to something smaller can be caught rather than
 * silently trusted.
 */
// `fileOrder` correlates with --numstat's rows by POSITION, not by path
// string: git always quotes a path containing a tab, a newline, a literal
// quote, or (by default) a non-ASCII byte in the FULL PATCH ("+++ " lines),
// but `--numstat -z` gives that same path raw and unquoted — there is no
// flag that makes the two agree on a shared string representation, and
// writing a full C-style path unquoter to bridge them is more risk (a buggy
// reassembly of a multi-byte-escaped path silently matching the wrong file)
// than it's worth for what is, even among binary files, a rare path shape.
// Position is unambiguous instead: `git diff` and `git diff --numstat`
// enumerate the same changed paths in the same order for the same
// (base, head, flags) — see the corpus-overlap.test.ts test that pins this
// order against a five-file mixed diff. A file whose path needed quoting is
// still correctly excluded from the cross-check; it just cannot be spelled
// out by name in the exclusion report as cleanly as an unquoted one can.
function extractAddedRuns(
  diffText: string,
): { runs: string[]; plusLineCount: number; fileOrder: number[]; plusWordCount: number } {
  const runs: string[] = [];
  const fileOrder: number[] = [];
  let current: string[] = [];
  let plusLineCount = 0;
  let plusWordCount = 0;
  // "header": between this section's `diff --git ` line and its own first
  // "@@ " line — metadata only. "hunk": past that point, where a '+' line is
  // always content. Starts "header" defensively, in case the text somehow
  // doesn't begin with a `diff --git ` line.
  let mode: "header" | "hunk" = "header";
  // A file↔symlink (or other) TYPE CHANGE renders as TWO consecutive
  // sections for the SAME path — one deleting the old type, one adding the
  // new — but --numstat gives it only ONE row. Their "diff --git a/X b/X"
  // lines are textually identical (both quoted, or not, the same way, by the
  // same git invocation — unlike matching against --numstat's own path
  // spelling, this comparison never crosses that quoting boundary). Two
  // consecutive sections sharing that exact line are merged into the same
  // `fileOrder` entry instead of starting a new one, so the count stays
  // correlated with --numstat's row count (round 5, J2).
  let lastSectionKey: string | null = null;
  const flush = () => {
    if (current.length > 0) {
      runs.push(current.join(" "));
      current = [];
    }
  };
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      flush();
      if (raw !== lastSectionKey) fileOrder.push(0); // new logical file; a repeat of the same line merges into the prior entry
      lastSectionKey = raw;
      mode = "header";
      continue;
    }
    if (mode === "header") {
      if (raw.startsWith("@@ ")) {
        mode = "hunk"; // header region for THIS section ends here, structurally — not by text shape
        flush();
        continue;
      }
      continue; // "+++ ", "--- ", "index ", mode/rename/similarity lines — never scanned
    }
    // mode === "hunk": a '+' line is unconditionally content from here on.
    if (raw.startsWith("@@ ")) {
      flush(); // this section's next hunk
      continue;
    }
    if (raw.startsWith("+")) {
      const content = raw.slice(1);
      current.push(content);
      plusLineCount++;
      plusWordCount += normalizeWhitespace(content).split(" ").filter((w) => w.length > 0).length;
      if (fileOrder.length > 0) fileOrder[fileOrder.length - 1]! += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      continue; // does not break contiguity of the surrounding '+' run
    }
    flush(); // "\ No newline at end of file", or any other non-content line
  }
  flush();
  return { runs, plusLineCount, fileOrder, plusWordCount };
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

/**
 * Which of these shingles the corpus contains. The real search and the
 * control (below) both call this SAME function on data that has been
 * combined into the SAME set — not two parallel computations that happen
 * to use the same helper. A mutation that disables this lookup, or that
 * hardcodes the real diff's shingle set to empty, breaks the control
 * identically to how it breaks the real search, because by the time this
 * runs there is no longer a "real search" and a "control" to tell apart.
 */
function findMatches(shingles: Iterable<string>, has: (shingle: string) => boolean): string[] {
  const out: string[] = [];
  for (const s of shingles) {
    if (has(s)) out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The diff: added lines between --base and --head, in THIS repo. Forced to
// text mode so the PR under scan cannot empty its own diff (F2). --numstat
// runs FIRST so binary paths (H1) are known before the unified diff is
// parsed, purely to exclude them from the numeric cross-check below — they
// are NOT excluded from scanning; see extractAddedRuns.
// ---------------------------------------------------------------------------

// --end-of-options MUST be the last option before the (positional) refs —
// git refuses any option, including --numstat, given after it. So it is
// appended by buildDiffArgs(), never hardcoded ahead of a variable option.
// --no-renames keeps every path in --numstat and the unified diff spelled
// identically — a detected rename would show `old => new` in --numstat but
// a plain path in "+++ b/new". With it, a rename is a delete (old path) plus
// an add (new path), each independently and normally scanned (H2).
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--text", "--no-renames"];
function buildDiffArgs(extra: string[] = []): string[] {
  return ["diff", ...DIFF_FLAGS, ...extra, "--end-of-options", baseRef, headRef];
}

// --unified=0 is only for the PATCH call. Combined with --numstat, git also
// implies -p and prints the full patch body after the numstat summary
// (--unified/-U is itself a "generate a patch" flag) — the numstat call
// below omits it so its output stays a pure, easily-parsed summary table.
// -z: raw, unquoted paths, NUL-separated records — needed for the ORDER
// correlation with the patch's file sections (see extractAddedRuns's comment
// on `fileOrder`), and a nicer display path when a binary file is named in
// the report below.
const numstat = run(["git", ...buildDiffArgs(["--numstat", "-z"])], root);
if (!numstat.ok) {
  inert(`git diff --numstat failed — the added-line count could not be cross-checked.`);
}
// H1: numstat's "-"/"-" (binary) verdict is used ONLY to know which files'
// added-line counts to leave out of the cross-check arithmetic below. It is
// NEVER used to decide what gets scanned — nothing does; see
// extractAddedRuns. So there is nothing here to verify or distrust: a false
// "binary" verdict (e.g. from a `.gitattributes -diff` marker) costs this
// file its place in the numeric cross-check, not its place in the search.
interface NumstatRow {
  path: string;
  isBinary: boolean;
  added: number; // 0 for a binary row; the field is meaningless there
}
const numstatRows: NumstatRow[] = [];
let numstatAdded = 0;
for (const record of decode(numstat.stdout).split("\0")) {
  if (record.length === 0) continue;
  const parts = record.split("\t");
  if (parts.length < 3) {
    inert("git diff --numstat produced an unparsable record — the added-line count could not be cross-checked.");
  }
  const addedStr = parts[0]!;
  const deletedStr = parts[1]!;
  const path = parts.slice(2).join("\t"); // a literal tab in the path is possible; only the first two fields are counts
  if (addedStr === "-" || deletedStr === "-") {
    numstatRows.push({ path, isBinary: true, added: 0 });
    continue;
  }
  const added = Number.parseInt(addedStr, 10);
  if (!Number.isInteger(added)) {
    inert("git diff --numstat produced a non-numeric added-line count — cannot trust the cross-check.");
  }
  numstatRows.push({ path, isBinary: false, added });
  numstatAdded += added;
}
const binaryPaths = new Set(numstatRows.filter((r) => r.isBinary).map((r) => r.path));

const diff = run(["git", ...buildDiffArgs(["--unified=0"])], root);
if (!diff.ok) {
  inert(`git diff failed — the diff could not be read.`);
}
const { runs: addedRuns, plusLineCount, fileOrder, plusWordCount } = extractAddedRuns(decode(diff.stdout));

// The cross-check compares like with like: numstatAdded already excludes
// binary-flagged rows (H1), so their contribution to plusLineCount (however
// many pseudo-lines --text produced for them — irrelevant to this check,
// relevant only to the search below) is subtracted out here too, correlated
// by POSITION (see extractAddedRuns's comment on `fileOrder`) rather than by
// path string. A deleted or renamed-away binary file contributes 0 either
// way (H2) — nothing to verify, nothing to go INERT over.
if (fileOrder.length !== numstatRows.length) {
  inert(
    `git diff and git diff --numstat listed a different number of changed files (${fileOrder.length} vs ` +
      `${numstatRows.length}) for the same base/head — refusing to trust a diff read that disagrees with itself.`,
  );
}
let binaryPlusLines = 0;
numstatRows.forEach((row, i) => {
  if (row.isBinary) binaryPlusLines += fileOrder[i] ?? 0;
});
const textOnlyPlusLineCount = plusLineCount - binaryPlusLines;

if (numstatAdded !== textOnlyPlusLineCount) {
  inert(
    `added-line count mismatch (after excluding ${binaryPaths.size} binary file(s) from the cross-check): the ` +
      `unified diff parsed ${textOnlyPlusLineCount} non-binary added line(s), --numstat reports ${numstatAdded} — ` +
      "refusing to trust a diff read that disagrees with itself.",
  );
}

// ---------------------------------------------------------------------------
// Control (G1): the corpus's own shingle Set can never disprove itself, so
// the control draws a raw (pre-normalisation) fragment from the corpus and
// injects it as one more element of `addedRuns` — not a parallel
// computation, THE SAME array the real diff's shingles come from — before
// the shared runsToShingles() and findMatches() calls run. This closes a
// mutation that breaks either shared function, or that breaks findMatches's
// own lookup loop. It does NOT, on its own, close a mutation that empties or
// replaces the ARRAY those functions are handed (round 5, J3 found two: the
// spread narrowed to just the control run, and `addedRuns` reassigned to `[]`
// right after extraction) — the control's own shingle is still present
// either way, since it's appended after whatever the array already holds.
// That gap is closed separately, immediately below, by an exact word-count
// re-check against `plusWordCount`, captured inside extractAddedRuns before
// any of this ran. Never printed; the control fragment is corpus content.
// ---------------------------------------------------------------------------

if (corpus.controlFragment === null) {
  inert(
    `no run of ${shingleSize} words could be found anywhere in the searched corpus content — the search was never ` +
      "proven capable of finding a match, so a clean result would be meaningless.",
  );
}

const controlRun = corpus.controlFragment;
const combinedRuns = [...addedRuns, controlRun];

// controlCounts is used only to tell provenance apart below (a bookkeeping
// read, not the security decision); allShingles — built from combinedRuns in
// ONE call — is the shared, sabotage-sensitive source of truth both the
// control's pass/fail AND the real search's matches come from.
const controlResult = runsToShingles([controlRun], shingleSize);
const controlCounts = controlResult.shingles;
const allResult = runsToShingles(combinedRuns, shingleSize);
const allShingles = allResult.shingles;
const matches = findMatches(allShingles.keys(), corpusHas);

// J3 (round 5) / K1 (round 6): plusWordCount was computed AND RETURNED by
// extractAddedRuns, before any of this ran. `allResult.wordCount` is not a
// separately-maintained variable that a mutation could leave correct while
// changing what actually reaches `runsToShingles` — it is the word count
// runsToShingles ITSELF processed to build allShingles, in the SAME call.
// So this catches not only `addedRuns` (or the spread above) being narrowed
// or reassigned, but also the call itself being bypassed in favour of a
// smaller array (e.g. `runsToShingles([controlRun], n)`) while `combinedRuns`
// is left correct and simply unused — round 5's check, based on recounting
// `combinedRuns` directly, could not see that.
const actualWordCount = allResult.wordCount - controlResult.wordCount;
if (actualWordCount !== plusWordCount) {
  inert(
    `the diff's shingle-source word count (${actualWordCount}) does not match the word count extracted from the ` +
      `patch (${plusWordCount}) — refusing to trust a diff read that disagrees with itself.`,
  );
}

if (![...controlCounts.keys()].some((s) => matches.includes(s))) {
  inert(
    "a fragment drawn from the corpus, run through the real diff-side shingling and matching path, produced no " +
      "shingle present in the corpus's own index — the search was never proven capable of finding a match.",
  );
}

// A matched shingle is genuinely from the diff (reportable — it's the PR's
// own content) if its combined count exceeds what the control run ALONE
// would have contributed. A shingle explained ENTIRELY by the injected
// control fragment (combined count equals the control's own count) is
// corpus content and is never reported — but one that ALSO happens to
// appear in the real diff (combined count is higher) still is: a Set-based
// "not equal to the control shingle" filter would have wrongly dropped that
// case, silently losing a real match that happens to coincide with whatever
// text the control drew.
function fromRealDiff(shingle: string): boolean {
  return (allShingles.get(shingle) ?? 0) > (controlCounts.get(shingle) ?? 0);
}

const rawMatches = matches.filter(fromRealDiff);

// K1 (round 6): a round-5 review found the check this replaced compared two
// quantities both derived from `fromRealDiff` over `matches` — they
// partition `matches` by definition, so they were equal for ANY predicate,
// including a broken one (forced to `false`, off by one, or with the search
// itself narrowed). It could only ever fire on a REASSIGNMENT of
// `rawMatches`, never on the filtering LOGIC being wrong. Replaced with a
// genuinely independent re-derivation: `addedRuns` ALONE (no control run
// mixed in, so no provenance arithmetic is needed at all) run through
// runsToShingles() and corpusHas() — both already exercised by the control
// above — but sharing NOTHING with `fromRealDiff`, `controlCounts`, or
// `allShingles`. `rawMatches` must equal this exactly; any disagreement
// means the shared pipeline and this independent one disagree about the
// same diff, which the control's own pass does not by itself rule out.
const expectedMatches = new Set(
  [...runsToShingles(addedRuns, shingleSize).shingles.keys()].filter((s) => corpusHas(s)),
);
const actualMatches = new Set(rawMatches);
const matchesAgree =
  actualMatches.size === expectedMatches.size && [...expectedMatches].every((s) => actualMatches.has(s));
if (!matchesAgree) {
  inert(
    "the reported matches do not agree with an independently re-derived match set — refusing to trust a result " +
      "that disagrees with itself.",
  );
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

// rawMatches (an in-memory set intersection, not a subprocess per shingle)
// was already computed above, via the SAME findMatches() call the control
// used — see "Control (G1)".

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

// allShingles has the control's own shingle(s) mixed in — count only the
// ones with real provenance in the diff, same rule as rawMatches above.
const diffShingleCount = [...allShingles.keys()].filter(fromRealDiff).length;
console.log(`corpus-overlap: ${diffShingleCount} shingle(s) drawn from ${plusLineCount} added line(s).`);
if (binaryPaths.size > 0) {
  // Named, not just counted — these paths are from the PUBLIC PR under scan,
  // never the corpus, so naming them is safe. H1: excluded from the numeric
  // cross-check only — every one of them was still scanned like any other
  // file above (there is no content-based exemption to evade).
  console.log(`corpus-overlap: ${binaryPaths.size} binary file(s) excluded from the line-count cross-check:`);
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
