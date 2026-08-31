#!/usr/bin/env bun
/**
 * run-all.ts — Run every validator in engine/validators/ against a target repo + CLAUDE.md.
 * Usage: bun engine/ci/run-all.ts <repo-path> [<owner/repo>]
 *
 *   <repo-path>   Local path to the repo (must contain CLAUDE.md at root)
 *   <owner/repo>  Optional. If provided, runs label-check against this slug.
 *
 * Runs claude-md-check, label-check (when a slug is given), and leak-check.
 *
 * leak-check scans <repo-path> recursively and reads its operator patterns from
 * CONFIDENTIALITY_DENYLIST_FILE, exactly as it does under the hook and in CI. It
 * is NOT given --require-patterns here: run-all is the local convenience runner,
 * and the local posture is warn-and-continue (see .githooks/pre-commit). The CI
 * workflow template applies --require-patterns itself, where a degraded gate
 * reporting green is the greater harm.
 *
 * Exit code is the bitwise OR of all validator exit codes (0 = all pass).
 */

import { resolve, join } from "node:path";
import { existsSync } from "node:fs";

const repoPath = process.argv[2];
const ownerRepo = process.argv[3];

if (!repoPath) {
  console.error("Usage: bun engine/ci/run-all.ts <repo-path> [<owner/repo>]");
  process.exit(1);
}

const absRepo = resolve(repoPath);
if (!existsSync(absRepo)) {
  console.error(`Repo path not found: ${absRepo}`);
  process.exit(1);
}

const claudeMd = join(absRepo, "CLAUDE.md");
let combinedExit = 0;

console.log(`Running compass-core validators against ${absRepo}\n`);

// Validator: claude-md-check
if (existsSync(claudeMd)) {
  console.log("→ claude-md-check");
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "validators", "claude-md-check.ts"), claudeMd], {
    stdout: "inherit",
    stderr: "inherit",
  });
  combinedExit |= r.exitCode ?? 1;
} else {
  console.error(`! CLAUDE.md not found at ${claudeMd} — skipping claude-md-check`);
  combinedExit |= 1;
}

// Validator: label-check (only if owner/repo provided)
if (ownerRepo) {
  console.log("\n→ label-check");
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "validators", "label-check.ts"), ownerRepo], {
    stdout: "inherit",
    stderr: "inherit",
  });
  combinedExit |= r.exitCode ?? 1;
} else {
  console.log("\n(skipping label-check — no owner/repo argument provided)");
}

// Validator: leak-check — scans the repo tree for credential shapes and any
// operator patterns. Added after the two above; their behaviour is unchanged.
console.log("\n→ leak-check");
{
  const r = Bun.spawnSync(
    ["bun", join(import.meta.dir, "..", "validators", "leak-check.ts"), absRepo],
    { stdout: "inherit", stderr: "inherit" },
  );
  combinedExit |= r.exitCode ?? 1;
}

console.log(`\nDone. Combined exit code: ${combinedExit}`);
process.exit(combinedExit);
