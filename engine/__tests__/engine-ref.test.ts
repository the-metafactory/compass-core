/**
 * Guard for ENGINE_REF in engine/install.ts.
 *
 * The installer renders ENGINE_REF into the consumer's compass-governance.yml
 * as the commit CI checks out into .compass-engine. Nothing else ties that pin
 * to the workflow template: the template can name a validator the pinned
 * commit does not yet contain, and every consumer installs a gate that fails
 * on a missing file. That happened (issue #25): the pin predated leak-check.ts
 * and the template itself.
 *
 * So this test reads the pin and the template as text and asks git whether
 * the pinned commit has every engine/ and .githooks/ path the template runs
 * or reads, and whether the pin is a commit on this history at all.
 *
 * It skips — printing why, never a silent pass — only when the local clone
 * does not have the pinned commit (a shallow or partial clone). A full clone
 * always runs it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..", "..");
const INSTALLER = join(REPO, "engine", "install.ts");
const TEMPLATE = join(REPO, "templates", "workflows", "compass-governance.yml");

/** Runs git in the repo root; returns exit code and stderr, never throws. */
function git(args: string[]): { exitCode: number; stderr: string } {
  const proc = Bun.spawnSync(["git", ...args], { cwd: REPO });
  return {
    exitCode: proc.exitCode ?? -1,
    stderr: new TextDecoder().decode(proc.stderr).trim(),
  };
}

/** The const line, and only the const line — a comment quoting a SHA must not satisfy this. */
function readEngineRef(): string {
  const source = readFileSync(INSTALLER, "utf8");
  const match = source.match(/^const ENGINE_REF = "([^"]*)";$/m);
  if (!match) throw new Error(`no 'const ENGINE_REF = "..."' line in ${INSTALLER}`);
  return match[1];
}

/**
 * Every engine/ and .githooks/ path the template mentions. The workflow runs
 * the engine from the .compass-engine checkout, so that prefix is stripped;
 * the lookbehind stops "compass-engine/" itself from matching as "engine/".
 */
function templatePaths(): string[] {
  const text = readFileSync(TEMPLATE, "utf8");
  const found = new Set<string>();
  const engine = /(?<![A-Za-z0-9_./-])(?:\.compass-engine\/)?(engine\/[A-Za-z0-9_./-]+\.ts)/g;
  const hooks = /(?<![A-Za-z0-9_./-])(\.githooks\/[A-Za-z0-9_./-]+)/g;
  for (const re of [engine, hooks]) {
    for (const m of text.matchAll(re)) found.add(m[1]);
  }
  return [...found].sort();
}

const ENGINE_REF = readEngineRef();
const refIsSha = /^[0-9a-f]{40}$/.test(ENGINE_REF);
const refPresent = refIsSha && git(["cat-file", "-e", `${ENGINE_REF}^{commit}`]).exitCode === 0;

if (refIsSha && !refPresent) {
  console.log(
    `engine-ref: SKIPPED — this clone does not contain ${ENGINE_REF} (shallow or partial clone?). ` +
      "Run from a full clone to exercise the guard.",
  );
}

describe("ENGINE_REF (engine/install.ts)", () => {
  test("is a full 40-hex commit SHA", () => {
    expect(ENGINE_REF).toMatch(/^[0-9a-f]{40}$/);
  });

  test("the template names at least one engine path (otherwise the guard below checks nothing)", () => {
    const paths = templatePaths();
    expect(paths.some((p) => p.startsWith("engine/validators/"))).toBe(true);
  });

  const guarded = refPresent ? test : test.skip;

  guarded("is a commit on this history, not a stray", () => {
    const r = git(["merge-base", "--is-ancestor", ENGINE_REF, "HEAD"]);
    expect(r.exitCode, `${ENGINE_REF} is not an ancestor of HEAD: ${r.stderr}`).toBe(0);
  });

  guarded("contains every engine/ and .githooks/ path the workflow template runs or reads", () => {
    const missing: string[] = [];
    for (const path of templatePaths()) {
      const r = git(["cat-file", "-e", `${ENGINE_REF}:${path}`]);
      if (r.exitCode !== 0) missing.push(path);
    }
    expect(
      missing,
      `templates/workflows/compass-governance.yml references paths that do not exist at ENGINE_REF ${ENGINE_REF}:\n` +
        missing.map((p) => `  - ${p}`).join("\n") +
        "\nBump ENGINE_REF in engine/install.ts to a main commit that contains them (see sops/versioning.md).",
    ).toEqual([]);
  });
});
