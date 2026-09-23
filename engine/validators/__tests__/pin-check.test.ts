/**
 * pin-check.test.ts — fixtures for the-metafactory/compass-core#41 ruling
 * item 2: a PR that changes the governance engine pin must be refused unless
 * it carries the `pin-bump` label.
 *
 * These are the three fixtures the issue's acceptance criteria and Andreas's
 * ruling comment call for, in fixture-diff form (a BASE snapshot and a HEAD
 * snapshot standing in for "the diff"):
 *   1. pin changed, no label            -> must fail   (blocked: true)
 *   2. pin changed, pin-bump label      -> must pass   (blocked: false)
 *   3. pin untouched, either label state -> must pass  (blocked: false)
 *
 * Every fixture drives evaluatePinChange directly — no workflow, no shell, no
 * CI needed to exercise this file. See the header of ../pin-check.ts for why
 * the actual workflow step reimplements this logic in shell rather than
 * invoking this module (the bootstrap problem: this file cannot yet be
 * referenced from a pinned engine checkout that predates it).
 */

import { describe, expect, test } from "bun:test";
import { evaluatePinChange, extractEngineRef, extractWorkflowRef } from "../pin-check.ts";

const OLD_SHA = "a73c053bfb19cdbe06fd3f0c7a35204dfaa81cf2";
const NEW_SHA = "b1b2b3b4b5b6b7b8b9b0b1b2b3b4b5b6b7b8b9b0";
const OLDER_SHA = "5de19b25de19b25de19b25de19b25de19b25de1";

/** A trimmed but realistic slice of compass-governance.yml around both checkout steps. */
function workflowFixture(engineRef: string): string {
  return `
name: compass governance
on:
  pull_request_target:
jobs:
  governance:
    steps:
      - name: Check out the compass-core engine
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          repository: the-metafactory/compass-core
          ref: ${engineRef} # compass-core pin, rendered at install time
          path: .compass-engine
          persist-credentials: false
`;
}

/** A trimmed slice of engine/install.ts around the ENGINE_REF const. */
function installFixture(engineRef: string): string {
  return `const PACKAGE_ROOT = resolve(import.meta.dir, "..");\nconst ENGINE_REF = "${engineRef}";\nconst TEMPLATE_VALUES = {};\n`;
}

describe("extractWorkflowRef", () => {
  test("reads the compass-core engine pin, not the actions/checkout action pin above it", () => {
    expect(extractWorkflowRef(workflowFixture(OLD_SHA))).toBe(OLD_SHA);
  });

  test("returns null when the anchor comment is gone", () => {
    const text = workflowFixture(OLD_SHA).replace("# compass-core pin, rendered at install time", "");
    expect(extractWorkflowRef(text)).toBeNull();
  });
});

describe("extractEngineRef", () => {
  test("reads the const line, not a comment quoting a SHA", () => {
    const text = `// was ${OLDER_SHA}\n${installFixture(NEW_SHA)}`;
    expect(extractEngineRef(text)).toBe(NEW_SHA);
  });

  test("returns null when the const line is absent", () => {
    expect(extractEngineRef("export const NOT_IT = 1;\n")).toBeNull();
  });
});

describe("evaluatePinChange — the three required fixtures", () => {
  test("FIXTURE 1: pin changed, no pin-bump label -> blocked", () => {
    const base = { workflow: workflowFixture(OLD_SHA), install: installFixture(OLD_SHA) };
    const head = { workflow: workflowFixture(OLDER_SHA), install: installFixture(OLDER_SHA) };

    const result = evaluatePinChange(base, head, /* hasPinBumpLabel */ false);

    expect(result.changed).toBe(true);
    expect(result.blocked).toBe(true);
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.message).toContain("pin-bump");
  });

  test("FIXTURE 2: pin changed, pin-bump label present -> passes", () => {
    const base = { workflow: workflowFixture(OLD_SHA), install: installFixture(OLD_SHA) };
    const head = { workflow: workflowFixture(NEW_SHA), install: installFixture(NEW_SHA) };

    const result = evaluatePinChange(base, head, /* hasPinBumpLabel */ true);

    expect(result.changed).toBe(true);
    expect(result.blocked).toBe(false);
  });

  test("FIXTURE 3: pin untouched (an unrelated change) -> passes regardless of the label", () => {
    const unrelatedBase = workflowFixture(OLD_SHA).replace("compass governance", "compass governance (base)");
    const unrelatedHead = workflowFixture(OLD_SHA).replace("compass governance", "compass governance (head, renamed)");
    const base = { workflow: unrelatedBase, install: installFixture(OLD_SHA) };
    const head = { workflow: unrelatedHead, install: installFixture(OLD_SHA) };

    expect(evaluatePinChange(base, head, false).blocked).toBe(false);
    expect(evaluatePinChange(base, head, false).changed).toBe(false);
    expect(evaluatePinChange(base, head, true).blocked).toBe(false);
  });
});

describe("evaluatePinChange — install.ts half", () => {
  test("a consumer repo (neither side carries install.ts) skips that half entirely", () => {
    const base = { workflow: workflowFixture(OLD_SHA) };
    const head = { workflow: workflowFixture(OLD_SHA) };
    const result = evaluatePinChange(base, head, false);
    expect(result.changed).toBe(false);
  });

  test("install.ts ENGINE_REF changing alone (workflow ref untouched) still blocks without the label", () => {
    const base = { workflow: workflowFixture(OLD_SHA), install: installFixture(OLD_SHA) };
    const head = { workflow: workflowFixture(OLD_SHA), install: installFixture(NEW_SHA) };
    const result = evaluatePinChange(base, head, false);
    expect(result.changed).toBe(true);
    expect(result.blocked).toBe(true);
    expect(result.changes[0]).toContain("ENGINE_REF");
  });

  test("install.ts appearing where it was absent on base counts as a change", () => {
    const base = { workflow: workflowFixture(OLD_SHA), install: null };
    const head = { workflow: workflowFixture(OLD_SHA), install: installFixture(OLD_SHA) };
    const result = evaluatePinChange(base, head, false);
    expect(result.changed).toBe(true);
    expect(result.blocked).toBe(true);
  });
});

describe("evaluatePinChange — a deleted/unrecognisable workflow still counts as a change", () => {
  test("the anchor comment disappearing (pin now unreadable) is treated as a change, not a silent pass", () => {
    const base = { workflow: workflowFixture(OLD_SHA) };
    const mangledHead = workflowFixture(OLD_SHA).replace("# compass-core pin, rendered at install time", "");
    const head = { workflow: mangledHead };
    const result = evaluatePinChange(base, head, false);
    expect(result.changed).toBe(true);
    expect(result.blocked).toBe(true);
  });
});
