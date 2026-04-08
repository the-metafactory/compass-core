#!/usr/bin/env bun
/**
 * claude-md-check.ts — Validate that a CLAUDE.md file contains required sections.
 * Usage: bun engine/validators/claude-md-check.ts <path-to-CLAUDE.md> [--config path/to/compass.config.yaml]
 *
 * Reads validators.claude_md.required_sections from compass.config.yaml. The loader
 * looks in (priority order): the COMPASS_CONFIG env var, the --config flag, the cwd,
 * then walks up from the directory of the CLAUDE.md being checked.
 *
 * If no compass.config.yaml is found OR validators.claude_md.required_sections is
 * absent, falls back to DEFAULT_SECTIONS — the minimal sections every compass-core
 * CLAUDE.md should have.
 *
 * If validators.claude_md.enabled is explicitly false, the validator skips with exit 0.
 *
 * Exit code 0 = all sections present (or validator disabled), 1 = missing sections.
 */

import { parseArgs } from "node:util";
import { loadConfig } from "../lib/config.ts";

// Fallback when no compass.config.yaml is provided.
const DEFAULT_SECTIONS = [
  "Critical Rules",
  "Standard Operating Procedures",
];

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    config: { type: "string" },
  },
});

const filePath = positionals[0];
if (!filePath) {
  console.error("Usage: bun engine/validators/claude-md-check.ts <path-to-CLAUDE.md> [--config path/to/compass.config.yaml]");
  process.exit(1);
}

// Load config (best-effort) — fall back to defaults if absent.
const config = loadConfig({ configPath: values.config, near: filePath });

if (config?.validators?.claude_md?.enabled === false) {
  console.log("validators.claude_md.enabled is false in compass.config.yaml — skipping.");
  process.exit(0);
}

const requiredSections =
  config?.validators?.claude_md?.required_sections && Array.isArray(config.validators.claude_md.required_sections)
    ? config.validators.claude_md.required_sections
    : DEFAULT_SECTIONS;

const source = config?.validators?.claude_md?.required_sections ? "compass.config.yaml" : "default";

const content = await Bun.file(filePath).text();
const missing: string[] = [];

for (const section of requiredSections) {
  // Match ## Section or ## Section (with qualifier)
  const pattern = new RegExp(`^##\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "mi");
  if (!pattern.test(content)) {
    missing.push(section);
  }
}

if (missing.length > 0) {
  console.error(`CLAUDE.md is missing ${missing.length} required section(s) (source: ${source}):`);
  for (const s of missing) {
    console.error(`  - ## ${s}`);
  }
  process.exit(1);
} else {
  console.log(`CLAUDE.md passes — all ${requiredSections.length} required section(s) present (source: ${source}).`);
  process.exit(0);
}
