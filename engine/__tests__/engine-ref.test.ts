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
 * So this test reads the pin and the template as text and asks git that:
 *   - the pin is a 40-hex SHA naming a COMMIT object (not a tag object — an
 *     annotated tag's SHA peels everywhere git looks, and lives only as long
 *     as the tag does);
 *   - the pin is reachable from origin/main, so it is a reviewed main commit
 *     and not this PR branch's own HEAD;
 *   - the pinned tree has every engine/ and .githooks/ path the template
 *     references, plus package.json and bun.lock, which
 *     `bun install --frozen-lockfile` needs at the pin.
 *
 * A FULL CLONE NEVER SKIPS. A pin that names no object in a full clone is a
 * failure, not an absence of evidence — that is exactly the typo this guard
 * exists to catch. The git-backed checks skip, with a console.warn, only in
 * a shallow clone (`git rev-parse --is-shallow-repository` == true), where
 * the pinned commit is legitimately unavailable. Any CI that runs this test
 * must check out with fetch-depth: 0. The ancestry check additionally skips,
 * loudly, when the clone has no origin/main ref to anchor on.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..", "..");
const INSTALLER = join(REPO, "engine", "install.ts");
const TEMPLATE = join(REPO, "templates", "workflows", "compass-governance.yml");

/** Files the workflow needs at the pin whether or not the template names them. */
const ALWAYS_REQUIRED = ["package.json", "bun.lock"];

/** Runs git in the repo root; returns exit code and output, never throws. */
function git(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["git", ...args], { cwd: REPO });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout).trim(),
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
 * Every engine/ and .githooks/ path a workflow template references, however
 * the engine checkout is addressed: `.compass-engine/`, `./.compass-engine/`
 * or `$GITHUB_WORKSPACE/.compass-engine/` are stripped first, so the paths
 * come back relative to the compass-core tree at the pin.
 */
export function collectTemplatePaths(text: string): string[] {
  const stripped = text.replace(/(?:\.\/|\$GITHUB_WORKSPACE\/)?\.compass-engine\//g, "");
  const found = new Set<string>();
  const engine = /(?<![A-Za-z0-9_./-])(engine\/[A-Za-z0-9_./-]+\.(?:ts|js))/g;
  const hooks = /(?<![A-Za-z0-9_./-])(\.githooks\/[A-Za-z0-9_./-]+)/g;
  for (const re of [engine, hooks]) {
    for (const m of stripped.matchAll(re)) found.add(m[1]);
  }
  return [...found].sort();
}

/** The subset of `paths` that does not exist in the tree of `ref`. */
function missingAt(ref: string, paths: string[]): string[] {
  return paths.filter((p) => git(["cat-file", "-e", `${ref}:${p}`]).exitCode !== 0);
}

const ENGINE_REF = readEngineRef();
const shallow = git(["rev-parse", "--is-shallow-repository"]).stdout === "true";
const hasOriginMain = git(["rev-parse", "--verify", "--quiet", "origin/main^{commit}"]).exitCode === 0;

if (shallow) {
  console.warn(
    `engine-ref: SKIPPING the git-backed checks — this is a shallow clone, so ${ENGINE_REF} ` +
      "may legitimately be absent. Run from a full clone (CI: fetch-depth: 0) to exercise the guard.",
  );
}
if (!shallow && !hasOriginMain) {
  console.warn(
    "engine-ref: SKIPPING the ancestry check — this clone has no origin/main ref to anchor on. " +
      "Add the remote (git remote add origin ...; git fetch origin main) to exercise it.",
  );
}

/** Full clone: run. Shallow clone: skip, and say so in the title. */
const onFullClone = shallow ? test.skip : test;
const withOriginMain = shallow || !hasOriginMain ? test.skip : test;
const skipTag = (reason: string) => (shallow ? ` [SKIPPED: ${reason}]` : "");
const ancestryTag = shallow
  ? " [SKIPPED: shallow clone]"
  : !hasOriginMain
    ? " [SKIPPED: no origin/main ref]"
    : "";

describe("ENGINE_REF (engine/install.ts)", () => {
  test("is a full 40-hex commit SHA", () => {
    expect(ENGINE_REF).toMatch(/^[0-9a-f]{40}$/);
  });

  test("the template names at least one engine validator (otherwise the guard below checks nothing)", () => {
    const paths = collectTemplatePaths(readFileSync(TEMPLATE, "utf8"));
    expect(paths.some((p) => p.startsWith("engine/validators/"))).toBe(true);
  });

  test("the collector reads every form the engine checkout can be addressed by", () => {
    const scratch = [
      "run: bun .compass-engine/engine/validators/claude-md-check.ts CLAUDE.md",
      "run: bun ./.compass-engine/engine/validators/label-check.ts",
      'run: bun "$GITHUB_WORKSPACE/.compass-engine/engine/validators/leak-check.ts"',
      "run: node .compass-engine/engine/ci/does-not-exist.js",
      "# see .githooks/pre-commit for the fail-open note",
      'case "$f" in .compass-engine/*) continue ;; esac',
    ].join("\n");
    expect(collectTemplatePaths(scratch)).toEqual([
      ".githooks/pre-commit",
      "engine/ci/does-not-exist.js",
      "engine/validators/claude-md-check.ts",
      "engine/validators/label-check.ts",
      "engine/validators/leak-check.ts",
    ]);
  });

  onFullClone(`names a COMMIT object present in this clone${skipTag("shallow clone")}`, () => {
    const r = git(["cat-file", "-t", ENGINE_REF]);
    expect(
      r.stdout,
      r.exitCode === 0
        ? `${ENGINE_REF} is a ${r.stdout} object, not a commit. Pin the commit a tag points at ` +
            "(git rev-parse 'v<version>^{commit}'), never the tag object itself."
        : `${ENGINE_REF} names no object in this full clone: ${r.stderr}. A pin that does not exist ` +
            "here cannot be checked, and would render a workflow that cannot check out its engine.",
    ).toBe("commit");
  });

  withOriginMain(
    `is reachable from origin/main — a reviewed main commit, not this branch's own HEAD${ancestryTag}`,
    () => {
      const r = git(["merge-base", "--is-ancestor", ENGINE_REF, "origin/main"]);
      expect(
        r.exitCode,
        `${ENGINE_REF} is not an ancestor of origin/main${r.stderr ? `: ${r.stderr}` : ""}. ` +
          "ENGINE_REF must be a commit already merged to main; a feature branch's HEAD is not a pin.",
      ).toBe(0);
    },
  );

  onFullClone(
    `contains every path the workflow template references, plus package.json and bun.lock${skipTag(
      "shallow clone",
    )}`,
    () => {
      const required = [
        ...new Set([...collectTemplatePaths(readFileSync(TEMPLATE, "utf8")), ...ALWAYS_REQUIRED]),
      ].sort();
      const missing = missingAt(ENGINE_REF, required);
      expect(
        missing,
        `the workflow needs paths that do not exist at ENGINE_REF ${ENGINE_REF}:\n` +
          missing.map((p) => `  - ${p}`).join("\n") +
          "\nBump ENGINE_REF in engine/install.ts to a main commit that contains them (see sops/versioning.md).",
      ).toEqual([]);
    },
  );

  onFullClone(`missingAt flags a path absent from the pinned tree${skipTag("shallow clone")}`, () => {
    // The scratch collector case above proves the paths are collected; this
    // proves the check behind them fires. Both together are the m1 evidence.
    expect(missingAt(ENGINE_REF, ["package.json", "engine/ci/does-not-exist.js"])).toEqual([
      "engine/ci/does-not-exist.js",
    ]);
  });
});
