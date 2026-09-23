/**
 * pin-check.test.ts — fixtures for the-metafactory/compass-core#41 ruling
 * item 2: a PR that changes the governance engine pin must be refused unless
 * it carries the `pin-bump` label.
 *
 * PR #52 review, F1: the first cut of this check parsed the pin's VALUE out
 * of the file by regex, and was evadable by any edit that left the anchored
 * line alone. The fix is path-based: evaluatePinChange only asks whether the
 * diff touched one of the three watched files at all, never what changed
 * inside them. These fixtures cover:
 *   1. the three required cases from the original ruling (unlabelled change
 *      → blocked, labelled change → passes, unrelated diff → passes);
 *   2. the six evasions from the review (E1, E5, E6, E7, E10, E11), each
 *      confirmed to defeat the OLD (text-based) implementation — see
 *      "watched failing on the pre-fix implementation" below — and each
 *      still caught here purely because the file's PATH is in the diff,
 *      regardless of the specific trick inside it.
 */

import { describe, expect, test } from "bun:test";
import { evaluatePinChange, PIN_SENSITIVE_PATHS } from "../pin-check.ts";

const WORKFLOW = ".github/workflows/compass-governance.yml";
const TEMPLATE = "templates/workflows/compass-governance.yml";
const INSTALL = "engine/install.ts";

describe("PIN_SENSITIVE_PATHS", () => {
  test("names exactly the three watched paths, repo-relative", () => {
    expect([...PIN_SENSITIVE_PATHS].sort()).toEqual([INSTALL, TEMPLATE, WORKFLOW].sort());
  });
});

describe("evaluatePinChange — the three required fixtures", () => {
  test("FIXTURE 1: the workflow path changed, no pin-bump label -> blocked", () => {
    const result = evaluatePinChange([WORKFLOW], /* hasPinBumpLabel */ false);
    expect(result.changed).toBe(true);
    expect(result.blocked).toBe(true);
    expect(result.changedPaths).toEqual([WORKFLOW]);
    expect(result.message).toContain("pin-bump");
  });

  test("FIXTURE 2: the workflow path changed, pin-bump label present -> passes", () => {
    const result = evaluatePinChange([WORKFLOW], /* hasPinBumpLabel */ true);
    expect(result.changed).toBe(true);
    expect(result.blocked).toBe(false);
  });

  test("FIXTURE 3: an unrelated diff (README only) -> passes regardless of the label", () => {
    expect(evaluatePinChange(["README.md"], false).blocked).toBe(false);
    expect(evaluatePinChange(["README.md"], false).changed).toBe(false);
    expect(evaluatePinChange(["README.md"], true).blocked).toBe(false);
  });
});

describe("evaluatePinChange — every watched path, and combinations", () => {
  test("engine/install.ts alone requires the label", () => {
    const result = evaluatePinChange([INSTALL], false);
    expect(result.changed).toBe(true);
    expect(result.blocked).toBe(true);
  });

  test("the template alone requires the label (consumer repos never carry engine/install.ts)", () => {
    const result = evaluatePinChange([TEMPLATE], false);
    expect(result.changed).toBe(true);
    expect(result.blocked).toBe(true);
  });

  test("all three at once still requires only one label, and lists all three", () => {
    const result = evaluatePinChange([WORKFLOW, TEMPLATE, INSTALL, "README.md"], false);
    expect(result.blocked).toBe(true);
    expect(result.changedPaths.sort()).toEqual([INSTALL, TEMPLATE, WORKFLOW].sort());
  });

  test("a watched path alongside unrelated files still blocks", () => {
    const result = evaluatePinChange(["src/foo.ts", WORKFLOW, "docs/readme.md"], false);
    expect(result.blocked).toBe(true);
  });
});

describe("evaluatePinChange — renames surface as delete+add under --no-renames", () => {
  test("a rename AWAY from a watched path (old name gone) still blocks", () => {
    // git diff --no-renames reports a rename as the OLD path deleted; the
    // caller passes both names through unchanged. The old name alone is
    // enough — deleting the workflow file is exactly as sensitive as editing it.
    const result = evaluatePinChange([WORKFLOW], false);
    expect(result.blocked).toBe(true);
  });

  test("a rename INTO a watched path (new name appears) still blocks", () => {
    const result = evaluatePinChange(["old-workflow-name.yml", WORKFLOW], false);
    expect(result.blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The six evasions from the PR #52 review (F1)
// ---------------------------------------------------------------------------
//
// Each one is a real trick that defeated the OLD, text-based
// evaluatePinChange (which parsed a `ref:` value and an `ENGINE_REF` value
// by regex and compared them). Confirmed watched-failing against that
// implementation directly (not reproduced here — that code no longer
// exists in this file to import) before this fix: E1, E5, E6, E10 and E11
// all evaded it outright (blocked: false, changed: false) — the PR would
// have passed unlabelled. E7, as reproduced, happened to be caught by that
// old code's anchor regex for one specific decoy shape, but the review's
// broader point about E7 (a second, differently-named constant shadowing
// the real one at render time) is the same class of attack as E11, which
// did evade it. All six are caught here for the same single reason: every
// one of them is an edit to a watched FILE, and this check no longer looks
// at what the edit says.

describe("evaluatePinChange — the six review evasions, all caught path-based", () => {
  test("E1: real ref-line commented out as a decoy, live ref moved to an unanchored line", () => {
    // workflow content (not read by evaluatePinChange at all anymore):
    //   # ref: a73c053... # compass-core pin
    //   ref: 5de19b2...
    // The OLD text extractor's `.match()` on `ref:\s*([0-9a-f]{40})\s*#.*compass-core pin`
    // still found the commented line and reported the pin UNCHANGED.
    const result = evaluatePinChange([WORKFLOW], false);
    expect(result.blocked).toBe(true);
  });

  test("E5: a second actions/checkout of the engine added at the old, downgraded ref", () => {
    // The first (anchored) checkout step is untouched; a SECOND checkout
    // step, added below it, points .compass-engine at the older ref instead
    // — the last checkout of a given path wins at runtime. The old
    // extractor only ever read the first regex match, so it never saw the
    // second step at all.
    const result = evaluatePinChange([WORKFLOW], false);
    expect(result.blocked).toBe(true);
  });

  test("E6: `git checkout <old-sha>` spliced into the 'Install engine dependencies' run: line", () => {
    // No `ref:` field changes anywhere; the downgrade happens via a shell
    // command the old extractor never looked at (it only read `with.ref`
    // and `ENGINE_REF`, both via regex over the raw file, blind to run: semantics).
    const result = evaluatePinChange([WORKFLOW], false);
    expect(result.blocked).toBe(true);
  });

  test("E7: a second, differently-shaped ENGINE_REF-like constant shadows the real one at render time", () => {
    // install.ts's real `const ENGINE_REF = "a73c053...";` line is left
    // byte-for-byte untouched (so an old value-diff sees no change there at
    // all); a second constant is added and wired into what actually gets
    // rendered into the template. Same class as E11.
    const result = evaluatePinChange([INSTALL], false);
    expect(result.blocked).toBe(true);
  });

  test("E10: the pin-check JOB deleted outright, the ref line completely untouched", () => {
    // The sharpest one: nothing about "the pin's value" changes at all —
    // the whole SECOND JOB is removed from the workflow file. A
    // value-comparison check has no representation of "a job exists" to
    // even compare; it would report changed=false because the one value it
    // knows how to read (the ref) really is byte-identical. Path-based
    // catches it because removing a job is still an edit to the file.
    const result = evaluatePinChange([WORKFLOW], false);
    expect(result.blocked).toBe(true);
  });

  test("E11: install.ts renders from a new const while the old ENGINE_REF line stays", () => {
    const result = evaluatePinChange([INSTALL], false);
    expect(result.blocked).toBe(true);
  });

  test("every evasion above passes cleanly once labelled pin-bump", () => {
    for (const paths of [[WORKFLOW], [INSTALL]]) {
      expect(evaluatePinChange(paths, true).blocked).toBe(false);
    }
  });
});
