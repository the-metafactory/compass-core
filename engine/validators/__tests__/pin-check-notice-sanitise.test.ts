/**
 * pin-check-notice-sanitise.test.ts — the-metafactory/compass-core#67 (from
 * PR #66's review, J1 and J2).
 *
 * J1: since #66's `-z`/NUL-delimited read loop, a filename containing a raw
 * newline reaches `echo "::notice::pin-sensitive path changed: $p"` intact.
 * A filename crafted as `evil<LF>::stop-commands::x.yml` prints:
 *
 *   ::notice::pin-sensitive path changed: evil
 *   ::stop-commands::x.yml
 *
 * — a bare `::stop-commands::` line the Actions runner would treat as a real
 * workflow command, suppressing every subsequent `::error::`/`::notice::`
 * until a matching `::x.yml::` (which never comes). The job's own verdict
 * (exit code) is unaffected either way — this is a log-forgery/annotation-
 * suppression bug, not a bypass — but the whole point of the annotation is
 * to be visible to a reviewer skimming the checks tab. Fix: strip CR and LF
 * from the path with `tr -d '\n\r'` before it is echoed, the same idiom
 * compass-governance.yml already uses for its own PR-controlled `$f`
 * (`safe_f=$(printf '%s' "$f" | tr -d '\n\r')`).
 *
 * J2: `computeChangedPaths` decoded git's `-z` output as a UTF-8 string
 * (`spawnSync(..., { encoding: "utf8" })`). A filename is an arbitrary POSIX
 * byte string, under no obligation to be valid UTF-8; an invalid sequence
 * decodes to U+FFFD, lossily. It never changes a MATCH (every
 * PIN_SENSITIVE_PATHS/PREFIXES entry is plain ASCII, and ASCII decodes
 * identically either way) but the returned path is no longer the same bytes
 * as the file on disk. Fix: read stdout as a `Buffer`, split on the literal
 * NUL byte, and decode each segment with `"latin1"` (byte 0..255 <->
 * code-unit 0..255, round-trips via `Buffer.from(s, "latin1")`).
 *
 * Threat model for both: a PR author trying to hide or forge pin-check's
 * OWN annotations from a human reviewer, or make the log lie about which
 * bytes were actually diffed. Neither can flip the verdict.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { computeChangedPaths } from "../pin-check.ts";

const REPO = resolve(import.meta.dir, "..", "..", "..");
const NEW_WORKFLOW_PATH = join(REPO, "templates", "workflows", "compass-pin-check.yml");
const OLD_WORKFLOW_FIXTURE_PATH = join(REPO, "engine", "__tests__", "fixtures", "compass-pin-check-e712d81.yml");

// ---------------------------------------------------------------------------
// Extraction (same shape as pin-check-nul-separated.test.ts's, duplicated
// per this repo's own convention of keeping each fixture file
// self-contained — see that file's header).
// ---------------------------------------------------------------------------

function extractDecisionScript(rawYaml: string): string {
  const doc = parse(rawYaml) as any;
  const steps: any[] = doc.jobs?.["pin-check"]?.steps ?? [];
  const step = steps.find((s) => typeof s.run === "string" && s.run.includes("HAS_PIN_BUMP_LABEL"));
  if (!step) throw new Error("could not find the pin-check decision step (run: containing HAS_PIN_BUMP_LABEL)");
  return step.run as string;
}

/** Strips the network `fetch` line — meaningless in a local, single-repo fixture. */
function stripFetchStep(script: string): string {
  const stripped = script.replace(
    /git -C base -c http\.https:\/\/github\.com\/\.extraheader="[\s\S]*?fetch --no-tags origin "\$HEAD_SHA"\n/,
    "",
  );
  if (stripped === script) {
    throw new Error("failed to strip the fetch step — the extracted script's shape changed; update this pattern");
  }
  return stripped;
}

const NEW_SCRIPT = stripFetchStep(extractDecisionScript(readFileSync(NEW_WORKFLOW_PATH, "utf8")));
const OLD_SCRIPT = stripFetchStep(extractDecisionScript(readFileSync(OLD_WORKFLOW_FIXTURE_PATH, "utf8")));

// ---------------------------------------------------------------------------
// Fixture repo builder (same as pin-check-nul-separated.test.ts)
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function commit(repoDir: string, message: string, allowEmpty = false): string {
  git(repoDir, ["add", "-A"]);
  const args = ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", message];
  if (allowEmpty) args.push("--allow-empty");
  git(repoDir, args);
  return git(repoDir, ["rev-parse", "HEAD"]).trim();
}

function writeAt(repoDir: string, relPath: string, content = "x\n") {
  const full = join(repoDir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function makeFixture(
  setupBase: (repoDir: string) => void,
  setupHead: (repoDir: string) => void,
): { parentDir: string; repoDir: string; baseSha: string; headSha: string } {
  const parentDir = mkdtempSync(join(tmpdir(), "pin-check-notice-fixture-"));
  const repoDir = join(parentDir, "base");
  mkdirSync(repoDir);
  git(repoDir, ["init", "-q"]);
  git(repoDir, ["config", "core.quotePath", "true"]);
  setupBase(repoDir);
  const baseSha = commit(repoDir, "base", true);
  setupHead(repoDir);
  const headSha = commit(repoDir, "head", true);
  return { parentDir, repoDir, baseSha, headSha };
}

function runShell(
  script: string,
  parentDir: string,
  baseSha: string,
  headSha: string,
  hasPinBumpLabel: boolean,
): { exitCode: number; output: string } {
  const runnerTemp = mkdtempSync(join(tmpdir(), "pin-check-notice-runnertemp-"));
  try {
    const env = {
      ...process.env,
      RUNNER_TEMP: runnerTemp,
      BASE_SHA: baseSha,
      HEAD_SHA: headSha,
      HAS_PIN_BUMP_LABEL: String(hasPinBumpLabel),
    };
    try {
      const out = execFileSync("bash", ["-c", script], { cwd: parentDir, encoding: "utf8", stdio: "pipe", env });
      return { exitCode: 0, output: out };
    } catch (err: any) {
      return { exitCode: err.status ?? 1, output: (err.stdout ?? "") + (err.stderr ?? "") };
    }
  } finally {
    rmSync(runnerTemp, { recursive: true, force: true });
  }
}

function cleanup(parentDir: string) {
  rmSync(parentDir, { recursive: true, force: true });
}

/** Every line of `output` that starts with `::`, split on LF only (bash's own line boundary here). */
function colonColonLines(output: string): string[] {
  return output.split("\n").filter((l) => l.startsWith("::"));
}

// ---------------------------------------------------------------------------
// J1 — watched failing on e712d81 (current main before this fix), then fixed
// ---------------------------------------------------------------------------

describe("J1 — a newline-plus-::stop-commands:: filename forges a workflow command", () => {
  const EVIL_NAME = ".github/workflows/evil\n::stop-commands::x.yml";

  test("watched failing on e712d81: the raw newline splits the notice into a bare ::stop-commands:: line", () => {
    const { parentDir, baseSha, headSha } = makeFixture(
      () => {},
      (dir) => writeAt(dir, EVIL_NAME),
    );
    try {
      const result = runShell(OLD_SCRIPT, parentDir, baseSha, headSha, /* hasPinBumpLabel */ false);

      // Verdict is unaffected by the injection either way.
      expect(result.exitCode, `e712d81 script exit code\n${result.output}`).toBe(1);

      const forged = colonColonLines(result.output).filter((l) => !/^::(notice|error)::/.test(l));
      expect(
        forged,
        `expected a bare (non notice/error) workflow-command-shaped line from the raw newline\n${result.output}`,
      ).not.toHaveLength(0);
      expect(forged.some((l) => l.startsWith("::stop-commands::"))).toBe(true);
    } finally {
      cleanup(parentDir);
    }
  });

  test("after the fix: no line starts with :: apart from the step's own notice/error lines, verdict unchanged", () => {
    const { parentDir, baseSha, headSha } = makeFixture(
      () => {},
      (dir) => writeAt(dir, EVIL_NAME),
    );
    try {
      const result = runShell(NEW_SCRIPT, parentDir, baseSha, headSha, /* hasPinBumpLabel */ false);

      expect(result.exitCode, `fixed script exit code\n${result.output}`).toBe(1);

      const forged = colonColonLines(result.output).filter((l) => !/^::(notice|error)::/.test(l));
      expect(forged, `no line should start with :: except the step's own notice/error\n${result.output}`).toHaveLength(
        0,
      );

      // The notice line itself must still name the (now-sanitised) path —
      // sanitising isn't the same as silently dropping the notice.
      expect(result.output).toMatch(/^::notice::pin-sensitive path changed: /m);
    } finally {
      cleanup(parentDir);
    }
  });

  test("labelled pin-bump: no injected line, exit code 0, same before and after", () => {
    for (const script of [OLD_SCRIPT, NEW_SCRIPT]) {
      const { parentDir, baseSha, headSha } = makeFixture(
        () => {},
        (dir) => writeAt(dir, EVIL_NAME),
      );
      try {
        const result = runShell(script, parentDir, baseSha, headSha, /* hasPinBumpLabel */ true);
        expect(result.exitCode, `labelled exit code\n${result.output}`).toBe(0);
      } finally {
        cleanup(parentDir);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// J2 — computeChangedPaths byte-exactness
// ---------------------------------------------------------------------------

/** "bad-<0xFF><0xFE>-name.yml" — 0xFF and 0xFE are never valid UTF-8 lead or
 * continuation bytes, so any UTF-8 decoder must replace them with U+FFFD. */
const INVALID_UTF8_NAME = Buffer.concat([
  Buffer.from("bad-", "utf8"),
  Buffer.from([0xff, 0xfe]),
  Buffer.from("-name.yml", "utf8"),
]);

/** Pre-#67 computeChangedPaths body, reproduced (not imported — pin-check.ts
 * is already fixed by this PR): UTF-8 string, split on "\0". */
function oldComputeChangedPaths(baseSha: string, headSha: string, cwd: string): string[] {
  const proc = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", `${baseSha}...${headSha}`], {
    cwd,
    encoding: "utf8",
  });
  return proc.split("\0").filter((l) => l.length > 0);
}

/**
 * Builds base/head commits with a byte-exact filename entirely through git
 * plumbing (hash-object / mktree -z / commit-tree) — never through the OS
 * filesystem. A real POSIX filesystem (Linux) would happily store a filename
 * with invalid-UTF-8 bytes, but macOS's (APFS/HFS+) rejects it outright
 * (EILSEQ), so writing the file to disk under that name is not portable
 * across the platforms this suite runs on. mktree -z reads/writes raw path
 * bytes with no such restriction (confirmed against real git: the produced
 * tree's `ls-tree -z`/`diff -z` output carries the exact bytes given), and
 * it's what `computeChangedPaths` reads from `git diff -z` regardless of how
 * the tree was built.
 */
function commitTreeWithBytePath(repoDir: string, pathBytes: Buffer, content: string): { baseSha: string; headSha: string } {
  const gitC = (args: string[], input?: string | Buffer) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.com", ...args], { cwd: repoDir, input });

  const emptyTree = gitC(["mktree"], "").toString("utf8").trim();
  const baseSha = gitC(["commit-tree", emptyTree, "-m", "base"]).toString("utf8").trim();

  const blobSha = gitC(["hash-object", "-w", "--stdin"], content).toString("utf8").trim();
  const entry = Buffer.concat([Buffer.from(`100644 blob ${blobSha}\t`, "utf8"), pathBytes, Buffer.from([0])]);
  const headTree = gitC(["mktree", "-z"], entry).toString("utf8").trim();
  const headSha = gitC(["commit-tree", headTree, "-p", baseSha, "-m", "head"]).toString("utf8").trim();

  return { baseSha, headSha };
}

describe("J2 — computeChangedPaths reads git's output byte-exact", () => {
  test("a path with invalid UTF-8 bytes round-trips byte-exact after the fix; did not before", () => {
    const parentDir = mkdtempSync(join(tmpdir(), "pin-check-j2-"));
    const repoDir = join(parentDir, "base");
    try {
      mkdirSync(repoDir);
      git(repoDir, ["init", "-q"]);
      const { baseSha, headSha } = commitTreeWithBytePath(repoDir, INVALID_UTF8_NAME, "x\n");

      // After the fix (real, imported computeChangedPaths).
      const newPaths = computeChangedPaths(baseSha, headSha, repoDir);
      expect(newPaths).toHaveLength(1);
      const roundTripped = Buffer.from(newPaths[0], "latin1");
      expect(
        roundTripped.equals(INVALID_UTF8_NAME),
        `expected the fixed computeChangedPaths to round-trip the exact bytes; got ${JSON.stringify(newPaths[0])}`,
      ).toBe(true);

      // Before the fix (reproduced pre-#67 body): lossy through UTF-8.
      const oldPaths = oldComputeChangedPaths(baseSha, headSha, repoDir);
      expect(oldPaths).toHaveLength(1);
      const oldRoundTripped = Buffer.from(oldPaths[0], "utf8");
      expect(
        oldRoundTripped.equals(INVALID_UTF8_NAME),
        "the pre-#67 (UTF-8-decoded) body must NOT round-trip byte-exact — this is the bug J2 fixes",
      ).toBe(false);
    } finally {
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  test("guarded-path matching is unaffected: plain ASCII paths decode identically under the fix", () => {
    const parentDir = mkdtempSync(join(tmpdir(), "pin-check-j2-ascii-"));
    const repoDir = join(parentDir, "base");
    try {
      mkdirSync(repoDir);
      git(repoDir, ["init", "-q"]);
      const baseSha = commit(repoDir, "base", true);
      writeAt(repoDir, ".github/workflows/compass-governance.yml", "a\n");
      writeAt(repoDir, "engine/install.ts", "a\n");
      const headSha = commit(repoDir, "head");

      const newPaths = computeChangedPaths(baseSha, headSha, repoDir).sort();
      const oldPaths = oldComputeChangedPaths(baseSha, headSha, repoDir).sort();
      expect(newPaths).toEqual(oldPaths);
      expect(newPaths).toEqual([".github/workflows/compass-governance.yml", "engine/install.ts"].sort());
    } finally {
      rmSync(parentDir, { recursive: true, force: true });
    }
  });
});
