#!/usr/bin/env bun
/**
 * install.ts — install compass-core governance into a target repository.
 *
 *   bun engine/install.ts <target-dir> [--with-ci] [--force] [--dry-run]
 *
 * Addresses the-metafactory/compass-core#17, all five acceptance criteria.
 *
 * ## What it writes, and only where
 *
 *   <target>/sops/*.md   the shipped SOPs, rendered against the target's config
 *   <target>/CLAUDE.md   a marked block: critical rules + SOP activation table
 *
 * With --with-ci, also:
 *
 *   <target>/.githooks/pre-commit                        the local leak gate
 *   <target>/.github/workflows/compass-governance.yml    the PR gate, rendered
 *
 * Nothing is written outside <target>. engine/, standards/ and the governance
 * skill are NOT copied — the CI workflow checks compass-core out for itself,
 * pinned by SHA, so the governed repo never carries the engine.
 *
 * ## Why the CI gate is opt-in and the CLAUDE.md block is not flag-dependent
 *
 * --with-ci adds files; it does NOT change a single byte of the generated
 * CLAUDE.md block. Block content is a pure function of the config, so two
 * targets with the same config get the same block whether or not either asked
 * for CI. Folding "arm your hook" into the block would make its content depend
 * on a command-line flag, and a re-install without the flag would then silently
 * rewrite it. The arming instruction is printed to stdout instead, and repeated
 * in the hook and workflow headers where someone reading them will find it.
 *
 * ## Why render at install time
 *
 * A skill that says "read compass.config.yaml, then read the SOP, then
 * substitute the patterns" costs the model four indirections on every single
 * invocation. Rendering here makes the installed SOP the single source of
 * truth: it names the real branch pattern, the real manifest, the real channel.
 * Nothing generated tells the model to go and read the config.
 *
 * ## The unresolvable-placeholder rule
 *
 * Every field is optional in the Zod schema, so "required" means required by
 * `claude/skills/governance/config-schema.md`. For an unset key, in order:
 *
 *   1. an inline `{{config:key|fallback}}` in the source wins;
 *   2. a key with a documented default renders that default, and the run
 *      REPORTS it — defaults are applied, never applied silently;
 *   3. a documented-optional key drops its enclosing parenthetical if it sits
 *      in one, else renders its documented neutral phrase;
 *   4. anything else is UNRESOLVED: the install aborts naming the key and the
 *      files that referenced it, and writes nothing. A half-rendered SOP with a
 *      blank where a branch name belongs is worse than no SOP.
 *
 * See engine/lib/render.ts for the grammar and the policy table.
 *
 * ## Non-clobber and idempotency
 *
 * An existing target file is written only if it is byte-identical to what we
 * would write (a no-op) or `--force` is given; otherwise it is left exactly as
 * it is, reported, and the run exits nonzero. Nothing is ever deleted. CLAUDE.md
 * is merged rather than refused: the marked block is replaced in place and every
 * byte outside the markers survives untouched.
 *
 * Rendering is pure, and the block carries no timestamp or version stamp, so
 * two runs with unchanged config produce byte-identical trees.
 *
 * ## Exit codes
 *
 *   0  success
 *   2  USAGE                    — bad or missing arguments
 *   3  TARGET_NOT_A_DIRECTORY   — target missing, or not a directory
 *   4  CONFIG_NOT_FOUND         — no compass.config.yaml in the target
 *   5  CONFIG_INVALID           — config present but failed schema validation
 *   6  UNRESOLVED_PLACEHOLDERS  — a referenced key has no value and no fallback
 *   7  REFUSED_EXISTING_FILES   — existing files differ; re-run with --force
 *   8  MARKERS_MALFORMED        — unbalanced marker pair in the target CLAUDE.md
 *
 * Nothing here runs in the target repo: the rendered output is plain markdown
 * and assumes no runtime, no bun, no toolchain.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { loadConfigFrom, type CompassConfig } from "./lib/config.ts";
import { buildClaudeBlock, mergeClaudeMd, renderText } from "./lib/render.ts";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const SOURCE_SOPS = join(PACKAGE_ROOT, "sops");
const SOURCE_HOOK = join(PACKAGE_ROOT, ".githooks", "pre-commit");
const SOURCE_WORKFLOW = join(PACKAGE_ROOT, "templates", "workflows", "compass-governance.yml");

/**
 * The compass-core commit the generated CI workflow pins its engine checkout to.
 *
 * Baked in rather than read from the local checkout's HEAD, on purpose. Resolving
 * `git rev-parse HEAD` at install time would pin whatever branch the operator
 * happened to run from — including an unmerged feature branch, or a dirty tree —
 * and would make the rendered workflow differ between machines installing "the
 * same" compass-core. A gate consumers copy should point at a reviewed commit on
 * main, and it should be the same commit for everyone who installs this build.
 *
 * Bumping it is a deliberate edit here, and re-running the installer re-renders
 * the pin into the target. Consumers may equally bump the SHA in their own
 * workflow file and read what changed, which is the upgrade path the workflow
 * header describes.
 */
const ENGINE_REF = "1214e7dde76b937d31261c329fe5089fd03aee91";

/** Substituted into the workflow template at install time. */
const TEMPLATE_VALUES: Record<string, string> = {
  compass_core_ref: ENGINE_REF,
};

const EXIT = {
  USAGE: 2,
  TARGET_NOT_A_DIRECTORY: 3,
  CONFIG_NOT_FOUND: 4,
  CONFIG_INVALID: 5,
  UNRESOLVED_PLACEHOLDERS: 6,
  REFUSED_EXISTING_FILES: 7,
  MARKERS_MALFORMED: 8,
} as const;

const USAGE = `usage: bun engine/install.ts <target-dir> [--with-ci] [--force] [--dry-run]

  <target-dir>  the repository to install governance into. Must exist and
                contain a compass.config.yaml.
  --with-ci     also install the pre-commit leak hook and the PR governance
                workflow. Does not change the CLAUDE.md block.
  --force       overwrite existing files that differ from the rendered output.
  --dry-run     report what would be written; touch nothing.`;

/** Fail with a named reason on stderr and the matching exit code. */
function fail(reason: keyof typeof EXIT, detail: string): never {
  console.error(`install failed: ${reason} — ${detail}`);
  process.exit(EXIT[reason]);
}

interface Args {
  targetDir: string;
  force: boolean;
  dryRun: boolean;
  withCi: boolean;
}

function parseArgs(argv: string[]): Args {
  let targetDir: string | undefined;
  let force = false;
  let dryRun = false;
  let withCi = false;

  for (const arg of argv) {
    if (arg === "--force") force = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--with-ci") withCi = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith("-")) {
      fail("USAGE", `unknown flag ${arg}.\n\n${USAGE}`);
    } else if (targetDir === undefined) targetDir = arg;
    else fail("USAGE", `unexpected extra argument ${arg}.\n\n${USAGE}`);
  }

  if (targetDir === undefined) {
    fail("USAGE", `no target directory given.\n\n${USAGE}`);
  }
  return { targetDir, force, dryRun, withCi };
}

/** Load the TARGET's config. Never the ambient one — see loadConfigFrom. */
function readTargetConfig(targetDir: string): CompassConfig {
  const configPath = join(targetDir, "compass.config.yaml");
  if (!existsSync(configPath)) {
    fail(
      "CONFIG_NOT_FOUND",
      `no compass.config.yaml in ${targetDir}.\n` +
        `  A governed repo owns its own config; the installer will not guess one.\n` +
        `  Copy ${join(PACKAGE_ROOT, "compass.config.example.yaml")} to\n` +
        `  ${configPath}, fill it in, and re-run.`,
    );
  }
  try {
    return loadConfigFrom(configPath);
  } catch (err) {
    fail("CONFIG_INVALID", (err as Error).message);
  }
}

interface Rendered {
  /** Path relative to the target root. */
  rel: string;
  contents: string;
  /** POSIX mode. Set for the hook, which is inert unless executable. */
  mode?: number;
}

/**
 * Substitute `{{template:...}}` values. Deliberately separate from renderText:
 * that function owns the `{{config:...}}` namespace and leaves every other
 * namespace alone (it is tested for exactly that), and the CI pin is an
 * install-time fact rather than a config value.
 */
function renderTemplateValues(text: string): string {
  return text.replace(/\{\{template:([a-z_]+)\}\}/g, (whole, key: string) => {
    const value = TEMPLATE_VALUES[key];
    return value === undefined ? whole : value;
  });
}

function main(): void {
  const { targetDir: rawTarget, force, dryRun, withCi } = parseArgs(process.argv.slice(2));
  const targetDir = resolve(rawTarget);

  if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
    fail("TARGET_NOT_A_DIRECTORY", `${targetDir} does not exist or is not a directory.`);
  }

  const config = readTargetConfig(targetDir);

  // --- Render everything before touching the filesystem -------------------
  // An unresolved key must abort with the target untouched, so rendering is a
  // complete, side-effect-free pass first.

  const sopFiles = readdirSync(SOURCE_SOPS)
    .filter((f) => f.endsWith(".md"))
    .sort();

  const rendered: Rendered[] = [];
  const unresolved = new Map<string, string[]>(); // key -> source files
  const defaulted = new Set<string>();
  const dropped = new Set<string>();

  for (const file of sopFiles) {
    const source = readFileSync(join(SOURCE_SOPS, file), "utf8");
    const result = renderText(source, config);
    for (const key of result.unresolved) {
      const files = unresolved.get(key) ?? [];
      files.push(`sops/${file}`);
      unresolved.set(key, files);
    }
    for (const key of result.defaulted) defaulted.add(key);
    for (const key of result.dropped) dropped.add(key);
    rendered.push({ rel: join("sops", file), contents: result.text });
  }

  if (withCi) {
    // The hook is plain shell with no placeholders — copied verbatim, but its
    // executable bit is load-carrying: git ignores a non-executable hook, which
    // would install a security gate that silently never runs.
    rendered.push({
      rel: join(".githooks", "pre-commit"),
      contents: readFileSync(SOURCE_HOOK, "utf8"),
      mode: 0o755,
    });

    // The workflow carries the compass-core pin, and is run through the config
    // renderer too so a future {{config:...}} in it resolves like anything else.
    const workflowSource = readFileSync(SOURCE_WORKFLOW, "utf8");
    const workflowResult = renderText(workflowSource, config);
    for (const key of workflowResult.unresolved) {
      const files = unresolved.get(key) ?? [];
      files.push("templates/workflows/compass-governance.yml");
      unresolved.set(key, files);
    }
    for (const key of workflowResult.defaulted) defaulted.add(key);
    for (const key of workflowResult.dropped) dropped.add(key);
    rendered.push({
      rel: join(".github", "workflows", "compass-governance.yml"),
      contents: renderTemplateValues(workflowResult.text),
    });
  }

  if (unresolved.size > 0) {
    const lines = [...unresolved.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, files]) => `    ${key}  (referenced by ${files.join(", ")})`)
      .join("\n");
    fail(
      "UNRESOLVED_PLACEHOLDERS",
      `these config keys are referenced by the SOPs but have no value, no\n` +
        `  documented default and no fallback:\n\n${lines}\n\n` +
        `  Set them in ${join(targetDir, "compass.config.yaml")} and re-run. See\n` +
        `  claude/skills/governance/config-schema.md for what each key means.\n` +
        `  Nothing was written.`,
    );
  }

  // --- Non-clobber pass over the rendered SOPs ---------------------------

  const toWrite: Rendered[] = [];
  const refused: string[] = [];
  const unchanged: string[] = [];

  for (const item of rendered) {
    const path = join(targetDir, item.rel);
    if (!existsSync(path)) {
      toWrite.push(item);
      continue;
    }
    const existing = readFileSync(path, "utf8");
    // Identical bytes are a no-op — unless the mode is wrong. An existing hook
    // with the right content and no execute bit is a gate that never fires, so
    // treat that as work to do rather than "already current".
    const modeOk =
      item.mode === undefined || (statSync(path).mode & 0o777) === item.mode;
    if (existing === item.contents && modeOk) unchanged.push(item.rel);
    else if (existing === item.contents) toWrite.push(item);
    else if (force) toWrite.push(item);
    else refused.push(item.rel);
  }

  // --- CLAUDE.md merge ----------------------------------------------------

  const claudePath = join(targetDir, "CLAUDE.md");
  const block = buildClaudeBlock(config, sopFiles);
  const existingClaude = existsSync(claudePath) ? readFileSync(claudePath, "utf8") : null;

  let mergedClaude: string;
  try {
    mergedClaude = mergeClaudeMd(existingClaude, block);
  } catch (err) {
    fail("MARKERS_MALFORMED", (err as Error).message.replace(/^MARKERS_MALFORMED — /, ""));
  }
  const claudeChanged = mergedClaude !== existingClaude;

  // --- Write --------------------------------------------------------------

  if (!dryRun) {
    for (const item of toWrite) {
      const path = join(targetDir, item.rel);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, item.contents);
      if (item.mode !== undefined) chmodSync(path, item.mode);
    }
    if (claudeChanged) writeFileSync(claudePath, mergedClaude);
  }

  // --- Report -------------------------------------------------------------

  const verb = dryRun ? "would write" : "wrote";
  console.log(`compass-core install → ${targetDir}`);
  console.log(`  config: ${join(targetDir, "compass.config.yaml")}`);
  console.log(`  ${verb}: ${toWrite.length} file(s)`);
  for (const item of toWrite) console.log(`    + ${item.rel}`);
  if (unchanged.length > 0) {
    console.log(`  already current: ${unchanged.length} file(s)`);
  }
  console.log(
    `  CLAUDE.md: ${
      claudeChanged
        ? existingClaude === null
          ? dryRun
            ? "would create"
            : "created"
          : existingClaude.includes("<!-- compass-core:begin -->")
            ? dryRun
              ? "would replace the managed block"
              : "replaced the managed block"
            : dryRun
              ? "would append the managed block"
              : "appended the managed block"
        : "already current"
    }`,
  );

  if (defaulted.size > 0) {
    console.log(`  applied documented defaults for: ${[...defaulted].sort().join(", ")}`);
  }
  if (dropped.size > 0) {
    console.log(`  optional keys unset (prose closed over them): ${[...dropped].sort().join(", ")}`);
  }

  if (withCi) {
    console.log(`  CI gate: pinned to compass-core ${ENGINE_REF.slice(0, 12)}`);
    console.log("");
    console.log("  The pre-commit hook is inert until this clone opts in. Once per clone:");
    console.log("");
    console.log("      git config core.hooksPath .githooks");
    console.log("");
    console.log("  Optionally point it at an operator pattern file (plaintext regexes,");
    console.log("  one per line, kept OUTSIDE the repo):");
    console.log("");
    console.log('      export CONFIDENTIALITY_DENYLIST_FILE="$HOME/.config/compass/denylist.txt"');
    console.log("");
  }

  if (refused.length > 0) {
    console.error("");
    fail(
      "REFUSED_EXISTING_FILES",
      `these files already exist in ${basename(targetDir)} and differ from what\n` +
        `  this install would write. They were left exactly as they are — nothing\n` +
        `  was overwritten and nothing was deleted:\n\n` +
        refused.map((r) => `    ${r}`).join("\n") +
        `\n\n  Re-run with --force to overwrite them, or diff them first.`,
    );
  }
}

main();
