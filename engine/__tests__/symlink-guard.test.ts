/**
 * symlink-guard.test.ts — behavioural fixtures for the-metafactory/compass-core#41
 * PR #52, round-2 review G4.
 *
 * The governance workflow's symlink guard used to refuse EVERY symlink under
 * pr-head/, unconditionally. That's wrong: a repo that legitimately commits
 * one (a `CLAUDE.md -> AGENTS.md` link is a real, common shape) would be
 * permanently red on every PR, for a link that never leaves the checkout and
 * never resolves to anything this workflow doesn't already treat as PR
 * content. The fix narrows the refusal to exactly the two cases that matter:
 * a symlink whose resolved target lies OUTSIDE pr-head/ (it can point at
 * base/.git/config, a runner temp file, anything else on the runner), or one
 * that is DANGLING (resolves to nothing — a link a PR times to point at a
 * path this checkout is about to create).
 *
 * This file does not parse the YAML and assert about its shape (that's
 * governance-workflow-hardening.test.ts) — it EXTRACTS the real `run:` shell
 * from the template and actually executes it against real directories
 * containing real symlinks, so the three required fixtures are exercised as
 * behaviour, not as a text pattern:
 *   1. in-tree symlink (CLAUDE.md -> AGENTS.md, both under pr-head/) -> PASSES
 *   2. out-of-tree symlink (pr-head/escape -> ../outside/secret) -> RED
 *   3. a symlinked DIRECTORY pointing out of tree -> RED
 *
 * Requires `realpath` (GNU coreutils) and bash — both present on the
 * ubuntu-latest runner this step actually runs on. Skipped automatically
 * where `realpath` isn't available (e.g. a bare macOS dev machine without
 * coreutils installed) rather than failing for an unrelated reason.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const REPO = resolve(import.meta.dir, "..", "..");

function extractSymlinkGuardScript(): string {
  const raw = require("node:fs").readFileSync(
    join(REPO, "templates", "workflows", "compass-governance.yml"),
    "utf8",
  ) as string;
  const doc = parse(raw.replace(/\{\{template:compass_core_ref\}\}/, "0".repeat(40))) as any;
  const steps: any[] = doc.jobs.governance.steps ?? [];
  const step = steps.find((s) => typeof s.run === "string" && /find\s+pr-head\s+-type\s+l/.test(s.run));
  if (!step) throw new Error("could not find the symlink-guard step in compass-governance.yml");
  return step.run as string;
}

/**
 * The shipped script uses plain `realpath -m` — correct for the ubuntu-latest
 * runner it actually executes on (GNU coreutils). A macOS dev machine's BSD
 * `realpath` has no `-m` flag at all, which would make this file spuriously
 * skip everywhere except CI. Rather than water down the SCRIPT UNDER TEST
 * (that would stop testing what actually ships), this shims the local PATH:
 * if GNU `realpath -m` isn't already on PATH but Homebrew's `grealpath` is,
 * a tiny bin/ dir with `realpath -> grealpath` is prepended for the
 * subprocess only. The extracted shell text itself is never touched.
 */
function gnuRealpathPathOverride(): string | null {
  try {
    execFileSync("realpath", ["-m", "."], { stdio: "ignore" });
    return null; // already GNU-compatible, no override needed
  } catch {
    // fall through
  }
  let grealpath: string;
  try {
    grealpath = execFileSync("which", ["grealpath"], { encoding: "utf8" }).trim();
  } catch {
    return "MISSING";
  }
  const shimDir = mkdtempSync(join(tmpdir(), "symlink-guard-shim-"));
  symlinkSync(grealpath, join(shimDir, "realpath"));
  return shimDir;
}

const SHIM_DIR = gnuRealpathPathOverride();
const SCRIPT = extractSymlinkGuardScript();
const maybeTest = SHIM_DIR === "MISSING" ? test.skip : test;

/** Runs the extracted guard script with cwd = the given workdir. Returns {exitCode, output}. */
function runGuard(workdir: string): { exitCode: number; output: string } {
  const env =
    SHIM_DIR && SHIM_DIR !== "MISSING" ? { ...process.env, PATH: `${SHIM_DIR}:${process.env.PATH}` } : process.env;
  try {
    const out = execFileSync("bash", ["-c", SCRIPT], { cwd: workdir, encoding: "utf8", stdio: "pipe", env });
    return { exitCode: 0, output: out };
  } catch (err: any) {
    return { exitCode: err.status ?? 1, output: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

describe("symlink guard — G4, behavioural fixtures against the real extracted shell", () => {
  maybeTest("FIXTURE 1 (in-tree): CLAUDE.md -> AGENTS.md, both inside pr-head/ -> passes", () => {
    const dir = mkdtempSync(join(tmpdir(), "symlink-guard-intree-"));
    try {
      mkdirSync(join(dir, "pr-head"));
      writeFileSync(join(dir, "pr-head", "AGENTS.md"), "# Agents\n");
      symlinkSync("AGENTS.md", join(dir, "pr-head", "CLAUDE.md"));

      const result = runGuard(dir);
      expect(result.exitCode, result.output).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  maybeTest("FIXTURE 2 (out-of-tree file): pr-head/escape -> ../outside/secret -> red", () => {
    const dir = mkdtempSync(join(tmpdir(), "symlink-guard-outoftree-"));
    try {
      mkdirSync(join(dir, "pr-head"));
      mkdirSync(join(dir, "outside"));
      writeFileSync(join(dir, "outside", "secret"), "shh\n");
      symlinkSync("../outside/secret", join(dir, "pr-head", "escape"));

      const result = runGuard(dir);
      expect(result.exitCode, result.output).not.toBe(0);
      expect(result.output).toMatch(/escapes the checkout/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  maybeTest("FIXTURE 3 (out-of-tree directory): pr-head/escaped-dir -> ../outside -> red, not followed", () => {
    const dir = mkdtempSync(join(tmpdir(), "symlink-guard-outoftree-dir-"));
    try {
      mkdirSync(join(dir, "pr-head"));
      mkdirSync(join(dir, "outside"));
      writeFileSync(join(dir, "outside", "whatever.txt"), "content\n");
      symlinkSync("../outside", join(dir, "pr-head", "escaped-dir"));

      const result = runGuard(dir);
      expect(result.exitCode, result.output).not.toBe(0);
      expect(result.output).toMatch(/escapes the checkout/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  maybeTest("dangling in-tree symlink (target inside pr-head/ but does not exist) -> red", () => {
    const dir = mkdtempSync(join(tmpdir(), "symlink-guard-dangling-"));
    try {
      mkdirSync(join(dir, "pr-head"));
      symlinkSync("does-not-exist.md", join(dir, "pr-head", "link.md"));

      const result = runGuard(dir);
      expect(result.exitCode, result.output).not.toBe(0);
      expect(result.output).toMatch(/dangling/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  maybeTest("no symlinks at all -> passes cleanly", () => {
    const dir = mkdtempSync(join(tmpdir(), "symlink-guard-none-"));
    try {
      mkdirSync(join(dir, "pr-head"));
      writeFileSync(join(dir, "pr-head", "README.md"), "# hi\n");

      const result = runGuard(dir);
      expect(result.exitCode, result.output).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  maybeTest("watched failing: the OLD (round-1) unconditional refusal would have failed fixture 1", () => {
    // Round-1's guard was `if find pr-head -type l -print -quit | grep -q .;
    // then refuse`. Run THAT against fixture 1's in-tree symlink directly —
    // proving the in-tree case really did use to go red, which is exactly
    // the bug G4 reports.
    const OLD_SCRIPT = `
set -euo pipefail
if find pr-head -type l -print -quit | grep -q .; then
  echo "::error::pr-head/ contains a symlink — refusing to scan it."
  exit 1
fi
`;
    const dir = mkdtempSync(join(tmpdir(), "symlink-guard-old-behavior-"));
    try {
      mkdirSync(join(dir, "pr-head"));
      writeFileSync(join(dir, "pr-head", "AGENTS.md"), "# Agents\n");
      symlinkSync("AGENTS.md", join(dir, "pr-head", "CLAUDE.md"));

      let exitCode = 0;
      try {
        execFileSync("bash", ["-c", OLD_SCRIPT], { cwd: dir, stdio: "pipe" });
      } catch (err: any) {
        exitCode = err.status ?? 1;
      }
      expect(exitCode, "the round-1 guard should have refused an in-tree symlink — confirming G4's bug").not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
