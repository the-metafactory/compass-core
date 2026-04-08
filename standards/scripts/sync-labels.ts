#!/usr/bin/env bun
/**
 * sync-labels.ts
 *
 * Sync a label set from a labels.yaml file (per labels.schema.yaml) to a target GitHub repo.
 *
 * Usage:
 *   bun standards/scripts/sync-labels.ts <owner/repo> [--source path/to/labels.yaml] [--prune]
 *
 * Defaults:
 *   --source: reads compass.config.yaml's labels.source from the cwd
 *   --prune:  off (don't delete labels not in source)
 *
 * Phase A1 note: this script is the verbatim shape carried over from the source repo.
 * Phase C will parameterize it to read compass.config.yaml automatically.
 */

import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

interface Label {
  name: string;
  color: string;
  description: string;
  category?: string;
}

interface LabelsFile {
  labels: Label[];
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    source: { type: "string" },
    prune: { type: "boolean", default: false },
  },
});

const target = positionals[0];
if (!target || !target.includes("/")) {
  console.error("Usage: sync-labels.ts <owner/repo> [--source path] [--prune]");
  process.exit(1);
}

// Resolve source path
let sourcePath = values.source;
if (!sourcePath) {
  // Try compass.config.yaml in cwd
  const configPath = resolve(process.cwd(), "compass.config.yaml");
  if (existsSync(configPath)) {
    const config = parseYaml(readFileSync(configPath, "utf8"));
    sourcePath = config?.labels?.source;
  }
}

if (!sourcePath) {
  console.error("No source provided. Use --source path/to/labels.yaml or set labels.source in compass.config.yaml.");
  process.exit(1);
}

const sourceFile = resolve(process.cwd(), sourcePath);
if (!existsSync(sourceFile)) {
  console.error(`Source file not found: ${sourceFile}`);
  process.exit(1);
}

const parsed = parseYaml(readFileSync(sourceFile, "utf8")) as LabelsFile;
if (!parsed?.labels || !Array.isArray(parsed.labels)) {
  console.error(`Invalid labels file: missing or non-array 'labels' key in ${sourceFile}`);
  process.exit(1);
}

console.log(`Syncing ${parsed.labels.length} labels from ${sourcePath} → ${target}`);

// List existing labels
const existingProc = Bun.spawnSync(["gh", "label", "list", "--repo", target, "--json", "name,color,description"]);
if (existingProc.exitCode !== 0) {
  console.error(`Failed to list labels: ${new TextDecoder().decode(existingProc.stderr)}`);
  process.exit(1);
}
const existing: Label[] = JSON.parse(new TextDecoder().decode(existingProc.stdout));
const existingByName = new Map(existing.map((l) => [l.name, l]));

const added: string[] = [];
const updated: string[] = [];
const skipped: string[] = [];

for (const label of parsed.labels) {
  const current = existingByName.get(label.name);
  if (!current) {
    // Create
    const r = Bun.spawnSync([
      "gh", "label", "create", label.name,
      "--repo", target,
      "--color", label.color,
      "--description", label.description,
    ]);
    if (r.exitCode === 0) added.push(label.name);
    else console.error(`  ! create ${label.name}: ${new TextDecoder().decode(r.stderr)}`);
  } else if (current.color !== label.color || current.description !== label.description) {
    // Update
    const r = Bun.spawnSync([
      "gh", "label", "edit", label.name,
      "--repo", target,
      "--color", label.color,
      "--description", label.description,
    ]);
    if (r.exitCode === 0) updated.push(label.name);
    else console.error(`  ! update ${label.name}: ${new TextDecoder().decode(r.stderr)}`);
  } else {
    skipped.push(label.name);
  }
}

const sourceNames = new Set(parsed.labels.map((l) => l.name));
const extraneous = existing.map((l) => l.name).filter((n) => !sourceNames.has(n));

console.log(`\nResult:`);
console.log(`  Added:    [${added.join(", ")}]`);
console.log(`  Updated:  [${updated.join(", ")}]`);
console.log(`  Skipped:  [${skipped.join(", ")}] (already in sync)`);
console.log(`  Extraneous in target: [${extraneous.join(", ")}]${values.prune ? " — pruning" : " (use --prune to delete)"}`);

if (values.prune) {
  for (const name of extraneous) {
    const r = Bun.spawnSync(["gh", "label", "delete", name, "--repo", target, "--yes"]);
    if (r.exitCode !== 0) console.error(`  ! delete ${name}: ${new TextDecoder().decode(r.stderr)}`);
  }
}
