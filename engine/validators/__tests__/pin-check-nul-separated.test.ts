/**
 * pin-check-nul-separated.test.ts — the-metafactory/compass-core#55 (split
 * from PR #52 round-3 review, H1).
 *
 * `git diff --name-only`, without `-z`, C-quotes any path containing a
 * non-ASCII byte, a tab, a `"` or a control character (git's `core.quotePath`
 * default, unconditional for quote/backslash/control bytes, same on the
 * runner). The quoted line starts with `"`, so it matched neither the
 * shell's `case .github/workflows/*)` nor the TS `startsWith(".github/workflows/")`
 * — a new workflow file with such a name (or a rename that lands one at a
 * guarded path, or removes one from a guarded path) passed pin-check
 * unlabelled. Confirmed on real git fixtures against commit `78f085b`
 * (current main before this fix): `.github/workflows/gövernance.yml`,
 * `a<TAB>b.yml`, `a"b.yml` and a name containing a literal newline all
 * evaded, in BOTH the shell and the TS.
 *
 * The fix (see engine/validators/pin-check.ts's computeChangedPaths, and
 * templates/workflows/compass-pin-check.yml + its mirrored
 * .github/workflows/compass-pin-check.yml) reads `git diff -z` everywhere and
 * splits on NUL, never on newline, and never `.trim()`s an entry — a leading
 * or trailing space in a real filename is path content, not whitespace to
 * strip.
 *
 * This file has two halves:
 *
 *   1. WATCHED FAILING ON 78f085b — the exact shell bytes shipped at that
 *      commit (committed as a fixture: 78f085b's own copy is reachable today,
 *      but pinning a fixture blob is the same discipline
 *      governance-workflow-hardening.test.ts's G1 proof uses, and survives a
 *      future rewrite of main's history), plus a reproduction of the
 *      PRE-#55 computeChangedPaths body (split on "\n", `.trim()`ed) — run
 *      against real git fixture repos built the same way the rest of this
 *      suite builds them. Both are shown defeated by the quoted-name
 *      fixtures, and NOT defeated by a leading-space name (space is not one
 *      of git's always-quoted bytes — confirmed empirically below, included
 *      as a control, not a sixth evasion).
 *
 *   2. SHELL vs TS AGREEMENT ON THE FIX — the CURRENT extracted shell and the
 *      real (imported, not reproduced) computeChangedPaths/evaluatePinChange
 *      are run against every fixture in this file, old and new, and must
 *      agree on every one, labelled and unlabelled.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { computeChangedPaths, evaluatePinChange } from "../pin-check.ts";

const REPO = resolve(import.meta.dir, "..", "..", "..");
const NEW_WORKFLOW_PATH = join(REPO, "templates", "workflows", "compass-pin-check.yml");
const OLD_WORKFLOW_FIXTURE_PATH = join(REPO, "engine", "__tests__", "fixtures", "compass-pin-check-78f085b.yml");

// ---------------------------------------------------------------------------
// Extraction: pull the pin-check decision step's `run:` text out of a
// compass-pin-check.yml (old or new — the shape of the surrounding job is
// unchanged by this fix, only the body of this one step is).
// ---------------------------------------------------------------------------

function extractDecisionScript(rawYaml: string): string {
  const doc = parse(rawYaml) as any;
  const steps: any[] = doc.jobs?.["pin-check"]?.steps ?? [];
  const step = steps.find((s) => typeof s.run === "string" && s.run.includes("HAS_PIN_BUMP_LABEL"));
  if (!step) throw new Error("could not find the pin-check decision step (run: containing HAS_PIN_BUMP_LABEL)");
  return step.run as string;
}

/**
 * The decision step also fetches HEAD_SHA from `origin` using a GH_TOKEN —
 * meaningless (and unreachable, no network) in this local, single-repo test
 * fixture, where BASE_SHA and HEAD_SHA are already both present in the one
 * `base/` checkout. Strips exactly that one `git ... fetch --no-tags origin
 * "$HEAD_SHA"` invocation and nothing else — the rest of the script (the
 * diff, the read loop, the decision, the messages) is executed byte-for-byte
 * as shipped.
 */
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
// Fixture repo builder
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

function rmAt(repoDir: string, relPath: string) {
  execFileSync("git", ["rm", "-q", "--", relPath], { cwd: repoDir });
}

/**
 * Builds a fresh repo at `<tmp>/base` (the shell script's own convention —
 * it always runs `git -C base diff ...`), commits `setupBase` as the base
 * commit, then commits `setupHead` on top as the head commit. Returns the
 * parent dir (to run the shell in) and the repo dir + both SHAs (to run the
 * TS functions against).
 */
function makeFixture(
  setupBase: (repoDir: string) => void,
  setupHead: (repoDir: string) => void,
): { parentDir: string; repoDir: string; baseSha: string; headSha: string } {
  const parentDir = mkdtempSync(join(tmpdir(), "pin-check-fixture-"));
  const repoDir = join(parentDir, "base");
  mkdirSync(repoDir);
  git(repoDir, ["init", "-q"]);
  git(repoDir, ["config", "core.quotePath", "true"]); // explicit: this is git's own default, asserted rather than assumed
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
  const runnerTemp = mkdtempSync(join(tmpdir(), "pin-check-runnertemp-"));
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

// ---------------------------------------------------------------------------
// Old (pre-#55) computeChangedPaths, reproduced for the watched-failing
// proof only. Not imported — the real implementation in pin-check.ts is
// already fixed by this PR. Byte-for-byte the old body: split on "\n",
// `.trim()` each line, drop empties.
// ---------------------------------------------------------------------------

function oldComputeChangedPaths(baseSha: string, headSha: string, cwd: string): string[] {
  const proc = execFileSync("git", ["diff", "--no-renames", "--name-only", `${baseSha}...${headSha}`], {
    cwd,
    encoding: "utf8",
  });
  return proc
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------
// PART 1 — watched failing on 78f085b
// ---------------------------------------------------------------------------

const GOVERNANCE_WORKFLOW = ".github/workflows/compass-governance.yml";

describe("H1 — watched failing on 78f085b (before #55)", () => {
  const NAME_FIXTURES: Array<{ label: string; relPath: string; expectEvades: boolean }> = [
    { label: "non-ASCII: gövernance.yml", relPath: ".github/workflows/gövernance.yml", expectEvades: true },
    { label: "tab: a<TAB>b.yml", relPath: ".github/workflows/a\tb.yml", expectEvades: true },
    { label: 'quote: a"b.yml', relPath: '.github/workflows/a"b.yml', expectEvades: true },
    { label: "newline: a<LF>b.yml", relPath: ".github/workflows/a\nb.yml", expectEvades: true },
    {
      label: "leading space: ' leading.yml' (control — space is not a git quoting trigger)",
      relPath: ".github/workflows/ leading.yml",
      expectEvades: false,
    },
  ];

  for (const fx of NAME_FIXTURES) {
    test(`${fx.label} — new file, unlabelled, shell + TS on 78f085b`, () => {
      const { parentDir, repoDir, baseSha, headSha } = makeFixture(
        () => {},
        (dir) => writeAt(dir, fx.relPath),
      );
      try {
        const shellResult = runShell(OLD_SCRIPT, parentDir, baseSha, headSha, false);
        const tsPaths = oldComputeChangedPaths(baseSha, headSha, repoDir);
        const tsResult = evaluatePinChange(tsPaths, false);

        if (fx.expectEvades) {
          expect(shellResult.exitCode, `shell on 78f085b: ${fx.label}\n${shellResult.output}`).toBe(0);
          expect(tsResult.blocked, `TS (pre-#55 body) on ${fx.label}`).toBe(false);
        } else {
          expect(shellResult.exitCode, `shell on 78f085b: ${fx.label}\n${shellResult.output}`).not.toBe(0);
          expect(tsResult.blocked, `TS (pre-#55 body) on ${fx.label}`).toBe(true);
        }
      } finally {
        cleanup(parentDir);
      }
    });
  }

  test('rename FROM a quoted+unguarded name INTO a guarded, quoted path (a"b.yml at root -> .github/workflows/a"b.yml) evades on 78f085b', () => {
    const { parentDir, repoDir, baseSha, headSha } = makeFixture(
      (dir) => writeAt(dir, 'a"b.yml'),
      (dir) => {
        rmAt(dir, 'a"b.yml');
        writeAt(dir, '.github/workflows/a"b.yml');
      },
    );
    try {
      const shellResult = runShell(OLD_SCRIPT, parentDir, baseSha, headSha, false);
      const tsPaths = oldComputeChangedPaths(baseSha, headSha, repoDir);
      const tsResult = evaluatePinChange(tsPaths, false);
      expect(shellResult.exitCode, `shell on 78f085b, rename-in\n${shellResult.output}`).toBe(0);
      expect(tsResult.blocked, "TS (pre-#55 body), rename-in").toBe(false);
    } finally {
      cleanup(parentDir);
    }
  });

  test('rename FROM a guarded, quoted path OUT to a quoted+unguarded name (.github/workflows/a"b.yml -> a"b.yml at root) evades on 78f085b', () => {
    const { parentDir, repoDir, baseSha, headSha } = makeFixture(
      (dir) => writeAt(dir, '.github/workflows/a"b.yml'),
      (dir) => {
        rmAt(dir, '.github/workflows/a"b.yml');
        writeAt(dir, 'a"b.yml');
      },
    );
    try {
      const shellResult = runShell(OLD_SCRIPT, parentDir, baseSha, headSha, false);
      const tsPaths = oldComputeChangedPaths(baseSha, headSha, repoDir);
      const tsResult = evaluatePinChange(tsPaths, false);
      expect(shellResult.exitCode, `shell on 78f085b, rename-out\n${shellResult.output}`).toBe(0);
      expect(tsResult.blocked, "TS (pre-#55 body), rename-out").toBe(false);
    } finally {
      cleanup(parentDir);
    }
  });
});

// ---------------------------------------------------------------------------
// PART 2 — shell vs TS agreement on the fix, every fixture old and new
// ---------------------------------------------------------------------------

interface Fixture {
  label: string;
  setupBase: (repoDir: string) => void;
  setupHead: (repoDir: string) => void;
  /** Expected `blocked` when unlabelled. */
  expectBlockedUnlabelled: boolean;
}

const FIXTURES: Fixture[] = [
  // --- the three required cases -------------------------------------------
  {
    label: "F1: edit the governance workflow",
    setupBase: (d) => writeAt(d, GOVERNANCE_WORKFLOW, "a\n"),
    setupHead: (d) => writeAt(d, GOVERNANCE_WORKFLOW, "b\n"),
    expectBlockedUnlabelled: true,
  },
  {
    label: "F3: unrelated README-only diff",
    setupBase: (d) => writeAt(d, "README.md", "a\n"),
    setupHead: (d) => writeAt(d, "README.md", "b\n"),
    expectBlockedUnlabelled: false,
  },
  {
    label: "watched path alongside unrelated files",
    setupBase: (d) => {
      writeAt(d, GOVERNANCE_WORKFLOW, "a\n");
      writeAt(d, "docs/readme.md", "a\n");
    },
    setupHead: (d) => {
      writeAt(d, GOVERNANCE_WORKFLOW, "b\n");
      writeAt(d, "docs/readme.md", "b\n");
    },
    expectBlockedUnlabelled: true,
  },
  // --- every exact watched path --------------------------------------------
  {
    label: "engine/install.ts alone",
    setupBase: (d) => writeAt(d, "engine/install.ts", "a\n"),
    setupHead: (d) => writeAt(d, "engine/install.ts", "b\n"),
    expectBlockedUnlabelled: true,
  },
  {
    label: "templates/workflows/compass-governance.yml alone",
    setupBase: (d) => writeAt(d, "templates/workflows/compass-governance.yml", "a\n"),
    setupHead: (d) => writeAt(d, "templates/workflows/compass-governance.yml", "b\n"),
    expectBlockedUnlabelled: true,
  },
  {
    label: "templates/workflows/compass-pin-check.yml alone",
    setupBase: (d) => writeAt(d, "templates/workflows/compass-pin-check.yml", "a\n"),
    setupHead: (d) => writeAt(d, "templates/workflows/compass-pin-check.yml", "b\n"),
    expectBlockedUnlabelled: true,
  },
  {
    label: ".github/workflows/compass-pin-check.yml alone (G1)",
    setupBase: (d) => writeAt(d, ".github/workflows/compass-pin-check.yml", "a\n"),
    setupHead: (d) => writeAt(d, ".github/workflows/compass-pin-check.yml", "b\n"),
    expectBlockedUnlabelled: true,
  },
  {
    label: "all exact watched paths at once",
    setupBase: (d) => {
      writeAt(d, GOVERNANCE_WORKFLOW, "a\n");
      writeAt(d, "templates/workflows/compass-governance.yml", "a\n");
      writeAt(d, "engine/install.ts", "a\n");
    },
    setupHead: (d) => {
      writeAt(d, GOVERNANCE_WORKFLOW, "b\n");
      writeAt(d, "templates/workflows/compass-governance.yml", "b\n");
      writeAt(d, "engine/install.ts", "b\n");
    },
    expectBlockedUnlabelled: true,
  },
  // --- renames (--no-renames: delete + add) --------------------------------
  {
    label: "rename AWAY from a watched path (plain ASCII)",
    setupBase: (d) => writeAt(d, GOVERNANCE_WORKFLOW, "a\n"),
    setupHead: (d) => {
      rmAt(d, GOVERNANCE_WORKFLOW);
      writeAt(d, ".github/workflows/renamed-away.yml", "a\n");
    },
    expectBlockedUnlabelled: true,
  },
  {
    label: "rename INTO a watched path (plain ASCII)",
    setupBase: (d) => writeAt(d, ".github/workflows/old-name.yml", "a\n"),
    setupHead: (d) => {
      rmAt(d, ".github/workflows/old-name.yml");
      writeAt(d, GOVERNANCE_WORKFLOW, "a\n");
    },
    expectBlockedUnlabelled: true,
  },
  // --- G3: check-name squatting via a brand-new file ------------------------
  {
    label: "G3: brand-new .github/workflows/x.yml",
    setupBase: () => {},
    setupHead: (d) => writeAt(d, ".github/workflows/x.yml"),
    expectBlockedUnlabelled: true,
  },
  {
    label: "G3: brand-new nested .github/workflows/nested/dir/sneaky.yml",
    setupBase: () => {},
    setupHead: (d) => writeAt(d, ".github/workflows/nested/dir/sneaky.yml"),
    expectBlockedUnlabelled: true,
  },
  // --- H1: quoted new-file names --------------------------------------------
  {
    label: "H1: new file, non-ASCII name",
    setupBase: () => {},
    setupHead: (d) => writeAt(d, ".github/workflows/gövernance.yml"),
    expectBlockedUnlabelled: true,
  },
  {
    label: "H1: new file, tab in name",
    setupBase: () => {},
    setupHead: (d) => writeAt(d, ".github/workflows/a\tb.yml"),
    expectBlockedUnlabelled: true,
  },
  {
    label: "H1: new file, quote in name",
    setupBase: () => {},
    setupHead: (d) => writeAt(d, '.github/workflows/a"b.yml'),
    expectBlockedUnlabelled: true,
  },
  {
    label: "H1: new file, newline in name",
    setupBase: () => {},
    setupHead: (d) => writeAt(d, ".github/workflows/a\nb.yml"),
    expectBlockedUnlabelled: true,
  },
  {
    label: "H1 control: new file, leading space in name (not a quoting trigger)",
    setupBase: () => {},
    setupHead: (d) => writeAt(d, ".github/workflows/ leading.yml"),
    expectBlockedUnlabelled: true,
  },
  {
    label: "H1: rename from a quoted+unguarded name into a guarded, quoted path",
    setupBase: (d) => writeAt(d, 'a"b.yml'),
    setupHead: (d) => {
      rmAt(d, 'a"b.yml');
      writeAt(d, '.github/workflows/a"b.yml');
    },
    expectBlockedUnlabelled: true,
  },
  {
    label: "H1: rename from a guarded, quoted path out to a quoted, unguarded name",
    setupBase: (d) => writeAt(d, '.github/workflows/a"b.yml'),
    setupHead: (d) => {
      rmAt(d, '.github/workflows/a"b.yml');
      writeAt(d, 'a"b.yml');
    },
    expectBlockedUnlabelled: true,
  },
  // --- unrelated, to round out the count ------------------------------------
  {
    label: "unrelated add + delete elsewhere in the tree",
    setupBase: (d) => writeAt(d, "src/foo.ts"),
    setupHead: (d) => {
      rmAt(d, "src/foo.ts");
      writeAt(d, "src/bar.ts");
    },
    expectBlockedUnlabelled: false,
  },
  // --- J1 (issue #67): notice-injection-shaped filename still blocks --------
  // The embedded newline+::stop-commands:: only forges the SHELL LOG (see
  // pin-check-notice-sanitise.test.ts); it changes nothing about whether
  // this path is watched, so shell and TS must still agree it blocks.
  {
    label: "J1: new file with an embedded newline shaped like a workflow-command injection",
    setupBase: () => {},
    setupHead: (d) => writeAt(d, ".github/workflows/evil\n::stop-commands::x.yml"),
    expectBlockedUnlabelled: true,
  },
];

describe("shell vs TS agreement on the fix (#55) — every fixture, old and new", () => {
  let agreedCount = 0;

  for (const fx of FIXTURES) {
    for (const hasPinBumpLabel of [false, true]) {
      test(`${fx.label} — hasPinBumpLabel=${hasPinBumpLabel}`, () => {
        const { parentDir, repoDir, baseSha, headSha } = makeFixture(fx.setupBase, fx.setupHead);
        try {
          const shellResult = runShell(NEW_SCRIPT, parentDir, baseSha, headSha, hasPinBumpLabel);
          const shellBlocked = shellResult.exitCode !== 0;

          const tsPaths = computeChangedPaths(baseSha, headSha, repoDir);
          const tsResult = evaluatePinChange(tsPaths, hasPinBumpLabel);

          const expectedBlocked = fx.expectBlockedUnlabelled && !hasPinBumpLabel;

          expect(shellBlocked, `shell: ${fx.label} (label=${hasPinBumpLabel})\n${shellResult.output}`).toBe(
            expectedBlocked,
          );
          expect(tsResult.blocked, `TS: ${fx.label} (label=${hasPinBumpLabel})`).toBe(expectedBlocked);
          expect(shellBlocked, `shell/TS disagree: ${fx.label} (label=${hasPinBumpLabel})`).toBe(tsResult.blocked);

          agreedCount++;
        } finally {
          cleanup(parentDir);
        }
      });
    }
  }

  test("agreement count", () => {
    // FIXTURES.length fixtures, each run at both label states — every one
    // must have agreed (both assertions above passed) for this to be
    // reached with the expected total. bun runs tests in declaration order
    // within a describe, so by the time this final test runs, every fixture
    // test above has already executed and incremented agreedCount on success.
    expect(agreedCount).toBe(FIXTURES.length * 2);
    console.log(`shell vs TS agreement: ${agreedCount}/${FIXTURES.length * 2} (${FIXTURES.length} fixtures × 2 label states)`);
  });
});
