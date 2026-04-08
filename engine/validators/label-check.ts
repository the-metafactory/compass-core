#!/usr/bin/env bun
/**
 * label-check.ts — Verify that a GitHub repo has all required labels per the consumer's config.
 * Usage: bun engine/validators/label-check.ts <org/repo> [--config path/to/compass.config.yaml]
 *
 * Reads labels.required.types and labels.required.priorities from compass.config.yaml.
 * The validator passes when the repo has every required type AND every required priority
 * label. The loader looks in (priority order): the COMPASS_CONFIG env var, the --config
 * flag, then the cwd.
 *
 * If no compass.config.yaml is found OR labels.required is absent, falls back to
 * DEFAULT_TYPES + DEFAULT_PRIORITIES — the minimal label set every compass-core repo
 * should have.
 *
 * If validators.label_check.enabled is explicitly false, the validator skips with exit 0.
 * If validators.label_check.enforce_required is false, the validator reports missing
 * labels but exits 0 (warning mode).
 *
 * Exit code 0 = all required labels present (or validator disabled / non-enforcing),
 * 1 = missing labels.
 */

import { parseArgs } from "node:util";
import { loadConfig } from "../lib/config.ts";

// Fallback when no compass.config.yaml is provided.
const DEFAULT_TYPES = ["bug", "documentation", "feature", "infrastructure"];
const DEFAULT_PRIORITIES = ["now", "next", "future"];

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    config: { type: "string" },
  },
});

const repo = positionals[0];
if (!repo) {
  console.error("Usage: bun engine/validators/label-check.ts <org/repo> [--config path/to/compass.config.yaml]");
  process.exit(1);
}

const config = loadConfig({ configPath: values.config });

if (config?.validators?.label_check?.enabled === false) {
  console.log("validators.label_check.enabled is false in compass.config.yaml — skipping.");
  process.exit(0);
}

const requiredTypes =
  config?.labels?.required?.types && Array.isArray(config.labels.required.types)
    ? config.labels.required.types
    : DEFAULT_TYPES;
const requiredPriorities =
  config?.labels?.required?.priorities && Array.isArray(config.labels.required.priorities)
    ? config.labels.required.priorities
    : DEFAULT_PRIORITIES;
const requiredLabels = [...requiredTypes, ...requiredPriorities];
const source = config?.labels?.required ? "compass.config.yaml" : "default";

const proc = Bun.spawnSync(["gh", "label", "list", "--repo", repo, "--json", "name", "--limit", "100"]);
if (proc.exitCode !== 0) {
  console.error(`Failed to list labels for ${repo}: ${new TextDecoder().decode(proc.stderr)}`);
  process.exit(1);
}

const labels: { name: string }[] = JSON.parse(new TextDecoder().decode(proc.stdout));
const labelNames = new Set(labels.map((l) => l.name));
const missing = requiredLabels.filter((l) => !labelNames.has(l));

if (missing.length === 0) {
  console.log(`${repo} has all ${requiredLabels.length} required label(s) (source: ${source}).`);
  process.exit(0);
}

console.error(`${repo} is missing ${missing.length} required label(s) (source: ${source}):`);
for (const l of missing) {
  console.error(`  - ${l}`);
}
console.error(`\nFix with: bun standards/scripts/sync-labels.ts ${repo}`);

const enforce = config?.validators?.label_check?.enforce_required ?? true;
if (!enforce) {
  console.error("\nvalidators.label_check.enforce_required is false — reporting only, not failing.");
  process.exit(0);
}

process.exit(1);
