#!/usr/bin/env bun
/**
 * pin-check.ts — refuse a PR that changes the governance engine pin unless it
 * carries the `pin-bump` label.
 *
 * Addresses the-metafactory/compass-core#41, ruling item 2 (Andreas,
 * 2026-09-24): "A separate check refuses any PR that changes the pin unless
 * it carries a label; such PRs are admin-merged after review."
 *
 * ## What "the pin" means
 *
 * Two literal locations, both compared BASE (main) vs HEAD (the PR):
 *   1. `ref:` on the compass-core engine checkout step in
 *      `.github/workflows/compass-governance.yml` (or, in a rendered consumer
 *      copy, the same file at the same path) — the 40-hex commit SHA the
 *      compass-core engine is checked out at.
 *   2. `const ENGINE_REF = "...";` in `engine/install.ts` — the value the
 *      installer renders into (1) for every consumer. Present only in
 *      compass-core's own tree; a consumer repo never carries install.ts, and
 *      this check quietly skips that half when the file is absent on BOTH
 *      sides (see evaluatePinChange).
 *
 * Either one changing, alone or together, is "a pin change". `--label`
 * decides whether that is refused.
 *
 * ## Why this is pure-function-first
 *
 * The workflow step that actually runs this (see
 * templates/workflows/compass-governance.yml and the mirrored
 * .github/workflows/compass-governance.yml) implements the same extraction
 * and decision directly in shell, NOT by invoking this file. That is
 * deliberate, not an oversight: this repo's OWN pin (ENGINE_REF) cannot yet
 * point at a commit that includes this file at the moment it is introduced —
 * a pin must name an already-merged commit (engine-ref.test.ts enforces
 * that), and a file this PR adds cannot be merged before it is added. Rather
 * than let that bootstrapping order block the template from protecting
 * consumers on day one, the RUNTIME check is a small, self-contained shell
 * script with no dependency on a pinned engine checkout; this module exists
 * so the same logic is written once, is unit-tested (see
 * __tests__/pin-check.test.ts, which drives it directly — no workflow, no
 * shell, no CI needed to exercise it), and is available as
 * `bun engine/validators/pin-check.ts` for anyone who wants to run it by
 * hand, from a full compass-core checkout, against two working trees.
 *
 * Usage (CLI):
 *   bun engine/validators/pin-check.ts \
 *     --base-workflow <path> --head-workflow <path> \
 *     [--base-install <path>] [--head-install <path>] \
 *     [--label pin-bump] [--labels <comma-separated-list>]
 *
 * Exit codes: 0 = no unlabelled pin change, 1 = refused, 2 = usage error.
 */

import { parseArgs } from "node:util";
import { existsSync, readFileSync } from "node:fs";

const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;

const USAGE = `Usage: bun engine/validators/pin-check.ts \\
  --base-workflow <path> --head-workflow <path> \\
  [--base-install <path>] [--head-install <path>] \\
  [--labels <comma-separated-list>]`;

/**
 * Extracts the 40-hex commit SHA from the compass-core engine checkout step's
 * `ref:` line. Anchored on the "compass-core pin" comment that line always
 * carries (both the template and every render of it) — see
 * templates/workflows/compass-governance.yml — so an unrelated 40-hex value
 * elsewhere in the file (an action pin, say) is never picked up by accident.
 *
 * Returns null when the file has no such line — a deleted or drastically
 * rewritten workflow. A null is treated as "the pin is gone", which
 * evaluatePinChange still reports as a change.
 */
export function extractWorkflowRef(workflowSource: string): string | null {
  const m = workflowSource.match(/ref:\s*([0-9a-f]{40})\s*#.*compass-core pin/);
  return m ? m[1]! : null;
}

/**
 * Extracts ENGINE_REF from engine/install.ts's own `const ENGINE_REF = "...";`
 * line — the exact same anchor engine-ref.test.ts uses (readEngineRef there),
 * deliberately: a comment quoting a SHA must not satisfy this either.
 */
export function extractEngineRef(installTsSource: string): string | null {
  const m = installTsSource.match(/^const ENGINE_REF = "([^"]*)";$/m);
  return m ? m[1]! : null;
}

export interface PinSnapshot {
  /** Contents of .github/workflows/compass-governance.yml (or the template). */
  workflow: string;
  /** Contents of engine/install.ts — absent in a consumer repo, which never carries it. */
  install?: string | null;
}

export interface PinChangeResult {
  changed: boolean;
  /** One entry per location that changed, human-readable, no secrets involved. */
  changes: string[];
  /** true when the PR must be refused: changed && !hasPinBumpLabel. */
  blocked: boolean;
  message: string;
}

/**
 * The decision function. Pure: no filesystem, no process, no git — every
 * fixture in __tests__/pin-check.test.ts calls this directly with literal
 * strings standing in for "the diff".
 *
 * `install` is compared only when BOTH base and head provide it. A consumer
 * repo has neither (both undefined/null) and the install.ts half is silently
 * skipped — that is correct, not a gap: a consumer never carries the file
 * this check would be comparing, and the workflow-ref half already covers
 * the one pin a consumer's own tree can change. If exactly one side has it
 * (e.g. a PR that deletes engine/install.ts, or a rendered template that
 * never had it to begin with but somehow gained one), that asymmetry itself
 * counts as a change, on the same "silently missing is not the same as
 * silently unchanged" principle the rest of this codebase uses.
 */
export function evaluatePinChange(
  base: PinSnapshot,
  head: PinSnapshot,
  hasPinBumpLabel: boolean,
): PinChangeResult {
  const changes: string[] = [];

  const baseWorkflowRef = extractWorkflowRef(base.workflow);
  const headWorkflowRef = extractWorkflowRef(head.workflow);
  if (baseWorkflowRef !== headWorkflowRef) {
    changes.push(
      `workflow engine pin: ${baseWorkflowRef ?? "<absent>"} -> ${headWorkflowRef ?? "<absent>"}`,
    );
  }

  const baseHasInstall = base.install !== undefined && base.install !== null;
  const headHasInstall = head.install !== undefined && head.install !== null;
  if (baseHasInstall || headHasInstall) {
    const baseEngineRef = baseHasInstall ? extractEngineRef(base.install!) : null;
    const headEngineRef = headHasInstall ? extractEngineRef(head.install!) : null;
    if (baseEngineRef !== headEngineRef) {
      changes.push(
        `engine/install.ts ENGINE_REF: ${baseEngineRef ?? "<absent>"} -> ${headEngineRef ?? "<absent>"}`,
      );
    }
  }

  const changed = changes.length > 0;
  const blocked = changed && !hasPinBumpLabel;

  const message = !changed
    ? "No pin change in this PR."
    : blocked
      ? `This PR changes the governance engine pin without the 'pin-bump' label:\n` +
        changes.map((c) => `  - ${c}`).join("\n") +
        `\nPin changes are admin-merged after review — add the 'pin-bump' label if this is a deliberate bump.`
      : `Pin change detected and labelled 'pin-bump' — OK, admin review required before merge:\n` +
        changes.map((c) => `  - ${c}`).join("\n");

  return { changed, changes, blocked, message };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readOptional(path: string | undefined): string | null {
  if (!path) return null;
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

function main(): void {
  let values: {
    "base-workflow"?: string;
    "head-workflow"?: string;
    "base-install"?: string;
    "head-install"?: string;
    labels?: string;
  };
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        "base-workflow": { type: "string" },
        "head-workflow": { type: "string" },
        "base-install": { type: "string" },
        "head-install": { type: "string" },
        labels: { type: "string" },
      },
    }));
  } catch (err) {
    console.error(`pin-check: ${(err as Error).message}`);
    console.error(USAGE);
    process.exit(EXIT_USAGE);
  }

  const baseWorkflowPath = values["base-workflow"];
  const headWorkflowPath = values["head-workflow"];
  if (!baseWorkflowPath || !headWorkflowPath) {
    console.error("pin-check: --base-workflow and --head-workflow are required.");
    console.error(USAGE);
    process.exit(EXIT_USAGE);
  }
  if (!existsSync(baseWorkflowPath) || !existsSync(headWorkflowPath)) {
    console.error(
      `pin-check: both --base-workflow and --head-workflow must exist (${baseWorkflowPath}, ${headWorkflowPath}).`,
    );
    process.exit(EXIT_USAGE);
  }

  const base: PinSnapshot = {
    workflow: readFileSync(baseWorkflowPath, "utf8"),
    install: readOptional(values["base-install"]),
  };
  const head: PinSnapshot = {
    workflow: readFileSync(headWorkflowPath, "utf8"),
    install: readOptional(values["head-install"]),
  };

  const labels = (values.labels ?? "")
    .split(",")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const hasPinBumpLabel = labels.includes("pin-bump");

  const result = evaluatePinChange(base, head, hasPinBumpLabel);
  console.log(result.message);
  process.exit(result.blocked ? EXIT_REFUSED : EXIT_OK);
}

if (import.meta.main) main();
