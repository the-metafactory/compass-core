#!/usr/bin/env bun
/**
 * label-check.ts — Verify that a GitHub repo has all required labels per the consumer's config.
 * Usage: bun engine/validators/label-check.ts <org/repo>
 *
 * Phase A1: uses a minimal hardcoded default label list. Any consumer whose label set
 * is a superset of the defaults will pass.
 *
 * Phase C TODO: read labels.required.types and labels.required.priorities from
 * compass.config.yaml. The hardcoded DEFAULT_LABELS list is the fallback.
 *
 * Exit code 0 = all labels present, 1 = missing labels.
 */

// PHASE C TODO: replace with config-driven label list.
const DEFAULT_LABELS = ["bug", "documentation", "feature", "infrastructure", "now", "next", "future"];

const repo = process.argv[2];
if (!repo) {
  console.error("Usage: bun engine/validators/label-check.ts <org/repo>");
  process.exit(1);
}

const proc = Bun.spawnSync(["gh", "label", "list", "--repo", repo, "--json", "name", "--limit", "100"]);
if (proc.exitCode !== 0) {
  console.error(`Failed to list labels for ${repo}: ${new TextDecoder().decode(proc.stderr)}`);
  process.exit(1);
}

const labels: { name: string }[] = JSON.parse(new TextDecoder().decode(proc.stdout));
const labelNames = new Set(labels.map((l) => l.name));
const missing = DEFAULT_LABELS.filter((l) => !labelNames.has(l));

if (missing.length > 0) {
  console.error(`${repo} is missing ${missing.length} required label(s):`);
  for (const l of missing) {
    console.error(`  - ${l}`);
  }
  console.error(`\nFix with: bun standards/scripts/sync-labels.ts ${repo}`);
  process.exit(1);
} else {
  console.log(`${repo} has all ${DEFAULT_LABELS.length} required labels.`);
  process.exit(0);
}
