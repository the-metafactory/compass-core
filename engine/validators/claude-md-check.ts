#!/usr/bin/env bun
/**
 * claude-md-check.ts — Validate that a CLAUDE.md file contains required sections.
 * Usage: bun engine/validators/claude-md-check.ts <path-to-CLAUDE.md>
 *
 * Phase A1: uses a minimal hardcoded default section list. Any consumer whose CLAUDE.md
 * follows compass-core conventions will pass with the defaults.
 *
 * Phase C TODO: read validators.claude_md.required_sections from compass.config.yaml.
 * The hardcoded DEFAULT_SECTIONS list is the fallback when no config is provided.
 *
 * Exit code 0 = all sections present, 1 = missing sections.
 */

// PHASE C TODO: replace with config-driven section list. For now, defaults reflect
// the generic compass-core CLAUDE.md template. Consumers can override at the wrapper level.
const DEFAULT_SECTIONS = [
  "Critical Rules",
  "Standard Operating Procedures",
];

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: bun engine/validators/claude-md-check.ts <path-to-CLAUDE.md>");
  process.exit(1);
}

const content = await Bun.file(filePath).text();
const missing: string[] = [];

for (const section of DEFAULT_SECTIONS) {
  // Match ## Section or ## Section (with qualifier)
  const pattern = new RegExp(`^##\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "mi");
  if (!pattern.test(content)) {
    missing.push(section);
  }
}

if (missing.length > 0) {
  console.error(`CLAUDE.md is missing ${missing.length} required section(s):`);
  for (const s of missing) {
    console.error(`  - ## ${s}`);
  }
  process.exit(1);
} else {
  console.log(`CLAUDE.md passes — all ${DEFAULT_SECTIONS.length} required sections present.`);
  process.exit(0);
}
