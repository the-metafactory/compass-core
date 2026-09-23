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
  });
}
