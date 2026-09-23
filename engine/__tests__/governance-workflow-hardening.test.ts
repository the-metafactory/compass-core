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
 *     the base branch);
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
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const REPO = resolve(import.meta.dir, "..", "..");

const FIXTURES = [
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

/** Executable-looking command verbs a `run:` line must never aim at PR-head data. */
const EXEC_VERBS = "(?:bun|bunx|node|npm|npx|yarn|pnpm|python3?|ruby|perl|sh|bash|source|\\.)";

for (const fixture of FIXTURES) {
  describe(`governance workflow hardening — ${fixture.label}`, () => {
    const raw = readFileSync(fixture.path, "utf8");
    // The template's engine-checkout ref is `{{template:compass_core_ref}}`,
    // a placeholder install.ts substitutes at render time — not valid YAML on
    // its own (a bare `{{...}}` parses as a flow mapping). Stand a dummy
    // 40-hex value in for it purely so this file can parse the structure;
    // the placeholder's own literal text is asserted separately below.
    const parseable = raw.replace(/\{\{template:compass_core_ref\}\}/, "0".repeat(40));
    const doc = parse(parseable) as any;

    test("triggers on pull_request_target, not pull_request", () => {
      // yaml parses the bare `on:` key as the boolean `true` in YAML 1.1
      // unless quoted; this repo's workflows all write `on:` unquoted, so
      // read it back the same way GitHub Actions itself would.
      const on = doc.on ?? doc[true];
      expect(on).toBeDefined();
      expect(Object.keys(on)).toContain("pull_request_target");
      expect(Object.keys(on)).not.toContain("pull_request");
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
      // This assertion is meaningful only once the fix lands (main pre-fix
      // never checks out the PR head at all, isolated or otherwise) — assert
      // it unconditionally anyway so a future regression that removes the PR
      // head checkout without updating this fixture is visible as "0 head
      // checkouts found", not a silent pass.
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
      // At least one block must exist and grant contents: read — an absent
      // permissions: block would mean the (dangerous, broad) default applies.
      const anyContentsRead = allPermBlocks.some((p) => p.contents === "read");
      expect(anyContentsRead, "no permissions: block explicitly grants contents: read").toBe(true);
    });

    test("no PR-controlled string (title, body, head ref, label name) is interpolated directly into a run: script", () => {
      // A conservative, deliberately broad textual check across the whole
      // file, not just inside run: blocks — env: assignments below ARE
      // allowed to read these fields (that's the sanctioned path), so this
      // only forbids the specific shapes that land PR text directly inside a
      // shell command line embedded in the YAML.
      const forbidden =
        /\$\{\{\s*github\.event\.pull_request\.(?:title|body|head\.ref|user\.login|labels)/;
      // Collect every run: scalar's raw text and check those in isolation —
      // stricter than scanning the whole file (which would also flag a
      // legitimate `env:` mapping's value), and it's run: text that reaches
      // a shell.
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

    test("F3: the trigger reacts to labeled/unlabeled, not just opened/synchronize/reopened", () => {
      const on = doc.on ?? doc[true];
      const types: string[] = on.pull_request_target?.types ?? [];
      for (const t of ["opened", "synchronize", "reopened", "labeled", "unlabeled"]) {
        expect(types, `on.pull_request_target.types missing "${t}"`).toContain(t);
      }
    });

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
          // The fallback for a non-match must be empty, not the secret unconditionally.
          expect(denylist).toMatch(/\|\|\s*''/);
        }
      }
      expect(sawDenylistEnv, "expected a DENYLIST env: assignment on the leak-check step").toBe(true);
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

    test("F10: symlinks under pr-head/ are rejected before any validator step runs", () => {
      const jobs = doc.jobs ?? {};
      let sawSymlinkGuard = false;
      let guardIndex = -1;
      let firstValidatorIndex = -1;
      for (const job of Object.values<any>(jobs)) {
        const steps: any[] = job.steps ?? [];
        steps.forEach((step, i) => {
          const runText = typeof step.run === "string" ? step.run : "";
          if (/find\s+pr-head\s+-type\s+l/.test(runText)) {
            sawSymlinkGuard = true;
            guardIndex = i;
          }
          if (/claude-md-check|leak-check/.test(step.name ?? "") && firstValidatorIndex === -1) {
            firstValidatorIndex = i;
          }
        });
        if (sawSymlinkGuard) {
          expect(guardIndex).toBeGreaterThanOrEqual(0);
          if (firstValidatorIndex !== -1) {
            expect(
              guardIndex,
              "the symlink guard must run before the first validator step in the same job",
            ).toBeLessThan(firstValidatorIndex);
          }
        }
      }
      expect(sawSymlinkGuard, "expected a step that refuses symlinks under pr-head/ (find pr-head -type l)").toBe(
        true,
      );
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

describe("pin-check job — F1, path-based not value-based", () => {
  const raw = readFileSync(join(REPO, "templates", "workflows", "compass-governance.yml"), "utf8");

  test("the pin-check step's shell decides by path membership in the diff, not by parsing a ref value", () => {
    const doc = parse(raw.replace(/\{\{template:compass_core_ref\}\}/, "0".repeat(40))) as any;
    const pinCheckSteps: any[] = doc.jobs["pin-check"].steps ?? [];
    const decisionStep = pinCheckSteps.find((s) => typeof s.run === "string" && s.run.includes("HAS_PIN_BUMP_LABEL"));
    expect(decisionStep, "expected the pin-check decision step").toBeDefined();
    const run = decisionStep.run as string;
    // Must diff and check path membership for all three watched paths...
    expect(run).toContain("git -C base diff --no-renames --name-only");
    for (const p of [
      ".github/workflows/compass-governance.yml",
      "templates/workflows/compass-governance.yml",
      "engine/install.ts",
    ]) {
      expect(run).toContain(p);
    }
    // ...and must NOT extract a ref value by regex anymore (the F1-defeated approach).
    expect(run).not.toMatch(/grep -oP.*ref:/);
    expect(run).not.toMatch(/ENGINE_REF/);
  });

  test("pin-check no longer checks out pr-head/ at all — it only needs the changed-path list", () => {
    const doc = parse(raw.replace(/\{\{template:compass_core_ref\}\}/, "0".repeat(40))) as any;
    const pinCheckSteps: any[] = doc.jobs["pin-check"].steps ?? [];
    for (const step of pinCheckSteps) {
      const ref = step?.with?.ref;
      expect(
        typeof ref === "string" && ref.includes("github.event.pull_request.head.sha"),
        "pin-check should no longer check out the PR head as a separate directory (F1 made it path-based)",
      ).toBe(false);
    }
  });
});
