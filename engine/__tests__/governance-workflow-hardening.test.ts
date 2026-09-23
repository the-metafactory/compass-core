/**
 * governance-workflow-hardening.test.ts — static guard for
 * the-metafactory/compass-core#41 ruling item 1 (Andreas, 2026-09-24):
 * "Governance runs under pull_request_target, so the workflow and the engine
 * pin always come from main, never from the PR."
 *
 * Before this issue's fix, compass-governance.yml (both the self-hosted copy
 * at .github/workflows/ and the template every consumer renders) triggered on
 * plain `pull_request`, which runs the PR HEAD's own copy of the workflow
 * file — a PR could repoint its own engine pin and be gated by whatever
 * engine version it chose. This file asks the YAML itself, not the runtime
 * behaviour (no `act`, nothing executed):
 *
 *   - the trigger is `pull_request_target`, not `pull_request` (the property
 *     that makes the workflow file, and the pin inside it, always come from
 *     the default branch);
 *   - the compass-core engine checkout's `ref:` is a literal full 40-hex
 *     commit SHA (unchanged from before this issue, but load-bearing: a
 *     branch or tag name there would defeat the pin regardless of trigger);
 *   - no checkout step names `github.event.pull_request.head.sha` (or any
 *     other PR-head-controlled ref) without BOTH `persist-credentials: false`
 *     and a `path:` that isolates it from the job's default working
 *     directory — and no `run:`/`working-directory:` in the job then treats
 *     that isolated directory as something to execute rather than read;
 *   - `permissions:` grants nothing beyond `contents: read` (plus
 *     `issues: read` on the job that lists repo labels) — no `write` scope
 *     anywhere;
 *   - no PR-controlled string (title, body, head ref, label name) is
 *     interpolated directly into a `run:` script via `${{ github.event.pull_request... }}`
 *     — the only such interpolations state values must travel through `env:`.
 *
 * FAILS ON CURRENT MAIN, watched: main's compass-governance.yml (both copies)
 * declares `on: pull_request:`, which this file's first assertion rejects —
 * run this test on an unmodified checkout to see it red.
 *
 * PR #52 round-2 review, G1: pin-check moved into its own workflow file,
 * compass-pin-check.yml, precisely because it needs `labeled`/`unlabeled` in
 * its trigger types and `compass-governance.yml` must NOT — a label event
 * that starts a new `governance` run just to have it skip (or short-circuit
 * via a job-level `if:`) reports SUCCESS for a skipped required check
 * (GitHub: "A job that is skipped will report its status as 'Success'"),
 * which would let a label click launder a genuinely red governance run into
 * a green one on the same commit. See "G1: governance never reacts to a
 * label event" below — watched failing at commit 550cae9, which had exactly
 * that shape (types: [..., labeled, unlabeled] plus a job-level
 * `if: github.event.action != 'labeled' && ...` on the governance job).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const REPO = resolve(import.meta.dir, "..", "..");

function parseWorkflow(raw: string): any {
  return parse(raw.replace(/\{\{template:compass_core_ref\}\}/, "0".repeat(40))) as any;
}

/**
 * G1's rule, applied to arbitrary workflow TEXT (used both against the
 * current tree and, in the watched-failing test below, against the exact
 * bytes of compass-governance.yml at commit 550cae9). Returns a list of
 * violations; empty means clean.
 */
function findG1Violations(raw: string): string[] {
  const doc = parseWorkflow(raw);
  const violations: string[] = [];
  const on = doc.on ?? doc[true];
  const types: string[] = on?.pull_request_target?.types ?? [];
  if (types.includes("labeled") || types.includes("unlabeled")) {
    violations.push("on.pull_request_target.types includes labeled/unlabeled");
  }
  for (const [name, job] of Object.entries<any>(doc.jobs ?? {})) {
    if (typeof job.if === "string" && job.if.includes("github.event.action")) {
      violations.push(`job "${name}" has a job-level if: referencing github.event.action`);
    }
  }
  return violations;
}

const GOVERNANCE_FIXTURES = [
  {
    label: "self-hosted (.github/workflows/compass-governance.yml)",
    path: join(REPO, ".github", "workflows", "compass-governance.yml"),
    rendered: true,
  },
  {
    label: "template (templates/workflows/compass-governance.yml)",
    path: join(REPO, "templates", "workflows", "compass-governance.yml"),
    rendered: false,
  },
];

const PIN_CHECK_FIXTURES = [
  {
    label: "self-hosted (.github/workflows/compass-pin-check.yml)",
    path: join(REPO, ".github", "workflows", "compass-pin-check.yml"),
  },
  {
    label: "template (templates/workflows/compass-pin-check.yml)",
    path: join(REPO, "templates", "workflows", "compass-pin-check.yml"),
  },
];

/** Executable-looking command verbs a `run:` line must never aim at PR-head data. */
const EXEC_VERBS = "(?:bun|bunx|node|npm|npx|yarn|pnpm|python3?|ruby|perl|sh|bash|source|\\.)";

// ---------------------------------------------------------------------------
// compass-governance.yml — plain pull_request_target, never labeled/unlabeled
// ---------------------------------------------------------------------------

for (const fixture of GOVERNANCE_FIXTURES) {
  describe(`governance workflow hardening — ${fixture.label}`, () => {
    const raw = readFileSync(fixture.path, "utf8");
    // The template's engine-checkout ref is `{{template:compass_core_ref}}`,
    // a placeholder install.ts substitutes at render time — not valid YAML on
    // its own (a bare `{{...}}` parses as a flow mapping). Stand a dummy
    // 40-hex value in for it purely so this file can parse the structure;
    // the placeholder's own literal text is asserted separately below.
    const doc = parseWorkflow(raw);

    test("triggers on pull_request_target, not pull_request", () => {
      // yaml parses the bare `on:` key as the boolean `true` in YAML 1.1
      // unless quoted; this repo's workflows all write `on:` unquoted, so
      // read it back the same way GitHub Actions itself would.
      const on = doc.on ?? doc[true];
      expect(on).toBeDefined();
      expect(Object.keys(on)).toContain("pull_request_target");
      expect(Object.keys(on)).not.toContain("pull_request");
    });

    test("G1: never reacts to a label event, and no job-level if: on github.event.action", () => {
      // This is the correctness fix, not an optimisation (round-2 review,
      // G1): a SKIPPED required job reports "Success", so a governance run
      // that starts on a label event and then no-ops via if: would let a
      // label click turn a red governance into a green one on the same
      // commit. The only correct fix is that a label event never starts a
      // new governance run in the first place — see findG1Violations, and
      // the watched-failing test below for proof this actually catches the
      // shape that shipped at 550cae9.
      expect(findG1Violations(raw)).toEqual([]);
    });

    test("the compass-core engine checkout ref is pinned, not a branch or tag", () => {
      if (fixture.rendered) {
        expect(raw).toMatch(/ref:\s*[0-9a-f]{40}\s*#.*compass-core pin/);
      } else {
        // The template never carries a literal SHA — that would defeat
        // per-consumer rendering — but it must carry the placeholder in
        // exactly the form install.ts's renderTemplateValues substitutes,
        // on the same "compass-core pin" line pin-check.ts anchors on.
        expect(raw).toMatch(/ref:\s*\{\{template:compass_core_ref\}\}\s*#.*compass-core pin/);
      }
    });

    test("every checkout of the PR head is isolated: persist-credentials: false AND a dedicated path", () => {
      const jobs = doc.jobs ?? {};
      let sawHeadCheckout = false;
      for (const job of Object.values<any>(jobs)) {
        for (const step of job.steps ?? []) {
          const ref = step?.with?.ref;
          if (typeof ref !== "string" || !ref.includes("github.event.pull_request.head.sha")) continue;
          sawHeadCheckout = true;
          expect(step.with["persist-credentials"], `step ${JSON.stringify(step.name)} checks out the PR head`).toBe(
            false,
          );
          expect(
            typeof step.with.path === "string" && step.with.path.length > 0,
            `step ${JSON.stringify(step.name)} checks out the PR head into the default (non-isolated) directory`,
          ).toBe(true);
        }
      }
      expect(sawHeadCheckout, `${fixture.label}: expected at least one isolated PR-head checkout`).toBe(true);
    });

    test("no run: step executes code from the isolated PR-head checkout directory (data only)", () => {
      const jobs = doc.jobs ?? {};
      const headPaths = new Set<string>();
      for (const job of Object.values<any>(jobs)) {
        for (const step of job.steps ?? []) {
          const ref = step?.with?.ref;
          if (typeof ref === "string" && ref.includes("github.event.pull_request.head.sha")) {
            if (typeof step.with.path === "string") headPaths.add(step.with.path);
          }
        }
      }
      expect(headPaths.size).toBeGreaterThan(0);

      for (const job of Object.values<any>(jobs)) {
        for (const step of job.steps ?? []) {
          for (const headPath of headPaths) {
            if (step["working-directory"] === headPath) {
              throw new Error(
                `step ${JSON.stringify(step.name)} sets working-directory to the PR-head data directory "${headPath}" — that directory must only be read, never made the cwd for a run: step`,
              );
            }
            if (typeof step.run === "string") {
              // Strip comment-only lines first — a code comment MENTIONING
              // the data directory (this file has several) must not trip an
              // "executes it" check meant for actual shell commands.
              const codeOnly = step.run
                .split("\n")
                .filter((line: string) => !/^\s*#/.test(line))
                .join("\n");
              const execRe = new RegExp(`\\b${EXEC_VERBS}\\s+\\.?/?${headPath}/`);
              expect(
                execRe.test(codeOnly),
                `step ${JSON.stringify(step.name)}'s run: appears to execute a file from "${headPath}/" — the PR-head checkout is DATA ONLY`,
              ).toBe(false);
            }
          }
        }
      }
    });

    test("permissions grant nothing beyond contents: read and issues: read — no write scope", () => {
      const topPerms = doc.permissions ?? {};
      const jobs = doc.jobs ?? {};
      const allPermBlocks = [topPerms, ...Object.values<any>(jobs).map((j) => j.permissions ?? {})];
      for (const perms of allPermBlocks) {
        for (const [scope, level] of Object.entries<string>(perms)) {
          expect(["read", "none"], `permissions.${scope}: ${level} exceeds read`).toContain(level);
        }
      }
      const anyContentsRead = allPermBlocks.some((p) => p.contents === "read");
      expect(anyContentsRead, "no permissions: block explicitly grants contents: read").toBe(true);
    });

    test("no PR-controlled string (title, body, head ref, label name) is interpolated directly into a run: script", () => {
      const forbidden =
        /\$\{\{\s*github\.event\.pull_request\.(?:title|body|head\.ref|user\.login|labels)/;
      const jobs = doc.jobs ?? {};
      for (const job of Object.values<any>(jobs)) {
        for (const step of job.steps ?? []) {
          if (typeof step.run === "string") {
            expect(
              forbidden.test(step.run),
              `step ${JSON.stringify(step.name)}'s run: interpolates PR-controlled text directly`,
            ).toBe(false);
          }
        }
      }
    });

    // --- PR #52 review fixes -------------------------------------------

    test("F4: the denylist secret is withheld from a fork PR, gated in env: not in the script", () => {
      const jobs = doc.jobs ?? {};
      let sawDenylistEnv = false;
      for (const job of Object.values<any>(jobs)) {
        for (const step of job.steps ?? []) {
          const denylist = step?.env?.DENYLIST;
          if (typeof denylist !== "string") continue;
          sawDenylistEnv = true;
          expect(
            denylist,
            "DENYLIST env value must compare head.repo.full_name against github.repository before falling back to the secret",
          ).toContain("github.event.pull_request.head.repo.full_name == github.repository");
          expect(denylist).toContain("secrets.CONFIDENTIALITY_DENYLIST");
          expect(denylist).toMatch(/\|\|\s*''/);
        }
      }
      expect(sawDenylistEnv, "expected a DENYLIST env: assignment on the leak-check step").toBe(true);
    });

    test("G2: the workflow header does not claim secrets are withheld from fork PRs", () => {
      // Round-2 review, G2: under pull_request_target a fork job DOES have
      // the secrets context (this repo has ECOSYSTEM_PAT); only the
      // denylist specifically is withheld, and only by the env: condition
      // above. A blanket "secrets are not exposed to fork PRs" claim is
      // false and, worse, would mislead a future maintainer wiring in a
      // different secret here into thinking forks can't reach it.
      expect(raw).not.toMatch(/Secrets are not exposed to fork PRs/);
    });

    test("F5: claude-md-check and label-check read their config from base/, never pr-head/", () => {
      const jobs = doc.jobs ?? {};
      let sawConfigFlag = false;
      for (const job of Object.values<any>(jobs)) {
        for (const step of job.steps ?? []) {
          if (typeof step.run !== "string" || !step.run.includes("--config")) continue;
          sawConfigFlag = true;
          expect(
            step.run,
            `step ${JSON.stringify(step.name)} passes --config from pr-head/ — a PR could disable its own checks`,
          ).not.toMatch(/--config\s+pr-head\//);
          expect(step.run).toMatch(/--config\s+base\/compass\.config\.yaml/);
        }
      }
      expect(sawConfigFlag, "expected at least one --config flag (claude-md-check, label-check)").toBe(true);
    });

    test("G5: COMPASS_CONFIG is set alongside --config, and a missing base/compass.config.yaml fails loudly", () => {
      const jobs = doc.jobs ?? {};
      let sawGuardStep = false;
      let guardIndex = -1;
      let sawCompassConfigEnv = 0;
      for (const job of Object.values<any>(jobs)) {
        const steps: any[] = job.steps ?? [];
        steps.forEach((step, i) => {
          if (typeof step.run === "string" && /base\/compass\.config\.yaml is missing/.test(step.run)) {
            sawGuardStep = true;
            guardIndex = i;
            expect(step.run, "the guard step must actually fail (exit 1) when the file is missing").toMatch(
              /exit 1/,
            );
          }
          if (step?.env?.COMPASS_CONFIG === "base/compass.config.yaml") {
            sawCompassConfigEnv++;
            expect(
              guardIndex,
              `step ${JSON.stringify(step.name)} using COMPASS_CONFIG must run after the base/compass.config.yaml guard`,
            ).toBeGreaterThanOrEqual(0);
            expect(i).toBeGreaterThan(guardIndex);
          }
        });
      }
      expect(sawGuardStep, "expected a step that fails loudly when base/compass.config.yaml is missing").toBe(true);
      expect(sawCompassConfigEnv, "expected COMPASS_CONFIG: base/compass.config.yaml on at least one validator step").toBeGreaterThan(
        0,
      );
    });

    test("F6: leak-check no longer skips a .compass-engine/* path inside the PR's own diff", () => {
      const jobs = doc.jobs ?? {};
      for (const job of Object.values<any>(jobs)) {
        for (const step of job.steps ?? []) {
          if (typeof step.run !== "string") continue;
          expect(
            step.run,
            `step ${JSON.stringify(step.name)} still special-cases .compass-engine/* — that path can only be PR-authored now`,
          ).not.toMatch(/\.compass-engine\/\*\)\s*continue/);
        }
      }
    });

    test("F10/G4: the symlink guard exists, runs before any validator, and narrows to out-of-tree/dangling", () => {
      const jobs = doc.jobs ?? {};
      let sawSymlinkGuard = false;
      let guardIndex = -1;
      let firstValidatorIndex = -1;
      let guardRun = "";
      for (const job of Object.values<any>(jobs)) {
        const steps: any[] = job.steps ?? [];
        steps.forEach((step, i) => {
          const runText = typeof step.run === "string" ? step.run : "";
          if (/find\s+pr-head\s+-type\s+l/.test(runText)) {
            sawSymlinkGuard = true;
            guardIndex = i;
            guardRun = runText;
          }
          if (/claude-md-check|leak-check/.test(step.name ?? "") && firstValidatorIndex === -1) {
            firstValidatorIndex = i;
          }
        });
        if (sawSymlinkGuard && firstValidatorIndex !== -1) {
          expect(
            guardIndex,
            "the symlink guard must run before the first validator step in the same job",
          ).toBeLessThan(firstValidatorIndex);
        }
      }
      expect(sawSymlinkGuard, "expected a step that inspects symlinks under pr-head/ (find pr-head -type l)").toBe(
        true,
      );
      // G4: must NOT refuse every symlink unconditionally — it must resolve
      // the target and only refuse one that escapes pr-head/ or is
      // dangling. realpath -m is what makes "escapes" and "dangling" both
      // checkable without requiring the target to exist first.
      expect(guardRun).toMatch(/realpath -m/);
      expect(guardRun).not.toMatch(/find pr-head -type l -print -quit \| grep -q \./); // the old, unconditional round-1 shape
    });

    test("F11: a PR-controlled filename echoed into a workflow-command notice has newlines stripped first", () => {
      const jobs = doc.jobs ?? {};
      let sawNoticeOfPRPath = false;
      for (const job of Object.values<any>(jobs)) {
        for (const step of job.steps ?? []) {
          if (typeof step.run !== "string") continue;
          if (!/::notice::\$f\b|::notice::\$safe_f\b/.test(step.run)) continue;
          if (/::notice::\$safe_f\b/.test(step.run)) {
            sawNoticeOfPRPath = true;
            expect(
              step.run,
              `step ${JSON.stringify(step.name)} echoes $safe_f without first stripping newlines from $f`,
            ).toMatch(/safe_f=.*tr -d '\\n\\r'/);
          } else {
            throw new Error(
              `step ${JSON.stringify(step.name)} echoes the raw, unsanitised PR-controlled $f into ::notice::`,
            );
          }
        }
      }
      expect(sawNoticeOfPRPath, "expected the leak-check step's PR-path notice to exist and use $safe_f").toBe(true);
    });

    test("every checkout step sets persist-credentials: false explicitly", () => {
      const jobs = doc.jobs ?? {};
      for (const job of Object.values<any>(jobs)) {
        for (const step of job.steps ?? []) {
          if (typeof step.uses === "string" && step.uses.startsWith("actions/checkout@")) {
            expect(
              step.with?.["persist-credentials"],
              `step ${JSON.stringify(step.name)} does not set persist-credentials: false`,
            ).toBe(false);
          }
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// G1 watched-failing proof: the check above, run against the EXACT bytes of
// compass-governance.yml at commit 550cae9 (the round-2-submitted head),
// which shipped types: [..., labeled, unlabeled] AND a job-level if: on
// github.event.action. The blob is committed as a fixture (see below), since
// 550cae9 is not reachable from main after the squash merge.
// ---------------------------------------------------------------------------

describe("G1 — watched failing on 550cae9", () => {
  test("the exact workflow bytes committed at 550cae9 violate the G1 rule this round fixes", () => {
    // The bytes are committed as a fixture: 550cae9 lived only on the PR
    // branch and is not reachable from main after the squash merge, so
    // `git show` fails in CI. Captured with
    // `git show 550cae9:templates/workflows/compass-governance.yml`.
    const raw = readFileSync(
      join(REPO, "engine", "__tests__", "fixtures", "compass-governance-550cae9.yml"),
      "utf8",
    );
    const violations = findG1Violations(raw);
    expect(violations.length, "expected 550cae9 to violate G1 — if this is empty, the watched-failing proof is stale").toBeGreaterThan(
      0,
    );
    expect(violations.some((v) => v.includes("labeled/unlabeled"))).toBe(true);
    expect(violations.some((v) => v.includes("github.event.action"))).toBe(true);
  });

  test("the current tree's compass-governance.yml (both copies) no longer violates it", () => {
    for (const fixture of GOVERNANCE_FIXTURES) {
      const raw = readFileSync(fixture.path, "utf8");
      expect(findG1Violations(raw), fixture.label).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// compass-pin-check.yml — the ONLY workflow allowed to react to labeled/unlabeled
// ---------------------------------------------------------------------------

for (const fixture of PIN_CHECK_FIXTURES) {
  describe(`pin-check workflow — ${fixture.label}`, () => {
    const raw = readFileSync(fixture.path, "utf8");
    const doc = parseWorkflow(raw);

    test("triggers on pull_request_target with labeled/unlabeled (F3) — this is the one file that needs them", () => {
      const on = doc.on ?? doc[true];
      const types: string[] = on.pull_request_target?.types ?? [];
      for (const t of ["opened", "synchronize", "reopened", "labeled", "unlabeled"]) {
        expect(types, `on.pull_request_target.types missing "${t}"`).toContain(t);
      }
    });

    test("has no job-level if: on github.event.action (it doesn't need one — nothing here is skipped on a label event)", () => {
      for (const [name, job] of Object.entries<any>(doc.jobs ?? {})) {
        expect(
          typeof job.if === "string" && job.if.includes("github.event.action"),
          `job "${name}" has an unexpected if: on github.event.action`,
        ).toBe(false);
      }
    });

    test("permissions grant nothing beyond contents: read", () => {
      const topPerms = doc.permissions ?? {};
      const jobs = doc.jobs ?? {};
      const allPermBlocks = [topPerms, ...Object.values<any>(jobs).map((j) => j.permissions ?? {})];
      for (const perms of allPermBlocks) {
        for (const [scope, level] of Object.entries<string>(perms)) {
          expect(["read", "none"], `permissions.${scope}: ${level} exceeds read`).toContain(level);
        }
      }
    });

    test("every checkout step sets persist-credentials: false explicitly", () => {
      for (const job of Object.values<any>(doc.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (typeof step.uses === "string" && step.uses.startsWith("actions/checkout@")) {
            expect(step.with?.["persist-credentials"]).toBe(false);
          }
        }
      }
    });

    test("does not check out the PR head at all — it only needs the changed-path list (F1)", () => {
      for (const job of Object.values<any>(doc.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          const ref = step?.with?.ref;
          expect(
            typeof ref === "string" && ref.includes("github.event.pull_request.head.sha"),
            "pin-check should not check out the PR head as a separate directory (F1 made it path-based)",
          ).toBe(false);
        }
      }
    });

    test("decides by path/prefix membership in the diff, not by parsing a ref value (F1)", () => {
      const pinCheckSteps: any[] = doc.jobs["pin-check"].steps ?? [];
      const decisionStep = pinCheckSteps.find(
        (s) => typeof s.run === "string" && s.run.includes("HAS_PIN_BUMP_LABEL"),
      );
      expect(decisionStep, "expected the pin-check decision step").toBeDefined();
      const run = decisionStep.run as string;
      expect(run).toContain("git -C base diff --no-renames --name-only");
      // G3: the whole .github/workflows/ prefix, not just the two named files.
      expect(run).toMatch(/\.github\/workflows\/\*/);
      for (const p of [
        "templates/workflows/compass-governance.yml",
        "templates/workflows/compass-pin-check.yml",
        "engine/install.ts",
      ]) {
        expect(run).toContain(p);
      }
      expect(run).not.toMatch(/grep -oP.*ref:/);
      expect(run).not.toMatch(/ENGINE_REF/);
    });

    test("no PR-controlled string is interpolated directly into a run: script", () => {
      const forbidden =
        /\$\{\{\s*github\.event\.pull_request\.(?:title|body|head\.ref|user\.login|labels)/;
      for (const job of Object.values<any>(doc.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (typeof step.run === "string") {
            expect(forbidden.test(step.run)).toBe(false);
          }
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// SOP cross-check (G2)
// ---------------------------------------------------------------------------

describe("sops/confidentiality-gate.md — G2", () => {
  const sopText = readFileSync(join(REPO, "sops", "confidentiality-gate.md"), "utf8");

  test("does not claim secrets are withheld from fork PRs as a blanket statement in §0's fork-coverage bullet", () => {
    const fork = sopText.match(/\*\*Fork coverage\.\*\*[\s\S]*?(?=\n {2}- \*\*|\n---)/);
    expect(fork, "expected a Fork coverage bullet in §0").toBeTruthy();
    expect(fork![0]).not.toMatch(/Secrets are not exposed to fork PRs.*pull_request_target/s);
  });
});
