#!/usr/bin/env bun
/**
 * pin-check.ts — refuse a PR that changes the governance engine pin unless it
 * carries the `pin-bump` label.
 *
 * Addresses the-metafactory/compass-core#41, ruling item 2 (Andreas,
 * 2026-09-24): "A separate check refuses any PR that changes the pin unless
 * it carries a label; such PRs are admin-merged after review."
 *
 * ## The rule is PATH-based, not text-based (PR #52 review, F1)
 *
 * A first cut of this file parsed the pin's VALUE out of the workflow and
 * install.ts by regex and compared the two values. That is evadable by any
 * edit that leaves the anchored line alone while changing what actually
 * takes effect: a decoy line commented out beside a live one with no anchor
 * comment, a second `actions/checkout` of the engine at a different ref
 * added after the pinned one, `git checkout <sha>` spliced into a `run:`
 * line, a second `ENGINE_REF`-shaped constant that shadows the real one at
 * render time, or — the sharpest case — deleting the pin-check JOB itself
 * while leaving the ref line completely untouched, which a value-comparison
 * check has no way to even notice. All of these were demonstrated live
 * against the text-based version (PR #52 review, F1): 5 of 6 fixtures
 * evaded it outright, unlabelled.
 *
 * The fix does not try to out-parse every such trick. It asks a different,
 * unevadable question: did this diff touch the FILE at all? Any change to
 *   - `.github/workflows/compass-governance.yml`
 *   - `templates/workflows/compass-governance.yml`
 *   - `engine/install.ts`
 * requires the `pin-bump` label — full stop, regardless of what changed
 * inside. That can't be evaded from inside the file (there is no "inside"
 * to hide in once the check is "was this path touched"), and it catches the
 * pin-check job's own deletion for the same reason: removing a job IS an
 * edit to the workflow file.
 *
 * `--no-renames` in the diff this reads means a rename shows up as a
 * delete-and-add pair — both the old and the new path appear in the
 * changed-path list — so a rename of any watched path is caught too, same
 * as leak-check's own diff already relies on for the same reason.
 *
 * ## Why this is pure-function-first
 *
 * evaluatePinChange takes the already-computed list of changed paths, not a
 * git ref or a working tree — every fixture in __tests__/pin-check.test.ts
 * calls it directly with a literal array standing in for "the diff", no
 * git, no filesystem, no CI needed to exercise it.
 *
 * The workflow step that actually runs this (see
 * templates/workflows/compass-governance.yml and the mirrored
 * .github/workflows/compass-governance.yml) implements the same
 * path-membership check directly in shell, NOT by invoking this file. That
 * is deliberate, not an oversight: this repo's OWN pin (ENGINE_REF) cannot
 * yet point at a commit that includes this file at the moment it is
 * introduced — a pin must name an already-merged commit
 * (engine-ref.test.ts enforces that), and a file this PR adds cannot be
 * merged before it is added. `bun engine/validators/pin-check.ts` is
 * available for anyone who wants to run the same check by hand, from a full
 * compass-core checkout, against two commits.
 *
 * Usage (CLI):
 *   bun engine/validators/pin-check.ts \
 *     --base-sha <sha> --head-sha <sha> \
 *     [--labels <comma-separated-list>] [--cwd <path>]
 *
 * Runs `git diff --no-renames --name-only <base>...<head>` in `--cwd`
 * (default: the current directory, which must be a git repo containing both
 * commits) and decides from the result.
 *
 * Exit codes: 0 = no unlabelled pin change, 1 = refused, 2 = usage error.
 */

import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";

const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;

const USAGE = `Usage: bun engine/validators/pin-check.ts \\
  --base-sha <sha> --head-sha <sha> \\
  [--labels <comma-separated-list>] [--cwd <path>]`;

/**
 * The exact set of paths a diff touching any of them requires `pin-bump`
 * for. Repo-relative, POSIX separators — the shape `git diff --name-only`
 * reports paths in, and the exact shape the workflow's own shell
 * implementation compares against (kept identical on purpose: see that
 * step's own comment for why this is not invoked from there directly).
 */
export const PIN_SENSITIVE_PATHS = [
  ".github/workflows/compass-governance.yml",
  "templates/workflows/compass-governance.yml",
  "engine/install.ts",
] as const;

export interface PinChangeResult {
  changed: boolean;
  /** The subset of PIN_SENSITIVE_PATHS this diff actually touched. */
  changedPaths: string[];
  /** true when the PR must be refused: changed && !hasPinBumpLabel. */
  blocked: boolean;
  message: string;
}

/**
 * The decision function. Pure: takes the diff's changed-path list (as
 * `git diff --no-renames --name-only` would print it — one path per
 * element, repo-relative) and the PR's current label state; returns
 * whether it's a pin change and whether that's refused.
 */
export function evaluatePinChange(changedPaths: string[], hasPinBumpLabel: boolean): PinChangeResult {
  const changed = new Set(changedPaths);
  const hit = PIN_SENSITIVE_PATHS.filter((p) => changed.has(p));

  const isChanged = hit.length > 0;
  const blocked = isChanged && !hasPinBumpLabel;

  const message = !isChanged
    ? "No pin-sensitive path changed in this PR."
    : blocked
      ? `This PR touches a pin-sensitive path without the 'pin-bump' label:\n` +
        hit.map((p) => `  - ${p}`).join("\n") +
        `\nPin changes are admin-merged after review — add the 'pin-bump' label to this PR; that will re-run this check.`
      : `Pin-sensitive path(s) changed and this PR is labelled 'pin-bump' — OK, admin review required before merge:\n` +
        hit.map((p) => `  - ${p}`).join("\n");

  return { changed: isChanged, changedPaths: hit, blocked, message };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Runs `git diff --no-renames --name-only <base>...<head>` and returns the
 * changed paths, one per line, repo-relative. `--no-renames` deliberately —
 * see the file header: a rename of a watched path must surface as both its
 * old and new name, not collapse into an `R` entry evaluatePinChange never
 * sees.
 */
export function computeChangedPaths(baseSha: string, headSha: string, cwd: string): string[] {
  const proc = spawnSync(
    "git",
    ["diff", "--no-renames", "--name-only", `${baseSha}...${headSha}`],
    { cwd, encoding: "utf8" },
  );
  if (proc.status !== 0) {
    throw new Error(
      `git diff --no-renames --name-only ${baseSha}...${headSha} failed (exit ${proc.status}): ${proc.stderr}`,
    );
  }
  return proc.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

function main(): void {
  let values: {
    "base-sha"?: string;
    "head-sha"?: string;
    labels?: string;
    cwd?: string;
  };
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        "base-sha": { type: "string" },
        "head-sha": { type: "string" },
        labels: { type: "string" },
        cwd: { type: "string" },
      },
    }));
  } catch (err) {
    console.error(`pin-check: ${(err as Error).message}`);
    console.error(USAGE);
    process.exit(EXIT_USAGE);
  }

  const baseSha = values["base-sha"];
  const headSha = values["head-sha"];
  if (!baseSha || !headSha) {
    console.error("pin-check: --base-sha and --head-sha are required.");
    console.error(USAGE);
    process.exit(EXIT_USAGE);
  }

  let changedPaths: string[];
  try {
    changedPaths = computeChangedPaths(baseSha, headSha, values.cwd ?? process.cwd());
  } catch (err) {
    console.error(`pin-check: ${(err as Error).message}`);
    process.exit(EXIT_USAGE);
  }

  const labels = (values.labels ?? "")
    .split(",")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const hasPinBumpLabel = labels.includes("pin-bump");

  const result = evaluatePinChange(changedPaths, hasPinBumpLabel);
  console.log(result.message);
  process.exit(result.blocked ? EXIT_REFUSED : EXIT_OK);
}

if (import.meta.main) main();
