#!/usr/bin/env bun
/**
 * corpus-overlap.ts — Scan a diff's added lines for 6-word-shingle overlap with a
 * private corpus, without ever revealing where in that corpus a hit lives.
 *
 * Usage:
 *   bun engine/validators/corpus-overlap.ts \
 *     --corpus <path> --base <ref> --head <ref> \
 *     [--n <k>] [--benign <file>]
 *
 *   --corpus <path>   A git checkout of the private corpus. Read only, via
 *                     `git -C <path> grep`/`git -C <path> ls-files` — this tool
 *                     never writes to it and never reads it with the filesystem
 *                     directly (so .gitignore'd and untracked-but-ignored junk
 *                     stays out of both the control and the search).
 *   --base <ref>      The diff base, in THIS (the consuming) repo.
 *   --head <ref>      The diff head, in THIS repo. Together with --base, this
 *                     defines "added lines" the same way a PR review would:
 *                     `git diff <base> <head>`.
 *   --n <k>           Shingle size in whitespace-delimited words. Default 6 —
 *                     the size builders already use by hand (see #32).
 *   --benign <file>   The reviewed-benign list, relative to the repo root.
 *                     Default: .corpus-overlap-benign.yaml. ALWAYS loaded from
 *                     --base, never --head (mirrors sops/confidentiality-gate.md
 *                     §4b: no allowlist addition in the same PR as the match).
 *
 * WHY A CONTROL SHINGLE (and why its failure is INERT, not clean):
 * A private corpus this tool can't actually search — wrong path, empty
 * checkout, git failure — would otherwise report zero matches, which looks
 * identical to "checked, and it's clean." Before searching the diff, the tool
 * draws a shingle FROM THE CORPUS ITSELF (a real n-word run out of a tracked
 * file) and confirms `git grep` can find it there. If it can't, the run is
 * INERT (exit 2): the search was never proven capable of finding anything,
 * so a clean result would be a false negative wearing a green light.
 *
 * NEVER-LEAK RULE: the corpus is private. This tool's output may name a
 * shingle (words that came from the DIFF, i.e. from the public PR itself —
 * never from the corpus) and may report counts, but it never prints a corpus
 * path, a corpus filename, or a corpus line number. The control shingle
 * itself — the one text fragment this process reads OUT of the corpus — is
 * never printed either, for the same reason operator patterns are withheld
 * in leak-check.ts: it is corpus content, and the corpus is private.
 *
 * THE BENIGN LIST (.corpus-overlap-benign.yaml, in the CONSUMING repo, public):
 *   - term: "display: flex; flex-direction: column;"
 *     reason: "generic CSS reset — collides by coincidence, not by leak"
 *     reviewed_by: "octocat"
 *     date: "2026-09-23"
 * `reason` is mandatory — an entry without one does not honour the match (it's
 * treated as absent, same failure mode as leak-check's unjustified `gate:allow`).
 * The file is loaded from --base ONLY: an entry a PR adds to excuse its own
 * match is invisible to that PR's run, by construction, not by review.
 *
 * Exit codes: 0 = no unreviewed matches. 1 = unreviewed matches. 2 = INERT
 * (control shingle not found in the corpus) or a usage/configuration error.
 */

import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const EXIT_CLEAN = 0;
const EXIT_MATCHES = 1;
// Usage errors and an INERT run (control shingle not found) share exit code 2
// by design (see #32) — both mean "this result cannot be trusted as a real
// scan," they're just named separately here for a readable call site.
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

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

function run(cmd: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(cmd, { cwd });
  return {
    ok: (proc.exitCode ?? 1) === 0,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

/** Fixed-string presence check against the corpus working tree. Never returns match content. */
function corpusContains(shingle: string): boolean {
  const r = run(["git", "-C", corpusPath, "grep", "-q", "-F", "--", shingle], corpusPath);
  return r.ok;
}

// ---------------------------------------------------------------------------
// Shingling
// ---------------------------------------------------------------------------

/** Whitespace-delimited n-word windows out of a single line of text. */
function shingles(line: string, n: number): string[] {
  const words = line.split(/\s+/).filter((w) => w.length > 0);
  const out: string[] = [];
  for (let i = 0; i + n <= words.length; i++) {
    out.push(words.slice(i, i + n).join(" "));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Control: prove the corpus search can find a real match, before trusting a
// clean result on the diff. Read only via git; nothing sourced here is ever
// printed, because it is corpus content.
// ---------------------------------------------------------------------------

function findControlShingle(): string | null {
  const listed = run(["git", "-C", corpusPath, "ls-files"], corpusPath);
  if (!listed.ok) return null;
  const files = listed.stdout.split("\n").filter((f) => f.length > 0);

  for (const file of files) {
    const shown = run(["git", "-C", corpusPath, "show", `HEAD:${file}`], corpusPath);
    if (!shown.ok) continue; // unborn HEAD, or the path isn't in HEAD — try the next file
    for (const line of shown.stdout.split(/\r?\n/)) {
      const candidates = shingles(line, shingleSize);
      if (candidates.length > 0) return candidates[0]!;
    }
  }
  return null;
}

const controlShingle = findControlShingle();
if (controlShingle === null || !corpusContains(controlShingle)) {
  inert(
    "could not draw a control shingle from the corpus (no commit, no tracked file, or no line with " +
      `${shingleSize} words) — the search was never proven capable of finding a match, so a clean result would be meaningless.`,
  );
}

// ---------------------------------------------------------------------------
// The diff: added lines between --base and --head, in THIS repo.
// ---------------------------------------------------------------------------

const repoRoot = run(["git", "rev-parse", "--show-toplevel"], process.cwd());
if (!repoRoot.ok) {
  usageError("must be run inside a git repository (git rev-parse --show-toplevel failed).");
}
const root = repoRoot.stdout.trim();

const diff = run(["git", "diff", "--no-color", "--unified=0", `${baseRef}`, `${headRef}`], root);
if (!diff.ok) {
  usageError(`git diff ${baseRef} ${headRef} failed: ${diff.stderr.trim()}`);
}

const resolvedBenignPath = resolve(root, benignFile);

function addedLines(diffText: string): string[] {
  const lines: string[] = [];
  let currentFile = "";
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      currentFile = p === "/dev/null" ? "" : p.replace(/^b\//, "");
      continue;
    }
    if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
    // The benign list itself legitimately contains every reviewed shingle
    // text; scanning its own additions would self-flag on every entry.
    if (currentFile && resolve(root, currentFile) === resolvedBenignPath) continue;
    lines.push(raw.slice(1));
  }
  return lines;
}

const diffAddedLines = addedLines(diff.stdout);

const allShingles = new Set<string>();
for (const line of diffAddedLines) {
  for (const s of shingles(line, shingleSize)) allShingles.add(s);
}

// ---------------------------------------------------------------------------
// The benign list — loaded from --base, never --head.
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
    // added at head. Either way: nothing is honoured this run. Not fatal.
    return [];
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(shown.stdout);
  } catch (err) {
    console.error(`corpus-overlap: ${benignFile} at ${baseRef} is not valid YAML (${(err as Error).message}).`);
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: BenignEntry[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const shingle = (raw as Record<string, unknown>).shingle;
    const reason = (raw as Record<string, unknown>).reason;
    if (typeof shingle !== "string" || shingle.length === 0) continue;
    if (typeof reason !== "string" || reason.trim().length === 0) {
      console.error(
        `corpus-overlap: ${benignFile} entry for a shingle is missing a mandatory reason — treated as absent.`,
      );
      continue;
    }
    entries.push({
      shingle,
      reason,
      reviewed_by: typeof (raw as Record<string, unknown>).reviewed_by === "string"
        ? ((raw as Record<string, unknown>).reviewed_by as string)
        : undefined,
      date: typeof (raw as Record<string, unknown>).date === "string"
        ? ((raw as Record<string, unknown>).date as string)
        : undefined,
    });
  }
  return entries;
}

const benignEntries = loadBenignList();
const benignByShingle = new Map<string, BenignEntry>();
for (const entry of benignEntries) benignByShingle.set(entry.shingle, entry);

// ---------------------------------------------------------------------------
// Search: which diff shingles land in the corpus?
// ---------------------------------------------------------------------------

const rawMatches: string[] = [];
for (const shingle of allShingles) {
  if (corpusContains(shingle)) rawMatches.push(shingle);
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
  if (!corpusContains(entry.shingle)) staleEntries.push(entry);
}

// ---------------------------------------------------------------------------
// Report — shingle text and counts only. Never a corpus path or line.
// ---------------------------------------------------------------------------

console.log(`corpus-overlap: ${allShingles.size} shingle(s) drawn from ${diffAddedLines.length} added line(s).`);
console.log(`corpus-overlap: ${rawMatches.length} match(es) against the corpus, ${honoured.length} honoured.`);

if (staleEntries.length > 0) {
  console.log(`corpus-overlap: ${staleEntries.length} benign entr${staleEntries.length === 1 ? "y" : "ies"} stale (no longer matches the corpus):`);
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
